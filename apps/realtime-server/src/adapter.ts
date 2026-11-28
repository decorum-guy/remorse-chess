import { randomBytes } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { REALTIME_PROTOCOL, REALTIME_SUBPROTOCOL, REALTIME_SOCKET_PATH, RealtimeError } from '@iva-games/realtime-kit';
import type { TicketClaims, TicketResponse } from '@iva-games/realtime-kit';
import type { GameRegistration, GameRuntime, StartMatchRequest } from '@iva-games/session-kit';
import { privateKey, signBridge, signTicket } from './crypto.js';

export interface BridgeOptions {
  url: string; keyId: string; privateKeyPem: string; allowedOrigins: string[];
  timeoutMs?: number;
}
export interface RealtimeRegistrationOptions extends BridgeOptions {
  gameId: string; title: string; rulesVersion: string; contentVersion: string; botVersion: string;
  route: string; normalizeSettings: (input: unknown) => Record<string, unknown>;
}
interface ParticipantReply {
  participantId: string;
  status: { rosterHash: string; roomId: string; phase: string; manifest: { gameId: string; rulesVersion: string; contentVersion: string; clientContentHash?: string; clientRoute?: string } };
}
export class RealtimeBridge {
  private key: KeyObject;
  constructor(private options: BridgeOptions) {
    const url = new URL(options.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new RealtimeError('INVALID_BRIDGE_CONFIG');
    this.key = privateKey(options.privateKeyPem);
  }
  async request<T>(method: 'GET' | 'POST', path: string, body: unknown): Promise<T> {
    const envelope = signBridge(method, path, body, this.options.keyId, this.key);
    const response = await fetch(new URL(path, this.options.url), {
      method, redirect: 'error', signal: AbortSignal.timeout(this.options.timeoutMs ?? 5000),
      headers: method === 'GET' ? { 'x-iva-service-request': Buffer.from(JSON.stringify(envelope)).toString('base64url') } : { 'Content-Type': 'application/json' },
      ...(method === 'POST' ? { body: JSON.stringify(envelope) } : {}),
    });
    const result = await response.json() as { error?: { code?: string; details?: Record<string, string | number> } };
    if (!response.ok) throw new RealtimeError(result.error?.code ?? 'REALTIME_UNAVAILABLE', response.status, result.error?.details);
    return result as T;
  }
  async ticket(matchId: string, playerId: string, sessionId: string, origin: string): Promise<TicketResponse> {
    if (!this.options.allowedOrigins.includes(origin)) throw new RealtimeError('ORIGIN_NOT_ALLOWED', 403);
    const info = await this.request<ParticipantReply>('POST', `/internal/realtime/v1/matches/${encodeURIComponent(matchId)}/participant`, { playerId });
    const issuedAt = Date.now(), expiresAt = issuedAt + 30_000;
    const claims: TicketClaims = { issuer: 'iva-platform', audience: 'iva-realtime', keyId: this.options.keyId,
      ticketId: randomBytes(24).toString('base64url'), playerId, participantId: info.participantId, matchId,
      roomId: info.status.roomId, rosterHash: info.status.rosterHash,
      gameId: info.status.manifest.gameId, rulesVersion: info.status.manifest.rulesVersion, contentVersion: info.status.manifest.contentVersion,
      protocolVersion: REALTIME_PROTOCOL, allowedOrigin: origin, permission: 'play', sessionId, issuedAt, expiresAt };
    return { ticket: signTicket(claims, this.key), websocketPath: REALTIME_SOCKET_PATH, protocolVersion: REALTIME_PROTOCOL,
      expiresAt, matchId, subprotocol: REALTIME_SUBPROTOCOL, participantId: info.participantId,
      ...(info.status.manifest.clientContentHash && info.status.manifest.clientRoute ? { clientContentHash: info.status.manifest.clientContentHash,
        launchUrl: `${info.status.manifest.clientRoute}?room=${encodeURIComponent(info.status.roomId)}` } : {}) };
  }
}
export function createRealtimeRegistration(options: RealtimeRegistrationOptions): GameRegistration {
  const bridge = new RealtimeBridge(options);
  const normalizeSettings = (input: unknown): Record<string, unknown> => {
    try { return options.normalizeSettings(input ?? {}); }
    catch { throw new RealtimeError('INVALID_SETTINGS'); }
  };
  const runtime: GameRuntime = {
    createMatch: (input: StartMatchRequest, context) => bridge.request('POST', '/internal/realtime/v1/matches', { gameId: options.gameId, input, ...(context?.hostPlayerId || input.hostPlayerId ? { hostPlayerId: context?.hostPlayerId ?? input.hostPlayerId } : {}) }),
    async viewForPlayer(matchId, playerId) {
      const info = await bridge.request<ParticipantReply>('POST', `/internal/realtime/v1/matches/${encodeURIComponent(matchId)}/participant`, { playerId });
      return { realtime: true, launchUrl: `${info.status.manifest.clientRoute ?? options.route}?room=${encodeURIComponent(info.status.roomId)}`, ...info.status };
    },
    async applyAction() { throw new RealtimeError('REALTIME_REQUIRED', 409); },
    status: matchId => bridge.request('GET', `/internal/realtime/v1/matches/${encodeURIComponent(matchId)}/status`, {}),
    realtimeTicket: (matchId, playerId, sessionId, origin) => bridge.ticket(matchId, playerId, sessionId, origin),
    syncAdmissions: sessionIds => bridge.request('POST', '/internal/realtime/v1/admissions', { sessionIds }),
    confirmResult: (matchId, resultId) => bridge.request('POST', `/internal/realtime/v1/matches/${encodeURIComponent(matchId)}/ack-result`, { resultId }),
  };
  return { gameId: options.gameId, collectionId: 'other', title: options.title, minPlayers: 2, maxPlayers: 6,
    supportsBots: true, rulesVersion: options.rulesVersion, contentVersion: options.contentVersion,
    status: 'available', normalizeSettings, runtime,
    resolveRoomVersion: (rulesVersion, contentVersion) => rulesVersion === options.rulesVersion && contentVersion === options.contentVersion
      ? { normalizeSettings, botVersion: options.botVersion } : undefined };
}
export function bridgeOptionsFromEnvironment(env: NodeJS.ProcessEnv, allowedOrigins: string[]): BridgeOptions | undefined {
  const names = ['REALTIME_INTERNAL_URL', 'REALTIME_SIGNING_KEY_FILE', 'REALTIME_KEY_ID'] as const;
  if (!names.some(name => env[name])) return undefined;
  if (names.some(name => !env[name])) throw new RealtimeError('INCOMPLETE_REALTIME_CONFIG');
  return { url: env.REALTIME_INTERNAL_URL!, privateKeyPem: readFileSync(env.REALTIME_SIGNING_KEY_FILE!, 'utf8'), keyId: env.REALTIME_KEY_ID!, allowedOrigins };
}
