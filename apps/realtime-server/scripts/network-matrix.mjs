/** Real sockets through an ordered delay relay. This does NOT emulate IP packet loss. */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createConnection, createServer } from 'node:net';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { connectClient, freePort, isSnapshot, sleep, startRig, writeReport } from './probe-lib.mjs';
const port = await freePort(), connections = new Set(), timers = new Set();
let profile = { rttMs: 0, jitterMs: 0 }, blocked = false, randomState = 129837;
function random() { randomState ^= randomState << 13; randomState ^= randomState >>> 17; randomState ^= randomState << 5; return (randomState >>> 0) / 4294967296; }
const proxy = createServer(downstream => {
  if (blocked) { downstream.destroy(); return; }
  const upstream = createConnection({ host: '127.0.0.1', port }); connections.add(downstream); connections.add(upstream);
  const close = () => { downstream.destroy(); upstream.destroy(); connections.delete(downstream); connections.delete(upstream); };
  downstream.on('error', close); upstream.on('error', close); downstream.on('close', close); upstream.on('close', close);
  const forward = (source, target) => {
    let previousDue = performance.now();
    source.on('data', data => {
      const delay = Math.max(0, profile.rttMs / 2 + (random() - 0.5) * profile.jitterMs);
      const due = previousDue = Math.max(previousDue, performance.now() + delay);
      const timer = setTimeout(() => {
        timers.delete(timer); if (source.destroyed || target.destroyed) return;
        if (!target.write(data)) { source.pause(); target.once('drain', () => source.resume()); }
      }, Math.max(0, due - performance.now())); timers.add(timer);
    });
  };
  forward(downstream, upstream); forward(upstream, downstream);
});
proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
const publicOrigin = `http://127.0.0.1:${proxy.address().port}`, rig = await startRig({ prefix: 'realtime-matrix', port, publicOrigin });
const reportPath = resolve(rig.directory, 'report.json'), cases = [], checks = [], disconnects = [];
let client, complete = false;
async function ping(ws) {
  const nonce = randomBytes(16), started = performance.now();
  return await new Promise((resolvePing, reject) => {
    const timeout = setTimeout(() => { ws.off('pong', pong); reject(new Error('Ping timed out')); }, 5000);
    const pong = data => { if (data.equals(nonce)) { clearTimeout(timeout); ws.off('pong', pong); resolvePing(performance.now() - started); } };
    ws.on('pong', pong); ws.ping(nonce);
  });
}
try {
  const profiles = [
    ...[40, 120, 250].flatMap(rttMs => [0, 50].map(jitterMs => ({ rttMs, jitterMs, contract: 'Forpost' }))),
    ...[0, 80, 160, 300].flatMap(rttMs => [0, 30].map(jitterMs => ({ rttMs, jitterMs, contract: 'shared realtime' }))),
  ];
  let admission;
  for (const { rttMs, jitterMs, contract } of profiles) {
    client?.close(); if (admission) await rig.post(`/api/realtime/v1/practice/${admission.matchId}/abandon`);
    profile = { rttMs, jitterMs };
    admission = await rig.post('/api/realtime/v1/practice', { mapId: 'FP02', teamSize: 1, displayName: 'Network matrix observer', mode: 'training', botLevel: 'normal', seed: 6543 });
    const ticket = await rig.post(`/api/realtime/v1/practice/${admission.matchId}/ticket`);
    let full = 0, delta = 0;
    client = await connectClient(rig, ticket.ticket, message => { if (message.type === 'full') full++; if (message.type === 'delta') delta++; });
    const initial = await client.wait(message => isSnapshot(message) && message.worldTick > 0);
    const pings = [], actionAckMs = [];
    for (let index = 0; index < 3; index++) {
      pings.push(await ping(client.ws));
      const actionId = randomUUID(), started = performance.now();
      client.send('action', { actionId, payload: { type: 'mode', mode: index % 2 ? 'fighter' : 'tactics' } });
      const ack = await client.wait(message => message.type === 'actionAck' && message.actionId === actionId);
      assert.equal(ack.result.ok, true); actionAckMs.push(performance.now() - started);
    }
    const padId = Object.keys(initial.view.buildOptions).sort().reverse().find(id => initial.view.buildOptions[id].some(option => option.kind === 'relay' && option.ok));
    assert.ok(padId, 'an actual eligible build option exists');
    const actionId = randomUUID(), build = { type: 'build', padId, kind: 'relay' };
    client.send('action', { actionId, payload: build });
    const built = await client.wait(message => message.type === 'actionAck' && message.actionId === actionId);
    assert.equal(built.result.ok, true);
    client.send('action', { actionId, payload: build });
    const repeated = await client.wait(message => message.type === 'actionAck' && message.actionId === actionId);
    assert.equal(repeated.replayed, true); assert.deepEqual(repeated.result, built.result);
    const withOrder = await client.wait(message => isSnapshot(message) && message.view.buildOrders.some(order => order.id === built.result.entityId));
    assert.equal(withOrder.view.buildOrders.filter(order => order.padId === padId).length, 1);
    const cancelId = randomUUID(); client.send('action', { actionId: cancelId, payload: { type: 'cancelBuild', orderId: built.result.entityId } });
    assert.equal((await client.wait(message => message.type === 'actionAck' && message.actionId === cancelId)).result.ok, true);
    const otherTicket = await rig.post(`/api/realtime/v1/practice/${admission.matchId}/ticket`);
    const other = await connectClient(rig, otherTicket.ticket);
    assert.equal(other.hello.controlling, false);
    other.send('claimControl'); await other.wait(message => message.type === 'controlChanged' && message.controlling);
    await client.wait(message => message.type === 'controlChanged' && !message.controlling);
    client.send('claimControl'); await client.wait(message => message.type === 'controlChanged' && message.controlling);
    other.close();
    client.send('input', { inputSeq: 1, payload: { moveX: 0, moveZ: 0, aimX: 1, aimZ: 0, fireHeld: false, firePressSeq: 0 } });
    await client.wait(message => isSnapshot(message) && message.lastConsumedInputSeq === 1);
    assert.ok(delta > 0); assert.equal(client.error, null);
    cases.push({ contract, configuredRttMs: rttMs, configuredRttJitterSpanMs: jitterMs, observedPingRttMs: pings, actionAckMs, full, delta,
      constructionRepeatOnce: true, cancelAcknowledged: true, explicitControlTransferBothWays: true, freshInputSequence: true, passed: true });
  }
  checks.push('fourteen real HTTP/WebSocket delay profiles; personalized acknowledged deltas, durable build repeat/cancel, explicit control transfer both ways and fresh input sequence');
  for (const seconds of [1, 5, 8, 15]) {
    const previousGeneration = client.hello.controllerGeneration, previousEpoch = client.hello.epoch;
    const started = performance.now(); blocked = true; client.close(); for (const socket of connections) socket.destroy();
    await sleep(seconds * 1000); blocked = false;
    const renewed = await rig.post(`/api/realtime/v1/practice/${admission.matchId}/ticket`); client = await connectClient(rig, renewed.ticket);
    const snapshot = await client.wait(isSnapshot); assert.equal(snapshot.view.matchId, admission.matchId);
    assert.equal(client.hello.epoch, previousEpoch); assert.ok(client.hello.controllerGeneration > previousGeneration);
    assert.equal(snapshot.lastConsumedInputSeq, -1, 'new controller generation must not acknowledge the old generation input');
    client.send('input', { inputSeq: 1, payload: { moveX: 0, moveZ: 0, aimX: 1, aimZ: 0, fireHeld: false, firePressSeq: 0 } });
    await client.wait(message => isSnapshot(message) && message.lastConsumedInputSeq === 1);
    disconnects.push({ blockedSeconds: seconds, recoveryMs: performance.now() - started - seconds * 1000, sameMatch: true, freshInputSequence: true, previousInputAckCleared: true });
  }
  checks.push('one/five/eight/fifteen-second actual TCP disconnections, new tickets, same match and fresh control sequences');
  const health = await rig.health(); assert.equal(health.metrics.storageFailures, 0); complete = true;
  await writeReport(reportPath, { complete, kind: 'real ordered TCP delay/jitter relay; no browser or physical WAN claim', artifactId: health.artifactId, contentId: health.contentId, sourceTrace: rig.sourceTrace,
    jitterDefinition: 'per direction uniform delay offset ± configuredJitter/2, clamped at zero and kept in TCP byte order',
    packetLossPercent: { cases: [1, 2, 5], status: 'unverified', reason: 'CAP_NET_ADMIN is false; dropping application bytes would corrupt TCP/WebSocket framing and is not IP packet loss' }, cases, disconnects, checks, health });
  console.log(JSON.stringify({ complete, reportPath, cases, disconnects, checks, metrics: health.metrics }, null, 2));
  await rig.post(`/api/realtime/v1/practice/${admission.matchId}/abandon`);
} catch (error) {
  await writeReport(reportPath, { complete, cases, disconnects, checks, failure: error.message }); console.error(rig.logs()); throw error;
} finally {
  client?.close(); for (const timer of timers) clearTimeout(timer); for (const socket of connections) socket.destroy();
  await new Promise(r => proxy.close(r)); await rig.stop();
}
