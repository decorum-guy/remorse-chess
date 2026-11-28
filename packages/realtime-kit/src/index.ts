import type { StartMatchRequest } from '@iva-games/session-kit';
import { projectViewChanges } from './view-projection.mjs';

/** Browser-safe protocol. No game implementation, filesystem, crypto or database is imported. */
export const REALTIME_PROTOCOL = 'iva-realtime@1';
/** RFC 6455 subprotocol tokens cannot contain '@'; JSON version is independent. */
export const REALTIME_SUBPROTOCOL = 'iva-realtime-v1';
export const REALTIME_SOCKET_PATH = '/ws/realtime/v1';
export const INPUT_TIMEOUT_MS = 250;
export const BOT_TAKEOVER_MS = 5_000;
export const EMPTY_PAUSE_MS = 10_000;
export const RETURN_WINDOW_MS = 86_400_000;
export const MAX_FRAME_BYTES = 16_384;
export const ADMISSION_RESERVATION_MS = 15_000;
export type MatchPhase = 'loading' | 'ready' | 'running' | 'paused' | 'recovering' | 'finished' | 'abandoned' | 'failed-recoverable';
export type PauseReason = 'overload' | 'empty' | 'updating' | 'recovery' | 'rewind';
export interface ControllerState {
  participantId: string;
  kind: 'human' | 'bot';
  connected: boolean;
  controllerGeneration: number;
}
export interface StepContext {
  controllers: ControllerState[];
  dt: number;
  elapsedSeconds: number;
  attempt: number;
}
export interface GameActionResult {
  result: unknown;
  /** These are emitted only after game-owned safety checks and unanimous voting. */
  checkpointId?: string;
  rewindTo?: string;
}
export interface GameAdapter<W = unknown> {
  gameId: string;
  rulesVersion: string;
  contentVersion: string;
  protocolVersion: string;
  physicsBuildHash: string;
  runtimeArtifactId: string;
  serializerVersion: string;
  botVersion: string;
  tickRate: number;
  snapshotRate: number;
  /** Optional top-level observer-view fields whose objects never mutate. A new
   * object must be returned if visibility or content changes. They may be sent
   * once per observer/epoch by a trusted worker; never list mutable/private state. */
  immutableViewFields?: readonly string[];
  create(input: StartMatchRequest): W | Promise<W>;
  restore(serialized: string): W | Promise<W>;
  serialize(world: W): string;
  input(payload: unknown): unknown;
  neutralInput(): unknown;
  step(world: W, inputs: Record<string, unknown>, context: StepContext): void;
  /** Game-owned automatic tutorial boundary after a real simulated step. The
   * runtime commits its complete world and clears this signal deterministically. */
  pollCheckpoint?(world: W): string | null;
  action(world: W, participantId: string, payload: unknown): GameActionResult;
  view(world: W, participantId: string): unknown;
  outcome(world: W): unknown | null;
  isSimulating?(world: W): boolean;
  controllersChanged?(world: W, controllers: ControllerState[]): void;
  onRewind?(world: W, meta: { attempt: number; elapsedSeconds: number }): void;
  release?(world: W): void;
}
export interface RuntimeManifest {
  gameId: string;
  rulesVersion: string;
  contentVersion: string;
  protocolVersion: string;
  physicsBuildHash: string;
  runtimeArtifactId: string;
  serializerVersion: string;
  botVersion: string;
  tickRate: number;
  snapshotRate: number;
  clientContentHash?: string;
  clientRoute?: string;
}
export interface TicketClaims {
  issuer: 'iva-platform'; audience: 'iva-realtime'; keyId: string;
  ticketId: string; playerId: string; participantId: string; matchId: string; roomId: string;
  rosterHash: string; gameId: string; rulesVersion: string; contentVersion: string;
  protocolVersion: string; allowedOrigin: string; permission: 'play';
  sessionId: string; issuedAt: number; expiresAt: number;
}
export interface TicketResponse {
  ticket: string;
  websocketPath: typeof REALTIME_SOCKET_PATH;
  protocolVersion: typeof REALTIME_PROTOCOL;
  subprotocol: typeof REALTIME_SUBPROTOCOL;
  expiresAt: number;
  matchId: string;
  participantId: string;
  clientContentHash?: string;
  launchUrl?: string;
}
export interface WireScope {
  protocolVersion: typeof REALTIME_PROTOCOL;
  matchId: string;
  epoch: number;
  controllerGeneration: number;
}
export type ClientMessage = WireScope & (
  | { type: 'input'; inputSeq: number; payload: unknown }
  | { type: 'action'; actionId: string; payload: unknown }
  | { type: 'claimControl'; expectedGeneration: number }
  | { type: 'heartbeat'; nonce: string }
  | { type: 'ackSnapshot'; snapshotSeq: number }
  | { type: 'resync' }
);
export interface Snapshot extends WireScope {
  type: 'full'; snapshotSeq: number; worldTick: number; committedJournalSeq: number; serverTime: number;
  manifest: RuntimeManifest; phase: MatchPhase; participantId: string;
  lastConsumedInputSeq: number; controls: ControllerState[];
  hasControl: boolean; elapsedSeconds: number; attempt: number;
  resumeAt: number | null; returnUntil: number | null;
  outcome: unknown | null; view: unknown;
  pauseReason?: PauseReason | null;
}
export interface ViewChange { path: (string | number)[]; value?: unknown; remove?: true }
export interface DeltaSnapshot extends Omit<Snapshot, 'type' | 'view'> {
  type: 'delta'; baselineSnapshotSeq: number; changes: ViewChange[];
}
export type ServerMessage = Snapshot | DeltaSnapshot | (WireScope & (
  | { type: 'hello'; connectionId: string; participantId: string; hasControl: boolean }
  | { type: 'actionAck'; actionId: string; worldTick: number; committedJournalSeq: number; result: unknown }
  | { type: 'controlChanged'; participantId: string; hasControl: boolean }
  | { type: 'heartbeat'; nonce: string }
  | { type: 'error'; code: string; actionId?: string }
));
export class RealtimeError extends Error {
  constructor(public readonly code: string, public readonly statusCode = 400, public readonly details?: Record<string, string | number>) {
    super(code); this.name = 'RealtimeError';
  }
}
export function identifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._:@-]{1,128}$/.test(value);
}
export function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RealtimeError('INVALID_MESSAGE');
  return value as Record<string, unknown>;
}
export function exactFields(value: Record<string, unknown>, fields: string[]): void {
  if (Object.keys(value).some(key => !fields.includes(key))) throw new RealtimeError('UNKNOWN_FIELD');
}
/** Reject non-JSON values even for in-process callers and bound nesting/collection size. */
export function checkJson(value: unknown, depth = 0): void {
  if (depth > 24) throw new RealtimeError('INVALID_PAYLOAD');
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string' && value.length <= 16_384) return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value) && value.length <= 2048) { value.forEach(item => checkJson(item, depth + 1)); return; }
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    if (Object.keys(value).length > 128) throw new RealtimeError('INVALID_PAYLOAD');
    for (const [key, item] of Object.entries(value)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') throw new RealtimeError('INVALID_PAYLOAD');
      checkJson(item, depth + 1);
    }
    return;
  }
  throw new RealtimeError('INVALID_PAYLOAD');
}
export function parseClientMessage(raw: unknown): ClientMessage {
  const value = object(raw);
  const keys = ['type', 'protocolVersion', 'matchId', 'epoch', 'controllerGeneration'];
  if (value.protocolVersion !== REALTIME_PROTOCOL || !identifier(value.matchId) || !integer(value.epoch) || !integer(value.controllerGeneration)) throw new RealtimeError('INVALID_SCOPE');
  if (value.type === 'input') {
    keys.push('inputSeq', 'payload');
    if (!integer(value.inputSeq)) throw new RealtimeError('INVALID_SEQUENCE');
    checkJson(value.payload);
  } else if (value.type === 'action') {
    keys.push('actionId', 'payload');
    if (!identifier(value.actionId) || value.actionId.length < 8) throw new RealtimeError('INVALID_ACTION_ID');
    checkJson(value.payload);
  } else if (value.type === 'claimControl') {
    keys.push('expectedGeneration');
    if (!integer(value.expectedGeneration)) throw new RealtimeError('INVALID_GENERATION');
  } else if (value.type === 'ackSnapshot') {
    keys.push('snapshotSeq');
    if (!integer(value.snapshotSeq)) throw new RealtimeError('INVALID_SEQUENCE');
  } else if (value.type === 'heartbeat') {
    keys.push('nonce');
    if (!identifier(value.nonce)) throw new RealtimeError('INVALID_HEARTBEAT');
  } else if (value.type !== 'resync') throw new RealtimeError('UNKNOWN_MESSAGE');
  exactFields(value, keys);
  return value as unknown as ClientMessage;
}
export class RateWindow {
  private values: number[] = [];
  constructor(private readonly count: number, private readonly interval: number) {}
  take(now: number): boolean {
    while (this.values.length && this.values[0] <= now - this.interval) this.values.shift();
    if (this.values.length >= this.count) return false;
    this.values.push(now); return true;
  }
}

/** The delta is generated only between two views of the same authenticated
 * observer. Missing entities are removals, never invisible placeholders. */
export function viewChanges(before: unknown, after: unknown, path: (string | number)[] = []): ViewChange[] {
  if (Object.is(before, after)) return [];
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object' || Array.isArray(before) !== Array.isArray(after)) return [{ path, value: after }];
  if (Array.isArray(before) && Array.isArray(after)) {
    if (before.length !== after.length) return [{ path, value: after }];
    return after.flatMap((value, index) => viewChanges(before[index], value, [...path, index]));
  }
  const a = before as Record<string, unknown>, b = after as Record<string, unknown>;
  return [
    ...Object.keys(a).filter(key => !(key in b)).map(key => ({ path: [...path, key], remove: true as const })),
    ...Object.keys(b).flatMap(key => viewChanges(a[key], b[key], [...path, key])),
  ];
}
export function applyViewChanges(before: unknown, changes: ViewChange[], immutableTopLevelFields: readonly string[] = []): unknown {
  try { return projectViewChanges(before, changes, immutableTopLevelFields); }
  catch { throw new RealtimeError('INVALID_DELTA'); }
}
