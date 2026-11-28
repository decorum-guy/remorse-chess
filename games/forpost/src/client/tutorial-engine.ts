import { applyAction, createTutorialWorld, deserializeWorld, neutralInput, resetInputStream, serializeWorld, stepWorld, tutorialProgress, viewForPlayer } from '../core/index'
import type { Input, World } from '../core/types'
import type { TutorialRequest, TutorialResponse } from './tutorial-protocol'

const INTERVAL = 1000 / 30, INPUT_LEASE = 250

/** The isolated lesson uses the actual core at fixed 30Hz. Rendering never
 * supplies dt or ticks. At most one unconsumed view can wait for the UI thread. */
export class TutorialEngine {
  private world: World
  private inputValue: Input = { ...neutralInput(), inputSeq: 0 }
  private inputAt = -Infinity
  private inputSequence = 0
  private discardedPressSeq = 0
  private nextTick: number
  private sequence = 0
  private inFlight = 0
  private changed = true
  private saveDue = true
  private closed = false
  constructor(lesson: number, saved: string | null, private send: (message: TutorialResponse) => void, now: number) {
    this.world = createTutorialWorld(lesson, 'learner')
    if (saved) {
      try {
        const restored = deserializeWorld(saved)
        if (restored.mode === 'tutorial' && restored.tutorial && restored.participants.some(p => p.id === 'learner')) this.world = restored
      } catch { /* Invalid saves restart only this isolated lesson. */ }
    }
    resetInputStream(this.world, 'learner')
    this.nextTick = now + INTERVAL
    this.publish()
  }
  private publish(): void {
    if (this.inFlight || !this.changed || this.closed) return
    this.inFlight = ++this.sequence
    const checkpoint = this.saveDue
    this.changed = false; this.saveDue = false
    this.send({ type: 'view', sequence: this.inFlight, view: viewForPlayer(this.world, 'learner'), progress: tutorialProgress(this.world), saved: serializeWorld(this.world), checkpoint })
  }
  /** Called by the Worker's own monotonic timer, independently of UI delivery. */
  pump(now: number): void {
    if (this.closed) return
    if (this.inputAt !== -Infinity && now - this.inputAt > INPUT_LEASE) {
      this.discardedPressSeq = Math.max(this.discardedPressSeq, this.inputValue.firePressSeq)
      this.inputValue = { ...this.inputValue, moveX: 0, moveZ: 0, fireHeld: false, toolHeld: false,
        firePressSeq: this.world.participants.find(p => p.id === 'learner')!.consumedFirePressSeq, inputSeq: ++this.inputSequence }
      this.inputAt = -Infinity
    }
    let steps = 0
    while (now >= this.nextTick && steps < 2) {
      // Reusing a sequence does not refresh core lastInputTick. Only a new UI
      // sample or the one explicit expiry-neutralization creates a new input.
      stepWorld(this.world, { learner: this.inputValue })
      this.nextTick += INTERVAL; steps++; this.changed = true
      if (this.world.tick % 30 === 0) this.saveDue = true
    }
    // A suspended Worker does not fast-forward a lesson on return or increase dt.
    if (now - this.nextTick > 1000) this.nextTick = now + INTERVAL
    this.publish()
  }
  receive(message: Exclude<TutorialRequest, { type: 'start' }>, now: number): void {
    if (this.closed) return
    if (message.type === 'input') {
      // A queued input that outlived a blocked UI must not revive a held trigger.
      if (Number.isFinite(message.sentAt) && now - message.sentAt >= -50 && now - message.sentAt <= INPUT_LEASE) {
        const firePressSeq = message.value.firePressSeq <= this.discardedPressSeq ? this.world.participants.find(p => p.id === 'learner')!.consumedFirePressSeq : message.value.firePressSeq
        this.inputValue = { ...message.value, firePressSeq, inputSeq: ++this.inputSequence }; this.inputAt = message.sentAt
      } else if (Number.isSafeInteger(message.value.firePressSeq)) this.discardedPressSeq = Math.max(this.discardedPressSeq, message.value.firePressSeq)
    } else if (message.type === 'consumed') {
      if (message.sequence === this.inFlight) { this.inFlight = 0; this.publish() }
    } else if (message.type === 'action') {
      const result = applyAction(this.world, 'learner', { ...message.value, actionId: message.id })
      this.changed = true; this.saveDue = true
      this.publish()
      this.send({ type: 'receipt', id: message.id, result, saved: serializeWorld(this.world) })
    } else {
      this.closed = true
      this.send({ type: 'closed', saved: serializeWorld(this.world) })
    }
  }
}
