import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RealtimeStore } from '../src/store';
import type { Commit, StoredMatch } from '../src/store';
import { hash } from '../src/crypto';
import { StoreQueue } from '../src/store-queue';

const stores: RealtimeStore[] = [], directories: string[] = [];
function store(path?: string) {
  if (!path) { const directory = mkdtempSync(join(tmpdir(), 'forpost-admission-')); directories.push(directory); path = join(directory, 'qa.sqlite'); }
  const value = new RealtimeStore(path); stores.push(value); return value;
}
afterEach(() => { vi.useRealTimers(); for (const value of stores.splice(0)) if (value.db.open) value.close(); for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function match(id: string): StoredMatch {
  const world = JSON.stringify({ kind: 'storage-fixture', tick: 0 });
  return { matchId: id, startId: 'start-' + id, fingerprint: 'fingerprint-' + id, roomId: 'room-' + id, kind: 'account', ownerHash: null,
    roster: [], rosterHash: 'fixture', rulesVersion: 'fixture', contentVersion: 'fixture', manifest: {}, world, worldHash: hash(world),
    tick: 0, epoch: 1, ownerEpoch: 1, journalSeq: 0, controls: {}, phase: 'ready', lastHumanAt: 0, pausedAt: null,
    expiresAt: Date.now() + 100_000, pendingOutcome: null, outcome: null, countdownUntil: 0, createdAt: Date.now() };
}
const start = (id: string, host = id) => ({ startId: 'start-' + id, hostId: 'host-' + host, fingerprint: 'fingerprint-' + id, requestJson: JSON.stringify({ fixture: id }) });

describe('durable FIFO start admission', () => {
  it('preserves order across restart, reuses the immutable start and allows one waiting start per actual host', () => {
    const first = store(), original = first.enqueueStart(start('a'))!;
    first.enqueueStart(start('b')); expect(first.enqueueStart(start('a'))).toEqual(original);
    expect(() => first.enqueueStart({ ...start('a'), fingerprint: 'changed-roster' })).toThrow('START_CONFLICT');
    expect(() => first.enqueueStart(start('second-room', 'a'))).toThrow('HOST_START_PENDING');
    const path = first.db.name; first.close(); const restarted = store(path);
    expect(restarted.starts().map(item => item.startId)).toEqual(['start-a', 'start-b']);
    expect(() => restarted.reserveStart('start-b', 'fingerprint-b', 'worker', 'skip-head')).toThrow('SERVER_BUSY');
  });

  it('keeps the same 15-second reservation on retries and fences an expired token before any match is written', () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(100_000);
    const value = store(); value.enqueueStart(start('a')); value.enqueueStart(start('b'));
    const reservation = value.reserveStart('start-a', 'fingerprint-a', 'worker-1', 'reservation-1');
    expect(reservation.reservedUntil).toBe(115_000);
    vi.setSystemTime(110_000);
    expect(value.reserveStart('start-a', 'fingerprint-a', 'worker-1', 'unused-new-token')).toEqual(reservation);
    expect(() => value.reserveStart('start-a', 'fingerprint-a', 'worker-2', 'other-owner')).toThrow('SERVER_BUSY');
    vi.setSystemTime(115_000);
    expect(() => value.create(match('a'), 'worker-1', 'reservation-1')).toThrow('RESERVATION_EXPIRED');
    expect(value.byStart('start-a')).toBeNull();
    const replacement = value.reserveStart('start-a', 'fingerprint-a', 'worker-2', 'reservation-2');
    expect(replacement.reservedUntil).toBe(130_000); expect(replacement.ordinal).toBe(reservation.ordinal);
    expect(() => value.create(match('a'), 'worker-1', 'reservation-1')).toThrow('RESERVATION_EXPIRED');
    const accepted = value.create(match('a'), 'worker-2', 'reservation-2');
    expect(value.create(match('a'), 'worker-2', 'reservation-2')).toEqual(accepted);
    expect(value.enqueueStart(start('a'))).toBeNull();
    expect(value.starts().map(item => item.startId)).toEqual(['start-b']);
    expect(value.db.prepare('SELECT COUNT(*) AS n FROM rt_matches').get()).toEqual({ n: 1 });
    expect(value.enqueueStart(start('later-room', 'a'))).not.toBeNull();
  });

  it('cannot release or cancel another process reservation before its deadline', () => {
    const value = store(); value.enqueueStart(start('a'));
    value.reserveStart('start-a', 'fingerprint-a', 'worker', 'reservation');
    value.releaseStart('start-a', 'other-worker', 'reservation'); value.cancelStart('start-a', 'host-a');
    expect(value.starts()[0].reservationId).toBe('reservation');
    value.releaseStart('start-a', 'worker', 'reservation');
    value.cancelStart('start-a', 'other-host'); expect(value.starts()).toHaveLength(1);
    value.cancelStart('start-a', 'host-a'); expect(value.starts()).toEqual([]);
  });
});

describe('grouped durable writer', () => {
  function transition(record: StoredMatch, owner = 'worker'): Commit {
    return { match: { ...record, journalSeq: 1, tick: 1, phase: 'finished', outcome: { winner: 'A' } }, leaseOwner: owner,
      journal: { type: 'fixture-result' }, receipts: [{ matchId: record.matchId, participantId: 'fixture-player', actionId: 'fixture-action',
        payloadHash: 'fixture-payload', result: { ok: true }, epoch: 1, seq: 1 }], result: { resultId: 'result-' + record.matchId, outcome: { winner: 'A' } } };
  }
  it('uses one atomic group while isolating a stale fenced room from healthy rooms', () => {
    const value = store(), a = match('a'), b = match('b'), c = match('c');
    for (const record of [a, b, c]) value.create(record, 'worker');
    expect(value.commitBatch([transition(a), transition(b, 'stale-worker'), transition(c)])).toEqual([{}, { error: 'LEASE_LOST' }, {}]);
    expect(value.get('a')?.journalSeq).toBe(1); expect(value.get('b')?.journalSeq).toBe(0); expect(value.get('c')?.journalSeq).toBe(1);
    expect(value.outbox()).toHaveLength(2); expect(value.receipt('b', 'fixture-action')).toBeNull();
  });

  it('rolls back every room and receipt on a non-logical database failure in the group', () => {
    const value = store(), a = match('a'), b = match('b'); value.create(a, 'worker'); value.create(b, 'worker');
    // Deliberate database fault injection, not a claim to have disconnected a disk.
    value.db.function('qa_failure', () => { throw new Error('INJECTED_DATABASE_FAILURE'); });
    value.db.exec("CREATE TRIGGER qa_fail BEFORE INSERT ON rt_journal WHEN NEW.match_id='b' BEGIN SELECT qa_failure(); END");
    expect(() => value.commitBatch([transition(a), transition(b)])).toThrow('INJECTED_DATABASE_FAILURE');
    expect(value.get('a')?.journalSeq).toBe(0); expect(value.get('b')?.journalSeq).toBe(0);
    expect(value.outbox()).toEqual([]); expect(value.receipt('a', 'fixture-action')).toBeNull();
  });

  it('batches consecutive commits, flushes before reads, and never sends a positive reply before the durable barrier', async () => {
    vi.useFakeTimers(); const value = store(), a = match('a'), b = match('b'); value.create(a, 'worker'); value.create(b, 'worker');
    const replies: { id: number; value?: unknown; error?: string }[] = [], sizes: number[] = [];
    const queue = new StoreQueue(request => value.get(request.args[0] as string), entries => {
      expect(replies).toEqual([]); sizes.push(entries.length); return value.commitBatch(entries);
    }, reply => replies.push(reply));
    queue.enqueue({ id: 1, op: 'commit', args: [transition(a)] }); queue.enqueue({ id: 2, op: 'commit', args: [transition(b)] });
    queue.enqueue({ id: 3, op: 'get', args: ['a'] });
    expect(replies).toEqual([]); expect(value.get('a')?.journalSeq).toBe(0);
    await vi.advanceTimersByTimeAsync(2);
    expect(sizes).toEqual([2]); expect(replies.map(reply => reply.id)).toEqual([1, 2, 3]);
    expect(replies[2].value).toMatchObject({ journalSeq: 1, phase: 'finished' });
  });
  it('keeps later requests behind an asynchronous lifecycle barrier', async () => {
    vi.useFakeTimers(); let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const order: string[] = [];
    const queue = new StoreQueue(() => barrier, () => { order.push('commit'); return [{}]; }, reply => order.push('reply-' + reply.id));
    queue.enqueue({ id: 1, op: 'close-checkpointer', args: [] });
    queue.enqueue({ id: 2, op: 'commit', args: [{}] });
    await vi.advanceTimersByTimeAsync(2); expect(order).toEqual([]);
    release(); await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(['reply-1', 'commit', 'reply-2']);
  });
});
