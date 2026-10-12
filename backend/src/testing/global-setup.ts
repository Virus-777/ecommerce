/**
 * Runs once per test run: starts one in-memory MongoDB replica set (transactions need a replica set). Test apps take
 * databases of their own from it (testing/mongo.ts).
 */
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { TestProject } from 'vitest/node';
import { useInstalledMongod } from '../kernel/mongo/binary.js';

declare module 'vitest' {
  interface ProvidedContext {
    /** The run's in-memory MongoDB replica set (testing/mongo.ts) */
    mongoUri: string;
  }
}

export default async function setup(project: TestProject) {
  useInstalledMongod();
  const mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  project.provide('mongoUri', mongo.getUri());
  return async () => {
    await mongo.stop();
  };
}
