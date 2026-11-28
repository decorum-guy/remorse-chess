import { randomBytes, randomUUID } from 'node:crypto';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { normalizeInput } from '@iva-games/forpost/core';
import type { CreateWorldOptions, Input, WorldView } from '@iva-games/forpost/core';
import { LIMITS } from '@iva-games/realtime-kit';
import type { ClientMessage, StartWaiting, TicketClaims } from '@iva-games/realtime-kit';
import { canonical, hash } from './crypto.js';
import type { Control, FrozenParticipant, Receipt, StoredMatch, StoredStart } from './store.js';
import { WorkerRpc } from './worker-rpc.js';
import { retainedWorkerDirectory } from './artifacts.js';
import { ProjectionStream } from './projection.js';
import { retainedClientDirectory } from './content.js';
import { TimingHistogram } from './timing.js';
import { canAdmit, capacityProfile, forpostDemand, ResourceProbe, sumDemand } from './capacity.js';
import type { CapacityDecision, CapacityProfile, ResourceSample } from './capacity.js';

interface SimulationResult {
  world: string; tick: number; phase: string; outcome: { winner: string | null; resultId: string; operations: unknown[] } | null;
  views: Record<string, WorldView>; results?: { actionId: string; participantId: string; result: unknown }[];
  workMs?: number; workCpuMs?: number;
}
export interface Peer {
  id: string; claims: TicketClaims; send(value: unknown): void; close(code: number, reason: string): void;
  queuedBytes(): number; rttMs: number; lastSeen: number; lastAdmissionCheck: number; blockedSince: number;
}
interface PendingAction { participantId: string; actionId: string; payload: Record<string, unknown>; payloadHash: string; peers: Set<Peer> }
interface Room {
  stored: StoredMatch; worker: WorkerRpc; views: Record<string, WorldView>; peers: Map<string, Peer>;
  published: { match: StoredMatch; views: Record<string, WorldView> }; failed: boolean;
  inputs: Record<string, Input>; actions: PendingAction[]; pending: Map<string, PendingAction>;
  chain: Promise<void>; busy: boolean; nextTickAt: number; lastPersistAt: number;
  viewsProducedAt: number; publishedAt: number; journalPendingAt: number | null;
}
export interface NewMatch {
  startId: string; roomId: string; kind: 'account' | 'practice'; ownerHash: string | null;
  hostPlayerId?: string;
  roster: FrozenParticipant[]; config: Omit<CreateWorldOptions, 'matchId'>; rulesVersion: string; contentVersion: string;
}
export class StartWaitingError extends Error {
  constructor(readonly waiting: StartWaiting) { super('SERVER_BUSY'); }
}
export class RealtimeRuntime {
  readonly store: WorkerRpc;
  readonly leaseOwner = randomUUID();
  readonly rooms = new Map<string, Room>();
  readonly ready: Promise<void>;
  private readonly workers = new Map<string, WorkerRpc[]>();
  private readonly projections = new WeakMap<Peer, ProjectionStream<WorldView>>();
  private readonly stepTiming = new TimingHistogram();
  private readonly commitTiming = new TimingHistogram();
  private readonly journalAgeTiming = new TimingHistogram();
  private readonly snapshotAgeTiming = new TimingHistogram();
  private readonly stepWorkTiming = new TimingHistogram();
  private readonly stepCpuTiming = new TimingHistogram();
  private readonly processStartedAt = performance.now();
  private readonly resourceProbe = new ResourceProbe();
  private baselineMemoryBytes = process.memoryUsage().rss;
  private queuedStarts: StoredStart[] = [];
  private readonly activeGuestCreates = new Set<string>();
  private admitting: Promise<void> | null = null;
  private nextAdmissionAt = 0;
  private nextRoom = 0;
  private lastCapacityDecision: CapacityDecision | null = null;
  private writerMetrics: Record<string, unknown> | null = null;
  private readonly resyncReasons = { requested: 0, staleEpoch: 0, backpressure: 0 };
  private readonly loopDelay = monitorEventLoopDelay({ resolution: 10 });
  private timer: ReturnType<typeof setInterval> | null = null;
  private draining = false;
  private closed = false;
  private creating = new Map<string, Promise<StoredMatch>>();
  private workerIndex = 0;
  private samples = { ticks: 0, maxStepMs: 0, maxCommitMs: 0, storageFailures: 0, resyncs: 0, admissionFailures: 0,
    stepWorkSamples: 0, stepWorkCpuTotalMs: 0, maxCommitBatchSize: 0 };
  constructor(readonly options: { databasePath: string; maxRooms: number; artifactId: string; artifactDirectory?: string; contentId?: string; contentDirectory?: string; buildRevision?: string; workerDirectory?: URL;
    capacityProfile?: CapacityProfile; resourceSample?: () => ResourceSample }) {
    if (!Number.isSafeInteger(options.maxRooms) || options.maxRooms < 1 || options.maxRooms > 16) throw new Error('INVALID_ROOM_CAPACITY');
    if (options.capacityProfile) options.capacityProfile = capacityProfile(options.capacityProfile, options.artifactId, process.env.NODE_ENV !== 'production');
    const directory = options.workerDirectory ?? new URL('./', import.meta.url);
    this.store = new WorkerRpc(new URL('store-worker.js', directory), { path: options.databasePath });
    const simulationDirectory = options.artifactDirectory ? retainedWorkerDirectory(options.artifactDirectory, options.artifactId) : directory;
    this.workers.set(options.artifactId, Array.from({ length: 2 }, () => new WorkerRpc(new URL('simulation-worker.js', simulationDirectory))));
    this.loopDelay.enable();
    this.ready = this.restore().then(() => {
      this.baselineMemoryBytes = process.memoryUsage().rss;
      this.resourceProbe.reset();
      this.timer = setInterval(() => this.schedule(), 10); this.timer.unref();
    });
  }
  private worker(artifactId = this.options.artifactId): WorkerRpc {
    let workers = this.workers.get(artifactId);
    if (!workers) {
      if (!this.options.artifactDirectory) throw new Error('UNSUPPORTED_SAVED_RUNTIME');
      const directory = retainedWorkerDirectory(this.options.artifactDirectory, artifactId);
      workers = Array.from({ length: 2 }, () => new WorkerRpc(new URL('simulation-worker.js', directory)));
      this.workers.set(artifactId, workers);
    }
    return workers[this.workerIndex++ % workers.length];
  }
  private async restore(): Promise<void> {
    this.queuedStarts = await this.store.call<StoredStart[]>('starts');
    const matches = await this.store.call<StoredMatch[]>('list');
    for (const old of matches) {
      if (old.rulesVersion !== 'forpost-0.1' || old.manifest.serializer !== 'forpost-world-1') throw new Error('UNSUPPORTED_SAVED_RUNTIME');
      if (this.options.contentDirectory) retainedClientDirectory(this.options.contentDirectory, old.manifest.client);
      try {
        let match: StoredMatch | undefined;
        const deadline = Date.now() + 16_000;
        while (!match) {
          try { match = await this.store.call<StoredMatch>('acquire', old.matchId, this.leaseOwner); }
          catch (error) {
            if (!(error instanceof Error) || error.message !== 'MATCH_OWNED' || Date.now() >= deadline) throw error;
            await new Promise(resolveWait => setTimeout(resolveWait, 250));
          }
        }
        const worker = this.worker(match.manifest.runtime); const result = await worker.call<SimulationResult>('load', match.world);
        this.rooms.set(match.matchId, this.room(match, worker, result));
      } catch (error) {
        if (error instanceof Error && error.message === 'MATCH_OWNED') throw new Error('ACTIVE_OWNER_LEASE', { cause: error });
        throw error;
      }
    }
  }
  private room(stored: StoredMatch, worker: WorkerRpc, result: SimulationResult): Room {
    return { stored, worker, views: result.views, peers: new Map(), inputs: {}, actions: [], pending: new Map(),
      published: this.publication(stored, result.views), failed: false,
      chain: Promise.resolve(), busy: false, nextTickAt: performance.now(), lastPersistAt: Date.now(),
      viewsProducedAt: performance.now(), publishedAt: performance.now(), journalPendingAt: null };
  }
  private publication(match: StoredMatch, views: Record<string, WorldView>) {
    // World strings and worker-produced views are immutable between steps. Copy
    // mutable metadata so heartbeat/controller writes cannot alter a publication.
    return { match: { ...match, controls: Object.fromEntries(Object.entries(match.controls).map(([id, control]) => [id, { ...control }])),
      roster: match.roster.map(participant => ({ ...participant })), manifest: { ...match.manifest },
      outcome: structuredClone(match.outcome), pendingOutcome: structuredClone(match.pendingOutcome) }, views };
  }
  private locked<T>(room: Room, operation: () => Promise<T>): Promise<T> {
    const task = room.chain.then(operation);
    room.chain = task.then(() => {}, () => {}); return task;
  }
  private host(input: NewMatch): string {
    return input.kind === 'practice' ? 'practice:' + input.ownerHash : input.hostPlayerId ? 'account:' + input.hostPlayerId : 'account:legacy';
  }
  private capacity(input: NewMatch): CapacityDecision {
    const active = [...this.rooms.values()].filter(room => !['finished', 'abandoned'].includes(room.stored.phase));
    const profile = this.options.capacityProfile;
    const demand = (roster: FrozenParticipant[]) => forpostDemand(roster.length, roster.filter(person => person.controller === 'human').length, profile);
    const resources = this.options.resourceSample?.() ?? this.resourceProbe.sample();
    const now = performance.now();
    return this.lastCapacityDecision = canAdmit({ demand: demand(input.roster), occupied: sumDemand(active.map(room => demand(room.stored.roster))),
      resources, maxRooms: this.options.maxRooms, baselineMemoryBytes: this.baselineMemoryBytes,
      actualConnections: [...this.rooms.values()].reduce((sum, room) => sum + room.peers.size, 0),
      backlogMs: Math.max(0, ...active.filter(room => room.stored.phase === 'running' && Date.now() >= room.stored.countdownUntil).map(room => now - room.nextTickAt)),
      draining: this.draining || this.closed || this.samples.storageFailures > 0, profile });
  }
  private waiting(startId: string, reason?: StartWaiting['reason']): StartWaitingError {
    const index = this.queuedStarts.findIndex(start => start.startId === startId), queued = this.queuedStarts[index];
    return new StartWaitingError({ reason: reason ?? (this.draining ? 'updating' : this.samples.storageFailures ? 'service' : 'capacity'), retryAt: Date.now() + 1000,
      ...(index < 0 ? {} : { queuePosition: index + 1 }), ...(queued?.reservedUntil ? { reservationExpiresAt: queued.reservedUntil } : {}) });
  }
  async create(input: NewMatch): Promise<StoredMatch> {
    await this.ready;
    // Optional loadout fields are omitted on the wire; canonicalize that JSON shape.
    const fingerprint = hash(canonical(JSON.parse(JSON.stringify(input))));
    const old = await this.store.call<StoredMatch | null>('byStart', input.startId);
    if (old) { if (old.fingerprint !== fingerprint) throw new Error('START_CONFLICT'); return old; }
    if (this.closed || input.kind === 'practice' && this.draining) throw this.waiting(input.startId);
    if (input.kind === 'practice') this.activeGuestCreates.add(input.startId);
    try {
    try {
      const queued = await this.store.call<StoredStart | null>('enqueueStart', { startId: input.startId, hostId: this.host(input), fingerprint, requestJson: JSON.stringify(input) });
      if (!queued) return (await this.store.call<StoredMatch>('byStart', input.startId));
      if (!this.queuedStarts.some(start => start.startId === input.startId)) this.queuedStarts.push(queued);
    } catch (error) {
      if (error instanceof Error && ['SERVER_BUSY', 'HOST_START_PENDING'].includes(error.message)) throw this.waiting(input.startId, error.message === 'HOST_START_PENDING' ? 'another_start' : 'capacity');
      throw error;
    }
    await this.pumpStarts(input.kind === 'practice' ? input.startId : undefined);
    const match = await this.store.call<StoredMatch | null>('byStart', input.startId);
    if (match) return match;
    if (input.kind === 'practice') {
      // A guest gets no invisible future room after an unsuccessful create HTTP request.
      await this.store.call('cancelStart', input.startId, this.host(input));
      this.queuedStarts = await this.store.call<StoredStart[]>('starts');
    }
    throw this.waiting(input.startId);
    } finally { this.activeGuestCreates.delete(input.startId); }
  }
  private async pumpStarts(guestStartId?: string): Promise<void> {
    if (this.admitting) { await this.admitting; if (!guestStartId) return; }
    const task = this.processStarts(guestStartId); this.admitting = task;
    try { await task; } finally { if (this.admitting === task) this.admitting = null; }
  }
  private async processStarts(guestStartId?: string): Promise<void> {
    this.queuedStarts = await this.store.call<StoredStart[]>('starts');
    while (this.queuedStarts.length && !this.draining && !this.closed && !this.samples.storageFailures) {
      const queued = this.queuedStarts[0], input = JSON.parse(queued.requestJson) as NewMatch;
      if (input.kind === 'practice' && queued.startId !== guestStartId) {
        if (!this.activeGuestCreates.has(queued.startId) && (!queued.reservedUntil || queued.reservedUntil <= Date.now())) {
          await this.store.call('cancelStart', queued.startId, queued.hostId);
          this.queuedStarts = await this.store.call<StoredStart[]>('starts'); continue;
        }
        return;
      }
      if (!this.capacity(input).ok) return;
      let reservation: StoredStart;
      try { reservation = await this.store.call<StoredStart>('reserveStart', queued.startId, queued.fingerprint, this.leaseOwner, randomUUID()); }
      catch (error) { if (error instanceof Error && error.message === 'SERVER_BUSY') return; throw error; }
      if (this.draining || this.closed) { await this.store.call('releaseStart', queued.startId, this.leaseOwner, reservation.reservationId); return; }
      const task = this.allocate(input, queued.fingerprint, reservation.reservationId!); this.creating.set(queued.startId, task);
      try { await task; }
      catch (error) {
        await this.store.call('releaseStart', queued.startId, this.leaseOwner, reservation.reservationId);
        if (error instanceof Error && error.message === 'RESERVATION_EXPIRED') return;
        throw error;
      } finally { this.creating.delete(queued.startId); }
      this.queuedStarts = await this.store.call<StoredStart[]>('starts');
    }
  }
  private async allocate(input: NewMatch, fingerprint: string, reservationId: string): Promise<StoredMatch> {
      const now = Date.now(), matchId = randomUUID(); const worker = this.worker();
      const result = await worker.call<SimulationResult>('create', { ...input.config, matchId, idSalt: randomBytes(32).toString('hex') });
      const controls = Object.fromEntries(input.roster.filter(p => p.controller === 'human').map(p => [p.participantId,
        { generation: 0, connectionId: null, lastActivity: now, lastInputAt: 0, inputSeq: -1, consumed: -1, temporaryBot: false } satisfies Control]));
      const match: StoredMatch = {
        matchId, startId: input.startId, fingerprint, roomId: input.roomId, kind: input.kind, ownerHash: input.ownerHash,
        roster: input.roster, rosterHash: hash(canonical(input.roster)), rulesVersion: input.rulesVersion, contentVersion: input.contentVersion,
        manifest: { runtime: this.options.artifactId, rules: input.rulesVersion, content: input.contentVersion, protocol: '1', serializer: 'forpost-world-1', bot: 'forpost-bot-0.1',
          map: 'forpost-maps-0.1', physics: 'forpost-kinematic-1', prng: 'xorshift32-1', client: this.options.contentId ?? input.contentVersion },
        world: result.world, worldHash: hash(result.world), tick: result.tick, epoch: 1, ownerEpoch: 1, journalSeq: 0,
        controls, phase: 'ready', lastHumanAt: now, pausedAt: null, expiresAt: now + LIMITS.resumeForMs,
        pendingOutcome: null, outcome: null, countdownUntil: 0, createdAt: now, pauseReason: null,
      };
      try {
        const saved = await this.store.call<StoredMatch>('create', match, this.leaseOwner, reservationId);
        if (saved.matchId !== matchId) {
          await worker.call('drop', matchId);
          // A second process may have completed the same immutable start. Its
          // lease remains authoritative; never publish this speculative world.
          return saved;
        }
        this.rooms.set(saved.matchId, this.room(saved, worker, result)); return saved;
      } catch (error) { await worker.call('drop', matchId); throw error; }
  }
  get(matchId: string): StoredMatch | null { return this.rooms.get(matchId)?.published.match ?? null; }
  private async persist(room: Room, journal: unknown, receipts: Receipt[] = [], result?: { resultId: string; outcome: unknown }): Promise<void> {
    if (room.failed) throw new Error('RECOVERY_REQUIRED');
    room.stored.journalSeq++;
    const publication = this.publication(room.stored, room.views);
    const start = performance.now();
    room.journalPendingAt ??= start;
    try {
      const confirmation = await this.store.call<{ batchSize?: number; writer?: Record<string, unknown> } | undefined>('commit', { match: publication.match, leaseOwner: this.leaseOwner, journal, receipts, result });
      if (confirmation?.batchSize) this.samples.maxCommitBatchSize = Math.max(this.samples.maxCommitBatchSize, confirmation.batchSize);
      if (confirmation?.writer) this.writerMetrics = confirmation.writer;
    }
    catch (error) { this.failRoom(room); throw error; }
    room.published = publication;
    room.publishedAt = room.viewsProducedAt;
    const elapsed = performance.now() - start; this.commitTiming.record(elapsed);
    this.journalAgeTiming.record(performance.now() - room.journalPendingAt); room.journalPendingAt = null;
    this.samples.maxCommitMs = Math.max(this.samples.maxCommitMs, elapsed); room.lastPersistAt = Date.now();
  }
  async connect(peer: Peer): Promise<void> {
    await this.ready; if (this.draining) throw new Error('SERVER_BUSY'); const room = this.rooms.get(peer.claims.matchId);
    if (room?.failed) throw new Error('SERVER_UNAVAILABLE');
    if (!room || (room.stored.kind === 'practice' ? peer.claims.issuer !== 'iva-realtime-practice' : peer.claims.issuer !== 'iva-platform') || room.stored.rosterHash !== peer.claims.rosterHash || room.stored.roomId !== peer.claims.roomId ||
      room.stored.rulesVersion !== peer.claims.rulesVersion || room.stored.contentVersion !== peer.claims.contentVersion ||
      !room.stored.roster.some(p => p.participantId === peer.claims.participantId && p.playerId === peer.claims.playerId && p.controller === 'human') ||
      room.stored.phase === 'abandoned' || room.stored.expiresAt < Date.now()) throw new Error('AUTH_REQUIRED');
    if (!await this.store.call<boolean>('checkAdmission', peer.claims.admissionId, peer.claims.playerId)) throw new Error('AUTH_REQUIRED');
    await this.store.call('consumeTicket', peer.claims.ticketId, peer.claims.expiresAt);
    await this.locked(room, async () => {
      if (this.draining || this.closed) throw new Error('SERVER_BUSY');
      if (room.failed) throw new Error('SERVER_UNAVAILABLE');
      room.peers.set(peer.id, peer); const control = room.stored.controls[peer.claims.participantId];
      room.stored.lastHumanAt = Date.now(); room.stored.expiresAt = Date.now() + LIMITS.resumeForMs;
      if (!control.connectionId) { control.generation++; control.connectionId = peer.id; control.lastActivity = Date.now(); control.lastInputAt = 0; control.inputSeq = -1; control.consumed = -1; control.temporaryBot = false; }
      if (['paused', 'ready', 'recovering'].includes(room.stored.phase)) {
        room.stored.phase = 'running'; room.stored.pausedAt = null; room.stored.pauseReason = null; room.stored.countdownUntil = Date.now() + 3000;
        room.nextTickAt = performance.now();
      }
      await this.persist(room, { type: 'connect', participantId: peer.claims.participantId, generation: control.generation, controller: control.connectionId === peer.id });
      peer.send({ type: 'hello', protocolVersion: 1, matchId: room.stored.matchId, participantId: peer.claims.participantId,
        epoch: room.stored.epoch, controllerGeneration: control.generation, controlling: control.connectionId === peer.id,
        rulesVersion: room.stored.rulesVersion, contentVersion: room.stored.contentVersion, artifactId: room.stored.manifest.runtime, contentId: room.stored.manifest.client,
        phase: room.stored.phase, resumeUntil: room.stored.expiresAt, countdownUntil: room.stored.countdownUntil });
      this.full(room, peer);
    });
  }
  disconnect(peer: Peer): void {
    if (this.closed) return;
    const room = this.rooms.get(peer.claims.matchId); if (!room) return;
    room.peers.delete(peer.id);
    void this.locked(room, async () => {
      if (room.failed) return;
      const control = room.stored.controls[peer.claims.participantId];
      if (control.connectionId === peer.id) { control.connectionId = null; delete room.inputs[peer.claims.participantId]; await this.persist(room, { type: 'disconnect', participantId: peer.claims.participantId }); }
    }).catch(() => this.failRoom(room));
  }
  private envelope(room: Room, peer: Peer) {
    const match = room.published.match;
    return { protocolVersion: 1, matchId: match.matchId, epoch: match.epoch,
      controllerGeneration: match.controls[peer.claims.participantId].generation };
  }
  private full(room: Room, peer: Peer): void { this.snapshot(room, peer, true); }
  private snapshot(room: Room, peer: Peer, forceFull = false): void {
    if (room.failed) return;
    // A suspended former owner may not send stale authority after its lease expires.
    if (Date.now() - room.lastPersistAt > 14_500) { this.failRoom(room); return; }
    const { match, views } = room.published;
    if (match.pendingOutcome && Date.now() < match.countdownUntil) return;
    let stream = this.projections.get(peer);
    if (!stream) { stream = new ProjectionStream<WorldView>(); this.projections.set(peer, stream); }
    const bytes = peer.queuedBytes();
    if (bytes > LIMITS.maxQueuedBytes) {
      stream.reset();
      if (!peer.blockedSince) { this.samples.resyncs++; this.resyncReasons.backpressure++; }
      peer.blockedSince ||= Date.now();
      if (bytes > LIMITS.closeQueuedBytes || Date.now() - peer.blockedSince > 2000) peer.close(1013, 'SLOW_CONNECTION');
      return;
    }
    peer.blockedSince = 0;
    const view = views[peer.claims.participantId]; if (!view) return;
    if (match.phase === 'running' && Date.now() >= match.countdownUntil) this.snapshotAgeTiming.record(performance.now() - room.publishedAt);
    peer.send({ ...stream.snapshot(view, match.epoch, forceFull), ...this.envelope(room, peer), worldTick: match.tick,
      rulesVersion: match.rulesVersion, contentVersion: match.contentVersion,
      committedJournalSeq: match.journalSeq, lastConsumedInputSeq: match.controls[peer.claims.participantId].consumed,
      phase: match.phase, pauseReason: match.pauseReason ?? null, countdownUntil: match.countdownUntil, resumeUntil: match.expiresAt });
  }
  async message(peer: Peer, message: Exclude<ClientMessage, {type: 'authenticate'}>): Promise<void> {
    const room = this.rooms.get(peer.claims.matchId); if (!room || message.matchId !== room.stored.matchId) throw new Error('MATCH_UNAVAILABLE');
    if (room.failed) throw new Error('SERVER_UNAVAILABLE');
    peer.lastSeen = Date.now();
    if (message.epoch !== room.stored.epoch) { this.samples.resyncs++; this.resyncReasons.staleEpoch++; this.full(room, peer); throw new Error('STALE_EPOCH'); }
    if (message.type === 'resync') { this.samples.resyncs++; this.resyncReasons.requested++; this.full(room, peer); return; }
    if (message.type === 'heartbeat' || message.type === 'ackSnapshot') {
      if (message.type === 'ackSnapshot') this.projections.get(peer)?.acknowledge(message.snapshotSeq);
      const control = room.stored.controls[peer.claims.participantId]; if (control.connectionId === peer.id) control.lastActivity = Date.now();
      return;
    }
    await this.locked(room, async () => {
      if (room.failed) throw new Error('SERVER_UNAVAILABLE');
      const control = room.stored.controls[peer.claims.participantId];
      if (message.controllerGeneration !== control.generation) throw new Error('STALE_CONTROLLER');
      if (message.type === 'claimControl') {
        const previous = control.connectionId; control.generation++; control.connectionId = peer.id; control.inputSeq = -1; control.consumed = -1;
        control.lastActivity = Date.now(); control.lastInputAt = 0; control.temporaryBot = false; delete room.inputs[peer.claims.participantId];
        await this.persist(room, { type: 'claimControl', participantId: peer.claims.participantId, generation: control.generation });
        for (const p of room.peers.values()) if (p.claims.participantId === peer.claims.participantId) p.send({ type: 'controlChanged', ...this.envelope(room, p), controlling: p.id === peer.id, previousConnection: p.id === previous });
        this.full(room, peer); return;
      }
      if (control.connectionId !== peer.id) throw new Error('VIEW_ONLY');
      control.lastActivity = Date.now();
      if (message.type === 'input') {
        if (this.draining || room.stored.phase !== 'running') throw new Error('MATCH_PAUSED');
        const input = normalizeInput({ ...message.payload, inputSeq: message.inputSeq });
        if (!input || message.inputSeq <= control.inputSeq) return;
        control.inputSeq = message.inputSeq; control.lastInputAt = Date.now(); room.inputs[peer.claims.participantId] = input; return;
      }
      if (message.type === 'action') {
        const payloadHash = hash(canonical(message.payload));
        const old = await this.store.call<Receipt | null>('receipt', room.stored.matchId, message.actionId);
        if (old) {
          if (old.participantId !== peer.claims.participantId || old.payloadHash !== payloadHash) throw new Error('ACTION_CONFLICT');
          peer.send({ type: 'actionAck', ...this.envelope(room, peer), actionId: message.actionId, result: old.result, replayed: true }); return;
        }
        if (this.draining || room.stored.phase !== 'running') throw new Error('MATCH_PAUSED');
        const pending = room.pending.get(message.actionId);
        if (pending) {
          if (pending.participantId !== peer.claims.participantId || pending.payloadHash !== payloadHash) throw new Error('ACTION_CONFLICT');
          pending.peers.add(peer); return;
        }
        if (room.actions.length >= 64) throw new Error('SERVER_BUSY');
        const action: PendingAction = { participantId: peer.claims.participantId, actionId: message.actionId, payload: message.payload, payloadHash, peers: new Set([peer]) };
        room.actions.push(action); room.pending.set(action.actionId, action);
      }
    });
  }
  private schedule(): void {
    if (this.draining || this.closed) return;
    const now = performance.now();
    if (this.queuedStarts.length && now >= this.nextAdmissionAt) {
      this.nextAdmissionAt = now + 1000;
      void this.pumpStarts().catch(() => { this.samples.admissionFailures++; });
    }
    const rooms = [...this.rooms.values()], start = this.nextRoom;
    this.nextRoom = rooms.length ? (start + 1) % rooms.length : 0;
    for (let i = 0; i < rooms.length; i++) {
      const room = rooms[(start + i) % rooms.length];
      if (room.failed || room.busy || now < room.nextTickAt) continue;
      room.busy = true;
      void this.locked(room, async () => {
        let steps = 0;
        do { await this.tick(room); room.nextTickAt += 1000 / 30; steps++; }
        while (room.stored.phase === 'running' && performance.now() >= room.nextTickAt && steps < 2);
        if (performance.now() - room.nextTickAt > 1000) {
          room.stored.phase = 'paused'; room.stored.pausedAt = Date.now(); room.stored.pauseReason = 'SERVER_BUSY'; await this.persist(room, { type: 'overloadPause' });
          for (const peer of room.peers.values()) peer.send({ type: 'phaseChanged', ...this.envelope(room, peer), phase: 'paused', reason: 'SERVER_BUSY' });
          room.nextTickAt = performance.now() + 1000;
        }
      }).catch(() => this.failRoom(room)).finally(() => { room.busy = false; });
    }
  }
  private async tick(room: Room): Promise<void> {
    const now = Date.now();
    const present = [...room.peers.values()].filter(peer => now - peer.lastSeen < 10_000);
    const lastSignal = Math.max(room.stored.lastHumanAt, ...[...room.peers.values()].map(peer => peer.lastSeen));
    room.stored.lastHumanAt = lastSignal;
    if (present.length) room.stored.expiresAt = lastSignal + LIMITS.resumeForMs;
    if (room.stored.phase === 'running' && !present.length && now - room.stored.lastHumanAt >= LIMITS.pauseAfterMs) {
      room.stored.phase = 'paused'; room.stored.pausedAt = now; room.stored.pauseReason = 'NO_HUMANS'; await this.persist(room, { type: 'emptyPause' });
      for (const peer of room.peers.values()) peer.send({ type: 'phaseChanged', ...this.envelope(room, peer), phase: 'paused', reason: 'NO_HUMANS' });
    }
    if (room.stored.expiresAt < now && !['finished', 'abandoned'].includes(room.stored.phase)) {
      room.stored.phase = 'abandoned'; room.stored.pendingOutcome = null;
      const outcome = { resultId: 'abandoned:' + room.stored.matchId, kind: 'abandoned', winner: null };
      room.stored.outcome = outcome; await this.persist(room, { type: 'abandoned' }, [], { resultId: outcome.resultId, outcome });
    }
    if (room.stored.expiresAt < now && ['finished', 'abandoned'].includes(room.stored.phase)) {
      for (const peer of room.peers.values()) peer.close(1000, 'MATCH_CLOSED');
      await room.worker.call('drop', room.stored.matchId); this.rooms.delete(room.stored.matchId); return;
    }
    for (const peer of room.peers.values()) {
      if (now - peer.lastAdmissionCheck >= 60_000) {
        peer.lastAdmissionCheck = now;
        if (!await this.store.call<boolean>('checkAdmission', peer.claims.admissionId, peer.claims.playerId)) peer.close(4001, 'SIGN_IN_AGAIN');
      }
    }
    if (room.stored.phase !== 'running' || now < room.stored.countdownUntil) {
      room.nextTickAt = performance.now() + 1000 / 15;
      if (now - room.lastPersistAt > 5000) await this.persist(room, { type: 'leaseHeartbeat' });
      for (const peer of room.peers.values()) this.snapshot(room, peer);
      return;
    }
    if (room.stored.pendingOutcome && present.length) {
      room.stored.outcome = room.stored.pendingOutcome; room.stored.pendingOutcome = null; room.stored.phase = 'finished';
      const outcome = room.stored.outcome as {resultId: string};
      await this.persist(room, { type: 'returnedOutcome' }, [], { resultId: outcome.resultId, outcome });
      for (const peer of room.peers.values()) this.full(room, peer); return;
    }
    const inputs: Record<string, Input> = {};
    const controls = Object.entries(room.stored.controls).map(([id, control]) => {
      const active = control.connectionId ? room.peers.get(control.connectionId) : undefined;
      control.temporaryBot = now - control.lastActivity >= LIMITS.botAfterMs;
      const last = room.inputs[id];
      if (!control.temporaryBot && last) {
        inputs[id] = now - control.lastInputAt <= LIMITS.neutralAfterMs ? last : { ...last, moveX: 0, moveZ: 0, fireHeld: false, toolHeld: false };
        control.consumed = control.inputSeq;
      }
      return { id, bot: control.temporaryBot, generation: control.generation, rttMs: active?.rttMs ?? 0 };
    });
    const actions = room.actions.splice(0); const start = performance.now(); room.journalPendingAt = start;
    const simulation = await room.worker.call<SimulationResult>('step', room.stored.matchId, inputs,
      actions.map(({ participantId, actionId, payload }) => ({ participantId, actionId, payload })), controls, true);
    const elapsed = performance.now() - start; this.stepTiming.record(elapsed);
    if (simulation.workMs !== undefined) this.stepWorkTiming.record(simulation.workMs);
    if (simulation.workCpuMs !== undefined) {
      this.stepCpuTiming.record(simulation.workCpuMs); this.samples.stepWorkSamples++; this.samples.stepWorkCpuTotalMs += simulation.workCpuMs;
    }
    this.samples.maxStepMs = Math.max(this.samples.maxStepMs, elapsed); this.samples.ticks++;
    room.stored.world = simulation.world; room.stored.worldHash = hash(simulation.world); room.stored.tick = simulation.tick;
    room.views = simulation.views; room.viewsProducedAt = start;
    const receipts: Receipt[] = (simulation.results ?? []).map(result => ({ matchId: room.stored.matchId,
      participantId: result.participantId, actionId: result.actionId, payloadHash: room.pending.get(result.actionId)!.payloadHash,
      result: result.result, epoch: room.stored.epoch, seq: room.stored.journalSeq + 1 }));
    let result: { resultId: string; outcome: unknown } | undefined;
    if (simulation.outcome) {
      if (present.length) { room.stored.phase = 'finished'; room.stored.outcome = simulation.outcome; result = { resultId: simulation.outcome.resultId, outcome: simulation.outcome }; }
      else { room.stored.phase = 'paused'; room.stored.pendingOutcome = simulation.outcome; room.stored.pausedAt = now; room.stored.pauseReason = 'NO_HUMANS'; }
    }
    await this.persist(room, { type: 'tick', inputs, controls, actions: actions.map(({ participantId, actionId, payload }) => ({ participantId, actionId, payload })) }, receipts, result);
    for (const receipt of receipts) {
      const action = room.pending.get(receipt.actionId)!; room.pending.delete(receipt.actionId);
      for (const peer of action.peers) peer.send({ type: 'actionAck', ...this.envelope(room, peer), actionId: receipt.actionId, result: receipt.result });
    }
    if (room.stored.tick % 2 === 0 || receipts.length || room.stored.phase !== 'running') for (const peer of room.peers.values()) this.snapshot(room, peer);
  }
  private failRoom(room: Room): void {
    if (room.failed) return;
    room.failed = true;
    this.samples.storageFailures++; room.stored.phase = 'failed-recoverable'; room.nextTickAt = Number.POSITIVE_INFINITY;
    for (const peer of room.peers.values()) peer.close(1011, 'RECOVERY_REQUIRED');
  }
  view(matchId: string, playerId: string): unknown {
    const room = this.rooms.get(matchId); const match = room?.published.match;
    const participant = match?.roster.find(p => p.playerId === playerId);
    if (!room || !match || !participant) throw new Error('MATCH_UNAVAILABLE');
    return { kind: 'realtime', gameId: 'forpost', matchId, route: this.route(match), phase: room.failed ? 'failed-recoverable' : match.phase,
      participantId: participant.participantId, finished: match.phase === 'finished', outcome: match.outcome,
      resumeUntil: match.expiresAt, rulesVersion: match.rulesVersion, contentVersion: match.contentVersion };
  }
  route(match: StoredMatch): string { return /^sha256:[0-9a-f]{64}$/.test(match.manifest.client) ? '/realtime-assets/' + match.manifest.client.slice(7) + '/' : '/play/forpost/'; }
  health() {
    const now = performance.now(), cpu = process.cpuUsage(), active = [...this.rooms.values()].filter(room => room.published.match.phase === 'running' && Date.now() >= room.published.match.countdownUntil);
    const ages = { journalPendingAgeMs: Math.max(0, ...[...this.rooms.values()].map(room => room.journalPendingAt === null ? 0 : now - room.journalPendingAt)),
      journalAgeP99Ms: this.journalAgeTiming.p99(), snapshotAgeMs: Math.max(0, ...active.map(room => now - room.publishedAt)), snapshotAgeP99Ms: this.snapshotAgeTiming.p99() };
    return { ok: !this.draining && this.samples.storageFailures === 0, service: 'iva-realtime', protocolVersion: 1, artifactId: this.options.artifactId, contentId: this.options.contentId, buildRevision: this.options.buildRevision ?? 'unknown',
    rooms: this.rooms.size, capacity: Math.min(this.options.maxRooms, this.options.capacityProfile?.maxRooms ?? 1), configuredCapacity: this.options.maxRooms, draining: this.draining,
    admission: { mode: this.options.capacityProfile?.source ?? 'conservative', waiting: this.queuedStarts.length,
      reason: this.lastCapacityDecision?.reason ?? 'READY', reservationTtlMs: LIMITS.reservationMs,
      resources: this.options.resourceSample?.() ?? this.resourceProbe.sample() }, metrics: { ...this.samples, ...ages, resyncReasons: { ...this.resyncReasons },
      stepP99Ms: this.stepTiming.p99(), commitP99Ms: this.commitTiming.p99(), eventLoopDelayP99Ms: this.loopDelay.percentile(99) / 1e6,
      stepWorkP99Ms: this.stepWorkTiming.p99(), stepWorkCpuP99Ms: this.stepCpuTiming.p99(),
      processCpuMs: (cpu.user + cpu.system) / 1000, processElapsedMs: now - this.processStartedAt, writer: this.writerMetrics,
      byGame: { forpost: { stepP99Ms: this.stepTiming.p99(), stepWorkP99Ms: this.stepWorkTiming.p99(),
        stepWorkCpuP99Ms: this.stepCpuTiming.p99(), commitP99Ms: this.commitTiming.p99(), ...ages } },
      rssBytes: process.memoryUsage().rss, heapUsedBytes: process.memoryUsage().heapUsed,
      queuedBytesMax: Math.max(0, ...[...this.rooms.values()].flatMap(room => [...room.peers.values()].map(peer => peer.queuedBytes()))) } }; }
  diagnostics() {
    const now = performance.now();
    return { roomDiagnostics: [...this.rooms.values()].map(room => ({ matchId: room.stored.matchId, gameId: 'forpost', phase: room.published.match.phase,
      snapshotAgeMs: now - room.publishedAt, journalPendingAgeMs: room.journalPendingAt === null ? 0 : now - room.journalPendingAt,
      connections: [...room.peers.values()].map(peer => ({ connectionId: peer.id, queuedBytes: peer.queuedBytes() })) })),
    startQueue: this.queuedStarts.map((start, index) => ({ startId: start.startId, position: index + 1, reservedUntil: start.reservedUntil })) };
  }
  async abandon(matchId: string, ownerHash: string): Promise<void> {
    const room = this.rooms.get(matchId);
    if (!room) {
      const saved = await this.store.call<StoredMatch | null>('get', matchId);
      if (saved?.kind === 'practice' && saved.ownerHash === ownerHash && ['abandoned', 'finished'].includes(saved.phase)) return;
      throw new Error('MATCH_UNAVAILABLE');
    }
    if (room.stored.kind !== 'practice' || room.stored.ownerHash !== ownerHash) throw new Error('MATCH_UNAVAILABLE');
    await this.locked(room, async () => {
      if (room.failed) throw new Error('SERVER_UNAVAILABLE');
      if (room.stored.phase !== 'finished') { room.stored.phase = 'abandoned'; room.stored.outcome = null; room.stored.pendingOutcome = null; }
      room.stored.expiresAt = Date.now();
      await this.persist(room, { type: 'practiceAbandoned' });
      for (const peer of room.peers.values()) { this.full(room, peer); peer.close(1000, 'MATCH_CLOSED'); }
      await room.worker.call('drop', room.stored.matchId); this.rooms.delete(room.stored.matchId);
    });
  }
  async drain(): Promise<void> {
    this.draining = true;
    if (this.admitting) await this.admitting.catch(() => {});
    await Promise.allSettled([...this.creating.values()]);
    const failures: unknown[] = [];
    for (const room of this.rooms.values()) {
      try { await this.locked(room, async () => {
        if (room.failed) throw new Error('RECOVERY_REQUIRED');
        if (!['finished', 'abandoned'].includes(room.stored.phase)) { room.stored.phase = 'paused'; room.stored.pausedAt ??= Date.now(); room.stored.pauseReason = 'SERVER_UPDATING'; }
        await this.persist(room, { type: 'drain' });
        for (const peer of room.peers.values()) peer.send({ type: 'phaseChanged', ...this.envelope(room, peer), phase: 'paused', reason: 'SERVER_UPDATING' });
      }); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'RECOVERY_REQUIRED');
  }
  async resume(): Promise<void> {
    if (this.closed || this.samples.storageFailures) throw new Error('SERVER_UNAVAILABLE');
    for (const room of this.rooms.values()) await this.locked(room, async () => {
      if (room.stored.phase === 'paused' && room.peers.size) {
        room.stored.phase = 'running'; room.stored.pauseReason = null; room.stored.countdownUntil = Date.now() + 3000; room.nextTickAt = performance.now();
        await this.persist(room, { type: 'resumeAfterDrain' });
      }
    });
    this.draining = false;
  }
  async close(): Promise<void> {
    if (this.closed) return;
    const failures: unknown[] = [];
    try { await this.drain(); } catch (error) { failures.push(error); }
    this.closed = true; this.loopDelay.disable(); if (this.timer) clearInterval(this.timer);
    for (const room of this.rooms.values()) for (const peer of room.peers.values()) peer.close(1012, 'SERVER_UPDATING');
    try { await this.store.call('release', this.leaseOwner); } catch (error) { failures.push(error); }
    try { await this.store.call('close'); } catch (error) { failures.push(error); }
    await Promise.all([...[...this.workers.values()].flat().map(worker => worker.stop()), this.store.stop()]);
    if (failures.length) throw new AggregateError(failures, 'RECOVERY_REQUIRED');
  }
}
