import { useCallback, useEffect, useRef, useState } from 'react';
import { LIVE_INPUT_HZ, LIVE_PROTOCOL, LiveRateWindow } from '@iva-games/session-kit';
import type { ActionEnvelope, LiveClientFrame, LiveScope } from '@iva-games/session-kit';
import { connectSeat, createMatch, viewForSeat, stepMatch, CONTENT_VERSION, RULES_VERSION, WIRE_VERSION } from '../core/index';
import { advanceWithBots } from '../bots/index';
import type { PilotInput, QueuedCommand, Receipt, Role, ShiftCommandPayload, ShiftSettings, ShiftState, ShiftView, VisibleActor } from '../core/types';
import { advanceLesson, createLesson, lessonCommands, practiceRoster } from './lesson';
import type { Lesson } from './lesson';
import { predictPilot } from './prediction';
export interface LocalGameConfig { settings: ShiftSettings; role: Role; seed: number; lesson?: Role; resume?: boolean; }
export interface ClientSession { view: ShiftView | null; connected: boolean; status: string; receipt: Receipt | null; lesson?: Lesson; predictSelf?: () => VisibleActor | null; setInput: (input: PilotInput) => void; send: (command: ShiftCommandPayload) => void; setPaused: (paused: boolean) => void; selectLessonRoom: (roomId: string, allowed: boolean) => void; }
const STOP: PilotInput = { moveX: 0, moveZ: 0, aim: 0, fireHeld: false };
const SAVE = 'iva-shift.practice.v1';
const lessonSave = (role: Role) => `iva-shift.lesson.v1.${role}`;
function savedSession(key: string): { state: ShiftState; lesson?: Lesson } | null {
  try {
    const saved = JSON.parse(localStorage.getItem(key) || 'null');
    return saved?.state?.rulesVersion === 'shift@1' && saved?.state?.actors?.self ? saved : null;
  } catch { return null; }
}
export function hasPractice(): boolean { const saved = savedSession(SAVE); return !!saved && saved.state.phase !== 'finished'; }
export function hasLesson(role: Role): boolean { const saved = savedSession(lessonSave(role)); return saved?.lesson?.role === role && saved.lesson.step < 5; }
export function useLocalSession(config: LocalGameConfig): ClientSession {
  const ref = useRef<{ state: ShiftState; lesson?: Lesson } | null>(null);
  if (!ref.current) {
    let saved: { state: ShiftState; lesson?: Lesson } | null = null;
    if (config.resume) saved = savedSession(config.lesson ? lessonSave(config.lesson) : SAVE);
    if (config.lesson && saved?.lesson?.role !== config.lesson) saved = null;
    ref.current = saved || (config.lesson ? createLesson(config.lesson) : { state: createMatch(config.settings, practiceRoster(config.role, config.settings.teamSize, config.settings.difficulty), config.seed) });
    connectSeat(ref.current.state, 'self');
  }
  const [view, setView] = useState(() => viewForSeat(ref.current!.state, 'self'));
  const [lesson, setLesson] = useState<Lesson | undefined>(ref.current.lesson ? { ...ref.current.lesson } : undefined);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const input = useRef({ ...STOP });
  const queue = useRef<QueuedCommand[]>([]);
  const paused = useRef(false);
  const setInput = useCallback((value: PilotInput) => { input.current = value; }, []);
  const send = useCallback((command: ShiftCommandPayload) => { queue.current.push({ seatId: 'self', command }); }, []);
  const setPaused = useCallback((value: boolean) => { paused.current = value; input.current = { ...STOP }; }, []);
  const selectLessonRoom = useCallback((roomId: string, allowed: boolean) => {
    const game = ref.current, l = game?.lesson;
    if (!l || !game) return;
    if (roomId === 'O') l.selected = true;
    if (!allowed && l.step === 4 && viewForSeat(game.state, 'self').shiftOptions.find(o => o.roomId === roomId)?.reason === 'NOT_ADJACENT') l.rejected = true;
  }, []);
  useEffect(() => {
    const save = () => { try { localStorage.setItem(config.lesson ? lessonSave(config.lesson) : SAVE, JSON.stringify(ref.current)); } catch { /* Gameplay continues when storage is full. */ } };
    // The menu checks for a checkpoint before this effect's unmount cleanup runs.
    save();
    const timer = window.setInterval(() => {
      if (paused.current || document.hidden) return;
      const game = ref.current!, state = game.state;
      if (game.lesson && game.lesson.step >= 5) return;
      const actor = state.actors.self;
      const commands = queue.current.splice(0);
      commands.push({ seatId: 'self', command: { type: 'input', ...input.current, seq: actor.lastAcceptedSeq + 1, roundId: state.round, controllerEpoch: actor.controllerEpoch } });
      const result = game.lesson ? stepMatch(state, [...commands, ...lessonCommands(state, game.lesson)]) : advanceWithBots(state, commands);
      if (game.lesson) { const old = game.lesson.step; advanceLesson(state, game.lesson); if (old !== game.lesson.step) { setLesson({ ...game.lesson }); save(); } }
      const last = result.receipts.filter(r => r.seatId === 'self').at(-1); if (last) setReceipt(last);
      if (state.tick % 2 === 0 || result.checkpoint) setView(viewForSeat(state, 'self'));
      if (result.checkpoint || state.tick % 60 === 0) save();
    }, 1000 / 30);
    window.addEventListener('pagehide', save);
    return () => { window.clearInterval(timer); window.removeEventListener('pagehide', save); save(); };
  }, [config.lesson]);
  return { view, connected: true, status: 'local', receipt, lesson, setInput, send, setPaused, selectLessonRoom };
}
type DiscreteCommand = Exclude<ShiftCommandPayload, { type: 'input' }>;
type PendingCommand = ActionEnvelope & { payload: DiscreteCommand };
type PendingStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type LiveUpdate = { type: 'snapshot'; view: ShiftView; changed: boolean } | { type: 'receipt'; receipt: Receipt } | { type: 'error'; code: string };
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown, min = 0): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min;
const retryable = new Set(['RATE_LIMITED', 'COMMAND_RATE', 'GAME_TIMEOUT', 'LIVE_FAILED', 'SERVER_RESTARTING']);

/** Game-specific reconciliation on top of the shared transport. It never
 * invents an ACK or rewrites an action's payload when a connection changes. */
export class ShiftLiveChannel {
  view: ShiftView | null = null;
  scope: LiveScope | null = null;
  input: PilotInput = { ...STOP };
  readonly pending = new Map<string, PendingCommand>();
  private sequence = -1;
  private sentInputs: { seq: number; input: PilotInput }[] = [];
  private lastSentAt = 0;
  private viewKey = '';
  private restored = false;
  private readonly inputRate = new LiveRateWindow(LIVE_INPUT_HZ);
  private readonly storageKey: string;
  constructor(readonly roomId: string, readonly matchId: string, private readonly storage?: PendingStorage) {
    this.storageKey = `iva-shift.pending.v1:${roomId}:${matchId}`;
  }
  beginConnection(): void {
    this.scope = null; this.input = { ...STOP }; this.sequence = -1; this.sentInputs = []; this.lastSentAt = 0;
  }
  private savePending(): void {
    try {
      if (!this.pending.size) this.storage?.removeItem(this.storageKey);
      else this.storage?.setItem(this.storageKey, JSON.stringify({ wireVersion: WIRE_VERSION, seatId: this.view?.self.seatId, commands: [...this.pending.values()] }));
    } catch { /* The same in-memory IDs still survive a temporary disconnect. */ }
  }
  private restorePending(): void {
    if (this.restored || !this.view) return;
    this.restored = true;
    try {
      const saved: unknown = JSON.parse(this.storage?.getItem(this.storageKey) || 'null');
      if (record(saved) && saved.wireVersion === WIRE_VERSION && saved.seatId === this.view.self.seatId && Array.isArray(saved.commands)) {
        for (const value of saved.commands.slice(0, 8)) {
          if (!record(value) || !integer(value.expectedRevision) || typeof value.actionId !== 'string' || !/^[A-Za-z0-9._:-]{8,100}$/.test(value.actionId)) continue;
          const payload = value.payload;
          if (!record(payload) || !['shift', 'interact', 'ping'].includes(String(payload.type)) || payload.actionId !== value.actionId || !integer(payload.roundId) || !integer(payload.controllerEpoch)) continue;
          if (payload.type === 'shift' && payload.expectedBoardRevision !== value.expectedRevision) continue;
          this.pending.set(value.actionId, { actionId: value.actionId, expectedRevision: value.expectedRevision, payload: payload as unknown as DiscreteCommand });
        }
      }
      this.savePending();
    } catch { /* Ignore an unreadable checkpoint without blocking connection. */ }
  }
  receive(value: unknown, now: number): LiveUpdate | null {
    if (!record(value) || value.protocol !== LIVE_PROTOCOL || value.roomId !== this.roomId || typeof value.epoch !== 'string' || !value.epoch) return null;
    if (value.matchId !== this.matchId) return { type: 'error', code: 'MATCH_CHANGED' };
    if (value.wireVersion !== WIRE_VERSION || value.gameId !== 'shift' || value.rulesVersion !== RULES_VERSION || value.contentVersion !== CONTENT_VERSION) return { type: 'error', code: 'INCOMPATIBLE_VERSION' };
    if (this.scope && value.epoch !== this.scope.epoch) return null;
    if (value.type === 'snapshot') {
      const next = value.view;
      if (!integer(value.tick) || !integer(value.lastAcceptedSeq, -1) || typeof value.serverTime !== 'number' || !Number.isFinite(value.serverTime)
        || !record(next) || next.wireVersion !== WIRE_VERSION || next.rulesVersion !== RULES_VERSION || next.contentVersion !== CONTENT_VERSION
        || next.tick !== value.tick || !integer(next.round, 1) || !record(next.self) || typeof next.self.seatId !== 'string'
        || !integer(next.self.controllerEpoch) || !Array.isArray(next.actors)) return null;
      const view = next as unknown as ShiftView;
      if (this.scope && this.view && view.tick < this.view.tick) return null;
      const reset = !this.scope || !this.view || this.view.round !== view.round || this.view.self.controllerEpoch !== view.self.controllerEpoch;
      this.scope = { protocol: LIVE_PROTOCOL, wireVersion: WIRE_VERSION, roomId: this.roomId, matchId: this.matchId, epoch: value.epoch };
      if (reset || view.recoveryTicksRemaining > 0 || view.phase !== 'active') {
        this.input = { ...STOP }; this.sentInputs = []; this.lastSentAt = now;
      }
      // The outer ACK is authoritative; dropped/coalesced packets remain
      // unacknowledged until an actually applied later sequence supersedes them.
      const lastAcceptedSeq = value.lastAcceptedSeq;
      this.sequence = Math.max(this.sequence, lastAcceptedSeq);
      this.sentInputs = this.sentInputs.filter(frame => frame.seq > lastAcceptedSeq);
      const key = JSON.stringify(view), changed = key !== this.viewKey;
      if (changed) { this.view = view; this.viewKey = key; }
      this.restorePending();
      return { type: 'snapshot', view: this.view!, changed };
    }
    if (value.type === 'receipt' && this.scope && this.view) {
      const result = value.result;
      if (!record(result) || typeof value.actionId !== 'string' || !this.pending.has(value.actionId) || result.actionId !== value.actionId
        || result.seatId !== this.view.self.seatId || typeof result.accepted !== 'boolean' || !integer(result.tick) || !integer(result.boardRevision)) return null;
      this.pending.delete(value.actionId); this.savePending();
      return { type: 'receipt', receipt: result as unknown as Receipt };
    }
    if (value.type === 'error' && typeof value.code === 'string') {
      if (typeof value.actionId === 'string' && !retryable.has(value.code)) { this.pending.delete(value.actionId); this.savePending(); }
      return { type: 'error', code: value.code };
    }
    return null;
  }
  queue(command: ShiftCommandPayload): string | null {
    if (command.type === 'input' || !this.view) return null;
    const envelope: PendingCommand = { actionId: command.actionId, expectedRevision: command.type === 'shift' ? command.expectedBoardRevision : this.view.boardRevision, payload: structuredClone(command) };
    const existing = this.pending.get(command.actionId);
    if (existing) return JSON.stringify(existing.payload) === JSON.stringify(envelope.payload) ? null : 'ACTION_CONFLICT';
    if (this.pending.size >= 8) return 'COMMAND_RATE';
    this.pending.set(command.actionId, envelope); this.savePending(); return null;
  }
  commandFrames(actionId?: string): LiveClientFrame[] {
    if (!this.scope) return [];
    return [...this.pending.values()].filter(item => !actionId || item.actionId === actionId).map(item => ({ ...this.scope!, type: 'command', ...item }));
  }
  inputFrame(now: number): LiveClientFrame | null {
    const view = this.view;
    if (!this.scope || !view || view.self.role !== 'pilot' || view.phase !== 'active' || view.recoveryTicksRemaining > 0 || !this.inputRate.take(now)) return null;
    const seq = ++this.sequence, input = { ...this.input };
    this.sentInputs.push({ seq, input }); this.sentInputs = this.sentInputs.slice(-8); this.lastSentAt = now;
    return { ...this.scope, type: 'input', seq, payload: { type: 'input', ...input, seq, roundId: view.round, controllerEpoch: view.self.controllerEpoch } };
  }
  predictSelf(now: number): VisibleActor | null {
    if (!this.view) return null;
    if (!this.scope) return this.view.actors.find(actor => actor.seatId === this.view!.self.seatId) || null;
    return predictPilot(this.view, this.sentInputs.map(frame => frame.input), this.input, now - this.lastSentAt);
  }
}

/** 4003 can also mean a recoverable game timeout; it is not always access loss. */
export function liveCloseStatus(code: number, error?: string): { status: string; retry: boolean } {
  if (code === 4001 || error === 'STALE_EPOCH' || error === 'LIVE_SUPERSEDED') return { status: 'STALE_EPOCH', retry: false };
  if (error && ['MATCH_CHANGED', 'MATCH_NOT_STARTED', 'LIVE_SCOPE_MISMATCH'].includes(error)) return { status: 'MATCH_CHANGED', retry: false };
  if (error && ['INCOMPATIBLE_VERSION', 'GAME_VERSION_UNAVAILABLE', 'LIVE_UNAVAILABLE'].includes(error)) return { status: 'INCOMPATIBLE_VERSION', retry: false };
  if (error && ['UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'ACTION_UNAVAILABLE'].includes(error) || code === 4003 && !retryable.has(error || '')) return { status: 'FORBIDDEN', retry: false };
  return { status: 'reconnecting', retry: true };
}

export function useOnlineSession(roomId: string, matchId: string): ClientSession {
  const [view, setView] = useState<ShiftView | null>(null);
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState('connecting');
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const socket = useRef<WebSocket | null>(null);
  const channel = useRef<ShiftLiveChannel | null>(null);
  const setInput = useCallback((value: PilotInput) => { if (channel.current) channel.current.input = value; }, []);
  const setPaused = useCallback(() => { if (channel.current) channel.current.input = { ...STOP }; }, []);
  const predictSelf = useCallback(() => channel.current?.predictSelf(performance.now()) || null, []);
  const send = useCallback((command: ShiftCommandPayload) => {
    const client = channel.current, ws = socket.current;
    if (!client || command.type === 'input') return;
    const error = client.queue(command); if (error) { setStatus(error); return; }
    if (ws?.readyState === WebSocket.OPEN && ws.bufferedAmount <= 32_768) for (const frame of client.commandFrames(command.actionId)) ws.send(JSON.stringify(frame));
  }, []);
  useEffect(() => {
    let storage: PendingStorage | undefined;
    try { storage = sessionStorage; } catch { /* In-memory reconnect is available without browser storage. */ }
    const client = new ShiftLiveChannel(roomId, matchId, storage); channel.current = client;
    let live = true, retry: number | undefined, retries = 0;
    setView(null); setReceipt(null); setConnected(false); setStatus('connecting');
    const connect = () => {
      if (!live) return;
      client.beginConnection();
      const url = new URL(`/api/platform/v1/rooms/${encodeURIComponent(roomId)}/live`, location.href); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(url); socket.current = ws;
      let lastError: string | undefined, terminalStatus: string | undefined;
      const isCurrent = () => live && socket.current === ws;
      ws.onmessage = event => {
        if (!isCurrent() || terminalStatus) return;
        let raw: unknown; try { raw = JSON.parse(String(event.data)); } catch { return; }
        const update = client.receive(raw, performance.now());
        if (!update) return;
        if (update.type === 'snapshot') {
          if (update.changed) setView(update.view);
          setConnected(true); setStatus('connected'); retries = 0; lastError = undefined;
        } else if (update.type === 'receipt') setReceipt(update.receipt);
        else {
          lastError = update.code; setStatus(update.code);
          const outcome = liveCloseStatus(0, update.code);
          if (!outcome.retry) { terminalStatus = outcome.status; setStatus(outcome.status); setConnected(false); client.beginConnection(); ws.close(); }
        }
      };
      ws.onclose = event => {
        if (!isCurrent()) return;
        client.beginConnection(); setConnected(false);
        const outcome = terminalStatus ? { status: terminalStatus, retry: false } : liveCloseStatus(event.code, lastError); setStatus(outcome.status);
        if (outcome.retry) retry = window.setTimeout(connect, Math.min(4000, 400 * 2 ** retries++));
      };
      ws.onerror = () => { if (isCurrent()) { client.input = { ...STOP }; setConnected(false); } };
    };
    connect();
    const timer = window.setInterval(() => {
      const ws = socket.current;
      if (ws?.readyState !== WebSocket.OPEN || ws.bufferedAmount > 32_768) return;
      const frame = client.inputFrame(performance.now()); if (frame) ws.send(JSON.stringify(frame));
    }, 34);
    const retryCommands = window.setInterval(() => {
      const ws = socket.current;
      if (ws?.readyState === WebSocket.OPEN && ws.bufferedAmount <= 32_768) for (const frame of client.commandFrames()) ws.send(JSON.stringify(frame));
    }, 1000);
    const stop = () => { client.input = { ...STOP }; };
    window.addEventListener('blur', stop); document.addEventListener('visibilitychange', stop);
    return () => { live = false; client.beginConnection(); window.clearTimeout(retry); window.clearInterval(timer); window.clearInterval(retryCommands); socket.current?.close(); window.removeEventListener('blur', stop); document.removeEventListener('visibilitychange', stop); };
  }, [roomId, matchId]);
  return { view, connected, status, receipt, predictSelf, setInput, send, setPaused, selectLessonRoom: () => {} };
}
