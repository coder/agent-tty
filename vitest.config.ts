import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup-node-options.ts', 'test/setup-state-home.ts'],
    watch: false,
  },
});
