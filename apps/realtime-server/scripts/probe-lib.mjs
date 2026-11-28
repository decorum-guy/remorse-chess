/** Isolated real-process QA helpers. No production credentials or accounts. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rename, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { sourceIdentity as identifySource } from './source-identity.mjs';
export const root = resolve(process.env.FORPOST_QA_SOURCE_DIRECTORY ?? fileURLToPath(new URL('../../../', import.meta.url)));
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const isSnapshot = message => message.type === 'full' || message.type === 'delta';
export async function freePort() { const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const port = server.address().port; await new Promise(r => server.close(r)); return port; }
export async function writeReport(path, report) { const temporary = path + '.tmp'; await writeFile(temporary, JSON.stringify(report, null, 2) + '\n'); await rename(temporary, path); }
export async function sourceIdentity() {
  return identifySource(root, process.env.FORPOST_QA_SOURCE_TRACE);
}
export async function startRig({ prefix, port, publicOrigin, maxRooms = 4, capacityFixture } = {}) {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(prefix)) throw new Error('INVALID_QA_PREFIX');
  const output = resolve(process.env.FORPOST_QA_OUTPUT_DIRECTORY ?? resolve(root, '.qa'));
  await mkdir(output, { recursive: true }); const directory = await mkdtemp(resolve(output, prefix + '-'));
  const databaseDirectory = resolve(directory, 'store'); await mkdir(databaseDirectory, { mode: 0o700 });
  let capacityPath = '';
  if (capacityFixture) {
    if (process.env.NODE_ENV !== 'test' || capacityFixture.source !== 'test-fixture') throw new Error('EXPLICIT_QA_FIXTURE_REQUIRED');
    capacityPath = resolve(directory, 'capacity-fixture.json'); await writeFile(capacityPath, JSON.stringify(capacityFixture, null, 2) + '\n');
  }
  port ??= await freePort(); const endpoint = `http://127.0.0.1:${port}`, origin = publicOrigin ?? endpoint;
  let logs = '', cookie = ''; const sourceTrace = await sourceIdentity();
  const runtimeEntry = resolve(process.env.FORPOST_QA_RUNTIME_ENTRY ?? resolve(root, 'dist-realtime/main.js'));
  const staticDirectory = resolve(process.env.FORPOST_QA_CLIENT_DIRECTORY ?? resolve(root, 'games/forpost/dist'));
  const expectedBuild = process.env.FORPOST_QA_EXPECTED_BUILD_SHA;
  if (expectedBuild && (sourceTrace.gitCommit !== expectedBuild || sourceTrace.dirty || !sourceTrace.providedTraceVerified)) throw new Error('IMAGE_SOURCE_IDENTITY_REQUIRED');
  const retentionIdentity = process.env.FORPOST_QA_RETENTION_IDENTITY ? JSON.parse(process.env.FORPOST_QA_RETENTION_IDENTITY) : null;
  const processHandle = spawn(process.execPath, [runtimeEntry], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, REALTIME_PORT: String(port), REALTIME_HOST: '127.0.0.1', REALTIME_PUBLIC_ORIGIN: origin, REALTIME_MAX_ROOMS: String(maxRooms),
      REALTIME_DATABASE_PATH: resolve(databaseDirectory, 'realtime.sqlite'), REALTIME_PRACTICE_KEY_PATH: resolve(databaseDirectory, 'practice.pem'),
      REALTIME_TRUSTED_KEYS_PATH: '', REALTIME_CAPACITY_PROFILE_PATH: capacityPath, REALTIME_STATIC_DIRECTORY: staticDirectory,
      IVA_BUILD_SHA: process.env.IVA_BUILD_SHA ?? sourceTrace.gitCommit } });
  for (const stream of [processHandle.stdout, processHandle.stderr]) stream.on('data', data => { logs = (logs + data.toString()).slice(-8000); });
  let spawnError = null;
  processHandle.on('error', error => { spawnError = error; });
  const hasExited = () => processHandle.exitCode !== null || processHandle.signalCode !== null;
  const rig = { directory, endpoint, origin, processHandle, sourceTrace, retentionIdentity,
    async health() { const response = await fetch(endpoint + '/health/ready', { signal: AbortSignal.timeout(10_000) }); return await response.json(); },
    async post(path, body = {}) {
      const response = await fetch(origin + path, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
      if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
      const result = await response.json(); if (!response.ok) { const error = new Error(`${path}: ${response.status} ${result.error?.code}`); error.code = result.error?.code ?? 'HTTP_FAILED'; error.status = response.status; throw error; } return result;
    },
    async stop() {
      if (hasExited()) { if (processHandle.exitCode !== 0) throw new Error('QA_SERVER_EXITED'); return; }
      const stopped = once(processHandle, 'exit'); processHandle.kill('SIGTERM');
      let timer;
      try {
        const result = await Promise.race([stopped, new Promise(resolve => { timer = setTimeout(() => resolve(null), 40_000); })]);
        if (!result) { processHandle.kill('SIGKILL'); await stopped; throw new Error('QA_DRAIN_TIMEOUT'); }
        if (result[0] !== 0) throw new Error('QA_DRAIN_FAILED');
      } finally { clearTimeout(timer); }
    },
    logs: () => logs,
  };
  const startupDeadline = performance.now() + 30_000;
  while (performance.now() < startupDeadline) {
    try {
      const response = await fetch(endpoint + '/health/ready', { signal: AbortSignal.timeout(1000) });
      if (response.ok) {
        const health = await response.json();
        if (expectedBuild && (health.buildRevision !== expectedBuild || process.env.IVA_BUILD_SHA !== expectedBuild ||
          !retentionIdentity || retentionIdentity.buildRevision !== expectedBuild || retentionIdentity.current?.runtime !== health.artifactId ||
          retentionIdentity.current?.client !== health.contentId)) {
          await rig.stop(); throw new Error('IMAGE_BUILD_IDENTITY_MISMATCH');
        }
        return rig;
      }
    } catch (error) { if (error.message === 'IMAGE_BUILD_IDENTITY_MISMATCH') throw error; /* startup */ }
    if (hasExited() || spawnError) throw new Error('QA_SERVER_EXITED'); await sleep(100);
  }
  await rig.stop(); throw new Error('QA_STARTUP_TIMEOUT');
}
export async function connectClient(rig, ticket, onMessage = () => {}) {
  const ws = new WebSocket(rig.origin.replace('http:', 'ws:') + '/ws/realtime/v1', 'iva-realtime-v1', { origin: rig.origin, handshakeTimeout: 10_000 });
  const messages = [], baselines = new Map(); let beat = null, hello = null, error = null, closed = false;
  const client = { ws, messages, get hello() { return hello; }, get error() { return error; }, get closed() { return closed; },
    send(type, extra = {}) { if (hello && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type, protocolVersion: 1, matchId: hello.matchId, epoch: hello.epoch, controllerGeneration: hello.controllerGeneration, ...extra })); },
    close() { clearInterval(beat); ws.close(); },
    async wait(predicate, timeout = 12_000) {
      const deadline = performance.now() + timeout;
      while (performance.now() < deadline) {
        if (error) throw error; const index = messages.findIndex(predicate); if (index >= 0) return messages.splice(index, 1)[0]; await sleep(10);
      }
      throw new Error('Socket timeout: ' + messages.map(m => m.type + (m.code ? ':' + m.code : '')).slice(-12).join(','));
    },
  };
  ws.on('error', caught => { error = caught; });
  ws.on('message', data => {
    try {
      const message = JSON.parse(data.toString());
      if (message.type === 'hello') { hello = message; baselines.clear(); beat = setInterval(() => client.send('heartbeat'), 1000); }
      if (message.type === 'controlChanged' && hello) { hello.controllerGeneration = message.controllerGeneration; hello.controlling = message.controlling; }
      if (isSnapshot(message)) {
        if (message.type === 'delta') {
          const baseline = baselines.get(message.baselineSnapshotSeq); assert.ok(baseline, 'delta baseline belongs to this observer');
          assert.equal(message.view, undefined); message.view = { ...baseline, ...message.patch };
        }
        for (const field of ['seed', 'idSalt', 'history', 'receipts', 'rewindTicks', 'botRandom']) assert.equal(message.view[field], undefined, 'private world field: ' + field);
        baselines.set(message.snapshotSeq, message.view); while (baselines.size > 32) baselines.delete(baselines.keys().next().value);
        client.send('ackSnapshot', { snapshotSeq: message.snapshotSeq });
      }
      messages.push(message); while (messages.length > 128) messages.shift(); onMessage(message, client);
    } catch (caught) { error = caught; client.close(); }
  });
  ws.on('close', () => { closed = true; clearInterval(beat); });
  try {
    await once(ws, 'open'); ws.send(JSON.stringify({ type: 'authenticate', ticket }));
    await client.wait(message => message.type === 'hello'); return client;
  } catch (caught) { client.close(); throw caught; }
}
