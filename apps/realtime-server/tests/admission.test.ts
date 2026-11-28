import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ADMISSION_RESERVATION_MS, REALTIME_PROTOCOL } from '@iva-games/realtime-kit';
import { RealtimeStore } from '../src/storage.js';
import { fingerprint } from '../src/crypto.js';
import { adapter, claims, fixture, request } from './fixture.js';

const folders: string[] = [];
afterEach(() => { for (const path of folders.splice(0)) rmSync(path, { recursive: true, force: true }); });
const start = (id: string, owner: string) => ({ ...request(), startCommandId: id, roomId: `room-${id}`, hostPlayerId: owner });

describe('durable FIFO admission and reservations', () => {
  it('keeps one waiting start per host and serves the oldest room when capacity becomes free', async () => {
    const f = await fixture();
    try {
      const a = start('waiting-a', 'player1'), b = start('waiting-b', 'player2');
      expect(f.store.queueAdmission('fixture', a, 'player1', 1, f.clock.wall)).toMatchObject({ position: 1, reservationId: null });
      expect(f.store.queueAdmission('fixture', b, 'player2', 1, f.clock.wall)).toMatchObject({ position: 2, reservationId: null });
      expect(f.store.queueAdmission('fixture', a, 'player1', 1, f.clock.wall)).toMatchObject({ position: 1, reservationId: null });
      expect(() => f.store.queueAdmission('fixture', start('other-for-host', 'player1'), 'player1', 1, f.clock.wall)).toThrow('HOST_START_PENDING');
      expect(() => f.store.queueAdmission('fixture', { ...a, settings: { changed: true } }, 'player1', 1, f.clock.wall)).toThrow('START_ID_REUSED');
      await f.engine.connect(claims(f.matchId, f.clock.wall), 'controller'); await f.tick(3000);
      const snapshot = f.engine.snapshot('controller');
      await f.engine.action('controller', { type: 'action', protocolVersion: REALTIME_PROTOCOL, matchId: f.matchId,
        epoch: snapshot.epoch, controllerGeneration: snapshot.controllerGeneration, actionId: 'finish-fixture', payload: { type: 'finish' } });
      await f.tick(25); expect(f.engine.status(f.matchId).finished).toBe(true);
      // The later caller cannot take the slot while the earlier host is waiting.
      expect(f.store.queueAdmission('fixture', b, 'player2', 1, f.clock.wall).reservationId).toBeNull();
      const reserved = f.store.queueAdmission('fixture', a, 'player1', 1, f.clock.wall);
      expect(reserved.reservationId).toBeTypeOf('string');
      expect(reserved.reservedUntil).toBe(f.clock.wall + ADMISSION_RESERVATION_MS);
      const repeated = f.store.queueAdmission('fixture', a, 'player1', 1, f.clock.wall + 1000);
      expect(repeated).toEqual(reserved);
      const created = await f.engine.create(adapter.gameId, a, { hostPlayerId: 'player1', reservationId: reserved.reservationId! });
      expect(f.store.admissionCount()).toBe(1);
      expect(await f.engine.create(adapter.gameId, a, { hostPlayerId: 'player1', reservationId: reserved.reservationId! })).toEqual(created);
      expect(f.store.queueAdmission('fixture', b, 'player2', 1, f.clock.wall).reservationId).toBeNull();
    } finally { f.store.close(); }
  });
  it('does not extend reservation TTL and returns an absent host behind callers already waiting', () => {
    const store = new RealtimeStore(':memory:');
    try {
      const now = 1_800_000_000_000, a = start('ttl-a', 'player1'), b = start('ttl-b', 'player2');
      const first = store.queueAdmission('fixture', a, 'player1', 1, now);
      expect(store.queueAdmission('fixture', b, 'player2', 1, now + 1).reservationId).toBeNull();
      expect(store.queueAdmission('fixture', a, 'player1', 1, now + 14_999).reservationId).toBe(first.reservationId);
      const next = store.queueAdmission('fixture', b, 'player2', 1, now + 15_001);
      expect(next.position).toBe(1); expect(next.reservationId).not.toBeNull();
      expect(store.queueAdmission('fixture', a, 'player1', 1, now + 15_001)).toMatchObject({ position: 2, reservationId: null });
    } finally { store.close(); }
  });
  it('persists queue order and tokens across SQLite reopen and rejects an expired reservation atomically', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'iva-admission-')); folders.push(directory);
    const path = join(directory, 'realtime.sqlite'), f = await fixture(path);
    const input = start('reserved-world', 'player1');
    const reservation = f.store.queueAdmission('fixture', input, 'player1', 2, f.clock.wall);
    expect(reservation.reservationId).not.toBeNull();
    f.store.close();
    const store = new RealtimeStore(path);
    try {
      expect(store.queueAdmission('fixture', input, 'player1', 2, f.clock.wall + 1000)).toEqual(reservation);
      const saved = store.get(f.matchId);
      const world = JSON.stringify(await adapter.create(request()));
      expect(() => store.create({ ...saved, matchId: 'must-not-exist', start: input, startHash: fingerprint({ gameId: 'fixture', input }) },
        'another-owner', world, f.clock.wall + 15_001, reservation.reservationId!)).toThrow('ADMISSION_EXPIRED');
      expect(() => store.get('must-not-exist')).toThrow('MATCH_UNAVAILABLE');
      expect(store.all()).toHaveLength(1);
    } finally { store.close(); }
  });
});
