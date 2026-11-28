/** Synthetic server profile: six real 3v3 matches, one owner, isolated SQLite.
 * Uses ordinary fixed steps and filtered runtime views; never edits match state.
 * This measures accelerated runtime work, not network, browser or device FPS.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { cpus, arch, loadavg, platform, release, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const args = process.argv.slice(2);
const argument = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const warmupSteps = Number(argument('--warmup', '360'));
const targetSteps = Number(argument('--steps', '1200'));
const difficulty = argument('--difficulty', 'normal');
assert.ok(Number.isSafeInteger(warmupSteps) && warmupSteps >= 300 && warmupSteps <= 1000, 'Use 300–1000 warmup steps');
assert.ok(Number.isSafeInteger(targetSteps) && targetSteps >= 900 && targetSteps <= 1200, 'Use 900–1200 measured steps');
assert.ok(['easy', 'normal', 'hard'].includes(difficulty), 'Unknown bot difficulty');

const qa = join(ROOT, '.qa', 'shift-runtime-profile');
await mkdir(qa, { recursive: true, mode: 0o700 });
const directory = await mkdtemp(join(qa, 'run-'));
const sourceHashes = {};
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
async function hashTree(path) {
  const entries = (await readdir(join(ROOT, path), { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  for (const entry of entries) {
    const file = `${path}/${entry.name}`;
    if (entry.isDirectory()) await hashTree(file);
    else if (entry.isFile()) sourceHashes[file] = sha256(await readFile(join(ROOT, file)));
  }
}
for (const path of ['games/shift/src/core', 'games/shift/src/bots', 'games/shift/src/server', 'packages/session-kit/src']) await hashTree(path);
for (const file of ['games/shift/scripts/profile-runtime.mjs', 'games/shift/package.json', 'package.json', 'package-lock.json']) sourceHashes[file] = sha256(await readFile(join(ROOT, file)));

const report = {
  classification: 'Synthetic accelerated fixed-step runtime + actual isolated SQLite + filtered snapshots and JSON encoding; no network, browser, human play or physical-device claim',
  startedAt: new Date().toISOString(),
  sourceSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(),
  dirtyWorktree: execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim().length > 0,
  sourceHashes,
  sourceTreeHash: sha256(JSON.stringify(sourceHashes)),
  environment: {
    node: process.version, v8: process.versions.v8, operatingSystem: `${platform()} ${release()}`, architecture: arch(),
    cpuModel: cpus()[0]?.model ?? 'unknown', logicalCpusReportedByOS: cpus().length, totalMemoryBytesReportedByOS: totalmem(),
    loadAverageBefore: loadavg(),
    concurrencyControl: 'Shared executor; other workspace activity is not controlled. One measured process, one ShiftRuntime owner, six matches.',
  },
  settings: { matchCount: 6, teamSize: 3, difficulty, rotateRoles: true, humanSeatsPerMatch: 2, initialHumanConnections: 0, warmupSteps, targetSteps, snapshotEverySteps: 2, filteredProfilesPerMatch: 2 },
  methodology: {
    advanceTicks: 'One ordinary advanceTicks(1) call covering all six resident matches, including bots and synchronous SQLite checkpoints.',
    snapshots: 'Two filtered viewForPlayer calls per match every second step, followed by representative iva-live@1 snapshot-frame JSON encoding with a fixed sample epoch. No transport or live leases are opened, so disconnected human substitutes remain enabled.',
    combined: 'Measured advance duration plus whole snapshot-batch duration where due; includes small snapshot bookkeeping/assertion overhead. Untimed status guards are excluded.',
    scheduling: 'Fixed steps are intentionally executed faster than wall time. This is a work-cost profile, not real-time scheduling or end-to-end latency.',
    threshold: '25 ms is the stated 75% budget of a 30 Hz tick. Timing is reported, never asserted as a CI test.',
  },
  samples: {},
  matches: [],
  failures: [],
};
for (const [name, path] of [['cpuMax', '/sys/fs/cgroup/cpu.max'], ['memoryMax', '/sys/fs/cgroup/memory.max']]) {
  const value = await readFile(path, 'utf8').catch(() => null);
  if (value !== null) report.environment[name] = value.trim();
}

const entry = join(directory, 'profile-entry.ts'), compiled = join(directory, 'compiled');
await writeFile(entry,
  `export { ShiftRuntime } from ${JSON.stringify(join(ROOT, 'games/shift/src/server/runtime.ts'))};\n` +
  `export { LIVE_PROTOCOL } from ${JSON.stringify(join(ROOT, 'packages/session-kit/src/realtime.ts'))};\n` +
  `export { RULES_VERSION, CONTENT_VERSION, WIRE_VERSION, BOT_VERSION, TICK_RATE, TIMING } from ${JSON.stringify(join(ROOT, 'games/shift/src/core/index.ts'))};\n`,
  { mode: 0o600 });
await build({ root: ROOT, configFile: false, logLevel: 'silent', ssr: { noExternal: ['@iva-games/session-kit'] },
  build: { ssr: entry, outDir: compiled, emptyOutDir: true, minify: false } });
const bundle = join(compiled, 'profile-entry.js');
report.compiledRuntimeHash = sha256(await readFile(bundle));
report.sourceChangedDuringCompile = false;
for (const [file, hash] of Object.entries(sourceHashes)) if (sha256(await readFile(join(ROOT, file))) !== hash) report.sourceChangedDuringCompile = true;
assert.equal(report.sourceChangedDuringCompile, false, 'Profile sources changed during compilation; run against a stable snapshot');

const { ShiftRuntime, LIVE_PROTOCOL, RULES_VERSION, CONTENT_VERSION, WIRE_VERSION, BOT_VERSION, TICK_RATE, TIMING } = await import(pathToFileURL(bundle).href);
assert.ok(warmupSteps >= Math.max(TIMING.preparation, TIMING.substitute), 'Warmup must include normal preparation and substitute activation');
report.settings.tickRate = TICK_RATE;
report.settings.snapshotRateEquivalent = TICK_RATE / 2;
report.settings.tickBudgetMs = 1000 / TICK_RATE;
report.settings.processingBudgetMs = 1000 / TICK_RATE * 0.75;
report.versions = { LIVE_PROTOCOL, RULES_VERSION, CONTENT_VERSION, WIRE_VERSION, BOT_VERSION };
const databasePath = join(directory, 'runtime.sqlite');
const runtime = new ShiftRuntime({ databasePath, autoTick: false });
const matches = [], measurements = [], profileMeasurements = [];
let totalEncodedBytes = 0, stoppedAtFinishedMatch = false;

function summary(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = p => sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] : null;
  const round = value => value === null ? null : Math.round(value * 1000) / 1000;
  return { count: sorted.length, p50Ms: round(percentile(0.5)), p95Ms: round(percentile(0.95)), maxMs: round(sorted.at(-1) ?? null),
    meanMs: round(sorted.length ? sorted.reduce((sum, value) => sum + value, 0) / sorted.length : null) };
}
async function databaseSizes() {
  const files = {};
  for (const suffix of ['', '-wal', '-shm']) files[`runtime.sqlite${suffix}`] = (await stat(databasePath + suffix).catch(() => null))?.size ?? 0;
  return { files, totalBytes: Object.values(files).reduce((sum, value) => sum + value, 0) };
}
async function takeSnapshots(step, record) {
  const batchStart = performance.now();
  const phases = new Map();
  let generationMs = 0, encodingMs = 0, bytes = 0;
  for (const match of matches) for (const playerId of match.profiles) {
    const start = performance.now();
    const view = await runtime.viewForPlayer(match.matchId, playerId);
    const generated = performance.now();
    const encoded = JSON.stringify({ protocol: LIVE_PROTOCOL, wireVersion: WIRE_VERSION, roomId: match.roomId, matchId: match.matchId,
      epoch: 'representative-profile-epoch', gameId: 'shift', rulesVersion: RULES_VERSION, contentVersion: CONTENT_VERSION,
      type: 'snapshot', tick: view.tick, serverTime: Date.now(), lastAcceptedSeq: view.self.lastAcceptedSeq, view });
    const finished = performance.now();
    const encodedBytes = Buffer.byteLength(encoded);
    phases.set(match.matchId, view.phase);
    generationMs += generated - start; encodingMs += finished - generated; bytes += encodedBytes;
    assert.equal(view.seats.length, 6);
    assert.equal(view.self.team, playerId.endsWith('-0') ? 'teal' : 'amber');
    if (record) profileMeasurements.push({ step, match: match.label, seat: view.self.seatId, generationMs: generated - start, encodingMs: finished - generated, encodedBytes });
  }
  return { batchMs: performance.now() - batchStart, generationMs, encodingMs, bytes, activeMatches: [...phases.values()].filter(phase => phase === 'active').length };
}

try {
  for (let index = 0; index < 6; index++) {
    const arena = ['foundry', 'calibration', 'depot'][index % 3];
    const participants = Array.from({ length: 6 }, (_, seatIndex) => {
      const playerId = `profile-${index}-player-${seatIndex}`;
      return { participantId: `profile-${index}-seat-${seatIndex}`, seatIndex, displayName: `Profile ${index + 1} seat ${seatIndex + 1}`,
        playerId: seatIndex === 0 || seatIndex === 3 ? playerId : null,
        controller: seatIndex === 0 || seatIndex === 3 ? { kind: 'human', playerId } : { kind: 'bot', botProfileId: `shift:${difficulty}`, botVersion: BOT_VERSION, difficulty } };
    });
    const created = await runtime.createMatch({ roomId: `profile-room-${index}`, startCommandId: `profile-start-${index}`,
      rulesVersion: RULES_VERSION, contentVersion: CONTENT_VERSION, participants, settings: { arena, teamSize: 3, rotateRoles: true, difficulty } });
    matches.push({ ...created, roomId: `profile-room-${index}`, arena, label: `${arena}-${index + 1}`, profiles: [`profile-${index}-player-0`, `profile-${index}-player-3`] });
  }
  // No sockets are opened: the two human seats get ordinary disconnected substitutes.
  // Both warmup and sample use the same 30 Hz-equivalent, every-other-step view cadence.
  for (let step = 1; step <= warmupSteps; step++) {
    runtime.advanceTicks(1);
    if (step % 2 === 0) await takeSnapshots(step, false);
  }
  for (const match of matches) {
    assert.equal((await runtime.status(match.matchId)).finished, false, 'Warmup must leave every match unfinished');
    const view = await runtime.viewForPlayer(match.matchId, match.profiles[0]);
    assert.ok(view.seats.filter(seat => !seat.bot).every(seat => seat.substitute), 'Normal disconnected substitutes must be active after warmup');
  }
  report.memoryBeforeSampling = process.memoryUsage();
  const sampleStart = performance.now();
  for (let step = 1; step <= targetSteps; step++) {
    const start = performance.now();
    runtime.advanceTicks(1);
    const advanceMs = performance.now() - start;
    const statuses = await Promise.all(matches.map(match => runtime.status(match.matchId)));
    if (statuses.some(status => status.finished)) { stoppedAtFinishedMatch = true; break; }
    const snapshot = step % 2 === 0 ? await takeSnapshots(warmupSteps + step, true) : { batchMs: 0, generationMs: 0, encodingMs: 0, bytes: 0, activeMatches: null };
    totalEncodedBytes += snapshot.bytes;
    measurements.push({ step, tick: warmupSteps + step, advanceMs, snapshotBatchMs: snapshot.batchMs,
      viewGenerationMs: snapshot.generationMs, jsonEncodingMs: snapshot.encodingMs, combinedMs: advanceMs + snapshot.batchMs, encodedBytes: snapshot.bytes, activeMatchesOnSnapshot: snapshot.activeMatches });
  }
  report.samplingWallMs = performance.now() - sampleStart;
  report.measuredSteps = measurements.length;
  report.simulatedSecondsMeasured = measurements.length / TICK_RATE;
  report.stoppedAtFinishedMatch = stoppedAtFinishedMatch;
  report.completeRequestedSample = measurements.length === targetSteps;
  report.minimum900StepsCollected = measurements.length >= 900;
  report.memoryAfterSampling = process.memoryUsage();
  report.samples = {
    allSixAdvanceTicks: summary(measurements.map(row => row.advanceMs)),
    twelveSnapshotBatches: summary(measurements.filter(row => row.encodedBytes > 0).map(row => row.snapshotBatchMs)),
    individualFilteredView: summary(profileMeasurements.map(row => row.generationMs)),
    individualJsonEncoding: summary(profileMeasurements.map(row => row.encodingMs)),
    combinedPerFixedStep: summary(measurements.map(row => row.combinedMs)),
    combinedOnSnapshotSteps: summary(measurements.filter(row => row.encodedBytes > 0).map(row => row.combinedMs)),
    combinedWhenAllSixActivelyPlaying: summary(measurements.filter(row => row.activeMatchesOnSnapshot === 6).map(row => row.combinedMs)),
  };
  report.p95Within25msBudget = report.samples.combinedPerFixedStep.p95Ms !== null && report.samples.combinedPerFixedStep.p95Ms <= report.settings.processingBudgetMs;
  report.snapshotStepP95Within25msBudget = report.samples.combinedOnSnapshotSteps.p95Ms !== null && report.samples.combinedOnSnapshotSteps.p95Ms <= report.settings.processingBudgetMs;
  report.encodedSnapshotCount = profileMeasurements.length;
  report.totalEncodedSnapshotBytes = totalEncodedBytes;
  report.databaseBeforeShutdown = await databaseSizes();
  for (const match of matches) {
    const view = await runtime.viewForPlayer(match.matchId, match.profiles[0]);
    report.matches.push({ label: match.label, matchId: match.matchId, arena: match.arena, phase: view.phase, tick: view.tick, round: view.round, score: view.score,
      completedRounds: view.rounds, roles: view.seats.map(seat => ({ seatId: seat.seatId, role: seat.role, bot: seat.bot, substitute: seat.substitute })) });
  }
} catch (error) {
  report.failures.push({ message: error.message, stack: error.stack });
  process.exitCode = 1;
} finally {
  // The normal runtime close may perform one final drain step; it is not measured.
  try { runtime.close(); } catch (error) { report.failures.push({ message: error.message }); process.exitCode = 1; }
  report.databaseAfterShutdown = await databaseSizes();
  report.environment.loadAverageAfter = loadavg();
  report.finishedAt = new Date().toISOString();
  const reportPath = join(directory, 'report.json');
  await writeFile(join(directory, 'measurements.json'), JSON.stringify({ fixedSteps: measurements, profiles: profileMeasurements }, null, 2), { mode: 0o600 });
  await writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
  process.stdout.write(JSON.stringify({ classification: report.classification, sourceSha: report.sourceSha, dirtyWorktree: report.dirtyWorktree,
    compiledRuntimeHash: report.compiledRuntimeHash, measuredSteps: report.measuredSteps, completeRequestedSample: report.completeRequestedSample,
    samples: report.samples, p95Within25msBudget: report.p95Within25msBudget, snapshotStepP95Within25msBudget: report.snapshotStepP95Within25msBudget,
    databaseAfterShutdown: report.databaseAfterShutdown, failures: report.failures.map(failure => failure.message), report: reportPath }, null, 2) + '\n');
}
