import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REALTIME_PROTOCOL } from '@iva-games/realtime-kit';
import type { ClientMessage, Snapshot, WireScope } from '@iva-games/realtime-kit';
import { RealtimeEngine } from '../src/engine.js';
import { LocalStorageClient, RealtimeStore } from '../src/storage.js';
import { adapter, claims, fixture, request } from './fixture.js';

const folders: string[] = [];
afterEach(() => { for (const path of folders.splice(0)) rmSync(path, { recursive: true, force: true }); });
const scope = (snapshot: Snapshot): WireScope => ({ protocolVersion: REALTIME_PROTOCOL, matchId: snapshot.matchId, epoch: snapshot.epoch, controllerGeneration: snapshot.controllerGeneration });
const command = (snapshot: Snapshot, type: string, actionId: string): Extract<ClientMessage, { type: 'action' }> => ({ ...scope(snapshot), type: 'action', actionId, payload: { type } });

describe('authoritative control and durable recovery', () => {
  it('counts silent open-socket absence from the last signal: bot at five seconds, empty pause at ten', async () => {
    const f = await fixture();
    try {
      await f.engine.connect(claims(f.matchId, f.clock.wall), 'silent'); await f.tick(3000);
      const current = f.engine.snapshot('silent');
      f.engine.heartbeat('silent', { ...scope(current), type: 'heartbeat', nonce: 'last-live-signal' });
      await f.tick(4999);
      expect(f.engine.snapshot('silent').hasControl).toBe(true);
      await f.tick(1);
      expect(() => f.engine.snapshot('silent')).toThrow('AUTH_EXPIRED');
      expect(f.store.get(f.matchId).meta.controllers.find(control => control.participantId === 'p1')?.kind).toBe('bot');
      await f.tick(4999); expect(f.engine.status(f.matchId).phase).toBe('running');
      await f.tick(1); expect(f.engine.status(f.matchId).phase).toBe('paused');
      const pausedTick = f.store.get(f.matchId).meta.worldTick; await f.tick(1000);
      expect(f.store.get(f.matchId).meta.worldTick).toBe(pausedTick);
    } finally { await f.engine.drain(); f.store.close(); }
  });
  it('holds a terminal state reached without a human until return, then commits one outcome and outbox', async () => {
    const f = await fixture();
    try {
      await f.engine.connect(claims(f.matchId, f.clock.wall), 'first'); await f.tick(3000);
      const current = f.engine.snapshot('first');
      await f.engine.action('first', command(current, 'finish', 'finish-before-signal-loss'));
      await f.engine.disconnect('first'); await f.tick(50);
      expect(f.engine.status(f.matchId)).toMatchObject({ finished: false, phase: 'paused' });
      expect(f.store.get(f.matchId).meta.pendingOutcome).toEqual({ won: true });
      expect(f.store.db.prepare('SELECT count(*) AS n FROM rt_outbox').get()).toEqual({ n: 0 });
      const returned = await f.engine.connect(claims(f.matchId, f.clock.wall), 'returned');
      expect(returned.phase).toBe('recovering'); await f.tick(2999);
      expect(f.engine.status(f.matchId).finished).toBe(false); await f.tick(1);
      const result = f.engine.status(f.matchId); expect(result).toMatchObject({ finished: true, outcome: { game: { won: true } } });
      await f.tick(1000); expect(f.engine.status(f.matchId).outcome).toEqual(result.outcome);
      expect(f.store.db.prepare('SELECT count(*) AS n FROM rt_outbox').get()).toEqual({ n: 1 });
    } finally { await f.engine.drain(); f.store.close(); }
  });
  it('automatically recovers a committed overload pause with the same connected controller and no catch-up motion', async () => {
    const f = await fixture();
    try {
      await f.engine.connect(claims(f.matchId, f.clock.wall), 'first'); await f.tick(3000);
      const before = f.engine.snapshot('first');
      const advance = async (ms: number) => {
        for (let time = 0; time < ms; time += 25) {
          f.engine.heartbeat('first', { ...scope(f.engine.snapshot('first')), type: 'heartbeat', nonce: 'keep-overload' });
          await f.tick(Math.min(25, ms - time));
        }
      };
      f.engine.input('first', { ...scope(before), type: 'input', inputSeq: 1, payload: { move: 1 } });
      f.clock.wall += 750; f.clock.mono += 750; await f.engine.tick();
      let snapshot = f.engine.snapshot('first');
      expect(snapshot).toMatchObject({ phase: 'paused', pauseReason: 'overload', hasControl: true, resumeAt: null, worldTick: before.worldTick });
      expect(f.store.recovery(f.matchId).snapshot.seq).toBe(snapshot.committedJournalSeq);
      const observation = JSON.parse((f.store.db.prepare("SELECT payload FROM rt_journal WHERE match_id=? AND kind='overload-pause'").get(f.matchId) as { payload: string }).payload);
      expect(observation).toMatchObject({ kind: 'pause', observedAt: f.clock.wall, worldTick: before.worldTick,
        schedulerGapMs: 750, accumulatedLagMs: 750, stepIntervalMs: 1000 / 60, maxCatchUpSteps: 4,
        lastStepMs: 0, lastBatchStepMs: 0, lastSerializeMs: 0, lastCommitMs: 0 });
      expect(f.engine.health()).not.toHaveProperty('diagnostics');
      expect(f.engine.health(true)).toMatchObject({ metrics: { overloadPauses: 1, overloadRecurrences: 0 },
        diagnostics: { games: [{ gameId: 'fixture', lastOverload: observation }] } });
      await advance(1100);
      snapshot = f.engine.snapshot('first'); expect(snapshot.phase).toBe('recovering'); expect(snapshot.resumeAt).not.toBeNull();
      await advance(500);
      f.clock.wall += 200; f.clock.mono += 200; await f.engine.tick();
      expect(f.engine.snapshot('first')).toMatchObject({ phase: 'paused', pauseReason: 'overload', resumeAt: null });
      expect(f.engine.health(true)).toMatchObject({ metrics: { overloadPauses: 1, overloadRecurrences: 1 },
        diagnostics: { games: [{ gameId: 'fixture', lastOverload: { kind: 'recurred', schedulerGapMs: 200, accumulatedLagMs: 0 } }] } });
      const recurrence = JSON.parse((f.store.db.prepare("SELECT payload FROM rt_journal WHERE match_id=? AND kind='overload-recurred'").get(f.matchId) as { payload: string }).payload);
      expect(recurrence).toMatchObject({ kind: 'recurred', schedulerGapMs: 200, accumulatedLagMs: 0 });
      expect(JSON.stringify(recurrence)).not.toContain('player1'); expect(JSON.stringify(recurrence)).not.toContain('inputs');
      await advance(1100); await advance(3100);
      snapshot = f.engine.snapshot('first');
      expect(snapshot).toMatchObject({ phase: 'running', pauseReason: null, hasControl: true, returnUntil: null, epoch: before.epoch, controllerGeneration: before.controllerGeneration });
      expect(snapshot.worldTick).toBeGreaterThan(before.worldTick);
      expect((snapshot.view as { x: number }).x).toBe(0);
      f.engine.input('first', { ...scope(snapshot), type: 'input', inputSeq: 2, payload: { move: 1 } }); await advance(100);
      expect((f.engine.snapshot('first').view as { x: number }).x).toBeGreaterThan(0);
    } finally { f.store.close(); }
  });
  it.each(['snapshot', 'replay'])('isolates a corrupt %s to one match and preserves its original recovery evidence', async fault => {
    const directory = mkdtempSync(join(tmpdir(), 'iva-corrupt-')); folders.push(directory);
    const path = join(directory, 'world.sqlite'), f = await fixture(path);
    const healthy = await f.engine.create(adapter.gameId, { ...request(), startCommandId: 'healthy-start', roomId: 'healthy-room' });
    await f.engine.connect(claims(f.matchId, f.clock.wall), 'damaged'); await f.tick(3000);
    const current = f.engine.snapshot('damaged');
    f.engine.input('damaged', { ...scope(current), type: 'input', inputSeq: 1, payload: { move: 1 } }); await f.tick(100);
    if (fault === 'snapshot') f.store.db.prepare('UPDATE rt_snapshots SET world=? WHERE match_id=? AND seq=(SELECT MAX(seq) FROM rt_snapshots WHERE match_id=?)').run('{damaged', f.matchId, f.matchId);
    else f.store.db.prepare('UPDATE rt_journal SET post_hash=? WHERE match_id=? AND seq=(SELECT MAX(seq) FROM rt_journal WHERE match_id=?)').run('f'.repeat(64), f.matchId, f.matchId);
    const snapshots = f.store.db.prepare('SELECT * FROM rt_snapshots WHERE match_id=? ORDER BY seq').all(f.matchId);
    const journal = f.store.db.prepare('SELECT * FROM rt_journal WHERE match_id=? ORDER BY seq').all(f.matchId);
    f.store.close(); f.clock.wall += 15_001; f.clock.mono += 15_001;
    const store = new RealtimeStore(path), recovered = new RealtimeEngine({ storage: new LocalStorageClient(store), adapters: [adapter],
      ownerId: 'healthy-recovery', wallNow: () => f.clock.wall, monoNow: () => f.clock.mono });
    try {
      await recovered.initialize();
      expect(recovered.health()).toMatchObject({ ok: true, unavailableMatches: 1 });
      expect(recovered.status(f.matchId)).toMatchObject({ phase: 'failed-recoverable', recoverableError: fault === 'snapshot' ? 'CORRUPT_SNAPSHOT' : 'REPLAY_DIVERGED' });
      const returned = await recovered.connect({ ...claims(healthy.matchId, f.clock.wall), roomId: 'healthy-room' }, 'healthy');
      expect((returned.view as { stock: number }).stock).toBe(5);
      await recovered.create(adapter.gameId, { ...request(), startCommandId: 'new-healthy-start', roomId: 'new-healthy-room' });
      expect(store.db.prepare('SELECT * FROM rt_snapshots WHERE match_id=? ORDER BY seq').all(f.matchId)).toEqual(snapshots);
      expect(store.db.prepare('SELECT * FROM rt_journal WHERE match_id=? ORDER BY seq').all(f.matchId)).toEqual(journal);
    } finally { await recovered.drain(); store.close(); }
  });
  it('drains exactly once and can resume the saved worlds after a cancelled release', async () => {
    const f = await fixture();
    try {
      await f.engine.connect(claims(f.matchId, f.clock.wall), 'first'); await f.tick(3000);
      const before = f.engine.snapshot('first');
      const spent = await f.engine.action('first', command(before, 'spend', 'before-drain'));
      await f.engine.drain();
      const saved = f.store.get(f.matchId);
      expect(saved.meta.phase).toBe('paused');
      expect(f.store.recovery(f.matchId).snapshot.seq).toBe(saved.meta.journalSeq);
      await f.engine.drain();
      expect(f.store.get(f.matchId).meta.journalSeq).toBe(saved.meta.journalSeq);
      await expect(f.engine.connect(claims(f.matchId, f.clock.wall), 'during-drain')).rejects.toThrow('SERVER_UPDATING');
      await f.engine.cancelDrain();
      const returned = await f.engine.connect(claims(f.matchId, f.clock.wall), 'returned');
      expect(returned.hasControl).toBe(true);
      expect((returned.view as { stock: number }).stock).toBe(4);
      expect(await f.engine.action('returned', command(returned, 'spend', 'before-drain'))).toEqual(spent);
      await f.tick(3000);
      expect(f.engine.snapshot('returned').phase).toBe('running');
      await f.engine.drain(); await f.engine.drain();
      expect(f.engine.health()).toMatchObject({ draining: true, failedMatches: 0 });
    } finally { f.store.close(); }
  });
  it('starts once, gives one controller per participant and preserves observer permissions', async () => {
    const f = await fixture();
    try {
      expect(await f.engine.create(adapter.gameId, request())).toEqual({ matchId: f.matchId });
      await expect(f.engine.create(adapter.gameId, { ...request(), settings: { changed: true } })).rejects.toThrow('START_ID_REUSED');
      const first = await f.engine.connect(claims(f.matchId, f.clock.wall), 'first');
      const observer = await f.engine.connect(claims(f.matchId, f.clock.wall), 'second');
      expect(first.hasControl).toBe(true); expect(observer.hasControl).toBe(false);
      await expect(f.engine.action('second', command(observer, 'spend', 'spend-observer'))).rejects.toThrow('CONTROL_REQUIRED');
      const changed = await f.engine.claim('second', { ...scope(observer), type: 'claimControl', expectedGeneration: observer.controllerGeneration });
      expect(changed.hasControl).toBe(true); expect(changed.controllerGeneration).toBe(first.controllerGeneration + 1);
      expect(() => f.engine.input('first', { ...scope(first), type: 'input', inputSeq: 1, payload: { move: 1 } })).toThrow('STALE_CONTROLLER');
      await f.engine.disconnect('first');
      expect(f.engine.snapshot('second').hasControl).toBe(true);
    } finally { f.store.close(); }
  });
  it('neutralizes stale input and takes over after five seconds without mutating seat identity', async () => {
    const f = await fixture();
    try {
      await f.engine.connect(claims(f.matchId, f.clock.wall), 'first');
      await f.engine.connect(claims(f.matchId, f.clock.wall, 2), 'other');
      await f.tick(3000);
      const snapshot = f.engine.snapshot('first');
      f.engine.input('first', { ...scope(snapshot), type: 'input', inputSeq: 1, payload: { move: 1 } });
      await f.tick(200); const moving = (f.engine.snapshot('first').view as { x: number }).x;
      await f.tick(1000); const stopped = (f.engine.snapshot('first').view as { x: number }).x;
      expect(moving).toBeGreaterThan(0); expect(stopped).toBeLessThanOrEqual(0.26);
      await f.engine.disconnect('first');
      for (let i = 0; i < 6; i++) { f.engine.heartbeat('other', { ...scope(f.engine.snapshot('other')), type: 'heartbeat', nonce: `ping${i}` }); await f.tick(1000); }
      const after = f.engine.snapshot('other');
      expect(after.controls.find(control => control.participantId === 'p1')?.kind).toBe('bot');
      expect(after.phase).toBe('running');
      const returned = await f.engine.connect(claims(f.matchId, f.clock.wall), 'returned');
      expect(returned.hasControl).toBe(true);
      expect(returned.controls.find(control => control.participantId === 'p1')?.kind).toBe('human');
    } finally { f.store.close(); }
  });
  it('does not renew continuous input when an internal worker queue delayed its arrival', async () => {
    const f = await fixture();
    try {
      await f.engine.connect(claims(f.matchId, f.clock.wall), 'first'); await f.tick(3000);
      const snapshot = f.engine.snapshot('first');
      f.engine.input('first', { ...scope(snapshot), type: 'input', inputSeq: 1, payload: { move: 1 } }, f.clock.mono - 400);
      await f.tick(100);
      expect((f.engine.snapshot('first').view as { x: number }).x).toBe(0);
      f.engine.input('first', { ...scope(snapshot), type: 'input', inputSeq: 2, payload: { move: 1 } }, f.clock.mono - 200);
      await f.tick(200);
      expect((f.engine.snapshot('first').view as { x: number }).x).toBeGreaterThan(0);
      expect((f.engine.snapshot('first').view as { x: number }).x).toBeLessThanOrEqual(0.06);
    } finally { f.store.close(); }
  });
  it('idempotently acknowledges lost replies, restores full checkpoints and rejects old epochs', async () => {
    const f = await fixture();
    try {
      await f.engine.connect(claims(f.matchId, f.clock.wall), 'first'); await f.tick(3000);
      let current = f.engine.snapshot('first');
      const spend = command(current, 'spend', 'spend-once');
      const result = await f.engine.action('first', spend);
      expect(await f.engine.action('first', spend)).toEqual(result);
      await expect(f.engine.action('first', { ...spend, payload: { type: 'save' } })).rejects.toThrow('ACTION_ID_REUSED');
      expect((f.engine.snapshot('first').view as { stock: number }).stock).toBe(4);
      await f.engine.action('first', command(current, 'save', 'save-camp'));
      await f.engine.action('first', command(current, 'spend', 'spend-again'));
      await f.tick(100);
      const elapsed = f.engine.snapshot('first').elapsedSeconds;
      await f.engine.action('first', command(current, 'rewind', 'rewind-camp'));
      current = f.engine.snapshot('first');
      expect(current.epoch).toBe(spend.epoch + 1); expect(current.attempt).toBe(1);
      expect(current.elapsedSeconds).toBe(elapsed); expect((current.view as { stock: number }).stock).toBe(4);
      await expect(f.engine.action('first', spend)).rejects.toThrow('STALE_EPOCH');
    } finally { f.store.close(); }
  });
  it('recovers a committed journal after an unclean connection loss and keeps receipts across recovery epochs', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'iva-realtime-')); folders.push(directory);
    const path = join(directory, 'world.sqlite'), f = await fixture(path);
    await f.engine.connect(claims(f.matchId, f.clock.wall), 'first'); await f.tick(3000);
    const before = f.engine.snapshot('first');
    await f.engine.action('first', command(before, 'spend', 'durable-spend'));
    f.engine.input('first', { ...scope(before), type: 'input', inputSeq: 1, payload: { move: 1 } });
    await f.tick(150);
    const expected = f.engine.snapshot('first');
    f.store.close();
    // The old process is gone. Advance past its fenced lease before a new owner.
    f.clock.wall += 15_001; f.clock.mono += 15_001;
    const store = new RealtimeStore(path), storage = new LocalStorageClient(store);
    const recovered = new RealtimeEngine({ storage, adapters: [adapter], ownerId: 'recovery-owner', wallNow: () => f.clock.wall, monoNow: () => f.clock.mono });
    try {
      await recovered.initialize();
      const after = await recovered.connect(claims(f.matchId, f.clock.wall), 'recovered');
      expect(after.view).toEqual(expected.view); expect(after.epoch).toBeGreaterThan(expected.epoch);
      expect(after.committedJournalSeq).toBeGreaterThan(expected.committedJournalSeq);
      const retry = await recovered.action('recovered', command(after, 'spend', 'durable-spend'));
      expect(retry.result).toEqual({ ok: true, stock: 4 });
      expect((recovered.snapshot('recovered').view as { stock: number }).stock).toBe(4);
    } finally { store.close(); }
  });
  it('commits an automatic tutorial boundary at the exact simulated step and uses ordinary rewind', async () => {
    const game = { ...adapter,
      step: (...args: Parameters<typeof adapter.step>) => { adapter.step(...args); args[0].changes += 1; },
      pollCheckpoint: (world: { changes: number }) => { if (world.changes === 3) { world.changes += 1; return 'camp'; } return null; },
    };
    const f = await fixture(':memory:', game);
    try {
      await f.engine.connect(claims(f.matchId, f.clock.wall), 'first'); await f.tick(3000);
      let current = f.engine.snapshot('first');
      f.engine.input('first', { ...scope(current), type: 'input', inputSeq: 1, payload: { move: 1 } });
      await f.tick(150);
      const saved = f.store.checkpoint(f.matchId, 'camp');
      expect(saved.worldTick).toBe(3);
      expect(JSON.parse(saved.world).changes).toBe(4);
      current = f.engine.snapshot('first'); const generation = current.controllerGeneration, elapsed = current.elapsedSeconds;
      await f.engine.action('first', command(current, 'rewind', 'lesson-retry'));
      const restored = f.engine.snapshot('first');
      expect(restored.worldTick).toBe(3); expect(restored.controllerGeneration).toBe(generation);
      expect(restored.elapsedSeconds).toBe(elapsed); expect(restored.epoch).toBe(current.epoch + 1);
      expect((restored.view as { x: number }).x).toBe(JSON.parse(saved.world).x);
    } finally { f.store.close(); }
  });
  it('fences concurrent owners, atomically consumes a ticket across two stores and expires empty rooms', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'iva-realtime-')); folders.push(directory);
    const path = join(directory, 'world.sqlite'), f = await fixture(path), second = new RealtimeStore(path);
    try {
      expect(() => second.acquire(f.matchId, 'intruder-owner', f.clock.wall)).toThrow('OWNER_BUSY');
      f.store.consume('ticket', 'one-use-token', f.clock.wall + 30_000, f.clock.wall);
      expect(() => second.consume('ticket', 'one-use-token', f.clock.wall + 30_000, f.clock.wall)).toThrow('REPLAY_REJECTED');
      await f.engine.connect(claims(f.matchId, f.clock.wall), 'first'); await f.tick(3000);
      await f.engine.disconnect('first'); await f.tick(10_001);
      expect(f.engine.status(f.matchId).phase).toBe('paused');
      f.clock.wall += 86_400_001; f.clock.mono += 86_400_001;
      // Lease was intentionally not renewed while this synthetic wall advanced;
      // expiry is tested by the authorized returning connection, before any tick.
      f.store.db.prepare('UPDATE rt_matches SET lease_until=? WHERE id=?').run(f.clock.wall + 15_000, f.matchId);
      await expect(f.engine.connect(claims(f.matchId, f.clock.wall), 'expired')).rejects.toThrow('RETURN_EXPIRED');
      expect(f.engine.status(f.matchId)).toMatchObject({ finished: true, phase: 'abandoned' });
    } finally { f.store.close(); second.close(); }
  });
  it('storage rejection never emits a successful action receipt or a new authoritative snapshot', async () => {
    const f = await fixture();
    try {
      await f.engine.connect(claims(f.matchId, f.clock.wall), 'first'); await f.tick(3000);
      const current = f.engine.snapshot('first');
      f.store.db.exec("CREATE TRIGGER fail_journal BEFORE INSERT ON rt_journal BEGIN SELECT RAISE(ABORT,'injected disk refusal'); END");
      await expect(f.engine.action('first', command(current, 'spend', 'refused-spend'))).rejects.toThrow();
      expect(f.store.receipt(f.matchId, 1, 'p1', 'refused-spend')).toBeNull();
      expect(() => f.engine.snapshot('first')).toThrow('RECOVERY_REQUIRED');
    } finally { f.store.close(); }
  });
});
