import Database from 'better-sqlite3';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ADMISSION_RESERVATION_MS, RealtimeError } from '@iva-games/realtime-kit';
import type { PauseReason, RuntimeManifest } from '@iva-games/realtime-kit';
import type { StartMatchRequest } from '@iva-games/session-kit';
import { fingerprint, hash } from './crypto.js';

export interface StoredMeta {
  epoch: number; receiptEpoch: number; worldTick: number; journalSeq: number; phase: string;
  elapsedSeconds: number; attempt: number; returnUntil: number | null;
  resumeAt: number | null; outcome: unknown | null; pendingOutcome: unknown | null;
  pauseReason?: PauseReason | null;
  controllers: { participantId: string; kind: 'human' | 'bot'; controllerGeneration: number }[];
}
export interface StoredMatch {
  matchId: string; startHash: string; rosterHash: string; manifest: RuntimeManifest;
  start: StartMatchRequest; meta: StoredMeta; fence: number;
}
export interface StoredJournal { seq: number; epoch: number; kind: string; payload: string; postHash: string }
export interface StoredSnapshot { seq: number; world: string; hash: string; worldTick: number }
export interface StoredReceipt { payloadHash: string; result: unknown; worldTick: number; journalSeq: number }
export interface Admission { reservationId: string | null; reservedUntil: number | null; position: number; queuedAt: number }
export interface Commit {
  matchId: string; ownerId: string; fence: number; meta: StoredMeta;
  kind: string; payload: string; postHash: string;
  snapshot?: { world: string; worldTick: number };
  checkpoint?: { id: string; world: string; worldTick: number };
  receipt?: { epoch: number; participantId: string; actionId: string; payloadHash: string; result: unknown; worldTick: number };
  outcome?: { resultId: string; value: unknown };
  now: number;
}
type Row = Record<string, string | number | null>;

/** Used only by the sequential writer worker in production. Every successful
 * response means the FULL-synchronous WAL transaction has committed. */
export class RealtimeStore {
  readonly db: Database.Database;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rt_matches(
        id TEXT PRIMARY KEY, start_id TEXT UNIQUE NOT NULL, start_hash TEXT NOT NULL, roster_hash TEXT NOT NULL,
        manifest TEXT NOT NULL, start TEXT NOT NULL, meta TEXT NOT NULL,
        owner_id TEXT NOT NULL, fence INTEGER NOT NULL, lease_until INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS rt_snapshots(
        match_id TEXT NOT NULL REFERENCES rt_matches(id), seq INTEGER NOT NULL,
        world TEXT NOT NULL, hash TEXT NOT NULL, world_tick INTEGER NOT NULL, PRIMARY KEY(match_id,seq));
      CREATE TABLE IF NOT EXISTS rt_journal(
        match_id TEXT NOT NULL REFERENCES rt_matches(id), seq INTEGER NOT NULL, epoch INTEGER NOT NULL,
        kind TEXT NOT NULL, payload TEXT NOT NULL, post_hash TEXT NOT NULL, PRIMARY KEY(match_id,seq));
      CREATE TABLE IF NOT EXISTS rt_receipts(
        match_id TEXT NOT NULL REFERENCES rt_matches(id), epoch INTEGER NOT NULL, participant_id TEXT NOT NULL,
        action_id TEXT NOT NULL, payload_hash TEXT NOT NULL, result TEXT NOT NULL, world_tick INTEGER NOT NULL,
        journal_seq INTEGER NOT NULL, PRIMARY KEY(match_id,epoch,participant_id,action_id));
      CREATE TABLE IF NOT EXISTS rt_checkpoints(
        match_id TEXT NOT NULL REFERENCES rt_matches(id), id TEXT NOT NULL, world TEXT NOT NULL,
        hash TEXT NOT NULL, world_tick INTEGER NOT NULL, PRIMARY KEY(match_id,id));
      CREATE TABLE IF NOT EXISTS rt_once(kind TEXT NOT NULL,id TEXT NOT NULL,expires_at INTEGER NOT NULL,PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS rt_outbox(
        result_id TEXT PRIMARY KEY,match_id TEXT UNIQUE NOT NULL REFERENCES rt_matches(id),value TEXT NOT NULL,acknowledged INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS rt_admissions(
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,start_id TEXT UNIQUE NOT NULL,host_id TEXT UNIQUE NOT NULL,
        game_id TEXT NOT NULL,start TEXT NOT NULL,start_hash TEXT NOT NULL,queued_at INTEGER NOT NULL,last_seen INTEGER NOT NULL,
        reservation_id TEXT,reserved_until INTEGER);
      CREATE TABLE IF NOT EXISTS rt_recovery_failures(
        match_id TEXT PRIMARY KEY REFERENCES rt_matches(id),code TEXT NOT NULL,detected_at INTEGER NOT NULL);
      PRAGMA user_version=1;
    `);
  }
  close(): void { this.db.close(); }
  async backup(path: string): Promise<void> { await this.db.backup(path); chmodSync(path, 0o600); }
  private decode(row: Row): StoredMatch {
    return { matchId: String(row.id), startHash: String(row.start_hash), rosterHash: String(row.roster_hash),
      manifest: JSON.parse(String(row.manifest)), start: JSON.parse(String(row.start)), meta: JSON.parse(String(row.meta)), fence: Number(row.fence) };
  }
  all(): StoredMatch[] { return (this.db.prepare('SELECT * FROM rt_matches').all() as Row[]).map(row => this.decode(row)); }
  releaseManifest(gameIds: string[] = []): unknown {
    return this.db.transaction(() => ({ schema: 1, capturedAt: Date.now(),
      gameIds: [...new Set([...gameIds, ...this.all().map(match => match.manifest.gameId)])].sort(),
      matches: this.all().map(match => ({ matchId: match.matchId, roomId: match.start.roomId,
        startCommandId: match.start.startCommandId, gameId: match.manifest.gameId, rosterHash: match.rosterHash,
        runtimeArtifactId: match.manifest.runtimeArtifactId, physicsBuildHash: match.manifest.physicsBuildHash,
        clientContentHash: match.manifest.clientContentHash, clientRoute: match.manifest.clientRoute,
        serializerVersion: match.manifest.serializerVersion, rulesVersion: match.manifest.rulesVersion,
        contentVersion: match.manifest.contentVersion, epoch: match.meta.epoch, journalSeq: match.meta.journalSeq,
        worldTick: match.meta.worldTick, phase: match.meta.phase })).sort((a, b) => a.matchId.localeCompare(b.matchId)),
      outbox: this.db.prepare('SELECT result_id AS resultId,match_id AS matchId,acknowledged FROM rt_outbox ORDER BY result_id').all(),
      admissions: this.db.prepare('SELECT sequence,start_id AS startCommandId,host_id AS hostPlayerId,game_id AS gameId,start_hash AS startHash,reservation_id AS reservationId,reserved_until AS reservedUntil FROM rt_admissions ORDER BY sequence').all(),
    })).deferred();
  }
  get(matchId: string): StoredMatch {
    const row = this.db.prepare('SELECT * FROM rt_matches WHERE id=?').get(matchId) as Row | undefined;
    if (!row) throw new RealtimeError('MATCH_UNAVAILABLE', 404);
    return this.decode(row);
  }
  byStart(startId: string): StoredMatch | null {
    const row = this.db.prepare('SELECT * FROM rt_matches WHERE start_id=?').get(startId) as Row | undefined;
    return row ? this.decode(row) : null;
  }
  queueAdmission(gameId: string, input: StartMatchRequest, hostPlayerId: string, maxMatches: number, now: number): Admission {
    return this.db.transaction(() => {
      // Only callers still attempting their durable start retain a place. A
      // missing platform cannot reserve slots indefinitely after its TTL.
      this.db.prepare('DELETE FROM rt_admissions WHERE last_seen<? AND (reserved_until IS NULL OR reserved_until<?)').run(now - 60_000, now);
      const startHash = fingerprint({ gameId, input });
      let row = this.db.prepare('SELECT * FROM rt_admissions WHERE start_id=?').get(input.startCommandId) as Row | undefined;
      if (row) {
        if (row.start_hash !== startHash || row.host_id !== hostPlayerId) throw new RealtimeError('START_ID_REUSED', 409);
        this.db.prepare('UPDATE rt_admissions SET last_seen=? WHERE start_id=?').run(now, input.startCommandId);
      } else {
        if (this.db.prepare('SELECT 1 FROM rt_admissions WHERE host_id=?').get(hostPlayerId)) throw new RealtimeError('HOST_START_PENDING', 409);
        if (Number((this.db.prepare('SELECT COUNT(*) AS n FROM rt_admissions').get() as Row).n) >= 64) throw new RealtimeError('ADMISSION_QUEUE_FULL', 503);
        this.db.prepare('INSERT INTO rt_admissions(start_id,host_id,game_id,start,start_hash,queued_at,last_seen) VALUES(?,?,?,?,?,?,?)')
          .run(input.startCommandId, hostPlayerId, gameId, JSON.stringify(input), startHash, now, now);
      }
      // Expired reservations move behind already waiting hosts. Retrying before
      // expiry returns the same token and never extends its 15-second deadline.
      const expired = this.db.prepare('SELECT start_id FROM rt_admissions WHERE reserved_until<=? ORDER BY sequence').all(now) as Row[];
      for (const value of expired) this.db.prepare('UPDATE rt_admissions SET sequence=(SELECT COALESCE(MAX(sequence),0)+1 FROM rt_admissions),reservation_id=NULL,reserved_until=NULL WHERE start_id=?').run(value.start_id);
      const active = Number((this.db.prepare("SELECT COUNT(*) AS n FROM rt_matches m WHERE json_extract(meta,'$.phase') NOT IN ('finished','abandoned') AND NOT EXISTS(SELECT 1 FROM rt_recovery_failures f WHERE f.match_id=m.id)").get() as Row).n);
      const reserved = Number((this.db.prepare('SELECT COUNT(*) AS n FROM rt_admissions WHERE reserved_until>?').get(now) as Row).n);
      const slots = Math.max(0, maxMatches - active - reserved);
      const waiting = this.db.prepare('SELECT start_id FROM rt_admissions WHERE reservation_id IS NULL ORDER BY sequence LIMIT ?').all(slots) as Row[];
      for (const value of waiting) this.db.prepare('UPDATE rt_admissions SET reservation_id=?,reserved_until=? WHERE start_id=?').run(randomUUID(), now + ADMISSION_RESERVATION_MS, value.start_id);
      row = this.db.prepare('SELECT * FROM rt_admissions WHERE start_id=?').get(input.startCommandId) as Row;
      const position = Number((this.db.prepare('SELECT COUNT(*) AS n FROM rt_admissions WHERE sequence<=?').get(row.sequence) as Row).n);
      return { reservationId: row.reservation_id === null ? null : String(row.reservation_id), reservedUntil: row.reserved_until === null ? null : Number(row.reserved_until), position, queuedAt: Number(row.queued_at) };
    }).immediate();
  }
  admissionCount(): number { return Number((this.db.prepare('SELECT COUNT(*) AS n FROM rt_admissions').get() as Row).n); }
  markRecoveryFailure(matchId: string, code: string, now: number): void {
    this.db.prepare('INSERT INTO rt_recovery_failures VALUES(?,?,?) ON CONFLICT(match_id) DO UPDATE SET code=excluded.code,detected_at=excluded.detected_at').run(matchId, code, now);
  }
  clearRecoveryFailure(matchId: string): void { this.db.prepare('DELETE FROM rt_recovery_failures WHERE match_id=?').run(matchId); }
  create(input: StoredMatch, ownerId: string, world: string, now: number, reservationId?: string): StoredMatch {
    return this.db.transaction(() => {
      const prior = this.byStart(input.start.startCommandId);
      if (prior) {
        if (prior.startHash !== input.startHash) throw new RealtimeError('START_ID_REUSED', 409);
        return prior;
      }
      if (reservationId !== undefined) {
        const reservation = this.db.prepare('SELECT reservation_id,reserved_until,start_hash FROM rt_admissions WHERE start_id=?').get(input.start.startCommandId) as Row | undefined;
        if (!reservation || reservation.reservation_id !== reservationId || Number(reservation.reserved_until) <= now || reservation.start_hash !== input.startHash) throw new RealtimeError('ADMISSION_EXPIRED', 409);
      }
      this.db.prepare('INSERT INTO rt_matches VALUES(?,?,?,?,?,?,?,?,?,?)').run(input.matchId, input.start.startCommandId, input.startHash, input.rosterHash, JSON.stringify(input.manifest), JSON.stringify(input.start), JSON.stringify(input.meta), ownerId, 1, now + 15_000);
      const digest = hash(world);
      this.db.prepare('INSERT INTO rt_snapshots VALUES(?,?,?,?,?)').run(input.matchId, 0, world, digest, 0);
      this.db.prepare('INSERT INTO rt_checkpoints VALUES(?,?,?,?,?)').run(input.matchId, 'start', world, digest, 0);
      if (reservationId !== undefined) this.db.prepare('DELETE FROM rt_admissions WHERE start_id=? AND reservation_id=?').run(input.start.startCommandId, reservationId);
      return { ...input, fence: 1 };
    }).immediate();
  }
  acquire(matchId: string, ownerId: string, now: number): number {
    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT owner_id,fence,lease_until FROM rt_matches WHERE id=?').get(matchId) as Row | undefined;
      if (!row) throw new RealtimeError('MATCH_UNAVAILABLE', 404);
      if (row.owner_id !== ownerId && Number(row.lease_until) > now) throw new RealtimeError('OWNER_BUSY', 503);
      const fence = Number(row.fence) + 1;
      this.db.prepare('UPDATE rt_matches SET owner_id=?,fence=?,lease_until=? WHERE id=?').run(ownerId, fence, now + 15_000, matchId);
      return fence;
    }).immediate();
  }
  renew(matchId: string, ownerId: string, fence: number, now: number): void {
    const result = this.db.prepare('UPDATE rt_matches SET lease_until=? WHERE id=? AND owner_id=? AND fence=? AND lease_until>=?').run(now + 15_000, matchId, ownerId, fence, now);
    if (result.changes !== 1) throw new RealtimeError('OWNER_FENCED', 503);
  }
  release(matchId: string, ownerId: string, fence: number): void {
    this.db.prepare('UPDATE rt_matches SET lease_until=0 WHERE id=? AND owner_id=? AND fence=?').run(matchId, ownerId, fence);
  }
  commit(input: Commit): void {
    this.db.transaction(() => {
      const row = this.db.prepare('SELECT owner_id,fence,lease_until,meta FROM rt_matches WHERE id=?').get(input.matchId) as Row | undefined;
      if (!row || row.owner_id !== input.ownerId || Number(row.fence) !== input.fence || Number(row.lease_until) < input.now) throw new RealtimeError('OWNER_FENCED', 503);
      const previous = JSON.parse(String(row.meta)) as StoredMeta;
      if (input.meta.journalSeq !== previous.journalSeq + 1) throw new RealtimeError('JOURNAL_CONFLICT', 409);
      this.db.prepare('INSERT INTO rt_journal VALUES(?,?,?,?,?,?)').run(input.matchId, input.meta.journalSeq, input.meta.epoch, input.kind, input.payload, input.postHash);
      this.db.prepare('UPDATE rt_matches SET meta=?,lease_until=? WHERE id=?').run(JSON.stringify(input.meta), input.now + 15_000, input.matchId);
      if (input.snapshot) {
        if (hash(input.snapshot.world) !== input.postHash) throw new RealtimeError('SNAPSHOT_HASH_MISMATCH');
        this.db.prepare('INSERT INTO rt_snapshots VALUES(?,?,?,?,?)').run(input.matchId, input.meta.journalSeq, input.snapshot.world, input.postHash, input.snapshot.worldTick);
        this.db.prepare('DELETE FROM rt_snapshots WHERE match_id=? AND seq NOT IN (SELECT seq FROM rt_snapshots WHERE match_id=? ORDER BY seq DESC LIMIT 2)').run(input.matchId, input.matchId);
      }
      if (input.checkpoint) this.db.prepare('INSERT OR REPLACE INTO rt_checkpoints VALUES(?,?,?,?,?)').run(input.matchId, input.checkpoint.id, input.checkpoint.world, hash(input.checkpoint.world), input.checkpoint.worldTick);
      if (input.receipt) {
        const r = input.receipt;
        this.db.prepare('INSERT INTO rt_receipts VALUES(?,?,?,?,?,?,?,?)').run(input.matchId, r.epoch, r.participantId, r.actionId, r.payloadHash, JSON.stringify(r.result), r.worldTick, input.meta.journalSeq);
      }
      if (input.outcome) this.db.prepare('INSERT INTO rt_outbox(result_id,match_id,value) VALUES(?,?,?) ON CONFLICT(match_id) DO NOTHING').run(input.outcome.resultId, input.matchId, JSON.stringify(input.outcome.value));
    }).immediate();
  }
  recovery(matchId: string): { snapshot: StoredSnapshot; journal: StoredJournal[] } {
    const row = this.db.prepare('SELECT * FROM rt_snapshots WHERE match_id=? ORDER BY seq DESC LIMIT 1').get(matchId) as Row | undefined;
    if (!row || hash(String(row.world)) !== row.hash) throw new RealtimeError('CORRUPT_SNAPSHOT', 503);
    const snapshot: StoredSnapshot = { seq: Number(row.seq), world: String(row.world), hash: String(row.hash), worldTick: Number(row.world_tick) };
    const journal = (this.db.prepare('SELECT * FROM rt_journal WHERE match_id=? AND seq>? ORDER BY seq').all(matchId, snapshot.seq) as Row[]).map(entry => ({ seq: Number(entry.seq), epoch: Number(entry.epoch), kind: String(entry.kind), payload: String(entry.payload), postHash: String(entry.post_hash) }));
    return { snapshot, journal };
  }
  checkpoint(matchId: string, id: string): { world: string; worldTick: number } {
    const row = this.db.prepare('SELECT * FROM rt_checkpoints WHERE match_id=? AND id=?').get(matchId, id) as Row | undefined;
    if (!row || hash(String(row.world)) !== row.hash) throw new RealtimeError('CHECKPOINT_UNAVAILABLE', 409);
    return { world: String(row.world), worldTick: Number(row.world_tick) };
  }
  receipt(matchId: string, epoch: number, participantId: string, actionId: string): StoredReceipt | null {
    const row = this.db.prepare('SELECT * FROM rt_receipts WHERE match_id=? AND epoch=? AND participant_id=? AND action_id=?').get(matchId, epoch, participantId, actionId) as Row | undefined;
    return row ? { payloadHash: String(row.payload_hash), result: JSON.parse(String(row.result)), worldTick: Number(row.world_tick), journalSeq: Number(row.journal_seq) } : null;
  }
  consume(kind: string, id: string, expiresAt: number, now: number): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM rt_once WHERE expires_at<?').run(now - 60_000);
      const result = this.db.prepare('INSERT OR IGNORE INTO rt_once VALUES(?,?,?)').run(kind, id, expiresAt);
      if (result.changes !== 1) throw new RealtimeError('REPLAY_REJECTED', 401);
    }).immediate();
  }
  acknowledgeResult(matchId: string, resultId: string): void {
    this.db.prepare('UPDATE rt_outbox SET acknowledged=1 WHERE match_id=? AND result_id=?').run(matchId, resultId);
  }
}

export type StorageMethod = 'all' | 'releaseManifest' | 'get' | 'byStart' | 'queueAdmission' | 'admissionCount' | 'markRecoveryFailure' | 'clearRecoveryFailure' | 'create' | 'acquire' | 'renew' | 'release' | 'commit' | 'recovery' | 'checkpoint' | 'receipt' | 'consume' | 'acknowledgeResult' | 'backup' | 'close';
export interface StorageClient {
  call<M extends StorageMethod>(method: M, ...args: Parameters<RealtimeStore[M]>): Promise<Awaited<ReturnType<RealtimeStore[M]>>>;
}
export class LocalStorageClient implements StorageClient {
  constructor(readonly store: RealtimeStore) {}
  async call<M extends StorageMethod>(method: M, ...args: Parameters<RealtimeStore[M]>): Promise<Awaited<ReturnType<RealtimeStore[M]>>> {
    const invoke = this.store[method] as (...values: Parameters<RealtimeStore[M]>) => ReturnType<RealtimeStore[M]>;
    return await invoke.apply(this.store, args);
  }
}
