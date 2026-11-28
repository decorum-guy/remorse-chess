import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../..', import.meta.url));
export default defineConfig({
  root,
  build: {
    ssr: true, target: 'node24', outDir: 'dist-realtime', emptyOutDir: true,
    rollupOptions: {
      input: { main: `${root}/apps/realtime-server/src/main.ts`, 'writer-worker': `${root}/apps/realtime-server/src/writer-worker.ts`, 'simulation-worker': `${root}/apps/realtime-server/src/simulation-worker.ts` },
      output: { entryFileNames: '[name].js', chunkFileNames: 'chunks/[name]-[hash].js' },
    },
  },
  // Bundle the physics package resolved from the game workspace. An external
  // import emitted beside dist-realtime would resolve an unrelated hoisted
  // version (older games also use Rapier), invalidating the recovery manifest.
  ssr: { noExternal: ['@iva-games/realtime-kit', '@iva-games/session-kit', '@iva-games/tyaga', '@dimforge/rapier3d-compat'], external: ['better-sqlite3', 'ws'] },
});
