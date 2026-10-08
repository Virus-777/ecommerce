/**
 * graphql-js must be one instance across the kernel and Mercurius (it checks schemas with instanceof).
 * Mercurius loads the CommonJS build, so the kernel loads the same one, whatever the bundler or test
 * runner would pick for an ESM import.
 */
import { createRequire } from 'node:module';

export const graphql = createRequire(import.meta.url)('graphql') as typeof import('graphql');
