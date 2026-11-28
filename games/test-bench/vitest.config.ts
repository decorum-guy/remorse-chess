import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
export default defineConfig({root:fileURLToPath(new URL('../../',import.meta.url)),test:{name:'test-bench',environment:'node',include:['games/test-bench/tests/**/*.test.ts'],testTimeout:30000}});
