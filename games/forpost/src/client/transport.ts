import type { Action, ActionResult, BotLevel, Input, MapId, Tool, Weapon, WorldView } from '../core/types'
import { predictFighter, type PendingInput, type PredictedFighter } from './prediction'

export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'paused' | 'spectating' | 'error'
export interface PracticeOptions { mapId: MapId; teamSize: 1 | 2 | 3; mode: 'training' | 'tutorial'; displayName: string; botLevel: BotLevel; weapon: Weapon; tool: Tool }
export interface JoinInfo { matchId: string; participantId: string; ticket: string; websocketPath: string; protocolVersion: number; route?: string }
export interface SessionClient {
  input(value: Input): void
  action(value: Action): Promise<ActionResult>
  claim(): void
  close(): void
  getView(): WorldView | null
  getPrediction?(): PredictedFighter | null
}
export async function requestJson<T>(path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  let response: Response
  try { response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000) }) }
  catch { throw new Error('NETWORK') }
  const result = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(result.error?.code ?? result.code ?? `HTTP_${response.status}`)
  return result as T
}
export const createPractice = (options: PracticeOptions): Promise<JoinInfo> => requestJson('/api/realtime/v1/practice', options)
export const practiceTicket = (matchId: string): Promise<JoinInfo> => requestJson(`/api/realtime/v1/practice/${encodeURIComponent(matchId)}/ticket`, {})
export const abandonPractice = (matchId: string): Promise<{ ok: boolean }> => requestJson(`/api/realtime/v1/practice/${encodeURIComponent(matchId)}/abandon`, {})
export async function roomTicket(roomId: string): Promise<JoinInfo> {
  const session = await requestJson<{ csrfToken: string; user: unknown }>('/api/platform/v1/session')
  if (!session.user) throw new Error('AUTH_REQUIRED')
  return requestJson(`/api/platform/v1/rooms/${encodeURIComponent(roomId)}/realtime-ticket`, {}, { 'X-CSRF-Token': session.csrfToken, 'Idempotency-Key': crypto.randomUUID() })
}
interface Pending { action: Action; resolve: (value: ActionResult) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> | null }
const TERMINAL_RENEW_ERRORS = new Set(['AUTH_REQUIRED', 'UNAUTHENTICATED', 'SESSION_REQUIRED', 'SIGN_IN_AGAIN', 'FORBIDDEN', 'ORIGIN_NOT_ALLOWED', 'EXPIRED', 'NOT_FOUND', 'MATCH_NOT_FOUND', 'MATCH_UNAVAILABLE', 'MATCH_CLOSED', 'HTTP_401', 'HTTP_403', 'HTTP_404'])

export class OnlineSession implements SessionClient {
  private socket: WebSocket | null = null
  private view: WorldView | null = null
  private epoch = 1
  private generation = 1
  private sequence = 0
  private closed = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private renewing = false
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private pending = new Map<string, Pending>()
  private connected = false
  private controlling = false
  private hostPhase = 'loading'
  private snapshotSeq = 0
  private baselines = new Map<number, WorldView>()
  private inputHistory: PendingInput[] = []
  private predicted: PredictedFighter | null = null
  private predictionLife = ''
  private retries = 0
  constructor(private info: JoinInfo, private renew: () => Promise<JoinInfo>, private onView: (view: WorldView) => void, private onStatus: (status: ConnectionState, code?: string) => void, private onInputReset: () => void = () => {}) { this.connect() }
  private send(value: unknown): void { if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(value)) }
  private envelope(type: string): Record<string, unknown> { return { type, protocolVersion: 1, matchId: this.info.matchId, epoch: this.epoch, controllerGeneration: this.generation } }
  private readPhase(value: unknown): void {
    const previous = this.hostPhase
    if (typeof value === 'string') this.hostPhase = value
    if (this.hostPhase !== 'running') { this.inputHistory = []; this.predicted = null }
    if (this.hostPhase === 'paused' || this.hostPhase === 'recovering') this.pausePending()
    else if (this.hostPhase === 'running' && (previous === 'paused' || previous === 'recovering') && this.connected) this.replayPending()
  }
  private reportStatus(code?: string): void {
    this.onStatus(this.hostPhase === 'paused' || this.hostPhase === 'recovering' ? 'paused' : this.controlling ? 'connected' : 'spectating', code)
  }
  private pausePending(): void { for (const pending of this.pending.values()) { if (pending.timer) clearTimeout(pending.timer); pending.timer = null } }
  private rejectPending(error: Error): void { this.pausePending(); for (const pending of this.pending.values()) pending.reject(error); this.pending.clear() }
  private sendPending(actionId: string, pending: Pending): void {
    if (pending.timer) clearTimeout(pending.timer)
    pending.timer = setTimeout(() => { this.pending.delete(actionId); pending.reject(new Error('NETWORK')) }, 20000)
    this.send({ ...this.envelope('action'), actionId, payload: pending.action })
  }
  private replayPending(): void {
    // The host looks up committed receipts before its phase guard. Replaying the same
    // ID/payload can recover a lost ACK even after the match has finished.
    if (this.controlling) for (const [actionId, pending] of this.pending) this.sendPending(actionId, pending)
  }
  private scheduleReconnect(code?: string): void {
    if (this.closed || this.reconnectTimer || this.renewing) return
    this.onStatus('reconnecting', code); this.retries++
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.closed) return
      this.renewing = true
      void this.renew().then(info => {
        this.renewing = false
        if (this.closed) return
        this.info = info; this.connect()
      }).catch((error: unknown) => {
        this.renewing = false
        if (this.closed) return
        const failure = error instanceof Error ? error : new Error('NETWORK')
        if (TERMINAL_RENEW_ERRORS.has(failure.message)) { this.rejectPending(failure); this.onStatus('error', failure.message) }
        else this.scheduleReconnect(failure.message)
      })
    }, Math.min(500 * this.retries, 5000))
  }
  private connect(): void {
    if (this.closed) return
    this.hostPhase = 'loading'
    this.onStatus(this.retries ? 'reconnecting' : 'connecting')
    const url = new URL(this.info.websocketPath, location.href); url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(url, 'iva-realtime-v1'); this.socket = socket
    socket.onopen = () => { if (!this.closed && this.socket === socket) this.send({ type: 'authenticate', ticket: this.info.ticket }) }
    socket.onmessage = event => {
      if (this.closed || this.socket !== socket) return
      let message: Record<string, unknown>
      try { message = JSON.parse(String(event.data)) as Record<string, unknown> } catch { return }
      if (message.type === 'hello') {
        this.epoch = Number(message.epoch); this.generation = Number(message.controllerGeneration); this.connected = true; this.retries = 0
        this.controlling = message.controlling === true; this.sequence = 0; this.baselines.clear(); this.inputHistory = []; this.predicted = null
        this.onInputReset()
        this.readPhase(message.phase); this.reportStatus()
        if (this.heartbeat) clearInterval(this.heartbeat)
        this.heartbeat = setInterval(() => this.send({ ...this.envelope('heartbeat') }), 1000)
        this.replayPending()
      }
      if (message.type === 'full') {
        const nextEpoch = Number(message.epoch)
        if (nextEpoch !== this.epoch) { this.epoch = nextEpoch; this.sequence = 0; this.baselines.clear(); this.inputHistory = []; this.predicted = null; this.onInputReset() }
        this.readPhase(message.phase)
        this.snapshotSeq = Number(message.snapshotSeq); this.view = message.view as WorldView; this.remember(this.snapshotSeq, this.view); this.onView(this.view)
        this.send({ ...this.envelope('ackSnapshot'), snapshotSeq: this.snapshotSeq })
        this.reportStatus()
      }
      if (message.type === 'delta') {
        const baseline = this.baselines.get(Number(message.baselineSnapshotSeq))
        if (Number(message.epoch) !== this.epoch || !baseline || !message.patch || typeof message.patch !== 'object') { this.send({ ...this.envelope('resync') }); return }
        this.readPhase(message.phase)
        this.snapshotSeq = Number(message.snapshotSeq); this.view = { ...baseline, ...message.patch as Partial<WorldView> }; this.remember(this.snapshotSeq, this.view); this.onView(this.view); this.send({ ...this.envelope('ackSnapshot'), snapshotSeq: this.snapshotSeq }); this.reportStatus()
      }
      if (message.type === 'actionAck') {
        const id = String(message.actionId); const pending = this.pending.get(id)
        if (pending) { if (pending.timer) clearTimeout(pending.timer); this.pending.delete(id); pending.resolve(message.result as ActionResult) }
      }
      if (message.type === 'controlChanged') { const generation = Number(message.controllerGeneration); if (generation !== this.generation) this.onInputReset(); this.generation = generation; this.sequence = 0; this.inputHistory = []; this.predicted = null; this.controlling = message.controlling === true; this.reportStatus(); this.pausePending(); this.replayPending() }
      if (message.type === 'error') {
        const code = String(message.code ?? 'NETWORK')
        if (code === 'MATCH_PAUSED' && this.hostPhase !== 'finished' && this.hostPhase !== 'abandoned') this.readPhase('paused')
        if (this.connected) this.reportStatus(code); else this.onStatus('error', code)
      }
      if (message.type === 'phaseChanged') { this.readPhase(message.phase); this.reportStatus() }
    }
    socket.onclose = () => {
      if (this.closed || this.socket !== socket) return
      this.socket = null; this.connected = false; this.controlling = false; this.inputHistory = []; this.predicted = null; if (this.heartbeat) clearInterval(this.heartbeat)
      this.heartbeat = null; this.pausePending(); this.scheduleReconnect()
    }
    socket.onerror = () => { if (!this.closed && this.socket === socket) this.onStatus('reconnecting') }
  }
  private remember(sequence: number, view: WorldView): void {
    this.baselines.set(sequence, view); while (this.baselines.size > 32) this.baselines.delete(this.baselines.keys().next().value!)
    const life = `${this.epoch}:${view.operation}:${view.phase}:${view.units.find(u => u.ownerId === view.you && u.kind === 'fighter')?.id ?? ''}`
    if (life !== this.predictionLife) { this.inputHistory = []; this.predicted = null; this.predictionLife = life }
    const consumed = view.participants.find(p => p.id === view.you)?.lastConsumedInputSeq ?? 0
    this.inputHistory = this.inputHistory.filter(item => item.sequence > consumed)
    this.predicted = this.controlling && this.hostPhase === 'running' ? predictFighter(view, this.inputHistory) : null
  }
  input(value: Input): void {
    if (!this.connected || !this.controlling || this.hostPhase !== 'running') return
    const sequence = ++this.sequence
    this.inputHistory.push({ sequence, input: { ...value } }); if (this.inputHistory.length > 30) this.inputHistory.shift()
    this.predicted = this.view ? predictFighter(this.view, this.inputHistory) : null
    this.send({ ...this.envelope('input'), inputSeq: sequence, payload: { ...value, inputSeq: sequence } })
  }
  action(value: Action): Promise<ActionResult> {
    if (!this.connected) return Promise.reject(new Error('NETWORK'))
    if (!this.controlling) return Promise.reject(new Error('VIEW_ONLY'))
    if (this.hostPhase !== 'running') return Promise.reject(new Error(this.hostPhase === 'finished' ? 'MATCH_FINISHED' : 'MATCH_PAUSED'))
    const actionId = crypto.randomUUID()
    return new Promise((resolve, reject) => {
      const pending: Pending = { action: structuredClone(value), resolve, reject, timer: null }
      this.pending.set(actionId, pending); this.sendPending(actionId, pending)
    })
  }
  claim(): void { this.send({ ...this.envelope('claimControl') }) }
  getView(): WorldView | null { return this.view }
  getPrediction(): PredictedFighter | null { return this.predicted }
  close(): void {
    this.input({ moveX: 0, moveZ: 0, aimX: 1, aimZ: 0, fireHeld: false, firePressSeq: 0 })
    this.closed = true; this.connected = false; this.controlling = false
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer); if (this.heartbeat) clearInterval(this.heartbeat)
    this.reconnectTimer = null; this.heartbeat = null; this.socket?.close(); this.rejectPending(new Error('NETWORK'))
  }
}
