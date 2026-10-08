/**
 * Boot the real app without a database, for tools that only read its wiring (routes, OpenAPI, handlers).
 */
import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler } from 'kysely';
import { buildApp } from '../../src/app.js';
import type { Database } from '../../src/kernel/db/index.js';
import { moduleNames } from '../../src/spec/index.js';

const offlineDatabase = (): Database => ({
  kind: 'postgres',
  kysely: new Kysely<any>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  }),
  exec: async () => {},
  close: async () => {},
});

/** Every module in the spec, all launch phases, no database. */
export async function buildOfflineApp() {
  const app = await buildApp({ env: { NODE_ENV: 'test' }, modules: [...moduleNames], database: offlineDatabase(), config: { launchPhase: 4, migrateOnStart: false } });
  await app.ready();
  return app;
}
