import { describe, expect, it } from 'vitest';
import { createMatch, pointFree, stepMatch, viewForSeat } from '../src/core';
import { advanceWithBots, chooseBotCommands } from '../src/bots';
import type { ArenaId, Seat } from '../src/core';
function roster(n: 2 | 3): Seat[] { return (['teal', 'amber'] as const).flatMap(team => Array.from({ length: n }, (_, i) => ({ seatId: `${team}${i}`, displayName: `${team}${i}`, team, teamIndex: i, initialRole: i === 0 ? 'navigator' as const : 'pilot' as const, bot: true }))); }
describe('ordinary server-policy matches', () => {
  for (const arena of ['foundry', 'calibration', 'depot'] as ArenaId[]) for (const teamSize of [2, 3] as const) it(`${arena} ${teamSize}v${teamSize}: completes normal rounds with actual delivery`, () => {
    const s = createMatch({ arena, teamSize, rotateRoles: true }, roster(teamSize), 73);
    for (let n = 0; n < 18000 && s.phase !== 'finished'; n++) advanceWithBots(s);
    expect(s.phase).toBe('finished');
    expect(s.rounds.length).toBeGreaterThanOrEqual(3);
    expect(s.rounds.filter(r => r.reason === 'delivery').length).toBeGreaterThan(0);
    expect(Object.values(s.stats).reduce((sum, stats) => sum + stats.deliveries, 0)).toBe(s.score.teal + s.score.amber);
    console.log(JSON.stringify({ arena, teamSize, tick: s.tick, score: s.score, rounds: s.rounds, shifts: Object.values(s.stats).reduce((sum, st) => sum + st.shifts, 0) }));
  }, 60000);
  it('recovers a pilot at a legal cover contact before routing to the battery', () => {
    const s = createMatch({ teamSize: 2, arena: 'foundry' }, roster(2)); s.phase = 'active'; s.phaseEndsAtTick = 3000;
    // A human can stop here; a reconnect substitute must escape its planning margin.
    Object.assign(s.actors.teal1, { spaceId: 'O', x: -2.39, z: 0, shieldUntilTick: 0 });
    expect(pointFree('foundry', s.board, s.actors.teal1)).toBe(true);
    for (let tick = 0; tick < 360 && s.battery.carrierId !== 'teal1'; tick++) {
      const commands = chooseBotCommands(viewForSeat(s, 'teal1'), s.botMemory.teal1);
      stepMatch(s, commands.map(command => ({ seatId: 'teal1', command })));
    }
    expect(s.battery.carrierId).toBe('teal1');
  });
  it('does not aim at a hidden enemy from a forbidden full state', () => {
    const s = createMatch({ teamSize: 2 }, roster(2)); s.phase = 'active'; s.phaseEndsAtTick = 3000;
    Object.assign(s.actors.teal1, { spaceId: 'west', x: 0, z: -8 }); Object.assign(s.actors.amber1, { spaceId: 'east', x: 0, z: 8 }); stepMatch(s);
    const view = viewForSeat(s, 'teal1'); expect(view.actors.some(a => a.team === 'amber')).toBe(false);
    const commands = chooseBotCommands(view, s.botMemory.teal1);
    expect(commands.find(c => c.type === 'input')).toHaveProperty('fireHeld', false);
  });
});
