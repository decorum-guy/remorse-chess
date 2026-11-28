import { describe, expect, it } from 'vitest';
import { LIVE_PROTOCOL, LiveRateWindow, parseLiveClientFrame } from './realtime';

const scope = { protocol: LIVE_PROTOCOL, wireVersion: 'fixture-wire@1', roomId: 'room', matchId: 'match', epoch: 'current-epoch' };
describe('shared realtime wire boundaries', () => {
  it('rejects mismatched session scopes, extra identities, invalid sequence and non-command frames', () => {
    const valid = { ...scope, type: 'input', seq: 1, payload: { steering: 0.5 } };
    expect(parseLiveClientFrame(valid, scope)).toEqual(valid);
    for (const changed of [{ epoch: 'previous' }, { matchId: 'another' }, { protocol: 'iva-live@0' }, { wireVersion: 'old' }]) {
      expect(() => parseLiveClientFrame({ ...valid, ...changed }, scope)).toThrow('LIVE_SCOPE_MISMATCH');
    }
    for (const changed of [{ seq: -1 }, { seq: 1.1 }, { seq: Number.MAX_SAFE_INTEGER + 1 }, { playerId: 'another' }, { type: 'snapshot' }]) {
      expect(() => parseLiveClientFrame({ ...valid, ...changed }, scope)).toThrow('INVALID_FRAME');
    }
    expect(() => parseLiveClientFrame({ ...scope, type: 'command', actionId: 'short', expectedRevision: 0, payload: {} }, scope)).toThrow('INVALID_FRAME');
    expect(parseLiveClientFrame({ ...scope, type: 'command', actionId: 'command-0001', expectedRevision: 0, payload: { reset: true } }, scope).type).toBe('command');
  });
  it('bounds the rolling second instead of doubling a burst across fixed windows', () => {
    const rate = new LiveRateWindow(30);
    for (let i = 0; i < 30; i++) expect(rate.take(990 + i / 100)).toBe(true);
    expect(rate.take(1001)).toBe(false);
    expect(rate.take(1989)).toBe(false);
    expect(rate.take(1990)).toBe(true);
    expect(rate.take(1990)).toBe(false);
    expect(rate.take(5000)).toBe(true);
  });
});
