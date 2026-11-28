import { describe, expect, it } from 'vitest';
import { createMatch, stepMatch, validateArena, viewForSeat } from '../src/core';
import type { ArenaId, Seat } from '../src/core';
describe('exhaustive arena and disclosure validation', () => {
  for (const id of ['foundry', 'calibration', 'depot'] as ArenaId[]) it(`${id}: every reachable board preserves delivery and safe metric door approaches`, () => {
    const result = validateArena(id); expect(result.failures).toEqual([]); expect(result.reachableBoards).toBe(181440); expect(result.shaftCells).toBe(9);
    console.log(JSON.stringify({ validation: result }));
  }, 15000);
  it('does not reveal unseen action counts through gaps in recipient event IDs', () => {
    const seats: Seat[] = (['teal', 'amber'] as const).flatMap(team => [0, 1].map(teamIndex => ({ seatId: `${team}${teamIndex}`, displayName: 'Pilot', team, teamIndex, initialRole: teamIndex === 0 ? 'navigator' : 'pilot', bot: false })));
    const base = createMatch({}, seats); base.phase = 'active'; base.phaseEndsAtTick = 2250;
    Object.assign(base.actors.teal1, { spaceId: 'west', x: -1, z: -8 }); Object.assign(base.actors.amber1, { spaceId: 'east', x: 0, z: 8 });
    const a = structuredClone(base), b = structuredClone(base);
    stepMatch(a, [{ seatId: 'amber1', command: { type: 'input', seq: 1, roundId: 1, controllerEpoch: 1, moveX: 0, moveZ: 0, aim: 0, fireHeld: true } }]); stepMatch(b);
    for (const s of [a, b]) stepMatch(s, [{ seatId: 'teal0', command: { type: 'ping', actionId: 'next-visible', roundId: 1, controllerEpoch: 1, kind: 'shift', roomId: 'O' } }]);
    expect(a.eventCounter).not.toBe(b.eventCounter); expect(viewForSeat(a, 'teal0')).toEqual(viewForSeat(b, 'teal0'));
  });
  it('keeps a hidden delivering carrier anonymous until the full match closes', () => {
    const seats: Seat[] = (['teal', 'amber'] as const).flatMap(team => [0, 1].map(teamIndex => ({ seatId: `${team}${teamIndex}`, displayName: 'Pilot', team, teamIndex, initialRole: teamIndex === 0 ? 'navigator' : 'pilot', bot: false })));
    const s = createMatch({}, seats); s.phase = 'active'; s.phaseEndsAtTick = 2250;
    Object.assign(s.actors.amber1, { spaceId: 'east', x: 0.7, z: 0, chargeTicks: 19 });
    s.battery = { mode: 'carried', carrierId: 'amber1', spaceId: 'east', x: 0.7, z: 0, returnAtTick: null };
    stepMatch(s); const teal = viewForSeat(s, 'teal0'), amber = viewForSeat(s, 'amber0');
    expect(teal.score.amber).toBe(1); expect(teal.events.find(e => e.kind === 'delivered')).not.toHaveProperty('seatId');
    expect(amber.events.find(e => e.kind === 'delivered')?.seatId).toBe('amber1'); expect(teal).not.toHaveProperty('journal');
    s.phase = 'finished'; expect(viewForSeat(s, 'teal0').journal?.find(e => e.kind === 'delivered')?.seatId).toBe('amber1');
  });
  it('does not reveal a hidden enemy carrier through navigator transfer counters', () => {
    const seats: Seat[] = (['teal', 'amber'] as const).flatMap(team => [0, 1].map(teamIndex => ({ seatId: `${team}${teamIndex}`, displayName: 'Pilot', team, teamIndex, initialRole: teamIndex === 0 ? 'navigator' : 'pilot', bot: false })));
    const base = createMatch({}, seats); base.phase = 'active'; base.phaseEndsAtTick = 2250;
    Object.assign(base.actors.teal1, { spaceId: 'west', x: -1, z: -8, shieldUntilTick: 0 });
    const a = structuredClone(base), b = structuredClone(base);
    for (const [s, spaceId] of [[a, 'O'], [b, 'G']] as const) {
      Object.assign(s.actors.amber1, { spaceId, x: 0, z: 0, shieldUntilTick: 0 });
      s.battery = { mode: 'carried', carrierId: 'amber1', spaceId, x: 0, z: 0, returnAtTick: null };
      stepMatch(s, [{ seatId: 'teal0', command: { type: 'shift', actionId: 'blind-shift', roundId: 1, controllerEpoch: 1, roomId: 'O', expectedBoardRevision: s.boardRevision } }]);
    }
    expect(a.stats.teal0.batteryTransfers).toBe(1); expect(b.stats.teal0.batteryTransfers).toBe(0);
    expect(viewForSeat(a, 'teal0')).toEqual(viewForSeat(b, 'teal0'));
    expect(viewForSeat(a, 'teal0').stats.teal0).not.toHaveProperty('batteryTransfers');
    a.phase = 'finished'; expect(viewForSeat(a, 'teal0').stats.teal0.batteryTransfers).toBe(1);
  });
  it('keeps a partially occluded hit recipient out of the shooter event feed', () => {
    const seats: Seat[] = (['teal', 'amber'] as const).flatMap(team => [0, 1].map(teamIndex => ({ seatId: `${team}${teamIndex}`, displayName: 'Pilot', team, teamIndex, initialRole: teamIndex === 0 ? 'navigator' : 'pilot', bot: false })));
    const s = createMatch({}, seats); s.phase = 'active'; s.phaseEndsAtTick = 2250;
    Object.assign(s.actors.teal1, { spaceId: 'O', x: 0, z: 0, shieldUntilTick: 0 }); Object.assign(s.actors.amber1, { spaceId: 'O', x: -2.3, z: 1, shieldUntilTick: 0 });
    stepMatch(s, [{ seatId: 'teal1', command: { type: 'input', seq: 1, roundId: 1, controllerEpoch: 1, moveX: 0, moveZ: 0, aim: Math.atan2(1.24, -2.2), fireHeld: true } }]);
    const v = viewForSeat(s, 'teal1'); expect(s.actors.amber1.hp).toBe(2);
    expect(v.actors.some(a => a.seatId === 'amber1')).toBe(false);
    expect(v.events.some(e => e.kind === 'hit' && e.seatId === 'amber1')).toBe(false);
  });
  it('filters an unseen attack and carrying position during a simultaneous public shift', () => {
    const seats: Seat[] = (['teal', 'amber'] as const).flatMap(team => [0, 1].map(teamIndex => ({ seatId: `${team}${teamIndex}`, displayName: 'Pilot', team, teamIndex, initialRole: teamIndex === 0 ? 'navigator' : 'pilot', bot: false })));
    const s = createMatch({}, seats); s.phase = 'active'; s.phaseEndsAtTick = 2250;
    Object.assign(s.actors.teal1, { spaceId: 'west', x: -1, z: -8, shieldUntilTick: 0 }); Object.assign(s.actors.amber1, { spaceId: 'O', x: 0.12, z: 0.34, shieldUntilTick: 0 });
    s.battery = { mode: 'carried', carrierId: 'amber1', spaceId: 'O', x: 0.12, z: 0.34, returnAtTick: null };
    stepMatch(s, [{ seatId: 'teal0', command: { type: 'shift', actionId: 'show-floor', roundId: 1, controllerEpoch: 1, roomId: 'O', expectedBoardRevision: s.boardRevision } }, { seatId: 'amber1', command: { type: 'input', seq: 1, roundId: 1, controllerEpoch: 1, moveX: 0, moveZ: 0, aim: 0, fireHeld: true } }]);
    const a = viewForSeat(s, 'teal0'), p = viewForSeat(s, 'teal1'), b = viewForSeat(s, 'amber0');
    expect(a.actors).toEqual(p.actors); expect(a.battery).toEqual({ mode: 'carried', team: 'amber' });
    expect(a.events.some(e => e.kind === 'shot')).toBe(false); expect(a.events.some(e => e.kind === 'shift-start')).toBe(true);
    expect(b.events.some(e => e.kind === 'shot')).toBe(true); expect(b.battery.carrierId).toBe('amber1');
    expect(a.actors.some(x => x.seatId === 'amber1')).toBe(false); expect(a.stats.amber1).toBeUndefined();
  });
});
