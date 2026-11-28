/** Arithmetic/source fixtures only. These tests do not run Docker or accept load. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { FORMAT, METHOD, SOURCE_DIRECTORIES, SOURCE_FILES, fingerprintSources, traceSummary, verifySourceTrace } from '../scripts/source-identity.mjs';
import { assertSlotProgress, cgroupSnapshot, safeFailureCode, summarizeLoad } from '../scripts/load-summary.mjs';

async function sourceFixture(t) {
  const root = await mkdtemp(resolve(os.tmpdir(), 'forpost-source-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const directory of SOURCE_DIRECTORIES) { await mkdir(resolve(root, directory), { recursive: true }); await writeFile(resolve(root, directory, 'fixture.js'), 'fixture bytes\n'); }
  for (const file of [...SOURCE_FILES, 'games/forpost/src/core/fixture.ts', 'games/forpost/src/art/fixture.ts']) {
    await mkdir(dirname(resolve(root, file)), { recursive: true }); await writeFile(resolve(root, file), 'explicit synthetic source fixture\n');
  }
  const trace = { format: FORMAT, gitCommit: '1'.repeat(40), dirty: false, ...await fingerprintSources(root), method: METHOD };
  return { root, trace };
}
test('provided source trace rehashes the complete required inventory without git', async t => {
  const { root, trace } = await sourceFixture(t), checked = await verifySourceTrace(root, trace);
  assert.deepEqual(checked, trace);
  assert.equal(checked.coreFileCount, 1);
  assert.ok(checked.files.some(file => file.path.includes('/src/art/')));
  assert.equal(traceSummary(checked, true).providedTraceVerified, true);
  assert.equal(traceSummary(checked).files, undefined);
});
test('changed source bytes are rejected even when the trace claims the same revision', async t => {
  const { root, trace } = await sourceFixture(t);
  await writeFile(resolve(root, 'games/forpost/src/art/fixture.ts'), 'different');
  await assert.rejects(verifySourceTrace(root, trace), /SOURCE_TRACE_MISMATCH/);
});
test('added source files cannot be omitted from a caller-selected inventory', async t => {
  const { root, trace } = await sourceFixture(t);
  await writeFile(resolve(root, 'apps/realtime-server/src/unlisted.ts'), 'unlisted');
  await assert.rejects(verifySourceTrace(root, trace), /SOURCE_TRACE_MISMATCH/);
});
test('per-file hashes are checked independently of aggregate claims', async t => {
  const { root, trace } = await sourceFixture(t);
  trace.files[0].sha256 = '0'.repeat(64);
  await assert.rejects(verifySourceTrace(root, trace), /SOURCE_FILE_HASH_MISMATCH/);
});
test('missing files, symlinks and malformed source revisions cannot verify', async t => {
  const { root, trace } = await sourceFixture(t);
  await assert.rejects(verifySourceTrace(root, { ...trace, gitCommit: 'not-a-revision' }), /INVALID_SOURCE_TRACE/);
  await rm(resolve(root, 'games/forpost/src/art/fixture.ts'));
  await assert.rejects(verifySourceTrace(root, trace), /SOURCE_TRACE_MISMATCH/);
  await symlink(resolve(root, 'package.json'), resolve(root, 'games/forpost/src/link'));
  await assert.rejects(fingerprintSources(root), /SOURCE_SYMLINK_OR_SPECIAL_FILE/);
});

function groupRead({ membership = '/', leaf = {}, ancestor = null } = {}) {
  const values = new Map([['/proc/self/cgroup', '0::' + membership]]);
  const defaults = { 'cpu.max': '200000 100000', 'cpu.stat': 'usage_usec 1000000\nthrottled_usec 2\nnr_throttled 1',
    'memory.max': String(2 * 1024 ** 3), 'memory.current': String(512 * 1024 ** 2), 'memory.peak': String(1024 ** 3),
    'memory.swap.max': '0', 'memory.swap.current': '0' };
  for (const [key, value] of Object.entries({ ...defaults, ...leaf })) values.set('/sys/fs/cgroup' + (membership === '/' ? '' : membership) + '/' + key, value);
  if (ancestor) for (const [key, value] of Object.entries(ancestor)) values.set('/sys/fs/cgroup/' + key, value);
  return async path => values.has(path) ? values.get(path) : null;
}
test('actual cgroup parser preserves zero swap and finite numeric quota', async () => {
  const sample = await cgroupSnapshot(groupRead());
  assert.equal(sample.available, true); assert.equal(sample.cpuCores, 2);
  assert.equal(sample.swapLimitBytes, 0); assert.equal(sample.swapUsedBytes, 0);
  assert.equal(sample.minMemoryPeakHeadroomFraction, 0.5);
});
test('ancestor quota and memory peaks constrain a more permissive leaf', async () => {
  const sample = await cgroupSnapshot(groupRead({ membership: '/leaf', ancestor: {
    'cpu.max': '100000 100000', 'memory.max': String(4 * 1024 ** 3),
    'memory.current': String(3 * 1024 ** 3), 'memory.peak': String(3.5 * 1024 ** 3) } }));
  assert.equal(sample.cpuCores, 1);
  assert.equal(sample.memoryLimitBytes, 2 * 1024 ** 3);
  assert.equal(sample.minMemoryPeakHeadroomFraction, 0.125);
});
test('unavailable or malformed cgroup metrics do not invent an allocation', async () => {
  assert.deepEqual(await cgroupSnapshot(async () => null), { available: false });
  assert.equal((await cgroupSnapshot(groupRead({ leaf: { 'memory.current': null } }))).available, false);
  assert.equal((await cgroupSnapshot(groupRead({ leaf: { 'cpu.max': 'max 100000' } }))).available, false);
  assert.deepEqual(await cgroupSnapshot(groupRead({ membership: '/../escape' })), { available: false });
});

function reportFixture() {
  const revision = '1'.repeat(40), runtime = 'sha256:' + '2'.repeat(64), client = 'sha256:' + '3'.repeat(64);
  const health = { ok: true, buildRevision: revision, artifactId: runtime, contentId: client,
    admission: { mode: 'test-fixture', resources: { valid: true, cpuSource: 'cgroup', memorySource: 'cgroup', cpuCores: 2 } },
    metrics: { ticks: 1000, stepP99Ms: 8, stepWorkP99Ms: 4, stepWorkCpuP99Ms: 3, commitP99Ms: 20, maxCommitMs: 40,
      storageFailures: 0, queuedBytesMax: 0, processCpuMs: 0, rssBytes: 600000000, resyncReasons: { backpressure: 0 },
      writer: { synchronous: 2, walAutoCheckpoint: 0, checkpoint: { sqliteVersion: '3.54.1', failures: 0 } } } };
  const cgroup = { available: true, cpuCores: 2, cpuUsageUsec: 0, cpuThrottledUsec: 0, cpuThrottledPeriods: 0,
    memoryLimitBytes: 2 * 1024 ** 3, memoryUsedBytes: 1024 ** 3, memoryPeakBytes: 1024 ** 3,
    minMemoryHeadroomFraction: 0.5, minMemoryPeakHeadroomFraction: 0.5, swapLimitBytes: 0, swapUsedBytes: 0 };
  const final = structuredClone(health); final.metrics.processCpuMs = 3_600_000;
  return { complete: true, targetSeconds: 3600, elapsedLoadSeconds: 3600, elapsedWallSeconds: 3610, roomCount: 4, initialAdmissions: 4,
    healthAtStart: health, imageId: 'sha256:' + '4'.repeat(64),
    sourceTrace: { gitCommit: revision, dirty: false, sourceSha256: '5'.repeat(64), coreSha256: '6'.repeat(64), sourceFileCount: 100, providedTraceVerified: true },
    retentionIdentity: { buildRevision: revision, bundleFileSha256: '7'.repeat(64), seal: 'sha256:' + '8'.repeat(64),
      current: { runtime, client }, artifactCount: 1, clientCount: 1, readerProfileCount: 1 },
    capacityFixture: { source: 'test-fixture', maxRooms: 4, maxBodies: 224, maxBots: 24, maxConnections: 48, stepP99Ms: 8, roomMemoryBytes: 268435456 },
    admissions: { attempted: 4, successful: 4, rejected: 0, rejectedCodes: {} }, failures: [], pauses: [], results: [],
    slots: [0, 1, 2, 3].map(number => ({ number, mapId: ['FP01', 'FP02', 'FP03', 'FP01'][number], starts: 1,
      snapshots: 100, deltas: 99, lastTick: 1000, observedTickAdvances: 1000, phase: 'battle', temporaryBotObserved: true, peakProjectedEntities: 20 })),
    samples: [{ observedAtMs: 0, elapsedSeconds: 0, health, cgroup },
      { observedAtMs: 3_600_000, elapsedSeconds: 3600, health: final, cgroup: { ...cgroup, cpuUsageUsec: 3_600_000_000 } }] };
}
test('diagnostic assumptions and actual headroom are separate, never a production acceptance', () => {
  const summary = summarizeLoad(reportFixture());
  assert.equal(summary.diagnosticThresholdsMet, true);
  assert.equal(summary.productionCapacityAccepted, false);
  assert.equal(summary.admission.profileSource, 'test-fixture');
  assert.equal(summary.resources.minContainerCpuHeadroomFraction, 0.5);
  assert.equal(summary.resources.minContainerMemoryHeadroomFraction, 0.5);
});
test('peak memory above 75% fails even after sampled current memory recovers', () => {
  const report = reportFixture(); report.samples[1].cgroup.minMemoryPeakHeadroomFraction = 0.2;
  const summary = summarizeLoad(report);
  assert.equal(summary.checks.memoryHeadroom25Percent, false);
  assert.equal(summary.checks.cpuHeadroom30Percent, true);
  assert.equal(summary.diagnosticThresholdsMet, false);
});
test('usable CPU affinity limits headroom even when the quota allows two cores', () => {
  const report = reportFixture(); report.samples[1].health.admission.resources.cpuCores = 1;
  const summary = summarizeLoad(report);
  assert.equal(summary.resources.minContainerCpuHeadroomFraction, 0);
  assert.equal(summary.checks.cpuHeadroom30Percent, false);
});
test('near-consecutive cleanup sample is not misread as a CPU budget interval', () => {
  const report = reportFixture(), last = structuredClone(report.samples[1]);
  last.observedAtMs += 1; last.cgroup.cpuUsageUsec += 50_000;
  report.samples.push(last);
  assert.equal(summarizeLoad(report).resources.minContainerCpuHeadroomFraction, 0.5);
});
test('unknown metrics, identity mismatch, early termination and partial admission fail closed', () => {
  for (const change of [
    report => { report.samples[1].cgroup.available = false; },
    report => { report.samples[1].cgroup.minMemoryPeakHeadroomFraction = null; },
    report => { report.retentionIdentity.current.client = 'sha256:' + '9'.repeat(64); },
    report => { report.elapsedLoadSeconds = 3599; },
    report => { report.initialAdmissions = 3; },
  ]) { const report = reportFixture(); change(report); assert.equal(summarizeLoad(report).diagnosticThresholdsMet, false); }
});
test('latched backpressure invalidates a run whose five-second queue samples are empty', () => {
  const report = reportFixture(); report.samples[1].health.metrics.resyncReasons.backpressure = 1;
  const summary = summarizeLoad(report);
  assert.equal(summary.checks.noOutputQueueOverflow, false);
  assert.equal(summary.timings.backpressureResyncs, 1);
});
test('stdout summary strips raw identities, tokens and unexpected nested values', () => {
  const report = reportFixture(), secret = 'PRIVATE_ACCOUNT_MATCH_TOKEN';
  report.results.push({ mapId: 'FP01', matchId: secret, resultId: secret });
  report.slots[0].matchId = secret; report.capacityFixture.evidence = secret;
  report.capacityFixture.token = secret; report.retentionIdentity.token = secret;
  report.samples[0].cgroup.token = secret; report.samples[1].health.metrics.writer.token = secret;
  report.samples[1].health.metrics.writer.checkpoint.sqliteVersion = secret;
  report.pauses.push({ slot: 0, mapId: secret, reason: secret, token: secret, elapsedSeconds: 1 });
  report.failures.push({ code: secret, error: secret }); report.admissions.rejectedCodes[secret] = 1;
  const output = JSON.stringify(summarizeLoad(report));
  assert.equal(output.includes(secret), false);
  assert.equal(output.includes('matchId'), false);
  assert.equal(output.includes('resultId'), false);
  assert.equal(safeFailureCode({ code: secret }), 'QA_CHECK_FAILED');
});
test('clean observer disconnect and stalled snapshots/ticks cannot silently reduce load', () => {
  const slot = { finished: false, client: { closed: false }, lastSnapshotAt: 1000, lastTickAt: 1000 };
  assert.doesNotThrow(() => assertSlotProgress(slot, 2000));
  assert.throws(() => assertSlotProgress({ ...slot, client: { closed: true } }, 2000), /OBSERVER_DISCONNECTED/);
  assert.throws(() => assertSlotProgress(slot, 5000), /SNAPSHOT_STALLED/);
  assert.throws(() => assertSlotProgress({ ...slot, lastSnapshotAt: 4999 }, 5000), /TICK_STALLED/);
  assert.doesNotThrow(() => assertSlotProgress({ ...slot, finished: true, client: { closed: true } }, 5000));
});
test('production image wrapper pins the resolved ID and does not grant host capabilities', async () => {
  const script = await readFile(new URL('../scripts/profile-image.sh', import.meta.url), 'utf8');
  assert.match(script, /--entrypoint node "\$qa_id"/);
  for (const option of ['--network none', '--read-only', '--cpus=2', '--memory=2g', '--memory-swap=2g', '--cap-drop=ALL', '--security-opt=no-new-privileges']) assert.ok(script.includes(option));
  assert.equal(script.includes('--privileged'), false);
  assert.equal(script.includes('--network host'), false);
  assert.equal(script.includes('docker.sock'), false);
});
