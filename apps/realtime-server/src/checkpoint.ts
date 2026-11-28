import Database from 'better-sqlite3';
import { statSync } from 'node:fs';
import { TimingHistogram } from './timing.js';

export const WAL_LIMIT_BYTES = 64 * 1024 * 1024;
export const CHECKPOINT_STALE_MS = 5000;
export interface CheckpointStatus {
  observedAt: number; sqliteVersion: string; pageSize: number; walBytes: number;
  logFrames: number; checkpointedFrames: number; busy: number;
  runs: number; maxMs: number; p99Ms: number; failures: number;
}
/** A separate connection: PASSIVE never waits for readers/writers to finish. */
export class WalCheckpointer {
  private readonly db: Database.Database;
  private readonly timing = new TimingHistogram();
  private lastAttemptAt = 0;
  private status: CheckpointStatus;
  constructor(private readonly path: string) {
    this.db = new Database(path, { fileMustExist: true });
    const version = (this.db.prepare('SELECT sqlite_version() AS version').get() as { version: string }).version;
    const [major, minor, patch] = version.split('.').map(Number);
    // Separate writer/checkpointer connections need the upstream WAL-reset fix.
    if (!(major > 3 || major === 3 && (minor > 51 || minor === 51 && patch >= 3))) {
      this.db.close(); throw new Error('UNSUPPORTED_CHECKPOINT_SQLITE');
    }
    this.db.pragma('busy_timeout = 0'); this.db.pragma('synchronous = FULL'); this.db.pragma('wal_autocheckpoint = 0');
    if (this.db.pragma('journal_mode', { simple: true }) !== 'wal') { this.db.close(); throw new Error('CHECKPOINT_REQUIRES_WAL'); }
    this.status = { observedAt: 0, sqliteVersion: version, pageSize: this.db.pragma('page_size', { simple: true }) as number,
      walBytes: 0, logFrames: 0, checkpointedFrames: 0, busy: 0, runs: 0, maxMs: 0, p99Ms: 0, failures: 0 };
  }
  poll(force = false): CheckpointStatus {
    const now = Date.now();
    try {
      let progress = (this.db.pragma('wal_checkpoint(NOOP)') as { busy: number; log: number; checkpointed: number }[])[0];
      if (progress.log > progress.checkpointed && (force || progress.log >= 1000 || now - this.lastAttemptAt >= 1000)) {
        this.lastAttemptAt = now;
        const start = performance.now();
        progress = (this.db.pragma('wal_checkpoint(PASSIVE)') as typeof progress[])[0];
        const elapsed = performance.now() - start; this.timing.record(elapsed);
        this.status.runs++; this.status.maxMs = Math.max(this.status.maxMs, elapsed); this.status.p99Ms = this.timing.p99();
      }
      this.status.logFrames = Math.max(0, progress.log); this.status.checkpointedFrames = Math.max(0, progress.checkpointed);
      this.status.busy = progress.busy; this.status.walBytes = walBytes(this.path); this.status.observedAt = Date.now();
    } catch { this.status.failures++; this.status.observedAt = Date.now(); }
    return { ...this.status };
  }
  close(): void { this.db.close(); }
}

export function walBytes(path: string): number {
  try { return statSync(path + '-wal').size; }
  catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return 0; throw error; }
}
export function assertCheckpointBudget(status: CheckpointStatus | null, path: string, now = Date.now()): void {
  if (!status || status.failures || now - status.observedAt > CHECKPOINT_STALE_MS) throw new Error('CHECKPOINT_UNAVAILABLE');
  if (walBytes(path) >= WAL_LIMIT_BYTES) throw new Error('CHECKPOINT_WAL_LIMIT');
}
