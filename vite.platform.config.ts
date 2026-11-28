import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    ssr: 'apps/platform/src/main.ts',
    outDir: 'dist-platform',
    target: 'node22',
    emptyOutDir: true,
    rollupOptions: { output: { entryFileNames: 'main.js' } },
  },
  ssr: {
    noExternal: ['@iva-games/district', '@iva-games/session-kit', '@iva-games/telegram-transport', '@iva-games/game-registry', '@iva-games/realtime-kit'],
    external: ['better-sqlite3', '@node-rs/argon2', 'nodemailer', 'https-proxy-agent', 'socks-proxy-agent'],
  },
});
