import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { LIVE_INPUT_HZ, LIVE_MAX_FRAME_BYTES, LIVE_PROTOCOL, LIVE_SNAPSHOT_HZ, LiveRateWindow, parseLiveClientFrame } from '@iva-games/session-kit';
import type { LiveClientFrame, LiveScope, LiveServerFrame, LiveServerScope, RealtimeInput, RealtimeSnapshot } from '@iva-games/session-kit';
import { PlatformError } from './types.js';
import type { PlatformService } from './service.js';

const MAX_BUFFERED_BYTES = 128 * 1024;
const MAX_OUTGOING_BYTES = 512 * 1024;
const MAX_RECEIPTS = 32;
const MAX_COMMANDS = 8;
const SOCKET_GRACE_MS = 250;
interface Options {
  origin: string;
  hosts: ReadonlySet<string>;
  cookieName: string;
  clientAddress(request: IncomingMessage): string;
  stopping(): boolean;
}
type Access = ReturnType<PlatformService['realtimeAccess']>;
interface Connection {
  ws: WebSocket;
  access: Access;
  token: string;
  scope: LiveServerScope;
  key: string;
  initialized: boolean;
  disconnected: boolean;
  snapshotPending: boolean;
  inputPending: boolean;
  latestInput?: RealtimeInput;
  lastSeq: number;
  lastTick: number;
  inputRate: LiveRateWindow;
  messageRate: LiveRateWindow;
  commandRate: LiveRateWindow;
  commands: Promise<void>;
  commandCount: number;
  receipts: string[];
  receiptBytes: number;
  heartbeatAt: number;
  pong: boolean;
}
function cookie(request: IncomingMessage, name: string): string | undefined {
  const matches = (request.headers.cookie ?? '').split(';').map(v => v.trim()).filter(v => v.startsWith(`${name}=`));
  return matches.length === 1 ? matches[0].slice(name.length + 1) : undefined;
}
function fail(code: string, status = 400): never { throw new PlatformError(code, 'Не удалось подключиться к игре', status); }
function issue(caught: unknown): { code: string; message: string; status: number } {
  if (caught instanceof PlatformError) return { code: caught.code, message: caught.message, status: caught.status };
  if (caught && typeof caught === 'object' && 'code' in caught && 'statusCode' in caught && typeof caught.code === 'string' && typeof caught.statusCode === 'number') {
    return { code: caught.code, message: 'Действие не выполнено. Проверьте состояние игры', status: caught.statusCode };
  }
  const code = caught instanceof Error && ['INVALID_FRAME', 'LIVE_SCOPE_MISMATCH'].includes(caught.message) ? caught.message : 'LIVE_FAILED';
  return { code, message: 'Соединение прервано. Подключитесь снова', status: 400 };
}
function deny(socket: Duplex, error: ReturnType<typeof issue>): void {
  if (socket.destroyed) return;
  const status = error.status >= 400 && error.status <= 599 ? error.status : 400;
  const body = JSON.stringify({ error: { code: error.code, message: error.message } });
  socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

/** One shared authenticated transport. It never knows driving, cargo, physics,
 * bot policies or a game's view format. HTTP room/actions remain unchanged. */
export function attachPlatformRealtime(server: Server, service: PlatformService, options: Options) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: LIVE_MAX_FRAME_BYTES, perMessageDeflate: false, clientTracking: true });
  const owners = new Map<string, Connection>();
  const seatInputRates = new Map<string, { window: LiveRateWindow; seen: number }>();
  const connections = new Set<Connection>();
  const work = new Set<Promise<unknown>>();
  const controlWork = new Map<string, Promise<void>>();
  let stopping = false;
  let completion: Promise<void> | undefined;
  function track<T>(promise: Promise<T>): Promise<T> {
    work.add(promise);
    void promise.then(() => work.delete(promise), () => work.delete(promise));
    return promise;
  }
  async function gameCall<T>(operation: () => T | Promise<T>): Promise<T> {
    const promise = track(Promise.resolve().then(operation));
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([promise, new Promise<T>((_resolve, reject) => {
        deadline = setTimeout(() => reject(new PlatformError('GAME_TIMEOUT', 'Игра не отвечает. Подключитесь снова', 503)), 3000);
      })]);
    } finally { clearTimeout(deadline); }
  }
  function control<T>(c: Connection, operation: () => T | Promise<T>): Promise<T> {
    // Await the actual hook, not its response deadline. A slow initial connect
    // must finish before its disconnect and a newer connect can take control.
    const task = track((controlWork.get(c.key) ?? Promise.resolve()).then(operation));
    const settled = task.then(() => {}, () => {});
    controlWork.set(c.key, settled);
    void settled.then(() => { if (controlWork.get(c.key) === settled) controlWork.delete(c.key); });
    return task;
  }
  function active(c: Connection): boolean { return !stopping && !options.stopping() && !c.disconnected && owners.get(c.key) === c && c.ws.readyState === WebSocket.OPEN; }
  function authorize(c: Connection, touch = false): void {
    if (!active(c)) fail('LIVE_SUPERSEDED', 409);
    const current = service.realtimeAccess(c.token, c.scope.roomId, touch);
    if (current.matchId !== c.scope.matchId || current.playerId !== c.access.playerId || current.runtime !== c.access.runtime) fail('LIVE_SCOPE_MISMATCH', 409);
  }
  function send(c: Connection, frame: LiveServerFrame, reliable = false): void {
    if (!active(c)) return;
    const body = JSON.stringify(frame);
    if (Buffer.byteLength(body) > MAX_OUTGOING_BYTES) { c.ws.close(1011, 'Snapshot exceeds limit'); return; }
    if (reliable && (c.receipts.length || c.ws.bufferedAmount > MAX_BUFFERED_BYTES)) {
      if (c.receipts.length >= MAX_RECEIPTS || c.receiptBytes + Buffer.byteLength(body) > MAX_OUTGOING_BYTES) { c.ws.close(1013, 'Reconnect and retry command IDs'); return; }
      c.receipts.push(body); c.receiptBytes += Buffer.byteLength(body); return;
    }
    // A skipped snapshot is not queued. The next tick obtains a fresh view.
    if (c.ws.bufferedAmount > MAX_BUFFERED_BYTES || c.receipts.length) return;
    c.ws.send(body, error => { if (error) c.ws.terminate(); });
  }
  function sendError(c: Connection, caught: unknown, actionId?: string): void {
    const error = issue(caught);
    send(c, { ...c.scope, type: 'error', code: error.code, message: error.message, ...(actionId ? { actionId } : {}) }, true);
    if ([401, 403, 404].includes(error.status) || ['LIVE_SCOPE_MISMATCH', 'GAME_TIMEOUT'].includes(error.code)) c.ws.close(4003, 'Reconnect required');
  }
  function snapshot(c: Connection, value: RealtimeSnapshot): void {
    if (!active(c)) return;
    authorize(c);
    if (!Number.isSafeInteger(value.tick) || value.tick < 0 || !Number.isFinite(value.serverTime) || !Number.isSafeInteger(value.lastAcceptedSeq) || value.lastAcceptedSeq < -1) {
      c.ws.close(1011, 'Invalid runtime snapshot'); return;
    }
    c.lastTick = value.tick;
    send(c, { ...c.scope, type: 'snapshot', ...value });
  }
  function disconnect(c: Connection): void {
    if (c.disconnected) return;
    c.disconnected = true; c.latestInput = undefined; c.receipts.length = 0; c.receiptBytes = 0;
    connections.delete(c);
    if (owners.get(c.key) === c) owners.delete(c.key);
    // The old epoch is deliberately passed even after a successor connected.
    void gameCall(() => control(c, () => c.access.runtime.liveDisconnect(c.scope.matchId, c.access.playerId, c.scope.epoch))).catch(() => {});
  }
  async function pumpInput(c: Connection): Promise<void> {
    if (c.inputPending) return;
    c.inputPending = true;
    try {
      while (active(c) && c.latestInput) {
        const input = c.latestInput; c.latestInput = undefined;
        authorize(c);
        await gameCall(() => c.access.runtime.liveInput(c.scope.matchId, c.access.playerId, input));
      }
    } catch (error) { sendError(c, error); }
    finally { c.inputPending = false; }
  }
  function command(c: Connection, frame: Extract<LiveClientFrame, { type: 'command' }>): void {
    if (!c.commandRate.take(performance.now()) || c.commandCount >= MAX_COMMANDS) { sendError(c, new PlatformError('RATE_LIMITED', 'Подождите немного и повторите действие', 429), frame.actionId); return; }
    c.commandCount++;
    c.commands = track(c.commands.then(async () => {
      if (!active(c)) return;
      authorize(c);
      // applyAction is the exact same durable, idempotent game command entry
      // as HTTP. Do not fabricate receipts or acknowledge before persistence.
      const result = await gameCall(() => c.access.runtime.applyAction(c.scope.matchId, c.access.playerId, {
        actionId: frame.actionId, expectedRevision: frame.expectedRevision, payload: frame.payload,
      }));
      if (active(c)) authorize(c);
      send(c, { ...c.scope, type: 'receipt', actionId: frame.actionId, tick: c.lastTick, result }, true);
    }).catch(error => { sendError(c, error, frame.actionId); }).finally(() => { c.commandCount--; }));
  }
  function receive(c: Connection, data: Buffer | ArrayBuffer | Buffer[], binary: boolean): void {
    if (!active(c)) return;
    try {
      if (!c.initialized || binary || !c.messageRate.take(performance.now())) { c.ws.close(1008, 'Invalid or excessive frames'); return; }
      const text = Buffer.isBuffer(data) ? data.toString('utf8') : Array.isArray(data) ? Buffer.concat(data).toString('utf8') : Buffer.from(data).toString('utf8');
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { throw new Error('INVALID_FRAME'); }
      const { protocol, wireVersion, roomId, matchId, epoch } = c.scope;
      const scope: LiveScope = { protocol, wireVersion, roomId, matchId, epoch };
      const frame = parseLiveClientFrame(parsed, scope);
      authorize(c);
      if (frame.type === 'command') { command(c, frame); return; }
      if (frame.seq <= c.lastSeq) return;
      if (!c.inputRate.take(performance.now())) return;
      const seatRate = seatInputRates.get(c.key);
      if (seatRate) seatRate.seen = performance.now();
      c.lastSeq = frame.seq;
      c.latestInput = { epoch, seq: frame.seq, payload: frame.payload };
      void pumpInput(c);
    } catch (error) { sendError(c, error); }
  }
  function connect(ws: WebSocket, access: Access, token: string, roomId: string): void {
    const key = `${access.matchId}:${access.playerId}`;
    const old = owners.get(key);
    let seatRate = seatInputRates.get(key);
    if (!seatRate) { seatRate = { window: new LiveRateWindow(LIVE_INPUT_HZ), seen: performance.now() }; seatInputRates.set(key, seatRate); }
    const c: Connection = {
      ws, access, token, key,
      scope: { protocol: LIVE_PROTOCOL, wireVersion: access.runtime.wireVersion, roomId, matchId: access.matchId,
        gameId: access.gameId, rulesVersion: access.rulesVersion, contentVersion: access.contentVersion, epoch: randomUUID() },
      initialized: false, disconnected: false, snapshotPending: false, inputPending: false,
      lastSeq: -1, lastTick: 0, inputRate: seatRate.window, messageRate: new LiveRateWindow(90), commandRate: new LiveRateWindow(12),
      commands: Promise.resolve(), commandCount: 0, receipts: [], receiptBytes: 0, heartbeatAt: performance.now(), pong: true,
    };
    owners.set(key, c); connections.add(c);
    if (old) { old.ws.close(4001, 'Control moved to another connection'); disconnect(old); }
    ws.on('error', () => { ws.terminate(); });
    ws.on('close', () => disconnect(c));
    ws.on('pong', () => { c.pong = true; });
    ws.on('message', (data, binary) => receive(c, data, binary));
    void track((async () => {
      try {
        const initial = await gameCall(() => control(c, () => access.runtime.liveConnect(access.matchId, access.playerId, c.scope.epoch)));
        if (!active(c)) return;
        authorize(c); c.initialized = true;
        snapshot(c, initial);
      } catch (error) { sendError(c, error); ws.close(1011, 'Unable to join live match'); }
    })());
  }
  const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    socket.on('error', () => socket.destroy());
    void track((async () => {
      try {
        if (stopping || options.stopping()) fail('SERVER_RESTARTING', 503);
        if (connections.size >= 512) fail('LIVE_BUSY', 503);
        if (request.method !== 'GET') fail('METHOD_NOT_ALLOWED', 405);
        if (!request.headers.host || !options.hosts.has(request.headers.host)) fail('HOST_NOT_ALLOWED', 421);
        // Realtime is intentionally same-origin even if development HTTP CORS
        // permits another origin. Missing/null origins cannot authenticate.
        if (request.headers.origin !== options.origin) fail('ORIGIN_NOT_ALLOWED', 403);
        if (!request.url?.startsWith('/') || request.url.startsWith('//')) fail('INVALID_URL');
        const url = new URL(request.url, options.origin);
        if (url.search || url.hash) fail('INVALID_URL');
        const match = /^\/api\/platform\/v1\/rooms\/([\w-]{1,100})\/live$/.exec(url.pathname);
        if (!match) fail('NOT_FOUND', 404);
        service.rateLimit(`live-connect-ip:${options.clientAddress(request)}`, 120);
        const token = cookie(request, options.cookieName);
        await service.ready;
        if (stopping || options.stopping() || socket.destroyed) return deny(socket, { code: 'SERVER_RESTARTING', status: 503, message: 'Обновляем игру. Подключитесь снова' });
        const access = service.realtimeAccess(token, match[1], true);
        service.rateLimit(`live-connect:${access.playerId}`, 30);
        wss.handleUpgrade(request, socket, head, ws => connect(ws, access, token!, match[1]));
      } catch (error) { deny(socket, issue(error)); }
    })());
  };
  server.on('upgrade', upgrade);
  const timer = setInterval(() => {
    for (const [key, rate] of seatInputRates) if (!owners.has(key) && rate.seen < performance.now() - 60_000) seatInputRates.delete(key);
    for (const c of connections) {
      if (!active(c) || !c.initialized) continue;
      try { authorize(c); } catch (error) { sendError(c, error); continue; }
      if (c.ws.bufferedAmount <= MAX_BUFFERED_BYTES) {
        while (c.receipts.length && c.ws.bufferedAmount <= MAX_BUFFERED_BYTES) {
          const receipt = c.receipts.shift()!; c.receiptBytes -= Buffer.byteLength(receipt);
          c.ws.send(receipt, error => { if (error) c.ws.terminate(); });
        }
      }
      if (performance.now() - c.heartbeatAt >= 15_000) {
        if (!c.pong) { c.ws.terminate(); continue; }
        c.pong = false; c.heartbeatAt = performance.now(); c.ws.ping();
        try { authorize(c, true); } catch (error) { sendError(c, error); continue; }
      }
      if (c.snapshotPending || c.ws.bufferedAmount > MAX_BUFFERED_BYTES || c.receipts.length) continue;
      c.snapshotPending = true;
      void track((async () => {
        try {
          authorize(c);
          const view = await gameCall(() => c.access.runtime.liveSnapshot(c.scope.matchId, c.access.playerId, c.scope.epoch));
          snapshot(c, view);
        } catch (error) { sendError(c, error); }
        finally { c.snapshotPending = false; }
      })());
    }
  }, Math.ceil(1000 / LIVE_SNAPSHOT_HZ));
  timer.unref();
  function close(): Promise<void> {
    if (completion) return completion;
    stopping = true; clearInterval(timer); seatInputRates.clear();
    for (const c of connections) { c.ws.close(1012, 'Server restarting'); disconnect(c); }
    const terminated = setTimeout(() => { for (const ws of wss.clients) ws.terminate(); }, SOCKET_GRACE_MS);
    completion = (async () => {
      await new Promise<void>(resolve => wss.close(() => resolve()));
      clearTimeout(terminated);
      while (work.size) await Promise.allSettled([...work]);
    })();
    return completion;
  }
  server.once('close', () => { void close(); });
  return { close };
}
