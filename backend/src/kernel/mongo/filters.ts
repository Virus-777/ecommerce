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

/**
 * One condition of a Where: a value (equals), a list (one of), null (is null), or an operator with a value.
 *
 * The last three are what a search box asks, and they are conditions rather than per-store helpers because
 * twenty-eight modules have one: `contains` and `starts with` match the text literally, ignoring case and
 * trimming what was typed (a typed `.` or `%` is a full stop or a per-cent sign, never a pattern), and
 * `equals ignoring case` is an exact comparison that ignores case only. On MongoDB they are case-insensitive
 * regexes; on MySQL the `as_ci` collation does the work (§5.2), which is the same rule either way.
 */
export type Cond<V> =
  | V
  | readonly V[]
  | null
  | { op: '<' | '<=' | '>' | '>=' | '<>' | 'is not' | 'like' | 'not in' | 'between' | 'contains' | 'starts with' | 'equals ignoring case'; value: V | readonly V[] | null }
  /**
   * Whether a JSON **array** column holds anything at all. It takes no value, which is why it is its own
   * shape: `{ media_ids: { op: 'is not empty' } }`.
   *
   * Both stores say it, and neither says it the obvious way. MongoDB asks whether the array has a first
   * element (`col.0`), because a column that is missing, null or `[]` all count as empty and one condition
   * covers the three. MySQL asks `COALESCE(JSON_LENGTH(col), 0)`, and the `COALESCE` is not decoration:
   * `JSON_LENGTH(NULL)` is NULL, so `NOT (… OR JSON_LENGTH(col) > 0)` is NULL for a null column and the row
   * vanishes from the *negative* answer — which is how catalog's "nothing missing" tab silently lost every
   * product whose column had never been written (§10.5g).
   */
  | { op: 'is empty' | 'is not empty' };

/**
 * A path into a JSON array: `items[].key` is "some element of items has key = …", and `role_keys[]` is "some
 * element of role_keys is …", which is what a list or a value means on an array column.
 *
 * The `[]` is written out because the two stores cannot both guess. MongoDB spells both of these `items.key`
 * and `role_keys`, and it reads a dotted path as "the field, or any array element's field" without being
 * told which. SQL has to choose: `items->'$[*].key'` for an array, `items->'$.key'` for an object. So the
 * repository says which, once, where it is written — and a path with no `[]` is a column name and nothing else.
 *
 * A path takes a value or a list; an operator on one is refused (there is no `MEMBER OF` with `<`).
 */
export type JsonArrayPath = `${string}[]` | `${string}[].${string}`;

/**
 * A path into a JSON **object**: `check_result.passed` is "the passed field of the check_result document".
 * It is MongoDB's own spelling, and the one SQL needs told about — `check_result->'$.passed'` — which is why
 * the MySQL side is given the table's JSON columns and reads a dotted name whose head is one of them as a
 * path (kernel/mysql/where.ts). A column name has no dot in it, so nothing is ambiguous; a dotted name whose
 * head is *not* a JSON column is refused there rather than quoted into a statement.
 *
 * Both stores take a value, a list, null, `<>`, `is not`, the four comparisons, `between` and `like` here.
 * The one meaning worth having in mind: `<>` keeps SQL's reading (a row whose field is missing or null does
 * not match) and `is not` is MongoDB's `$ne` (it does), which is the pair the sites being converted use.
 */
export type JsonObjectPath = `${string}.${string}`;

/** Conditions on a row's columns, all of which must hold (undefined conditions are left out) */
export type Where<R> = { [K in keyof R]?: Cond<R[K]> } & { [P in JsonArrayPath]?: unknown } & { [P in JsonObjectPath]?: unknown };

/** `items[].key` → `{ column: 'items', field: 'key' }`; undefined when the name is an ordinary column */
export function jsonArrayPath(name: string): { column: string; field?: string } | undefined {
  const at = name.indexOf('[]');
  if (at < 0) return undefined;
  const rest = name.slice(at + 2);
  if (rest !== '' && !rest.startsWith('.')) throw new Error(`where: ${name} is not a path: [] is followed by ${rest[0]}, not a field`);
  return { column: name.slice(0, at), ...(rest ? { field: rest.slice(1) } : {}) };
}

/**
 * A Where plus alternatives: the columns are ANDed, and `or` is a list of Wheres any one of which may hold,
 * ANDed with the rest. The same shape the MySQL side takes (kernel/mysql/where.ts), so a repository written
 * in this vocabulary reads the same on either store.
 *
 * `and` is for what one object cannot say: two conditions on the same name. A filter that is about a key *and*
 * about a section asks twice of the same JSON array (`items[].key`), and `{ a: x, a: y }` is not a thing one
 * can write. An `and` of none adds no condition, because that is what "all of these, and there are none" means.
 */
export type WhereWithOr<R> = Where<R> & { or?: readonly WhereWithOr<R>[]; and?: readonly WhereWithOr<R>[] };

const COMPARE: Record<string, string> = { '<': '$lt', '<=': '$lte', '>': '$gt', '>=': '$gte' };
/** A condition no document meets (SQL: a comparison with null is never true) */
const NOTHING = { $in: [] };

const isOperator = (v: unknown): v is { op: string; value?: unknown } =>
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
 *
 * `and` is a list of Wheres all of which must hold, for the conditions one object cannot hold two of.
 *
 * A `items[].key` path is MongoDB's own `items.key` with the `[]` taken out: a dotted path already matches any
 * element of an array, which is the whole meaning of the condition.
 */
export function whereFilter(where: Readonly<Record<string, unknown>>): Filter {
  const out: Filter = {};
  for (const [column, cond] of Object.entries(where)) {
    if (cond === undefined) continue;
    const path = jsonArrayPath(column);
    if (path) {
      // an object asks about one element's fields, which is what $elemMatch is for (isElementFields)
      if (!path.field && isElementFields(cond)) {
        out[path.column] = { $elemMatch: cond };
        continue;
      }
      if (path.field && isElementFields(cond)) throw new Error(`where: ${column} is a path to one field, which takes a value and not an object`);
      // MongoDB reads items.key as "any element's key", so the path is the name with the [] removed
      const field = path.field ? `${path.column}.${path.field}` : path.column;
      const values = pathValues(column, cond);
      // a list of one is the value itself, so the common case reads as an ordinary equality in the profiler
      out[field] = Array.isArray(cond) ? { $in: values } : values[0];
      continue;
    }
    if (column === 'or' || column === 'and') {
      const branches = Array.isArray(cond) ? (cond as Readonly<Record<string, unknown>>[]) : [];
      if (column === 'and') {
        // Every row meets all of no conditions, so an empty `and` adds nothing. It is left out rather than
        // passed on because the server answers "$and/$or/$nor must be a nonempty array" to `$and: []` —
        // Mongoose happens to strip it first, which is exactly why this is checked in mongo.test.ts against
        // the filter this builds and not against what a query returns.
        if (branches.length) out.$and = branches.map((b) => whereFilter(b));
        continue;
      }
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

/**
 * A condition on a `[]` path, as the values it means: one value, or a list of them ("any of these"). An
 * operator and null are refused by **both** stores, so a repository cannot write one that would mean two
 * different things — `MEMBER OF` has no `<`, and "some element is null" is a question about the array, not
 * about its elements. Each store then shapes the values its own way.
 */
export function pathValues(name: string, cond: unknown): readonly unknown[] {
  if (Array.isArray(cond)) return cond.filter((v) => v !== null && v !== undefined);
  if (cond === null || isOperator(cond)) throw new Error(`where: ${name} is a [] path, which takes a value or a list of values, not ${cond === null ? 'null' : `"${(cond as { op: string }).op}"`}`);
  return [cond];
}

/**
 * "Some element of the array has **these fields**", as `{ 'related_subjects[]': { type, id } }` — the
 * `$elemMatch` of two equalities that a dotted path cannot say, because `related_subjects.type = t` and
 * `related_subjects.id = i` may be satisfied by *different* elements.
 *
 * It is in the vocabulary because both stores say it exactly: `$elemMatch` on MongoDB, and
 * `JSON_CONTAINS(col, CAST(? AS JSON))` on MySQL, which asks whether some element of the array contains the
 * given object. Equalities only — a comparison inside an element is not something `JSON_CONTAINS` can ask,
 * and a filter that needs one is not store-neutral.
 *
 * The fields are matched as a **subset**: an element with more fields than these still matches, on both
 * stores. A path with a field (`items[].key`) takes a value, never an object: that path is already about one
 * field, so an object there would be a mistake rather than a second meaning.
 */
export const isElementFields = (cond: unknown): cond is Readonly<Record<string, unknown>> =>
  typeof cond === 'object' && cond !== null && !Array.isArray(cond) && !(cond instanceof Date) && !('op' in cond);

/** One `{ op, value }` condition as a field condition (undefined: no condition on the field) */
function operatorFilter(column: string, op: string, value: unknown): unknown {
  const list = Array.isArray(value) ? (value as unknown[]) : undefined;
  switch (op) {
    // "the array has a first element", which is also what a missing or null column fails
    case 'is not empty':
      return { $exists: true, $ne: null, $not: { $size: 0 } };
    case 'is empty':
      return { $in: [null, []] };
    case 'is not':
      return { $ne: value };
    case '<>':
      return value === null ? NOTHING : { $nin: [value, null] };
    case 'not in':
      if (!list?.length) return undefined;
      return list.some((v) => v === null) ? NOTHING : { $nin: [...list, null] };
    case 'like':
      return value === null ? NOTHING : likePattern(String(value));
    case 'contains':
      return value === null ? NOTHING : contains(String(value));
    case 'starts with':
      return value === null ? NOTHING : startsWith(String(value));
    case 'equals ignoring case':
      return value === null ? NOTHING : equalsIgnoringCase(String(value));
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
