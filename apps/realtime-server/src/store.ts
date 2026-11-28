import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { hash } from './crypto.js';
import { LIMITS } from '@iva-games/realtime-kit';
import { TimingHistogram } from './timing.js';

export interface FrozenParticipant { participantId: string; playerId: string | null; displayName: string; team: 'A' | 'B'; controller: 'human' | 'bot' }
export interface Control { generation: number; connectionId: string | null; lastActivity: number; lastInputAt: number; inputSeq: number; consumed: number; temporaryBot: boolean }
export interface StoredMatch {
  matchId: string; startId: string; fingerprint: string; roomId: string; kind: 'account' | 'practice'; ownerHash: string | null;
  roster: FrozenParticipant[]; rosterHash: string; rulesVersion: string; contentVersion: string; manifest: Record<string, string>;
  world: string; worldHash: string; tick: number; epoch: number; ownerEpoch: number; journalSeq: number;
  controls: Record<string, Control>; phase: string; lastHumanAt: number; pausedAt: number | null;
  expiresAt: number; pendingOutcome: unknown; outcome: unknown; countdownUntil: number; createdAt: number;
  pauseReason?: 'NO_HUMANS' | 'SERVER_BUSY' | 'SERVER_UPDATING' | 'RECOVERY' | null;
}
export interface Receipt { matchId: string; participantId: string; actionId: string; payloadHash: string; result: unknown; epoch: number; seq: number }
export interface Commit {
  match: StoredMatch; leaseOwner: string; journal: unknown; receipts: Receipt[]; result?: { resultId: string; outcome: unknown };
}
export interface StoredStart {
  ordinal: number; startId: string; hostId: string; fingerprint: string; requestJson: string; createdAt: number;
  reservationId: string | null; reservedUntil: number | null; leaseOwner: string | null;
}
export class RealtimeStore {
  readonly db: Database.Database;
  private readonly statements = new Map<string, Database.Statement>();
  private readonly transactionTiming = new TimingHistogram();
  private readonly bodyTiming = new TimingHistogram();
  private readonly finalizeTiming = new TimingHistogram();
  private batchBodyMs = 0;
  private writerSamples = { batches: 0, maxTransactionMs: 0, maxWorldBytes: 0, maxRecordBytes: 0, maxJournalBytes: 0 };
  constructor(path: string, options: { separateCheckpoint?: boolean } = {}) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL'); this.db.pragma('synchronous = FULL'); this.db.pragma('foreign_keys = ON'); this.db.pragma('busy_timeout = 3000');
    if (options.separateCheckpoint) { this.db.pragma('wal_autocheckpoint = 0'); this.db.pragma('journal_size_limit = 16777216'); }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rt_matches (
        match_id TEXT PRIMARY KEY, start_id TEXT UNIQUE NOT NULL, fingerprint TEXT NOT NULL,
        record_json TEXT NOT NULL, world_hash TEXT NOT NULL, owner_epoch INTEGER NOT NULL,
        lease_owner TEXT NOT NULL, lease_until INTEGER NOT NULL, journal_seq INTEGER NOT NULL,
        expires_at INTEGER NOT NULL, phase TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS rt_journal (
        match_id TEXT NOT NULL REFERENCES rt_matches(match_id), seq INTEGER NOT NULL,
        tick INTEGER NOT NULL, record_json TEXT NOT NULL, world_hash TEXT NOT NULL,
        PRIMARY KEY (match_id, seq)
      );
      CREATE TABLE IF NOT EXISTS rt_checkpoints (
        match_id TEXT NOT NULL REFERENCES rt_matches(match_id), seq INTEGER NOT NULL,
        record_json TEXT NOT NULL, world_hash TEXT NOT NULL, PRIMARY KEY (match_id,seq)
      );
      CREATE TABLE IF NOT EXISTS rt_actions (
        match_id TEXT NOT NULL REFERENCES rt_matches(match_id), action_id TEXT NOT NULL,
        participant_id TEXT NOT NULL, payload_hash TEXT NOT NULL, record_json TEXT NOT NULL,
        PRIMARY KEY(match_id, action_id)
      );
      CREATE TABLE IF NOT EXISTS rt_tickets (ticket_id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS rt_bridge_requests (request_id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS rt_outbox (result_id TEXT PRIMARY KEY, match_id TEXT NOT NULL, payload_json TEXT NOT NULL, delivered_at INTEGER);
      CREATE TABLE IF NOT EXISTS rt_admissions (admission_id TEXT PRIMARY KEY, player_id TEXT NOT NULL, expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS rt_start_queue (
        ordinal INTEGER PRIMARY KEY AUTOINCREMENT, start_id TEXT UNIQUE NOT NULL, host_id TEXT UNIQUE NOT NULL,
        fingerprint TEXT NOT NULL, request_json TEXT NOT NULL, created_at INTEGER NOT NULL,
        reservation_id TEXT, reserved_until INTEGER, lease_owner TEXT
      );
    `);
  }
  private statement(sql: string): Database.Statement {
    let statement = this.statements.get(sql);
    if (!statement) { statement = this.db.prepare(sql); this.statements.set(sql, statement); }
    return statement;
  }
  private startRow(row: Record<string, unknown>): StoredStart {
    return { ordinal: Number(row.ordinal), startId: String(row.start_id), hostId: String(row.host_id), fingerprint: String(row.fingerprint),
      requestJson: String(row.request_json), createdAt: Number(row.created_at), reservationId: row.reservation_id === null ? null : String(row.reservation_id),
      reservedUntil: row.reserved_until === null ? null : Number(row.reserved_until), leaseOwner: row.lease_owner === null ? null : String(row.lease_owner) };
  }
  starts(): StoredStart[] {
    return (this.statement('SELECT * FROM rt_start_queue ORDER BY ordinal').all() as Record<string, unknown>[]).map(row => this.startRow(row));
  }
  enqueueStart(start: Pick<StoredStart, 'startId' | 'hostId' | 'fingerprint' | 'requestJson'>, now = Date.now()): StoredStart | null {
    return this.db.transaction(() => {
      const completed = this.byStart(start.startId);
      if (completed) { if (completed.fingerprint !== start.fingerprint) throw new Error('START_CONFLICT'); return null; }
      const prior = this.statement('SELECT * FROM rt_start_queue WHERE start_id=?').get(start.startId) as Record<string, unknown> | undefined;
      if (prior) {
        if (prior.fingerprint !== start.fingerprint || prior.host_id !== start.hostId) throw new Error('START_CONFLICT');
        return this.startRow(prior);
      }
      if (this.statement('SELECT 1 FROM rt_start_queue WHERE host_id=?').get(start.hostId)) throw new Error('HOST_START_PENDING');
      if ((this.statement('SELECT COUNT(*) AS count FROM rt_start_queue').get() as { count: number }).count >= 128) throw new Error('SERVER_BUSY');
      this.statement('INSERT INTO rt_start_queue(start_id,host_id,fingerprint,request_json,created_at) VALUES (?,?,?,?,?)')
        .run(start.startId, start.hostId, start.fingerprint, start.requestJson, now);
      return this.startRow(this.statement('SELECT * FROM rt_start_queue WHERE start_id=?').get(start.startId) as Record<string, unknown>);
    }).immediate();
  }
  reserveStart(startId: string, fingerprint: string, leaseOwner: string, reservationId: string, now = Date.now()): StoredStart {
    return this.db.transaction(() => {
      const row = this.statement('SELECT * FROM rt_start_queue ORDER BY ordinal LIMIT 1').get() as Record<string, unknown> | undefined;
      if (!row || row.start_id !== startId) throw new Error('SERVER_BUSY');
      if (row.fingerprint !== fingerprint) throw new Error('START_CONFLICT');
      if (row.reserved_until !== null && Number(row.reserved_until) > now) {
        if (row.lease_owner !== leaseOwner) throw new Error('SERVER_BUSY');
        return this.startRow(row);
      }
      this.statement('UPDATE rt_start_queue SET reservation_id=?,reserved_until=?,lease_owner=? WHERE start_id=?')
        .run(reservationId, now + LIMITS.reservationMs, leaseOwner, startId);
      return this.startRow(this.statement('SELECT * FROM rt_start_queue WHERE start_id=?').get(startId) as Record<string, unknown>);
    }).immediate();
  }
  releaseStart(startId: string, leaseOwner: string, reservationId: string): void {
    this.statement('UPDATE rt_start_queue SET reservation_id=NULL,reserved_until=NULL,lease_owner=NULL WHERE start_id=? AND lease_owner=? AND reservation_id=?')
      .run(startId, leaseOwner, reservationId);
  }
  cancelStart(startId: string, hostId: string): void {
    this.statement('DELETE FROM rt_start_queue WHERE start_id=? AND host_id=? AND (reservation_id IS NULL OR reserved_until<=?)').run(startId, hostId, Date.now());
  }
  status() { return { journalMode: this.db.pragma('journal_mode', { simple: true }), synchronous: this.db.pragma('synchronous', { simple: true }), integrity: this.db.pragma('quick_check', { simple: true }) }; }
  list(): StoredMatch[] { return (this.statement("SELECT record_json FROM rt_matches WHERE expires_at>? OR phase NOT IN ('finished','abandoned')").all(Date.now()) as {record_json: string}[]).map(r => JSON.parse(r.record_json) as StoredMatch); }
  compatibilityManifests(): unknown[] {
    return (this.statement("SELECT DISTINCT json_extract(record_json,'$.manifest') AS manifest FROM rt_matches WHERE expires_at>? OR phase NOT IN ('finished','abandoned')")
      .all(Date.now()) as { manifest: string }[]).map(row => JSON.parse(row.manifest) as unknown);
  }
  get(matchId: string): StoredMatch | null {
    const row = this.statement('SELECT record_json,world_hash FROM rt_matches WHERE match_id=?').get(matchId) as {record_json: string; world_hash: string} | undefined;
    if (!row) return null;
    const match = JSON.parse(row.record_json) as StoredMatch;
    if (hash(match.world) !== row.world_hash || match.worldHash !== row.world_hash) throw new Error('RECOVERY_CHECKSUM');
    if (match.journalSeq > 0) {
      const journal = this.statement('SELECT tick,world_hash FROM rt_journal WHERE match_id=? AND seq=?').get(matchId, match.journalSeq) as {tick: number; world_hash: string} | undefined;
      if (!journal || journal.tick !== match.tick || journal.world_hash !== match.worldHash) throw new Error('RECOVERY_CHECKSUM');
    }
    return match;
  }
  byStart(startId: string): StoredMatch | null {
    const row = this.statement('SELECT match_id FROM rt_matches WHERE start_id=?').get(startId) as {match_id: string} | undefined;
    return row ? this.get(row.match_id) : null;
  }
  create(match: StoredMatch, leaseOwner: string, reservationId?: string): StoredMatch {
    return this.db.transaction(() => {
      const old = this.byStart(match.startId);
      if (old) {
        if (old.fingerprint !== match.fingerprint) throw new Error('START_CONFLICT');
        this.statement('DELETE FROM rt_start_queue WHERE start_id=? AND fingerprint=?').run(match.startId, match.fingerprint);
        return old;
      }
      if (reservationId !== undefined) {
        const reservation = this.statement('SELECT * FROM rt_start_queue WHERE start_id=?').get(match.startId) as Record<string, unknown> | undefined;
        if (!reservation || reservation.fingerprint !== match.fingerprint || reservation.lease_owner !== leaseOwner ||
          reservation.reservation_id !== reservationId || Number(reservation.reserved_until) <= Date.now()) throw new Error('RESERVATION_EXPIRED');
      }
      this.statement('INSERT INTO rt_matches VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(match.matchId, match.startId, match.fingerprint,
        JSON.stringify(match), match.worldHash, match.ownerEpoch, leaseOwner, Date.now() + 15_000, match.journalSeq, match.expiresAt, match.phase);
      this.statement('INSERT INTO rt_checkpoints VALUES (?,?,?,?)').run(match.matchId, match.journalSeq, JSON.stringify(match), match.worldHash);
      if (reservationId !== undefined) this.statement('DELETE FROM rt_start_queue WHERE start_id=? AND reservation_id=?').run(match.startId, reservationId);
      return match;
    }).immediate();
  }
  acquire(matchId: string, leaseOwner: string, now = Date.now()): StoredMatch {
    return this.db.transaction(() => {
      const row = this.statement('SELECT lease_owner,lease_until FROM rt_matches WHERE match_id=?').get(matchId) as {lease_owner: string; lease_until: number} | undefined;
      if (!row) throw new Error('MATCH_UNAVAILABLE');
      if (row.lease_owner !== leaseOwner && row.lease_until > now) throw new Error('MATCH_OWNED');
      const match = this.get(matchId)!;
      match.ownerEpoch++; match.epoch++; match.countdownUntil = now + 3000;
      for (const control of Object.values(match.controls)) { control.connectionId = null; control.generation++; control.lastActivity = 0; control.lastInputAt = 0; }
      if (!['finished', 'abandoned'].includes(match.phase)) { match.phase = 'paused'; match.pausedAt ??= now; match.pauseReason = 'RECOVERY'; }
      this.statement('UPDATE rt_matches SET record_json=?,owner_epoch=?,lease_owner=?,lease_until=?,phase=? WHERE match_id=?').run(
        JSON.stringify(match), match.ownerEpoch, leaseOwner, now + 15_000, match.phase, matchId);
      return match;
    }).immediate();
  }
  private writeCommit(value: Commit): void {
      const started = performance.now();
      const { match } = value;
      if (hash(match.world) !== match.worldHash) throw new Error('STATE_CHECKSUM');
      const record = JSON.stringify(match), journal = JSON.stringify(value.journal);
      this.writerSamples.maxWorldBytes = Math.max(this.writerSamples.maxWorldBytes, Buffer.byteLength(match.world));
      this.writerSamples.maxRecordBytes = Math.max(this.writerSamples.maxRecordBytes, Buffer.byteLength(record));
      this.writerSamples.maxJournalBytes = Math.max(this.writerSamples.maxJournalBytes, Buffer.byteLength(journal));
      const changed = this.statement('UPDATE rt_matches SET record_json=?,world_hash=?,journal_seq=?,lease_until=?,expires_at=?,phase=? WHERE match_id=? AND owner_epoch=? AND lease_owner=?')
        .run(record, match.worldHash, match.journalSeq, Date.now() + 15_000, match.expiresAt, match.phase, match.matchId, match.ownerEpoch, value.leaseOwner);
      if (changed.changes !== 1) throw new Error('LEASE_LOST');
      this.statement('INSERT INTO rt_journal VALUES (?,?,?,?,?)').run(match.matchId, match.journalSeq, match.tick, journal, match.worldHash);
      for (const receipt of value.receipts) this.statement('INSERT INTO rt_actions VALUES (?,?,?,?,?)').run(receipt.matchId, receipt.actionId, receipt.participantId, receipt.payloadHash, JSON.stringify(receipt));
      if (match.tick % 60 === 0 || match.phase !== 'running') {
        this.statement('INSERT OR REPLACE INTO rt_checkpoints VALUES (?,?,?,?)').run(match.matchId, match.journalSeq, record, match.worldHash);
        this.statement('DELETE FROM rt_checkpoints WHERE match_id=? AND seq NOT IN (SELECT seq FROM rt_checkpoints WHERE match_id=? ORDER BY seq DESC LIMIT 2)').run(match.matchId, match.matchId);
      }
      if (value.result) this.statement('INSERT OR IGNORE INTO rt_outbox VALUES (?,?,?,NULL)').run(value.result.resultId, match.matchId, JSON.stringify(value.result.outcome));
      this.batchBodyMs += performance.now() - started;
  }
  commit(value: Commit): void {
    this.db.transaction(() => this.writeCommit(value)).immediate();
  }
  /** One durable barrier for a group; a fenced/corrupt room cannot poison peers. */
  commitBatch(values: Commit[]): { error?: string }[] {
    const started = performance.now(); this.batchBodyMs = 0;
    const results = this.db.transaction(() => values.map(value => {
      try {
        // A nested transaction is a savepoint. Logical per-room failures roll
        // back that complete transition; an I/O failure aborts the whole group.
        this.db.transaction(() => this.writeCommit(value))(); return {};
      } catch (error) {
        const message = error instanceof Error ? error.message : 'STORE_FAILED';
        const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
        if (['LEASE_LOST', 'STATE_CHECKSUM'].includes(message) || code.startsWith('SQLITE_CONSTRAINT')) return { error: message };
        throw error;
      }
    })).immediate();
    const elapsed = performance.now() - started;
    this.writerSamples.batches++; this.writerSamples.maxTransactionMs = Math.max(this.writerSamples.maxTransactionMs, elapsed);
    this.transactionTiming.record(elapsed); this.bodyTiming.record(this.batchBodyMs); this.finalizeTiming.record(Math.max(0, elapsed - this.batchBodyMs));
    return results;
  }
  writerMetrics() { return { ...this.writerSamples, transactionP99Ms: this.transactionTiming.p99(), bodyP99Ms: this.bodyTiming.p99(),
    finalizeP99Ms: this.finalizeTiming.p99(), walAutoCheckpoint: this.db.pragma('wal_autocheckpoint', { simple: true }),
    synchronous: this.db.pragma('synchronous', { simple: true }) }; }
  receipt(matchId: string, actionId: string): Receipt | null {
    const row = this.statement('SELECT record_json FROM rt_actions WHERE match_id=? AND action_id=?').get(matchId, actionId) as {record_json: string} | undefined;
    return row ? JSON.parse(row.record_json) as Receipt : null;
  }
  consumeTicket(ticketId: string, expiresAt: number): void {
    this.db.transaction(() => {
      this.statement('DELETE FROM rt_tickets WHERE expires_at<?').run(Date.now() - 10_000);
      this.statement('INSERT INTO rt_tickets VALUES (?,?)').run(ticketId, expiresAt);
    }).immediate();
  }
  consumeBridge(requestId: string): void {
    this.db.transaction(() => {
      this.statement('DELETE FROM rt_bridge_requests WHERE expires_at<?').run(Date.now());
      this.statement('INSERT INTO rt_bridge_requests VALUES (?,?)').run(requestId, Date.now() + 60_000);
    }).immediate();
  }
  admission(admissionId: string, playerId: string, expiresAt: number): void {
    this.statement('INSERT INTO rt_admissions VALUES (?,?,?,0) ON CONFLICT(admission_id) DO UPDATE SET expires_at=excluded.expires_at WHERE revoked=0').run(admissionId, playerId, expiresAt);
  }
  checkAdmission(admissionId: string, playerId: string): boolean {
    return !!this.statement('SELECT 1 FROM rt_admissions WHERE admission_id=? AND player_id=? AND revoked=0 AND expires_at>?').get(admissionId, playerId, Date.now());
  }
  revoke(admissionId: string): void { this.statement('UPDATE rt_admissions SET revoked=1 WHERE admission_id=?').run(admissionId); }
  release(leaseOwner: string): void { this.statement('UPDATE rt_matches SET lease_until=0 WHERE lease_owner=?').run(leaseOwner); }
  outbox() { return this.statement('SELECT result_id,match_id,payload_json FROM rt_outbox WHERE delivered_at IS NULL').all(); }
  delivered(resultId: string, matchId: string) { this.statement('UPDATE rt_outbox SET delivered_at=COALESCE(delivered_at,?) WHERE result_id=? AND match_id=?').run(Date.now(), resultId, matchId); }
  close(): void { this.db.pragma('wal_checkpoint(TRUNCATE)'); this.db.close(); }
}
