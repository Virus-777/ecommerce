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

export type { Cond, Where, WhereWithOr } from '../mongo/filters.js';
import type { Where, WhereWithOr } from '../mongo/filters.js';

/** A fragment and the values it binds, in order */
export interface Sql {
  sql: string;
  params: unknown[];
}

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
function operatorSql(column: string, op: string, value: unknown): Sql | undefined {
  const col = q(column);
  const list = Array.isArray(value) ? (value as unknown[]) : undefined;
  switch (op) {
    // "is distinct from": `is not` null is every non-null value, and `is not` x also matches nulls
    case 'is not':
      return value === null ? { sql: `${col} IS NOT NULL`, params: [] } : { sql: `NOT (${col} <=> ?)`, params: [value] };
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

/** One column's condition */
function condSql(column: string, cond: unknown): Sql | undefined {
  const col = q(column);
  if (cond === undefined) return undefined;
  if (cond === null) return { sql: `${col} IS NULL`, params: [] };
  if (Array.isArray(cond)) {
    // a list is "in": nulls in it are ignored (null equals nothing), and an empty list matches nothing
    const values = cond.filter((v) => v !== null && v !== undefined);
    if (!values.length) return NOTHING;
    return { sql: `${col} IN (${values.map(() => '?').join(', ')})`, params: values };
  }
  if (isOperator(cond)) return operatorSql(column, cond.op, cond.value);
  return { sql: `${col} = ?`, params: [cond] };
}

/** A Where, and optionally `or: [...]`, as one condition */
// Defined with Where itself, so the two stores cannot drift on what a filter means

/**
 * A Where as SQL. Columns are ANDed; `or` is a list of Wheres, any of which may hold, ANDed with the rest —
 * the same shape repositories build today with `$or`.
 */
export function whereSql<R>(where: WhereWithOr<R> | undefined): Sql {
  if (!where) return EVERYTHING;
  const parts: Sql[] = [];
  for (const [column, cond] of Object.entries(where)) {
    if (column === 'or') continue;
    const part = condSql(column, cond);
    if (part) parts.push(part);
  }
  const alternatives = (where as { or?: readonly Where<R>[] }).or;
  if (alternatives) {
    if (!alternatives.length) {
      parts.push(NOTHING); // an `or` of nothing can be satisfied by nothing
    } else {
      const branches = alternatives.map((w) => whereSql(w as WhereWithOr<R>));
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
export function whereClause<R>(where: WhereWithOr<R> | undefined): Sql {
  const w = whereSql(where);
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
