import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
export default defineConfig({ root: fileURLToPath(new URL('../../', import.meta.url)), test: { name: 'tyaga', environment: 'node', include: ['games/tyaga/tests/**/*.test.ts'], testTimeout: 30000 } });
