import { describe, expect, it } from 'vitest';
import { connectSeat, createMatch, recoverMatch, stepMatch, TIMING, viewForSeat } from '../src/core';
import type { InputCommand, QueuedCommand, Seat, ShiftState } from '../src/core';
const roster: Seat[] = (['teal', 'amber'] as const).flatMap(team => [0, 1].map(i => ({ seatId: `${team}${i}`, displayName: `${team}${i}`, team, teamIndex: i, initialRole: i === 0 ? 'navigator' : 'pilot', bot: false })));
function match(): ShiftState {
  const s = createMatch({ arena: 'foundry', teamSize: 2 }, roster);
  for (const seat of s.seats) connectSeat(s, seat.seatId);
  s.phase = 'active'; s.tick = 211; s.phaseEndsAtTick = s.tick + TIMING.round;
  for (const actor of Object.values(s.actors)) actor.shieldUntilTick = 0;
  return s;
}
const command = (s: ShiftState, seatId: string, payload: Record<string, unknown>): QueuedCommand => ({ seatId, command: { roundId: s.round, controllerEpoch: s.actors[seatId].controllerEpoch, ...payload } as QueuedCommand['command'] });
function input(s: ShiftState, values: Partial<InputCommand> = {}): QueuedCommand { return command(s, 'teal1', { type: 'input', seq: s.actors.teal1.lastAcceptedSeq + 1, moveX: 0, moveZ: 0, aim: -Math.PI / 2, fireHeld: false, ...values }); }
function finishRound(s: ShiftState): void { s.phaseEndsAtTick = s.tick + 1; stepMatch(s); }
function carryEnemy(s: ShiftState): void { const a = s.actors.amber1; s.battery = { mode: 'carried', carrierId: a.seatId, spaceId: a.spaceId, x: a.x, z: a.z, returnAtTick: null }; }

describe('permitted round recap', () => {
  it('keeps opening key events after a long exchange and records the actual room ride in world coordinates', () => {
    const s = match(); Object.assign(s.actors.teal1, { spaceId: 'O', x: 0, z: -2 });
    stepMatch(s, [command(s, 'teal0', { type: 'shift', actionId: 'opening-ride', roomId: 'O', expectedBoardRevision: s.boardRevision })]);
    for (let tick = 0; tick < 1150; tick++) stepMatch(s, [input(s, { fireHeld: true })]);
    const live = viewForSeat(s, 'teal0');
    expect(live.roundRecap).toBeUndefined();
    expect(live.events.some(e => e.kind === 'shift-start')).toBe(false);
    finishRound(s);
    const recap = viewForSeat(s, 'teal0').roundRecap!;
    expect(recap.events.some(e => e.kind === 'shift-start' && e.roomId === 'O')).toBe(true);
    expect(recap.events.every(e => e.id.startsWith('v:teal:'))).toBe(true);
    expect(recap.events.some(e => e.kind === 'shot' || e.kind === 'hit')).toBe(false);
    const points = recap.batteryTrace.filter(p => !p.gap);
    expect(points[0]).toMatchObject({ worldX: 8, worldZ: 8 });
    expect(points.at(-1)).toMatchObject({ worldX: 8, worldZ: 16 });
    expect(points.some(p => p.worldZ > 8 && p.worldZ < 16)).toBe(true);
  });

  it('does not distinguish two unseen carrier rooms during intermission', () => {
    const a = match(); Object.assign(a.actors.teal1, { spaceId: 'west', x: 0, z: -8 }); Object.assign(a.actors.amber1, { spaceId: 'O', x: 0, z: 0 }); carryEnemy(a);
    const b = structuredClone(a); Object.assign(b.actors.amber1, { spaceId: 'G', x: 0, z: 0 }); carryEnemy(b);
    finishRound(a); finishRound(b);
    expect(viewForSeat(a, 'teal0')).toEqual(viewForSeat(b, 'teal0'));
    const gap = viewForSeat(a, 'teal0').roundRecap!.batteryTrace.at(-1)!;
    expect(gap).toMatchObject({ gap: true, reason: 'hidden' });
    expect(gap).not.toHaveProperty('worldX'); expect(gap).not.toHaveProperty('worldZ');
  });

  it('splits a reveal inside a moving room and preserves the same permitted trace through recovery', () => {
    const a = match(); Object.assign(a.actors.teal1, { spaceId: 'O', x: 0, z: 0 }); Object.assign(a.actors.amber1, { spaceId: 'O', x: -3, z: 0 }); carryEnemy(a);
    const b = structuredClone(a); b.actors.amber1.x = 3; carryEnemy(b);
    for (const state of [a, b]) stepMatch(state, [command(state, 'teal0', { type: 'shift', actionId: 'hidden-ride', roomId: 'O', expectedBoardRevision: state.boardRevision })]);
    for (let tick = 0; tick < 4; tick++) { stepMatch(a); stepMatch(b); }
    for (const state of [a, b]) { Object.assign(state.actors.amber1, { x: 0, z: 1 }); stepMatch(state); }
    expect(viewForSeat(a, 'teal0').battery.carrierId).toBe('amber1');
    a.actors.amber1.x = -3; a.actors.amber1.z = 0; b.actors.amber1.x = 3; b.actors.amber1.z = 0;
    for (let tick = 0; tick < 15; tick++) { stepMatch(a); stepMatch(b); }
    finishRound(a); finishRound(b);
    expect(viewForSeat(a, 'teal0')).toEqual(viewForSeat(b, 'teal0'));
    const trace = viewForSeat(a, 'teal0').roundRecap!.batteryTrace;
    expect(trace.filter(p => p.gap)).toHaveLength(2);
    expect(trace.filter(p => !p.gap && p.mode === 'carried')).toHaveLength(1);
    const restored = JSON.parse(JSON.stringify(a)) as ShiftState; recoverMatch(restored);
    for (let tick = 0; tick < TIMING.recovery; tick++) stepMatch(restored);
    expect(restored.tick).toBe(a.tick);
    expect(viewForSeat(restored, 'teal0').roundRecap!.batteryTrace).toEqual(trace);
  });

  it('retains prior round key chains for the final journal without exposing them during play', () => {
    const s = match();
    stepMatch(s, [command(s, 'teal0', { type: 'shift', actionId: 'round-one-key', roomId: 'O', expectedBoardRevision: s.boardRevision })]);
    for (let tick = 0; tick < TIMING.shift; tick++) stepMatch(s);
    finishRound(s);
    for (let tick = 0; tick < TIMING.intermission + TIMING.preparation; tick++) stepMatch(s);
    expect(s.round).toBe(2); expect(viewForSeat(s, 'teal0').journal).toBeUndefined();
    // A final-point fixture uses the real final-tick delivery and projection paths.
    s.score.teal = 2; Object.assign(s.actors.teal0, { spaceId: 'east', x: 0.7, z: 0, chargeTicks: 19 });
    s.battery = { mode: 'carried', carrierId: 'teal0', spaceId: 'east', x: 0.7, z: 0, returnAtTick: null };
    stepMatch(s);
    expect(s.phase).toBe('finished');
    const view = viewForSeat(s, 'teal0');
    expect(view.roundRecap?.round).toBe(2);
    expect(view.journal?.some(e => e.round === 1 && e.kind === 'shift-start')).toBe(true);
    expect(view.journal?.some(e => e.round === 2 && e.kind === 'delivered')).toBe(true);
  });

  it('bounds repeated public actions without silently joining a pruned route', () => {
    const s = match(); Object.assign(s.actors.teal1, { spaceId: 'O', x: 0, z: 0 });
    for (let tick = 0; tick < 650; tick++) stepMatch(s, [command(s, 'teal1', { type: 'interact', actionId: `toggle-${tick}` })]);
    finishRound(s);
    const recap = viewForSeat(s, 'teal0').roundRecap!;
    expect(recap.events.length).toBeLessThanOrEqual(256);
    expect(recap.events.some(e => e.kind === 'pickup' && e.tick === 212)).toBe(true);
    expect(recap.batteryTrace.length).toBeLessThanOrEqual(600);
    expect(recap.batteryTrace.some(p => p.gap && p.reason === 'history-limit')).toBe(true);
  });
});
