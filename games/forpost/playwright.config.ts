import { defineConfig } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../..', import.meta.url))
const origin = 'http://127.0.0.1:5274'
const revision = process.env.IVA_BUILD_SHA ?? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
const browserName = process.env.FORPOST_BROWSER === 'webkit' ? 'webkit' : 'chromium'

export default defineConfig({
  testDir: './e2e', fullyParallel: false, workers: 1, timeout: 60_000,
  expect: { timeout: 10_000 }, reporter: [['list']],
  use: { baseURL: origin, browserName, headless: true, trace: 'off', video: 'off', screenshot: 'off', actionTimeout: 15_000, navigationTimeout: 30_000,
    viewport: { width: 1440, height: 900 },
    launchOptions: browserName === 'chromium' && process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : undefined },
  webServer: { command: 'npm run build:forpost && npm run build:realtime && npm run build:portal && npm run build:platform && node scripts/forpost-qa-server.mjs',
    cwd: root, env: { IVA_BUILD_SHA: revision }, url: `${origin}/__qa/health`, reuseExistingServer: false, timeout: 120_000 },
})
