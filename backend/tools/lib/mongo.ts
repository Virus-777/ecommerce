/**
 * Table notation (docs/api/spec/modules/*.json "tables", lib/tables.ts) → MongoDB collections (docs/04-mongodb-migration.md):
 * each table is a collection `<module>.<table>` with a $jsonSchema validator and the spec's indexes.
 *
 *   - a single-column primary key is stored as `_id`; a composite key (or none) gets a generated `_id` and,
 *     for a key, a unique index;
 *   - types, NOT NULL, enum values and `check >= 0` become the validator; tsvector columns are not stored;
 *   - unique columns become unique indexes (nullable ones partial, so several rows may hold null: the spec's meaning);
 *     `unique nulls not distinct` is a plain unique index (MongoDB treats nulls as equal);
 *   - `where …` becomes a partialFilterExpression: is null → null equality (rows store explicit nulls),
 *     is not null → {$gte: ''} on strings, else {$type: <the column's type>} (see present()), = and in → equality
 *     and $in, a bare boolean → true,
 *     <> on an enum column → $in of its other values;
 *   - lower()/upper() → a case-insensitive collation; coalesce(col, …) → col (nulls are equal); gin on an array →
 *     a multikey index; gin(col jsonb_path_ops) → a wildcard index; gin(col gin_trgm_ops) → a plain index;
 *     gin(to_tsvector(a || ' ' || b)) → a text index; gin on a tsvector column is dropped (the search engine's job).
 */
import { createHash } from 'node:crypto';
import type { ModuleSpec } from './spec.js';
import type { Column, TablePlan } from './tables.js';

export interface IndexDef {
  name: string;
  key: Record<string, 1 | -1 | 'text'>;
  unique?: boolean;
  partial?: Record<string, unknown>;
  collation?: { locale: string; strength: number };
}

export interface CollectionDef {
  /** The column stored as _id (single-column primary key), else null (generated _id) */
  idField: string | null;
  /** Primary key columns */
  key: string[];
  /** Stored columns, in spec order */
  columns: string[];
  nullable: string[];
  /** numeric columns: Decimal128 in MongoDB, strings in JS */
  decimal: string[];
  /** bytea columns: binary in MongoDB, Uint8Array in JS */
  binary: string[];
  /** timestamptz columns (cursor values are decoded back to dates) */
  dates: string[];
  /** identity / bigserial column the kernel numbers from a counter */
  identity: string | null;
  validator: Record<string, unknown>;
  indexes: IndexDef[];
  /** Spec indexes MongoDB can't express yet (a unique index whose condition needs the column's value list): the module's repository must enforce them, or the spec gives the column its values */
  unenforced: string[];
}

const INT = ['int', 'long', 'double'];

/** The BSON type(s) a column's base SQL type is stored as; undefined = any (jsonb) */
function bsonOf(sqlType: string): string | string[] | undefined {
  const base = sqlType.replace(/\(.*\)/, '');
  if (base.endsWith('[]')) return 'array';
  switch (base) {
    case 'int':
    case 'integer':
    case 'smallint':
    case 'bigint':
    case 'bigserial':
    case 'serial':
      return INT;
    case 'numeric':
      return 'decimal';
    case 'bool':
    case 'boolean':
      return 'bool';
    case 'timestamptz':
    case 'timestamp':
      return 'date';
    case 'bytea':
      return 'binData';
    case 'jsonb':
    case 'json':
      return undefined;
    default:
      return 'string'; // uuid, text, char, varchar, date (YYYY-MM-DD), time, inet
  }
}

/**
 * A partial-filter condition that matches every non-null value of the column. MongoDB only uses a partial index when
 * the query implies its filter: `col = 'x'` implies `col >= ''` but not `$type: 'string'`, so strings take the lower
 * bound. Other types keep $type (their partial indexes serve range scans, which neither form helps).
 */
function present(c: Column): Record<string, unknown> | undefined {
  const b = bsonOf(c.sqlType);
  if (b === 'string') return { $gte: '' };
  if (Array.isArray(b)) return { $type: 'number' };
  return b === undefined ? undefined : { $type: b };
}

function property(c: Column): Record<string, unknown> {
  const base = c.sqlType.replace(/\(.*\)/, '');
  const b = bsonOf(c.sqlType);
  const p: Record<string, unknown> = {};
  if (b !== undefined) {
    const types = Array.isArray(b) ? [...b] : [b];
    if (c.nullable) types.push('null');
    p.bsonType = types.length === 1 ? types[0] : types;
  }
  if (base.endsWith('[]')) {
    const item = bsonOf(base.slice(0, -2));
    if (item !== undefined) p.items = { bsonType: item };
  }
  if (base === 'date') p.pattern = '^\\d{4}-\\d{2}-\\d{2}$';
  if (c.enumValues) p.enum = c.nullable ? [...c.enumValues, null] : [...c.enumValues];
  const check = c.check && /\s(>=|>)\s*(-?\d+(?:\.\d+)?)$/.exec(c.check);
  // MongoDB's $jsonSchema is draft 4: exclusiveMinimum is a flag on minimum
  if (check) Object.assign(p, { minimum: Number(check[2]) }, check[1] === '>' ? { exclusiveMinimum: true } : {});
  return p;
}

/** Top-level comma split (expressions keep their own commas) */
function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = false;
  let cur = '';
  for (const ch of s) {
    if (ch === "'") quote = !quote;
    if (!quote && ch === '(') depth++;
    if (!quote && ch === ')') depth--;
    if (!quote && depth === 0 && ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => x.trim());
}

const literal = (v: string): unknown => {
  const t = v.trim();
  if (/^'.*'$/.test(t)) return t.slice(1, -1).replace(/''/g, "'");
  if (t === 'true' || t === 'false') return t === 'true';
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  throw new Error(`unsupported value ${t}`);
};

/** A `where` clause (conjunction of simple terms) → partialFilterExpression */
function partialFilter(where: string, columns: Map<string, Column>): Record<string, unknown> {
  const terms = where.split(/\s+and\s+/i).map((t) => t.trim());
  const conds: Record<string, unknown>[] = [];
  for (const term of terms) {
    let m: RegExpExecArray | null;
    const col = (name: string) => {
      const c = columns.get(name);
      if (!c) throw new Error(`unknown column ${name}`);
      return c;
    };
    if ((m = /^(\w+)\s+is\s+null$/i.exec(term))) conds.push({ [col(m[1]!).name]: null });
    else if ((m = /^(\w+)\s+is\s+not\s+null$/i.exec(term))) {
      const c = col(m[1]!);
      const p = present(c);
      if (!p) throw new Error(`is not null on ${c.name} (any type)`);
      conds.push({ [c.name]: p });
    } else if ((m = /^(\w+)\s*=\s*(.+)$/.exec(term))) conds.push({ [col(m[1]!).name]: literal(m[2]!) });
    else if ((m = /^(\w+)\s+in\s*\((.+)\)$/i.exec(term))) conds.push({ [col(m[1]!).name]: { $in: splitTop(m[2]!).map(literal) } });
    else if ((m = /^(\w+)\s+not\s+in\s*\((.+)\)$/i.exec(term))) {
      const c = col(m[1]!);
      if (!c.enumValues) throw new Error(`not in on ${c.name}, which has no enum values`);
      const not = new Set(splitTop(m[2]!).map(literal));
      conds.push({ [c.name]: { $in: c.enumValues.filter((v) => !not.has(v)) } });
    }
    else if ((m = /^(\w+)\s*(<>|!=)\s*(.+)$/.exec(term))) {
      const c = col(m[1]!);
      if (!c.enumValues) throw new Error(`<> on ${c.name}, which has no enum values`);
      const not = literal(m[3]!);
      conds.push({ [c.name]: { $in: c.enumValues.filter((v) => v !== not) } });
    } else if ((m = /^not\s+(\w+)$/i.exec(term))) conds.push({ [col(m[1]!).name]: false });
    else if ((m = /^(\w+)$/.exec(term))) conds.push({ [col(m[1]!).name]: true });
    else throw new Error(`unsupported condition "${term}"`);
  }
  // two conditions on one field (a = 'x' and a <> 'y') need $and; otherwise one object
  const fields = conds.map((c) => Object.keys(c)[0]!);
  if (new Set(fields).size !== fields.length) return { $and: conds };
  return Object.assign({}, ...conds);
}

const indexName = (table: string, def: Omit<IndexDef, 'name'>) =>
  `${table}_${Object.keys(def.key).join('_').replace(/[^a-z0-9_]/gi, '').slice(0, 40)}_${createHash('sha256').update(JSON.stringify(def)).digest('hex').slice(0, 6)}`;

/** One spec index → a MongoDB index (null: dropped, with the reason in notes) */
function indexOf(idx: string, table: string, columns: Map<string, Column>, problems: string[], where: string, unenforced: string[]): IndexDef | null {
  let s = idx.trim();
  let partial: Record<string, unknown> | undefined;
  const w = /\swhere\s(.+)$/i.exec(s);
  if (w) s = s.slice(0, w.index).trim();
  let unique = false;
  let nullsEqual = false;
  if (/^unique\s+nulls\s+not\s+distinct\b/i.test(s)) {
    nullsEqual = true;
    s = s.replace(/^unique\s+nulls\s+not\s+distinct\s*/i, 'unique ');
  }
  if (/^unique\b/.test(s)) {
    unique = true;
    s = s.replace(/^unique\s*/, '');
  }
  if (/\sunique$/.test(s)) {
    unique = true;
    s = s.replace(/\sunique$/, '');
  }
  if (w) {
    try {
      partial = partialFilter(w[1]!, columns);
    } catch (err) {
      if (unique) {
        unenforced.push(`${idx} (${(err as Error).message})`);
        return null;
      }
      partial = undefined; // a non-unique partial index is only narrower: index every row instead
    }
  }
  const key: IndexDef['key'] = {};
  let collation: IndexDef['collation'];
  /** key columns whose null counts as a value (coalesce) */
  const coalesced = new Set<string>();
  const gin = /^gin\s*\((.+)\)$/.exec(s);
  if (gin) {
    const inner = gin[1]!.trim();
    const ts = /^to_tsvector\((.+)\)$/.exec(inner);
    if (ts) {
      for (const part of ts[1]!.split('||')) {
        const name = part.trim();
        if (columns.has(name)) key[name] = 'text';
      }
    } else {
      const m = /^(\w+)(?:\s+(\w+))?$/.exec(inner);
      if (!m || !columns.has(m[1]!)) {
        problems.push(`${where}: cannot read index "${idx}"`);
        return null;
      }
      const c = columns.get(m[1]!)!;
      if (c.sqlType === 'tsvector') return null; // full-text search is the search engine's job
      if (m[2] === 'jsonb_path_ops') key[`${c.name}.$**`] = 1;
      else key[c.name] = 1; // arrays: multikey; gin_trgm_ops: a plain index (prefix and equality)
    }
  } else {
    if (!/^\(.+\)$/.test(s)) {
      problems.push(`${where}: cannot read index "${idx}"`);
      return null;
    }
    for (const raw of splitTop(s.slice(1, -1))) {
      let k = raw.trim();
      let dir: 1 | -1 = 1;
      const d = /^(.+?)\s+(asc|desc)$/i.exec(k);
      if (d) {
        k = d[1]!.trim();
        dir = d[2]!.toLowerCase() === 'desc' ? -1 : 1;
      }
      const fn = /^(lower|upper|coalesce)\((\w+)(?:\s*,.*)?\)$/i.exec(k);
      if (fn) {
        k = fn[2]!;
        if (fn[1]!.toLowerCase() !== 'coalesce') collation = { locale: 'en', strength: 2 };
        else coalesced.add(k);
      }
      if (!columns.has(k)) {
        problems.push(`${where}: index "${idx}" names ${k}, which is not a column`);
        return null;
      }
      key[k] = dir;
    }
  }
  if (!Object.keys(key).length) return null;
  // In the spec a unique key ignores rows with a null in it (several are allowed); MongoDB counts null as a value.
  // Same meaning: the index covers only rows whose nullable key columns all have a value.
  if (unique && !nullsEqual) {
    const conds: Record<string, unknown>[] = [];
    for (const k of Object.keys(key)) {
      const c = columns.get(k);
      if (!c?.nullable || coalesced.has(k)) continue;
      const p = present(c);
      if (p) conds.push({ [k]: p });
    }
    if (conds.length) {
      const all = [...(partial ? ((partial.$and as Record<string, unknown>[] | undefined) ?? [partial]) : []), ...conds];
      const fields = all.flatMap((x) => Object.keys(x));
      partial = new Set(fields).size === fields.length ? Object.assign({}, ...all) : { $and: all };
    }
  }
  const def: Omit<IndexDef, 'name'> = { key, ...(unique ? { unique } : {}), ...(partial ? { partial } : {}), ...(collation ? { collation } : {}) };
  return { name: indexName(table, def), ...def };
}

/** An index with the primary key column renamed to _id (in its keys and its partial filter); its name follows */
function withIdField(i: IndexDef, idField: string, table: string): IndexDef {
  const rename = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k === idField ? '_id' : k, v]));
  const renameFilter = (f: Record<string, unknown>): Record<string, unknown> =>
    Array.isArray(f.$and) ? { $and: (f.$and as Record<string, unknown>[]).map(rename) } : rename(f);
  if (!(idField in i.key) && !(i.partial && JSON.stringify(i.partial).includes(`"${idField}"`))) return i;
  const { name: _name, ...rest } = i;
  const def: Omit<IndexDef, 'name'> = { ...rest, key: rename(i.key) as IndexDef['key'], ...(i.partial ? { partial: renameFilter(i.partial) } : {}) };
  return { name: indexName(table, def), ...def };
}

/** Every table of a module as a collection definition */
export function collectionDefs(mod: ModuleSpec, plans: TablePlan[], problems: string[]): Record<string, CollectionDef> {
  const out: Record<string, CollectionDef> = {};
  for (const { table, columns } of plans) {
    const where = `${mod.name}.${table.name}`;
    const stored = columns.filter((c) => c.sqlType !== 'tsvector');
    const byName = new Map(columns.map((c) => [c.name, c]));
    const compositePk = (table.indexes ?? []).map((i) => /^pk\s*\((.+)\)$/.exec(i)).find(Boolean);
    const key = compositePk ? compositePk[1]!.split(',').map((x) => x.trim()) : stored.filter((c) => c.pk).map((c) => c.name);
    const idField = key.length === 1 && !compositePk ? key[0]! : null;

    const properties: Record<string, unknown> = { _id: idField ? property(byName.get(idField)!) : {}, _lock: { bsonType: INT } };
    const required: string[] = ['_id'];
    for (const c of stored) {
      if (c.name === idField) continue;
      properties[c.name] = property(c);
      if (!c.nullable) required.push(c.name);
    }
    const indexes: IndexDef[] = [];
    const unenforced: string[] = [];
    if (key.length && !idField) {
      const def = { key: Object.fromEntries(key.map((k) => [k, 1 as const])), unique: true };
      indexes.push({ name: indexName(table.name, def), ...def });
    }
    for (const c of stored) {
      if (!c.unique || c.name === idField) continue;
      const p = c.nullable ? present(c) : undefined;
      const def: Omit<IndexDef, 'name'> = { key: { [c.name]: 1 }, unique: true, ...(p ? { partial: { [c.name]: p } } : {}) };
      indexes.push({ name: indexName(table.name, def), ...def });
    }
    for (const idx of table.indexes ?? []) {
      if (/^pk\s*\(/.test(idx)) continue;
      const found = indexOf(idx, table.name, byName, problems, where, unenforced);
      // the primary key column is stored as _id: an index or partial filter naming it must say _id
      const def = found && idField ? withIdField(found, idField, table.name) : found;
      if (def && !indexes.some((i) => i.name === def.name)) indexes.push(def);
    }
    // MongoDB allows one text index per collection: merge text keys
    const text = indexes.filter((i) => Object.values(i.key).includes('text'));
    if (text.length > 1) {
      const merged: Omit<IndexDef, 'name'> = { key: Object.assign({}, ...text.map((i) => i.key)) };
      indexes.splice(0, indexes.length, ...indexes.filter((i) => !text.includes(i)), { name: indexName(table.name, merged), ...merged });
    }
    out[table.name] = {
      idField,
      key,
      columns: stored.map((c) => c.name),
      nullable: stored.filter((c) => c.nullable).map((c) => c.name),
      decimal: stored.filter((c) => c.sqlType.startsWith('numeric')).map((c) => c.name),
      binary: stored.filter((c) => c.sqlType === 'bytea').map((c) => c.name),
      dates: stored.filter((c) => /^timestamp/.test(c.sqlType)).map((c) => c.name),
      identity: stored.find((c) => c.identity || c.sqlType === 'bigserial')?.name ?? null,
      validator: { $jsonSchema: { bsonType: 'object', required, properties, additionalProperties: false } },
      indexes,
      unenforced,
    };
  }
  return out;
}
