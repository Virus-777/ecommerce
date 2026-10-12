#!/usr/bin/env tsx
/**
 * npm run migrate   apply pending migrations of the kernel and every enabled module to persistent databases:
 *                   MongoDB (MONGODB_URI): kernel collections and every module's collections, validators and
 *                   indexes, then the data migrations of the modules on MongoDB; PostgreSQL (DATABASE_URL, or PGLITE_DIR) for the
 *                   modules not moved yet (docs/04-mongodb-migration.md)
 */
import { loadConfig } from '../src/kernel/config/index.js';
import { createDatabase } from '../src/kernel/db/index.js';
import { migrate, migrationUnits } from '../src/kernel/migrations/index.js';
import { connectMongo } from '../src/kernel/mongo/index.js';
import { migrateMongo } from '../src/kernel/mongo/schema.js';
import { loadDefinitions } from '../src/kernel/module-system/loader.js';
import { enabledModules } from '../src/modules.config.js';
import { moduleLoaders } from '../src/modules/index.js';

const config = loadConfig();
const defs = await loadDefinitions(config.modules ?? enabledModules, moduleLoaders);
const onPostgres = defs.filter((d) => d.store !== 'mongo');

if (!config.mongo.uri) {
  console.error('Set MONGODB_URI (a MongoDB replica set) to migrate a persistent database.');
  process.exit(1);
}
const mongo = await connectMongo({ uri: config.mongo.uri });
const applied = await migrateMongo(
  mongo,
  // every module's collections, validators and indexes; data migrations only for the modules already on MongoDB
  defs.map((d) => ({ module: d.spec.name, collections: d.spec.collections, schemas: d.schemas ?? {}, migrations: d.store === 'mongo' ? d.mongoMigrations : [] })),
  (m) => console.log(m),
);
console.log(applied.length ? `MongoDB: applied ${applied.join(', ')}.` : 'MongoDB is up to date.');
await mongo.close();

if (onPostgres.length) {
  if (!config.databaseUrl && !config.pgliteDir) {
    console.error(`Set DATABASE_URL (PostgreSQL) or PGLITE_DIR for the modules still on PostgreSQL: ${onPostgres.map((d) => d.spec.name).join(', ')}.`);
    process.exit(1);
  }
  const db = await createDatabase({ url: config.databaseUrl, pgliteDir: config.pgliteDir });
  const { applied: pg } = await migrate(db, migrationUnits(onPostgres), (m) => console.log(m));
  console.log(pg.length ? `PostgreSQL: applied ${pg.length} migration(s).` : 'PostgreSQL is up to date.');
  await db.close();
  if (config.jobsBackend === 'pgboss' && config.databaseUrl) {
    // the job queue's own tables (schema pgboss), versioned by pg-boss
    const { migrateJobQueue } = await import('../src/kernel/jobs/pgboss.js');
    await migrateJobQueue(config.databaseUrl);
    console.log('Job queue (pg-boss) is up to date.');
  }
}
