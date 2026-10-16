#!/usr/bin/env tsx
/**
 * npm run migrate   apply the MongoDB schema (MONGODB_URI) of the kernel and every enabled module: collections,
 *                   validators and indexes, then pending data migrations. Production runs this before the servers
 *                   start (MIGRATE_ON_START is off there).
 */
import { loadConfig } from '../src/kernel/config/index.js';
import { connectMongo } from '../src/kernel/mongo/index.js';
import { migrateMongo, mongoUnits } from '../src/kernel/mongo/schema.js';
import { loadDefinitions } from '../src/kernel/module-system/loader.js';
import { enabledModules } from '../src/modules.config.js';
import { moduleLoaders } from '../src/modules/index.js';

const config = loadConfig();
if (!config.mongo.uri) {
  console.error('Set MONGODB_URI (a MongoDB replica set) to migrate a persistent database.');
  process.exit(1);
}
// independent: the module imports and the connection (as buildApp does)
const [defs, mongo] = await Promise.all([loadDefinitions(config.modules ?? enabledModules, moduleLoaders), connectMongo({ uri: config.mongo.uri })]);
try {
  const applied = await migrateMongo(mongo, mongoUnits(defs), (m) => console.log(m));
  console.log(applied.length ? `MongoDB: applied ${applied.join(', ')}.` : 'MongoDB is up to date.');
} finally {
  await mongo.close();
}
