import { TutorialEngine } from './tutorial-engine'
import type { TutorialRequest, TutorialResponse } from './tutorial-protocol'

const scope = self as unknown as { onmessage: ((event: MessageEvent<TutorialRequest>) => void) | null; postMessage(message: TutorialResponse): void }
const now = () => performance.timeOrigin + performance.now()
let engine: TutorialEngine | null = null, timer: ReturnType<typeof setInterval> | undefined
const fail = () => { clearInterval(timer); engine = null; scope.postMessage({ type: 'failed' }) }
scope.onmessage = event => {
  try {
    const message = event.data
    if (message.type === 'start') {
      if (engine) throw new Error('LESSON_ALREADY_STARTED')
      engine = new TutorialEngine(message.lesson, message.saved, response => scope.postMessage(response), now())
      timer = setInterval(() => { try { engine?.pump(now()) } catch { fail() } }, 1000 / 30)
    } else {
      engine?.receive(message, now())
      if (message.type === 'close') { clearInterval(timer); engine = null }
    }
  } catch { fail() }
}
