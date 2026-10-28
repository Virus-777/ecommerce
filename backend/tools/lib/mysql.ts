/**
 * The spec's tables → MySQL DDL (docs/10-mysql-migration.md §17.2). This is the MySQL counterpart of lib/mongo.ts.
 *
 * Shape of the output, and why: all the `CREATE TABLE`s first with no foreign keys, then the keys as `ALTER TABLE`
 * statements, then the append-only triggers. Emitting the keys separately means the tables need no topological
 * order — a module where two tables point at each other is a problem for the ordering, not for the schema — and it
 * is the same order `npm run migrate` will use when it creates a module from nothing.
 */
import { createTableSql, keyNameOf, type NamedDdl, type TableSchema } from '../../src/kernel/mysql/schema.js';
import { planTables, type Column, type TablePlan } from './tables.js';
import type { ModuleSpec, TableSpec } from './spec.js';
import { q } from './mysql-where.js';
import { columnDdl, checksOf } from './mysql-types.js';
import { keyDdl, parseIndex } from './mysql-indexes.js';
import type { TableDef, UniqueKeyDef } from '../../src/kernel/spec/define.js';

/** `<module>_<table>`, with `-` replaced by `_` (§4) */
export const tableName = (module: string, table: string) => `${module.replace(/-/g, '_')}_${table}`;

export interface TableDdl {
  name: string;
  /**
   * The table in pieces, which is what `npm run migrate` needs: it has to know *which* part is missing,
   * not just what the whole table should look like. `create` below is built from it by the same
   * `createTableSql` the kernel uses, so the statement that is applied and the statement that is written
   * to docs/api/db cannot drift apart.
   */
  schema: TableSchema;
  create: string;
  /** ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY, applied after every table exists */
  foreignKeys: string[];
  /** The append-only guards of §6.3 */
  triggers: string[];
  /** Translation decisions a reader (and Y2's EXPLAIN review) should see */
  notes: string[];
  /**
   * What `kernel/mysql/table.ts` needs at run time to turn rows into parameters and back: which columns are of
   * which type, and every unique key by the name MySQL reports in a 1062. It is built here, beside the DDL, and
   * **from** the DDL lines rather than from the spec a second time, so the def cannot come to disagree with the
   * table that was created.
   */
  def: TableDef;
}

/** The MySQL type a generated column line declares, e.g. `DATETIME(3)` -> 'DATETIME' */
const typeOf = (ddl: string): string => /^`(?:[^`]|``)+`\s+([A-Z]+)/.exec(ddl)?.[1] ?? '';

/** The runtime def, from the column lines that were just generated */
function defOf(o: {
  name: string;
  columnLines: readonly { name: string; ddl: string }[];
  stored: readonly Column[];
  declaredPk: readonly string[];
  primaryKey: readonly string[];
  uniqueKeys: readonly UniqueKeyDef[];
}): TableDef {
  const of = (...types: string[]) => o.columnLines.filter((c) => types.includes(typeOf(c.ddl))).map((c) => c.name);
  const surrogate = o.primaryKey.length === 1 && o.primaryKey[0] === 'row_id';
  return {
    table: o.name,
    key: [...o.declaredPk],
    idColumn: o.declaredPk.length === 1 ? o.declaredPk[0]! : null,
    columns: o.stored.map((c) => c.name),
    nullable: o.stored.filter((c) => c.nullable).map((c) => c.name),
    decimal: of('DECIMAL'),
    binary: of('BINARY', 'BLOB', 'VARBINARY'),
    // a DATE column is a 'YYYY-MM-DD' string in JS and is deliberately not here (dateStrings: ['DATE'])
    dates: of('DATETIME'),
    json: of('JSON'),
    booleans: o.columnLines.filter((c) => /^`(?:[^`]|``)+`\s+TINYINT\(1\)/.test(c.ddl)).map((c) => c.name),
    identity: o.stored.find((c) => c.identity)?.name ?? (surrogate ? 'row_id' : null),
    uniqueKeys: [...o.uniqueKeys],
  };
}

/**
 * Which columns any index names, and so which text columns become VARCHAR rather than TEXT.
 *
 * The `where` clause counts. A partial index carries its condition's columns (§6.1), so a condition on a `text`
 * column puts that column in a key — and MySQL refuses a TEXT column in a key without a prefix length. Missing
 * this is what made `access_role_assignments` and `notifications_template_versions` unbuildable.
 */
function indexedColumns(table: TableSpec): Set<string> {
  const out = new Set<string>();
  for (const i of table.indexes ?? []) {
    const text = String(i);
    const inside = /\((.+)\)/s.exec(text.replace(/\bwhere\s+.+$/is, ''))?.[1] ?? '';
    for (const m of inside.matchAll(/[a-z_][a-z0-9_]*/g)) out.add(m[0]);
    const where = /\bwhere\s+(.+)$/is.exec(text)?.[1];
    if (where) for (const m of where.matchAll(/[a-z_][a-z0-9_]*/g)) out.add(m[0]);
  }
  return out;
}

/** The primary key of a table as the spec declares it: a `pk` column, or a `pk (a, b)` index */
export function primaryKeyOf(table: TableSpec, columns: Column[]): string[] {
  const composite = (table.indexes ?? []).map(String).find((i) => /^\s*pk\s*\(/i.test(i));
  if (composite) {
    const inside = /\((.+)\)/s.exec(composite)?.[1] ?? '';
    return inside.split(',').map((c) => c.trim());
  }
  return columns.filter((c) => c.pk).map((c) => c.name);
}

export function tableDdl(module: ModuleSpec, plan: TablePlan): TableDdl {
  const { table, columns } = plan;
  const name = tableName(module.name, table.name);
  const at = `${module.name}.${table.name}`;
  const byName = new Map(columns.map((c) => [c.name, c]));
  const indexed = indexedColumns(table);
  const notes: string[] = [];
  const columnLines: string[] = [];
  const keys: NamedDdl[] = [];
  const checks: NamedDdl[] = [];
  // every unique key, by the name a duplicate-key error reports (§10.4). Collected where each key is made,
  // so a key that is added to the DDL and not here cannot slip through.
  const uniqueKeys: UniqueKeyDef[] = [];
  let primaryKey: string[] = [];

  const stored = columns.filter((c) => !c.sqlType.startsWith('tsvector'));
  for (const c of stored) {
    // a reference counts as indexed: MySQL puts an index on a foreign key column itself, and a TEXT column
    // cannot carry one without a prefix length (which would change what the key means)
    columnLines.push(
      columnDdl(c, { indexed: indexed.has(c.name) || c.unique || c.pk || Boolean(c.ref), at: `${at}.${c.name}` }),
    );
    for (const check of checksOf(c, name)) checks.push({ name: check.name, ddl: `CONSTRAINT ${q(check.name)} CHECK (${check.sql})` });
  }
  if (stored.length !== columns.length) notes.push('tsvector columns are not stored: the search engine owns them (§5.1)');

  const parsed = (table.indexes ?? []).map((i, n) => ({ raw: String(i), index: parseIndex(String(i), `${at} index ${n + 1}`), n: n + 1 }));

  // §5.3: a single-column pk, a composite one from a `pk (a, b)` index, or an invisible surrogate for the
  // 37 tables the spec gives no key — InnoDB needs a real primary key, and an invisible column never shows up
  // in SELECT *, so rows keep the shape the spec gives them.
  const compositePk = parsed.find((p) => p.index.kind === 'pk');
  const declaredPk = compositePk?.index.kind === 'pk' ? compositePk.index.columns.map((c) => c.name) : columns.filter((c) => c.pk).map((c) => c.name);
  const nullablePk = declaredPk.filter((n) => byName.get(n)?.nullable);

  if (!declaredPk.length) {
    columnLines.unshift('`row_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT INVISIBLE');
    primaryKey = ['row_id'];
    notes.push('no key in the spec: an invisible row_id is the primary key, so SELECT * keeps the spec shape (§5.3)');
  } else if (nullablePk.length) {
    // MySQL refuses a NULL in a PRIMARY KEY, and the spec uses one as a value: brand_stats keys on
    // (brand_id, category_id) where a null category_id means "all categories". So the surrogate of §5.3 becomes
    // the primary key and the declared key becomes a UNIQUE whose nullable parts are COALESCEd — which is the
    // "nulls not distinct" treatment of §6.1, and keeps the rollup row unique rather than unconstrained.
    columnLines.unshift('`row_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT INVISIBLE');
    primaryKey = ['row_id'];
    const parts = declaredPk.map((n) => (byName.get(n)?.nullable ? `(COALESCE(${q(n)}, ''))` : q(n)));
    keys.push({ name: `uq_${name}_pk`, ddl: `UNIQUE KEY ${q(`uq_${name}_pk`)} (${parts.join(', ')})` });
    uniqueKeys.push({ name: `uq_${name}_pk`, columns: declaredPk });
    notes.push(
      `the spec's key (${declaredPk.join(', ')}) has a nullable part (${nullablePk.join(', ')}), which MySQL will not accept in a PRIMARY KEY. ` +
        `An invisible row_id is the primary key and the declared key is a UNIQUE with COALESCE on the nullable parts, so a null still counts as a value (§5.3, §6.1)`,
    );
  } else {
    primaryKey = declaredPk;
  }
  // MySQL reports the primary key as PRIMARY; the surrogate row_id is AUTO_INCREMENT and never at risk
  uniqueKeys.unshift({ name: 'PRIMARY', columns: [...primaryKey] });

  // a `unique` flag on a column is its own key
  for (const c of stored) {
    if (!c.unique) continue;
    keys.push({ name: `uq_${name}_${c.name}`, ddl: `UNIQUE KEY ${q(`uq_${name}_${c.name}`)} (${q(c.name)})` });
    // a UNIQUE on a nullable column refuses nothing among the null rows: MySQL never compares two nulls
    uniqueKeys.push({ name: `uq_${name}_${c.name}`, columns: [c.name], ...(c.nullable ? { partial: true } : {}) });
  }

  for (const p of parsed) {
    if (p.index.kind === 'pk') continue;
    const key = keyDdl(p.index, { table: table.name, qualified: name, columns: byName, at: `${at} index ${p.n}`, n: p.n });
    if (key.sql) keys.push({ name: keyNameOf(key.sql, `${at} index ${p.n}`), ddl: key.sql });
    if (key.sql && p.index.kind === 'index' && p.index.unique) {
      uniqueKeys.push({
        name: keyNameOf(key.sql, `${at} index ${p.n}`),
        columns: p.index.columns.map((c) => c.name),
        // a partial unique (§6.1) is a functional key part: it only refuses the rows its condition covers
        ...(p.index.where ? { partial: true } : {}),
      });
    }
    if (key.note) notes.push(key.note);
  }

  // §6.2: foreign keys inside the module only. A cross-module id stays a plain indexed column, because modules
  // can be switched off and are kept consistent by events.
  const byTableName = new Map((module.tables ?? []).map((t) => [t.name, t]));
  const foreignKeyParts: NamedDdl[] = [];
  for (const c of stored) {
    if (!c.ref) continue;
    const target = c.ref.split('.').pop()!;
    const targetTable = byTableName.get(target);
    if (!targetTable) continue; // cross-module: no key (§6.2)
    if (c.refOption === 'nofk') {
      notes.push(`${c.name} → ${target}: nofk in the spec, so no foreign key (§6.2)`);
      continue;
    }
    // the target's key is whatever the spec says it is: `access.permissions` keys on `key`, `finance.recon_days`
    // on `date`. Assuming `id` is what made nine of these keys unbuildable.
    const targetPk = primaryKeyOf(targetTable, planTables({ ...module, tables: [targetTable] } as ModuleSpec, [])[0]?.columns ?? []);
    if (targetPk.length !== 1) {
      notes.push(`${c.name} → ${target}: no foreign key, because ${target} has a ${targetPk.length ? 'composite' : 'surrogate'} primary key and this is a single column (§6.2)`);
      continue;
    }
    const onDelete = c.refOption === 'cascade' ? 'CASCADE' : 'RESTRICT';
    foreignKeyParts.push({
      name: `fk_${name}_${c.name}`,
      ddl:
        `ALTER TABLE ${q(name)} ADD CONSTRAINT ${q(`fk_${name}_${c.name}`)} FOREIGN KEY (${q(c.name)}) ` +
        `REFERENCES ${q(tableName(module.name, target))} (${q(targetPk[0]!)}) ON DELETE ${onDelete} ON UPDATE RESTRICT`,
    });
  }

  // §6.3: append-only means inserts only. The retention purge names itself in a session variable to delete.
  const triggerParts: NamedDdl[] = [];
  if (table.appendOnly) {
    triggerParts.push({
      name: `${name}_no_update`,
      ddl:
        `CREATE TRIGGER ${q(`${name}_no_update`)} BEFORE UPDATE ON ${q(name)} FOR EACH ROW\n` +
        `  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '${name} is append-only'`,
    });
    triggerParts.push({
      name: `${name}_no_delete`,
      ddl:
        `CREATE TRIGGER ${q(`${name}_no_delete`)} BEFORE DELETE ON ${q(name)} FOR EACH ROW\n` +
        `BEGIN\n` +
        `  IF COALESCE(@marketly_purge, '') <> '${name}' THEN\n` +
        `    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '${name} is append-only';\n` +
        `  END IF;\n` +
        `END`,
    });
    notes.push(`append-only: UPDATE and DELETE are refused; a retention purge sets @marketly_purge = '${name}' in its own session (§6.3)`);
  }

  const schema: TableSchema = {
    name,
    columns: columnLines.map((ddl) => ({ name: /^`((?:[^`]|``)+)`/.exec(ddl)![1]!.replace(/``/g, '`'), ddl })),
    primaryKey,
    keys,
    checks,
    foreignKeys: foreignKeyParts,
    triggers: triggerParts,
  };
  const def = defOf({ name, columnLines: schema.columns, stored, declaredPk, primaryKey, uniqueKeys });
  return { name, schema, create: `${createTableSql(schema)};`, foreignKeys: foreignKeyParts.map((f) => `${f.ddl};`), // the readable .sql file wants each statement terminated; a BEGIN … END body ends itself
    triggers: triggerParts.map((t) => (t.ddl.endsWith(`END`) ? t.ddl : `${t.ddl};`)), notes, def };
}

/**
 * The runtime defs of a module's tables, keyed by spec table name: what `src/spec/<module>.ts` exports as
 * `tables`, and what `ctx.store` hands `Table` for a module whose data lives in MySQL.
 */
export function mysqlTableDefs(module: ModuleSpec, plans: readonly TablePlan[]): Record<string, TableDef> {
  const out: Record<string, TableDef> = {};
  for (const plan of plans) out[plan.table.name] = tableDdl(module, plan).def;
  return out;
}

/** `<module>_v_<name>` (§9.2) */
export const viewName = (module: string, view: string) => `${module.replace(/-/g, '_')}_v_${view}`;

/**
 * What a view may not do, checked before a server ever sees it. The server has the last word — migrate asks it
 * whether it could merge the view and refuses one it could not (kernel/mysql/schema.ts) — but a generator that
 * says "GROUP BY is not allowed in a view, §9.1" names the mistake, where the server says 1354.
 */
const NOT_MERGEABLE: [RegExp, string][] = [
  [/\bGROUP\s+BY\b/i, 'GROUP BY'],
  [/\bHAVING\b/i, 'HAVING'],
  [/\bDISTINCT\b/i, 'DISTINCT'],
  [/\bUNION\b/i, 'UNION'],
  [/\bLIMIT\b/i, 'LIMIT'],
  [/\bOVER\s*\(/i, 'a window function'],
  [/\b(?:SUM|COUNT|AVG|MIN|MAX|GROUP_CONCAT|JSON_ARRAYAGG|JSON_OBJECTAGG|STD|STDDEV|VARIANCE|BIT_AND|BIT_OR|BIT_XOR)\s*\(/i, 'an aggregate'],
];

/** Every table a FROM or JOIN names, so a view that reaches into another module can be refused (§6.2, §9.2) */
const tablesIn = (sql: string): string[] => [...sql.matchAll(/\b(?:FROM|JOIN)\s+\`?([a-z_][a-z0-9_]*)\`?/gi)].map((m) => m[1]!);

/**
 * The module's views (§9.2): join shapes its own code reads often, folded into the reading query by MySQL so the
 * base tables' indexes still do the work. `CREATE OR REPLACE` because migrate applies the whole unit again
 * whenever its hash changes, and a view's definition is expanded at create time — a column added to a base table
 * only reaches a `t.*` view when the view is recreated.
 */
export function moduleViews(module: ModuleSpec): { views: NamedDdl[]; problems: string[] } {
  const problems: string[] = [];
  const views: NamedDdl[] = [];
  const own = new Set((module.tables ?? []).map((t) => tableName(module.name, t.name)));
  for (const v of module.views ?? []) {
    const name = viewName(module.name, v.name);
    const sql = v.sql.trim().replace(/;+\s*$/, '');
    const at = `${module.name} view ${v.name}`;
    for (const [pattern, what] of NOT_MERGEABLE) {
      if (pattern.test(sql)) problems.push(`${at}: ${what} keeps MySQL from merging the view into the query that reads it; a view is a join shape only and anything aggregated belongs in a summary table (§9.1)`);
    }
    const outside = tablesIn(sql).filter((t) => !own.has(t));
    if (outside.length) problems.push(`${at}: reads ${[...new Set(outside)].join(', ')}, which ${outside.length > 1 ? 'are' : 'is'} not this module's. A view joins the module's own tables; another module's rows come through its public API or an event (§6.2, §9.2)`);
    views.push({ name, ddl: `CREATE OR REPLACE ALGORITHM=MERGE SQL SECURITY INVOKER VIEW ${q(name)} AS${sql.includes('\n') ? '\n' : ' '}${sql}` });
  }
  return { views, problems };
}

export interface ModuleDdl {
  module: string;
  tables: TableDdl[];
  /** §9.2, applied after every table exists */
  views: NamedDdl[];
  problems: string[];
}

export function moduleDdl(module: ModuleSpec): ModuleDdl {
  const problems: string[] = [];
  const plans = planTables(module, problems);
  const tables: TableDdl[] = [];
  for (const plan of plans) {
    try {
      tables.push(tableDdl(module, plan));
    } catch (err) {
      problems.push((err as Error).message);
    }
  }
  const { views, problems: viewProblems } = moduleViews(module);
  problems.push(...viewProblems);
  return { module: module.name, tables, views, problems };
}

/** The readable per-module file of §17.2, for the maintainer: docs/api/db/<module>.sql */
export function moduleSql(ddl: ModuleDdl): string {
  const out: string[] = [
    `-- ${ddl.module}: MySQL schema generated from docs/api/spec/modules/${ddl.module}.json by \`npm run gen\`.`,
    '-- Do not edit: change the spec and regenerate. Tables first, then foreign keys, then the append-only guards.',
    '',
  ];
  for (const t of ddl.tables) {
    if (t.notes.length) out.push(...t.notes.map((n) => `-- ${t.name}: ${n}`));
    out.push(t.create, '');
  }
  const keys = ddl.tables.flatMap((t) => t.foreignKeys);
  if (keys.length) out.push('-- foreign keys, inside this module only (§6.2)', ...keys, '');
  if (ddl.views.length) {
    out.push('-- views: join shapes, merged into the query that reads them (§9.2)');
    for (const v of ddl.views) out.push(`${v.ddl};`, '');
  }
  const triggers = ddl.tables.flatMap((t) => t.triggers);
  if (triggers.length) out.push('-- append-only guards (§6.3)', ...triggers.map((t) => `${t}\n`));
  return `${out.join('\n').trimEnd()}\n`;
}

/**
 * The module's tables as data: `src/modules/<m>/mysql-schema.ts` (§17.2).
 *
 * This is what `npm run migrate` and start-up bring the database up to, and it is generated for the same reason
 * the Mongoose `schema.ts` beside it is: the server must not depend on the generator. The spec parser, the type
 * rules and the index translation are `tools/` code — they are not shipped, they are read by a person reviewing a
 * diff. So the decisions they make are written out here, once, and the server only ever reads them.
 *
 * `TableSchema` is plain data, so the file is its JSON with a type on it. That is deliberate: a generated file
 * whose diff is readable is a generated file a change can be reviewed in, and `migrateMysql` compares these
 * pieces against `information_schema` one by one (§17.3) — so what the reviewer reads is what is applied.
 *
 * Views (§9.2) and data migrations belong to the same unit and are added here when they exist.
 */
export function emitMysqlSchema(ddl: ModuleDdl, header: string): string {
  const tables = ddl.tables.map((t) => t.schema);
  const counts = [
    `${tables.length} tables`,
    `${tables.reduce((n, t) => n + t.columns.length, 0)} columns`,
    `${tables.reduce((n, t) => n + t.keys.length, 0)} keys`,
    `${tables.reduce((n, t) => n + t.foreignKeys.length, 0)} foreign keys`,
  ];
  // One line per column, key, check, foreign key and trigger. A generated file of this size is only reviewable if
  // a spec change shows up as the one line it changed, and these are the pieces migrate compares one by one.
  const list = (items: readonly unknown[], indent: string) =>
    items.length ? `[\n${items.map((i) => `${indent}  ${JSON.stringify(i)},`).join('\n')}\n${indent}]` : '[]';
  const table = (t: TableSchema) =>
    [
      `    {`,
      `      name: ${JSON.stringify(t.name)},`,
      `      columns: ${list(t.columns, '      ')},`,
      `      primaryKey: ${JSON.stringify(t.primaryKey)},`,
      `      keys: ${list(t.keys, '      ')},`,
      `      checks: ${list(t.checks, '      ')},`,
      `      foreignKeys: ${list(t.foreignKeys, '      ')},`,
      `      triggers: ${list(t.triggers, '      ')},`,
      `    },`,
    ].join('\n');
  const views = ddl.views.length
    ? `\n  views: [\n${ddl.views.map((v) => `    ${JSON.stringify(v)},`).join('\n')}\n  ],`
    : '';
  return `${header}
import type { MysqlUnit } from '../../kernel/mysql/schema.js';

/** ${ddl.module}: ${counts.join(', ')}. The readable form of the same thing is docs/api/db/${ddl.module}.sql. */
export const unit: MysqlUnit = {
  module: ${JSON.stringify(ddl.module)},
  tables: [
${tables.map(table).join('\n')}
  ],${views}
};
`;
}
