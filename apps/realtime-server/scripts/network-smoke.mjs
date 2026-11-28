/** Real HTTP/WebSocket/SQLite probe. This is protocol automation, not browser play. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { appendFile, cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import WebSocket from 'ws';
import Database from 'better-sqlite3';
import { sourceIdentity } from './probe-lib.mjs';
const root = fileURLToPath(new URL('../../../', import.meta.url));
await mkdir(resolve(root, '.qa'), { recursive: true });
const directory = await mkdtemp(resolve(root, '.qa/realtime-network-'));
const sourceTrace = await sourceIdentity();
const capacityFixture = { schema: 'iva-realtime-capacity-1', gameId: 'forpost', artifactId: 'test-fixture', source: 'test-fixture',
  evidence: 'Two simultaneously retained versions for a functional HTTP/WS probe. These sizing inputs are synthetic, not measured capacity.',
  maxRooms: 2, maxBodies: 112, maxBots: 12, maxConnections: 24, stepP99Ms: 8, roomMemoryBytes: 128 * 1024 * 1024 };
await writeFile(resolve(directory, 'capacity-fixture.json'), JSON.stringify(capacityFixture));
const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
const port = probe.address().port; await new Promise(r => probe.close(r));
const origin = `http://127.0.0.1:${port}`;
let processHandle, logs = '', cookie = '', clients = [], entry = resolve(root, 'dist-realtime/main.js');
let staticDirectory = resolve(root, 'games/forpost/dist');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function start() {
  logs = '';
  processHandle = spawn(process.execPath, [entry], { cwd: root,
    env: { ...process.env, REALTIME_PORT: String(port), REALTIME_HOST: '127.0.0.1', REALTIME_PUBLIC_ORIGIN: origin,
      REALTIME_DATABASE_PATH: resolve(directory, 'realtime.sqlite'), REALTIME_PRACTICE_KEY_PATH: resolve(directory, 'key.pem'),
      REALTIME_STATIC_DIRECTORY: staticDirectory, IVA_BUILD_SHA: process.env.IVA_BUILD_SHA ?? sourceTrace.gitCommit,
      NODE_ENV: 'test', REALTIME_CAPACITY_PROFILE_PATH: resolve(directory, 'capacity-fixture.json') },
    stdio: ['ignore', 'pipe', 'pipe'] });
  processHandle.stdout.on('data', d => { logs = (logs + d).slice(-6000); });
  processHandle.stderr.on('data', d => { logs = (logs + d).slice(-6000); });
  for (let i = 0; i < 250; i++) {
    try { const r = await fetch(origin + '/health/ready'); if (r.ok) return; } catch { /* startup */ }
    if (processHandle.exitCode !== null) throw new Error('Server exited during startup: ' + logs);
    await sleep(100);
  }
  throw new Error('Server health timeout: ' + logs);
}
async function stop() {
  if (!processHandle || processHandle.exitCode !== null) return;
  for (const client of clients) client.close(); clients = [];
  const exited = once(processHandle, 'exit'); processHandle.kill('SIGTERM');
  const [code] = await exited; assert.equal(code, 0, 'drained server shutdown');
}
async function post(path, value = {}, useCookie = true) {
  const response = await fetch(origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, ...(useCookie && cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(value) });
  if (useCookie && response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
  return { status: response.status, body: await response.json(), setCookie: response.headers.get('set-cookie') };
}
async function socket(ticket) {
  const ws = new WebSocket(origin.replace('http:', 'ws:') + '/ws/realtime/v1', 'iva-realtime-v1', { origin });
  const messages = [], baselines = new Map();
  ws.on('message', raw => {
    const message = JSON.parse(raw.toString());
    if (message.type === 'full' || message.type === 'delta') {
      if (message.type === 'delta') {
        const baseline = baselines.get(message.baselineSnapshotSeq);
        if (!baseline) { messages.push({ type: 'protocolFailure', code: 'MISSING_BASELINE' }); return; }
        assert.equal(message.view, undefined, 'delta carries only a filtered patch'); message.view = { ...baseline, ...message.patch };
      }
      baselines.set(message.snapshotSeq, message.view);
      while (baselines.size > 32) baselines.delete(baselines.keys().next().value);
      ws.send(JSON.stringify({ type: 'ackSnapshot', protocolVersion: 1, matchId: message.matchId, epoch: message.epoch, controllerGeneration: message.controllerGeneration, snapshotSeq: message.snapshotSeq }));
    }
    messages.push(message);
  });
  await once(ws, 'open'); ws.send(JSON.stringify({ type: 'authenticate', ticket }));
  const client = { ws, messages, hello: null, beat: null,
    async wait(predicate, ms = 7000) {
      const until = Date.now() + ms;
      while (Date.now() < until) { const index = messages.findIndex(predicate); if (index >= 0) return messages.splice(index, 1)[0]; await sleep(20); }
      throw new Error('Message wait timed out; observed types: ' + messages.map(m => m.type + (m.code ? ':' + m.code : '')).join(','));
    },
    send(type, extra = {}) {
      ws.send(JSON.stringify({ type, protocolVersion: 1, matchId: client.hello.matchId, epoch: client.hello.epoch, controllerGeneration: client.hello.controllerGeneration, ...extra }));
    },
    close() { clearInterval(client.beat); ws.close(); },
  };
  clients.push(client); return client;
}
async function admitted(ticket) {
  const client = await socket(ticket); client.hello = await client.wait(m => m.type === 'hello');
  client.beat = setInterval(() => { if (client.ws.readyState === WebSocket.OPEN) client.send('heartbeat'); }, 1000);
  return client;
}
const passed = [];
const snapshot = message => message.type === 'full' || message.type === 'delta';
function committedSpend(matchId, participantId) {
  const database = new Database(resolve(directory, 'realtime.sqlite'), { readonly: true });
  try {
    const saved = JSON.parse(database.prepare('SELECT record_json FROM rt_matches WHERE match_id=?').get(matchId).record_json);
    return JSON.parse(saved.world).participants.find(person => person.id === participantId).statistics.spent;
  } finally { database.close(); }
}
try {
  await start();
  const startRoom = await post('/api/realtime/v1/practice', { mapId: 'FP01', teamSize: 1, displayName: 'QA', botLevel: 'novice', mode: 'training', seed: 9123 });
  assert.equal(startRoom.status, 201); const firstTicket = startRoom.body.ticket, matchId = startRoom.body.matchId;
  assert.ok(startRoom.setCookie?.includes('HttpOnly') && startRoom.setCookie.includes('SameSite=Strict') && startRoom.setCookie.includes('Max-Age=2592000'));
  const firstOwnerCookie = cookie;
  assert.match(startRoom.body.route, /^\/realtime-assets\/[0-9a-f]{64}\/$/);
  const originalHtml = await (await fetch(origin + startRoom.body.route)).text();
  assert.equal(originalHtml, await (await fetch(origin + '/play/forpost/')).text());
  passed.push('current build and content-addressed client serve identical accepted bytes');
  const first = await admitted(firstTicket), firstView = await first.wait(m => m.type === 'full');
  assert.equal(first.hello.controlling, true); assert.equal(firstView.view.matchId, matchId);
  assert.equal(firstView.world, undefined); assert.equal(firstView.view.seed, undefined); assert.equal(firstView.view.history, undefined);
  first.send('input', { inputSeq: 500, payload: { moveX: 0, moveZ: 0, aimX: 1, aimZ: 0, fireHeld: false, firePressSeq: 0 } });
  await first.wait(m => snapshot(m) && m.worldTick > 2 && m.lastConsumedInputSeq === 500);
  // Preparation intentionally freezes units; movement must be checked in battle.
  await first.wait(m => snapshot(m) && m.view.phase === 'battle', 25_000);
  assert.ok(first.messages.some(m => m.type === 'delta')); assert.equal(first.messages.some(m => m.type === 'protocolFailure'), false);
  first.send('resync'); await first.wait(m => m.type === 'full' && m.view.phase === 'battle');
  passed.push('personal acknowledged delta stream and requested full resynchronization');
  passed.push('real practice admission and filtered full');
  const replay = await socket(firstTicket); await replay.wait(m => m.type === 'error');
  assert.equal(replay.messages.some(snapshot), false); replay.close(); passed.push('one-use ticket denied before state');
  const unauthorized = await post(`/api/realtime/v1/practice/${matchId}/ticket`, {}, false); assert.equal(unauthorized.status, 404); passed.push('another guest cannot resume');
  const secondTicket = await post(`/api/realtime/v1/practice/${matchId}/ticket`), second = await admitted(secondTicket.body.ticket);
  assert.ok(secondTicket.setCookie?.includes('Max-Age=2592000')); assert.ok(cookie === firstOwnerCookie, 'ticket renewal preserves opaque ownership');
  passed.push('HttpOnly guest identity renews for thirty days without a script bearer or identity rotation');
  assert.equal(second.hello.controlling, false); second.send('claimControl');
  const control = await second.wait(m => m.type === 'controlChanged' && m.controlling); second.hello.controllerGeneration = control.controllerGeneration;
  await first.wait(m => m.type === 'controlChanged' && !m.controlling);
  first.send('input', { inputSeq: 1, payload: { moveX: 1, moveZ: 0, aimX: 1, aimZ: 0, fireHeld: false, firePressSeq: 0 } });
  await first.wait(m => m.type === 'error' && m.code === 'STALE_CONTROLLER'); passed.push('atomic one-controller transfer');
  const startMove = await second.wait(m => snapshot(m) && m.controllerGeneration === control.controllerGeneration && m.view.phase === 'battle');
  const initialFighter = startMove.view.units.find(u => u.ownerId === second.hello.participantId && u.kind === 'fighter');
  const direction = startMove.view.teams[startMove.view.yourTeam].side === 'L' ? 1 : -1;
  second.send('input', { inputSeq: 1, payload: { moveX: direction, moveZ: 0, aimX: direction, aimZ: 0, fireHeld: false, firePressSeq: 0 } });
  const moved = await second.wait(m => snapshot(m) && m.worldTick >= startMove.worldTick + 18);
  const movedFighter = moved.view.units.find(u => u.id === initialFighter.id);
  assert.ok((movedFighter.x - initialFighter.x) * direction > 0.1, 'new controller sequence 1 moves after previous stream sequence 500');
  const neutral = await second.wait(m => snapshot(m) && m.worldTick >= moved.worldTick + 12);
  const stoppedFighter = neutral.view.units.find(u => u.id === initialFighter.id);
  assert.ok(Math.abs(stoppedFighter.x - movedFighter.x) < 0.05, 'stale movement neutralizes without a key-up packet');
  passed.push('new input sequence after takeover and stale movement neutralization');
  const actionId = 'forpost-smoke-mode-1'; second.send('action', { actionId, payload: { type: 'mode', mode: 'tactics' } });
  const ack = await second.wait(m => m.type === 'actionAck' && m.actionId === actionId); assert.equal(ack.result.ok, true);
  second.send('action', { actionId, payload: { type: 'mode', mode: 'tactics' } });
  const repeated = await second.wait(m => m.type === 'actionAck' && m.actionId === actionId); assert.equal(repeated.replayed, true); assert.deepEqual(repeated.result, ack.result);
  second.send('action', { actionId, payload: { type: 'mode', mode: 'fighter' } }); await second.wait(m => m.type === 'error' && m.code === 'ACTION_CONFLICT');
  passed.push('durable ACK repeat and payload conflict');
  const before = await second.wait(m => snapshot(m) && m.worldTick > 10);
  first.close(); second.close();
  await sleep(11_000);
  const observedDatabase = new Database(resolve(directory, 'realtime.sqlite'), { readonly: true });
  try {
    const readPause = () => JSON.parse(observedDatabase.prepare('SELECT record_json FROM rt_matches WHERE match_id=?').get(matchId).record_json);
    const paused = readPause(); assert.equal(paused.phase, 'paused');
    await sleep(400); assert.equal(readPause().tick, paused.tick, 'empty durable pause does not advance game time');
  } finally { observedDatabase.close(); }
  const health = await (await fetch(origin + '/health/ready')).json(); assert.equal(health.ok, true); assert.equal(health.metrics.storageFailures, 0);
  await stop(); await start();
  const restoredTicket = await post(`/api/realtime/v1/practice/${matchId}/ticket`); assert.equal(restoredTicket.status, 200);
  const restored = await admitted(restoredTicket.body.ticket), full = await restored.wait(m => m.type === 'full');
  assert.ok(restored.hello.epoch > first.hello.epoch); assert.ok(full.worldTick >= before.worldTick); assert.equal(full.view.matchId, matchId);
  assert.equal(full.lastConsumedInputSeq, -1, 'a new generation cannot acknowledge the previous input stream');
  restored.send('action', { actionId, payload: { type: 'mode', mode: 'tactics' } });
  const restoredAck = await restored.wait(m => m.type === 'actionAck' && m.actionId === actionId); assert.equal(restoredAck.replayed, true);
  passed.push('pause, process restart, same match and committed receipt');
  const purchaseOptions = view => Object.entries(view.buildOptions).flatMap(([padId, entries]) => entries.filter(entry => entry.ok).map(entry => ({ padId, ...entry }))).sort((a, b) => a.cost - b.cost);
  let purchaseView = full.view;
  if (!purchaseOptions(purchaseView).length) {
    // The temporary bot may legitimately have spent the wallet during absence.
    // Cancel its unstarted own order through the actual gameplay API first.
    const queued = purchaseView.buildOrders.find(order => order.ownerId === purchaseView.you && !order.buildingId);
    if (queued) {
      const cancelId = 'forpost-smoke-prepare-purchase'; restored.send('action', { actionId: cancelId, payload: { type: 'cancelBuild', orderId: queued.id } });
      assert.equal((await restored.wait(message => message.type === 'actionAck' && message.actionId === cancelId)).result.ok, true);
    }
    purchaseView = (await restored.wait(message => snapshot(message) && purchaseOptions(message.view).length > 0, 35_000)).view;
  }
  const option = purchaseOptions(purchaseView)[0];
  assert.ok(option, 'a real legal purchase exists before the lost-ACK crash');
  const purchaseId = 'forpost-smoke-purchase-lost-ack', purchasePayload = { type: 'build', padId: option.padId, kind: option.kind };
  assert.equal(purchaseView.participants.find(person => person.id === purchaseView.you).statistics, undefined, 'live combat statistics remain private');
  const spentBeforePurchase = committedSpend(matchId, purchaseView.you);
  // Stop receiving bytes before the request. The writer remains real SQLite;
  // observe its receipt, then destroy the socket without delivering that ACK.
  restored.ws._socket.pause(); restored.send('action', { actionId: purchaseId, payload: purchasePayload });
  let purchaseReceipt;
  const purchaseDatabase = new Database(resolve(directory, 'realtime.sqlite'), { readonly: true });
  try {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && !purchaseReceipt) {
      const row = purchaseDatabase.prepare('SELECT record_json FROM rt_actions WHERE match_id=? AND action_id=?').get(matchId, purchaseId);
      if (row) purchaseReceipt = JSON.parse(row.record_json); else await sleep(20);
    }
  } finally { purchaseDatabase.close(); }
  assert.equal(purchaseReceipt?.result.ok, true, 'purchase has a durable receipt before process death');
  assert.equal(restored.messages.some(message => message.type === 'actionAck' && message.actionId === purchaseId), false, 'purchase ACK was not received');
  const previousEpoch = restored.hello.epoch;
  for (const client of clients) { clearInterval(client.beat); client.ws.terminate(); } clients = [];
  const killed = once(processHandle, 'exit'); processHandle.kill('SIGKILL'); await killed; processHandle = null;
  await start();
  const crashTicket = await post(`/api/realtime/v1/practice/${matchId}/ticket`); assert.equal(crashTicket.status, 200);
  const crashClient = await admitted(crashTicket.body.ticket); assert.ok(crashClient.hello.epoch > previousEpoch);
  const crashFull = await crashClient.wait(message => message.type === 'full');
  assert.equal(crashFull.view.buildOrders.filter(order => order.id === purchaseReceipt.result.entityId).length, 1);
  assert.equal(committedSpend(matchId, crashFull.view.you), spentBeforePurchase + option.cost);
  crashClient.send('action', { actionId: purchaseId, payload: purchasePayload });
  const purchaseReplay = await crashClient.wait(message => message.type === 'actionAck' && message.actionId === purchaseId);
  assert.equal(purchaseReplay.replayed, true); assert.deepEqual(purchaseReplay.result, purchaseReceipt.result);
  passed.push('real purchase, deliberately unreceived ACK, SIGKILL and one restored order/charge/receipt');
  crashClient.send('action', { actionId, payload: { type: 'mode', mode: 'tactics' } });
  assert.equal((await crashClient.wait(m => m.type === 'actionAck' && m.actionId === actionId)).replayed, true);
  passed.push('abrupt process death, expired lease and durable receipt recovery');
  const pinnedArtifact = crashClient.hello.artifactId;
  await stop();
  const updatedDirectory = resolve(directory, 'updated-build');
  await cp(resolve(root, 'dist-realtime'), updatedDirectory, { recursive: true });
  const updatedClient = resolve(directory, 'updated-client'); await cp(staticDirectory, updatedClient, { recursive: true });
  await appendFile(resolve(updatedClient, 'index.html'), '\n<!-- controlled client-content retention probe -->\n'); staticDirectory = updatedClient;
  // A deliberately different compiled artifact tests version routing, not game balance.
  await appendFile(resolve(updatedDirectory, 'simulation-worker.js'), '\n// controlled artifact-retention probe\n');
  entry = resolve(updatedDirectory, 'main.js'); await start();
  const newHealth = await (await fetch(origin + '/health/ready')).json(); assert.notEqual(newHealth.artifactId, pinnedArtifact);
  const pinnedTicket = await post(`/api/realtime/v1/practice/${matchId}/ticket`), pinned = await admitted(pinnedTicket.body.ticket);
  assert.equal(pinned.hello.artifactId, pinnedArtifact);
  assert.equal(pinnedTicket.body.route, startRoom.body.route); assert.equal(await (await fetch(origin + pinnedTicket.body.route)).text(), originalHtml);
  pinned.send('action', { actionId, payload: { type: 'mode', mode: 'tactics' } });
  assert.equal((await pinned.wait(m => m.type === 'actionAck' && m.actionId === actionId)).replayed, true);
  const fresh = await post('/api/realtime/v1/practice', { mapId: 'FP03', teamSize: 1, displayName: 'QA next image', mode: 'training' });
  assert.equal(fresh.status, 201); const freshClient = await admitted(fresh.body.ticket);
  assert.equal(freshClient.hello.artifactId, newHealth.artifactId);
  assert.notEqual(fresh.body.route, startRoom.body.route); assert.match(await (await fetch(origin + fresh.body.route)).text(), /controlled client-content retention probe/);
  await post(`/api/realtime/v1/practice/${fresh.body.matchId}/abandon`);
  passed.push('new artifact starts new rooms while existing rooms retain exact simulation code');
  const abandoned = await post(`/api/realtime/v1/practice/${matchId}/abandon`); assert.equal(abandoned.status, 200);
  passed.push('owner can end saved practice');
  await stop();
  console.log(JSON.stringify({ passed: passed.length, checks: passed, artifactId: health.artifactId, contentId: health.contentId,
    sourceTrace, capacityFixture, lastHealth: health.metrics, evidenceDirectory: directory, kind: 'automated HTTP/WebSocket, not browser or capacity acceptance' }, null, 2));
} catch (error) { console.error(logs); throw error; }
finally { await stop(); }
