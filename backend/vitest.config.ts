import { createRequire } from 'node:module';
import { availableParallelism } from 'node:os';
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
    // integration suites set up whole flows (staff, sellers, listings, checkouts) in beforeAll
    hookTimeout: 300_000,
    // every test file boots whole apps on the one in-memory MongoDB replica set; too many at once starve each other
    // (flaky timeouts)
    maxWorkers: Math.max(2, Math.min(12, availableParallelism() - 1)),
    env: { NODE_ENV: 'test' },
  },
});
