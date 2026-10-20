/**
 * MongoDB for tests: global-setup.ts starts one in-memory replica set per run (mongodb-memory-server); every test app
 * gets a database of its own (one Mongoose connection per process, a useDb connection per database).
 *
 * Creating every module's collections and indexes takes seconds, so databases are reused: they are named after the
 * vitest worker slot (VITEST_POOL_ID), which runs one test file at a time, so the next file in the same slot finds
 * its collections, indexes and schema hashes (kernel.migrations) already there. A database is emptied (documents
 * only) when an app takes it and when the app closes.
 */
import mongoose, { type Connection } from 'mongoose';
import { inject } from 'vitest';
import { mongoStore, type Db, type MongoStore } from '../kernel/mongo/index.js';

let base: Promise<Connection> | undefined;
const free: string[] = [];
let made = 0;

const baseConnection = () => (base ??= mongoose.createConnection(inject('mongoUri'), { appName: 'marketly-tests', maxPoolSize: 50 }).asPromise());

/**
 * Deletes the documents of every collection that has any (all at once). Schema hashes stay; data migrations are
 * forgotten, so the next app runs them again on the empty database (a seed migration such as content's news
 * categories would otherwise count as done with its data gone).
 */
async function empty(db: Db) {
  const collections = await db.listCollections({}, { nameOnly: true }).toArray();
  await Promise.all([
    ...collections
      .filter((c) => c.name !== 'kernel.migrations')
      .map(async ({ name }) => {
        const c = db.collection(name);
        if (await c.estimatedDocumentCount()) await c.deleteMany({});
      }),
    db.collection<{ _id: string }>('kernel.migrations').deleteMany({ _id: { $not: /\/schema$/ } }),
  ]);
}

/** A store on a database of its own; close() empties it for the next test app */
export async function testMongo(): Promise<MongoStore> {
  const name = free.pop() ?? `t${process.env.VITEST_POOL_ID ?? process.pid}_${++made}`;
  const connection = (await baseConnection()).useDb(name, { useCache: true });
  // a database this process did not use yet may hold what an earlier test file in this slot left behind
  await empty(connection.db!);
  return mongoStore(connection, async () => {
    await empty(connection.db!);
    free.push(name);
  });
}
