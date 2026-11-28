import type { Action, ActionResult, Input, WorldView } from '../core/types'
import type { SessionClient } from './transport'
import type { LessonProgress, TutorialRequest, TutorialResponse } from './tutorial-protocol'

export type { LessonProgress } from './tutorial-protocol'
export const TUTORIAL_SAVE = 'iva.forpost.tutorial.v1'
let saveOwner: object | null = null

export class TutorialSession implements SessionClient {
  private worker: Worker
  private latest: WorldView | null = null
  private saved: string | null = null
  private closed = false
  private closeTimer: ReturnType<typeof setTimeout> | undefined
  private pending = new Map<string, { resolve: (value: ActionResult) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private owner = {}
  private pageHide = () => {
    this.save()
    // Navigation can enter the browser's back/forward cache. Persist and
    // neutralize without making the cached session permanently unusable.
    this.input({ moveX: 0, moveZ: 0, aimX: 1, aimZ: 0, fireHeld: false, firePressSeq: 0, toolHeld: false })
  }
  constructor(lesson: number, private onView: (view: WorldView) => void, private onProgress: (progress: LessonProgress) => void, resume = false, private onError: () => void = () => {}) {
    saveOwner = this.owner
    let saved: string | null = null
    if (resume) { try { saved = localStorage.getItem(TUTORIAL_SAVE) } catch { /* Storage may be unavailable. */ } }
    this.worker = new Worker(new URL('./tutorial-worker.ts', import.meta.url), { type: 'module' })
    this.worker.onmessage = event => this.receive(event.data as TutorialResponse)
    this.worker.onerror = () => this.fail()
    this.worker.onmessageerror = () => this.fail()
    window.addEventListener('pagehide', this.pageHide)
    this.send({ type: 'start', lesson, saved })
  }
  private send(message: TutorialRequest): void { this.worker.postMessage(message) }
  private save(value = this.saved): void {
    if (!value || saveOwner !== this.owner) return
    this.saved = value
    try { localStorage.setItem(TUTORIAL_SAVE, value) } catch { /* The active lesson remains playable without storage. */ }
  }
  private receive(message: TutorialResponse): void {
    if (message.type === 'closed') { this.save(message.saved); clearTimeout(this.closeTimer); this.worker.terminate(); return }
    if (message.type === 'failed') { this.fail(); return }
    if (this.closed) return
    if (message.type === 'receipt') {
      this.save(message.saved)
      const pending = this.pending.get(message.id)
      if (pending) { clearTimeout(pending.timer); this.pending.delete(message.id); pending.resolve(message.result) }
    } else {
      this.saved = message.saved
      if (message.checkpoint) this.save()
      this.latest = message.view; this.onView(message.view); this.onProgress(message.progress)
      this.send({ type: 'consumed', sequence: message.sequence })
    }
  }
  private rejectPending(): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('LESSON_UNAVAILABLE')) }
    this.pending.clear()
  }
  private fail(): void {
    const notify = !this.closed
    this.closed = true; this.rejectPending(); clearTimeout(this.closeTimer); this.worker.terminate(); this.save()
    window.removeEventListener('pagehide', this.pageHide)
    if (notify) this.onError()
  }
  input(value: Input): void { if (!this.closed) this.send({ type: 'input', value: { ...value }, sentAt: performance.timeOrigin + performance.now() }) }
  action(value: Action): Promise<ActionResult> {
    if (this.closed) return Promise.reject(new Error('LESSON_UNAVAILABLE'))
    const id = crypto.randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('LESSON_UNAVAILABLE')) }, 10_000)
      this.pending.set(id, { resolve, reject, timer }); this.send({ type: 'action', id, value })
    })
  }
  getView(): WorldView | null { return this.latest }
  claim(): void {}
  close(): void {
    if (this.closed) return
    this.closed = true; this.rejectPending(); this.save()
    window.removeEventListener('pagehide', this.pageHide)
    // Synchronously save the last delivered world. Navigation cannot await a
    // final Worker reply; an ordinary close additionally requests it.
    // A newer lesson owns the save, so an older close cannot overwrite it.
    this.closeTimer = setTimeout(() => this.worker.terminate(), 2500)
    this.send({ type: 'close' })
  }
}
