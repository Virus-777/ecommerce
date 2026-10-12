/**
 * Runs once per test run: migrates every module into one PGlite database and dumps it, so each test
 * app starts from an already-migrated copy instead of initialising and migrating its own.
 * Modules own separate schemas, so a test that boots a few modules is unaffected by the others' tables.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { useInstalledMongod } from '../kernel/mongo/binary.js';
import type { TestProject } from 'vitest/node';
import { createDatabase } from '../kernel/db/index.js';
import { migrate, migrationUnits } from '../kernel/migrations/index.js';
import { loadDefinitions, loadOrder } from '../kernel/module-system/loader.js';
import { moduleLoaders } from '../modules/index.js';

declare module 'vitest' {
  interface ProvidedContext {
    pgliteDump: string;
    /** The run's in-memory MongoDB replica set (testing/mongo.ts) */
    mongoUri: string;
  }
}

export default async function setup(project: TestProject) {
  // one replica set for the run (transactions need one); test apps take databases from it (testing/mongo.ts)
  useInstalledMongod();
  const mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  project.provide('mongoUri', mongo.getUri());
  const db = await createDatabase();
  await migrate(db, migrationUnits(await loadDefinitions(loadOrder(Object.keys(moduleLoaders)), moduleLoaders)));
  const dir = mkdtempSync(join(tmpdir(), 'marketly-test-'));
  const file = join(dir, 'migrated.tar');
  writeFileSync(file, Buffer.from(await (await db.dump!()).arrayBuffer()));
  await db.close();
  project.provide('pgliteDump', file);
  return async () => {
    rmSync(dir, { recursive: true, force: true });
    await mongo.stop();
  };
}
