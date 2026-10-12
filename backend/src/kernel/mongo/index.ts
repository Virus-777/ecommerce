/**
 * MongoDB through Mongoose (docs/04-mongodb-migration.md): one database, each module's collections named
 * `<module>.<table>` with the Mongoose schemas generated from the spec (src/modules/<m>/infra/mongo/schema.ts),
 * kernel collections `kernel.*` (kernel/mongo/schemas.ts). Production and staging connect to a replica set
 * (MONGODB_URI); development without MONGODB_URI and tests run an in-process replica set (mongodb-memory-server).
 *
 * Transactions need a replica set. `store.transaction(fn)` runs fn in a session transaction (snapshot reads,
 * majority writes) and runs it again when MongoDB reports a transient error (write conflict, failover), so:
 *   - fn only reads and writes the database: no events (publish after the commit), no provider calls;
 *   - operations inside one transaction run one after another (no Promise.all on the same session).
 */
import mongoose, { type Connection, type Model, type Schema } from 'mongoose';
import type { CollectionDef } from '../spec/define.js';
import { useInstalledMongod } from './binary.js';
import { kernelSchemas, type KernelCollection } from './schemas.js';
import { inTransaction } from './session.js';
import { Table } from './table.js';

export { inTransaction };
export type ClientSession = mongoose.mongo.ClientSession;
export type Db = mongoose.mongo.Db;

/** A module's Mongoose schemas: table → schema (generated) */
export type ModuleSchemas = Readonly<Record<string, Schema>>;

export interface MongoStore {
  readonly connection: Connection;
  /** The native database handle (index listings, collMod) */
  readonly db: Db;
  /** The model of a collection, compiled once per connection */
  model(collection: string, schema: Schema): Model<any>;
  /** A module's view: its own collections only (ctx.mongo) */
  module(name: string, collections: Readonly<Record<string, CollectionDef>>, schemas: ModuleSchemas): ModuleStore;
  /** Kernel collections (kernel.*) */
  kernel(name: KernelCollection): Model<any>;
  /** fn in a transaction, retried on transient errors; inside a transaction already, fn simply runs in it */
  transaction<T>(fn: (session: ClientSession) => Promise<T>, session?: ClientSession): Promise<T>;
  /** Next value of a named counter (identity columns, sequences); never rolled back: a number taken by an aborted transaction is skipped */
  nextValue(counter: string): Promise<number>;
  close(): Promise<void>;
}

const TX: mongoose.mongo.TransactionOptions = { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary' };

export function mongoStore(connection: Connection, onClose: () => Promise<void> = () => connection.close()): MongoStore {
  const store: MongoStore = {
    connection,
    get db() {
      return connection.db!;
    },
    model: (collection, schema) => connection.models[collection] ?? connection.model(collection, schema, collection),
    module: (name, collections, schemas) => new ModuleStore(store, name, collections, schemas),
    kernel: (name) => store.model(`kernel.${name}`, kernelSchemas[name]),
    async transaction<T>(fn: (session: ClientSession) => Promise<T>, outer?: ClientSession): Promise<T> {
      if (inTransaction(outer)) return fn(outer);
      const session = await connection.startSession();
      try {
        let result: T;
        await session.withTransaction(async (s) => {
          result = await fn(s);
        }, TX);
        return result!;
      } finally {
        await session.endSession();
      }
    },
    async nextValue(counter) {
      const r = await store.kernel('counters').findOneAndUpdate({ _id: counter }, { $inc: { value: 1 } }, { upsert: true, new: true, lean: true });
      return (r as unknown as { value: number }).value;
    },
    close: onClose,
  };
  return store;
}

export interface MongoOptions {
  /** mongodb://…/marketly?replicaSet=rs0; without it, development and tests start an embedded replica set */
  uri?: string;
  /** Database name (default: the one in the URI, else marketly) */
  dbName?: string;
  /** Embedded replica set only: keep the data in this folder between restarts */
  dataDir?: string;
}

/** Connects to MONGODB_URI, or (development, tests) starts an embedded single-node replica set. */
export async function connectMongo(o: MongoOptions): Promise<MongoStore> {
  if (o.uri) {
    const connection = await mongoose.createConnection(o.uri, { appName: 'marketly', ...(o.dbName ? { dbName: o.dbName } : dbNameOf(o.uri) ? {} : { dbName: 'marketly' }) }).asPromise();
    return mongoStore(connection);
  }
  useInstalledMongod();
  const { MongoMemoryReplSet } = await import('mongodb-memory-server');
  const set = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
    ...(o.dataDir ? { instanceOpts: [{ dbPath: o.dataDir, storageEngine: 'wiredTiger' as const }] } : {}),
  });
  const connection = await mongoose.createConnection(set.getUri(), { appName: 'marketly', dbName: o.dbName ?? 'marketly' }).asPromise();
  return mongoStore(connection, async () => {
    await connection.close();
    await set.stop({ doCleanup: !o.dataDir });
  });
}

const dbNameOf = (uri: string) => {
  try {
    return decodeURIComponent(new URL(uri).pathname.slice(1));
  } catch {
    return '';
  }
};

/**
 * A module's collections (ctx.mongo). Repositories hold one per transaction: `store.transaction(tx => …)` hands
 * fn a store bound to the session, whose tables run every operation in it.
 */
export class ModuleStore {
  readonly #tables = new Map<string, Table<any>>();

  constructor(
    readonly root: MongoStore,
    readonly module: string,
    readonly collections: Readonly<Record<string, CollectionDef>>,
    readonly schemas: ModuleSchemas,
    readonly session?: ClientSession,
  ) {}

  get inTransaction(): boolean {
    return inTransaction(this.session);
  }

  /** The collection of one of this module's spec tables, with row ↔ document conversion */
  table<R extends object>(name: string): Table<R> {
    let t = this.#tables.get(name);
    if (!t) {
      const def = this.collections[name];
      const schema = this.schemas[name];
      if (!def || !schema) throw new Error(`${this.module} has no table ${name} in its spec`);
      t = new Table<R>(this.root, this.root.model(`${this.module}.${name}`, schema), def, `${this.module}.${name}`, this.session);
      this.#tables.set(name, t);
    }
    return t as Table<R>;
  }

  /** fn with a store bound to a transaction (this one's, when already in one) */
  transaction<T>(fn: (tx: ModuleStore) => Promise<T>): Promise<T> {
    if (this.inTransaction) return fn(this);
    return this.root.transaction((session) => fn(new ModuleStore(this.root, this.module, this.collections, this.schemas, session)));
  }

  /**
   * Serialises transactions on a name: a second transaction locking the same
   * name conflicts and is retried after this one commits. Only inside a transaction.
   */
  async lock(name: string): Promise<void> {
    if (!this.inTransaction) throw new Error(`${this.module}: lock(${name}) outside a transaction`);
    await this.root.kernel('locks').updateOne({ _id: `${this.module}:${name}` }, { $inc: { n: 1 } }, { upsert: true, session: this.session });
  }

  /**
   * Inbox (kernel/events/inbox.ts): true the first time this module claims the key. Inside a transaction the claim
   * commits with the effects. An upsert, never a duplicate-key error (which would abort the transaction).
   */
  async claim(key: string): Promise<boolean> {
    const r = await this.root.kernel('processed_events').updateOne({ _id: `${this.module}:${key}` }, { $setOnInsert: { module: this.module, key, at: new Date() } }, { upsert: true, session: this.session });
    return r.upsertedCount === 1;
  }

  /** Whether the key was already claimed (read-only) */
  async seen(key: string): Promise<boolean> {
    return Boolean(await this.root.kernel('processed_events').exists({ _id: `${this.module}:${key}` }).session(this.session ?? null));
  }

  /** Next value of this module's counter (sequences) */
  nextValue(counter: string): Promise<number> {
    return this.root.nextValue(`${this.module}.${counter}`);
  }
}

export { Table } from './table.js';
export type { Filter, Sort, UpdateSpec } from './table.js';
