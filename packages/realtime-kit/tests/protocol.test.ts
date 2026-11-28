import { describe, expect, it } from 'vitest';
import { parseClientMessage } from '../src/index';
const frame = { type: 'input', protocolVersion: 1, matchId: 'room-1', epoch: 1, controllerGeneration: 2,
  inputSeq: 3, payload: { moveX: 1, moveZ: 0, aimX: 1, aimZ: 0, fireHeld: true, firePressSeq: 1 } };
describe('strict realtime wire boundary', () => {
  it('accepts the declared input and discrete envelopes', () => {
    expect(parseClientMessage(frame)).toEqual(frame);
    expect(parseClientMessage({ ...frame, type: 'action', inputSeq: undefined, actionId: 'action-123', payload: { type: 'reload' } })).toBeNull();
    expect(parseClientMessage({ type: 'action', protocolVersion: 1, matchId: 'room-1', epoch: 1, controllerGeneration: 2, actionId: 'action-123', payload: { type: 'reload' } })).not.toBeNull();
  });
  it.each([NaN, Infinity, -Infinity])('rejects nonfinite payload number %s before simulation', number => {
    expect(parseClientMessage({ ...frame, payload: { aimX: number } })).toBeNull();
  });
  it('rejects client authority, unsafe sequence and unknown fields', () => {
    expect(parseClientMessage({ ...frame, winner: 'A' })).toBeNull();
    expect(parseClientMessage({ ...frame, epoch: -1 })).toBeNull();
    expect(parseClientMessage({ ...frame, inputSeq: Number.MAX_SAFE_INTEGER + 1 })).toBeNull();
    expect(parseClientMessage({ ...frame, type: 'setWorld' })).toBeNull();
  });
  it('bounds nested payloads and authentication size', () => {
    expect(parseClientMessage({ ...frame, payload: { ids: Array.from({ length: 101 }, (_, i) => i) } })).toBeNull();
    expect(parseClientMessage({ type: 'authenticate', ticket: 'a'.repeat(3801) })).toBeNull();
    expect(parseClientMessage({ type: 'authenticate', ticket: 'safe.signature', playerId: 'someone-else' })).toBeNull();
  });

});
