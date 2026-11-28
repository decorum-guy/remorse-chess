import { describe, expect, it } from 'vitest';
import { ARENAS, createMatch, connectSeat, disconnectSeat, getDoors, lineOfSight, movePose, pointFree, recoverMatch, stepMatch, TIMING, viewForSeat, worldPosition } from '../src/core';
import type { ArenaId, InputCommand, QueuedCommand, Seat, ShiftState } from '../src/core';
function roster(teamSize: 2 | 3 = 2): Seat[] { return (['teal', 'amber'] as const).flatMap(team => Array.from({ length: teamSize }, (_, i) => ({ seatId: `${team}${i}`, displayName: `${team}${i}`, team, teamIndex: i, initialRole: i === 0 ? 'navigator' as const : 'pilot' as const, bot: false }))); }
function match(arena: ArenaId = 'foundry', size: 2 | 3 = 2): ShiftState {
  const s = createMatch({ arena, teamSize: size, rotateRoles: true }, roster(size));
  for (const seat of s.seats) connectSeat(s, seat.seatId);
  s.phase = 'active'; s.tick = 211; s.phaseEndsAtTick = s.tick + TIMING.round;
  for (const a of Object.values(s.actors)) a.shieldUntilTick = 0;
  return s;
}
const cmd = (s: ShiftState, seatId: string, payload: Record<string, unknown>): QueuedCommand => ({ seatId, command: { roundId: s.round, controllerEpoch: s.actors[seatId].controllerEpoch, ...payload } as QueuedCommand['command'] });
function input(s: ShiftState, seatId: string, values: Partial<InputCommand> = {}): QueuedCommand { return cmd(s, seatId, { type: 'input', seq: s.actors[seatId].lastAcceptedSeq + 1, moveX: 0, moveZ: 0, aim: 0, fireHeld: false, ...values }); }
function carry(s: ShiftState, id: string): void { const a = s.actors[id]; s.battery = { mode: 'carried', carrierId: id, spaceId: a.spaceId, x: a.x, z: a.z, returnAtTick: null }; }
function ticks(s: ShiftState, n: number): void { for (let i = 0; i < n; i++) stepMatch(s); }

describe('authoritative Shift geometry and transport', () => {
  it('ships all three exact starting layouts and clear equal door profiles', () => {
    expect(ARENAS.foundry.board.join(',')).toBe('B,C,D,A,O,E,F,,G');
    expect(ARENAS.calibration.board.join(',')).toBe('F,,G,B,O,D,A,C,E');
    expect(ARENAS.depot.board.join(',')).toBe('A,C,E,F,O,G,B,,D');
    for (const arena of Object.values(ARENAS)) {
      for (const covers of Object.values(arena.covers)) for (const c of covers) { expect(Math.abs(c.x) + c.width / 2).toBeLessThanOrEqual(3.1); expect(Math.abs(c.z) + c.depth / 2).toBeLessThanOrEqual(3.1); }
      for (let hole = 0; hole < 9; hole++) {
        const board = [...arena.board], old = board.indexOf(null); [board[hole], board[old]] = [board[old], board[hole]];
        const doors = getDoors(board);
        expect(doors.filter(d => d.spaceId === 'west' && d.open).length).toBeGreaterThanOrEqual(2);
        expect(doors.filter(d => d.spaceId === 'east' && d.open).length).toBeGreaterThanOrEqual(2);
      }
    }
  });
  it('moves continuously across an open door and preserves the remainder', () => {
    const s = match(); const p = movePose('foundry', s.board, { spaceId: 'A', x: 3.97, z: 0 }, 0.15, 0);
    expect(p.spaceId).toBe('O'); expect(p.x).toBeCloseTo(-3.88, 8);
    const exact = movePose('foundry', s.board, { spaceId: 'A', x: 3.9, z: 0 }, 0.1, 0);
    expect(exact.spaceId).toBe('A'); expect(exact.x).toBeCloseTo(4);
  });
  it('resolves concurrent O/F requests by alternating team priority with no loser cooldown', () => {
    const s = match(); const a = cmd(s, 'teal0', { type: 'shift', actionId: 'o', roomId: 'O', expectedBoardRevision: s.boardRevision });
    const b = cmd(s, 'amber0', { type: 'shift', actionId: 'f', roomId: 'F', expectedBoardRevision: s.boardRevision });
    const result = stepMatch(s, [b, a]);
    expect(s.motion?.roomId).toBe('O'); expect(s.priority).toBe('amber'); expect(s.cooldownUntilTick.amber).toBe(0);
    expect(result.receipts.find(r => r.actionId === 'f')?.reason).toBe('PRIORITY');
    const repeat = stepMatch(s, [a]); expect(repeat.receipts[0]).toEqual(result.receipts.find(r => r.actionId === 'o'));
    expect(s.stats.teal0.shifts).toBe(1); expect(s.stats.teal0.openedDoors).toBe(2);
    ticks(s, 16); expect(s.board[7]).toBe('O'); expect(s.board[4]).toBeNull();
    const reverse = stepMatch(s, [cmd(s, 'amber0', { type: 'shift', actionId: 'reverse', roomId: 'O', expectedBoardRevision: s.boardRevision })]);
    expect(reverse.receipts[0].reason).toBe('REVERSE_LOCK'); expect(s.cooldownUntilTick.amber).toBe(0);
  });
  it('transports ally, enemy and loose battery unchanged in one local space', () => {
    const s = match(); Object.assign(s.actors.teal1, { spaceId: 'O', x: 0.1, z: 1.3 }); Object.assign(s.actors.amber1, { spaceId: 'O', x: -0.2, z: -1.3 });
    s.battery = { mode: 'floor', spaceId: 'O', x: 0.3, z: 0.5, carrierId: null, returnAtTick: s.tick + 210 };
    const old = worldPosition(s.board, s.actors.teal1);
    stepMatch(s, [cmd(s, 'teal0', { type: 'shift', actionId: 'transport', roomId: 'O', expectedBoardRevision: s.boardRevision })]);
    ticks(s, TIMING.shift);
    expect(s.actors.teal1.x).toBe(0.1); expect(s.actors.amber1.z).toBe(-1.3); expect(s.battery.x).toBe(0.3);
    expect(worldPosition(s.board, s.actors.teal1).z - old.z).toBe(8);
    expect(s.stats.teal0.allyTransfers).toBe(1); expect(s.stats.teal0.batteryTransfers).toBe(1);
  });
  it('closes a threshold without moving its last confirmed space to the other room', () => {
    const s = match(); Object.assign(s.actors.teal1, { spaceId: 'O', x: -4, z: 0 }); Object.assign(s.actors.amber1, { spaceId: 'A', x: 3.95, z: 0 });
    stepMatch(s, [cmd(s, 'teal0', { type: 'shift', actionId: 'door', roomId: 'O', expectedBoardRevision: s.boardRevision })]);
    expect(s.actors.teal1.spaceId).toBe('O'); expect(s.actors.teal1.x).toBeCloseTo(-3.72);
    expect(s.actors.amber1.spaceId).toBe('A'); expect(s.actors.amber1.x).toBeCloseTo(3.72);
    expect(getDoors(s.board, s.motion).filter(d => d.spaceId === 'O').every(d => !d.open)).toBe(true);
    expect(movePose('foundry', s.board, s.actors.amber1, 0.15, 0, s.motion).spaceId).toBe('A');
  });
  it('blocks sight and bullets through a moving-room seal while allowing internal shots', () => {
    const s = match(); Object.assign(s.actors.teal1, { spaceId: 'O', x: 0, z: -2 }); Object.assign(s.actors.amber1, { spaceId: 'C', x: 0, z: 2 });
    expect(lineOfSight('foundry', s.board, s.actors.teal1, s.actors.amber1)).toBe(true);
    stepMatch(s, [cmd(s, 'teal0', { type: 'shift', actionId: 'seal', roomId: 'O', expectedBoardRevision: s.boardRevision }), input(s, 'teal1', { aim: -Math.PI / 2, fireHeld: true })]);
    expect(s.actors.amber1.hp).toBe(3); expect(lineOfSight('foundry', s.board, s.actors.teal1, s.actors.amber1, s.motion, s.tick)).toBe(false);
    Object.assign(s.actors.amber1, { spaceId: 'O', x: 0, z: 1 }); s.actors.teal1.nextShotTick = 0;
    stepMatch(s, [input(s, 'teal1', { aim: Math.PI / 2, fireHeld: true })]); expect(s.actors.amber1.hp).toBe(2);
  });
  it('finishes an acknowledged move during intermission after the round timer expires', () => {
    const s = match(); s.phaseEndsAtTick = s.tick + 1;
    stepMatch(s, [cmd(s, 'teal0', { type: 'shift', actionId: 'last-tick-move', roomId: 'O', expectedBoardRevision: s.boardRevision })]);
    expect(s.phase).toBe('intermission'); expect(s.rounds[0].reason).toBe('timeout');
    const roundEndTick = s.tick; ticks(s, TIMING.shift);
    expect(s.tick).toBe(roundEndTick + TIMING.shift); expect(s.motion).toBeNull();
    expect(s.board[7]).toBe('O'); expect(s.board[4]).toBeNull();
    expect(s.events.filter(e => e.kind === 'shift-end')).toHaveLength(1);
    expect(getDoors(s.board).some(d => d.spaceId === 'O' && d.open)).toBe(true);
  });
  it('keeps a final delivery final while the accepted room move settles through recovery', () => {
    const s = match(); s.score.teal = 2; Object.assign(s.actors.teal1, { spaceId: 'west', x: -0.7, z: 0, chargeTicks: 19 }); carry(s, 'teal1');
    stepMatch(s, [cmd(s, 'teal0', { type: 'shift', actionId: 'winning-tick-move', roomId: 'O', expectedBoardRevision: s.boardRevision })]);
    expect(s.score.teal).toBe(3); expect(s.phase).toBe('intermission'); expect(s.pendingMatchEnd).toBe(true);
    const scoredTick = s.tick, roundTime = s.rounds[0].ticks;
    const restored = JSON.parse(JSON.stringify(s)) as ShiftState; recoverMatch(restored); ticks(restored, TIMING.recovery);
    expect(restored.tick).toBe(scoredTick); expect(restored.score.teal).toBe(3);
    ticks(restored, TIMING.shift);
    expect(restored.phase).toBe('finished'); expect(restored.winner).toBe('teal'); expect(restored.motion).toBeNull(); expect(restored.board[7]).toBe('O');
    expect(restored.score.teal).toBe(3); expect(restored.stats.teal1.deliveries).toBe(1); expect(restored.rounds[0].ticks).toBe(roundTime);
    expect(restored.events.filter(e => e.kind === 'match-end')).toHaveLength(1);
  });
  it('preserves moving-room phase and timer through a 5-second recovery freeze', () => {
    const s = match(); stepMatch(s, [cmd(s, 'teal0', { type: 'shift', actionId: 'recovery', roomId: 'O', expectedBoardRevision: s.boardRevision })]); ticks(s, 5);
    const restored = JSON.parse(JSON.stringify(s)) as ShiftState, tick = restored.tick, end = restored.phaseEndsAtTick, moveEnd = restored.motion?.endTick;
    recoverMatch(restored); ticks(restored, 150); expect(restored.tick).toBe(tick); expect(restored.phaseEndsAtTick).toBe(end); expect(restored.motion?.endTick).toBe(moveEnd);
    ticks(restored, 12); expect(restored.motion).toBeNull(); expect(restored.board[7]).toBe('O'); expect(restored.stats.teal0.shifts).toBe(1);
  });
});

describe('combat and battery ordering', () => {
  it('applies both lethal shots from one canonical tick', () => {
    const s = match(); Object.assign(s.actors.teal1, { spaceId: 'O', x: 0, z: -1, hp: 1 }); Object.assign(s.actors.amber1, { spaceId: 'O', x: 0, z: 1, hp: 1 });
    stepMatch(s, [input(s, 'teal1', { aim: Math.PI / 2, fireHeld: true }), input(s, 'amber1', { aim: -Math.PI / 2, fireHeld: true })]);
    expect(s.actors.teal1.hp).toBe(0); expect(s.actors.amber1.hp).toBe(0);
    expect(s.actors.teal1.respawnAtTick).toBe(s.tick + TIMING.respawn);
  });
  it('leaves allies transparent, stops on cover and respects spawn protection until firing', () => {
    const s = match('foundry', 3); Object.assign(s.actors.teal1, { spaceId: 'O', x: 0, z: -2 }); Object.assign(s.actors.teal2, { spaceId: 'O', x: 0, z: -1 }); Object.assign(s.actors.amber1, { spaceId: 'O', x: 0, z: 1 });
    stepMatch(s, [input(s, 'teal1', { aim: Math.PI / 2, fireHeld: true })]); expect(s.actors.teal2.hp).toBe(3); expect(s.actors.amber1.hp).toBe(2);
    Object.assign(s.actors.teal1, { x: -3, z: 0, nextShotTick: 0 }); Object.assign(s.actors.amber1, { x: 3, z: 0 });
    stepMatch(s, [input(s, 'teal1', { fireHeld: true })]); expect(s.actors.amber1.hp).toBe(2);
    Object.assign(s.actors.teal1, { spaceId: 'east', x: -1, z: 0, nextShotTick: 0 }); Object.assign(s.actors.amber1, { spaceId: 'east', x: 1, z: 0, shieldUntilTick: s.tick + 36 });
    stepMatch(s, [input(s, 'teal1', { fireHeld: true })]); expect(s.actors.amber1.hp).toBe(2);
    s.actors.teal1.nextShotTick = 0;
    stepMatch(s, [input(s, 'teal1', { fireHeld: true }), input(s, 'amber1', { aim: Math.PI, fireHeld: true })]); expect(s.actors.amber1.hp).toBe(1);
  });
  it('picks the nearer pilot, safely retries, and returns a dropped battery to the moved pedestal', () => {
    const s = match(); Object.assign(s.actors.teal1, { spaceId: 'O', x: 0, z: -0.7 }); Object.assign(s.actors.amber1, { spaceId: 'O', x: 0, z: 0.3 });
    const a = cmd(s, 'teal1', { type: 'interact', actionId: 'far' }), b = cmd(s, 'amber1', { type: 'interact', actionId: 'near' });
    const r = stepMatch(s, [a, b]); expect(s.battery.carrierId).toBe('amber1'); expect(r.receipts.find(x => x.actionId === 'far')?.reason).toBe('TAKEN');
    stepMatch(s, [b]); expect(s.battery.carrierId).toBe('amber1');
    stepMatch(s, [cmd(s, 'amber1', { type: 'interact', actionId: 'drop' }), cmd(s, 'teal0', { type: 'shift', actionId: 'move', roomId: 'O', expectedBoardRevision: s.boardRevision })]);
    expect(s.battery.mode).toBe('floor'); ticks(s, 210); expect(s.battery.mode).toBe('pedestal'); expect(s.board[7]).toBe('O'); expect(s.battery.spaceId).toBe('O'); expect(s.battery.x).toBe(0);
  });
  it('cancels a last-tick delivery when the carrier is knocked out', () => {
    const s = match(); Object.assign(s.actors.teal1, { spaceId: 'west', x: -0.7, z: 0, hp: 1, chargeTicks: 19 }); Object.assign(s.actors.amber1, { spaceId: 'west', x: 0.7, z: 0 }); carry(s, 'teal1'); s.phaseEndsAtTick = s.tick + 1;
    stepMatch(s, [input(s, 'amber1', { aim: Math.PI, fireHeld: true })]);
    expect(s.score.teal).toBe(0); expect(s.battery.mode).toBe('floor'); expect(s.rounds[0].reason).toBe('timeout');
  });
  it('accepts an intact delivery on the final tick and resets interrupted charging', () => {
    const s = match(); Object.assign(s.actors.teal1, { spaceId: 'west', x: -0.7, z: 0, chargeTicks: 19 }); carry(s, 'teal1'); s.phaseEndsAtTick = s.tick + 1;
    stepMatch(s); expect(s.score.teal).toBe(1); expect(s.rounds[0].reason).toBe('delivery');
    const a = match(); Object.assign(a.actors.teal1, { spaceId: 'west', x: -0.7, z: 1.2, chargeTicks: 12 }); carry(a, 'teal1'); stepMatch(a); expect(a.actors.teal1.chargeTicks).toBe(0);
  });
});

describe('authority, privacy and complete match', () => {
  it('rejects another role, stale board/round/epoch and invalid analog input', () => {
    const s = match(), p = s.actors.teal1, epoch = p.controllerEpoch;
    const wrong = stepMatch(s, [cmd(s, 'teal1', { type: 'shift', actionId: 'pilot', roomId: 'O', expectedBoardRevision: s.boardRevision }), cmd(s, 'teal0', { type: 'shift', actionId: 'stale', roomId: 'O', expectedBoardRevision: 999 }), input(s, 'teal1', { moveX: 99 })]);
    expect(wrong.receipts.map(r => r.reason)).toEqual(['ROLE', 'REVISION']); expect(p.lastAcceptedSeq).toBe(-1);
    connectSeat(s, 'teal1'); const x = p.x;
    stepMatch(s, [input(s, 'teal1', { controllerEpoch: epoch, moveX: 1 })]); expect(p.x).toBe(x);
    const stale = stepMatch(s, [cmd(s, 'teal1', { type: 'interact', actionId: 'oldRound', roundId: 0 })]); expect(stale.receipts[0].reason).toBe('STALE_ROUND');
  });
  it('stops held input at 250ms and replaces disconnected control only at ten seconds', () => {
    const s = match(); Object.assign(s.actors.teal1, { spaceId: 'O', x: 0, z: 0 }); stepMatch(s, [input(s, 'teal1', { moveZ: 1 })]); disconnectSeat(s, 'teal1');
    ticks(s, 8); const z = s.actors.teal1.z; ticks(s, 20); expect(s.actors.teal1.z).toBe(z); expect(s.actors.teal1.substitute).toBe(false);
    ticks(s, 272); expect(s.actors.teal1.substitute).toBe(true); const epoch = connectSeat(s, 'teal1'); expect(s.actors.teal1.substitute).toBe(false); expect(s.actors.teal1.controllerEpoch).toBe(epoch);
  });
  it('removes hidden HP/carry pose, freezes the last spot, and keeps team pings private', () => {
    const s = match(); Object.assign(s.actors.teal1, { spaceId: 'O', x: 0, z: 0 }); Object.assign(s.actors.amber1, { spaceId: 'C', x: 0, z: 2 }); stepMatch(s);
    expect(viewForSeat(s, 'teal0').actors.some(a => a.seatId === 'amber1')).toBe(true);
    Object.assign(s.actors.amber1, { spaceId: 'east', x: 0, z: 10 }); carry(s, 'amber1'); stepMatch(s);
    const v = viewForSeat(s, 'teal0'); expect(v.actors.some(a => a.seatId === 'amber1')).toBe(false); expect(v.battery).toEqual({ mode: 'carried', team: 'amber' });
    expect(v.ghosts[0]).not.toHaveProperty('hp'); const spot = v.ghosts[0].worldX;
    s.actors.amber1.x = 1; stepMatch(s); expect(viewForSeat(s, 'teal0').ghosts[0].worldX).toBe(spot);
    stepMatch(s, [cmd(s, 'teal0', { type: 'ping', kind: 'shift', roomId: 'O', actionId: 'private' })]);
    expect(viewForSeat(s, 'teal1').pings).toHaveLength(1); expect(viewForSeat(s, 'amber1').pings).toHaveLength(0); expect(viewForSeat(s, 'amber1').events.some(e => e.kind === 'ping')).toBe(false);
    ticks(s, 60); expect(viewForSeat(s, 'teal0').ghosts).toHaveLength(0);
  });
  it('rotates roles and sides, stops at three points and has one 45s tiebreaker', () => {
    const s = match('foundry', 3); s.phaseEndsAtTick = s.tick + 1; stepMatch(s); ticks(s, TIMING.intermission);
    expect(s.round).toBe(2); expect(s.actors.teal1.role).toBe('navigator'); expect(s.actors.teal0.role).toBe('pilot'); expect(s.actors.teal0.spaceId).toBe('east');
    for (let round = 2; round <= 6; round++) { ticks(s, TIMING.preparation); expect(s.phaseEndsAtTick - s.tick).toBe(round === 6 ? TIMING.suddenDeath : TIMING.round); s.phaseEndsAtTick = s.tick + 1; stepMatch(s); if (round < 6) ticks(s, TIMING.intermission); }
    expect(s.phase).toBe('finished'); expect(s.winner).toBeNull(); expect(s.rounds).toHaveLength(6);
    const win = match(); win.score.teal = 2; Object.assign(win.actors.teal1, { spaceId: 'west', x: -0.7, z: 0, chargeTicks: 19 }); carry(win, 'teal1'); stepMatch(win); expect(win.phase).toBe('finished'); expect(win.winner).toBe('teal');
  });
  it('replays a recorded input stream exactly and all moved poses remain legal', () => {
    const a = match('depot'), b = JSON.parse(JSON.stringify(a)) as ShiftState;
    for (let t = 0; t < 300; t++) {
      const incoming = [input(a, 'teal1', { moveX: Math.sin(t / 20), moveZ: Math.cos(t / 20), aim: t / 30, fireHeld: t % 2 === 0 })];
      stepMatch(a, incoming); stepMatch(b, incoming);
      expect(pointFree(a.settings.arena, a.board, a.actors.teal1, a.motion)).toBe(true);
    }
    expect(b).toEqual(a);
  });
});
