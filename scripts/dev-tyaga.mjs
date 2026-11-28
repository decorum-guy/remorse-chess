#!/usr/bin/env node
/** Isolated local acceptance harness. Uses ordinary platform registration and
 * file-mail verification; no production authentication or game state shortcuts. */
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile, readdir, readlink, stat, open, unlink } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tyagaQaConfig } from './tyaga-qa-config.mjs';
import { inspectProcessAffinity, requestedServerCpus, validateServerAffinity } from './realtime-load-affinity.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const { qa, ports, origin } = tyagaQaConfig(root);
const args = new Set(process.argv.slice(2));
const realtimeCpus = requestedServerCpus(process.env.TYAGA_REALTIME_CPUS, 'TYAGA_REALTIME_CPUS');
if (realtimeCpus && process.platform !== 'linux') throw new Error('TYAGA_REALTIME_CPUS requires Linux taskset and /proc');
const children = new Map();
const lockToken = randomUUID();
let proxy, lockOwned = false, stopping = false, runnerReady = false, realtimeLaunch, buildId;
let lastRealtimeCrashAt = null, controlQueue = Promise.resolve();
await mkdir(qa, { recursive: true, mode: 0o700 });
async function exists(path) { try { await stat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
async function acquireLock() {
  const path = join(qa, 'runner.pid');
  // Executor calls can share files while using different PID/network namespaces.
  // A number alone may refer to an unrelated process in this call's namespace.
  const pidNamespace = await readlink('/proc/self/ns/pid').catch(() => null);
  if (await exists(path)) {
    let record;
    try { record = JSON.parse(await readFile(path, 'utf8')); } catch { record = null; }
    const pid = record?.pid;
    if (record?.pidNamespace === pidNamespace && Number.isInteger(pid) && pid > 1) {
      try { process.kill(pid, 0); throw new Error(`The isolated Tyaga runner is already active (PID ${pid}).`); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    await unlink(path);
  }
  const handle = await open(path, 'wx', 0o600);
  await handle.writeFile(JSON.stringify({ pid: process.pid, pidNamespace, token: lockToken }));
  await handle.close(); lockOwned = true;
}
async function checkPort(port) {
  await new Promise((accept, reject) => { const server = createNetServer(); server.once('error', reject); server.listen(port, '127.0.0.1', () => server.close(accept)); });
}
function run(command, arguments_, options = {}) {
  return new Promise((accept, reject) => {
    const child = spawn(command, arguments_, { cwd: root, env: process.env, stdio: 'inherit', ...options });
    child.once('error', reject); child.once('exit', code => code === 0 ? accept() : reject(new Error(`${command} exited with ${code}`)));
  });
}
async function digestFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await digestFiles(path));
    else if (entry.isFile()) files.push({ path: relative(root, path), sha256: createHash('sha256').update(await readFile(path)).digest('hex') });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
async function keys() {
  const directory = join(qa, 'keys'); await mkdir(directory, { recursive: true, mode: 0o700 });
  const privatePath = join(directory, 'platform-private.pem'), publicPath = join(directory, 'trusted-public-keys.json');
  if (await exists(privatePath) && await exists(publicPath)) return { privatePath, publicPath };
  if (await exists(privatePath) || await exists(publicPath)) throw new Error('Incomplete isolated signing-key pair; preserve and repair it before restarting.');
  const pair = generateKeyPairSync('ed25519');
  await writeFile(privatePath, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
  await writeFile(publicPath, JSON.stringify({ 'tyaga-dev': pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() }), { mode: 0o600, flag: 'wx' });
  return { privatePath, publicPath };
}
async function health(url, label) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { const response = await fetch(url, { signal: AbortSignal.timeout(1000) }); if (response.ok) return await response.json(); } catch { /* bounded startup retry */ }
    if ([...children.values()].some(record => !record.expectedExit && (record.child.exitCode !== null || record.child.signalCode !== null))) throw new Error(`${label} exited before readiness`);
    await new Promise(accept => setTimeout(accept, 300));
  }
  throw new Error(`${label} did not become ready`);
}
async function startProcess(name, file, env) {
  const log = await open(join(qa, `${name}.log`), 'a', 0o600);
  const pinned = name === 'realtime' && realtimeCpus !== null;
  const child = spawn(pinned ? 'taskset' : process.execPath, pinned ? ['-c', realtimeCpus.join(','), process.execPath, file] : [file], { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', log.fd, log.fd] });
  const record = { child, expectedExit: false, startedAt: Date.now(), affinity: null };
  children.set(name, record);
  child.once('error', error => { console.error(`${name} could not start: ${error.message}`); if (!stopping && !record.expectedExit) void stop(1); });
  child.once('exit', (code, signal) => { if (!stopping && !record.expectedExit) { console.error(`${name} exited (${code ?? signal}); see ${join(qa, `${name}.log`)}`); void stop(1); } });
  await log.close();
  return record;
}
async function recordRealtimeAffinity() {
  if (!realtimeCpus) return;
  const record = children.get('realtime'), actual = inspectProcessAffinity(record.child.pid);
  validateServerAffinity(realtimeCpus, actual); record.affinity = actual;
  const runner = inspectProcessAffinity(process.pid);
  const evidence = { kind: 'Opt-in local affinity, not a CPU quota or exclusive reservation', requestedRealtimeCpus: realtimeCpus,
    realtime: actual, runner, runnerUsesDisjointCpus: runner.threadCpuSets.every(mask => mask.every(cpu => !realtimeCpus.includes(cpu))) };
  const path = join(qa, 'build.json'), build = JSON.parse(await readFile(path, 'utf8'));
  await writeFile(path, JSON.stringify({ ...build, cpuAffinity: evidence }, null, 2), { mode: 0o600 });
}
const alive = record => !!record && record.child.exitCode === null && record.child.signalCode === null;
function runnerStatus() {
  return { ready: runnerReady && !stopping, buildId: buildId ?? null, runnerPid: process.pid, ports,
    services: Object.fromEntries([...children].map(([name, record]) => [name, { pid: record.child.pid,
      running: alive(record), exitCode: record.child.exitCode, signal: record.child.signalCode, startedAt: record.startedAt, affinity: record.affinity }])),
    realtimeRestartDelayMs: lastRealtimeCrashAt === null ? 0 : Math.max(0, lastRealtimeCrashAt + 15_100 - Date.now()) };
}
async function terminateOwnRealtime(signal) {
  const record = children.get('realtime');
  if (!alive(record)) return { alreadyStopped: true };
  record.expectedExit = true;
  const exited = new Promise((accept, reject) => {
    const timeout = setTimeout(() => reject(new Error('The owned realtime child did not stop within its deadline')), signal === 'SIGKILL' ? 5000 : 32_000);
    record.child.once('exit', (code, stoppedBy) => { clearTimeout(timeout); accept({ code, signal: stoppedBy }); });
  });
  if (!record.child.kill(signal)) throw new Error('Cannot signal the owned realtime child');
  if (signal === 'SIGKILL') lastRealtimeCrashAt = Date.now();
  const result = await exited;
  if (signal === 'SIGTERM' && result.code !== 0) throw new Error(`Realtime drain exited ${result.code ?? result.signal}; data retained, restart not attempted`);
  return result;
}
async function startOwnRealtime() {
  if (alive(children.get('realtime'))) return { alreadyRunning: true };
  // A killed writer cannot release its owner lease. Preserve it instead of
  // editing SQLite or letting a replacement steal live ownership.
  const delay = runnerStatus().realtimeRestartDelayMs;
  if (delay) await new Promise(accept => setTimeout(accept, delay));
  if (stopping) throw new Error('Runner is stopping');
  await checkPort(ports.realtime);
  await startProcess('realtime', realtimeLaunch.file, realtimeLaunch.env);
  await health(`http://127.0.0.1:${ports.realtime}/health/realtime/ready`, 'Realtime');
  await recordRealtimeAffinity();
  lastRealtimeCrashAt = null;
  return { restarted: true };
}
async function controlRunner(command) {
  if (command === 'status') return runnerStatus();
  if (!runnerReady || stopping || !realtimeLaunch) throw new Error('Runner is not ready');
  if (command === 'crash-realtime') await terminateOwnRealtime('SIGKILL');
  else if (command === 'start-realtime') await startOwnRealtime();
  else if (command === 'restart-realtime') { await terminateOwnRealtime('SIGTERM'); await startOwnRealtime(); }
  else throw new Error('Unsupported runner command');
  return runnerStatus();
}
// Only the parent process can use this channel. There is no HTTP control API,
// supplied PID, arbitrary signal, filesystem deletion or database mutation.
process.on('message', message => {
  if (!message || typeof message !== 'object' || Array.isArray(message) || message.type !== 'tyaga-runner-control') return;
  const reply = result => { if (process.connected) process.send({ type: 'tyaga-runner-result', id: message.id, ...result }); };
  if (Object.keys(message).some(key => !['type', 'id', 'command'].includes(key)) || typeof message.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(message.id)
    || !['status', 'restart-realtime', 'crash-realtime', 'start-realtime'].includes(message.command)) {
    reply({ ok: false, error: 'Invalid runner control message' }); return;
  }
  const operation = message.command === 'status' ? controlRunner(message.command) : controlQueue.then(() => controlRunner(message.command));
  if (message.command !== 'status') controlQueue = operation.catch(() => {});
  void operation.then(status => reply({ ok: true, status }), error => reply({ ok: false, error: error.message }));
});
process.once('disconnect', () => { void stop(); });
async function startProxy() {
  const targetPort = path => path.startsWith('/play/tyaga') || path.startsWith('/api/realtime/') || path.startsWith('/health/realtime/') ? ports.realtime : ports.platform;
  proxy = createHttpServer((request, response) => {
    const upstream = httpRequest({ host: '127.0.0.1', port: targetPort(request.url ?? '/'), path: request.url, method: request.method, headers: request.headers }, incoming => {
      response.writeHead(incoming.statusCode ?? 502, incoming.headers); incoming.pipe(response);
    });
    upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end('Local service unavailable'); });
    request.pipe(upstream);
  });
  proxy.on('upgrade', (request, socket, head) => {
    if (request.url !== '/ws/realtime/v1') { socket.destroy(); return; }
    const upstream = httpRequest({ host: '127.0.0.1', port: ports.realtime, path: request.url, method: 'GET', headers: request.headers });
    upstream.on('upgrade', (response, connection, upstreamHead) => {
      socket.write(`HTTP/${response.httpVersion} ${response.statusCode} ${response.statusMessage}\r\n` + response.rawHeaders.reduce((text, value, index) => text + value + (index % 2 ? '\r\n' : ': '), '') + '\r\n');
      if (head.length) connection.write(head); if (upstreamHead.length) socket.write(upstreamHead);
      connection.pipe(socket); socket.pipe(connection);
      connection.on('error', () => socket.destroy()); socket.on('error', () => connection.destroy());
    });
    upstream.on('response', response => { socket.end(`HTTP/1.1 ${response.statusCode ?? 502} Rejected\r\nConnection: close\r\n\r\n`); response.resume(); });
    upstream.on('error', () => socket.destroy()); upstream.end();
  });
  await new Promise((accept, reject) => { proxy.once('error', reject); proxy.listen(ports.browser, '127.0.0.1', accept); });
}
async function prepareAccounts() {
  const path = join(qa, 'accounts.json');
  let accounts;
  if (await exists(path)) accounts = JSON.parse(await readFile(path, 'utf8'));
  else {
    const suffix = randomBytes(3).toString('hex');
    accounts = ['pilot', 'mechanic'].map((role, index) => ({ email: `tyaga-${role}-${suffix}@example.invalid`, handle: `tyaga_${role}_${suffix}`, displayName: index ? 'Механик QA' : 'Пилот QA', password: randomBytes(24).toString('base64url') }));
    await writeFile(path, JSON.stringify(accounts, null, 2), { mode: 0o600, flag: 'wx' });
  }
  for (const account of accounts) {
    let cookie = '', csrf = '';
    const call = async (path, body) => {
      const response = await fetch(`${origin}/api/platform/v1${path}`, { method: body === undefined ? 'GET' : 'POST',
        headers: { Origin: origin, Cookie: cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, 'Idempotency-Key': randomUUID() }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const setCookie = response.headers.get('set-cookie'); if (setCookie) cookie = setCookie.split(';')[0];
      const value = await response.json(); return { status: response.status, value };
    };
    csrf = (await call('/session')).value.csrfToken;
    let result = await call('/auth/login', { email: account.email, password: account.password });
    if (result.status !== 200) result = await call('/auth/register', account);
    if (![200, 201].includes(result.status)) throw new Error(`Cannot prepare local ${account.handle}: ${result.value.error?.code ?? result.status}`);
    csrf = (await call('/session')).value.csrfToken;
    if (!result.value.user?.emailVerified) {
      const mails = await readdir(join(qa, 'mail'));
      let token;
      for (const filename of mails.sort().reverse()) {
        const contents = await readFile(join(qa, 'mail', filename), 'utf8');
        if (!contents.startsWith(`To: ${account.email}\n`) || !contents.includes('X-Iva-Development-Mail: verification')) continue;
        const url = contents.match(/https?:\/\/[^\s]+/); if (url) { token = new URL(url[0]).searchParams.get('token'); break; }
      }
      if (!token) throw new Error('Local verification mail not found');
      const verified = await call('/auth/verify', { token }); if (verified.status !== 200) throw new Error('Local account verification failed');
    }
  }
  console.info(`Two isolated QA accounts are ready. Credentials: ${join(qa, 'accounts.json')}`);
}
async function stop(code = 0) {
  if (stopping) return; stopping = true; runnerReady = false;
  proxy?.close(); proxy?.closeAllConnections();
  const active = [...children.values()].filter(alive).map(record => record.child);
  for (const child of active) child.kill('SIGTERM');
  await Promise.all(active.map(child => new Promise(accept => { const timer = setTimeout(() => { child.kill('SIGKILL'); accept(); }, 32_000); child.once('exit', () => { clearTimeout(timer); accept(); }); })));
  if (lockOwned) {
    const path = join(qa, 'runner.pid');
    const record = await readFile(path, 'utf8').then(JSON.parse).catch(() => null);
    if (record?.token === lockToken) await unlink(path).catch(() => {});
  }
  process.exitCode = code;
  if (process.connected) process.disconnect();
}
process.once('SIGINT', () => { void stop(); }); process.once('SIGTERM', () => { void stop(); });
try {
  await acquireLock(); for (const port of Object.values(ports)) await checkPort(port);
  if (!args.has('--no-build')) {
    await run('npm', ['run', 'build:foundation']);
    await run('npm', ['run', 'build:realtime']);
  }
  const signing = await keys();
  const runnerCommit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
  const runnerDirty = !!spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).stdout.trim();
  let commit = runnerCommit, dirty = runnerDirty;
  const artifacts = [...await digestFiles(join(root, 'dist-realtime')), ...await digestFiles(join(root, 'dist-platform')), ...await digestFiles(join(root, 'games/tyaga/dist')), ...await digestFiles(join(root, 'apps/portal/dist'))];
  const artifactHash = createHash('sha256').update(JSON.stringify(artifacts)).digest('hex');
  // A later CI/test-only commit does not rebuild a running acceptance candidate.
  // Reuse its recorded source revision only after hashing every actual file.
  if (process.env.TYAGA_QA_BUILD_RECORD) {
    if (!args.has('--no-build')) throw new Error('A frozen build record requires --no-build');
    const recordPath = resolve(root, process.env.TYAGA_QA_BUILD_RECORD);
    if (!relative(root, recordPath).startsWith('.qa/')) throw new Error('Build record must belong to this checkout’s QA directory');
    const record = JSON.parse(await readFile(recordPath, 'utf8'));
    if (record.artifactHash !== artifactHash || !/^[a-f0-9]{40}$/.test(record.commit ?? '') || typeof record.dirty !== 'boolean') throw new Error('Frozen build record does not match the actual artifacts');
    commit = record.commit; dirty = record.dirty;
  }
  buildId = `${commit.slice(0, 12)}${dirty ? '-dirty' : ''}-${artifactHash.slice(0, 12)}`;
  await writeFile(join(qa, 'build.json'), JSON.stringify({ commit, dirty, buildId, artifactHash, artifacts, runnerCommit, runnerDirty }, null, 2), { mode: 0o600 });
  const common = { NODE_ENV: 'development', TELEGRAM_ENABLED: 'false', TELEGRAM_AUTH_ENABLED: 'false' };
  const allowedOrigins = Object.values(ports).map(port => `http://127.0.0.1:${port}`).join(',');
  realtimeLaunch = { file: 'dist-realtime/main.js', env: { ...common, REALTIME_HOST: '127.0.0.1', REALTIME_PORT: String(ports.realtime),
    REALTIME_TRUSTED_KEYS_FILE: signing.publicPath, REALTIME_DATABASE_PATH: join(qa, 'realtime.sqlite'), REALTIME_REVISION: buildId,
    REALTIME_ALLOWED_ORIGINS: allowedOrigins, REALTIME_ALLOWED_HOSTS: Object.values(ports).flatMap(port => [`127.0.0.1:${port}`, `localhost:${port}`]).join(','),
    // Local QA retains previous round worlds. This is not production capacity.
    REALTIME_TYAGA_STATIC_DIRECTORY: join(root, 'games/tyaga/dist'), REALTIME_MAX_MATCHES: '12' } };
  await startProcess('realtime', realtimeLaunch.file, realtimeLaunch.env);
  await health(`http://127.0.0.1:${ports.realtime}/health/realtime/ready`, 'Realtime');
  await recordRealtimeAffinity();
  await startProcess('platform', 'dist-platform/main.js', { ...common, PLATFORM_HOST: '127.0.0.1', PLATFORM_PORT: String(ports.platform),
    PORTAL_ORIGIN: origin, PLATFORM_ALLOWED_ORIGINS: allowedOrigins, PLATFORM_ALLOWED_HOSTS: Object.values(ports).flatMap(port => [`127.0.0.1:${port}`, `localhost:${port}`]).join(','),
    PLATFORM_DATABASE_PATH: join(qa, 'platform.sqlite'), PLATFORM_LAB_DATABASE_PATH: join(qa, 'platform-lab.sqlite'), MAIL_MODE: 'file', MAIL_FILE_DIRECTORY: join(qa, 'mail'),
    PORTAL_DIST_DIRECTORY: join(root, 'apps/portal/dist'), REALTIME_INTERNAL_URL: `http://127.0.0.1:${ports.realtime}`, REALTIME_SIGNING_KEY_FILE: signing.privatePath, REALTIME_KEY_ID: 'tyaga-dev' });
  await health(`http://127.0.0.1:${ports.platform}/health/ready`, 'Platform'); await startProxy();
  if (!args.has('--no-accounts')) await prepareAccounts();
  runnerReady = true;
  console.info(`Tyaga built client: ${origin}/play/tyaga/`);
  console.info(`Build ${buildId}; full artifact hashes: ${join(qa, 'build.json')}`);
  console.info('Ctrl+C drains and stops only this runner’s processes.');
} catch (error) { console.error(error instanceof Error ? error.message : 'Local startup failed'); await stop(1); }
