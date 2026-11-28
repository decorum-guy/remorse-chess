import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import type { KeyObject } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { INPUT_TIMEOUT_MS, MAX_FRAME_BYTES, REALTIME_PROTOCOL, REALTIME_SUBPROTOCOL, REALTIME_SOCKET_PATH, RateWindow, RealtimeError, exactFields, identifier, object, parseClientMessage, viewChanges } from '@iva-games/realtime-kit';
import type { ClientMessage, DeltaSnapshot, Snapshot, TicketClaims } from '@iva-games/realtime-kit';
import type { StartMatchRequest } from '@iva-games/session-kit';
import type { RuntimeClient } from './rpc.js';
import { failure } from './rpc.js';
import type { StorageClient } from './storage.js';
import { verifyBridge, verifyTicket } from './crypto.js';
import { BoundedTiming } from './metrics.js';

export interface RealtimeHttpOptions {
  runtime: RuntimeClient; storage: StorageClient; trustedKeys: Map<string, KeyObject>;
  allowedOrigins: string[]; allowedHosts: string[];
  staticDirectories?: Record<string, string>; revision?: string;
  wallNow?: () => number; monoNow?: () => number; snapshotIntervalMs?: number;
}
interface Peer {
  id: string; ws: WebSocket; claims: TicketClaims | null; snapshot: Snapshot | null;
  baselines: Map<number, Snapshot>; acknowledged: number | null; fullAt: number;
  forceFull: boolean; congestedAt: number | null; snapshotPending: boolean; closed: boolean;
  inputs: RateWindow; actions: RateWindow; control: RateWindow; acknowledgements: RateWindow; bad: number;
  queue: number[]; fullReason: FullReason; lastSnapshotAt: number | null;
  fullSizeChars: number;
  counters: ReturnType<typeof counters>;
}
const FULL_REASONS = ['initial', 'periodic', 'client-request', 'missing-baseline', 'epoch-change', 'control-change', 'backpressure', 'delta-not-smaller'] as const;
type FullReason = typeof FULL_REASONS[number];
const reasons = () => Object.fromEntries(FULL_REASONS.map(reason => [reason, 0])) as Record<FullReason, number>;
const rateKinds = (): Record<ClientMessage['type'], number> => ({ input: 0, action: 0, ackSnapshot: 0, heartbeat: 0, resync: 0, claimControl: 0 });
function counters() { return { framesReceived: 0, framesSent: 0, jsonBytesReceived: 0, jsonBytesSent: 0,
  fullSnapshots: 0, deltaSnapshots: 0, resyncRequests: 0, coalescedInputs: 0, expiredInputs: 0, rateLimits: 0,
  backpressureCloses: 0, queueOverflows: 0, maxBufferedBytes: 0, maxQueuedFrames: 0, fullReasons: reasons(), rateLimitKinds: rateKinds() }; }
const json = (response: ServerResponse, status: number, value: unknown): void => {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(value));
};
async function readJson(request: IncomingMessage): Promise<unknown> {
  if (!request.headers['content-type']?.startsWith('application/json')) throw new RealtimeError('JSON_REQUIRED', 415);
  const parts: Buffer[] = []; let length = 0;
  for await (const part of request) {
    const bytes = Buffer.isBuffer(part) ? part : Buffer.from(part);
    length += bytes.length; if (length > 262_144) throw new RealtimeError('BODY_TOO_LARGE', 413);
    parts.push(bytes);
  }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { throw new RealtimeError('INVALID_JSON'); }
}
export function createRealtimeHttpServer(options: RealtimeHttpOptions): Server & { shutdown(): Promise<void> } {
  const wall = options.wallNow ?? Date.now;
  const mono = options.monoNow ?? (() => performance.now());
  const origins = new Set(options.allowedOrigins), hosts = new Set(options.allowedHosts);
  const staticRoutes = Object.entries(options.staticDirectories ?? {}).sort((a, b) => b[0].length - a[0].length);
  const peers = new Map<string, Peer>();
  const totals = counters(), snapshotLatency = new BoundedTiming();
  const loopDelay = monitorEventLoopDelay({ resolution: 10 }); loopDelay.enable();
  const increment = (peer: Peer, field: Exclude<keyof ReturnType<typeof counters>, 'fullReasons' | 'rateLimitKinds'>, amount = 1): void => { peer.counters[field] += amount; totals[field] += amount; };
  const maximum = (peer: Peer, field: 'maxBufferedBytes' | 'maxQueuedFrames', value: number): void => { peer.counters[field] = Math.max(peer.counters[field], value); totals[field] = Math.max(totals[field], value); };
  const charge = (peer: Peer, message: ClientMessage, arrivedAt: number): void => {
    const limiter = message.type === 'input' ? peer.inputs : message.type === 'action' ? peer.actions : message.type === 'ackSnapshot' ? peer.acknowledgements : peer.control;
    if (limiter.take(arrivedAt)) return;
    peer.counters.rateLimitKinds[message.type] += 1; totals.rateLimitKinds[message.type] += 1;
    throw new RealtimeError('RATE_LIMIT', 429);
  };
  const diagnostics = () => ({ totals, snapshotRequest: snapshotLatency.report(),
    eventLoop: { delaySamples: loopDelay.count, p99DelayMs: loopDelay.count ? loopDelay.percentile(99) / 1e6 : null,
      maxDelayMs: loopDelay.count ? loopDelay.max / 1e6 : null, utilization: performance.eventLoopUtilization() },
    process: { uptimeSeconds: process.uptime(), memory: process.memoryUsage(), cpuMicroseconds: process.cpuUsage() },
    connections: [...peers.values()].map(peer => ({ connectionId: peer.id, authenticated: peer.claims !== null,
      queuedFrames: peer.queue.length, oldestQueuedAgeMs: peer.queue.length ? Math.max(0, mono() - peer.queue[0]) : 0,
      bufferedBytes: peer.ws.bufferedAmount, lastSnapshotAgeMs: peer.lastSnapshotAt === null ? null : Math.max(0, mono() - peer.lastSnapshotAt),
      snapshotPending: peer.snapshotPending, retainedBaselines: peer.baselines.size, ...peer.counters })) });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES, perMessageDeflate: false,
    handleProtocols: protocols => protocols.has(REALTIME_SUBPROTOCOL) ? REALTIME_SUBPROTOCOL : false });
  let stopping = false;
  const server = createServer((request, response) => {
    void (async () => {
      try {
        if (stopping) throw new RealtimeError('SERVER_UPDATING', 503);
        if (!request.headers.host || !hosts.has(request.headers.host)) throw new RealtimeError('HOST_NOT_ALLOWED', 421);
        if (!request.url?.startsWith('/') || request.url.startsWith('//')) throw new RealtimeError('INVALID_URL');
        const url = new URL(request.url, 'http://localhost'), path = url.pathname;
        const method = request.method ?? 'GET';
        if (method === 'GET' && (['/health/realtime/live', '/health/realtime/ready', '/api/realtime/v1/health'].includes(path) || /^\/api\/realtime\/v1\/health\/[a-z][a-z0-9-]*$/.test(path))) {
          const health = await options.runtime.call('health') as { ok: boolean; games: { gameId: string }[]; diagnostics?: unknown };
          if (path.startsWith('/api/realtime/v1/health/') && !health.games.some(game => game.gameId === path.split('/').at(-1))) throw new RealtimeError('NOT_FOUND', 404);
          const publicHealth = { ...health }; delete publicHealth.diagnostics;
          json(response, path.endsWith('/live') || health.ok ? 200 : 503, { ...publicHealth, revision: options.revision ?? 'unknown' }); return;
        }
        if (path.startsWith('/internal/realtime/v1/')) {
          let raw: unknown;
          if (method === 'GET') {
            const header = request.headers['x-iva-service-request'];
            if (typeof header !== 'string' || header.length > 8192) throw new RealtimeError('BRIDGE_UNAUTHORIZED', 401);
            try { raw = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')); } catch { throw new RealtimeError('BRIDGE_UNAUTHORIZED', 401); }
          } else if (method === 'POST') raw = await readJson(request);
          else throw new RealtimeError('METHOD_NOT_ALLOWED', 405);
          const envelope = verifyBridge(raw, options.trustedKeys, method, path + url.search, wall());
          await options.storage.call('consume', 'bridge', envelope.nonce, wall() + 30_000, wall());
          const body = object(envelope.body);
          let result: unknown;
          const match = path.match(/^\/internal\/realtime\/v1\/matches\/([\w-]+)\/(status|participant|ack-result)$/);
          if (method === 'POST' && path === '/internal/realtime/v1/matches') {
            exactFields(body, ['gameId', 'input', 'hostPlayerId']);
            if (!identifier(body.gameId)) throw new RealtimeError('INVALID_GAME');
            if (body.hostPlayerId !== undefined && !identifier(body.hostPlayerId)) throw new RealtimeError('INVALID_HOST');
            result = await options.runtime.call('create', body.gameId, body.input as StartMatchRequest, { hostPlayerId: body.hostPlayerId as string | undefined });
          } else if (match && method === 'GET' && match[2] === 'status') {
            exactFields(body, []); result = await options.runtime.call('status', match[1]);
          } else if (match && method === 'POST' && match[2] === 'participant') {
            exactFields(body, ['playerId']); if (!identifier(body.playerId)) throw new RealtimeError('INVALID_PLAYER');
            result = await options.runtime.call('participant', match[1], body.playerId);
          } else if (match && method === 'POST' && match[2] === 'ack-result') {
            exactFields(body, ['resultId']); if (!identifier(body.resultId)) throw new RealtimeError('INVALID_RESULT');
            await options.runtime.call('acknowledgeResult', match[1], body.resultId); result = { ok: true };
          } else if (method === 'GET' && path === '/internal/realtime/v1/metrics') {
            exactFields(body, []); result = { ...await options.runtime.call('health', true) as object, gateway: diagnostics(), revision: options.revision ?? 'unknown' };
          } else if (method === 'POST' && path === '/internal/realtime/v1/admissions') {
            exactFields(body, ['sessionIds']);
            if (!Array.isArray(body.sessionIds) || body.sessionIds.length > 10_000 || body.sessionIds.some(id => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id))) throw new RealtimeError('INVALID_ADMISSION');
            await options.runtime.call('admissions', body.sessionIds as string[]); result = { ok: true };
          } else if (method === 'POST' && path === '/internal/realtime/v1/drain') {
            exactFields(body, []); await options.runtime.call('drain');
            const health = await options.runtime.call('health') as { games: { gameId: string }[] };
            result = { ok: true, manifest: await options.storage.call('releaseManifest', health.games.map(game => game.gameId)) };
            for (const peer of peers.values()) peer.ws.close(1012, 'Server updating');
          } else if (method === 'POST' && path === '/internal/realtime/v1/cancel-drain') {
            exactFields(body, []); await options.runtime.call('cancelDrain'); result = { ok: true };
          } else throw new RealtimeError('NOT_FOUND', 404);
          json(response, 200, result); return;
        }
        if (method !== 'GET' && method !== 'HEAD') throw new RealtimeError('METHOD_NOT_ALLOWED', 405);
        const route = staticRoutes.find(([prefix]) => path === prefix.slice(0, -1) || path.startsWith(prefix));
        if (!route) throw new RealtimeError('NOT_FOUND', 404);
        const [prefix, directory] = route;
        if (path === prefix.slice(0, -1)) {
          response.writeHead(308, { Location: prefix + url.search, 'Cache-Control': 'no-store' }); response.end(); return;
        }
        let relative: string;
        try { relative = decodeURIComponent(path.startsWith(prefix) ? path.slice(prefix.length) : ''); } catch { throw new RealtimeError('INVALID_URL'); }
        const root = resolve(directory), candidate = resolve(root, relative || 'index.html');
        if (!candidate.startsWith(root + sep) || !existsSync(candidate) || !statSync(candidate).isFile()) throw new RealtimeError('NOT_FOUND', 404);
        const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm', '.glb': 'model/gltf-binary', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.wav': 'audio/wav', '.ogg': 'audio/ogg' };
        response.setHeader('Content-Type', mime[extname(candidate)] ?? 'application/octet-stream');
        response.setHeader('Cache-Control', extname(candidate) === '.html' ? 'no-store' : /\/versions\/[a-f0-9]{64}\//.test(path) || /\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/.test(path) ? 'public,max-age=31536000,immutable' : 'public,max-age=3600');
        response.setHeader('X-Content-Type-Options', 'nosniff');
        response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; media-src 'self' blob:; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
        if (method === 'HEAD') response.end(); else { const stream = createReadStream(candidate); response.once('close', () => stream.destroy()); stream.on('error', () => response.destroy()).pipe(response); }
      } catch (error) { const rejected = failure(error); if (!response.headersSent) json(response, rejected.statusCode, { error: { code: rejected.code, ...(rejected.details ? { details: rejected.details } : {}) } }); else response.destroy(); }
    })();
  });
  const send = (peer: Peer, value: unknown, encoded = JSON.stringify(value)): void => {
    if (!peer.closed && peer.ws.readyState === WebSocket.OPEN) {
      peer.ws.send(encoded);
      increment(peer, 'framesSent'); increment(peer, 'jsonBytesSent', Buffer.byteLength(encoded)); maximum(peer, 'maxBufferedBytes', peer.ws.bufferedAmount);
    }
  };
  const report = (peer: Peer, error: unknown, actionId?: string): void => {
    const rejected = failure(error), current = peer.snapshot;
    if (rejected.code === 'RATE_LIMIT') increment(peer, 'rateLimits');
    send(peer, { type: 'error', protocolVersion: REALTIME_PROTOCOL, matchId: current?.matchId, epoch: current?.epoch, controllerGeneration: current?.controllerGeneration, code: rejected.code, ...(actionId ? { actionId } : {}) });
    if (rejected.statusCode === 401 || rejected.code === 'RECOVERY_REQUIRED') peer.ws.close(4001, 'Reconnect required');
    else if (['WORKER_RECOVERING', 'WORKER_UNAVAILABLE'].includes(rejected.code)) peer.ws.close(1012, 'Restoring saved world');
  };
  const transmit = async (peer: Peer, provided?: Snapshot): Promise<void> => {
    if (peer.closed || !peer.claims || peer.snapshotPending) return;
    maximum(peer, 'maxBufferedBytes', peer.ws.bufferedAmount);
    if (peer.ws.bufferedAmount > 256 * 1024) {
      peer.forceFull = true; peer.fullReason = 'backpressure'; peer.congestedAt ??= wall();
      if (peer.ws.bufferedAmount > 1024 * 1024 || wall() - peer.congestedAt > 2000) { increment(peer, 'backpressureCloses'); peer.ws.close(4008, 'Connection too slow'); }
      return;
    }
    peer.congestedAt = null; peer.snapshotPending = true;
    const requestedAt = mono();
    try {
      const snapshot = provided ?? await options.runtime.call('snapshot', peer.id);
      if (peer.snapshot && (snapshot.epoch !== peer.snapshot.epoch || snapshot.controllerGeneration !== peer.snapshot.controllerGeneration)) {
        peer.baselines.clear(); peer.acknowledged = null; peer.forceFull = true;
        peer.fullReason = snapshot.epoch !== peer.snapshot.epoch ? 'epoch-change' : 'control-change';
        if (snapshot.controllerGeneration !== peer.snapshot.controllerGeneration) send(peer, { type: 'controlChanged', protocolVersion: REALTIME_PROTOCOL,
          matchId: snapshot.matchId, epoch: snapshot.epoch, controllerGeneration: snapshot.controllerGeneration, participantId: snapshot.participantId, hasControl: snapshot.hasControl });
      }
      const baseline = peer.acknowledged === null ? undefined : peer.baselines.get(peer.acknowledged);
      peer.snapshot = snapshot;
      if (!peer.forceFull && baseline && wall() - peer.fullAt < 2000) {
        const { view, ...metadata } = snapshot;
        const delta: DeltaSnapshot = { ...metadata, type: 'delta', baselineSnapshotSeq: baseline.snapshotSeq, changes: viewChanges(baseline.view, view) };
        const encoded = JSON.stringify(delta);
        // The last full view supplies a per-observer size estimate. A fresh
        // full is still forced every two seconds; do not stringify an entire
        // unchanged static map on every delta just to compare lengths.
        if (encoded.length < peer.fullSizeChars) { send(peer, delta, encoded); increment(peer, 'deltaSnapshots'); }
        else { const full = JSON.stringify(snapshot); send(peer, snapshot, full); peer.fullSizeChars = full.length; peer.fullAt = wall(); increment(peer, 'fullSnapshots'); peer.counters.fullReasons['delta-not-smaller'] += 1; totals.fullReasons['delta-not-smaller'] += 1; }
      } else {
        const reason = peer.forceFull ? peer.fullReason : !baseline ? 'missing-baseline' : 'periodic';
        const full = JSON.stringify(snapshot); send(peer, snapshot, full); peer.fullSizeChars = full.length; peer.fullAt = wall(); increment(peer, 'fullSnapshots'); peer.counters.fullReasons[reason] += 1; totals.fullReasons[reason] += 1;
      }
      peer.lastSnapshotAt = mono(); snapshotLatency.observe(peer.lastSnapshotAt - requestedAt);
      peer.forceFull = false;
      peer.baselines.set(snapshot.snapshotSeq, snapshot);
      // Keep the last acknowledged base while newer frames are in flight.
      // Slow acknowledgements must not turn an otherwise usable delta stream
      // into repeated full maps. One confirmed + eleven recent views is bounded.
      while (peer.baselines.size > 12) {
        const oldest = [...peer.baselines.keys()].find(sequence => sequence !== peer.acknowledged)!;
        peer.baselines.delete(oldest);
      }
    } catch (error) { report(peer, error); }
    finally { peer.snapshotPending = false; }
  };
  server.on('upgrade', (request, socket, head) => {
    if (stopping || request.url !== REALTIME_SOCKET_PATH || typeof request.headers.origin !== 'string' || !origins.has(request.headers.origin) || !request.headers.host || !hosts.has(request.headers.host) || request.headers['sec-websocket-protocol'] !== REALTIME_SUBPROTOCOL || peers.size >= 256) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    const origin = request.headers.origin;
    sockets.handleUpgrade(request, socket, head, ws => {
      const peer: Peer = { id: randomUUID(), ws, claims: null, snapshot: null, baselines: new Map(), acknowledged: null, fullAt: 0,
        forceFull: true, congestedAt: null, snapshotPending: false, closed: false,
        queue: [], fullReason: 'initial', lastSnapshotAt: null, counters: counters(), fullSizeChars: 0,
        inputs: new RateWindow(90, 2000), actions: new RateWindow(20, 2000), control: new RateWindow(20, 2000), acknowledgements: new RateWindow(90, 2000), bad: 0 };
      peers.set(peer.id, peer);
      const timeout = setTimeout(() => { if (!peer.claims) ws.close(4001, 'Authentication required'); }, 5000);
      let authenticating = false;
      let queue = Promise.resolve();
      let pendingInput: { message: Extract<ClientMessage, { type: 'input' }>; receivedAt: number } | null = null;
      let inputQueued = false;
      ws.on('message', (data, binary) => {
        const receivedAt = mono();
        let value: unknown, parsed: ClientMessage | null = null;
        try {
          const byteLength = Array.isArray(data) ? data.reduce((sum, part) => sum + part.byteLength, 0) : data.byteLength;
          increment(peer, 'framesReceived'); increment(peer, 'jsonBytesReceived', byteLength);
          if (binary || byteLength > (peer.claims ? MAX_FRAME_BYTES : 4096)) throw new RealtimeError('INVALID_FRAME');
          try { value = JSON.parse(data.toString()); } catch { throw new RealtimeError('INVALID_JSON'); }
          if (peer.claims) {
            parsed = parseClientMessage(value);
            charge(peer, parsed, receivedAt);
            if (parsed.type === 'input') {
              // Keep only the newest not-yet-processed continuous state. Discrete
              // commands retain their own bounded queue and durable receipts.
              pendingInput = { message: parsed, receivedAt };
              if (inputQueued) { increment(peer, 'coalescedInputs'); return; }
              inputQueued = true;
            }
          }
        } catch (error) {
          report(peer, error, parsed?.type === 'action' ? parsed.actionId : undefined);
          if (!peer.claims || ++peer.bad > 20) ws.close(4002, 'Invalid messages');
          return;
        }
        if (peer.queue.length >= 128) { increment(peer, 'queueOverflows'); ws.close(4008, 'Input queue full'); return; }
        peer.queue.push(receivedAt); maximum(peer, 'maxQueuedFrames', peer.queue.length);
        queue = queue.then(async () => {
          if (peer.closed) { peer.queue.shift(); return; }
          let actionId: string | undefined;
          try {
            if (!peer.claims) {
              if (authenticating) throw new RealtimeError('AUTH_FAILED', 401);
              authenticating = true;
              const auth = object(value); exactFields(auth, ['type', 'ticket']);
              if (auth.type !== 'authenticate') throw new RealtimeError('AUTH_FAILED', 401);
              const claims = verifyTicket(auth.ticket, options.trustedKeys, origin, wall());
              const snapshot = await options.runtime.call('connect', claims, peer.id);
              // The socket may close while its durable admission is pending.
              // Release the newly admitted control instead of leaving an orphan.
              if (peer.closed) { await options.runtime.call('disconnect', peer.id); return; }
              peer.claims = claims; clearTimeout(timeout);
              send(peer, { type: 'hello', protocolVersion: REALTIME_PROTOCOL, matchId: snapshot.matchId, epoch: snapshot.epoch, controllerGeneration: snapshot.controllerGeneration, connectionId: peer.id, participantId: claims.participantId, hasControl: snapshot.hasControl });
              await transmit(peer, snapshot); return;
            }
            const input = parsed?.type === 'input' ? pendingInput : null;
            if (parsed?.type === 'input') { pendingInput = null; inputQueued = false; }
            const message = input?.message ?? parsed ?? parseClientMessage(value);
            if (message.type === 'action') actionId = message.actionId;
            if (!parsed) charge(peer, message, receivedAt);
            if (message.type === 'input') {
              const arrival = input?.receivedAt ?? receivedAt;
              if (mono() - arrival <= INPUT_TIMEOUT_MS) await options.runtime.call('input', peer.id, message, arrival);
              else increment(peer, 'expiredInputs');
            }
            else if (message.type === 'action') {
              const receipt = await options.runtime.call('action', peer.id, message);
              const current = await options.runtime.call('snapshot', peer.id);
              send(peer, { type: 'actionAck', protocolVersion: REALTIME_PROTOCOL, matchId: current.matchId, epoch: current.epoch, controllerGeneration: current.controllerGeneration,
                actionId: message.actionId, worldTick: receipt.worldTick, committedJournalSeq: receipt.journalSeq, result: receipt.result });
              await transmit(peer, current);
            } else if (message.type === 'claimControl') { peer.forceFull = true; peer.fullReason = 'control-change'; await transmit(peer, await options.runtime.call('claim', peer.id, message)); }
            else if (message.type === 'ackSnapshot') {
              await options.runtime.call('heartbeat', peer.id, message);
              if (peer.baselines.has(message.snapshotSeq) && (peer.acknowledged === null || message.snapshotSeq > peer.acknowledged)) {
                peer.acknowledged = message.snapshotSeq;
                // An acknowledged newer projection supersedes older bases for
                // this observer. Keep newer in-flight views, not 32 obsolete
                // copies of the map after every immediate acknowledgement.
                for (const sequence of peer.baselines.keys()) if (sequence < message.snapshotSeq) peer.baselines.delete(sequence);
              }
              // An ACK can arrive after its newer in-flight view was evicted.
              // Preserve a still-valid confirmed base until a retained newer
              // ACK or explicit resync; stale ACKs never move it backwards.
              else if (peer.acknowledged === null || !peer.baselines.has(peer.acknowledged)) { peer.forceFull = true; peer.fullReason = 'missing-baseline'; }
            } else if (message.type === 'resync') { increment(peer, 'resyncRequests'); peer.forceFull = true; peer.fullReason = 'client-request'; await transmit(peer, await options.runtime.call('resync', peer.id, message)); }
            else { await options.runtime.call('heartbeat', peer.id, message); send(peer, { ...message, type: 'heartbeat' }); }
            peer.bad = 0;
          } catch (error) {
            report(peer, error, actionId);
            if (!peer.claims || ++peer.bad > 20) ws.close(4002, 'Invalid messages');
          } finally { peer.queue.shift(); }
        });
      });
      ws.on('error', () => {});
      ws.once('close', () => { clearTimeout(timeout); peer.closed = true; peers.delete(peer.id); void options.runtime.call('disconnect', peer.id).catch(() => {}); });
    });
  });
  const timer = setInterval(() => { for (const peer of peers.values()) if (peer.claims) void transmit(peer); }, options.snapshotIntervalMs ?? 50);
  timer.unref();
  server.requestTimeout = 10_000; server.headersTimeout = 8000; server.keepAliveTimeout = 5000;
  return Object.assign(server, {
    async shutdown(): Promise<void> {
      if (stopping) return; stopping = true; clearInterval(timer); loopDelay.disable();
      await options.runtime.call('drain');
      for (const peer of peers.values()) peer.ws.close(1012, 'Server updating');
      const closed = new Promise<void>((resolveClosed, reject) => server.close(error => error ? reject(error) : resolveClosed()));
      server.closeIdleConnections();
      // A half-uploaded internal request or an uncooperative WebSocket cannot
      // hold deployment until SIGKILL. Durable drain has already committed.
      const force = setTimeout(() => {
        for (const peer of peers.values()) peer.ws.terminate();
        server.closeAllConnections();
      }, 500);
      try { await closed; } finally { clearTimeout(force); }
      for (const peer of peers.values()) peer.ws.terminate(); sockets.close();
    },
  });
}
