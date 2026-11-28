import { describe, expect, it, vi } from 'vitest';
import { REALTIME_PROTOCOL } from '@iva-games/realtime-kit';
import { BoundedTiming, TIMING_BOUNDS_MS } from '../src/metrics.js';
import type { RealtimeStore } from '../src/storage.js';
import { claims, fixture } from './fixture.js';

describe('bounded, explicit operational measurements', () => {
  it('retains whole-run bucket counts and only a bounded exact recent window', () => {
    const timing = new BoundedTiming();
    expect(timing.report().p99UpperMs).toBeNull();
    for (let index = 1; index <= 100; index++) timing.observe(index);
    expect(timing.report()).toMatchObject({ count: 100, maxMs: 100, p99UpperMs: 100, recent: { count: 100, p99Ms: 99 } });
    for (let index = 0; index < 200_000; index++) timing.observe(index % 8);
    timing.observe(NaN); timing.observe(Infinity); timing.observe(-1);
    const report = timing.report();
    expect(report.count).toBe(200_100); expect(report.buckets).toHaveLength(TIMING_BOUNDS_MS.length + 1);
    expect(report.buckets.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(report.count);
    expect(report.recent).toEqual({ count: 2048, p50Ms: 3, p95Ms: 7, p99Ms: 7 });
    expect(report.p99UpperMs).toBe(7);
  });
  it('makes overflow explicit instead of reporting a successful finite p99', () => {
    const timing = new BoundedTiming(); timing.observe(9000);
    expect(timing.report()).toMatchObject({ count: 1, maxMs: 9000, p99UpperMs: null, recent: { p99Ms: 9000 } });
    expect(timing.report().buckets.at(-1)).toEqual({ upperMs: null, count: 1 });
  });
  it('reports a pending durable write age without publishing a game acknowledgement', async () => {
    const f = await fixture();
    const initial = await f.engine.connect(claims(f.matchId, f.clock.wall), 'metrics-client'); await f.tick(3000);
    const original = f.storage.call.bind(f.storage);
    let unblock!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { unblock = resolve; }), waiting = new Promise<void>(resolve => { entered = resolve; });
    const spy = vi.spyOn(f.storage, 'call').mockImplementation(async (method, ...args) => {
      if (method === 'commit' && (args[0] as { kind?: string })?.kind === 'action') { entered(); await gate; }
      return original(method, ...args as Parameters<RealtimeStore[typeof method]>);
    });
    try {
      let acknowledged = false;
      const action = f.engine.action('metrics-client', { protocolVersion: REALTIME_PROTOCOL, matchId: f.matchId,
        epoch: initial.epoch, controllerGeneration: initial.controllerGeneration, type: 'action', actionId: 'measured-write', payload: { type: 'spend' } }).then(value => { acknowledged = true; return value; });
      await waiting; f.clock.mono += 75; f.clock.wall += 75;
      expect(f.engine.health()).not.toHaveProperty('diagnostics');
      expect(f.engine.health(true)).toMatchObject({ diagnostics: { uncommittedAgeMs: 75 } });
      expect(acknowledged).toBe(false);
      unblock(); await action;
      f.clock.mono += 13; f.engine.snapshot('metrics-client');
      expect(f.engine.health(true)).toMatchObject({ diagnostics: { uncommittedAgeMs: 0, runningSnapshotAgeMs: 13,
        games: [{ commit: { maxMs: 75 }, uncommitted: { maxMs: 75 }, snapshotAge: { maxMs: 13 } }] } });
    } finally { unblock(); spy.mockRestore(); await f.engine.drain(); f.store.close(); }
  });
});
