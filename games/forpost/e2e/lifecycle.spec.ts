import { test, expect } from '@playwright/test'
import type { Page, Route } from '@playwright/test'
import { installDiagnostics } from './diagnostics'

installDiagnostics(test)

// A source-derived navigation race, prepared for native CI reproduction. The
// request reaches the real server; only delivery of its unchanged reply waits.
const practicePath = '/api/realtime/v1/practice'
async function ownLesson(page: Page) {
  return page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem('iva.forpost.tutorial.v1') ?? 'null')
    return saved ? { lesson: saved.tutorial?.lesson, matchId: saved.matchId, tick: saved.tick } : null
  })
}

test('a late real practice response leaves the newly selected lesson active and releases its own room', async ({ page }) => {
  await page.goto('/play/forpost/')
  const health = await (await page.request.get('/api/realtime/v1/health')).json()
  await expect(page.locator('[data-build]')).toHaveAttribute('data-build', health.buildRevision)
  expect(await page.evaluate(() => localStorage.getItem('iva.forpost.last-match.v1'))).toBeNull()
  await page.getByRole('button', { name: 'Настройки', exact: true }).click()
  const settings = page.getByRole('dialog', { name: 'Настройки', exact: true })
  await settings.getByRole('combobox', { name: /^Отображение/ }).selectOption('2d')
  await settings.getByRole('button', { name: 'Готово', exact: true }).click()
  await page.getByRole('button', { name: /Научиться играть/ }).click()
  await page.locator('.fp-lesson-list button').nth(6).click()
  await expect(page.locator('.fp-lesson h2')).toHaveText('Первая операция')
  await page.locator('.fp-mode-switch').click()
  await page.locator('.fp-unit-bar button').filter({ hasText: 'Боец' }).click()
  await page.getByRole('button', { name: 'Сопровождать', exact: true }).click()
  await expect(page.locator('.fp-lesson')).toContainText('Задача выполнена', { timeout: 40_000 })

  let releaseDelivery = () => {}
  const delivery = new Promise<void>(resolve => { releaseDelivery = resolve })
  let createdMatchId: string | null = null, createStatus: number | null = null, createErrorCode: string | null = null, requestedAt = 0
  let fetched = false, delivered = false, routeFailed = false, appCleanupConfirmed = false, primaryFailed = false, fixtureCleanupFailed = false
  let routeCompletion: Promise<void> = Promise.resolve()
  const routeHandler = (route: Route) => {
    requestedAt = performance.now()
    routeCompletion = (async () => {
      try {
        const response = await route.fetch({ timeout: 15_000, maxRetries: 0 })
        createStatus = response.status()
        const result = await response.json()
        if (createStatus === 201 && typeof result.matchId === 'string') createdMatchId = result.matchId
        const code = result.error?.code ?? result.code
        if (typeof code === 'string' && /^[A-Z_]{1,80}$/.test(code)) createErrorCode = code
        fetched = true
        await delivery
        await route.fulfill({ response })
        delivered = true
      } catch {
        routeFailed = true
        await route.abort().catch(() => {})
      }
    })()
    return routeCompletion
  }
  await page.route(`**${practicePath}`, routeHandler)
  try {
    await page.getByRole('button', { name: 'Начать тренировку', exact: true }).click()
    await expect.poll(() => fetched || routeFailed, { timeout: 10_000 }).toBe(true)
    expect(routeFailed, 'The real practice request must succeed before its reply is held.').toBe(false)
    if (createStatus !== 201) console.log(JSON.stringify({ automatedLifecyclePrecondition: 'real-practice-create', status: createStatus, errorCode: createErrorCode }))
    expect(createStatus).toBe(201)
    expect(createdMatchId).toMatch(/^[\w-]+$/)
    await page.getByRole('button', { name: 'Все уроки', exact: true }).click()
    await page.locator('.fp-lesson-list button').nth(0).click()
    await expect(page.locator('.fp-lesson h2')).toHaveText('Движение и стрельба')
    await expect(page.locator('.fp-mode-switch')).toBeEnabled()
    await expect.poll(async () => (await ownLesson(page))?.lesson).toBe(0)
    const selected = (await ownLesson(page))!
    const responseDelayMs = performance.now() - requestedAt
    expect(responseDelayMs, 'LIFECYCLE_DELAYED_RESPONSE_WINDOW_EXPIRED: deliver inside the real client 20-second request timeout.').toBeLessThan(19_000)

    const abandonPath = `${practicePath}/${encodeURIComponent(createdMatchId!)}/abandon`
    const abandoned = page.waitForResponse(response => new URL(response.url()).pathname === abandonPath && response.request().method() === 'POST', { timeout: 10_000 })
    releaseDelivery()
    const cleanup = await abandoned
    expect(cleanup.status(), 'The app must abandon exactly the cancelled create result.').toBe(200)
    appCleanupConfirmed = true
    await routeCompletion
    expect(delivered).toBe(true)
    expect(routeFailed).toBe(false)
    await expect(page.locator('.fp-lesson h2')).toHaveText('Движение и стрельба')
    expect(await page.evaluate(() => localStorage.getItem('iva.forpost.last-match.v1'))).toBeNull()
    await expect(page.locator('.fp-toast')).toHaveCount(0)
    // An accepted action proves that the late response did not close the Worker
    // or leave the current session's action controls busy.
    await page.locator('.fp-mode-switch').click()
    await expect(page.locator('.fp-mode-switch')).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(async () => (await ownLesson(page))?.tick).toBeGreaterThan(selected.tick)
    expect((await ownLesson(page))?.matchId).toBe(selected.matchId)
    console.log(JSON.stringify({ automatedLifecycle: 'late-practice-response', realCreateStatus: createStatus, appAbandonStatus: cleanup.status(), responseDelayMs, unchangedLesson: 0, acceptedAction: 'mode' }))
  } catch (error) {
    primaryFailed = true
    throw error
  } finally {
    releaseDelivery()
    await routeCompletion
    await page.unroute(`**${practicePath}`, routeHandler).catch(() => {})
    if (createdMatchId && !appCleanupConfirmed) {
      const cleanup = await page.request.post(`${practicePath}/${encodeURIComponent(createdMatchId)}/abandon`, { data: {}, headers: { Origin: new URL(page.url()).origin }, timeout: 5000 }).catch(() => null)
      if (!cleanup?.ok()) {
        fixtureCleanupFailed = true
        console.log(JSON.stringify({ automatedFixtureCleanup: 'late-practice-response', outcome: 'failed', httpStatus: cleanup?.status() ?? null, primaryFailed }))
      }
    }
  }
  expect(fixtureCleanupFailed, 'OWN_PRACTICE_CLEANUP_FAILED').toBe(false)
})
