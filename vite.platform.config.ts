import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    ssr: true,
    outDir: 'dist-platform',
    target: 'node22',
    emptyOutDir: true,
    rollupOptions: { input: { main: 'apps/platform/src/main.ts', 'test-bench-worker': 'games/test-bench/src/worker-entry.ts' }, output: { entryFileNames: '[name].js' } },
  },
  ssr: {
    noExternal: ['@iva-games/test-bench', '@dimforge/rapier3d-compat', '@iva-games/district', '@iva-games/session-kit', '@iva-games/telegram-transport', '@iva-games/game-registry'],
    external: ['better-sqlite3', '@node-rs/argon2', 'nodemailer', 'https-proxy-agent', 'socks-proxy-agent'],
  },
});
