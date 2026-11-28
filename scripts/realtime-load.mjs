// Real compiled realtime, Rapier, signed bridge, independent WebSockets and
// continuous inputs. This measures this machine; it is not browser gameplay,
// a completed expedition, a network-loss emulator, or a production VPS claim.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { generateKeyPairSync, randomBytes, randomUUID, sign, createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { resolve, join } from 'node:path';
import os from 'node:os';
import { WebSocket } from 'ws';
import { applyLoadChanges } from './realtime-load-view.mjs';
import { inspectProcessAffinity, requestedServerCpus, validateServerAffinity, processCpuFraction } from './realtime-load-affinity.mjs';

const allowed = new Set(['--output', '--runtime', '--client', '--seconds', '--rooms', '--profile', '--memory-mib', '--scene', '--map', '--server-cpus']);
const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  assert.ok(allowed.has(process.argv[index]) && process.argv[index + 1] && !args.has(process.argv[index]), 'Use documented --name value arguments');
  args.set(process.argv[index], process.argv[index + 1]);
}
const seconds = Number(args.get('--seconds') ?? 3600), rooms = Number(args.get('--rooms') ?? 2), profile = args.get('--profile') ?? 'humans';
const scene = args.get('--scene') ?? 'normal', requestedMap = args.get('--map') ?? null;
const serverCpus = requestedServerCpus(args.get('--server-cpus'));
assert.ok(serverCpus === null || process.platform === 'linux', 'Explicit CPU-budget validation requires Linux taskset and /proc');
const harnessAffinity = process.platform === 'linux' ? inspectProcessAffinity(process.pid) : null;
assert.ok(Number.isInteger(seconds) && seconds >= 20 && seconds <= 86_400);
assert.ok(Number.isInteger(rooms) && rooms >= 1 && rooms <= 8 && ['humans', 'bots'].includes(profile));
assert.ok(['normal', 'ferry', 'lift', 'paired'].includes(scene));
assert.ok(requestedMap === null || ['valley', 'quarry', 'ridge'].includes(requestedMap));
if (scene !== 'normal') { assert.equal(profile, 'humans', 'Heavy fixtures retain six independent human protocol controllers'); assert.equal(requestedMap, null, 'Heavy scene determines its actual map'); assert.equal(rooms, scene === 'paired' ? 2 : 1); }
const humanCount = profile === 'humans' ? 6 : 1;
const output = resolve(args.get('--output') ?? `.qa/realtime-load/${Date.now()}-${profile}`);
assert.equal(existsSync(output), false, 'Load evidence directory must be new; never overwrite a saved database'); mkdirSync(output, { recursive: true, mode: 0o700 });
const data = join(output, 'data'); mkdirSync(data);
const memoryBudgetBytes = args.has('--memory-mib') ? Number(args.get('--memory-mib')) * 1024 ** 2 : os.totalmem();
assert.ok(Number.isFinite(memoryBudgetBytes) && memoryBudgetBytes >= 128 * 1024 ** 2);
const runtime = resolve(args.get('--runtime') ?? 'dist-realtime/main.js'), clientDirectory = resolve(args.get('--client') ?? 'games/tyaga/dist');
assert.ok(existsSync(runtime) && existsSync(join(clientDirectory, 'index.html')), 'Build the exact runtime/client before this test');
const publicFile = join(output, 'trusted-public.json'), keys = generateKeyPairSync('ed25519');
writeFileSync(publicFile, JSON.stringify({ load: keys.publicKey.export({ type: 'spki', format: 'pem' }) }), { mode: 0o600 });
const machine = { node: process.version, platform: process.platform, arch: process.arch, kernel: os.release(), cpuModel: os.cpus()[0]?.model,
  reportedLogicalCpus: os.availableParallelism(), reportedMemoryBytes: os.totalmem(), freeMemoryAtStart: os.freemem(),
  memoryReferenceBytes: memoryBudgetBytes, memoryReference: args.has('--memory-mib') ? 'explicit test budget, not an enforced limit' : 'OS-reported machine total, allocation limit not inferred',
  harnessAffinity, runtimeAffinity: null,
  cpuBudget: serverCpus === null ? null : { cpus: serverCpus, logicalCores: serverCpus.length, verified: false, kind: 'Explicit task affinity; not a quota, exclusive reservation or VPS allocation' },
  harnessUsesDisjointCpus: serverCpus === null ? null : harnessAffinity.threadCpuSets.every(mask => mask.every(cpu => !serverCpus.includes(cpu))),
  productionVpsMeasured: false };
if (serverCpus) assert.equal(machine.harnessUsesDisjointCpus, true, 'Pin this load generator to other CPUs before using --server-cpus');
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(name => [name, item[name]])) : item);
const signature = (purpose, payload) => sign(null, Buffer.from(`${purpose}\n${payload}`), keys.privateKey).toString('base64url');
const sleep = milliseconds => new Promise(done => setTimeout(done, milliseconds));
const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening'); const port = probe.address().port; await new Promise(done => probe.close(done));
const origin = `http://127.0.0.1:${port}`;
let prepared = null;
if (scene !== 'normal') {
  try {
    const { seedHeavyLoad } = await import('../.qa/realtime-heavy-seed-build/seed.js');
    prepared = await seedHeavyLoad({ runtime, clientDirectory, data, rooms, scene });
  } catch (error) {
    writeFileSync(join(output, 'report.json'), JSON.stringify({ complete: false, localBudgetPassed: false, stage: 'heavy-fixture-preparation', scene, error: error.message }, null, 2));
    throw error;
  }
}
const command = serverCpus === null ? process.execPath : 'taskset', commandArgs = serverCpus === null ? [runtime] : ['-c', serverCpus.join(','), process.execPath, runtime];
const child = spawn(command, commandArgs, { env: { ...process.env, NODE_ENV: 'test', REALTIME_HOST: '127.0.0.1', REALTIME_PORT: String(port),
  REALTIME_DATABASE_PATH: join(data, 'realtime.sqlite'), REALTIME_ARTIFACT_DIRECTORY: join(data, 'runtime-artifacts'), REALTIME_TRUSTED_KEYS_FILE: publicFile, REALTIME_ALLOWED_ORIGINS: origin,
  REALTIME_ALLOWED_HOSTS: `127.0.0.1:${port}`, REALTIME_TYAGA_STATIC_DIRECTORY: clientDirectory, REALTIME_MAX_MATCHES: String(rooms), REALTIME_REVISION: 'isolated-load-test' }, stdio: ['ignore', 'pipe', 'pipe'] });
let tail = '', fatal = null, stopping = false;
const childExit = once(child, 'exit');
for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { appendFileSync(join(output, 'runtime.log'), bytes); tail = (tail + bytes).slice(-8192); });
child.once('exit', code => { if (!stopping) fatal = new Error(`Runtime exited ${code}: ${tail}`); });
const clients = [], starts = [], timers = [], errors = [], measurements = [];
const sceneProgress = new Map();
let measuring = false, measurementStarted = 0;
let errorCount = 0;
const recordError = value => { errorCount += 1; if (errors.length < 100) errors.push(value); };
let interrupted = false;
process.once('SIGINT', () => { interrupted = true; }); process.once('SIGTERM', () => { interrupted = true; });
const record = value => appendFileSync(join(output, 'measurements.jsonl'), JSON.stringify(value) + '\n');
async function bridge(path, body = {}, method = 'POST', expected = 200) {
  const unsigned = { keyId: 'load', nonce: randomBytes(24).toString('base64url'), issuedAt: Date.now(), method, path, body };
  const envelope = { ...unsigned, signature: signature('iva-bridge-v1', canonical(unsigned)) };
  const response = await fetch(origin + path, { method, headers: method === 'GET' ? { 'X-Iva-Service-Request': Buffer.from(JSON.stringify(envelope)).toString('base64url') } : { 'Content-Type': 'application/json' },
    ...(method === 'GET' ? {} : { body: JSON.stringify(envelope) }), signal: AbortSignal.timeout(10_000) });
  const value = await response.json(); assert.equal(response.status, expected, JSON.stringify(value)); return value;
}
const metrics = () => bridge('/internal/realtime/v1/metrics', {}, 'GET');
const scope = client => ({ protocolVersion: 'iva-realtime@1', matchId: client.matchId, epoch: client.snapshot.epoch, controllerGeneration: client.snapshot.controllerGeneration });
function send(client, value) { if (client.ws.readyState === WebSocket.OPEN && client.snapshot) { client.ws.send(JSON.stringify({ ...scope(client), ...value })); client.sent += 1; } }
function observeScene(client, view) {
  if (!prepared || !measuring || !client.participantId.endsWith('-1')) return;
  const ferry = view.mapId === 'quarry', target = ferry ? 'ferry-deck' : 'lift-platform';
  const platform = view.entities.find(entity => entity.id === target), machine = ferry ? view.machinery.ferry : view.machinery.lift;
  const ropeViews = view.connections.filter(link => link.kind === 'rope');
  const contactSegments = ropeViews.reduce((sum, rope) => sum + Math.max(0, rope.points.length - 2), 0);
  const operator = view.participants.find(participant => participant.participantId === client.participantId)?.controlling;
  const cargo = ['cargo-1', 'cargo-2', 'cargo-3'].map(id => view.entities.find(entity => entity.id === id));
  const truckAndCrate = ['truck', 'equipment-crate'].map(id => view.entities.find(entity => entity.id === id));
  const crew = view.participants.map(participant => view.entities.find(entity => entity.participantId === participant.participantId));
  const progress = sceneProgress.get(client.matchId) ?? { mapId: view.mapId, samples: 0, firstPosition: platform?.position,
    minHeight: Infinity, maxHeight: -Infinity, maximumHorizontalDisplacement: 0, maximumRopeTension: 0,
    expectedPayloadKg: prepared.evidence.find(scene => scene.mapId === view.mapId).expectedPayloadKg,
    minPayload: Infinity, maxPayload: 0, minContactSegments: Infinity, maxContactSegments: 0, violations: new Set() };
  if (platform && machine) {
    progress.firstPosition ??= platform.position;
    const height = ferry ? platform.position.y : machine.height;
    progress.minHeight = Math.min(progress.minHeight, height); progress.maxHeight = Math.max(progress.maxHeight, height);
    progress.maximumHorizontalDisplacement = Math.max(progress.maximumHorizontalDisplacement, Math.hypot(platform.position.x - progress.firstPosition.x, platform.position.z - progress.firstPosition.z));
    progress.minPayload = Math.min(progress.minPayload, machine.payload); progress.maxPayload = Math.max(progress.maxPayload, machine.payload);
    const retained = [...truckAndCrate, ...cargo, ...crew].every(entity => entity && Math.hypot(entity.position.x - platform.position.x, entity.position.z - platform.position.z) <= 6.5 && entity.position.y >= platform.position.y - .5 && entity.position.y <= platform.position.y + 6);
    if (!retained || crew.length !== 6) progress.violations.add('LOADED_ASSEMBLY_NOT_RETAINED');
    if (ferry ? !machine.launched : machine.cableBroken) progress.violations.add('MACHINERY_UNAVAILABLE');
    if (machine.payload > machine.capacity + 1) progress.violations.add('MACHINERY_CAPACITY_EXCEEDED');
  } else progress.violations.add('MACHINERY_MISSING');
  progress.maximumRopeTension = Math.max(progress.maximumRopeTension, ...ropeViews.map(rope => rope.tension));
  progress.samples += 1; progress.minContactSegments = Math.min(progress.minContactSegments, contactSegments); progress.maxContactSegments = Math.max(progress.maxContactSegments, contactSegments);
  if (view.phase !== 'running') progress.violations.add('WORLD_NOT_RUNNING');
  if (operator !== target) progress.violations.add('OPERATOR_NOT_ACTIVE');
  if (ropeViews.length !== 2 || contactSegments !== 48) progress.violations.add('CABLE_BODY_BUDGET_CHANGED');
  if (ropeViews.some(rope => rope.broken || rope.detached)) progress.violations.add('CABLE_BROKEN_OR_DETACHED');
  if ([truckAndCrate[0], ...cargo].some(entity => !entity || !(entity.integrity > 0))) progress.violations.add('CARGO_LOST');
  if (view.participants.some(participant => participant.rescueIn !== undefined)) progress.violations.add('CREW_RESCUED');
  sceneProgress.set(client.matchId, progress);
}
async function connect(start, participant) {
  const now = Date.now(), sessionId = createHash('sha256').update(participant.playerId).digest('hex');
  const claims = { issuer: 'iva-platform', audience: 'iva-realtime', keyId: 'load', ticketId: randomBytes(24).toString('base64url'), playerId: participant.playerId,
    participantId: participant.participantId, matchId: start.matchId, roomId: start.input.roomId, rosterHash: start.status.rosterHash, gameId: 'tyaga',
    rulesVersion: start.status.manifest.rulesVersion, contentVersion: start.status.manifest.contentVersion, protocolVersion: 'iva-realtime@1',
    allowedOrigin: origin, permission: 'play', sessionId, issuedAt: now, expiresAt: now + 30_000 };
  const encoded = Buffer.from(canonical(claims)).toString('base64url');
  const ws = new WebSocket(origin.replace('http:', 'ws:') + '/ws/realtime/v1', 'iva-realtime-v1', { origin });
  const client = { ws, matchId: start.matchId, participantId: participant.participantId, sessionId, snapshot: null, baselines: new Map(), sequence: 0,
    anchor: null, lastPosition: null, travelled: 0, sent: 0, received: 0, resyncAt: 0, actions: new Map(), receipts: 0, overloadFrames: 0 };
  clients.push(client);
  ws.on('error', error => { if (!stopping) recordError({ type: 'socket-error', message: error.message }); });
  ws.on('close', (code) => { if (!stopping) recordError({ type: 'socket-close', code }); });
  ws.on('message', bytes => {
    try {
      const frame = JSON.parse(bytes); client.received += 1;
      if (frame.type === 'error') recordError({ type: 'protocol', code: frame.code });
      if (frame.type === 'actionAck') { const pending = client.actions.get(frame.actionId); if (pending) { assert.equal(frame.result.ok, true); client.actions.delete(frame.actionId); client.receipts += 1; } }
      if (frame.type !== 'full' && frame.type !== 'delta') return;
      if (frame.type === 'delta') {
        const baseline = client.baselines.get(frame.baselineSnapshotSeq);
        if (!baseline) { if (performance.now() - client.resyncAt > 250) { client.resyncAt = performance.now(); send(client, { type: 'resync' }); } return; }
        frame.view = applyLoadChanges(baseline, frame.changes);
      }
      if (client.snapshot && frame.epoch !== client.snapshot.epoch) { recordError({ type: 'unexpected-epoch-change' }); client.baselines.clear(); }
      client.snapshot = frame; client.baselines.set(frame.snapshotSeq, frame.view); while (client.baselines.size > 64) client.baselines.delete(client.baselines.keys().next().value);
      observeScene(client, frame.view);
      client.sequence = Math.max(client.sequence, frame.lastConsumedInputSeq);
      if (frame.pauseReason === 'overload') client.overloadFrames += 1;
      const person = frame.view.entities.find(entity => entity.participantId === client.participantId);
      if (person) { client.anchor ??= { ...person.position }; if (client.lastPosition) client.travelled += Math.hypot(person.position.x - client.lastPosition.x, person.position.z - client.lastPosition.z, prepared ? person.position.y - client.lastPosition.y : 0); client.lastPosition = { ...person.position }; }
      send(client, { type: 'ackSnapshot', snapshotSeq: frame.snapshotSeq });
    } catch (error) { recordError({ type: 'client-projection', message: error.message }); }
  });
  await once(ws, 'open'); ws.send(JSON.stringify({ type: 'authenticate', ticket: `${encoded}.${signature('iva-ticket-v1', encoded)}` })); return client;
}
function sampledTimings(report) {
  return report.diagnostics.workers.flatMap(worker => (worker.diagnostics?.games ?? []).map(game => ({ key: worker.runtimeArtifactIds.join(',') + ':' + game.gameId, game })));
}
function intervalQuantile(before, after, field, fraction = .99) {
  const initial = before[field], final = after[field], count = final.count - initial.count; assert.ok(count >= 0, 'Measurement counters reset during the load');
  let sum = 0; for (let index = 0; index < final.buckets.length; index++) { const delta = final.buckets[index].count - initial.buckets[index].count; assert.ok(delta >= 0); sum += delta; if (count && sum >= Math.ceil(count * fraction)) return { count, upperMs: final.buckets[index].upperMs }; }
  return { count, upperMs: null };
}
function sqliteBytes() { return ['realtime.sqlite', 'realtime.sqlite-wal', 'realtime.sqlite-shm'].reduce((sum, name) => sum + (existsSync(join(data, name)) ? statSync(join(data, name)).size : 0), 0); }
let report;
try {
  let health;
  for (let attempt = 0; attempt < 150; attempt++) {
    if (fatal) throw fatal;
    try { const response = await fetch(origin + '/health/realtime/ready', { signal: AbortSignal.timeout(300) }); if (response.ok) { health = await response.json(); break; } } catch { /* Own child may still be loading its verified world reader. */ }
    await sleep(50);
  }
  assert.ok(health?.ok, tail); const manifest = health.games.find(game => game.gameId === 'tyaga'); assert.ok(manifest);
  if (process.platform === 'linux') machine.runtimeAffinity = inspectProcessAffinity(child.pid);
  if (serverCpus) { validateServerAffinity(serverCpus, machine.runtimeAffinity); machine.cpuBudget.verified = true; }
  if (prepared) for (const [field, value] of Object.entries(prepared.manifest)) assert.equal(manifest[field], value, `Fixture and compiled worker differ: ${field}`);
  for (let room = 0; room < rooms; room++) {
    if (prepared) {
      const seeded = prepared.starts[room], status = await bridge(`/internal/realtime/v1/matches/${seeded.matchId}/status`, {}, 'GET');
      const start = { ...seeded, status }; starts.push(start);
      await Promise.all(start.input.participants.map(participant => connect(start, participant))); continue;
    }
    const participants = Array.from({ length: 6 }, (_value, seatIndex) => ({ participantId: `load-${room}-${seatIndex}`, playerId: seatIndex < humanCount ? `load-player-${room}-${seatIndex}` : null,
      displayName: `Load fixture ${seatIndex + 1}`, seatIndex, controller: seatIndex < humanCount ? { kind: 'human', playerId: `load-player-${room}-${seatIndex}` } : { kind: 'bot', botProfileId: 'helper', botVersion: manifest.botVersion, difficulty: 'normal' } }));
    const input = { startCommandId: randomUUID(), roomId: randomUUID(), hostPlayerId: participants[0].playerId, rulesVersion: manifest.rulesVersion, contentVersion: manifest.contentVersion,
      settings: { mapId: requestedMap ?? (room % 2 ? 'quarry' : 'ridge'), mode: 'practice' }, participants };
    const created = await bridge('/internal/realtime/v1/matches', { gameId: 'tyaga', input });
    const status = await bridge(`/internal/realtime/v1/matches/${created.matchId}/status`, {}, 'GET'); const start = { ...created, input, status }; starts.push(start);
    await Promise.all(participants.filter(participant => participant.playerId).map(participant => connect(start, participant)));
  }
  const activeIds = clients.map(client => client.sessionId);
  const admissionTimer = setInterval(() => { void bridge('/internal/realtime/v1/admissions', { sessionIds: activeIds }).catch(error => { fatal = error; }); }, 20_000); timers.push(admissionTimer);
  const inputStarted = performance.now();
  timers.push(setInterval(() => {
    const angle = (performance.now() - inputStarted) / 12_000;
    for (const client of clients) {
      if (!client.snapshot?.hasControl || client.snapshot.phase !== 'running' || !client.anchor || !client.lastPosition) continue;
      if (prepared) {
        const operator = client.participantId.endsWith('-1'), ferry = client.snapshot.view.mapId === 'quarry', elapsed = measuring ? performance.now() - measurementStarted : 0;
        send(client, { type: 'input', inputSeq: ++client.sequence, payload: { moveX: 0, moveZ: 0, run: false,
          throttle: operator && ferry ? .25 * Math.sin(elapsed / 8000) : 0, steer: operator && ferry ? .72601883 : 0,
          brake: true, tool: operator && !ferry && measuring ? (Math.floor(elapsed / 60000) % 2 ? -1 : 1) : 0 } }); continue;
      }
      const dx = client.anchor.x + 2 + Math.cos(angle) * 1.5 - client.lastPosition.x, dz = client.anchor.z + 3 + Math.sin(angle) * 1.5 - client.lastPosition.z, distance = Math.max(1, Math.hypot(dx, dz));
      send(client, { type: 'input', inputSeq: ++client.sequence, payload: { moveX: dx / distance, moveZ: dz / distance, run: false, throttle: 0, steer: 0, brake: false, tool: 0 } });
    }
  }, 1000 / 30));
  timers.push(setInterval(() => {
    for (const client of clients) {
      send(client, { type: 'heartbeat', nonce: randomUUID() });
      for (const [actionId, pending] of client.actions) {
        if (performance.now() - pending.started > 30_000) { recordError({ type: 'action-timeout' }); client.actions.delete(actionId); }
        else if (performance.now() - pending.sent > 2000) { pending.sent = performance.now(); send(client, { type: 'action', actionId, payload: pending.payload }); }
      }
    }
  }, 1000));
  if (prepared) timers.push(setInterval(() => {
    for (const client of clients) if (client.participantId.endsWith('-1') && client.snapshot?.hasControl && client.snapshot.phase === 'running' && !client.actions.size && !client.snapshot.view.participants.find(participant => participant.participantId === client.participantId)?.controlling) {
      const actionId = randomUUID(), payload = { type: 'operate', targetId: client.snapshot.view.mapId === 'quarry' ? 'ferry-deck' : 'lift-platform' }, now = performance.now();
      client.actions.set(actionId, { payload, started: now, sent: now }); send(client, { type: 'action', actionId, payload });
    }
  }, 500));
  let appearance = 0;
  timers.push(setInterval(() => {
    appearance = 1 - appearance;
    for (const client of clients) if (client.snapshot?.phase === 'running' && !client.actions.size) {
      const actionId = randomUUID(), payload = { type: 'appearance', head: appearance, backpack: appearance }, now = performance.now();
      client.actions.set(actionId, { payload, started: now, sent: now }); send(client, { type: 'action', actionId, payload });
    }
  }, 15_000));
  for (let attempt = 0; attempt < 200 && !clients.every(client => client.snapshot?.phase === 'running'); attempt++) { if (fatal) throw fatal; await sleep(50); }
  assert.ok(clients.every(client => client.snapshot?.phase === 'running'), 'All requested independent controllers must enter running worlds');
  await sleep(10_000);
  const first = await metrics(); assert.equal(first.diagnostics.legacyWorkers, 0); assert.equal(first.activeMatches, rooms);
  const started = performance.now(), initialBytes = sqliteBytes(); let previous = first;
  measurementStarted = started; measuring = true;
  writeFileSync(join(output, 'configuration.json'), JSON.stringify({ machine, seconds, rooms, profile, scene, requestedMap, fixture: prepared?.evidence ?? null, humansPerRoom: humanCount, runtime,
    runtimeEntrySha256: createHash('sha256').update(readFileSync(runtime)).digest('hex'),
    clientEntrySha256: createHash('sha256').update(readFileSync(join(clientDirectory, 'index.html'))).digest('hex'),
    clientDirectory, manifests: starts.map(start => start.status.manifest), warmupSeconds: 10, inputHz: 30, expectedSnapshotHz: 20 }, null, 2));
  console.log(JSON.stringify({ state: 'measuring', output, seconds, rooms, profile, clients: clients.length, runtimeArtifactId: manifest.runtimeArtifactId }));
  while (performance.now() - started < seconds * 1000) {
    if (fatal) throw fatal; if (interrupted) throw new Error('Load measurement interrupted; not a completed hour');
    await sleep(Math.min(5000, Math.max(1, seconds * 1000 - (performance.now() - started))));
    const current = await metrics(), elapsedSeconds = (performance.now() - started) / 1000;
    const dt = current.gateway.process.uptimeSeconds - previous.gateway.process.uptimeSeconds;
    const cpu = current.gateway.process.cpuMicroseconds, oldCpu = previous.gateway.process.cpuMicroseconds;
    const utilization = (a, b) => (a.active - b.active) / Math.max(.001, a.active + a.idle - b.active - b.idle);
    const workerUtilizations = current.diagnostics.workers.map((worker, index) => utilization(worker.diagnostics.eventLoop.utilization, previous.diagnostics.workers[index].diagnostics.eventLoop.utilization));
    const sample = { elapsedSeconds, cpuCoreEquivalents: (cpu.user + cpu.system - oldCpu.user - oldCpu.system) / (dt * 1e6),
      gatewayUtilization: utilization(current.gateway.eventLoop.utilization, previous.gateway.eventLoop.utilization), workerUtilizations, sqliteBytes: sqliteBytes(),
      loadGenerator: { memory: process.memoryUsage(), cpuMicroseconds: process.cpuUsage() }, report: current };
    if (serverCpus) {
      sample.runtimeAffinity = inspectProcessAffinity(child.pid); validateServerAffinity(serverCpus, sample.runtimeAffinity);
      sample.harnessAffinity = inspectProcessAffinity(process.pid);
      assert.ok(sample.harnessAffinity.threadCpuSets.every(mask => mask.every(cpu => !serverCpus.includes(cpu))), 'Load generator shares the declared runtime CPUs');
    }
    sample.processCpuFractionOfBudget = processCpuFraction(sample.cpuCoreEquivalents, serverCpus);
    measurements.push({ elapsedSeconds, cpuCoreEquivalents: sample.cpuCoreEquivalents, gatewayUtilization: sample.gatewayUtilization,
      processCpuFractionOfBudget: sample.processCpuFractionOfBudget, workerUtilizations, rss: current.gateway.process.memory.rss, sqliteBytes: sample.sqliteBytes }); record(sample); previous = current;
    assert.equal(current.ok, true, 'Runtime readiness failed under the requested load'); assert.equal(current.activeMatches, rooms);
    assert.equal(current.failedMatches, 0); assert.equal(current.workerRestarts, 0); assert.equal(current.unavailableMatches, 0);
    if (prepared) assert.ok([...sceneProgress.values()].every(progress => progress.violations.size === 0), JSON.stringify([...sceneProgress.values()].map(progress => ({ mapId: progress.mapId, violations: [...progress.violations] }))));
  }
  const elapsedSeconds = (performance.now() - started) / 1000, final = previous;
  const base = new Map(sampledTimings(first).map(value => [value.key, value.game]));
  const timings = sampledTimings(final).map(({ key, game }) => ({ key, step: intervalQuantile(base.get(key), game, 'step'), commit: intervalQuantile(base.get(key), game, 'commit'),
    uncommitted: intervalQuantile(base.get(key), game, 'uncommitted'), snapshotAge: intervalQuantile(base.get(key), game, 'snapshotAge'),
    serialize: intervalQuantile(base.get(key), game, 'serialize'), recent: { step: game.step.recent, commit: game.commit.recent },
    wholeProcessMaxStepMs: game.step.maxMs, wholeProcessMaxCommitMs: game.commit.maxMs }));
  const peakRss = Math.max(...measurements.map(sample => sample.rss)), maximumWorkerUtilization = Math.max(...measurements.flatMap(sample => sample.workerUtilizations)), maximumGatewayUtilization = Math.max(...measurements.map(sample => sample.gatewayUtilization));
  const maximumProcessCpuFractionOfBudget = serverCpus === null ? null : Math.max(...measurements.map(sample => sample.processCpuFractionOfBudget));
  const sceneEvidence = prepared ? [...sceneProgress.values()].map(progress => ({ ...progress, violations: [...progress.violations] })) : null;
  const checks = { ...(prepared ? { heavySceneStillActive: sceneEvidence.length === rooms && sceneEvidence.every(progress => progress.samples > 0 && progress.violations.length === 0 && progress.maximumRopeTension > 10),
    heavyLoadedMassObserved: sceneEvidence.length === rooms && sceneEvidence.every(progress => progress.maxPayload >= progress.expectedPayloadKg - .1),
    heavyMachineryActuallyMoved: sceneEvidence.every(progress => progress.mapId === 'quarry' ? progress.maximumHorizontalDisplacement > .1 : progress.maxHeight - progress.minHeight > 5.5) } : {}), requestedDurationCompleted: elapsedSeconds >= seconds, fullHourCompleted: elapsedSeconds >= 3600,
    stepP99BelowHalfInterval: timings.every(timing => timing.step.count > 0 && timing.step.upperMs !== null && timing.step.upperMs < 1000 / manifest.tickRate / 2),
    commitP99AtMost50ms: timings.every(timing => timing.commit.count > 0 && timing.commit.upperMs !== null && timing.commit.upperMs <= 50),
    eventLoopHeadroom30Percent: maximumWorkerUtilization <= .7 && maximumGatewayUtilization <= .7,
    processCpuHeadroom30Percent: machine.cpuBudget?.verified === true && maximumProcessCpuFractionOfBudget < .7,
    loadGeneratorUsesSeparateCpus: machine.harnessUsesDisjointCpus === true,
    memoryHeadroom25PercentOfReference: peakRss <= memoryBudgetBytes * .75,
    noQueueOverflow: final.gateway.totals.queueOverflows === 0 && final.gateway.totals.backpressureCloses === 0,
    noRateLimitOrProtocolErrors: final.gateway.totals.rateLimits === 0 && errorCount === 0,
    noOverloadPause: clients.every(client => client.overloadFrames === 0), allControllersActuallyMoved: clients.every(client => client.travelled > .1),
    durableActionsAcknowledged: clients.every(client => client.receipts > 0) };
  report = { complete: true, localBudgetPassed: Object.entries(checks).filter(([name]) => name !== 'fullHourCompleted').every(([, value]) => value), checks,
    machine, durationSeconds: elapsedSeconds, requestedSeconds: seconds, rooms, profile, scene, requestedMap, clients: clients.length, timings,
    peakRss, maximumWorkerUtilization, maximumGatewayUtilization, maximumProcessCpuFractionOfBudget, sqliteGrowthBytes: sqliteBytes() - initialBytes,
    sceneEvidence, fixture: prepared?.evidence ?? null,
    clientSummary: clients.map(client => ({ sent: client.sent, received: client.received, travelledMetres: client.travelled, receipts: client.receipts, overloadFrames: client.overloadFrames })), errorCount, errors,
    limitations: ['Synthetic protocol clients, not a rendered browser or mission-completion test.', 'No TCP packet-loss impairment in this run.',
      prepared ? 'Explicit prepared physical scene with named stress-only additions; not ordinary room setup or route completion. Machinery and cable operation during measurement uses the unchanged runtime.' : 'This profile does not substitute for the separate simultaneous machinery/rope stress scene.',
      'The ELU gate measures per-event-loop activity. The separate process-CPU gate requires verified explicit task affinity and disjoint load-generator CPUs; it does not reserve host CPU or infer a VPS quota.', 'Production VPS performance and its allocation were not measured.'] };
} catch (error) {
  report = { complete: false, localBudgetPassed: false, requestedSeconds: seconds, rooms, profile, scene, requestedMap, fixture: prepared?.evidence ?? null,
    sceneEvidence: [...sceneProgress.values()].map(progress => ({ ...progress, violations: [...progress.violations] })), machine, error: error.message, errorCount, errors, runtimeTail: tail };
} finally {
  stopping = true; for (const timer of timers) clearInterval(timer); for (const client of clients) { client.ws.removeAllListeners('message'); client.ws.close(1000); }
  try {
    child.kill('SIGTERM'); const exit = await Promise.race([childExit, new Promise((_done, reject) => setTimeout(() => reject(new Error('Owned realtime process failed to drain')), 32_000).unref())]);
    report.shutdown = { code: exit[0], signal: exit[1] }; if (exit[0] !== 0) report.localBudgetPassed = false;
  } catch (error) { report.shutdown = { error: error.message }; report.localBudgetPassed = false; child.kill('SIGKILL'); }
  for (const client of clients) client.ws.terminate();
  writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify({ state: 'finished', report: join(output, 'report.json'), complete: report.complete, localBudgetPassed: report.localBudgetPassed, checks: report.checks }));
process.exitCode = report.complete && report.localBudgetPassed ? 0 : 1;
