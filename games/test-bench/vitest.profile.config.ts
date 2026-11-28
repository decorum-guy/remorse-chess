import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
export default defineConfig({root:fileURLToPath(new URL('../../',import.meta.url)),test:{name:'test-bench-profile',environment:'node',include:['games/test-bench/tests/*.profile.ts'],fileParallelism:false,maxWorkers:1,testTimeout:60000}});
