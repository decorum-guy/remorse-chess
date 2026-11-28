import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const revision = process.env.IVA_BUILD_SHA ?? execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
export default defineConfig(({ command }) => ({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: command === 'serve' ? '/play/forpost/' : './',
  plugins: [react()],
  define: { __FORPOST_BUILD__: JSON.stringify(revision) },
  server: { proxy: {
    '/api/realtime': { target: 'http://127.0.0.1:4274', changeOrigin: false },
    '/api/platform': { target: 'http://127.0.0.1:4275', changeOrigin: false },
    '/ws/realtime': { target: 'ws://127.0.0.1:4274', ws: true, changeOrigin: false },
  } },
  build: { outDir: 'dist', emptyOutDir: true, license: { fileName: 'assets/forpost-LICENSES.md' } },
}))
