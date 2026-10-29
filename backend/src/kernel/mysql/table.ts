/**
 * One spec table as a MySQL table, for repositories (docs/10-mysql-migration.md §10.4). The method names are the
 * ones `kernel/mongo/table.ts` has today, so a repository keeps its shape when it moves across; what changes is
 * the filter, which is now the typed `Where<R>` of ./where.ts instead of a MongoDB filter document.
 *
 *   const t = store.table<RoleRow>('roles');
 *   await t.get(id, { forUpdate: true });                  // in a transaction: SELECT … FOR UPDATE
 *   await t.find({ status: ['active'] }, { sort: { created_at: -1 }, limit: 50 });
 *   await t.insert(row); await t.update(id, { name }); await t.page(f, req, { column: 'created_at', direction: 'desc' });
 *
 * Three things are deliberately different from the MongoDB version, and each is a rule rather than a detail:
 *
 *  - **A write that must be read back runs in a transaction.** MongoDB's `findOneAndUpdate` returned the new
 *    document in one round trip; MySQL's UPDATE returns a count. So `updateOne`, `upsert` and `increment` lock
 *    the row, write it and read it on the same connection, inside a transaction (the caller's, when there is
 *    one). Without that the row read back could be someone else's write.
 *  - **A duplicate key costs the statement, not the transaction.** MongoDB aborted the whole transaction on a
 *    duplicate key, which is why `insertIfAbsent` had to check every unique index first. InnoDB fails only the
 *    INSERT, so `insertIfAbsent` is simply an insert that catches 1062 — no pre-reads, and no race between the
 *    check and the write.
 *  - **Nothing is locked by reading.** MongoDB aborted the second writer of a document, so a read-then-write
 *    without a lock was still safe. InnoDB makes the second writer wait and then overwrite, so a value read and
 *    written back must be read with `forUpdate`, or changed with an expression (`inc`) that the server applies
 *    (§11.2).
 */
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { decodeCursor, encodeCursor, type KeysetOrder, type PageRequest } from '../lib/pagination.js';
import type { Page } from '../../spec/common.js';
import type { TableDef, UniqueKeyDef } from '../spec/define.js';
import { detecting, keysFromWhere, lockedByWrite, readRows, rowKey, writingRows } from './detect.js';
import { duplicateKeyName, isDuplicateKey } from './errors.js';
import { q, raw, whereSql, type Sql, type WhereOptions, type WhereWithOr } from './where.js';

export { q, raw };
export type { Sql, WhereWithOr };
export type { Cond, Where } from './where.js';

/** Sort order, as today: 1 ascending, -1 descending */
export type Sort = Record<string, 1 | -1>;

/** Rows per INSERT statement (§10.4): large enough to be one round trip, small enough to stay under max_allowed_packet */
export const INSERT_CHUNK = 500;

/* ------------------------------------------------------------------ expressions in a patch */

/**
 * A value in a patch that the **server** computes, rather than one this process worked out and sends. Used
 * through the helpers below: `t.update(id, { tries: inc('tries', 1) })`.
 *
 * Its SQL is a function of the table's name, and that is not decoration. An `INSERT … ON DUPLICATE KEY UPDATE`
 * brings the row being inserted into scope under an alias, so a bare `n` in `n = n + ?` is **ambiguous** —
 * MySQL refuses the statement rather than guessing, which is how `increment` was caught. Writing the table's
 * name makes every expression mean the stored row, in an UPDATE and in an upsert alike.
 *
 * The brand is a symbol so that a JSON column holding `{ sql, params }` can never be mistaken for one.
 */
const EXPRESSION = Symbol('sql expression');

/**
 * What a portable expression *means*, apart from the SQL it compiles to. `inc`, `decToZero` and `jsonAppend`
 * all had a MongoDB spelling (`$inc`, a `$max(x - n, 0)` pipeline, `$push`), so a repository that uses only
 * those runs on either store (kernel/store). A hand-written `expr` has no intent and is MySQL-only, which is
 * what lets the MongoDB side refuse it by name instead of writing something that does not mean the same.
 */
export type Intent =
  | { readonly kind: 'inc'; readonly column: string; readonly n: number }
  | { readonly kind: 'decToZero'; readonly column: string; readonly n: number }
  | { readonly kind: 'jsonAppend'; readonly column: string; readonly value: unknown };

export interface Expr {
  readonly [EXPRESSION]: true;
  /** `table` is the quoted table name, e.g. \`orders_orders\` */
  sql(table: string): string;
  readonly params: readonly unknown[];
  /** Set by the portable helpers below; absent on a hand-written `expr` */
  readonly intent?: Intent;
}

/**
 * An expression with bound parameters. Give it a function to name the table it reads from:
 * `expr((t) => \`LEAST(\${t}.\${q('cap')}, ?)\`, [n])`. The SQL text never holds a value (§10.5).
 */
export const expr = (sql: string | ((table: string) => string), params: readonly unknown[] = [], intent?: Intent): Expr => ({
  [EXPRESSION]: true,
  sql: typeof sql === 'function' ? sql : () => sql,
  params: [...params],
  ...(intent ? { intent } : {}),
});

export const isExpr = (v: unknown): v is Expr => typeof v === 'object' && v !== null && EXPRESSION in v;

/** `col = col + n` — what `$inc` was. The server adds, so two callers at once both count (§11.2) */
export const inc = (column: string, n: number): Expr => expr((t) => `${t}.${q(column)} + ?`, [n], { kind: 'inc', column, n });

/** `col = GREATEST(col - n, 0)`: take n away without going below zero (the `$max(x - n, 0)` pipelines) */
export const decToZero = (column: string, n: number): Expr => expr((t) => `GREATEST(${t}.${q(column)} - ?, 0)`, [n], { kind: 'decToZero', column, n });

/** Appends to a JSON array column, as `$push` did */
export const jsonAppend = (column: string, value: unknown): Expr =>
  expr((t) => `JSON_ARRAY_APPEND(${t}.${q(column)}, '$', CAST(? AS JSON))`, [JSON.stringify(value)], { kind: 'jsonAppend', column, value });

/** A patch: a value per column, or an expression the server computes */
export type Patch<R> = { [K in keyof R]?: R[K] | Expr };

/* ------------------------------------------------------------------ options */

export interface ReadOptions {
  /** An extra condition for what `Where` cannot say (`used + ? <= cap`, a JSON path, a function call) */
  and?: Sql;
}

export interface FindOptions extends ReadOptions {
  sort?: Sort;
  limit?: number;
  offset?: number;
  /**
   * Inside a transaction: `FOR UPDATE`, locking every matching row until it commits. With no `sort`, the rows
   * are locked in primary key order, because two transactions that lock the same rows in different orders
   * deadlock (§11.2).
   */
  forUpdate?: boolean;
  /** Sort columns whose nulls come after every value: `ORDER BY col IS NULL, col` (MySQL sorts null lowest) */
  nullsLast?: readonly string[];
}

/** What `pageQuery` reads: a fragment of our own, or a Kysely query's `compile()`, which names its values `parameters` */
export type Compiled = Sql | { readonly sql: string; readonly parameters: readonly unknown[] };

/** The order of `pageQuery`: a value the query computes (or a column), then the primary key */
export interface ComputedOrder {
  key: string;
  direction: 'asc' | 'desc';
}

/**
 * How a table reaches the server: the transaction's connection, or the pool when there is no transaction.
 * `transaction` is how a write that must be read back gets one connection to itself.
 */
export interface TableContext {
  readonly conn: Pool | PoolConnection;
  readonly inTransaction: boolean;
  /** fn in a transaction — this one, when already inside it */
  transaction<T>(fn: (conn: PoolConnection) => Promise<T>): Promise<T>;
}

/* ------------------------------------------------------------------ the table */

const sameColumns = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

/** A positive whole number for LIMIT/OFFSET, which are written into the SQL rather than bound */
function whole(n: number, what: string): number {
  if (!Number.isInteger(n) || n < 0) throw new Error(`${what} must be a whole number, got ${n}`);
  return n;
}

export class Table<R extends object> {
  readonly #columnList: string;
  readonly #decimal: Set<string>;
  readonly #binary: Set<string>;
  readonly #json: Set<string>;
  readonly #nullable: Set<string>;
  readonly #whereOptions: WhereOptions;
  readonly #booleans: Set<string>;

  constructor(
    readonly ctx: TableContext,
    readonly def: TableDef,
  ) {
    this.#columnList = def.columns.map(q).join(', ');
    this.#decimal = new Set(def.decimal);
    this.#binary = new Set(def.binary);
    this.#json = new Set(def.json);
    this.#nullable = new Set(def.nullable);
    // a JSON column that cannot be null holds `null` as a JSON document, so a filter asking for null asks of
    // the document and not of SQL NULL — which is the only reading that agrees with MongoDB (#param)
    this.#whereOptions = { jsonNotNull: new Set(def.json.filter((c) => !this.#nullable.has(c))), json: this.#json };
    this.#booleans = new Set(def.booleans);
  }

  get name(): string {
    return this.def.table;
  }

  /** The same table bound to one connection (inside `ctx.transaction`) */
  #on(conn: PoolConnection): Table<R> {
    return new Table<R>({ conn, inTransaction: true, transaction: (fn) => fn(conn) }, this.def);
  }

  /* ---------------------------------------------------------------- running statements */

  async #rows(sql: string, params: readonly unknown[] = []): Promise<RowDataPacket[]> {
    const [rows] = await this.ctx.conn.query<RowDataPacket[]>(sql, [...params]);
    return rows;
  }

  async #run(sql: string, params: readonly unknown[] = []): Promise<ResultSetHeader> {
    const [res] = await this.ctx.conn.query<ResultSetHeader>(sql, [...params]);
    return res;
  }

  /* ---------------------------------------------------------------- conversion */

  /** One stored value as the row type reads it: the types mysql2 cannot know from the value alone */
  #value(column: string, v: unknown): unknown {
    if (v === null || v === undefined) return null;
    if (this.#binary.has(column)) return v instanceof Uint8Array ? new Uint8Array(v) : v;
    if (this.#booleans.has(column)) return typeof v === 'boolean' ? v : Boolean(Number(v));
    if (this.#decimal.has(column)) return String(v);
    return v;
  }

  /** A stored row as the row type: the types mysql2 cannot know from the value alone, and nulls for what is missing */
  fromRow(raw: Record<string, unknown>): R {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw)) out[k] = this.#value(k, v);
    for (const c of this.def.nullable) if (out[c] === undefined) out[c] = null;
    return out as R;
  }

  /** One value as a bound parameter: JSON is text on the way in, and a numeric keeps its exact digits */
  #param(column: string, value: unknown): unknown {
    // A JSON column that cannot be null still holds `null`, the JSON value: a setting declared with no default,
    // or whose value is "no cap", is null, and that is a JSON document like any other (PostgreSQL's
    // `'null'::jsonb`). Only a *nullable* JSON column takes SQL NULL. MongoDB has one null for both and so
    // never had to tell them apart, which is why this shows up on the first module to move.
    if (value === null || value === undefined) return this.#json.has(column) && !this.#nullable.has(column) ? 'null' : null;
    // mysql2 turns an array into a value list and an object into `key = value` pairs, neither of which is JSON
    if (this.#json.has(column)) return JSON.stringify(value);
    if (this.#binary.has(column) && value instanceof Uint8Array && !Buffer.isBuffer(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    if (this.#decimal.has(column)) return String(value);
    return value;
  }

  /** A row with its nullable columns filled in and its values in the shape they are stored in */
  #fullRow(row: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const c of this.def.columns) {
      const v = row[c];
      if (v === undefined) continue;
      out[c] = v === null ? null : this.#decimal.has(c) ? String(v) : this.#binary.has(c) && v instanceof Uint8Array ? new Uint8Array(v) : v;
    }
    for (const c of this.def.nullable) if (out[c] === undefined) out[c] = null;
    const unknownColumns = Object.keys(row).filter((k) => !this.def.columns.includes(k));
    if (unknownColumns.length) throw new Error(`${this.name} has no column ${unknownColumns.join(', ')}`);
    return out;
  }

  /** A where, an optional extra condition, as `WHERE …` (or '' when nothing is filtered) */
  #where(where: WhereWithOr<R> | undefined, o: ReadOptions = {}, extra: readonly Sql[] = []): Sql {
    const parts = [whereSql(where, this.#whereOptions), ...(o.and ? [o.and] : []), ...extra].filter((p) => p.sql !== '1 = 1');
    if (!parts.length) return { sql: '', params: [] };
    return { sql: `WHERE ${parts.map((p) => `(${p.sql})`).join(' AND ')}`, params: parts.flatMap((p) => p.params) };
  }

  #orderBy(sort: Sort | undefined, nullsLast: readonly string[] = []): string {
    const missing = nullsLast.filter((c) => !(c in (sort ?? {})));
    if (missing.length) throw new Error(`${this.name}: nullsLast names ${missing.join(', ')}, which the sort does not`);
    if (!sort || !Object.keys(sort).length) return '';
    const parts = Object.entries(sort).flatMap(([column, dir]) => [
      ...(nullsLast.includes(column) ? [`${q(column)} IS NULL`] : []),
      `${q(column)} ${dir === -1 ? 'DESC' : 'ASC'}`,
    ]);
    return ` ORDER BY ${parts.join(', ')}`;
  }

  #limit(o: { limit?: number; offset?: number }): string {
    if (o.limit === undefined && !o.offset) return '';
    const limit = o.limit === undefined ? Number.MAX_SAFE_INTEGER : whole(o.limit, 'limit');
    return o.offset ? ` LIMIT ${limit} OFFSET ${whole(o.offset, 'offset')}` : ` LIMIT ${limit}`;
  }

  /* ---------------------------------------------------------------- reads */

  /** One row by primary key; `forUpdate` inside a transaction locks it until the transaction ends */
  async get(id: unknown, o: { forUpdate?: boolean } = {}): Promise<R | undefined> {
    return this.findOne({ [this.#idColumn('get')]: id } as WhereWithOr<R>, o);
  }

  async findOne(where: WhereWithOr<R>, o: { sort?: Sort; forUpdate?: boolean } & ReadOptions = {}): Promise<R | undefined> {
    const [row] = await this.find(where, { ...o, limit: 1 });
    return row;
  }

  async find(where: WhereWithOr<R> = {}, o: FindOptions = {}): Promise<R[]> {
    const w = this.#where(where, o);
    // §11.2: locking rows in a fixed order is what stops two transactions deadlocking over the same set
    const sort = o.sort ?? (o.forUpdate && this.ctx.inTransaction ? Object.fromEntries(this.def.key.map((c) => [c, 1 as const])) : undefined);
    const forUpdate = o.forUpdate && this.ctx.inTransaction ? ' FOR UPDATE' : '';
    const sql = `SELECT ${this.#columnList} FROM ${q(this.name)} ${w.sql}${this.#orderBy(sort, o.nullsLast)}${this.#limit(o)}${forUpdate}`;
    const rows = (await this.#rows(sql, w.params)).map((r) => this.fromRow(r));
    // §11.2 rule 2: a row read here without a lock is one a write later in this transaction could be losing
    if (detecting() && this.ctx.inTransaction)
      readRows(
        this.ctx.conn,
        rows.map((r) => this.#rowKey(r)),
        Boolean(forUpdate),
      );
    return rows;
  }

  /** Rows whose primary key is one of `ids` (none for an empty list) */
  async getMany(ids: readonly unknown[], o: { forUpdate?: boolean; sort?: Sort } = {}): Promise<R[]> {
    if (!ids.length) return [];
    return this.find({ [this.#idColumn('getMany')]: [...ids] } as WhereWithOr<R>, o);
  }

  async count(where: WhereWithOr<R> = {}, o: ReadOptions = {}): Promise<number> {
    const w = this.#where(where, o);
    const rows = await this.#rows(`SELECT COUNT(*) AS n FROM ${q(this.name)} ${w.sql}`, w.params);
    return Number(rows[0]?.n ?? 0);
  }

  async exists(where: WhereWithOr<R>, o: ReadOptions = {}): Promise<boolean> {
    const w = this.#where(where, o);
    return (await this.#rows(`SELECT 1 FROM ${q(this.name)} ${w.sql} LIMIT 1`, w.params)).length > 0;
  }

  async distinct<T = unknown>(column: string, where: WhereWithOr<R> = {}, o: ReadOptions = {}): Promise<T[]> {
    const w = this.#where(where, o);
    const rows = await this.#rows(`SELECT DISTINCT ${q(column)} AS v FROM ${q(this.name)} ${w.sql}`, w.params);
    return rows.map((r) => (this.#decimal.has(column) && r.v !== null ? String(r.v) : r.v)) as T[];
  }

  /** Columns this table does not have, refused by name rather than quoted into a statement */
  #known(what: string, columns: readonly string[]): void {
    if (!columns.length) throw new Error(`${this.name}: ${what} needs a column`);
    const unknown = columns.filter((c) => !this.def.columns.includes(c));
    if (unknown.length) throw new Error(`${this.name} has no column ${unknown.join(', ')}`);
  }

  /**
   * `COUNT(*)` grouped by one or more columns — "how many per key", which is what about half of the census's
   * `$group` sites ask (docs/10 §13.1) and the one aggregate that reads the same in both databases. It is in
   * the neutral vocabulary for that reason; anything with a join, a window or a second measure is not, and
   * belongs to a module's own per-store queries.
   *
   * Rows with a null in a group column are one group, as they are in MongoDB. No rows means no rows: a count
   * of nothing has no key to report it under.
   */
  async countBy<K extends keyof R & string>(columns: readonly K[], where: WhereWithOr<R> = {}, o: ReadOptions = {}): Promise<(Pick<R, K> & { n: number })[]> {
    this.#known('countBy', columns);
    const w = this.#where(where, o);
    const list = columns.map(q).join(', ');
    const rows = await this.#rows(`SELECT ${list}, COUNT(*) AS n FROM ${q(this.name)} ${w.sql} GROUP BY ${list}`, w.params);
    return rows.map((r) => {
      const out: Record<string, unknown> = { n: Number(r.n) };
      for (const c of columns) out[c] = this.#value(c, r[c]);
      return out as Pick<R, K> & { n: number };
    });
  }

  /**
   * The total of one numeric column over the matching rows, 0 when none match.
   *
   * A DECIMAL column is refused: `SUM` of one answers a DECIMAL, which this would have to round into a number
   * to keep one return type, and money that has been rounded on its way through a total is the one thing a
   * ledger may not do. Those sums are grouped and compared to stored balances anyway, so they belong to a
   * module's own per-store queries where the exact string survives.
   */
  async sum(column: keyof R & string, where: WhereWithOr<R> = {}, o: ReadOptions = {}): Promise<number> {
    this.#known('sum', [column]);
    if (this.#decimal.has(column)) throw new Error(`${this.name}.${column} is DECIMAL: sum() would round it; total it in the module's own query where the exact value survives`);
    const w = this.#where(where, o);
    const rows = await this.#rows(`SELECT SUM(${q(column)}) AS s FROM ${q(this.name)} ${w.sql}`, w.params);
    // an aggregate with no GROUP BY always answers a row, so "no rows matched" arrives here as SUM() = NULL,
    // and `Number(null)` is 0. MongoDB's `$group` answers nothing at all, which is where its `?? 0` earns its keep
    return Number(rows[0]?.s ?? 0);
  }

  /**
   * A page of rows (kernel/lib/pagination.ts). Cursor mode pages by `(column, primary key)` after the cursor —
   * a keyset, so the hundredth page costs what the first does; page mode counts and offsets.
   */
  async page(where: WhereWithOr<R>, req: PageRequest, order: KeysetOrder, o: ReadOptions = {}): Promise<Page<R>> {
    const idColumn = order.id ?? this.#idColumn('page');
    const dir = order.direction === 'desc' ? -1 : 1;
    const sort: Sort = { [order.column]: dir, [idColumn]: dir };
    const cursorOf = (row: R) => {
      const v = (row as Record<string, unknown>)[order.column];
      return encodeCursor([v instanceof Date ? v.toISOString() : v, (row as Record<string, unknown>)[idColumn]]);
    };

    if (req.mode === 'page') {
      const offset = (req.page - 1) * req.limit;
      const read = () => this.find(where, { ...o, sort, offset, limit: req.limit });
      // one statement at a time on a transaction's connection; outside one the two can go together
      const [total, items] = this.ctx.inTransaction ? [await this.count(where, o), await read()] : await Promise.all([this.count(where, o), read()]);
      const totalPages = Math.max(1, Math.ceil(total / req.limit));
      const last = items.at(-1);
      return { items, nextCursor: req.page < totalPages && last ? cursorOf(last) : null, page: req.page, totalPages, total };
    }

    const after: Sql[] = [];
    if (req.cursor) {
      const [raw, id] = decodeCursor(req.cursor);
      const v = this.def.dates.includes(order.column) && typeof raw === 'string' ? new Date(raw) : raw;
      const cmp = dir === -1 ? '<' : '>';
      after.push({ sql: `${q(order.column)} ${cmp} ? OR (${q(order.column)} = ? AND ${q(idColumn)} ${cmp} ?)`, params: [v, v, id] });
    }
    const w = this.#where(where, o, after);
    const sql = `SELECT ${this.#columnList} FROM ${q(this.name)} ${w.sql}${this.#orderBy(sort)} LIMIT ${whole(req.limit, 'limit') + 1}`;
    const rows = (await this.#rows(sql, w.params)).map((r) => this.fromRow(r));
    const items = rows.slice(0, req.limit);
    return { items, nextCursor: rows.length > req.limit ? cursorOf(items.at(-1)!) : null };
  }

  /**
   * A page ordered by a value the query computes, then by primary key — what `pageAggregate` did: lists sorted by
   * something that is not a column (a priority rank, a deadline with a default). `query` is a compiled select
   * (Kysely's `.compile()` gives exactly `{ sql, parameters }`) that produces the table's columns and `order.key`:
   *
   *   t.pageQuery(db.selectFrom('t').selectAll().select(sql`COALESCE(due_at, '9999-12-31')`.as('sort_due')).compile(),
   *               req, { key: 'sort_due', direction: 'asc' })
   *
   * It is wrapped as a derived table, so the key can be paged on without being computed twice.
   */
  async pageQuery(compiled: Compiled, req: PageRequest, order: ComputedOrder): Promise<Page<R>> {
    const query: Sql = { sql: compiled.sql, params: [...('params' in compiled ? compiled.params : compiled.parameters)] };
    const idColumn = this.#idColumn('pageQuery');
    const dir = order.direction === 'desc' ? -1 : 1;
    const orderBy = ` ORDER BY ${q(order.key)} ${dir === -1 ? 'DESC' : 'ASC'}, ${q(idColumn)} ${dir === -1 ? 'DESC' : 'ASC'}`;
    const derived = `(${query.sql}) AS ${q('q')}`;
    const computed = !this.def.columns.includes(order.key);
    const rowOf = (raw: RowDataPacket) => {
      if (!computed) return this.fromRow(raw);
      const { [order.key]: _key, ...rest } = raw;
      return this.fromRow(rest);
    };
    const cursorOf = (raw: RowDataPacket) => {
      const v = raw[order.key];
      // a date key keeps its kind in the cursor, so it reads back as a Date rather than as the string it printed as
      return encodeCursor([v instanceof Date ? { $date: v.toISOString() } : v, raw[idColumn]]);
    };

    if (req.mode === 'page') {
      const counted = await this.#rows(`SELECT COUNT(*) AS n FROM ${derived}`, query.params);
      const total = Number(counted[0]?.n ?? 0);
      const offset = (req.page - 1) * req.limit;
      const rows = await this.#rows(`SELECT * FROM ${derived}${orderBy} LIMIT ${whole(req.limit, 'limit')} OFFSET ${whole(offset, 'offset')}`, query.params);
      const totalPages = Math.max(1, Math.ceil(total / req.limit));
      const last = rows.at(-1);
      return { items: rows.map(rowOf), nextCursor: req.page < totalPages && last ? cursorOf(last) : null, page: req.page, totalPages, total };
    }

    let keyset = '';
    const params = [...query.params];
    if (req.cursor) {
      const [raw, id] = decodeCursor(req.cursor);
      const v = typeof raw === 'object' && raw !== null && '$date' in raw ? new Date(String((raw as { $date: unknown }).$date)) : raw;
      const cmp = dir === -1 ? '<' : '>';
      keyset = ` WHERE ${q(order.key)} ${cmp} ? OR (${q(order.key)} = ? AND ${q(idColumn)} ${cmp} ?)`;
      params.push(v, v, id);
    }
    const rows = await this.#rows(`SELECT * FROM ${derived}${keyset}${orderBy} LIMIT ${whole(req.limit, 'limit') + 1}`, params);
    const items = rows.slice(0, req.limit);
    return { items: items.map(rowOf), nextCursor: rows.length > req.limit ? cursorOf(items.at(-1)!) : null };
  }

  /* ---------------------------------------------------------------- writes */

  async insert(row: Partial<R> | Record<string, unknown>): Promise<R> {
    const values = this.#fullRow(row as Record<string, unknown>);
    const columns = this.def.columns.filter((c) => values[c] !== undefined);
    const res = await this.#run(
      `INSERT INTO ${q(this.name)} (${columns.map(q).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
      columns.map((c) => this.#param(c, values[c])),
    );
    const identity = this.def.identity;
    if (identity && values[identity] == null) values[identity] = res.insertId;
    const inserted = this.fromRow(values);
    // the insert holds this row until the transaction commits, so reading it back and writing it loses nothing
    if (detecting() && this.ctx.inTransaction) lockedByWrite(this.ctx.conn, [this.#rowKey(inserted)]);
    return inserted;
  }

  /** Several rows in one statement per {@link INSERT_CHUNK} rows; every row must fill the same columns */
  async insertMany(rows: readonly (Partial<R> | Record<string, unknown>)[]): Promise<void> {
    if (!rows.length) return;
    const full = rows.map((r) => this.#fullRow(r as Record<string, unknown>));
    const columns = this.def.columns.filter((c) => full.some((r) => r[c] !== undefined));
    for (const [i, r] of full.entries()) {
      const missing = columns.filter((c) => r[c] === undefined);
      if (missing.length) throw new Error(`${this.name}: row ${i} leaves out ${missing.join(', ')}, which other rows in the same insert set`);
    }
    const names = columns.map(q).join(', ');
    const placeholders = `(${columns.map(() => '?').join(', ')})`;
    for (let i = 0; i < full.length; i += INSERT_CHUNK) {
      const chunk = full.slice(i, i + INSERT_CHUNK);
      await this.#run(
        `INSERT INTO ${q(this.name)} (${names}) VALUES ${chunk.map(() => placeholders).join(', ')}`,
        chunk.flatMap((r) => columns.map((c) => this.#param(c, r[c]))),
      );
    }
  }

  /**
   * Inserts the row unless a unique key already holds it (SQL: on conflict do nothing): the row, or undefined.
   *
   * It is the insert itself that decides — there is no read first, so there is no window between the check and
   * the write. A duplicate key fails this statement and nothing else, inside a transaction as well as outside,
   * which is the rule that changed from MongoDB.
   *
   * `key` narrows it to one unique key: a clash on any other is then raised, not swallowed.
   */
  async insertIfAbsent(row: Partial<R> | Record<string, unknown>, key?: readonly string[]): Promise<R | undefined> {
    const expected = key ? this.#uniqueKeyFor(key, 'insertIfAbsent') : undefined;
    try {
      return await this.insert(row);
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
      // the error names the index; a clash on a key the caller did not mean is a real error
      if (expected && duplicateKeyName(err) !== expected.name) throw err;
      return undefined;
    }
  }

  /**
   * insertIfAbsent for each row, in order (a later row may clash with an earlier one): how many were inserted.
   *
   * One statement per row, on purpose. A multi-row `INSERT … ON DUPLICATE KEY UPDATE` would be one round trip,
   * but its `affectedRows` cannot say how many rows were new: with CLIENT_FOUND_ROWS (§10.2) a row that was
   * inserted and a row that was found both count 1. Where the count is not wanted, `insertMany` is the batch.
   */
  async insertManyIfAbsent(rows: readonly (Partial<R> | Record<string, unknown>)[], key?: readonly string[]): Promise<number> {
    let inserted = 0;
    for (const row of rows) if (await this.insertIfAbsent(row, key)) inserted++;
    return inserted;
  }

  /**
   * Inserts the row, or updates the row that already holds `key` (on conflict do update). `update` says what to
   * set on an existing row; by default every column of `row` that is not part of the key. The row as stored.
   */
  async upsert(row: Partial<R> | Record<string, unknown>, o: { key?: readonly string[]; update?: Patch<R> } = {}): Promise<R> {
    const key = o.key ?? this.def.key;
    const values = this.#fullRow(row as Record<string, unknown>);
    this.#uniqueKeyFor(key, 'upsert');
    const blank = key.filter((c) => values[c] === undefined || values[c] === null);
    if (blank.length) throw new Error(`${this.name}: upsert on (${key.join(', ')}) needs a value for ${blank.join(', ')}`);
    return this.ctx.transaction(async (conn) => {
      const t = this.#on(conn);
      if (this.#onlyKeyAtRisk(key, values)) await t.#onDuplicateUpdate([values], key, o.update ? () => o.update! : undefined);
      else await t.#upsertByLock(values, key, o.update);
      const stored = await t.findOne(this.#keyWhere(values, key));
      if (!stored) throw new Error(`${this.name}: the row upserted on (${key.join(', ')}) was not there afterwards`);
      return stored;
    });
  }

  /** upsert for many rows; one statement per {@link INSERT_CHUNK} rows where the key is the only one at risk */
  async upsertMany(rows: readonly (Partial<R> | Record<string, unknown>)[], o: { key?: readonly string[]; update?: (row: Partial<R> & Record<string, unknown>) => Patch<R> } = {}): Promise<void> {
    if (!rows.length) return;
    const key = o.key ?? this.def.key;
    this.#uniqueKeyFor(key, 'upsertMany');
    const full = rows.map((r) => this.#fullRow(r as Record<string, unknown>));
    // a patch per row cannot share one ON DUPLICATE KEY UPDATE clause, so only the default overwrite batches
    if (!o.update && full.every((r) => this.#onlyKeyAtRisk(key, r))) {
      for (let i = 0; i < full.length; i += INSERT_CHUNK) await this.#onDuplicateUpdate(full.slice(i, i + INSERT_CHUNK), key);
      return;
    }
    // the callback is handed the row the caller passed (with its nullable columns filled in), which is a row
    // of this table: that is what it is for
    for (const row of full) await this.upsert(row, { key, ...(o.update ? { update: o.update(row as Partial<R> & Record<string, unknown>) } : {}) });
  }

  /**
   * Adds to number columns of the row with this key, creating the row when there is none (SQL: insert … on
   * conflict do update set n = n + excluded.n). The server adds, so two callers at once both count. `key` holds
   * the key columns; a new row gets them, the additions, and null in its other nullable columns. The row after.
   *
   *   await t.increment({ owner_kind, owner_id, day }, { count: 1, bytes });
   */
  async increment(key: Record<string, unknown>, fields: Record<string, number>): Promise<R> {
    const keyColumns = Object.keys(key);
    this.#uniqueKeyFor(keyColumns, 'increment');
    const values = this.#fullRow({ ...key, ...fields });
    return this.ctx.transaction(async (conn) => {
      const t = this.#on(conn);
      await t.#onDuplicateUpdate([values], keyColumns, () => Object.fromEntries(Object.entries(fields).map(([c, n]) => [c, inc(c, n)])) as Patch<R>);
      const stored = await t.findOne(this.#keyWhere(values, keyColumns));
      if (!stored) throw new Error(`${this.name}: the row incremented on (${keyColumns.join(', ')}) was not there afterwards`);
      return stored;
    });
  }

  /** Updates one row by primary key; the row after, or undefined when there is none */
  async update(id: unknown, patch: Patch<R>): Promise<R | undefined> {
    return this.updateOne({ [this.#idColumn('update')]: id } as WhereWithOr<R>, patch);
  }

  /**
   * Updates the first matching row and answers it as it now is.
   *
   * Three statements, in a transaction: the row is found and locked, written by primary key, then read. The lock
   * is what makes the answer the caller's own write rather than whatever the row holds by the time it is read.
   */
  async updateOne(where: WhereWithOr<R>, patch: Patch<R>, o: { sort?: Sort } & ReadOptions = {}): Promise<R | undefined> {
    return this.ctx.transaction(async (conn) => {
      const t = this.#on(conn);
      const [found] = await t.find(where, { ...o, limit: 1, forUpdate: true });
      if (!found) return undefined;
      const byKey = this.#keyWhere(found as Record<string, unknown>, this.def.key);
      await t.updateMany(byKey, patch);
      return t.findOne(byKey);
    });
  }

  /** Updates every matching row; how many matched (CLIENT_FOUND_ROWS, so a row set to what it already held counts) */
  async updateMany(where: WhereWithOr<R>, patch: Patch<R>, o: ReadOptions = {}): Promise<number> {
    const set = this.#setClause(patch);
    if (!set.sql) return 0;
    if (detecting() && this.ctx.inTransaction) this.#checkNotLosingAnUpdate(where, patch);
    const w = this.#where(where, o);
    const res = await this.#run(`UPDATE ${q(this.name)} SET ${set.sql} ${w.sql}`, [...set.params, ...w.params]);
    return res.affectedRows;
  }

  async delete(id: unknown): Promise<boolean> {
    return (await this.deleteMany({ [this.#idColumn('delete')]: id } as WhereWithOr<R>)) > 0;
  }

  async deleteMany(where: WhereWithOr<R>, o: ReadOptions = {}): Promise<number> {
    const w = this.#where(where, o);
    return (await this.#run(`DELETE FROM ${q(this.name)} ${w.sql}`, w.params)).affectedRows;
  }

  /**
   * Deletes from an **append-only** table (§6.3), where the ordinary delete is refused by a trigger. Such a
   * table lets a delete through only when the session says which table it is purging, and the only writes
   * entitled to say it are the retention jobs: audit's purge, and nothing else — the ledgers have no purge,
   * so their trigger always refuses.
   *
   * It runs in a transaction because `SET` and `DELETE` have to reach the **same** connection, and on a pool
   * two statements need not. The variable is cleared again on the way out, so a pooled connection does not
   * carry the permission to its next borrower.
   */
  async purgeMany(where: WhereWithOr<R>, o: ReadOptions = {}): Promise<number> {
    const w = this.#where(where, o);
    return this.ctx.transaction(async (conn) => {
      await conn.query('SET @marketly_purge = ?', [this.name]);
      try {
        const [res] = await conn.query<ResultSetHeader>(`DELETE FROM ${q(this.name)} ${w.sql}`, [...w.params]);
        return res.affectedRows;
      } finally {
        await conn.query('SET @marketly_purge = NULL');
      }
    });
  }

  /* ---------------------------------------------------------------- write helpers */

  /* ---------------------------------------------------------------- the unlocked read-modify-write detector (§11.2 rule 2) */

  /** How a row of this table is remembered: by its primary key */
  #rowKey(row: R | Record<string, unknown>): string {
    return rowKey(
      this.name,
      this.def.key.map((c) => (row as Record<string, unknown>)[c]),
    );
  }

  /**
   * Refuses a write that would lose an update: a row this transaction read without a lock, written now with a
   * value this process computed. A patch of nothing but expressions is the server computing from the stored
   * row, which is safe by construction, and a filter that names no particular row cannot be checked at all.
   */
  #checkNotLosingAnUpdate(where: WhereWithOr<R>, patch: Patch<R>): void {
    if (!Object.entries(patch).some(([, v]) => v !== undefined && !isExpr(v))) return;
    const keys = keysFromWhere(this.name, this.def.key, where as Record<string, unknown>);
    if (keys) writingRows(this.ctx.conn, this.name, keys);
  }

  /**
   * Rows an upsert is about to write, as long as it names the whole primary key: checked against what this
   * transaction read without a lock, unless the new values are ones the server computes from the stored row,
   * and locked by the statement from here on either way.
   */
  #writingUpsert(rows: readonly Record<string, unknown>[], computed: boolean): void {
    if (!detecting() || !this.ctx.inTransaction) return;
    const named = rows.filter((r) => this.def.key.every((c) => r[c] !== undefined && r[c] !== null));
    if (!named.length) return;
    const keys = named.map((r) => this.#rowKey(r));
    if (computed) lockedByWrite(this.ctx.conn, keys);
    else writingRows(this.ctx.conn, this.name, keys);
  }

  /** `SET a = ?, n = n + ?` from a patch; an expression is written out, a value is bound */
  #setClause(patch: Patch<R>): Sql {
    const parts: string[] = [];
    const params: unknown[] = [];
    for (const [column, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      if (!this.def.columns.includes(column)) throw new Error(`${this.name} has no column ${column}`);
      if (isExpr(value)) {
        parts.push(`${q(column)} = ${value.sql(q(this.name))}`);
        params.push(...value.params);
      } else {
        parts.push(`${q(column)} = ?`);
        params.push(this.#param(column, value));
      }
    }
    return { sql: parts.join(', '), params };
  }

  /**
   * `INSERT … VALUES … AS new ON DUPLICATE KEY UPDATE …` for one or more rows. `update` gives the patch for a row
   * that is already there; without it, every column of the row that is not part of the key is overwritten.
   */
  async #onDuplicateUpdate(rows: readonly Record<string, unknown>[], key: readonly string[], update?: (row: Record<string, unknown>) => Patch<R>): Promise<void> {
    const columns = this.def.columns.filter((c) => rows.some((r) => r[c] !== undefined));
    const names = columns.map(q).join(', ');
    const placeholders = `(${columns.map(() => '?').join(', ')})`;
    const params = rows.flatMap((r) => columns.map((c) => this.#param(c, r[c] ?? null)));
    // without `update` every row sets the same columns, so one clause serves them all; with it, the patch is the
    // caller's and must be the same for every row of the batch (upsertMany falls back to one row at a time)
    if (update && rows.length > 1) throw new Error(`${this.name}: one ON DUPLICATE KEY UPDATE clause cannot carry a patch per row`);
    const patch = update ? update(rows[0]!) : (Object.fromEntries(columns.filter((c) => !key.includes(c)).map((c) => [c, expr(`new.${q(c)}`)])) as Patch<R>);
    const set = this.#setClause(patch);
    // an upsert without a patch overwrites with the values in hand, and `new.col` is one of those values, not
    // the server reading the stored row — so only a patch that is all expressions (`increment`'s) is safe here
    const computed = Boolean(update) && Object.values(patch as Record<string, unknown>).every((v) => v === undefined || isExpr(v));
    if (!set.sql) {
      // nothing to change: keep a key column as it is, so the statement is still an "insert if absent"
      this.#writingUpsert(rows, true);
      await this.#run(`INSERT INTO ${q(this.name)} (${names}) VALUES ${rows.map(() => placeholders).join(', ')} AS new ON DUPLICATE KEY UPDATE ${q(key[0]!)} = ${q(this.name)}.${q(key[0]!)}`, params);
      return;
    }
    this.#writingUpsert(rows, computed);
    await this.#run(`INSERT INTO ${q(this.name)} (${names}) VALUES ${rows.map(() => placeholders).join(', ')} AS new ON DUPLICATE KEY UPDATE ${set.sql}`, [...params, ...set.params]);
  }

  /**
   * The upsert for a table where some *other* unique key could also refuse the insert. `ON DUPLICATE KEY UPDATE`
   * fires on whichever key clashed, which on such a table would quietly update a row the caller never named — so
   * the row is found and locked first, and only then written.
   */
  async #upsertByLock(values: Record<string, unknown>, key: readonly string[], update?: Patch<R>): Promise<void> {
    const where = this.#keyWhere(values, key);
    const [existing] = await this.find(where, { limit: 1, forUpdate: true });
    const patch = update ?? (Object.fromEntries(this.def.columns.filter((c) => !key.includes(c) && values[c] !== undefined).map((c) => [c, values[c]])) as Patch<R>);
    if (existing) {
      await this.updateMany(where, patch);
      return;
    }
    try {
      await this.insert(values);
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
      // Only a clash on the caller's own key means "it is there now, so update it". A clash on a different
      // unique key is a row the caller never named: updating `where` would match nothing and the upsert would
      // quietly do nothing at all, which is the failure this whole path exists to avoid.
      if (duplicateKeyName(err) !== this.#uniqueKeyFor(key, 'upsert').name) throw err;
      await this.updateMany(where, patch);
    }
  }

  /**
   * Whether `key` is the only unique key an insert of this row could break — the question `ON DUPLICATE KEY
   * UPDATE` cannot ask, because it acts on whichever key clashed. An AUTO_INCREMENT primary key the row leaves
   * for the server is never at risk: the number it gets is new.
   */
  #onlyKeyAtRisk(key: readonly string[], values: Record<string, unknown>): boolean {
    return this.def.uniqueKeys.every(
      (u) => sameColumns(u.columns, key) || (u.columns.length === 1 && u.columns[0] === this.def.identity && values[this.def.identity] == null),
    );
  }

  #keyWhere(values: Record<string, unknown>, key: readonly string[]): WhereWithOr<R> {
    return Object.fromEntries(key.map((c) => [c, values[c] ?? null])) as WhereWithOr<R>;
  }

  #uniqueKeyFor(key: readonly string[], where: string): UniqueKeyDef {
    const found = this.def.uniqueKeys.find((u) => sameColumns(u.columns, key));
    if (!found) throw new Error(`${this.name}: ${where} names (${key.join(', ')}), which is not a unique key of the table`);
    return found;
  }

  #idColumn(where: string): string {
    if (!this.def.idColumn) throw new Error(`${this.name} has a key of several columns: ${where} needs a single-column one`);
    return this.def.idColumn;
  }
}
