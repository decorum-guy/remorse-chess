/** Authoritative, JSON-serializable Shift rules. Coordinates are metres; north is -Z. */
export const RULES_VERSION = 'shift@1';
export const CONTENT_VERSION = 'shift-content@1';
export const WIRE_VERSION = 'shift-wire@1';
export const BOT_VERSION = 'shift-bot@1';
export const TICK_RATE = 30;
export type TeamId = 'teal' | 'amber';
export type Role = 'pilot' | 'navigator';
export type RoomId = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'O';
export type SpaceId = RoomId | 'west' | 'east';
export type ArenaId = 'foundry' | 'calibration' | 'depot';
export type Difficulty = 'easy' | 'normal' | 'hard';
export type Phase = 'prepare' | 'active' | 'intermission' | 'finished';
export type Direction = 'north' | 'east' | 'south' | 'west';
export interface Vec2 { x: number; z: number }
export interface Pose { spaceId: SpaceId; x: number; z: number }
export interface Cover extends Vec2 { width: number; depth: number; height: number; kind: 'crate' | 'pillar' | 'machine' }
export interface Arena { id: ArenaId; title: { ru: string; en: string }; board: (RoomId | null)[]; covers: Record<RoomId, Cover[]>; pathNodes: Record<RoomId, Vec2[]>; spawnPoints: Record<'west' | 'east', Vec2[]>; }
export interface ShiftSettings { arena: ArenaId; teamSize: 2 | 3; rotateRoles: boolean; difficulty: Difficulty; }
export interface Seat { seatId: string; displayName: string; team: TeamId; teamIndex: number; initialRole: Role; bot: boolean; difficulty?: Difficulty; }
export interface ShiftMotion { roomId: RoomId; from: number; to: number; startTick: number; endTick: number; team: TeamId; seatId: string; }
export interface PilotInput { moveX: number; moveZ: number; aim: number; fireHeld: boolean; }
export interface Actor extends Pose { seatId: string; team: TeamId; role: Role; hp: number; aim: number; shieldUntilTick: number; respawnAtTick: number | null; nextShotTick: number; input: PilotInput; lastInputTick: number; lastAcceptedSeq: number; controllerEpoch: number; connected: boolean; disconnectedAtTick: number | null; substitute: boolean; chargeTicks: number; }
export interface Battery { mode: 'pedestal' | 'floor' | 'carried'; spaceId: SpaceId; x: number; z: number; carrierId: string | null; returnAtTick: number | null; }
export interface Stats { deliveries: number; interceptions: number; hits: number; shifts: number; allyTransfers: number; batteryTransfers: number; openedDoors: number; }
export type VisibleStats = Omit<Stats, 'batteryTransfers'> & { batteryTransfers?: number };
export interface Ghost extends Pose { seatId: string; team: TeamId; seenAtTick: number; worldX: number; worldZ: number; }
export interface Ping extends Pose { id: string; seatId: string; team: TeamId; kind: 'shift' | 'look' | 'battery'; roomId?: RoomId; expiresAtTick: number; }
export interface Shot { id: string; seatId: string; from: Vec2; to: Vec2; hit: 'wall' | 'drone' | 'none'; tick: number; }
export interface GameEvent { id: string; tick: number; round: number; kind: 'shift-start' | 'shift-end' | 'shot' | 'hit' | 'down' | 'respawn' | 'pickup' | 'drop' | 'return' | 'delivered' | 'round-end' | 'round-start' | 'match-end' | 'ping' | 'recovery' | 'control'; team?: TeamId; seatId?: string; roomId?: RoomId; pose?: Pose; shot?: Shot; value?: number; reason?: string; }
export type BatteryTracePoint = { tick: number; worldX: number; worldZ: number; mode: Battery['mode']; team?: TeamId; gap?: false } | { tick: number; gap: true; reason: 'hidden' | 'history-limit' };
export interface RoundRecap { round: number; events: GameEvent[]; batteryTrace: BatteryTracePoint[]; }
export interface RoundResult { round: number; winner: TeamId | null; reason: 'delivery' | 'timeout'; ticks: number; }
export type RejectReason = 'PHASE' | 'ROLE' | 'STALE_ROUND' | 'STALE_EPOCH' | 'STALE_SEQUENCE' | 'INVALID_INPUT' | 'INVALID_ACTION' | 'REVISION' | 'MOVING' | 'NOT_ADJACENT' | 'COOLDOWN' | 'REVERSE_LOCK' | 'PRIORITY' | 'DEAD' | 'OUT_OF_REACH' | 'TAKEN' | 'PING_LIMIT' | 'NOT_VISIBLE' | 'ACTION_CONFLICT' | 'UNKNOWN_SEAT';
export interface Receipt { actionId: string; seatId: string; accepted: boolean; tick: number; boardRevision: number; reason?: RejectReason; }
export interface CommandScope { roundId: number; controllerEpoch: number; }
export interface InputCommand extends CommandScope, PilotInput { type: 'input'; seq: number; }
export interface ShiftCommand extends CommandScope { type: 'shift'; actionId: string; roomId: RoomId; expectedBoardRevision: number; }
export interface InteractCommand extends CommandScope { type: 'interact'; actionId: string; }
export interface PingCommand extends CommandScope { type: 'ping'; actionId: string; kind: 'shift' | 'look' | 'battery'; roomId?: RoomId; pose?: Pose; }
export type ShiftCommandPayload = InputCommand | ShiftCommand | InteractCommand | PingCommand;
export interface QueuedCommand { seatId: string; command: ShiftCommandPayload; }
export interface BotMemory { nextDecisionTick: number; target?: Pose; aimUntilTick?: number; seq: number; counter: number; recentRooms: RoomId[]; enemyTargetId?: string; }
export interface ShiftState {
  rulesVersion: typeof RULES_VERSION; contentVersion: typeof CONTENT_VERSION; wireVersion: typeof WIRE_VERSION;
  settings: ShiftSettings; seats: Seat[]; seed: number; tick: number; round: number; phase: Phase; phaseEndsAtTick: number; roundStartedAtTick: number;
  board: (RoomId | null)[]; boardRevision: number; motion: ShiftMotion | null; previousMotion: { roomId: RoomId; untilTick: number } | null;
  priority: TeamId; cooldownUntilTick: Record<TeamId, number>; score: Record<TeamId, number>; actors: Record<string, Actor>; battery: Battery;
  events: GameEvent[]; matchKeyEvents?: Record<string, GameEvent[]>; teamRoundRecaps?: Record<TeamId, RoundRecap>; teamEvents: Record<TeamId, GameEvent[]>; teamEventCounter: Record<TeamId, number>; ghosts: Record<TeamId, Record<string, Ghost>>; visible: Record<TeamId, string[]>;
  pings: Ping[]; pingTicks: Record<string, number[]>; receipts: Record<string, { fingerprint: string; receipt: Receipt }>; stats: Record<string, Stats>;
  rounds: RoundResult[]; winner: TeamId | null; pendingMatchEnd?: boolean; eventCounter: number; recoveryTicksRemaining: number; botMemory: Record<string, BotMemory>;
}
export interface VisibleActor extends Pose { seatId: string; team: TeamId; role: 'pilot'; hp: number; aim: number; shieldUntilTick: number; respawnAtTick: number | null; carrying: boolean; substitute: boolean; chargeTicks: number; }
export interface BatteryView { mode: Battery['mode']; team?: TeamId; spaceId?: SpaceId; x?: number; z?: number; carrierId?: string; returnAtTick?: number | null; }
export interface Door { spaceId: SpaceId; direction: Direction; open: boolean; neighbor: SpaceId | null; x: number; z: number; }
export interface ShiftOption { roomId: RoomId; allowed: boolean; reason?: RejectReason; to: number; doorsAfter: Door[]; }
/** Only this object may cross the server boundary. No raw state is sent to clients or bots. */
export interface ShiftView {
  rulesVersion: typeof RULES_VERSION; contentVersion: typeof CONTENT_VERSION; wireVersion: typeof WIRE_VERSION;
  settings: ShiftSettings; tick: number; round: number; phase: Phase; phaseEndsAtTick: number; recoveryTicksRemaining: number;
  self: { seatId: string; team: TeamId; role: Role; controllerEpoch: number; lastAcceptedSeq: number; connected: boolean; nextRole: Role };
  seats: (Seat & { role: Role; substitute: boolean })[]; board: (RoomId | null)[]; boardRevision: number; motion: ShiftMotion | null; previousMotion: ShiftState['previousMotion'];
  priority: TeamId; cooldownUntilTick: Record<TeamId, number>; score: Record<TeamId, number>; actors: VisibleActor[]; ghosts: Ghost[];
  battery: BatteryView; pings: Ping[]; events: GameEvent[]; journal?: GameEvent[]; roundRecap?: RoundRecap; doors: Door[]; shiftOptions: ShiftOption[]; rounds: RoundResult[]; winner: TeamId | null; stats: Record<string, VisibleStats>; goalSpace: 'west' | 'east';
}
export interface TickResult { receipts: Receipt[]; checkpoint: boolean; events: GameEvent[]; }
