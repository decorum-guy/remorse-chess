/** Real wall-clock HTTP/WS/WAL profiling. Diagnostic assumptions are explicit. */
import assert from 'node:assert/strict';
import os from 'node:os';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { connectClient, isSnapshot, sleep, startRig, writeReport } from './probe-lib.mjs';
import { assertSlotProgress, cgroupSnapshot, safeFailureCode, summarizeLoad } from './load-summary.mjs';
const publicNumber = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

async function main() {
  const seconds = Number(process.argv.find(arg => arg.startsWith('--seconds='))?.slice(10) ?? 3600);
  const roomCount = Number(process.argv.find(arg => arg.startsWith('--rooms='))?.slice(8) ?? 4);
  if (!Number.isSafeInteger(seconds) || seconds < 30 || seconds > 7200 || !Number.isSafeInteger(roomCount) || roomCount < 1 || roomCount > 4) throw new Error('INVALID_LOAD_ARGUMENTS');
  const diagnostic = process.argv.includes('--admission=test-fixture');
  if (diagnostic && process.env.NODE_ENV !== 'test') throw new Error('EXPLICIT_QA_FIXTURE_REQUIRED');
  const capacityFixture = diagnostic ? { schema: 'iva-realtime-capacity-1', gameId: 'forpost', artifactId: 'test-fixture', source: 'test-fixture',
    evidence: 'Synthetic sizing assumptions for capped CI measurement, not measured capacity. No production profile is produced.',
    maxRooms: 4, maxBodies: 224, maxBots: 24, maxConnections: 48, stepP99Ms: 8, roomMemoryBytes: 256 * 1024 * 1024 } : undefined;
  const wallStart = performance.now(), rig = await startRig({ prefix: 'realtime-load', maxRooms: roomCount, capacityFixture });
  const reportPath = resolve(rig.directory, 'report.json'), slots = [], samples = [], failures = [], results = [], pauses = [];
  const admissions = { attempted: 0, successful: 0, rejected: 0, rejectedCodes: {} };
  let healthAtStart = {}, complete = false, stopping = false, initialAdmissions = 0, loadStart = null, loadEnd = null;
  const stopSignal = () => { stopping = true; };
  process.once('SIGTERM', stopSignal); process.once('SIGINT', stopSignal);
  const elapsed = () => loadStart === null ? 0 : ((loadEnd ?? performance.now()) - loadStart) / 1000;
  const machine = { node: process.version, platform: os.platform(), arch: os.arch(), cpuModel: os.cpus()[0]?.model,
    availableParallelism: os.availableParallelism(), totalMemoryBytes: os.totalmem() };
  function snapshotReport() {
    return { kind: 'real wall-clock HTTP/WebSocket simulation profile; no browser/FPS or production-capacity claim', complete,
      targetSeconds: seconds, elapsedLoadSeconds: elapsed(), elapsedWallSeconds: (performance.now() - wallStart) / 1000,
      roomCount, initialAdmissions, teamSize: 3, explicitBotLevel: 'strong', temporaryHumanBotLevel: 'normal',
      imageId: process.env.FORPOST_QA_IMAGE_ID ?? null, retentionIdentity: rig.retentionIdentity, capacityFixture, healthAtStart, sourceTrace: rig.sourceTrace, machine,
      admissions, failures, results, pauses, slots: slots.map(slot => ({ number: slot.number, mapId: slot.mapId, matchId: slot.matchId,
        starts: slot.starts, snapshots: slot.snapshots, deltas: slot.deltas, lastTick: slot.lastTick, phase: slot.phase, observedTickAdvances: slot.observedTickAdvances,
        peakProjectedEntities: slot.peakProjectedEntities, temporaryBotObserved: slot.temporaryBotObserved })), samples };
  }
  function recordPause(slot, reason) {
    const code = ['SERVER_BUSY', 'NO_HUMANS', 'SERVER_UPDATING', 'RECOVERY'].includes(reason) ? reason : 'UNKNOWN_PAUSE';
    const key = slot.starts + ':' + code;
    if (!slot.seenPauses.has(key)) { slot.seenPauses.add(key); pauses.push({ slot: slot.number, mapId: slot.mapId, reason: code, elapsedSeconds: elapsed() }); }
  }
  async function sample() {
    const health = await rig.health(), cgroup = await cgroupSnapshot();
    samples.push({ elapsedSeconds: elapsed(), observedAtMs: performance.now() - wallStart, health, cgroup });
    if (!health.ok || health.metrics.storageFailures) throw new Error('SERVER_HEALTH_FAILED');
    await writeReport(reportPath, snapshotReport());
  }
  async function begin(slot) {
    admissions.attempted++;
    let admission;
    try {
      admission = await rig.post('/api/realtime/v1/practice', { mapId: slot.mapId, teamSize: 3, displayName: 'Explicit automated load observer',
        botLevel: 'strong', mode: 'training', seed: 91000 + slot.number + slot.starts * 100 });
      admissions.successful++;
    } catch (error) {
      admissions.rejected++; const code = safeFailureCode(error); admissions.rejectedCodes[code] = (admissions.rejectedCodes[code] ?? 0) + 1; throw error;
    }
    slot.matchId = admission.matchId; slot.starts++; slot.finished = false; slot.lastTick = 0;
    slot.lastSnapshotAt = slot.lastTickAt = performance.now();
    let owner;
    try {
      owner = await connectClient(rig, admission.ticket); await owner.wait(isSnapshot);
      const ticket = await rig.post(`/api/realtime/v1/practice/${slot.matchId}/ticket`);
      slot.client = await connectClient(rig, ticket.ticket, message => {
        if (message.matchId !== undefined && message.matchId !== slot.matchId) return;
        if (message.type === 'phaseChanged' && message.phase === 'paused') recordPause(slot, message.reason);
        if (!isSnapshot(message)) { if (message.type === 'error') failures.push({ slot: slot.number, code: message.code, elapsedSeconds: elapsed() }); return; }
        slot.snapshots++; if (message.type === 'delta') slot.deltas++;
        slot.lastSnapshotAt = performance.now();
        if (message.worldTick > slot.lastTick) { slot.observedTickAdvances += message.worldTick - slot.lastTick; slot.lastTickAt = performance.now(); }
        slot.lastTick = message.worldTick; slot.phase = message.view.phase;
        slot.peakProjectedEntities = Math.max(slot.peakProjectedEntities, message.view.units.length + message.view.buildings.length + message.view.transports.length);
        slot.temporaryBotObserved ||= message.view.participants.find(person => person.id === message.view.you)?.temporaryBot === true;
        if (message.view.phase === 'finished' && message.phase === 'finished' && !slot.finished) {
          slot.finished = true; results.push({ mapId: slot.mapId, matchId: slot.matchId, resultId: message.view.resultId, winner: message.view.winner, ticks: message.worldTick });
        }
        if (message.phase === 'paused') recordPause(slot, message.pauseReason);
        if (message.phase === 'failed-recoverable') failures.push({ slot: slot.number, code: 'RECOVERY_REQUIRED', elapsedSeconds: elapsed() });
      });
      assert.equal(slot.client.hello.controlling, false);
    } finally { owner?.close(); }
    await slot.client.wait(message => isSnapshot(message) && message.worldTick > 0);
  }
  try {
    healthAtStart = await rig.health();
    if (diagnostic && healthAtStart.admission?.mode !== 'test-fixture') throw new Error('DIAGNOSTIC_PROFILE_NOT_ACTIVE');
    if (process.env.FORPOST_QA_IMAGE_ID) {
      const actual = await cgroupSnapshot();
      if (!actual.available || actual.cpuCores > 2 || actual.memoryLimitBytes > 2 * 1024 ** 3) throw new Error('CAPPED_CGROUP_REQUIRED');
    }
    for (let number = 0; number < roomCount; number++) {
      const slot = { number, mapId: ['FP01', 'FP02', 'FP03', 'FP01'][number], starts: 0, snapshots: 0, deltas: 0,
        lastTick: 0, observedTickAdvances: 0, lastSnapshotAt: performance.now(), lastTickAt: performance.now(),
        phase: 'preparation', peakProjectedEntities: 0, temporaryBotObserved: false, seenPauses: new Set() };
      slots.push(slot); await begin(slot); initialAdmissions++;
      if (pauses.length || failures.length) throw new Error('INITIAL_ROOM_FAILED');
    }
    loadStart = performance.now(); await sample();
    const identity = summarizeLoad(snapshotReport()).identity;
    console.log(JSON.stringify({ stage: 'load-started', requestedSeconds: seconds, requestedRooms: roomCount,
      profileSource: capacityFixture?.source ?? 'conservative', buildRevision: identity.buildRevision,
      runtimeArtifact: identity.runtimeArtifact, clientContent: identity.clientContent, coreSha256: identity.coreSha256 }));
    let lastSample = performance.now(), lastProgress = performance.now();
    while (!stopping && elapsed() < seconds) {
      if (failures.length || pauses.length) throw new Error('ROOM_FAILURE_OR_PAUSE');
      for (const slot of slots) {
        assertSlotProgress(slot, performance.now());
        if (slot.finished) { slot.client.close(); await rig.post(`/api/realtime/v1/practice/${slot.matchId}/abandon`); await begin(slot); }
      }
      if (performance.now() - lastSample >= 5000) { lastSample = performance.now(); await sample(); }
      if (performance.now() - lastProgress >= 60_000) {
        lastProgress = performance.now(); const metric = samples.at(-1)?.health.metrics;
        console.log(JSON.stringify({ stage: 'load-progress', elapsedLoadSeconds: Math.floor(elapsed()), admissions: admissions.successful,
          completedMatches: results.length, pauses: pauses.length, stepWorkP99Ms: publicNumber(metric?.stepWorkP99Ms),
          commitP99Ms: publicNumber(metric?.commitP99Ms), rssBytes: publicNumber(metric?.rssBytes) }));
      }
      await sleep(100);
    }
    if (stopping) throw new Error('LOAD_INTERRUPTED');
    if (!slots.every(slot => slot.temporaryBotObserved)) throw new Error('TEMPORARY_BOT_NOT_OBSERVED');
    if (failures.length || pauses.length) throw new Error('ROOM_FAILURE_OR_PAUSE');
    await sample(); complete = true;
  } catch (error) { failures.push({ code: safeFailureCode(error), error: error.message, elapsedSeconds: elapsed() }); process.exitCode = 1; }
  finally {
    loadEnd = performance.now();
    try { await sample(); } catch (error) { failures.push({ code: safeFailureCode(error), error: error.message }); process.exitCode = 1; }
    for (const slot of slots) slot.client?.close();
    try { await rig.stop(); } catch (error) { failures.push({ code: 'DRAIN_FAILED', error: error.message }); process.exitCode = 1; }
    await writeFile(resolve(rig.directory, 'server.log'), rig.logs());
    await writeReport(reportPath, snapshotReport());
    const summary = summarizeLoad(snapshotReport()); await writeReport(resolve(rig.directory, 'summary.json'), summary);
    if (!summary.diagnosticThresholdsMet) process.exitCode = 1;
    console.log(JSON.stringify({ stage: 'load-summary', ...summary }));
    process.off('SIGTERM', stopSignal); process.off('SIGINT', stopSignal);
  }
}
await main().catch(error => { console.error(JSON.stringify({ stage: 'load-initialization', complete: false, code: safeFailureCode(error) })); process.exitCode = 1; });
