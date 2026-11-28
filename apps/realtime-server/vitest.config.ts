import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
export default defineConfig({ root: fileURLToPath(new URL('.', import.meta.url)), test: { name: 'realtime', include: ['tests/**/*.test.ts'], environment: 'node' } });
