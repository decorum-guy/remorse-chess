import base from '../apps/realtime-server/vite.config';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
export default { ...base, build: { ...base.build, outDir: '.qa/realtime-heavy-seed-build',
  rollupOptions: { input: { seed: `${root}/apps/realtime-server/qa/heavy-seed.ts` }, output: { entryFileNames: '[name].js' } } } };
