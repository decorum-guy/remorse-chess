import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTutorialWorld, deserializeWorld, neutralInput, serializeWorld } from '../src/core/index'
import { TUTORIAL_SAVE, TutorialSession } from '../src/client/tutorial-client'
import { TutorialEngine } from '../src/client/tutorial-engine'
import type { TutorialRequest, TutorialResponse } from '../src/client/tutorial-protocol'

type ViewMessage = Extract<TutorialResponse, { type: 'view' }>
const time = () => performance.timeOrigin + performance.now()

/** A transport fixture around the real lesson engine. It models asynchronous
 * structured-clone delivery; it is not a native-browser Worker/FPS claim. */
class WorkerFixture {
  static instances: WorkerFixture[] = []
  onmessage: ((event: { data: TutorialResponse }) => void) | null = null
  onerror: (() => void) | null = null
  onmessageerror: (() => void) | null = null
  engine: TutorialEngine | null = null
  timer: ReturnType<typeof setInterval> | undefined
  terminated = false
  holdClosed = false
  closedMessage: TutorialResponse | null = null
  constructor() { WorkerFixture.instances.push(this) }
  deliver(message: TutorialResponse) {
    if (this.holdClosed && message.type === 'closed') { this.closedMessage = message; return }
    void Promise.resolve().then(() => { if (!this.terminated) this.onmessage?.({ data: structuredClone(message) }) })
  }
  postMessage(message: TutorialRequest) {
    const cloned = structuredClone(message)
    void Promise.resolve().then(() => {
      if (this.terminated) return
      if (cloned.type === 'start') {
        this.engine = new TutorialEngine(cloned.lesson, cloned.saved, response => this.deliver(response), time())
        this.timer = setInterval(() => this.engine?.pump(time()), 1000 / 30)
      } else {
        this.engine?.receive(cloned, time())
        if (cloned.type === 'close') clearInterval(this.timer)
      }
    })
  }
  terminate() { this.terminated = true; clearInterval(this.timer) }
}

let storage: Map<string, string>, browserWindow: EventTarget
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] })
  storage = new Map(); browserWindow = new EventTarget(); WorkerFixture.instances = []
  vi.stubGlobal('Worker', WorkerFixture); vi.stubGlobal('window', browserWindow)
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) })
})
afterEach(() => { for (const worker of WorkerFixture.instances) worker.terminate(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('isolated tutorial clock and bounded delivery', () => {
  it('advances the actual core for two seconds with a blocked view consumer and sends only the latest view', () => {
    const messages: TutorialResponse[] = [], engine = new TutorialEngine(3, null, m => messages.push(m), 0)
    const initialTick = (messages[0] as ViewMessage).view.tick
    for (let i = 1; i <= 60; i++) engine.pump(i * 1000 / 30 + .0001)
    expect(messages).toHaveLength(1)
    engine.receive({ type: 'consumed', sequence: 999 }, 2001)
    expect(messages).toHaveLength(1)
    engine.receive({ type: 'consumed', sequence: 1 }, 2001)
    const latest = messages.at(-1) as ViewMessage
    expect(latest.view.tick - initialTick).toBe(60)
    expect(deserializeWorld(latest.saved).tick).toBe(latest.view.tick)
    expect(latest.checkpoint).toBe(true)
    expect(messages).toHaveLength(2)
  })
  it('expires held input while UI delivery is blocked and rejects stale queued presses', () => {
    const messages: TutorialResponse[] = [], engine = new TutorialEngine(0, null, m => messages.push(m), 0)
    const initialTick = (messages[0] as ViewMessage).view.tick
    engine.receive({ type: 'input', value: { ...neutralInput(), moveX: 1, fireHeld: true, firePressSeq: 1 }, sentAt: 0 }, 0)
    for (let i = 1; i <= 30; i++) engine.pump(i * 1000 / 30 + .0001)
    engine.receive({ type: 'consumed', sequence: 1 }, 1001)
    const first = messages.at(-1) as ViewMessage, fighter = first.view.units.find(u => u.kind === 'fighter' && u.ownerId === 'learner')!
    expect(fighter.magazine).toBeLessThan(24)
    const stopped = { x: fighter.x, z: fighter.z, magazine: fighter.magazine }
    const restored = deserializeWorld(first.saved), learner = restored.participants.find(p => p.id === 'learner')!
    expect(learner.lastInputTick - initialTick).toBeLessThan(15)
    expect(learner.input.fireHeld).toBe(false)
    engine.receive({ type: 'input', value: { ...neutralInput(), moveX: 1, fireHeld: true, firePressSeq: 2 }, sentAt: 0 }, 1001)
    for (let i = 31; i <= 60; i++) engine.pump(i * 1000 / 30 + .0001)
    engine.receive({ type: 'consumed', sequence: first.sequence }, 2001)
    expect((messages.at(-1) as ViewMessage).view.units.find(u => u.id === fighter.id)).toMatchObject(stopped)
  })
  it('does not fast-forward a suspended Worker and retains fresh allowed events when views coalesce', () => {
    const messages: TutorialResponse[] = [], engine = new TutorialEngine(0, null, m => messages.push(m), 0)
    engine.receive({ type: 'input', value: { ...neutralInput(), firePressSeq: 1 }, sentAt: 0 }, 0)
    engine.pump(34); engine.pump(68)
    engine.receive({ type: 'consumed', sequence: 1 }, 68)
    const before = messages.at(-1) as ViewMessage
    expect(before.view.events.some(event => event.type === 'weapon:carbine' || event.type === 'sound:weapon:carbine')).toBe(true)
    engine.pump(10_000)
    engine.receive({ type: 'consumed', sequence: before.sequence }, 10_000)
    expect((messages.at(-1) as ViewMessage).view.tick - before.view.tick).toBe(2)
  })
  it('does not fire an unconsumed press that expired during a Worker stall, but accepts a new press', () => {
    const messages: TutorialResponse[] = [], engine = new TutorialEngine(0, null, m => messages.push(m), 0)
    engine.receive({ type: 'input', value: { ...neutralInput(), firePressSeq: 1 }, sentAt: 0 }, 0)
    engine.pump(300)
    engine.receive({ type: 'consumed', sequence: 1 }, 300)
    const first = messages.at(-1) as ViewMessage
    expect(first.view.units.find(u => u.kind === 'fighter' && u.ownerId === 'learner')!.magazine).toBe(24)
    // Controls keeps its counter on a neutral sample; that does not make the
    // discarded press a new gesture when UI delivery recovers.
    engine.receive({ type: 'input', value: { ...neutralInput(), firePressSeq: 1 }, sentAt: 301 }, 301)
    engine.pump(301)
    engine.receive({ type: 'consumed', sequence: first.sequence }, 301)
    const neutral = messages.at(-1) as ViewMessage
    expect(neutral.view.units.find(u => u.kind === 'fighter' && u.ownerId === 'learner')!.magazine).toBe(24)
    engine.receive({ type: 'input', value: { ...neutralInput(), firePressSeq: 2 }, sentAt: 302 }, 302)
    engine.pump(302)
    engine.receive({ type: 'consumed', sequence: neutral.sequence }, 302)
    expect((messages.at(-1) as ViewMessage).view.units.find(u => u.kind === 'fighter' && u.ownerId === 'learner')!.magazine).toBe(23)
  })
})

describe('tutorial client restore, receipts and lifecycle', () => {
  it('accepts the first short fire press after restoring a lesson while preserving its progress and ordinary save', async () => {
    const world = createTutorialWorld(0), learner = world.participants.find(p => p.id === 'learner')!
    learner.consumedFirePressSeq = 9; learner.input.firePressSeq = 9; world.tutorial!.stage = 1
    storage.set(TUTORIAL_SAVE, serializeWorld(world)); storage.set('iva.forpost.last-match.v1', '{"matchId":"ordinary-match"}')
    const progress = vi.fn(), tutorial = new TutorialSession(0, () => {}, progress, true)
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ lesson: 0, stage: 1 }))
      tutorial.input({ ...neutralInput(), firePressSeq: 1 })
      await vi.advanceTimersByTimeAsync(70)
      const fighter = tutorial.getView()!.units.find(u => u.ownerId === 'learner' && u.kind === 'fighter')!
      expect(fighter.magazine).toBe(23)
      expect(storage.get('iva.forpost.last-match.v1')).toBe('{"matchId":"ordinary-match"}')
      tutorial.input({ ...neutralInput(), firePressSeq: 1 })
      await vi.advanceTimersByTimeAsync(300)
      expect(tutorial.getView()!.units.find(u => u.id === fighter.id)!.magazine).toBe(23)
    } finally { tutorial.close() }
  })
  it('saves an acknowledged action before resolving it and flushes the last displayed world synchronously on pagehide', async () => {
    const tutorial = new TutorialSession(3, () => {}, () => {})
    await vi.advanceTimersByTimeAsync(0)
    await expect(tutorial.action({ type: 'mode', mode: 'tactics' })).resolves.toMatchObject({ ok: true })
    expect(deserializeWorld(storage.get(TUTORIAL_SAVE)!).participants.find(p => p.id === 'learner')!.mode).toBe('tactics')
    await vi.advanceTimersByTimeAsync(200)
    const shownTick = tutorial.getView()!.tick
    browserWindow.dispatchEvent(new Event('pagehide'))
    expect(deserializeWorld(storage.get(TUTORIAL_SAVE)!).tick).toBe(shownTick)
    await vi.advanceTimersByTimeAsync(0)
    // A page kept in the browser cache can still accept new user commands.
    expect(WorkerFixture.instances[0].terminated).toBe(false)
    await expect(tutorial.action({ type: 'mode', mode: 'fighter' })).resolves.toMatchObject({ ok: true })
    tutorial.close(); await vi.advanceTimersByTimeAsync(0)
    expect(WorkerFixture.instances[0].terminated).toBe(true)
  })
  it('ignores a closing lesson after a new lesson takes save and view ownership', async () => {
    const oldViews = vi.fn(), previous = new TutorialSession(0, oldViews, () => {})
    await vi.advanceTimersByTimeAsync(100)
    const oldWorker = WorkerFixture.instances[0]; oldWorker.holdClosed = true
    previous.close(); await vi.advanceTimersByTimeAsync(0)
    const calls = oldViews.mock.calls.length, next = new TutorialSession(1, () => {}, () => {})
    await vi.advanceTimersByTimeAsync(0)
    const currentSave = storage.get(TUTORIAL_SAVE)
    oldWorker.holdClosed = false; oldWorker.deliver(oldWorker.closedMessage!)
    await vi.advanceTimersByTimeAsync(0)
    expect(storage.get(TUTORIAL_SAVE)).toBe(currentSave)
    expect(deserializeWorld(currentSave!).tutorial!.lesson).toBe(1)
    expect(oldViews).toHaveBeenCalledTimes(calls)
    next.close()
  })
  it('reports Worker failure, stops it and rejects an outstanding action', async () => {
    const failed = vi.fn(), tutorial = new TutorialSession(0, () => {}, () => {}, false, failed)
    await vi.advanceTimersByTimeAsync(0)
    const action = tutorial.action({ type: 'mode', mode: 'tactics' }), worker = WorkerFixture.instances[0]
    worker.onerror!()
    await expect(action).rejects.toThrow('LESSON_UNAVAILABLE')
    expect(worker.terminated).toBe(true); expect(failed).toHaveBeenCalledOnce()
    worker.onerror!(); expect(failed).toHaveBeenCalledOnce()
  })
})
