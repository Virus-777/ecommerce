/**
 * The generic table access of ShippingRepository (get / find / insert / update with a Where of column conditions)
 * on MongoDB, with these meanings (docs/04-mongodb-migration.md §2):
 *   - `<>` and `not in` skip nulls, an empty list matches nothing, `like` is an anchored pattern (% and _);
 *   - jsonb columns are stored as JSON (dates inside become strings, as jsonb gave them back);
 *   - insert-if-new ("on conflict do nothing") looks for every unique key first: a duplicate key inside a
 *     transaction would abort it.
 */
import type { Schema } from 'mongoose';
import type { Table } from '../../kernel/mongo/index.js';
import type { Filter, Sort } from '../../kernel/mongo/table.js';
import type { CollectionDef } from '../../kernel/spec/define.js';

type Row = Record<string, unknown>;

const isOp = (v: unknown): v is { op: string; value: unknown } => typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date) && 'op' in v;
const RANGE: Record<string, string> = { '<': '$lt', '<=': '$lte', '>': '$gt', '>=': '$gte' };

export const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** SQL LIKE (case-sensitive, % any run, _ one character) as an anchored regular expression */
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

/** lower(col) like '%term%' */
export const containsText = (s: string) => ({ $regex: escapeRegExp(s.trim().toLowerCase()), $options: 'i' });

/** A Where of column conditions (value, list, null, { op, value }) as a filter */
export function toFilter(where: Row): Filter {
  const out: Filter = {};
  for (const [k, v] of Object.entries(where)) {
    if (v === undefined) continue;
    if (v === null) out[k] = null;
    else if (Array.isArray(v)) out[k] = { $in: [...v] };
    else if (isOp(v)) {
      switch (v.op) {
        case '<>':
          out[k] = { $nin: [v.value, null] };
          break;
        case 'is not':
          out[k] = { $ne: v.value };
          break;
        case 'not in':
          // an empty list leaves the column unfiltered
          if (Array.isArray(v.value) && v.value.length) out[k] = { $nin: [...v.value, null] };
          break;
        case 'like':
          out[k] = likePattern(String(v.value));
          break;
        default: {
          const op = RANGE[v.op];
          if (!op) throw new Error(`unsupported condition ${v.op} on ${k}`);
          out[k] = { [op]: v.value };
        }
      }
    } else out[k] = v;
  }
  return out;
}

export const sortOf = (orderBy: readonly (readonly [string, 'asc' | 'desc'])[] | undefined): Sort | undefined =>
  orderBy?.length ? Object.fromEntries(orderBy.map(([c, d]) => [c, d === 'desc' ? -1 : 1])) : undefined;

/** The jsonb columns of a table (Mixed paths of its generated schema) */
export function jsonColumns(schema: Schema): Set<string> {
  return new Set(Object.entries(schema.paths).filter(([, p]) => p.instance === 'Mixed').map(([k]) => k));
}

/** A row or patch with undefined fields dropped and json values as JSON */
export function encode(json: Set<string>, row: Row): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) {
    if (v === undefined) continue;
    out[k] = json.has(k) && v !== null ? JSON.parse(JSON.stringify(v)) : v;
  }
  return out;
}

const TYPES: Record<string, (v: unknown) => boolean> = {
  string: (v) => typeof v === 'string',
  null: (v) => v === null || v === undefined,
  bool: (v) => typeof v === 'boolean',
  date: (v) => v instanceof Date,
  int: (v) => Number.isInteger(v),
  long: (v) => Number.isInteger(v),
  double: (v) => typeof v === 'number',
  number: (v) => typeof v === 'number',
  decimal: (v) => typeof v === 'string' || typeof v === 'number',
  object: (v) => typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date),
  array: (v) => Array.isArray(v),
};

/** Whether a row falls under an index's partial filter (unknown operators: assume it does) */
function satisfies(row: Row, partial: Readonly<Record<string, unknown>>): boolean {
  for (const [k, cond] of Object.entries(partial)) {
    if (k === '$and') {
      if (!(cond as Row[]).every((c) => satisfies(row, c))) return false;
      continue;
    }
    if (k === '$or') {
      if (!(cond as Row[]).some((c) => satisfies(row, c))) return false;
      continue;
    }
    const v = row[k] ?? null;
    if (typeof cond === 'object' && cond !== null && !Array.isArray(cond) && !(cond instanceof Date)) {
      for (const [op, x] of Object.entries(cond)) {
        if (op === '$type' && !(TYPES[String(x)]?.(v) ?? true)) return false;
        if (op === '$in' && !(x as unknown[]).some((y) => y === v)) return false;
        if (op === '$eq' && x !== v) return false;
        if (op === '$exists' && x && v === null) return false;
      }
    } else if (cond !== v) return false;
  }
  return true;
}

/** The unique keys a new row takes (primary key and unique indexes it falls under), as filters */
export function uniqueKeys(def: CollectionDef, row: Row): { filter: Filter; collation?: { locale: string; strength: number } }[] {
  const keys: { filter: Filter; collation?: { locale: string; strength: number } }[] = [];
  if (def.idField) {
    if (row[def.idField] != null) keys.push({ filter: { [def.idField]: row[def.idField] } });
  } else if (def.key.length) keys.push({ filter: Object.fromEntries(def.key.map((k) => [k, row[k] ?? null])) });
  for (const idx of def.indexes) {
    if (!idx.unique) continue;
    if (idx.partial && !satisfies(row, idx.partial)) continue;
    const filter: Filter = { ...Object.fromEntries(Object.keys(idx.key).map((k) => [k, row[k] ?? null])) };
    if (idx.partial) filter.$and = [idx.partial];
    keys.push({ filter, ...(idx.collation ? { collation: { ...idx.collation } } : {}) });
  }
  return keys;
}

const isDuplicateKey = (err: unknown) => (err as { code?: number })?.code === 11000;

/**
 * Inserts the row unless one of its unique keys is taken (on conflict do nothing): the stored row, or undefined.
 * Inside a transaction a concurrent insert of the same key is a write conflict (the transaction is retried);
 * outside one a lost race answers undefined.
 */
export async function insertIfNew<R extends object>(t: Table<R>, row: Row): Promise<R | undefined> {
  for (const key of uniqueKeys(t.def, row)) {
    const q = t.model.exists(t.filter(key.filter)).session(t.session ?? null);
    if (key.collation) q.collation(key.collation);
    if (await q) return undefined;
  }
  try {
    return await t.insert(row);
  } catch (err) {
    if (!t.session?.inTransaction() && isDuplicateKey(err)) return undefined;
    throw err;
  }
}

/** coalesce(sum(column), 0) over the matching rows */
export async function sumOf(t: Table<object>, column: string, filter: Filter): Promise<number> {
  const [r] = await t.aggregate<{ n: unknown }>([{ $match: t.filter(filter) }, { $group: { _id: null, n: { $sum: `$${column}` } } }]);
  return Number(r?.n ?? 0);
}
