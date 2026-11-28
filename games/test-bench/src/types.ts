import type { Participant } from '@iva-games/session-kit';

export const RULES_VERSION = 'test-bench@1';
export const CONTENT_VERSION = 'test-bench-content@1';
export const WIRE_VERSION = 'test-bench-wire@1';
export const BOT_VERSION = 'test-bench-bot@1';
export const PHYSICS_VERSION = 'test-bench-rapier@1';
export const SNAPSHOT_VERSION = 1;
export const STEP = 1 / 60;
export const RACE_TICKS = 65 * 60;
export type Locale = 'ru' | 'en';
export type Label = { ru: string; en: string };
export type AxleId = 'road' | 'terrain' | 'high';
export type MotorId = 'speed' | 'torque' | 'economy';
export type BatteryId = 'small' | 'large';
export type CargoModuleId = 'platform' | 'cradle' | 'clamp';
export type AuxiliaryId = 'damper-front' | 'damper-rear' | 'ballast' | 'rollbar';
export type PartId = AxleId | MotorId | BatteryId | CargoModuleId | AuxiliaryId;
export const SLOT_IDS = ['front-axle', 'rear-axle', 'motor', 'battery', 'cargo', 'aux-left', 'aux-right'] as const;
export type SlotId = typeof SLOT_IDS[number];
export interface Blueprint {
  'front-axle': AxleId; 'rear-axle': AxleId; motor: MotorId; battery: BatteryId;
  cargo: CargoModuleId; 'aux-left': AuxiliaryId | null; 'aux-right': AuxiliaryId | null;
}
export interface Part {
  id: PartId; name: Label; description: Label; cost: number; mass: number;
  slots: readonly SlotId[]; radius?: number; lateralGrip?: number; longitudinalGrip?: number;
  force?: number; maxSpeed?: number; consumption?: number; capacity?: number;
  shockFactor?: number; tiltLimit?: number;
}
export type PresetId = 'universal' | 'gentle' | 'tractor';
export type TrackId = 'fragile' | 'precision' | 'climb';
export type CargoKind = 'egg' | 'instrument' | 'power-cell';
export interface Vec3 { x: number; y: number; z: number }
export interface Quaternion { x: number; y: number; z: number; w: number }
export interface Gate { id: string; x: number; z: number; width: number }
export interface TrackDefinition {
  id: TrackId; name: Label; description: Label; hazards: Label[];
  mirrored: boolean; width: number; length: number; cargoKind: CargoKind;
  spawn: { x: number; z: number; yaw: number };
  loadingDock: { x: number; z: number; radius: number };
  orderedGates: Gate[];
  unload: { minX: number; maxX: number; minZ: number; maxZ: number };
  restorePads: { x: number; z: number; yaw: number }[];
  ribs: { z: number; height: number; smoothSide: -1 | 1 }[];
  ramp?: { start: number; end: number; height: number; bevel?: number; downStart?: number; downEnd?: number };
  wet?: { minZ: number; maxZ: number; drySide: -1 | 1; dryWidth: number };
}
export interface DriveInput { throttle: number; steering: number; brake: boolean }
export interface WheelState { x: number; y: number; z: number; radius: number; compression: number; steering: number; grounded: boolean }
export interface CarState {
  position: Vec3; rotation: Quaternion; velocity: Vec3; angularVelocity: Vec3;
  yaw: number; speed: number; tilt: number; charge: number; wheels: WheelState[];
}
export type CargoStatus = 'at-dock' | 'secured' | 'loose' | 'broken' | 'deposited';
export interface CargoState {
  id: string; kind: CargoKind; status: CargoStatus; health: number; slot: number;
  position: Vec3; rotation: Quaternion; velocity: Vec3;
}
export type EventKind = 'loaded' | 'picked-up' | 'damaged' | 'lost' | 'broken' | 'gate' | 'restored' | 'delivered' | 'depleted' | 'timeout';
export interface BenchEvent { id: string; tick: number; kind: EventKind; position: Vec3; cargoId?: string; amount?: number; gate?: number; cause?: string }
export interface LaneResult { participantId: string; delivered: number; integrity: number; elapsedTicks: number; resets: number; finished: boolean; place?: number; points?: number }
export interface LaneSnapshot {
  tick: number; trackId: TrackId; mirrored: boolean; blueprint: Blueprint; car: CarState;
  cargo: CargoState[]; gatesPassed: number; resets: number; unloadTicks: number;
  tiltTicks: number; finished: boolean; result: LaneResult | null; events: BenchEvent[];
  interaction: 'load' | 'pickup' | 'slow-down' | 'face-dock' | 'full' | 'empty' | 'none';
  impactWindowStart: number; impactWindowPeak: number; impactWindowDamage: number; impactWindowEjected: boolean; suspensionImpulse: number;
}
export interface LaneCheckpoint extends LaneSnapshot {
  world: string; terrainHandle: number; chassisHandle: number; cargoHandles: Record<string, number>; cargoColliderHandles: Record<string, number>;
}
export type Phase = 'briefing' | 'building' | 'countdown' | 'racing' | 'debrief' | 'finished' | 'recovering';
export interface BuildState { blueprint: Blueprint; previous: Blueprint | null; revision: number; ready: boolean }
export interface StageRecord { stage: number; trackId: TrackId; mirrored: boolean; results: LaneResult[]; blueprints: Record<string, Blueprint>; events: Record<string, BenchEvent[]> }
export interface CupStanding { participantId: string; points: number; delivered: number; integrity: number; elapsedTicks: number; place: number }
export interface BenchState {
  schemaVersion: 1; matchId: string; roomId: string; rulesVersion: string; contentVersion: string;
  wireVersion: string; botVersion: string; physicsVersion: string; seed: number;
  participants: Participant[]; phase: Phase; phaseId: number; phaseEndsAt: number; stage: number;
  tick: number; revision: number; variants: boolean[]; builds: Record<string, BuildState>;
  confirmations: string[]; stages: StageRecord[]; standings: CupStanding[]; lanes: Record<string, LaneCheckpoint>;
  savedAt: number; recovery?: { phase: Exclude<Phase, 'recovering'>; remainingMs: number };
}
export interface BenchView {
  matchId: string; roomId: string; rulesVersion: string; contentVersion: string; physicsVersion: string;
  phase: Phase; phaseId: number; phaseEndsAt: number; serverTime: number; stage: number; tick: number; revision: number; spectatingId: string | null;
  track: TrackDefinition; tracks: TrackDefinition[];
  you: { participantId: string; build: BuildState; edits: number; budget: number; lane: LaneSnapshot | null };
  players: (Participant & { ready: boolean; confirmed: boolean; blueprint: Blueprint | null; lane: LaneSnapshot | null; progress: { gatesPassed: number; finished: boolean; delivered: number; integrity: number } | null })[];
  stages: StageRecord[]; standings: CupStanding[];
}
export type BenchAction =
  | { type: 'confirm'; phaseId: number }
  | { type: 'blueprint'; phaseId: number; blueprint: Blueprint; buildRevision: number }
  | { type: 'ready'; phaseId: number; ready: boolean }
  | { type: 'interact'; phaseId: number }
  | { type: 'restore'; phaseId: number };

export class BenchError extends Error {
  constructor(public readonly code: string, message = code) { super(message); this.name = 'BenchError'; }
}
