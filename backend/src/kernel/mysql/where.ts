/**
 * `Where<R>` → SQL (docs/10-mysql-migration.md §10.1, §10.5).
 *
 * The conditions are the ones repositories already pass, and their meanings do not change — they were defined
 * with SQL's reading of null in the first place (kernel/mongo/filters.ts had to *simulate* that; here most of
 * them are simply what SQL already does). The two worth looking at twice:
 *
 *   - `<>` is **not** SQL's `<>` alone in meaning, but it is in behaviour: both skip rows where the column is
 *     null, so `col <> ?` is the whole translation. On MongoDB this needed `$nin: [value, null]`.
 *   - `is not` means "is distinct from", which *does* match nulls, so it is `NOT (col <=> ?)` using MySQL's
 *     null-safe equality. Writing it as `col <> ?` would silently drop every null row.
 *
 * Everything is a bound parameter. No value is ever put into the SQL text, and `check:boundaries` refuses a
 * `sql` fragment built by concatenating one (§10.5).
 */
import { escapeLike } from '../lib/text.js';

export type { Cond, JsonArrayPath, Where, WhereWithOr } from '../mongo/filters.js';
import { isElementFields, jsonArrayPath, pathValues, type WhereWithOr } from '../mongo/filters.js';

/** A fragment and the values it binds, in order */
export interface Sql {
  sql: string;
  params: unknown[];
}

export interface WhereOptions {
  /**
   * The table's JSON columns. A dotted filter name whose head is one of them is a path into that document
   * (`check_result.passed` → `check_result->'$.passed'`, §10.5f); a dotted name whose head is not is a
   * mistake, and is refused by name here rather than sent to the server as a column nobody has.
   */
  json?: ReadonlySet<string>;
  /**
   * Columns where a `null` condition asks about the JSON value null and not about SQL NULL: a JSON column the
   * table says cannot be null (`Table` works them out from its def). Such a column holds `null` as a JSON
   * document — a setting whose default is "no cap" — so `IS NULL` would never match it, while MongoDB, which
   * has one null for both, matches those very rows. Asking as JSON is what makes the two answer alike.
   */
  jsonNotNull?: ReadonlySet<string>;
}

/** The JSON document `null`, which is not SQL NULL */
const JSON_NULL = "CAST('null' AS JSON)";

/** Matches every row: an empty Where filters nothing */
export const EVERYTHING: Sql = { sql: '1 = 1', params: [] };
/** Matches no row. SQL comparisons with null are never true, and several conditions mean exactly that */
export const NOTHING: Sql = { sql: '1 = 0', params: [] };

export const q = (ident: string) => `\`${ident.replace(/`/g, '``')}\``;

/**
 * A fragment written by hand, for the conditions `Where` has no shape for — a comparison between two columns,
 * a JSON path, a function call. Values are bound; a value written into the text is what `check:boundaries`
 * refuses (§10.5).
 */
export const raw = (sql: string, params: readonly unknown[] = []): Sql => ({ sql, params: [...params] });

const COMPARE = new Set(['<', '<=', '>', '>=']);
const isOperator = (v: unknown): v is { op: string; value: unknown } =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date) && 'op' in v;

/** One `{ op, value }` condition; undefined means "no condition on this column" */
function operatorSql(column: string, op: string, value: unknown, o: WhereOptions): Sql | undefined {
  const col = q(column);
  const list = Array.isArray(value) ? (value as unknown[]) : undefined;
  const jsonNull = o.jsonNotNull?.has(column) ?? false;
  switch (op) {
    // "is distinct from": `is not` null is every non-null value, and `is not` x also matches nulls
    case 'is not':
      if (value === null) return jsonNull ? { sql: `NOT (${col} <=> ${JSON_NULL})`, params: [] } : { sql: `${col} IS NOT NULL`, params: [] };
      return { sql: `NOT (${col} <=> ?)`, params: [value] };
    // SQL's <> already excludes nulls, which is what this condition has always meant
    case '<>':
      return value === null ? NOTHING : { sql: `${col} <> ?`, params: [value] };
    case 'not in': {
      if (!list?.length) return undefined; // an empty list leaves the column unfiltered
      if (list.some((v) => v === null)) return NOTHING; // NOT IN a list holding null is never true
      return { sql: `${col} NOT IN (${list.map(() => '?').join(', ')})`, params: [...list] };
    }
    case 'like':
      return value === null ? NOTHING : { sql: `${col} LIKE ?`, params: [String(value)] };
    // what a search box asks. The MongoDB side is a case-insensitive regex; here the collation does it (§5.2)
    case 'contains':
      return value === null ? NOTHING : contains(column, String(value));
    case 'starts with':
      return value === null ? NOTHING : startsWith(column, String(value));
    case 'equals ignoring case':
      return value === null ? NOTHING : equalsIgnoringCase(column, String(value));
    case 'between': {
      const [low, high] = list ?? [];
      if (low === null || low === undefined || high === null || high === undefined) return NOTHING;
      return { sql: `${col} BETWEEN ? AND ?`, params: [low, high] };
    }
    default: {
      if (!COMPARE.has(op)) throw new Error(`where: unsupported condition ${op} on ${column}`);
      return value === null ? NOTHING : { sql: `${col} ${op} ?`, params: [value] };
    }
  }
}

/**
 * A condition on a `[]` path: "some element of the JSON array matches". `items[].key` is
 * `? MEMBER OF (items->'$[*].key')`, and `role_keys[]` is `? MEMBER OF (role_keys)` — the multi-valued index
 * of §8.1 answers both (EXPLAIN: `type: ref`, `key: mv_…`). A list is one MEMBER OF per value, ORed; an empty
 * list matches nothing, as an empty `IN` does.
 *
 * The path is a JSON path written into the SQL text, which is why it is built from the `[]` name and never from
 * a value: `jsonArrayPath` splits it, and a name with a quote or a backslash in it cannot get this far because
 * it is the repository's own source text.
 */
function pathSql(name: string, path: { column: string; field?: string }, cond: unknown): Sql | undefined {
  if (cond === undefined) return undefined;
  // the field goes into the SQL text as part of a JSON path, so it is held to what a field name may be. It
  // comes from the repository's own source and not from a value, and this is what keeps that true.
  if (path.field !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(path.field)) throw new Error(`where: ${name} is not a path this store can build: "${path.field}" is not a plain field name`);
  // an object asks whether some element of the array holds these fields: JSON_CONTAINS, which reads the
  // candidate as a *subset* of an element, exactly as MongoDB's $elemMatch of equalities does
  if (!path.field && isElementFields(cond)) return { sql: `JSON_CONTAINS(${q(path.column)}, CAST(? AS JSON))`, params: [JSON.stringify(cond)] };
  if (path.field && isElementFields(cond)) throw new Error(`where: ${name} is a path to one field, which takes a value and not an object`);
  const array = path.field ? `${q(path.column)}->'$[*].${path.field}'` : q(path.column);
  const values = pathValues(name, cond); // refuses an operator and null, as the MongoDB side does
  if (!values.length) return NOTHING; // "any of none"
  return { sql: values.length === 1 ? `? MEMBER OF (${array})` : `(${values.map(() => `? MEMBER OF (${array})`).join(' OR ')})`, params: [...values] };
}

/** A field name that can go into a JSON path in the SQL text. It comes from the repository's own source */
const FIELD = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * `check_result.passed` → `check_result->'$.passed'`, for a dotted name whose head is a JSON column of this
 * table. A name with a dot is never a column (no column here has one), so the two cannot be confused; a
 * dotted name whose head is not a JSON column is the repository's mistake and says so.
 */
function jsonObjectPath(name: string, o: WhereOptions): string | undefined {
  const dot = name.indexOf('.');
  if (dot < 0) return undefined;
  const column = name.slice(0, dot);
  if (!o.json?.has(column)) throw new Error(`where: ${name} reads as a path into a JSON document, but ${column} is not a JSON column of this table`);
  const fields = name.slice(dot + 1).split('.');
  const bad = fields.find((f) => !FIELD.test(f));
  if (bad !== undefined) throw new Error(`where: ${name} is not a path this store can build: "${bad}" is not a plain field name`);
  return `${q(column)}->'$.${fields.join('.')}'`;
}

/** The JSON value of a bound parameter: `= CAST(? AS JSON)` compares as JSON and never mixes collations */
const asJson = (value: unknown): Sql => ({ sql: 'CAST(? AS JSON)', params: [JSON.stringify(value)] });

/**
 * A condition on a path into a JSON object. Everything is compared **as JSON** (`CAST(? AS JSON)`), which is
 * the one form that is neither slow nor wrong: `->>` unquotes to `utf8mb4_bin` and a session running
 * `utf8mb4_0900_bin` then refuses the comparison outright with "Illegal mix of collations" (measured on
 * 8.4.13, §10.5b), and it would turn `true` into the string `'true'` on the way.
 *
 * A field that is not there reads as SQL NULL, which is how the null rules fall out:
 *
 *   - `null` matches a field that is absent *or* set to the JSON null, which is what MongoDB matches;
 *   - `<>` keeps SQL's reading — neither absent nor null matches — so the JSON null is excluded by hand,
 *     because `<>` between the JSON null and a string is perfectly true in SQL;
 *   - `is not` is "is distinct from", MongoDB's own `$ne`: absent and null both match.
 */
function objectPathSql(name: string, expr: string, cond: unknown): Sql | undefined {
  if (cond === undefined) return undefined;
  const nullish: Sql = { sql: `(${expr} IS NULL OR ${expr} = ${JSON_NULL})`, params: [] };
  const eq = (v: unknown): Sql => {
    const j = asJson(v);
    return { sql: `${expr} = ${j.sql}`, params: j.params };
  };
  if (cond === null) return nullish;
  if (Array.isArray(cond)) {
    const values = cond.filter((v) => v !== null && v !== undefined);
    if (!values.length) return NOTHING;
    const parts = values.map(eq);
    return { sql: parts.length === 1 ? parts[0]!.sql : `(${parts.map((p) => p.sql).join(' OR ')})`, params: parts.flatMap((p) => p.params) };
  }
  if (!isOperator(cond)) return eq(cond);
  const { op, value } = cond;
  const list = Array.isArray(value) ? (value as unknown[]) : undefined;
  switch (op) {
    case 'is not':
      // "is distinct from": a field that is absent or null is distinct from any value, as $ne says it is
      if (value === null) return { sql: `(${expr} IS NOT NULL AND ${expr} <> ${JSON_NULL})`, params: [] };
      return { sql: `NOT (${expr} <=> ${asJson(value).sql})`, params: asJson(value).params };
    case '<>':
      if (value === null) return NOTHING;
      return { sql: `(${expr} <> ${asJson(value).sql} AND ${expr} <> ${JSON_NULL})`, params: asJson(value).params };
    case 'not in': {
      if (!list?.length) return undefined;
      if (list.some((v) => v === null)) return NOTHING;
      const parts = list.map((v) => asJson(v));
      return { sql: `(${parts.map((p) => `${expr} <> ${p.sql}`).join(' AND ')} AND ${expr} <> ${JSON_NULL})`, params: parts.flatMap((p) => p.params) };
    }
    case 'like':
      // the text inside the document, compared in the session's own collation so the comparison is defined
      return value === null ? NOTHING : { sql: `JSON_UNQUOTE(${expr}) COLLATE utf8mb4_0900_bin LIKE ?`, params: [String(value)] };
    case 'between': {
      const [low, high] = list ?? [];
      if (low === null || low === undefined || high === null || high === undefined) return NOTHING;
      const [l, h] = [asJson(low), asJson(high)];
      return { sql: `${expr} BETWEEN ${l.sql} AND ${h.sql}`, params: [...l.params, ...h.params] };
    }
    default: {
      // JSON values compare by type and then by value, so numbers compare as numbers and strings as strings
      if (!COMPARE.has(op)) throw new Error(`where: unsupported condition ${op} on ${name}`);
      if (value === null) return NOTHING;
      const j = asJson(value);
      return { sql: `${expr} ${op} ${j.sql}`, params: j.params };
    }
  }
}

/** One column's condition */
function condSql(column: string, cond: unknown, o: WhereOptions): Sql | undefined {
  const path = jsonArrayPath(column);
  if (path) return pathSql(column, path, cond);
  const object = jsonObjectPath(column, o);
  if (object) return objectPathSql(column, object, cond);
  const col = q(column);
  if (cond === undefined) return undefined;
  if (cond === null) return o.jsonNotNull?.has(column) ? { sql: `${col} = ${JSON_NULL}`, params: [] } : { sql: `${col} IS NULL`, params: [] };
  if (Array.isArray(cond)) {
    // a list is "in": nulls in it are ignored (null equals nothing), and an empty list matches nothing
    const values = cond.filter((v) => v !== null && v !== undefined);
    if (!values.length) return NOTHING;
    return { sql: `${col} IN (${values.map(() => '?').join(', ')})`, params: values };
  }
  if (isOperator(cond)) return operatorSql(column, cond.op, cond.value, o);
  return { sql: `${col} = ?`, params: [cond] };
}

/** A Where, and optionally `or: [...]`, as one condition */
// Defined with Where itself, so the two stores cannot drift on what a filter means

/**
 * A Where as SQL. Columns are ANDed; `or` is a list of Wheres, any of which may hold, ANDed with the rest —
 * the same shape repositories build today with `$or` — and `and` is a list all of which must hold, for the two
 * conditions on one name that an object cannot carry.
 */
export function whereSql<R>(where: WhereWithOr<R> | undefined, o: WhereOptions = {}): Sql {
  if (!where) return EVERYTHING;
  const parts: Sql[] = [];
  for (const [column, cond] of Object.entries(where)) {
    if (column === 'or' || column === 'and') continue;
    const part = condSql(column, cond, o);
    if (part) parts.push(part);
  }
  // every one of these must hold: what an object cannot say twice of one name (kernel/mongo/filters.ts)
  for (const also of (where as { and?: readonly WhereWithOr<R>[] }).and ?? []) {
    const part = whereSql(also, o);
    if (part.sql !== EVERYTHING.sql) parts.push({ sql: `(${part.sql})`, params: part.params });
  }
  const alternatives = (where as { or?: readonly WhereWithOr<R>[] }).or;
  if (alternatives) {
    if (!alternatives.length) {
      parts.push(NOTHING); // an `or` of nothing can be satisfied by nothing
    } else {
      const branches = alternatives.map((w) => whereSql(w, o));
      parts.push({
        sql: `(${branches.map((b) => `(${b.sql})`).join(' OR ')})`,
        params: branches.flatMap((b) => b.params),
      });
    }
  }
  if (!parts.length) return EVERYTHING;
  return { sql: parts.map((p) => p.sql).join(' AND '), params: parts.flatMap((p) => p.params) };
}

/** `WHERE …`, or '' when nothing is filtered, ready to append to a statement */
export function whereClause<R>(where: WhereWithOr<R> | undefined, o: WhereOptions = {}): Sql {
  const w = whereSql(where, o);
  return w.sql === EVERYTHING.sql ? { sql: '', params: [] } : { sql: `WHERE ${w.sql}`, params: w.params };
}

/* ------------------------------------------------------------------ search-box helpers (§10.4, §13.1)
 * The MongoDB versions were case-insensitive regexes. Here the collation does the work: `as_ci` ignores case but
 * not accents, which is the rule MongoDB's strength-2 collation applied (§5.2). `%`, `_` and `\` in what the
 * customer typed are escaped, so a typed `%` is a per-cent sign and not "anything".
 */

const CI = 'COLLATE utf8mb4_0900_as_ci';

/** A search box's "contains": `name LIKE '%term%'`, ignoring case */
export const contains = (column: string, text: string): Sql => ({ sql: `${q(column)} LIKE ? ${CI}`, params: [`%${escapeLike(text.trim())}%`] });

/** "Starts with", for a reference typed in part (`MK-2610…`) */
export const startsWith = (column: string, text: string): Sql => ({ sql: `${q(column)} LIKE ? ${CI}`, params: [`${escapeLike(text.trim())}%`] });

/** Equality ignoring case, for a column that is not already `ci` */
export const equalsIgnoringCase = (column: string, text: string): Sql => ({ sql: `${q(column)} = ? ${CI}`, params: [text] });

/** A value is one of the entries of a JSON array column: the multi-valued index of §8.1 answers this */
export const memberOf = (column: string, value: unknown): Sql => ({ sql: `? MEMBER OF (${q(column)})`, params: [value] });

/** Every one of `values` is in the JSON array column (`$all`): one MEMBER OF each, ANDed (§8.1) */
export const allMembersOf = (column: string, values: readonly unknown[]): Sql =>
  values.length ? { sql: values.map(() => `? MEMBER OF (${q(column)})`).join(' AND '), params: [...values] } : EVERYTHING;
