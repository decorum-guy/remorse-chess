import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { createClientAddressReader, createHttpLifecycle } from '@iva-games/session-kit/http';
import { PlatformError } from './types.js';
import { MAX_PROFILE_BODY } from './avatar-photo.js';
import type { SessionRecord, TelegramIntegration } from './types.js';
import type { TelegramAuth } from './telegram/auth.js';
import { PlatformService, textField } from './service.js';
import { attachPlatformRealtime } from './realtime.js';

const PREFIX = '/api/platform/v1';
const MAX_BODY = 16_384;
export interface HttpOptions {
  publicOrigin: string;
  allowedOrigins?: string[];
  allowedHosts?: string[];
  trustedProxyIps?: readonly string[];
  secureCookies?: boolean;
  serveDirectory?: string;
  telegram?: TelegramIntegration;
  telegramWebhookSecret?: string;
  telegramAuth?: TelegramAuth;
  telegramAuthWebhookSecret?: string;
  shutdownGraceMs?: number;
}
function error(code: string, message: string, status = 400): never { throw new PlatformError(code, message, status); }
function only(body: Record<string, unknown>, fields: string[]): void {
  if (Object.keys(body).some(key => !fields.includes(key))) error('INVALID_INPUT', 'Обновите страницу и попробуйте снова');
}
async function jsonBody(request: IncomingMessage, limit = MAX_BODY): Promise<Record<string, unknown>> {
  if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) error('JSON_REQUIRED', 'Обновите страницу и попробуйте снова', 415);
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > limit) error('BODY_TOO_LARGE', 'Не удалось выполнить действие. Попробуйте ещё раз', 413);
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  let result: unknown;
  try { result = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { error('INVALID_JSON', 'Обновите страницу и попробуйте снова'); }
  if (!result || typeof result !== 'object' || Array.isArray(result)) error('INVALID_JSON', 'Обновите страницу и попробуйте снова');
  return result as Record<string, unknown>;
}
function cookieValue(request: IncomingMessage, name: string): string | undefined {
  const matches = (request.headers.cookie ?? '').split(';').map(value => value.trim()).filter(value => value.startsWith(`${name}=`));
  if (matches.length !== 1) return undefined;
  return matches[0].slice(name.length + 1);
}
function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

export function createPlatformHttpServer(service: PlatformService, options: HttpOptions): Server & { shutdown(): Promise<void> } {
  const origin = new URL(options.publicOrigin).origin;
  const origins = new Set(options.allowedOrigins ?? [origin]);
  const hosts = new Set(options.allowedHosts ?? [new URL(origin).host]);
  const clientAddress = createClientAddressReader(options.trustedProxyIps);
  const secure = options.secureCookies ?? origin.startsWith('https:');
  const cookieName = secure ? '__Host-iva_session' : 'iva_dev_session';
  const staticRoot = options.serveDirectory ? resolve(options.serveDirectory) : null;
  if (options.telegram && (!options.telegramWebhookSecret || !/^[A-Za-z0-9_-]{32,256}$/.test(options.telegramWebhookSecret))) throw new Error('Telegram webhook secret is required');
  const setCookie = (res: ServerResponse, token: string, expires: number): void => {
    const maxAge = Math.max(0, Math.floor((expires - Date.now()) / 1000));
    res.setHeader('Set-Cookie', `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`);
  };
  const clearCookie = (res: ServerResponse): void => { res.setHeader('Set-Cookie', `${cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`); };
  const replacementSession = (res: ServerResponse, previous: SessionRecord | null, playerId: string | null): SessionRecord => {
    if (previous) service.revokeSession(previous.sessionHash);
    const created = service.createSession(playerId);
    setCookie(res, created.token, created.session.expiresAt);
    return created.session;
  };

  const server = createServer((request, response) => { void lifecycle.run(async () => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    // Rapier compiles packaged WebAssembly; JavaScript eval remains disallowed.
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    response.setHeader('X-Frame-Options', 'DENY');
    if (secure) response.setHeader('Strict-Transport-Security', 'max-age=31536000');
    try {
      if (lifecycle.stopping) {
        response.setHeader('Connection', 'close');
        error('SERVER_RESTARTING', 'Обновляем игру. Попробуйте ещё раз', 503);
      }
      const host = request.headers.host;
      if (!host || !hosts.has(host)) error('HOST_NOT_ALLOWED', 'Неверный адрес сайта', 421);
      if (!request.url?.startsWith('/') || request.url.startsWith('//')) error('INVALID_URL', 'Неверный адрес');
      const url = new URL(request.url, origin);
      const path = url.pathname;
      const method = request.method ?? 'GET';
      const client = clientAddress(request);
      // Reverse proxies and household NAT legitimately share one source address.
      service.rateLimit(`http:${client}`, 3000);
      if (method === 'GET' && (path === '/health/live' || path === '/health/ready')) {
        await service.ready; send(response, 200, { ok: true, service: 'iva-platform' }); return;
      }
      if (path === '/integrations/telegram/auth-webhook') {
        if (method !== 'POST') error('METHOD_NOT_ALLOWED', 'Действие недоступно', 405);
        const expected = options.telegramAuthWebhookSecret;
        if (!options.telegramAuth || !expected) error('NOT_FOUND', 'Telegram пока недоступен', 404);
        const supplied = request.headers['x-telegram-bot-api-secret-token'];
        if (typeof supplied !== 'string' || Buffer.byteLength(supplied) !== Buffer.byteLength(expected) ||
          !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) error('WEBHOOK_UNAUTHORIZED', 'Доступ запрещён', 401);
        send(response, 200, options.telegramAuth.webhook(await jsonBody(request, 64 * 1024)));
        return;
      }
      if (path === '/integrations/telegram/webhook') {
        if (method !== 'POST') error('METHOD_NOT_ALLOWED', 'Действие недоступно', 405);
        if (!options.telegram || !options.telegramWebhookSecret) error('NOT_FOUND', 'Telegram пока недоступен', 404);
        const supplied = request.headers['x-telegram-bot-api-secret-token'];
        const expected = options.telegramWebhookSecret;
        if (typeof supplied !== 'string' || Buffer.byteLength(supplied) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) error('WEBHOOK_UNAUTHORIZED', 'Доступ запрещён', 401);
        const body = await jsonBody(request, 64 * 1024);
        send(response, 200, options.telegram.handleUpdate(supplied, body)); return;
      }
      if (!path.startsWith(`${PREFIX}/`)) {
        if (method !== 'GET' && method !== 'HEAD') error('METHOD_NOT_ALLOWED', 'Действие недоступно', 405);
        if (!staticRoot) error('NOT_FOUND', 'Страница не найдена', 404);
        let decoded: string;
        try { decoded = decodeURIComponent(path); } catch { error('INVALID_URL', 'Неверный адрес'); }
        const candidate = resolve(staticRoot, `.${decoded}`);
        if (!candidate.startsWith(`${staticRoot}${sep}`) && candidate !== staticRoot) error('NOT_FOUND', 'Страница не найдена', 404);
        const file = existsSync(candidate) && statSync(candidate).isFile() ? candidate : resolve(staticRoot, 'index.html');
        if (!existsSync(file)) error('NOT_FOUND', 'Сайт пока недоступен', 404);
        const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.wav': 'audio/wav' };
        response.setHeader('Content-Type', mime[extname(file)] ?? 'application/octet-stream');
        if (extname(file) !== '.html') response.setHeader('Cache-Control', 'public, max-age=3600');
        if (method === 'HEAD') response.end();
        else {
          const stream = createReadStream(file);
          response.once('close', () => stream.destroy());
          stream.on('error', () => response.destroy()).pipe(response);
        }
        return;
      }
      const route = path.slice(PREFIX.length);
      await service.ready;
      let session = service.getSession(cookieValue(request, cookieName));
      if (method === 'GET' && route === '/session') {
        if (!session) { service.rateLimit(`bootstrap:${client}`, 60); session = replacementSession(response, null, null); }
        service.rateLimit(`read:${session.sessionHash}`, 300);
        send(response, 200, { user: session.playerId ? service.account(session.playerId) : null, csrfToken: session.csrfToken,
          auth: { email: service.emailDeliveryEnabled, telegram: !!options.telegramAuth } }); return;
      }
      if (method === 'GET' && route === '/games') { send(response, 200, { games: service.catalogue() }); return; }
      if (!['GET', 'POST'].includes(method)) error('METHOD_NOT_ALLOWED', 'Действие недоступно', 405);
      let body: Record<string, unknown> = {};
      if (method === 'POST') {
        if (typeof request.headers.origin !== 'string' || !origins.has(request.headers.origin)) error('ORIGIN_NOT_ALLOWED', 'Обновите страницу и попробуйте снова', 403);
        if (!session) error('SESSION_REQUIRED', 'Обновите страницу и повторите действие', 401);
        service.checkCsrf(session, request.headers['x-csrf-token']);
        if (route === '/profile' && !session.playerId) error('UNAUTHENTICATED', 'Войдите в аккаунт', 401);
        body = await jsonBody(request, route === '/profile' ? MAX_PROFILE_BODY : MAX_BODY);
        // Body upload is asynchronous. A reset/logout while it is arriving must revoke this
        // request too; the pre-upload session object is not an authorization snapshot.
        session = service.getSession(cookieValue(request, cookieName));
        if (!session) error('UNAUTHENTICATED', 'Войдите снова', 401);
        service.checkCsrf(session, request.headers['x-csrf-token']);
      }
      if (method === 'POST' && route.startsWith('/auth/')) {
        service.rateLimit(`auth:${client}`, 30);
        if (route === '/auth/telegram/start' || route === '/auth/telegram/finish') {
          if (!options.telegramAuth) error('TELEGRAM_NOT_CONFIGURED', 'Telegram пока недоступен', 503);
          const current = session!;
          if (route.endsWith('/start')) {
            only(body, ['locale']);
            service.rateLimit(`telegram-signin:${client}`, 20, 10 * 60_000);
            send(response, 201, options.telegramAuth.start(current, body.locale));
          } else {
            only(body, ['attemptId', 'code', 'handle', 'displayName']);
            const result = options.telegramAuth.finish(current, body);
            if ('token' in result) {
              setCookie(response, result.token, result.session.expiresAt);
              send(response, 200, { user: result.user });
            } else send(response, 200, result);
          }
          return;
        }
        if (!service.emailDeliveryEnabled && ['/auth/register', '/auth/login', '/auth/verify', '/auth/forgot-password', '/auth/reset-password'].includes(route))
          error('MAIL_UNAVAILABLE', 'Войдите через Telegram', 503);
        if (route === '/auth/register') {
          only(body, ['email', 'password', 'handle', 'displayName']);
          service.rateLimit(`signup:${client}`, 10, 60 * 60_000);
          const issued = await service.register(body, session?.sessionHash);
          setCookie(response, issued.token, issued.session.expiresAt);
          send(response, 201, { user: issued.user }); return;
        }
        if (route === '/auth/login') {
          only(body, ['email', 'password']);
          const emailKey = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
          service.rateLimit(`login:${client}:${emailKey}`, 10, 15 * 60_000);
          const issued = await service.login(body.email, body.password, session?.sessionHash);
          setCookie(response, issued.token, issued.session.expiresAt);
          send(response, 200, { user: issued.user }); return;
        }
        if (route === '/auth/verify') {
          only(body, ['token']); service.verifyEmail(body.token);
          send(response, 200, { user: session?.playerId ? service.account(session.playerId) : null }); return;
        }
        if (route === '/auth/forgot-password') {
          only(body, ['email']); service.rateLimit(`forgot:${client}`, 5, 60 * 60_000);
          await service.forgotPassword(body.email); send(response, 202, { ok: true }); return;
        }
        if (route === '/auth/reset-password') {
          only(body, ['token', 'password']); service.rateLimit(`reset:${client}`, 10, 60 * 60_000);
          await service.resetPassword(body.token, body.password); clearCookie(response); send(response, 200, { ok: true }); return;
        }
      }
      const actor = session?.playerId;
      if (!session || !actor) error('UNAUTHENTICATED', 'Войдите в аккаунт', 401);
      const match = (pattern: RegExp): RegExpMatchArray | null => route.match(pattern);
      if (method === 'GET') {
        service.rateLimit(`read:${session.sessionHash}`, 300);
        if (route === '/friends') { send(response, 200, service.social(actor)); return; }
        if (route === '/players') { send(response, 200, { players: service.searchPlayers(actor, url.searchParams.get('handle')) }); return; }
        if (route === '/rooms') { send(response, 200, { rooms: service.listRooms(actor), hiddenRoomCount: service.hiddenRoomCount(actor) }); return; }
        if (route === '/invitations') { send(response, 200, { invitations: service.listInvitations(actor) }); return; }
        if (route === '/telegram') { send(response, 200, options.telegram?.getStatus(actor) ?? { available: false, linked: false, reason: 'not_configured' }); return; }
        let groups: RegExpMatchArray | null;
        if ((groups = match(/^\/avatars\/([a-f0-9-]{36})$/))) {
          const photo = service.avatarPhoto(groups[1], actor);
          if (!photo) error('NOT_FOUND', 'Фото не найдено', 404);
          response.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': photo.length });
          response.end(photo); return;
        }
        if ((groups = match(/^\/telegram\/link-attempts\/([\w-]+)$/))) {
          if (!options.telegram) error('TELEGRAM_NOT_CONFIGURED', 'Telegram пока недоступен', 503);
          send(response, 200, options.telegram.getAttemptStatus(session, groups[1])); return;
        }
        if ((groups = match(/^\/rooms\/([\w-]+)$/))) { send(response, 200, { room: service.getRoom(actor, groups[1]) }); return; }
        if ((groups = match(/^\/rooms\/([\w-]+)\/match$/))) { send(response, 200, { view: await service.matchView(actor, groups[1]) }); return; }
        if ((groups = match(/^\/invitations\/([\w-]+)$/))) { send(response, 200, { invitation: service.getInvitation(actor, groups[1]) }); return; }
        error('NOT_FOUND', 'Не найдено', 404);
      }
      service.rateLimit(`mutation:${actor}`, 120);
      if (route === '/auth/logout') { only(body, []); service.revokeSession(session.sessionHash); clearCookie(response); send(response, 200, { ok: true }); return; }
      if (route === '/auth/resend-verification') { only(body, []); await service.resendVerification(actor); send(response, 200, { ok: true }); return; }
      if (route === '/auth/reauthenticate') { only(body, ['password']); await service.reauthenticate(session, body.password); send(response, 200, { ok: true }); return; }
      if (route === '/auth/revoke-sessions') {
        only(body, ['password']); await service.revokeAllWithPassword(session, body.password); clearCookie(response); send(response, 200, { ok: true }); return;
      }
      if (route.startsWith('/telegram/')) {
        if (!options.telegram) error('TELEGRAM_NOT_CONFIGURED', 'Telegram пока недоступен', 503);
        service.requireVerified(actor);
        let result: unknown;
        let groups: RegExpMatchArray | null;
        if (route === '/telegram/link-attempts') { only(body, []); result = options.telegram.createAttempt(session); }
        else if ((groups = match(/^\/telegram\/link-attempts\/([\w-]+)\/confirm$/))) {
          only(body, ['proofCode', 'consent']);
          if (typeof body.consent !== 'boolean') error('INVALID_INPUT', 'Выберите, получать ли приглашения в Telegram');
          result = options.telegram.confirm(session, { attemptId: groups[1], proofCode: textField(body.proofCode, 'proofCode', 1, 32), consent: body.consent });
        } else if ((groups = match(/^\/telegram\/link-attempts\/([\w-]+)\/cancel$/))) {
          only(body, []); options.telegram.cancelAttempt(session, groups[1]); result = { ok: true };
        } else if (route === '/telegram/preferences') {
          only(body, ['enabled']); if (typeof body.enabled !== 'boolean') error('INVALID_INPUT', 'Выберите, получать ли уведомления');
          result = options.telegram.setDelivery(session, body.enabled);
        } else if (route === '/telegram/unlink') { only(body, []); result = options.telegram.unlink(session); }
        else error('NOT_FOUND', 'Не найдено', 404);
        send(response, 200, result); return;
      }
      const idem = request.headers['idempotency-key'];
      if (Array.isArray(idem)) error('INVALID_IDEMPOTENCY_KEY', 'Обновите страницу и попробуйте снова');
      const mutate = <T>(fields: string[], work: () => T): T => {
        only(body, fields); return service.mutation(actor, route, idem, body, work);
      };
      let result: unknown;
      let groups: RegExpMatchArray | null;
      if (route === '/profile') {
        if (body.avatarPhoto !== undefined) service.rateLimit(`avatar-photo:${actor}`, 20, 60_000);
        result = mutate(['displayName', 'avatar', 'avatarPhoto'], () => ({ user: service.updateProfile(actor, body) }));
      }
      else if (route === '/friend-requests') result = mutate(['playerId'], () => service.requestFriend(actor, body.playerId));
      else if ((groups = match(/^\/friend-requests\/([\w-]+)\/(accept|decline|cancel)$/))) {
        const [, id, action] = groups; result = mutate([], () => { service.respondFriend(actor, id, action as 'accept' | 'decline' | 'cancel'); return { ok: true }; });
      } else if ((groups = match(/^\/friends\/([\w-]+)\/remove$/))) {
        const id = groups[1]; result = mutate([], () => { service.removeFriend(actor, id); return { ok: true }; });
      } else if (route === '/blocks') result = mutate(['playerId'], () => { service.blockPlayer(actor, body.playerId); return { ok: true }; });
      else if ((groups = match(/^\/blocks\/([\w-]+)\/remove$/))) {
        const id = groups[1]; result = mutate([], () => { service.unblockPlayer(actor, id); return { ok: true }; });
      } else if (route === '/rooms/history/clear') result = mutate([], () => { service.clearRoomHistory(actor); return { ok: true }; });
      else if (route === '/rooms/history/restore') result = mutate([], () => { service.restoreRoomHistory(actor); return { ok: true }; });
      else if (route === '/rooms') result = mutate(['gameId', 'capacity', 'title', 'settings'], () => ({ room: service.createRoom(actor, body) }));
      else if ((groups = match(/^\/rooms\/([\w-]+)\/(ready|settings|transfer-host|leave|cancel|kick|bots|join|start|invitations|actions)$/))) {
        const [, id, action] = groups;
        if (action === 'ready') result = mutate(['ready', 'expectedRevision'], () => ({ room: service.setReady(actor, id, body) }));
        else if (action === 'settings') result = mutate(['capacity', 'title', 'settings', 'expectedRevision'], () => ({ room: service.changeSettings(actor, id, body) }));
        else if (action === 'transfer-host') result = mutate(['playerId', 'expectedRevision'], () => ({ room: service.transferHost(actor, id, body) }));
        else if (action === 'leave') result = mutate([], () => ({ room: service.leaveRoom(actor, id) }));
        else if (action === 'cancel') result = mutate([], () => ({ room: service.cancelRoom(actor, id) }));
        else if (action === 'join') result = mutate([], () => ({ room: service.joinRoom(actor, id) }));
        else if (action === 'kick') result = mutate(['participantId', 'expectedRevision'], () => ({ room: service.kick(actor, id, body) }));
        else if (action === 'bots') result = mutate(['difficulty', 'expectedRevision'], () => ({ room: service.addBot(actor, id, body) }));
        else if (action === 'invitations') result = mutate(['playerId'], () => ({ invitation: service.invite(actor, id, body.playerId) }));
        else if (action === 'start') {
          mutate(['expectedRevision'], () => service.startRoom(actor, id, body)); await service.reconcile(); result = { room: service.getRoom(actor, id) };
        } else {
          only(body, ['actionId', 'expectedRevision', 'payload']); result = { view: await service.matchAction(actor, id, body) };
        }
      } else if ((groups = match(/^\/rooms\/([\w-]+)\/bots\/([\w-]+)\/remove$/))) {
        const [, id, bot] = groups; result = mutate(['expectedRevision'], () => ({ room: service.removeBot(actor, id, bot, body) }));
      } else if ((groups = match(/^\/invitations\/([\w-]+)\/(accept|decline|revoke)$/))) {
        const [, id, action] = groups;
        result = mutate([], () => ({ invitation: action === 'accept' ? service.acceptInvitation(actor, id) : action === 'decline' ? service.declineInvitation(actor, id) : service.revokeInvitation(actor, id) }));
      } else error('NOT_FOUND', 'Не найдено', 404);
      send(response, 200, result);
    } catch (caught) {
      if (response.destroyed) return;
      if (response.headersSent) { response.destroy(); return; }
      if (caught instanceof PlatformError) {
        if (caught.status === 429) response.setHeader('Retry-After', '60');
        send(response, caught.status, { error: { code: caught.code, message: caught.message } });
      } else if (caught && typeof caught === 'object' && 'code' in caught && 'statusCode' in caught && typeof caught.code === 'string' && typeof caught.statusCode === 'number' && caught.statusCode >= 400 && caught.statusCode <= 599) {
        send(response, caught.statusCode, { error: { code: caught.code, message: caught instanceof Error ? caught.message : 'Игровое действие отклонено' } });
      } else {
        send(response, 500, { error: { code: 'INTERNAL_ERROR', message: 'Не удалось выполнить действие. Попробуйте ещё раз' } });
      }
    }
  }); });
  const lifecycle = createHttpLifecycle(server, options.shutdownGraceMs);
  const live = attachPlatformRealtime(server, service, { origin, hosts, cookieName, clientAddress, stopping: () => lifecycle.stopping });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  let shutdownPromise: Promise<void> | undefined;
  return Object.assign(server, { shutdown: () => {
    if (!shutdownPromise) {
      const httpClosed = lifecycle.close();
      shutdownPromise = (async () => { await live.close(); await httpClosed; })();
    }
    return shutdownPromise;
  } });
}
