import { test, expect, errors } from '@playwright/test'
import type { Page, APIRequestContext, Locator } from '@playwright/test'
import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { WorldView } from '../src/core/types'
import { installDiagnostics } from './diagnostics'

installDiagnostics(test)

const origin = 'http://127.0.0.1:5274'
const root = resolve(import.meta.dirname, '../../..')
async function post(api: APIRequestContext, path: string, body: unknown) {
  const current = await (await api.get('/api/platform/v1/session')).json()
  const response = await api.post('/api/platform/v1' + path, { data: body, headers: { Origin: origin, 'X-CSRF-Token': current.csrfToken, 'Idempotency-Key': randomUUID() } })
  expect(response.ok(), `${path}: HTTP ${response.status()}`).toBe(true)
  return response.json()
}
/** Explicit isolated fixtures: local .test accounts and file mailbox, no outgoing mail. */
async function account(page: Page, prefix: string) {
  const suffix = randomUUID().slice(0, 8), handle = `fp_${prefix}_${suffix}`, email = `${handle}@example.test`
  await post(page.request, '/auth/register', { email, password: 'Forpost-local-fixture-2026!', handle, displayName: `QA ${prefix}` })
  const config = JSON.parse(await readFile(resolve(root, '.qa/forpost/current-e2e.json'), 'utf8')) as { mailDirectory: string; origin: string }
  const files = await readdir(config.mailDirectory)
  let verification: string | undefined
  for (const file of files) {
    const message = await readFile(resolve(config.mailDirectory, file), 'utf8')
    if (message.split(/\r?\n/, 1)[0] !== `To: ${email}`) continue
    const link = message.split(/\r?\n/).map(line => line.trim()).find(line => line.startsWith(`${config.origin}/verify?`))
    if (link) { const url = new URL(link); if (url.origin === origin && url.pathname === '/verify') verification = url.searchParams.get('token') ?? undefined }
  }
  expect(verification, 'local verification token').toMatch(/^[A-Za-z0-9_-]{40,64}$/)
  await post(page.request, '/auth/verify', { token: verification })
}
function observeView(page: Page) {
  let latest: WorldView | undefined
  let serverOverloadObserved = false
  const bases = new Map<number, WorldView>()
  let epoch: number | undefined
  page.on('websocket', socket => socket.on('framereceived', event => {
    const packet = JSON.parse(String(event.payload))
    if (packet.type === 'phaseChanged' && packet.phase === 'paused' && packet.reason === 'SERVER_BUSY') serverOverloadObserved = true
    if (packet.type === 'hello') { epoch = packet.epoch; bases.clear(); latest = undefined; return }
    if (packet.type === 'full') { if (epoch !== packet.epoch) bases.clear(); epoch = packet.epoch; latest = packet.view }
    else if (packet.type === 'delta') {
      const baseline = bases.get(packet.baselineSnapshotSeq)
      if (packet.epoch !== epoch || !baseline) return
      latest = { ...baseline, ...packet.patch }
    } else return
    if (latest) { bases.set(packet.snapshotSeq, latest); while (bases.size > 64) bases.delete(bases.keys().next().value!) }
  }))
  return () => {
    // A real overload pause already violates this continuous-match scenario.
    // Fail at the next observation instead of waiting out the 20-minute match
    // budget. The original result/escort/privacy assertions remain mandatory.
    expect(serverOverloadObserved, 'SERVER_BUSY observed in an actual phaseChanged message').toBe(false)
    return latest
  }
}
/** A result overlay can arrive between the last snapshot and a visible UI click. */
async function clickWithinOperation(locator: Locator, latest: () => WorldView | undefined): Promise<boolean> {
  const before = latest()
  if (!before || before.phase === 'operationResult' || before.phase === 'finished') return false
  try { await locator.click({ timeout: 1500 }); return true }
  catch (error) {
    const after = latest()
    // Suppress only a click timeout accompanied by the actually observed result transition.
    if (error instanceof errors.TimeoutError && after && (after.phase === 'operationResult' || after.phase === 'finished' || after.operation !== before.operation)) return false
    throw error
  }
}
async function lesson(page: Page, index: number) {
  await page.goto('/play/forpost/')
  await page.getByRole('button', { name: /Научиться играть/ }).click()
  await page.locator('.fp-lesson-list button').nth(index).click()
  await expect(page.locator('.fp-lesson')).toBeVisible()
}
async function exitMenu(page: Page) {
  await page.getByRole('button', { name: 'Меню партии', exact: true }).click()
  await page.getByRole('button', { name: 'В главное меню', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'ФОРПОСТ', exact: true })).toBeVisible()
}
test('catalogue, exact build, all map choices and persisted RU/EN/settings', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
  await page.goto('/games')
  await expect(page.locator('.game-forpost')).toBeVisible()
  await page.locator('.game-forpost').getByRole('link', { name: 'Играть', exact: true }).click()
  const identity = await (await page.request.get('/api/realtime/v1/health')).json()
  await expect(page.locator('[data-build]')).toHaveAttribute('data-build', identity.buildRevision)
  for (const map of ['FP01', 'FP02', 'FP03']) {
    const choice = page.locator('.fp-map-card').filter({ hasText: map }); await choice.click(); await expect(choice).toHaveAttribute('aria-pressed', 'true')
  }
  await page.getByRole('button', { name: 'Настройки', exact: true }).click()
  // A wrapping label also contains option text; locate the named control itself.
  await page.getByRole('combobox', { name: /^Язык/ }).selectOption('en')
  await page.getByRole('combobox', { name: /^Text size/ }).selectOption('1.3')
  await page.getByLabel('Reduced motion', { exact: true }).check()
  await page.getByRole('button', { name: 'Done', exact: true }).click()
  await page.reload()
  await expect(page.getByRole('heading', { name: 'FORPOST', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page.getByRole('combobox', { name: /^Text size/ })).toHaveValue('1.3')
  await expect(page.getByLabel('Reduced motion', { exact: true })).toBeChecked()
  expect(errors).toEqual([])
})

test('actual tutorial construction, queue, power state and isolated save', async ({ page }) => {
  await lesson(page, 3)
  await page.locator('.fp-mode-switch').click()
  await page.getByRole('button', { name: 'Строительство', exact: true }).click()
  for (const [pad, name] of [['L-03', 'Ретранслятор'], ['L-01', 'Экстрактор']]) {
    await page.getByRole('combobox', { name: /^Выбрать площадку/ }).selectOption(pad)
    await page.locator('.fp-build-option').filter({ has: page.getByText(name, { exact: true }) }).click()
    await expect(page.getByRole('button', { name: 'Построить', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: 'Построить', exact: true }).click()
  }
  await expect(page.locator('.fp-lesson')).toContainText('Задача выполнена', { timeout: 40_000 })
  await exitMenu(page)
  await page.getByRole('button', { name: /Научиться играть/ }).click()
  await page.getByRole('button', { name: 'Продолжить сохранённый урок', exact: true }).click()
  await expect(page.locator('.fp-lesson')).toContainText('Задача выполнена')
  expect(await page.evaluate(() => localStorage.getItem('iva.forpost.last-match.v1'))).toBeNull()
})

test.describe('mobile controls', () => {
  // The fixture owns teardown, preserving the original error if a test times out.
  test.use({ viewport: { width: 390, height: 600 }, isMobile: true, hasTouch: true })
  test('touch viewport, 130 percent text, renderer fallback and rotation keep controls usable', async ({ page }) => {
    await lesson(page, 0)
    await expect(page.getByRole('button', { name: 'Джойстик движения', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Меню партии', exact: true }).click()
    await page.getByRole('dialog', { name: 'Меню партии', exact: true }).getByRole('button', { name: 'Настройки', exact: true }).click()
    const settings = page.getByRole('dialog', { name: 'Настройки', exact: true })
    await settings.getByRole('combobox', { name: /^Размер текста/ }).selectOption('1.3')
    await settings.getByRole('combobox', { name: /^Отображение/ }).selectOption('2d')
    await settings.getByRole('button', { name: 'Готово', exact: true }).click()
    await expect(settings).not.toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.setViewportSize({ width: 844, height: 390 })
    await expect(page.getByRole('button', { name: 'Огонь', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Меню партии', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Продолжить', exact: true })).toBeVisible()
  })
})

test.describe('three complete network matches through visible controls', () => {
  test.describe.configure({ mode: 'parallel' })
  const renderer = process.env.FORPOST_MAP_RENDERER === '2d' ? '2d' : '3d'
  for (const map of ['FP01', 'FP02', 'FP03']) test(`${map}: lobby, direct input, squad escort, match result and return [${renderer}]`, async ({ page }) => {
    test.setTimeout(1_300_000)
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message)); const latest = observeView(page)
    await account(page, map.toLowerCase())
    if (renderer === '2d') {
      // An additional supported-renderer passage, separate from the unchanged
      // default-3D jobs. Selecting it never counts as 3D performance acceptance.
      await page.goto('/play/forpost/')
      await page.getByRole('button', { name: 'Настройки', exact: true }).click()
      const settings = page.getByRole('dialog', { name: 'Настройки', exact: true })
      await settings.getByRole('combobox', { name: /^Отображение/ }).selectOption('2d')
      await settings.getByRole('button', { name: 'Готово', exact: true }).click()
    }
    await page.goto('/rooms?game=forpost')
    const createDialog = page.getByRole('dialog', { name: 'Новая комната', exact: true })
    await expect(createDialog).toBeVisible()
    await createDialog.getByRole('combobox', { name: /^Мест за столом/ }).selectOption('2')
    await createDialog.getByRole('combobox', { name: /^Карта операции/ }).selectOption(map)
    await createDialog.getByRole('button', { name: 'Создать комнату', exact: true }).click()
    await page.locator('.add-bot').getByRole('button', { name: 'Добавить', exact: true }).click()
    await page.getByRole('button', { name: 'Я готов', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Начать игру', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: 'Начать игру', exact: true }).click()
    await page.getByRole('link', { name: 'Открыть Форпост', exact: true }).click()
    await expect(page.locator('.fp-game')).toBeVisible()
    await expect.poll(() => latest()?.mapId).toBe(map)
    await expect.poll(() => latest()?.phase, { timeout: 30_000 }).toBe('battle')
    const stage = page.locator('.fp-stage'), bounds = (await stage.boundingBox())!
    await stage.click(); const side = latest()!.teams[latest()!.yourTeam].side
    await page.keyboard.down(side === 'L' ? 'KeyD' : 'KeyA'); await page.waitForTimeout(1200); await page.keyboard.up(side === 'L' ? 'KeyD' : 'KeyA')
    await page.mouse.move(bounds.x + bounds.width * (side === 'L' ? .7 : .3), bounds.y + bounds.height / 2)
    await page.mouse.down(); await page.waitForTimeout(400); await page.mouse.up()
    await page.locator('.fp-mode-switch').click()
    const started = Date.now(); let observedEscort = false
    while (Date.now() - started < 1_220_000 && latest()?.phase !== 'finished') {
      if (latest()?.phase === 'operationResult') { await page.waitForTimeout(1000); continue }
      const player = latest()?.participants.find(p => p.id === latest()?.you)
      if (player?.mode !== 'tactics') { const mode = page.locator('.fp-mode-switch'); if (await mode.isEnabled()) await clickWithinOperation(mode, latest) }
      const fighterButton = page.locator('.fp-unit-bar button').filter({ hasText: 'Боец' })
      if (await fighterButton.count()) {
        if (!await clickWithinOperation(fighterButton, latest)) continue
        const escort = page.getByRole('button', { name: 'Сопровождать', exact: true })
        if (await escort.isVisible() && await escort.isEnabled()) await clickWithinOperation(escort, latest)
      }
      const view = latest()
      if (view?.units.some(unit => unit.ownerId === view.you && unit.kind === 'fighter' && unit.order?.type === 'escort')) observedEscort = true
      if (view && view.phase !== 'finished') for (const transport of view.transports.filter(t => t.team !== view.yourTeam)) {
        expect(transport).not.toHaveProperty('speed'); expect(transport).not.toHaveProperty('escorted'); expect(transport).not.toHaveProperty('unloadTicks'); expect(transport).not.toHaveProperty('lastDamageTick')
      }
      await page.waitForTimeout(2000)
    }
    expect(latest()?.phase).toBe('finished')
    expect(observedEscort).toBe(true)
    expect(latest()!.operations.length).toBeGreaterThanOrEqual(2)
    await expect(page.locator('.fp-result')).toBeVisible()
    await expect(page.locator('.fp-result')).toContainText(/Победа|Поражение|Ничья/)
    await page.getByRole('button', { name: 'В меню', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'ФОРПОСТ', exact: true })).toBeVisible()
    expect(errors).toEqual([])
    console.log(JSON.stringify({ automatedUi: true, map, matchId: latest()!.matchId, tick: latest()!.tick, operations: latest()!.operations, winner: latest()!.winner }))
  })
})
