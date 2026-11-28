import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import type { World } from '../src/core/types'
import { installDiagnostics } from './diagnostics'

installDiagnostics(test)

// Browser-emulated touch input, distinct from a physical phone acceptance pass.
// CDP dispatches native browser touch events; it never edits the game world.
test.use({ viewport: { width: 390, height: 600 }, isMobile: true, hasTouch: true })

async function learner(page: Page) {
  const world = await page.evaluate(() => JSON.parse(localStorage.getItem('iva.forpost.tutorial.v1') ?? 'null')) as World | null
  return world?.units.find(unit => unit.ownerId === 'learner' && unit.kind === 'fighter')
}
async function point(button: Locator, id: number, dx = 0, dy = 0) {
  await expect(button).toBeVisible()
  const rect = (await button.boundingBox())!
  const p = { x: rect.x + rect.width / 2 + dx, y: rect.y + rect.height / 2 + dy, id, radiusX: 2, radiusY: 2, force: 1 }
  expect(await button.evaluate((element, location) => element.contains(document.elementFromPoint(location.x, location.y)), p)).toBe(true)
  return p
}

test('touch sticks, simultaneous fire, cancel, reload and rotation operate the real controls', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'Native multitouch driver uses Chromium CDP; physical phone acceptance remains separate.')
  await page.goto('/play/forpost/')
  const health = await (await page.request.get('/api/realtime/v1/health')).json()
  await expect(page.locator('[data-build]')).toHaveAttribute('data-build', health.buildRevision)
  await page.getByRole('button', { name: 'Настройки', exact: true }).tap()
  const settings = page.getByRole('dialog', { name: 'Настройки', exact: true })
  await settings.getByRole('combobox', { name: /^Отображение/ }).selectOption('2d')
  await settings.getByRole('checkbox', { name: 'Экранные джойстики', exact: true }).check()
  await settings.getByRole('button', { name: 'Готово', exact: true }).tap()
  await page.getByRole('button', { name: /Научиться играть/ }).tap()
  await page.locator('.fp-lesson-list button').first().tap()
  await expect.poll(() => learner(page)).toBeTruthy()
  const initial = (await learner(page))!
  const move = page.getByRole('button', { name: 'Джойстик движения', exact: true })
  const aim = page.getByRole('button', { name: 'Прицеливание и огонь', exact: true })
  const ammo = page.locator('.fp-ammo strong')
  const cdp = await context.newCDPSession(page)
  try {
    const moving = await point(move, 1, 30), gentleAim = await point(aim, 2, 5)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [moving, gentleAim] })
    await expect.poll(async () => (await learner(page))?.x, { timeout: 4000 }).toBeGreaterThan(initial.x + .5)
    await expect(ammo).toHaveText('24/24')
    const firingAim = await point(aim, 2, 28)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [moving, firingAim] })
    await expect(ammo).not.toHaveText('24/24')
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] })
    await page.waitForTimeout(1200)
    const released = (await learner(page))!, remaining = await ammo.innerText()
    await page.waitForTimeout(1200)
    const stable = (await learner(page))!
    expect([stable.x, stable.z]).toEqual([released.x, released.z])
    await expect(ammo).toHaveText(remaining)
    await page.locator('.fp-touch-reload').tap()
    await expect(ammo).toHaveText('24/24', { timeout: 5000 })
    // Actual browser emulation changes orientation; no synthetic DOM event is injected.
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 1, mobile: true,
      screenOrientation: { type: 'landscapePrimary', angle: 90 } })
    await expect(page.locator('.fp-touch-fire')).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    const fire = await point(page.locator('.fp-touch-fire'), 3)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [fire] })
    await expect(ammo).not.toHaveText('24/24')
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await page.waitForTimeout(250)
    const finalAmmo = await ammo.innerText()
    await page.waitForTimeout(750)
    await expect(ammo).toHaveText(finalAmmo)
    await page.getByRole('button', { name: 'Меню партии', exact: true }).tap()
    await expect(page.getByRole('dialog', { name: 'Меню партии', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Продолжить', exact: true }).tap()
  } finally {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] }).catch(() => {})
    await cdp.detach().catch(() => {})
  }
})
