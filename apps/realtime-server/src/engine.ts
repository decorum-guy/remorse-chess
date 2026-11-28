import { randomUUID } from 'node:crypto';
import { BOT_TAKEOVER_MS, EMPTY_PAUSE_MS, INPUT_TIMEOUT_MS, REALTIME_PROTOCOL, RETURN_WINDOW_MS, RealtimeError, checkJson, identifier } from '@iva-games/realtime-kit';
import type { ClientMessage, ControllerState, GameAdapter, RuntimeManifest, Snapshot, StepContext, TicketClaims } from '@iva-games/realtime-kit';
import type { StartMatchRequest } from '@iva-games/session-kit';
import type { Commit, StorageClient, StoredMatch, StoredMeta, StoredReceipt } from './storage.js';
import { fingerprint, hash } from './crypto.js';
import { GameTimings } from './metrics.js';

interface Control extends ControllerState {
  connectionId: string | null; input: unknown; lastInputAt: number;
  lastActiveAt: number; inputSeq: number; consumedSeq: number;
}
interface Connection {
  id: string; matchId: string; participantId: string; playerId: string; sessionId: string;
  validUntil: number; snapshotSeq: number; lastSignal: number;
}
interface ActiveMatch {
  stored: StoredMatch; world: unknown; adapter: GameAdapter; controls: Map<string, Control>;
  lastHumanAt: number; lastMono: number; accumulator: number;
  lastSnapshotTick: number; lastLeaseAt: number; frozen: boolean;
  healthySince: number | null;
  committedAt: number; dirtySince: number | null;
  lastStepMs: number; lastBatchStepMs: number; lastBatchSteps: number;
  lastSerializeMs: number; lastCommitMs: number;
}
interface OverloadObservation {
  kind: 'pause' | 'recurred'; observedAt: number; worldTick: number;
  schedulerGapMs: number; accumulatedLagMs: number; stepIntervalMs: number; maxCatchUpSteps: number;
  lastStepMs: number; lastBatchStepMs: number; lastBatchSteps: number; lastSerializeMs: number; lastCommitMs: number;
}
export interface EngineOptions {
  storage: StorageClient; adapters: GameAdapter[]; ownerId?: string;
  maxMatches?: number; wallNow?: () => number; monoNow?: () => number;
  /** A versioned worker owns only its exact archived runtime's matches. */
  ownedArtifactIds?: string[];
  /** Worker postMessage immediately clones the returned view before any next
   * queued mutation. Direct in-process adapters retain defensive cloning. */
  cloneViews?: boolean;
}
interface ReplayStep { inputs: Record<string, unknown>; context: StepContext }
export class RealtimeEngine {
  private readonly matches = new Map<string, ActiveMatch>();
  private readonly connections = new Map<string, Connection>();
  private readonly unavailable = new Map<string, { stored: StoredMatch; code: string }>();
  private readonly adapters: Map<string, GameAdapter>;
  readonly ownerId: string;
  readonly maxMatches: number;
  private draining = false;
  private drained = false;
  private readonly wall: () => number;
  private readonly mono: () => number;
  private readonly storage: StorageClient;
  private ready = false;
  private readonly ownedArtifactIds?: Set<string>;
  private readonly cloneViews: boolean;
  private readonly timings = new Map<string, GameTimings>();
  private readonly lastOverloads = new Map<string, OverloadObservation>();
  readonly metrics = { steps: 0, commits: 0, maxStepMs: 0, maxCommitMs: 0, failures: 0, overloadPauses: 0, overloadRecurrences: 0, startedAt: Date.now() };
  constructor(options: EngineOptions) {
    this.storage = options.storage; this.adapters = new Map(options.adapters.map(adapter => [`${adapter.gameId}:${adapter.rulesVersion}:${adapter.contentVersion}`, adapter]));
    this.ownerId = options.ownerId ?? randomUUID(); this.maxMatches = options.maxMatches ?? 4;
    this.wall = options.wallNow ?? Date.now; this.mono = options.monoNow ?? (() => performance.now());
    this.ownedArtifactIds = options.ownedArtifactIds ? new Set(options.ownedArtifactIds) : undefined;
    this.cloneViews = options.cloneViews !== false;
    for (const adapter of options.adapters) this.timings.set(adapter.gameId, new GameTimings());
  }
  private adapter(gameId: string, rulesVersion: string, contentVersion: string): GameAdapter {
    const adapter = this.adapters.get(`${gameId}:${rulesVersion}:${contentVersion}`);
    if (!adapter) throw new RealtimeError('ARTIFACT_UNAVAILABLE', 503);
    return adapter;
  }
  private manifest(adapter: GameAdapter): RuntimeManifest {
    return { gameId: adapter.gameId, rulesVersion: adapter.rulesVersion, contentVersion: adapter.contentVersion,
      protocolVersion: adapter.protocolVersion, physicsBuildHash: adapter.physicsBuildHash, runtimeArtifactId: adapter.runtimeArtifactId,
      serializerVersion: adapter.serializerVersion, botVersion: adapter.botVersion, tickRate: adapter.tickRate, snapshotRate: adapter.snapshotRate };
  }
  private activate(stored: StoredMatch, adapter: GameAdapter, world: unknown): ActiveMatch {
    const now = this.mono();
    return { stored, adapter, world, controls: new Map(stored.meta.controllers.map(control => [control.participantId, {
      ...control, connected: false, connectionId: null, input: adapter.neutralInput(), lastInputAt: -Infinity,
      lastActiveAt: now, inputSeq: -1, consumedSeq: -1,
    }])), lastHumanAt: now, lastMono: now, accumulator: 0, lastSnapshotTick: stored.meta.worldTick, lastLeaseAt: this.wall(), frozen: false, healthySince: null,
      committedAt: now, dirtySince: null, lastStepMs: 0, lastBatchStepMs: 0, lastBatchSteps: 0, lastSerializeMs: 0, lastCommitMs: 0 };
  }
  private listControls(match: ActiveMatch): ControllerState[] {
    return [...match.controls.values()].map(({ participantId, kind, connected, controllerGeneration }) => ({ participantId, kind, connected, controllerGeneration }));
  }
  private syncControllers(match: ActiveMatch): void {
    match.stored.meta.controllers = this.listControls(match).map(({ participantId, kind, controllerGeneration }) => ({ participantId, kind, controllerGeneration }));
    match.adapter.controllersChanged?.(match.world, this.listControls(match));
  }
  async initialize(): Promise<void> {
    for (const stored of await this.storage.call('all')) {
      if (this.ownedArtifactIds && !this.ownedArtifactIds.has(stored.manifest.runtimeArtifactId)) continue;
      let adapter: GameAdapter | undefined, world: unknown, acquired = false;
      try {
        adapter = this.adapter(stored.manifest.gameId, stored.manifest.rulesVersion, stored.manifest.contentVersion);
        const simulationManifest = { ...stored.manifest }; delete simulationManifest.clientContentHash; delete simulationManifest.clientRoute;
        if (fingerprint(this.manifest(adapter)) !== fingerprint(simulationManifest)) throw new RealtimeError('ARTIFACT_MISMATCH', 503);
        stored.fence = await this.storage.call('acquire', stored.matchId, this.ownerId, this.wall()); acquired = true;
        const recovery = await this.storage.call('recovery', stored.matchId);
        try { world = await adapter.restore(recovery.snapshot.world); }
        catch { throw new RealtimeError('WORLD_UNREADABLE', 503); }
        let expected = recovery.snapshot.seq;
        for (const entry of recovery.journal) {
          if (entry.seq !== ++expected || entry.kind !== 'ticks') throw new RealtimeError('REPLAY_GAP', 503);
          try {
            const payload = JSON.parse(entry.payload) as { steps: ReplayStep[] };
            for (const step of payload.steps) { adapter.step(world, step.inputs, step.context); adapter.pollCheckpoint?.(world); }
          } catch { throw new RealtimeError('REPLAY_CORRUPT', 503); }
          if (hash(adapter.serialize(world)) !== entry.postHash) throw new RealtimeError('REPLAY_DIVERGED', 503);
        }
        if (expected !== stored.meta.journalSeq) throw new RealtimeError('REPLAY_GAP', 503);
        const match = this.activate(stored, adapter, world);
        if (!['finished', 'abandoned'].includes(stored.meta.phase)) {
          stored.meta.epoch += 1; stored.meta.phase = 'paused'; stored.meta.resumeAt = null; stored.meta.pauseReason = 'recovery';
          stored.meta.returnUntil ??= this.wall() + RETURN_WINDOW_MS;
          this.syncControllers(match);
          await this.persist(match, 'recovery', {}, true);
        }
        await this.storage.call('clearRecoveryFailure', stored.matchId);
        this.matches.set(stored.matchId, match);
      } catch (error) {
        if (world !== undefined) adapter?.release?.(world);
        const isolated = new Set(['ARTIFACT_UNAVAILABLE', 'ARTIFACT_MISMATCH', 'CORRUPT_SNAPSHOT', 'WORLD_UNREADABLE', 'REPLAY_GAP', 'REPLAY_CORRUPT', 'REPLAY_DIVERGED']);
        if (!(error instanceof RealtimeError) || !isolated.has(error.code)) throw error;
        // Preserve the original snapshots/journal; only record why this one
        // match is unavailable. Healthy matches in the same worker still load.
        await this.storage.call('markRecoveryFailure', stored.matchId, error.code, this.wall());
        if (acquired) await this.storage.call('release', stored.matchId, this.ownerId, stored.fence);
        this.unavailable.set(stored.matchId, { stored, code: error.code });
      }
    }
    this.ready = true;
  }
  health(includeDiagnostics = false): unknown {
    const failedMatches = [...this.matches.values()].filter(match => match.frozen).length;
    return { ok: this.ready && !this.draining && failedMatches === 0, failedMatches, unavailableMatches: this.unavailable.size, service: 'iva-realtime', protocolVersion: REALTIME_PROTOCOL,
      runtimeArtifactIds: [...this.adapters.values()].map(adapter => adapter.runtimeArtifactId),
      games: [...this.adapters.values()].map(adapter => this.manifest(adapter)),
      capacity: this.maxMatches, activeMatches: [...this.matches.values()].filter(match => !['finished', 'abandoned'].includes(match.stored.meta.phase)).length,
      draining: this.draining, metrics: this.metrics,
      ...(includeDiagnostics ? { diagnostics: { games: [...this.timings].map(([gameId, timings]) => ({ gameId, ...timings.report(), lastOverload: this.lastOverloads.get(gameId) ?? null })),
        uncommittedAgeMs: Math.max(0, ...[...this.matches.values()].map(match => match.dirtySince === null ? 0 : this.mono() - match.dirtySince)),
        runningSnapshotAgeMs: Math.max(0, ...[...this.matches.values()].filter(match => match.stored.meta.phase === 'running').map(match => this.mono() - match.committedAt)),
        loadedWorlds: this.matches.size, connectedClients: this.connections.size } } : {}) };
  }
  private observeOverload(match: ActiveMatch, kind: OverloadObservation['kind'], schedulerGapMs: number): OverloadObservation {
    // A fixed-size last observation per registered game complements the durable
    // per-match journal. It records measured timing context, not an inferred
    // cause, and contains no player/input/world payloads.
    const observation: OverloadObservation = { kind, observedAt: this.wall(), worldTick: match.stored.meta.worldTick,
      schedulerGapMs, accumulatedLagMs: match.accumulator, stepIntervalMs: 1000 / match.adapter.tickRate,
      maxCatchUpSteps: match.adapter.tickRate === 60 ? 4 : 2, lastStepMs: match.lastStepMs,
      lastBatchStepMs: match.lastBatchStepMs, lastBatchSteps: match.lastBatchSteps,
      lastSerializeMs: match.lastSerializeMs, lastCommitMs: match.lastCommitMs };
    this.lastOverloads.set(match.adapter.gameId, observation);
    if (kind === 'pause') this.metrics.overloadPauses += 1; else this.metrics.overloadRecurrences += 1;
    return observation;
  }
  async create(gameId: string, input: StartMatchRequest, admission?: { hostPlayerId?: string; reservationId?: string; clientContentHash?: string; clientRoute?: string }): Promise<{ matchId: string }> {
    checkJson(input);
    if (this.draining || !this.ready) throw new RealtimeError('SERVER_UPDATING', 503);
    if (!identifier(input.startCommandId) || !identifier(input.roomId)) throw new RealtimeError('INVALID_START');
    const prior = await this.storage.call('byStart', input.startCommandId);
    const startHash = fingerprint({ gameId, input });
    if (prior) {
      if (prior.startHash !== startHash) throw new RealtimeError('START_ID_REUSED', 409);
      return { matchId: prior.matchId };
    }
    if ([...this.matches.values()].filter(match => !['finished', 'abandoned'].includes(match.stored.meta.phase)).length >= this.maxMatches) throw new RealtimeError('CAPACITY_BUSY', 503);
    if (!Array.isArray(input.participants) || input.participants.length < 2 || input.participants.length > 6 || !input.participants.some(p => p.controller.kind === 'human')) throw new RealtimeError('INVALID_ROSTER');
    const ids = new Set<string>(), players = new Set<string>(), seats = new Set<number>();
    for (const participant of input.participants) {
      if (!identifier(participant.participantId) || ids.has(participant.participantId) || !Number.isInteger(participant.seatIndex) || participant.seatIndex < 0 || participant.seatIndex > 5 || seats.has(participant.seatIndex) || typeof participant.displayName !== 'string' || !participant.displayName.trim() || participant.displayName.length > 40) throw new RealtimeError('INVALID_ROSTER');
      ids.add(participant.participantId); seats.add(participant.seatIndex);
      if (participant.controller.kind === 'human') {
        if (!identifier(participant.playerId) || participant.playerId !== participant.controller.playerId || players.has(participant.playerId)) throw new RealtimeError('INVALID_ROSTER');
        players.add(participant.playerId);
      } else if (participant.controller.kind !== 'bot' || participant.playerId !== null || !['easy', 'normal', 'hard'].includes(participant.controller.difficulty)) throw new RealtimeError('INVALID_ROSTER');
    }
    const adapter = this.adapter(gameId, input.rulesVersion, input.contentVersion);
    const world = await adapter.create(input);
    const meta: StoredMeta = { epoch: 1, receiptEpoch: 1, worldTick: 0, journalSeq: 0, phase: 'loading', elapsedSeconds: 0, attempt: 0,
      returnUntil: this.wall() + RETURN_WINDOW_MS, resumeAt: null, outcome: null, pendingOutcome: null,
      pauseReason: null,
      controllers: input.participants.map(p => ({ participantId: p.participantId, kind: p.controller.kind, controllerGeneration: 0 })) };
    try {
      const manifest = this.manifest(adapter);
      if (admission?.clientContentHash) {
        if (!/^[a-f0-9]{64}$/.test(admission.clientContentHash) || admission.clientRoute !== `/play/${gameId}/versions/${admission.clientContentHash}/`) throw new RealtimeError('CLIENT_CONTENT_INVALID');
        manifest.clientContentHash = admission.clientContentHash; manifest.clientRoute = admission.clientRoute;
      }
      const stored = await this.storage.call('create', { matchId: randomUUID(), startHash, rosterHash: fingerprint(input.participants), manifest, start: input, meta, fence: 1 }, this.ownerId, adapter.serialize(world), this.wall(), admission?.reservationId);
      this.matches.set(stored.matchId, this.activate(stored, adapter, world));
      return { matchId: stored.matchId };
    } catch (error) { adapter.release?.(world); throw error; }
  }
  private match(matchId: string): ActiveMatch {
    const match = this.matches.get(matchId);
    if (!match) { const missing = this.unavailable.get(matchId); throw new RealtimeError(missing?.code ?? 'MATCH_UNAVAILABLE', missing ? 409 : 404); }
    return match;
  }
  status(matchId: string): { finished: boolean; outcome?: unknown; phase: string; recoverableError?: string; manifest: RuntimeManifest; rosterHash: string; roomId: string } {
    const missing = this.unavailable.get(matchId);
    if (missing) return { finished: ['finished', 'abandoned'].includes(missing.stored.meta.phase),
      ...(missing.stored.meta.outcome ? { outcome: missing.stored.meta.outcome } : {}), phase: 'failed-recoverable', recoverableError: missing.code,
      manifest: missing.stored.manifest, rosterHash: missing.stored.rosterHash, roomId: missing.stored.start.roomId };
    const match = this.match(matchId), meta = match.stored.meta;
    return { finished: meta.phase === 'finished' || meta.phase === 'abandoned', ...(meta.outcome ? { outcome: meta.outcome } : {}),
      phase: meta.phase, manifest: match.stored.manifest, rosterHash: match.stored.rosterHash, roomId: match.stored.start.roomId };
  }
  participant(matchId: string, playerId: string): { participantId: string; status: ReturnType<RealtimeEngine['status']> } {
    const match = this.match(matchId);
    const participant = match.stored.start.participants.find(p => p.playerId === playerId && p.controller.kind === 'human');
    if (!participant) throw new RealtimeError('MATCH_UNAVAILABLE', 403);
    return { participantId: participant.participantId, status: this.status(matchId) };
  }
  private async persist(match: ActiveMatch, kind: string, payload: unknown, full = false, extra: Partial<Commit> = {}): Promise<void> {
    if (match.frozen) throw new RealtimeError('RECOVERY_REQUIRED', 503);
    match.dirtySince ??= this.mono();
    const timings = this.timings.get(match.adapter.gameId)!;
    const serializationStarted = this.mono();
    const world = match.adapter.serialize(match.world), now = this.wall();
    match.lastSerializeMs = this.mono() - serializationStarted; timings.serialize.observe(match.lastSerializeMs);
    const next = { ...match.stored.meta, journalSeq: match.stored.meta.journalSeq + 1 };
    const before = this.mono();
    try {
      await this.storage.call('commit', { matchId: match.stored.matchId, ownerId: this.ownerId, fence: match.stored.fence,
        meta: next, kind, payload: JSON.stringify(payload), postHash: hash(world), now,
        ...(full ? { snapshot: { world, worldTick: next.worldTick } } : {}), ...extra });
      Object.assign(match.stored.meta, next); match.lastLeaseAt = now;
      if (full) match.lastSnapshotTick = next.worldTick;
      const completed = this.mono(), duration = completed - before;
      match.lastCommitMs = duration;
      timings.commit.observe(duration); timings.uncommitted.observe(completed - match.dirtySince);
      match.committedAt = completed; match.dirtySince = null;
      this.metrics.commits += 1; this.metrics.maxCommitMs = Math.max(this.metrics.maxCommitMs, duration);
    } catch (error) {
      match.frozen = true; this.metrics.failures += 1;
      throw error;
    }
  }
  async connect(claims: TicketClaims, connectionId: string): Promise<Snapshot> {
    if (this.draining) throw new RealtimeError('SERVER_UPDATING', 503);
    const match = this.match(claims.matchId);
    const participant = this.participant(claims.matchId, claims.playerId);
    const manifest = match.stored.manifest;
    if (participant.participantId !== claims.participantId || match.stored.start.roomId !== claims.roomId || match.stored.rosterHash !== claims.rosterHash || manifest.gameId !== claims.gameId || manifest.rulesVersion !== claims.rulesVersion || manifest.contentVersion !== claims.contentVersion) throw new RealtimeError('AUTH_FAILED', 401);
    if (match.stored.meta.phase === 'abandoned' || (match.stored.meta.returnUntil !== null && this.wall() > match.stored.meta.returnUntil && match.stored.meta.phase !== 'finished')) {
      await this.abandon(match); throw new RealtimeError('RETURN_EXPIRED', 409);
    }
    await this.storage.call('consume', 'ticket', claims.ticketId, claims.expiresAt, this.wall());
    const now = this.mono();
    const connection: Connection = { id: connectionId, matchId: claims.matchId, participantId: claims.participantId, playerId: claims.playerId,
      sessionId: claims.sessionId, validUntil: this.wall() + 60_000, snapshotSeq: 0, lastSignal: now };
    this.connections.set(connectionId, connection);
    const control = match.controls.get(claims.participantId)!;
    if (control.connectionId === null) {
      control.connectionId = connectionId; control.connected = true; control.kind = 'human'; control.controllerGeneration += 1;
      control.lastActiveAt = now; control.lastInputAt = -Infinity; control.input = match.adapter.neutralInput(); control.inputSeq = -1; control.consumedSeq = -1;
      this.syncControllers(match);
      if (['paused', 'loading', 'ready'].includes(match.stored.meta.phase)) {
        match.stored.meta.phase = 'recovering'; match.stored.meta.resumeAt = this.wall() + 3000;
        match.stored.meta.returnUntil = null; match.lastMono = now; match.accumulator = 0;
      }
      match.lastHumanAt = now;
      await this.persist(match, 'connect', { participantId: claims.participantId }, true);
    }
    return this.snapshot(connectionId);
  }
  private connection(connectionId: string): { connection: Connection; match: ActiveMatch; control: Control } {
    const connection = this.connections.get(connectionId);
    if (!connection || connection.validUntil < this.wall()) throw new RealtimeError('AUTH_EXPIRED', 401);
    const match = this.match(connection.matchId);
    if (match.frozen) throw new RealtimeError('RECOVERY_REQUIRED', 503);
    return { connection, match, control: match.controls.get(connection.participantId)! };
  }
  private scope(connectionId: string, message: ClientMessage, requireControl = false, arrivedAt = this.mono()): ReturnType<RealtimeEngine['connection']> {
    const value = this.connection(connectionId), { match, control, connection } = value;
    if (message.matchId !== connection.matchId || message.epoch !== match.stored.meta.epoch) throw new RealtimeError('STALE_EPOCH', 409);
    if (message.controllerGeneration !== control.controllerGeneration) throw new RealtimeError('STALE_CONTROLLER', 409);
    if (requireControl && (control.connectionId !== connectionId || control.kind !== 'human')) throw new RealtimeError('CONTROL_REQUIRED', 409);
    connection.lastSignal = Math.max(connection.lastSignal, Math.min(arrivedAt, this.mono()));
    if (control.connectionId === connectionId) control.lastActiveAt = Math.max(control.lastActiveAt, Math.min(arrivedAt, this.mono()));
    return value;
  }
  input(connectionId: string, message: Extract<ClientMessage, { type: 'input' }>, receivedAt = this.mono()): void {
    if (!Number.isFinite(receivedAt)) throw new RealtimeError('INVALID_INPUT');
    const { match, control } = this.scope(connectionId, message, true, receivedAt);
    if (!['running', 'recovering'].includes(match.stored.meta.phase)) { control.input = match.adapter.neutralInput(); return; }
    if (message.inputSeq <= control.inputSeq) return;
    // The trusted gateway records arrival before its queue and worker RPC.
    // Waiting for a durable action must not give an old held input a new TTL.
    control.lastInputAt = Math.min(receivedAt, this.mono());
    control.input = this.mono() - control.lastInputAt > INPUT_TIMEOUT_MS ? match.adapter.neutralInput() : match.adapter.input(message.payload);
    control.inputSeq = message.inputSeq;
  }
  heartbeat(connectionId: string, message: ClientMessage): void { this.scope(connectionId, message); }
  resync(connectionId: string, message: ClientMessage): Snapshot {
    const { connection, control } = this.connection(connectionId);
    if (message.matchId !== connection.matchId) throw new RealtimeError('INVALID_SCOPE');
    connection.lastSignal = this.mono();
    if (control.connectionId === connectionId) control.lastActiveAt = connection.lastSignal;
    return this.snapshot(connectionId);
  }
  async claim(connectionId: string, message: Extract<ClientMessage, { type: 'claimControl' }>): Promise<Snapshot> {
    const { match, control } = this.scope(connectionId, message);
    if (message.expectedGeneration !== control.controllerGeneration) throw new RealtimeError('STALE_CONTROLLER', 409);
    control.controllerGeneration += 1; control.connectionId = connectionId; control.connected = true; control.kind = 'human';
    control.input = match.adapter.neutralInput(); control.inputSeq = -1; control.consumedSeq = -1; control.lastInputAt = -Infinity; control.lastActiveAt = this.mono();
    this.syncControllers(match);
    await this.persist(match, 'claim-control', { participantId: control.participantId }, true);
    return this.snapshot(connectionId);
  }
  async disconnect(connectionId: string, absentSince = this.mono()): Promise<void> {
    const connection = this.connections.get(connectionId); if (!connection) return;
    this.connections.delete(connectionId);
    const match = this.match(connection.matchId), control = match.controls.get(connection.participantId)!;
    if (control.connectionId !== connectionId || match.frozen) return;
    control.connectionId = null; control.connected = false; control.lastActiveAt = Math.min(absentSince, this.mono()); control.lastInputAt = -Infinity; control.input = match.adapter.neutralInput();
    match.lastHumanAt = Math.max(match.lastHumanAt, control.lastActiveAt);
    this.syncControllers(match);
    await this.persist(match, 'disconnect', { participantId: control.participantId }, true);
  }
  async admissions(sessionIds: string[]): Promise<void> {
    const active = new Set(sessionIds);
    for (const connection of [...this.connections.values()]) {
      if (active.has(connection.sessionId)) connection.validUntil = this.wall() + 60_000;
      else await this.disconnect(connection.id);
    }
  }
  async action(connectionId: string, message: Extract<ClientMessage, { type: 'action' }>): Promise<StoredReceipt> {
    const { match, connection } = this.scope(connectionId, message, true);
    const meta = match.stored.meta;
    const payloadHash = fingerprint(message.payload);
    const prior = await this.storage.call('receipt', match.stored.matchId, meta.receiptEpoch, connection.participantId, message.actionId);
    if (prior) {
      if (prior.payloadHash !== payloadHash) throw new RealtimeError('ACTION_ID_REUSED', 409);
      return prior;
    }
    if (meta.phase !== 'running') throw new RealtimeError('MATCH_PAUSED', 409);
    const before = match.adapter.serialize(match.world);
    const sourceEpoch = meta.receiptEpoch;
    let result;
    match.dirtySince ??= this.mono();
    try { result = match.adapter.action(match.world, connection.participantId, message.payload); }
    catch (error) { match.adapter.release?.(match.world); match.world = await match.adapter.restore(before); match.dirtySince = null; throw error; }
    checkJson(result.result);
    if (result.checkpointId && result.rewindTo) throw new RealtimeError('INVALID_TRANSITION');
    const extra: Partial<Commit> = {};
    if (result.checkpointId) {
      if (!identifier(result.checkpointId)) throw new RealtimeError('INVALID_CHECKPOINT');
      extra.checkpoint = { id: result.checkpointId, world: match.adapter.serialize(match.world), worldTick: meta.worldTick };
    }
    if (result.rewindTo) {
      const checkpoint = await this.storage.call('checkpoint', match.stored.matchId, result.rewindTo);
      const world = await match.adapter.restore(checkpoint.world);
      match.adapter.release?.(match.world); match.world = world;
      meta.epoch += 1; meta.receiptEpoch += 1; meta.attempt += 1; meta.worldTick = checkpoint.worldTick;
      for (const control of match.controls.values()) { control.input = match.adapter.neutralInput(); control.inputSeq = -1; control.consumedSeq = -1; control.lastInputAt = -Infinity; }
      this.syncControllers(match); match.adapter.onRewind?.(match.world, { attempt: meta.attempt, elapsedSeconds: meta.elapsedSeconds });
      meta.phase = 'recovering'; meta.pauseReason = 'rewind'; meta.resumeAt = this.wall() + 3000; match.accumulator = 0; match.lastMono = this.mono();
    }
    const receipt = { epoch: sourceEpoch, participantId: connection.participantId, actionId: message.actionId, payloadHash,
      result: result.result, worldTick: meta.worldTick };
    await this.persist(match, result.rewindTo ? 'rewind' : 'action', { participantId: connection.participantId, payload: message.payload }, true, { ...extra, receipt });
    return { payloadHash, result: result.result, worldTick: meta.worldTick, journalSeq: match.stored.meta.journalSeq };
  }
  immutableViewFields(connectionId: string): readonly string[] {
    return this.connection(connectionId).match.adapter.immutableViewFields ?? [];
  }
  snapshot(connectionId: string): Snapshot {
    const { match, connection, control } = this.connection(connectionId), meta = match.stored.meta;
    if (meta.phase === 'running') this.timings.get(match.adapter.gameId)!.snapshotAge.observe(Math.max(0, this.mono() - match.committedAt));
    const view = match.adapter.view(match.world, connection.participantId);
    return { type: 'full', protocolVersion: REALTIME_PROTOCOL, matchId: match.stored.matchId, epoch: meta.epoch,
      controllerGeneration: control.controllerGeneration, snapshotSeq: ++connection.snapshotSeq,
      worldTick: meta.worldTick, committedJournalSeq: meta.journalSeq, manifest: match.stored.manifest,
      serverTime: this.wall(),
      phase: meta.phase as Snapshot['phase'], participantId: connection.participantId, lastConsumedInputSeq: control.consumedSeq,
      controls: this.listControls(match), hasControl: control.connectionId === connectionId && control.kind === 'human',
      elapsedSeconds: meta.elapsedSeconds, attempt: meta.attempt, resumeAt: meta.resumeAt, returnUntil: meta.returnUntil,
      outcome: meta.outcome, pauseReason: meta.pauseReason ?? null, view: this.cloneViews ? structuredClone(view) : view };
  }
  async tick(): Promise<void> {
    if (this.draining) return;
    const now = this.mono(), wall = this.wall();
    for (const connection of [...this.connections.values()]) {
      if (connection.validUntil < wall) await this.disconnect(connection.id);
      else if (now - connection.lastSignal >= BOT_TAKEOVER_MS) await this.disconnect(connection.id, connection.lastSignal);
    }
    for (const match of this.matches.values()) {
      if (match.frozen) continue;
      const meta = match.stored.meta;
      try {
        if (wall - match.lastLeaseAt > 5000) { await this.storage.call('renew', match.stored.matchId, this.ownerId, match.stored.fence, wall); match.lastLeaseAt = wall; }
        if (['finished', 'abandoned'].includes(meta.phase)) continue;
        if (meta.returnUntil !== null && wall > meta.returnUntil) { await this.abandon(match); continue; }
        let controlsChanged = false;
        for (const control of match.controls.values()) {
          if (!control.connected && control.kind === 'human' && now - control.lastActiveAt >= BOT_TAKEOVER_MS) {
            control.kind = 'bot'; control.controllerGeneration += 1; controlsChanged = true;
          }
        }
        if (controlsChanged) { this.syncControllers(match); await this.persist(match, 'bot-takeover', {}, true); }
        const humans = [...match.controls.values()].filter(control => control.connected && control.kind === 'human');
        if (humans.length) match.lastHumanAt = Math.max(match.lastHumanAt, ...humans.map(control => control.lastActiveAt));
        if (!humans.length && now - match.lastHumanAt >= EMPTY_PAUSE_MS && ['running', 'recovering'].includes(meta.phase)) {
          meta.phase = 'paused'; meta.pauseReason = 'empty'; meta.resumeAt = null; meta.returnUntil = wall + RETURN_WINDOW_MS; match.accumulator = 0;
          await this.persist(match, 'empty-pause', {}, true); continue;
        }
        if (meta.pauseReason === 'overload' && ['paused', 'recovering'].includes(meta.phase)) {
          // A transient scheduler stall must not strand an authenticated human
          // in a permanently paused world. Require one stable second before
          // the ordinary three-second resume countdown; never catch up the gap.
          const gap = Math.max(0, now - match.lastMono); match.lastMono = now;
          if (gap > 100) {
            match.healthySince = null;
            if (meta.phase === 'recovering') {
              const observation = this.observeOverload(match, 'recurred', gap);
              meta.phase = 'paused'; meta.resumeAt = null; match.accumulator = 0;
              await this.persist(match, 'overload-recurred', observation, true);
            }
          } else match.healthySince ??= now;
          if (meta.phase === 'paused' && humans.length && match.healthySince !== null && now - match.healthySince >= 1000) {
            meta.phase = 'recovering'; meta.resumeAt = wall + 3000; match.accumulator = 0;
            await this.persist(match, 'overload-ready', {}, true);
          }
        }
        if (meta.phase === 'recovering' && meta.resumeAt !== null && wall >= meta.resumeAt && humans.length) {
          meta.phase = 'running'; meta.pauseReason = null; meta.resumeAt = null; meta.returnUntil = null; match.lastMono = now; match.accumulator = 0; match.healthySince = null;
          if (meta.pendingOutcome) { await this.finish(match, meta.pendingOutcome); continue; }
          await this.persist(match, 'resume', {}, true);
        }
        if (meta.phase !== 'running') { match.lastMono = now; continue; }
        const schedulerGap = Math.max(0, now - match.lastMono);
        match.accumulator += schedulerGap; match.lastMono = now;
        const interval = 1000 / match.adapter.tickRate;
        const maxSteps = match.adapter.tickRate === 60 ? 4 : 2;
        if (match.accumulator > interval * maxSteps + 500) {
          const observation = this.observeOverload(match, 'pause', schedulerGap);
          meta.phase = 'paused'; meta.pauseReason = 'overload'; meta.returnUntil = wall + RETURN_WINDOW_MS; meta.resumeAt = null; match.accumulator = 0; match.healthySince = null;
          await this.persist(match, 'overload-pause', observation, true); continue;
        }
        const count = Math.min(maxSteps, Math.floor(match.accumulator / interval));
        if (!count) continue;
        const steps: ReplayStep[] = [];
        match.lastBatchStepMs = 0; match.lastBatchSteps = 0;
        let checkpointId: string | null = null;
        for (let index = 0; index < count; index++) {
          const inputs: Record<string, unknown> = {};
          for (const control of match.controls.values()) {
            inputs[control.participantId] = control.kind === 'human' && control.connected && now - control.lastInputAt <= INPUT_TIMEOUT_MS ? control.input : match.adapter.neutralInput();
            if (control.kind === 'human' && control.connected && now - control.lastInputAt <= INPUT_TIMEOUT_MS) control.consumedSeq = control.inputSeq;
          }
          const dt = 1 / match.adapter.tickRate;
          if (match.adapter.isSimulating?.(match.world) !== false) meta.elapsedSeconds += dt;
          const context: StepContext = { dt, controllers: this.listControls(match), elapsedSeconds: meta.elapsedSeconds, attempt: meta.attempt };
          const start = this.mono(); match.dirtySince ??= start; match.adapter.step(match.world, inputs, context);
          const duration = this.mono() - start; this.timings.get(match.adapter.gameId)!.step.observe(duration);
          match.lastStepMs = duration; match.lastBatchStepMs += duration; match.lastBatchSteps += 1;
          this.metrics.maxStepMs = Math.max(this.metrics.maxStepMs, duration); this.metrics.steps += 1;
          meta.worldTick += 1; match.accumulator -= interval;
          steps.push({ inputs, context });
          checkpointId = match.adapter.pollCheckpoint?.(match.world) ?? null;
          if (checkpointId !== null && !identifier(checkpointId)) throw new RealtimeError('INVALID_CHECKPOINT');
          if (checkpointId !== null || match.adapter.outcome(match.world) !== null) break;
        }
        const outcome = match.adapter.outcome(match.world);
        await this.persist(match, 'ticks', { steps }, checkpointId !== null || meta.worldTick - match.lastSnapshotTick >= match.adapter.tickRate * 2 || outcome !== null,
          checkpointId === null ? {} : { checkpoint: { id: checkpointId, world: match.adapter.serialize(match.world), worldTick: meta.worldTick } });
        if (outcome !== null) {
          if (humans.length) await this.finish(match, outcome);
          else { meta.pendingOutcome = outcome; meta.phase = 'paused'; meta.pauseReason = 'empty'; meta.returnUntil = wall + RETURN_WINDOW_MS; await this.persist(match, 'pending-outcome', {}, true); }
        }
      } catch { match.frozen = true; this.metrics.failures += 1; }
    }
  }
  private async finish(match: ActiveMatch, value: unknown): Promise<void> {
    const meta = match.stored.meta;
    if (meta.outcome) return;
    const resultId = randomUUID();
    meta.outcome = { resultId, game: value, elapsedSeconds: meta.elapsedSeconds, rewinds: meta.attempt };
    meta.pendingOutcome = null; meta.phase = 'finished'; meta.pauseReason = null; meta.resumeAt = null; meta.returnUntil = null;
    await this.persist(match, 'finish', { resultId }, true, { outcome: { resultId, value: meta.outcome } });
  }
  private async abandon(match: ActiveMatch): Promise<void> {
    if (match.stored.meta.phase === 'abandoned') return;
    match.stored.meta.phase = 'abandoned'; match.stored.meta.outcome = null; match.stored.meta.pendingOutcome = null;
    await this.persist(match, 'abandon', {}, true);
  }
  async acknowledgeResult(matchId: string, resultId: string): Promise<void> { await this.storage.call('acknowledgeResult', matchId, resultId); }
  async drain(): Promise<void> {
    if (this.drained) return;
    this.draining = true;
    for (const match of this.matches.values()) {
      if (match.frozen) throw new RealtimeError('DRAIN_FAILED', 503);
      if (!['finished', 'abandoned'].includes(match.stored.meta.phase)) {
        match.stored.meta.phase = 'paused'; match.stored.meta.pauseReason = 'updating'; match.stored.meta.returnUntil = this.wall() + RETURN_WINDOW_MS; match.stored.meta.resumeAt = null;
        for (const control of match.controls.values()) { control.connected = false; control.connectionId = null; control.input = match.adapter.neutralInput(); }
        this.syncControllers(match); await this.persist(match, 'drain', {}, true);
      }
      await this.storage.call('release', match.stored.matchId, this.ownerId, match.stored.fence);
    }
    this.connections.clear();
    this.drained = true;
  }
  /** The local adapter uses this for cancellation tests. Production WorkerHost
   * restarts each pinned worker from its committed archive after a cancelled
   * release, so even an older worker protocol cannot retain stale ownership. */
  async cancelDrain(): Promise<void> {
    if (!this.draining) return;
    if (!this.drained) throw new RealtimeError('DRAIN_FAILED', 503);
    for (const match of this.matches.values()) {
      match.stored.fence = await this.storage.call('acquire', match.stored.matchId, this.ownerId, this.wall());
      match.lastLeaseAt = this.wall(); match.lastMono = this.mono(); match.accumulator = 0;
    }
    this.drained = false; this.draining = false;
  }
}
