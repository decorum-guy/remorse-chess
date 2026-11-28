import { describe, expect, it } from 'vitest';
import { V } from '../src/core/math';
import { TyagaWorld } from '../src/server-world/world';
import { evidence } from './evidence';

async function failedRescueFixture(twoHumans = false) {
  const world = await TyagaWorld.create({
    matchId: 'R04-failed-rescue', mapId: 'quarry', mode: 'expedition',
    participants: [
      { participantId: 'alice', displayName: 'Alice', seatIndex: 0, bot: false },
      { participantId: 'bob', displayName: 'Bob', seatIndex: 1, bot: !twoHumans },
    ],
  });
  const start = world.serialize();
  // The explicit fixture reproduces the observed ordering: a falling player
  // starts personal rescue, then required cargo is lost before rescue ends.
  // Production physics determines rescue and failure; neither flag is assigned.
  world.body('person:alice').setTranslation(V(50, world.map.abyssY - .2, 85), true);
  if (twoHumans) world.body('person:bob').setTranslation(V(52, world.map.abyssY - .2, 85), true);
  world.step();
  expect(world.state.phase).toBe('running');
  expect(world.state.characters.alice.rescueAt).not.toBeNull();
  expect(world.action('alice', { type: 'jump' }).result.code).toBe('BUSY');
  for (const link of Object.values(world.state.links)) {
    if (link.fromId === 'cargo-1' || link.toId === 'cargo-1') world.detachLink(link.id);
  }
  world.body('cargo-1').setTranslation(V(58, world.map.abyssY - 3, 85), true);
  world.step();
  expect(world.state.phase).toBe('failed');
  expect(world.state.characters.alice.rescueAt).not.toBeNull();
  return { world, start };
}

describe('R04 failure during personal rescue (isolated regression, not browser acceptance)', () => {
  it('permits a solo rewind while the personal rescue timer is frozen', async () => {
    const { world, start } = await failedRescueFixture();
    let restored: TyagaWorld | undefined;
    try {
      const failedTick = world.state.tick, failedWorldTime = world.state.worldTime;
      const rescueBefore = world.view('alice').participants[0].rescueIn;
      for (let i = 0; i < 180; i++) world.step();
      expect(world.state.tick).toBe(failedTick);
      expect(world.state.worldTime).toBe(failedWorldTime);
      expect(world.view('alice').participants[0].rescueIn).toBe(rescueBefore);
      const rewind = world.action('alice', { type: 'rewind' });
      expect(rewind.result.ok).toBe(true);
      expect(rewind.rewindTo).toBe('start');
      restored = await TyagaWorld.restore(start);
      restored.afterRewind({ attempt: 1, elapsedSeconds: 3 });
      expect(restored.state.phase).toBe('running');
      expect(restored.state.characters.alice.rescueAt).toBeNull();
      expect(restored.state.rewinds).toBe(1);
      evidence('R04-failure-rescue-rewind', { failedTick, failedWorldTime, rescueBefore, rewind, restoredPhase: restored.state.phase, rewinds: restored.state.rewinds });
    } finally { restored?.dispose(); world.dispose(); }
  });

  it.each(['decline', 'timeout'] as const)('keeps a failed crew able to vote again after %s', async (cancellation) => {
    const { world } = await failedRescueFixture(true);
    try {
      const tick = world.state.tick, worldTime = world.state.worldTime;
      expect(world.action('alice', { type: 'rewind' }).result.ok).toBe(true);
      expect(world.state.vote?.voters).toEqual(['alice', 'bob']);
      if (cancellation === 'decline') expect(world.action('bob', { type: 'vote', yes: false }).result.ok).toBe(true);
      else for (let i = 0; i < 1801; i++) world.step();
      expect(world.state.phase).toBe('failed');
      expect(world.state.vote).toBeNull();
      expect(world.action('alice', { type: 'rewind' }).result.code).toBe('VOTE_COOLDOWN');
      for (let i = 0; i < 901; i++) world.step();
      expect(world.state.tick).toBe(tick);
      expect(world.state.worldTime).toBe(worldTime);
      expect(world.action('alice', { type: 'rewind' }).result.ok).toBe(true);
      const accepted = world.action('bob', { type: 'vote', yes: true });
      expect(accepted.result.ok).toBe(true);
      expect(accepted.rewindTo).toBe('start');
      evidence(`R04-failure-rescue-vote-${cancellation}`, { tick, worldTime, accepted, events: world.state.events });
    } finally { world.dispose(); }
  });

  it('lets the host end a failed attempt during rescue without bypassing host ownership', async () => {
    const { world } = await failedRescueFixture(true);
    try {
      expect(world.action('bob', { type: 'end-attempt' }).result.code).toBe('HOST_ONLY');
      const ended = world.action('alice', { type: 'end-attempt' });
      expect(ended.result.ok).toBe(true);
      expect(world.state.phase).toBe('finished');
      expect(world.state.outcome?.success).toBe(false);
      evidence('R04-failure-rescue-end-attempt', { ended, outcome: world.state.outcome });
    } finally { world.dispose(); }
  });
});
