import Database from 'better-sqlite3';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { canonicalJson, SessionError } from '@iva-games/session-kit';
import type { ActionEnvelope, GameRegistration, Participant, RealtimeGameRuntime, RealtimeInput, RealtimeSnapshot, StartMatchRequest } from '@iva-games/session-kit';
import { BOT_VERSION, CONTENT_VERSION, RULES_VERSION, TICK_RATE, WIRE_VERSION, connectSeat, createMatch, disconnectSeat, normalizeSettings, recoverMatch, viewForSeat } from '../core/index';
import type { InputCommand, QueuedCommand, Receipt, Seat, ShiftCommandPayload, ShiftSettings, ShiftState, ShiftView, TeamId } from '../core/types';
import { advanceWithBots } from '../bots/index';

export interface ShiftRoomSettings extends ShiftSettings {
  teams?: Record<string, TeamId>;
  initialNavigators?: Partial<Record<TeamId, string>>;
}
interface MatchRow { match_id: string; room_id: string; start_command_id: string; request_hash: string; roster: string; state: string; finished: number }
interface ReceiptRow { request_hash: string; response: string }
interface Pending { seatId: string; command: ShiftCommandPayload; hash: string; resolve(value: Receipt): void; reject(error: unknown): void; promise: Promise<Receipt> }
interface Control { epoch: string; controllerEpoch: number; lastReceivedSeq: number; finalView?: ShiftView }
interface Resident { state: ShiftState; roster: Participant[]; queue: Pending[]; pending: Map<string, Pending>; inputs: Map<string, InputCommand>; checkpointTick: number; failed: boolean; controls: Map<string, Control> }
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9:_-]{1,128}$/.test(value);
const fingerprint = (value: unknown): string => createHash('sha256').update(canonicalJson(value)).digest('hex');
function fail(code: string, message = 'Действие сейчас недоступно', status = 409): never { throw new SessionError(code, message, status); }
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_INPUT', 'Проверьте действие', 400);
  return value as Record<string, unknown>;
};
const nonnegativeInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Lobby-only ownership fields never become an alternate account or controller identity. */
export function shiftRoomSettings(input: unknown): ShiftRoomSettings {
  const value = input === undefined ? {} : object(input);
  if (Object.keys(value).some(key => !['arena', 'teamSize', 'rotateRoles', 'difficulty', 'teams', 'initialNavigators'].includes(key))) fail('INVALID_SETTINGS', 'Проверьте настройки игры', 400);
  let settings: ShiftRoomSettings;
  try { settings = normalizeSettings({ arena: value.arena, teamSize: value.teamSize, rotateRoles: value.rotateRoles, difficulty: value.difficulty }); }
  catch { return fail('INVALID_SETTINGS', 'Проверьте настройки игры', 400); }
  if (value.teams !== undefined) {
    const mapping = object(value.teams);
    if (Object.keys(mapping).length > 6 || Object.entries(mapping).some(([id, team]) => !identifier(id) || !['teal', 'amber'].includes(String(team)))) fail('INVALID_SETTINGS', 'Проверьте команды', 400);
    settings.teams = { ...mapping } as Record<string, TeamId>;
  }
  if (value.initialNavigators !== undefined) {
    const mapping = object(value.initialNavigators);
    if (Object.entries(mapping).some(([team, id]) => !['teal', 'amber'].includes(team) || !identifier(id))) fail('INVALID_SETTINGS', 'Выберите штурманов', 400);
    settings.initialNavigators = { ...mapping } as Partial<Record<TeamId, string>>;
  }
  return settings;
}

function seatsFor(settings: ShiftRoomSettings, participants: Participant[]): Seat[] {
  const sorted = [...participants].sort((a, b) => a.seatIndex - b.seatIndex);
  const seats: Seat[] = sorted.map((p, index) => ({
    seatId: p.participantId, displayName: p.displayName,
    team: settings.teams?.[p.participantId] ?? (index < settings.teamSize ? 'teal' : 'amber'), teamIndex: 0,
    initialRole: 'pilot', bot: p.controller.kind === 'bot',
    difficulty: p.controller.kind === 'bot' ? p.controller.difficulty : settings.difficulty,
  }));
  for (const team of ['teal', 'amber'] as const) {
    const members = seats.filter(seat => seat.team === team);
    if (members.length !== settings.teamSize) fail('INVALID_TEAMS', 'В командах должно быть поровну игроков');
    const navigatorId = settings.initialNavigators?.[team] ?? members[0].seatId;
    if (!members.some(seat => seat.seatId === navigatorId)) fail('INVALID_ROLES', 'Выберите штурмана своей команды');
    members.forEach((seat, index) => { seat.teamIndex = index; seat.initialRole = seat.seatId === navigatorId ? 'navigator' : 'pilot'; });
  }
  return seats;
}

export function validateShiftRoom(raw: Record<string, unknown>, capacity: number, participants?: Participant[]): void {
  const settings = shiftRoomSettings(raw);
  if (capacity !== settings.teamSize * 2) fail('PLAYER_COUNT', 'Выберите 2×2 или 3×3');
  if (!participants) return;
  if (participants.length !== capacity) fail('PLAYER_COUNT', 'Заполните все места игроками или ботами');
  const ids = new Set<string>(), players = new Set<string>(), seats = new Set<number>();
  for (const p of participants) {
    if (!identifier(p.participantId) || ids.has(p.participantId) || !nonnegativeInteger(p.seatIndex) || p.seatIndex >= capacity || seats.has(p.seatIndex) || typeof p.displayName !== 'string' || !p.displayName.trim() || p.displayName.length > 40) fail('INVALID_ROSTER', 'Проверьте состав');
    ids.add(p.participantId); seats.add(p.seatIndex);
    if (p.controller.kind === 'human') {
      if (!identifier(p.playerId) || p.controller.playerId !== p.playerId || players.has(p.playerId)) fail('INVALID_ROSTER', 'Один аккаунт занимает одно место');
      players.add(p.playerId);
    } else if (p.controller.kind !== 'bot' || p.playerId !== null || !['easy', 'normal', 'hard'].includes(p.controller.difficulty) || p.controller.botVersion !== BOT_VERSION || p.controller.botProfileId !== `shift:${p.controller.difficulty}`) fail('INCOMPATIBLE_VERSION', 'Добавьте бота заново');
  }
  if (players.size < 2) fail('HUMANS_REQUIRED', 'Пригласите второго игрока или откройте практику');
  if (settings.teams && Object.keys(settings.teams).some(id => !ids.has(id))) fail('INVALID_TEAMS', 'Обновите состав команд');
  seatsFor(settings, participants);
}

export function reconcileShiftRoster(raw: Record<string, unknown>, participants: Participant[]): Record<string, unknown> {
  const settings = shiftRoomSettings(raw), sorted = [...participants].sort((a, b) => a.seatIndex - b.seatIndex);
  const present = new Set(sorted.map(p => p.participantId));
  const teams = Object.fromEntries(Object.entries(settings.teams ?? {}).filter(([id]) => present.has(id))) as Record<string, TeamId>;
  const count = (team: TeamId) => Object.values(teams).filter(value => value === team).length;
  for (const member of sorted) if (!teams[member.participantId]) {
    const preferred = member.seatIndex < settings.teamSize ? 'teal' : 'amber';
    teams[member.participantId] = count(preferred) < settings.teamSize ? preferred : preferred === 'teal' ? 'amber' : 'teal';
  }
  const initialNavigators: Partial<Record<TeamId, string>> = {};
  for (const team of ['teal', 'amber'] as const) {
    const selected = settings.initialNavigators?.[team];
    const navigator = selected && teams[selected] === team ? selected : sorted.find(p => teams[p.participantId] === team)?.participantId;
    if (navigator) initialNavigators[team] = navigator;
  }
  return { ...settings, teams, initialNavigators };
}

function parseCommand(value: unknown, actionId?: string): ShiftCommandPayload {
  const p = object(value);
  if (!nonnegativeInteger(p.roundId) || !nonnegativeInteger(p.controllerEpoch)) fail('INVALID_INPUT', 'Обновите состояние игры', 400);
  const scope = { roundId: p.roundId, controllerEpoch: p.controllerEpoch };
  if (actionId === undefined) {
    if (p.type !== 'input' || !nonnegativeInteger(p.seq) || typeof p.moveX !== 'number' || !Number.isFinite(p.moveX) || Math.abs(p.moveX) > 1 || typeof p.moveZ !== 'number' || !Number.isFinite(p.moveZ) || Math.abs(p.moveZ) > 1 || typeof p.aim !== 'number' || !Number.isFinite(p.aim) || Math.abs(p.aim) > 100 || typeof p.fireHeld !== 'boolean') fail('INVALID_INPUT', 'Проверьте управление', 400);
    return { type: 'input', ...scope, seq: p.seq, moveX: p.moveX, moveZ: p.moveZ, aim: p.aim, fireHeld: p.fireHeld };
  }
  if (p.actionId !== undefined && p.actionId !== actionId) fail('ACTION_CONFLICT', 'Повторите действие');
  if (p.type === 'interact') return { type: 'interact', ...scope, actionId };
  if (p.type === 'shift') {
    if (typeof p.roomId !== 'string' || !['A', 'B', 'C', 'D', 'E', 'F', 'G', 'O'].includes(p.roomId) || !nonnegativeInteger(p.expectedBoardRevision)) fail('INVALID_INPUT', 'Выберите комнату', 400);
    return { type: 'shift', ...scope, actionId, roomId: p.roomId as 'A', expectedBoardRevision: p.expectedBoardRevision };
  }
  if (p.type === 'ping') {
    if (!['shift', 'look', 'battery'].includes(String(p.kind))) fail('INVALID_INPUT', 'Выберите метку', 400);
    const result: ShiftCommandPayload = { type: 'ping', ...scope, actionId, kind: p.kind as 'shift' };
    if (p.roomId !== undefined) {
      if (typeof p.roomId !== 'string' || !['A', 'B', 'C', 'D', 'E', 'F', 'G', 'O'].includes(p.roomId)) fail('INVALID_INPUT', 'Выберите комнату', 400);
      result.roomId = p.roomId as 'A';
    }
    if (p.pose !== undefined) {
      const pose = object(p.pose);
      if (!['A', 'B', 'C', 'D', 'E', 'F', 'G', 'O', 'west', 'east'].includes(String(pose.spaceId)) || typeof pose.x !== 'number' || !Number.isFinite(pose.x) || typeof pose.z !== 'number' || !Number.isFinite(pose.z) || Math.abs(pose.x) > 40 || Math.abs(pose.z) > 40) fail('INVALID_INPUT', 'Выберите видимую точку', 400);
      result.pose = { spaceId: pose.spaceId as 'A', x: pose.x, z: pose.z };
    }
    return result;
  }
  return fail('INVALID_ACTION', 'Действие недоступно', 400);
}

/** One owner per match. Socket callbacks only enqueue; a fixed step resolves all contenders. */
export class ShiftRuntime implements RealtimeGameRuntime {
  readonly wireVersion = WIRE_VERSION;
  private readonly db: Database.Database;
  private readonly matches = new Map<string, Resident>();
  private readonly timer: ReturnType<typeof setInterval> | undefined;
  private closed = false;

  constructor(options: { databasePath: string; autoTick?: boolean }) {
    if (options.databasePath !== ':memory:') mkdirSync(dirname(options.databasePath), { recursive: true, mode: 0o700 });
    this.db = new Database(options.databasePath);
    if (options.databasePath !== ':memory:') chmodSync(options.databasePath, 0o600);
    this.db.pragma('journal_mode = WAL'); this.db.pragma('busy_timeout = 5000'); this.db.pragma('foreign_keys = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS shift_schema (singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL);
      INSERT OR IGNORE INTO shift_schema VALUES (1,1);
      CREATE TABLE IF NOT EXISTS shift_matches (
        match_id TEXT PRIMARY KEY, room_id TEXT NOT NULL, start_command_id TEXT NOT NULL UNIQUE,
        request_hash TEXT NOT NULL, roster TEXT NOT NULL, state TEXT NOT NULL, finished INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS shift_room_history ON shift_matches(room_id);
      CREATE TABLE IF NOT EXISTS shift_receipts (
        match_id TEXT NOT NULL REFERENCES shift_matches(match_id), seat_id TEXT NOT NULL, action_id TEXT NOT NULL,
        request_hash TEXT NOT NULL, response TEXT NOT NULL, PRIMARY KEY(match_id,seat_id,action_id)
      );
    `);
    const schema = this.db.prepare('SELECT version FROM shift_schema WHERE singleton=1').get() as { version: number };
    if (schema.version !== 1) { this.db.close(); throw new Error('Unsupported Shift schema'); }
    for (const row of this.db.prepare('SELECT * FROM shift_matches WHERE finished=0').all() as MatchRow[]) {
      const entry = this.restore(row); recoverMatch(entry.state); this.persist(row.match_id, entry);
    }
    if (options.autoTick !== false) {
      let nextTick = performance.now() + 1000 / TICK_RATE;
      this.timer = setInterval(() => {
        const due = Math.min(4, Math.max(0, Math.floor((performance.now() - nextTick) * TICK_RATE / 1000) + 1));
        if (due) { this.advanceTicks(due); nextTick += due * 1000 / TICK_RATE; }
      }, 8);
      this.timer.unref();
    }
  }

  registration(): GameRegistration {
    return { gameId: 'shift', collectionId: 'other', title: 'Сдвиг', minPlayers: 4, maxPlayers: 6, supportsBots: true,
      rulesVersion: RULES_VERSION, contentVersion: CONTENT_VERSION, status: 'available', runtime: this,
      normalizeSettings: input => ({ ...shiftRoomSettings(input) }), validateRoom: validateShiftRoom,
      reconcileRoster: reconcileShiftRoster,
      resolveRoomVersion: (rules, content) => rules === RULES_VERSION && content === CONTENT_VERSION ? {
        normalizeSettings: input => ({ ...shiftRoomSettings(input) }), botVersion: BOT_VERSION,
      } : undefined };
  }

  async createMatch(input: StartMatchRequest): Promise<{ matchId: string }> {
    if (!identifier(input.startCommandId) || !identifier(input.roomId)) fail('INVALID_ROSTER');
    if (input.rulesVersion !== RULES_VERSION || input.contentVersion !== CONTENT_VERSION) fail('INCOMPATIBLE_VERSION', 'Создайте новую комнату');
    const settings = shiftRoomSettings(input.settings);
    validateShiftRoom({ ...settings }, settings.teamSize * 2, input.participants);
    const hash = fingerprint(input);
    const previous = this.db.prepare('SELECT * FROM shift_matches WHERE start_command_id=?').get(input.startCommandId) as MatchRow | undefined;
    if (previous) {
      if (previous.request_hash !== hash) fail('START_CONFLICT', 'Партия уже началась');
      return { matchId: previous.match_id };
    }
    if (this.db.prepare('SELECT 1 FROM shift_matches WHERE room_id=? AND finished=0').get(input.roomId)) fail('START_CONFLICT', 'Партия уже началась');
    const matchId = randomUUID();
    const state = createMatch(settings, seatsFor(settings, input.participants), randomBytes(4).readUInt32LE());
    const roster = structuredClone(input.participants);
    this.db.prepare('INSERT INTO shift_matches VALUES (?,?,?,?,?,?,0)').run(matchId, input.roomId, input.startCommandId, hash, JSON.stringify(roster), JSON.stringify(state));
    this.matches.set(matchId, { state, roster, queue: [], pending: new Map(), inputs: new Map(), checkpointTick: state.tick, failed: false, controls: new Map() });
    return { matchId };
  }

  private restore(row: MatchRow): Resident {
    const state = JSON.parse(row.state) as ShiftState;
    if (state.rulesVersion !== RULES_VERSION || state.contentVersion !== CONTENT_VERSION || state.wireVersion !== WIRE_VERSION) fail('INCOMPATIBLE_VERSION', 'Не удалось открыть эту партию');
    const entry: Resident = { state, roster: JSON.parse(row.roster) as Participant[], queue: [], pending: new Map(), inputs: new Map(), checkpointTick: state.tick, failed: false, controls: new Map() };
    // Completed HTTP reads use the durable final state without populating the
    // simulation clock's resident map. A live result page acquires its own lease.
    if (state.phase !== 'finished') this.matches.set(row.match_id, entry);
    return entry;
  }
  private resident(matchId: string): Resident {
    if (this.closed) fail('SERVER_RESTARTING', 'Игра обновляется', 503);
    const entry = this.matches.get(matchId);
    if (entry) { if (entry.failed) fail('LIVE_UNAVAILABLE', 'Переподключитесь к игре', 503); return entry; }
    const row = this.db.prepare('SELECT * FROM shift_matches WHERE match_id=?').get(matchId) as MatchRow | undefined;
    if (!row) fail('MATCH_NOT_FOUND', 'Матч не найден', 404);
    return this.restore(row);
  }
  private human(entry: Resident, playerId: string): string {
    const p = entry.roster.find(seat => seat.playerId === playerId && seat.controller.kind === 'human');
    return p?.participantId ?? fail('FORBIDDEN', 'Вы не участник этой партии', 403);
  }
  private releaseFinished(matchId: string, entry: Resident): void {
    if (entry.state.phase === 'finished' && entry.controls.size === 0 && entry.pending.size === 0 && this.matches.get(matchId) === entry) {
      entry.inputs.clear(); this.matches.delete(matchId);
    }
  }
  private persist(matchId: string, entry: Resident, settled: { pending: Pending; receipt: Receipt }[] = []): void {
    this.db.transaction(() => {
      this.db.prepare('UPDATE shift_matches SET state=?,finished=? WHERE match_id=?').run(JSON.stringify(entry.state), entry.state.phase === 'finished' ? 1 : 0, matchId);
      for (const { pending, receipt } of settled) {
        this.db.prepare('INSERT INTO shift_receipts VALUES (?,?,?,?,?) ON CONFLICT(match_id,seat_id,action_id) DO NOTHING').run(matchId, pending.seatId, pending.command.type === 'input' ? '' : pending.command.actionId, pending.hash, JSON.stringify(receipt));
      }
    }).immediate();
    entry.checkpointTick = entry.state.tick;
  }

  /** Also used by deterministic integration tests; no HTTP route can advance time. */
  advanceTicks(count = 1): void {
    if (this.closed) return;
    for (let i = 0; i < count; i++) for (const [matchId, entry] of this.matches) {
      if (entry.failed) continue;
      if (entry.state.phase === 'finished' && !entry.queue.length) { this.releaseFinished(matchId, entry); continue; }
      const pending = entry.queue.splice(0);
      const queue: QueuedCommand[] = [...entry.inputs].map(([seatId, command]) => ({ seatId, command }));
      entry.inputs.clear();
      queue.push(...pending.map(item => ({ seatId: item.seatId, command: item.command })));
      try {
        const result = advanceWithBots(entry.state, queue);
        const settled = pending.map(item => {
          const actionId = item.command.type === 'input' ? '' : item.command.actionId;
          const receipt = result.receipts.find(value => value.actionId === actionId && value.seatId === item.seatId);
          if (!receipt) throw new Error('Missing receipt for queued command');
          return { pending: item, receipt };
        });
        if (result.checkpoint || settled.length || entry.state.tick - entry.checkpointTick >= 2 * TICK_RATE || entry.state.phase === 'finished') this.persist(matchId, entry, settled);
        for (const { pending: item, receipt } of settled) {
          entry.pending.delete(`${item.seatId}:${receipt.actionId}`); item.resolve(receipt);
        }
        this.releaseFinished(matchId, entry);
      } catch (error) {
        entry.failed = true;
        for (const item of pending) item.reject(error);
        for (const item of entry.queue.splice(0)) item.reject(error);
        entry.pending.clear();
        // Never acknowledge an uncommitted state. A restart reads the last whole transaction.
      }
    }
  }

  async viewForPlayer(matchId: string, playerId: string): Promise<unknown> {
    const entry = this.resident(matchId); return viewForSeat(entry.state, this.human(entry, playerId));
  }
  async status(matchId: string): Promise<{ finished: boolean; outcome?: unknown }> {
    const state = this.resident(matchId).state;
    return { finished: state.phase === 'finished', ...(state.phase === 'finished' ? { outcome: { winner: state.winner, score: state.score, rounds: state.rounds } } : {}) };
  }
  async applyAction(matchId: string, playerId: string, envelope: ActionEnvelope): Promise<unknown> {
    const entry = this.resident(matchId); const seatId = this.human(entry, playerId);
    if (typeof envelope.actionId !== 'string' || !/^[A-Za-z0-9._:-]{8,100}$/.test(envelope.actionId) || !nonnegativeInteger(envelope.expectedRevision)) fail('INVALID_ACTION');
    // The shared envelope mirrors the board revision. Interact/ping retain
    // their core preconditions; only shifts are conditional on this revision.
    const payload = object(envelope.payload);
    if (payload.type === 'shift' && envelope.expectedRevision !== payload.expectedBoardRevision) fail('INVALID_INPUT', 'Проверьте версию плана', 400);
    return this.enqueue(matchId, entry, seatId, envelope.actionId, envelope.payload);
  }
  private enqueue(matchId: string, entry: Resident, seatId: string, actionId: string, raw: unknown): Promise<Receipt> {
    const command = parseCommand(raw, actionId), hash = fingerprint(command);
    const row = this.db.prepare('SELECT request_hash,response FROM shift_receipts WHERE match_id=? AND seat_id=? AND action_id=?').get(matchId, seatId, actionId) as ReceiptRow | undefined;
    if (row) {
      if (row.request_hash !== hash) fail('ACTION_CONFLICT', 'Повторите действие');
      return Promise.resolve(JSON.parse(row.response) as Receipt);
    }
    // Terminal matches never accept a new action ID. Previously acknowledged
    // actions above still replay durably, including after eviction or restart.
    if (entry.state.phase === 'finished') fail('MATCH_FINISHED', 'Матч завершён');
    const key = `${seatId}:${actionId}`, previous = entry.pending.get(key);
    if (previous) { if (previous.hash !== hash) fail('ACTION_CONFLICT'); return previous.promise; }
    if (entry.queue.filter(item => item.seatId === seatId).length >= 8) fail('COMMAND_RATE');
    let resolve!: (value: Receipt) => void, reject!: (error: unknown) => void;
    const promise = new Promise<Receipt>((yes, no) => { resolve = yes; reject = no; });
    const pending: Pending = { seatId, command, hash, resolve, reject, promise };
    entry.queue.push(pending); entry.pending.set(key, pending); return promise;
  }

  async liveConnect(matchId: string, playerId: string, epoch: string): Promise<RealtimeSnapshot> {
    if (typeof epoch !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(epoch)) fail('INVALID_INPUT', 'Обновите соединение', 400);
    const entry = this.resident(matchId), seatId = this.human(entry, playerId);
    if (entry.controls.get(seatId)?.epoch === epoch) return this.liveSnapshot(matchId, playerId, epoch);
    const controllerEpoch = connectSeat(entry.state, seatId);
    entry.inputs.delete(seatId);
    entry.controls.set(seatId, { epoch, controllerEpoch, lastReceivedSeq: -1 });
    this.persist(matchId, entry);
    this.matches.set(matchId, entry);
    return this.liveSnapshot(matchId, playerId, epoch);
  }

  private control(entry: Resident, seatId: string, epoch: string): Control {
    const control = entry.controls.get(seatId);
    if (!control || control.epoch !== epoch || entry.state.actors[seatId]?.controllerEpoch !== control.controllerEpoch) fail('STALE_EPOCH', 'Управление перешло в другую вкладку');
    return control;
  }

  liveInput(matchId: string, playerId: string, input: RealtimeInput): void {
    const entry = this.resident(matchId), seatId = this.human(entry, playerId), control = this.control(entry, seatId, input.epoch);
    const command = parseCommand(input.payload) as InputCommand;
    if (!nonnegativeInteger(input.seq) || input.seq !== command.seq) fail('INVALID_INPUT', 'Проверьте последовательность управления', 400);
    if (command.controllerEpoch !== control.controllerEpoch) fail('STALE_EPOCH');
    if (input.seq <= control.lastReceivedSeq) return;
    control.lastReceivedSeq = input.seq;
    // Do not retain a late round/preparation packet for a later active tick.
    // The core independently validates scope again when it consumes the input,
    // and neutralizes a silent pilot after its existing eight-tick timeout.
    if (command.roundId !== entry.state.round || entry.state.phase !== 'active' || entry.state.recoveryTicksRemaining > 0 || entry.state.actors[seatId].role !== 'pilot') return;
    entry.inputs.set(seatId, command);
  }

  async liveSnapshot(matchId: string, playerId: string, epoch: string): Promise<RealtimeSnapshot> {
    const entry = this.resident(matchId), seatId = this.human(entry, playerId), control = this.control(entry, seatId, epoch);
    let view = control.finalView;
    if (!view) {
      view = viewForSeat(entry.state, seatId);
      if (entry.state.phase === 'finished') control.finalView = view;
    }
    return { tick: entry.state.tick, serverTime: Date.now(), lastAcceptedSeq: entry.state.actors[seatId].lastAcceptedSeq, view };
  }

  liveDisconnect(matchId: string, playerId: string, epoch: string): void {
    if (this.closed) return;
    const entry = this.matches.get(matchId);
    if (!entry) return;
    const seatId = this.human(entry, playerId), control = entry.controls.get(seatId);
    // A delayed close from a replaced controller cannot neutralize its heir.
    if (!control || control.epoch !== epoch) return;
    entry.controls.delete(seatId); entry.inputs.delete(seatId);
    if (!entry.failed) {
      disconnectSeat(entry.state, seatId, control.controllerEpoch);
      const actor = entry.state.actors[seatId];
      actor.input = { moveX: 0, moveZ: 0, aim: actor.aim, fireHeld: false };
      this.persist(matchId, entry);
    }
    this.releaseFinished(matchId, entry);
  }

  close(): void {
    if (this.closed) return;
    if (this.timer) clearInterval(this.timer);
    this.advanceTicks();
    for (const [matchId, entry] of this.matches) if (!entry.failed) this.persist(matchId, entry);
    this.closed = true; this.matches.clear(); this.db.close();
  }
}

export function createShiftRegistration(options: { databasePath: string; autoTick?: boolean }): GameRegistration & { close(): void; runtime: ShiftRuntime } {
  const runtime = new ShiftRuntime(options);
  return { ...runtime.registration(), runtime, close: () => runtime.close() };
}
