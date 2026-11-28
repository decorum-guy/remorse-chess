import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { REALTIME_PROTOCOL, applyViewChanges, parseClientMessage, viewChanges } from '@iva-games/realtime-kit';
import { signBridge, signTicket, verifyBridge, verifyTicket } from '../src/crypto.js';
import { RealtimeStore } from '../src/storage.js';
import { claims, keyPair } from './fixture.js';

describe('realtime authentication and bounded protocol', () => {
  it('binds an Ed25519 ticket to origin, roster fields, expiry and exact keys', () => {
    const keys = keyPair(), now = 1_800_000_000_000;
    const ticket = claims('match1', now), trusted = new Map([['test-key', keys.publicKey]]);
    const token = signTicket(ticket, keys.privateKey);
    expect(verifyTicket(token, trusted, ticket.allowedOrigin, now)).toEqual(ticket);
    expect(() => verifyTicket(token, trusted, 'https://other.invalid', now)).toThrow('AUTH_FAILED');
    expect(() => verifyTicket(token, trusted, ticket.allowedOrigin, now + 36_000)).toThrow('AUTH_FAILED');
    expect(() => verifyTicket(token, new Map(), ticket.allowedOrigin, now)).toThrow('AUTH_FAILED');
    const altered = { ...ticket, playerId: 'player2' };
    const forged = `${Buffer.from(JSON.stringify(altered)).toString('base64url')}.${token.split('.')[1]}`;
    expect(() => verifyTicket(forged, trusted, ticket.allowedOrigin, now)).toThrow('AUTH_FAILED');
    const extended = signTicket({ ...ticket, admin: true } as typeof ticket, keys.privateKey);
    expect(() => verifyTicket(extended, trusted, ticket.allowedOrigin, now)).toThrow('UNKNOWN_FIELD');
  });
  it('atomically consumes ticket IDs and bridge nonces in durable SQLite transactions', () => {
    const store = new RealtimeStore(':memory:');
    try {
      const id = randomBytes(24).toString('base64url');
      store.consume('ticket', id, 1000, 1);
      expect(() => store.consume('ticket', id, 1000, 2)).toThrow('REPLAY_REJECTED');
    } finally { store.close(); }
  });
  it('service signatures cannot be moved to another endpoint, method or payload', () => {
    const keys = keyPair(), now = 1_800_000_000_000, trusted = new Map([['test-key', keys.publicKey]]);
    const envelope = signBridge('POST', '/internal/realtime/v1/matches', { gameId: 'fixture' }, 'test-key', keys.privateKey, now);
    expect(verifyBridge(envelope, trusted, 'POST', envelope.path, now)).toEqual(envelope);
    expect(() => verifyBridge(envelope, trusted, 'GET', envelope.path, now)).toThrow('BRIDGE_UNAUTHORIZED');
    expect(() => verifyBridge(envelope, trusted, 'POST', '/internal/realtime/v1/drain', now)).toThrow('BRIDGE_UNAUTHORIZED');
    expect(() => verifyBridge({ ...envelope, body: {} }, trusted, 'POST', envelope.path, now)).toThrow('BRIDGE_UNAUTHORIZED');
  });
  it('rejects stale-style identity fields, nonfinite values and unknown messages', () => {
    const frame = { protocolVersion: REALTIME_PROTOCOL, matchId: 'match1', epoch: 1, controllerGeneration: 1, type: 'input', inputSeq: 1, payload: { move: 1 } };
    expect(parseClientMessage(frame)).toEqual(frame);
    expect(() => parseClientMessage({ ...frame, playerId: 'other' })).toThrow('UNKNOWN_FIELD');
    expect(() => parseClientMessage({ ...frame, inputSeq: -1 })).toThrow('INVALID_SEQUENCE');
    expect(() => parseClientMessage({ ...frame, payload: { move: Infinity } })).toThrow('INVALID_PAYLOAD');
    expect(() => parseClientMessage({ ...frame, type: 'win' })).toThrow('UNKNOWN_MESSAGE');
  });
  it('deltas reconstruct a view and remove entities without mutating its baseline', () => {
    const initial = { map: { geometry: [1, 2, 3] }, units: [{ id: 'u1', x: 1 }, { id: 'u2', x: 3 }], visible: true };
    const next = { map: { geometry: [1, 2, 3] }, units: [{ id: 'u1', x: 2 }] };
    const delta = viewChanges(initial, next);
    expect(delta.some(change => change.path[0] === 'map')).toBe(false);
    expect(applyViewChanges(initial, delta)).toEqual(next);
    expect(initial.units).toHaveLength(2);
    expect(() => applyViewChanges({}, [{ path: ['__proto__', 'admin'], value: true }])).toThrow('INVALID_DELTA');
  });
});
