import { defineProject } from 'vitest/config';
import { fileURLToPath } from 'node:url';
export default defineProject({ root: fileURLToPath(new URL('.', import.meta.url)), test: { name: 'realtime', include: ['tests/**/*.test.ts'], environment: 'node', testTimeout: 20_000 } });
