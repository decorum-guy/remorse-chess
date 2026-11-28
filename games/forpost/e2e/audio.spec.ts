import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { FORPOST_SOUNDS } from '../src/art/audio'
import type { World } from '../src/core/types'
import { installDiagnostics } from './diagnostics'

installDiagnostics(test)

type Clip = { assetId: string; path: string; sha256: string; bytes: number; duration: number; sampleRate: number; channels: number; format: string }
type Manifest = { sounds: Clip[]; files: { path: string; bytes: number; sha256: string }[] }
type AudioObservation = { seq: number; atMs: number; kind: 'decode' | 'resume' | 'start' | 'stop' | 'ended' | 'mute-toggle'; cue?: string; context?: number; state?: AudioContextState; voice?: number; gain?: number; connected?: boolean; duration?: number; channels?: number; sampleRate?: number; muted?: boolean }
type AudioProbe = { events: AudioObservation[]; sequence: number; active: number }
type ProbeWindow = Window & { __forpostNativeAudio?: AudioProbe }

/** Observe real native methods with their original arguments and return values.
 * No source is started here, and no game state/event/input is injected. */
function installNativeAudioObservers() {
  const probe: AudioProbe = { events: [], sequence: 0, active: 0 }
  ;(window as ProbeWindow).__forpostNativeAudio = probe
  const bytesCues = new WeakMap<ArrayBuffer, string>(), bufferCues = new WeakMap<AudioBuffer, string>()
  const connected = new WeakMap<AudioNode, AudioNode | AudioParam>(), contexts = new WeakMap<BaseAudioContext, number>(), voices = new WeakMap<AudioBufferSourceNode, number>()
  let nextContext = 0, nextVoice = 0
  const contextId = (context: BaseAudioContext) => { if (!contexts.has(context)) contexts.set(context, ++nextContext); return contexts.get(context)! }
  const record = (event: Omit<AudioObservation, 'seq' | 'atMs'>) => { probe.events.push({ ...event, seq: ++probe.sequence, atMs: performance.now() }); if (probe.events.length > 512) probe.events.shift() }
  // React's checkbox onChange comes from click. Capture that real activation
  // before the root listener; native change can arrive after the audio effect.
  document.addEventListener('click', event => {
    const input = event.target
    if (input instanceof HTMLInputElement && input.type === 'checkbox' && Array.from(input.labels ?? []).some(label => /^(Без звука|Mute all sounds)$/.test(label.textContent?.trim() ?? ''))) record({ kind: 'mute-toggle', muted: input.checked })
  }, true)
  const graph = (source: AudioBufferSourceNode) => {
    let node: AudioNode | AudioParam | undefined = source, gain = 1, reachesDestination = false
    const visited = new Set<AudioNode | AudioParam>()
    while (node && !visited.has(node)) {
      visited.add(node)
      if (node instanceof GainNode) gain *= node.gain.value
      if (node === source.context.destination) { reachesDestination = true; break }
      node = node instanceof AudioNode ? connected.get(node) : undefined
    }
    return { gain, connected: reachesDestination }
  }
  const nativeArrayBuffer = Response.prototype.arrayBuffer
  Response.prototype.arrayBuffer = function (...args: Parameters<typeof nativeArrayBuffer>) {
    const path = new URL(this.url, location.href).pathname, cue = path.match(/\/assets\/forpost\/audio\/([a-z-]+)\.wav$/)?.[1]
    return nativeArrayBuffer.apply(this, args).then(bytes => { if (cue) bytesCues.set(bytes, cue); return bytes })
  }
  const nativeDecode = BaseAudioContext.prototype.decodeAudioData
  BaseAudioContext.prototype.decodeAudioData = function (bytes, ...rest) {
    const cue = bytesCues.get(bytes)
    return nativeDecode.call(this, bytes, ...rest).then(buffer => {
      if (cue) bufferCues.set(buffer, cue)
      record({ kind: 'decode', cue, context: contextId(this), state: this.state, duration: buffer.duration, sampleRate: buffer.sampleRate, channels: buffer.numberOfChannels })
      return buffer
    })
  }
  const nativeResume = AudioContext.prototype.resume
  AudioContext.prototype.resume = function (...args: Parameters<typeof nativeResume>) {
    return nativeResume.apply(this, args).then(value => { record({ kind: 'resume', context: contextId(this), state: this.state }); return value })
  }
  const nativeConnect = AudioNode.prototype.connect
  AudioNode.prototype.connect = function (this: AudioNode, ...args: Parameters<typeof nativeConnect>) {
    const result = Reflect.apply(nativeConnect, this, args)
    connected.set(this, args[0]); return result
  } as typeof nativeConnect
  const nativeStart = AudioBufferSourceNode.prototype.start
  AudioBufferSourceNode.prototype.start = function (...args: Parameters<typeof nativeStart>) {
    const result = nativeStart.apply(this, args), voice = ++nextVoice, cue = this.buffer ? bufferCues.get(this.buffer) : undefined
    voices.set(this, voice); probe.active++
    record({ kind: 'start', voice, cue, context: contextId(this.context), state: this.context.state, duration: this.buffer?.duration, ...graph(this) })
    this.addEventListener('ended', () => { probe.active--; record({ kind: 'ended', voice, cue }) }, { once: true })
    return result
  }
  const nativeStop = AudioBufferSourceNode.prototype.stop
  AudioBufferSourceNode.prototype.stop = function (...args: Parameters<typeof nativeStop>) {
    const result = nativeStop.apply(this, args)
    record({ kind: 'stop', voice: voices.get(this), cue: this.buffer ? bufferCues.get(this.buffer) : undefined, ...graph(this) }); return result
  }
}

async function observations(page: Page): Promise<AudioObservation[]> { return page.evaluate(() => (window as ProbeWindow).__forpostNativeAudio?.events ?? []) }
async function cursor(page: Page) { return page.evaluate(() => (window as ProbeWindow).__forpostNativeAudio?.sequence ?? 0) }
async function starts(page: Page, after = 0) { return (await observations(page)).filter(event => event.kind === 'start' && event.seq > after) }
async function expectCue(page: Page, cue: string, after: number) {
  await expect.poll(async () => (await starts(page, after)).map(event => event.cue), { timeout: 5000, intervals: [20, 40, 80] }).toContain(cue)
  const events = (await starts(page, after)).filter(event => event.cue === cue)
  for (const event of events) { expect(event.state).toBe('running'); expect(event.connected).toBe(true); expect(event.gain).toBeGreaterThan(0) }
  return events
}
async function idle(page: Page) { await expect.poll(() => page.evaluate(() => (window as ProbeWindow).__forpostNativeAudio?.active), { timeout: 4000 }).toBe(0) }

test.afterEach(async ({ page }, info) => {
  if (info.status === info.expectedStatus || page.isClosed()) return
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const observation = await Promise.race([
      page.evaluate(() => { const probe = (window as ProbeWindow).__forpostNativeAudio; return probe ? { active: probe.active, events: probe.events.slice(-40) } : null }).catch(() => null),
      new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 3500) }),
    ])
    console.log(JSON.stringify({ nativeAudioFailure: info.title, observation, audioListened: false, physicalDevice: false }))
  } finally { clearTimeout(timer) }
})

test('native Web Audio decodes all 29 shipped WAVs and honors live cues, mute and reload isolation', async ({ page, browserName }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(installNativeAudioObservers)
  await page.goto('/play/forpost/')
  const health = await (await page.request.get('/api/realtime/v1/health')).json()
  await expect(page.locator('[data-build]')).toHaveAttribute('data-build', health.buildRevision)
  const authoritative = JSON.parse(await readFile(new URL('../public/assets/forpost/manifest.json', import.meta.url), 'utf8')) as Manifest
  const response = await page.request.get('/play/forpost/assets/forpost/manifest.json')
  expect(response.ok()).toBe(true)
  const manifest = await response.json() as Manifest
  expect(manifest.sounds).toEqual(authoritative.sounds)
  expect(manifest.files.filter(file => file.path.startsWith('audio/'))).toEqual(authoritative.files.filter(file => file.path.startsWith('audio/')))
  expect(manifest.sounds).toHaveLength(29)
  expect(manifest.sounds.map(clip => clip.assetId).sort()).toEqual([...FORPOST_SOUNDS].sort())
  expect(await starts(page)).toHaveLength(0)

  // Native decode only. This separate context never starts a source or resumes.
  const decoded = await page.evaluate(async clips => {
    const context = new AudioContext({ sampleRate: 44100 }), results = []
    try {
      for (const clip of clips) {
        const response = await fetch('/play/forpost/assets/forpost/' + clip.path)
        if (!response.ok || response.headers.get('content-type')?.split(';')[0] !== 'audio/wav') throw new Error('Invalid audio response: ' + clip.assetId)
        const bytes = await response.arrayBuffer()
        const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), value => value.toString(16).padStart(2, '0')).join('')
        if (bytes.byteLength !== clip.bytes || sha256 !== clip.sha256) throw new Error('Audio manifest bytes/hash mismatch: ' + clip.assetId)
        const header = new DataView(bytes)
        if (clip.format !== 'PCM16' || header.getUint16(20, true) !== 1 || header.getUint16(22, true) !== clip.channels || header.getUint32(24, true) !== clip.sampleRate || header.getUint16(34, true) !== 16) throw new Error('WAV metadata mismatch: ' + clip.assetId)
        const buffer = await context.decodeAudioData(bytes)
        if (buffer.sampleRate !== clip.sampleRate || buffer.numberOfChannels !== clip.channels || buffer.length !== Math.round(clip.duration * clip.sampleRate)) throw new Error('Native decoded metadata mismatch: ' + clip.assetId)
        let peak = 0
        for (const value of buffer.getChannelData(0)) { if (!Number.isFinite(value)) throw new Error('Non-finite PCM: ' + clip.assetId); peak = Math.max(peak, Math.abs(value)) }
        if (peak <= 0 || peak >= 1) throw new Error('Silent or clipped decoded PCM: ' + clip.assetId)
        results.push({ cue: clip.assetId, sha256, duration: buffer.duration, sampleRate: buffer.sampleRate, channels: buffer.numberOfChannels })
      }
    } finally { await context.close() }
    return results
  }, manifest.sounds)
  expect(decoded).toHaveLength(29)
  expect(await starts(page)).toHaveLength(0)

  // Use the existing visible 2D setting; this is an audio functional scenario.
  const settingsButton = page.getByRole('button', { name: 'Настройки', exact: true })
  await settingsButton.click()
  const settings = page.getByRole('dialog', { name: 'Настройки', exact: true }), mute = settings.getByRole('checkbox', { name: 'Без звука', exact: true })
  await settings.getByRole('combobox', { name: /^Отображение/ }).selectOption('2d')
  await mute.uncheck()
  await settings.getByRole('button', { name: 'Готово', exact: true }).click()
  const beforeUnlock = await cursor(page)
  await page.getByRole('button', { name: /Научиться играть/ }).click()
  await page.locator('.fp-lesson-list button').first().click()
  await expect(page.locator('.fp-lesson')).toBeVisible()
  await expect.poll(async () => new Set((await observations(page)).filter(event => event.kind === 'decode' && event.seq > beforeUnlock && event.state === 'running').map(event => event.cue)).size).toBe(29)

  const beforeOrder = await cursor(page)
  await page.locator('.fp-mode-switch').click()
  await expectCue(page, 'order', beforeOrder)
  await page.locator('.fp-mode-switch').click()
  await idle(page)
  const stage = page.locator('.fp-stage'), bounds = (await stage.boundingBox())!, ammo = page.locator('.fp-ammo strong')
  const shoot = () => stage.click({ position: { x: bounds.width * .7, y: bounds.height * .4 } })
  const beforeShot = await cursor(page)
  await shoot()
  await expect(ammo).not.toHaveText('24/24')
  await expectCue(page, 'carbine', beforeShot)
  await idle(page)

  // A real barrier cue lasts 700ms. Do not spend that window polling before mute.
  const beforeMute = await cursor(page)
  await page.locator('.fp-tool-button').click()
  await settingsButton.click(); await mute.check()
  const barrier = (await expectCue(page, 'barrier', beforeMute))[0], muteEvents = await observations(page)
  const muteEvent = muteEvents.find(event => event.kind === 'mute-toggle' && event.muted && event.seq > beforeMute)
  expect(muteEvent, 'The actual visible mute checkbox must receive its activation').toBeDefined()
  const endedBeforeMute = muteEvents.find(event => event.kind === 'ended' && event.voice === barrier.voice && event.seq < muteEvent!.seq)
  if (endedBeforeMute && !muteEvents.some(event => event.kind === 'stop' && event.voice === barrier.voice && event.seq < endedBeforeMute.seq)) {
    throw new Error(`AUDIO_MUTE_ACTIVE_VOICE_WINDOW_EXPIRED: native barrier ended before the visible mute gesture; ${JSON.stringify({ startMs: barrier.atMs, endedMs: endedBeforeMute.atMs, muteMs: muteEvent!.atMs, duration: barrier.duration })}`)
  }
  await expect.poll(async () => (await observations(page)).some(event => event.kind === 'stop' && event.voice === barrier.voice && event.seq > muteEvent!.seq && event.gain === 0), { timeout: 3000 }).toBe(true)
  await idle(page)
  await settings.getByRole('button', { name: 'Готово', exact: true }).click()
  const mutedCursor = await cursor(page), magazine = Number.parseInt(await ammo.innerText(), 10)
  await shoot()
  await expect.poll(async () => Number.parseInt(await ammo.innerText(), 10)).toBeLessThan(magazine)
  await page.waitForTimeout(400)
  expect(await starts(page, mutedCursor)).toHaveLength(0)

  await settingsButton.click(); await mute.uncheck(); await settings.getByRole('button', { name: 'Готово', exact: true }).click()
  await page.waitForTimeout(500)
  expect(await starts(page, mutedCursor)).toHaveLength(0)
  const beforeReload = await cursor(page)
  await page.locator('.fp-ammo').click()
  await expectCue(page, 'reload-start', beforeReload)
  await expect(ammo).toHaveText('24/24', { timeout: 5000 })
  await expectCue(page, 'reload-end', beforeReload)
  expect((await starts(page, mutedCursor)).filter(event => event.cue === 'carbine')).toHaveLength(0)
  await idle(page)
  // Read only this context's own lesson save; worker delivery is asynchronous.
  await expect.poll(() => page.evaluate(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('iva.forpost.tutorial.v1') ?? 'null') as World | null
      const fighter = saved?.units.find(unit => unit.kind === 'fighter' && unit.ownerId === 'learner')
      const reload = saved?.events.learner?.find(event => event.type === 'reload-finish')
      return saved?.mode === 'tutorial' && saved.tutorial?.lesson === 0 && !!reload && saved.tick >= reload.tick && fighter?.magazine === 24 && fighter.reloadUntil === 0
    } catch { return false }
  }), { timeout: 5000 }).toBe(true)

  // Browser reload and a new genuine unlock silently baseline old tutorial events.
  await page.reload()
  await expect(page.getByRole('heading', { name: 'ФОРПОСТ', exact: true })).toBeVisible()
  expect(await starts(page)).toHaveLength(0)
  await page.getByRole('button', { name: /Научиться играть/ }).click()
  await page.getByRole('button', { name: 'Продолжить сохранённый урок', exact: true }).click()
  await expect(page.locator('.fp-lesson')).toBeVisible()
  await expect.poll(async () => new Set((await observations(page)).filter(event => event.kind === 'decode' && event.state === 'running').map(event => event.cue)).size).toBe(29)
  await page.waitForTimeout(600)
  expect(await starts(page)).toHaveLength(0)
  const fresh = await cursor(page)
  await shoot()
  await expectCue(page, 'carbine', fresh)
  await idle(page)
  expect(errors).toEqual([])
  console.log(JSON.stringify({ nativeAudio: 'passed', build: health.buildRevision, browserName, decodedClips: decoded.length, freshUiCue: 'order', freshShotCue: 'carbine', muteStoppedNativeVoice: true, mutedShotConsumed: true, reloadReplayedOldShots: false, audioListened: false, physicalDevice: false, mockedAudio: false }))
})
