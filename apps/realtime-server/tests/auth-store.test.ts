import { generateKeyPairSync, createPublicKey } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { TicketClaims } from '@iva-games/realtime-kit';
import { bridgeSignature, hash, newTicketId, signTicket, verifyBridge, verifyTicket } from '../src/crypto';
import { RealtimeStore } from '../src/store';
import type { StoredMatch } from '../src/store';
import { bridgeSignature as platformBridgeSignature, signTicket as platformSignTicket } from '../../platform/src/realtime-crypto';
const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });
function database() {
  const dir = mkdtempSync(join(tmpdir(), 'forpost-store-')); temporary.push(dir);
  return { path: join(dir, 'realtime.sqlite'), dir };
}
function fixture(): StoredMatch {
  const world = JSON.stringify({ test: 'durability-only', tick: 0 });
  return { matchId: 'match-1', startId: 'start-1', fingerprint: 'same-request', roomId: 'room-1', kind: 'practice', ownerHash: 'owner',
    roster: [{ participantId: 'seat-1', playerId: 'practice-1', displayName: 'Test', team: 'A', controller: 'human' }],
    rosterHash: 'roster', rulesVersion: 'forpost-0.1', contentVersion: 'forpost-content-1', manifest: { runtime: 'test' }, world, worldHash: hash(world),
    tick: 0, epoch: 1, ownerEpoch: 1, journalSeq: 0, controls: {}, phase: 'paused', lastHumanAt: 0, pausedAt: 0,
    expiresAt: Date.now() + 100_000, pendingOutcome: null, outcome: null, countdownUntil: 0, createdAt: Date.now() };
}
describe('Ed25519 admission', () => {
  it('binds signature, origin, lifetime and one fixed algorithm', () => {
    const privateKey = generateKeyPairSync('ed25519').privateKey, now = Date.now();
    const claims: TicketClaims = { issuer: 'iva-platform', audience: 'iva-realtime', keyId: 'platform-v1', ticketId: newTicketId(),
      playerId: 'user-1', participantId: 'seat-1', matchId: 'match-1', roomId: 'room-1', rosterHash: 'hash', gameId: 'forpost',
      protocolVersion: 1, rulesVersion: 'forpost-0.1', contentVersion: 'forpost-content-1', allowedOrigin: 'https://iva-games.pro',
      permission: 'control', issuedAt: now, expiresAt: now + 30_000, admissionId: 'admission-1' };
    const token = signTicket(claims, privateKey), keys = { 'platform-v1': createPublicKey(privateKey) };
    expect(platformSignTicket(claims, privateKey)).toBe(token);
    expect(verifyTicket(platformSignTicket(claims, privateKey), keys, claims.allowedOrigin, now)).toEqual(claims);
    expect(verifyTicket(token, keys, claims.allowedOrigin, now)).toEqual(claims);
    expect(() => verifyTicket(token, keys, 'https://other.invalid', now)).toThrow();
    expect(() => verifyTicket(token, keys, claims.allowedOrigin, now + 35_001)).toThrow();
    expect(() => verifyTicket(token.slice(0, -2) + 'xx', keys, claims.allowedOrigin, now)).toThrow();
    expect(() => verifyTicket(signTicket({ ...claims, expiresAt: now + 60_000 }, privateKey), keys, claims.allowedOrigin, now)).toThrow();
  });
  it('signs the method, exact bridge path, request identity and body', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519'), id = newTicketId(), timestamp = String(Date.now());
    const signature = bridgeSignature('POST', '/internal/realtime/v1/matches', '{}', id, timestamp, privateKey);
    expect(platformBridgeSignature('POST', '/internal/realtime/v1/matches', '{}', id, timestamp, privateKey)).toBe(signature);
    expect(verifyBridge('POST', '/internal/realtime/v1/matches', '{}', id, timestamp, signature, publicKey)).toBe(true);
    expect(verifyBridge('POST', '/internal/realtime/v1/matches', '{"winner":"A"}', id, timestamp, signature, publicKey)).toBe(false);
    expect(verifyBridge('GET', '/internal/realtime/v1/matches', '{}', id, timestamp, signature, publicKey)).toBe(false);
  });
});
describe('durable acceptance and fenced ownership', () => {
  it('consumes one ticket across independent SQLite connections', () => {
    const { path } = database(), first = new RealtimeStore(path), second = new RealtimeStore(path);
    try { first.consumeTicket('ticket', Date.now() + 30_000); expect(() => second.consumeTicket('ticket', Date.now() + 30_000)).toThrow(); }
    finally { second.close(); first.close(); }
  });
  it('reuses a start ID only for its original immutable request', () => {
    const { path } = database(), store = new RealtimeStore(path);
    try {
      store.create(fixture(), 'owner-1'); expect(store.create(fixture(), 'owner-1').matchId).toBe('match-1');
      expect(() => store.create({ ...fixture(), fingerprint: 'different-roster' }, 'owner-1')).toThrow('START_CONFLICT');
    } finally { store.close(); }
  });
  it('commits the state, receipt and final outbox atomically and preserves them after restart', () => {
    const { path } = database(); let store = new RealtimeStore(path);
    const match = fixture(); store.create(match, 'owner-1'); match.journalSeq = 1;
    const receipt = { matchId: match.matchId, participantId: 'seat-1', actionId: 'buy-once', payloadHash: 'cost', result: { ok: true }, epoch: 1, seq: 1 };
    store.commit({ match, leaseOwner: 'owner-1', journal: { action: 'buy' }, receipts: [receipt], result: { resultId: 'result-1', outcome: { winner: 'A' } } });
    store.close(); store = new RealtimeStore(path);
    try {
      expect(store.receipt('match-1', 'buy-once')).toEqual(receipt); expect(store.get('match-1')?.journalSeq).toBe(1); expect(store.outbox()).toHaveLength(1);
      store.delivered('result-1', 'wrong-match'); expect(store.outbox()).toHaveLength(1);
      store.delivered('result-1', 'match-1'); store.delivered('result-1', 'match-1'); expect(store.outbox()).toHaveLength(0);
      match.journalSeq = 2;
      expect(() => store.commit({ match, leaseOwner: 'owner-1', journal: {}, receipts: [receipt] })).toThrow();
      expect(store.get('match-1')?.journalSeq).toBe(1);
    } finally { store.close(); }
  });
  it('rejects the stale writer after lease transfer and increments the reconnect epoch', () => {
    const { path } = database(), first = new RealtimeStore(path), second = new RealtimeStore(path);
    try {
      const original = fixture(); first.create(original, 'owner-1');
      expect(() => second.acquire('match-1', 'owner-2')).toThrow('MATCH_OWNED');
      first.release('owner-1'); const recovered = second.acquire('match-1', 'owner-2');
      expect(recovered.epoch).toBe(2); expect(recovered.ownerEpoch).toBe(2);
      original.journalSeq++;
      expect(() => first.commit({ match: original, leaseOwner: 'owner-1', journal: {}, receipts: [] })).toThrow('LEASE_LOST');
    } finally { second.close(); first.close(); }
  });
  it('rejects corrupted durable state and revoked admissions', () => {
    const { path } = database(), store = new RealtimeStore(path);
    try {
      store.create(fixture(), 'owner'); store.db.prepare('UPDATE rt_matches SET world_hash=?').run('bad');
      expect(() => store.get('match-1')).toThrow('RECOVERY_CHECKSUM');
      store.admission('admission', 'user', Date.now() + 60_000); expect(store.checkAdmission('admission', 'user')).toBe(true);
      store.revoke('admission'); store.admission('admission', 'user', Date.now() + 60_000); expect(store.checkAdmission('admission', 'user')).toBe(false);
    } finally { store.close(); }
  });
});
