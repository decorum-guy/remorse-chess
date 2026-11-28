import type { Page, test as PlaywrightTest } from '@playwright/test'

const pageFailures = new WeakMap<Page, string[]>()
type LongFrameSample = { durationMs: number; blockingMs: number | null; beforeRenderMs: number | null; renderPhaseMs: number | null; afterStyleLayoutStartMs: number | null; reportedScriptMs: number | null; forcedStyleLayoutMs: number | null }
type LongFrameProbe = { supported: boolean; count: number; totalMs: number; maxMs: number; recent: LongFrameSample[] }
export type TimingProbe = { start: number; frames: number; frameGaps: number[]; timerGaps: number[]; maxFrameGapMs: number; maxTimerGapMs: number; longTasks: number; longTaskMs: number; maxLongTaskMs: number; supportsLongTasks: boolean; longAnimationFrames: LongFrameProbe; focusEvents: { seq: number; type: string; elapsedMs: number; hidden: boolean; hasFocus: boolean }[] }
async function boundedDiagnostic<T>(operation: Promise<T>, unavailable: string): Promise<T | string> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([operation.catch(() => unavailable), new Promise<string>(resolve => { timer = setTimeout(() => resolve(unavailable), 3500) })])
  } finally { clearTimeout(timer) }
}
/** Shared observational diagnostics for every CI UI suite. */
export function installDiagnostics(test: typeof PlaywrightTest): void {
  test.beforeEach(async ({ page }, info) => {
    const failures: string[] = []; pageFailures.set(page, failures)
    page.on('pageerror', error => { if (failures.length < 20) failures.push(error.message.slice(0, 1000)) })
    page.on('websocket', socket => {
      let hostPhase: string | undefined
      socket.on('framereceived', event => {
        let packet: Record<string, unknown>
        try { packet = JSON.parse(String(event.payload)) as Record<string, unknown> } catch { return }
        if (!packet || typeof packet !== 'object') return
        if (typeof packet.phase === 'string' && (packet.phase !== hostPhase || packet.type === 'phaseChanged')) {
          hostPhase = packet.phase
          console.log(JSON.stringify({ test: info.title, automatedHostPhase: packet.phase, reason: typeof packet.reason === 'string' ? packet.reason : null }))
        }
        if (packet.type === 'error' && typeof packet.code === 'string') console.log(JSON.stringify({ test: info.title, automatedProtocolError: packet.code }))
      })
    })
    // Observational instrumentation only: no game clock, input, world or storage mutation.
    await page.addInitScript(() => {
      const probe: TimingProbe = { start: performance.now(), frames: 0, frameGaps: [], timerGaps: [], maxFrameGapMs: 0, maxTimerGapMs: 0, longTasks: 0, longTaskMs: 0, maxLongTaskMs: 0, supportsLongTasks: false, longAnimationFrames: { supported: false, count: 0, totalMs: 0, maxMs: 0, recent: [] }, focusEvents: [] }
      ;(window as Window & { __forpostQaTiming?: TimingProbe }).__forpostQaTiming = probe
      let focusSequence = 0
      const recordFocus = (type: string) => {
        probe.focusEvents.push({ seq: ++focusSequence, type, elapsedMs: performance.now() - probe.start, hidden: document.hidden, hasFocus: document.hasFocus() })
        if (probe.focusEvents.length > 40) probe.focusEvents.shift()
      }
      recordFocus('initial')
      for (const type of ['blur', 'focus', 'pagehide']) window.addEventListener(type, () => recordFocus(type))
      document.addEventListener('visibilitychange', () => recordFocus('visibilitychange'))
      const sample = (list: number[], gap: number) => { list.push(gap); if (list.length > 600) list.shift() }
      let lastFrame = 0, lastTimer = performance.now()
      const frame = (now: number) => { if (lastFrame) { sample(probe.frameGaps, now - lastFrame); probe.maxFrameGapMs = Math.max(probe.maxFrameGapMs, now - lastFrame) } lastFrame = now; probe.frames++; requestAnimationFrame(frame) }
      requestAnimationFrame(frame)
      setInterval(() => { const now = performance.now(); sample(probe.timerGaps, now - lastTimer); probe.maxTimerGapMs = Math.max(probe.maxTimerGapMs, now - lastTimer); lastTimer = now }, 50)
      if (typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
        probe.supportsLongTasks = true
        new PerformanceObserver(list => { for (const entry of list.getEntries()) { probe.longTasks++; probe.longTaskMs += entry.duration; probe.maxLongTaskMs = Math.max(probe.maxLongTaskMs, entry.duration) } }).observe({ type: 'longtask', buffered: true })
      }
      if (typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes?.includes('long-animation-frame')) {
        const finite = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
        const observer = new PerformanceObserver(list => {
          for (const entry of list.getEntries()) {
            const frame = entry as PerformanceEntry & { blockingDuration?: number; renderStart?: number; styleAndLayoutStart?: number; scripts?: readonly { duration?: number; forcedStyleAndLayoutDuration?: number; forcedStyleDuration?: number; forcedLayoutDuration?: number }[] }
            const end = frame.startTime + frame.duration, render = finite(frame.renderStart), styleLayout = finite(frame.styleAndLayoutStart)
            let scriptMs: number | null = null, forcedMs: number | null = null
            if (Array.isArray(frame.scripts)) {
              scriptMs = 0
              for (const script of frame.scripts) {
                scriptMs += finite(script.duration) ?? 0
                const combined = finite(script.forcedStyleAndLayoutDuration), style = finite(script.forcedStyleDuration), layout = finite(script.forcedLayoutDuration)
                const forced = combined ?? (style !== null || layout !== null ? (style ?? 0) + (layout ?? 0) : null)
                if (forced !== null) forcedMs = (forcedMs ?? 0) + forced
              }
            }
            // Only numeric fields enter the bounded buffer. Script URLs, names,
            // attribution objects and gameplay state are never retained.
            const sample: LongFrameSample = {
              durationMs: frame.duration, blockingMs: finite(frame.blockingDuration),
              beforeRenderMs: render && render >= frame.startTime ? render - frame.startTime : null,
              renderPhaseMs: render && end >= render ? end - render : null,
              afterStyleLayoutStartMs: styleLayout && end >= styleLayout ? end - styleLayout : null,
              reportedScriptMs: scriptMs, forcedStyleLayoutMs: forcedMs,
            }
            const frames = probe.longAnimationFrames
            frames.recent[frames.count % 120] = sample
            frames.count++; frames.totalMs += frame.duration; frames.maxMs = Math.max(frames.maxMs, frame.duration)
          }
        })
        try { observer.observe({ type: 'long-animation-frame', buffered: true }); probe.longAnimationFrames.supported = true }
        catch { observer.disconnect() /* Optional diagnostics must not alter the scenario. */ }
      }
    })
  })
  test.afterEach(async ({ page, browser, browserName }, info) => {
    if (info.status === info.expectedStatus || page.isClosed()) return
    const [body, runtimeHealth, timing] = await Promise.all([
      page.locator('body').innerText({ timeout: 2000 }).catch(() => '[page unavailable]'),
      page.request.get('/api/realtime/v1/health', { timeout: 3000 }).then(response => response.json()).catch(() => '[health unavailable]'),
      boundedDiagnostic(page.evaluate(() => {
        const probe = (window as Window & { __forpostQaTiming?: TimingProbe }).__forpostQaTiming
        const summary = (samples: number[]) => { const sorted = [...samples].sort((a, b) => a - b); return { samples: sorted.length, p50Ms: sorted[Math.ceil(sorted.length * .5) - 1] ?? null, p95Ms: sorted[Math.ceil(sorted.length * .95) - 1] ?? null, maxMs: sorted.at(-1) ?? null } }
        const longFrames = probe?.longAnimationFrames
        const frameField = (key: keyof LongFrameSample) => summary(longFrames?.recent.flatMap(frame => { const value = frame[key]; return value === null ? [] : [value] }) ?? [])
        const longAnimationFrames = longFrames?.supported ? {
          count: longFrames.count, totalMs: longFrames.totalMs, maxMs: longFrames.maxMs, windowSize: 120,
          recent: { durationMs: frameField('durationMs'), blockingMs: frameField('blockingMs'), beforeRenderMs: frameField('beforeRenderMs'), renderPhaseMs: frameField('renderPhaseMs'), afterStyleLayoutStartMs: frameField('afterStyleLayoutStartMs'), reportedScriptMs: frameField('reportedScriptMs'), forcedStyleLayoutMs: frameField('forcedStyleLayoutMs') },
          coverage: 'reported script entries only; render/style intervals overlap and include browser work; GPU completion is not measured',
        } : 'unsupported'
        const canvas = document.querySelector<HTMLCanvasElement>('.fp-stage canvas'), gl = canvas?.getContext('webgl2')
        const debug = gl?.getExtension('WEBGL_debug_renderer_info')
        return { visible: !document.hidden, hasFocus: document.hasFocus(), viewport: [innerWidth, innerHeight], pixelRatio: devicePixelRatio, build: document.querySelector('[data-build]')?.getAttribute('data-build'), stageMetrics: JSON.parse(document.querySelector('.fp-stage')?.getAttribute('data-render-metrics') ?? 'null'), renderer: gl ? { version: gl.getParameter(gl.VERSION), vendor: gl.getParameter(debug?.UNMASKED_VENDOR_WEBGL ?? gl.VENDOR), renderer: gl.getParameter(debug?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER), width: canvas!.width, height: canvas!.height } : 'no WebGL2 stage context', ...(probe ? { elapsedMs: performance.now() - probe.start, frames: probe.frames, maxFrameGapMs: probe.maxFrameGapMs, maxTimerGapMs: probe.maxTimerGapMs, recentFrameGaps: summary(probe.frameGaps), recentTimerGaps: summary(probe.timerGaps), focusEvents: probe.focusEvents, longTasks: probe.supportsLongTasks ? { count: probe.longTasks, totalMs: probe.longTaskMs, maxMs: probe.maxLongTaskMs } : 'unsupported', longAnimationFrames } : {}) }
      }), '[timing unavailable within 3500 ms]'),
    ])
    console.log(JSON.stringify({ automatedUiFailure: info.title, path: new URL(page.url()).pathname, browserName, browserVersion: browser.version(), pageErrors: pageFailures.get(page) ?? [], timing, runtimeHealth, visibleText: body.slice(0, 12_000) }))
  })
}
