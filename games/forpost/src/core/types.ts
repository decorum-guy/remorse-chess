/** Forpost 0.1 authoritative contracts. Coordinates are metres in the XZ plane. */
export type Team = 'A' | 'B'
export type Side = 'L' | 'R'
export type MapId = 'FP01' | 'FP02' | 'FP03'
export type Weapon = 'carbine' | 'shotgun' | 'rifle'
export type Tool = 'barrier' | 'smoke' | 'repair'
export type BotLevel = 'novice' | 'normal' | 'strong'
export type BuildingKind = 'relay' | 'generator' | 'extractor' | 'turret' | 'dock' | 'battery' | 'post' | 'bridge'
export type Phase = 'preparation' | 'battle' | 'overtime' | 'operationResult' | 'finished'
export type Mode = 'match' | 'training' | 'tutorial'
export interface Point { x: number; z: number }
export interface Rect { x1: number; z1: number; x2: number; z2: number }
export interface MapWall extends Rect { id: string; destructible: boolean }
export interface MapPad extends Point { id: string; side: Side; kind: 'ground' | 'bridge'; rect: Rect; workPoint?: Point }
export interface MapData {
  id: MapId; version: string; name: { ru: string; en: string }; width: number; height: number
  bases: Record<Side, Point>; protected: Record<Side, Rect>; spawns: Record<Side, Point[]>
  depots: Record<Side, Point>; complex: Point; stations: (Point & { id: string })[]
  routes: Record<Side, Record<'N' | 'S', Point[]>>; routeLengths: Record<'N' | 'S', number>
  pads: MapPad[]; water: Rect[]; walls: MapWall[]
}
export interface ParticipantConfig {
  id: string; name: string; team: Team; controller: 'human' | 'bot'; botLevel?: BotLevel
  weapon?: Weapon; tool?: Tool
}
export interface CreateWorldOptions {
  matchId: string; mapId: MapId; teamSize: 1 | 2 | 3; participants: ParticipantConfig[]
  seed: number; mode?: Mode; firstSide?: Side; idSalt?: string
}
export interface Input {
  moveX: number; moveZ: number; aimX: number; aimZ: number; fireHeld: boolean; firePressSeq: number
  toolHeld?: boolean; assist?: boolean; inputSeq?: number
}
export type Order =
  | { type: 'move' | 'guard'; point: Point }
  | { type: 'attack'; targetId: string; lastPoint?: Point; lostAt?: number }
  | { type: 'capture'; stationId: string }
  | { type: 'escort' | 'return' | 'stop' }
export interface Refund { calculated: number; credited: number; lost: number }
type ActionPayload =
  | { type: 'mode'; mode: 'fighter' | 'tactics' }
  | { type: 'loadout'; weapon?: Weapon; tool?: Tool }
  | { type: 'reload' }
  | { type: 'tool'; point?: Point; targetId?: string }
  | { type: 'build'; padId: string; kind: BuildingKind }
  | { type: 'cancelBuild'; orderId: string }
  | { type: 'reorderBuild'; orderIds: string[] }
  | { type: 'resumeBuild' }
  | { type: 'sell' | 'cancelSell'; buildingId: string }
  | { type: 'produceDrone'; buildingId: string }
  | { type: 'cancelDrone'; buildingId: string; orderId: string }
  | { type: 'priority'; buildingIds: string[] }
  | { type: 'order'; unitIds: string[]; order: Order }
  | { type: 'route'; route: 'N' | 'S' }
  | { type: 'respawn'; buildingId: string | null }
  | { type: 'batteryAim'; buildingId: string; direction: Point | null }
  | { type: 'ping'; ping: 'escort' | 'help' | 'build' | 'north' | 'south'; point?: Point }
export type Action = ActionPayload & { actionId?: string }
export interface ActionResult { ok: boolean; code: string; entityId?: string; refund?: Refund }
export interface Participant extends ParticipantConfig {
  botLevel: BotLevel; weapon: Weapon; tool: Tool; mode: 'fighter' | 'tactics'; seat: number
  credits: number; incomeRemainder: number; power: number; powerUsed: number; priority: string[]
  toolReadyTick: number; respawnAt: number; respawnBuildingId: string | null; builderRespawnAt: number
  input: Input; lastInputTick: number; lastConsumedInputSeq: number; consumedFirePressSeq: number
  temporaryBot: boolean; botSinceTick: number; botRandom: number; nextPlanTick: number; aimError: number; aimErrorUntil: number
  pendingLoadout: { weapon: Weapon; tool: Tool; readyTick: number } | null
  repair: { targetId: string; untilTick: number; started: boolean } | null
  builderPaused: boolean
  fighterGeneration: number; builderGeneration: number
  statistics: { damage: number; kills: number; spent: number; income: number; deliveries: number; tacticsTicks: number }
  refunds: (Refund & { tick: number; reason: string })[]
}
export interface Unit extends Point {
  id: string; ownerId: string; team: Team; kind: 'fighter' | 'builder' | 'drone'; generation: number
  hp: number; maxHp: number; radius: number; angle: number; vx: number; vz: number
  lastDamageTick: number; lastAttackerId: string | null; magazine: number; reloadUntil: number
  nextShotExact: number; shotSerial: number; targetId: string | null; targetSinceTick: number
  protectedUntil: number; freshSpawn: boolean; baseHealTicks: number
  order: Order; explicitOrder: boolean; path: Point[]; pathTarget: Point | null; pathVersion: number; pathRetryTick: number
}
export interface BuildOrder { id: string; ownerId: string; padId: string; kind: BuildingKind; createdTick: number; buildingId: string | null }
export interface DroneOrder { id: string; ownerId: string; started: boolean; workTicks: number }
export interface Building extends Point {
  id: string; ownerId: string; team: Team; kind: BuildingKind; padId: string; hp: number; maxHp: number
  createdTick: number; completedTick: number | null; workTicks: number; connected: boolean; powered: boolean
  disabledReason: 'construction' | 'network' | 'power' | null; sellUntil: number | null; lastDamageTick: number
  lastAttackerId: string | null; angle: number; nextShotExact: number; targetId: string | null; targetSinceTick: number
  droneQueue: DroneOrder[]; manualAim: Point | null; suppressed: boolean
}
export interface Transport extends Point {
  id: string; team: Team; route: 'N' | 'S'; side: Side; hp: number; maxHp: number; distance: number; length: number
  angle: number; speed: number; escorted: boolean; unloadTicks: number; lastDamageTick: number
}
export type TransportView = Pick<Transport, 'id' | 'team' | 'route' | 'side' | 'hp' | 'maxHp' | 'distance' | 'length' | 'x' | 'z' | 'angle'> & Partial<Pick<Transport, 'speed' | 'escorted' | 'unloadTicks'>>
export interface Station extends Point { id: string; owner: Team | null; capturing: Team | null; captureTicks: number }
export interface WallState extends MapWall { hp: number; maxHp: number }
export interface Barrier { id: string; ownerId: string; team: Team; a: Point; b: Point; hp: number; expiresTick: number }
export interface Smoke extends Point { id: string; ownerId: string; team: Team; radius: number; expiresTick: number }
export interface TeamState {
  id: Team; side: Side; charge: number; chargeRemainder: number; deliveries: number; wins: number
  nextTransportTick: number; nextRoute: 'N' | 'S'; manualRoute: 'N' | 'S' | null; routeChangedTick: number; routeAuthorId: string | null; humanRouteTick: number
}
export interface OperationResult {
  operation: number; winner: Team | null; reason: 'deliveries' | 'progress' | 'equal' | 'limit'
  deliveries: Record<Team, number>; progress: Record<Team, number>
}
export interface GameEvent {
  seq: number; tick: number; type: string; actorId?: string; targetId?: string; point?: Point; end?: Point
  value?: number; team?: Team; label?: string; sector?: number; proximity?: 'near' | 'far'; muffled?: boolean
  refund?: Refund
}
export interface HistoricalFrame {
  tick: number; units: { id: string; generation: number; x: number; z: number; radius: number; team: Team; protectedUntil?: number }[]
  visible: Record<Team, string[]>; blockers: Rect[]; barriers?: { a: Point; b: Point }[]
}
export interface TutorialState { lesson: number; stage: number; completed: boolean; learnerId: string; targetId: string | null; flags: Record<string, number | boolean>; frozenParticipants: string[] }
export interface TutorialProgress { lesson: number; stage: number; completed: boolean; key: string; focus: Point[]; targetId?: string }
/** Server-only full state. NEVER serialize this into a browser packet. */
export interface World {
  schemaVersion: 1; rulesVersion: 'forpost-0.1'; mapVersion: string; botVersion: 'forpost-bot-0.1'
  matchId: string; mapId: MapId; mode: Mode; teamSize: 1 | 2 | 3; seed: number; nextId: number; idSalt: string
  tick: number; activeTicks: number; phase: Phase; phaseStartTick: number; operation: number; firstSide: Side
  participants: Participant[]; teams: Record<Team, TeamState>; units: Unit[]; buildings: Building[]
  buildOrders: BuildOrder[]; transports: Transport[]; stations: Station[]; walls: WallState[]; barriers: Barrier[]; smokes: Smoke[]
  operations: OperationResult[]; winner: Team | null; resultId: string | null
  events: Record<string, GameEvent[]>; eventSeq: Record<string, number>; memories: Record<Team, Record<string, BuildingMemory>>
  receipts: Record<string, { payload: string; result: ActionResult }>; history: HistoricalFrame[]
  rewindTicks: Record<string, number>; navigationVersion: number; technicalErrors: string[]
  tutorial?: TutorialState
}
export type UnitView = Pick<Unit, 'id' | 'ownerId' | 'team' | 'kind' | 'generation' | 'x' | 'z' | 'hp' | 'maxHp' | 'angle' | 'vx' | 'vz'> & { protected: boolean; weapon?: Weapon } & Partial<Pick<Unit, 'magazine' | 'reloadUntil' | 'order' | 'protectedUntil'>>
export type BuildingView = Pick<Building, 'id' | 'ownerId' | 'team' | 'kind' | 'padId' | 'x' | 'z' | 'hp' | 'maxHp' | 'angle' | 'powered' | 'completedTick' | 'suppressed'> & Partial<Pick<Building, 'createdTick' | 'workTicks' | 'connected' | 'disabledReason' | 'sellUntil' | 'lastDamageTick' | 'droneQueue'>>
export interface BuildingMemory { id: string; kind: BuildingKind; team: Team; ownerId: string; padId: string; x: number; z: number; hp: number; maxHp: number; seenTick: number; stale: true }
export interface ParticipantView {
  id: string; name: string; team: Team; seat: number; controller: 'human' | 'bot'; temporaryBot: boolean; botLevel: BotLevel
  weapon?: Weapon; tool?: Tool; mode?: 'fighter' | 'tactics'; credits?: number; power?: number; powerUsed?: number; toolReadyTick?: number
  respawnAt?: number; respawnBuildingId?: string | null; priority?: string[]; lastConsumedInputSeq?: number; refunds?: Participant['refunds']
  builderPaused?: boolean
  statistics?: Participant['statistics']
}
export type TeamView = Pick<TeamState, 'id' | 'side' | 'deliveries' | 'wins'> & Partial<Pick<TeamState, 'charge' | 'nextTransportTick' | 'nextRoute' | 'manualRoute' | 'routeChangedTick' | 'routeAuthorId'>>
export interface BuildOption { kind: BuildingKind; ok: boolean; code: string; cost: number; workTicks: number; power: number; willBePowered: boolean }
/** This is the sole safe client/bot projection; absent enemies have no placeholders. */
export interface WorldView {
  rulesVersion: World['rulesVersion']; mapVersion: string; matchId: string; mapId: MapId; mode: Mode; teamSize: 1 | 2 | 3
  tick: number; phase: Phase; phaseStartTick: number; phaseRemainingTicks: number; operation: number; you: string; yourTeam: Team
  teams: Record<Team, TeamView>; participants: ParticipantView[]; units: UnitView[]; buildings: BuildingView[]; memories: BuildingMemory[]
  buildOrders: BuildOrder[]; transports: TransportView[]; stations: Station[]; walls: WallState[]
  barriers: (Omit<Barrier, 'ownerId' | 'expiresTick'> & { ownerId?: string; expiresTick?: number })[]; smokes: (Omit<Smoke, 'ownerId' | 'expiresTick'> & { ownerId?: string; expiresTick?: number })[]; publicBridges: string[]
  operations: OperationResult[]; winner: Team | null; resultId: string | null; events: GameEvent[]; buildOptions: Record<string, BuildOption[]>
}
