import assert from 'node:assert/strict';
import test from 'node:test';
import { netemProfile } from './realtime-network-profile.mjs';

test('zero nominal RTT with jitter records a one-microsecond latency floor', () => {
  const value = netemProfile({ rttMs: 0, jitterMs: 30, lossPercent: 5 });
  assert.deepEqual(value.args.slice(8), ['delay', '0.001ms', '15ms', 'distribution', 'normal', 'loss', '5%']);
  assert.deepEqual(value.applied, { oneWayBaseDelayMs: 0.001, oneWayJitterMs: 15, lossPercent: 5, zeroRttJitterFloorMs: 0.001 });
});

test('every requested matrix profile keeps loss and positive RTT, without zero-latency distributions', () => {
  for (const rttMs of [0, 80, 160, 300]) for (const jitterMs of [0, 30]) for (const lossPercent of [0, 1, 5]) {
    const value = netemProfile({ rttMs, jitterMs, lossPercent });
    assert.equal(value.applied.lossPercent, lossPercent);
    assert.equal(value.applied.oneWayBaseDelayMs, rttMs === 0 && jitterMs > 0 ? 0.001 : rttMs / 2);
    if (value.args.includes('distribution')) assert.ok(value.applied.oneWayBaseDelayMs > 0 && value.applied.oneWayJitterMs > 0);
  }
  assert.deepEqual(netemProfile({ rttMs: 0, jitterMs: 0, lossPercent: 0 }).args.slice(8), ['delay', '0ms']);
  assert.deepEqual(netemProfile({ rttMs: 0, jitterMs: 0, lossPercent: 100 }).args.slice(8), ['loss', '100%']);
  assert.throws(() => netemProfile({ rttMs: 0, jitterMs: 0, lossPercent: 101 }), /Invalid netem/);
});
