import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createPublicKey, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { WebSocketServer, WebSocket } from 'ws';
import { LIMITS, parseClientMessage, WS_PATH, WS_PROTOCOL } from '@iva-games/realtime-kit';
import type { Admission, TicketClaims } from '@iva-games/realtime-kit';
import type { StartMatchRequest } from '@iva-games/session-kit';
import { hash, loadSigningKey, newTicketId, signTicket, verifyBridge, verifyTicket } from './crypto.js';
import { normalizeForpostSettings, validatePractice } from './settings.js';
import { RealtimeRuntime, StartWaitingError } from './runtime.js';
import type { Peer } from './runtime.js';
import type { FrozenParticipant, StoredMatch } from './store.js';
import { retainedClientDirectory } from './content.js';
import type { CapacityProfile } from './capacity.js';
import { compatibilityInventory } from './retention.js';

export interface RealtimeOptions {
  databasePath: string; signingKeyPath: string; trustedKeys?: Record<string, string>; publicOrigin: string;
  staticDirectory: string; maxRooms?: number; artifactId?: string; artifactDirectory?: string; buildRevision?: string; workerDirectory?: URL;
  contentId?: string; contentDirectory?: string;
  capacityProfile?: CapacityProfile;
}
async function body(request: IncomingMessage, max = 16_384): Promise<string> {
  let bytes = 0; const chunks: Buffer[] = [];
  for await (const chunk of request) { bytes += Buffer.byteLength(chunk); if (bytes > max) throw new Error('BODY_TOO_LARGE'); chunks.push(Buffer.from(chunk)); }
  return Buffer.concat(chunks).toString('utf8');
}
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function cookie(request: IncomingMessage, name: string): string | null {
  const matches = (request.headers.cookie ?? '').split(';').map(v => v.trim()).filter(v => v.startsWith(name + '='));
  return matches.length === 1 && /^[A-Za-z0-9_-]{43}$/.test(matches[0].slice(name.length + 1)) ? matches[0].slice(name.length + 1) : null;
}
function send(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(value));
}
function safeError(error: unknown): string {
  if (error instanceof SyntaxError) return 'INVALID_MESSAGE';
  const code = error instanceof Error ? error.message : 'SERVER_UNAVAILABLE';
  return ['AUTH_REQUIRED', 'INVALID_SETTINGS', 'MATCH_UNAVAILABLE', 'SERVER_BUSY', 'START_CONFLICT', 'BODY_TOO_LARGE', 'ORIGIN_NOT_ALLOWED',
    'STALE_CONTROLLER', 'STALE_EPOCH', 'VIEW_ONLY', 'ACTION_CONFLICT', 'MATCH_PAUSED', 'INVALID_MESSAGE', 'RATE_LIMITED', 'PLAYER_COUNT', 'TEAM_SIZE'].includes(code) ? code : 'SERVER_UNAVAILABLE';
}
function statusFor(code: string): number { return code === 'AUTH_REQUIRED' ? 401 : code === 'ORIGIN_NOT_ALLOWED' ? 403 : code === 'MATCH_UNAVAILABLE' ? 404 : code === 'SERVER_BUSY' || code === 'SERVER_UNAVAILABLE' ? 503 : code === 'BODY_TOO_LARGE' ? 413 : 400; }
function keyHeader(request: IncomingMessage, name: string): string { const value = request.headers[name]; if (typeof value !== 'string') throw new Error('AUTH_REQUIRED'); return value; }

export function createRealtimeServer(options: RealtimeOptions) {
  const origin = new URL(options.publicOrigin).origin;
  if (origin !== options.publicOrigin || !/^https?:/.test(origin) || origin.startsWith('http:') && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname)) throw new Error('INVALID_PUBLIC_ORIGIN');
  const secure = origin.startsWith('https:'), cookieName = secure ? '__Host-iva_practice' : 'iva_dev_practice';
  const practiceKey = loadSigningKey(options.signingKeyPath);
  const maintenancePath = resolve(dirname(options.databasePath), 'realtime-maintenance-token');
  if (!existsSync(maintenancePath)) writeFileSync(maintenancePath, randomBytes(32).toString('base64url'), { flag: 'wx', mode: 0o600 });
  const maintenanceToken = readFileSync(maintenancePath);
  const keys: Record<string, KeyObject> = Object.assign(Object.create(null) as Record<string, KeyObject>, { 'practice-v1': createPublicKey(practiceKey) });
  for (const [keyId, pem] of Object.entries(options.trustedKeys ?? {})) {
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(keyId) || keyId === 'practice-v1') throw new Error('INVALID_TRUSTED_KEY');
    keys[keyId] = createPublicKey(pem); if (keys[keyId].asymmetricKeyType !== 'ed25519') throw new Error('INVALID_TRUSTED_KEY');
  }
  const runtime = new RealtimeRuntime({ databasePath: options.databasePath, maxRooms: options.maxRooms ?? 4,
    artifactId: options.artifactId ?? 'forpost-runtime-v1', artifactDirectory: options.artifactDirectory, contentId: options.contentId, contentDirectory: options.contentDirectory,
    buildRevision: options.buildRevision, workerDirectory: options.workerDirectory, capacityProfile: options.capacityProfile });
  const staticRoot = resolve(options.staticDirectory);
  const sockets = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: LIMITS.messageBytes,
    handleProtocols: protocols => protocols.has(WS_PROTOCOL) ? WS_PROTOCOL : false });
  const anonymousRate = new Map<string, { at: number; count: number }>();
  let closing = false;
  const admission = (match: StoredMatch, playerId: string, admissionId: string, keyId: string, issuer: TicketClaims['issuer']): TicketClaims => {
    const participant = match.roster.find(p => p.playerId === playerId && p.controller === 'human'); if (!participant) throw new Error('AUTH_REQUIRED');
    const now = Date.now();
    return { issuer, audience: 'iva-realtime', keyId, ticketId: newTicketId(), playerId, participantId: participant.participantId,
      matchId: match.matchId, roomId: match.roomId, rosterHash: match.rosterHash, gameId: 'forpost', protocolVersion: 1,
      rulesVersion: match.rulesVersion, contentVersion: match.contentVersion, allowedOrigin: origin, permission: 'control',
      issuedAt: now, expiresAt: now + 30_000, admissionId };
  };
  const practiceTicket = async (match: StoredMatch, ownerHash: string): Promise<Admission> => {
    if (match.kind !== 'practice' || match.ownerHash !== ownerHash) throw new Error('MATCH_UNAVAILABLE');
    const person = match.roster.find(p => p.controller === 'human')!;
    const admissionId = 'practice:' + hash(ownerHash + ':' + person.playerId);
    await runtime.store.call('admission', admissionId, person.playerId!, Date.now() + LIMITS.resumeForMs);
    return { matchId: match.matchId, participantId: person.participantId, ticket: signTicket(admission(match, person.playerId!, admissionId, 'practice-v1', 'iva-realtime-practice'), practiceKey),
      websocketPath: WS_PATH, protocolVersion: 1, route: runtime.route(match) };
  };
  const server = createServer((request, response) => { void (async () => {
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (secure) response.setHeader('Strict-Transport-Security', 'max-age=31536000');
    try {
      if (!request.url?.startsWith('/') || request.url.startsWith('//')) throw new Error('INVALID_MESSAGE');
      const url = new URL(request.url, origin), path = url.pathname, method = request.method ?? 'GET';
      if (method === 'GET' && ['/health/live', '/health/ready', '/api/realtime/v1/health'].includes(path)) {
        await runtime.ready; send(response, closing || path !== '/health/live' && !runtime.health().ok ? 503 : 200, runtime.health()); return;
      }
      if (closing) throw new Error('SERVER_BUSY');
      await runtime.ready;
      if (path === '/api/realtime/v1/compatibility' && method === 'GET') {
        const manifests = await runtime.store.call<unknown[]>('compatibilityManifests');
        send(response, 200, compatibilityInventory(manifests, options.buildRevision ?? 'unknown', runtime.options.artifactId, options.contentId ?? ''));
        return;
      }
      if (path.startsWith('/maintenance/realtime/v1/')) {
        const token = Buffer.from(typeof request.headers['x-iva-maintenance'] === 'string' ? request.headers['x-iva-maintenance'] : '');
        if (method !== 'POST' || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? '') || token.length !== maintenanceToken.length || !timingSafeEqual(token, maintenanceToken)) throw new Error('AUTH_REQUIRED');
        if (path.endsWith('/drain')) await runtime.drain();
        else if (path.endsWith('/resume')) await runtime.resume();
        else if (!path.endsWith('/status')) throw new Error('MATCH_UNAVAILABLE');
        send(response, 200, { ...runtime.health(), ...runtime.diagnostics(), drained: runtime.health().draining }); return;
      }
      if (path.startsWith('/internal/realtime/v1/')) {
        const raw = await body(request, 65_536), keyId = keyHeader(request, 'x-iva-key-id'), requestId = keyHeader(request, 'x-iva-request-id');
        if (!keys[keyId] || keyId === 'practice-v1' || !verifyBridge(method, path, raw, requestId, keyHeader(request, 'x-iva-timestamp'), keyHeader(request, 'x-iva-signature'), keys[keyId])) throw new Error('AUTH_REQUIRED');
        await runtime.store.call('consumeBridge', requestId);
        const input: unknown = raw ? JSON.parse(raw) : {}; if (!object(input)) throw new Error('INVALID_MESSAGE');
        if (path === '/internal/realtime/v1/matches' && method === 'POST') {
          const command = input as unknown as StartMatchRequest;
          if (!command.startCommandId || !command.roomId || !Array.isArray(command.participants) || command.rulesVersion !== 'forpost-0.1' || command.contentVersion !== 'forpost-content-1') throw new Error('INVALID_SETTINGS');
          const settings = normalizeForpostSettings(command.settings);
          if (command.participants.length !== Number(settings.teamSize) * 2 || !command.participants.some(p => p.controller.kind === 'human')) throw new Error('PLAYER_COUNT');
          if (new Set(command.participants.map(p => p.participantId)).size !== command.participants.length ||
            command.participants.some(p => !Number.isInteger(p.seatIndex) || p.seatIndex < 0 || p.seatIndex >= command.participants.length ||
              !/^[A-Za-z0-9_-]{1,100}$/.test(p.participantId) || typeof p.displayName !== 'string' || p.displayName.length > 80 ||
              !['human', 'bot'].includes(p.controller.kind) || p.controller.kind === 'human' && (!p.playerId || p.controller.playerId !== p.playerId) ||
              p.controller.kind === 'bot' && (p.playerId !== null || !['easy', 'normal', 'hard'].includes(p.controller.difficulty)))) throw new Error('INVALID_SETTINGS');
          if (command.hostPlayerId !== undefined && (typeof command.hostPlayerId !== 'string' ||
            !command.participants.some(person => person.playerId === command.hostPlayerId && person.controller.kind === 'human'))) throw new Error('INVALID_SETTINGS');
          const roster: FrozenParticipant[] = command.participants.map(p => ({ participantId: p.participantId, playerId: p.playerId, displayName: p.displayName,
            team: settings.loadouts[p.participantId]?.team ?? (p.seatIndex % 2 === 0 ? 'A' : 'B'), controller: p.controller.kind }));
          if (roster.filter(p => p.team === 'A').length !== settings.teamSize) throw new Error('TEAM_SIZE');
          const match = await runtime.create({ startId: command.startCommandId, roomId: command.roomId, kind: 'account', ownerHash: null,
            ...(command.hostPlayerId === undefined ? {} : { hostPlayerId: command.hostPlayerId }),
            roster, rulesVersion: command.rulesVersion, contentVersion: command.contentVersion,
            config: { mapId: settings.mapId, teamSize: settings.teamSize, mode: 'match',
              seed: Number.parseInt(hash(command.startCommandId).slice(0, 8), 16), participants: command.participants.map((p, i) => ({ id: p.participantId,
                name: p.displayName, team: roster[i].team, controller: p.controller.kind,
                weapon: settings.loadouts[p.participantId]?.weapon ?? 'carbine', tool: settings.loadouts[p.participantId]?.tool ?? 'barrier',
                botLevel: settings.loadouts[p.participantId]?.botLevel ?? (p.controller.kind === 'bot' ? ({ easy: 'novice', normal: 'normal', hard: 'strong' } as const)[p.controller.difficulty] : 'normal') })) } });
          send(response, 200, { matchId: match.matchId }); return;
        }
        const matchPath = path.match(/^\/internal\/realtime\/v1\/matches\/([\w-]+)\/(status|view|admission|result-ack)$/);
        if (matchPath) {
          const match = runtime.get(matchPath[1]) ?? await runtime.store.call<StoredMatch | null>('get', matchPath[1]);
          if (!match || match.kind !== 'account') throw new Error('MATCH_UNAVAILABLE');
          if (matchPath[2] === 'status') { send(response, 200, { finished: ['finished', 'abandoned'].includes(match.phase), outcome: match.outcome }); return; }
          if (matchPath[2] === 'result-ack') {
            if (!['finished', 'abandoned'].includes(match.phase) || !object(match.outcome) || typeof input.resultId !== 'string' || match.outcome.resultId !== input.resultId) throw new Error('INVALID_MESSAGE');
            await runtime.store.call('delivered', input.resultId, match.matchId); send(response, 200, { ok: true }); return;
          }
          if (typeof input.playerId !== 'string') throw new Error('AUTH_REQUIRED');
          if (matchPath[2] === 'view') { send(response, 200, runtime.view(match.matchId, input.playerId)); return; }
          if (typeof input.admissionId !== 'string' || input.admissionId.length > 128) throw new Error('AUTH_REQUIRED');
          const claims = admission(match, input.playerId, input.admissionId, keyId, 'iva-platform');
          await runtime.store.call('admission', input.admissionId, input.playerId, Date.now() + 65_000);
          send(response, 200, { claims, route: runtime.route(match) }); return;
        }
        if (path === '/internal/realtime/v1/admissions' && method === 'POST' && Array.isArray(input.admissions) && input.admissions.length <= 100) {
          for (const item of input.admissions) {
            if (!object(item) || typeof item.admissionId !== 'string' || typeof item.playerId !== 'string' || typeof item.valid !== 'boolean') throw new Error('INVALID_MESSAGE');
            if (item.valid) await runtime.store.call('admission', item.admissionId, item.playerId, Date.now() + 65_000);
            else await runtime.store.call('revoke', item.admissionId);
          }
          send(response, 200, { ok: true }); return;
        }
        if (path === '/internal/realtime/v1/drain' && method === 'POST') { await runtime.drain(); send(response, 200, { drained: true }); return; }
        throw new Error('MATCH_UNAVAILABLE');
      }
      if (path.startsWith('/api/realtime/v1/')) {
        if (method !== 'POST' || request.headers.origin !== origin) throw new Error('ORIGIN_NOT_ALLOWED');
        if (!request.headers['content-type']?.startsWith('application/json')) throw new Error('INVALID_MESSAGE');
        let token = cookie(request, cookieName);
        if (!token) token = randomBytes(32).toString('base64url');
        // Guest identity outlives a room's 24-hour resume window and is renewed
        // on successful owned HTTP operations; no bearer is exposed to script.
        const renewOwnership = () => response.setHeader('Set-Cookie', `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${30 * 24 * 60 * 60}${secure ? '; Secure' : ''}`);
        const ownerHash = hash(token), raw = await body(request), input: unknown = JSON.parse(raw || '{}');
        if (path === '/api/realtime/v1/practice') {
          const address = request.socket.remoteAddress ?? 'local'; const bucket = anonymousRate.get(address) ?? { at: Date.now(), count: 0 };
          if (Date.now() - bucket.at > 60_000) { bucket.at = Date.now(); bucket.count = 0; }
          if (++bucket.count > 12) throw new Error('SERVER_BUSY'); anonymousRate.set(address, bucket);
          const settings = validatePractice(input), personId = 'practice-' + randomUUID();
          const roster: FrozenParticipant[] = Array.from({ length: settings.teamSize * 2 }, (_, i) => ({ participantId: randomUUID(), playerId: i === 0 ? personId : null,
            displayName: i === 0 ? settings.displayName : `Бот ${i}`, team: i % 2 === 0 ? 'A' : 'B', controller: i === 0 ? 'human' : 'bot' }));
          const startId = randomUUID();
          const match = await runtime.create({ startId, roomId: 'practice-' + startId, kind: 'practice', ownerHash, roster, rulesVersion: 'forpost-0.1', contentVersion: 'forpost-content-1',
            config: { mapId: settings.mapId, teamSize: settings.teamSize, mode: settings.mode, seed: settings.seed ?? randomBytes(4).readUInt32LE(),
              participants: roster.map(p => ({ id: p.participantId, name: p.displayName, team: p.team, controller: p.controller, botLevel: settings.botLevel,
                weapon: settings.weapon, tool: settings.tool })) } });
          const ticket = await practiceTicket(match, ownerHash); renewOwnership(); send(response, 201, ticket); return;
        }
        const ticketMatch = path.match(/^\/api\/realtime\/v1\/practice\/([\w-]+)\/ticket$/);
        if (ticketMatch) {
          const match = runtime.get(ticketMatch[1]); if (!match) throw new Error('MATCH_UNAVAILABLE');
          const ticket = await practiceTicket(match, ownerHash); renewOwnership(); send(response, 200, ticket); return;
        }
        const abandonMatch = path.match(/^\/api\/realtime\/v1\/practice\/([\w-]+)\/abandon$/);
        if (abandonMatch) { await runtime.abandon(abandonMatch[1], ownerHash); renewOwnership(); send(response, 200, { ok: true }); return; }
        throw new Error('MATCH_UNAVAILABLE');
      }
      if (!['GET', 'HEAD'].includes(method)) throw new Error('MATCH_UNAVAILABLE');
      if (path === '/play/forpost') { response.writeHead(308, { Location: '/play/forpost/' + url.search }); response.end(); return; }
      let directory = staticRoot, part: string;
      const pinned = path.match(/^\/realtime-assets\/([0-9a-f]{64})\/(.*)$/);
      if (pinned && options.contentDirectory) {
        if (!existsSync(resolve(options.contentDirectory, pinned[1]))) throw new Error('MATCH_UNAVAILABLE');
        directory = retainedClientDirectory(options.contentDirectory, 'sha256:' + pinned[1]); part = decodeURIComponent(pinned[2]);
      }
      else if (path.startsWith('/play/forpost/')) part = decodeURIComponent(path.slice('/play/forpost/'.length));
      else throw new Error('MATCH_UNAVAILABLE');
      if (part.split('/').some(segment => segment.startsWith('.') || segment === '_content-manifest.json')) throw new Error('MATCH_UNAVAILABLE');
      const candidate = resolve(directory, part || 'index.html');
      if (!candidate.startsWith(directory + sep)) throw new Error('MATCH_UNAVAILABLE');
      if (!existsSync(candidate) || !statSync(candidate).isFile()) throw new Error('MATCH_UNAVAILABLE');
      const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.glb': 'model/gltf-binary', '.png': 'image/png', '.webp': 'image/webp', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.json': 'application/json' };
      response.setHeader('Content-Type', mime[extname(candidate)] ?? 'application/octet-stream');
      if (pinned) response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      else if (extname(candidate) !== '.html') response.setHeader('Cache-Control', 'public, max-age=86400');
      response.setHeader('Content-Length', statSync(candidate).size);
      if (method === 'HEAD') response.end(); else createReadStream(candidate).on('error', () => response.destroy()).pipe(response);
    } catch (error) { const code = safeError(error); send(response, statusFor(code), { error: { code }, ...(error instanceof StartWaitingError ? { waiting: error.waiting } : {}) }); }
  })(); });
  server.on('upgrade', (request, socket, head) => {
    if (closing || request.url !== WS_PATH || request.headers.origin !== origin || !(request.headers['sec-websocket-protocol'] ?? '').split(',').map(p => p.trim()).includes(WS_PROTOCOL) || sockets.clients.size >= (options.maxRooms ?? 4) * 12) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return;
    }
    sockets.handleUpgrade(request, socket, head, ws => sockets.emit('connection', ws, request));
  });
  sockets.on('connection', (ws: WebSocket) => {
    let peer: Peer | null = null, attempted = false, inputTokens = 90, actionTokens = 20, allTokens = 240, tokenTime = performance.now();
    let pingNonce: Buffer | null = null, pingAt = 0; const rtts: number[] = [];
    const sendWs = (value: unknown) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value)); };
    const timeout = setTimeout(() => ws.close(4001, 'AUTH_REQUIRED'), 5000);
    const pingTimer = setInterval(() => { if (ws.readyState === WebSocket.OPEN) { pingNonce = randomBytes(16); pingAt = performance.now(); ws.ping(pingNonce); } }, 2000);
    pingTimer.unref();
    ws.on('pong', data => { if (peer && pingNonce && data.equals(pingNonce)) { rtts.push(Math.min(300, Math.max(0, performance.now() - pingAt))); if (rtts.length > 9) rtts.shift(); if (rtts.length >= 3) peer.rttMs = [...rtts].sort((a, b) => a - b)[Math.floor(rtts.length / 2)]; pingNonce = null; } });
    ws.on('message', (data, binary) => { void (async () => {
      try {
        if (ws.readyState !== WebSocket.OPEN) return;
        const elapsed = (performance.now() - tokenTime) / 1000; tokenTime = performance.now();
        inputTokens = Math.min(90, inputTokens + elapsed * 30); actionTokens = Math.min(20, actionTokens + elapsed * 10);
        allTokens = Math.min(240, allTokens + elapsed * 120); if (--allTokens < 0) throw new Error('RATE_LIMITED');
        if (binary || !peer && data.toString().length > LIMITS.authBytes) throw new Error('INVALID_MESSAGE');
        const message = parseClientMessage(JSON.parse(data.toString())); if (!message) throw new Error('INVALID_MESSAGE');
        if (!peer) {
          if (attempted || message.type !== 'authenticate') throw new Error('AUTH_REQUIRED'); attempted = true;
          const claims = verifyTicket(message.ticket, keys, origin);
          const candidate: Peer = { id: randomUUID(), claims, send: sendWs, close: (code, reason) => ws.close(code, reason), queuedBytes: () => ws.bufferedAmount,
            rttMs: 0, lastSeen: Date.now(), lastAdmissionCheck: Date.now(), blockedSince: 0 };
          await runtime.connect(candidate);
          if (ws.readyState !== WebSocket.OPEN) { runtime.disconnect(candidate); return; }
          peer = candidate; clearTimeout(timeout); return;
        }
        if (message.type === 'authenticate') throw new Error('AUTH_REQUIRED');
        if (message.type === 'input' && --inputTokens < 0 || ['action', 'claimControl', 'resync'].includes(message.type) && --actionTokens < 0) throw new Error('RATE_LIMITED');
        await runtime.message(peer, message);
      } catch (error) {
        const code = safeError(error); sendWs({ type: 'error', code });
        if (!peer || ['AUTH_REQUIRED', 'INVALID_MESSAGE', 'RATE_LIMITED'].includes(code)) ws.close(4001, code);
      }
    })(); });
    ws.on('close', () => { clearTimeout(timeout); clearInterval(pingTimer); if (peer) runtime.disconnect(peer); });
    ws.on('error', () => {});
  });
  return { server, runtime, async close() { if (closing) return; closing = true; await runtime.close(); sockets.close(); await new Promise<void>(resolveClose => server.close(() => resolveClose())); } };
}

export function trustedKeysFromFile(path: string | undefined): Record<string, string> {
  if (!path) return {};
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!object(value) || Object.values(value).some(p => typeof p !== 'string')) throw new Error('INVALID_TRUSTED_KEYS');
  return value as Record<string, string>;
}
