import { defineConfig } from 'vite';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '../..');
export default defineConfig({
  build: { ssr: true, outDir: resolve(root, 'dist-realtime'), emptyOutDir: true, target: 'node22',
    rollupOptions: { input: { main: resolve(root, 'apps/realtime-server/src/main.ts'),
      'store-worker': resolve(root, 'apps/realtime-server/src/store-worker.ts'),
      'checkpoint-worker': resolve(root, 'apps/realtime-server/src/checkpoint-worker.ts'),
      'retention-cli': resolve(root, 'apps/realtime-server/src/retention-cli.ts'),
      'simulation-worker': resolve(root, 'apps/realtime-server/src/simulation-worker.ts') }, output: { entryFileNames: '[name].js' } } },
  ssr: { noExternal: ['@iva-games/forpost', '@iva-games/realtime-kit', '@iva-games/session-kit'], external: ['better-sqlite3', 'ws'] },
});
