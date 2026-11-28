import { parentPort, workerData } from 'node:worker_threads';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { createTyagaAdapter } from '@iva-games/tyaga/server';
import { RealtimeError } from '@iva-games/realtime-kit';
import { RealtimeEngine } from './engine.js';
import { LocalRuntimeClient, failure } from './rpc.js';
import type { EngineMethod, Failure } from './rpc.js';
import type { StorageClient } from './storage.js';
import { WORKER_PROTOCOL } from './artifacts.js';
import { SnapshotEncoder, STATIC_VIEW_TRANSFER, snapshotConnection } from './snapshot-transfer.js';
import type { Snapshot } from '@iva-games/realtime-kit';

const port = parentPort;
if (!port) throw new Error('Simulation requires worker_threads');
let serial = 0;
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>();
const storage: StorageClient = {
  call(method, ...args) {
    return new Promise((resolve, reject) => {
      const id = ++serial;
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      port.postMessage({ type: 'storage', id, method, args });
    });
  },
};
let queue = Promise.resolve();
let ticking = false;
let queuedCalls = 0;
let engine: RealtimeEngine;
let staticTransfer = false;
const snapshots = new SnapshotEncoder();
const loopDelay = monitorEventLoopDelay({ resolution: 10 }); loopDelay.enable();
function health(includeDiagnostics: boolean): unknown {
  const value = engine.health(includeDiagnostics) as { diagnostics: Record<string, unknown> };
  if (!includeDiagnostics) return value;
  const memory = process.memoryUsage();
  return { ...value, diagnostics: { ...value.diagnostics, queuedCalls, writerRequests: pending.size,
    eventLoop: { delaySamples: loopDelay.count, p99DelayMs: loopDelay.count ? loopDelay.percentile(99) / 1e6 : null,
      maxDelayMs: loopDelay.count ? loopDelay.max / 1e6 : null, utilization: performance.eventLoopUtilization() },
    memory: { heapUsed: memory.heapUsed, heapTotal: memory.heapTotal, external: memory.external, arrayBuffers: memory.arrayBuffers } } };
}
port.on('message', (message: { type: string; id: number; method: EngineMethod; args: unknown[]; value: unknown; error?: Failure }) => {
  if (message.type === 'storageResult') {
    const call = pending.get(message.id); if (!call) return;
    pending.delete(message.id);
    if (message.error) call.reject(new RealtimeError(message.error.code, message.error.statusCode, message.error.details)); else call.resolve(message.value);
    return;
  }
  // Read-only telemetry stays available during a pending durable write. It
  // exposes no world view and does not bypass the authoritative commit barrier.
  if (message.method === 'health' && engine) { port.postMessage({ type: 'result', id: message.id, value: health(message.args[0] === true) }); return; }
  queuedCalls += 1;
  queue = queue.then(async () => {
    try {
      const runtime = new LocalRuntimeClient(engine);
      let value = await runtime.call(message.method, ...(message.args as Parameters<RealtimeEngine[EngineMethod]>)) as unknown;
      const connectionId = snapshotConnection(message.method, message.args);
      if (staticTransfer && connectionId) value = snapshots.encode(connectionId, value as Snapshot, engine.immutableViewFields(connectionId));
      if (message.method === 'disconnect') snapshots.delete(message.args[0] as string);
      if (message.method === 'drain') snapshots.clear();
      port.postMessage({ type: 'result', id: message.id, value });
    } catch (error) { port.postMessage({ type: 'result', id: message.id, error: failure(error) }); }
    finally { queuedCalls -= 1; }
  });
});
try {
  const options = workerData as { maxMatches: number; artifactFingerprint: string; workerProtocol: string; snapshotTransfer?: string };
  if (options.workerProtocol !== WORKER_PROTOCOL || !/^[a-f0-9]{64}$/.test(options.artifactFingerprint)) throw new Error('Invalid runtime artifact fingerprint or protocol');
  staticTransfer = options.snapshotTransfer === STATIC_VIEW_TRANSFER;
  const adapter = await createTyagaAdapter();
  adapter.runtimeArtifactId = `${adapter.runtimeArtifactId}:${options.artifactFingerprint}`;
  engine = new RealtimeEngine({ storage, adapters: [adapter], maxMatches: options.maxMatches, ownedArtifactIds: [adapter.runtimeArtifactId], cloneViews: false });
  await engine.initialize();
  setInterval(() => {
    if (ticking) return;
    ticking = true;
    queue = queue.then(() => engine.tick()).catch(() => {}).finally(() => { ticking = false; });
  // Two fixed 60 Hz Tyaga steps per durable batch (one 30 Hz Forpost step).
  // Engine accumulation remains monotonic with its four/two-step catch-up cap.
  }, 1000 / Math.min(adapter.tickRate, 30)).unref();
  port.postMessage({ type: 'ready' });
} catch (error) { port.postMessage({ type: 'fatal', error: failure(error) }); }
