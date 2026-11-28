import { afterEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { WebSocket as NodeSocket } from 'ws';
import { REALTIME_PROTOCOL, REALTIME_SUBPROTOCOL } from '@iva-games/realtime-kit';
import type { ClientMessage, Snapshot } from '@iva-games/realtime-kit';
import { GameConnection } from '../../../games/tyaga/src/client/connection.js';
import { createRealtimeHttpServer } from '../src/server.js';
import { LocalRuntimeClient } from '../src/rpc.js';
import { signTicket } from '../src/crypto.js';
import { adapter, claims, fixture, keyPair } from './fixture.js';

type Frame = Record<string, unknown>;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllGlobals();
});

/** Real TCP/WebSocket transport with browser event delivery held explicitly.
 * This models a renderer that resumes with queued messages; it is not a game
 * physics or latency-capacity benchmark. The fixture clock does not advance. */
class BrowserWire {
  static readonly OPEN = NodeSocket.OPEN;
  static instances: BrowserWire[] = [];
  readonly socket: NodeSocket;
  readonly received: Frame[] = [];
  readonly sent: Frame[] = [];
  readonly delivered: Frame[] = [];
  readonly queued: string[] = [];
  held = true;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(url: string | URL, protocols: string | string[]) {
    this.socket = new NodeSocket(url, protocols, { headers: { Origin: 'http://127.0.0.1:5284', Host: 'test.local' } });
    BrowserWire.instances.push(this);
    this.socket.on('open', () => this.onopen?.());
    this.socket.on('message', bytes => {
      const data = bytes.toString(); this.received.push(JSON.parse(data) as Frame);
      if (this.held) this.queued.push(data); else this.deliver(data);
    });
    this.socket.on('error', () => this.onerror?.());
    this.socket.on('close', () => this.onclose?.());
  }
  get readyState() { return this.socket.readyState; }
  send(data: string) { this.sent.push(JSON.parse(data) as Frame); this.socket.send(data); }
  close(code?: number, reason?: string) { this.socket.close(code, reason); }
  private deliver(data: string) { this.delivered.push(JSON.parse(data) as Frame); this.onmessage?.({ data }); }
  flush() { for (const data of this.queued.splice(0)) this.deliver(data); }
}

async function browser() {
  // A minimal Tyaga-shaped projection exercises the production client without
  // starting Rapier, assets, a renderer, or changing any QA database.
  const f = await fixture(':memory:', { ...adapter, input: value => adapter.input({ move: (value as { moveX?: number }).moveX ?? 0 }), view: world => ({ ...adapter.view(world, 'p1') as object,
    gameId: 'tyaga', phase: 'running', participants: [], participantId: 'p1', outcome: null }) });
  const keys = keyPair();
  const server = createRealtimeHttpServer({ runtime: new LocalRuntimeClient(f.engine), storage: f.storage,
    trustedKeys: new Map([['test-key', keys.publicKey]]), allowedOrigins: ['http://127.0.0.1:5284'], allowedHosts: ['test.local'],
    wallNow: () => f.clock.wall, monoNow: () => f.clock.mono, snapshotIntervalMs: 20 });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing listener');
  BrowserWire.instances = [];
  vi.stubGlobal('WebSocket', BrowserWire);
  vi.stubGlobal('window', { setTimeout, clearTimeout, setInterval, clearInterval });
  vi.stubGlobal('location', new URL('http://127.0.0.1:5284/play/tyaga/'));
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    expect(path).toBe('/api/platform/v1/rooms/room1/realtime-ticket');
    return new Response(JSON.stringify({ ticket: signTicket(claims(f.matchId, f.clock.wall), keys.privateKey),
      websocketPath: `ws://127.0.0.1:${address.port}/ws/realtime/v1`, subprotocol: REALTIME_SUBPROTOCOL }));
  }));
  const connection = new GameConnection('room1');
  cleanups.push(async () => {
    connection.close();
    for (const wire of BrowserWire.instances) wire.socket.terminate();
    await new Promise(resolve => setTimeout(resolve, 20));
    await server.shutdown(); f.store.close();
  });
  connection.start();
  await vi.waitFor(() => expect(BrowserWire.instances).toHaveLength(1), { interval: 5 });
  const wire = BrowserWire.instances[0];
  await vi.waitFor(() => expect(wire.received.some(frame => frame.type === 'full')).toBe(true), { interval: 5 });
  return { ...f, connection, wire };
}

describe('production browser connection over a real WebSocket gateway', () => {
  it('coalesces 100 queued initial full views into one retained ACK without triggering the gateway limit', async () => {
    const { connection, wire } = await browser();
    await vi.waitFor(() => expect(wire.received.filter(frame => frame.type === 'full').length).toBeGreaterThanOrEqual(100), { timeout: 4000, interval: 5 });
    wire.flush();
    const latest = wire.delivered.filter(frame => frame.type === 'full').at(-1)!;
    await vi.waitFor(() => expect(wire.sent.filter(frame => frame.type === 'ackSnapshot').length).toBeGreaterThan(0), { interval: 5 });
    await new Promise(resolve => setTimeout(resolve, 50));
    const acknowledgements = wire.sent.filter(frame => frame.type === 'ackSnapshot');
    expect(wire.received.filter(frame => frame.type === 'error')).toEqual([]);
    expect(acknowledgements).toHaveLength(1);
    expect(acknowledgements[0].snapshotSeq).toBe(latest.snapshotSeq);
    expect(wire.socket.readyState).toBe(NodeSocket.OPEN);
    expect(connection.getState().snapshot?.snapshotSeq).toBe(latest.snapshotSeq);
    wire.flush(); wire.held = false;
    await vi.waitFor(() => expect(wire.delivered.some(frame => frame.type === 'delta')).toBe(true), { interval: 5 });
    expect(wire.sent.filter(frame => frame.type === 'resync')).toEqual([]);
  });

  it('keeps the last acknowledged baseline through more than 64 queued deltas', async () => {
    const { connection, wire } = await browser();
    wire.flush();
    await vi.waitFor(() => expect(wire.sent.filter(frame => frame.type === 'ackSnapshot')).toHaveLength(1), { interval: 5 });
    const acknowledged = wire.sent.find(frame => frame.type === 'ackSnapshot')!.snapshotSeq;
    await vi.waitFor(() => expect(wire.received.filter(frame => frame.type === 'delta' && frame.baselineSnapshotSeq === acknowledged).length).toBeGreaterThanOrEqual(80), { timeout: 3000, interval: 5 });
    const ackCount = wire.sent.filter(frame => frame.type === 'ackSnapshot').length;
    wire.flush();
    const latest = wire.delivered.filter(frame => ['full', 'delta'].includes(String(frame.type))).at(-1)!;
    await vi.waitFor(() => expect(wire.sent.filter(frame => frame.type === 'ackSnapshot').length).toBeGreaterThan(ackCount), { interval: 5 });
    expect(wire.sent.filter(frame => frame.type === 'resync')).toEqual([]);
    expect(wire.sent.filter(frame => frame.type === 'ackSnapshot')).toHaveLength(ackCount + 1);
    expect(connection.getState().snapshot?.snapshotSeq).toBe(latest.snapshotSeq);
    expect(wire.received.filter(frame => frame.type === 'error')).toEqual([]);
  });

  it('only acknowledges the new retained scope after control transfer and a committed rewind', async () => {
    const { connection, wire, engine, tick } = await browser();
    wire.flush();
    const first = connection.getState().snapshot!;
    connection.claim();
    await vi.waitFor(() => expect(wire.received.some(frame => frame.type === 'full' && Number(frame.controllerGeneration) > first.controllerGeneration)).toBe(true), { interval: 5 });
    const afterClaim = wire.sent.length; wire.flush();
    const current = connection.getState().snapshot!;
    expect(current.controllerGeneration).toBe(first.controllerGeneration + 1);
    await vi.waitFor(() => expect(wire.sent.slice(afterClaim).some(frame => frame.type === 'ackSnapshot')).toBe(true), { interval: 5 });
    expect(wire.sent.slice(afterClaim).filter(frame => frame.type === 'ackSnapshot').every(frame => frame.controllerGeneration === current.controllerGeneration)).toBe(true);
    expect(wire.received.filter(frame => frame.type === 'error')).toEqual([]);

    await tick(3000);
    const id = String(wire.received.find(frame => frame.type === 'hello')!.connectionId);
    const command = (snapshot: Snapshot, actionId: string, type: string): Extract<ClientMessage, { type: 'action' }> => ({ protocolVersion: REALTIME_PROTOCOL,
      matchId: snapshot.matchId, epoch: snapshot.epoch, controllerGeneration: snapshot.controllerGeneration,
      type: 'action' as const, actionId, payload: { type } });
    wire.flush();
    await engine.action(id, command(engine.snapshot(id), 'save-before-scope-change', 'save'));
    await engine.action(id, command(engine.snapshot(id), 'rewind-scope-change', 'rewind'));
    await vi.waitFor(() => expect(wire.received.some(frame => frame.type === 'full' && Number(frame.epoch) > first.epoch)).toBe(true), { interval: 5 });
    const afterRewind = wire.sent.length; wire.flush();
    const restored = connection.getState().snapshot!;
    expect(restored.epoch).toBe(first.epoch + 1);
    await vi.waitFor(() => expect(wire.sent.slice(afterRewind).some(frame => frame.type === 'ackSnapshot')).toBe(true), { interval: 5 });
    expect(wire.sent.slice(afterRewind).filter(frame => frame.type === 'ackSnapshot').every(frame => frame.epoch === restored.epoch && frame.controllerGeneration === restored.controllerGeneration)).toBe(true);
  });

  it('cancels pending ACKs on close and ignores delayed events from the replaced socket', async () => {
    const { connection, wire, engine } = await browser();
    wire.flush();
    const sentBeforeClose = wire.sent.filter(frame => frame.type === 'ackSnapshot').length;
    connection.close();
    await vi.waitFor(() => expect(engine.health(true)).toMatchObject({ diagnostics: { connectedClients: 0 } }), { interval: 5 });
    await new Promise(resolve => setTimeout(resolve, 70));
    expect(wire.sent.filter(frame => frame.type === 'ackSnapshot')).toHaveLength(sentBeforeClose);

    connection.start();
    await vi.waitFor(() => expect(BrowserWire.instances).toHaveLength(2), { interval: 5 });
    const replacement = BrowserWire.instances[1];
    await vi.waitFor(() => expect(replacement.received.some(frame => frame.type === 'full')).toBe(true), { interval: 5 });
    replacement.flush();
    const current = connection.getState().snapshot!;
    // Re-deliver the actual old frames after the new transport has a snapshot.
    // An old socket event must not overwrite the new scope or create an ACK.
    for (const frame of wire.received) wire.onmessage?.({ data: JSON.stringify(frame) });
    expect(connection.getState().snapshot).toBe(current);
    await vi.waitFor(() => expect(replacement.sent.filter(frame => frame.type === 'ackSnapshot')).toHaveLength(1), { interval: 5 });
    expect(replacement.sent.find(frame => frame.type === 'ackSnapshot')).toMatchObject({ snapshotSeq: current.snapshotSeq, epoch: current.epoch, controllerGeneration: current.controllerGeneration });
    expect(wire.sent.filter(frame => frame.type === 'ackSnapshot')).toHaveLength(sentBeforeClose);
  });
});
