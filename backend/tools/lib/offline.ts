/**
 * Boot the real app for tools that only read its wiring (routes, OpenAPI, handlers): every module, on the embedded
 * MongoDB (no MONGODB_URI), without applying the schema.
 */
import { buildApp } from '../../src/app.js';
import { moduleNames } from '../../src/spec/index.js';

/** Every module in the spec, all launch phases */
export async function buildOfflineApp() {
  const app = await buildApp({ env: { NODE_ENV: 'test' }, modules: [...moduleNames], config: { launchPhase: 4, migrateOnStart: false } });
  await app.ready();
  return app;
}
