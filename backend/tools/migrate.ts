#!/usr/bin/env tsx
/**
 * npm run migrate   apply pending migrations of the kernel and every enabled module to a
 *                   persistent database (DATABASE_URL for PostgreSQL, or PGLITE_DIR for local PGlite)
 */
import { loadConfig } from '../src/kernel/config/index.js';
import { createDatabase } from '../src/kernel/db/index.js';
import { migrate, migrationUnits } from '../src/kernel/migrations/index.js';
import { loadDefinitions } from '../src/kernel/module-system/loader.js';
import { enabledModules } from '../src/modules.config.js';
import { moduleLoaders } from '../src/modules/index.js';

const config = loadConfig();
if (!config.databaseUrl && !config.pgliteDir) {
  console.error('Set DATABASE_URL (PostgreSQL) or PGLITE_DIR (local PGlite folder) to migrate a persistent database.');
  process.exit(1);
}
const db = await createDatabase({ url: config.databaseUrl, pgliteDir: config.pgliteDir });
const defs = await loadDefinitions(config.modules ?? enabledModules, moduleLoaders);
const { applied } = await migrate(db, migrationUnits(defs), (m) => console.log(m));
console.log(applied.length ? `Applied ${applied.length} migration(s).` : 'Database is up to date.');
await db.close();
