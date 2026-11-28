import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { performance } from 'node:perf_hooks';
import type { StoredMatch, StoredStart } from '../src/store';
import type { NewMatch, Peer } from '../src/runtime';
import type { World } from '@iva-games/forpost/core';

const io = vi.hoisted(() => ({ records: new Map<string, StoredMatch>(), starts: new Map<string, StoredStart>(), results: [] as unknown[], finish: false,
  release: [] as (() => void)[], admissionBarrier: null as null | Promise<void>,
  barrier: null as null | { wait: Promise<void>; entered: (value: { match: StoredMatch }) => void } }));
vi.mock('../src/worker-rpc', async () => {
  const core = await import('@iva-games/forpost/core');
  return { WorkerRpc: class {
    private worlds = new Map<string, World>();
    private store: boolean;
    constructor(path: URL) { this.store = path.href.endsWith('/store-worker.js'); }
    async call(method: string, ...args: unknown[]) {
      if (this.store) {
        if (method === 'list') return [];
        if (method === 'starts') return [...io.starts.values()].map(value => structuredClone(value));
        if (method === 'byStart') return [...io.records.values()].find(match => match.startId === args[0]) ?? null;
        if (method === 'enqueueStart') {
          const input = args[0] as StoredStart, old = io.starts.get(input.startId);
          if (old) { if (old.fingerprint !== input.fingerprint) throw new Error('START_CONFLICT'); return structuredClone(old); }
          if ([...io.starts.values()].some(start => start.hostId === input.hostId)) throw new Error('HOST_START_PENDING');
          const start = { ...input, ordinal: io.starts.size + 1, createdAt: Date.now(), reservationId: null, reservedUntil: null, leaseOwner: null };
          io.starts.set(start.startId, start); return structuredClone(start);
        }
        if (method === 'reserveStart') {
          const entry = io.starts.get(args[0] as string)!;
          if (entry !== [...io.starts.values()][0]) throw new Error('SERVER_BUSY');
          entry.reservationId = args[3] as string; entry.reservedUntil = Date.now() + 15_000; entry.leaseOwner = args[2] as string;
          return structuredClone(entry);
        }
        if (method === 'cancelStart') { const entry = io.starts.get(args[0] as string); if (entry && entry.hostId === args[1] && !entry.reservationId) io.starts.delete(entry.startId); return; }
        if (method === 'releaseStart') { const entry = io.starts.get(args[0] as string); if (entry && entry.leaseOwner === args[1] && entry.reservationId === args[2]) { entry.reservationId = null; entry.reservedUntil = null; entry.leaseOwner = null; } return; }
        if (method === 'create') { const match = structuredClone(args[0] as StoredMatch); io.records.set(match.matchId, match); io.starts.delete(match.startId); return structuredClone(match); }
        if (method === 'checkAdmission') { await io.admissionBarrier; return true; }
        if (method === 'commit') {
          const value = structuredClone(args[0] as { match: StoredMatch; result?: unknown }), barrier = io.barrier;
          io.barrier = null;
          if (barrier) { barrier.entered(value); await barrier.wait; }
          io.records.set(value.match.matchId, value.match); if (value.result) io.results.push(value.result);
        }
        return null;
      }
      if (method === 'drop') { this.worlds.delete(args[0] as string); return; }
      let world: World;
      if (method === 'create') { world = core.createWorld(args[0] as Parameters<typeof core.createWorld>[0]); this.worlds.set(world.matchId, world); }
      else {
        world = this.worlds.get(args[0] as string)!; world.tick++;
        if (io.finish) { world.phase = 'finished'; world.winner = 'A'; world.resultId = world.matchId + ':result'; }
      }
      return { world: core.serializeWorld(world), tick: world.tick, phase: world.phase,
        outcome: world.phase === 'finished' ? { winner: world.winner, resultId: world.resultId, operations: [] } : null,
        views: Object.fromEntries(world.participants.map(person => [person.id, core.viewForPlayer(world, person.id)])), results: [] };
    }
    async stop() {}
  } };
});
import { RealtimeRuntime } from '../src/runtime';

const runtimes: RealtimeRuntime[] = [];
beforeEach(() => {
  io.records.clear(); io.starts.clear(); io.results.length = 0; io.release.length = 0; io.finish = false; io.barrier = null; io.admissionBarrier = null;
  vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(new Date('2026-11-28T00:00:00Z'));
  vi.spyOn(performance, 'now').mockImplementation(() => Date.now() - Date.parse('2026-11-28T00:00:00Z'));
});
afterEach(async () => {
  for (const release of io.release) release(); await vi.advanceTimersByTimeAsync(0);
  for (const runtime of runtimes) await runtime.close().catch(() => {});
  runtimes.length = 0; vi.restoreAllMocks(); vi.useRealTimers();
});

async function fixture() {
  const runtime = new RealtimeRuntime({ databasePath: '/unused-controlled-writer.sqlite', maxRooms: 4, artifactId: 'test-runtime',
    resourceSample: () => ({ memoryLimitBytes: 8 * 1024 ** 3, memoryUsedBytes: 128 * 1024 ** 2, availableMemoryBytes: 7 * 1024 ** 3,
      memorySource: 'cgroup', cpuSource: 'cgroup', cpuCores: 2, cpuMsPerSecond: 0, valid: true }) });
  runtimes.push(runtime); await runtime.ready;
  const input: NewMatch = { startId: 'start', roomId: 'room', kind: 'practice', ownerHash: 'owner', rulesVersion: 'forpost-0.1', contentVersion: 'forpost-content-1',
    roster: [{ participantId: 'human', playerId: 'player', displayName: 'Human fixture', team: 'A', controller: 'human' },
      { participantId: 'bot', playerId: null, displayName: 'Explicit bot fixture', team: 'B', controller: 'bot' }],
    config: { mapId: 'FP01', teamSize: 1, seed: 5, mode: 'training', participants: [
      { id: 'human', name: 'Human fixture', team: 'A', controller: 'human' }, { id: 'bot', name: 'Explicit bot fixture', team: 'B', controller: 'bot' }] } };
  const match = await runtime.create(input);
  const sent: Record<string, unknown>[] = [];
  const peer: Peer = { id: 'socket-1', claims: { issuer: 'iva-realtime-practice', audience: 'iva-realtime', keyId: 'test-key', ticketId: 'ticket',
    playerId: 'player', participantId: 'human', matchId: match.matchId, roomId: 'room', rosterHash: match.rosterHash, gameId: 'forpost', protocolVersion: 1,
    rulesVersion: match.rulesVersion, contentVersion: match.contentVersion, allowedOrigin: 'http://localhost', permission: 'control',
    issuedAt: Date.now(), expiresAt: Date.now() + 30_000, admissionId: 'admission' },
    send: value => sent.push(structuredClone(value) as Record<string, unknown>), close: vi.fn(), queuedBytes: () => 0,
    rttMs: 0, lastSeen: Date.now(), lastAdmissionCheck: Date.now(), blockedSince: 0 };
  await runtime.connect(peer);
  const resync = () => runtime.message(peer, { type: 'resync', protocolVersion: 1, matchId: match.matchId,
    epoch: match.epoch, controllerGeneration: runtime.get(match.matchId)!.controls.human.generation });
  return { runtime, matchId: match.matchId, peer, sent, resync, input };
}
function blockedCommit() {
  let release!: () => void, reject!: (error: Error) => void, entered!: (value: { match: StoredMatch }) => void;
  const wait = new Promise<void>((resolve, fail) => { release = resolve; reject = fail; });
  io.release.push(release);
  const started = new Promise<{ match: StoredMatch }>(resolve => { entered = resolve; });
  io.barrier = { wait, entered }; return { release, reject, started };
}

describe('publication waits for durable writer confirmation', () => {
  it('keeps resync, committed sequence and platform outcome on the previous state while the result write is blocked', async () => {
    const { runtime, matchId, sent, resync } = await fixture(); await vi.advanceTimersByTimeAsync(3200);
    const before = runtime.get(matchId)!; io.finish = true; const block = blockedCommit();
    await vi.advanceTimersByTimeAsync(40); const candidate = await block.started;
    expect(candidate.match.tick).toBeGreaterThan(before.tick); expect(candidate.match.phase).toBe('finished');
    expect(runtime.get(matchId)).toEqual(before); expect(runtime.view(matchId, 'player')).toMatchObject({ finished: false, outcome: null });
    await vi.advanceTimersByTimeAsync(300);
    expect(runtime.health().metrics.journalPendingAgeMs).toBeGreaterThanOrEqual(300);
    expect(io.results).toEqual([]); await resync();
    expect(sent.at(-1)).toMatchObject({ type: 'full', worldTick: before.tick, committedJournalSeq: before.journalSeq,
      phase: 'running', view: { tick: before.tick, resultId: null } });
    block.release(); await vi.advanceTimersByTimeAsync(0);
    expect(runtime.get(matchId)).toMatchObject({ tick: candidate.match.tick, phase: 'finished', outcome: { winner: 'A' } });
    expect(runtime.view(matchId, 'player')).toMatchObject({ finished: true, outcome: { winner: 'A' } });
    expect(io.results).toHaveLength(1);
    expect(runtime.health().metrics.journalPendingAgeMs).toBe(0);
    expect(runtime.health().metrics.journalAgeP99Ms).toBeGreaterThanOrEqual(300);
  });

  it('never promotes a failed result or re-persists its dirty worker world on reconnect, drain or shutdown', async () => {
    const { runtime, matchId, peer, resync } = await fixture(); await vi.advanceTimersByTimeAsync(3200);
    const before = runtime.get(matchId)!; io.finish = true; const block = blockedCommit();
    await vi.advanceTimersByTimeAsync(40); await block.started;
    block.reject(new Error('INJECTED_STORAGE_FAILURE')); await vi.advanceTimersByTimeAsync(0);
    expect(runtime.get(matchId)).toEqual(before); expect(io.records.get(matchId)).toEqual(before); expect(io.results).toEqual([]);
    expect(runtime.view(matchId, 'player')).toMatchObject({ phase: 'failed-recoverable', finished: false, outcome: null });
    await expect(resync()).rejects.toThrow('SERVER_UNAVAILABLE');
    await expect(runtime.connect({ ...peer, id: 'new-socket' })).rejects.toThrow('SERVER_UNAVAILABLE');
    runtime.disconnect(peer); await vi.advanceTimersByTimeAsync(0);
    await expect(runtime.abandon(matchId, 'owner')).rejects.toThrow('SERVER_UNAVAILABLE');
    await expect(runtime.resume()).rejects.toThrow('SERVER_UNAVAILABLE');
    await expect(runtime.drain()).rejects.toThrow('RECOVERY_REQUIRED');
    await expect(runtime.close()).rejects.toThrow('RECOVERY_REQUIRED');
    expect(io.records.get(matchId)).toEqual(before); expect(io.results).toEqual([]);
  });

  it('pauses a silent still-open socket ten seconds after the last signal, without adding a second grace period', async () => {
    const { runtime, matchId } = await fixture(); await vi.advanceTimersByTimeAsync(9990);
    expect(runtime.get(matchId)!.phase).toBe('running');
    await vi.advanceTimersByTimeAsync(50); const paused = runtime.get(matchId)!;
    expect(paused.phase).toBe('paused'); expect(paused.pauseReason).toBe('NO_HUMANS'); expect(paused.tick).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(1000); expect(runtime.get(matchId)!.tick).toBe(paused.tick);
  });

  it('does not let an admission that began before drain unpause the room after the durable drain succeeds', async () => {
    const { runtime, matchId, peer } = await fixture();
    let release!: () => void;
    io.admissionBarrier = new Promise<void>(resolve => { release = resolve; }); io.release.push(release);
    const connecting = runtime.connect({ ...peer, id: 'late-socket', claims: { ...peer.claims, ticketId: 'late-ticket' } });
    await vi.advanceTimersByTimeAsync(0); await runtime.drain();
    const drained = runtime.get(matchId)!; expect(drained.phase).toBe('paused');
    const rejected = expect(connecting).rejects.toThrow('SERVER_BUSY'); release(); await rejected;
    expect(runtime.get(matchId)).toEqual(drained);
  });

  it('keeps a capacity-blocked account start in FIFO and creates it automatically after capacity is released', async () => {
    const { runtime, matchId, input } = await fixture();
    const next: NewMatch = { ...input, startId: 'next-start', roomId: 'next-room', kind: 'account', ownerHash: null, hostPlayerId: 'player' };
    await expect(runtime.create(next)).rejects.toMatchObject({ waiting: { reason: 'capacity', queuePosition: 1 } });
    await expect(runtime.create(next)).rejects.toMatchObject({ waiting: { reason: 'capacity', queuePosition: 1 } });
    await expect(runtime.create({ ...next, startId: 'host-second-start' })).rejects.toMatchObject({ waiting: { reason: 'another_start' } });
    expect(io.starts.size).toBe(1); expect(io.records.size).toBe(1);
    await runtime.abandon(matchId, 'owner'); await vi.advanceTimersByTimeAsync(1100);
    const created = await runtime.create(next);
    expect(created.startId).toBe('next-start'); expect(io.starts.size).toBe(0); expect(io.records.size).toBe(2);
    expect((await runtime.create(next)).matchId).toBe(created.matchId);
  });

  it('durably queues account starts during drain but does not create them until resume', async () => {
    const { runtime, matchId, input } = await fixture(); await runtime.drain(); await runtime.abandon(matchId, 'owner');
    const next: NewMatch = { ...input, startId: 'during-drain', roomId: 'waiting-room', kind: 'account', ownerHash: null, hostPlayerId: 'player' };
    await expect(runtime.create(next)).rejects.toMatchObject({ waiting: { reason: 'updating' } });
    await vi.advanceTimersByTimeAsync(16_000); expect(io.records.size).toBe(1); expect(io.starts.size).toBe(1);
    await runtime.resume(); await vi.advanceTimersByTimeAsync(1100);
    expect((await runtime.create(next)).startId).toBe('during-drain'); expect(io.starts.size).toBe(0);
  });

  it('does not create an invisible future training room after a guest receives a capacity refusal', async () => {
    const { runtime, matchId, input } = await fixture();
    await expect(runtime.create({ ...input, startId: 'guest-refused', roomId: 'guest-room' })).rejects.toMatchObject({ waiting: { reason: 'capacity' } });
    expect(io.starts.size).toBe(0);
    await runtime.abandon(matchId, 'owner'); await vi.advanceTimersByTimeAsync(1100);
    expect(io.records.size).toBe(1); expect(runtime.rooms.size).toBe(0);
  });
});
