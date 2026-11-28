// Isolated protocol/recovery matrix. netem acts on the test container's own
// loopback TCP packets, never on individual already-delivered WebSocket frames.
// This is not a rendered browser test or a completed Tyaga expedition.
import assert from 'node:assert/strict';
import { createHash, createPrivateKey, randomBytes, randomUUID, sign } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { WebSocket } from 'ws';
import { applyLoadChanges } from './realtime-load-view.mjs';
import { unexpectedNetworkErrors } from './realtime-network-errors.mjs';
import { netemProfile } from './realtime-network-profile.mjs';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  assert.ok(['--origin', '--output', '--mode'].includes(process.argv[index]) && process.argv[index + 1] && !args.has(process.argv[index]));
  args.set(process.argv[index], process.argv[index + 1]);
}
const origin = args.get('--origin') ?? 'http://127.0.0.1:4320', output = args.get('--output') ?? '/tmp/realtime-network.json', mode = args.get('--mode') ?? 'netem';
assert.match(origin, /^http:\/\/127\.0\.0\.1:\d{1,5}$/); assert.ok(['netem', 'loopback'].includes(mode));
const netem = mode === 'netem';
const key = createPrivateKey(readFileSync(0, 'utf8'));
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(name => [name, item[name]])) : item);
const signature = (purpose, value) => sign(null, Buffer.from(`${purpose}\n${value}`), key).toString('base64url');
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const clients = new Set(), cases = [], outages = [];
let ownedQdisc = false, prepared = null, activeCase = { stage: 'initial-connection' };
const emptyInput = { moveX: 0, moveZ: 0, run: false, throttle: 0, steer: 0, brake: false, tool: 0 };
function command(name, commandArgs) {
  const result = spawnSync(name, commandArgs, { encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${name} failed: ${result.stderr || result.error?.message || result.status}`);
  return result.stdout;
}
function impairment(profile) {
  if (!netem) return null;
  const { args: commandArgs, applied } = netemProfile(profile);
  command('tc', commandArgs); ownedQdisc = true;
  return applied;
}
const clearImpairment = () => { if (ownedQdisc) { command('tc', ['qdisc', 'del', 'dev', 'lo', 'root', 'handle', '1:']); ownedQdisc = false; } };
async function waitUntil(predicate, timeoutMs = 20_000, message = 'Expected protocol state') {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) { const value = predicate(); if (value) return value; await sleep(25); }
  throw new Error(message);
}
async function bridge(path, body = {}, method = 'POST') {
  const unsigned = { keyId: 'network-test', nonce: randomBytes(24).toString('base64url'), issuedAt: Date.now(), method, path, body };
  const envelope = { ...unsigned, signature: signature('iva-bridge-v1', canonical(unsigned)) };
  const response = await fetch(origin + path, { method, signal: AbortSignal.timeout(20_000),
    headers: method === 'GET' ? { 'X-Iva-Service-Request': Buffer.from(JSON.stringify(envelope)).toString('base64url') } : { 'Content-Type': 'application/json' },
    ...(method === 'GET' ? {} : { body: JSON.stringify(envelope) }) });
  const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value;
}
function scope(client) { const value = client.snapshot ?? client.hello; return { protocolVersion: 'iva-realtime@1', matchId: prepared.matchId, epoch: value.epoch, controllerGeneration: value.controllerGeneration }; }
class Client {
  constructor(participant) {
    this.participant = participant; this.snapshot = null; this.hello = null; this.baselines = new Map(); this.receipts = new Map();
    this.input = { ...emptyInput }; this.inputSeq = 0; this.frames = 0; this.errors = []; this.errorCount = 0; this.rtts = []; this.pings = new Map(); this.closed = null;
    this.resyncAt = 0; this.dropAckFor = null; this.ignoredAck = null; this.stopping = false; this.lastStateAt = performance.now();
    this.ackTimer = null; this.pendingAck = null; this.lastAcknowledged = null; this.serverBaseline = null;
    this.awaitingFull = false; this.claimAttempts = []; this.claimCount = 0; this.lastClaimAt = -Infinity;
    const now = Date.now(), claims = { issuer: 'iva-platform', audience: 'iva-realtime', keyId: 'network-test', ticketId: randomBytes(24).toString('base64url'),
      playerId: participant.playerId, participantId: participant.participantId, matchId: prepared.matchId, roomId: prepared.input.roomId, rosterHash: prepared.status.rosterHash,
      gameId: 'tyaga', rulesVersion: prepared.status.manifest.rulesVersion, contentVersion: prepared.status.manifest.contentVersion, protocolVersion: 'iva-realtime@1',
      allowedOrigin: origin, permission: 'play', sessionId: createHash('sha256').update(participant.playerId).digest('hex'), issuedAt: now, expiresAt: now + 30_000 };
    const encoded = Buffer.from(canonical(claims)).toString('base64url');
    this.socket = new WebSocket(origin.replace('http:', 'ws:') + '/ws/realtime/v1', 'iva-realtime-v1', { origin }); clients.add(this);
    this.socket.on('open', () => this.socket.send(JSON.stringify({ type: 'authenticate', ticket: `${encoded}.${signature('iva-ticket-v1', encoded)}` })));
    this.socket.on('error', () => {});
    this.socket.on('close', code => { this.closed = code; });
    this.socket.on('message', bytes => {
      try {
        const frame = JSON.parse(bytes); this.frames += 1;
        if (frame.type === 'hello') this.hello = frame;
        if (frame.type === 'error') {
          this.errorCount += 1; if (this.errors.length < 50) this.errors.push({ code: frame.code, actionId: frame.actionId, silenceMs: performance.now() - this.lastStateAt });
          if (['STALE_EPOCH', 'STALE_CONTROLLER'].includes(frame.code)) { this.awaitingFull = true; this.resetAcknowledgements(); this.resync(); }
        }
        if (frame.type === 'controlChanged') { this.awaitingFull = true; this.resetAcknowledgements(); this.resync(); }
        if (frame.type === 'heartbeat' && this.pings.has(frame.nonce)) { this.rtts.push(performance.now() - this.pings.get(frame.nonce)); this.pings.delete(frame.nonce); }
        if (frame.type === 'actionAck') {
          if (this.dropAckFor === frame.actionId) { this.dropAckFor = null; this.ignoredAck = frame; }
          else this.receipts.set(frame.actionId, frame);
        }
        if (!['full', 'delta'].includes(frame.type)) return;
        if (this.snapshot && (frame.epoch !== this.snapshot.epoch || frame.controllerGeneration !== this.snapshot.controllerGeneration)) this.resetAcknowledgements();
        if (frame.type === 'delta') {
          const baseline = this.baselines.get(frame.baselineSnapshotSeq);
          if (!baseline || this.awaitingFull) { this.resync(); return; }
          frame.view = applyLoadChanges(baseline, frame.changes);
          this.serverBaseline = frame.baselineSnapshotSeq;
        }
        if (frame.type === 'full') this.awaitingFull = false;
        this.snapshot = frame; this.lastStateAt = performance.now(); this.baselines.set(frame.snapshotSeq, frame.view);
        this.inputSeq = Math.max(this.inputSeq, frame.lastConsumedInputSeq);
        this.acknowledge(frame);
      } catch (error) { this.errorCount += 1; if (this.errors.length < 50) this.errors.push({ code: 'PROJECTION_FAILED', detail: error.message }); }
    });
    this.inputTimer = setInterval(() => { if (this.snapshot?.hasControl && this.snapshot.phase === 'running') this.send({ type: 'input', inputSeq: ++this.inputSeq, payload: this.input }); }, 1000 / 30);
    this.heartbeatTimer = setInterval(() => {
      if (!this.hello) return; const nonce = randomUUID(); this.pings.set(nonce, performance.now());
      while (this.pings.size > 32) this.pings.delete(this.pings.keys().next().value);
      this.send({ type: 'heartbeat', nonce });
    }, 500);
  }
  send(message) {
    if (this.socket.readyState !== WebSocket.OPEN || (!this.snapshot && !this.hello) || (this.awaitingFull && message.type !== 'resync')) return false;
    this.socket.send(JSON.stringify({ ...scope(this), ...message })); return true;
  }
  resetAcknowledgements() {
    clearTimeout(this.ackTimer); this.ackTimer = null; this.pendingAck = null;
    this.lastAcknowledged = null; this.serverBaseline = null; this.baselines.clear();
  }
  pruneBaselines() {
    while (this.baselines.size > 64) this.baselines.delete([...this.baselines.keys()].find(sequence => sequence !== this.lastAcknowledged && sequence !== this.serverBaseline && sequence !== this.pendingAck?.snapshotSeq));
  }
  acknowledge(frame) {
    this.pendingAck = { snapshotSeq: frame.snapshotSeq, epoch: frame.epoch, controllerGeneration: frame.controllerGeneration }; this.pruneBaselines();
    if (this.ackTimer) return;
    this.ackTimer = setTimeout(() => {
      this.ackTimer = null; const pending = this.pendingAck; this.pendingAck = null;
      if (!pending || pending.epoch !== this.snapshot?.epoch || pending.controllerGeneration !== this.snapshot?.controllerGeneration || !this.baselines.has(pending.snapshotSeq)) return;
      if (this.send({ type: 'ackSnapshot', snapshotSeq: pending.snapshotSeq })) this.lastAcknowledged = pending.snapshotSeq;
      this.pruneBaselines();
    }, 50);
  }
  resync() { if (performance.now() - this.resyncAt > 250) { this.resyncAt = performance.now(); this.send({ type: 'resync' }); } }
  diagnostic() {
    const s = this.snapshot;
    return { frames: this.frames, closed: this.closed, lastStateAgeMs: performance.now() - this.lastStateAt,
      snapshot: s ? { phase: s.phase, pauseReason: s.pauseReason, hasControl: s.hasControl, epoch: s.epoch, controllerGeneration: s.controllerGeneration,
        snapshotSeq: s.snapshotSeq, worldTick: s.worldTick, resumeAt: s.resumeAt } : null,
      errors: this.errors, errorCount: this.errorCount, retainedBaselines: this.baselines.size, claimCount: this.claimCount, claimAttempts: this.claimAttempts };
  }
  async ready() {
    const deadline = performance.now() + 25_000;
    while (performance.now() < deadline) {
      if (this.snapshot?.hasControl && this.snapshot.phase === 'running') return this;
      if (this.closed !== null) throw new Error('Independent controller socket closed before ready');
      // This isolated same-player test client explicitly requests control if a
      // replacement authenticates before the previous TCP close reaches the
      // server. Production observer admission remains unchanged.
      if (this.snapshot && !this.snapshot.hasControl && !this.awaitingFull && performance.now() - this.lastClaimAt >= 1000) {
        if (this.send({ type: 'claimControl', expectedGeneration: this.snapshot.controllerGeneration })) {
          this.lastClaimAt = performance.now(); this.claimCount += 1;
          if (this.claimAttempts.length < 8) this.claimAttempts.push({ epoch: this.snapshot.epoch, controllerGeneration: this.snapshot.controllerGeneration, worldTick: this.snapshot.worldTick });
          this.awaitingFull = true; this.resetAcknowledgements();
        }
      }
      await sleep(25);
    }
    throw new Error('Independent controller did not enter the running world');
  }
  async action(actionId, payload) {
    const deadline = performance.now() + 20_000;
    while (performance.now() < deadline) {
      this.send({ type: 'action', actionId, payload });
      for (let index = 0; index < 20; index++) { if (this.receipts.has(actionId)) return this.receipts.get(actionId); await sleep(50); }
    }
    throw new Error('Durable action acknowledgement unavailable');
  }
  stop() { this.stopping = true; clearInterval(this.inputTimer); clearInterval(this.heartbeatTimer); this.resetAcknowledgements(); this.socket.terminate(); clients.delete(this); }
}
async function pair() {
  const values = prepared.input.participants.map(participant => new Client(participant));
  await Promise.all(values.map(client => client.ready())); return values;
}
function itemState(client) {
  const view = client.snapshot.view;
  return { count: view.entities.filter(entity => entity.id === 'repair-1').length,
    item: view.inventory.find(item => item.id === 'repair-1')?.state,
    crateMass: view.entities.find(entity => entity.id === 'equipment-crate').mass };
}
function assertRetained(client, expected) {
  assert.equal(client.snapshot.matchId, prepared.matchId); assert.deepEqual(itemState(client), expected);
  assert.equal(client.snapshot.manifest.runtimeArtifactId, prepared.status.manifest.runtimeArtifactId);
  assert.equal(client.errorCount, client.errors.length, 'Error evidence overflow must not hide an unexpected failure');
  assert.deepEqual(unexpectedNetworkErrors(client.errors), [], 'Unexpected errors after connection restoration');
}
const quantile = (values, fraction) => values.length ? [...values].sort((a,b)=>a-b)[Math.max(0,Math.ceil(values.length*fraction)-1)] : null;
let report;
try {
  if (netem) {
    assert.equal(process.env.IVA_NETWORK_TEST_SANDBOX, 'isolated-loopback', 'Explicit CI test-container guard required');
    const links = JSON.parse(command('ip', ['-j', 'link', 'show']));
    assert.deepEqual(links.map(link => link.ifname), ['lo'], 'Only a private network-none loopback namespace is permitted');
    const qdiscs = JSON.parse(command('tc', ['-j', 'qdisc', 'show', 'dev', 'lo']));
    assert.ok(qdiscs.every(qdisc => qdisc.kind === 'noqueue'), 'Refuse to replace an unrelated qdisc');
    impairment({ rttMs:0,jitterMs:0,lossPercent:0 });
  }
  let health;
  for (let attempt = 0; attempt < 150; attempt++) {
    try { const response = await fetch(origin + '/health/realtime/ready', { signal: AbortSignal.timeout(500) }); if (response.ok) { health = await response.json(); break; } } catch { /* Own candidate may still be starting. */ }
    await sleep(100);
  }
  assert.ok(health?.ok, 'Candidate did not become ready'); const manifest = health.games.find(game=>game.gameId==='tyaga'); assert.ok(manifest);
  const participants = [1,2].map(index=>({participantId:`network-${index}`,playerId:`network-player-${index}`,displayName:`Network fixture ${index}`,seatIndex:index-1,controller:{kind:'human',playerId:`network-player-${index}`}}));
  const input = { startCommandId:randomUUID(),roomId:randomUUID(),hostPlayerId:participants[0].playerId,rulesVersion:manifest.rulesVersion,contentVersion:manifest.contentVersion,settings:{mapId:'tutorial',mode:'tutorial'},participants };
  const created = await bridge('/internal/realtime/v1/matches',{gameId:'tyaga',input});
  prepared = {...created,input,status:await bridge(`/internal/realtime/v1/matches/${created.matchId}/status`,{},'GET')};
  let connected = await pair(), actor = connected[0]; const initialMass = itemState(actor).crateMass;
  const walkingDeadline = performance.now()+20_000;
  while (!actor.snapshot.view.interactions.some(option=>option.id==='unpack-repair'&&option.enabled) && performance.now()<walkingDeadline) {
    const view=actor.snapshot.view,person=view.entities.find(entity=>entity.participantId===actor.participant.participantId),crate=view.entities.find(entity=>entity.id==='equipment-crate');
    actor.input={...emptyInput,...(person.position.x>crate.position.x+.1?{moveX:-1}:{moveZ:-1})}; await sleep(80);
  }
  actor.input={...emptyInput}; await sleep(100);
  assert.ok(actor.snapshot.view.interactions.some(option=>option.id==='unpack-repair'&&option.enabled),'Ordinary input must reach the crate');
  const person=actor.snapshot.view.entities.find(entity=>entity.participantId===actor.participant.participantId);
  const actionId=randomUUID(),payload={type:'unpack',itemId:'repair-1',position:{x:person.position.x,y:person.position.y,z:person.position.z+1.2}};
  actor.dropAckFor=actionId; actor.send({type:'action',actionId,payload});
  await waitUntil(()=>itemState(actor).item==='world'&&actor.ignoredAck,10_000,'Real unpack operation did not finish');
  const receipt=await actor.action(actionId,payload),expected=itemState(actor);
  assert.equal(receipt.result.ok,true); assert.equal(receipt.committedJournalSeq,actor.ignoredAck.committedJournalSeq);
  assert.equal(expected.count,1);assert.equal(expected.item,'world');assert.ok(Math.abs(expected.crateMass-(initialMass-6))<.001);
  connected.forEach(client=>client.stop());await sleep(100);
  const profiles=netem?[0,80,160,300].flatMap(rttMs=>[0,30].flatMap(jitterMs=>[0,1,5].map(lossPercent=>({rttMs,jitterMs,lossPercent})))):[{rttMs:0,jitterMs:0,lossPercent:0}];
  for (const profile of profiles) {
    activeCase = { stage: 'impaired-connection', ...profile };
    const applied=impairment(profile);connected=await pair();const before=connected.map(client=>client.frames);await sleep(8000);
    const sample={...profile,applied,measuredSeconds:8,clients:connected.map((client,index)=>({frames:client.frames-before[index],closed:client.closed,errors:client.errors,errorCount:client.errorCount,
      claimCount:client.claimCount,claimAttempts:client.claimAttempts,heartbeatRtt:{count:client.rtts.length,p50Ms:quantile(client.rtts,.5),p99Ms:quantile(client.rtts,.99)}})),
      qdisc:netem?JSON.parse(command('tc',['-j','-s','qdisc','show','dev','lo'])):null};
    assert.ok(sample.clients.every(client=>client.frames>1),'Both clients must receive state under the requested impairment');
    for(const client of sample.clients){assert.equal(client.errorCount,client.errors.length,'Error evidence overflow');assert.deepEqual(unexpectedNetworkErrors(client.errors,profile.lossPercent),[],'Unexpected error code under live TCP impairment');}
    clearImpairment();connected.forEach(client=>client.stop());await sleep(100);
    activeCase = { stage: 'profile-restoration', ...profile };
    connected=await pair();for(const client of connected)assertRetained(client,expected);
    const retry=await connected[0].action(actionId,payload);assert.equal(retry.committedJournalSeq,receipt.committedJournalSeq);
    sample.recoverySucceeded=true;sample.singleItemRetained=true;cases.push(sample);console.log(JSON.stringify({event:'network-profile',...sample}));
    connected.forEach(client=>client.stop());await sleep(100);
  }
  if(netem)for(const seconds of [1,5,15]) {
    activeCase = { stage: 'blackhole', seconds };
    connected=await pair();const previous=connected[0].snapshot,started=performance.now();
    const applied=impairment({rttMs:0,jitterMs:0,lossPercent:100});await sleep(seconds*1000);const qdisc=JSON.parse(command('tc',['-j','-s','qdisc','show','dev','lo']));
    clearImpairment();const actualBlackholeSeconds=(performance.now()-started)/1000;
    const interruptedClients=connected.map(client=>({closed:client.closed,errors:[...client.errors],errorCount:client.errorCount}));
    for(const client of interruptedClients){assert.equal(client.errorCount,client.errors.length,'Error evidence overflow');assert.deepEqual(unexpectedNetworkErrors(client.errors,100),[],'Unexpected error during TCP blackhole');}
    connected.forEach(client=>client.stop());await sleep(100);
    const first=new Client(participants[0]);await waitUntil(()=>first.snapshot,20_000,'Return full snapshot missing');
    const firstReturn={phase:first.snapshot.phase,worldTick:first.snapshot.worldTick,controls:first.snapshot.controls,hasControl:first.snapshot.hasControl};
    if(seconds===15){
      assert.equal(firstReturn.phase,'recovering','An empty world must pause durably before its 15-second return');
      assert.ok(firstReturn.worldTick-previous.worldTick<=610,'The world must stop after ten seconds without humans');
      assert.equal(firstReturn.controls.find(control=>control.participantId===participants[1].participantId)?.kind,'bot');
    }
    await first.ready();const second=await new Client(participants[1]).ready();connected=[first,second];for(const client of connected)assertRetained(client,expected);
    const retry=await first.action(actionId,payload);assert.equal(retry.committedJournalSeq,receipt.committedJournalSeq);
    const sample={requestedSeconds:seconds,actualBlackholeSeconds,applied,recoveryElapsedSeconds:(performance.now()-started)/1000-actualBlackholeSeconds,previousWorldTick:previous.worldTick,firstReturn,qdisc,interruptedClients,
      sameMatch:true,singleItemRetained:true,receiptRetained:true};outages.push(sample);console.log(JSON.stringify({event:'network-outage',...sample}));
    connected.forEach(client=>client.stop());await sleep(100);
  }
  health=await bridge('/health/realtime/ready',{},'GET').catch(async()=>await(await fetch(origin+'/health/realtime/ready')).json());
  assert.equal(health.activeMatches,1);assert.equal(health.failedMatches,0);
  report={passed:true,mode,netemExecuted:netem,matrixComplete:netem&&cases.length===24&&outages.length===3,manifest:prepared.status.manifest,
    matchId:prepared.matchId,ordinaryCrateApproach:true,unpackedPhysicalItems:1,crateMassDecreaseKg:6,applicationAckLossDeduplicated:true,cases,outages,
    limitations:['Protocol clients, not browser/mobile/rendered acceptance.','Netem loss affects real TCP packets; RTT and jitter are requested settings, observed heartbeat RTT is reported separately.',
      'Zero nominal RTT with nonzero jitter applies a reported 0.001 ms one-way base: tc rejects a normal distribution at exactly zero latency.','This does not complete a map or measure hour-long capacity.']};
} catch(error) { report={passed:false,mode,netemExecuted:netem,matrixComplete:false,error:error.message,activeCase,
  failedClients:[...clients].map(client=>client.diagnostic()),manifest:prepared?.status.manifest,cases,outages}; }
finally {
  for(const client of clients)client.stop();
  try{clearImpairment();}catch(error){report.passed=false;report.cleanupError=error.message;}
  writeFileSync(output,JSON.stringify(report,null,2));
}
console.log(JSON.stringify({event:'network-summary',...report}));process.exitCode=report.passed?0:1;
