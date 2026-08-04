import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/console/**/*.test.ts'],
    testTimeout: 5_000
  }
});
