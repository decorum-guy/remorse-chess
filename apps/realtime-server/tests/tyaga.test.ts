import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REALTIME_PROTOCOL } from '@iva-games/realtime-kit';
import type { Snapshot, TicketClaims, WireScope } from '@iva-games/realtime-kit';
import type { StartMatchRequest } from '@iva-games/session-kit';
import { createTyagaAdapter } from '@iva-games/tyaga/server';
import { NEUTRAL_INPUT } from '@iva-games/tyaga/shared';
import type { TyagaInput, TyagaView } from '@iva-games/tyaga/shared';
import { fingerprint } from '../src/crypto.js';
import { RealtimeEngine } from '../src/engine.js';
import { LocalStorageClient, RealtimeStore } from '../src/storage.js';

const folders: string[] = [];
afterEach(() => { for (const path of folders.splice(0)) rmSync(path, { recursive: true, force: true }); });
const scope = (snapshot: Snapshot): WireScope => ({ protocolVersion: REALTIME_PROTOCOL, matchId: snapshot.matchId,
  epoch: snapshot.epoch, controllerGeneration: snapshot.controllerGeneration });

// Actual Rapier adapter through the runtime. This is a technical durability
// test with ordinary input/actions, not renderer/browser mission acceptance.
describe('real Tyaga adapter and durable runtime', () => {
  it('unpacks one physical item once, changes crate mass once, retains its receipt and changes controller without replacing the participant', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'iva-tyaga-runtime-')); folders.push(directory);
    const path = join(directory, 'realtime.sqlite');
    const adapter = createTyagaAdapter();
    const clock = { wall: 1_800_000_000_000, mono: 1000 };
    const start: StartMatchRequest = { startCommandId: 'tyaga-start', roomId: 'tyaga-room',
      rulesVersion: adapter.rulesVersion, contentVersion: adapter.contentVersion, settings: { mapId: 'tutorial', mode: 'tutorial' },
      participants: [1, 2].map(n => ({ participantId: `tyaga-p${n}`, playerId: `tyaga-player${n}`, displayName: `QA ${n}`,
        seatIndex: n - 1, controller: { kind: 'human', playerId: `tyaga-player${n}` } })),
    };
    let store = new RealtimeStore(path);
    let engine = new RealtimeEngine({ storage: new LocalStorageClient(store), adapters: [adapter], ownerId: 'tyaga-engine-1',
      wallNow: () => clock.wall, monoNow: () => clock.mono });
    await engine.initialize(); const { matchId } = await engine.create('tyaga', start);
    const claims = (n: number): TicketClaims => ({ issuer: 'iva-platform', audience: 'iva-realtime', keyId: 'test-key',
      ticketId: randomBytes(24).toString('base64url'), playerId: `tyaga-player${n}`, participantId: `tyaga-p${n}`,
      roomId: start.roomId, matchId, rosterHash: fingerprint(start.participants), gameId: 'tyaga', rulesVersion: adapter.rulesVersion,
      contentVersion: adapter.contentVersion, protocolVersion: REALTIME_PROTOCOL, allowedOrigin: 'http://127.0.0.1:5284',
      permission: 'play', sessionId: String(n).repeat(64), issuedAt: clock.wall, expiresAt: clock.wall + 30_000 });
    let sequence = 0;
    const active = new Set(['human1', 'human2']);
    const view = (connection = 'human1') => engine.snapshot(connection).view as TyagaView;
    const advance = async (ms: number, input?: Partial<TyagaInput>) => {
      for (let elapsed = 0; elapsed < ms; elapsed += 25) {
        if (input) engine.input('human1', { ...scope(engine.snapshot('human1')), type: 'input', inputSeq: ++sequence, payload: { ...NEUTRAL_INPUT, ...input } });
        for (const connection of active) engine.heartbeat(connection, { ...scope(engine.snapshot(connection)), type: 'heartbeat', nonce: 'technical-keepalive' });
        const dt = Math.min(25, ms - elapsed); clock.wall += dt; clock.mono += dt; await engine.tick();
      }
    };
    try {
      await engine.connect(claims(1), 'human1'); await engine.connect(claims(2), 'human2'); await advance(3000);
      const crateMass = view().entities.find(entity => entity.id === 'equipment-crate')!.mass;
      for (let index = 0; index < 40 && !view().interactions.some(option => option.id === 'unpack-repair' && option.enabled); index++) {
        const state = view(), person = state.entities.find(entity => entity.id === 'person:tyaga-p1')!;
        const crate = state.entities.find(entity => entity.id === 'equipment-crate')!;
        await advance(100, person.position.x > crate.position.x + .1 ? { moveX: -1 } : { moveZ: -1 });
      }
      await advance(100, {});
      expect(view().interactions.find(option => option.id === 'unpack-repair')?.enabled).toBe(true);
      const person = view().entities.find(entity => entity.id === 'person:tyaga-p1')!;
      const message = { ...scope(engine.snapshot('human1')), type: 'action' as const, actionId: 'unpack-once',
        payload: { type: 'unpack', itemId: 'repair-1', position: { x: person.position.x, y: person.position.y, z: person.position.z + 1.2 } } };
      const receipt = await engine.action('human1', message);
      expect(receipt.result).toMatchObject({ ok: true, code: 'STARTED' });
      expect(await engine.action('human1', message)).toEqual(receipt);
      await advance(1300, {});
      const packed = view();
      expect(packed.inventory.find(item => item.id === 'repair-1')?.state).toBe('world');
      expect(packed.entities.filter(entity => entity.id === 'repair-1')).toHaveLength(1);
      expect(packed.entities.find(entity => entity.id === 'equipment-crate')!.mass).toBeCloseTo(crateMass - 6, 4);
      expect(await engine.action('human1', message)).toEqual(receipt);
      await engine.disconnect('human1'); active.delete('human1'); await advance(5200);
      expect(view('human2').participants.find(participant => participant.participantId === 'tyaga-p1')?.controller).toBe('bot');
      const returned = await engine.connect(claims(1), 'human1'); active.add('human1');
      expect(returned.hasControl).toBe(true);
      expect(view().participants.find(participant => participant.participantId === 'tyaga-p1')?.controller).toBe('human');
      await engine.drain(); await engine.drain(); store.close();
      store = new RealtimeStore(path);
      engine = new RealtimeEngine({ storage: new LocalStorageClient(store), adapters: [createTyagaAdapter()], ownerId: 'tyaga-engine-2',
        wallNow: () => clock.wall, monoNow: () => clock.mono });
      await engine.initialize();
      const recovered = await engine.connect(claims(1), 'human1');
      expect(recovered.epoch).toBeGreaterThan(returned.epoch);
      expect(view().inventory.find(item => item.id === 'repair-1')?.state).toBe('world');
      expect(view().entities.filter(entity => entity.id === 'repair-1')).toHaveLength(1);
      expect(view().entities.find(entity => entity.id === 'equipment-crate')!.mass).toBeCloseTo(crateMass - 6, 4);
      expect(await engine.action('human1', { ...message, ...scope(recovered) })).toEqual(receipt);
    } finally { await engine.drain(); store.close(); }
  });
});
