/**
 * The schema the spec asks for, and bringing a database up to it (docs/10-mysql-migration.md §17.3). Applied
 * at startup outside production (MIGRATE_ON_START) and by `npm run migrate`; idempotent. The counterpart of
 * kernel/mongo/schema.ts.
 *
 * A table is described in **pieces** — columns, keys, checks, foreign keys, triggers — rather than as one
 * `CREATE TABLE` string, because that is the only way to answer the question migrate has to ask: *which* part
 * is missing. {@link createTableSql} builds the statement from the pieces, and the generator writes its
 * `docs/api/db/<module>.sql` with the same function, so what is applied and what is read can never drift.
 *
 * What it will do on its own, and what it will not:
 *
 *  - **adds**: tables, columns (`ALGORITHM=INSTANT`), keys (`ALGORITHM=INPLACE, LOCK=NONE`), checks, foreign
 *    keys, triggers, views. These are the changes that cannot lose anything.
 *  - **drops**: only a key the spec no longer declares, which is what `syncIndexes` did on MongoDB. A table or
 *    a column that is not in the spec is **reported, never dropped** — "never drops collections" was the rule
 *    on MongoDB and it is the rule here, because the thing that is not in the spec may be the thing that is
 *    right.
 *  - **refuses**: a column whose type, nullability or collation has changed. Those rewrite the table, and a
 *    rewrite is a decision with a maintenance window attached, not something a restart should do. It is
 *    refused by name with both definitions, and a hand-written migration does it.
 *
 * Data changes (backfills, renames) are a module's `mysqlMigrations`: { id, up(store) }, each run once, in
 * order, recorded in `kernel_migrations` as on MongoDB.
 */
import { createHash } from 'node:crypto';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { kernelDdl } from './kernel-tables.js';
import type { MysqlStore } from './index.js';
import { q } from './where.js';

/** One column: its name, and the line that defines it inside a CREATE TABLE */
export interface ColumnSchema {
  name: string;
  /** e.g. ``​`status` VARCHAR(16) NOT NULL`` */
  ddl: string;
}

/** Anything else that has a name of its own: a key, a check, a foreign key, a trigger, a view */
export interface NamedDdl {
  name: string;
  ddl: string;
}

export interface TableSchema {
  /** `<module>_<table>` */
  name: string;
  columns: readonly ColumnSchema[];
  primaryKey: readonly string[];
  /** `UNIQUE KEY …`, `KEY …`, `FULLTEXT KEY …` lines, by index name */
  keys: readonly NamedDdl[];
  /** `CONSTRAINT … CHECK (…)` lines, by constraint name */
  checks: readonly NamedDdl[];
  /** Whole `ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY …` statements, by constraint name */
  foreignKeys: readonly NamedDdl[];
  /** Whole `CREATE TRIGGER …` statements, by trigger name */
  triggers: readonly NamedDdl[];
}

const SUFFIX = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin';

/** The `CREATE TABLE` for a schema. The generator's .sql files and migrate both come through here */
export function createTableSql(t: TableSchema): string {
  const lines = [
    ...t.columns.map((c) => c.ddl),
    ...(t.primaryKey.length ? [`PRIMARY KEY (${t.primaryKey.map(q).join(', ')})`] : []),
    ...t.keys.map((k) => k.ddl),
    ...t.checks.map((c) => c.ddl),
  ];
  return `CREATE TABLE ${q(t.name)} (\n${lines.map((l) => `  ${l}`).join(',\n')}\n) ${SUFFIX}`;
}

/* ------------------------------------------------------------------ what a column says it is */

/** A column definition as the server would describe it, so the spec's line and the stored one can be compared */
export interface ColumnShape {
  type: string;
  nullable: boolean;
  autoIncrement: boolean;
  invisible: boolean;
  collation: string | undefined;
}

/**
 * Reads one of our own generated column lines. It is a small closed grammar — `columnDdl` in tools/lib
 * writes every one of them — so anything it cannot read is a mistake worth throwing for rather than a shape
 * to guess at.
 */
export function parseColumnDdl(ddl: string, at: string): ColumnShape {
  const m = /^`((?:[^`]|``)+)`\s+(.*)$/.exec(ddl.trim());
  if (!m) throw new Error(`${at}: cannot read the column definition ${JSON.stringify(ddl)}`);
  let rest = ` ${m[2]!} `;
  const take = (re: RegExp) => {
    const found = re.exec(rest);
    if (found) rest = rest.replace(re, ' ');
    return found;
  };
  const autoIncrement = Boolean(take(/\sAUTO_INCREMENT\s/i));
  const invisible = Boolean(take(/\sINVISIBLE\s/i));
  const notNull = Boolean(take(/\sNOT\s+NULL\s/i));
  if (!notNull) take(/\sNULL\s/i);
  const collation = take(/\sCOLLATE\s+(\w+)\s/i)?.[1];
  const charset = take(/\sCHARACTER\s+SET\s+(\w+)\s/i)?.[1];
  const type = rest.trim().toLowerCase();
  if (!type) throw new Error(`${at}: no type in the column definition ${JSON.stringify(ddl)}`);
  return { type, nullable: !notNull, autoIncrement, invisible, collation: collationOf(type, collation, charset) };
}

/** The table default, from {@link createTableSql}'s suffix */
export const DEFAULT_COLLATION = 'utf8mb4_0900_bin';
const TEXTUAL = /^(char|varchar|tinytext|text|mediumtext|longtext|enum|set)\b/;

/**
 * What collation a column will actually have, which is not always written on the line.
 *
 * It has to be answered for every textual column, not only the ones that say `COLLATE`, or the comparison
 * is not a comparison: a column the spec leaves at the table default would have nothing to check against,
 * and a database where that column had been altered to something else would pass. A test asserts this for
 * every kind of column the generator writes, and it only became a real test once this was total.
 */
function collationOf(type: string, collate: string | undefined, charset: string | undefined): string | undefined {
  if (collate) return collate;
  if (charset) return charset === 'ascii' ? 'ascii_general_ci' : `${charset}_general_ci`;
  return TEXTUAL.test(type) ? DEFAULT_COLLATION : undefined;
}

/**
 * The index name out of one of our own key lines (``UNIQUE KEY `x` (…)``, ``KEY `x` (…)``, ``FULLTEXT KEY
 * `x` (…) …``). Same rule as the column lines: a small closed grammar we write ourselves, so a line it
 * cannot read is a mistake to throw for.
 */
export function keyNameOf(ddl: string, at: string): string {
  const m = /^\s*(?:UNIQUE\s+|FULLTEXT\s+|SPATIAL\s+)?KEY\s+`((?:[^`]|``)+)`/i.exec(ddl);
  if (!m) throw new Error(`${at}: cannot read the index name out of ${JSON.stringify(ddl)}`);
  return m[1]!.replace(/``/g, '`');
}

/** Whether a column has to be rewritten to match the spec — and what differs, for the message */
function columnDiffers(want: ColumnShape, has: ColumnShape): string | undefined {
  if (want.type !== has.type) return `type ${has.type} should be ${want.type}`;
  if (want.nullable !== has.nullable) return has.nullable ? 'is nullable and should not be' : 'is NOT NULL and should be nullable';
  if (want.autoIncrement !== has.autoIncrement) return want.autoIncrement ? 'should be AUTO_INCREMENT' : 'should not be AUTO_INCREMENT';
  if (want.collation && has.collation && want.collation !== has.collation) return `collation ${has.collation} should be ${want.collation}`;
  return undefined;
}

/* ------------------------------------------------------------------ reading the database */

interface Existing {
  tables: Set<string>;
  columns: Map<string, Map<string, ColumnShape>>;
  keys: Map<string, Set<string>>;
  checks: Set<string>;
  foreignKeys: Set<string>;
  triggers: Set<string>;
  views: Set<string>;
}

/** One pass over information_schema for the whole database: six statements, not six per table */
async function readExisting(conn: PoolConnection | Pool): Promise<Existing> {
  const rows = async (sql: string) => (await conn.query<RowDataPacket[]>(sql))[0];
  const existing: Existing = {
    tables: new Set(),
    columns: new Map(),
    keys: new Map(),
    checks: new Set(),
    foreignKeys: new Set(),
    triggers: new Set(),
    views: new Set(),
  };

  for (const r of await rows("SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()")) {
    if (String(r.TABLE_TYPE) === 'VIEW') existing.views.add(String(r.TABLE_NAME));
    else existing.tables.add(String(r.TABLE_NAME));
  }
  for (const r of await rows(
    'SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, EXTRA, COLLATION_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()',
  )) {
    const table = String(r.TABLE_NAME);
    const extra = String(r.EXTRA ?? '').toUpperCase();
    const map = existing.columns.get(table) ?? new Map<string, ColumnShape>();
    map.set(String(r.COLUMN_NAME), {
      type: String(r.COLUMN_TYPE).toLowerCase(),
      nullable: String(r.IS_NULLABLE) === 'YES',
      autoIncrement: extra.includes('AUTO_INCREMENT'),
      invisible: extra.includes('INVISIBLE'),
      collation: r.COLLATION_NAME ? String(r.COLLATION_NAME) : undefined,
    });
    existing.columns.set(table, map);
  }
  for (const r of await rows('SELECT DISTINCT TABLE_NAME, INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()')) {
    const table = String(r.TABLE_NAME);
    const set = existing.keys.get(table) ?? new Set<string>();
    set.add(String(r.INDEX_NAME));
    existing.keys.set(table, set);
  }
  for (const r of await rows('SELECT CONSTRAINT_NAME FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE()')) {
    existing.checks.add(String(r.CONSTRAINT_NAME));
  }
  for (const r of await rows("SELECT CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_TYPE = 'FOREIGN KEY'")) {
    existing.foreignKeys.add(String(r.CONSTRAINT_NAME));
  }
  for (const r of await rows('SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE()')) {
    existing.triggers.add(String(r.TRIGGER_NAME));
  }
  return existing;
}

/* ------------------------------------------------------------------ migrating */

export interface MysqlMigration {
  id: string;
  up(store: MysqlStore): Promise<void>;
}

export interface MysqlUnit {
  module: string;
  tables: readonly TableSchema[];
  /** `CREATE OR REPLACE VIEW …` statements (§9.2), by view name */
  views?: readonly NamedDdl[];
  migrations?: readonly MysqlMigration[];
}

export interface MigrateResult {
  /** What was applied, by id: `<module>/schema`, `<module>/<migration id>` */
  applied: string[];
  /** Tables and columns the database has and the spec does not. Reported, never acted on */
  extra: string[];
}

/** Thrown for a change that would rewrite a table: it needs a migration and a maintenance window, not a restart */
export class SchemaRewriteNeeded extends Error {
  constructor(readonly changes: readonly string[]) {
    super(`MySQL schema changes that rewrite a table are never applied automatically (§17.3). Write a migration for:\n  - ${changes.join('\n  - ')}`);
    this.name = 'SchemaRewriteNeeded';
  }
}

const hashOf = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);

/**
 * Brings the database up to the spec. Returns what was applied and what the database has that the spec does
 * not. A module whose tables did not change since the last run is skipped by its hash, so a restart costs one
 * read per module, as on MongoDB.
 */
export async function migrateMysql(store: MysqlStore, units: readonly MysqlUnit[], log: (msg: string) => void = () => {}): Promise<MigrateResult> {
  const conn = await store.pool.getConnection();
  try {
    const applied: string[] = [];
    const extra: string[] = [];
    const rewrites: string[] = [];
    const run = async (sql: string) => {
      await conn.query(sql);
    };

    // the kernel's own tables are hand-written (kernel-tables.ts) and are created if absent; a change to one
    // of them is a change to the kernel and comes with its own migration
    for (const ddl of kernelDdl()) await run(ddl.replace('CREATE TABLE', 'CREATE TABLE IF NOT EXISTS'));

    let existing = await readExisting(conn);
    const recorded = async (id: string): Promise<string | undefined> => {
      const [rows] = await conn.query<RowDataPacket[]>('SELECT `hash` FROM `kernel_migrations` WHERE `id` = ?', [id]);
      return rows.length ? String(rows[0]!.hash) : undefined;
    };
    const record = async (id: string, hash: string) => {
      await conn.query('INSERT INTO `kernel_migrations` (`id`, `hash`, `at`) VALUES (?, ?, ?) AS new ON DUPLICATE KEY UPDATE `hash` = new.`hash`, `at` = new.`at`', [id, hash, new Date()]);
    };

    for (const unit of units) {
      const hash = hashOf(unit.tables.map((t) => [t.name, t.columns, t.primaryKey, t.keys, t.checks, t.foreignKeys, t.triggers]).concat(unit.views ? [unit.views as never] : []));
      if ((await recorded(`${unit.module}/schema`)) !== hash) {
        // tables first, then the keys between them: a module whose tables point at each other needs no order
        const deferred: string[] = [];
        for (const table of unit.tables) {
          if (!existing.tables.has(table.name)) {
            await run(createTableSql(table));
            for (const t of table.triggers) await run(t.ddl);
            deferred.push(...table.foreignKeys.map((f) => f.ddl));
            log(`schema ${unit.module}: created ${table.name}`);
            continue;
          }
          await alterTable(table, existing, { run, log, extra, rewrites, module: unit.module });
          deferred.push(...table.foreignKeys.filter((f) => !existing.foreignKeys.has(f.name)).map((f) => f.ddl));
          for (const t of table.triggers) if (!existing.triggers.has(t.name)) await run(t.ddl);
        }
        if (rewrites.length) throw new SchemaRewriteNeeded(rewrites);
        for (const sql of deferred) await run(sql);
        for (const view of unit.views ?? []) await run(view.ddl);
        // the tables this unit just made are there for the next unit's foreign keys to point at
        existing = await readExisting(conn);
        await record(`${unit.module}/schema`, hash);
        applied.push(`${unit.module}/schema`);
        log(`schema ${unit.module}: ${unit.tables.length} tables`);
      }

      for (const m of unit.migrations ?? []) {
        const id = `${unit.module}/${m.id}`;
        if ((await recorded(id)) !== undefined) continue;
        await m.up(store);
        await record(id, '');
        applied.push(id);
        log(`migrated ${id}`);
      }
    }

    // a table the spec does not describe is reported once, at the end, so the list reads as a list
    const wanted = new Set(units.flatMap((u) => u.tables.map((t) => t.name)));
    for (const name of existing.tables) {
      if (!wanted.has(name) && !name.startsWith('kernel_')) extra.push(`table ${name} is in the database and not in the spec`);
    }
    if (extra.length) log(`in the database and not in the spec: ${extra.length} (nothing was dropped)`);
    return { applied, extra };
  } finally {
    conn.release();
  }
}

interface AlterContext {
  run(sql: string): Promise<void>;
  log(msg: string): void;
  extra: string[];
  rewrites: string[];
  module: string;
}

/** The additive half of the diff for one table that already exists */
async function alterTable(table: TableSchema, existing: Existing, ctx: AlterContext): Promise<void> {
  const columns = existing.columns.get(table.name) ?? new Map<string, ColumnShape>();
  const keys = existing.keys.get(table.name) ?? new Set<string>();

  for (const column of table.columns) {
    const at = `${table.name}.${column.name}`;
    const want = parseColumnDdl(column.ddl, at);
    const has = columns.get(column.name);
    if (!has) {
      // INSTANT: the column is recorded in the table's metadata and no rows are touched (8.0.29 is refused
      // for getting exactly this wrong, §20.1)
      await ctx.run(`ALTER TABLE ${q(table.name)} ADD COLUMN ${column.ddl}, ALGORITHM=INSTANT`);
      ctx.log(`schema ${ctx.module}: added ${at}`);
      continue;
    }
    const difference = columnDiffers(want, has);
    if (difference) ctx.rewrites.push(`${at}: ${difference}`);
  }
  for (const name of columns.keys()) {
    if (!table.columns.some((c) => c.name === name)) ctx.extra.push(`column ${table.name}.${name} is in the database and not in the spec`);
  }

  for (const key of table.keys) {
    if (keys.has(key.name)) continue;
    await ctx.run(`ALTER TABLE ${q(table.name)} ADD ${key.ddl}, ALGORITHM=INPLACE, LOCK=NONE`);
    ctx.log(`schema ${ctx.module}: added key ${key.name} on ${table.name}`);
  }
  // a key the spec no longer declares goes, as syncIndexes dropped one MongoDB no longer declared. The primary
  // key and the keys MySQL keeps for its own foreign keys are not ours to drop.
  const declared = new Set([...table.keys.map((k) => k.name), 'PRIMARY']);
  const foreignKeyNames = new Set(table.foreignKeys.map((f) => f.name));
  for (const name of keys) {
    if (declared.has(name) || foreignKeyNames.has(name)) continue;
    await ctx.run(`ALTER TABLE ${q(table.name)} DROP INDEX ${q(name)}`);
    ctx.log(`schema ${ctx.module}: dropped key ${name} on ${table.name}, which the spec no longer declares`);
  }

  for (const check of table.checks) {
    if (existing.checks.has(check.name)) continue;
    await ctx.run(`ALTER TABLE ${q(table.name)} ADD ${check.ddl}`);
    ctx.log(`schema ${ctx.module}: added check ${check.name}`);
  }
}
