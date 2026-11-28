/** Shared diagnostic fixture. It never creates a public room or account. */
import { createHash } from 'node:crypto';
import { createWorld, serializeWorld, setController, stepWorld } from '@iva-games/forpost/core';
import type { StoredMatch } from '../src/store';

export const writerHash = (value: string): string => createHash('sha256').update(value).digest('hex');
export function writerFixture(options: { teamSize?: 1 | 3; advanceTicks?: number; temporaryBot?: boolean } = {}) {
  const teamSize = options.teamSize ?? 3;
  const participants = Array.from({ length: teamSize * 2 }, (_, i) => ({ id: 'fixture-' + i, name: 'Explicit fixture ' + i,
    team: i % 2 ? 'B' as const : 'A' as const, controller: i ? 'bot' as const : 'human' as const, botLevel: 'normal' as const }));
  const world = createWorld({ matchId: 'writer-fixture', mapId: 'FP01', teamSize, participants,
    seed: 5149, mode: 'training', idSalt: 'explicit-writer-fixture-only' });
  if (options.temporaryBot ?? true) setController(world, participants[0].id, 'bot');
  for (let tick = 0; tick < (options.advanceTicks ?? 750); tick++) stepWorld(world);
  const initialWorld = serializeWorld(world), now = Date.now();
  const match: StoredMatch = { matchId: world.matchId, startId: 'writer-fixture-start', fingerprint: 'writer-fixture-fingerprint', roomId: 'writer-fixture-room',
    kind: 'practice', ownerHash: 'writer-fixture-owner', roster: participants.map(p => ({ participantId: p.id, playerId: p.controller === 'human' ? p.id : null,
      displayName: p.name, team: p.team, controller: p.controller })), rosterHash: 'writer-fixture-roster', rulesVersion: 'forpost-0.1', contentVersion: 'forpost-content-1',
    manifest: { diagnostic: 'writer comparison only' }, world: initialWorld, worldHash: writerHash(initialWorld), tick: world.tick, epoch: 1, ownerEpoch: 1,
    journalSeq: 0, controls: {}, phase: 'running', lastHumanAt: now, pausedAt: null, expiresAt: now + 3600_000,
    pendingOutcome: null, outcome: null, countdownUntil: 0, createdAt: now };
  return { world, match, leaseOwner: 'fixture-writer' };
}
