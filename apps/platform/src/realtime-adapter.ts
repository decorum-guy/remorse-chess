/** Platform-side bridge only: no simulation, WebSocket or hidden world imports. */
import type { GameRegistration } from '@iva-games/session-kit';
import { randomInt } from 'node:crypto';
import { SessionError } from '@iva-games/session-kit';
import type { Admission, TicketClaims } from '@iva-games/realtime-kit';
import { parseStartWaiting } from '@iva-games/realtime-kit';
import { bridgeSignature, canonical, hash, loadSigningKey, newTicketId, publicKeyPem, signTicket } from './realtime-crypto.js';

function normalizeForpostSettings(input: unknown): Record<string, unknown> {
  const value = input === undefined ? {} : input;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !['mapId', 'teamSize', 'mapVersion', 'loadouts'].includes(k))) throw new Error('INVALID_SETTINGS');
  const v = value as Record<string, unknown>, mapId = v.mapId === 'random' ? ['FP01', 'FP02', 'FP03'][randomInt(3)] : v.mapId ?? 'FP01', teamSize = v.teamSize ?? 1;
  if (!['FP01', 'FP02', 'FP03'].includes(String(mapId)) || typeof teamSize !== 'number' || ![1, 2, 3].includes(teamSize) || v.mapVersion !== undefined && v.mapVersion !== 'forpost-maps-0.1') throw new Error('INVALID_SETTINGS');
  const loadouts = v.loadouts ?? {};
  if (!loadouts || typeof loadouts !== 'object' || Array.isArray(loadouts) || Object.keys(loadouts).length > 64) throw new Error('INVALID_SETTINGS');
  for (const [id, entry] of Object.entries(loadouts)) {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(id) || !entry || typeof entry !== 'object' || Array.isArray(entry) ||
      Object.keys(entry).some(k => !['team', 'weapon', 'tool', 'botLevel'].includes(k)) ||
      !['A', 'B'].includes(entry.team) || !['carbine', 'shotgun', 'rifle'].includes(entry.weapon) || !['barrier', 'smoke', 'repair'].includes(entry.tool) ||
      !['novice', 'normal', 'strong'].includes(entry.botLevel)) throw new Error('INVALID_SETTINGS');
  }
  return { mapId, teamSize, mapVersion: 'forpost-maps-0.1', loadouts };
}

export interface AdapterOptions { baseUrl: string; signingKeyPath: string; keyId: string; publicOrigin: string }
export function forpostUnavailable(): GameRegistration {
  return { gameId: 'forpost', collectionId: 'other', title: 'Форпост', minPlayers: 2, maxPlayers: 6, supportsBots: true,
    rulesVersion: 'forpost-0.1', contentVersion: 'forpost-content-1', status: 'unavailable' };
}
export function createForpostRegistration(options: AdapterOptions) {
  const base = new URL(options.baseUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw new Error('Invalid realtime bridge URL');
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(options.keyId) || options.keyId === 'practice-v1') throw new Error('Invalid realtime signing key ID');
  const key = loadSigningKey(options.signingKeyPath);
  const admissions = new Map<string, { sessionHash: string; playerId: string; expiresAt: number }>();
  const call = async <T>(path: string, payload: unknown = {}): Promise<T> => {
    const data = canonical(payload), requestId = newTicketId(), timestamp = String(Date.now());
    let response: Response;
    try {
      response = await fetch(new URL(path, base), { method: 'POST', body: data, signal: AbortSignal.timeout(2500),
        headers: { 'Content-Type': 'application/json', 'X-Iva-Key-Id': options.keyId, 'X-Iva-Request-Id': requestId,
          'X-Iva-Timestamp': timestamp, 'X-Iva-Signature': bridgeSignature('POST', path, data, requestId, timestamp, key) } });
    } catch { throw new SessionError('GAME_UNAVAILABLE', 'Игра временно недоступна. Попробуйте позже', 503); }
    if (!response.ok) {
      if (path === '/internal/realtime/v1/matches' && response.status === 503) {
        const data = await response.json().catch(() => null) as { waiting?: unknown } | null;
        const waiting = parseStartWaiting(data?.waiting);
        if (waiting) throw Object.assign(new SessionError('START_WAITING', 'Ожидаем запуска игры. Повторим автоматически', 503), { startWaiting: waiting });
      }
      throw new SessionError('GAME_UNAVAILABLE', 'Не удалось продолжить игру. Попробуйте ещё раз', 503);
    }
    return await response.json() as T;
  };
  const normalizeSettings = (input: unknown) => {
    try { return normalizeForpostSettings(input); } catch { throw new SessionError('INVALID_SETTINGS', 'Выберите карту и равные команды', 400); }
  };
  const registration: GameRegistration = {
    ...forpostUnavailable(), status: 'available', normalizeSettings,
    resolveRoomVersion: (rules, content) => rules === 'forpost-0.1' && content === 'forpost-content-1'
      ? { normalizeSettings, botVersion: 'forpost-bot-0.1' } : undefined,
    validateStart(participants, settings) {
      const normalized = normalizeSettings(settings), size = Number(normalized.teamSize);
      if (participants.length !== size * 2 || !participants.some(p => p.controller.kind === 'human')) throw new SessionError('PLAYER_COUNT', 'Заполните обе команды: по одному, два или три участника', 409);
      const loadouts = normalized.loadouts as Record<string, {team: string}>;
      const a = participants.filter(p => (loadouts[p.participantId]?.team ?? (p.seatIndex % 2 === 0 ? 'A' : 'B')) === 'A').length;
      if (a !== size) throw new SessionError('TEAM_SIZE', 'В командах должно быть поровну участников', 409);
    },
    runtime: {
      createMatch: request => call('/internal/realtime/v1/matches', request),
      viewForPlayer: (matchId, playerId) => call(`/internal/realtime/v1/matches/${encodeURIComponent(matchId)}/view`, { playerId }),
      applyAction: async () => { throw new SessionError('REALTIME_REQUIRED', 'Откройте игру, чтобы продолжить', 409); },
      status: matchId => call(`/internal/realtime/v1/matches/${encodeURIComponent(matchId)}/status`),
      acknowledgeResult: async (matchId, resultId) => { await call(`/internal/realtime/v1/matches/${encodeURIComponent(matchId)}/result-ack`, { resultId }); },
      async issueRealtimeTicket(matchId, playerId, session) {
        const admissionId = hash('realtime-admission:' + session.sessionHash);
        admissions.set(admissionId, { sessionHash: session.sessionHash, playerId, expiresAt: session.expiresAt });
        const { claims, route } = await call<{claims: TicketClaims; route: string}>(`/internal/realtime/v1/matches/${encodeURIComponent(matchId)}/admission`, { playerId, admissionId });
        if (claims.allowedOrigin !== options.publicOrigin || claims.keyId !== options.keyId || claims.playerId !== playerId || claims.matchId !== matchId) throw new SessionError('GAME_UNAVAILABLE', 'Не удалось подключиться к игре', 503);
        if (route !== '/play/forpost/' && !/^\/realtime-assets\/[0-9a-f]{64}\/$/.test(route)) throw new SessionError('GAME_UNAVAILABLE', 'Не удалось подключиться к игре', 503);
        return { matchId, participantId: claims.participantId, ticket: signTicket(claims, key), websocketPath: '/ws/realtime/v1', protocolVersion: 1, route } satisfies Admission;
      },
    },
  };
  let lastRefresh = 0, refreshing = false;
  return {
    registration, publicKey: publicKeyPem(key), keyId: options.keyId,
    async refreshAdmissions(valid: (sessionHash: string, playerId: string) => boolean) {
      if (refreshing || Date.now() - lastRefresh < 30_000 || admissions.size === 0) return;
      refreshing = true;
      try {
        const items = [...admissions.entries()].map(([admissionId, item]) => ({ admissionId, playerId: item.playerId, valid: item.expiresAt > Date.now() && valid(item.sessionHash, item.playerId) }));
        for (let i = 0; i < items.length; i += 100) await call('/internal/realtime/v1/admissions', { admissions: items.slice(i, i + 100) });
        for (const item of items) if (!item.valid) admissions.delete(item.admissionId);
        lastRefresh = Date.now();
      } finally { refreshing = false; }
    },
  };
}
