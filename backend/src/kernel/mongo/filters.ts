/**
 * Filter helpers for repositories: text search terms, SQL LIKE patterns, and the "Where" objects some modules pass
 * around ({ column: value | list | { op, value } }) turned into MongoDB filters with SQL's meaning of null.
 *
 * Why SQL's meaning: the spec describes conditions the way PostgreSQL read them (`status <> 'closed'` never matches
 * a row whose status is null). MongoDB's own operators do not (`$ne: 'closed'` also matches null), so these helpers
 * add the null rules once, here, instead of in every repository.
 */
import { escapeRegExp } from '../lib/text.js';
import type { Filter } from './table.js';

/**
 * A case-insensitive "contains" condition for a search box: `{ name: contains(q) }`. The term is trimmed (spaces
 * around a typed term never mean anything) and matched literally (a typed `.` or `*` is not a pattern).
 */
export const contains = (text: string): { $regex: string; $options: 'i' } => ({ $regex: escapeRegExp(text.trim()), $options: 'i' });

/** A case-insensitive "starts with" condition (a reference typed in part, `MK-2610…`): matched literally, trimmed */
export const startsWith = (text: string): { $regex: string; $options: 'i' } => ({ $regex: `^${escapeRegExp(text.trim())}`, $options: 'i' });

/**
 * A case-insensitive "equals" condition (`lower(email) = lower(x)` in SQL). Prefer an index with the
 * CASE_INSENSITIVE collation for lookups that must be fast; this one cannot use an ordinary index.
 */
export const equalsIgnoringCase = (text: string): { $regex: string; $options: 'i' } => ({ $regex: `^${escapeRegExp(text)}$`, $options: 'i' });

/** SQL LIKE (case-sensitive; `%` any run of characters, `_` one character, `\` escapes the next) as an anchored regex */
export function likePattern(pattern: string): { $regex: string } {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === '\\' && i + 1 < pattern.length) out += escapeRegExp(pattern[++i]!);
    else if (ch === '%') out += '[\\s\\S]*';
    else if (ch === '_') out += '[\\s\\S]';
    else out += escapeRegExp(ch);
  }
  return { $regex: `^${out}$` };
}

/** One condition of a Where: a value (equals), a list (one of), null (is null), or an operator with a value */
export type Cond<V> =
  | V
  | readonly V[]
  | null
  | { op: '<' | '<=' | '>' | '>=' | '<>' | 'is not' | 'like' | 'not in' | 'between'; value: V | readonly V[] | null };

/** Conditions on a row's columns, all of which must hold (undefined conditions are left out) */
export type Where<R> = { [K in keyof R]?: Cond<R[K]> };

/**
 * A Where plus alternatives: the columns are ANDed, and `or` is a list of Wheres any one of which may hold,
 * ANDed with the rest. The same shape the MySQL side takes (kernel/mysql/where.ts), so a repository written
 * in this vocabulary reads the same on either store.
 */
export type WhereWithOr<R> = Where<R> & { or?: readonly Where<R>[] };

const COMPARE: Record<string, string> = { '<': '$lt', '<=': '$lte', '>': '$gt', '>=': '$gte' };
/** A condition no document meets (SQL: a comparison with null is never true) */
const NOTHING = { $in: [] };

const isOperator = (v: unknown): v is { op: string; value: unknown } =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date) && 'op' in v;

/**
 * A Where as a MongoDB filter on row fields (give it to table.find / count / page …), with SQL's meaning:
 *   - `value` equals; `null` is "is null" (a missing field counts as null);
 *   - a list is "in": an empty list matches nothing, and nulls in the list are ignored (null equals nothing);
 *   - `<>` skips rows where the column is null; `<>` null matches nothing;
 *   - `is not` is "is distinct from": `is not` null matches every non-null value, `is not` x also matches nulls;
 *   - `not in` skips nulls; an empty list leaves the column unfiltered; a list holding null matches nothing;
 *   - `<`, `<=`, `>`, `>=`, `between` [low, high] and `like` with a null value match nothing;
 *   - `like` is a case-sensitive anchored pattern (likePattern).
 *
 * `or` is a list of Wheres, any of which may hold, ANDed with the columns beside it. An `or` of one branch is
 * that branch; an `or` of none matches nothing, which is what "any of these, and there are none" means, and is
 * what NOTHING does on the SQL side.
 */
export function whereFilter(where: Readonly<Record<string, unknown>>): Filter {
  const out: Filter = {};
  for (const [column, cond] of Object.entries(where)) {
    if (cond === undefined) continue;
    if (column === 'or') {
      const branches = Array.isArray(cond) ? (cond as Readonly<Record<string, unknown>>[]) : [];
      if (branches.length) out.$or = branches.map((b) => whereFilter(b));
      else out.$nor = [{}]; // "none of: everything"
      continue;
    }
    if (cond === null) out[column] = null;
    else if (Array.isArray(cond)) out[column] = { $in: cond.filter((v) => v !== null && v !== undefined) };
    else if (isOperator(cond)) {
      const c = operatorFilter(column, cond.op, cond.value);
      if (c !== undefined) out[column] = c;
    } else out[column] = cond;
  }
  return out;
}

/** One `{ op, value }` condition as a field condition (undefined: no condition on the field) */
function operatorFilter(column: string, op: string, value: unknown): unknown {
  const list = Array.isArray(value) ? (value as unknown[]) : undefined;
  switch (op) {
    case 'is not':
      return { $ne: value };
    case '<>':
      return value === null ? NOTHING : { $nin: [value, null] };
    case 'not in':
      if (!list?.length) return undefined;
      return list.some((v) => v === null) ? NOTHING : { $nin: [...list, null] };
    case 'like':
      return value === null ? NOTHING : likePattern(String(value));
    case 'between': {
      const [low, high] = list ?? [];
      return low === null || low === undefined || high === null || high === undefined ? NOTHING : { $gte: low, $lte: high };
    }
    default: {
      const mongoOp = COMPARE[op];
      if (!mongoOp) throw new Error(`whereFilter: unsupported condition ${op} on ${column}`);
      return value === null ? NOTHING : { [mongoOp]: value };
    }
  }
}
