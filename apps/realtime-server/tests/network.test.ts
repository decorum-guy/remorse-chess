import { afterEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { request as httpRequest } from 'node:http';
import { WebSocket } from 'ws';
import { REALTIME_PROTOCOL, REALTIME_SUBPROTOCOL, applyViewChanges } from '@iva-games/realtime-kit';
import type { ClientMessage, DeltaSnapshot, Snapshot, WireScope } from '@iva-games/realtime-kit';
import { createRealtimeHttpServer } from '../src/server.js';
import { LocalRuntimeClient } from '../src/rpc.js';
import type { RealtimeStore } from '../src/storage.js';
import { signBridge, signTicket } from '../src/crypto.js';
import { adapter, claims, fixture, keyPair } from './fixture.js';

type Frame = Record<string, unknown>;
const closing: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of closing.splice(0)) await cleanup(); });
class Client {
  readonly frames: Frame[] = [];
  private listeners = new Set<() => void>();
  constructor(readonly socket: WebSocket) {
    socket.on('message', bytes => { this.frames.push(JSON.parse(bytes.toString()) as Frame); for (const listener of this.listeners) listener(); });
    socket.on('error', () => {});
  }
  async frame(predicate: (frame: Frame) => boolean): Promise<Frame> {
    const found = this.frames.find(predicate); if (found) return found;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.listeners.delete(check); reject(new Error('Missing expected network frame')); }, 3000);
      const check = () => { const value = this.frames.find(predicate); if (value) { clearTimeout(timer); this.listeners.delete(check); resolve(value); } };
      this.listeners.add(check);
    });
  }
  send(value: unknown) { this.socket.send(JSON.stringify(value)); }
}
const scope = (snapshot: Snapshot): WireScope => ({ protocolVersion: REALTIME_PROTOCOL, matchId: snapshot.matchId, epoch: snapshot.epoch, controllerGeneration: snapshot.controllerGeneration });
async function network(gameAdapter = adapter, snapshotIntervalMs = 20) {
  const f = await fixture(':memory:', gameAdapter); const keys = keyPair();
  const server = createRealtimeHttpServer({ runtime: new LocalRuntimeClient(f.engine), storage: f.storage,
    trustedKeys: new Map([['test-key', keys.publicKey]]), allowedOrigins: ['http://127.0.0.1:5284'], allowedHosts: ['test.local'],
    wallNow: () => f.clock.wall, monoNow: () => f.clock.mono, snapshotIntervalMs });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing test address');
  const url = `ws://127.0.0.1:${address.port}/ws/realtime/v1`;
  const clients: Client[] = [];
  const connect = async (participant = 1, token?: string) => {
    const client = new Client(new WebSocket(url, REALTIME_SUBPROTOCOL, { headers: { Origin: 'http://127.0.0.1:5284', Host: 'test.local' } }));
    clients.push(client); await once(client.socket, 'open');
    client.send({ type: 'authenticate', ticket: token ?? signTicket(claims(f.matchId, f.clock.wall, participant), keys.privateKey) });
    return client;
  };
  closing.push(async () => {
    for (const client of clients) client.socket.terminate();
    await new Promise(resolve => setTimeout(resolve, 20));
    await server.shutdown(); f.store.close();
  });
  return { ...f, keys, server, url, connect };
}

describe('actual HTTP/WebSocket boundary', () => {
  it('retains the confirmed base through slow or evicted acknowledgements without a full-map storm', async () => {
    const f = await network(), client = await f.connect();
    const initial = await client.frame(frame => frame.type === 'full') as unknown as Snapshot;
    client.send({ ...scope(initial), type: 'ackSnapshot', snapshotSeq: initial.snapshotSeq });
    const firstDelta = await client.frame(frame => frame.type === 'delta') as unknown as DeltaSnapshot;
    const later = await client.frame(frame => frame.type === 'delta' && Number(frame.snapshotSeq) > firstDelta.snapshotSeq + 25) as unknown as DeltaSnapshot;
    expect(later.baselineSnapshotSeq).toBe(initial.snapshotSeq);
    expect(client.frames.filter(frame => Number(frame.snapshotSeq) > firstDelta.snapshotSeq && frame.type === 'full')).toEqual([]);
    // This once-sent newer view is no longer in the twelve-view cache. It must
    // not discard the still-present base the client has already acknowledged.
    client.send({ ...scope(initial), type: 'ackSnapshot', snapshotSeq: firstDelta.snapshotSeq });
    const retained = await client.frame(frame => frame.type === 'delta' && Number(frame.snapshotSeq) > later.snapshotSeq + 2) as unknown as DeltaSnapshot;
    expect(retained.baselineSnapshotSeq).toBe(initial.snapshotSeq);
    client.send({ ...scope(initial), type: 'ackSnapshot', snapshotSeq: retained.snapshotSeq });
    const advanced = await client.frame(frame => frame.type === 'delta' && frame.baselineSnapshotSeq === retained.snapshotSeq) as unknown as DeltaSnapshot;
    client.send({ ...scope(initial), type: 'ackSnapshot', snapshotSeq: initial.snapshotSeq });
    expect((await client.frame(frame => frame.type === 'delta' && Number(frame.snapshotSeq) > advanced.snapshotSeq + 2)).baselineSnapshotSeq).toBe(retained.snapshotSeq);
  });
  it('consumes the same ticket exactly once when two independent Node processes race it', async () => {
    const f = await network(), ticket = signTicket(claims(f.matchId, f.clock.wall), f.keys.privateKey);
    const script = `
      import { WebSocket } from 'ws';
      let input = ''; for await (const chunk of process.stdin) input += chunk;
      const { url, ticket } = JSON.parse(input);
      const socket = new WebSocket(url, 'iva-realtime-v1', { headers: { Origin: 'http://127.0.0.1:5284', Host: 'test.local' } });
      let finished = false;
      const timer = setTimeout(() => finish({ error: 'TIMEOUT' }), 3000);
      function finish(value) { if (finished) return; finished = true; clearTimeout(timer); console.log(JSON.stringify(value)); socket.terminate(); }
      socket.on('open', () => socket.send(JSON.stringify({ type: 'authenticate', ticket })));
      socket.on('message', bytes => { const frame = JSON.parse(bytes); if (frame.type === 'full') finish({ accepted: true }); if (frame.type === 'error') finish({ rejected: frame.code }); });
      socket.on('error', () => finish({ error: 'SOCKET_FAILED' }));
    `;
    const children = [0, 1].map(() => spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['pipe', 'pipe', 'pipe'] }));
    try {
      const results = await Promise.all(children.map(async child => {
        let output = '', errors = ''; child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
        child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { errors += data; });
        child.stdin.end(JSON.stringify({ url: f.url, ticket }));
        const [code] = await once(child, 'exit'); expect(code, errors).toBe(0);
        return JSON.parse(output.trim()) as Record<string, unknown>;
      }));
      expect(results.filter(result => result.accepted)).toHaveLength(1);
      expect(results.filter(result => result.rejected === 'REPLAY_REJECTED')).toHaveLength(1);
    } finally { for (const child of children) if (child.exitCode === null) child.kill('SIGKILL'); }
  });
  it('bounds a genuinely blocked TCP reader and keeps the other observer receiving', async () => {
    const padding = 'x'.repeat(128 * 1024);
    const f = await network({ ...adapter, view: world => ({ ...world, padding }) }, 50);
    const slow = await f.connect(), slowFirst = await slow.frame(frame => frame.type === 'full') as unknown as Snapshot;
    const healthy = await f.connect(2), healthyFirst = await healthy.frame(frame => frame.type === 'full') as unknown as Snapshot;
    healthy.socket.on('message', bytes => { const frame = JSON.parse(bytes.toString()) as Snapshot; if (['full', 'delta'].includes(frame.type)) healthy.send({ ...scope(frame), type: 'ackSnapshot', snapshotSeq: frame.snapshotSeq }); });
    slow.socket.pause();
    const address = f.server.address(); if (!address || typeof address === 'string') throw new Error('Missing listener');
    const clock = setInterval(() => { f.clock.wall += 50; f.clock.mono += 50; }, 50);
    const readMetrics = () => new Promise<{ gateway: { totals: { backpressureCloses: number; maxBufferedBytes: number } } }>((resolve, reject) => {
      const path = '/internal/realtime/v1/metrics';
      const request = httpRequest({ hostname: '127.0.0.1', port: address.port, path, headers: { Host: 'test.local',
        'X-Iva-Service-Request': Buffer.from(JSON.stringify(signBridge('GET', path, {}, 'test-key', f.keys.privateKey, f.clock.wall))).toString('base64url') } }, response => {
        let body = ''; response.setEncoding('utf8'); response.on('data', bytes => { body += bytes; });
        response.on('end', () => { if (response.statusCode !== 200) reject(new Error(`Metrics returned ${response.statusCode}`)); else resolve(JSON.parse(body)); });
      }); request.on('error', reject); request.end();
    });
    try {
      await vi.waitFor(async () => {
        const report = await readMetrics();
        expect(report.gateway.totals.backpressureCloses).toBeGreaterThan(0);
        expect(report.gateway.totals.maxBufferedBytes).toBeGreaterThan(256 * 1024);
        expect(report.gateway.totals.maxBufferedBytes).toBeLessThan(1024 * 1024);
      }, { timeout: 12_000, interval: 100 });
      expect(slow.frames.filter(frame => Number(frame.snapshotSeq) > slowFirst.snapshotSeq)).toHaveLength(0);
      expect(healthy.frames.some(frame => Number(frame.snapshotSeq) > healthyFirst.snapshotSeq + 5)).toBe(true);
      expect(healthy.socket.readyState).toBe(WebSocket.OPEN);
      expect(healthy.frames.filter(frame => frame.type === 'error')).toEqual([]);
      const closed = once(slow.socket, 'close'); slow.socket.resume();
      expect((await closed)[0]).toBe(4008);
    } finally { clearInterval(clock); slow.socket.resume(); }
  }, 15_000);
  it('releases control if the socket closes while durable authentication is pending', async () => {
    const f = await network(), original = f.engine.connect.bind(f.engine);
    let unblock!: () => void, entered!: () => void, admitted!: () => void;
    const gate = new Promise<void>(resolve => { unblock = resolve; }), waiting = new Promise<void>(resolve => { entered = resolve; });
    const completed = new Promise<void>(resolve => { admitted = resolve; });
    const connect = vi.spyOn(f.engine, 'connect').mockImplementation(async (...args) => { entered(); await gate; const result = await original(...args); admitted(); return result; });
    try {
      const client = await f.connect(); await waiting;
      client.socket.close(); await once(client.socket, 'close');
      unblock(); await completed;
      await vi.waitFor(() => {
        expect(f.engine.health(true)).toMatchObject({ diagnostics: { connectedClients: 0 } });
      });
      const other = await f.connect(2), snapshot = await other.frame(frame => frame.type === 'full') as unknown as Snapshot;
      expect(snapshot.controls.find(control => control.participantId === f.engine.participant(f.matchId, 'player1').participantId)).toMatchObject({ connected: false });
    } finally { unblock(); connect.mockRestore(); }
  });
  it('keeps connection queues and resync diagnostics behind a signed internal request', async () => {
    const f = await network(), first = await f.connect(), address = f.server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test listener');
    const initial = await first.frame(frame => frame.type === 'full') as unknown as Snapshot;
    await f.tick(3100);
    const get = (path: string, signed = false) => new Promise<{ status: number; value: Record<string, unknown> }>((resolve, reject) => {
      const headers: Record<string, string> = { Host: 'test.local' };
      if (signed) headers['X-Iva-Service-Request'] = Buffer.from(JSON.stringify(signBridge('GET', path, {}, 'test-key', f.keys.privateKey, f.clock.wall))).toString('base64url');
      const request = httpRequest({ hostname: '127.0.0.1', port: address.port, path, headers }, response => {
        let body = ''; response.setEncoding('utf8'); response.on('data', bytes => { body += bytes; });
        response.on('end', () => resolve({ status: response.statusCode ?? 0, value: JSON.parse(body) }));
      }); request.on('error', reject); request.end();
    });
    const publicHealth = await get('/health/realtime/ready');
    expect(publicHealth.status).toBe(200); expect(publicHealth.value).not.toHaveProperty('diagnostics'); expect(publicHealth.value).not.toHaveProperty('gateway');
    expect((await get('/internal/realtime/v1/metrics')).status).toBe(401);
    first.send({ ...scope(initial), type: 'resync' });
    await first.frame(frame => frame.type === 'full' && Number(frame.snapshotSeq) > initial.snapshotSeq);
    for (let index = 0; index < 91; index++) first.send({ ...scope(initial), type: 'ackSnapshot', snapshotSeq: initial.snapshotSeq });
    await first.frame(frame => frame.type === 'error' && frame.code === 'RATE_LIMIT');
    await vi.waitFor(async () => {
      const report = await get('/internal/realtime/v1/metrics', true);
      expect(report.status).toBe(200);
      expect(report.value).toMatchObject({ gateway: { totals: { resyncRequests: 1, rateLimits: 1,
        rateLimitKinds: { input: 0, action: 0, ackSnapshot: 1, heartbeat: 0, resync: 0, claimControl: 0 }, fullReasons: { 'client-request': 1 } },
        connections: [{ authenticated: true }] }, diagnostics: { games: [{ gameId: 'fixture' }] } });
      const encoded = JSON.stringify(report.value);
      expect(encoded).not.toContain('player1'); expect(encoded).not.toContain('Player one'); expect(encoded).not.toContain('rosterHash');
    });
  });
  it('keeps the socket and controller through overload pause and automatic durable resume', async () => {
    const f = await network(), first = await f.connect();
    await first.frame(frame => frame.type === 'full'); await f.tick(3000);
    const id = String(first.frames.find(frame => frame.type === 'hello')!.connectionId);
    const before = f.engine.snapshot(id);
    f.clock.wall += 750; f.clock.mono += 750; await f.engine.tick();
    const paused = await first.frame(frame => frame.type === 'full' && frame.phase === 'paused');
    expect(paused.pauseReason).toBe('overload'); expect(paused.hasControl).toBe(true);
    for (let elapsed = 0; elapsed < 4300; elapsed += 100) {
      f.engine.heartbeat(id, { ...scope(f.engine.snapshot(id)), type: 'heartbeat', nonce: 'same-socket' }); await f.tick(100);
    }
    const running = await first.frame(frame => frame.type === 'full' && frame.phase === 'running' && Number(frame.worldTick) > before.worldTick);
    expect(running.controllerGeneration).toBe(before.controllerGeneration); expect(running.epoch).toBe(before.epoch);
    expect(first.socket.readyState).toBe(WebSocket.OPEN); expect(first.frames.filter(frame => frame.type === 'hello')).toHaveLength(1);
  });
  it.each([0, 400])('coalesces continuous input behind a durable action and uses its original arrival (%i ms delay)', async delay => {
    const f = await network(), first = await f.connect();
    await first.frame(frame => frame.type === 'full'); await f.tick(3000);
    const connectionId = String(first.frames.find(frame => frame.type === 'hello')!.connectionId);
    const current = f.engine.snapshot(connectionId);
    const original = f.storage.call.bind(f.storage);
    let unblock!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { unblock = resolve; });
    const pending = new Promise<void>(resolve => { entered = resolve; });
    let delayed = false;
    const storageSpy = vi.spyOn(f.storage, 'call').mockImplementation(async (method, ...args) => {
      if (method === 'commit' && (args[0] as { kind?: string })?.kind === 'action' && !delayed) {
        delayed = true; entered(); await gate;
      }
      return original(method, ...args as Parameters<RealtimeStore[typeof method]>);
    });
    const inputs = vi.spyOn(f.engine, 'input');
    try {
      first.send({ ...scope(current), type: 'action', actionId: 'blocked-commit', payload: { type: 'spend' } });
      await pending;
      const arrivedAt = f.clock.mono;
      for (let inputSeq = 1; inputSeq <= 20; inputSeq++) first.send({ ...scope(current), type: 'input', inputSeq, payload: { move: 1 } });
      // Let the actual socket deliver all frames while the writer reply waits.
      await new Promise(resolve => setTimeout(resolve, 35));
      f.clock.mono += delay; f.clock.wall += delay;
      unblock();
      await first.frame(frame => frame.type === 'actionAck' && frame.actionId === 'blocked-commit');
      await new Promise(resolve => setTimeout(resolve, 25));
      expect(inputs).toHaveBeenCalledTimes(delay ? 0 : 1);
      if (!delay) {
        expect(inputs.mock.calls[0][1].inputSeq).toBe(20);
        expect(inputs.mock.calls[0][2]).toBe(arrivedAt);
      }
      await f.tick(100);
      const x = (f.engine.snapshot(connectionId).view as { x: number }).x;
      if (delay) expect(x).toBe(0); else expect(x).toBeGreaterThan(0);
      expect(f.store.receipt(f.matchId, 1, 'p1', 'blocked-commit')?.result).toEqual({ ok: true, stock: 4 });
    } finally { unblock(); storageSpy.mockRestore(); inputs.mockRestore(); }
  });
  it('requires a signed positive drain receipt, reports the durable cursor, and resumes after cancellation', async () => {
    const f = await network(), address = f.server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test listener');
    const first = await f.connect();
    await first.frame(frame => frame.type === 'full'); await f.tick(3000);
    const post = async (operation: string, signed = true): Promise<{ status: number; json(): Promise<unknown> }> => {
      const path = `/internal/realtime/v1/${operation}`;
      const body = JSON.stringify(signBridge('POST', path, {}, 'test-key', signed ? f.keys.privateKey : keyPair().privateKey, f.clock.wall));
      return new Promise((resolve, reject) => {
        const request = httpRequest({ hostname: '127.0.0.1', port: address.port, path, method: 'POST',
          headers: { Host: 'test.local', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        }, response => {
          let bytes = ''; response.setEncoding('utf8'); response.on('data', chunk => { bytes += chunk; });
          response.on('end', () => resolve({ status: response.statusCode ?? 0, json: async () => JSON.parse(bytes) }));
        });
        request.on('error', reject); request.end(body);
      });
    };
    expect((await post('drain', false)).status).toBe(401);
    expect(f.engine.health()).toMatchObject({ draining: false });
    const receipt = await (await post('drain')).json() as { ok: boolean; manifest: { matches: { matchId: string; journalSeq: number }[] } };
    expect(receipt.ok).toBe(true); expect(receipt.manifest.matches[0].matchId).toBe(f.matchId);
    expect(receipt.manifest.matches[0].journalSeq).toBe(f.store.recovery(f.matchId).snapshot.seq);
    const again = await (await post('drain')).json() as typeof receipt;
    expect(again.manifest.matches).toEqual(receipt.manifest.matches);
    expect((await post('cancel-drain')).status).toBe(200);
    const returned = await f.connect();
    expect((await returned.frame(frame => frame.type === 'full')).hasControl).toBe(true);
  });
  it('drains durably and closes a stalled HTTP upload within a bounded shutdown', async () => {
    const f = await network(), address = f.server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test listener');
    const socket = createConnection(address.port, '127.0.0.1'); socket.on('error', () => {});
    await once(socket, 'connect'); socket.resume();
    let received = false; socket.on('data', () => { received = true; });
    socket.write('POST /internal/realtime/v1/drain HTTP/1.1\r\nHost: test.local\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{');
    await new Promise(resolve => setTimeout(resolve, 25)); expect(received).toBe(false);
    const start = performance.now();
    await f.server.shutdown();
    expect(performance.now() - start).toBeLessThan(2000);
    socket.destroy();
    expect(f.engine.health()).toMatchObject({ draining: true });
  });
  it('accepts independent authenticated clients, converges on durable actions, and emits acknowledged deltas', async () => {
    const f = await network();
    const first = await f.connect(1), second = await f.connect(2);
    let a = await first.frame(frame => frame.type === 'full') as unknown as Snapshot;
    const b = await second.frame(frame => frame.type === 'full') as unknown as Snapshot;
    expect(a.participantId).toBe('p1'); expect(b.participantId).toBe('p2');
    await f.tick(3000);
    a = f.engine.snapshot(String(first.frames.find(frame => frame.type === 'hello')!.connectionId));
    first.send({ ...scope(a), type: 'action', actionId: 'network-spend', payload: { type: 'spend' } });
    const receipt = await first.frame(frame => frame.type === 'actionAck' && frame.actionId === 'network-spend');
    expect(receipt.result).toEqual({ ok: true, stock: 4 });
    const nextA = await first.frame(frame => frame.type === 'full' && (frame.view as { stock: number }).stock === 4) as unknown as Snapshot;
    const nextB = await second.frame(frame => frame.type === 'full' && (frame.view as { stock: number }).stock === 4) as unknown as Snapshot;
    expect(nextA.view).toEqual(nextB.view);
    first.send({ ...scope(nextA), type: 'ackSnapshot', snapshotSeq: nextA.snapshotSeq });
    first.send({ ...scope(nextA), type: 'input', inputSeq: 1, payload: { move: 1 } });
    await new Promise(resolve => setTimeout(resolve, 30)); await f.tick(100);
    const delta = await first.frame(frame => frame.type === 'delta' && (frame.changes as { path: unknown[] }[]).some(change => change.path[0] === 'x')) as unknown as DeltaSnapshot;
    expect(delta.baselineSnapshotSeq).toBe(nextA.snapshotSeq);
    const reconstructed = applyViewChanges(nextA.view, delta.changes) as { x: number; stock: number };
    expect(reconstructed.x).toBeGreaterThan(0); expect(reconstructed.stock).toBe(4);
    expect(delta.changes.some(change => change.path[0] === 'map')).toBe(false);
    first.send({ ...scope(nextA), type: 'resync' });
    const full = await first.frame(frame => frame.type === 'full' && Number(frame.snapshotSeq) > delta.snapshotSeq);
    expect((full.view as { stock: number }).stock).toBe(4);
  });
  it('does not expose a roster before auth and rejects ticket replay, unrelated Origin and old controller', async () => {
    const f = await network();
    const ticket = signTicket(claims(f.matchId, f.clock.wall), f.keys.privateKey);
    const first = await f.connect(1, ticket); const full = await first.frame(frame => frame.type === 'full') as unknown as Snapshot;
    const replay = await f.connect(1, ticket);
    expect((await replay.frame(frame => frame.type === 'error')).code).toBe('REPLAY_REJECTED');
    expect(replay.frames.some(frame => frame.type === 'full')).toBe(false);
    const observer = await f.connect(1); const own = await observer.frame(frame => frame.type === 'full') as unknown as Snapshot;
    expect(own.hasControl).toBe(false);
    observer.send({ ...scope(own), type: 'claimControl', expectedGeneration: own.controllerGeneration });
    await observer.frame(frame => frame.type === 'full' && frame.hasControl === true);
    first.send({ ...scope(full), type: 'input', inputSeq: 99, payload: { move: 1 } });
    expect((await first.frame(frame => frame.type === 'error')).code).toBe('STALE_CONTROLLER');
    const foreign = new WebSocket(f.url, REALTIME_SUBPROTOCOL, { headers: { Origin: 'https://foreign.invalid', Host: 'test.local' } });
    const result = await new Promise<number>(resolve => { foreign.on('unexpected-response', (_request, response) => { response.resume(); foreign.terminate(); resolve(response.statusCode ?? 0); }); foreign.on('error', () => {}); });
    expect(result).toBe(403);
  });
  it('stops revoked admissions and rejects malformed input frames', async () => {
    const f = await network(), first = await f.connect();
    const initial = await first.frame(frame => frame.type === 'full') as unknown as Snapshot;
    first.send({ ...scope(initial), type: 'input', inputSeq: 1, playerId: 'player2', payload: { move: 1 } });
    expect((await first.frame(frame => frame.type === 'error')).code).toBe('UNKNOWN_FIELD');
    await f.engine.admissions([]);
    first.send({ ...scope(initial), type: 'heartbeat', nonce: 'revoked' } satisfies ClientMessage);
    expect((await first.frame(frame => frame.type === 'error' && frame.code === 'AUTH_EXPIRED')).code).toBe('AUTH_EXPIRED');
  });
  it('closes an oversized frame before it can execute an action', async () => {
    const f = await network(), first = await f.connect();
    const initial = await first.frame(frame => frame.type === 'full') as unknown as Snapshot;
    const closed = once(first.socket, 'close');
    first.send({ ...scope(initial), type: 'action', actionId: 'oversized-action', payload: { type: 'spend', padding: 'x'.repeat(17_000) } });
    const [code] = await closed;
    expect(code).toBe(1009);
    expect(f.store.receipt(f.matchId, 1, 'p1', 'oversized-action')).toBeNull();
  });
});
