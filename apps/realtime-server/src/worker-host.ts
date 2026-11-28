import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { REALTIME_PROTOCOL, RealtimeError, checkJson, identifier } from '@iva-games/realtime-kit';
import type { TicketClaims } from '@iva-games/realtime-kit';
import type { StartMatchRequest } from '@iva-games/session-kit';
import type { RealtimeEngine } from './engine.js';
import type { EngineMethod, Failure, RuntimeClient } from './rpc.js';
import type { RealtimeStore, StorageClient, StorageMethod, StoredMatch } from './storage.js';
import { WORKER_PROTOCOL, archiveCurrentArtifact, readArtifact } from './artifacts.js';
import type { RuntimeArtifact } from './artifacts.js';
import type { ClientReference } from './client-content.js';
import { fingerprint } from './crypto.js';
import { SnapshotDecoder, STATIC_VIEW_TRANSFER, snapshotConnection } from './snapshot-transfer.js';

interface Pending { resolve: (value: unknown) => void; reject: (error: unknown) => void }
interface Simulation { worker: Worker; ready: Promise<void>; pending: Map<number, Pending>; failed: boolean; intentionalStop: boolean; artifact: RuntimeArtifact }
interface Health { ok: boolean; failedMatches: number; service: string; protocolVersion: string; runtimeArtifactIds: string[];
  games: unknown[]; capacity: number; activeMatches: number; draining: boolean;
  unavailableMatches?: number;
  recoveringWorkers?: number; failedWorkers?: number; workerRestarts?: number; queuedStarts?: number;
  diagnostics?: unknown;
  metrics: { steps: number; commits: number; maxStepMs: number; maxCommitMs: number; failures: number; startedAt: number;
    overloadPauses?: number; overloadRecurrences?: number; overloadMeasuredWorkers?: number } }

/** The one SQLite writer is shared by preallocated versioned simulation workers.
 * Old matches keep their exact local artifact; a deployed update supplies the
 * worker used for new rooms, without migrating a running physics world. */
export class WorkerHost implements RuntimeClient {
  private writer: Worker;
  private serial = 0;
  private writerPending = new Map<number, Pending>();
  private simulations = new Map<string, Simulation>();
  private matchArtifacts = new Map<string, string>();
  private connectionArtifacts = new Map<string, string>();
  private snapshots = new SnapshotDecoder();
  private unavailable = new Map<string, StoredMatch>();
  private compiledDirectory: string;
  private currentArtifact!: string;
  private archiveDirectory!: string;
  private recoveries = new Map<string, Promise<void>>();
  private restartHistory = new Map<string, number[]>();
  private lastHealth = new Map<string, Health>();
  private workerRestarts = 0;
  private failed = false;
  private closing = false;
  private drained = false;
  private draining = false;
  private drainingWork: Promise<void> | null = null;
  private drainFailed = false;
  private cancellingDrain: Promise<void> | null = null;
  private createQueue: Promise<unknown> = Promise.resolve();
  readonly ready: Promise<void>;
  readonly storage: StorageClient;
  constructor(private readonly options: { databasePath: string; maxMatches: number; artifactDirectory?: string;
    clients?: Record<string, ClientReference>; availableClientHashes?: string[] }) {
    const location = fileURLToPath(new URL('.', import.meta.url));
    const compiled = [location, dirname(location)].find(path => existsSync(join(path, 'simulation-worker.js')) && existsSync(join(path, 'writer-worker.js')));
    if (!compiled) throw new RealtimeError('ARTIFACT_UNAVAILABLE', 503);
    this.compiledDirectory = compiled;
    this.writer = new Worker(join(compiled, 'writer-worker.js'), { workerData: { databasePath: options.databasePath } });
    this.storage = { call: (method, ...args) => this.storeCall(method, args) };
    this.writer.on('message', (message: { id: number; value: unknown; error?: Failure }) => {
      const call = this.writerPending.get(message.id); if (!call) return;
      this.writerPending.delete(message.id);
      if (message.error) call.reject(new RealtimeError(message.error.code, message.error.statusCode, message.error.details)); else call.resolve(message.value);
    });
    const writerFailed = (): void => {
      if (this.closing) return;
      this.failed = true;
      for (const call of this.writerPending.values()) call.reject(new RealtimeError('STORAGE_UNAVAILABLE', 503));
      this.writerPending.clear();
    };
    this.writer.on('error', writerFailed); this.writer.on('exit', writerFailed);
    this.ready = this.initialize();
  }
  private async initialize(): Promise<void> {
    const archive = this.options.artifactDirectory ?? join(dirname(this.options.databasePath), 'runtime-artifacts');
    this.archiveDirectory = archive;
    const current = archiveCurrentArtifact(this.compiledDirectory, archive);
    this.currentArtifact = current.sha256;
    const required = new Map<string, RuntimeArtifact>([[current.sha256, current]]);
    for (const stored of await this.storage.call('all')) {
      if (stored.manifest.clientContentHash && this.options.availableClientHashes && !this.options.availableClientHashes.includes(stored.manifest.clientContentHash)) {
        this.unavailable.set(stored.matchId, stored); await this.storage.call('markRecoveryFailure', stored.matchId, 'CLIENT_CONTENT_UNAVAILABLE', Date.now()); continue;
      }
      const sha256 = stored.manifest.runtimeArtifactId.match(/:([a-f0-9]{64})$/)?.[1];
      if (!sha256) { this.unavailable.set(stored.matchId, stored); await this.storage.call('markRecoveryFailure', stored.matchId, 'VERSION_UNAVAILABLE', Date.now()); continue; }
      if (!required.has(sha256)) {
        try { required.set(sha256, readArtifact(archive, sha256)); }
        catch { this.unavailable.set(stored.matchId, stored); await this.storage.call('markRecoveryFailure', stored.matchId, 'VERSION_UNAVAILABLE', Date.now()); continue; }
      }
      this.matchArtifacts.set(stored.matchId, sha256);
    }
    for (const artifact of required.values()) this.spawnSimulation(artifact);
    await Promise.all([...this.simulations.values()].map(async simulation => {
      try { await simulation.ready; }
      catch (error) { const recovering = this.recoveries.get(simulation.artifact.sha256); if (!recovering) throw error; await recovering; }
    }));
  }
  private spawnSimulation(artifact: RuntimeArtifact): void {
    const worker = new Worker(artifact.workerPath, { workerData: {
      maxMatches: this.options.maxMatches, artifactFingerprint: artifact.sha256, workerProtocol: WORKER_PROTOCOL,
      snapshotTransfer: STATIC_VIEW_TRANSFER,
    } });
    let accept!: () => void, refuse!: (error: unknown) => void;
    const simulation: Simulation = { worker, pending: new Map(), failed: false, intentionalStop: false, artifact,
      ready: new Promise<void>((resolve, reject) => { accept = resolve; refuse = reject; }) };
    this.simulations.set(artifact.sha256, simulation);
    const fail = (error = new RealtimeError('WORKER_UNAVAILABLE', 503)): void => {
      if (this.closing || simulation.intentionalStop || simulation.failed || this.simulations.get(artifact.sha256) !== simulation) return;
      simulation.failed = true; refuse(error);
      for (const call of simulation.pending.values()) call.reject(error);
      simulation.pending.clear();
      for (const [connectionId, owner] of this.connectionArtifacts) if (owner === artifact.sha256) { this.connectionArtifacts.delete(connectionId); this.snapshots.delete(connectionId); }
      this.recoverWorker(artifact.sha256);
    };
    worker.on('message', (message: { type: string; id: number; method: StorageMethod; args: unknown[]; value: unknown; error?: Failure }) => {
      if (message.type === 'ready') { accept(); return; }
      if (message.type === 'fatal') { fail(new RealtimeError(message.error?.code ?? 'WORKER_FAILED', 503)); return; }
      if (message.type === 'storage') {
        void this.storeCall(message.method, message.args).then(value => worker.postMessage({ type: 'storageResult', id: message.id,
          value: message.method === 'all' ? (value as StoredMatch[]).filter(match => !this.unavailable.has(match.matchId)) : value }),
          error => worker.postMessage({ type: 'storageResult', id: message.id, error: { code: error instanceof RealtimeError ? error.code : 'STORAGE_FAILED', statusCode: 503 } }));
        return;
      }
      const call = simulation.pending.get(message.id); if (!call) return;
      simulation.pending.delete(message.id);
      if (message.error) call.reject(new RealtimeError(message.error.code, message.error.statusCode, message.error.details)); else call.resolve(message.value);
    });
    worker.on('error', () => fail()); worker.on('exit', () => fail());
  }
  private recoverWorker(sha256: string): void {
    if (this.recoveries.has(sha256) || this.closing || this.drained || this.failed) return;
    const operation = (async () => {
      let lastError: unknown = new RealtimeError('WORKER_UNAVAILABLE', 503);
      for (let attempt = 0; attempt < 3; attempt++) {
        const history = (this.restartHistory.get(sha256) ?? []).filter(at => at > Date.now() - 60_000);
        if (history.length >= 3) throw new RealtimeError('WORKER_RESTART_LIMIT', 503);
        history.push(Date.now()); this.restartHistory.set(sha256, history);
        const previous = this.simulations.get(sha256);
        if (previous) { previous.intentionalStop = true; await previous.worker.terminate(); }
        // The old thread may have committed just before it died. Do not edit or
        // steal its fence: wait out the longest possible 15-second writer lease.
        await new Promise<void>(resolve => setTimeout(resolve, 15_100));
        if (this.closing || this.drained || this.failed) throw new RealtimeError('SERVER_UPDATING', 503);
        try {
          const artifact = readArtifact(this.archiveDirectory, sha256);
          this.spawnSimulation(artifact); this.workerRestarts += 1;
          const replacement = this.simulations.get(sha256)!;
          await replacement.ready;
          if (replacement.failed) throw new RealtimeError('WORKER_UNAVAILABLE', 503);
          return;
        } catch (error) { lastError = error; }
      }
      throw lastError;
    })();
    this.recoveries.set(sha256, operation);
    // Every caller observes explicit unavailability during recovery; a failed
    // bounded retry remains visible in health instead of an unhandled promise.
    void operation.then(() => this.recoveries.delete(sha256), () => this.recoveries.delete(sha256));
  }
  private storeCall<M extends StorageMethod>(method: M, args: unknown[]): Promise<Awaited<ReturnType<RealtimeStore[M]>>> {
    if (this.failed) return Promise.reject(new RealtimeError('STORAGE_UNAVAILABLE', 503));
    return new Promise((resolve, reject) => {
      const id = ++this.serial; this.writerPending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.writer.postMessage({ id, method, args });
    });
  }
  private async invoke<M extends EngineMethod>(artifact: string, method: M, args: Parameters<RealtimeEngine[M]>): Promise<Awaited<ReturnType<RealtimeEngine[M]>>> {
    const simulation = this.simulations.get(artifact);
    if (!simulation || simulation.failed || this.failed) throw new RealtimeError(this.recoveries.has(artifact) ? 'WORKER_RECOVERING' : 'WORKER_UNAVAILABLE', 503);
    await simulation.ready;
    const value = await new Promise<unknown>((resolve, reject) => {
      const id = ++this.serial; simulation.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      simulation.worker.postMessage({ type: 'call', id, method, args });
    });
    const connectionId = snapshotConnection(method, args);
    return (connectionId ? this.snapshots.decode(connectionId, value) : value) as Awaited<ReturnType<RealtimeEngine[M]>>;
  }
  private async health(includeDiagnostics = false): Promise<Health> {
    const reports: Health[] = [];
    let unavailableWorkers = 0;
    for (const artifact of this.simulations.keys()) {
      try { const report = await this.invoke(artifact, 'health', [includeDiagnostics]) as Health; reports.push(report); this.lastHealth.set(artifact, report); }
      catch { unavailableWorkers += 1; const prior = this.lastHealth.get(artifact); if (prior) reports.push({ ...prior, ok: false }); }
    }
    const current = reports[0];
    return { ...current, service: 'iva-realtime', protocolVersion: REALTIME_PROTOCOL,
      ok: unavailableWorkers === 0 && reports.length > 0 && reports.every(report => report.ok) && !this.failed && !this.draining,
      failedMatches: reports.reduce((sum, report) => sum + report.failedMatches, 0),
      runtimeArtifactIds: reports.flatMap(report => report.runtimeArtifactIds), games: reports.flatMap(report => report.games),
      capacity: this.options.maxMatches, activeMatches: reports.reduce((sum, report) => sum + report.activeMatches, 0),
      recoveringWorkers: this.recoveries.size, failedWorkers: unavailableWorkers, workerRestarts: this.workerRestarts,
      queuedStarts: await this.storage.call('admissionCount'),
      unavailableMatches: this.unavailable.size + reports.reduce((sum, report) => sum + (report.unavailableMatches ?? 0), 0),
      draining: this.draining || reports.some(report => report.draining),
      ...(includeDiagnostics ? { diagnostics: { instrumentedWorkers: reports.filter(report => report.diagnostics !== undefined).length,
        legacyWorkers: reports.filter(report => report.diagnostics === undefined).length,
        writerPending: this.writerPending.size, workers: reports.map(report => ({ runtimeArtifactIds: report.runtimeArtifactIds, diagnostics: report.diagnostics ?? null })) } } : {}), metrics: {
        steps: reports.reduce((sum, report) => sum + report.metrics.steps, 0),
        commits: reports.reduce((sum, report) => sum + report.metrics.commits, 0),
        failures: reports.reduce((sum, report) => sum + report.metrics.failures, 0),
        overloadPauses: reports.reduce((sum, report) => sum + (report.metrics.overloadPauses ?? 0), 0),
        overloadRecurrences: reports.reduce((sum, report) => sum + (report.metrics.overloadRecurrences ?? 0), 0),
        // Retained older workers do not retroactively gain instrumentation.
        overloadMeasuredWorkers: reports.filter(report => report.metrics.overloadPauses !== undefined).length,
        maxStepMs: Math.max(0, ...reports.map(report => report.metrics.maxStepMs)),
        maxCommitMs: Math.max(0, ...reports.map(report => report.metrics.maxCommitMs)),
        startedAt: Math.min(Date.now(), ...reports.map(report => report.metrics.startedAt)),
      } };
  }
  private async create(gameId: string, input: StartMatchRequest, context?: { hostPlayerId?: string }): Promise<{ matchId: string }> {
    if (this.draining) throw new RealtimeError('SERVER_UPDATING', 503);
    checkJson(input);
    const prior = await this.storage.call('byStart', input.startCommandId);
    if (prior && this.unavailable.has(prior.matchId)) {
      if (prior.startHash !== fingerprint({ gameId, input })) throw new RealtimeError('START_ID_REUSED', 409);
      return { matchId: prior.matchId };
    }
    const artifact = prior ? this.matchArtifacts.get(prior.matchId) : this.currentArtifact;
    if (!artifact) throw new RealtimeError('ARTIFACT_UNAVAILABLE', 503);
    let admission: { hostPlayerId: string; reservationId: string; clientContentHash?: string; clientRoute?: string } | undefined;
    if (!prior) {
      const hostPlayerId = context?.hostPlayerId ?? input.hostPlayerId;
      if (!identifier(hostPlayerId) || !input.participants?.some(participant => participant.controller?.kind === 'human' && participant.playerId === hostPlayerId)) throw new RealtimeError('INVALID_HOST', 400);
      const reserved = await this.storage.call('queueAdmission', gameId, input, hostPlayerId, this.options.maxMatches, Date.now());
      if (!reserved.reservationId) throw new RealtimeError('ADMISSION_QUEUED', 503, { position: reserved.position, retryAfterMs: 1000 });
      admission = { hostPlayerId, reservationId: reserved.reservationId };
      const client = this.options.clients?.[gameId];
      if (client) { admission.clientContentHash = client.sha256; admission.clientRoute = client.route; }
    }
    const result = await this.invoke(artifact, 'create', [gameId, input, admission]);
    this.matchArtifacts.set(result.matchId, artifact);
    return result;
  }
  private async cancelDrain(): Promise<void> {
    if (this.drainingWork) await this.drainingWork;
    if (this.drainFailed) throw new RealtimeError('DRAIN_FAILED', 503);
    if (this.cancellingDrain) return this.cancellingDrain;
    if (!this.drained) return;
    this.cancellingDrain = (async () => {
      const artifacts = [...this.simulations.values()].map(simulation => simulation.artifact);
      await Promise.all([...this.simulations.values()].map(simulation => { simulation.intentionalStop = true; return simulation.worker.terminate(); }));
      this.simulations.clear(); this.connectionArtifacts.clear(); this.snapshots.clear();
      for (const artifact of artifacts) this.spawnSimulation(artifact);
      await Promise.all([...this.simulations.values()].map(simulation => simulation.ready));
      this.drained = false; this.draining = false;
    })();
    try { await this.cancellingDrain; } finally { this.cancellingDrain = null; }
  }
  async call<M extends EngineMethod>(method: M, ...args: Parameters<RealtimeEngine[M]>): Promise<Awaited<ReturnType<RealtimeEngine[M]>>> {
    await this.ready;
    let result: unknown;
    if (method === 'health') result = await this.health(args[0] === true);
    else if (method === 'create') {
      const creating = this.createQueue.then(() => this.create(...args as [string, StartMatchRequest, { hostPlayerId?: string }?]));
      this.createQueue = creating.catch(() => {}); result = await creating;
    } else if (method === 'cancelDrain') {
      await this.cancelDrain();
    } else if (method === 'drain') {
      if (this.drained) return undefined as Awaited<ReturnType<RealtimeEngine[M]>>;
      this.draining = true;
      if (!this.drainingWork) this.drainingWork = (async () => {
        try {
          await this.createQueue;
          await Promise.all([...this.recoveries.values()]);
          await Promise.all([...this.simulations.keys()].map(artifact => this.invoke(artifact, 'drain', [])));
          this.drained = true; this.drainFailed = false; this.connectionArtifacts.clear(); this.snapshots.clear();
        } catch (error) { this.drainFailed = true; throw error; }
      })();
      try { await this.drainingWork; } finally { this.drainingWork = null; }
    } else if (method === 'admissions') {
      await Promise.all([...this.simulations.keys()].map(artifact => this.invoke(artifact, method, args)));
    } else if (method === 'connect') {
      if (this.draining) throw new RealtimeError('SERVER_UPDATING', 503);
      const [claims, connectionId] = args as [TicketClaims, string];
      if (this.unavailable.has(claims.matchId)) throw new RealtimeError('VERSION_UNAVAILABLE', 409);
      const artifact = this.matchArtifacts.get(claims.matchId);
      if (!artifact) throw new RealtimeError('MATCH_UNAVAILABLE', 404);
      result = await this.invoke(artifact, method, args);
      this.connectionArtifacts.set(connectionId, artifact);
    } else {
      const byMatch = ['status', 'participant', 'acknowledgeResult'].includes(method);
      const id = args[0] as string;
      const missing = byMatch ? this.unavailable.get(id) : undefined;
      if (missing) {
        if (method === 'status') return { finished: ['finished', 'abandoned'].includes(missing.meta.phase),
          ...(missing.meta.outcome ? { outcome: missing.meta.outcome } : {}), phase: 'failed-recoverable', recoverableError: 'VERSION_UNAVAILABLE',
          manifest: missing.manifest, rosterHash: missing.rosterHash, roomId: missing.start.roomId } as Awaited<ReturnType<RealtimeEngine[M]>>;
        if (method === 'acknowledgeResult') return await this.storage.call('acknowledgeResult', id, args[1] as string) as Awaited<ReturnType<RealtimeEngine[M]>>;
        if (!missing.start.participants.some(participant => participant.playerId === args[1] && participant.controller.kind === 'human')) throw new RealtimeError('MATCH_UNAVAILABLE', 403);
        throw new RealtimeError('VERSION_UNAVAILABLE', 409);
      }
      const artifact = (byMatch ? this.matchArtifacts : this.connectionArtifacts).get(id);
      if (!artifact) {
        if (method === 'disconnect') { this.snapshots.delete(id); return undefined as Awaited<ReturnType<RealtimeEngine[M]>>; }
        throw new RealtimeError(byMatch ? 'MATCH_UNAVAILABLE' : 'AUTH_FAILED', byMatch ? 404 : 401);
      }
      try { result = await this.invoke(artifact, method, args); }
      finally { if (method === 'disconnect') { this.connectionArtifacts.delete(id); this.snapshots.delete(id); } }
    }
    return result as Awaited<ReturnType<RealtimeEngine[M]>>;
  }
  async close(): Promise<void> {
    await this.call('drain');
    this.closing = true;
    await this.storage.call('close');
    await Promise.all([...this.simulations.values()].map(simulation => { simulation.intentionalStop = true; return simulation.worker.terminate(); }));
    await this.writer.terminate();
  }
}
