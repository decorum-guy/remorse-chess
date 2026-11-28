import { getArena, ROOM_IDS } from './arenas';
import { correctPose, getDoors, goalPosition, lineOfSight, movePose, rayObstacles, wallFraction, worldPosition, DRONE_RADIUS } from './geometry';
import type { Rect } from './geometry';
import { CONTENT_VERSION, RULES_VERSION, WIRE_VERSION } from './types';
import type { Actor, BatteryTracePoint, BatteryView, GameEvent, InputCommand, InteractCommand, PingCommand, Pose, QueuedCommand, Receipt, RejectReason, Role, RoomId, Seat, ShiftCommand, ShiftCommandPayload, ShiftSettings, ShiftState, ShiftView, Stats, TeamId, TickResult, VisibleActor } from './types';
export const TIMING = { preparation: 210, round: 2250, suddenDeath: 1350, intermission: 240, shift: 17, cooldown: 180, reverseLock: 60, respawn: 78, shield: 36, shot: 11, delivery: 20, batteryReturn: 210, lastSeen: 60, inputTimeout: 8, substitute: 300, recovery: 150 } as const;
const TEAMS: TeamId[] = ['teal', 'amber'];
const RECAP_EVENTS = new Set<GameEvent['kind']>(['round-start', 'shift-start', 'pickup', 'drop', 'return', 'delivered', 'round-end', 'match-end', 'recovery']);
const EMPTY_INPUT = { moveX: 0, moveZ: 0, aim: 0, fireHeld: false };
const zeroStats = (): Stats => ({ deliveries: 0, interceptions: 0, hits: 0, shifts: 0, allyTransfers: 0, batteryTransfers: 0, openedDoors: 0 });
export function normalizeSettings(value: unknown): ShiftSettings {
  const x = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  if (x.arena !== undefined && !['foundry', 'calibration', 'depot'].includes(String(x.arena))) throw new Error('INVALID_ARENA');
  if (x.teamSize !== undefined && x.teamSize !== 2 && x.teamSize !== 3) throw new Error('INVALID_TEAM_SIZE');
  if (x.rotateRoles !== undefined && typeof x.rotateRoles !== 'boolean') throw new Error('INVALID_ROTATION');
  if (x.difficulty !== undefined && !['easy', 'normal', 'hard'].includes(String(x.difficulty))) throw new Error('INVALID_DIFFICULTY');
  return { arena: (x.arena ?? 'foundry') as ShiftSettings['arena'], teamSize: (x.teamSize ?? 2) as 2 | 3, rotateRoles: x.rotateRoles !== false, difficulty: (x.difficulty ?? 'normal') as ShiftSettings['difficulty'] };
}
export function teamGoal(team: TeamId, round: number): 'west' | 'east' { return ((team === 'teal') === (round % 2 === 1)) ? 'west' : 'east'; }
export function roleForSeat(state: Pick<ShiftState, 'seats' | 'round' | 'settings'>, seat: Seat, round = state.round): Role {
  if (!state.settings.rotateRoles) return seat.initialRole;
  const nav = state.seats.find(s => s.team === seat.team && s.initialRole === 'navigator')!;
  return seat.teamIndex === (nav.teamIndex + round - 1) % state.settings.teamSize ? 'navigator' : 'pilot';
}
function emit(state: ShiftState, value: Omit<GameEvent, 'id' | 'tick' | 'round'>, audience: TeamId[] = TEAMS): GameEvent {
  const event: GameEvent = { ...value, id: `e${++state.eventCounter}`, tick: state.tick, round: state.round };
  // Full-match archive is reserved for completed games. Never send it during play.
  state.events.push(event);
  if (state.events.length > 2400) state.events.splice(0, state.events.length - 2400);
  if (RECAP_EVENTS.has(event.kind)) {
    state.matchKeyEvents ??= {};
    const roundEvents = state.matchKeyEvents[state.round] ??= [];
    roundEvents.push(structuredClone(event));
    if (roundEvents.length > 128) roundEvents.splice(16, roundEvents.length - 128);
  }
  for (const team of audience) {
    state.teamEventCounter ??= { teal: 0, amber: 0 };
    const delivered = { ...event, id: `v:${team}:${++state.teamEventCounter[team]}` };
    if (delivered.kind === 'delivered' && delivered.seatId && state.actors[delivered.seatId].team !== team && !state.visible[team].includes(delivered.seatId)) delete delivered.seatId;
    state.teamEvents[team].push(delivered);
    if (state.teamEvents[team].length > 96) state.teamEvents[team].shift();
    const recap = state.teamRoundRecaps?.[team];
    if (recap && RECAP_EVENTS.has(delivered.kind)) {
      recap.events.push(structuredClone(delivered));
      // Preserve the opening decisions as well as the latest chain under spam.
      if (recap.events.length > 256) recap.events.splice(32, recap.events.length - 256);
    }
  }
  return event;
}
function spawnActor(state: ShiftState, actor: Actor): void {
  const side = teamGoal(actor.team, state.round), seat = state.seats.find(s => s.seatId === actor.seatId)!;
  const pilots = state.seats.filter(s => s.team === actor.team && roleForSeat(state, s) === 'pilot').sort((a, b) => a.teamIndex - b.teamIndex);
  const index = Math.max(0, pilots.findIndex(s => s.seatId === seat.seatId));
  const spawn = getArena(state.settings.arena).spawnPoints[side][index];
  actor.spaceId = side; actor.x = spawn.x; actor.z = spawn.z; actor.hp = actor.role === 'pilot' ? 3 : 0;
  actor.aim = side === 'west' ? 0 : Math.PI; actor.shieldUntilTick = state.tick + TIMING.shield; actor.respawnAtTick = null;
  actor.chargeTicks = 0; actor.nextShotTick = state.tick; actor.input = { ...EMPTY_INPUT, aim: actor.aim }; actor.lastInputTick = state.tick;
}
function beginRound(state: ShiftState): void {
  state.pendingMatchEnd = false;
  state.board = [...getArena(state.settings.arena).board]; state.boardRevision++; state.motion = null; state.previousMotion = null;
  state.priority = state.round % 2 === 1 ? 'teal' : 'amber'; state.cooldownUntilTick = { teal: 0, amber: 0 };
  state.battery = { mode: 'pedestal', spaceId: 'O', x: 0, z: 0, carrierId: null, returnAtTick: null };
  state.phase = 'prepare'; state.phaseEndsAtTick = state.tick + TIMING.preparation; state.roundStartedAtTick = state.phaseEndsAtTick;
  state.teamRoundRecaps = { teal: { round: state.round, events: [], batteryTrace: [] }, amber: { round: state.round, events: [], batteryTrace: [] } };
  state.pings = []; state.ghosts = { teal: {}, amber: {} }; state.visible = { teal: [], amber: [] }; state.teamEvents = { teal: [], amber: [] };
  for (const seat of state.seats) { const actor = state.actors[seat.seatId]; actor.role = roleForSeat(state, seat); spawnActor(state, actor); state.botMemory[seat.seatId] = { seq: actor.lastAcceptedSeq, counter: 0, nextDecisionTick: 0, recentRooms: [] }; }
  emit(state, { kind: 'round-start' });
}
export function createMatch(settingsInput: unknown, roster: Seat[], seed = 1): ShiftState {
  const settings = normalizeSettings(settingsInput);
  if (roster.length !== settings.teamSize * 2 || new Set(roster.map(s => s.seatId)).size !== roster.length) throw new Error('INVALID_ROSTER');
  for (const team of TEAMS) {
    const members = roster.filter(s => s.team === team);
    if (members.length !== settings.teamSize || members.filter(s => s.initialRole === 'navigator').length !== 1 || members.some(s => !Number.isInteger(s.teamIndex) || s.teamIndex < 0 || s.teamIndex >= settings.teamSize) || new Set(members.map(s => s.teamIndex)).size !== settings.teamSize) throw new Error('INVALID_TEAM');
  }
  const seats = roster.map(s => ({ ...s })).sort((a, b) => TEAMS.indexOf(a.team) - TEAMS.indexOf(b.team) || a.teamIndex - b.teamIndex);
  const state: ShiftState = {
    rulesVersion: RULES_VERSION, contentVersion: CONTENT_VERSION, wireVersion: WIRE_VERSION, settings, seats, seed: seed >>> 0, tick: 0, round: 1, phase: 'prepare', phaseEndsAtTick: 0, roundStartedAtTick: 0,
    board: [], boardRevision: 0, motion: null, previousMotion: null, priority: 'teal', cooldownUntilTick: { teal: 0, amber: 0 }, score: { teal: 0, amber: 0 }, actors: {}, battery: { mode: 'pedestal', spaceId: 'O', x: 0, z: 0, carrierId: null, returnAtTick: null },
    events: [], teamEvents: { teal: [], amber: [] }, teamEventCounter: { teal: 0, amber: 0 }, ghosts: { teal: {}, amber: {} }, visible: { teal: [], amber: [] }, pings: [], pingTicks: {}, receipts: {}, stats: {}, rounds: [], winner: null, eventCounter: 0, recoveryTicksRemaining: 0, botMemory: {},
  };
  for (const seat of seats) {
    state.actors[seat.seatId] = { seatId: seat.seatId, team: seat.team, role: seat.initialRole, spaceId: teamGoal(seat.team, 1), x: 0, z: 0, hp: 3, aim: 0, shieldUntilTick: 0, respawnAtTick: null, nextShotTick: 0, input: { ...EMPTY_INPUT }, lastInputTick: 0, lastAcceptedSeq: -1, controllerEpoch: 1, connected: seat.bot, disconnectedAtTick: seat.bot ? null : 0, substitute: false, chargeTicks: 0 };
    state.stats[seat.seatId] = zeroStats(); state.pingTicks[seat.seatId] = [];
  }
  beginRound(state); updateVisibility(state); captureRoundRecap(state);
  return state;
}
export function connectSeat(state: ShiftState, seatId: string): number {
  const actor = state.actors[seatId]; if (!actor) throw new Error('UNKNOWN_SEAT');
  actor.controllerEpoch++; actor.connected = true; actor.substitute = false; actor.disconnectedAtTick = null; actor.input = { ...EMPTY_INPUT, aim: actor.aim }; actor.lastInputTick = state.tick; actor.lastAcceptedSeq = -1;
  state.botMemory[seatId] = { seq: -1, counter: 0, nextDecisionTick: state.tick, recentRooms: [] };
  emit(state, { kind: 'control', seatId, team: actor.team }, [actor.team]);
  return actor.controllerEpoch;
}
export function disconnectSeat(state: ShiftState, seatId: string, epoch?: number): void {
  const actor = state.actors[seatId]; if (!actor || (epoch !== undefined && actor.controllerEpoch !== epoch)) return;
  actor.connected = false; actor.disconnectedAtTick = state.tick;
}
export function recoverMatch(state: ShiftState): void {
  if (state.phase === 'finished') return;
  state.recoveryTicksRemaining = TIMING.recovery;
  for (const seat of state.seats) {
    const actor = state.actors[seat.seatId]; actor.input = { ...EMPTY_INPUT, aim: actor.aim }; actor.controllerEpoch++; actor.lastAcceptedSeq = -1;
    actor.connected = seat.bot; actor.disconnectedAtTick = seat.bot ? null : state.tick; actor.substitute = false;
  }
  emit(state, { kind: 'recovery' });
}
function fingerprint(command: ShiftCommandPayload): string {
  const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)])) : value;
  return JSON.stringify(stable(command));
}
function receipt(state: ShiftState, seatId: string, command: Exclude<ShiftCommandPayload, InputCommand>, reason?: RejectReason): Receipt {
  const result: Receipt = { actionId: command.actionId, seatId, accepted: !reason, tick: state.tick, boardRevision: state.boardRevision, ...(reason ? { reason } : {}) };
  state.receipts[seatId + ':' + command.actionId] = { fingerprint: fingerprint(command), receipt: result };
  return result;
}
function commandScope(state: ShiftState, actor: Actor | undefined, command: ShiftCommandPayload): RejectReason | undefined {
  if (!actor) return 'UNKNOWN_SEAT';
  if (command.controllerEpoch !== actor.controllerEpoch) return 'STALE_EPOCH';
  if (command.roundId !== state.round) return 'STALE_ROUND';
  if (state.phase !== 'active' || state.recoveryTicksRemaining > 0) return 'PHASE';
  return undefined;
}
export function shiftReason(state: Pick<ShiftState, 'phase' | 'tick' | 'recoveryTicksRemaining' | 'motion' | 'cooldownUntilTick' | 'previousMotion' | 'board'>, team: TeamId, roomId: RoomId): RejectReason | undefined {
  if (state.phase !== 'active' || state.recoveryTicksRemaining > 0) return 'PHASE';
  if (state.motion) return 'MOVING';
  if (state.cooldownUntilTick[team] > state.tick) return 'COOLDOWN';
  if (state.previousMotion?.roomId === roomId && state.previousMotion.untilTick > state.tick) return 'REVERSE_LOCK';
  const from = state.board.indexOf(roomId), to = state.board.indexOf(null);
  if (from < 0 || Math.abs(from % 3 - to % 3) + Math.abs(Math.floor(from / 3) - Math.floor(to / 3)) !== 1) return 'NOT_ADJACENT';
  return undefined;
}
function acceptShift(state: ShiftState, actor: Actor, command: ShiftCommand): void {
  const from = state.board.indexOf(command.roomId), to = state.board.indexOf(null);
  const oldDoors = new Set(getDoors(state.board).filter(d => d.open && d.neighbor).map(d => [d.spaceId, d.neighbor].sort().join(':')));
  const changedBoard = [...state.board]; changedBoard[from] = null; changedBoard[to] = command.roomId;
  const newDoors = new Set(getDoors(changedBoard).filter(d => d.open && d.neighbor).map(d => [d.spaceId, d.neighbor].sort().join(':')));
  const opened = [...newDoors].filter(door => !oldDoors.has(door)).length;
  state.motion = { roomId: command.roomId, from, to, startTick: state.tick, endTick: state.tick + TIMING.shift, team: actor.team, seatId: actor.seatId };
  state.boardRevision++; state.cooldownUntilTick[actor.team] = state.tick + TIMING.cooldown; state.priority = actor.team === 'teal' ? 'amber' : 'teal';
  const stats = state.stats[actor.seatId]; stats.shifts++; stats.openedDoors += opened;
  if (Object.values(state.actors).some(a => a.role === 'pilot' && a.hp > 0 && a.team === actor.team && a.spaceId === command.roomId)) stats.allyTransfers++;
  const carrier = state.battery.carrierId ? state.actors[state.battery.carrierId] : null;
  if ((carrier?.spaceId ?? state.battery.spaceId) === command.roomId) stats.batteryTransfers++;
  for (const a of Object.values(state.actors)) if (a.role === 'pilot' && a.hp > 0) Object.assign(a, correctPose(state.settings.arena, state.board, a, state.motion));
  emit(state, { kind: 'shift-start', team: actor.team, seatId: actor.seatId, roomId: command.roomId });
}
function observedBy(state: ShiftState, actor: Actor): TeamId[] { return TEAMS.filter(t => t === actor.team || state.visible[t].includes(actor.seatId)); }
function batteryDrop(state: ShiftState, actor: Actor): void {
  const p = correctPose(state.settings.arena, state.board, actor, state.motion);
  state.battery = { mode: 'floor', ...p, carrierId: null, returnAtTick: state.tick + TIMING.batteryReturn }; actor.chargeTicks = 0;
  // Free battery's module is public; exact position remains in the viewer's battery projection.
  emit(state, { kind: 'drop', team: actor.team, roomId: ROOM_IDS.includes(p.spaceId as RoomId) ? p.spaceId as RoomId : undefined });
}
function updateVisibility(state: ShiftState, obstacles?: Rect[]): void {
  const blocks = obstacles ?? rayObstacles(state.settings.arena, state.board, state.motion, state.tick);
  for (const team of TEAMS) {
    const observers = Object.values(state.actors).filter(a => a.team === team && a.role === 'pilot' && a.hp > 0);
    const visible: string[] = [];
    for (const target of Object.values(state.actors)) if (target.team !== team && target.role === 'pilot' && target.hp > 0) {
      if (observers.some(a => lineOfSight(state.settings.arena, state.board, a, target, state.motion, state.tick, 13, blocks))) {
        visible.push(target.seatId); const w = worldPosition(state.board, target, state.motion, state.tick);
        state.ghosts[team][target.seatId] = { seatId: target.seatId, team: target.team, spaceId: target.spaceId, x: target.x, z: target.z, seenAtTick: state.tick, worldX: w.x, worldZ: w.z };
      }
    }
    state.visible[team] = visible;
    for (const [id, ghost] of Object.entries(state.ghosts[team])) if (state.tick - ghost.seenAtTick >= TIMING.lastSeen) delete state.ghosts[team][id];
  }
}
function finishMatch(state: ShiftState): void {
  state.pendingMatchEnd = false;
  state.phase = 'finished'; state.phaseEndsAtTick = state.tick;
  state.winner = state.score.teal > state.score.amber ? 'teal' : state.score.amber > state.score.teal ? 'amber' : null;
  emit(state, { kind: 'match-end', ...(state.winner ? { team: state.winner } : {}), reason: state.winner ? 'score' : 'draw' });
}
function completeRound(state: ShiftState, winner: TeamId | null): void {
  const reason = winner ? 'delivery' : 'timeout';
  if (winner) state.score[winner]++;
  state.rounds.push({ round: state.round, winner, reason, ticks: Math.max(0, state.tick - state.roundStartedAtTick) });
  emit(state, { kind: 'round-end', ...(winner ? { team: winner } : {}), reason });
  for (const actor of Object.values(state.actors)) actor.input = { ...EMPTY_INPUT, aim: actor.aim };
  const end = state.score.teal >= 3 || state.score.amber >= 3 || (state.round >= 5 && state.score.teal !== state.score.amber) || state.round >= 6;
  if (end && !state.motion) finishMatch(state);
  else {
    // Combat has ended, but an acknowledged room move still reaches its destination.
    // The result waits at most the remaining17 ticks; scores and round time are final.
    state.pendingMatchEnd = end; state.phase = 'intermission';
    state.phaseEndsAtTick = end ? state.motion!.endTick : state.tick + TIMING.intermission;
  }
}
function validateInput(command: InputCommand): boolean {
  return Number.isSafeInteger(command.seq) && command.seq >= 0 && [command.moveX, command.moveZ, command.aim].every(Number.isFinite) && Math.abs(command.moveX) <= 1 && Math.abs(command.moveZ) <= 1 && Math.abs(command.aim) <= Math.PI * 100 && typeof command.fireHeld === 'boolean';
}
function doPing(state: ShiftState, actor: Actor, command: PingCommand): RejectReason | undefined {
  const ticks = state.pingTicks[actor.seatId].filter(t => state.tick - t < 300); state.pingTicks[actor.seatId] = ticks;
  if (ticks.length >= 3) return 'PING_LIMIT';
  let pose: Pose;
  if (command.kind === 'shift' && command.roomId && ROOM_IDS.includes(command.roomId)) pose = { spaceId: command.roomId, x: 0, z: 0 };
  else if (command.kind === 'battery') {
    const b = batteryView(state, actor.team); if (b.spaceId === undefined || b.x === undefined || b.z === undefined) return 'NOT_VISIBLE';
    pose = { spaceId: b.spaceId, x: b.x, z: b.z };
  } else if (command.kind === 'look' && command.pose) {
    pose = command.pose;
    if (![...ROOM_IDS, 'west', 'east'].includes(pose.spaceId) || !Number.isFinite(pose.x) || !Number.isFinite(pose.z) || Math.abs(pose.x) > 4 || Math.abs(pose.z) > 12) return 'INVALID_ACTION';
    const observers = Object.values(state.actors).filter(a => a.team === actor.team && a.role === 'pilot' && a.hp > 0);
    if (!observers.some(a => lineOfSight(state.settings.arena, state.board, a, pose, state.motion, state.tick, 13))) return 'NOT_VISIBLE';
  } else return 'INVALID_ACTION';
  ticks.push(state.tick);
  state.pings.push({ ...pose, id: command.actionId, team: actor.team, seatId: actor.seatId, kind: command.kind, ...(command.kind === 'shift' ? { roomId: command.roomId } : {}), expiresAtTick: state.tick + 120 });
  emit(state, { kind: 'ping', team: actor.team, seatId: actor.seatId, pose: { ...pose }, ...(command.roomId ? { roomId: command.roomId } : {}) }, [actor.team]);
  return undefined;
}
function batteryView(state: ShiftState, team: TeamId, obstacles?: Rect[]): BatteryView {
  const b = state.battery;
  if (b.mode === 'carried') {
    const carrier = state.actors[b.carrierId!];
    if (carrier.team === team || state.visible[team].includes(carrier.seatId)) return { mode: b.mode, team: carrier.team, carrierId: carrier.seatId, spaceId: carrier.spaceId, x: carrier.x, z: carrier.z };
    return { mode: 'carried', team: carrier.team };
  }
  const known: BatteryView = { mode: b.mode, spaceId: b.spaceId, returnAtTick: b.returnAtTick };
  const observers = Object.values(state.actors).filter(a => a.team === team && a.role === 'pilot' && a.hp > 0);
  if (state.phase === 'prepare' || state.phase === 'finished' || observers.some(a => lineOfSight(state.settings.arena, state.board, a, b, state.motion, state.tick, 13, obstacles))) { known.x = b.x; known.z = b.z; }
  return known;
}
/** Persist only observations this team is entitled to remember, in fixed world coordinates. */
function captureRoundRecap(state: ShiftState, obstacles?: Rect[]): void {
  if (!state.teamRoundRecaps) return; // Compatibility with older local checkpoints.
  for (const team of TEAMS) {
    const recap = state.teamRoundRecaps[team], visible = batteryView(state, team, obstacles);
    const last = recap.batteryTrace.at(-1);
    let point: BatteryTracePoint;
    if (visible.spaceId === undefined || visible.x === undefined || visible.z === undefined) {
      if (last?.gap) continue;
      point = { tick: state.tick, gap: true, reason: 'hidden' };
    } else {
      const world = worldPosition(state.board, { spaceId: visible.spaceId, x: visible.x, z: visible.z }, state.motion, state.tick);
      const changedMode = !last || last.gap || last.mode !== visible.mode || last.team !== visible.team;
      if (!changedMode && (state.tick - last.tick < 6 || Math.hypot(last.worldX - world.x, last.worldZ - world.z) < 0.04)) continue;
      point = { tick: state.tick, worldX: world.x, worldZ: world.z, mode: visible.mode, ...(visible.team ? { team: visible.team } : {}) };
    }
    recap.batteryTrace.push(point);
    if (recap.batteryTrace.length > 600) {
      const first = recap.batteryTrace[0], rest = recap.batteryTrace.slice(-598);
      recap.batteryTrace = [first, { tick: rest[0].tick, gap: true, reason: 'history-limit' }, ...rest];
    }
  }
}
export function viewForSeat(state: ShiftState, seatId: string): ShiftView {
  const self = state.actors[seatId]; if (!self) throw new Error('UNKNOWN_SEAT');
  const seat = state.seats.find(s => s.seatId === seatId)!;
  const actors: VisibleActor[] = Object.values(state.actors).filter(a => a.role === 'pilot' && (a.team === self.team || state.visible[self.team].includes(a.seatId))).map(a => ({ seatId: a.seatId, team: a.team, role: 'pilot', spaceId: a.spaceId, x: a.x, z: a.z, hp: a.hp, aim: a.aim, shieldUntilTick: a.shieldUntilTick, respawnAtTick: a.respawnAtTick, carrying: state.battery.carrierId === a.seatId, substitute: a.substitute, chargeTicks: a.chargeTicks }));
  const shiftOptions = ROOM_IDS.map(roomId => {
    const reason = self.role !== 'navigator' ? 'ROLE' as const : shiftReason(state, self.team, roomId), to = state.board.indexOf(null), from = state.board.indexOf(roomId), board = [...state.board];
    board[from] = null; board[to] = roomId;
    return { roomId, allowed: !reason, ...(reason ? { reason } : {}), to, doorsAfter: getDoors(board) };
  });
  return {
    rulesVersion: RULES_VERSION, contentVersion: CONTENT_VERSION, wireVersion: WIRE_VERSION, settings: { ...state.settings }, tick: state.tick, round: state.round, phase: state.phase, phaseEndsAtTick: state.phaseEndsAtTick, recoveryTicksRemaining: state.recoveryTicksRemaining,
    self: { seatId, team: self.team, role: self.role, controllerEpoch: self.controllerEpoch, lastAcceptedSeq: self.lastAcceptedSeq, connected: self.connected, nextRole: roleForSeat(state, seat, state.round + 1) },
    seats: state.seats.map(s => ({ ...s, role: state.actors[s.seatId].role, substitute: state.actors[s.seatId].substitute })), board: [...state.board], boardRevision: state.boardRevision, motion: state.motion ? { ...state.motion } : null, previousMotion: state.previousMotion ? { ...state.previousMotion } : null,
    priority: state.priority, cooldownUntilTick: { ...state.cooldownUntilTick }, score: { ...state.score }, actors, ghosts: Object.values(state.ghosts[self.team]).filter(g => state.tick - g.seenAtTick < TIMING.lastSeen && !state.visible[self.team].includes(g.seatId)).map(g => ({ ...g })),
    battery: batteryView(state, self.team), pings: state.pings.filter(p => p.team === self.team).map(p => ({ ...p })), events: state.teamEvents[self.team].slice(-36).map(e => structuredClone(e)),
    ...((state.phase === 'intermission' || state.phase === 'finished') && state.teamRoundRecaps?.[self.team] ? { roundRecap: structuredClone(state.teamRoundRecaps[self.team]) } : {}),
    ...(state.phase === 'finished' ? { journal: (state.matchKeyEvents ? Object.values(state.matchKeyEvents).flat() : state.events.filter(e => RECAP_EVENTS.has(e.kind))).map(e => structuredClone(e)) } : {}),
    doors: getDoors(state.board, state.motion, state.tick), shiftOptions, rounds: state.rounds.map(r => ({ ...r })), winner: state.winner,
    stats: Object.fromEntries(Object.entries(state.stats).filter(([id]) => state.phase === 'finished' || state.actors[id].team === self.team).map(([id, stats]) => {
      if (state.phase === 'finished') return [id, { ...stats }];
      // A hidden enemy carrier can be inside our selected module. This count is final-only.
      const { batteryTransfers: _privateTransfers, ...publicStats } = stats;
      void _privateTransfers;
      return [id, publicStats];
    })), goalSpace: teamGoal(self.team, state.round),
  };
}
/** Advance exactly one deterministic 1/30 s tick. Incoming commands are serialized together. */
export function stepMatch(state: ShiftState, incoming: QueuedCommand[] = []): TickResult {
  const receipts: Receipt[] = [], startCounter = state.eventCounter;
  const wasRecovery = state.recoveryTicksRemaining > 0;
  if (!wasRecovery && state.phase !== 'finished') state.tick++;
  if (wasRecovery) state.recoveryTicksRemaining--;
  const checkpointTick = state.tick % 60 === 0;
  if (!wasRecovery && state.phase !== 'finished' && state.motion && state.tick >= state.motion.endTick) {
    const m = state.motion; state.board[m.from] = null; state.board[m.to] = m.roomId; state.motion = null; state.boardRevision++; state.previousMotion = { roomId: m.roomId, untilTick: state.tick + TIMING.reverseLock };
    emit(state, { kind: 'shift-end', team: m.team, seatId: m.seatId, roomId: m.roomId });
    updateVisibility(state);
  }
  if (!wasRecovery && state.phase === 'prepare' && state.tick >= state.phaseEndsAtTick) {
    state.phase = 'active'; state.roundStartedAtTick = state.tick; state.phaseEndsAtTick = state.tick + (state.round === 6 ? TIMING.suddenDeath : TIMING.round);
    for (const a of Object.values(state.actors)) { a.shieldUntilTick = state.tick + TIMING.shield; a.lastInputTick = state.tick; }
    emit(state, { kind: 'round-start', reason: 'active' });
  } else if (!wasRecovery && state.phase === 'intermission' && state.tick >= state.phaseEndsAtTick) { if (state.pendingMatchEnd) finishMatch(state); else { state.round++; beginRound(state); } }
  let frameObstacles: Rect[] | undefined;
  const active = state.phase === 'active' && !wasRecovery;
  if (active) {
    if (state.battery.mode === 'floor' && state.battery.returnAtTick !== null && state.tick >= state.battery.returnAtTick) {
      state.battery = { mode: 'pedestal', spaceId: 'O', x: 0, z: 0, carrierId: null, returnAtTick: null }; emit(state, { kind: 'return', roomId: 'O' });
    }
    for (const actor of Object.values(state.actors)) {
      if (actor.role === 'pilot' && actor.respawnAtTick !== null && state.tick >= actor.respawnAtTick) { spawnActor(state, actor); emit(state, { kind: 'respawn', seatId: actor.seatId, team: actor.team }, [actor.team]); }
      if (!actor.connected && actor.disconnectedAtTick !== null && state.tick - actor.disconnectedAtTick >= TIMING.substitute) actor.substitute = true;
    }
  }
  const shifts: { actor: Actor; command: ShiftCommand }[] = [], interactions: { actor: Actor; command: InteractCommand }[] = [], seenThisTick = new Set<string>();
  for (const { seatId, command } of incoming) {
    const actor = state.actors[seatId];
    if (command.type === 'input') {
      if (!active || commandScope(state, actor, command) || actor.role !== 'pilot' || !validateInput(command) || command.seq <= actor.lastAcceptedSeq) continue;
      actor.input = { moveX: command.moveX, moveZ: command.moveZ, aim: command.aim, fireHeld: command.fireHeld }; actor.lastAcceptedSeq = command.seq; actor.lastInputTick = state.tick;
      continue;
    }
    const key = seatId + ':' + command.actionId;
    if (typeof command.actionId !== 'string' || command.actionId.length < 1 || command.actionId.length > 100) { receipts.push({ actionId: String(command.actionId).slice(0, 100), seatId, accepted: false, tick: state.tick, boardRevision: state.boardRevision, reason: 'INVALID_ACTION' }); continue; }
    const cached = state.receipts[key];
    if (cached) { receipts.push(cached.fingerprint === fingerprint(command) ? { ...cached.receipt } : { actionId: command.actionId, seatId, accepted: false, tick: state.tick, boardRevision: state.boardRevision, reason: 'ACTION_CONFLICT' }); continue; }
    if (seenThisTick.has(key)) continue; seenThisTick.add(key);
    const scope = wasRecovery ? 'PHASE' : commandScope(state, actor, command);
    if (scope) { receipts.push(receipt(state, seatId, command, scope)); continue; }
    if (command.type === 'shift') {
      const reason = actor.role !== 'navigator' ? 'ROLE' : command.expectedBoardRevision !== state.boardRevision ? 'REVISION' : !ROOM_IDS.includes(command.roomId) ? 'INVALID_ACTION' : shiftReason(state, actor.team, command.roomId);
      if (reason) receipts.push(receipt(state, seatId, command, reason)); else shifts.push({ actor, command });
    } else if (command.type === 'interact') {
      const reason = actor.role !== 'pilot' ? 'ROLE' : actor.hp <= 0 ? 'DEAD' : undefined;
      if (reason) receipts.push(receipt(state, seatId, command, reason)); else interactions.push({ actor, command });
    } else if (command.type === 'ping') receipts.push(receipt(state, seatId, command, doPing(state, actor, command)));
    else receipts.push(receipt(state, seatId, command, 'INVALID_ACTION'));
  }
  if (active) {
    if (shifts.length) {
      const priority = state.priority;
      shifts.sort((a, b) => Number(b.actor.team === priority) - Number(a.actor.team === priority));
      const winner = shifts[0]; acceptShift(state, winner.actor, winner.command); receipts.push(receipt(state, winner.actor.seatId, winner.command));
      for (const loser of shifts.slice(1)) receipts.push(receipt(state, loser.actor.seatId, loser.command, 'PRIORITY'));
    }
    for (const actor of Object.values(state.actors)) if (actor.role === 'pilot' && actor.hp > 0) {
      if (state.tick - actor.lastInputTick >= TIMING.inputTimeout) actor.input = { ...EMPTY_INPUT, aim: actor.aim };
      const input = actor.input, magnitude = Math.hypot(input.moveX, input.moveZ), speed = state.battery.carrierId === actor.seatId ? 3.6 : 4.6;
      actor.aim = input.aim;
      if (magnitude > 0) Object.assign(actor, movePose(state.settings.arena, state.board, actor, input.moveX / Math.max(1, magnitude) * speed / 30, input.moveZ / Math.max(1, magnitude) * speed / 30, state.motion));
      if (actor.spaceId !== teamGoal(actor.team, state.round)) actor.shieldUntilTick = 0;
    }
    const obstacles = frameObstacles = rayObstacles(state.settings.arena, state.board, state.motion, state.tick);
    updateVisibility(state, obstacles);
    // Interactions share the post-movement world, with nearest-first and rotated seat tie-break.
    const allSeats = state.seats.map(s => s.seatId), rotation = (state.round - 1) % allSeats.length;
    const initialCarrier = state.battery.carrierId;
    const batteryWorld = worldPosition(state.board, state.battery, state.motion, state.tick);
    interactions.sort((a, b) => {
      const aw = worldPosition(state.board, a.actor, state.motion, state.tick), bw = worldPosition(state.board, b.actor, state.motion, state.tick);
      const distance = Math.hypot(aw.x - batteryWorld.x, aw.z - batteryWorld.z) - Math.hypot(bw.x - batteryWorld.x, bw.z - batteryWorld.z);
      return Math.abs(distance) > 1e-8 ? distance : (allSeats.indexOf(a.actor.seatId) - rotation + allSeats.length) % allSeats.length - (allSeats.indexOf(b.actor.seatId) - rotation + allSeats.length) % allSeats.length;
    });
    let interactionUsed = false;
    for (const { actor, command } of interactions) {
      if (interactionUsed) { receipts.push(receipt(state, actor.seatId, command, 'TAKEN')); continue; }
      if (initialCarrier === actor.seatId) { batteryDrop(state, actor); interactionUsed = true; receipts.push(receipt(state, actor.seatId, command)); }
      else if (state.battery.mode !== 'carried' && lineOfSight(state.settings.arena, state.board, actor, state.battery, state.motion, state.tick, 0.9, obstacles)) {
        state.battery.mode = 'carried'; state.battery.carrierId = actor.seatId; state.battery.returnAtTick = null; actor.chargeTicks = 0; interactionUsed = true;
        emit(state, { kind: 'pickup', team: actor.team }); receipts.push(receipt(state, actor.seatId, command));
      } else receipts.push(receipt(state, actor.seatId, command, state.battery.mode === 'carried' ? 'TAKEN' : 'OUT_OF_REACH'));
    }
    const pendingHits: { target: Actor; shooter: Actor }[] = [];
    const aliveAtShots = Object.values(state.actors).filter(a => a.role === 'pilot' && a.hp > 0);
    for (const shooter of aliveAtShots) if (shooter.input.fireHeld && state.tick >= shooter.nextShotTick) {
      shooter.nextShotTick = state.tick + TIMING.shot; shooter.shieldUntilTick = 0;
      const from = worldPosition(state.board, shooter, state.motion, state.tick), far = { x: from.x + Math.cos(shooter.aim) * 12, z: from.z + Math.sin(shooter.aim) * 12 };
      let fraction = wallFraction(from, far, obstacles), target: Actor | null = null;
      for (const enemy of aliveAtShots) if (enemy.team !== shooter.team && !(enemy.spaceId !== shooter.spaceId && (shooter.spaceId === state.motion?.roomId || enemy.spaceId === state.motion?.roomId))) {
        const p = worldPosition(state.board, enemy, state.motion, state.tick), dx = Math.cos(shooter.aim), dz = Math.sin(shooter.aim), along = (p.x - from.x) * dx + (p.z - from.z) * dz;
        const perpendicularSq = (p.x - from.x) ** 2 + (p.z - from.z) ** 2 - along ** 2;
        if (perpendicularSq <= DRONE_RADIUS ** 2 && along >= 0) {
          const f = Math.max(0, along - Math.sqrt(Math.max(0, DRONE_RADIUS ** 2 - perpendicularSq))) / 12;
          if (f <= fraction) { fraction = f; target = enemy; }
        }
      }
      if (target) pendingHits.push({ target, shooter });
      const shot = { id: `s${state.tick}:${shooter.seatId}`, seatId: shooter.seatId, from, to: { x: from.x + (far.x - from.x) * fraction, z: from.z + (far.z - from.z) * fraction }, hit: target ? 'drone' as const : fraction < 1 ? 'wall' as const : 'none' as const, tick: state.tick };
      emit(state, { kind: 'shot', seatId: shooter.seatId, team: shooter.team, shot }, observedBy(state, shooter));
    }
    // All rays exist before any death is applied; reciprocal lethal shots are both effective.
    for (const { target, shooter } of pendingHits) if (target.shieldUntilTick <= state.tick) {
      target.hp--; state.stats[shooter.seatId].hits++;
      emit(state, { kind: 'hit', team: target.team, seatId: target.seatId, value: 1 }, TEAMS.filter(t => t === target.team || (t === shooter.team && state.visible[t].includes(target.seatId))));
    }
    for (const actor of aliveAtShots) if (actor.hp <= 0) {
      actor.hp = 0; actor.respawnAtTick = state.tick + TIMING.respawn; actor.input = { ...EMPTY_INPUT, aim: actor.aim };
      if (state.battery.carrierId === actor.seatId) {
        const killer = pendingHits.find(h => h.target === actor)?.shooter; if (killer) state.stats[killer.seatId].interceptions++;
        batteryDrop(state, actor);
      }
      emit(state, { kind: 'down', seatId: actor.seatId, team: actor.team, pose: { spaceId: actor.spaceId, x: actor.x, z: actor.z } }, observedBy(state, actor));
    }
    const carrier = state.battery.carrierId ? state.actors[state.battery.carrierId] : null;
    for (const actor of Object.values(state.actors)) if (actor !== carrier) actor.chargeTicks = 0;
    if (carrier && carrier.hp > 0) {
      state.battery.spaceId = carrier.spaceId; state.battery.x = carrier.x; state.battery.z = carrier.z;
      const goal = goalPosition(teamGoal(carrier.team, state.round));
      if (carrier.spaceId === goal.spaceId && Math.abs(carrier.x - goal.x) <= 0.8 && Math.abs(carrier.z - goal.z) <= 0.9) carrier.chargeTicks++; else carrier.chargeTicks = 0;
      if (carrier.chargeTicks >= TIMING.delivery) { state.stats[carrier.seatId].deliveries++; emit(state, { kind: 'delivered', team: carrier.team, seatId: carrier.seatId }); completeRound(state, carrier.team); }
    }
    if (state.phase === 'active' && state.tick >= state.phaseEndsAtTick) completeRound(state, null);
    updateVisibility(state, obstacles);
  }
  if (!wasRecovery) captureRoundRecap(state, frameObstacles);
  state.pings = state.pings.filter(p => p.expiresAtTick > state.tick);
  const events = state.events.filter(e => e.id && Number(e.id.slice(1)) > startCounter);
  const critical = events.some(e => !['shot', 'hit', 'ping'].includes(e.kind));
  return { receipts, checkpoint: checkpointTick || critical || receipts.length > 0, events };
}
