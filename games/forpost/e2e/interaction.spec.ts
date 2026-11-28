import { test, expect } from '@playwright/test'
import type { CDPSession, Locator, Page, Route } from '@playwright/test'
import type { World } from '../src/core/types'
import { installDiagnostics, type TimingProbe } from './diagnostics'

installDiagnostics(test)

// All changes use the shipped visible interface. Saved tutorial state is read only
// for position/neutral-input assertions; no world, money, result or clock is injected.
const tutorialKey = 'iva.forpost.tutorial.v1'
async function savedLesson(page: Page): Promise<World | null> {
  return page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? 'null'), tutorialKey)
}
async function openMenu(page: Page) {
  await page.goto('/play/forpost/')
  const health = await (await page.request.get('/api/realtime/v1/health')).json()
  await expect(page.locator('[data-build]')).toHaveAttribute('data-build', health.buildRevision)
}
async function settings(page: Page) {
  await page.getByRole('button', { name: 'Настройки', exact: true }).click()
  return page.getByRole('dialog', { name: 'Настройки', exact: true })
}
async function startLesson(page: Page, index: number) {
  await openMenu(page)
  const panel = await settings(page)
  await panel.getByRole('combobox', { name: /^Отображение/ }).selectOption('2d')
  await panel.getByRole('button', { name: 'Готово', exact: true }).click()
  await page.getByRole('button', { name: /Научиться играть/ }).click()
  await page.locator('.fp-lesson-list button').nth(index).click()
  await expect(page.locator('.fp-lesson')).toBeVisible()
  await expect.poll(async () => (await savedLesson(page))?.tutorial?.lesson).toBe(index)
}
async function walkTo(page: Page, x: number, z: number) {
  for (const axis of ['x', 'z'] as const) {
    const target = axis === 'x' ? x : z
    for (let attempt = 0; attempt < 12; attempt++) {
      const world = (await savedLesson(page))!, unit = world.units.find(unit => unit.ownerId === 'learner' && unit.kind === 'fighter')!
      const delta = target - unit[axis]
      if (Math.abs(delta) < .25) break
      const key = axis === 'x' ? delta > 0 ? 'KeyD' : 'KeyA' : delta > 0 ? 'KeyS' : 'KeyW'
      await page.keyboard.down(key)
      await page.waitForTimeout(Math.min(500, Math.abs(delta) / 4.5 * 1000))
      await page.keyboard.up(key)
      // Wait for a later persisted observation after key release, not a stale pose.
      await page.waitForTimeout(1150)
    }
    const unit = (await savedLesson(page))!.units.find(unit => unit.ownerId === 'learner' && unit.kind === 'fighter')!
    expect(Math.abs(target - unit[axis])).toBeLessThan(.4)
  }
}
async function aimAtLessonPoint(page: Page, x: number, z: number) {
  const unit = (await savedLesson(page))!.units.find(unit => unit.ownerId === 'learner' && unit.kind === 'fighter')!
  const rect = (await page.locator('.fp-stage').boundingBox())!
  const width = rect.width < 600 ? 24 : 38, scale = rect.width / width, halfZ = rect.height / scale / (Math.sqrt(3) / 2) / 2
  const cx = Math.max(Math.min(width / 2, 32), Math.min(Math.max(64 - width / 2, 32), unit.x))
  const cz = Math.max(Math.min(halfZ, 20), Math.min(Math.max(40 - halfZ, 20), unit.z))
  await page.mouse.move(rect.x + rect.width / 2 + (x - cx) * scale, rect.y + rect.height / 2 + (z - cz) * scale * Math.sqrt(3) / 2)
}
async function selectPad(page: Page, id: string) {
  await page.getByRole('combobox', { name: /^Выбрать площадку/ }).selectOption(id)
}
async function confirmBuild(page: Page, id: string, name: string) {
  await selectPad(page, id)
  await page.locator('.fp-build-option').filter({ has: page.getByText(name, { exact: true }) }).click()
  await page.getByRole('button', { name: 'Построить', exact: true }).click()
  await expect(page.locator('.fp-build-confirm')).toHaveCount(0)
}
async function holdUntil(page: Page, key: string, assertion: () => Promise<void>) {
  await page.keyboard.down(key)
  try { await assertion() } finally { await page.keyboard.up(key) }
}
async function openDetails(page: Page, label: RegExp): Promise<Locator> {
  const details = page.locator('details').filter({ has: page.locator('summary').filter({ hasText: label }) })
  if (!await details.evaluate(node => node.hasAttribute('open'))) await details.locator('summary').click()
  return details
}

test('menu exposes all team, bot, weapon and tool choices and an escaped bounded callsign', async ({ page }) => {
  await openMenu(page)
  for (const map of ['FP01', 'FP02', 'FP03']) {
    const button = page.locator('.fp-map-card').filter({ hasText: map })
    await button.hover(); await button.focus(); await page.keyboard.press('Enter')
    await expect(button).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('.fp-map-card[aria-pressed="true"]')).toHaveCount(1)
  }
  const team = page.getByRole('combobox', { name: /^Состав/ })
  for (const value of ['1', '2', '3']) { await team.selectOption(value); await expect(team).toHaveValue(value) }
  const bot = page.getByRole('combobox', { name: /^Уровень ботов/ })
  for (const value of ['novice', 'normal', 'strong']) { await bot.selectOption(value); await expect(bot).toHaveValue(value) }
  for (const weapon of ['carbine', 'shotgun', 'rifle']) for (const tool of ['barrier', 'smoke', 'repair']) {
    await page.getByRole('combobox', { name: /^Оружие/ }).selectOption(weapon)
    await page.getByRole('combobox', { name: /^Полевой инструмент/ }).selectOption(tool)
    await expect(page.getByRole('combobox', { name: /^Оружие/ })).toHaveValue(weapon)
    await expect(page.getByRole('combobox', { name: /^Полевой инструмент/ })).toHaveValue(tool)
  }
  const callsign = page.getByRole('textbox', { name: /^Ваш позывной/ })
  await callsign.fill(''); await expect(callsign).toHaveValue('')
  await callsign.pressSequentially('<b>Командир</b>-12345678901234567890')
  expect((await callsign.inputValue()).length).toBe(24)
  await expect(page.locator('.fp-setup-row b')).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Играть онлайн', exact: true })).toHaveAttribute('href', '/rooms?game=forpost')
  await expect(page.getByRole('button', { name: 'Начать тренировку', exact: true })).toBeEnabled()
})

test('settings trap focus, restore it and persist every control through reload', async ({ page }) => {
  await openMenu(page)
  const opener = page.getByRole('button', { name: 'Настройки', exact: true })
  await opener.click()
  const panel = page.getByRole('dialog', { name: 'Настройки', exact: true })
  const close = panel.getByRole('button', { name: 'Закрыть', exact: true })
  const done = panel.getByRole('button', { name: 'Готово', exact: true })
  await expect(close).toBeFocused()
  await page.keyboard.press('Shift+Tab'); await expect(done).toBeFocused()
  await page.keyboard.press('Tab'); await expect(close).toBeFocused()
  await panel.getByRole('combobox', { name: /^Размер текста/ }).selectOption('1.3')
  await panel.getByRole('combobox', { name: /^Отображение/ }).selectOption('2d')
  await panel.getByRole('combobox', { name: /^Детализация/ }).selectOption('low')
  for (const label of [/^Общая громкость/, /^Эффекты/, /^Интерфейс/]) {
    const slider = panel.getByRole('slider', { name: label })
    await slider.focus(); await page.keyboard.press('Home'); await page.keyboard.press('ArrowRight')
    await expect(slider).toHaveValue('0.05')
  }
  for (const name of ['Без звука', 'Меньше движения', 'Мягкая помощь прицеливанию', 'Экранные джойстики']) {
    const checkbox = panel.getByRole('checkbox', { name, exact: true })
    await checkbox.uncheck(); await expect(checkbox).not.toBeChecked()
    await checkbox.check(); await expect(checkbox).toBeChecked()
  }
  await page.keyboard.press('Escape')
  await expect(panel).not.toBeVisible(); await expect(opener).toBeFocused()
  await page.reload(); await opener.click()
  for (const [name, value] of [[/^Размер текста/, '1.3'], [/^Отображение/, '2d'], [/^Детализация/, 'low']] as const) await expect(panel.getByRole('combobox', { name })).toHaveValue(value)
  for (const name of [/^Общая громкость/, /^Эффекты/, /^Интерфейс/]) await expect(panel.getByRole('slider', { name })).toHaveValue('0.05')
  for (const name of ['Без звука', 'Меньше движения', 'Мягкая помощь прицеливанию', 'Экранные джойстики']) await expect(panel.getByRole('checkbox', { name, exact: true })).toBeChecked()
  await panel.getByRole('combobox', { name: /^Язык/ }).selectOption('en')
  const english = page.getByRole('dialog', { name: 'Settings', exact: true })
  await expect(english.getByRole('checkbox', { name: 'Mute all sounds', exact: true })).toBeChecked()
  await english.getByRole('button', { name: 'Done', exact: true }).click()
  await page.reload(); await expect(page.getByRole('heading', { name: 'FORPOST', exact: true })).toBeVisible()
})

test('movement, aim, reload and modal neutral input complete the first lesson through controls', async ({ page }) => {
  await startLesson(page, 0)
  const objective = page.locator('.fp-lesson p')
  // Restart replaces the lesson while its Worker starts. Wait for the new
  // playable view, then test movement with actual focus on its visible button.
  const restart = page.getByRole('button', { name: 'Повторить', exact: true })
  const previousButton = (await restart.elementHandle())!
  await restart.click()
  await expect.poll(() => previousButton.evaluate(node => node.isConnected)).toBe(false)
  await expect(page.locator('.fp-network')).toContainText('На связи')
  await expect(page.locator('.fp-mode-switch')).toBeEnabled()
  await expect(restart).toBeVisible()
  await restart.focus(); await expect(restart).toBeFocused()
  await holdUntil(page, 'KeyD', () => expect.poll(() => objective.innerText(), { timeout: 3000, intervals: [25, 40, 50] }).toContain('ко второй отметке'))
  await holdUntil(page, 'KeyS', () => expect.poll(() => objective.innerText(), { timeout: 3000, intervals: [25, 40, 50] }).toContain('Наведитесь'))
  const menuButton = page.getByRole('button', { name: 'Меню партии', exact: true })
  await menuButton.click()
  const modal = page.getByRole('dialog', { name: 'Меню партии', exact: true })
  await expect(modal).toBeVisible()
  await page.waitForTimeout(1100)
  const before = (await savedLesson(page))!.units.find(unit => unit.ownerId === 'learner' && unit.kind === 'fighter')!
  await page.keyboard.down('KeyD'); await page.waitForTimeout(1200); await page.keyboard.up('KeyD')
  const after = (await savedLesson(page))!.units.find(unit => unit.id === before.id)!
  expect([after.x, after.z, after.magazine]).toEqual([before.x, before.z, before.magazine])
  await modal.getByRole('button', { name: 'Продолжить', exact: true }).click()
  await page.waitForTimeout(150)
  const rect = (await page.locator('.fp-stage').boundingBox())!
  // The lesson marks a visible target at (16,22); use the fixed orthographic map.
  const width = rect.width < 600 ? 24 : 38, scale = rect.width / width, halfZ = rect.height / scale / (Math.sqrt(3) / 2) / 2
  const cx = Math.max(Math.min(width / 2, 32), Math.min(Math.max(64 - width / 2, 32), after.x))
  const cz = Math.max(Math.min(halfZ, 20), Math.min(Math.max(40 - halfZ, 20), after.z))
  await page.mouse.move(rect.x + rect.width / 2 + (16 - cx) * scale, rect.y + rect.height / 2 + (22 - cz) * scale * Math.sqrt(3) / 2)
  await page.mouse.down()
  try { await expect(objective).toContainText('перезарядки', { timeout: 5000 }) } finally { await page.mouse.up() }
  await page.keyboard.press('KeyR')
  await expect(page.locator('.fp-lesson')).toContainText('Задача выполнена', { timeout: 6000 })
  await expect(page.locator('.fp-ammo strong')).toHaveText('24/24')
  const ammo = await page.locator('.fp-ammo strong').innerText()
  await page.waitForTimeout(750)
  await expect(page.locator('.fp-ammo strong')).toHaveText(ammo)
  await page.getByRole('button', { name: 'Следующий урок', exact: true }).click()
  await expect(page.locator('.fp-lesson h2')).toHaveText('Укрытие и защита')
})

test('construction cancel, queued refund, rebuild and disabled reasons finish the infrastructure lesson', async ({ page }) => {
  await startLesson(page, 3)
  await page.locator('.fp-mode-switch').click()
  await selectPad(page, 'L-13')
  const forbidden = page.locator('.fp-build-option:disabled')
  expect(await forbidden.count()).toBeGreaterThan(0)
  for (const button of await forbidden.all()) { await expect(button).toBeDisabled(); expect((await button.locator('small').first().innerText()).length).toBeGreaterThan(3) }
  await selectPad(page, 'L-03')
  await page.locator('.fp-build-option').filter({ has: page.getByText('Ретранслятор', { exact: true }) }).click()
  await expect(page.locator('.fp-build-confirm')).toContainText('60')
  await page.getByRole('button', { name: 'Отмена', exact: true }).click()
  await expect(page.locator('.fp-build-confirm')).toHaveCount(0)
  await confirmBuild(page, 'L-03', 'Ретранслятор')
  await confirmBuild(page, 'L-01', 'Экстрактор')
  const queue = await openDetails(page, /^Очередь строительства/)
  const second = queue.locator('.fp-queue-item').filter({ hasText: 'L-01' })
  await expect(second).toBeVisible()
  await second.getByRole('button', { name: 'Отмена', exact: true }).click()
  const confirm = page.getByRole('dialog', { name: 'Подтверждение', exact: true })
  await expect(confirm).toContainText('120 ¤')
  await confirm.getByRole('button', { name: 'Отмена', exact: true }).click()
  await expect(second).toBeVisible()
  await second.getByRole('button', { name: 'Отмена', exact: true }).click()
  await confirm.getByRole('button', { name: 'Подтвердить', exact: true }).click()
  await expect(second).toHaveCount(0)
  const refunds = await openDetails(page, /^Возвраты средств/)
  await expect(refunds).toContainText('120 ¤')
  await expect(refunds).toContainText('Сверх лимита')
  await confirmBuild(page, 'L-01', 'Экстрактор')
  await expect(page.locator('.fp-lesson')).toContainText('Задача выполнена', { timeout: 30_000 })
})

test('power priority, sale cancellation and generator finish the power lesson', async ({ page }) => {
  await startLesson(page, 4)
  const priorities = await openDetails(page, /^Приоритет питания/)
  const battery = priorities.locator('.fp-power-priority').filter({ hasText: /батарея/i })
  const raise = battery.getByRole('button', { name: /^Повысить приоритет/ })
  await raise.click()
  if (!(await battery.innerText()).includes('вкл.')) await raise.click()
  await expect(page.locator('.fp-lesson p')).toContainText('Продайте экстрактор')
  await selectPad(page, 'L-04')
  const sell = page.getByRole('button', { name: /^Продать ·/ })
  await sell.click()
  const confirm = page.getByRole('dialog', { name: 'Подтверждение', exact: true })
  await expect(confirm).toContainText('Расчётный возврат')
  await confirm.getByRole('button', { name: 'Отмена', exact: true }).click()
  await expect(sell).toBeVisible()
  await sell.click(); await confirm.getByRole('button', { name: 'Подтвердить', exact: true }).click()
  const cancelSale = page.getByRole('button', { name: /^Отменить продажу/ })
  await expect(cancelSale).toBeVisible(); await cancelSale.click()
  await expect(sell).toBeVisible()
  await sell.click(); await confirm.getByRole('button', { name: 'Подтвердить', exact: true }).click()
  await expect(page.locator('.fp-lesson p')).toContainText('Постройте генератор', { timeout: 5000 })
  await confirmBuild(page, 'L-04', 'Генератор')
  await expect(page.locator('.fp-lesson')).toContainText('Задача выполнена', { timeout: 30_000 })
})

test('dock cancel, production, drone escort and switching back finish the squad lesson', async ({ page }) => {
  await startLesson(page, 5)
  await selectPad(page, 'L-03')
  const order = page.getByRole('button', { name: /^Заказать дрон/ })
  await order.click()
  await expect(page.locator('.fp-dock .fp-queue-item')).toBeVisible()
  await page.locator('.fp-dock .fp-queue-item').getByRole('button', { name: 'Отменить', exact: true }).click()
  const confirm = page.getByRole('dialog', { name: 'Подтверждение', exact: true })
  await expect(confirm).toContainText('Расчётный возврат')
  await confirm.getByRole('button', { name: 'Подтвердить', exact: true }).click()
  await expect(page.locator('.fp-dock .fp-queue-item')).toHaveCount(0)
  await expect(order).toBeEnabled(); await order.click()
  await expect(page.locator('.fp-lesson p')).toContainText('Перейдите в тактику', { timeout: 15_000 })
  await page.locator('.fp-mode-switch').click()
  const drone = page.locator('.fp-unit-bar button').filter({ hasText: 'Боевой дрон' })
  await drone.click()
  await page.getByRole('button', { name: 'Сопровождать', exact: true }).click()
  await expect(page.locator('.fp-current-order')).toContainText('Сопровождать')
  await expect(page.locator('.fp-lesson p')).toContainText('Вернитесь к бойцу', { timeout: 30_000 })
  await page.locator('.fp-mode-switch').click()
  await expect(page.locator('.fp-lesson')).toContainText('Задача выполнена')
})

test('cover lesson requires a blocked shot, a real wall detour and barrier placement', async ({ page }) => {
  await startLesson(page, 1)
  await aimAtLessonPoint(page, 21, 23)
  await page.mouse.down()
  try { await expect(page.locator('.fp-lesson p')).toContainText('Обойдите стену', { timeout: 3000 }) } finally { await page.mouse.up() }
  // Go north first: walking straight to the eastern mark would hit the wall.
  await walkTo(page, 17, 19.8)
  await walkTo(page, 20.6, 19.8)
  await expect(page.locator('.fp-lesson p')).toContainText('Примените барьер')
  await aimAtLessonPoint(page, 26, 19.8)
  await page.keyboard.press('Space')
  await expect(page.locator('.fp-lesson')).toContainText('Задача выполнена')
  await expect(page.locator('.fp-tool-button')).toBeDisabled()
})

test('delivery lesson escorts its vehicle and clears the actual unloading circle', async ({ page }) => {
  await startLesson(page, 2)
  await walkTo(page, 32, 11)
  await expect(page.locator('.fp-lesson p')).toContainText('Сопроводите машину')
  await walkTo(page, 32, 19)
  await expect(page.locator('.fp-lesson p')).toContainText('Устраните учебного противника', { timeout: 20_000 })
  await aimAtLessonPoint(page, 32, 20)
  await page.mouse.down()
  try { await expect(page.locator('.fp-lesson p')).toContainText('Оставайтесь в круге', { timeout: 5000 }) } finally { await page.mouse.up() }
  await expect(page.locator('.fp-lesson')).toContainText('Задача выполнена', { timeout: 6000 })
  await expect.poll(async () => (await savedLesson(page))?.teams.A.deliveries).toBeGreaterThan(0)
})

test('final lesson reaches an operation result and starts a separate live practice', async ({ page }) => {
  test.setTimeout(180_000)
  await startLesson(page, 6)
  await page.locator('.fp-mode-switch').click()
  await page.locator('.fp-unit-bar button').filter({ hasText: 'Боец' }).click()
  await page.getByRole('button', { name: 'Сопровождать', exact: true }).click()
  await expect(page.locator('.fp-lesson')).toContainText('Задача выполнена', { timeout: 140_000 })
  await expect.poll(async () => (await savedLesson(page))?.phase).toBe('finished')
  const completed = (await savedLesson(page))!
  expect(completed.phase).toBe('finished')
  expect(completed.operations).toHaveLength(1)
  await expect(page.locator('.fp-result')).toHaveCount(0)
  const practicePath = '/api/realtime/v1/practice'
  expect(await page.evaluate(() => localStorage.getItem('iva.forpost.last-match.v1'))).toBeNull()
  let createdMatchId: string | null = null, primaryFailed = false, fixtureCleanupFailed = false, captureFailed = false
  let createStatus: number | null = null, captureCompletion: Promise<void> = Promise.resolve()
  // A browser Response body can disappear during the immediate pinned-route
  // navigation. Capture the real APIResponse before delivering it unchanged.
  const capturePractice = (route: Route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    captureCompletion = (async () => {
      try {
        const response = await route.fetch({ timeout: 15_000, maxRetries: 0 })
        createStatus = response.status()
        const result = await response.json().catch(() => null)
        if (createStatus === 201 && typeof result?.matchId === 'string') createdMatchId = result.matchId
        await route.fulfill({ response })
      } catch {
        captureFailed = true
        await route.abort().catch(() => {})
      }
    })()
    return captureCompletion
  }
  await page.route(`**${practicePath}`, capturePractice)
  const created = page.waitForResponse(response => new URL(response.url()).pathname === practicePath && response.request().method() === 'POST', { timeout: 15_000 }).then(response => response.status()).catch(() => null)
  try {
    await page.getByRole('button', { name: 'Начать тренировку', exact: true }).click()
    expect(await created).toBe(201)
    await captureCompletion
    expect(captureFailed).toBe(false)
    expect(createStatus).toBe(201)
    await expect(page.locator('.fp-game')).toBeVisible()
    await expect(page.locator('.fp-lesson')).toHaveCount(0)
    await expect(page.locator('.fp-network')).toContainText('На связи', { timeout: 30_000 })
    const ordinary = await page.evaluate(() => JSON.parse(localStorage.getItem('iva.forpost.last-match.v1') ?? 'null'))
    expect(ordinary?.matchId).toBeTruthy()
    expect(ordinary.matchId).not.toBe(completed.matchId)
    expect(ordinary.matchId).toBe(createdMatchId)
    await page.getByRole('button', { name: 'Меню партии', exact: true }).click()
    await page.getByRole('button', { name: 'В главное меню', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Продолжить партию', exact: true })).toBeVisible()
    await page.getByRole('button', { name: /Научиться играть/ }).click()
    await page.getByRole('button', { name: 'Продолжить сохранённый урок', exact: true }).click()
    await expect(page.locator('.fp-lesson')).toContainText('Задача выполнена')
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('iva.forpost.last-match.v1') ?? 'null')?.matchId)).toBe(ordinary.matchId)
  } catch (error) {
    primaryFailed = true
    throw error
  } finally {
    await created
    await captureCompletion
    await page.unroute(`**${practicePath}`, capturePractice).catch(() => {})
    if (!createdMatchId && createStatus === 201) {
      // Only this fresh context's previously empty ordinary save can be a
      // fallback identity. The wait survives an in-progress pinned navigation.
      const savedId = await page.waitForFunction(() => {
        const saved = JSON.parse(localStorage.getItem('iva.forpost.last-match.v1') ?? 'null')
        return !saved?.roomId && typeof saved?.matchId === 'string' ? saved.matchId : null
      }, undefined, { timeout: 3000 }).then(handle => handle.jsonValue()).catch(() => null)
      if (typeof savedId === 'string' && savedId !== completed.matchId) createdMatchId = savedId
    }
    // Release only this test's real fixture, after all persistence assertions.
    // The context's own HttpOnly cookie supplies ownership; capacity stays real.
    if (createdMatchId) {
      const cleanup = await page.request.post(`/api/realtime/v1/practice/${encodeURIComponent(createdMatchId)}/abandon`, { data: {}, headers: { Origin: new URL(page.url()).origin }, timeout: 5000 }).catch(() => null)
      if (!cleanup?.ok()) {
        fixtureCleanupFailed = true
        console.log(JSON.stringify({ automatedFixtureCleanup: 'final-lesson-practice', outcome: 'failed', httpStatus: cleanup?.status() ?? null, primaryFailed }))
      }
    } else if (createStatus === 201) {
      fixtureCleanupFailed = true
      console.log(JSON.stringify({ automatedFixtureCleanup: 'final-lesson-practice', outcome: 'identity-unavailable', primaryFailed }))
    }
  }
  expect(fixtureCleanupFailed, 'OWN_PRACTICE_CLEANUP_FAILED').toBe(false)
})

test('switching browser tabs while firing releases input and does not resume old shots', async ({ page, context, browserName }) => {
  let focusDriver: CDPSession | undefined
  let other: Page | undefined
  try {
    if (browserName === 'chromium') {
      focusDriver = await context.newCDPSession(page)
      // Playwright enables this override by default. Removing it allows actual
      // tab activation to determine focus; no focus/blur event is synthesized.
      await focusDriver.send('Emulation.setFocusEmulationEnabled', { enabled: false })
    }
    await startLesson(page, 0)
    await page.bringToFront()
    try {
      await expect.poll(() => page.evaluate(() => ({ hidden: document.hidden, hasFocus: document.hasFocus() })), { timeout: 3000, message: 'BROWSER_INITIAL_FOCUS_UNAVAILABLE: the lesson must really be visible and focused before firing.' }).toEqual({ hidden: false, hasFocus: true })
    } catch (error) {
      console.log(JSON.stringify({ automatedCapabilityFailure: 'BROWSER_INITIAL_FOCUS_UNAVAILABLE', browserName, chromiumFocusEmulationDisabled: !!focusDriver }))
      throw error
    }
    console.log(JSON.stringify({ automatedFocusPrecondition: 'visible-and-focused', browserName, chromiumFocusEmulationDisabled: !!focusDriver }))
    await aimAtLessonPoint(page, 30, 5)
    const ammo = page.locator('.fp-ammo strong')
    await page.mouse.down()
    await expect(ammo).not.toHaveText('24/24')
    const beforeFocus = await page.evaluate(() => ({ sequence: (window as Window & { __forpostQaTiming?: TimingProbe }).__forpostQaTiming?.focusEvents.at(-1)?.seq ?? 0, hidden: document.hidden, hasFocus: document.hasFocus() }))
    other = await context.newPage()
    await other.goto('about:blank'); await other.bringToFront()
    try {
      await expect.poll(() => page.evaluate(before => {
        const events = (window as Window & { __forpostQaTiming?: TimingProbe }).__forpostQaTiming?.focusEvents ?? []
        return !before.hidden && document.hidden || before.hasFocus && !document.hasFocus() || events.some(event => event.seq > before.sequence && (event.type === 'blur' || event.type === 'visibilitychange' && event.hidden))
      }, beforeFocus), { timeout: 3000, message: 'BROWSER_FOCUS_LOSS_UNAVAILABLE: tab activation must produce real focus or visibility loss before fire-release acceptance.' }).toBe(true)
    } catch (error) {
      console.log(JSON.stringify({ automatedCapabilityFailure: 'BROWSER_FOCUS_LOSS_UNAVAILABLE', browserName }))
      throw error
    }
    await other.waitForTimeout(500)
    await page.bringToFront()
    await page.waitForTimeout(100)
    const released = await ammo.innerText()
    expect(released).not.toBe('0/24')
    await page.waitForTimeout(850)
    await expect(ammo).toHaveText(released)
  } finally { await page.mouse.up().catch(() => {}); await other?.close().catch(() => {}); await focusDriver?.detach().catch(() => {}) }
})
