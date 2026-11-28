/** Public, renderer-safe data. No Rapier handles, server seeds or account secrets. */
export interface Vec3 { x: number; y: number; z: number }
export interface Quat { x: number; y: number; z: number; w: number }
export type MapId = 'valley' | 'quarry' | 'ridge' | 'tutorial';
export type GameMode = 'expedition' | 'practice' | 'tutorial';
export type MaterialId = 'stone' | 'wood' | 'soil' | 'wet-stone' | 'mud' | 'ice' | 'steel';
export type ItemKind = 'deck' | 'beam' | 'winch' | 'anchor' | 'strap' | 'jack' | 'repair' | 'drive';
export type EntityKind = ItemKind | 'truck' | 'character' | 'generator-large' | 'mast' | 'pump-large' | 'generator' | 'optics' | 'pump' | 'crate' | 'pontoon' | 'ferry-deck' | 'lift' | 'block' | 'ramp' | 'ring' | 'hook' | 'rope-segment' | 'barrier';
export type BotTaskKind = 'follow' | 'carry' | 'hold' | 'winch' | 'secure' | 'drive';
export interface TyagaInput {
  /** World X/Z for walking; UI rotates its screen-relative stick once. */
  moveX: number; moveZ: number; run: boolean;
  /** Independent vehicle axes, positive throttle drives the vehicle's +X. */
  throttle: number; steer: number; brake: boolean;
  /** Positive reels in/raises; negative pays out/lowers. */
  tool: number;
}
export type TyagaAction =
  | { type: 'jump' }
  | { type: 'appearance'; head: 0 | 1; backpack: 0 | 1 }
  | { type: 'interact'; targetId?: string; socketId?: string }
  | { type: 'release' }
  | { type: 'grab'; itemId: string; handleId?: string }
  | { type: 'unpack'; itemId: string; position?: Vec3; angle?: number }
  | { type: 'pack'; itemId: string }
  | { type: 'unfold'; itemId: string }
  | { type: 'rotate'; direction: -1 | 1 }
  | { type: 'attach'; fromId: string; fromSocket: string; toId: string; toSocket: string; itemId?: string; kind?: 'strap' | 'rope' | 'deck' | 'ferry-lock' }
  | { type: 'detach'; connectionId: string; confirm?: boolean }
  | { type: 'anchor'; itemId: string }
  | { type: 'extract'; itemId: string }
  | { type: 'jack'; itemId: string; targetId: string }
  | { type: 'repair'; targetId: string; itemId?: string }
  | { type: 'operate'; targetId: string }
  | { type: 'barrier'; targetId: string; closed: boolean }
  | { type: 'install-drive'; itemId: string; targetId: string }
  | { type: 'remove-drive'; targetId: string }
  | { type: 'launch-ferry' }
  | { type: 'brake'; enabled: boolean }
  | { type: 'rescue' }
  | { type: 'bot-order'; participantId: string; task: BotTaskKind; targetId?: string; point?: Vec3 }
  | { type: 'checkpoint'; checkpointId?: string }
  | { type: 'rewind' }
  | { type: 'finish' }
  | { type: 'vote'; yes: boolean }
  | { type: 'cancel' }
  | { type: 'end-attempt' }
  | { type: 'tutorial-retry' }
  | { type: 'tutorial-skip' };

export interface TyagaParticipant {
  participantId: string; displayName: string; seatIndex: number;
  bot: boolean; botProfile?: 'helper' | 'driver'; appearance?: { head: 0 | 1; backpack: 0 | 1 };
}
export interface ControllerState {
  participantId: string; kind: 'human' | 'bot'; connected: boolean; controllerGeneration: number;
}
export interface SocketView {
  id: string; local: Vec3; world: Vec3;
  role: 'handle' | 'ring' | 'cab' | 'crate' | 'control' | 'lock' | 'drive';
  occupiedBy?: string;
}
export interface EntityView {
  id: string; kind: EntityKind; model: string; name: { ru: string; en: string };
  position: Vec3; rotation: Quat; size: Vec3; velocity: Vec3; angularVelocity: Vec3;
  mass: number; integrity?: number; required?: boolean; active: boolean;
  sockets: SocketView[]; participantId?: string; seatIndex?: number; appearance?: { head: 0 | 1; backpack: 0 | 1 };
  animation?: 'idle' | 'walk' | 'run' | 'jump' | 'fall' | 'land' | 'carry' | 'push' | 'hold' | 'crank' | 'repair' | 'driver' | 'stumble';
  state?: string; material?: MaterialId; mechanism?: { drumAngle?: number; crankAngle?: number; piston?: number; propellerAngle?: number; steer?: number };
}
export interface Surface {
  id: string; position: Vec3; rotation: Quat; size: Vec3; material: MaterialId;
  kind: 'road' | 'pad' | 'pillar' | 'rock' | 'step' | 'rail' | 'frame';
  renderModel?: string; renderPosition?: Vec3;
  mesh?: { vertices: number[]; indices: number[] };
}
export interface WaterVolume { id: string; min: Vec3; max: Vec3; baseLevel: number; amplitude: number; period: number; flow: Vec3 }
export interface AnchorDefinition { id: string; position: Vec3; limit: number; ground?: boolean; mount?: 'deck' }
export interface MapZone { id: string; position: Vec3; size: Vec3; label: { ru: string; en: string } }
export interface RoadNode { id: string; position: Vec3 }
export interface RoadEdge { from: string; to: string; width: number; kind: 'road' | 'walk' | 'jump' | 'bridge' | 'ferry' | 'lift'; bidirectional?: boolean }
export interface RouteDefinition { id: string; name: { ru: string; en: string }; points: Vec3[] }
export interface StartBody { id: string; kind: EntityKind; position: Vec3; rotation?: Quat; size?: Vec3; mass?: number; fixed?: boolean }
export interface TyagaMap {
  id: MapId; version: string; name: { ru: string; en: string }; subtitle: { ru: string; en: string };
  bounds: Vec3; abyssY: number; start: Vec3;
  surfaces: Surface[]; waterVolumes: WaterVolume[]; anchors: AnchorDefinition[];
  checkpoints: MapZone[]; finish: MapZone;
  roadGraph: { nodes: RoadNode[]; edges: RoadEdge[] };
  footGraph: { nodes: RoadNode[]; edges: RoadEdge[] };
  routes: RouteDefinition[];
  cargo: [EntityKind, EntityKind, EntityKind];
  tools: Record<Exclude<ItemKind, 'drive'>, number>;
  startBodies: StartBody[];
  windProfile: { base: number; gust: number; period: number; duration: number; warning: number; firstCalm: number; direction: Vec3 } | null;
  bridges: { id: string; centers: Vec3[]; length: number; width: number }[];
}
export interface InventoryView { id: string; kind: ItemKind; name: { ru: string; en: string }; mass: number; state: 'stored' | 'world' | 'attached' | 'destroyed'; bodyId?: string }
export interface ConnectionView {
  id: string; kind: 'strap' | 'rope' | 'deck' | 'ferry-lock' | 'jack';
  fromId: string; fromSocket: string; toId: string; toSocket: string;
  points: Vec3[]; length: number; tension: number; limit: number; broken: boolean; itemId?:string; hookId?:string; detached?:boolean;
}
export interface ParticipantView extends TyagaParticipant {
  controller: 'human' | 'bot'; connected: boolean;
  entityId: string; controlling: string | null; holding: string | null;
  gripHeight?: number;
  task?: { kind: BotTaskKind; targetId?: string; point?: Vec3; status: string; requestedBy?: string };
  rescueIn?: number;
}
export interface WheelView { position: Vec3; suspension: number; rotation: number; steer: number; grounded: boolean }
export interface OperationView { participantId: string; type: string; targetId: string; progress: number; duration: number }
export interface InteractionView {
  id: string; label: { ru: string; en: string }; action: TyagaAction;
  enabled: boolean; reason?: { ru: string; en: string };
  targetId?: string; distance?: number;
}
export interface GameEvent { id: number; type: string; tick: number; entityId?: string; participantId?: string; amount?: number; message?: { ru: string; en: string } }
export interface VoteView {
  kind: 'checkpoint' | 'rewind' | 'finish'; initiator: string; checkpointId?: string;
  voters: string[]; yes: string[]; remainingSeconds: number;
}
export interface TyagaOutcome {
  outcomeId: string; success: boolean; mapId: MapId; mode: GameMode; elapsedSeconds: number; rewinds: number;
  cargo: { id: string; kind: EntityKind; integrity: number }[]; truckIntegrity: number;
  careful: boolean; noRewinds: boolean;
}
export interface TutorialView { step: number; total: number; completed: boolean; title: { ru: string; en: string }; instruction: { ru: string; en: string }; targetId?: string }
export interface TyagaView {
  gameId: 'tyaga'; rulesVersion: string; contentVersion: string;
  mapId: MapId; mode: GameMode; tick: number; phase: 'running' | 'voting' | 'failed' | 'finished';
  elapsedSeconds: number; rewinds: number; participantId: string;
  entities: EntityView[]; participants: ParticipantView[]; connections: ConnectionView[];
  inventory: InventoryView[]; operations: OperationView[]; interactions: InteractionView[]; events: GameEvent[];
  truck: { integrity: number; speed: number; load: number; capacity: number; brake: boolean; brakeHolder: string | null; driver: string | null; wheels: WheelView[] };
  machinery: { ferry?:{payload:number;capacity:number;draft:number;heel:number;speed:number;launched:boolean;driveId:string|null}; lift?:{payload:number;capacity:number;height:number;speed:number;cableBroken:boolean;driveId:string|null} };
  weather: { waterLevel: number | null; wind: Vec3; gust: boolean; warning: boolean };
  checkpoint: { id: string; ready: boolean; reason: { ru: string; en: string }; nextId?: string; leftBehind: number };
  finishReady: boolean; finishReason: { ru: string; en: string };
  vote: VoteView | null; outcome: TyagaOutcome | null; tutorial: TutorialView | null;
  /** Static render/collision data is public and content-versioned. */
  map: TyagaMap;
}
export interface ActionResult { result: { ok: boolean; code: string; message: { ru: string; en: string } }; checkpointId?: string; rewindTo?: string }
export interface WorldOptions { matchId: string; mapId: MapId; mode?: GameMode; participants: TyagaParticipant[] }
