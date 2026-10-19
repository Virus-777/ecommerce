// Benchmarks (npm run bench:search): *.bench.ts files, never part of `npm test`. Same in-memory MongoDB as the tests.
import { mergeConfig } from 'vitest/config';
import base from './vitest.config.js';

export default mergeConfig(base, {
  test: {
    include: ['src/**/*.bench.ts'],
    testTimeout: 3_600_000,
    hookTimeout: 3_600_000,
    maxWorkers: 1,
  },
});
