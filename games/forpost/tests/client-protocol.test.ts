import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTutorialWorld, resetInputStream, stepWorld, viewForPlayer } from '../src/core/index'
import { OnlineSession } from '../src/client/transport'
import { Controls } from '../src/client/controls'
import type { JoinInfo, ConnectionState } from '../src/client/transport'
import type { Input, WorldView } from '../src/core/types'

class Wire {
  static OPEN = 1
  static instances: Wire[] = []
  readyState = 1
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  sent: Record<string, unknown>[] = []
  constructor(public url: URL, public protocol: string) { Wire.instances.push(this) }
  send(data: string) { this.sent.push(JSON.parse(data)) }
  close() { this.readyState = 3; this.onclose?.() }
  receive(message: unknown) { this.onmessage?.({ data: JSON.stringify(message) }) }
  hello(controlling = true, generation = 1, phase = 'running') { this.onopen?.(); this.receive({ type: 'hello', epoch: 1, controllerGeneration: generation, controlling, phase }) }
}
const info: JoinInfo = { matchId: 'fixture', participantId: 'learner', ticket: 'one-use-test-ticket', websocketPath: '/ws/realtime/v1', protocolVersion: 1 }
const input = { moveX: 1, moveZ: 0, aimX: 1, aimZ: 0, fireHeld: false, firePressSeq: 0 }
let session: OnlineSession | undefined
beforeEach(() => { vi.useFakeTimers(); Wire.instances = []; vi.stubGlobal('WebSocket', Wire); vi.stubGlobal('location', { href: 'http://forpost.test/play/forpost/', protocol: 'http:' }) })
afterEach(() => { session?.close(); session = undefined; vi.unstubAllGlobals(); vi.useRealTimers() })
function connect(renew: () => Promise<JoinInfo> = async () => ({ ...info, ticket: 'renewed-test-ticket' })) {
  const views: WorldView[] = [], statuses: ConnectionState[] = []
  session = new OnlineSession(info, renew, view => views.push(view), status => statuses.push(status))
  const socket = Wire.instances[0], view = viewForPlayer(createTutorialWorld(0), 'learner')
  socket.hello(); socket.receive({ type: 'full', epoch: 1, snapshotSeq: 1, phase: 'running', view })
  return { socket, view, views, statuses }
}
describe('client realtime protocol', () => {
  it('uses actual control fields, rejects local spectator input and claims without extra fields', () => {
    const { socket, statuses } = connect()
    session!.input(input)
    expect(socket.sent.at(-1)).toMatchObject({ type: 'input', protocolVersion: 1, epoch: 1, controllerGeneration: 1, inputSeq: 1 })
    socket.receive({ type: 'controlChanged', controllerGeneration: 2, controlling: false })
    const count = socket.sent.length; session!.input(input); expect(socket.sent).toHaveLength(count)
    expect(statuses.at(-1)).toBe('spectating')
    session!.claim(); expect(socket.sent.at(-1)).toEqual({ type: 'claimControl', protocolVersion: 1, matchId: 'fixture', epoch: 1, controllerGeneration: 2 })
    socket.receive({ type: 'controlChanged', controllerGeneration: 3, controlling: true }); session!.input(input)
    expect(socket.sent.at(-1)).toMatchObject({ type: 'input', controllerGeneration: 3, inputSeq: 1 })
  })
  it('merges against the acknowledged cached baseline and completely removes disappeared entities', () => {
    const { socket, view, views } = connect()
    socket.receive({ type: 'delta', epoch: 1, baselineSnapshotSeq: 1, snapshotSeq: 2, patch: { tick: view.tick + 2, units: [] } })
    expect(views.at(-1)!.units).toEqual([])
    socket.receive({ type: 'delta', epoch: 1, baselineSnapshotSeq: 1, snapshotSeq: 3, patch: { tick: view.tick + 4, units: [view.units[0]] } })
    expect(views.at(-1)!.units).toEqual([view.units[0]])
    expect(socket.sent.filter(message => message.type === 'resync')).toHaveLength(0)
    expect(socket.sent.at(-1)).toMatchObject({ type: 'ackSnapshot', snapshotSeq: 3 })
  })
  it('resyncs a missing baseline or epoch and does not display its partial state', () => {
    const { socket, views } = connect(), count = views.length
    socket.receive({ type: 'delta', epoch: 1, baselineSnapshotSeq: 999, snapshotSeq: 2, patch: { units: [] } })
    socket.receive({ type: 'delta', epoch: 2, baselineSnapshotSeq: 1, snapshotSeq: 3, patch: { units: [] } })
    expect(views).toHaveLength(count)
    expect(socket.sent.filter(message => message.type === 'resync')).toHaveLength(2)
  })
  it('retries an unacknowledged action with its original ID after reconnect', async () => {
    const { socket } = connect()
    const promise = session!.action({ type: 'mode', mode: 'tactics' }), first = socket.sent.at(-1)!
    socket.close(); await vi.advanceTimersByTimeAsync(500)
    const reconnected = Wire.instances.at(-1)!; reconnected.hello(true, 2)
    expect(reconnected.sent.find(message => message.type === 'action')).toMatchObject({ actionId: first.actionId, payload: first.payload, controllerGeneration: 2 })
    reconnected.receive({ type: 'actionAck', actionId: first.actionId, result: { ok: true, code: 'ok' } })
    await expect(promise).resolves.toEqual({ ok: true, code: 'ok' })
  })
  it('reconciles local movement against consumed input without changing authoritative view', () => {
    const { socket, view } = connect(), unit = view.units.find(u => u.ownerId === view.you && u.kind === 'fighter')!
    session!.input(input)
    expect(session!.getPrediction()!.x).toBeCloseTo(unit.x + .15, 3)
    expect(session!.getView()!.units.find(u => u.id === unit.id)!.x).toBe(unit.x)
    const next = structuredClone(view); next.units.find(u => u.id === unit.id)!.x += .15; next.participants.find(p => p.id === next.you)!.lastConsumedInputSeq = 1
    socket.receive({ type: 'full', epoch: 1, snapshotSeq: 2, phase: 'running', view: next })
    expect(session!.getPrediction()!.x).toBeCloseTo(unit.x + .15, 3)
    session!.input(input); expect(session!.getPrediction()!.x).toBeCloseTo(unit.x + .3, 3)
    socket.receive({ type: 'controlChanged', controllerGeneration: 2, controlling: false }); expect(session!.getPrediction()).toBeNull()
  })
  it('keeps a paused host paused after MATCH_PAUSED and sends no neutral input or action spam', async () => {
    const { socket, statuses } = connect()
    session!.input(input); expect(session!.getPrediction()).not.toBeNull()
    socket.receive({ type: 'phaseChanged', phase: 'paused' })
    expect(session!.getPrediction()).toBeNull()
    const statusCount = statuses.length, sentCount = socket.sent.length
    for (let i = 0; i < 90; i++) session!.input({ ...input, moveX: 0 })
    await expect(session!.action({ type: 'mode', mode: 'tactics' })).rejects.toThrow('MATCH_PAUSED')
    expect(socket.sent).toHaveLength(sentCount)
    socket.receive({ type: 'error', code: 'MATCH_PAUSED' })
    expect(statuses.slice(statusCount)).toEqual(['paused'])
    socket.receive({ type: 'error', code: 'RATE_LIMITED' })
    expect(statuses.at(-1)).toBe('paused')
  })
  it('does not treat a control claim as a paused-host resume and accepts the next running snapshot', () => {
    const { socket, view, statuses } = connect()
    socket.receive({ type: 'full', epoch: 1, snapshotSeq: 2, phase: 'paused', view })
    session!.claim()
    expect(socket.sent.at(-1)).toMatchObject({ type: 'claimControl', controllerGeneration: 1 })
    socket.receive({ type: 'controlChanged', controllerGeneration: 2, controlling: true })
    expect(statuses.at(-1)).toBe('paused')
    const count = socket.sent.length; session!.input(input); expect(socket.sent).toHaveLength(count)
    socket.receive({ type: 'delta', epoch: 1, baselineSnapshotSeq: 2, snapshotSeq: 3, phase: 'running', patch: { tick: view.tick + 2 } })
    expect(statuses.at(-1)).toBe('connected')
    session!.input(input)
    expect(socket.sent.at(-1)).toMatchObject({ type: 'input', controllerGeneration: 2, inputSeq: 1 })
  })
  it('gates a paused admission until its authoritative running phase is observed', () => {
    const statuses: ConnectionState[] = []
    session = new OnlineSession(info, async () => info, () => {}, status => statuses.push(status))
    const socket = Wire.instances.at(-1)!
    socket.hello(true, 1, 'paused')
    const count = socket.sent.length; session.input(input); expect(socket.sent).toHaveLength(count)
    expect(statuses.at(-1)).toBe('paused')
    socket.receive({ type: 'phaseChanged', phase: 'running' })
    session.input(input); expect(socket.sent.at(-1)).toMatchObject({ type: 'input', inputSeq: 1 })
    expect(statuses.at(-1)).toBe('connected')
  })
  it('resumes after closing a paused session and opening the renewed admission used by App', () => {
    const { socket, view, statuses } = connect()
    socket.receive({ type: 'phaseChanged', phase: 'paused' }); session!.close()
    session = new OnlineSession({ ...info, ticket: 'new-resume-admission' }, async () => info, () => {}, status => statuses.push(status))
    const resumed = Wire.instances.at(-1)!
    resumed.hello(true, 2)
    expect(resumed.sent[0]).toEqual({ type: 'authenticate', ticket: 'new-resume-admission' })
    resumed.receive({ type: 'full', epoch: 1, snapshotSeq: 1, phase: 'running', view })
    session.input(input)
    expect(resumed.sent.at(-1)).toMatchObject({ type: 'input', controllerGeneration: 2, inputSeq: 1 })
    expect(statuses.at(-1)).toBe('connected')
  })
  it('stops gameplay messages after the finished host snapshot while still acknowledging it', async () => {
    const { socket, view } = connect()
    socket.receive({ type: 'full', epoch: 1, snapshotSeq: 2, phase: 'finished', view: { ...view, phase: 'finished' } })
    expect(socket.sent.at(-1)).toMatchObject({ type: 'ackSnapshot', snapshotSeq: 2 })
    const count = socket.sent.length; session!.input(input); expect(socket.sent).toHaveLength(count)
    socket.receive({ type: 'error', code: 'MATCH_PAUSED' })
    await expect(session!.action({ type: 'reload' })).rejects.toThrow('MATCH_FINISHED')
    expect(socket.sent).toHaveLength(count)
  })
  it('keeps renewing through transient outages and reconnects after the service recovers', async () => {
    const renew = vi.fn<() => Promise<JoinInfo>>()
      .mockRejectedValueOnce(new Error('NETWORK'))
      .mockRejectedValueOnce(new Error('GAME_UNAVAILABLE'))
      .mockResolvedValue({ ...info, ticket: 'recovered-ticket' })
    const { socket, statuses } = connect(renew)
    socket.close()
    const statusCount = statuses.length; socket.hello(); expect(statuses).toHaveLength(statusCount)
    await vi.advanceTimersByTimeAsync(500); expect(renew).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1000); expect(renew).toHaveBeenCalledTimes(2)
    expect(statuses.at(-1)).toBe('reconnecting'); expect(Wire.instances).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1500); expect(renew).toHaveBeenCalledTimes(3)
    const recovered = Wire.instances.at(-1)!
    recovered.hello(true, 2)
    expect(recovered.sent[0]).toEqual({ type: 'authenticate', ticket: 'recovered-ticket' })
    expect(statuses.at(-1)).toBe('connected')
  })
  it('caps the retry interval during a prolonged outage instead of giving up or hot-looping', async () => {
    const renew = vi.fn<() => Promise<JoinInfo>>().mockRejectedValue(new Error('SERVER_BUSY'))
    const { socket, statuses } = connect(renew)
    socket.close(); await vi.advanceTimersByTimeAsync(60000)
    expect(renew.mock.calls.length).toBeGreaterThanOrEqual(12)
    expect(renew.mock.calls.length).toBeLessThanOrEqual(20)
    expect(statuses.at(-1)).toBe('reconnecting'); expect(Wire.instances).toHaveLength(1)
  })
  it('stops renewal and exposes a terminal authentication failure', async () => {
    const renew = vi.fn<() => Promise<JoinInfo>>().mockRejectedValue(new Error('AUTH_REQUIRED'))
    const { socket, statuses } = connect(renew)
    const pending = session!.action({ type: 'mode', mode: 'tactics' })
    const rejected = expect(pending).rejects.toThrow('AUTH_REQUIRED')
    socket.close(); await vi.advanceTimersByTimeAsync(60000)
    await rejected
    expect(renew).toHaveBeenCalledTimes(1); expect(statuses.at(-1)).toBe('error')
    expect(Wire.instances).toHaveLength(1)
  })
  it('cancels a scheduled renewal when the user closes the session', async () => {
    const renew = vi.fn<() => Promise<JoinInfo>>().mockResolvedValue(info)
    const { socket, statuses } = connect(renew)
    socket.close(); session!.close(); const count = statuses.length
    await vi.advanceTimersByTimeAsync(60000)
    expect(renew).not.toHaveBeenCalled(); expect(statuses).toHaveLength(count)
    expect(Wire.instances).toHaveLength(1)
  })
  it.each(['resolve', 'reject'] as const)('ignores a late renewal %s and old socket packets after disposal', async outcome => {
    let resolveRenew!: (info: JoinInfo) => void, rejectRenew!: (error: Error) => void
    const renew = vi.fn(() => new Promise<JoinInfo>((resolve, reject) => { resolveRenew = resolve; rejectRenew = reject }))
    const { socket, statuses, views, view } = connect(renew)
    socket.close(); await vi.advanceTimersByTimeAsync(500); expect(renew).toHaveBeenCalledTimes(1)
    session!.close(); const statusCount = statuses.length, viewCount = views.length
    if (outcome === 'resolve') resolveRenew({ ...info, ticket: 'late-ticket' }); else rejectRenew(new Error('NETWORK'))
    socket.receive({ type: 'full', epoch: 1, snapshotSeq: 2, phase: 'running', view: { ...view, tick: 999 } })
    socket.onerror?.(); await vi.advanceTimersByTimeAsync(60000)
    expect(statuses).toHaveLength(statusCount); expect(views).toHaveLength(viewCount)
    expect(Wire.instances).toHaveLength(1); expect(renew).toHaveBeenCalledTimes(1)
  })
  it('recovers a committed action receipt after a long outage and finished-match reconnect with the original payload', async () => {
    let resolveRenew!: (info: JoinInfo) => void
    const { socket } = connect(() => new Promise(resolve => { resolveRenew = resolve }))
    const payload = { type: 'build' as const, padId: 'L-03', kind: 'relay' as 'relay' | 'generator' }
    const pending = session!.action(payload), first = socket.sent.at(-1)!
    let settled = false; void pending.then(() => { settled = true }, () => { settled = true })
    payload.kind = 'generator'
    socket.close(); await vi.advanceTimersByTimeAsync(30000)
    expect(settled).toBe(false)
    resolveRenew({ ...info, ticket: 'finished-match-ticket' }); await vi.advanceTimersByTimeAsync(0)
    const recovered = Wire.instances.at(-1)!
    recovered.hello(true, 2, 'finished')
    const replay = recovered.sent.filter(message => message.type === 'action')
    expect(replay).toHaveLength(1)
    expect(replay[0]).toMatchObject({ actionId: first.actionId, payload: { type: 'build', padId: 'L-03', kind: 'relay' }, controllerGeneration: 2 })
    await expect(session!.action({ type: 'reload' })).rejects.toThrow('MATCH_FINISHED')
    recovered.receive({ type: 'actionAck', actionId: first.actionId, replayed: true, result: { ok: true, code: 'ok', entityId: 'committed-order' } })
    await expect(pending).resolves.toMatchObject({ ok: true, entityId: 'committed-order' })
    await vi.advanceTimersByTimeAsync(30000)
    expect(recovered.sent.filter(message => message.type === 'action')).toHaveLength(1)
  })
  it('waits for control before replaying a pending receipt from a spectator reconnect', async () => {
    const { socket } = connect()
    const pending = session!.action({ type: 'mode', mode: 'tactics' }), first = socket.sent.at(-1)!
    socket.close(); await vi.advanceTimersByTimeAsync(500)
    const recovered = Wire.instances.at(-1)!
    recovered.hello(false, 2, 'finished')
    expect(recovered.sent.filter(message => message.type === 'action')).toHaveLength(0)
    recovered.receive({ type: 'controlChanged', controllerGeneration: 3, controlling: true })
    expect(recovered.sent.filter(message => message.type === 'action')).toEqual([expect.objectContaining({ actionId: first.actionId, payload: first.payload, controllerGeneration: 3 })])
    recovered.receive({ type: 'actionAck', actionId: first.actionId, replayed: true, result: { ok: true, code: 'ok' } })
    await expect(pending).resolves.toEqual({ ok: true, code: 'ok' })
  })
  it('keeps an uncertain action through a host pause without a socket break and reuses its ID on resume', async () => {
    const { socket } = connect()
    const pending = session!.action({ type: 'mode', mode: 'tactics' }), first = socket.sent.at(-1)!
    let settled = false; void pending.then(() => { settled = true }, () => { settled = true })
    socket.receive({ type: 'phaseChanged', phase: 'paused' })
    await vi.advanceTimersByTimeAsync(30000)
    expect(settled).toBe(false); expect(socket.sent.filter(message => message.type === 'action')).toHaveLength(1)
    socket.receive({ type: 'phaseChanged', phase: 'running' })
    const actions = socket.sent.filter(message => message.type === 'action')
    expect(actions).toHaveLength(2); expect(actions[1]).toEqual(first)
    socket.receive({ type: 'actionAck', actionId: first.actionId, replayed: true, result: { ok: true, code: 'ok' } })
    await expect(pending).resolves.toEqual({ ok: true, code: 'ok' })
  })
  it.each(['hello', 'generation', 'epoch'] as const)('resets control input on %s so the real core cannot replay a released fire press', kind => {
    vi.stubGlobal('window', new EventTarget()); vi.stubGlobal('document', new EventTarget())
    const controls = new Controls(() => {})
    try {
      for (let i = 0; i < 9; i++) { controls.fire(true, 'mouse'); controls.fire(false, 'mouse') }
      controls.neutral()
      expect(controls.value.fireHeld).toBe(false); expect(controls.value.firePressSeq).toBe(9)
      const world = createTutorialWorld(0), unsafe = structuredClone(world)
      resetInputStream(unsafe, 'learner')
      stepWorld(unsafe, { learner: { ...controls.value, inputSeq: 1 } })
      expect(unsafe.units.find(u => u.ownerId === 'learner' && u.kind === 'fighter')!.shotSerial).toBe(1)
      const reset = vi.fn(() => { controls.neutral(); controls.value.firePressSeq = 0 })
      session = new OnlineSession(info, async () => info, () => {}, () => {}, reset)
      const socket = Wire.instances.at(-1)!
      if (kind !== 'hello') {
        socket.hello(); reset.mockClear()
        for (let i = 0; i < 9; i++) { controls.fire(true, 'mouse'); controls.fire(false, 'mouse') }
        controls.neutral()
      }
      if (kind === 'hello') socket.hello()
      else if (kind === 'generation') socket.receive({ type: 'controlChanged', controllerGeneration: 2, controlling: true })
      else socket.receive({ type: 'full', epoch: 2, snapshotSeq: 1, phase: 'running', view: viewForPlayer(world, 'learner') })
      expect(reset).toHaveBeenCalledTimes(1)
      session.input(controls.value)
      const transmitted = socket.sent.at(-1)!.payload as Input
      expect(transmitted).toMatchObject({ moveX: 0, moveZ: 0, fireHeld: false, firePressSeq: 0, toolHeld: false })
      resetInputStream(world, 'learner'); stepWorld(world, { learner: transmitted })
      const fighter = world.units.find(u => u.ownerId === 'learner' && u.kind === 'fighter')!
      expect(fighter.shotSerial).toBe(0); expect(fighter.magazine).toBe(24)
    } finally { controls.destroy() }
  })
  it('preserves the press counter through ordinary pause/resume, errors and same-generation snapshots', () => {
    const reset = vi.fn()
    session = new OnlineSession(info, async () => info, () => {}, () => {}, reset)
    const socket = Wire.instances.at(-1)!, view = viewForPlayer(createTutorialWorld(0), 'learner')
    socket.hello(); expect(reset).toHaveBeenCalledTimes(1); reset.mockClear()
    socket.receive({ type: 'phaseChanged', phase: 'paused' })
    socket.receive({ type: 'error', code: 'MATCH_PAUSED' })
    socket.receive({ type: 'full', epoch: 1, snapshotSeq: 1, phase: 'paused', view })
    socket.receive({ type: 'phaseChanged', phase: 'running' })
    socket.receive({ type: 'delta', epoch: 1, baselineSnapshotSeq: 1, snapshotSeq: 2, phase: 'running', patch: { tick: view.tick + 1 } })
    socket.receive({ type: 'controlChanged', controllerGeneration: 1, controlling: true })
    expect(reset).not.toHaveBeenCalled()
  })
})
