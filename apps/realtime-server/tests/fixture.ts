import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { REALTIME_PROTOCOL, RealtimeError } from '@iva-games/realtime-kit';
import type { GameAdapter, TicketClaims } from '@iva-games/realtime-kit';
import type { StartMatchRequest } from '@iva-games/session-kit';
import { RealtimeEngine } from '../src/engine.js';
import { LocalStorageClient, RealtimeStore } from '../src/storage.js';
import { fingerprint } from '../src/crypto.js';

/** Deliberately small protocol fixture; never reported as Tyaga physics/gameplay. */
export interface TestWorld { x: number; stock: number; done: boolean; changes: number }
export const adapter: GameAdapter<TestWorld> = {
  gameId: 'fixture', rulesVersion: 'fixture@1', contentVersion: 'fixture-content@1', protocolVersion: REALTIME_PROTOCOL,
  physicsBuildHash: 'fixture-no-physics', runtimeArtifactId: 'fixture-runtime@1', serializerVersion: 'fixture-json@1', botVersion: 'fixture-bot@1', tickRate: 60, snapshotRate: 20,
  create: () => ({ x: 0, stock: 5, done: false, changes: 0 }),
  serialize: world => JSON.stringify(world), restore: value => JSON.parse(value) as TestWorld,
  neutralInput: () => ({ move: 0 }),
  input: value => {
    const move = (value as { move?: unknown })?.move;
    if (typeof move !== 'number' || !Number.isFinite(move) || Math.abs(move) > 1) throw new RealtimeError('INVALID_INPUT');
    return { move };
  },
  step(world, inputs, context) { world.x += Number((inputs.p1 as { move: number }).move) * context.dt; },
  action(world, _actor, raw) {
    const action = raw as { type: string };
    if (action.type === 'spend') { if (!world.stock) throw new RealtimeError('EMPTY'); world.stock -= 1; world.changes += 1; }
    else if (action.type === 'save') return { result: { ok: true }, checkpointId: 'camp' };
    else if (action.type === 'rewind') return { result: { ok: true }, rewindTo: 'camp' };
    else if (action.type === 'finish') world.done = true;
    else throw new RealtimeError('INVALID_ACTION');
    return { result: { ok: true, stock: world.stock } };
  },
  view: world => ({ ...world, map: { id: 'static-map', points: Array.from({ length: 100 }, (_, index) => index) } }),
  outcome: world => world.done ? { won: true } : null,
};
export const request = (): StartMatchRequest => ({
  startCommandId: 'start-request-1', roomId: 'room1', rulesVersion: adapter.rulesVersion, contentVersion: adapter.contentVersion,
  settings: {}, participants: [
    { participantId: 'p1', playerId: 'player1', displayName: 'Player one', seatIndex: 0, controller: { kind: 'human', playerId: 'player1' } },
    { participantId: 'p2', playerId: 'player2', displayName: 'Player two', seatIndex: 1, controller: { kind: 'human', playerId: 'player2' } },
  ],
});
export function claims(matchId: string, now: number, participant = 1): TicketClaims {
  return { issuer: 'iva-platform', audience: 'iva-realtime', keyId: 'test-key', ticketId: randomBytes(24).toString('base64url'),
    playerId: `player${participant}`, participantId: `p${participant}`, matchId, roomId: 'room1', rosterHash: fingerprint(request().participants),
    gameId: adapter.gameId, rulesVersion: adapter.rulesVersion, contentVersion: adapter.contentVersion,
    protocolVersion: REALTIME_PROTOCOL, allowedOrigin: 'http://127.0.0.1:5284', permission: 'play', sessionId: String(participant).repeat(64), issuedAt: now, expiresAt: now + 30_000 };
}
export function keyPair() { return generateKeyPairSync('ed25519'); }
export async function fixture(path = ':memory:', gameAdapter = adapter) {
  const store = new RealtimeStore(path), storage = new LocalStorageClient(store);
  const clock = { wall: 1_800_000_000_000, mono: 1000 };
  const engine = new RealtimeEngine({ storage, adapters: [gameAdapter], ownerId: 'fixture-owner', wallNow: () => clock.wall, monoNow: () => clock.mono });
  await engine.initialize();
  const { matchId } = await engine.create(adapter.gameId, request());
  const tick = async (ms: number) => {
    for (let elapsed = 0; elapsed < ms; elapsed += Math.min(25, ms - elapsed)) {
      const step = Math.min(25, ms - elapsed); clock.wall += step; clock.mono += step; await engine.tick();
    }
  };
  return { store, storage, clock, engine, matchId, tick };
}
