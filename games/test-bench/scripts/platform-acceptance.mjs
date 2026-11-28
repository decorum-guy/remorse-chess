/** Real HTTP/WebSocket checks of the built platform. This is not browser play. */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, stat, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import Database from 'better-sqlite3';
import { WebSocket } from 'ws';
import { checkLiveCatalogue, expectedTestBenchProfile } from '../../../scripts/check-live-catalogue.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const build = resolve(process.env.BENCH_PLATFORM_BUILD_DIRECTORY ?? join(root, 'dist-platform'));
for (const path of [join(build, 'main.js'), join(build, 'test-bench-worker.js'), join(root, 'apps/portal/dist/index.html')]) {
  assert.ok((await stat(path).catch(() => null))?.isFile(), 'Run npm run build:foundation before the built-platform check');
}
const directory = await mkdtemp(join(tmpdir(), 'iva-test-bench-platform-'));
const mailbox = join(directory, 'mail');
const runtimeDatabase = join(directory, 'runtime.sqlite');
const peers = [];
let running = null;
let origin = '';
let port = 0;
const digest = data => createHash('sha256').update(data).digest('hex');
const request = (url, options = {}) => fetch(url, { ...options, signal: AbortSignal.timeout(8000), redirect: 'error' });

async function availablePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const address = probe.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  return address.port;
}

async function start() {
  const child = spawn(process.execPath, [join(build, 'main.js')], {
    cwd: root,
    env: {
      ...process.env, NODE_ENV: 'development', PLATFORM_HOST: '127.0.0.1', PLATFORM_PORT: String(port),
      PORTAL_ORIGIN: origin, PLATFORM_ALLOWED_HOSTS: `127.0.0.1:${port}`, PLATFORM_ALLOWED_ORIGINS: origin,
      PLATFORM_DATABASE_PATH: join(directory, 'platform.sqlite'), PLATFORM_LAB_DATABASE_PATH: runtimeDatabase,
      PORTAL_DIST_DIRECTORY: join(root, 'apps/portal/dist'), MAIL_MODE: 'file', MAIL_FILE_DIRECTORY: mailbox,
      TELEGRAM_ENABLED: 'false', TELEGRAM_AUTH_ENABLED: 'false', DISTRICT_TERRITORIAL_ENABLED: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const state = { child, output: '', error: null };
  running = state;
  const collect = part => { state.output = (state.output + String(part)).slice(-16000); };
  child.stdout.on('data', collect); child.stderr.on('data', collect);
  child.on('error', error => { state.error = error; });
  const expected = `Iva Games platform listening on 127.0.0.1:${port}`;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (state.error) throw state.error;
    assert.ok(child.exitCode === null && child.signalCode === null, 'Built platform exited before readiness');
    if (state.output.split(/\r?\n/).includes(expected)) {
      assert.equal((await request(origin + '/health/ready')).status, 200);
      return;
    }
    await delay(25);
  }
  throw new Error('Built Test Bench platform readiness timeout');
}

async function stop() {
  const state = running;
  if (!state) return;
  const { child } = state;
  if (state.error) { running = null; throw state.error; }
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  const deadline = Date.now() + 12000;
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await delay(25);
  running = null;
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await new Promise(resolve => child.once('exit', resolve));
    throw new Error('Built Test Bench platform did not shut down gracefully');
  }
  assert.equal(child.exitCode, 0, 'Built platform shutdown must complete without losing accepted work');
}

class Client {
  cookie = '';
  csrf = '';
  async request(path, body, expectedStatus) {
    const response = await request(origin + '/api/platform/v1' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Cookie: this.cookie, ...(body === undefined ? {} : {
        Origin: origin, 'Content-Type': 'application/json', 'X-CSRF-Token': this.csrf,
      }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const cookie = response.headers.getSetCookie().find(value => value.startsWith('iva_dev_session='));
    if (cookie) this.cookie = cookie.split(';')[0];
    const value = await response.json();
    if (expectedStatus !== undefined) assert.equal(response.status, expectedStatus, `${path}: ${value.error?.code ?? 'unexpected HTTP status'}`);
    else assert.ok(response.ok, `${path}: HTTP ${response.status}, ${value.error?.code ?? 'unknown error'}`);
    if (path === '/session') this.csrf = value.csrfToken;
    return value;
  }
  async register(handle) {
    await this.request('/session');
    const email = `${handle}@example.test`;
    const created = await this.request('/auth/register', { email, handle, displayName: handle, password: 'isolated Test Bench fixture password' });
    await this.request('/session');
    let token;
    for (const file of await readdir(mailbox)) {
      const contents = await readFile(join(mailbox, file), 'utf8');
      if (!contents.startsWith(`To: ${email}\n`)) continue;
      const url = contents.match(/https?:\/\/[^\s]+\/verify\?token=[^\s]+/)?.[0];
      if (url) token = new URL(url).searchParams.get('token');
    }
    assert.ok(token, 'Account verification must use the isolated file mailbox');
    await this.request('/auth/verify', { token });
    assert.equal((await this.request('/session')).user.emailVerified, true);
    return created.user;
  }
}

class Peer {
  frames = [];
  closeCode = null;
  error = null;
  constructor(client, roomId) {
    this.ws = new WebSocket(origin.replace('http:', 'ws:') + `/api/platform/v1/rooms/${roomId}/live`, {
      headers: { Origin: origin, Cookie: client.cookie },
    });
    peers.push(this);
    this.ws.on('message', data => { this.frames.push(JSON.parse(data.toString())); });
    this.ws.on('close', code => { this.closeCode = code; });
    this.ws.on('error', error => { this.error = error; });
  }
  async frame(predicate, after = 0, timeout = 10000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const found = this.frames.slice(after).find(predicate);
      if (found) return found;
      if (this.error) throw this.error;
      assert.equal(this.closeCode, null, 'WebSocket closed before the expected game frame');
      await delay(15);
    }
    throw new Error(`Expected Test Bench frame was not received; recent types: ${this.frames.slice(-4).map(frame => frame.type + (frame.code ? ':' + frame.code : '')).join(', ')}`);
  }
  async snapshot(after = 0, predicate = () => true, timeout = 10000) {
    return this.frame(frame => frame.type === 'snapshot' && predicate(frame), after, timeout);
  }
  scope(snapshot) {
    const { protocol, wireVersion, roomId, matchId, epoch } = snapshot;
    return { protocol, wireVersion, roomId, matchId, epoch };
  }
  send(frame) { this.ws.send(JSON.stringify(frame)); }
  async closed(code) {
    const deadline = Date.now() + 3000;
    while (this.closeCode === null && Date.now() < deadline) await delay(15);
    assert.equal(this.closeCode, code);
  }
}

async function assets() {
  const landing = await request(origin + '/games/test-bench');
  assert.equal(landing.status, 200);
  assert.match(landing.headers.get('content-type') ?? '', /text\/html/);
  const response = await request(origin + '/test-bench/assets-manifest.json');
  assert.equal(response.status, 200);
  const manifestText = await response.text();
  const manifest = JSON.parse(manifestText);
  assert.equal(manifest.gameId, 'test-bench');
  assert.equal(digest(manifestText), digest(await readFile(join(root, 'games/test-bench/assets-manifest.json'))), 'Served manifest differs from source; rebuild the portal');
  let bytes = 0;
  for (const asset of manifest.assets) {
    assert.ok(asset.servedUrl.startsWith('/test-bench/'));
    const resource = await request(origin + asset.servedUrl);
    assert.equal(resource.status, 200, asset.id);
    const data = Buffer.from(await resource.arrayBuffer()); bytes += data.length;
    assert.equal(data.length, asset.bytes, `${asset.id}: served size`);
    assert.equal(digest(data), asset.sha256, `${asset.id}: served hash`);
    if (asset.servedUrl.endsWith('.glb')) assert.equal(data.readUInt32LE(0), 0x46546c67, `${asset.id}: GLB magic`);
    if (asset.servedUrl.endsWith('.wav')) assert.equal(data.toString('ascii', 8, 12), 'WAVE', `${asset.id}: WAV magic`);
  }
  return { files: manifest.assets.length, transferredUncompressedBytes: bytes, hashes: 'matched', firstSceneBudgetMeasurement: false };
}

async function cleanup() {
  for (const peer of peers) peer.ws.terminate();
  try { await stop(); } finally { await rm(directory, { recursive: true, force: true }); }
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  void cleanup().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143));
});

let report;
let failure;
try {
  port = await availablePort(); origin = `http://127.0.0.1:${port}`; await start();
  const catalogue = await checkLiveCatalogue(origin);
  const servedAssets = await assets();
  const alice = new Client(), bob = new Client();
  const a = await alice.register('bench_alice'), b = await bob.register('bench_bob');
  assert.notEqual(alice.cookie, bob.cookie, 'The two clients must have independent portal sessions');
  const friendship = await alice.request('/friend-requests', { playerId: b.playerId });
  await bob.request(`/friend-requests/${friendship.requestId}/accept`, {});
  let room = (await alice.request('/rooms', { gameId: 'test-bench', capacity: 3, title: 'Isolated Test Bench transport check', settings: { cup: 'standard' } })).room;
  assert.equal(room.rulesVersion, expectedTestBenchProfile.rulesVersion);
  assert.equal(room.contentVersion, expectedTestBenchProfile.contentVersion);
  const roomId = room.roomId;
  const invitation = (await alice.request(`/rooms/${roomId}/invitations`, { playerId: b.playerId })).invitation;
  await bob.request(`/invitations/${invitation.invitationId}/accept`, {});
  room = (await bob.request(`/rooms/${roomId}/join`, {})).room;
  room = (await alice.request(`/rooms/${roomId}/bots`, { difficulty: 'normal', expectedRevision: room.revision })).room;
  assert.equal(room.members.filter(member => member.controller.kind === 'bot').length, 1);
  room = (await alice.request(`/rooms/${roomId}/ready`, { ready: true, expectedRevision: room.revision })).room;
  room = (await bob.request(`/rooms/${roomId}/ready`, { ready: true, expectedRevision: room.revision })).room;
  room = (await alice.request(`/rooms/${roomId}/start`, { expectedRevision: room.revision })).room;
  const startDeadline = Date.now() + 5000;
  while (room.state !== 'playing' && Date.now() < startDeadline) { await delay(50); room = (await alice.request(`/rooms/${roomId}`)).room; }
  assert.equal(room.state, 'playing'); assert.ok(room.matchId);
  const matchId = room.matchId;
  const peerA = new Peer(alice, roomId), peerB = new Peer(bob, roomId);
  const firstA = await peerA.snapshot(), firstB = await peerB.snapshot();
  assert.equal(firstA.protocol, 'iva-live@1'); assert.equal(firstA.matchId, matchId);
  assert.equal(firstA.view.players.find(player => player.playerId === a.playerId).participantId, firstA.view.you.participantId);
  assert.equal(firstB.view.players.find(player => player.playerId === b.playerId).participantId, firstB.view.you.participantId);
  assert.notEqual(firstA.view.you.participantId, firstB.view.you.participantId);
  assert.equal(firstB.view.players.find(player => player.playerId === a.playerId).blueprint, null);
  const act = async (client, actionId, payload) => {
    const view = (await client.request(`/rooms/${roomId}/match`)).view;
    return client.request(`/rooms/${roomId}/actions`, { actionId, expectedRevision: view.revision, payload: { ...payload, phaseId: view.phaseId } });
  };
  await act(alice, 'bench-confirm-a', { type: 'confirm' });
  let view = (await act(bob, 'bench-confirm-b', { type: 'confirm' })).view;
  assert.equal(view.phase, 'building');
  view = (await alice.request(`/rooms/${roomId}/match`)).view;
  const blueprint = { ...view.you.build.blueprint, motor: 'torque' };
  const buildCommand = { actionId: 'bench-durable-build', expectedRevision: view.revision,
    payload: { type: 'blueprint', phaseId: view.phaseId, buildRevision: view.you.build.revision, blueprint } };
  const buildAfter = peerA.frames.length;
  peerA.send({ ...peerA.scope(firstA), type: 'command', ...buildCommand });
  const built = (await peerA.frame(frame => frame.type === 'receipt' && frame.actionId === buildCommand.actionId, buildAfter)).result;
  assert.deepEqual(built.you.build.blueprint, blueprint); assert.equal(built.you.build.revision, 1);
  assert.equal((await alice.request(`/rooms/${roomId}/actions`, buildCommand)).view.you.build.revision, 1);
  assert.equal((await bob.request(`/rooms/${roomId}/match`)).view.players.find(player => player.playerId === a.playerId).blueprint, null);
  const conflict = await alice.request(`/rooms/${roomId}/actions`, { ...buildCommand,
    payload: { ...buildCommand.payload, blueprint: { ...blueprint, motor: 'speed' } } }, 409);
  assert.equal(conflict.error.code, 'ACTION_CONFLICT');
  const overBudget = await alice.request(`/rooms/${roomId}/actions`, { ...buildCommand, actionId: 'bench-over-budget',
    payload: { ...buildCommand.payload, buildRevision: 1, blueprint: { 'front-axle': 'high', 'rear-axle': 'high', motor: 'torque', battery: 'large', cargo: 'clamp', 'aux-left': 'damper-front', 'aux-right': 'damper-rear' } } }, 400);
  assert.equal(overBudget.error.code, 'OVER_BUDGET');
  await act(alice, 'bench-ready-a', { type: 'ready', ready: true });
  await act(bob, 'bench-ready-b', { type: 'ready', ready: true });
  const racing = await peerA.snapshot(0, frame => frame.view.phase === 'racing');
  let seq = 0;
  for (let i = 0; i < 10; i++) {
    peerA.send({ ...peerA.scope(racing), type: 'input', seq: ++seq, payload: { phaseId: racing.view.phaseId, throttle: 1, steering: 0, brake: false } });
    await delay(50);
  }
  const driven = await peerA.snapshot(0, frame => frame.lastAcceptedSeq >= seq && frame.view.you.lane.car.position.z > racing.view.you.lane.car.position.z + 0.1);
  const neutralAfter = peerA.frames.length;
  peerA.send({ ...peerA.scope(racing), type: 'input', seq: ++seq, payload: { phaseId: racing.view.phaseId, throttle: 0, steering: 0, brake: true } });
  await peerA.snapshot(neutralAfter, frame => frame.lastAcceptedSeq === seq);
  view = (await alice.request(`/rooms/${roomId}/match`)).view;
  const restoreCommand = { actionId: 'bench-durable-restore', expectedRevision: view.revision, payload: { type: 'restore', phaseId: view.phaseId } };
  const restored = (await alice.request(`/rooms/${roomId}/actions`, restoreCommand)).view;
  assert.equal(restored.you.lane.resets, 1);
  const restoreAfter = peerA.frames.length;
  peerA.send({ ...peerA.scope(racing), type: 'command', ...restoreCommand });
  const replay = (await peerA.frame(frame => frame.type === 'receipt' && frame.actionId === restoreCommand.actionId, restoreAfter)).result;
  assert.equal(replay.you.lane.resets, 1);
  const remaining = restored.phaseEndsAt - restored.serverTime;
  await stop(); await peerA.closed(1012); await peerB.closed(1012);
  await start();
  assert.equal((await alice.request(`/rooms/${roomId}`)).room.matchId, matchId);
  const resumedA = new Peer(alice, roomId), resumedB = new Peer(bob, roomId);
  const recovered = await resumedA.snapshot(), recoveredB = await resumedB.snapshot();
  assert.equal(recovered.view.phase, 'recovering'); assert.equal(recoveredB.view.phase, 'recovering');
  assert.ok(recovered.view.phaseEndsAt - recovered.serverTime > 0 && recovered.view.phaseEndsAt - recovered.serverTime <= 5100);
  assert.equal(recovered.view.you.lane.resets, 1);
  assert.equal(recovered.view.you.build.revision, 1); assert.deepEqual(recovered.view.you.build.blueprint, blueprint);
  assert.ok(recovered.view.you.lane.tick >= restored.you.lane.tick);
  assert.ok(recovered.view.you.lane.car.charge <= restored.you.lane.car.charge + 0.00001, 'Restart must not recharge the battery');
  assert.notEqual(recovered.epoch, firstA.epoch); assert.equal(recovered.lastAcceptedSeq, -1);
  assert.equal((await alice.request(`/rooms/${roomId}/actions`, restoreCommand)).view.you.lane.resets, 1);
  const resumed = await resumedA.snapshot(0, frame => frame.view.phase === 'racing', 8000);
  assert.ok(Math.abs((resumed.view.phaseEndsAt - resumed.serverTime) - remaining) < 1500, 'Restart downtime must not consume the race timer');
  const inputAfter = resumedA.frames.length;
  resumedA.send({ ...resumedA.scope(resumed), type: 'input', seq: 1, payload: { phaseId: resumed.view.phaseId, throttle: 0, steering: 0, brake: true } });
  await resumedA.snapshot(inputAfter, frame => frame.lastAcceptedSeq === 1);
  const replacement = new Peer(alice, roomId);
  const replacementSnapshot = await replacement.snapshot(); await resumedA.closed(4001);
  assert.notEqual(replacementSnapshot.epoch, resumed.epoch); assert.equal(replacementSnapshot.lastAcceptedSeq, -1);
  assert.equal(replacementSnapshot.view.you.lane.resets, 1);
  await checkLiveCatalogue(origin);
  await stop();
  const db = new Database(runtimeDatabase, { readonly: true, fileMustExist: true });
  try {
    assert.equal(db.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    for (const actionId of [buildCommand.actionId, restoreCommand.actionId]) {
      assert.equal(db.prepare('SELECT count(*) AS n FROM test_bench_receipts WHERE match_id=? AND action_id=?').get(matchId, actionId).n, 1);
    }
    const durable = JSON.parse(db.prepare('SELECT state FROM test_bench_matches WHERE match_id=?').get(matchId).state);
    assert.equal(durable.lanes[recovered.view.you.participantId].resets, 1);
  } finally { db.close(); }
  report = {
    builtPlatformAcceptance: 'passed', gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    workingTreeDirty: !!execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(),
    builtMainSha256: digest(await readFile(join(build, 'main.js'))), builtWorkerSha256: digest(await readFile(join(build, 'test-bench-worker.js'))),
    productionBuild: true, runtimeMode: 'isolated development authentication with file mailbox', independentAccounts: 2, botSeats: 1,
    catalogue: catalogue.games, assets: servedAssets, realWebSockets: true, personalizedSnapshots: 'passed', privateDrafts: 'passed',
    websocketAndHttpReplay: 'passed', conflictingReplay: 'rejected', budgetViolation: 'rejected', inputAcknowledgement: driven.lastAcceptedSeq,
    gracefulRestart: 'passed', fiveSecondRecovery: 'passed', replayAfterRestart: 'once-only in SQLite', reconnectEpoch: 'replaced',
    controlSupersession: 'old socket closed 4001', fullCupsPlayed: 0, browser: false, audioListening: false, physicalDevice: false,
    telegram: 'disabled', externalMessages: 0,
  };
} catch (error) {
  if (running?.output) console.error(running.output);
  failure = error;
} finally {
  try { await cleanup(); } catch (error) { failure ??= error; }
}
if (failure) throw failure;
await mkdir(join(root, '.qa/test-bench'), { recursive: true });
await writeFile(join(root, '.qa/test-bench/built-platform-acceptance.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
