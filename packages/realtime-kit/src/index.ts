/** Browser-safe realtime v1 contract. Never put authoritative worlds or signing keys here. */
export const PROTOCOL_VERSION = 1 as const;
export const WS_PROTOCOL = 'iva-realtime-v1';
export const WS_PATH = '/ws/realtime/v1';
export const LIMITS = Object.freeze({ authBytes: 4096, messageBytes: 16_384, inputPerSecond: 30,
  inputBurst: 90, actionPerSecond: 10, actionBurst: 20, neutralAfterMs: 250,
  botAfterMs: 5000, pauseAfterMs: 10_000, resumeForMs: 86_400_000, ticketMs: 30_000,
  reservationMs: 15_000, fullEveryTicks: 60, maxQueuedBytes: 262_144, closeQueuedBytes: 1_048_576 });
export type MatchPhase = 'creating' | 'loading' | 'ready' | 'running' | 'paused' | 'recovering' | 'finished' | 'abandoned' | 'failed-recoverable';
export interface TicketClaims {
  issuer: 'iva-platform' | 'iva-realtime-practice'; audience: 'iva-realtime'; keyId: string;
  ticketId: string; playerId: string; participantId: string; matchId: string; roomId: string;
  rosterHash: string; gameId: string; protocolVersion: 1; rulesVersion: string; contentVersion: string;
  allowedOrigin: string; permission: 'control'; issuedAt: number; expiresAt: number; admissionId: string;
}
export interface Envelope { protocolVersion: 1; matchId: string; epoch: number; controllerGeneration: number }
export type ClientMessage =
  | { type: 'authenticate'; ticket: string }
  | (Envelope & { type: 'input'; inputSeq: number; payload: Record<string, unknown> })
  | (Envelope & { type: 'action'; actionId: string; payload: Record<string, unknown> })
  | (Envelope & { type: 'claimControl' | 'resync' | 'heartbeat' })
  | (Envelope & { type: 'ackSnapshot'; snapshotSeq: number });
export interface Admission {
  matchId: string; participantId: string; ticket: string; websocketPath: string; protocolVersion: 1; route: string;
}
export interface StartWaiting {
  reason: 'capacity' | 'updating' | 'another_start' | 'service';
  retryAt: number; queuePosition?: number; reservationExpiresAt?: number;
}
/** Data safe to show only to members of the already authenticated lobby. */
export function parseStartWaiting(value: unknown): StartWaiting | null {
  if (!object(value) || !['capacity', 'updating', 'another_start', 'service'].includes(String(value.reason)) ||
    !safeInteger(value.retryAt) || value.queuePosition !== undefined && (!safeInteger(value.queuePosition) || value.queuePosition < 1 || value.queuePosition > 128) ||
    value.reservationExpiresAt !== undefined && !safeInteger(value.reservationExpiresAt)) return null;
  return { reason: value.reason as StartWaiting['reason'], retryAt: value.retryAt,
    ...(value.queuePosition === undefined ? {} : { queuePosition: value.queuePosition }),
    ...(value.reservationExpiresAt === undefined ? {} : { reservationExpiresAt: value.reservationExpiresAt }) };
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function finiteJson(value: unknown, depth = 0): boolean {
  if (depth > 10) return false;
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return typeof value !== 'string' || value.length <= 1024;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 100 && value.every(v => finiteJson(v, depth + 1));
  if (object(value)) return Object.keys(value).length <= 32 && Object.values(value).every(v => finiteJson(v, depth + 1));
  return false;
}
export function safeInteger(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function id(value: unknown, max = 128): value is string { return typeof value === 'string' && value.length > 0 && value.length <= max && /^[A-Za-z0-9_.:-]+$/.test(value); }
export function parseClientMessage(value: unknown): ClientMessage | null {
  if (!object(value) || typeof value.type !== 'string') return null;
  if (value.type === 'authenticate') return Object.keys(value).length === 2 && typeof value.ticket === 'string' && value.ticket.length <= 3800
    ? value as ClientMessage : null;
  const base = ['type', 'protocolVersion', 'matchId', 'epoch', 'controllerGeneration'];
  if (value.protocolVersion !== 1 || !id(value.matchId) || !safeInteger(value.epoch) || !safeInteger(value.controllerGeneration)) return null;
  const extra: string[] = [];
  if (value.type === 'input') {
    if (!safeInteger(value.inputSeq) || !object(value.payload) || !finiteJson(value.payload)) return null;
    extra.push('inputSeq', 'payload');
  } else if (value.type === 'action') {
    if (!id(value.actionId) || value.actionId.length < 8 || !object(value.payload) || !finiteJson(value.payload)) return null;
    extra.push('actionId', 'payload');
  } else if (value.type === 'ackSnapshot') {
    if (!safeInteger(value.snapshotSeq)) return null;
    extra.push('snapshotSeq');
  } else if (!['claimControl', 'resync', 'heartbeat'].includes(value.type)) return null;
  if (Object.keys(value).some(k => !base.includes(k) && !extra.includes(k))) return null;
  return value as ClientMessage;
}
