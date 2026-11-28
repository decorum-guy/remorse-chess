export interface Player { playerId: string; displayName: string; handle: string; emailVerified?: boolean; telegramVerified?: boolean }
export interface Session { user: Player | null; csrfToken: string; auth?: { email: boolean; telegram: boolean } }
export interface RoomMember {
  participantId: string; playerId: string | null; displayName: string; seatIndex: number; ready: boolean;
  controller: { kind: 'human'; playerId: string } | { kind: 'bot'; difficulty: 'easy' | 'normal' | 'hard'; botProfileId: string };
}
export interface Room {
  roomId: string; gameId: string; hostPlayerId: string; title: string; revision: number;
  state: 'lobby' | 'starting' | 'playing' | 'finished' | 'cancelled';
  startStatus?: { state: 'starting' | 'queued'; code?: string; position?: number; retryAfterMs?: number };
  capacity: number; reservedSeats: number; settings: Record<string, unknown>; members: RoomMember[];
  matchId: string | null; rulesVersion: string; contentVersion: string;
}
export class ApiError extends Error { constructor(public code: string) { super(code); } }
let csrf = '';
const retries = new Map<string, string>();
export async function api<T>(path: string, body?: unknown): Promise<T> {
  const signature = path + JSON.stringify(body ?? null);
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'; headers['X-CSRF-Token'] = csrf;
    if (!retries.has(signature)) retries.set(signature, crypto.randomUUID());
    headers['Idempotency-Key'] = retries.get(signature)!;
  }
  let response: Response;
  try { response = await fetch('/api/platform/v1' + path, { method: body === undefined ? 'GET' : 'POST', headers, credentials: 'same-origin', cache: 'no-store', ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) }); }
  catch { throw new ApiError('NETWORK'); }
  const result = await response.json().catch(() => null);
  if (result && response.status < 500) retries.delete(signature);
  if (!response.ok || !result) throw new ApiError(result?.error?.code ?? 'NETWORK');
  return result as T;
}
let sessionPromise: Promise<Session> | null = null;
export function loadSession(): Promise<Session> {
  if (!sessionPromise) sessionPromise = api<Session>('/session').then(session => { csrf = session.csrfToken; return session; }).finally(() => { sessionPromise = null; });
  return sessionPromise;
}
