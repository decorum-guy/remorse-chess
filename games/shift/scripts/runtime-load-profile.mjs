/** Bounded real-time Shift profile. Private accounts/mail/SQLite stay under .qa.
 * Run only after other acceptance processes have stopped. No manual game ticks.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, fork } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile, appendFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { availableParallelism, cpus, platform as osPlatform, release, totalmem } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'vite';
import { chromium } from '@playwright/test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const args = process.argv.slice(2), option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
if (!args.includes('--run')) {
  process.stdout.write('Explicit --run starts six normal 3x3 matches and six Chromium contexts for a real 60-second sample.\nOptions: --browser PATH --port 4428 --source-ref d9db2f178998bcf3ff953af1279bb576d183d052 --label realtime-6x3\n');
  process.exit(0);
}
const acceptedSource = option('--source-ref', 'd9db2f178998bcf3ff953af1279bb576d183d052');
const label = option('--label', 'realtime-6x3'), port = Number(option('--port', '4428'));
assert.match(label, /^[a-zA-Z0-9_-]+$/); assert.ok(Number.isInteger(port) && port > 1024 && port < 65536);
const browserPath = option('--browser', null), sampleMs = 60000, warmupMs = 10000;
const productPaths = ['games/shift/src', 'games/shift/public', 'games/shift/assets-manifest.json', 'apps/platform/src', 'apps/portal/src', 'packages/session-kit/src', 'packages/game-registry/src', 'packages/game-registry/games.json', 'package.json', 'package-lock.json', 'vite.platform.config.ts', 'apps/portal/vite.config.ts'];
execFileSync('git', ['diff', '--exit-code', acceptedSource, '--', ...productPaths], { cwd: ROOT, stdio: 'pipe' });
const base = join(ROOT, '.qa/shift-load'); await mkdir(base, { recursive: true, mode: 0o700 });
const directory = await mkdtemp(join(base, `${label}-`)), copied = join(directory, 'source'), portal = join(directory, 'portal');
const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
const dirtyFiles = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
const report = { label, classification: 'Automated real Chromium clients, ordinary authentication/shared WebSocket/SQLite and normal production autoTick; no human play, physical device FPS, actual listening or production-capacity claim', sourceSha, acceptedProductSource: acceptedSource, productMatchesAcceptedSource: true, dirtyFiles, startedAt: new Date().toISOString(), settings: { matches: 6, teamSize: 3, accounts: 6, browserProcesses: 3, contexts: 6, rosterBotsPerMatch: 4, absentUserSeatsPerMatch: 1, sampleMs, warmupMs, renderer: 'Canvas2D / low quality', clientPolicyIntervalMs: 67 }, sourceHashes: {}, buildHashes: {}, checks: [], failures: [], directory };
const log = value => process.stdout.write(JSON.stringify({ label, ...value }) + '\n');
const check = (name, details = {}) => { report.checks.push({ name, ...details }); log({ check: name, ...details }); };
const hash = data => createHash('sha256').update(data).digest('hex');
async function hashPath(path, target, root, key = path) {
  for (const e of (await readdir(join(root, path), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.isDirectory()) await hashPath(`${path}/${e.name}`, target, root, `${key}/${e.name}`);
    else if (e.isFile()) target[`${key}/${e.name}`] = hash(await readFile(join(root, path, e.name)));
  }
}
for (const path of productPaths) {
  if (path.endsWith('.json') || path.endsWith('.ts')) report.sourceHashes[path] = hash(await readFile(join(ROOT, path)));
  else await hashPath(path, report.sourceHashes, ROOT);
}
for (const path of ['games/shift/src', 'apps/platform/src', 'packages/session-kit/src', 'packages/game-registry/src', 'packages/game-registry/games.json']) await cp(join(ROOT, path), join(copied, path), { recursive: true });
await cp(join(ROOT, 'apps/portal/dist'), portal, { recursive: true, dereference: true });
await hashPath('portal', report.buildHashes, directory, 'apps/portal/dist');
report.buildHashes['dist-platform/main.js'] = hash(await readFile(join(ROOT, 'dist-platform/main.js')));
report.sourceTreeSha256 = hash(JSON.stringify(report.sourceHashes)); report.builtTreeSha256 = hash(JSON.stringify(report.buildHashes));
report.environment = { node: process.version, os: `${osPlatform()} ${release()}`, availableParallelism: availableParallelism(), cpuModel: cpus()[0]?.model, logicalCpus: cpus().length, totalMemoryBytes: totalmem(), cpuMax: await readFile('/sys/fs/cgroup/cpu.max', 'utf8').catch(() => null), memoryMax: await readFile('/sys/fs/cgroup/memory.max', 'utf8').catch(() => null) };
const scriptDir = dirname(fileURLToPath(import.meta.url));
let entryText = await readFile(join(scriptDir, 'runtime-load-entry.ts.template'), 'utf8');
for (const [token, path] of Object.entries({ __PLATFORM_SERVICE__: 'apps/platform/src/service.ts', __PLATFORM_HTTP__: 'apps/platform/src/http.ts', __PLATFORM_CONFIG__: 'apps/platform/src/config.ts', __SHIFT_RUNTIME__: 'games/shift/src/server/runtime.ts', __SHIFT_CORE__: 'games/shift/src/core/index.ts' })) entryText = entryText.replace(token, join(copied, path));
const entry = join(directory, 'server-entry.ts'), out = join(directory, 'compiled'); await writeFile(entry, entryText);
const aliases = [{ find: '@iva-games/session-kit/http', replacement: join(copied, 'packages/session-kit/src/http.ts') }, { find: '@iva-games/session-kit', replacement: join(copied, 'packages/session-kit/src/index.ts') }, { find: '@iva-games/game-registry', replacement: join(copied, 'packages/game-registry/src/index.ts') }];
await build({ root: ROOT, configFile: join(ROOT, 'vite.platform.config.ts'), logLevel: 'error', resolve: { alias: aliases }, build: { ssr: entry, outDir: out, emptyOutDir: true, minify: false, rollupOptions: { output: { entryFileNames: 'server.mjs' } } } });
const policyEntry = join(directory, 'policy-entry.ts');
await writeFile(policyEntry, `export { chooseBotCommands } from ${JSON.stringify(join(copied, 'games/shift/src/bots/policy.ts'))};\nexport { LIVE_PROTOCOL, parseLiveClientFrame } from ${JSON.stringify(join(copied, 'packages/session-kit/src/index.ts'))};\n`);
await build({ root: ROOT, configFile: false, logLevel: 'error', build: { ssr: policyEntry, outDir: join(directory, 'policy'), emptyOutDir: true, minify: false } });
const { chooseBotCommands, LIVE_PROTOCOL, parseLiveClientFrame } = await import(pathToFileURL(join(directory, 'policy/policy-entry.js')).href);
const { ShiftDemoClient, createShiftDemoRoom } = await import(pathToFileURL(join(ROOT, 'games/shift/scripts/demo.mjs')).href);
report.measurementEntrypointSha256 = hash(await readFile(join(out, 'server.mjs')));
report.harnessHashes = { script: hash(await readFile(fileURLToPath(import.meta.url))), entryTemplate: hash(await readFile(join(scriptDir, 'runtime-load-entry.ts.template'))) };
const peers = [], browsers = [], servers = [], pendingIpc = new Map(); let child = null, requestId = 0, driving = false, driver = null, measureStarted = false;
let readyResolve, readyReject; const ready = new Promise((resolveReady, rejectReady) => { readyResolve = resolveReady; readyReject = rejectReady; });
function bounded(promise, name, timeout = 12000) { let timer; return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${name}`)), timeout); })]).finally(() => clearTimeout(timer)); }
function ipc(type, extra = {}) { const id = ++requestId; return bounded(new Promise((resolveRequest, rejectRequest) => { pendingIpc.set(id, { resolve: resolveRequest, reject: rejectRequest }); child.send({ id, type, ...extra }); }), `measurement IPC ${type}`).finally(() => pendingIpc.delete(id)); }
async function until(test, name, timeout = 20000) { const end = Date.now() + timeout; while (Date.now() < end) { for (const peer of peers) if (peer.failure) throw peer.failure; const result = await test(); if (result) return result; await delay(50); } throw new Error(`Timed out: ${name}`); }
function freeze(value) { if (value && typeof value === 'object' && !Object.isFrozen(value)) { for (const childValue of Object.values(value)) freeze(childValue); Object.freeze(value); } return value; }
function instrument() {
  if (location.protocol !== 'http:') return;
  localStorage.setItem('iva-shift.preferences.v1', JSON.stringify({ lang: 'ru', mode: '2d', quality: 'low', reducedMotion: true, volume: 0, ambience: 0 }));
  const Native = window.WebSocket;
  const state = { scope: null, socket: null, frameCount: 0, sentInputs: 0, sentCommands: 0, peakInputsPerSecond: 0, recentInputs: [], canvasDraws: 0, firstDrawAt: null, lastDrawAt: null, sockets: 0, closes: [], errors: [] };
  window.__shiftLoad = state;
  const clear = CanvasRenderingContext2D.prototype.clearRect;
  CanvasRenderingContext2D.prototype.clearRect = function (...params) {
    if (this.canvas.closest('.shift-scene [data-shift-renderer="2d"]')) { state.canvasDraws++; const t = performance.now(); state.firstDrawAt ??= t; state.lastDrawAt = t; }
    return clear.apply(this, params);
  };
  const transmit = (socket, frame) => {
    if (frame.type === 'input') { const now = performance.now(); state.recentInputs = state.recentInputs.filter(t => now - t < 1000); state.recentInputs.push(now); state.peakInputsPerSecond = Math.max(state.peakInputsPerSecond, state.recentInputs.length); state.sentInputs++; }
    else if (frame.type === 'command') state.sentCommands++;
    Native.prototype.send.call(socket, JSON.stringify(frame));
  };
  window.WebSocket = class extends Native {
    constructor(url, protocols) {
      super(url, protocols);
      if (/\/api\/platform\/v1\/rooms\/[^/]+\/live$/.test(new URL(String(url), location.href).pathname)) {
        state.socket = this; state.sockets++; state.scope = null;
        this.addEventListener('message', event => { const frame = JSON.parse(String(event.data)); state.frameCount++;
          if (frame.type === 'snapshot') { const { protocol, wireVersion, roomId, matchId, epoch } = frame; state.scope = { protocol, wireVersion, roomId, matchId, epoch }; }
          if (frame.type === 'error') state.errors.push(frame.code);
        });
        this.addEventListener('close', event => state.closes.push(event.code));
      }
    }
    send(data) { try { if (JSON.parse(String(data)).type === 'input') return; } catch { /* Native validation remains. */ } return Native.prototype.send.call(this, data); }
  };
  state.send = (commands, expectedRevision) => {
    if (!state.scope || state.socket?.readyState !== Native.OPEN) return false;
    for (const payload of commands) transmit(state.socket, payload.type === 'input' ? { ...state.scope, type: 'input', seq: payload.seq, payload } : { ...state.scope, type: 'command', actionId: payload.actionId, expectedRevision, payload });
    return true;
  };
  state.metrics = () => ({ frameCount: state.frameCount, sentInputs: state.sentInputs, sentCommands: state.sentCommands, peakInputsPerSecond: state.peakInputsPerSecond,
    canvasDraws: state.canvasDraws, firstDrawAt: state.firstDrawAt, lastDrawAt: state.lastDrawAt, now: performance.now(), visibility: document.visibilityState,
    sockets: state.sockets, closes: [...state.closes], errors: [...state.errors], readyState: state.socket?.readyState,
    renderer: document.querySelector('.shift-scene [data-shift-renderer]')?.getAttribute('data-shift-renderer'), hasActualMatch: !!document.querySelector('.shift-match') });
}
function observe(page, room, index) {
  const peer = { page, room, label: `M${index + 1}`, view: null, scope: null, frames: 0, frameBytes: 0, inputFrames: 0, receipts: 0, failure: null, errors: [], httpErrors: [], lastDriveTick: -1, memory: { seq: 0, counter: 0, nextDecisionTick: 0, recentRooms: [] } };
  page.on('pageerror', error => { peer.errors.push(error.message); peer.failure ??= error; });
  page.on('response', response => { const p = new URL(response.url()).pathname; if (p.startsWith('/api/platform/') && response.status() >= 400) { peer.httpErrors.push({ path: p, status: response.status() }); peer.failure ??= new Error(`${peer.label} HTTP ${response.status()}`); } });
  page.on('websocket', socket => {
    if (!socket.url().includes('/api/platform/v1/rooms/')) return;
    let scope;
    const fail = error => { peer.failure ??= error; };
    try { const url = new URL(socket.url()); assert.equal(url.pathname, `/api/platform/v1/rooms/${room.roomId}/live`); assert.equal(url.search, ''); } catch (e) { fail(e); }
    socket.on('framereceived', ({ payload }) => {
      try {
        peer.frames++; peer.frameBytes += Buffer.byteLength(String(payload));
        const frame = JSON.parse(String(payload)); assert.equal(frame.protocol, LIVE_PROTOCOL); assert.equal(frame.wireVersion, 'shift-wire@1'); assert.equal(frame.rulesVersion, 'shift@1'); assert.equal(frame.contentVersion, 'shift-content@1'); assert.equal(frame.gameId, 'shift'); assert.equal(frame.roomId, room.roomId); assert.equal(typeof frame.epoch, 'string'); assert.ok(frame.epoch);
        const nowScope = (({ protocol, wireVersion, roomId, matchId, epoch }) => ({ protocol, wireVersion, roomId, matchId, epoch }))(frame);
        if (scope) assert.deepEqual(nowScope, scope); else assert.equal(frame.type, 'snapshot'); scope = nowScope; peer.scope = nowScope;
        if (frame.type === 'error') throw new Error(`${peer.label} wire ${frame.code}`);
        if (frame.type === 'snapshot') { assert.equal(frame.tick, frame.view.tick); assert.equal(frame.lastAcceptedSeq, frame.view.self.lastAcceptedSeq); for (const field of ['seed', 'botMemory', 'visible', 'receipts', 'teamEvents']) assert.ok(!(field in frame.view)); peer.view = freeze(frame.view); }
        else { assert.equal(frame.type, 'receipt'); assert.equal(frame.actionId, frame.result.actionId); peer.receipts++; }
      } catch (e) { fail(e); }
    });
    socket.on('framesent', ({ payload }) => { try { const frame = JSON.parse(String(payload)); assert.ok(parseLiveClientFrame(frame, scope)); assert.deepEqual((({ protocol, wireVersion, roomId, matchId, epoch }) => ({ protocol, wireVersion, roomId, matchId, epoch }))(frame), scope); if (frame.type === 'input') { assert.equal(frame.seq, frame.payload.seq); peer.inputFrames++; } else if (frame.payload.type === 'shift') assert.equal(frame.expectedRevision, frame.payload.expectedBoardRevision); } catch (e) { fail(e); } });
    socket.on('socketerror', error => fail(new Error(`${peer.label} socket ${error}`)));
  });
  peers.push(peer); return peer;
}
async function drive() {
  while (driving) {
    await Promise.all(peers.map(async peer => {
      if (peer.failure) throw peer.failure;
      const view = peer.view; if (!view || view.tick === peer.lastDriveTick) return;
      peer.lastDriveTick = view.tick; const commands = chooseBotCommands(view, peer.memory);
      if (commands.length) assert.equal(await bounded(peer.page.evaluate(({ commands: payload, revision }) => window.__shiftLoad.send(payload, revision), { commands, revision: view.boardRevision }), `${peer.label} ordinary browser send`), true);
    }));
    await delay(67);
  }
}
async function clientMetrics() { return Promise.all(peers.map(async peer => ({ label: peer.label, frames: peer.frames, bytes: peer.frameBytes, inputFrames: peer.inputFrames, receipts: peer.receipts, tick: peer.view?.tick, phase: peer.view?.phase, browser: await bounded(peer.page.evaluate(() => window.__shiftLoad.metrics()), `${peer.label} renderer metrics`) }))); }
try {
  const privateData = join(directory, 'private'); await mkdir(privateData, { recursive: true, mode: 0o700 });
  child = fork(join(out, 'server.mjs'), [privateData, String(port), portal], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  child.stdout.on('data', data => { void appendFile(join(privateData, 'server.log'), data, { mode: 0o600 }); });
  child.stderr.on('data', data => { void appendFile(join(privateData, 'server.log'), data, { mode: 0o600 }); });
  child.on('message', message => { if (message.type === 'ready') readyResolve(message); else { const pending = pendingIpc.get(message.id); if (pending) { if (message.ok) pending.resolve(message.result); else pending.reject(new Error(message.error)); } } });
  child.on('error', readyReject); child.on('exit', (code, signal) => { readyReject(new Error(`Private server exit ${code}/${signal}`)); for (const pending of pendingIpc.values()) pending.reject(new Error(`Private server exit ${code}/${signal}`)); });
  const fixture = await bounded(ready, 'normal runtime server startup'); assert.equal(fixture.normalAutoTick, true);
  const accounts = [], mailbox = join(privateData, 'mail'), suffix = randomUUID().slice(0, 6);
  for (let index = 0; index < 6; index++) { const client = new ShiftDemoClient(fixture.origin, mailbox); await client.register(`load${suffix}${index}`, `Load ${index + 1}`); accounts.push(client); }
  for (let index = 0; index < 6; index++) { const guest = accounts[(index + 1) % 6]; const friendship = await accounts[index].request('/friend-requests', { playerId: guest.user.playerId }); await guest.request(`/friend-requests/${friendship.requestId}/accept`, {}); }
  const rooms = [];
  for (let index = 0; index < 6; index++) {
    const host = accounts[index], guest = accounts[(index + 1) % 6];
    let room = await createShiftDemoRoom(host, guest, { teamSize: 3, arena: ['foundry', 'calibration', 'depot'][index % 3], rotateRoles: true, difficulty: 'normal', hostRole: 'pilot' });
    await host.request(`/rooms/${room.roomId}/ready`, { expectedRevision: room.revision, ready: true });
    await guest.request(`/rooms/${room.roomId}/ready`, { expectedRevision: room.revision, ready: true });
    room = (await host.request(`/rooms/${room.roomId}`)).room; rooms.push(room);
  }
  check('Six ordinary account registrations and six prepared 3×3 ring lobbies; authentication and limits unchanged');
  for (let index = 0; index < 3; index++) {
    const server = await chromium.launchServer({ headless: true, ...(browserPath ? { executablePath: resolve(ROOT, browserPath) } : {}), args: ['--disable-dev-shm-usage', '--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });
    servers.push(server); const browser = await chromium.connect(server.wsEndpoint()); browsers.push(browser);
  }
  report.chromiumVersion = browsers[0].version();
  await Promise.all(rooms.map(async (room, index) => {
    const context = await browsers[Math.floor(index / 2)].newContext({ storageState: accounts[index].storageState(), viewport: { width: 1024, height: 768 }, locale: 'ru-RU', reducedMotion: 'reduce' });
    await context.addInitScript(instrument); const page = await context.newPage(); page.setDefaultTimeout(20000); observe(page, room, index);
    await page.goto(`${fixture.origin}/rooms/${room.roomId}`, { waitUntil: 'domcontentloaded' });
    await until(() => page.getByRole('button', { name: /Начать матч/ }).isEnabled(), `M${index + 1} prepared real start button`);
  }));
  peers.sort((a, b) => a.label.localeCompare(b.label));
  const startAt = performance.now();
  await Promise.all(peers.map(peer => peer.page.getByRole('button', { name: /Начать матч/ }).click()));
  const startsCompletedMs = performance.now() - startAt;
  await until(() => peers.every(peer => peer.view && peer.scope && peer.view.self.connected), 'Six actual authenticated browser snapshots');
  await Promise.all(peers.map(peer => peer.page.locator('.shift-scene [data-shift-renderer="2d"] canvas').waitFor()));
  driving = true; driver = drive(); driver.catch(error => { for (const peer of peers) peer.failure ??= error; });
  const warmAt = performance.now();
  while (performance.now() - warmAt < warmupMs) { await delay(250); for (const peer of peers) if (peer.failure) throw peer.failure; }
  await until(() => peers.every((peer, index) => { const guestId = peer.room.members.find(member => member.playerId === accounts[(index + 1) % 6].user.playerId)?.participantId; return peer.view.seats.some(seat => seat.seatId === guestId && seat.substitute && !seat.bot); }), 'All six unconnected user seats have normal substitutes');
  const beforeClients = await clientMetrics();
  for (const client of beforeClients) { assert.equal(client.browser.renderer, '2d'); assert.equal(client.browser.hasActualMatch, true); assert.equal(client.browser.readyState, 1); assert.ok(client.browser.canvasDraws > 0); assert.equal(client.browser.visibility, 'visible'); assert.deepEqual(client.browser.errors, []); }
  const matchIds = peers.map(peer => peer.scope.matchId);
  report.start = await ipc('begin', { matchIds }); measureStarted = true;
  check('Six real UI clients, all guest substitutes and normal server autoTick present before measurement', { startsCompletedMs, warmupMs: performance.now() - warmAt, measuredWindowMs: sampleMs });
  const measureWall = performance.now();
  while (performance.now() - measureWall < sampleMs) {
    await delay(Math.min(1000, Math.max(1, sampleMs - (performance.now() - measureWall))));
    for (const peer of peers) if (peer.failure) throw peer.failure;
    if (peers.some(peer => peer.view.phase === 'finished')) { report.failures.push('A real match finished before the full measurement interval; this probe is incomplete'); break; }
  }
  report.measurement = await ipc('end'); measureStarted = false;
  const afterClients = await clientMetrics(); report.clients = afterClients.map((after, index) => { const before = beforeClients[index]; return { label: after.label, arena: rooms[index].settings.arena, initialTick: before.tick, finalTick: after.tick, finalPhase: after.phase,
    receivedFrames: after.frames - before.frames, receivedPayloadBytes: after.bytes - before.bytes, inputFrames: after.inputFrames - before.inputFrames, receipts: after.receipts - before.receipts,
    canvasDraws: after.browser.canvasDraws - before.browser.canvasDraws, browserElapsedMs: after.browser.now - before.browser.now,
    visibility: after.browser.visibility, renderer: after.browser.renderer, peakInputsPerSecond: after.browser.peakInputsPerSecond, errors: after.browser.errors, closes: after.browser.closes }; });
  for (const client of report.clients) { assert.ok(client.receivedFrames > 0 && client.inputFrames > 0 && client.canvasDraws > 0); assert.ok(client.peakInputsPerSecond <= 30); assert.deepEqual(client.errors, []); assert.deepEqual(client.closes, []); }
  report.complete = report.failures.length === 0 && report.measurement.elapsedMs >= sampleMs && report.measurement.allSixOngoingThroughout;
  report.tickProcessingBudgetPassed = report.measurement.batchDuration.count > 0 && report.measurement.batchDuration.p95Ms <= 25;
  report.noGrowingRelativeBacklogObserved = report.measurement.scheduler.noAccumulationObserved;
  report.passed = report.complete && report.tickProcessingBudgetPassed && report.noGrowingRelativeBacklogObserved;
  check('Real-time sample ended', { complete: report.complete, passed: report.passed, elapsedMs: report.measurement.elapsedMs, p95FullBatchMs: report.measurement.batchDuration.p95Ms, batches: report.measurement.batchDuration.count, histogram: report.measurement.batchCountHistogram, finalRelativeDebtMs: report.measurement.scheduler.finalRelativeDebtMs });
} catch (error) {
  report.passed = false; report.complete = false; report.failures.push(error.stack || String(error));
  if (measureStarted) { report.measurement = await ipc('end').catch(endError => ({ error: String(endError) })); }
  log({ failed: error.message });
} finally {
  driving = false; if (driver) await bounded(driver.catch(() => {}), 'policy driver shutdown').catch(error => report.failures.push(error.message));
  // Official BrowserServer process-group cleanup. No page.close hang and no raw process.kill.
  report.browserCleanup = [];
  for (const server of servers) { try { await bounded(server.kill(), 'official BrowserServer cleanup'); report.browserCleanup.push('killed-by-official-api'); } catch (error) { report.browserCleanup.push(error.message); report.passed = false; } }
  if (child?.connected) { try { report.serverCleanup = await ipc('stop'); } catch (error) { report.serverCleanup = { error: error.message }; report.passed = false; } }
  report.finishedAt = new Date().toISOString();
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  await writeFile(join(base, `${label}-evidence.json`), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  log({ report: join(directory, 'report.json'), passed: report.passed, complete: report.complete });
}
if (!report.passed) process.exitCode = 1;
