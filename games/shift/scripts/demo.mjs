/** Isolated, loopback-only acceptance fixture using the ordinary platform HTTP API. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const DEMO_PASSWORD = 'Shift isolated local demo 2026!';
const request = (url, options = {}) => fetch(url, { ...options, signal: AbortSignal.timeout(8000) });

export class ShiftDemoClient {
  cookie = '';
  csrf = '';
  user = null;
  constructor(origin, mailbox) { this.origin = origin; this.mailbox = mailbox; }
  async request(path, data, key = randomUUID()) {
    const response = await request(this.origin + '/api/platform/v1' + path, {
      method: data === undefined ? 'GET' : 'POST', headers: {
        Cookie: this.cookie,
        ...(data === undefined ? {} : { Origin: this.origin, 'Content-Type': 'application/json', 'X-CSRF-Token': this.csrf, 'Idempotency-Key': key }),
      }, ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    const cookie = response.headers.getSetCookie().find(value => value.startsWith('iva_dev_session='));
    if (cookie) this.cookie = cookie.split(';')[0];
    const result = await response.json();
    assert.ok(response.ok, `${path}: HTTP ${response.status} (${result.error?.code ?? 'unknown'})`);
    if (path === '/session') this.csrf = result.csrfToken;
    return result;
  }
  async register(handle, displayName) {
    await this.request('/session');
    const email = `${handle}@example.test`;
    await this.request('/auth/register', { email, handle, displayName, password: DEMO_PASSWORD });
    await this.request('/session');
    let token;
    for (const filename of await readdir(this.mailbox)) {
      const text = await readFile(join(this.mailbox, filename), 'utf8');
      if (!text.startsWith(`To: ${email}\n`)) continue;
      const link = text.match(/https?:\/\/\S+\/verify\?token=\S+/)?.[0];
      if (link && new URL(link).origin === this.origin) token = new URL(link).searchParams.get('token');
    }
    assert.ok(token, 'The isolated file mailbox must contain the normal verification link');
    await this.request('/auth/verify', { token });
    const session = await this.request('/session');
    assert.equal(session.user.emailVerified, true);
    this.user = session.user;
    return { ...session.user, email };
  }
  storageState() {
    return { cookies: [{ name: 'iva_dev_session', value: this.cookie.slice('iva_dev_session='.length), domain: '127.0.0.1', path: '/',
      expires: Math.floor(Date.now() / 1000) + 86400, httpOnly: true, secure: false, sameSite: 'Lax' }], origins: [] };
  }
}

/** Creates actual friendship, invitation, reservation, seats and readiness. No DB edits. */
export async function createShiftDemoRoom(host, guest, options = {}) {
  const teamSize = options.teamSize ?? 2;
  const settings = { arena: options.arena ?? 'foundry', teamSize, rotateRoles: options.rotateRoles ?? true, difficulty: options.difficulty ?? 'normal' };
  let room = (await host.request('/rooms', { gameId: 'shift', capacity: teamSize * 2, title: `Shift ${teamSize}×${teamSize} · local QA`, settings })).room;
  const invitation = (await host.request(`/rooms/${room.roomId}/invitations`, { playerId: guest.user.playerId })).invitation;
  await guest.request(`/invitations/${invitation.invitationId}/accept`, {});
  room = (await guest.request(`/rooms/${room.roomId}/join`, {})).room;
  while (room.members.length < room.capacity) room = (await host.request(`/rooms/${room.roomId}/bots`, { expectedRevision: room.revision, difficulty: settings.difficulty })).room;
  const teams = Object.fromEntries(room.members.map((member, index) => [member.participantId, options.sameTeam
    ? index < teamSize ? 'teal' : 'amber' : index % 2 ? 'amber' : 'teal']));
  const initialNavigators = {};
  for (const team of ['teal', 'amber']) {
    const members = room.members.filter(member => teams[member.participantId] === team);
    initialNavigators[team] = (team === 'teal' && options.hostRole !== 'navigator'
      ? members.find(member => member.playerId !== host.user.playerId) ?? members[0]
      : members[0]).participantId;
  }
  room = (await host.request(`/rooms/${room.roomId}/settings`, { expectedRevision: room.revision, settings: { ...settings, teams, initialNavigators } })).room;
  if (options.start) {
    await host.request(`/rooms/${room.roomId}/ready`, { expectedRevision: room.revision, ready: true });
    await guest.request(`/rooms/${room.roomId}/ready`, { expectedRevision: room.revision, ready: true });
    room = (await host.request(`/rooms/${room.roomId}/start`, { expectedRevision: room.revision })).room;
    const deadline = Date.now() + 8000;
    while (room.state === 'starting' && Date.now() < deadline) { await delay(100); room = (await host.request(`/rooms/${room.roomId}`)).room; }
    assert.equal(room.state, 'playing'); assert.ok(room.matchId);
  }
  return room;
}

export async function startShiftDemo(options = {}) {
  const port = options.port ?? 4398;
  assert.ok(Number.isSafeInteger(port) && port > 1024 && port < 65536, 'Use an unprivileged isolated port');
  const origin = `http://127.0.0.1:${port}`;
  const platformEntrypoint = resolve(options.platformEntrypoint || join(ROOT, 'dist-platform/main.js'));
  const portalDirectory = resolve(options.portalDirectory || join(ROOT, 'apps/portal/dist'));
  for (const path of [platformEntrypoint, join(portalDirectory, 'index.html')]) assert.ok((await stat(path).catch(() => null))?.isFile(), 'Run npm run build:foundation first');
  const base = join(ROOT, '.qa', 'shift-demo'); await mkdir(base, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(base, 'run-'));
  const mailbox = join(directory, 'mail'), logPath = join(directory, 'platform.log');
  let running = null, stopped = false;
  async function start() {
    const child = spawn(process.execPath, [platformEntrypoint], { cwd: ROOT,
      env: { ...process.env, NODE_ENV: 'development', PLATFORM_HOST: '127.0.0.1', PLATFORM_PORT: String(port),
        PORTAL_ORIGIN: origin, PLATFORM_ALLOWED_HOSTS: `127.0.0.1:${port},localhost:${port}`, PLATFORM_ALLOWED_ORIGINS: origin,
        TRUSTED_PROXY_IPS: '', PLATFORM_DATABASE_PATH: join(directory, 'platform.sqlite'), PLATFORM_LAB_DATABASE_PATH: join(directory, 'runtime.sqlite'),
        MAIL_MODE: 'file', MAIL_FILE_DIRECTORY: mailbox, TELEGRAM_ENABLED: 'false', TELEGRAM_AUTH_ENABLED: 'false',
        PORTAL_DIST_DIRECTORY: portalDirectory }, stdio: ['ignore', 'pipe', 'pipe'] });
    const state = { child, output: '', error: null }; running = state;
    const collect = part => { const text = String(part); state.output = (state.output + text).slice(-16000); void appendFile(logPath, text, { mode: 0o600 }).catch(error => { state.error ??= error; }); };
    child.stdout.on('data', collect); child.stderr.on('data', collect); child.on('error', error => { state.error = error; });
    const expected = `Iva Games platform listening on 127.0.0.1:${port}`, deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (state.error) throw state.error;
      assert.ok(child.exitCode === null && child.signalCode === null, `Local fixture server exited; see ${logPath}`);
      if (state.output.split(/\r?\n/).includes(expected)) {
        assert.equal((await request(origin + '/health/ready')).status, 200); return;
      }
      await delay(25);
    }
    throw new Error(`Local fixture server did not become ready; see ${logPath}`);
  }
  async function stopProcess(crash = false) {
    const state = running; running = null;
    if (!state || state.child.exitCode !== null || state.child.signalCode !== null) return;
    const child = state.child;
    child.kill(crash ? 'SIGKILL' : 'SIGTERM');
    const deadline = Date.now() + 7000;
    while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await delay(25);
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); throw new Error('Fixture shutdown did not drain'); }
    if (!crash) assert.equal(child.exitCode, 0, 'Fixture server shutdown must succeed');
  }
  async function stop() { if (stopped) return; stopped = true; await stopProcess(); }
  try {
    await start();
    const pilot = new ShiftDemoClient(origin, mailbox), navigator = new ShiftDemoClient(origin, mailbox);
    const one = await pilot.register('shift_pilot', 'Лис'), two = await navigator.register('shift_navigator', 'Сова');
    const friendship = await pilot.request('/friend-requests', { playerId: two.playerId });
    await navigator.request(`/friend-requests/${friendship.requestId}/accept`, {});
    const catalogue = await pilot.request('/games');
    assert.equal(catalogue.games.find(game => game.gameId === 'shift')?.status, 'available');
    assert.equal((await pilot.request('/telegram')).available, false);
    const profiles = { pilot: join(directory, 'pilot.storage.json'), navigator: join(directory, 'navigator.storage.json') };
    await writeFile(profiles.pilot, JSON.stringify(pilot.storageState(), null, 2), { mode: 0o600 });
    await writeFile(profiles.navigator, JSON.stringify(navigator.storageState(), null, 2), { mode: 0o600 });
    const rooms = [];
    if (options.rooms) for (const teamSize of [2, 3]) rooms.push(await createShiftDemoRoom(pilot, navigator, { teamSize, start: options.start === true }));
    const fixture = { origin, directory, logPath, profiles,
      accounts: [{ email: one.email, password: DEMO_PASSWORD, playerId: one.playerId, displayName: one.displayName }, { email: two.email, password: DEMO_PASSWORD, playerId: two.playerId, displayName: two.displayName }],
      rooms: rooms.map(room => ({ roomId: room.roomId, matchId: room.matchId, teamSize: room.settings.teamSize, state: room.state, url: origin + '/rooms/' + room.roomId })) };
    const fixturePath = join(directory, 'fixture.json'), readyPath = join(base, `fixture-${port}.json`);
    await writeFile(fixturePath, JSON.stringify(fixture, null, 2), { mode: 0o600 });
    await writeFile(readyPath, JSON.stringify({ ...fixture, fixturePath }, null, 2), { mode: 0o600 });
    return { ...fixture, fixturePath, readyPath, pilot, navigator, stop,
      restart: async ({ crash = false } = {}) => { assert.ok(!stopped, 'Fixture has stopped'); await stopProcess(crash); await start(); },
      createRoom: async roomOptions => createShiftDemoRoom(pilot, navigator, roomOptions),
    };
  } catch (error) { await stop().catch(() => {}); throw error; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), portAt = args.indexOf('--port');
  const demo = await startShiftDemo({ port: portAt < 0 ? 4398 : Number(args[portAt + 1]), rooms: args.includes('--rooms') || args.includes('--start'), start: args.includes('--start') });
  process.stdout.write(`SHIFT_DEMO_READY ${demo.origin}\n`);
  process.stdout.write(JSON.stringify({ localOnly: true, url: demo.origin + '/shift', fixturePath: demo.fixturePath, readyPath: demo.readyPath, profiles: demo.profiles,
    accounts: demo.accounts.map(({ email, password }) => ({ email, password })), rooms: demo.rooms }, null, 2) + '\n');
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void demo.stop().then(() => process.exit(0), () => process.exit(1)); });
}
