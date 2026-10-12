/**
 * MongoDB for tests: global-setup.ts starts one in-memory replica set per run (mongodb-memory-server); every test app
 * gets a database of its own from a pool in its process (one Mongoose connection, a useDb connection per database,
 * which keeps its compiled models). Closing the app empties the database (documents only: collections, validators,
 * indexes and the schema hashes in kernel.migrations stay) and returns it to the pool, so the next app skips
 * creating collections and indexes it already has.
 */
import mongoose, { type Connection } from 'mongoose';
import { inject } from 'vitest';
import { mongoStore, type MongoStore } from '../kernel/mongo/index.js';

let base: Promise<Connection> | undefined;
const free: string[] = [];
let made = 0;

const baseConnection = () => (base ??= mongoose.createConnection(inject('mongoUri'), { appName: 'marketly-tests', maxPoolSize: 50 }).asPromise());

/** A store on a database of its own; close() empties it for the next test app */
export async function testMongo(): Promise<MongoStore> {
  const name = free.pop() ?? `t${process.pid}_${++made}`;
  const connection = (await baseConnection()).useDb(name, { useCache: true });
  return mongoStore(connection, async () => {
    const db = connection.db!;
    const collections = await db.listCollections({}, { nameOnly: true }).toArray();
    for (const { name: coll } of collections) if (coll !== 'kernel.migrations') await db.collection(coll).deleteMany({});
    free.push(name);
  });
}
