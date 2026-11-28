import type { BotMemory } from '../bots';
import type { BotTaskKind, ControllerState, EntityKind, GameEvent, GameMode, InventoryView, MapId, Quat, SocketView, TyagaAction, TyagaOutcome, TyagaParticipant, Vec3, WheelView } from '../core/types';
export interface EntityRecord {
  id: string; kind: EntityKind; handle: number; colliders: number[]; size: Vec3; baseMass: number;
  sockets: Omit<SocketView, 'world'>[]; integrity?: number; required: boolean; active: boolean;
  fixed: boolean; folded?: boolean; anchored?: boolean; anchorLimit?: number;
  submergedSeconds: number; lastSafe: Vec3; customModel?: string;
}
export interface CharacterRecord {
  participant: TyagaParticipant; controller: ControllerState; bodyId: string;
  controlling: string | null; holding: { itemId: string; handleId: string; offset: Vec3; since: number; yawTarget?:number } | null;
  heading: number; grounded: boolean; groundBodyId: string | null; safePoint: Vec3; safeTime: number;
  rescueAt: number | null; rescueCooldown: number; stuckFor: number; submergedFor: number;
  seatJoint: number | null; lastPosition: Vec3; jumpTick: number;
  task: { kind: BotTaskKind; targetId?: string; point?: Vec3; status: string; requestedBy?: string; path?: Vec3[]; failures: number; failedAt: number } | null;
  botMemory: BotMemory;
}
export interface LinkRecord {
  id: string; kind: 'strap' | 'rope' | 'deck' | 'ferry-lock' | 'jack';
  fromId: string; fromSocket: string; toId: string; toSocket: string;
  itemId: string | null; jointHandles: number[]; length: number; limit: number; tension: number; overload: number; broken: boolean;
  segments?: { id: string; length: number }[]; trim?: number; spoolMass?: number;
  lastDistance: number; effectiveMass: number; limitForce?: number; collarId?: string; collarJoint?: number; drumJoint?: number; hookId?: string; hookJoint?: number; detached?: boolean;
}
export interface OperationRecord { participantId: string; action: TyagaAction; remaining: number; duration: number; startPosition: Vec3; targetId: string; guideJoint?:number }
export interface VoteRecord { kind: 'checkpoint' | 'rewind' | 'finish'; initiator: string; checkpointId?: string; voters: string[]; yes: string[]; remaining: number; controllerFingerprint: string }
export interface MachineryState {
  ferry: { launched: boolean; driveId: string | null; supportHandles: number[]; operator: string | null; propellerAngle: number } | null;
  lift: { driveId: string | null; targetHeight: number; operator: string | null; guideJoint: number; cableBroken: boolean; catchHeight: number | null; barriers: Record<string,boolean>; driveJoint: number | null; overloadSeconds:number } | null;
  jacks: Record<string,{targetId:string;targetSocket:Vec3;height:number;origin:Vec3}>;
}
export interface GameState {
  schema: number; matchId: string; mapId: MapId; mode: GameMode; tick: number; worldTime: number;
  elapsedSeconds: number; rewinds: number; phase: 'running' | 'voting' | 'failed' | 'finished';
  entities: Record<string,EntityRecord>; characters: Record<string,CharacterRecord>; inventory: Record<string,InventoryView>;
  links: Record<string,LinkRecord>; operations: Record<string,OperationRecord>;
  fixedBodyHandle: number; colliderBodies: Record<string,string>; colliderMaterials: Record<string,string>;
  truck: { driver:string|null;brake:boolean;brakeHolder:string|null; wheels:WheelView[];grips:({supportHandle:number|null;point:Vec3}|null)[]; engineSubmerged:number };
  vote: VoteRecord|null; voteCooldown:number; checkpointId:string; zoneReadySeconds:Record<string,number>;
  outcome:TyagaOutcome|null; events:GameEvent[]; nextEventId:number; nextLinkId:number; machinery:MachineryState;
  contactCooldown:Record<string,number>; previousVelocities:Record<string,Vec3>;
  tutorial:{step:number;completed:boolean;flags:Record<string,number>;stepStartPosition:Vec3;stepStartedAt:number;checkpointDone:boolean};
  initialParticipantIds:string[];pendingCheckpointId:string|null;
}
export interface SavedWorld { schema:1;physicsBuildHash:string;physics:string;state:GameState }
export interface BodyOptions { id:string;kind:EntityKind;position:Vec3;rotation?:Quat;size?:Vec3;mass?:number;fixed?:boolean;required?:boolean;integrity?:number;folded?:boolean;customModel?:string }
