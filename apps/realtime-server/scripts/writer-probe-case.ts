import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cpus, release } from 'node:os';
import { serializeWorld, stepWorld } from '@iva-games/forpost/core';
import { RealtimeStore } from '../src/store';
import { writerFixture, writerHash as hash } from './writer-fixture';
import { WorkerRpc } from '../src/worker-rpc';
import { ResourceProbe } from '../src/capacity';
import type { CheckpointStatus } from '../src/checkpoint';

const directory = process.argv[2], samples = 600, warmup = 30, cases: unknown[] = [];
assert.ok(directory);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
const order = process.env.WRITER_PROBE_ORDER === 'reverse' ? [true, false] : [false, true];
for (const separateCheckpoint of order) {
  const mode = separateCheckpoint ? 'separate-passive-worker' : 'sqlite-auto-1000-pages';
  const path = join(directory, mode + '.sqlite'), store = new RealtimeStore(path, { separateCheckpoint });
  let checkpoint: WorkerRpc | null = null, checkpointStatus: CheckpointStatus | null = null;
  try {
    if (separateCheckpoint) {
      checkpoint = new WorkerRpc(new URL('./checkpoint-worker.js', import.meta.url), { path });
      checkpoint.worker.on('message', (message: { type?: string; status?: CheckpointStatus }) => {
        if (message.type === 'checkpointMetrics' && message.status) checkpointStatus = message.status;
      });
      checkpointStatus = await checkpoint.call<CheckpointStatus>('status');
    }
    const { world, match } = writerFixture();
    store.create(match, 'fixture-writer');
    const durations: number[] = [], checkpointCommits: number[] = [];
    const started = performance.now(), cpu = process.cpuUsage();
    for (let tick = 0; tick < samples + warmup; tick++) {
      stepWorld(world); match.world = serializeWorld(world); match.worldHash = hash(match.world); match.tick = world.tick; match.journalSeq++;
      const before = (store.db.pragma('wal_checkpoint(NOOP)') as { log: number; checkpointed: number }[])[0];
      const begin = performance.now();
      assert.deepEqual(store.commitBatch([{ match, leaseOwner: 'fixture-writer', journal: { type: 'tick', inputs: {}, controls: [], actions: [] }, receipts: [] }]), [{}]);
      const elapsed = performance.now() - begin;
      const after = (store.db.pragma('wal_checkpoint(NOOP)') as typeof before[])[0];
      if (tick >= warmup) {
        durations.push(elapsed);
        if (!separateCheckpoint && after.checkpointed > before.checkpointed) checkpointCommits.push(elapsed);
      }
      await sleep(started + (tick + 1) * 1000 / 30 - performance.now());
    }
    const elapsedMs = performance.now() - started, usedCpu = process.cpuUsage(cpu);
    const sorted = [...durations].sort((a, b) => a - b), percentile = (p: number) => sorted[Math.ceil(sorted.length * p) - 1];
    assert.equal(store.get(match.matchId)?.worldHash, match.worldHash);
    cases.push({ mode, samples, warmup, elapsedMs, cadenceMs: 1000 / 30, sqlite: (store.db.prepare('SELECT sqlite_version() AS v').get() as {v: string}).v,
      measuredCommitMs: { median: percentile(0.5), p99: percentile(0.99), max: sorted.at(-1), over50: durations.filter(value => value > 50).length },
      detectedAutoCheckpointCommits: checkpointCommits.length, detectedAutoCheckpointCommitMs: checkpointCommits,
      writer: store.writerMetrics(), checkpoint: checkpointStatus, cpuMs: (usedCpu.user + usedCpu.system) / 1000, processRss: process.memoryUsage().rss });
  } finally {
    if (checkpoint) { try { await checkpoint.call('close'); } finally { await checkpoint.stop(); } }
    store.close();
  }
}
const report = { kind: 'actual SQLite commits of a deterministic legal 3v3 world; diagnostic, not production capacity or browser acceptance',
  source: JSON.parse(readFileSync(join(directory, 'source.json'), 'utf8')) as unknown,
  environment: { node: process.version, cpuModel: cpus()[0]?.model, release: release(), resources: new ResourceProbe().sample() }, cases };
writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
