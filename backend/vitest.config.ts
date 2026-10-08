import { createRequire } from 'node:module';
import { defineConfig } from 'vitest/config';

const require = createRequire(import.meta.url);

export default defineConfig({
  // graphql 16 ships an ESM build that Vite would pick, while Mercurius requires the CommonJS one;
  // graphql-js refuses schemas from another copy, so tests use the same file as Node does
  resolve: { alias: [{ find: /^graphql$/, replacement: require.resolve('graphql') }] },
  test: {
    include: ['src/**/*.test.ts', 'tools/**/*.test.ts'],
    globalSetup: ['src/testing/global-setup.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 120_000,
    env: { NODE_ENV: 'test' },
  },
});
