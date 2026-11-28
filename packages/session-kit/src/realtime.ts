import type { ActionEnvelope, GameRuntime } from './types';

/** The platform owns authentication and connection scope; a game owns every
 * payload, its clock, authoritative simulation, persistence and replay rules. */
export const LIVE_PROTOCOL = 'iva-live@1' as const;
export const LIVE_INPUT_HZ = 30;
export const LIVE_SNAPSHOT_HZ = 15;
export const LIVE_MAX_FRAME_BYTES = 16_384;

export interface RealtimeInput { epoch: string; seq: number; payload: unknown }
export interface RealtimeSnapshot {
  tick: number;
  serverTime: number;
  lastAcceptedSeq: number;
  view: unknown;
}

/** Optional capability: existing HTTP-only runtimes need no changes.
 * liveConnect resets control/sequence for the new epoch. Old liveDisconnect
 * calls must not neutralize its successor. Each live method rechecks epoch;
 * the game also neutralizes stale input independently of socket callbacks.
 * Commands use GameRuntime.applyAction and its durable action-ID receipt. */
export interface RealtimeGameRuntime extends GameRuntime {
  readonly wireVersion: string;
  liveConnect(matchId: string, playerId: string, epoch: string): Promise<RealtimeSnapshot>;
  liveInput(matchId: string, playerId: string, input: RealtimeInput): void | Promise<void>;
  liveSnapshot(matchId: string, playerId: string, epoch: string): Promise<RealtimeSnapshot>;
  liveDisconnect(matchId: string, playerId: string, epoch: string): void | Promise<void>;
}
export function isRealtimeRuntime(runtime: unknown): runtime is RealtimeGameRuntime {
  if (!runtime || typeof runtime !== 'object') return false;
  const live = runtime as Partial<RealtimeGameRuntime>;
  return typeof live.wireVersion === 'string' && /^[a-z][a-z0-9@._-]{0,95}$/.test(live.wireVersion)
    && ['createMatch', 'viewForPlayer', 'applyAction', 'status', 'liveConnect', 'liveInput', 'liveSnapshot', 'liveDisconnect'].every(key => typeof live[key as keyof RealtimeGameRuntime] === 'function');
}

export interface LiveScope {
  protocol: typeof LIVE_PROTOCOL;
  wireVersion: string;
  roomId: string;
  matchId: string;
  epoch: string;
}
export type LiveClientFrame = LiveScope & (
  | { type: 'input'; seq: number; payload: unknown }
  | ({ type: 'command' } & ActionEnvelope)
);
export interface LiveServerScope extends LiveScope {
  gameId: string;
  rulesVersion: string;
  contentVersion: string;
}
export type LiveServerFrame = LiveServerScope & (
  | ({ type: 'snapshot' } & RealtimeSnapshot)
  | { type: 'receipt'; actionId: string; tick: number; result: unknown }
  | { type: 'error'; code: string; message: string; actionId?: string }
);

/** Exact outer fields prevent an apparent second identity/seat/clock. Games
 * must validate payload ranges and phase IDs themselves before accepting. */
export function parseLiveClientFrame(value: unknown, scope: LiveScope): LiveClientFrame {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_FRAME');
  const input = value as Record<string, unknown>;
  if (Object.keys(scope).some(key => input[key] !== scope[key as keyof LiveScope])) throw new Error('LIVE_SCOPE_MISMATCH');
  const fields = ['protocol', 'wireVersion', 'roomId', 'matchId', 'epoch', 'type', 'payload'];
  const validInteger = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
  if (input.type === 'input') {
    fields.push('seq');
    if (!validInteger(input.seq)) throw new Error('INVALID_FRAME');
  } else if (input.type === 'command') {
    fields.push('actionId', 'expectedRevision');
    if (typeof input.actionId !== 'string' || !/^[A-Za-z0-9._:-]{8,100}$/.test(input.actionId) || !validInteger(input.expectedRevision)) throw new Error('INVALID_FRAME');
  } else throw new Error('INVALID_FRAME');
  if (!Object.hasOwn(input, 'payload') || Object.keys(input).some(key => !fields.includes(key))) throw new Error('INVALID_FRAME');
  return input as unknown as LiveClientFrame;
}

/** A sliding window bounds bursts across second boundaries. No refill credits
 * accrue while disconnected. The caller supplies a monotonic clock. */
export class LiveRateWindow {
  private accepted: number[] = [];
  constructor(private readonly limit: number, private readonly windowMs = 1000) {}
  take(now: number): boolean {
    while (this.accepted.length && this.accepted[0] <= now - this.windowMs) this.accepted.shift();
    if (this.accepted.length >= this.limit) return false;
    this.accepted.push(now); return true;
  }
}
