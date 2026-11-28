import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { request as httpRequest } from 'node:http';
import { WebSocket } from 'ws';
import { LIVE_PROTOCOL } from '@iva-games/session-kit';
import type { LiveScope, LiveServerScope } from '@iva-games/session-kit';
import type { Receipt, ShiftView } from '@iva-games/shift/core';
import { createShiftRegistration } from '@iva-games/shift/runtime';
import { PlatformService } from '../src/service';
import { MemoryMailbox } from '../src/mail';
import { createPlatformHttpServer } from '../src/http';
import type { Room } from '../src/types';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { try { for (const close of cleanup.splice(0)) await close(); } finally { vi.useRealTimers(); } });
type Frame = LiveServerScope & { type: string; view?: ShiftView; actionId?: string; code?: string; tick?: number; serverTime?: number; lastAcceptedSeq?: number; result?: Receipt };
function scope(frame: Frame): LiveScope {
  const { protocol, wireVersion, roomId, matchId, epoch } = frame;
  return { protocol, wireVersion, roomId, matchId, epoch };
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'iva-shift-live-'));
  const shift = createShiftRegistration({ databasePath: join(directory, 'runtime.sqlite'), autoTick: false });
  const mail = new MemoryMailbox();
  const platform = new PlatformService({ databasePath: join(directory, 'platform.sqlite'), publicOrigin: 'http://shift.test', mail, games: [shift] });
  await platform.ready;
  const server = createPlatformHttpServer(platform, { publicOrigin: 'http://shift.test', allowedHosts: ['shift.test'], secureCookies: false });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const sockets: WebSocket[] = [];
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    for (const socket of sockets) socket.terminate();
    await server.shutdown(); await platform.settle(); shift.close(); platform.close();
    await rm(directory, { recursive: true, force: true });
  };
  cleanup.push(stop);
  async function signup(handle: string) {
    const created = await platform.register({ email: handle + '@example.test', handle, displayName: handle, password: 'Long isolated testing password 304' });
    const message = mail.messages.find(item => item.to === handle + '@example.test')!;
    platform.verifyEmail(new URL(message.text.match(/https?:\/\/\S+/)![0]).searchParams.get('token'));
    return { id: created.user.playerId, token: created.token, session: created.session };
  }
  type Player = Awaited<ReturnType<typeof signup>>;
  function connect(player: Player, room: Room, headers: Record<string, string> = {}, suffix = '') {
    const frames: Frame[] = [];
    const socket = new WebSocket(`${base}/api/platform/v1/rooms/${room.roomId}/live${suffix}`, { headers: {
      Host: 'shift.test', Origin: 'http://shift.test', Cookie: `iva_dev_session=${player.token}`, ...headers,
    } });
    sockets.push(socket);
    socket.on('message', data => { frames.push(JSON.parse(data.toString()) as Frame); });
    // Authentication rejection is inspected through unexpected-response below.
    socket.on('error', () => {});
    const wait = (predicate: (frame: Frame) => boolean, start = 0): Promise<Frame> => new Promise((resolve, reject) => {
      const poll = setInterval(() => { const match = frames.slice(start).find(predicate); if (match) { clearInterval(poll); clearTimeout(deadline); resolve(match); } }, 5);
      const deadline = setTimeout(() => { clearInterval(poll); reject(new Error('Live frame not received: ' + JSON.stringify(frames.map(f => f.type)))); }, 3000);
    });
    return { socket, frames, wait };
  }
  async function post(player: Player, roomId: string, action: string, body: unknown) {
    return new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      const request = httpRequest({ hostname: '127.0.0.1', port: (server.address() as AddressInfo).port,
        path: `/api/platform/v1/rooms/${roomId}/${action}`, method: 'POST', headers: {
          Host: 'shift.test', Origin: 'http://shift.test', Cookie: `iva_dev_session=${player.token}`,
          'Content-Type': 'application/json', 'X-CSRF-Token': player.session.csrfToken, 'Idempotency-Key': `http-${action}-fixture`,
        },
      }, response => {
        let raw = ''; response.setEncoding('utf8'); response.on('data', chunk => { raw += String(chunk); });
        response.on('end', () => { try { resolve({ status: response.statusCode!, body: JSON.parse(raw) }); } catch (error) { reject(error); } });
      });
      request.on('error', reject); request.end(JSON.stringify(body));
    });
  }
  async function get<T>(player: Player, path: string): Promise<{ status: number; body: T }> {
    return new Promise((resolve, reject) => {
      const request = httpRequest({ hostname: '127.0.0.1', port: (server.address() as AddressInfo).port,
        path: `/api/platform/v1${path}`, headers: { Host: 'shift.test', Cookie: `iva_dev_session=${player.token}` },
      }, response => {
        let raw = ''; response.setEncoding('utf8'); response.on('data', chunk => { raw += String(chunk); });
        response.on('end', () => { try { resolve({ status: response.statusCode!, body: JSON.parse(raw) as T }); } catch (error) { reject(error); } });
      });
      request.on('error', reject); request.end();
    });
  }
  async function room(host: Player, other: Player, size: 2 | 3 = 2, humanPilots = false) {
    const friends = platform.requestFriend(host.id, other.id); platform.respondFriend(other.id, friends.requestId, 'accept');
    let room = platform.createRoom(host.id, { gameId: 'shift', capacity: size * 2, settings: { teamSize: size } });
    const invitation = platform.invite(host.id, room.roomId, other.id);
    platform.acceptInvitation(other.id, invitation.invitationId); room = platform.joinRoom(other.id, room.roomId);
    while (room.members.length < room.capacity) room = platform.addBot(host.id, room.roomId, { expectedRevision: room.revision, difficulty: 'normal' });
    const teams = Object.fromEntries(room.members.map((p, index) => [p.participantId, index % 2 ? 'amber' : 'teal']));
    room = platform.changeSettings(host.id, room.roomId, { expectedRevision: room.revision, settings: {
      arena: 'foundry', teamSize: size, rotateRoles: false, difficulty: 'normal', teams,
      initialNavigators: { teal: room.members[humanPilots ? 2 : 0].participantId, amber: room.members[humanPilots ? 3 : 1].participantId },
    } });
    platform.setReady(host.id, room.roomId, { expectedRevision: room.revision, ready: true });
    platform.setReady(other.id, room.roomId, { expectedRevision: room.revision, ready: true });
    platform.startRoom(host.id, room.roomId, { expectedRevision: room.revision }); await platform.reconcile();
    return platform.getRoom(host.id, room.roomId);
  }
  return { platform, shift, server, stop, signup, connect, room, post, get };
}

describe('shared authenticated live gateway with Shift', () => {
  it.each([2, 3] as const)('opens independent views with %i players per team and settles same-tick competing room commands once', async size => {
    const f = await fixture(), a = await f.signup('live_a'), b = await f.signup('live_b');
    const room = await f.room(a, b, size);
    expect(room.state).toBe('playing');
    const first = f.connect(a, room), second = f.connect(b, room);
    const [fa, fb] = await Promise.all([first.wait(frame => frame.type === 'snapshot'), second.wait(frame => frame.type === 'snapshot')]);
    for (const frame of [fa, fb]) {
      expect(frame).toMatchObject({ protocol: LIVE_PROTOCOL, wireVersion: 'shift-wire@1', roomId: room.roomId, matchId: room.matchId,
        gameId: 'shift', rulesVersion: room.rulesVersion, contentVersion: room.contentVersion, lastAcceptedSeq: -1 });
      expect(frame.epoch).toEqual(expect.any(String)); expect(frame.serverTime).toEqual(expect.any(Number));
      expect(frame).not.toHaveProperty('controllerEpoch'); expect(frame).not.toHaveProperty('version');
    }
    expect(fa.view!.self.team).toBe('teal'); expect(fb.view!.self.team).toBe('amber');
    expect(fa.view!.actors.every(actor => actor.team === 'teal')).toBe(true);
    expect(fb.view!.actors.every(actor => actor.team === 'amber')).toBe(true);
    expect(JSON.stringify(fa)).not.toContain(b.token);
    expect(JSON.stringify(fa)).not.toContain(b.id);
    f.shift.runtime.advanceTicks(211);
    const active = await f.platform.matchView(a.id, room.roomId) as ShiftView;
    first.socket.send(JSON.stringify({ ...scope(fa), type: 'command', actionId: 'live-shift-teal', expectedRevision: active.boardRevision, payload: {
      type: 'shift', roundId: active.round, controllerEpoch: fa.view!.self.controllerEpoch, roomId: 'O', expectedBoardRevision: active.boardRevision,
    } }));
    second.socket.send(JSON.stringify({ ...scope(fb), type: 'command', actionId: 'live-shift-amber', expectedRevision: active.boardRevision, payload: {
      type: 'shift', roundId: active.round, controllerEpoch: fb.view!.self.controllerEpoch, roomId: 'F', expectedBoardRevision: active.boardRevision,
    } }));
    // Both socket callbacks enqueue before the explicit authoritative tick.
    await new Promise(resolve => setTimeout(resolve, 25)); f.shift.runtime.advanceTicks();
    const receipts = await Promise.all([first.wait(frame => frame.actionId === 'live-shift-teal'), second.wait(frame => frame.actionId === 'live-shift-amber')]);
    expect(receipts.filter(frame => frame.result?.accepted)).toHaveLength(1);
    expect(receipts[0].result?.accepted).toBe(true);
    const one = await f.platform.matchView(a.id, room.roomId) as ShiftView;
    const two = await f.platform.matchView(b.id, room.roomId) as ShiftView;
    expect(one.motion).toEqual(two.motion);
  });

  it('stops shared snapshot scheduling and drains hooks before the platform databases close', async () => {
    // Real sockets and databases; only interval dispatch is controlled so a
    // queued snapshot cannot hide behind a lucky close-event ordering.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const f = await fixture(), a = await f.signup('shutdown_a'), b = await f.signup('shutdown_b');
    const room = await f.room(a, b, 3);
    const first = f.connect(a, room), second = f.connect(b, room);
    await Promise.all([first, second].map(client => new Promise<void>(resolve => client.socket.once('message', () => resolve()))));
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    const sessionReads = vi.spyOn(f.platform, 'getSession');
    const shutdown = f.server.shutdown();
    // This happens before asynchronous WS close events get a turn.
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(1000);
    expect(sessionReads).not.toHaveBeenCalled();
    await shutdown; await f.stop();
    expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
    expect(sessionReads).not.toHaveBeenCalled();
  });

  it('rejects foreign origins, missing sessions, non-members and query credentials before upgrade', async () => {
    const f = await fixture(), a = await f.signup('auth_a'), b = await f.signup('auth_b'), outside = await f.signup('auth_out');
    const room = await f.room(a, b);
    for (const [player, headers, suffix] of [
      [a, { Origin: 'http://foreign.test' }, ''],
      [a, { Cookie: '' }, ''],
      [outside, {}, ''],
      [a, {}, '?matchId=another-match'],
      [a, {}, '?version=shift-wire%401'],
    ] as const) {
      const client = f.connect(player, room, headers, suffix);
      const status = await new Promise<number>(resolve => client.socket.once('unexpected-response', (_req, response) => { response.resume(); resolve(response.statusCode!); client.socket.terminate(); }));
      expect(status).toBeGreaterThanOrEqual(400);
    }
  });

  it('rejects a forged match, transport epoch or game wire version on an authenticated channel', async () => {
    const f = await fixture(), a = await f.signup('scope_a'), b = await f.signup('scope_b'), room = await f.room(a, b);
    for (const change of [{ matchId: 'another-match' }, { epoch: 'unowned-epoch' }, { wireVersion: 'shift-wire@2' }]) {
      const client = f.connect(a, room), initial = await client.wait(frame => frame.type === 'snapshot');
      const closed = new Promise<number>(resolve => client.socket.once('close', resolve));
      client.socket.send(JSON.stringify({ ...scope(initial), ...change, type: 'input', seq: 1, payload: {} }));
      expect((await client.wait(frame => frame.type === 'error')).code).toBe('LIVE_SCOPE_MISMATCH');
      expect(await closed).toBe(4003);
    }
  });

  it('does not acquire a controller when a WebSocket handshake field is rejected', async () => {
    const f = await fixture(), a = await f.signup('handshake_a'), b = await f.signup('handshake_b');
    const room = await f.room(a, b);
    const rejected = f.connect(a, room, { 'Sec-WebSocket-Protocol': ',' });
    const status = await new Promise<number>(resolve => rejected.socket.once('unexpected-response', (_request, response) => {
      response.resume(); resolve(response.statusCode!); rejected.socket.terminate();
    }));
    expect(status).toBe(400);
    await vi.waitFor(async () => {
      const view = await f.platform.matchView(a.id, room.roomId) as ShiftView;
      expect(view.self.connected).toBe(false);
    });
  });

  it('takes over one seat with a new epoch and closes a revoked session', async () => {
    const f = await fixture(), a = await f.signup('epoch_a'), b = await f.signup('epoch_b'), room = await f.room(a, b);
    const first = f.connect(a, room), initial = await first.wait(frame => frame.type === 'snapshot');
    const oldClosed = new Promise<number>(resolve => first.socket.once('close', resolve));
    const second = f.connect(a, room), replacement = await second.wait(frame => frame.type === 'snapshot');
    expect(replacement.epoch).not.toBe(initial.epoch);
    expect(replacement.view!.self.controllerEpoch).toBeGreaterThan(initial.view!.self.controllerEpoch);
    expect(await oldClosed).toBe(4001);
    const revoked = new Promise<number>(resolve => second.socket.once('close', resolve));
    f.platform.revokeSession(a.session.sessionHash);
    expect(await revoked).toBe(4003);
  });

  it('keeps final filtered views on the shared channel and still enforces takeover and revocation', async () => {
    const f = await fixture(), a = await f.signup('final_a'), b = await f.signup('final_b');
    const room = await f.room(a, b);
    const snapshots = vi.spyOn(f.shift.runtime, 'liveSnapshot');
    const first = f.connect(a, room); await first.wait(frame => frame.type === 'snapshot');
    // A normal match completes through fixed steps and public-view substitute bots.
    f.shift.runtime.advanceTicks(16_000);
    const final = await first.wait(frame => frame.type === 'snapshot' && frame.view?.phase === 'finished');
    expect(final).not.toHaveProperty('finished'); // The published contract has no transport terminal hint.
    const callsAtFinal = snapshots.mock.calls.length, auth = vi.spyOn(f.platform, 'getSession');
    await new Promise(resolve => setTimeout(resolve, 250));
    const repeats = first.frames.filter(frame => frame.type === 'snapshot' && frame.view?.phase === 'finished');
    expect(repeats.length).toBeGreaterThan(1);
    expect(repeats.every(frame => JSON.stringify(frame.view) === JSON.stringify(final.view))).toBe(true);
    expect(snapshots.mock.calls.length).toBeGreaterThan(callsAtFinal);
    expect(auth).toHaveBeenCalled();
    const oldClosed = new Promise<number>(resolve => first.socket.once('close', resolve));
    const second = f.connect(a, room), replacement = await second.wait(frame => frame.type === 'snapshot');
    expect(replacement.view?.phase).toBe('finished');
    expect(replacement.epoch).not.toBe(final.epoch);
    expect(replacement.view!.self.controllerEpoch).toBeGreaterThan(final.view!.self.controllerEpoch);
    expect(await oldClosed).toBe(4001);
    const revoked = new Promise<number>(resolve => second.socket.once('close', resolve));
    f.platform.revokeSession(a.session.sessionHash);
    expect(await revoked).toBe(4003);
  }, 30_000);

  it('acknowledges consumed pilot input and preserves the shared rolling rate limit across reconnects', async () => {
    const f = await fixture(), a = await f.signup('jitter_a'), b = await f.signup('jitter_b'), room = await f.room(a, b, 2, true);
    const client = f.connect(a, room), first = await client.wait(frame => frame.type === 'snapshot');
    expect(first.view!.self.role).toBe('pilot');
    f.shift.runtime.advanceTicks(211);
    const input = vi.spyOn(f.shift.runtime, 'liveInput');
    const send = (socket: WebSocket, snapshot: Frame, seq: number) => socket.send(JSON.stringify({ ...scope(snapshot), type: 'input', seq, payload: {
      type: 'input', roundId: snapshot.view!.round, controllerEpoch: snapshot.view!.self.controllerEpoch, seq, moveX: 0, moveZ: 0, aim: 0, fireHeld: false,
    } }));
    for (let seq = 1; seq <= 40; seq++) send(client.socket, first, seq);
    await vi.waitFor(() => expect(input.mock.calls.some(call => call[2].seq === 30)).toBe(true));
    expect(input.mock.calls.every(call => call[2].seq <= 30)).toBe(true);
    expect((await f.platform.matchView(a.id, room.roomId) as ShiftView).self.lastAcceptedSeq).toBe(-1);
    f.shift.runtime.advanceTicks();
    expect((await client.wait(frame => frame.type === 'snapshot' && frame.lastAcceptedSeq === 30)).view!.self.lastAcceptedSeq).toBe(30);
    expect(client.socket.readyState).toBe(WebSocket.OPEN);
    const next = f.connect(a, room), replacement = await next.wait(frame => frame.type === 'snapshot');
    expect(replacement.lastAcceptedSeq).toBe(-1); expect(replacement.epoch).not.toBe(first.epoch);
    const calls = input.mock.calls.length;
    send(next.socket, replacement, 0);
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(input.mock.calls).toHaveLength(calls); // Reconnect grants no fresh input quota.
    f.shift.runtime.advanceTicks();
    expect((await f.platform.matchView(a.id, room.roomId) as ShiftView).self.lastAcceptedSeq).toBe(-1);
    await new Promise(resolve => setTimeout(resolve, 1000));
    send(next.socket, replacement, 1);
    await vi.waitFor(() => expect(input.mock.calls.length).toBeGreaterThan(calls));
    f.shift.runtime.advanceTicks();
    await next.wait(frame => frame.type === 'snapshot' && frame.lastAcceptedSeq === 1);
    expect([...client.frames, ...next.frames].filter(frame => frame.type === 'error')).toEqual([]);
  });

  it('replays one committed shift through HTTP and a new shared epoch without repeating its effect', async () => {
    const f = await fixture(), a = await f.signup('replay_a'), b = await f.signup('replay_b'), room = await f.room(a, b);
    const client = f.connect(a, room), first = await client.wait(frame => frame.type === 'snapshot');
    f.shift.runtime.advanceTicks(211);
    const view = await f.platform.matchView(a.id, room.roomId) as ShiftView;
    const command = { actionId: 'http-ws-replay-shift', expectedRevision: view.boardRevision, payload: {
      type: 'shift', roundId: view.round, controllerEpoch: first.view!.self.controllerEpoch, roomId: 'O', expectedBoardRevision: view.boardRevision,
    } };
    const apply = vi.spyOn(f.shift.runtime, 'applyAction');
    client.socket.send(JSON.stringify({ ...scope(first), type: 'command', ...command }));
    await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
    f.shift.runtime.advanceTicks();
    const committed = await client.wait(frame => frame.type === 'receipt' && frame.actionId === command.actionId);
    expect(committed.result).toMatchObject({ accepted: true, actionId: command.actionId, tick: view.tick + 1 });
    expect(committed.result).not.toHaveProperty('view');
    expect(await f.post(a, room.roomId, 'actions', command)).toEqual({ status: 200, body: { view: committed.result } });
    const next = f.connect(a, room), replacement = await next.wait(frame => frame.type === 'snapshot');
    expect(replacement.view!.motion?.roomId).toBe('O');
    expect(replacement.view!.self.controllerEpoch).not.toBe(command.payload.controllerEpoch);
    next.socket.send(JSON.stringify({ ...scope(replacement), type: 'command', ...command }));
    expect((await next.wait(frame => frame.type === 'receipt' && frame.actionId === command.actionId)).result).toEqual(committed.result);
    const afterReplay = await f.platform.matchView(a.id, room.roomId) as ShiftView;
    expect(afterReplay.tick).toBe(view.tick + 1); expect(afterReplay.motion).toEqual(replacement.view!.motion);
    expect(afterReplay.boardRevision).toBe(replacement.view!.boardRevision);
  });

  it('rejects invalid lobby capacity and resets human readiness after team changes', async () => {
    const f = await fixture(), a = await f.signup('lobby_a');
    expect(() => f.platform.createRoom(a.id, { gameId: 'shift', capacity: 5, settings: { teamSize: 2 } })).toThrow();
    let room = f.platform.createRoom(a.id, { gameId: 'shift', capacity: 4, settings: { teamSize: 2 } });
    f.platform.setReady(a.id, room.roomId, { expectedRevision: room.revision, ready: true });
    room = f.platform.changeSettings(a.id, room.roomId, { expectedRevision: room.revision, settings: { teamSize: 2, rotateRoles: false } });
    expect(room.members[0].ready).toBe(false);
    while (room.members.length < 4) room = f.platform.addBot(a.id, room.roomId, { expectedRevision: room.revision, difficulty: 'normal' });
    f.platform.setReady(a.id, room.roomId, { expectedRevision: room.revision, ready: true });
    expect(() => f.platform.startRoom(a.id, room.roomId, { expectedRevision: room.revision })).toThrow();
    expect(f.platform.getRoom(a.id, room.roomId).state).toBe('lobby');
    const removed = room.members.find(p => !p.playerId)!;
    room = f.platform.changeSettings(a.id, room.roomId, { expectedRevision: room.revision, settings: {
      ...room.settings, initialNavigators: { ...(room.settings.initialNavigators as object), teal: removed.participantId },
    } });
    room = f.platform.removeBot(a.id, room.roomId, removed.participantId, { expectedRevision: room.revision });
    room = f.platform.addBot(a.id, room.roomId, { expectedRevision: room.revision, difficulty: 'normal' });
    expect(Object.keys(room.settings.teams as object)).toEqual(expect.arrayContaining(room.members.map(p => p.participantId)));
    expect(JSON.stringify(room.settings)).not.toContain(removed.participantId);
    expect(Object.values(room.settings.teams as object).filter(team => team === 'teal')).toHaveLength(2);
  });

  it('reopens a hidden finished room, preserves direct access, and lists its new rematch result without restoring unrelated history', async () => {
    const f = await fixture(), a = await f.signup('rematch_a'), b = await f.signup('rematch_b');
    const room = await f.room(a, b);
    const client = f.connect(a, room); await client.wait(frame => frame.type === 'snapshot');
    f.shift.runtime.advanceTicks(16_000);
    const finalFrame = await client.wait(frame => frame.view?.phase === 'finished');
    // The live runtime finishes before the platform's periodic reconciliation.
    // A visible final frame alone must not imply that rematch is ready yet.
    const pending = f.platform.getRoom(a.id, room.roomId);
    expect(pending.state).toBe('playing');
    const port = (f.server.address() as AddressInfo).port;
    const premature = await new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      const request = httpRequest({ hostname: '127.0.0.1', port, path: `/api/platform/v1/rooms/${room.roomId}/rematch`,
        method: 'POST', headers: {
          Host: 'shift.test', Origin: 'http://shift.test', Cookie: `iva_dev_session=${a.token}`,
          'Content-Type': 'application/json', 'X-CSRF-Token': a.session.csrfToken, 'Idempotency-Key': 'rematch-before-reconciliation',
        },
      }, response => {
        let body = ''; response.setEncoding('utf8'); response.on('data', chunk => { body += String(chunk); });
        response.on('end', () => { try { resolve({ status: response.statusCode!, body: JSON.parse(body) }); } catch (error) { reject(error); } });
      });
      request.on('error', reject); request.end(JSON.stringify({ expectedRevision: pending.revision }));
    });
    expect(premature.status).toBe(409);
    expect(premature.body).toMatchObject({ error: { code: 'MATCH_NOT_FINISHED' } });
    expect(f.platform.getRoom(a.id, room.roomId).matchId).toBe(room.matchId);
    await f.platform.reconcile();
    const finished = f.platform.getRoom(a.id, room.roomId);
    expect(finished.state).toBe('finished');
    const unrelated = f.platform.createRoom(a.id, { gameId: 'shift', capacity: 4, settings: { teamSize: 2 } });
    f.platform.cancelRoom(a.id, unrelated.roomId);
    expect(await f.post(a, 'history', 'clear', {})).toEqual({ status: 200, body: { ok: true } });
    expect(await f.post(b, 'history', 'clear', {})).toEqual({ status: 200, body: { ok: true } });
    type RoomList = { rooms: Room[]; hiddenRoomCount: number };
    for (const [player, count] of [[a, 2], [b, 1]] as const) {
      expect(await f.get<RoomList>(player, '/rooms')).toEqual({ status: 200, body: { rooms: [], hiddenRoomCount: count } });
      const directRoom = await f.get<{ room: Room }>(player, `/rooms/${room.roomId}`);
      expect(directRoom.status).toBe(200); expect(directRoom.body.room).toEqual(finished);
      const directMatch = await f.get<{ view: ShiftView }>(player, `/rooms/${room.roomId}/match`);
      expect(directMatch.status).toBe(200); expect(directMatch.body.view.phase).toBe('finished');
      expect(directMatch.body.view.score).toEqual(finalFrame.view!.score);
    }
    // Hiding a list entry changes neither the current lease nor future admission.
    const afterClear = await client.wait(frame => frame.type === 'snapshot', client.frames.length);
    expect(afterClear.epoch).toBe(finalFrame.epoch); expect(afterClear.view!.phase).toBe('finished');
    const replaced = new Promise<number>(resolve => client.socket.once('close', resolve));
    const reconnect = f.connect(a, finished), replay = await reconnect.wait(frame => frame.type === 'snapshot');
    expect(replay.view!.phase).toBe('finished'); expect(replay.view!.score).toEqual(finalFrame.view!.score);
    expect(replay.epoch).not.toBe(finalFrame.epoch); expect(await replaced).toBe(4001);
    expect(() => f.platform.rematch(b.id, room.roomId, { expectedRevision: finished.revision })).toThrow();
    const disconnected = new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Old rematch channel stayed open: ${reconnect.frames.slice(-4).map(frame => frame.code ?? frame.type).join(',')}`)), 2000);
      reconnect.socket.once('close', code => { clearTimeout(timeout); resolve(code); });
    });
    const rematch = await f.post(a, room.roomId, 'rematch', { expectedRevision: finished.revision });
    expect(rematch.status).toBe(200);
    const again = (rematch.body as { room: Room }).room;
    expect(again.state).toBe('lobby'); expect(again.matchId).toBeNull();
    expect(again.members.map(p => p.participantId)).toEqual(room.members.map(p => p.participantId));
    expect(again.members.filter(p => p.playerId).every(p => !p.ready)).toBe(true);
    expect(await disconnected).toBe(4003);
    await expect(f.platform.matchView(a.id, room.roomId)).rejects.toMatchObject({ code: 'MATCH_NOT_STARTED' });
    for (const [player, count] of [[a, 1], [b, 0]] as const) {
      const listed = await f.get<RoomList>(player, '/rooms');
      expect(listed).toEqual({ status: 200, body: { rooms: [again], hiddenRoomCount: count } });
    }
    f.platform.setReady(a.id, again.roomId, { expectedRevision: again.revision, ready: true });
    f.platform.setReady(b.id, again.roomId, { expectedRevision: again.revision, ready: true });
    f.platform.startRoom(a.id, again.roomId, { expectedRevision: again.revision }); await f.platform.reconcile();
    const restarted = f.platform.getRoom(a.id, again.roomId);
    expect(restarted.state).toBe('playing'); expect(restarted.matchId).not.toBe(room.matchId);
    expect((await f.shift.runtime.status(room.matchId!)).finished).toBe(true);
    f.shift.runtime.advanceTicks(16_000); await f.platform.reconcile();
    const nextResult = f.platform.getRoom(a.id, room.roomId);
    expect(nextResult.state).toBe('finished'); expect(nextResult.matchId).toBe(restarted.matchId);
    const hostList = await f.get<RoomList>(a, '/rooms'), guestList = await f.get<RoomList>(b, '/rooms');
    expect({ host: hostList, guest: guestList }).toEqual({
      host: { status: 200, body: { rooms: [nextResult], hiddenRoomCount: 1 } },
      guest: { status: 200, body: { rooms: [nextResult], hiddenRoomCount: 0 } },
    });
    // The other cancelled room remains hidden and directly accessible.
    expect((await f.get<{ room: Room }>(a, `/rooms/${unrelated.roomId}`)).body.room.state).toBe('cancelled');
  }, 30_000);
});
