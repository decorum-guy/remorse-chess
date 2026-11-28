/** Explicit public evidence whitelist. Raw reports stay in the private QA directory. */
import { readFile } from 'node:fs/promises';
const readSystem = path => readFile(path, 'utf8').then(value => value.trim(), () => null);
const integer = value => typeof value === 'string' && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const numeric = value => finite(value) !== null && value >= 0 ? value : null;
const digest = value => typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value) ? value : null;
const sha = (value, length = 64) => typeof value === 'string' && new RegExp(`^[0-9a-f]{${length}}$`).test(value) ? value : null;
const maps = ['FP01', 'FP02', 'FP03'];
const phaseNames = ['preparation', 'battle', 'overtime', 'operationResult', 'finished', 'running', 'paused', 'failed-recoverable', 'abandoned'];
const pauseNames = ['SERVER_BUSY', 'NO_HUMANS', 'SERVER_UPDATING', 'RECOVERY'];
function fields(value) { return Object.fromEntries((value ?? '').split('\n').map(line => line.trim().split(/\s+/)).filter(pair => pair.length === 2).map(([key, value]) => [key, integer(value)])); }
function maximum(values) { const valid = values.filter(Number.isFinite); return valid.length ? Math.max(...valid) : null; }
function minimum(values) { const valid = values.filter(Number.isFinite); return valid.length ? Math.min(...valid) : null; }
function numbers(value, names) { return Object.fromEntries(names.map(name => [name, numeric(value?.[name])])); }

/** The whole container includes the runtime, worker threads and QA HTTP/WS clients. */
export async function cgroupSnapshot(read = readSystem) {
  const membership = (await read('/proc/self/cgroup') ?? '').split('\n').find(line => line.startsWith('0::'))?.slice(3);
  if (membership === undefined) return { available: false };
  const parts = membership.split('/').filter(Boolean);
  if (parts.length > 64 || parts.some(part => part === '.' || part === '..' || part.includes('\0'))) return { available: false };
  const paths = ['/sys/fs/cgroup', ...parts.map((_, index) => '/sys/fs/cgroup/' + parts.slice(0, index + 1).join('/'))].reverse();
  const groups = await Promise.all(paths.map(async path => {
    const values = await Promise.all(['cpu.max', 'cpu.stat', 'memory.max', 'memory.current', 'memory.peak', 'memory.swap.max', 'memory.swap.current'].map(name => read(path + '/' + name)));
    const [quota, period] = values[0]?.split(/\s+/) ?? [], numerator = integer(quota), denominator = integer(period);
    return { cpuCores: numerator !== null && denominator > 0 ? numerator / denominator : null, cpu: fields(values[1]),
      memoryLimitBytes: integer(values[2]), memoryUsedBytes: integer(values[3]), memoryPeakBytes: integer(values[4]),
      swapLimitBytes: integer(values[5]), swapUsedBytes: integer(values[6]) };
  }));
  const cpuLimits = groups.map(group => group.cpuCores).filter(value => value !== null && value > 0);
  const limitedMemory = groups.filter(group => group.memoryLimitBytes > 0);
  const memory = [...limitedMemory].sort((a, b) => a.memoryLimitBytes - b.memoryLimitBytes)[0];
  const cpu = groups.find(group => group.cpu.usage_usec !== null && group.cpu.usage_usec !== undefined)?.cpu;
  const memoryKnown = limitedMemory.length > 0 && limitedMemory.every(group => group.memoryUsedBytes !== null);
  return { available: !!cpuLimits.length && memoryKnown && cpu?.usage_usec !== undefined && cpu?.usage_usec !== null,
    cpuCores: cpuLimits.length ? Math.min(...cpuLimits) : null, cpuUsageUsec: cpu?.usage_usec ?? null,
    cpuThrottledUsec: cpu?.throttled_usec ?? null, cpuThrottledPeriods: cpu?.nr_throttled ?? null,
    memoryLimitBytes: memory?.memoryLimitBytes ?? null, memoryUsedBytes: memory?.memoryUsedBytes ?? null,
    memoryPeakBytes: memory?.memoryPeakBytes ?? null, swapLimitBytes: memory?.swapLimitBytes ?? null, swapUsedBytes: memory?.swapUsedBytes ?? null,
    minMemoryHeadroomFraction: memoryKnown ? Math.min(...limitedMemory.map(group => 1 - group.memoryUsedBytes / group.memoryLimitBytes)) : null,
    minMemoryPeakHeadroomFraction: memoryKnown && limitedMemory.every(group => group.memoryPeakBytes !== null)
      ? Math.min(...limitedMemory.map(group => 1 - Math.max(group.memoryPeakBytes, group.memoryUsedBytes) / group.memoryLimitBytes)) : null };
}

const failureCodes = new Set(['QA_CHECK_FAILED', 'QA_ASSERTION_FAILED', 'INVALID_LOAD_ARGUMENTS', 'EXPLICIT_QA_FIXTURE_REQUIRED',
  'DIAGNOSTIC_PROFILE_NOT_ACTIVE', 'CAPPED_CGROUP_REQUIRED', 'INITIAL_ROOM_FAILED', 'ROOM_FAILURE_OR_PAUSE',
  'LOAD_INTERRUPTED', 'TEMPORARY_BOT_NOT_OBSERVED', 'SERVER_HEALTH_FAILED', 'DRAIN_FAILED', 'RECOVERY_REQUIRED',
  'INVALID_QA_PREFIX', 'IMAGE_SOURCE_IDENTITY_REQUIRED', 'IMAGE_BUILD_IDENTITY_MISMATCH', 'QA_SERVER_EXITED',
  'QA_STARTUP_TIMEOUT', 'QA_DRAIN_TIMEOUT', 'QA_DRAIN_FAILED', 'SOURCE_TRACE_MISMATCH', 'SOURCE_FILE_HASH_MISMATCH',
  'INVALID_SOURCE_TRACE', 'SOURCE_DIRECTORY_REQUIRED', 'SOURCE_FILE_REQUIRED', 'SOURCE_SYMLINK_OR_SPECIAL_FILE',
  'SOURCE_DUPLICATE_PATH', 'HTTP_FAILED', 'SERVER_BUSY', 'SERVER_UPDATING', 'MATCH_PAUSED', 'MATCH_UNAVAILABLE',
  'AUTH_REQUIRED', 'ORIGIN_REJECTED', 'RATE_LIMITED', 'TICKET_INVALID', 'TICKET_EXPIRED', 'TICKET_USED', 'QUEUE_FULL',
  'CHECKPOINT_UNAVAILABLE', 'CHECKPOINT_WAL_LIMIT', 'STORAGE_FAILED', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT',
  'OBSERVER_DISCONNECTED', 'SNAPSHOT_STALLED', 'TICK_STALLED']);
export function safeFailureCode(error) {
  const value = typeof error?.code === 'string' ? error.code : typeof error?.message === 'string' ? error.message : '';
  if (value === 'ERR_ASSERTION') return 'QA_ASSERTION_FAILED';
  return failureCodes.has(value) ? value : 'QA_CHECK_FAILED';
}
/** A clean socket close or stopped tick stream cannot silently reduce the load. */
export function assertSlotProgress(slot, now) {
  if (slot.client?.error) throw slot.client.error;
  if (slot.finished) return;
  if (slot.client?.closed) throw new Error('OBSERVER_DISCONNECTED');
  if (now - slot.lastSnapshotAt > 3000) throw new Error('SNAPSHOT_STALLED');
  if (now - slot.lastTickAt > 3000) throw new Error('TICK_STALLED');
}
function safeCgroup(value) {
  if (!value) return null;
  return { available: value.available === true, ...numbers(value, ['cpuCores', 'cpuUsageUsec', 'cpuThrottledUsec', 'cpuThrottledPeriods',
    'memoryLimitBytes', 'memoryUsedBytes', 'memoryPeakBytes', 'swapLimitBytes', 'swapUsedBytes']),
    minMemoryHeadroomFraction: finite(value.minMemoryHeadroomFraction), minMemoryPeakHeadroomFraction: finite(value.minMemoryPeakHeadroomFraction) };
}
function safeWriter(value) {
  if (!value) return null;
  return { ...numbers(value, ['batches', 'maxTransactionMs', 'maxWorldBytes', 'maxRecordBytes', 'maxJournalBytes',
    'transactionP99Ms', 'bodyP99Ms', 'finalizeP99Ms', 'walAutoCheckpoint', 'synchronous', 'queueP99Ms']),
    checkpoint: value.checkpoint ? { ...numbers(value.checkpoint, ['pageSize', 'walBytes', 'logFrames', 'checkpointedFrames', 'busy', 'runs', 'maxMs', 'p99Ms', 'failures']),
      sqliteVersion: typeof value.checkpoint.sqliteVersion === 'string' && /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value.checkpoint.sqliteVersion) ? value.checkpoint.sqliteVersion : null } : null };
}
function safeRetention(value) {
  if (!value) return null;
  return { bundleFileSha256: sha(value.bundleFileSha256), seal: digest(value.seal), buildRevision: sha(value.buildRevision, 40),
    current: { runtime: digest(value.current?.runtime), client: digest(value.current?.client) },
    ...numbers(value, ['artifactCount', 'clientCount', 'readerProfileCount']) };
}
function safeFixture(value) {
  if (!value || value.source !== 'test-fixture') return null;
  return { source: 'test-fixture', evidence: 'Synthetic sizing assumptions only; not measured capacity and not a production profile.',
    ...numbers(value, ['maxRooms', 'maxBodies', 'maxBots', 'maxConnections', 'stepP99Ms', 'roomMemoryBytes']) };
}
export function summarizeLoad(report) {
  const samples = report.samples ?? [], final = samples.at(-1)?.health ?? report.healthAtStart ?? {}, metrics = final.metrics ?? {};
  const observedCpuHeadroom = [], observedRuntimeCpu = [], observedMemoryHeadroom = [];
  for (const [index, sample] of samples.entries()) {
    if (sample.cgroup?.available && finite(sample.cgroup.minMemoryPeakHeadroomFraction) !== null) observedMemoryHeadroom.push(sample.cgroup.minMemoryPeakHeadroomFraction);
    if (!index) continue;
    const previous = samples[index - 1], elapsedMs = sample.observedAtMs - previous.observedAtMs;
    // Final/cleanup reads can be adjacent. They still count for peak memory and
    // failures, but cannot be interpreted as a five-second CPU budget sample.
    if (!(elapsedMs >= 1000)) continue;
    const runtimeCpuMs = sample.health?.metrics?.processCpuMs - previous.health?.metrics?.processCpuMs;
    if (Number.isFinite(runtimeCpuMs) && runtimeCpuMs >= 0) observedRuntimeCpu.push(runtimeCpuMs / elapsedMs);
    const effectiveCpuCores = Math.min(sample.cgroup?.cpuCores, sample.health?.admission?.resources?.cpuCores);
    if (sample.cgroup?.available && previous.cgroup?.available && effectiveCpuCores > 0) {
      const usedMs = (sample.cgroup.cpuUsageUsec - previous.cgroup.cpuUsageUsec) / 1000;
      if (usedMs >= 0) observedCpuHeadroom.push(1 - usedMs / elapsedMs / effectiveCpuCores);
    }
  }
  const minCpuHeadroom = minimum(observedCpuHeadroom), minMemoryHeadroom = minimum(observedMemoryHeadroom);
  const actualConstraintsObserved = samples.length >= 2 && samples.every(sample => {
    const resource = sample.health?.admission?.resources;
    return sample.cgroup?.available === true && numeric(sample.cgroup.cpuUsageUsec) !== null && sample.cgroup.cpuCores > 0 &&
      sample.cgroup.memoryLimitBytes > 0 && numeric(sample.cgroup.memoryUsedBytes) !== null &&
      resource?.cpuSource === 'cgroup' && resource?.memorySource === 'cgroup' && resource?.valid === true && resource.cpuCores > 0;
  });
  const source = report.sourceTrace ?? {}, retention = safeRetention(report.retentionIdentity);
  const identity = { buildRevision: sha(report.healthAtStart?.buildRevision, 40), imageId: digest(report.imageId),
    runtimeArtifact: digest(report.healthAtStart?.artifactId), clientContent: digest(report.healthAtStart?.contentId),
    sourceCommit: sha(source.gitCommit, 40), sourceDirty: typeof source.dirty === 'boolean' ? source.dirty : null,
    sourceSha256: sha(source.sourceSha256), coreSha256: sha(source.coreSha256), sourceFileCount: numeric(source.sourceFileCount),
    providedTraceVerified: source.providedTraceVerified === true, retention };
  const checks = {
    durationCompleted: report.complete === true && numeric(report.elapsedLoadSeconds) !== null && report.elapsedLoadSeconds >= report.targetSeconds,
    allSlotsAdmitted: Number.isSafeInteger(report.roomCount) && report.roomCount > 0 && report.initialAdmissions === report.roomCount,
    noUnexpectedPauses: report.pauses.length === 0,
    noFailures: report.failures.length === 0,
    noStorageFailures: metrics.storageFailures === 0,
    noOutputQueueOverflow: samples.length > 0 && samples.every(sample => numeric(sample.health?.metrics?.queuedBytesMax) !== null && sample.health.metrics.queuedBytesMax < 256 * 1024) &&
      numeric(metrics.resyncReasons?.backpressure ?? 0) === 0,
    stepWorkP99BelowHalfTick: numeric(metrics.stepWorkP99Ms) !== null && metrics.stepWorkP99Ms < 1000 / 60,
    commitP99Below50Ms: numeric(metrics.commitP99Ms) !== null && metrics.commitP99Ms < 50,
    cpuHeadroom30Percent: actualConstraintsObserved && minCpuHeadroom !== null && minCpuHeadroom >= 0.30,
    memoryHeadroom25Percent: actualConstraintsObserved && samples.every(sample => finite(sample.cgroup.minMemoryPeakHeadroomFraction) !== null) && minMemoryHeadroom !== null && minMemoryHeadroom >= 0.25,
    resourceCapsObserved: actualConstraintsObserved && samples.every(sample => sample.cgroup.cpuCores <= 2 && sample.cgroup.memoryLimitBytes <= 2 * 1024 ** 3),
    exactImageIdentity: !!identity.imageId && !!identity.runtimeArtifact && !!identity.clientContent && !!identity.sourceSha256 && !!identity.coreSha256 &&
      identity.providedTraceVerified && identity.sourceDirty === false && identity.buildRevision === identity.sourceCommit && !!retention?.seal && !!retention?.bundleFileSha256 &&
      retention.buildRevision === identity.buildRevision && retention.current.runtime === identity.runtimeArtifact && retention.current.client === identity.clientContent,
  };
  const rejectedCodes = {};
  for (const [code, count] of Object.entries(report.admissions.rejectedCodes ?? {})) {
    const safe = safeFailureCode({ code }); rejectedCodes[safe] = (rejectedCodes[safe] ?? 0) + (numeric(count) ?? 0);
  }
  return { kind: 'capped CI profiling with diagnostic assumptions; not production capacity acceptance', productionCapacityAccepted: false,
    complete: report.complete === true, requestedSeconds: numeric(report.targetSeconds), elapsedLoadSeconds: numeric(report.elapsedLoadSeconds),
    elapsedWallSeconds: numeric(report.elapsedWallSeconds), requestedRooms: numeric(report.roomCount), identity,
    admission: { profileSource: report.capacityFixture?.source === 'test-fixture' ? 'test-fixture' : 'conservative', assumptions: safeFixture(report.capacityFixture),
      initialSuccessful: numeric(report.initialAdmissions), ...numbers(report.admissions, ['attempted', 'successful', 'rejected']), rejectedCodes },
    pauses: report.pauses.map(pause => ({ slot: numeric(pause.slot), mapId: maps.includes(pause.mapId) ? pause.mapId : null,
      reason: pauseNames.includes(pause.reason) ? pause.reason : 'UNKNOWN_PAUSE', elapsedSeconds: numeric(pause.elapsedSeconds) })),
    failureCodes: [...new Set(report.failures.map(failure => safeFailureCode(failure)))],
    completedMatches: report.results.length, completedByMap: Object.fromEntries(maps.map(map => [map, report.results.filter(result => result.mapId === map).length])),
    slots: report.slots.map(slot => ({ slot: numeric(slot.number), mapId: maps.includes(slot.mapId) ? slot.mapId : null,
      ...numbers(slot, ['starts', 'snapshots', 'deltas', 'lastTick', 'observedTickAdvances']), phase: phaseNames.includes(slot.phase) ? slot.phase : null,
      temporaryBotObserved: slot.temporaryBotObserved === true, peakVisibleEntities: numeric(slot.peakProjectedEntities) })),
    resources: { constraintsObserved: actualConstraintsObserved, configuredCaps: { cpuCores: 2, memoryBytes: 2 * 1024 ** 3, swapBytes: 0 },
      first: safeCgroup(samples[0]?.cgroup), last: safeCgroup(samples.at(-1)?.cgroup),
      minimumEffectiveCpuCores: minimum(samples.map(sample => Math.min(sample.cgroup?.cpuCores, sample.health?.admission?.resources?.cpuCores))),
      cpuHeadroomMethod: 'minimum whole-container CPU delta over monotonic intervals of at least one second divided by smaller observed quota/affinity-aware runtime capacity',
      memoryHeadroomMethod: 'minimum latched memory.peak headroom across observed cgroup ancestors; includes bootstrap and QA clients',
      maxRuntimeCpuCoreEquivalents: maximum(observedRuntimeCpu), minContainerCpuHeadroomFraction: minCpuHeadroom,
      minContainerMemoryHeadroomFraction: minMemoryHeadroom, peakRuntimeRssBytes: maximum(samples.map(sample => sample.health?.metrics?.rssBytes)),
      peakContainerMemoryBytes: maximum(samples.map(sample => sample.cgroup?.memoryUsedBytes)) },
    timings: { ticks: numeric(metrics.ticks), stepRpcP99Ms: numeric(metrics.stepP99Ms),
      ...numbers(metrics, ['stepWorkP99Ms', 'stepWorkCpuP99Ms', 'commitP99Ms', 'maxCommitMs', 'journalAgeP99Ms', 'snapshotAgeP99Ms',
        'eventLoopDelayP99Ms', 'maxCommitBatchSize', 'storageFailures']),
      peakJournalPendingAgeMs: maximum(samples.map(sample => sample.health?.metrics?.journalPendingAgeMs)),
      queuedBytesMax: maximum(samples.map(sample => sample.health?.metrics?.queuedBytesMax)), backpressureResyncs: numeric(metrics.resyncReasons?.backpressure ?? 0), writer: safeWriter(metrics.writer) },
    checks, diagnosticThresholdsMet: Object.values(checks).every(Boolean),
    notVerified: ['production host capacity', 'browser rendering/FPS', 'human play', 'physical device', 'public deployment'] };
}
