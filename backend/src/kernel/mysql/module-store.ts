/**
 * A module's view of the database (`ctx.mysql`), the counterpart of the `ModuleStore` in kernel/mongo/index.ts
 * (docs/10-mysql-migration.md §10.1, §10.6). It hands out this module's tables, its Kysely handle, and the four
 * kernel services a module uses: `transaction`, `lock`, `claim`/`seen` and the counters.
 *
 * It is the boundary. `tables` holds only this module's tables, so `table('orders')` from another module throws
 * and `db.selectFrom('orders_orders')` from another module does not compile — the generated `<Module>Tables`
 * type is what `DB` is filled in with. `check:boundaries` covers what types cannot: a `sql` string naming
 * another module's table, and any use of a `kernel_` table outside this file.
 *
 * A repository holds one of these per transaction: `store.transaction(tx => …)` hands fn a store whose tables
 * and whose `db` all run on that transaction's connection.
 */
import { Kysely, MysqlDialect } from 'kysely';
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { TableDef } from '../spec/define.js';
import { isDuplicateKey } from './errors.js';
import { Table, type TableContext } from './table.js';
import type { MysqlStore, Tx } from './index.js';

/** The tables of one module, as the generator writes them: spec name → its MySQL table */
export type ModuleTables = Readonly<Record<string, TableDef>>;

/**
 * Kysely wants mysql2's **callback** pool, and mysql2/promise keeps it one level down: a promise `Pool` holds
 * the real one as `.pool`, and a promise `PoolConnection` holds its own as `.connection`. Neither is in the
 * published types, so the two reach-throughs live here, named, instead of being spread through the file.
 */
const corePool = (pool: Pool) => (pool as unknown as { pool: unknown }).pool;
const coreConnection = (conn: PoolConnection) => (conn as unknown as { connection: CoreConnection }).connection;

interface CoreConnection {
  config: object;
  threadId: number;
  query(sql: string, parameters: unknown, callback?: unknown): unknown;
}

/**
 * A pool of exactly one connection — the transaction's — so a Kysely built on it runs inside that transaction
 * rather than taking a second connection and seeing none of its uncommitted work.
 *
 * `release` is deliberately nothing: the connection belongs to the transaction and goes back to the real pool
 * when the transaction ends, not when Kysely finishes a statement. For the same reason `end` closes nothing.
 * Only the handful of members Kysely's `MysqlPoolConnection` asks for are passed on; handing it the connection
 * itself would let it release ours, and wrapping it in a prototype or a clone breaks mysql2's internals.
 */
function pinnedPool(conn: PoolConnection) {
  const core = coreConnection(conn);
  return {
    getConnection(cb: (error: unknown, connection: unknown) => void) {
      cb(null, {
        config: core.config,
        threadId: core.threadId,
        connect: (done?: (error: unknown) => void) => done?.(null),
        destroy: () => undefined,
        release: () => undefined,
        query: (sql: string, parameters: unknown, done?: unknown) => core.query(sql, parameters, done),
      });
    },
    end(cb: (error: unknown) => void) {
      cb(null);
    },
  };
}

export class ModuleStore<DB = Record<string, never>> {
  readonly #tables = new Map<string, Table<never>>();
  #db: Kysely<DB> | undefined;

  constructor(
    readonly root: MysqlStore,
    readonly module: string,
    readonly tables: ModuleTables,
    readonly tx?: Tx,
  ) {}

  get inTransaction(): boolean {
    return Boolean(this.tx);
  }

  /** The connection a statement runs on: the transaction's, or the pool */
  get #conn(): Pool | PoolConnection {
    return this.tx?.conn ?? this.root.pool;
  }

  /** One of this module's tables, with row ↔ column conversion from the generated def */
  table<R extends object>(name: string): Table<R> {
    let t = this.#tables.get(name);
    if (!t) {
      const def = this.tables[name];
      if (!def) throw new Error(`${this.module} has no table ${name} in its spec`);
      t = new Table<R>(this.#tableContext(), def) as Table<never>;
      this.#tables.set(name, t);
    }
    return t as unknown as Table<R>;
  }

  #tableContext(): TableContext {
    return {
      conn: this.#conn,
      inTransaction: this.inTransaction,
      transaction: <T>(fn: (conn: PoolConnection) => Promise<T>) =>
        this.tx ? fn(this.tx.conn) : this.root.transaction((tx) => fn(tx.conn), undefined, this.module),
    };
  }

  /**
   * Kysely over this module's tables, for the reads `Where` has no shape for: joins, aggregates, JSON paths,
   * window functions (§10.5). Inside a transaction it runs on that transaction's connection.
   *
   * It is never destroyed: the pool is the store's, and `db.destroy()` would end it for everyone.
   */
  get db(): Kysely<DB> {
    this.#db ??= new Kysely<DB>({
      dialect: new MysqlDialect({ pool: (this.tx ? pinnedPool(this.tx.conn) : corePool(this.root.pool)) as never }),
    });
    return this.#db;
  }

  /** fn with a store bound to a transaction — this one, when already inside it */
  transaction<T>(fn: (tx: ModuleStore<DB>) => Promise<T>): Promise<T> {
    if (this.tx) return fn(this);
    return this.root.transaction((tx) => fn(new ModuleStore<DB>(this.root, this.module, this.tables, tx)), undefined, this.module);
  }

  async #run(sql: string, params: readonly unknown[]): Promise<ResultSetHeader> {
    const [res] = await this.#conn.query<ResultSetHeader>(sql, [...params]);
    return res;
  }

  /**
   * Serialises transactions on a name: a second transaction locking the same name waits here until this one
   * commits. The row is written rather than read, because only a write takes a lock that lasts that long —
   * an unlocked read would let both sides through, which is the whole failure this guards against.
   *
   * It must be inside a transaction. Outside one the statement commits immediately and the lock is gone before
   * the caller does anything with it, so that is an error rather than a lock that silently does nothing.
   */
  async lock(name: string): Promise<void> {
    if (!this.tx) throw new Error(`${this.module}: lock(${name}) outside a transaction`);
    await this.#run(
      'INSERT INTO `kernel_locks` (`name`, `n`) VALUES (?, 1) AS new ON DUPLICATE KEY UPDATE `n` = `kernel_locks`.`n` + 1',
      [`${this.module}:${name}`],
    );
  }

  /**
   * Inbox for event consumers that must be idempotent: true the first time this module claims the key (the
   * event id, or a natural key such as `order-placed:<orderId>`). Inside a transaction the claim commits with
   * the effects, so a redelivered event changes nothing and a failed attempt leaves the key free for the retry.
   *
   * An INSERT that catches the duplicate. On MongoDB that was forbidden — a duplicate key aborted the whole
   * transaction, so this had to be an upsert — and on InnoDB it is the plain way to write it (§25).
   */
  async claim(key: string): Promise<boolean> {
    try {
      await this.#run('INSERT INTO `kernel_processed_events` (`module`, `key`, `at`) VALUES (?, ?, ?)', [this.module, key, new Date()]);
      return true;
    } catch (err) {
      if (isDuplicateKey(err)) return false;
      throw err;
    }
  }

  /** Whether the key was already claimed, without claiming it */
  async seen(key: string): Promise<boolean> {
    const [rows] = await this.#conn.query<RowDataPacket[]>('SELECT 1 FROM `kernel_processed_events` WHERE `module` = ? AND `key` = ? LIMIT 1', [this.module, key]);
    return rows.length > 0;
  }

  /** Next value of one of this module's counters (reference numbers, sequences) */
  nextValue(counter: string): Promise<number> {
    return this.root.nextValue(`${this.module}.${counter}`);
  }

  /** The next n values in order, taken in one update (numbering a batch of rows) */
  nextValues(counter: string, n: number): Promise<number[]> {
    return this.root.nextValues(`${this.module}.${counter}`, n);
  }
}
