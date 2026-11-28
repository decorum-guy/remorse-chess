import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import Database from 'better-sqlite3';
import type { ActionEnvelope, GameRegistration, LiveScope, LiveServerFrame, RealtimeGameRuntime, RealtimeInput, RealtimeSnapshot, StartMatchRequest } from '@iva-games/session-kit';
import { LIVE_PROTOCOL } from '@iva-games/session-kit';
import { PlatformService } from '../src/service';
import { createPlatformHttpServer } from '../src/http';
import { MemoryMailbox } from '../src/mail';

const ORIGIN = 'http://live.test';
/** Deliberately tiny fixture game, not a simulated Test Bench implementation.
 * Its real SQLite command receipts let transport tests detect replay/loss. */
class FixtureRuntime implements RealtimeGameRuntime {
  readonly wireVersion = 'fixture-wire@1';
  db: Database.Database;
  epochs = new Map<string, string>();
  inputs: { playerId: string; input: RealtimeInput }[] = [];
  disconnects: { playerId: string; epoch: string }[] = [];
  connectGate: (() => Promise<void>) | undefined;
  actionGate: (() => Promise<void>) | undefined;
  tick = 0;
  snapshots = 0;
  constructor(path: string) {
    this.db = new Database(path);
    this.db.exec('CREATE TABLE IF NOT EXISTS receipts (action_id TEXT PRIMARY KEY, player_id TEXT NOT NULL, payload TEXT NOT NULL, result TEXT NOT NULL); CREATE TABLE IF NOT EXISTS matches (id TEXT PRIMARY KEY, roster TEXT NOT NULL)');
  }
  async createMatch(input: StartMatchRequest) {
    const matchId = input.startCommandId;
    this.db.prepare('INSERT OR IGNORE INTO matches VALUES (?,?)').run(matchId, JSON.stringify(input.participants));
    return { matchId };
  }
  async viewForPlayer(matchId: string, playerId: string) {
    const match = this.db.prepare('SELECT roster FROM matches WHERE id=?').get(matchId) as { roster: string } | undefined;
    if (!match || !(JSON.parse(match.roster) as { playerId: string | null }[]).some(p => p.playerId === playerId)) throw new Error('invalid participant');
    const count = (this.db.prepare('SELECT COUNT(*) AS n FROM receipts WHERE player_id=?').get(playerId) as { n: number }).n;
    return { playerId, privateDraft: `only:${playerId}`, count };
  }
  async applyAction(matchId: string, playerId: string, command: ActionEnvelope) {
    await this.viewForPlayer(matchId, playerId);
    if (this.actionGate) await this.actionGate();
    return this.db.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM receipts WHERE action_id=?').get(command.actionId) as { player_id: string; payload: string; result: string } | undefined;
      if (existing) {
        if (existing.player_id !== playerId || existing.payload !== JSON.stringify(command.payload)) throw new Error('action ID conflict');
        return JSON.parse(existing.result) as unknown;
      }
      const result = { accepted: command.actionId, playerId };
      this.db.prepare('INSERT INTO receipts VALUES (?,?,?,?)').run(command.actionId, playerId, JSON.stringify(command.payload), JSON.stringify(result));
      return result;
    }).immediate();
  }
  async status() { return { finished: false }; }
  async liveConnect(matchId: string, playerId: string, epoch: string) {
    if (this.connectGate) await this.connectGate();
    this.epochs.set(playerId, epoch);
    return this.liveSnapshot(matchId, playerId, epoch);
  }
  liveInput(_matchId: string, playerId: string, input: RealtimeInput) {
    if (this.epochs.get(playerId) !== input.epoch) throw new Error('stale epoch');
    this.inputs.push({ playerId, input });
  }
  async liveSnapshot(matchId: string, playerId: string, epoch: string): Promise<RealtimeSnapshot> {
    if (this.epochs.get(playerId) !== epoch) throw new Error('stale epoch');
    this.snapshots++;
    const lastAcceptedSeq = this.inputs.filter(v => v.playerId === playerId && v.input.epoch === epoch).at(-1)?.input.seq ?? -1;
    return { tick: ++this.tick, serverTime: Date.now(), lastAcceptedSeq, view: await this.viewForPlayer(matchId, playerId) };
  }
  liveDisconnect(_matchId: string, playerId: string, epoch: string) {
    this.disconnects.push({ playerId, epoch });
    if (this.epochs.get(playerId) === epoch) this.epochs.delete(playerId);
  }
}
type Server = ReturnType<typeof createPlatformHttpServer>;
interface Fixture {
  directory: string; platform: PlatformService; runtime: FixtureRuntime; server: Server; endpoint: string;
  players: { playerId: string; token: string }[];
  roomId: string; matchId: string; sockets: WebSocket[];
}
const fixtures: Fixture[] = [];
async function fixture(): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'iva-live-'));
  const runtime = new FixtureRuntime(join(directory, 'fixture.sqlite'));
  const registration: GameRegistration = { gameId: 'live-fixture', title: 'Live fixture', minPlayers: 2, maxPlayers: 6, supportsBots: true,
    rulesVersion: 'fixture@1', contentVersion: 'fixture-content@1', status: 'available', runtime };
  const mailbox = new MemoryMailbox();
  const platform = new PlatformService({ databasePath: join(directory, 'platform.sqlite'), publicOrigin: ORIGIN, mail: mailbox, games: [registration] });
  await platform.ready;
  const players = [];
  for (const name of ['alice', 'bob', 'outsider']) {
    const result = await platform.register({ email: `${name}@example.test`, password: 'Testing a long password 854', handle: name, displayName: name });
    const mail = mailbox.messages.find(value => value.to === `${name}@example.test` && value.kind === 'verification')!;
    platform.verifyEmail(new URL(mail.text.match(/https?:\/\/\S+/)![0]).searchParams.get('token'));
    players.push({ playerId: result.user.playerId, token: result.token });
  }
  const [alice, bob] = players;
  const friend = platform.requestFriend(alice.playerId, bob.playerId);
  platform.respondFriend(bob.playerId, friend.requestId, 'accept');
  let room = platform.createRoom(alice.playerId, { gameId: 'live-fixture', capacity: 2 });
  const invitation = platform.invite(alice.playerId, room.roomId, bob.playerId);
  platform.acceptInvitation(bob.playerId, invitation.invitationId);
  room = platform.joinRoom(bob.playerId, room.roomId);
  platform.setReady(alice.playerId, room.roomId, { ready: true, expectedRevision: room.revision });
  platform.setReady(bob.playerId, room.roomId, { ready: true, expectedRevision: room.revision });
  platform.startRoom(alice.playerId, room.roomId, { expectedRevision: room.revision });
  await platform.reconcile(); room = platform.getRoom(alice.playerId, room.roomId);
  const server = createPlatformHttpServer(platform, { publicOrigin: ORIGIN, allowedHosts: ['live.test'], secureCookies: false });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const f = { directory, platform, runtime, server, endpoint, players, roomId: room.roomId, matchId: room.matchId!, sockets: [] };
  fixtures.push(f); return f;
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of fixtures) {
    for (const ws of f.sockets) ws.terminate();
    await f.server.shutdown(); await f.platform.settle(); f.runtime.db.close(); f.platform.close();
    await rm(f.directory, { recursive: true, force: true });
  }
  fixtures.length = 0;
});
class Peer {
  frames: LiveServerFrame[] = [];
  closed: Promise<number>;
  constructor(readonly ws: WebSocket) {
    ws.on('message', data => { this.frames.push(JSON.parse(data.toString()) as LiveServerFrame); });
    this.closed = new Promise(resolve => ws.once('close', code => resolve(code)));
  }
  async frame(type: LiveServerFrame['type'], after = 0): Promise<LiveServerFrame> {
    await vi.waitFor(() => expect(this.frames.slice(after).some(frame => frame.type === type)).toBe(true), { timeout: 3000, interval: 10 });
    return this.frames.slice(after).find(frame => frame.type === type)!;
  }
  async scope(): Promise<LiveScope> {
    const { protocol, wireVersion, roomId, matchId, epoch } = await this.frame('snapshot');
    return { protocol, wireVersion, roomId, matchId, epoch };
  }
  send(frame: unknown) { this.ws.send(JSON.stringify(frame)); }
}
async function peer(f: Fixture, playerIndex = 0, headers: Record<string, string> = {}, path = `/api/platform/v1/rooms/${f.roomId}/live`) {
  const ws = new WebSocket(f.endpoint.replace('http:', 'ws:') + path, { headers: { Host: 'live.test', Origin: ORIGIN, Cookie: `iva_dev_session=${f.players[playerIndex].token}`, ...headers } });
  f.sockets.push(ws);
  const p = new Peer(ws);
  await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  return p;
}
async function denied(f: Fixture, headers: Record<string, string>, path = `/api/platform/v1/rooms/${f.roomId}/live`): Promise<number> {
  const ws = new WebSocket(f.endpoint.replace('http:', 'ws:') + path, { headers: { Host: 'live.test', Origin: ORIGIN, Cookie: `iva_dev_session=${f.players[0].token}`, ...headers } });
  f.sockets.push(ws);
  return new Promise((resolve, reject) => {
    ws.once('unexpected-response', (_request, response) => { response.resume(); resolve(response.statusCode!); ws.terminate(); });
    ws.on('error', () => {});
    ws.once('open', () => reject(new Error('Unexpected WebSocket access')));
  });
}
describe('shared realtime gateway with real HTTP, sockets and SQLite', () => {
  it('rejects missing/cross origins, duplicate cookies, outsiders, tokens in URLs and wrong hosts before upgrade', async () => {
    const f = await fixture();
    expect(await denied(f, { Origin: '' })).toBe(403);
    expect(await denied(f, { Origin: 'https://unrelated.test' })).toBe(403);
    expect(await denied(f, { Host: 'unrelated.test' })).toBe(421);
    expect(await denied(f, { Cookie: '' })).toBe(401);
    expect(await denied(f, { Cookie: `iva_dev_session=${f.players[0].token}; iva_dev_session=${f.players[0].token}` })).toBe(401);
    expect(await denied(f, { Cookie: `iva_dev_session=${f.players[2].token}` })).toBe(403);
    expect(await denied(f, {}, `/api/platform/v1/rooms/${f.roomId}/live?token=not-accepted`)).toBe(400);
    expect(f.runtime.epochs.size).toBe(0);
  });
  it('first delivers a personalized full view to two independent accounts, bounded snapshots and sequenced input', async () => {
    const f = await fixture(); const a = await peer(f), b = await peer(f, 1);
    const firstA = await a.frame('snapshot'), firstB = await b.frame('snapshot');
    expect(a.frames[0].type).toBe('snapshot'); expect(b.frames[0].type).toBe('snapshot');
    expect(firstA).toMatchObject({ protocol: LIVE_PROTOCOL, gameId: 'live-fixture', rulesVersion: 'fixture@1', contentVersion: 'fixture-content@1' });
    expect(JSON.stringify(firstA)).toContain(`only:${f.players[0].playerId}`);
    expect(JSON.stringify(firstA)).not.toContain(`only:${f.players[1].playerId}`);
    expect(JSON.stringify(firstB)).toContain(`only:${f.players[1].playerId}`);
    const scope = await a.scope();
    for (const seq of [1, 2, 2, 0, 3]) a.send({ ...scope, type: 'input', seq, payload: { throttle: 0.5 } });
    await vi.waitFor(() => expect(f.runtime.inputs.at(-1)?.input.seq).toBe(3));
    expect(f.runtime.inputs.every(v => v.playerId === f.players[0].playerId)).toBe(true);
    // A pending input may be replaced by a fresher one, never replayed twice.
    expect(f.runtime.inputs.filter(v => v.input.seq === 2).length).toBeLessThanOrEqual(1);
    const baseline = a.frames.length;
    await new Promise(resolve => setTimeout(resolve, 220));
    expect(a.frames.length - baseline).toBeGreaterThanOrEqual(2);
    expect(a.frames.length - baseline).toBeLessThanOrEqual(5);
    expect(a.frames.at(-1)).toMatchObject({ type: 'snapshot', lastAcceptedSeq: 3 });
  });
  it('supersedes a tab with a fresh epoch, ignores stale disconnect and rejects replay from the old scope', async () => {
    const f = await fixture(); const old = await peer(f); const oldScope = await old.scope();
    const current = await peer(f); const scope = await current.scope();
    expect(await old.closed).toBe(4001); expect(scope.epoch).not.toBe(oldScope.epoch);
    expect(f.runtime.epochs.get(f.players[0].playerId)).toBe(scope.epoch);
    current.send({ ...scope, type: 'input', seq: 0, payload: {} });
    await vi.waitFor(() => expect(f.runtime.inputs.at(-1)?.input.epoch).toBe(scope.epoch));
    current.send({ ...oldScope, type: 'input', seq: 100, payload: {} });
    expect(await current.frame('error')).toMatchObject({ code: 'LIVE_SCOPE_MISMATCH' });
    expect(await current.closed).toBe(4003);
    expect(f.runtime.inputs.some(v => v.input.seq === 100)).toBe(false);
  });
  it('bounds inputs to 30 per rolling second and closes binary/oversize frames', async () => {
    const f = await fixture(); const a = await peer(f); const scope = await a.scope();
    for (let seq = 0; seq < 60; seq++) a.send({ ...scope, type: 'input', seq, payload: {} });
    await vi.waitFor(() => expect(f.runtime.inputs.length).toBeGreaterThan(0));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(f.runtime.inputs.length).toBeLessThanOrEqual(30);
    expect(Math.max(...f.runtime.inputs.map(v => v.input.seq))).toBeLessThan(30);
    const accepted = f.runtime.inputs.length;
    const rejoined = await peer(f); const nextScope = await rejoined.scope();
    rejoined.send({ ...nextScope, type: 'input', seq: 100, payload: {} });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(f.runtime.inputs).toHaveLength(accepted); // reconnect cannot refill the same seat's rate window
    rejoined.ws.send(Buffer.from('binary'));
    expect(await rejoined.closed).toBe(1008);
    const b = await peer(f, 1); await b.scope();
    b.ws.send('x'.repeat(20_000)); expect(await b.closed).toBe(1009);
  });
  it('replays an acknowledged command by its SQLite receipt after reconnect and across HTTP', async () => {
    const f = await fixture(); const a = await peer(f); const scope = await a.scope();
    const action = { actionId: randomUUID(), expectedRevision: 0, payload: { move: 1 } };
    a.send({ ...scope, type: 'command', ...action });
    const receipt = await a.frame('receipt');
    expect((f.runtime.db.prepare('SELECT COUNT(*) AS n FROM receipts').get() as { n: number }).n).toBe(1);
    const b = await peer(f); const scopeB = await b.scope();
    b.send({ ...scopeB, type: 'command', ...action });
    const retried = await b.frame('receipt');
    expect(receipt.type === 'receipt' && retried.type === 'receipt' && retried.result).toEqual(receipt.type === 'receipt' && receipt.result);
    const session = f.platform.getSession(f.players[0].token)!;
    const result = await new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      const req = httpRequest(`${f.endpoint}/api/platform/v1/rooms/${f.roomId}/actions`, { method: 'POST', headers: {
        Host: 'live.test', Origin: ORIGIN, Cookie: `iva_dev_session=${f.players[0].token}`, 'X-CSRF-Token': session.csrfToken, 'Content-Type': 'application/json',
      } }, res => { const chunks: Buffer[] = []; res.on('data', chunk => chunks.push(Buffer.from(chunk))); res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) })); });
      req.on('error', reject); req.end(JSON.stringify(action));
    });
    expect(result.status).toBe(200); expect((f.runtime.db.prepare('SELECT COUNT(*) AS n FROM receipts').get() as { n: number }).n).toBe(1);
  });
  it('revokes an already open socket when its session is revoked', async () => {
    const f = await fixture(); const a = await peer(f); await a.scope();
    f.platform.revokeAllSessions(f.players[0].playerId);
    expect(await a.closed).toBe(4003);
    await vi.waitFor(() => expect(f.runtime.disconnects).toHaveLength(1));
  });
  it('coalesces snapshot backpressure while retaining a committed receipt for a retry', async () => {
    const f = await fixture(); const a = await peer(f); const scope = await a.scope();
    let congested = true;
    const original = Object.getOwnPropertyDescriptor(WebSocket.prototype, 'bufferedAmount')!.get!;
    vi.spyOn(WebSocket.prototype, 'bufferedAmount', 'get').mockImplementation(function (this: WebSocket) {
      return congested ? 200_000 : original.call(this) as number;
    });
    const before = f.runtime.snapshots;
    a.send({ ...scope, type: 'command', actionId: 'delayed-receipt', expectedRevision: 0, payload: {} });
    await vi.waitFor(() => expect((f.runtime.db.prepare('SELECT COUNT(*) AS n FROM receipts').get() as { n: number }).n).toBe(1));
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(f.runtime.snapshots - before).toBeLessThanOrEqual(1);
    expect(a.frames.some(v => v.type === 'receipt')).toBe(false);
    congested = false;
    expect(await a.frame('receipt')).toMatchObject({ actionId: 'delayed-receipt' });
    const previous = a.frames.length;
    await a.frame('snapshot', previous);
  });
  it('drains an accepted async command before graceful shutdown closes the runtime database', async () => {
    const f = await fixture(); const a = await peer(f); const scope = await a.scope();
    let release!: () => void;
    let entered = false;
    f.runtime.actionGate = () => { entered = true; return new Promise<void>(resolve => { release = resolve; }); };
    a.send({ ...scope, type: 'command', actionId: 'drain-command', expectedRevision: 0, payload: {} });
    await vi.waitFor(() => expect(entered).toBe(true));
    let closed = false;
    const drain = f.server.shutdown().then(() => { closed = true; });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(closed).toBe(false); expect(await a.closed).toBe(1012);
    release(); await drain;
    expect((f.runtime.db.prepare('SELECT COUNT(*) AS n FROM receipts').get() as { n: number }).n).toBe(1);
  });
  it('orders a slow original connect before the disconnect and replacement epoch', async () => {
    const f = await fixture();
    let release!: () => void;
    let calls = 0;
    f.runtime.connectGate = () => ++calls === 1 ? new Promise<void>(resolve => { release = resolve; }) : Promise.resolve();
    const old = await peer(f);
    await vi.waitFor(() => expect(calls).toBe(1));
    const current = await peer(f);
    expect(await old.closed).toBe(4001);
    release();
    const scope = await current.scope();
    expect(f.runtime.epochs.get(f.players[0].playerId)).toBe(scope.epoch);
    expect(f.runtime.disconnects).toHaveLength(1);
    current.send({ ...scope, type: 'input', seq: 0, payload: {} });
    await vi.waitFor(() => expect(f.runtime.inputs.at(-1)?.input.epoch).toBe(scope.epoch));
  });
  it('bounds queued commands while an earlier durable operation is in flight', async () => {
    const f = await fixture(); const a = await peer(f); const scope = await a.scope();
    let release!: () => void;
    let entered = false;
    f.runtime.actionGate = () => { if (entered) return Promise.resolve(); entered = true; return new Promise<void>(resolve => { release = resolve; }); };
    for (let i = 0; i < 10; i++) a.send({ ...scope, type: 'command', actionId: `queued-command-${i}`, expectedRevision: 0, payload: {} });
    expect(await a.frame('error')).toMatchObject({ code: 'RATE_LIMITED' });
    release();
    await vi.waitFor(() => expect((f.runtime.db.prepare('SELECT COUNT(*) AS n FROM receipts').get() as { n: number }).n).toBe(8));
  });
  it('reopens real SQLite stores and listener with the same membership, session and command receipt', async () => {
    const f = await fixture(); const a = await peer(f); const oldScope = await a.scope();
    const action = { actionId: 'surviving-command', expectedRevision: 0, payload: { load: true } };
    a.send({ ...oldScope, type: 'command', ...action }); await a.frame('receipt');
    await f.server.shutdown(); await f.platform.settle();
    const registered = f.platform.games.get('live-fixture')!;
    f.runtime.db.close(); f.platform.close();
    f.runtime = new FixtureRuntime(join(f.directory, 'fixture.sqlite'));
    f.platform = new PlatformService({ databasePath: join(f.directory, 'platform.sqlite'), publicOrigin: ORIGIN, games: [{ ...registered, runtime: f.runtime }] });
    await f.platform.ready;
    f.server = createPlatformHttpServer(f.platform, { publicOrigin: ORIGIN, allowedHosts: ['live.test'], secureCookies: false });
    await new Promise<void>(resolve => f.server.listen(0, '127.0.0.1', resolve));
    f.endpoint = `http://127.0.0.1:${(f.server.address() as AddressInfo).port}`;
    const restored = await peer(f); const newScope = await restored.scope();
    expect(newScope.matchId).toBe(oldScope.matchId); expect(newScope.epoch).not.toBe(oldScope.epoch);
    expect(await restored.frame('snapshot')).toMatchObject({ view: { playerId: f.players[0].playerId, count: 1 } });
    restored.send({ ...newScope, type: 'command', ...action }); await restored.frame('receipt');
    expect((f.runtime.db.prepare('SELECT COUNT(*) AS n FROM receipts').get() as { n: number }).n).toBe(1);
  });
});
