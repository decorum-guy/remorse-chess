import { catalogueDefaults } from '@iva-games/game-registry';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync } from 'node:fs';
import { hash, verify } from '@node-rs/argon2';
import type Database from 'better-sqlite3';
import { openPlatformDatabase } from './database.js';
import { normalizeAvatarPhoto } from './avatar-photo.js';
import { AVATARS, PlatformError } from './types.js';
import type { Account, AvatarChoice, Controller, Difficulty, GameRegistration, Invitation, MailTransport, Participant, PublicPlayer, Room, SessionRecord, StartMatchCommand } from './types.js';

const DAY = 86_400_000;
const INVITE_TTL = 30 * 60_000;
const RESERVATION_TTL = 2 * 60_000;
const LEGACY_AVATARS = new Set(['king', 'queen', 'rook', 'bishop', 'knight', 'pawn']);
// The library's Argon2id enum value is 2; its ambient const enum cannot be imported with verbatim modules.
const PASSWORD_OPTIONS = { algorithm: 2 as const, memoryCost: 19_456, timeCost: 2, parallelism: 1, outputLen: 32 };
type Row = Record<string, string | number | null>;

export const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
const secret = (): string => randomBytes(32).toString('base64url');
function fail(code: string, message: string, status = 400): never { throw new PlatformError(code, message, status); }
export function textField(value: unknown, _name: string, min = 1, max = 128): string {
  if (typeof value !== 'string' || value.length < min || value.length > max || [...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
    return fail('INVALID_INPUT', 'Проверьте заполненные поля');
  }
  return value;
}
function emailField(value: unknown): string {
  const email = textField(value, 'email', 3, 254).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('INVALID_EMAIL', 'Проверьте адрес электронной почты');
  return email;
}
function passwordField(value: unknown): string {
  if (typeof value !== 'string' || [...value].length < 15 || [...value].length > 128 || value.length > 512) {
    return fail('INVALID_PASSWORD', 'Пароль должен содержать от 15 до 128 символов');
  }
  return value;
}
function displayNameField(value: unknown): string {
  const name = textField(value, 'displayName', 1, 40).trim();
  if (!name) fail('INVALID_INPUT', 'Укажите имя');
  return name;
}
function registrationProfile(input: Record<string, unknown>): { handle: string; displayName: string } {
  const handle = textField(input.handle, 'handle', 3, 24).toLowerCase();
  if (!/^[a-z0-9_]{3,24}$/.test(handle)) fail('INVALID_HANDLE', 'Имя пользователя: 3–24 латинские буквы, цифры или _');
  const displayName = displayNameField(input.displayName);
  return { handle, displayName };
}
function intField(value: unknown, _name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) return fail('INVALID_INPUT', 'Проверьте заполненные поля');
  return value;
}
const pair = (a: string, b: string): [string, string] => a < b ? [a, b] : [b, a];

export interface PlatformOptions {
  databasePath: string;
  publicOrigin: string;
  mail?: MailTransport;
  games?: GameRegistration[];
  now?: () => number;
  runtimeTimeoutMs?: number;
}
export interface AuthenticationResult {
  user: Account;
  token: string;
  session: SessionRecord;
}

export class PlatformService {
  readonly db: Database.Database;
  readonly ready: Promise<void>;
  readonly games: Map<string, GameRegistration>;
  readonly publicOrigin: string;
  private readonly now: () => number;
  private readonly runtimeTimeoutMs: number;
  private dummyHash = '';
  private passwordWork = 0;
  private ticking = false;
  private reconciliationStopping = false;
  private reconciliationFinished: Promise<void> | null = null;
  private readonly runtimeWork = new Set<Promise<unknown>>();
  private invitationDelivery: ((invitationId: string) => unknown) | null = null;
  private readonly rateBuckets = new Map<string, { hits: number; until: number }>();
  private lastAdmissionSync = 0;

  constructor(private readonly options: PlatformOptions) {
    this.publicOrigin = new URL(options.publicOrigin).origin;
    this.now = options.now ?? Date.now;
    this.runtimeTimeoutMs = options.runtimeTimeoutMs ?? 3000;
    if (!Number.isFinite(this.runtimeTimeoutMs) || this.runtimeTimeoutMs < 1 || this.runtimeTimeoutMs > 30_000) throw new Error('Invalid runtime deadline');
    this.db = openPlatformDatabase(options.databasePath);
    this.db.exec('CREATE TABLE IF NOT EXISTS realtime_result_acks(match_id TEXT PRIMARY KEY)');
    this.games = new Map((options.games ?? []).map(game => [game.gameId, game]));
    for (const game of catalogueDefaults()) {
      if (!this.games.has(game.gameId)) this.games.set(game.gameId, game);
    }
    this.ready = hash(randomBytes(32).toString('hex'), PASSWORD_OPTIONS).then(value => { this.dummyHash = value; });
  }
  get emailDeliveryEnabled(): boolean { return !!this.options.mail; }
  close(): void { this.db.close(); }
  stopReconciliation(): void { this.reconciliationStopping = true; }
  setInvitationDelivery(handler: (invitationId: string) => unknown): void { this.invitationDelivery = handler; }
  /** Call after HTTP has drained and reconciliation has stopped accepting work.
   * A response deadline does not cancel the underlying runtime adapter. */
  async settle(): Promise<void> {
    await this.reconciliationFinished;
    while (this.runtimeWork.size) await Promise.allSettled([...this.runtimeWork]);
  }
  async backup(destination: string): Promise<void> { await this.db.backup(destination); chmodSync(destination, 0o600); }
  private row(sql: string, ...values: (string | number | null)[]): Row | undefined { return this.db.prepare(sql).get(...values) as Row | undefined; }
  private rows(sql: string, ...values: (string | number | null)[]): Row[] { return this.db.prepare(sql).all(...values) as Row[]; }
  private run(sql: string, ...values: (string | number | null)[]): void { this.db.prepare(sql).run(...values); }
  private async runtimeCall<T>(operation: Promise<T>): Promise<T> {
    this.runtimeWork.add(operation);
    void operation.then(() => this.runtimeWork.delete(operation), () => this.runtimeWork.delete(operation));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([operation, new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new PlatformError('GAME_TIMEOUT', 'Не удалось продолжить игру. Попробуйте ещё раз', 503)), this.runtimeTimeoutMs);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }
  private async runtimeBatch(rows: Row[], operation: (row: Row) => Promise<void>): Promise<void> {
    let next = 0;
    // Independent rooms progress even when one adapter has stopped answering.
    await Promise.all(Array.from({ length: Math.min(4, rows.length) }, async () => {
      while (next < rows.length && !this.reconciliationStopping) { const row = rows[next++]; await operation(row); }
    }));
  }

  rateLimit(key: string, max: number, windowMs = 60_000): void {
    const now = this.now();
    if (this.rateBuckets.size > 10_000) for (const [entry, bucket] of this.rateBuckets) if (bucket.until <= now) this.rateBuckets.delete(entry);
    let bucket = this.rateBuckets.get(key);
    if (!bucket || bucket.until <= now) { bucket = { hits: 0, until: now + windowMs }; this.rateBuckets.set(key, bucket); }
    if (++bucket.hits > max) fail('RATE_LIMITED', 'Подождите немного и попробуйте снова', 429);
  }
  private async passwordTask<T>(work: () => Promise<T>): Promise<T> {
    if (this.passwordWork >= 4) fail('AUTH_BUSY', 'Попробуйте ещё раз чуть позже', 429);
    this.passwordWork++;
    try { return await work(); } finally { this.passwordWork--; }
  }
  private playerRow(playerId: string): Row {
    return this.row('SELECT * FROM players WHERE player_id=?', playerId) ?? fail('NOT_FOUND', 'Пользователь не найден', 404);
  }
  publicPlayer(playerId: string): PublicPlayer {
    const row = this.playerRow(playerId);
    const extra = this.row('SELECT avatar,photo_version FROM player_avatar_extra WHERE player_id=?', playerId);
    const avatar = (extra?.avatar ?? this.row('SELECT avatar FROM player_avatar WHERE player_id=?', playerId)?.avatar) as AvatarChoice | undefined;
    return { playerId, handle: String(row.handle), displayName: String(row.display_name), ...(avatar ? { avatar } : {}),
      ...(extra?.avatar === 'photo' && extra.photo_version ? { avatarVersion: String(extra.photo_version) } : {}) };
  }
  avatarPhoto(playerId: string, viewerId?: string): Buffer | undefined {
    if (viewerId && viewerId !== playerId && this.blocked(viewerId, playerId)) return undefined;
    return (this.db.prepare("SELECT photo FROM player_avatar_extra WHERE player_id=? AND avatar='photo'").get(playerId) as { photo: Buffer } | undefined)?.photo;
  }
  account(playerId: string): Account {
    const row = this.playerRow(playerId);
    const telegram = this.row('SELECT 1 FROM telegram_login_accounts WHERE player_id=?', playerId);
    return { ...this.publicPlayer(playerId), email: telegram ? '' : String(row.email),
      emailVerified: !!row.email_verified, ...(telegram ? { telegramVerified: true as const } : {}) };
  }
  requireVerified(playerId: string): Account {
    const user = this.account(playerId);
    if (!user.emailVerified && !user.telegramVerified) fail('EMAIL_NOT_VERIFIED', 'Сначала подтвердите почту', 403);
    return user;
  }
  private createToken(playerId: string, purpose: 'verification' | 'password_reset'): string {
    const token = secret();
    this.db.transaction(() => {
      this.run('UPDATE account_tokens SET used_at=? WHERE player_id=? AND purpose=? AND used_at IS NULL', this.now(), playerId, purpose);
      this.run('INSERT INTO account_tokens VALUES (?,?,?,?,?,NULL)', digest(token), playerId, purpose, this.now(), this.now() + (purpose === 'verification' ? DAY : 30 * 60_000));
    }).immediate();
    return token;
  }
  private async sendAccountMail(playerId: string, kind: 'verification' | 'password_reset'): Promise<void> {
    const account = this.account(playerId);
    const mail = this.options.mail;
    if (!mail || !account.email) fail('MAIL_UNAVAILABLE', 'Почта пока недоступна', 503);
    const token = this.createToken(playerId, kind);
    const path = kind === 'verification' ? '/verify' : '/reset-password';
    const url = `${this.publicOrigin}${path}?token=${encodeURIComponent(token)}`;
    await mail.send({
      to: account.email, kind,
      subject: kind === 'verification' ? 'Подтвердить почту — Iva Games' : 'Сбросить пароль — Iva Games',
      text: `${kind === 'verification' ? 'Подтвердить почту' : 'Сбросить пароль'}:\n\n${url}\n\nСсылка действует ${kind === 'verification' ? '24 часа' : '30 минут'}.\nЕсли вы не запрашивали это письмо, ничего не делайте.`,
    });
  }
  async register(input: Record<string, unknown>, previousSessionHash?: string): Promise<AuthenticationResult> {
    if (!this.emailDeliveryEnabled) fail('MAIL_UNAVAILABLE', 'Почта пока недоступна', 503);
    const email = emailField(input.email);
    const { handle, displayName } = registrationProfile(input);
    const password = passwordField(input.password);
    if (this.row('SELECT player_id FROM players WHERE email=? OR handle=?', email, handle)) fail('SIGNUP_UNAVAILABLE', 'Этот адрес или имя пользователя уже заняты', 409);
    const passwordHash = await this.passwordTask(() => hash(password, PASSWORD_OPTIONS));
    const playerId = randomUUID();
    let issued: { token: string; session: SessionRecord };
    try { issued = this.db.transaction(() => {
      this.run('INSERT INTO players VALUES (?,?,?,?,?,?,?)', playerId, handle, displayName, email, passwordHash, 0, this.now());
      return this.issueAuthenticatedSession(playerId, passwordHash, previousSessionHash);
    }).immediate(); }
    catch (error) { if (String(error).includes('UNIQUE')) fail('SIGNUP_UNAVAILABLE', 'Этот адрес или имя пользователя уже заняты', 409); throw error; }
    try { await this.sendAccountMail(playerId, 'verification'); }
    catch { fail('MAIL_UNAVAILABLE', 'Аккаунт создан. Войдите и запросите письмо ещё раз', 503); }
    return { user: this.account(playerId), ...issued };
  }
  createTelegramAccount(input: Record<string, unknown>): string {
    const { handle, displayName } = registrationProfile(input);
    if (this.row('SELECT 1 FROM players WHERE handle=?', handle)) fail('HANDLE_TAKEN', 'Имя пользователя уже занято', 409);
    const playerId = randomUUID();
    // Internal value cannot match the email address format; no password is set.
    this.run('INSERT INTO players VALUES (?,?,?,?,?,?,?)', playerId, handle, displayName, `tg:${playerId}`, '', 0, this.now());
    return playerId;
  }
  async login(emailInput: unknown, passwordInput: unknown, previousSessionHash?: string): Promise<AuthenticationResult> {
    await this.ready;
    const email = typeof emailInput === 'string' ? emailInput.trim().toLowerCase().slice(0, 254) : '';
    const password = typeof passwordInput === 'string' && passwordInput.length <= 512 ? passwordInput : '';
    const row = this.row('SELECT * FROM players WHERE email=?', email);
    const valid = await this.passwordTask(() => verify(row?.password_hash ? String(row.password_hash) : this.dummyHash, password));
    if (!row?.password_hash || !valid) fail('INVALID_CREDENTIALS', 'Неверная почта или пароль', 401);
    const playerId = String(row.player_id);
    // Credential recheck and session issuance share one synchronous transaction. A reset during
    // asynchronous verification cannot mint a new session from the obsolete password afterward.
    const issued = this.issueAuthenticatedSession(playerId, String(row.password_hash), previousSessionHash);
    return { user: this.account(playerId), ...issued };
  }
  async reauthenticate(session: SessionRecord, password: unknown): Promise<void> {
    if (!session.playerId) fail('UNAUTHENTICATED', 'Войдите в аккаунт', 401);
    const row = this.playerRow(session.playerId);
    const value = typeof password === 'string' && password.length <= 512 ? password : '';
    if (!row.password_hash || !await this.passwordTask(() => verify(row.password_hash ? String(row.password_hash) : this.dummyHash, value))) fail('INVALID_CREDENTIALS', 'Неверная почта или пароль', 401);
    this.db.transaction(() => {
      this.checkActiveCredential(session, String(row.password_hash));
      this.run('UPDATE web_sessions SET reauthenticated_at=? WHERE session_hash=?', this.now(), session.sessionHash);
    }).immediate();
  }
  async revokeAllWithPassword(session: SessionRecord, password: unknown): Promise<void> {
    if (!session.playerId) fail('UNAUTHENTICATED', 'Войдите в аккаунт', 401);
    const row = this.playerRow(session.playerId);
    const value = typeof password === 'string' && password.length <= 512 ? password : '';
    if (!row.password_hash || !await this.passwordTask(() => verify(row.password_hash ? String(row.password_hash) : this.dummyHash, value))) fail('INVALID_CREDENTIALS', 'Неверная почта или пароль', 401);
    this.db.transaction(() => {
      this.checkActiveCredential(session, String(row.password_hash));
      this.revokeAllSessions(session.playerId!);
    }).immediate();
  }
  private activeSessionHash(sessionHash: string): Row | undefined {
    const row = this.row('SELECT * FROM web_sessions WHERE session_hash=?', sessionHash);
    if (!row || Number(row.expires_at) <= this.now() || Number(row.last_seen_at) + (row.player_id ? 7 * DAY : 60 * 60_000) <= this.now()) return undefined;
    return row;
  }
  private checkActiveCredential(session: SessionRecord, credentialHash: string): void {
    const active = this.activeSessionHash(session.sessionHash);
    if (!session.playerId || !active || active.player_id !== session.playerId || this.playerRow(session.playerId).password_hash !== credentialHash) fail('UNAUTHENTICATED', 'Войдите снова', 401);
  }
  private issueAuthenticatedSession(playerId: string, credentialHash: string, previousSessionHash?: string): { token: string; session: SessionRecord } {
    return this.db.transaction(() => {
      if (this.playerRow(playerId).password_hash !== credentialHash) fail('INVALID_CREDENTIALS', 'Неверная почта или пароль', 401);
      if (previousSessionHash && !this.activeSessionHash(previousSessionHash)) fail('UNAUTHENTICATED', 'Обновите страницу и попробуйте снова', 401);
      if (previousSessionHash) this.revokeSession(previousSessionHash);
      return this.createSession(playerId);
    }).immediate();
  }
  updateProfile(playerId: string, input: Record<string, unknown>): Account {
    if (input.avatarPhoto !== undefined && input.avatar !== 'photo') fail('INVALID_AVATAR_PHOTO', 'Выберите подходящее фото');
    const photo = input.avatarPhoto === undefined ? undefined : normalizeAvatarPhoto(input.avatarPhoto);
    return this.db.transaction(() => {
      this.run('UPDATE players SET display_name=? WHERE player_id=?', displayNameField(input.displayName), playerId);
      if (input.avatar === null) {
        this.run('DELETE FROM player_avatar WHERE player_id=?', playerId);
        this.run('DELETE FROM player_avatar_extra WHERE player_id=?', playerId);
      }
      else if (input.avatar !== undefined) {
        if (typeof input.avatar !== 'string' || (input.avatar !== 'photo' && !Object.hasOwn(AVATARS, input.avatar))) fail('INVALID_INPUT', 'Выберите аватар');
        if (input.avatar === 'photo') {
          if (photo) {
            this.run('DELETE FROM player_avatar WHERE player_id=?', playerId);
            this.db.prepare("INSERT INTO player_avatar_extra(player_id,avatar,photo,photo_version) VALUES (?,'photo',?,?) ON CONFLICT(player_id) DO UPDATE SET avatar=excluded.avatar,photo=excluded.photo,photo_version=excluded.photo_version")
              .run(playerId, photo.bytes, photo.version);
          } else if (!this.avatarPhoto(playerId)) fail('INVALID_AVATAR_PHOTO', 'Выберите подходящее фото');
        } else if (LEGACY_AVATARS.has(input.avatar)) {
          this.run('DELETE FROM player_avatar_extra WHERE player_id=?', playerId);
          this.run('INSERT INTO player_avatar VALUES (?,?) ON CONFLICT(player_id) DO UPDATE SET avatar=excluded.avatar', playerId, input.avatar);
        } else {
          this.run('DELETE FROM player_avatar WHERE player_id=?', playerId);
          this.run('INSERT INTO player_avatar_extra(player_id,avatar,photo,photo_version) VALUES (?,?,NULL,NULL) ON CONFLICT(player_id) DO UPDATE SET avatar=excluded.avatar,photo=NULL,photo_version=NULL', playerId, input.avatar);
        }
      }
      return this.account(playerId);
    }).immediate();
  }
  async resendVerification(playerId: string): Promise<void> {
    const account = this.account(playerId);
    if (account.emailVerified || account.telegramVerified) return;
    this.rateLimit(`verification:${playerId}`, 1, 60_000);
    try { await this.sendAccountMail(playerId, 'verification'); }
    catch { fail('MAIL_UNAVAILABLE', 'Не удалось отправить письмо. Попробуйте позже', 503); }
  }
  verifyEmail(tokenInput: unknown): void {
    const token = textField(tokenInput, 'token', 40, 64);
    this.db.transaction(() => {
      const tokenRow = this.row("SELECT * FROM account_tokens WHERE token_hash=? AND purpose='verification'", digest(token));
      if (!tokenRow || tokenRow.used_at !== null || Number(tokenRow.expires_at) <= this.now()) fail('TOKEN_INVALID', 'Ссылка недействительна или устарела');
      this.run('UPDATE account_tokens SET used_at=? WHERE token_hash=?', this.now(), digest(token));
      this.run('UPDATE players SET email_verified=1 WHERE player_id=?', String(tokenRow.player_id));
    }).immediate();
  }
  async forgotPassword(emailInput: unknown): Promise<void> {
    const email = emailField(emailInput);
    const row = this.row('SELECT player_id FROM players WHERE email=?', email);
    if (row) {
      const playerId = String(row.player_id);
      // Response remains identical for unknown, rate-limited and undeliverable addresses.
      try { this.rateLimit(`reset:${playerId}`, 1, 60_000); await this.sendAccountMail(playerId, 'password_reset'); } catch { /* no account existence disclosure */ }
    }
  }
  async resetPassword(tokenInput: unknown, passwordInput: unknown): Promise<void> {
    const token = textField(tokenInput, 'token', 40, 64);
    const password = passwordField(passwordInput);
    const tokenHash = digest(token);
    const valid = () => this.row("SELECT * FROM account_tokens WHERE token_hash=? AND purpose='password_reset' AND used_at IS NULL AND expires_at>?", tokenHash, this.now());
    if (!valid()) fail('TOKEN_INVALID', 'Ссылка недействительна или устарела');
    const passwordHash = await this.passwordTask(() => hash(password, PASSWORD_OPTIONS));
    this.db.transaction(() => {
      const row = valid();
      if (!row) fail('TOKEN_INVALID', 'Ссылка недействительна или устарела');
      const playerId = String(row.player_id);
      this.run('UPDATE players SET password_hash=? WHERE player_id=?', passwordHash, playerId);
      this.run("UPDATE account_tokens SET used_at=? WHERE player_id=? AND purpose='password_reset' AND used_at IS NULL", this.now(), playerId);
      this.run('DELETE FROM web_sessions WHERE player_id=?', playerId);
    }).immediate();
  }
  createSession(playerId: string | null): { token: string; session: SessionRecord } {
    const token = secret();
    const now = this.now();
    const session: SessionRecord = { sessionHash: digest(token), playerId, csrfToken: secret(), createdAt: now, lastSeenAt: now, expiresAt: now + (playerId ? 30 * DAY : 60 * 60_000), reauthenticatedAt: playerId ? now : 0 };
    this.run('INSERT INTO web_sessions VALUES (?,?,?,?,?,?,?)', session.sessionHash, playerId, session.csrfToken, now, now, session.expiresAt, session.reauthenticatedAt);
    return { token, session };
  }
  getSession(token: string | undefined): SessionRecord | null {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const sessionHash = digest(token);
    const row = this.row('SELECT * FROM web_sessions WHERE session_hash=?', sessionHash);
    if (!row || Number(row.expires_at) <= this.now() || Number(row.last_seen_at) + (row.player_id ? 7 * DAY : 60 * 60_000) <= this.now()) return null;
    this.run('UPDATE web_sessions SET last_seen_at=? WHERE session_hash=?', this.now(), sessionHash);
    return { sessionHash, playerId: row.player_id ? String(row.player_id) : null, csrfToken: String(row.csrf_token), createdAt: Number(row.created_at), lastSeenAt: this.now(), expiresAt: Number(row.expires_at), reauthenticatedAt: Number(row.reauthenticated_at) };
  }
  checkCsrf(session: SessionRecord, token: unknown): void {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token) || !timingSafeEqual(Buffer.from(token), Buffer.from(session.csrfToken))) fail('CSRF_INVALID', 'Обновите страницу и повторите действие', 403);
  }
  revokeSession(sessionHash: string): void { this.run('DELETE FROM web_sessions WHERE session_hash=?', sessionHash); }
  revokeAllSessions(playerId: string): void { this.run('DELETE FROM web_sessions WHERE player_id=?', playerId); }
  catalogue(): Omit<GameRegistration, 'runtime' | 'normalizeSettings'>[] {
    return [...this.games.values()].map(game => ({
      gameId: game.gameId, collectionId: game.collectionId, title: game.title,
      minPlayers: game.minPlayers, maxPlayers: game.maxPlayers, supportsBots: game.supportsBots,
      rulesVersion: game.rulesVersion, contentVersion: game.contentVersion,
      status: game.status === 'available' && !game.runtime ? 'unavailable' : game.status,
    }));
  }
  searchPlayers(actor: string, query: unknown): PublicPlayer[] {
    this.requireVerified(actor);
    const handle = textField(query, 'handle', 3, 24).toLowerCase();
    if (!/^[a-z0-9_]+$/.test(handle)) return [];
    this.rateLimit(`search:${actor}`, 30);
    // Literal prefix, escaping underscores rather than treating handles as SQL patterns.
    return this.rows("SELECT player_id FROM players WHERE handle LIKE ? ESCAPE '\\' AND player_id<>? AND (email_verified=1 OR EXISTS (SELECT 1 FROM telegram_login_accounts t WHERE t.player_id=players.player_id)) ORDER BY handle LIMIT 12", `${handle.replaceAll('_', '\\_')}%`, actor)
      .filter(row => !this.blocked(actor, String(row.player_id))).map(row => this.publicPlayer(String(row.player_id)));
  }
  private blocked(a: string, b: string): boolean {
    return !!this.row('SELECT 1 AS found FROM blocks WHERE (blocker_id=? AND blocked_id=?) OR (blocker_id=? AND blocked_id=?)', a, b, b, a);
  }
  private friendsWith(a: string, b: string): boolean {
    const [low, high] = pair(a, b);
    return !this.blocked(a, b) && !!this.row("SELECT 1 AS found FROM friendships WHERE low_id=? AND high_id=? AND state='accepted'", low, high);
  }
  social(actor: string): { friends: PublicPlayer[]; incoming: { requestId: string; player: PublicPlayer }[]; outgoing: { requestId: string; player: PublicPlayer }[]; blocked: PublicPlayer[] } {
    this.requireVerified(actor);
    const result: ReturnType<PlatformService['social']> = { friends: [], incoming: [], outgoing: [], blocked: [] };
    for (const row of this.rows("SELECT * FROM friendships WHERE (low_id=? OR high_id=?) AND state IN ('pending','accepted') ORDER BY updated_at DESC", actor, actor)) {
      const other = String(row.low_id === actor ? row.high_id : row.low_id);
      if (this.blocked(actor, other)) continue;
      if (row.state === 'accepted') result.friends.push(this.publicPlayer(other));
      else result[row.requested_by === actor ? 'outgoing' : 'incoming'].push({ requestId: String(row.request_id), player: this.publicPlayer(other) });
    }
    result.blocked = this.rows('SELECT blocked_id FROM blocks WHERE blocker_id=?', actor).map(row => this.publicPlayer(String(row.blocked_id)));
    return result;
  }
  requestFriend(actor: string, targetInput: unknown): { requestId: string; state: string } {
    this.requireVerified(actor);
    const target = textField(targetInput, 'playerId', 1, 64);
    if (actor === target || this.blocked(actor, target)) fail('ACTION_UNAVAILABLE', 'Действие недоступно', 403);
    this.requireVerified(target);
    this.rateLimit(`friend:${actor}`, 20);
    const [low, high] = pair(actor, target);
    const existing = this.row('SELECT * FROM friendships WHERE low_id=? AND high_id=?', low, high);
    if (existing && (existing.state === 'pending' || existing.state === 'accepted')) return { requestId: String(existing.request_id), state: String(existing.state) };
    if (existing && (existing.state === 'declined' || existing.state === 'removed') && Number(existing.updated_at) + DAY > this.now()) fail('REQUEST_COOLDOWN', 'Повторную заявку можно отправить через сутки', 409);
    const requestId = randomUUID();
    this.run("INSERT INTO friendships VALUES (?,?,?,?,'pending',?) ON CONFLICT(low_id,high_id) DO UPDATE SET request_id=excluded.request_id,requested_by=excluded.requested_by,state='pending',updated_at=excluded.updated_at", requestId, low, high, actor, this.now());
    return { requestId, state: 'pending' };
  }
  respondFriend(actor: string, requestId: string, action: 'accept' | 'decline' | 'cancel'): void {
    this.requireVerified(actor);
    const row = this.row('SELECT * FROM friendships WHERE request_id=?', requestId);
    if (!row || (row.low_id !== actor && row.high_id !== actor)) fail('NOT_FOUND', 'Заявка не найдена', 404);
    const target = String(row.low_id === actor ? row.high_id : row.low_id);
    if (this.blocked(actor, target)) fail('ACTION_UNAVAILABLE', 'Действие недоступно', 403);
    if ((action === 'cancel') !== (row.requested_by === actor)) fail('FORBIDDEN', 'Это действие недоступно', 403);
    const state = action === 'accept' ? 'accepted' : action === 'decline' ? 'declined' : 'cancelled';
    if (row.state === state) return;
    if (row.state !== 'pending') fail('REQUEST_CLOSED', 'Эта заявка уже закрыта', 409);
    this.run('UPDATE friendships SET state=?,updated_at=? WHERE request_id=?', state, this.now(), requestId);
  }
  private revokePairInvitations(a: string, b: string): void {
    const invites = this.rows("SELECT invitation_id,room_id,invitee_id FROM invitations WHERE state IN ('pending','accepted') AND ((inviter_id=? AND invitee_id=?) OR (inviter_id=? AND invitee_id=?))", a, b, b, a);
    for (const invite of invites) {
      if (this.row('SELECT 1 AS found FROM room_members WHERE room_id=? AND player_id=?', String(invite.room_id), String(invite.invitee_id))) continue;
      this.run("UPDATE invitations SET state='revoked',reason='relationship_changed' WHERE invitation_id=?", String(invite.invitation_id));
      this.run('DELETE FROM seat_reservations WHERE invitation_id=?', String(invite.invitation_id));
    }
  }
  removeFriend(actor: string, target: string): void {
    this.requireVerified(actor);
    const [low, high] = pair(actor, target);
    this.run("UPDATE friendships SET state='removed',updated_at=? WHERE low_id=? AND high_id=? AND state IN ('accepted','pending')", this.now(), low, high);
    this.revokePairInvitations(actor, target);
  }
  blockPlayer(actor: string, targetInput: unknown): void {
    this.requireVerified(actor);
    const target = textField(targetInput, 'playerId', 1, 64);
    this.playerRow(target);
    if (actor === target) fail('INVALID_INPUT', 'Нельзя заблокировать себя');
    this.run('INSERT OR IGNORE INTO blocks VALUES (?,?,?)', actor, target, this.now());
    this.removeFriend(actor, target);
  }
  unblockPlayer(actor: string, target: string): void { this.run('DELETE FROM blocks WHERE blocker_id=? AND blocked_id=?', actor, target); }

  /** Keeps operation + its replay receipt inside the same SQLite transaction. */
  mutation<T>(actor: string, operation: string, key: string | undefined, payload: unknown, work: () => T): T {
    if (key !== undefined && !/^[A-Za-z0-9_.:-]{8,100}$/.test(key)) fail('INVALID_IDEMPOTENCY_KEY', 'Обновите страницу и попробуйте снова');
    return this.db.transaction(() => {
      this.expire();
      const payloadHash = digest(JSON.stringify(payload));
      if (key) {
        const previous = this.row('SELECT * FROM idempotency WHERE actor=? AND operation=? AND key=? AND expires_at>?', actor, operation, key, this.now());
        if (previous) {
          if (previous.payload_hash !== payloadHash) fail('IDEMPOTENCY_CONFLICT', 'Обновите страницу и повторите действие', 409);
          return JSON.parse(String(previous.result_json)) as T;
        }
      }
      const result = work();
      if (key) this.run('INSERT OR REPLACE INTO idempotency VALUES (?,?,?,?,?,?)', actor, operation, key, payloadHash, JSON.stringify(result ?? null), this.now() + DAY);
      return result;
    }).immediate();
  }
  private expire(): void {
    const now = this.now();
    for (const row of this.rows('SELECT invitation_id FROM seat_reservations WHERE expires_at<=?', now)) {
      this.run("UPDATE invitations SET state='expired',reason='reservation_expired' WHERE invitation_id=? AND state='accepted'", String(row.invitation_id));
    }
    this.run('DELETE FROM seat_reservations WHERE expires_at<=?', now);
    this.run("UPDATE invitations SET state='expired',reason='invitation_expired' WHERE state='pending' AND expires_at<=?", now);
    this.run('DELETE FROM idempotency WHERE expires_at<=?', now);
    this.run('DELETE FROM web_sessions WHERE expires_at<=? OR (player_id IS NULL AND last_seen_at<=?)', now, now - 60 * 60_000);
  }
  private roomRow(roomId: string): Row { return this.row('SELECT * FROM rooms WHERE room_id=?', roomId) ?? fail('NOT_FOUND', 'Комната не найдена', 404); }
  private member(actor: string, roomId: string): Row { return this.row('SELECT * FROM room_members WHERE room_id=? AND player_id=?', roomId, actor) ?? fail('FORBIDDEN', 'Нет доступа к комнате', 403); }
  private host(actor: string, roomId: string): Row {
    const row = this.roomRow(roomId);
    if (row.host_player_id !== actor) fail('FORBIDDEN', 'Только хозяин комнаты может это сделать', 403);
    return row;
  }
  private lobby(row: Row): void { if (row.state !== 'lobby') fail('ROOM_NOT_OPEN', 'Изменить эту комнату уже нельзя', 409); }
  private revision(row: Row, expected: unknown): void { if (intField(expected, 'expectedRevision', 1, Number.MAX_SAFE_INTEGER) !== row.revision) fail('STALE_REVISION', 'Комната изменилась. Обновите страницу', 409); }
  private bump(roomId: string, resetReady = false): void {
    this.run('UPDATE rooms SET revision=revision+1 WHERE room_id=?', roomId);
    if (resetReady) this.run("UPDATE room_members SET ready=CASE WHEN player_id IS NULL THEN 1 ELSE 0 END WHERE room_id=?", roomId);
  }
  private participants(roomId: string): Participant[] {
    return this.rows('SELECT m.*,p.handle,p.display_name AS account_name,a.avatar AS legacy_avatar,e.avatar AS extra_avatar,e.photo_version FROM room_members m LEFT JOIN players p ON p.player_id=m.player_id LEFT JOIN player_avatar a ON a.player_id=m.player_id LEFT JOIN player_avatar_extra e ON e.player_id=m.player_id WHERE room_id=? ORDER BY seat_index', roomId).map(row => ({
      participantId: String(row.participant_id), playerId: row.player_id ? String(row.player_id) : null,
      handle: row.handle ? String(row.handle) : '', displayName: String(row.account_name ?? row.display_name),
      ...(row.extra_avatar || row.legacy_avatar ? { avatar: (row.extra_avatar ?? row.legacy_avatar) as AvatarChoice } : {}),
      ...(row.extra_avatar === 'photo' && row.photo_version ? { avatarVersion: String(row.photo_version) } : {}),
      seatIndex: Number(row.seat_index), ready: !!row.ready, controller: JSON.parse(String(row.controller_json)) as Controller,
    }));
  }
  private occupancy(roomId: string): number {
    return Number(this.row('SELECT COUNT(*) AS count FROM room_members WHERE room_id=?', roomId)?.count ?? 0)
      + Number(this.row('SELECT COUNT(*) AS count FROM seat_reservations WHERE room_id=? AND expires_at>?', roomId, this.now())?.count ?? 0);
  }
  private vacantSeat(roomId: string, capacity: number): number {
    const used = new Set(this.rows('SELECT seat_index FROM room_members WHERE room_id=?', roomId).map(row => Number(row.seat_index)));
    for (let i = 0; i < capacity; i++) if (!used.has(i)) return i;
    return fail('ROOM_FULL', 'В комнате нет свободных мест', 409);
  }
  private roomView(roomId: string): Room {
    const row = this.roomRow(roomId);
    let startStatus: Room['startStatus'];
    if (row.state === 'starting') {
      startStatus = { state: 'starting' };
      const pending = this.row('SELECT last_error FROM start_commands WHERE room_id=? AND completed_at IS NULL', roomId);
      try {
        const value = JSON.parse(String(pending?.last_error));
        if (value?.code === 'ADMISSION_QUEUED' || value?.code === 'HOST_START_PENDING' || value?.code === 'ADMISSION_QUEUE_FULL') {
          startStatus = { state: 'queued', code: value.code,
            ...(Number.isSafeInteger(value.position) && value.position > 0 ? { position: value.position } : {}), retryAfterMs: 1000 };
        }
      } catch { /* Older releases store an unstructured reconciliation error. */ }
    }
    return {
      roomId, gameId: String(row.game_id), title: String(row.title), hostPlayerId: String(row.host_player_id),
      state: row.state as Room['state'], capacity: Number(row.capacity), rulesVersion: String(row.rules_version), contentVersion: String(row.content_version),
      revision: Number(row.revision), settings: JSON.parse(String(row.settings_json)), members: this.participants(roomId),
      reservedSeats: Number(this.row('SELECT COUNT(*) AS count FROM seat_reservations WHERE room_id=? AND expires_at>?', roomId, this.now())?.count ?? 0),
      matchId: row.match_id ? String(row.match_id) : null, outcome: row.outcome_json ? JSON.parse(String(row.outcome_json)) : null, createdAt: Number(row.created_at),
      ...(startStatus ? { startStatus } : {}),
    };
  }
  getRoom(actor: string, roomId: string): Room { this.member(actor, roomId); return this.roomView(roomId); }
  listRooms(actor: string): Room[] {
    // A history cap must never hide a room the player can still return to.
    const active = this.rows("SELECT r.room_id FROM rooms r JOIN room_members m ON m.room_id=r.room_id WHERE m.player_id=? AND r.state IN ('lobby','starting','playing') ORDER BY r.created_at DESC,r.room_id DESC", actor);
    const history = this.rows("SELECT r.room_id FROM rooms r JOIN room_members m ON m.room_id=r.room_id WHERE m.player_id=? AND r.state IN ('finished','cancelled') AND NOT EXISTS (SELECT 1 FROM room_list_hidden h WHERE h.player_id=m.player_id AND h.room_id=r.room_id) ORDER BY r.created_at DESC,r.room_id DESC LIMIT 50", actor);
    return [...active, ...history].map(row => this.roomView(String(row.room_id)));
  }
  hiddenRoomCount(actor: string): number {
    return Number(this.row("SELECT COUNT(*) AS count FROM room_list_hidden h JOIN rooms r ON r.room_id=h.room_id JOIN room_members m ON m.room_id=r.room_id AND m.player_id=h.player_id WHERE h.player_id=? AND r.state IN ('finished','cancelled')", actor)?.count ?? 0);
  }
  clearRoomHistory(actor: string): void {
    this.run("INSERT OR IGNORE INTO room_list_hidden (player_id,room_id) SELECT ?,r.room_id FROM rooms r JOIN room_members m ON m.room_id=r.room_id WHERE m.player_id=? AND r.state IN ('finished','cancelled')", actor, actor);
  }
  restoreRoomHistory(actor: string): void {
    this.run('DELETE FROM room_list_hidden WHERE player_id=?', actor);
  }
  private gameSettings(game: GameRegistration, input: unknown): Record<string, unknown> {
    if (game.normalizeSettings) return game.normalizeSettings(input);
    if (input !== undefined && (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length)) {
      fail('INVALID_SETTINGS', 'Проверьте настройки игры');
    }
    return {};
  }
  private roomGameVersion(game: GameRegistration, row: Row) {
    const rulesVersion = String(row.rules_version), contentVersion = String(row.content_version);
    const version = game.resolveRoomVersion
      ? game.resolveRoomVersion(rulesVersion, contentVersion)
      : game.rulesVersion === rulesVersion && game.contentVersion === contentVersion
        ? { normalizeSettings: (input: unknown) => this.gameSettings(game, input), botVersion: '1' }
        : undefined;
    return version ?? fail('GAME_VERSION_UNAVAILABLE', 'Игра обновилась. Создайте новую комнату', 409);
  }
  createRoom(actor: string, input: Record<string, unknown>): Room {
    this.requireVerified(actor);
    const gameId = textField(input.gameId, 'gameId', 1, 64);
    const game = this.games.get(gameId);
    if (!game || game.status !== 'available' || !game.runtime) fail('GAME_UNAVAILABLE', 'Эта игра пока недоступна', 409);
    const capacity = intField(input.capacity, 'capacity', game.minPlayers, game.maxPlayers);
    const count = Number(this.row("SELECT COUNT(*) AS count FROM rooms WHERE host_player_id=? AND state IN ('lobby','starting','playing')", actor)?.count ?? 0);
    if (count >= 5) fail('ROOM_LIMIT', 'Сначала закройте одну из ваших активных комнат', 409);
    const title = input.title === undefined ? `Комната ${this.publicPlayer(actor).displayName}` : textField(input.title, 'title', 1, 60).trim();
    if (!title) fail('INVALID_INPUT', 'Укажите название комнаты');
    const settings = this.gameSettings(game, input.settings);
    const roomId = randomUUID();
    this.run("INSERT INTO rooms VALUES (?,?,?,?,'lobby',?,?,?,1,?,?,NULL,NULL)", roomId, gameId, title, actor, capacity, game.rulesVersion, game.contentVersion, JSON.stringify(settings), this.now());
    this.run('INSERT INTO room_members VALUES (?,?,?,?,0,?,?)', randomUUID(), roomId, actor, 0, JSON.stringify({ kind: 'human', playerId: actor }), this.publicPlayer(actor).displayName);
    return this.roomView(roomId);
  }
  setReady(actor: string, roomId: string, input: Record<string, unknown>): Room {
    const row = this.roomRow(roomId); this.lobby(row); this.member(actor, roomId); this.revision(row, input.expectedRevision);
    if (typeof input.ready !== 'boolean') fail('INVALID_INPUT', 'Отметьте, готовы ли вы играть');
    this.run('UPDATE room_members SET ready=? WHERE room_id=? AND player_id=?', input.ready ? 1 : 0, roomId, actor);
    // Ready flags refer to roster/settings revision; changing another ready flag never invalidates them.
    return this.roomView(roomId);
  }
  changeSettings(actor: string, roomId: string, input: Record<string, unknown>): Room {
    const row = this.host(actor, roomId); this.lobby(row); this.revision(row, input.expectedRevision);
    const game = this.games.get(String(row.game_id))!;
    const capacity = input.capacity === undefined ? Number(row.capacity) : intField(input.capacity, 'capacity', game.minPlayers, game.maxPlayers);
    if (capacity < this.occupancy(roomId) || this.participants(roomId).some(p => p.seatIndex >= capacity)) fail('ROOM_FULL', 'Сначала освободите занятые места', 409);
    const title = input.title === undefined ? String(row.title) : textField(input.title, 'title', 1, 60).trim();
    if (!title) fail('INVALID_INPUT', 'Укажите название комнаты');
    const settings = this.roomGameVersion(game, row).normalizeSettings(input.settings === undefined ? JSON.parse(String(row.settings_json)) : input.settings);
    this.run('UPDATE rooms SET capacity=?,title=?,settings_json=? WHERE room_id=?', capacity, title, JSON.stringify(settings), roomId); this.bump(roomId, true);
    return this.roomView(roomId);
  }
  transferHost(actor: string, roomId: string, input: Record<string, unknown>): Room {
    const row = this.host(actor, roomId); this.lobby(row); this.revision(row, input.expectedRevision);
    const target = textField(input.playerId, 'playerId', 1, 64); this.member(target, roomId);
    this.run('UPDATE rooms SET host_player_id=? WHERE room_id=?', target, roomId); this.bump(roomId, true);
    // Invitations authored by the former host no longer grant new lobby access.
    for (const invite of this.rows("SELECT invitation_id FROM invitations WHERE room_id=? AND state IN ('pending','accepted')", roomId)) this.revokeInvitation(actor, String(invite.invitation_id), true);
    return this.roomView(roomId);
  }
  private revokeRoomInvites(roomId: string): void {
    this.run("UPDATE invitations SET state='revoked',reason='room_closed' WHERE room_id=? AND state='pending'", roomId);
    this.run("UPDATE invitations SET state='revoked',reason='room_closed' WHERE room_id=? AND state='accepted' AND invitation_id IN (SELECT invitation_id FROM seat_reservations WHERE room_id=?)", roomId, roomId);
    this.run('DELETE FROM seat_reservations WHERE room_id=?', roomId);
  }
  cancelRoom(actor: string, roomId: string): Room {
    const row = this.host(actor, roomId);
    if (row.state === 'cancelled') return this.roomView(roomId);
    this.lobby(row); this.run("UPDATE rooms SET state='cancelled',revision=revision+1 WHERE room_id=?", roomId); this.revokeRoomInvites(roomId);
    return this.roomView(roomId);
  }
  leaveRoom(actor: string, roomId: string): Room {
    const row = this.roomRow(roomId);
    const member = this.row('SELECT * FROM room_members WHERE room_id=? AND player_id=?', roomId, actor);
    if (!member) fail('NOT_FOUND', 'Вы не состоите в комнате', 404);
    if (row.state !== 'lobby') return fail('MATCH_ALREADY_STARTED', 'Сейчас выйти из комнаты нельзя', 409);
    if (row.host_player_id === actor) return this.cancelRoom(actor, roomId);
    this.run('DELETE FROM room_members WHERE participant_id=?', String(member.participant_id));
    this.run("UPDATE invitations SET state='revoked',reason='left_room' WHERE room_id=? AND invitee_id=? AND state IN ('pending','accepted')", roomId, actor);
    this.bump(roomId, true); return this.roomView(roomId);
  }
  kick(actor: string, roomId: string, input: Record<string, unknown>): Room {
    const row = this.host(actor, roomId); this.lobby(row); this.revision(row, input.expectedRevision);
    const participantId = textField(input.participantId, 'participantId', 1, 64);
    const member = this.row('SELECT * FROM room_members WHERE room_id=? AND participant_id=?', roomId, participantId);
    if (!member) fail('NOT_FOUND', 'Участник не найден', 404);
    if (member.player_id === actor) fail('INVALID_INPUT', 'Передайте роль создателя или закройте комнату');
    this.run('DELETE FROM room_members WHERE participant_id=?', participantId);
    if (member.player_id) this.run("UPDATE invitations SET state='revoked',reason='removed_from_room' WHERE room_id=? AND invitee_id=? AND state IN ('pending','accepted')", roomId, String(member.player_id));
    this.bump(roomId, true); return this.roomView(roomId);
  }
  addBot(actor: string, roomId: string, input: Record<string, unknown>): Room {
    const row = this.host(actor, roomId); this.lobby(row); this.revision(row, input.expectedRevision);
    const game = this.games.get(String(row.game_id));
    if (!game?.supportsBots) fail('BOTS_UNSUPPORTED', 'В этой игре пока нет ботов', 409);
    const difficulty = input.difficulty;
    if (typeof difficulty !== 'string' || !['easy', 'normal', 'hard'].includes(difficulty)) fail('INVALID_INPUT', 'Выберите сложность бота');
    if (this.occupancy(roomId) >= Number(row.capacity)) fail('ROOM_FULL', 'В комнате нет свободных мест', 409);
    const participantId = randomUUID();
    const controller: Controller = { kind: 'bot', botProfileId: `${game.gameId}:${difficulty}`, botVersion: this.roomGameVersion(game, row).botVersion, difficulty: difficulty as Difficulty };
    const seat = this.vacantSeat(roomId, Number(row.capacity));
    this.run('INSERT INTO room_members VALUES (?,?,NULL,?,1,?,?)', participantId, roomId, seat, JSON.stringify(controller), `Бот ${seat + 1}`);
    this.bump(roomId, true); return this.roomView(roomId);
  }
  removeBot(actor: string, roomId: string, participantId: string, input: Record<string, unknown>): Room {
    const member = this.row('SELECT player_id FROM room_members WHERE room_id=? AND participant_id=?', roomId, participantId);
    if (!member || member.player_id !== null) fail('NOT_FOUND', 'Бот не найден', 404);
    return this.kick(actor, roomId, { ...input, participantId });
  }
  private canJoin(actor: string, roomId: string): void {
    this.requireVerified(actor);
    const row = this.roomRow(roomId); this.lobby(row);
    for (const member of this.participants(roomId)) if (member.playerId && this.blocked(actor, member.playerId)) fail('ACTION_UNAVAILABLE', 'Действие недоступно', 403);
  }
  invite(actor: string, roomId: string, targetInput: unknown): Invitation {
    this.requireVerified(actor); const row = this.host(actor, roomId); this.lobby(row);
    const target = textField(targetInput, 'playerId', 1, 64);
    if (!this.friendsWith(actor, target)) fail('FRIENDS_REQUIRED', 'Сначала добавьте игрока в друзья', 403);
    this.canJoin(target, roomId);
    if (this.row('SELECT 1 AS found FROM room_members WHERE room_id=? AND player_id=?', roomId, target)) fail('ALREADY_JOINED', 'Друг уже в комнате', 409);
    const existing = this.row("SELECT invitation_id FROM invitations WHERE room_id=? AND invitee_id=? AND state IN ('pending','accepted')", roomId, target);
    if (existing) return this.invitationView(String(existing.invitation_id));
    this.rateLimit(`invite:${actor}`, 30);
    const id = randomUUID();
    this.run("INSERT INTO invitations VALUES (?,?,?,?,'pending',?,?,NULL,NULL)", id, roomId, actor, target, this.now(), this.now() + INVITE_TTL);
    this.run("INSERT INTO site_notifications VALUES (?,?,'game_invitation',?,?)", randomUUID(), target, id, this.now());
    // Optional adapter checks existing opt-in/binding in this same transaction. No send occurs here.
    this.invitationDelivery?.(id);
    return this.invitationView(id);
  }
  private invitationRow(id: string): Row { return this.row('SELECT * FROM invitations WHERE invitation_id=?', id) ?? fail('NOT_FOUND', 'Приглашение не найдено', 404); }
  private invitationView(id: string): Invitation {
    const row = this.invitationRow(id); const room = this.roomRow(String(row.room_id));
    const reservation = this.row('SELECT expires_at FROM seat_reservations WHERE invitation_id=?', id);
    let state = row.state as Invitation['status']; let reason = row.reason ? String(row.reason) : null;
    if (state === 'pending' && Number(row.expires_at) <= this.now()) { state = 'expired'; reason = 'invitation_expired'; }
    if (state === 'accepted' && reservation && Number(reservation.expires_at) <= this.now()) { state = 'expired'; reason = 'reservation_expired'; }
    return {
      invitationId: id, roomId: String(row.room_id), roomTitle: String(room.title), gameId: String(room.game_id),
      inviter: this.publicPlayer(String(row.inviter_id)), invitee: this.publicPlayer(String(row.invitee_id)),
      status: state, displayStatus: state === 'pending' && this.occupancy(String(row.room_id)) >= Number(room.capacity) ? 'full' : state,
      expiresAt: Number(row.expires_at), reservationExpiresAt: reservation ? Number(reservation.expires_at) : null,
      reason, url: `${this.publicOrigin}/invitations/${id}`,
    };
  }
  getInvitation(actor: string, id: string): Invitation {
    const row = this.invitationRow(id);
    if (row.inviter_id !== actor && row.invitee_id !== actor) fail('NOT_FOUND', 'Приглашение не найдено', 404);
    return this.invitationView(id);
  }
  listInvitations(actor: string): Invitation[] {
    // Joined, expired and closed invitations are history. Keep every pending offer or
    // unexpired reservation visible even when the account has a long invitation history.
    const now = this.now();
    return this.rows(`
      WITH visible AS (
        SELECT i.invitation_id,i.created_at,
          CASE WHEN r.state='lobby' AND (
            (i.state='pending' AND i.expires_at>?) OR
            (i.state='accepted' AND EXISTS (SELECT 1 FROM seat_reservations s WHERE s.invitation_id=i.invitation_id AND s.expires_at>?))
          ) THEN 1 ELSE 0 END AS actionable
        FROM invitations i JOIN rooms r ON r.room_id=i.room_id
        WHERE i.invitee_id=? OR i.inviter_id=?
      ), history AS (
        SELECT * FROM visible WHERE actionable=0 ORDER BY created_at DESC,invitation_id DESC LIMIT 100
      )
      SELECT invitation_id FROM (
        SELECT * FROM visible WHERE actionable=1 UNION ALL SELECT * FROM history
      ) ORDER BY actionable DESC,created_at DESC,invitation_id DESC
    `, now, now, actor, actor).map(row => this.invitationView(String(row.invitation_id)));
  }
  acceptInvitation(actor: string, id: string): Invitation {
    this.requireVerified(actor); const row = this.invitationRow(id);
    if (row.invitee_id !== actor) fail('NOT_FOUND', 'Приглашение не найдено', 404);
    if (row.state === 'accepted') return this.invitationView(id);
    if (row.state !== 'pending' || Number(row.expires_at) <= this.now()) fail('INVITATION_CLOSED', 'Приглашение больше не действует', 409);
    const roomId = String(row.room_id); const room = this.roomRow(roomId);
    this.canJoin(actor, roomId);
    if (room.host_player_id !== row.inviter_id || !this.friendsWith(actor, String(row.inviter_id))) fail('ACTION_UNAVAILABLE', 'Действие недоступно', 403);
    if (this.occupancy(roomId) >= Number(room.capacity)) fail('ROOM_FULL', 'В комнате нет свободных мест', 409);
    this.run('INSERT INTO seat_reservations VALUES (?,?,?,?)', roomId, actor, id, Math.min(this.now() + RESERVATION_TTL, Number(row.expires_at)));
    this.run("UPDATE invitations SET state='accepted',accepted_at=? WHERE invitation_id=?", this.now(), id);
    return this.invitationView(id);
  }
  declineInvitation(actor: string, id: string): Invitation {
    const row = this.invitationRow(id);
    if (row.invitee_id !== actor) fail('NOT_FOUND', 'Приглашение не найдено', 404);
    if (row.state === 'declined') return this.invitationView(id);
    if (row.state !== 'pending') fail('INVITATION_CLOSED', 'Приглашение уже обработано', 409);
    this.run("UPDATE invitations SET state='declined' WHERE invitation_id=?", id);
    return this.invitationView(id);
  }
  revokeInvitation(actor: string, id: string, internal = false): Invitation {
    const row = this.invitationRow(id);
    if (!internal && row.inviter_id !== actor) fail('NOT_FOUND', 'Приглашение не найдено', 404);
    if (this.row('SELECT 1 AS found FROM room_members WHERE room_id=? AND player_id=?', String(row.room_id), String(row.invitee_id))) return this.invitationView(id);
    if (row.state === 'pending' || row.state === 'accepted') {
      this.run("UPDATE invitations SET state='revoked',reason='revoked_by_host' WHERE invitation_id=?", id);
      this.run('DELETE FROM seat_reservations WHERE invitation_id=?', id);
    }
    return this.invitationView(id);
  }
  joinRoom(actor: string, roomId: string): Room {
    this.requireVerified(actor);
    if (this.row('SELECT 1 AS found FROM room_members WHERE room_id=? AND player_id=?', roomId, actor)) return this.roomView(roomId);
    this.canJoin(actor, roomId);
    const reservation = this.row('SELECT * FROM seat_reservations WHERE room_id=? AND player_id=? AND expires_at>?', roomId, actor, this.now());
    if (!reservation) fail('RESERVATION_REQUIRED', 'Сначала примите приглашение в эту комнату', 403);
    const room = this.roomRow(roomId);
    this.run('INSERT INTO room_members VALUES (?,?,?,?,0,?,?)', randomUUID(), roomId, actor, this.vacantSeat(roomId, Number(room.capacity)), JSON.stringify({ kind: 'human', playerId: actor }), this.publicPlayer(actor).displayName);
    this.run('DELETE FROM seat_reservations WHERE room_id=? AND player_id=?', roomId, actor);
    this.bump(roomId, true); return this.roomView(roomId);
  }
  startRoom(actor: string, roomId: string, input: Record<string, unknown>): Room {
    const row = this.host(actor, roomId);
    if (row.state === 'starting' || row.state === 'playing') return this.roomView(roomId);
    this.lobby(row); this.revision(row, input.expectedRevision);
    const game = this.games.get(String(row.game_id));
    if (!game || game.status !== 'available' || !game.runtime) fail('GAME_UNAVAILABLE', 'Игра временно недоступна. Попробуйте позже', 503);
    this.roomGameVersion(game, row);
    const participants = this.participants(roomId);
    if (participants.length < game.minPlayers || participants.length > game.maxPlayers || !participants.some(p => p.playerId)) fail('PLAYER_COUNT', 'Недостаточно участников для начала', 409);
    if (participants.some(p => !p.ready)) fail('PLAYERS_NOT_READY', 'Не все игроки готовы', 409);
    if (this.occupancy(roomId) !== participants.length) fail('RESERVATIONS_PENDING', 'Дождитесь приглашённых игроков', 409);
    const command: StartMatchCommand = { startCommandId: randomUUID(), roomId, hostPlayerId: String(row.host_player_id), rulesVersion: String(row.rules_version), contentVersion: String(row.content_version), participants, settings: JSON.parse(String(row.settings_json)) };
    this.run("UPDATE rooms SET state='starting',revision=revision+1 WHERE room_id=?", roomId);
    this.run('INSERT INTO start_commands VALUES (?,?,?,0,?,NULL,NULL)', command.startCommandId, roomId, JSON.stringify(command), this.now());
    this.revokeRoomInvites(roomId);
    return this.roomView(roomId);
  }
  async reconcile(): Promise<void> {
    if (this.ticking || this.reconciliationStopping || !this.db.open) return;
    this.ticking = true;
    let complete!: () => void;
    this.reconciliationFinished = new Promise<void>(resolve => { complete = resolve; });
    try {
      this.db.transaction(() => this.expire()).immediate();
      await this.runtimeBatch(this.rows('SELECT s.*,r.game_id,r.host_player_id FROM start_commands s JOIN rooms r ON r.room_id=s.room_id WHERE completed_at IS NULL AND next_attempt_at<=? ORDER BY s.rowid LIMIT 20', this.now()), async row => {
        const runtime = this.games.get(String(row.game_id))?.runtime;
        if (!runtime) return;
        try {
          const result = await this.runtimeCall(runtime.createMatch(JSON.parse(String(row.payload_json)) as StartMatchCommand, { hostPlayerId: String(row.host_player_id) }));
          if (!result.matchId) throw new Error('Missing match identity');
          this.db.transaction(() => {
            this.run('UPDATE start_commands SET completed_at=?,attempts=attempts+1,last_error=NULL WHERE start_command_id=?', this.now(), String(row.start_command_id));
            this.run("UPDATE rooms SET state='playing',match_id=?,revision=revision+1 WHERE room_id=? AND state='starting'", result.matchId, String(row.room_id));
          }).immediate();
        } catch (error) {
          // An unknown result never reopens the frozen roster; retry the same command.
          const failure = error as { code?: string; details?: { position?: unknown } };
          const waiting = ['ADMISSION_QUEUED', 'ADMISSION_EXPIRED', 'HOST_START_PENDING', 'ADMISSION_QUEUE_FULL', 'SERVER_UPDATING', 'WORKER_RECOVERING'].includes(failure?.code ?? '');
          const recorded = waiting ? JSON.stringify({ code: failure.code, ...(typeof failure.details?.position === 'number' ? { position: failure.details.position } : {}) }) : 'runtime_unconfirmed';
          this.run('UPDATE start_commands SET attempts=attempts+1,next_attempt_at=?,last_error=? WHERE start_command_id=?', this.now() + (waiting ? 1000 : Math.min(30_000, 1000 * (Number(row.attempts) + 1))), recorded, String(row.start_command_id));
        }
      });
      await this.runtimeBatch(this.rows("SELECT room_id,game_id,match_id FROM rooms WHERE state='playing'"), async row => {
        const runtime = this.games.get(String(row.game_id))?.runtime;
        if (!runtime?.status) return;
        try {
          const status = await this.runtimeCall(runtime.status(String(row.match_id)));
          if (status.finished) {
            this.run("UPDATE rooms SET state='finished',outcome_json=?,revision=revision+1 WHERE room_id=? AND state='playing'", JSON.stringify(status.outcome ?? null), String(row.room_id));
          }
        } catch { /* Keep durable room membership when the runtime is temporarily unavailable. */ }
      });
      // Refresh signed admissions independently of game input; revoked or expired
      // website sessions disappear from this list within the 60-second window.
      if (this.now() - this.lastAdmissionSync >= 20_000) {
        const sessionIds = this.rows('SELECT session_hash FROM web_sessions WHERE player_id IS NOT NULL AND expires_at>? AND last_seen_at>?', this.now(), this.now() - 7 * DAY).map(row => String(row.session_hash));
        await Promise.allSettled([...this.games.values()].flatMap(game => game.runtime?.syncAdmissions ? [this.runtimeCall(game.runtime.syncAdmissions(sessionIds))] : []));
        this.lastAdmissionSync = this.now();
      }
      // A result is acknowledged only after the platform's own room row is durable.
      await this.runtimeBatch(this.rows("SELECT game_id,match_id,outcome_json FROM rooms WHERE state='finished' AND outcome_json IS NOT NULL AND match_id NOT IN (SELECT match_id FROM realtime_result_acks)"), async row => {
        const runtime = this.games.get(String(row.game_id))?.runtime;
        if (!runtime?.confirmResult) return;
        const outcome = JSON.parse(String(row.outcome_json)) as { resultId?: unknown };
        if (typeof outcome?.resultId === 'string') {
          try {
            await this.runtimeCall(runtime.confirmResult(String(row.match_id), outcome.resultId));
            this.run('INSERT OR IGNORE INTO realtime_result_acks VALUES(?)', String(row.match_id));
          } catch { /* Retain result and retry the outbox acknowledgement. */ }
        }
      });
    } finally { this.ticking = false; complete(); this.reconciliationFinished = null; }
  }
  private matchRuntime(actor: string, roomId: string): { runtime: NonNullable<GameRegistration['runtime']>; matchId: string } {
    this.member(actor, roomId); const room = this.roomRow(roomId);
    if (!['playing', 'finished'].includes(String(room.state)) || !room.match_id) fail('MATCH_NOT_STARTED', 'Партия ещё не началась', 409);
    const runtime = this.games.get(String(room.game_id))?.runtime;
    if (!runtime) fail('GAME_UNAVAILABLE', 'Игра временно недоступна. Попробуйте позже', 503);
    return { runtime, matchId: String(room.match_id) };
  }
  async matchView(actor: string, roomId: string): Promise<unknown> {
    const { runtime, matchId } = this.matchRuntime(actor, roomId);
    return this.runtimeCall(runtime.viewForPlayer(matchId, actor));
  }
  async matchTicket(actor: string, roomId: string, sessionId: string, origin: string): Promise<unknown> {
    const { runtime, matchId } = this.matchRuntime(actor, roomId);
    if (!runtime.realtimeTicket) fail('REALTIME_UNAVAILABLE', 'Игра пока недоступна', 409);
    return this.runtimeCall(runtime.realtimeTicket(matchId, actor, sessionId, origin));
  }
  async matchAction(actor: string, roomId: string, input: Record<string, unknown>): Promise<unknown> {
    const { runtime, matchId } = this.matchRuntime(actor, roomId);
    const actionId = textField(input.actionId, 'actionId', 8, 100);
    const expectedRevision = intField(input.expectedRevision, 'expectedRevision', 0, Number.MAX_SAFE_INTEGER);
    const result = await this.runtimeCall(runtime.applyAction(matchId, actor, { actionId, expectedRevision, payload: input.payload }));
    await this.reconcile(); return result;
  }
}
