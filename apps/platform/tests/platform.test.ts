import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { request as httpRequest } from 'node:http';
import { createPlatformLabRegistration } from '@iva-games/session-kit/lab';
import { SessionError } from '@iva-games/session-kit';
import { MemoryMailbox } from '../src/mail';
import { PlatformService } from '../src/service';
import { createPlatformHttpServer } from '../src/http';
import { loadPlatformConfig } from '../src/config';
import { TelegramService } from '../src/telegram/index';
import type { TelegramAttemptStatus, TelegramStatus } from '../src/telegram/index';
import type { TelegramMessage } from '@iva-games/telegram-transport';
import type { Account, GameRegistration, Invitation, Room } from '../src/types';

const ORIGIN = 'http://portal.test';
const PASSWORD = 'A real long test password 72';
const WEBHOOK_SECRET = 'test_only_webhook_secret_not_for_real_use_123';
const verifyGate = vi.hoisted(() => ({ pause: null as null | (() => Promise<void>) }));
vi.mock('@node-rs/argon2', async importOriginal => {
  const actual = await importOriginal<typeof import('@node-rs/argon2')>();
  return { ...actual, verify: async (...args: Parameters<typeof actual.verify>) => {
    const result = await actual.verify(...args);
    if (verifyGate.pause) await verifyGate.pause();
    return result;
  } };
});
interface Reply<T = Record<string, unknown>> { status: number; body: T; headers: Headers }
class Client {
  cookie = '';
  csrf = '';
  constructor(public endpoint: string) {}
  async request<T = Record<string, unknown>>(path: string, body?: unknown, extra: Record<string, string> = {}): Promise<Reply<T>> {
    const response = await new Promise<Reply<T>>((resolve, reject) => {
      const request = httpRequest(`${this.endpoint}/api/platform/v1${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Host: 'portal.test', Origin: ORIGIN, Cookie: this.cookie, 'X-CSRF-Token': this.csrf, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra },
      }, incoming => {
        const chunks: Buffer[] = [];
        incoming.on('data', chunk => chunks.push(Buffer.from(chunk)));
        incoming.on('end', () => {
          const headers = new Headers();
          for (const [name, value] of Object.entries(incoming.headers)) for (const item of Array.isArray(value) ? value : value ? [value] : []) headers.append(name, item);
          resolve({ status: incoming.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) as T, headers });
        });
      });
      request.on('error', reject); request.end(body === undefined ? undefined : JSON.stringify(body));
    });
    const cookie = response.headers.get('set-cookie');
    if (cookie) this.cookie = cookie.split(';')[0];
    return response;
  }
  async session(): Promise<{ user: Account | null; csrfToken: string }> {
    const reply = await this.request<{ user: Account | null; csrfToken: string }>('/session');
    expect(reply.status).toBe(200); this.csrf = reply.body.csrfToken; return reply.body;
  }
  async room(id: string): Promise<Room> { const response = await this.request<{ room: Room }>(`/rooms/${id}`); expect(response.status).toBe(200); return response.body.room; }
}
interface Fixture {
  directory: string; platform: PlatformService; lab: ReturnType<typeof createPlatformLabRegistration>;
  mailbox: MemoryMailbox; server: Server; endpoint: string; now: { value: number }; stopped: boolean;
  telegram?: TelegramService; telegramMessages: TelegramMessage[];
  client: () => Client; stop: () => Promise<void>;
}
const fixtures: Fixture[] = [];
async function fixture(options: { directory?: string; now?: { value: number }; runtimeTimeoutMs?: number; telegram?: boolean; trustedProxyIps?: readonly string[]; games?: (lab: ReturnType<typeof createPlatformLabRegistration>) => GameRegistration[] } = {}): Promise<Fixture> {
  const directory = options.directory ?? await mkdtemp(join(tmpdir(), 'iva-platform-'));
  const now = options.now ?? { value: Date.now() };
  const mailbox = new MemoryMailbox();
  const lab = createPlatformLabRegistration({ databasePath: join(directory, 'lab.sqlite'), now: () => now.value });
  const platform = new PlatformService({ databasePath: join(directory, 'platform.sqlite'), publicOrigin: ORIGIN, mail: mailbox, games: options.games?.(lab) ?? [lab], now: () => now.value, runtimeTimeoutMs: options.runtimeTimeoutMs });
  await platform.ready;
  const telegramMessages: TelegramMessage[] = [];
  const telegram = options.telegram ? new TelegramService({ db: platform.db, publicOrigin: ORIGIN,
    botId: '12345678', botUsername: 'iva_test_bot', webhookSecret: WEBHOOK_SECRET,
    proofEncryptionKey: new Uint8Array(32).fill(7), now: () => now.value,
    transport: { sendMessage: async message => { telegramMessages.push(message); return { outcome: 'accepted', messageId: String(telegramMessages.length) }; } },
  }) : undefined;
  if (telegram) platform.setInvitationDelivery(id => telegram.enqueueInvitation(id));
  const server = createPlatformHttpServer(platform, { publicOrigin: ORIGIN, allowedHosts: ['portal.test'], secureCookies: false, trustedProxyIps: options.trustedProxyIps, telegram, telegramWebhookSecret: telegram ? WEBHOOK_SECRET : undefined });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const value: Fixture = { directory, platform, lab, mailbox, server, endpoint, now, telegram, telegramMessages, stopped: false, client: () => new Client(endpoint),
    stop: async () => { if (value.stopped) return; value.stopped = true; await new Promise<void>(resolve => server.close(() => resolve())); platform.close(); lab.close(); },
  };
  fixtures.push(value); return value;
}
afterEach(async () => {
  verifyGate.pause = null;
  for (const f of fixtures) await f.stop();
  for (const directory of new Set(fixtures.map(f => f.directory))) await rm(directory, { recursive: true, force: true });
  fixtures.length = 0;
});
function mailToken(f: Fixture, email: string, kind: 'verification' | 'password_reset'): string {
  const mail = f.mailbox.messages.filter(item => item.to === email && item.kind === kind).at(-1);
  expect(mail).toBeDefined();
  return new URL(mail!.text.match(/https?:\/\/\S+/)![0]).searchParams.get('token')!;
}
async function signup(f: Fixture, handle: string, verified = true): Promise<{ client: Client; account: Account }> {
  const client = f.client(); await client.session();
  const result = await client.request<{ user: Account }>('/auth/register', { email: `${handle}@example.test`, password: PASSWORD, handle, displayName: `Игрок ${handle}` });
  expect(result.status).toBe(201); await client.session();
  if (verified) {
    expect((await client.request('/auth/verify', { token: mailToken(f, `${handle}@example.test`, 'verification') })).status).toBe(200);
  }
  return { client, account: (await client.session()).user! };
}
async function befriend(a: Awaited<ReturnType<typeof signup>>, b: Awaited<ReturnType<typeof signup>>): Promise<void> {
  const request = await a.client.request<{ requestId: string }>('/friend-requests', { playerId: b.account.playerId });
  expect(request.status).toBe(200);
  expect((await b.client.request(`/friend-requests/${request.body.requestId}/accept`, {})).status).toBe(200);
}
async function newRoom(client: Client, capacity = 2): Promise<Room> {
  const reply = await client.request<{ room: Room }>('/rooms', { gameId: 'platform-lab', capacity });
  expect(reply.status).toBe(200); return reply.body.room;
}
async function invite(host: Client, room: Room, playerId: string): Promise<Invitation> {
  const reply = await host.request<{ invitation: Invitation }>(`/rooms/${room.roomId}/invitations`, { playerId });
  expect(reply.status).toBe(200); return reply.body.invitation;
}
async function acceptJoin(client: Client, invitation: Invitation): Promise<Room> {
  expect((await client.request(`/invitations/${invitation.invitationId}/accept`, {})).status).toBe(200);
  const joined = await client.request<{ room: Room }>(`/rooms/${invitation.roomId}/join`, {});
  expect(joined.status).toBe(200); return joined.body.room;
}
async function webhook(f: Fixture, body: unknown, secret = WEBHOOK_SECRET): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(`${f.endpoint}/integrations/telegram/webhook`, { method: 'POST', headers: {
      Host: 'portal.test', 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret,
    } }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => resolve({ status: response.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()), headers: new Headers() }));
    });
    request.on('error', reject); request.end(JSON.stringify(body));
  });
}

describe('Iva Games platform: independent HTTP clients and persistent authority', () => {
  it('permits packaged WebAssembly compilation without enabling JavaScript eval or relaxing HTTP guards', async () => {
    const f = await fixture();
    const reply = await f.client().request('/session');
    expect(reply.status).toBe(200);
    const policy = reply.headers.get('Content-Security-Policy'); expect(policy).not.toBeNull();
    const directives = new Map(policy!.split(';').map(value => {
      const [name, ...sources] = value.trim().split(/\s+/); return [name, sources] as const;
    }));
    const scripts = directives.get('script-src');
    expect(scripts).toContain("'wasm-unsafe-eval'");
    expect(scripts).not.toContain("'unsafe-eval'");
    expect(scripts).not.toContain("'unsafe-inline'");
    expect(scripts).toEqual(["'self'", "'wasm-unsafe-eval'"]);
    expect(directives.get('default-src')).toEqual(["'self'"]);
    expect(directives.get('connect-src')).toEqual(["'self'"]);
    expect(directives.get('style-src')).toEqual(["'self'", "'unsafe-inline'"]);
    expect(directives.get('img-src')).toEqual(["'self'", 'data:']);
    expect(directives.get('font-src')).toEqual(["'self'"]);
    expect(directives.get('frame-ancestors')).toEqual(["'none'"]);
    expect(directives.get('base-uri')).toEqual(["'none'"]);
    expect(directives.get('form-action')).toEqual(["'self'"]);
    expect(reply.headers.get('X-Frame-Options')).toBe('DENY');
    expect(reply.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(reply.headers.get('Cross-Origin-Resource-Policy')).toBe('same-origin');
    expect(reply.headers.get('Referrer-Policy')).toBe('no-referrer');
  });

  it('keeps signup and recovery limits separate for clients behind the trusted edge proxy', async () => {
    const f = await fixture({ trustedProxyIps: ['127.0.0.1'] });
    const alice = f.client(), bob = f.client();
    await alice.session(); await bob.session();
    const a = { 'X-Iva-Client-IP': '198.51.100.10' }, b = { 'X-Iva-Client-IP': '198.51.100.11' };
    // Invalid registrations still consume the abuse limit, without creating test accounts.
    for (let i = 0; i < 10; i++) expect((await alice.request('/auth/register', {}, a)).status).toBe(400);
    expect((await alice.request('/auth/register', {}, a)).status).toBe(429);
    expect((await bob.request('/auth/register', {}, b)).status).toBe(400);
    for (let i = 0; i < 5; i++) expect((await alice.request('/auth/forgot-password', { email: 'absent@example.test' }, a)).status).toBe(202);
    expect((await alice.request('/auth/forgot-password', { email: 'absent@example.test' }, { ...a, 'X-Forwarded-For': '203.0.113.200' })).status).toBe(429);
    expect((await bob.request('/auth/forgot-password', { email: 'absent@example.test' }, b)).status).toBe(202);
    expect(f.mailbox.messages).toHaveLength(0);
  });

  it('does not let an untrusted peer escape recovery limits with forged address headers', async () => {
    const f = await fixture({ trustedProxyIps: ['192.0.2.20'] });
    const client = f.client(); await client.session();
    for (let i = 0; i < 5; i++) {
      expect((await client.request('/auth/forgot-password', { email: 'absent@example.test' }, { 'X-Iva-Client-IP': `198.51.100.${i + 1}` })).status).toBe(202);
    }
    expect((await client.request('/auth/forgot-password', { email: 'absent@example.test' }, { 'X-Iva-Client-IP': '203.0.113.1', 'X-Forwarded-For': '203.0.113.2' })).status).toBe(429);
  });

  it('registers a real hashed account, gates unverified actions, verifies once and rotates sessions at login', async () => {
    const f = await fixture();
    const { client, account } = await signup(f, 'alice', false);
    expect(account.emailVerified).toBe(false);
    expect((await client.request('/rooms', { gameId: 'platform-lab', capacity: 2 })).status).toBe(403);
    const token = mailToken(f, account.email, 'verification');
    expect((await client.request('/auth/verify', { token })).status).toBe(200);
    expect((await client.request('/auth/verify', { token })).status).toBe(400);
    const stored = f.platform.db.prepare('SELECT * FROM players').get() as Record<string, string>;
    expect(stored.password_hash).toMatch(/^\$argon2id\$/);
    expect(JSON.stringify(stored)).not.toContain(PASSWORD);
    expect((await client.session()).user?.emailVerified).toBe(true);
    const oldCookie = client.cookie;
    expect((await client.request('/auth/login', { email: 'ALICE@EXAMPLE.TEST', password: PASSWORD })).status).toBe(200);
    expect(client.cookie).not.toBe(oldCookie);
    const hijack = f.client(); hijack.cookie = oldCookie;
    expect((await hijack.session()).user).toBeNull();
    const databaseText = (await readFile(join(f.directory, 'platform.sqlite'))).toString('utf8');
    expect(databaseText).not.toContain(token);
  });

  it('protects every cookie mutation from hostile Origin/CSRF/Host and forged identities', async () => {
    const f = await fixture(); const alice = await signup(f, 'alice');
    expect((await alice.client.request('/rooms', { gameId: 'platform-lab', capacity: 2 }, { Origin: 'https://evil.test' })).status).toBe(403);
    expect((await alice.client.request('/rooms', { gameId: 'platform-lab', capacity: 2 }, { 'X-CSRF-Token': 'x'.repeat(43) })).status).toBe(403);
    expect((await alice.client.request('/rooms', { gameId: 'platform-lab', capacity: 2 }, { Host: 'evil.test' })).status).toBe(421);
    expect((await alice.client.request('/rooms', { gameId: 'platform-lab', capacity: 2, playerId: 'forged' })).status).toBe(400);
    const room = await newRoom(alice.client);
    expect(room.hostPlayerId).toBe(alice.account.playerId);
    expect((await alice.client.request(`/rooms/${room.roomId}/ready`, { ready: true, expectedRevision: room.revision, playerId: 'forged' })).status).toBe(400);
    const other = f.client(); await other.session();
    expect((await other.request(`/rooms/${room.roomId}`)).status).toBe(401);
  });

  it('recovers access with one-use reset token and revokes all existing sessions', async () => {
    const f = await fixture(); const alice = await signup(f, 'alice');
    const second = f.client(); await second.session();
    expect((await second.request('/auth/login', { email: alice.account.email, password: PASSWORD })).status).toBe(200); await second.session();
    const recovery = f.client(); await recovery.session();
    const known = await recovery.request('/auth/forgot-password', { email: alice.account.email });
    const unknown = await recovery.request('/auth/forgot-password', { email: 'absent@example.test' });
    expect(known).toMatchObject({ status: 202, body: { ok: true } }); expect(unknown.body).toEqual(known.body);
    const token = mailToken(f, alice.account.email, 'password_reset');
    const replacement = 'Another completely long password 94';
    expect((await recovery.request('/auth/reset-password', { token, password: replacement })).status).toBe(200);
    expect((await alice.client.session()).user).toBeNull(); expect((await second.session()).user).toBeNull();
    await recovery.session();
    expect((await recovery.request('/auth/reset-password', { token, password: replacement })).status).toBe(400);
    expect((await recovery.request('/auth/login', { email: alice.account.email, password: PASSWORD })).status).toBe(401);
    expect((await recovery.request('/auth/login', { email: alice.account.email, password: replacement })).status).toBe(200);
  });

  it('does not issue a session from an old password when reset commits during Argon2 verification', async () => {
    const f = await fixture(); const alice = await signup(f, 'alice');
    const loginClient = f.client(); await loginClient.session();
    await alice.client.request('/auth/forgot-password', { email: alice.account.email });
    const token = mailToken(f, alice.account.email, 'password_reset');
    let entered!: () => void; let release!: () => void;
    const paused = new Promise<void>(resolve => { entered = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    verifyGate.pause = async () => { entered(); await released; };
    const pending = loginClient.request('/auth/login', { email: alice.account.email, password: PASSWORD });
    try {
      await paused;
      expect((await alice.client.request('/auth/reset-password', { token, password: 'A different long password after reset' })).status).toBe(200);
    } finally { verifyGate.pause = null; release(); }
    expect((await pending).status).toBe(401);
    expect((await loginClient.session()).user).toBeNull();
    expect(f.platform.db.prepare('SELECT COUNT(*) AS count FROM web_sessions WHERE player_id=?').get(alice.account.playerId)).toEqual({ count: 0 });
  });

  it('rejects delayed-body writes and reauthentication after the session is revoked', async () => {
    const f = await fixture(); const alice = await signup(f, 'alice');
    const original = f.platform.getSession.bind(f.platform);
    let seen!: () => void; const sessionSeen = new Promise<void>(resolve => { seen = resolve; });
    f.platform.getSession = token => { const result = original(token); seen(); return result; };
    const content = JSON.stringify({ displayName: 'Changed after revocation' });
    let request!: ReturnType<typeof httpRequest>;
    const delayed = new Promise<number>((resolve, reject) => {
      request = httpRequest(`${f.endpoint}/api/platform/v1/profile`, { method: 'POST', headers: {
        Host: 'portal.test', Origin: ORIGIN, Cookie: alice.client.cookie, 'X-CSRF-Token': alice.client.csrf,
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(content),
      } }, response => { response.resume(); response.on('end', () => resolve(response.statusCode!)); });
      request.on('error', reject);
    });
    request.write(content.slice(0, 1)); await sessionSeen;
    f.platform.revokeAllSessions(alice.account.playerId);
    request.end(content.slice(1));
    expect(await delayed).toBe(401);
    expect(f.platform.account(alice.account.playerId).displayName).toBe(alice.account.displayName);
    f.platform.getSession = original;

    await alice.client.session(); await alice.client.request('/auth/login', { email: alice.account.email, password: PASSWORD }); await alice.client.session();
    let entered!: () => void; let release!: () => void;
    const paused = new Promise<void>(resolve => { entered = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    verifyGate.pause = async () => { entered(); await released; };
    const reauth = alice.client.request('/auth/reauthenticate', { password: PASSWORD });
    try { await paused; f.platform.revokeAllSessions(alice.account.playerId); }
    finally { verifyGate.pause = null; release(); }
    expect((await reauth).status).toBe(401);
  });

  it('keeps crossed friend requests pending, limits acceptance to recipient and never exposes private emails', async () => {
    const f = await fixture(); const alice = await signup(f, 'alice'); const bob = await signup(f, 'bobby');
    const created = await alice.client.request<{ requestId: string }>('/friend-requests', { playerId: bob.account.playerId });
    const crossed = await bob.client.request('/friend-requests', { playerId: alice.account.playerId });
    expect(crossed.body).toMatchObject({ requestId: created.body.requestId, state: 'pending' });
    expect((await alice.client.request(`/friend-requests/${created.body.requestId}/accept`, {})).status).toBe(403);
    expect((await bob.client.request(`/friend-requests/${created.body.requestId}/accept`, {})).status).toBe(200);
    const friends = await alice.client.request('/friends');
    expect(friends.body).toMatchObject({ friends: [{ playerId: bob.account.playerId }] });
    expect(JSON.stringify(friends.body)).not.toContain('@example.test');
    const search = await alice.client.request('/players?handle=bob'); expect(JSON.stringify(search.body)).not.toContain('email');
    expect((await alice.client.request(`/friends/${bob.account.playerId}/remove`, {})).status).toBe(200);
    expect((await bob.client.request('/friend-requests', { playerId: alice.account.playerId })).status).toBe(409);
    f.now.value += 86_400_001;
    expect((await bob.client.request('/friend-requests', { playerId: alice.account.playerId })).status).toBe(200);
  });

  it('atomically reserves the last seat across concurrent clients and requires a separate join', async () => {
    const f = await fixture(); const host = await signup(f, 'hoster'); const bob = await signup(f, 'bobby'); const cara = await signup(f, 'carol');
    await befriend(host, bob); await befriend(host, cara);
    const room = await newRoom(host.client, 2); const b = await invite(host.client, room, bob.account.playerId); const c = await invite(host.client, room, cara.account.playerId);
    expect((await cara.client.request(`/invitations/${b.invitationId}`)).status).toBe(404);
    const replies = await Promise.all([bob.client.request<{ invitation: Invitation; error: { code: string } }>(`/invitations/${b.invitationId}/accept`, {}), cara.client.request<{ invitation: Invitation; error: { code: string } }>(`/invitations/${c.invitationId}/accept`, {})]);
    expect(replies.map(r => r.status).sort()).toEqual([200, 409]);
    const winner = replies[0].status === 200 ? bob : cara;
    const winnerInvite = replies[0].status === 200 ? b : c;
    const loserInvite = replies[0].status === 200 ? c : b;
    const loser = replies[0].status === 200 ? cara : bob;
    const reserved = await host.client.room(room.roomId); expect(reserved.members).toHaveLength(1); expect(reserved.reservedSeats).toBe(1);
    expect((await loser.client.request<{ invitation: Invitation }>(`/invitations/${loserInvite.invitationId}`)).body.invitation).toMatchObject({ status: 'pending', displayStatus: 'full' });
    expect((await winner.client.request(`/invitations/${winnerInvite.invitationId}/accept`, {})).status).toBe(200);
    const joined = await winner.client.request<{ room: Room }>(`/rooms/${room.roomId}/join`, {}); expect(joined.body.room.members).toHaveLength(2);
    expect((await winner.client.request<{ room: Room }>(`/rooms/${room.roomId}/join`, {})).body.room.members).toHaveLength(2);
    expect((await loser.client.request(`/rooms/${room.roomId}/join`, {})).status).toBe(403);
  });

  it('expires an unused reservation and revokes pending access on block without ejecting joined players', async () => {
    const f = await fixture(); const host = await signup(f, 'hoster'); const bob = await signup(f, 'bobby'); const cara = await signup(f, 'carol');
    await befriend(host, bob); await befriend(host, cara);
    const room = await newRoom(host.client, 2); const b = await invite(host.client, room, bob.account.playerId); const c = await invite(host.client, room, cara.account.playerId);
    expect((await bob.client.request(`/invitations/${b.invitationId}/accept`, {})).status).toBe(200);
    f.now.value += 120_001; await f.platform.reconcile();
    expect((await bob.client.request<{ invitation: Invitation }>(`/invitations/${b.invitationId}`)).body.invitation).toMatchObject({ status: 'expired', reason: 'reservation_expired' });
    await acceptJoin(cara.client, c);
    expect((await host.client.request('/blocks', { playerId: cara.account.playerId })).status).toBe(200);
    expect((await host.client.room(room.roomId)).members).toHaveLength(2);
    expect((await cara.client.request('/friend-requests', { playerId: host.account.playerId })).status).toBe(403);
    expect((await cara.client.request(`/rooms/${room.roomId}/leave`, {})).status).toBe(200);
    expect((await cara.client.request(`/rooms/${room.roomId}/join`, {})).status).toBe(403);
    expect((await host.client.request(`/blocks/${cara.account.playerId}/remove`, {})).status).toBe(200);
    expect((await host.client.request<{ friends: unknown[] }>('/friends')).body.friends).toHaveLength(1);
  });

  it('keeps active rooms discoverable after terminal history exceeds the list limit', async () => {
    const f = await fixture(); const host = await signup(f, 'hoster'); const outsider = await signup(f, 'outsider');
    const lobby = await newRoom(host.client);
    f.now.value++;
    let playing = await newRoom(host.client);
    playing = (await host.client.request<{ room: Room }>(`/rooms/${playing.roomId}/bots`, { difficulty: 'easy', expectedRevision: playing.revision })).body.room;
    expect((await host.client.request(`/rooms/${playing.roomId}/ready`, { ready: true, expectedRevision: playing.revision })).status).toBe(200);
    const started = await host.client.request<{ room: Room }>(`/rooms/${playing.roomId}/start`, { expectedRevision: playing.revision });
    expect(started.body.room.state).toBe('playing');
    const history: string[] = [];
    for (let index = 0; index < 51; index++) {
      f.now.value++;
      const room = await newRoom(host.client); history.push(room.roomId);
      expect((await host.client.request(`/rooms/${room.roomId}/cancel`, {})).status).toBe(200);
    }
    const listed = await host.client.request<{ rooms: Room[] }>('/rooms');
    expect(listed.status).toBe(200);
    expect(listed.body.rooms.slice(0, 2).map(room => room.roomId)).toEqual([playing.roomId, lobby.roomId]);
    expect(listed.body.rooms.slice(2).map(room => room.roomId)).toEqual(history.slice(1).reverse());
    expect((await outsider.client.request<{ rooms: Room[] }>('/rooms')).body.rooms).toEqual([]);
    expect((await host.client.room(lobby.roomId)).state).toBe('lobby');
  });

  it('clears and restores only the requesting player’s finished rooms without deleting matches or active rooms', async () => {
    const f = await fixture(); const host = await signup(f, 'hoster'); const guest = await signup(f, 'guest');
    await befriend(host, guest);
    const lobby = await newRoom(host.client);
    let playing = await newRoom(host.client);
    playing = (await host.client.request<{ room: Room }>(`/rooms/${playing.roomId}/bots`, { difficulty: 'easy', expectedRevision: playing.revision })).body.room;
    await host.client.request(`/rooms/${playing.roomId}/ready`, { ready: true, expectedRevision: playing.revision });
    playing = (await host.client.request<{ room: Room }>(`/rooms/${playing.roomId}/start`, { expectedRevision: playing.revision })).body.room;
    let finished = await newRoom(host.client);
    finished = (await host.client.request<{ room: Room }>(`/rooms/${finished.roomId}/bots`, { difficulty: 'easy', expectedRevision: finished.revision })).body.room;
    await host.client.request(`/rooms/${finished.roomId}/ready`, { ready: true, expectedRevision: finished.revision });
    finished = (await host.client.request<{ room: Room }>(`/rooms/${finished.roomId}/start`, { expectedRevision: finished.revision })).body.room;
    f.platform.db.prepare("UPDATE rooms SET state='finished' WHERE room_id=?").run(finished.roomId);
    const shared = await newRoom(host.client);
    await acceptJoin(guest.client, await invite(host.client, shared, guest.account.playerId));
    expect((await host.client.request(`/rooms/${shared.roomId}/cancel`, {})).status).toBe(200);

    expect((await host.client.request('/rooms/history/clear', {})).status).toBe(200);
    let listed = (await host.client.request<{ rooms: Room[]; hiddenRoomCount: number }>('/rooms')).body;
    expect(listed.rooms.map(room => room.roomId).sort()).toEqual([lobby.roomId, playing.roomId].sort());
    expect(listed.hiddenRoomCount).toBe(2);
    expect((await guest.client.request<{ rooms: Room[] }>('/rooms')).body.rooms.map(room => room.roomId)).toContain(shared.roomId);
    expect((await host.client.room(shared.roomId)).state).toBe('cancelled');
    expect((await host.client.room(finished.roomId)).matchId).toBe(finished.matchId);

    await f.stop();
    const restarted = await fixture({ directory: f.directory });
    const client = restarted.client(); client.cookie = host.client.cookie; client.csrf = host.client.csrf;
    listed = (await client.request<{ rooms: Room[]; hiddenRoomCount: number }>('/rooms')).body;
    expect(listed.hiddenRoomCount).toBe(2);
    const later = await newRoom(client); await client.request(`/rooms/${later.roomId}/cancel`, {});
    expect((await client.request<{ rooms: Room[] }>('/rooms')).body.rooms.map(room => room.roomId)).toContain(later.roomId);
    expect((await client.request('/rooms/history/restore', {})).status).toBe(200);
    listed = (await client.request<{ rooms: Room[]; hiddenRoomCount: number }>('/rooms')).body;
    expect(listed.hiddenRoomCount).toBe(0);
    expect(listed.rooms.map(room => room.roomId)).toEqual(expect.arrayContaining([lobby.roomId, playing.roomId, finished.roomId, shared.roomId, later.roomId]));
  });

  it('keeps actionable invitations ahead of bounded terminal history without changing access', async () => {
    const f = await fixture(); const host = await signup(f, 'hoster'); const secondHost = await signup(f, 'another'); const guest = await signup(f, 'guest');
    await befriend(host, guest); await befriend(secondHost, guest);
    const pendingRoom = await newRoom(host.client); const reservedRoom = await newRoom(host.client);
    const pending = await invite(host.client, pendingRoom, guest.account.playerId);
    f.now.value++;
    const reserved = await invite(host.client, reservedRoom, guest.account.playerId);
    expect((await guest.client.request(`/invitations/${reserved.invitationId}/accept`, {})).status).toBe(200);
    const historyRooms = [await newRoom(host.client), await newRoom(secondHost.client)];
    const history: string[] = [];
    for (let index = 0; index < 51; index++) {
      // Two hosts stay within invitation limits; the reservation remains younger than two minutes.
      if (index === 25) f.now.value += 60_001;
      for (const [offset, owner] of [host, secondHost].entries()) {
        f.now.value++;
        const old = await invite(owner.client, historyRooms[offset], guest.account.playerId); history.push(old.invitationId);
        expect((await owner.client.request(`/invitations/${old.invitationId}/revoke`, {})).status).toBe(200);
      }
    }
    const listed = await guest.client.request<{ invitations: Invitation[] }>('/invitations');
    expect(listed.status).toBe(200);
    expect(listed.body.invitations.slice(0, 2).map(invitation => invitation.invitationId)).toEqual([reserved.invitationId, pending.invitationId]);
    expect(listed.body.invitations.slice(2).map(invitation => invitation.invitationId)).toEqual(history.slice(2).reverse());
    expect(listed.body.invitations[0]).toMatchObject({ status: 'accepted', reservationExpiresAt: expect.any(Number) });
    expect(listed.body.invitations[1].status).toBe('pending');
    const secondHostList = await secondHost.client.request<{ invitations: Invitation[] }>('/invitations');
    expect(secondHostList.body.invitations.some(invitation => [reserved.invitationId, pending.invitationId].includes(invitation.invitationId))).toBe(false);
    expect((await guest.client.request(`/rooms/${reservedRoom.roomId}/join`, {})).status).toBe(200);
    const afterJoin = (await guest.client.request<{ invitations: Invitation[] }>('/invitations')).body.invitations;
    expect(afterJoin).toHaveLength(101);
    expect(afterJoin[0].invitationId).toBe(pending.invitationId);
    expect(afterJoin.some(invitation => invitation.invitationId === reserved.invitationId)).toBe(false);
    f.now.value += 30 * 60_000;
    const afterExpiry = (await guest.client.request<{ invitations: Invitation[] }>('/invitations')).body.invitations;
    expect(afterExpiry).toHaveLength(100);
    expect(afterExpiry.some(invitation => invitation.invitationId === pending.invitationId)).toBe(false);
  });

  it('resets readiness when roster changes, rejects stale settings/start and keeps bots separate from accounts', async () => {
    const f = await fixture(); const host = await signup(f, 'hoster');
    let room = await newRoom(host.client, 3);
    expect((await host.client.request(`/rooms/${room.roomId}/bots`, { difficulty: ['easy'], expectedRevision: room.revision })).status).toBe(400);
    expect((await host.client.request(`/rooms/${room.roomId}/ready`, { ready: true, expectedRevision: room.revision })).status).toBe(200);
    const previousRevision = room.revision;
    const added = await host.client.request<{ room: Room }>(`/rooms/${room.roomId}/bots`, { difficulty: 'hard', expectedRevision: room.revision });
    expect(added.status).toBe(200); room = added.body.room;
    expect(room.members[0].ready).toBe(false);
    expect(room.members[1]).toMatchObject({ playerId: null, ready: true, controller: { kind: 'bot', difficulty: 'hard' } });
    expect(f.platform.db.prepare('SELECT COUNT(*) AS count FROM players').get()).toEqual({ count: 1 });
    expect((await host.client.request(`/rooms/${room.roomId}/start`, { expectedRevision: previousRevision })).status).toBe(409);
    expect((await host.client.request(`/rooms/${room.roomId}/start`, { expectedRevision: room.revision })).status).toBe(409);
    expect((await host.client.request(`/rooms/${room.roomId}/ready`, { ready: true, expectedRevision: room.revision })).status).toBe(200);
    const started = await host.client.request<{ room: Room }>(`/rooms/${room.roomId}/start`, { expectedRevision: room.revision });
    expect(started.status).toBe(200); expect(started.body.room.state).toBe('playing');
    expect((await host.client.request(`/rooms/${room.roomId}/bots`, { difficulty: 'easy', expectedRevision: started.body.room.revision })).status).toBe(409);
    const match = await host.client.request<{ view: { players: { isBot: boolean }[] } }>(`/rooms/${room.roomId}/match`);
    expect(match.body.view.players.some(player => player.isBot)).toBe(true);
  });

  it('persists identities, rooms and private choices across a full server/runtime restart and deduplicates an action', async () => {
    const f = await fixture(); const host = await signup(f, 'hoster'); const bob = await signup(f, 'bobby'); await befriend(host, bob);
    let room = await newRoom(host.client); room = await acceptJoin(bob.client, await invite(host.client, room, bob.account.playerId));
    for (const player of [host, bob]) expect((await player.client.request(`/rooms/${room.roomId}/ready`, { ready: true, expectedRevision: room.revision })).status).toBe(200);
    const started = await host.client.request<{ room: Room }>(`/rooms/${room.roomId}/start`, { expectedRevision: room.revision });
    expect(started.body.room.state).toBe('playing');
    const initial = await host.client.request<{ view: { revision: number } }>(`/rooms/${room.roomId}/match`);
    const command = { actionId: randomUUID(), expectedRevision: initial.body.view.revision, payload: { type: 'choose', value: 3 } };
    const accepted = await host.client.request<{ view: { revision: number; you: { choice: number | null } } }>(`/rooms/${room.roomId}/actions`, command);
    expect(accepted.status).toBe(200); expect(accepted.body.view.you.choice).toBe(3);
    const opponent = await bob.client.request<{ view: { you: { choice: number | null }; history: unknown[]; players: unknown[] } }>(`/rooms/${room.roomId}/match`);
    expect(opponent.body.view.you.choice).toBeNull(); expect(opponent.body.view.history).toHaveLength(0);
    expect(JSON.stringify(opponent.body)).not.toContain('botSeed'); expect(JSON.stringify(opponent.body)).not.toContain('choices');
    const hostCookie = host.client.cookie; const csrf = host.client.csrf;
    await f.stop(); const restarted = await fixture({ directory: f.directory, now: f.now });
    const resume = restarted.client(); resume.cookie = hostCookie; resume.csrf = csrf;
    expect((await resume.session()).user?.playerId).toBe(host.account.playerId);
    expect((await resume.room(room.roomId)).matchId).toBe(started.body.room.matchId);
    const replay = await resume.request(`/rooms/${room.roomId}/actions`, command);
    expect(replay).toMatchObject({ status: 200, body: accepted.body });
    expect((await resume.request(`/rooms/${room.roomId}/actions`, { ...command, payload: { type: 'choose', value: 1 } })).status).toBe(409);
  });

  it('reopens a capacity-rejected lobby durably, never retries the rejected start and allows a fresh start or cancellation', async () => {
    let busy = true;
    const commands: string[] = [];
    const games = (lab: ReturnType<typeof createPlatformLabRegistration>): GameRegistration[] => [{ ...lab, runtime: {
      createMatch: async command => {
        commands.push(command.startCommandId);
        if (busy) throw new SessionError('GAME_BUSY', 'All simulation owners are at capacity', 503);
        return lab.runtime!.createMatch(command);
      },
      viewForPlayer: (match, actor) => lab.runtime!.viewForPlayer(match, actor),
      applyAction: (match, actor, command) => lab.runtime!.applyAction(match, actor, command),
      status: match => lab.runtime!.status!(match),
    } }];
    const f = await fixture({ games }); const host = await signup(f, 'hoster');
    let room = await newRoom(host.client);
    room = (await host.client.request<{ room: Room }>(`/rooms/${room.roomId}/bots`, { difficulty: 'easy', expectedRevision: room.revision })).body.room;
    room = (await host.client.request<{ room: Room }>(`/rooms/${room.roomId}/ready`, { ready: true, expectedRevision: room.revision })).body.room;
    const readyMembers = room.members; const rejectedRevision = room.revision;
    const first = await host.client.request<{ room: Room }>(`/rooms/${room.roomId}/start`, { expectedRevision: room.revision });
    expect(first.status).toBe(200); room = first.body.room;
    expect(room).toMatchObject({ state: 'lobby', matchId: null, startError: 'GAME_BUSY', members: readyMembers });
    expect(room.revision).toBe(rejectedRevision + 2);
    const rejectedCommand = commands[0];
    expect(f.platform.db.prepare('SELECT completed_at,last_error,attempts FROM start_commands WHERE start_command_id=?').get(rejectedCommand)).toEqual({ completed_at: f.now.value, last_error: 'game_busy', attempts: 1 });
    expect((await host.client.request(`/rooms/${room.roomId}/start`, { expectedRevision: rejectedRevision })).status).toBe(409);
    f.now.value += 60_000; await f.platform.reconcile(); expect(commands).toEqual([rejectedCommand]);

    await f.stop(); const restarted = await fixture({ directory: f.directory, now: f.now, games });
    host.client.endpoint = restarted.endpoint;
    room = await host.client.room(room.roomId);
    expect(room).toMatchObject({ state: 'lobby', startError: 'GAME_BUSY', members: readyMembers });
    await restarted.platform.reconcile(); expect(commands).toEqual([rejectedCommand]);
    busy = false;
    const retry = await host.client.request<{ room: Room }>(`/rooms/${room.roomId}/start`, { expectedRevision: room.revision });
    expect(retry.status).toBe(200); expect(retry.body.room.state).toBe('playing'); expect(retry.body.room.startError).toBeUndefined();
    expect(commands).toHaveLength(2); expect(commands[1]).not.toBe(rejectedCommand);
    expect(restarted.platform.db.prepare('SELECT start_command_id FROM start_commands WHERE room_id=?').get(room.roomId)).toEqual({ start_command_id: commands[1] });
    f.now.value += 60_000; await restarted.platform.reconcile(); expect(commands).toHaveLength(2);

    busy = true; let cancellable = await newRoom(host.client);
    cancellable = (await host.client.request<{ room: Room }>(`/rooms/${cancellable.roomId}/bots`, { difficulty: 'easy', expectedRevision: cancellable.revision })).body.room;
    await host.client.request(`/rooms/${cancellable.roomId}/ready`, { ready: true, expectedRevision: cancellable.revision });
    expect((await host.client.request<{ room: Room }>(`/rooms/${cancellable.roomId}/start`, { expectedRevision: cancellable.revision })).body.room.startError).toBe('GAME_BUSY');
    const cancelled = await host.client.request<{ room: Room }>(`/rooms/${cancellable.roomId}/cancel`, {});
    expect(cancelled.status).toBe(200); expect(cancelled.body.room.state).toBe('cancelled'); expect(cancelled.body.room.startError).toBeUndefined();
    f.now.value += 60_000; await restarted.platform.reconcile(); expect(commands).toHaveLength(3);
  });

  it('keeps an uncertain game start frozen even after a later capacity error and reconciles the same command', async () => {
    let createCalls = 0;
    let committedMatchId = '';
    const f = await fixture({ games: lab => [{ ...lab, runtime: {
      ...lab.runtime!,
      createMatch: async command => {
        createCalls++;
        expect(f.platform.db.prepare('SELECT attempts,last_error FROM start_commands WHERE start_command_id=?').get(command.startCommandId)).toEqual({ attempts: createCalls, last_error: 'runtime_unconfirmed' });
        if (createCalls === 2) throw new SessionError('GAME_BUSY', 'This response cannot resolve the earlier unknown result', 503);
        const result = await lab.runtime!.createMatch(command);
        if (createCalls === 1) { committedMatchId = result.matchId; throw new Error('Reply lost after durable commit'); }
        return result;
      },
      viewForPlayer: (match, actor) => lab.runtime!.viewForPlayer(match, actor),
      applyAction: (match, actor, command) => lab.runtime!.applyAction(match, actor, command),
      status: match => lab.runtime!.status!(match),
    } }] });
    const host = await signup(f, 'hoster'); let room = await newRoom(host.client);
    room = (await host.client.request<{ room: Room }>(`/rooms/${room.roomId}/bots`, { difficulty: 'easy', expectedRevision: room.revision })).body.room;
    await host.client.request(`/rooms/${room.roomId}/ready`, { ready: true, expectedRevision: room.revision });
    const start = await host.client.request<{ room: Room }>(`/rooms/${room.roomId}/start`, { expectedRevision: room.revision });
    expect(start.body.room.state).toBe('starting');
    const commandId = (f.platform.db.prepare('SELECT start_command_id FROM start_commands').get() as { start_command_id: string }).start_command_id;
    f.now.value += 2000; await f.platform.reconcile();
    const uncertain = await host.client.room(room.roomId);
    expect(uncertain.state).toBe('starting'); expect(uncertain.startError).toBeUndefined(); expect(createCalls).toBe(2);
    expect(f.platform.db.prepare('SELECT completed_at,attempts FROM start_commands').get()).toEqual({ completed_at: null, attempts: 2 });
    expect((await host.client.request(`/rooms/${room.roomId}/cancel`, {})).status).toBe(409);
    f.now.value += 4000; await f.platform.reconcile();
    expect(await host.client.room(room.roomId)).toMatchObject({ state: 'playing', matchId: committedMatchId }); expect(createCalls).toBe(3);
    expect(f.platform.db.prepare('SELECT COUNT(*) AS count FROM start_commands').get()).toEqual({ count: 1 });
    expect((f.platform.db.prepare('SELECT start_command_id FROM start_commands').get() as { start_command_id: string }).start_command_id).toBe(commandId);
  });

  it('makes room creation retry-safe, refuses a changed payload and exposes disconnected games honestly', async () => {
    const f = await fixture(); const host = await signup(f, 'hoster');
    const key = randomUUID(); const payload = { gameId: 'platform-lab', capacity: 2 };
    const first = await host.client.request('/rooms', payload, { 'Idempotency-Key': key });
    const repeat = await host.client.request('/rooms', payload, { 'Idempotency-Key': key }); expect(repeat.body).toEqual(first.body);
    expect((await host.client.request('/rooms', { ...payload, capacity: 3 }, { 'Idempotency-Key': key })).status).toBe(409);
    expect((await host.client.request('/rooms', { gameId: 'remorse', capacity: 2 })).status).toBe(409);
    expect((await host.client.request('/telegram')).body).toEqual({ available: false, linked: false, reason: 'not_configured' });
    expect(f.platform.db.prepare('SELECT COUNT(*) AS count FROM integration_outbox').get()).toEqual({ count: 0 });
    const games = await host.client.request<{ games: { gameId: string; status: string }[] }>('/games');
    expect(games.body.games.find(game => game.gameId === 'district')?.status).toBe('planned');
    expect(games.body.games.find(game => game.gameId === 'remorse')?.status).toBe('unavailable');
  });

  it('bounds a hung runtime call, lets healthy rooms start and keeps timed-out command identity for retry', async () => {
    let release!: () => void;
    let blockedRoomId = '';
    let hanging = true;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const f = await fixture({ runtimeTimeoutMs: 25, games: lab => [{
      ...lab, runtime: {
        createMatch: async command => { if (command.roomId === blockedRoomId && hanging) await gate; return lab.runtime!.createMatch(command); },
        viewForPlayer: (match, actor) => lab.runtime!.viewForPlayer(match, actor),
        applyAction: (match, actor, command) => lab.runtime!.applyAction(match, actor, command),
        status: match => lab.runtime!.status!(match),
      },
    }] });
    const host = await signup(f, 'hoster');
    const rooms = ['platform-lab', 'platform-lab'].map((gameId, index) => f.platform.mutation(host.account.playerId, `prepare:${index}`, undefined, {}, () => {
      let room = f.platform.createRoom(host.account.playerId, { gameId, capacity: 2 });
      room = f.platform.addBot(host.account.playerId, room.roomId, { difficulty: 'easy', expectedRevision: room.revision });
      f.platform.setReady(host.account.playerId, room.roomId, { ready: true, expectedRevision: room.revision });
      return f.platform.startRoom(host.account.playerId, room.roomId, { expectedRevision: room.revision });
    }));
    blockedRoomId = rooms[0].roomId;
    const commandId = (f.platform.db.prepare('SELECT start_command_id FROM start_commands WHERE room_id=?').get(rooms[0].roomId) as { start_command_id: string }).start_command_id;
    try {
      await f.platform.reconcile();
      expect(f.platform.getRoom(host.account.playerId, rooms[0].roomId).state).toBe('starting');
      expect(f.platform.getRoom(host.account.playerId, rooms[1].roomId).state).toBe('playing');
      hanging = false;
      f.now.value += 2000; await f.platform.reconcile();
      expect(f.platform.getRoom(host.account.playerId, rooms[0].roomId).state).toBe('playing');
      expect((f.platform.db.prepare('SELECT start_command_id FROM start_commands WHERE room_id=?').get(rooms[0].roomId) as { start_command_id: string }).start_command_id).toBe(commandId);
      const recoveredId = f.platform.getRoom(host.account.playerId, rooms[0].roomId).matchId;
      release(); await Promise.resolve();
      expect(f.platform.getRoom(host.account.playerId, rooms[0].roomId).matchId).toBe(recoveredId);
    } finally { release(); }
  });

  it('rejects an incompatible registered game version before freezing a lobby', async () => {
    const f = await fixture(); const host = await signup(f, 'hoster');
    let room = await newRoom(host.client);
    room = (await host.client.request<{ room: Room }>(`/rooms/${room.roomId}/bots`, { difficulty: 'normal', expectedRevision: room.revision })).body.room;
    await host.client.request(`/rooms/${room.roomId}/ready`, { ready: true, expectedRevision: room.revision });
    f.platform.games.set('platform-lab', { ...f.lab, rulesVersion: 'incompatible-next-version' });
    const start = await host.client.request<{ error: { code: string } }>(`/rooms/${room.roomId}/start`, { expectedRevision: room.revision });
    expect(start).toMatchObject({ status: 409, body: { error: { code: 'GAME_VERSION_UNAVAILABLE' } } });
    expect((await host.client.room(room.roomId)).state).toBe('lobby');
    expect(f.platform.db.prepare('SELECT COUNT(*) AS count FROM start_commands').get()).toEqual({ count: 0 });
  });

  it('returns bounded HTTP errors when a connected runtime stops answering views or actions', async () => {
    const f = await fixture({ runtimeTimeoutMs: 25 }); const host = await signup(f, 'hoster');
    let room = await newRoom(host.client);
    room = (await host.client.request<{ room: Room }>(`/rooms/${room.roomId}/bots`, { difficulty: 'normal', expectedRevision: room.revision })).body.room;
    await host.client.request(`/rooms/${room.roomId}/ready`, { ready: true, expectedRevision: room.revision });
    const started = await host.client.request<{ room: Room }>(`/rooms/${room.roomId}/start`, { expectedRevision: room.revision });
    expect(started.body.room.state).toBe('playing');
    f.platform.games.set('platform-lab', { ...f.lab, runtime: {
      ...f.lab.runtime!, viewForPlayer: () => new Promise(() => {}), applyAction: () => new Promise(() => {}),
    } });
    const view = await host.client.request(`/rooms/${room.roomId}/match`);
    expect(view).toMatchObject({ status: 503, body: { error: { code: 'GAME_TIMEOUT' } } });
    const action = await host.client.request(`/rooms/${room.roomId}/actions`, { actionId: randomUUID(), expectedRevision: 0, payload: { type: 'choose', value: 1 } });
    expect(action).toMatchObject({ status: 503, body: { error: { code: 'GAME_TIMEOUT' } } });
    expect((await host.client.room(room.roomId)).state).toBe('playing');
  });

  it('backs up SQLite consistently and restores account identity and social records', async () => {
    const f = await fixture(); const host = await signup(f, 'hoster'); const bob = await signup(f, 'bobby'); await befriend(host, bob);
    const backup = join(f.directory, 'restored.sqlite'); await f.platform.backup(backup);
    const restored = new PlatformService({ databasePath: backup, publicOrigin: ORIGIN, mail: new MemoryMailbox() }); await restored.ready;
    expect(restored.account(host.account.playerId)).toEqual(host.account);
    expect(restored.social(host.account.playerId).friends.map(player => player.playerId)).toEqual([bob.account.playerId]);
    restored.close();
  });

  it('links Telegram through authenticated web confirmation and queues only opted-in new invitations with a fake transport', async () => {
    const f = await fixture({ telegram: true });
    const alice = await signup(f, 'alice');
    const created = await alice.client.request<TelegramAttemptStatus & { deepLink: string }>('/telegram/link-attempts', {});
    expect(created.status).toBe(200);
    expect(created.body.state).toBe('issued');
    const payload = new URL(created.body.deepLink).searchParams.get('start')!;
    expect(payload).toMatch(/^l1_[\w-]{43}$/);

    const anotherBrowser = f.client(); await anotherBrowser.session();
    expect((await anotherBrowser.request('/auth/login', { email: alice.account.email, password: PASSWORD })).status).toBe(200);
    await anotherBrowser.session();
    expect((await anotherBrowser.request(`/telegram/link-attempts/${created.body.attemptId}`)).status).toBe(403);
    // Only the webhook shared secret authorizes this route; it has no website cookies or Origin.
    const update = { update_id: 91, message: { message_id: 12, date: Math.floor(f.now.value / 1000),
      from: { id: 7123456789, is_bot: false, first_name: 'Алиса', username: 'alice_test' },
      chat: { id: 7123456789, type: 'private' }, text: `/start ${payload}`,
    } };
    expect((await webhook(f, update, 'wrong_secret')).status).toBe(401);
    expect((await webhook(f, update)).body).toEqual({ accepted: true, duplicate: false });
    expect((await webhook(f, update)).body).toEqual({ accepted: true, duplicate: true });
    const pending = await alice.client.request<TelegramAttemptStatus>(`/telegram/link-attempts/${created.body.attemptId}`);
    expect(pending.body).toMatchObject({ state: 'awaiting_web_confirmation', candidate: { userIdSuffix: '6789' } });
    expect(JSON.stringify(pending.body)).not.toContain('7123456789');
    expect((await alice.client.request<TelegramStatus>('/telegram')).body.linked).toBe(false);
    expect(f.telegramMessages).toHaveLength(0);
    expect((await f.telegram!.drain()).sent).toBe(1);
    const proof = f.telegramMessages[0].text.match(/: ([A-Z2-7]{8})\n/)![1];
    const confirmPath = `/telegram/link-attempts/${created.body.attemptId}/confirm`;
    expect((await alice.client.request(confirmPath, { proofCode: proof, consent: false }, { 'X-CSRF-Token': 'bad' })).status).toBe(403);
    expect((await alice.client.request(confirmPath, { proofCode: proof })).status).toBe(400);
    const confirmed = await alice.client.request<TelegramStatus>(confirmPath, { proofCode: proof, consent: false });
    expect(confirmed.body).toMatchObject({ available: true, linked: true, notificationsEnabled: false });

    const host = await signup(f, 'hoster'); await befriend(host, alice);
    const mutedRoom = await newRoom(host.client);
    await invite(host.client, mutedRoom, alice.account.playerId);
    expect((await f.telegram!.drain()).processed).toBe(0);
    expect((await alice.client.request<TelegramStatus>('/telegram/preferences', { enabled: true })).body.notificationsEnabled).toBe(true);
    const room = await newRoom(host.client);
    const invitation = await invite(host.client, room, alice.account.playerId);
    expect((await invite(host.client, room, alice.account.playerId)).invitationId).toBe(invitation.invitationId);
    expect(f.platform.db.prepare("SELECT COUNT(*) AS n FROM telegram_outbox WHERE kind='invitation'").get()).toEqual({ n: 1 });
    expect((await f.telegram!.drain()).sent).toBe(1);
    expect(f.telegramMessages).toHaveLength(2);
    expect(f.telegramMessages[1].button?.url).toBe(`${ORIGIN}/invitations/${invitation.invitationId}`);
    expect(f.platform.getInvitation(alice.account.playerId, invitation.invitationId).status).toBe('pending');
    expect((await host.client.room(room.roomId)).members).toHaveLength(1);
    expect((await alice.client.request<TelegramStatus>('/telegram/unlink', {})).body.linked).toBe(false);
  });

  it('refuses unsafe production activation and remote development file-mail delivery', () => {
    expect(() => loadPlatformConfig({ NODE_ENV: 'production', PORTAL_ORIGIN: 'http://portal.test', MAIL_MODE: 'file' })).toThrow();
    expect(() => loadPlatformConfig({ NODE_ENV: 'production', PORTAL_ORIGIN: 'https://portal.test' })).toThrow(/SMTP/);
    expect(() => loadPlatformConfig({ NODE_ENV: 'development', PORTAL_ORIGIN: 'http://127.0.0.1:5175', PLATFORM_HOST: '0.0.0.0', MAIL_MODE: 'file' })).toThrow(/loopback/);
    expect(() => loadPlatformConfig({ NODE_ENV: 'production', PORTAL_ORIGIN: 'https://portal.test', SMTP_HOST: 'smtp.example.test', SMTP_FROM: 'Iva <no-reply@example.test>' })).not.toThrow();
  });

  it('requires explicit complete Telegram configuration with HTTPS, encryption key and mandatory proxy', () => {
    const base = { NODE_ENV: 'production', PORTAL_ORIGIN: 'https://portal.test', SMTP_HOST: 'smtp.example.test', SMTP_FROM: 'Iva <no-reply@example.test>' };
    expect(loadPlatformConfig(base).telegram).toBeUndefined();
    expect(() => loadPlatformConfig({ ...base, TELEGRAM_BOT_USERNAME: 'iva_test_bot' })).toThrow(/explicit/);
    expect(() => loadPlatformConfig({ ...base, TELEGRAM_ENABLED: 'true' })).toThrow(/requires/);
    const enabled = { ...base, TELEGRAM_ENABLED: 'true', TELEGRAM_BOT_TOKEN: `12345678:${'t'.repeat(30)}`,
      TELEGRAM_BOT_USERNAME: 'iva_test_bot', TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
      TELEGRAM_PROOF_KEY_BASE64: Buffer.alloc(32, 7).toString('base64'), TELEGRAM_PROXY_URL: 'socks5h://127.0.0.1:1080' };
    expect(loadPlatformConfig(enabled).telegram).toMatchObject({ botId: '12345678', proxyUrl: enabled.TELEGRAM_PROXY_URL });
    expect(() => loadPlatformConfig({ ...enabled, TELEGRAM_PROXY_URL: undefined })).toThrow(/proxy/);
    expect(() => loadPlatformConfig({ ...enabled, TELEGRAM_PROXY_URL: 'socks5://127.0.0.1:1080' })).toThrow(/proxy/);
    expect(() => loadPlatformConfig({ ...enabled, TELEGRAM_PROOF_KEY_BASE64: 'short' })).toThrow(/32 bytes/);
    expect(() => loadPlatformConfig({ ...enabled, NODE_ENV: 'development', PORTAL_ORIGIN: 'http://127.0.0.1:5175' })).toThrow(/HTTPS/);
    expect(loadPlatformConfig({ ...enabled, TELEGRAM_ENABLED: 'false' }).telegram).toBeUndefined();
  });
});
