// Runs inside the isolated candidate image. Real Rapier, HTTP, WebSocket and
// SQLite; this is runtime/persistence acceptance, not a completed expedition.
import assert from 'node:assert/strict';
import { createHash, createPrivateKey, randomBytes, randomUUID, sign } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { WebSocket } from 'ws';

const [phase, revision] = process.argv.slice(2);
assert.ok(['initial', 'restored'].includes(phase));
assert.notEqual(process.getuid(), 0);
const origin = 'https://iva-games.pro', base = 'http://127.0.0.1:4320', protocolVersion = 'iva-realtime@1';
const signerPath = '/tmp/iva-ci-private.pem';
assert.equal(statSync(signerPath).mode & 0o777, 0o600);
assert.equal(statSync(signerPath).uid, process.getuid());
const key = createPrivateKey(readFileSync(signerPath));
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(name => [name, item[name]])) : item);
const signature = (purpose, payload) => sign(null, Buffer.from(`${purpose}\n${payload}`), key).toString('base64url');
async function get(path, expected = 200) {
  const response = await fetch(base + path, { signal: AbortSignal.timeout(5000), redirect: 'error' });
  assert.equal(response.status, expected, path); return response;
}
async function bridge(method, path, body) {
  const unsigned = { keyId: 'ci', nonce: randomBytes(24).toString('base64url'), issuedAt: Date.now(), method, path, body };
  const envelope = { ...unsigned, signature: signature('iva-bridge-v1', canonical(unsigned)) };
  const response = await fetch(base + path, { method, signal: AbortSignal.timeout(5000),
    headers: method === 'GET' ? { 'X-Iva-Service-Request': Buffer.from(JSON.stringify(envelope)).toString('base64url') } : { 'Content-Type': 'application/json' },
    ...(method === 'GET' ? {} : { body: JSON.stringify(envelope) }) });
  assert.equal(response.status, 200, path); return await response.json();
}
const health = await (await get('/health/realtime/ready')).json();
assert.equal(health.ok, true); assert.equal(health.service, 'iva-realtime');
assert.equal(health.protocolVersion, protocolVersion); assert.equal(health.revision, revision);
assert.equal(Object.hasOwn(health, 'diagnostics'), false);
const game = health.games.find(entry => entry.gameId === 'tyaga');
assert.ok(game); assert.match(game.physicsBuildHash, /^rapier3d-0\.21\.0:/);
assert.match(game.runtimeArtifactId, /:[a-f0-9]{64}$/);
await get('/api/realtime/v1/health/tyaga');
const html = await (await get('/play/tyaga/')).text();
assert.match(html, /id="root"/);
const assets = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map(match => match[1]);
assert.ok(assets.some(path => path.endsWith('.js')) && assets.some(path => path.endsWith('.css')));
for (const path of assets) assert.ok((await (await get(new URL(path, base + '/play/tyaga/').pathname)).arrayBuffer()).byteLength > 100);
await get('/play/tyaga/assets/missing.js', 404);
const models = readdirSync('/app/dist-tyaga', { recursive: true }).filter(path => typeof path === 'string' && path.endsWith('.glb'));
assert.ok(models.length >= 10, 'The production image must include the finished model set');
const model = await get('/play/tyaga/' + models[0]);
assert.equal(model.headers.get('content-type'), 'model/gltf-binary');
assert.ok((await model.arrayBuffer()).byteLength > 100);

const marker = '/data/ci-realtime-persistence.json';
const persisted = phase === 'restored' ? JSON.parse(readFileSync(marker, 'utf8')) : null;
const participants = persisted?.participants ?? ['a', 'b'].map((id, seatIndex) => ({
  participantId: `ci-seat-${id}`, playerId: `ci-player-${id}`, displayName: `CI ${id}`, seatIndex,
  controller: { kind: 'human', playerId: `ci-player-${id}` },
}));
let matchId = persisted?.matchId;
if (!matchId) {
  const start = { startCommandId: randomUUID(), roomId: randomUUID(), hostPlayerId: participants[0].playerId, participants,
    rulesVersion: game.rulesVersion, contentVersion: game.contentVersion, settings: { mapId: 'valley', mode: 'practice' } };
  const started = await bridge('POST', '/internal/realtime/v1/matches', { gameId: 'tyaga', input: start });
  const retry = await bridge('POST', '/internal/realtime/v1/matches', { gameId: 'tyaga', input: start });
  assert.deepEqual(retry, started); matchId = started.matchId;
}
const status = await bridge('GET', `/internal/realtime/v1/matches/${matchId}/status`, {});
const clientHash = status.manifest.clientContentHash, clientRoute = status.manifest.clientRoute;
assert.match(clientHash, /^[a-f0-9]{64}$/);
assert.equal(clientRoute, `/play/tyaga/versions/${clientHash}/`);
const retainedHtml = await (await get(clientRoute)).text();
assert.match(retainedHtml, /id="root"/);
const retainedAssets = [...retainedHtml.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map(match => match[1]);
assert.ok(retainedAssets.length >= 2);
for (const path of retainedAssets) assert.ok((await (await get(new URL(path, base + clientRoute).pathname)).arrayBuffer()).byteLength > 100);
const retainedModel = Buffer.from(await (await get(clientRoute + models[0])).arrayBuffer());
const modelHash = createHash('sha256').update(retainedModel).digest('hex');
assert.ok(retainedModel.length > 100);
const font = await get(clientRoute + 'assets/tyaga/fonts/golos-text-variable.ttf');
assert.equal(font.headers.get('content-type'), 'font/ttf'); assert.ok((await font.arrayBuffer()).byteLength > 100);
await get(clientRoute + 'assets/missing.js', 404);
if (persisted) {
  assert.equal(status.phase, 'paused');
  assert.equal(status.manifest.runtimeArtifactId, persisted.runtimeArtifactId);
  assert.equal(clientHash, persisted.clientContentHash); assert.equal(modelHash, persisted.modelHash);
}
function apply(baseline, changes) {
  let value = structuredClone(baseline);
  for (const change of changes) {
    if (!change.path.length) { value = structuredClone(change.value); continue; }
    let parent = value;
    for (const field of change.path.slice(0, -1)) parent = parent[field];
    const field = change.path.at(-1);
    if (change.remove) delete parent[field]; else parent[field] = structuredClone(change.value);
  }
  return value;
}
async function connect(participant) {
  const now = Date.now();
  const claims = { issuer: 'iva-platform', audience: 'iva-realtime', keyId: 'ci', ticketId: randomBytes(24).toString('base64url'),
    playerId: participant.playerId, participantId: participant.participantId, matchId, roomId: status.roomId, rosterHash: status.rosterHash,
    gameId: 'tyaga', rulesVersion: game.rulesVersion, contentVersion: game.contentVersion, protocolVersion,
    allowedOrigin: origin, permission: 'play', sessionId: createHash('sha256').update(participant.playerId).digest('hex'), issuedAt: now, expiresAt: now + 30_000 };
  const encoded = Buffer.from(canonical(claims)).toString('base64url');
  const ws = new WebSocket('ws://127.0.0.1:4320/ws/realtime/v1', 'iva-realtime-v1', { origin });
  const client = { ws, snapshot: null, acks: [], errors: [] }, baselines = new Map();
  ws.on('message', data => {
    const frame = JSON.parse(data.toString());
    if (frame.type === 'error') client.errors.push(frame);
    if (frame.type === 'actionAck') client.acks.push(frame);
    if (frame.type === 'full' || frame.type === 'delta') {
      if (frame.type === 'delta') frame.view = apply(baselines.get(frame.baselineSnapshotSeq).view, frame.changes);
      client.snapshot = frame; baselines.set(frame.snapshotSeq, frame);
      while (baselines.size > 32) baselines.delete(baselines.keys().next().value);
      ws.send(JSON.stringify({ ...scope(client), type: 'ackSnapshot', snapshotSeq: frame.snapshotSeq }));
    }
  });
  await new Promise((accept, reject) => { ws.once('error', reject); ws.once('open', accept); });
  ws.send(JSON.stringify({ type: 'authenticate', ticket: `${encoded}.${signature('iva-ticket-v1', encoded)}` }));
  return client;
}
function scope(client) { const s = client.snapshot; return { protocolVersion, matchId, epoch: s.epoch, controllerGeneration: s.controllerGeneration }; }
async function until(predicate, label, timeout = 10_000) {
  const limit = Date.now() + timeout;
  while (!predicate()) { assert.ok(Date.now() < limit, label); await new Promise(accept => setTimeout(accept, 25)); }
}
const clients = await Promise.all(participants.map(connect));
await until(() => clients.every(client => client.snapshot?.phase === 'running'), 'both clients entered the real running world');
const a = clients[0], actionId = persisted?.actionId ?? randomUUID();
const payload = { type: 'appearance', head: 1, backpack: 1 };
a.ws.send(JSON.stringify({ ...scope(a), type: 'action', actionId, payload }));
await until(() => a.acks.some(ack => ack.actionId === actionId), 'durable appearance ACK');
const ack = a.acks.find(entry => entry.actionId === actionId);
assert.equal(ack.result.ok, true);
if (persisted) {
  assert.deepEqual(ack.result, persisted.ack.result);
  assert.equal(ack.committedJournalSeq, persisted.ack.committedJournalSeq, 'retry after restart must retain the exact original receipt');
} else {
  const body = () => a.snapshot.view.entities.find(entity => entity.participantId === participants[0].participantId);
  const initial = { ...body().position };
  for (let seq = 0; seq < 30; seq++) {
    a.ws.send(JSON.stringify({ ...scope(a), type: 'input', inputSeq: seq, payload: { moveX: 1, moveZ: 0, run: false, throttle: 0, steer: 0, brake: false, tool: 0 } }));
    await new Promise(accept => setTimeout(accept, 50));
  }
  assert.ok(Math.hypot(body().position.x - initial.x, body().position.z - initial.z) > 0.1, 'real input must move the physical character');
  writeFileSync(marker, JSON.stringify({ matchId, participants, actionId, ack, runtimeArtifactId: a.snapshot.manifest.runtimeArtifactId,
    clientContentHash: clientHash, modelHash }), { mode: 0o600, flag: 'wx' });
}
await until(() => clients.every(client => client.snapshot.view.participants[0].appearance?.head === 1), 'both clients saw the persistent action');
assert.deepEqual(clients.flatMap(client => client.errors), []);
const measurements = await bridge('GET', '/internal/realtime/v1/metrics', {});
assert.equal(measurements.diagnostics.legacyWorkers, 0);
assert.ok(measurements.diagnostics.instrumentedWorkers > 0);
assert.ok(measurements.diagnostics.workers.some(worker => worker.diagnostics.games.some(game => game.gameId === 'tyaga' && game.step.count > 0)));
assert.equal(measurements.gateway.connections.length, 2);
assert.equal(measurements.gateway.totals.rateLimits, 0); assert.equal(measurements.gateway.totals.queueOverflows, 0);
await Promise.all(clients.map(client => new Promise(accept => { client.ws.once('close', accept); client.ws.close(); })));
const db = new Database('/data/realtime.sqlite', { readonly: true, fileMustExist: true });
assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
assert.equal(db.pragma('quick_check', { simple: true }), 'ok');
assert.deepEqual(db.pragma('foreign_key_check'), []);
assert.equal(db.prepare('SELECT count(*) AS n FROM rt_receipts').get().n, 1);
assert.equal(db.prepare('SELECT count(*) AS n FROM rt_checkpoints').get().n, 1);
db.close();
console.log(`realtime/${phase}: real Rapier, two sockets, movement, action receipt, static assets and durable recovery passed.`);
