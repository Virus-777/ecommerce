/**
 * Runs once per test run: starts one in-memory MongoDB replica set (transactions need a replica set). Test apps take
 * databases of their own from it (testing/mongo.ts).
 *
 * TEST_MONGODB_URI runs the tests on a real server instead (a replica set, e.g.
 * mongodb://127.0.0.1:27017/?replicaSet=rs0). The tests then create databases named t<slot>_<n> on it and drop them
 * at the end; never point it at a server whose databases could have such names. MONGODB_URI is never used here, so
 * tests cannot touch the development database.
 */
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { TestProject } from 'vitest/node';
import { useInstalledMongod } from '../kernel/mongo/binary.js';

declare module 'vitest' {
  interface ProvidedContext {
    /** The run's MongoDB replica set (testing/mongo.ts) */
    mongoUri: string;
  }
}

/** The databases testing/mongo.ts creates */
const TEST_DATABASE = /^t\d+_\d+$/;

export default async function setup(project: TestProject) {
  const real = process.env.TEST_MONGODB_URI;
  if (real) {
    project.provide('mongoUri', real);
    return async () => {
      const conn = await mongoose.createConnection(real).asPromise();
      const { databases } = await conn.db!.admin().listDatabases({ nameOnly: true });
      for (const d of databases) if (TEST_DATABASE.test(d.name)) await conn.useDb(d.name).dropDatabase();
      await conn.close();
    };
  }
  useInstalledMongod();
  const mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  project.provide('mongoUri', mongo.getUri());
  return async () => {
    await mongo.stop();
  };
}
