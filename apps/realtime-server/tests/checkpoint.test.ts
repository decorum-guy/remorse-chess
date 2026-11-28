import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { assertCheckpointBudget, CHECKPOINT_STALE_MS, WAL_LIMIT_BYTES, WalCheckpointer } from '../src/checkpoint';
import type { CheckpointStatus } from '../src/checkpoint';
import { RealtimeStore } from '../src/store';

const directories: string[] = [], connections: Database.Database[] = [], checkpointers: WalCheckpointer[] = [];
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'forpost-wal-')); directories.push(directory);
  const path = join(directory, 'test.sqlite'), store = new RealtimeStore(path, { separateCheckpoint: true });
  connections.push(store.db); return { path, store };
}
afterEach(() => {
  for (const checkpoint of checkpointers.splice(0)) checkpoint.close();
  for (const db of connections.splice(0)) if (db.open) db.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
describe('separate bounded WAL checkpoint', () => {
  it('preserves FULL durability and committed records while checkpointing on a second connection', () => {
    const { store, path } = fixture();
    expect(store.db.pragma('synchronous', { simple: true })).toBe(2);
    expect(store.db.pragma('wal_autocheckpoint', { simple: true })).toBe(0);
    store.enqueueStart({ startId: 'first', hostId: 'host', fingerprint: 'frozen', requestJson: '{}' });
    const checkpoint = new WalCheckpointer(path); checkpointers.push(checkpoint);
    const status = checkpoint.poll(true);
    expect(status.failures).toBe(0); expect(status.runs).toBe(1);
    expect(status.checkpointedFrames).toBe(status.logFrames);
    expect(status.pageSize).toBeGreaterThan(0); expect(status.walBytes).toBeLessThan(WAL_LIMIT_BYTES);
    expect(() => assertCheckpointBudget(status, path)).not.toThrow();
    expect(store.starts()[0]).toMatchObject({ startId: 'first', fingerprint: 'frozen' });
  });
  it('does not wait for a pinned reader and resumes progress after that reader leaves', () => {
    const { store, path } = fixture(), reader = new Database(path, { readonly: true }); connections.push(reader);
    const checkpoint = new WalCheckpointer(path); checkpointers.push(checkpoint); checkpoint.poll(true);
    reader.exec('BEGIN'); reader.prepare('SELECT * FROM rt_start_queue').all();
    store.enqueueStart({ startId: 'new', hostId: 'host', fingerprint: 'frozen', requestJson: '{}' });
    const blocked = checkpoint.poll(true);
    expect(blocked.failures).toBe(0); expect(blocked.checkpointedFrames).toBeLessThan(blocked.logFrames);
    expect(reader.prepare('SELECT count(*) AS count FROM rt_start_queue').get()).toEqual({ count: 0 });
    expect(store.starts()).toHaveLength(1);
    reader.exec('ROLLBACK'); const complete = checkpoint.poll(true);
    expect(complete.checkpointedFrames).toBe(complete.logFrames);
  });
  it('fails conservatively on a dead or failed checkpointer and on excessive retained WAL', () => {
    const { path } = fixture(), checkpoint = new WalCheckpointer(path); checkpointers.push(checkpoint);
    const status = checkpoint.poll(true), now = status.observedAt;
    expect(() => assertCheckpointBudget(null, path, now)).toThrow('CHECKPOINT_UNAVAILABLE');
    expect(() => assertCheckpointBudget({ ...status, failures: 1 }, path, now)).toThrow('CHECKPOINT_UNAVAILABLE');
    expect(() => assertCheckpointBudget(status, path, now + CHECKPOINT_STALE_MS + 1)).toThrow('CHECKPOINT_UNAVAILABLE');
    const oversized = join(directories.at(-1)!, 'size-fixture.sqlite');
    writeFileSync(oversized + '-wal', ''); truncateSync(oversized + '-wal', WAL_LIMIT_BYTES);
    expect(() => assertCheckpointBudget(status, oversized, now)).toThrow('CHECKPOINT_WAL_LIMIT');
  });
  it('reports safe checkpoint numbers and does not include database contents', () => {
    const { path } = fixture(), checkpoint = new WalCheckpointer(path); checkpointers.push(checkpoint);
    const status: CheckpointStatus = checkpoint.poll();
    expect(Object.keys(status).sort()).toEqual(['busy', 'checkpointedFrames', 'failures', 'logFrames', 'maxMs', 'observedAt', 'p99Ms', 'pageSize', 'runs', 'sqliteVersion', 'walBytes'].sort());
  });
});
