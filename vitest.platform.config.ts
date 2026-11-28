import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['games/shift/**/*.test.ts', 'games/district/**/*.test.ts', 'apps/platform/**/*.test.ts', 'apps/portal/src/**/*.test.ts', 'packages/session-kit/**/*.test.ts', 'packages/telegram-transport/**/*.test.ts'],
    testTimeout: 15_000,
  },
});
