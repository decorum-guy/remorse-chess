/** Own-process storage diagnostic; no alternative transaction implementation. */
import assert from 'node:assert/strict';
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { serializeWorld, stepWorld } from '@iva-games/forpost/core';
import { RealtimeStore } from '../src/store';
import { WorkerRpc } from '../src/worker-rpc';
import type { CheckpointStatus } from '../src/checkpoint';
import { writerFixture, writerHash } from './writer-fixture';

process.umask(0o077);
const [phase, directory, samplesText, warmupText] = process.argv.slice(2);
const samples = Number(samplesText), warmup = Number(warmupText);
assert.ok(['fsync', 'sqlite'].includes(phase)); assert.ok(lstatSync(directory).isDirectory());
assert.ok(Number.isSafeInteger(samples) && samples >= 8 && samples <= 540);
assert.ok(Number.isSafeInteger(warmup) && warmup >= 0 && warmup <= 30);
let cancelled = false;
process.once('SIGTERM', () => { cancelled = true; });
const check = () => { if (cancelled) throw new Error('STORAGE_DIAGNOSTIC_INTERRUPTED'); };
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
const cpuMs = (before: ReturnType<typeof process.threadCpuUsage>) => { const used = process.threadCpuUsage(before); return (used.user + used.system) / 1000; };
function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const p = (value: number) => sorted[Math.ceil(sorted.length * value) - 1] ?? null;
  return { samples: values.length, p50Ms: p(0.5), p95Ms: p(0.95), p99Ms: p(0.99), maxMs: sorted.at(-1) ?? null,
    meanMs: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null, over50Ms: values.filter(value => value > 50).length };
}
const raw: Record<string, unknown>[] = [], startedAt = Date.now(), started = performance.now();
let result: Record<string, unknown>;
if (phase === 'fsync') {
  const path = join(directory, 'fsync-fixture.bin'), fd = openSync(path, 'wx', 0o600), buffer = Buffer.alloc(16 * 1024);
  const writes: number[] = [], syncs: number[] = [], totals: number[] = [], cpus: number[] = [];
  try {
    // Directory setup is outside the measured sequence; no tmpfs or sync mode change.
    const directoryFd = openSync(directory, 'r'); try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
    for (let index = 0; index < warmup + samples; index++) {
      check(); buffer.writeUInt32LE(index, 0);
      const at = Date.now(), cpu = process.threadCpuUsage(), start = performance.now();
      assert.equal(writeSync(fd, buffer), buffer.length);
      const afterWrite = performance.now(); fsyncSync(fd); const end = performance.now(), threadCpu = cpuMs(cpu);
      if (index >= warmup) {
        writes.push(afterWrite - start); syncs.push(end - afterWrite); totals.push(end - start); cpus.push(threadCpu);
        raw.push({ index: index - warmup, at, writeMs: afterWrite - start, fsyncMs: end - afterWrite, totalMs: end - start, threadCpuMs: threadCpu });
      }
      await delay(started + (index + 1) * 1000 / 30 - performance.now());
    }
  } finally { closeSync(fd); }
  result = { phase, processId: process.pid, startedAt, endedAt: Date.now(), elapsedMs: performance.now() - started, samples, warmup,
    bytesPerWrite: buffer.length, totalWrittenBytes: (samples + warmup) * buffer.length,
    write: stats(writes), fsync: stats(syncs), total: stats(totals), threadCpu: stats(cpus),
    scope: 'Explicit 16 KiB append plus fsync file fixture; not a SQLite commit or power-loss test' };
} else {
  const path = join(directory, 'realtime.sqlite'); assert.equal(existsSync(path), false);
  const store = new RealtimeStore(path, { separateCheckpoint: true });
  let checkpoint: WorkerRpc | null = null, checkpointStatus: CheckpointStatus;
  const checkpoints: CheckpointStatus[] = [];
  try {
    // Identify the binding actually loaded by the unchanged store, including
    // prebuilt distributions whose package exports hide build/Release paths.
    const require = createRequire(import.meta.url), packagePath = require.resolve('better-sqlite3/package.json');
    const packageDirectory = dirname(packagePath), loaded = Object.keys(require.cache).filter(file => file.startsWith(packageDirectory + '/') && file.endsWith('.node'));
    assert.equal(loaded.length, 1);
    const nativeSqlite = { sha256: createHash('sha256').update(readFileSync(loaded[0])).digest('hex'),
      file: relative(packageDirectory, loaded[0]), packageVersion: (JSON.parse(readFileSync(packagePath, 'utf8')) as { version: string }).version };
    assert.equal(store.db.pragma('synchronous', { simple: true }), 2);
    assert.equal(store.db.pragma('journal_mode', { simple: true }), 'wal');
    assert.equal(store.db.pragma('wal_autocheckpoint', { simple: true }), 0);
    checkpoint = new WorkerRpc(new URL('./checkpoint-worker.js', import.meta.url), { path });
    checkpoint.worker.on('message', (message: { type?: string; status?: CheckpointStatus }) => {
      if (message.type === 'checkpointMetrics' && message.status) { checkpointStatus = message.status; if (checkpoints.length < 1200) checkpoints.push(message.status); }
    });
    checkpointStatus = await checkpoint.call<CheckpointStatus>('status');
    const { world, match, leaseOwner } = writerFixture({ teamSize: 1, advanceTicks: 0, temporaryBot: false });
    store.create(match, leaseOwner);
    const startTick = world.tick, startPhase = world.phase, measured: number[] = [], cpus: number[] = [], backlog: number[] = [];
    const clock = performance.now();
    for (let index = 0; index < warmup + samples; index++) {
      check(); stepWorld(world); match.world = serializeWorld(world); match.worldHash = writerHash(match.world); match.tick = world.tick; match.journalSeq++;
      const at = Date.now(), cpu = process.threadCpuUsage(), start = performance.now();
      const replies = store.commitBatch([{ match, leaseOwner, journal: { type: 'tick', inputs: {}, controls: [], actions: [] }, receipts: [] }]);
      const end = performance.now(), threadCpu = cpuMs(cpu), lateness = Math.max(0, end - clock - (index + 1) * 1000 / 30);
      assert.deepEqual(replies, [{}]);
      if (index >= warmup) {
        measured.push(end - start); cpus.push(threadCpu); backlog.push(lateness);
        raw.push({ index: index - warmup, tick: world.tick, at, commitMs: end - start, threadCpuMs: threadCpu, pacingDebtMs: lateness,
          checkpointObservedAt: checkpointStatus?.observedAt ?? null, checkpointRuns: checkpointStatus?.runs ?? null });
      }
      await delay(clock + (index + 1) * 1000 / 30 - performance.now());
    }
    assert.equal(store.get(match.matchId)?.worldHash, match.worldHash);
    assert.equal(store.get(match.matchId)?.journalSeq, match.journalSeq);
    const currentCheckpoint = await checkpoint.call<CheckpointStatus>('status');
    assert.equal(currentCheckpoint.failures, 0);
    result = { phase, processId: process.pid, startedAt, endedAt: Date.now(), elapsedMs: performance.now() - started, samples, warmup, cadenceMs: 1000 / 30,
      fixture: { mapId: 'FP01', teamSize: 1, seed: 5149, startTick, endTick: world.tick, startPhase, endPhase: world.phase,
        humanSeats: 1, explicitBotSeats: 1, temporaryBot: false, realCoreSteps: true },
      sqliteVersion: (store.db.prepare('SELECT sqlite_version() AS version').get() as { version: string }).version,
      nativeSqlite,
      journalMode: store.db.pragma('journal_mode', { simple: true }), verifiedFinalState: true,
      commit: stats(measured), threadCpu: stats(cpus), pacingDebt: stats(backlog), writer: store.writerMetrics(), checkpoint: currentCheckpoint,
      scope: 'Existing RealtimeStore.commitBatch and PASSIVE worker; direct one-room writer diagnostic, not full server or browser acceptance' };
  } finally {
    if (checkpoint) { try { await checkpoint.call('close'); } finally { await checkpoint.stop(); } }
    store.close();
    writeFileSync(join(directory, 'checkpoints.json'), JSON.stringify(checkpoints), { mode: 0o600 });
  }
}
check();
writeFileSync(join(directory, 'samples.json'), JSON.stringify(raw), { mode: 0o600 });
writeFileSync(join(directory, 'result.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
