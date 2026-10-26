/**
 * Spec index notation → MySQL keys (docs/10-mysql-migration.md §6.1, §7, Appendix A).
 *
 * The notation is read, not pattern-matched against a list, so a new index in the spec is translated rather than
 * forgotten. Every form the spec uses is handled; anything else throws, for the same reason the condition
 * language throws — a key that silently covers the wrong rows is a data bug with no symptom until it is too late.
 *
 *   (a, b)                              a plain index, b may be `desc`
 *   (a, b) unique  |  unique (a, b)     a unique key
 *   unique (a) where <cond>             partial unique → a functional key part (Appendix A)
 *   unique nulls not distinct (a, b)    NULLs count as equal → COALESCE key parts
 *   (a) where <cond>                    partial plain → the condition's columns ride along
 *   pk (a, b)                           the table's primary key
 *   gin(col gin_trgm_ops)               substring search → FULLTEXT … WITH PARSER ngram
 *   gin(to_tsvector(a || ' ' || b))     the same, over several columns
 *   gin(array_col)                      membership → a multi-valued index over a JSON array
 *   gin(col jsonb_path_ops)             paths inside JSON → generated columns, decided per query in Y2 (Appendix B)
 */
import type { Column } from './tables.js';
import { parseCondition, q, type ParsedCondition } from './mysql-where.js';

export interface KeyColumn {
  name: string;
  desc: boolean;
  /**
   * The spec may wrap a key column in an expression:
   * - `lower(col)` / `upper(col)` — case-insensitive comparison. On MySQL the **collation** does this, so the key
   *   is on the plain column and the column must carry `ci` (§5.2). The generator checks that it does, because a
   *   key on the raw column with a case-sensitive collation would quietly stop treating `ABC` and `abc` as one.
   * - `coalesce(col, 'sentinel')` — a NULL counts as the sentinel, so one row per key even when the column is
   *   null. MySQL keeps the COALESCE in a functional key part (Appendix A).
   */
  fn?: 'lower' | 'upper' | 'coalesce';
  /** the second argument of `coalesce`, kept exactly as the spec writes it */
  fallback?: string;
}

export type ParsedIndex =
  | { kind: 'pk'; columns: KeyColumn[] }
  | { kind: 'index'; columns: KeyColumn[]; unique: boolean; nullsNotDistinct: boolean; where?: ParsedCondition }
  | { kind: 'fulltext'; columns: string[] }
  | { kind: 'multivalued'; column: string }
  | { kind: 'json-paths'; column: string };

/** Splits on commas that are not inside parentheses, so `coalesce(a, 'x'), b` is two columns */
function topLevelCommas(inside: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let current = '';
  for (const ch of inside) {
    if (ch === "'") quoted = !quoted;
    if (!quoted && ch === '(') depth++;
    if (!quoted && ch === ')') depth--;
    if (!quoted && ch === ',' && depth === 0) {
      out.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) out.push(current);
  return out;
}

const splitColumns = (inside: string): KeyColumn[] =>
  topLevelCommas(inside).map((part) => {
    const t = part.trim();
    const desc = /\s+desc$/i.test(t);
    const body = t.replace(/\s+desc$/i, '').trim();

    let m = /^(lower|upper)\s*\(\s*([a-z_][a-z0-9_]*)\s*\)$/i.exec(body);
    if (m) return { name: m[2]!, desc, fn: m[1]!.toLowerCase() as 'lower' | 'upper' };

    m = /^coalesce\s*\(\s*([a-z_][a-z0-9_]*)\s*,\s*(.+?)\s*\)$/i.exec(body);
    if (m) return { name: m[1]!, desc, fn: 'coalesce' as const, fallback: m[2]! };

    m = /^([a-z_][a-z0-9_]*)$/i.exec(body);
    if (m) return { name: m[1]!, desc };

    throw new Error(`cannot read the index column "${t}"`);
  });

/** The columns a `gin(to_tsvector(a || ' ' || b))` expression concatenates */
const tsvectorColumns = (expr: string): string[] => {
  const inner = /to_tsvector\s*\((.*)\)\s*$/is.exec(expr)?.[1] ?? expr;
  return [...inner.matchAll(/\b([a-z_][a-z0-9_]*)\b/g)].map((m) => m[1]!).filter((n) => n !== 'to_tsvector' && n !== 'coalesce');
};

export function parseIndex(notation: string, at: string): ParsedIndex {
  const text = notation.trim();

  const gin = /^gin\s*\((.*)\)$/is.exec(text);
  if (gin) {
    const expr = gin[1]!.trim();
    if (/gin_trgm_ops/.test(expr)) return { kind: 'fulltext', columns: [expr.replace(/\s+gin_trgm_ops$/, '').trim()] };
    if (/to_tsvector/i.test(expr)) return { kind: 'fulltext', columns: tsvectorColumns(expr) };
    if (/jsonb_path_ops/.test(expr)) return { kind: 'json-paths', column: expr.replace(/\s+jsonb_path_ops$/, '').trim() };
    const bare = /^([a-z_][a-z0-9_]*)$/i.exec(expr);
    // a bare gin() over an array column is membership; over a jsonb column it is paths, which Y2 decides per query
    if (bare) return { kind: 'multivalued', column: bare[1]! };
    throw new Error(`${at}: cannot translate the index "${notation}"`);
  }

  const pk = /^pk\s*\((.+)\)$/is.exec(text);
  if (pk) return { kind: 'pk', columns: splitColumns(pk[1]!) };

  const where = /\bwhere\s+(.+)$/is.exec(text);
  const head = where ? text.slice(0, where.index).trim() : text;

  const nullsNotDistinct = /\bnulls\s+not\s+distinct\b/i.test(head);
  const body = head.replace(/\bnulls\s+not\s+distinct\b/i, ' ').trim();
  // `unique` may lead or trail: "unique (a, b)" and "(a, b) unique" both appear in the spec
  const unique = /^unique\b/i.test(body) || /\bunique$/i.test(body);
  const cols = /\((.+)\)/s.exec(body)?.[1];
  if (!cols) throw new Error(`${at}: cannot find the columns of the index "${notation}"`);

  return {
    kind: 'index',
    columns: splitColumns(cols),
    unique,
    nullsNotDistinct,
    ...(where ? { where: parseCondition(where[1]!, at) } : {}),
  };
}

/** `uq_orders_3`, kept under MySQL's 64-character limit even for the longest table name */
export function indexName(prefix: string, table: string, n: number): string {
  const name = `${prefix}_${table}_${n}`;
  if (name.length <= 64) return name;
  const room = 64 - `${prefix}__${n}`.length;
  return `${prefix}_${table.slice(0, room)}_${n}`;
}

export interface KeyDdl {
  /** The line inside CREATE TABLE, or undefined when this index becomes nothing (Y2 decides it per query) */
  sql?: string;
  /** What a reader of the plan should know about this translation */
  note?: string;
}

export interface KeyContext {
  table: string;
  /** <module>_<table>, for the index name */
  qualified: string;
  columns: Map<string, Column>;
  at: string;
  n: number;
}

/**
 * One parsed index → its MySQL key. The three interesting cases are all in Appendix A: a partial unique becomes a
 * functional key part, `nulls not distinct` wraps each part in COALESCE, and a partial plain index carries the
 * condition's columns so the condition can still be filtered inside the index.
 */
export function keyDdl(index: ParsedIndex, ctx: KeyContext): KeyDdl {
  const { qualified, columns, at, n } = ctx;

  if (index.kind === 'pk') return { sql: `PRIMARY KEY (${index.columns.map((c) => q(c.name)).join(', ')})` };

  if (index.kind === 'fulltext') {
    for (const c of index.columns) if (!columns.has(c)) throw new Error(`${at}: FULLTEXT names "${c}", which is not a column`);
    return {
      sql: `FULLTEXT KEY ${q(indexName('ft', qualified, n))} (${index.columns.map(q).join(', ')}) WITH PARSER ngram`,
      note: `FULLTEXT ngram over ${index.columns.join(', ')}: terms shorter than the ngram size fall back to LIKE (§6.1)`,
    };
  }

  if (index.kind === 'multivalued') {
    const col = columns.get(index.column);
    if (!col) throw new Error(`${at}: the index names "${index.column}", which is not a column`);
    // §5.1: a tsvector column is not stored at all — the search engine owns the index — so there is nothing here
    if (col.sqlType.startsWith('tsvector')) {
      return { note: `gin(${index.column}) is dropped: the column is tsvector, which is not stored; the search engine owns this index (§5.1, §14)` };
    }
    if (!col.sqlType.endsWith('[]') && !/^jsonb?$/.test(col.sqlType)) {
      throw new Error(`${at}: gin(${index.column}) needs an array or json column, but it is ${col.sqlType}`);
    }
    // §8.1: the array stays JSON and membership is answered by a multi-valued index
    return {
      sql: `KEY ${q(indexName('mv', qualified, n))} ((CAST(${q(index.column)} AS CHAR(64) ARRAY)))`,
      note: `multi-valued index on ${index.column}: queried with MEMBER OF, one per value for an AND (§8.1)`,
    };
  }

  if (index.kind === 'json-paths') {
    // Appendix B decides these per query in Y2: a generated column where a list filters or sorts on the path,
    // a plain ->> in the WHERE clause where another filter is selective enough. Nothing to create now.
    return { note: `gin(${index.column} jsonb_path_ops) becomes generated columns, chosen per query in Y2 (Appendix B); no key emitted` };
  }

  const expr = (c: KeyColumn): string => {
    const base = q(c.name);
    let part: string;
    if (c.fn === 'lower' || c.fn === 'upper') {
      // §5.2: the collation makes the comparison case-insensitive, so the key is on the plain column — which is
      // only equivalent if the column actually carries `ci`. Checked, because getting this wrong silently turns a
      // case-insensitive unique key into a case-sensitive one.
      const col = columns.get(c.name);
      if (!col?.caseInsensitive) {
        throw new Error(
          `${at}: the index uses ${c.fn}(${c.name}), which on MySQL is the column's collation, but "${c.name}" is not marked \`ci\`. ` +
            `Add \`ci\` to the column in the spec (§5.2) so the key compares without case.`,
        );
      }
      part = base;
    } else if (c.fn === 'coalesce') {
      part = `(COALESCE(${base}, ${c.fallback}))`;
    } else {
      part = index.nullsNotDistinct ? `(COALESCE(${base}, ''))` : base;
    }
    return c.desc ? `${part} DESC` : part;
  };

  // MySQL cannot put these in an ordinary key at all: JSON needs a generated column or a multi-valued index
  // (§8.1), and a BLOB needs a prefix length that would change what the key means.
  const notIndexable = (name: string): string | undefined => {
    const col = columns.get(name);
    if (!col) return undefined;
    if (col.sqlType.endsWith('[]')) return 'an array column';
    if (/^jsonb?$/.test(col.sqlType)) return 'a JSON column';
    if (col.sqlType === 'bytea' && /_encrypted$/.test(col.name)) return 'a BLOB column';
    if (col.sqlType === 'mediumtext' || col.sqlType === 'longtext') return 'a long text column';
    return undefined;
  };

  if (index.where) {
    if (index.unique) {
      // Appendix A: the first key part is NULL outside the condition, and MySQL never compares a NULL key
      const first = index.columns[0];
      if (!first) throw new Error(`${at}: a partial unique key needs at least one column`);
      const rest = index.columns.slice(1).map(expr);
      const firstExpr = expr({ ...first, desc: false });
      return {
        sql: `UNIQUE KEY ${q(indexName('uq', qualified, n))} ((IF(${index.where.sql}, ${firstExpr}, NULL))${rest.length ? `, ${rest.join(', ')}` : ''})`,
        note: `partial unique on ${index.columns.map((c) => c.name).join(', ')} where ${index.where.sql}`,
      };
    }
    // a plain partial index: MySQL has no partial indexes, so the condition's columns are appended and filtered
    // inside the index. Appending rather than leading keeps the index usable for the lookup it was declared for;
    // Y2 confirms each one with EXPLAIN and reorders where the query wants it (§6.1, Appendix A).
    const wanted = index.where.columns.filter((c) => !index.columns.some((k) => k.name === c));
    for (const c of wanted) if (!columns.has(c)) throw new Error(`${at}: the index condition names "${c}", which is not a column`);
    // a condition on a column MySQL cannot key is left out: the index still serves the lookup and the condition
    // is checked per row. Appendix A's answer where it matters is a generated flag column (wallet.gift_card_batches
    // becomes `has_codes`), which Y2 adds with the query in front of it.
    const dropped = wanted.filter((c) => notIndexable(c));
    const extra = wanted.filter((c) => !notIndexable(c));
    const all = [...index.columns.map(expr), ...extra.map(q)];
    const notes = [
      `partial index: ${index.columns.map((c) => c.name).join(', ')}${extra.length ? ` plus ${extra.join(', ')}` : ''} from "where ${index.where.sql}" — confirm the column order with EXPLAIN in Y2`,
      ...dropped.map((c) => `the condition's ${c} is left out of the key: it is ${notIndexable(c)}. A generated flag column would put it back (§6.1, Appendix A)`),
    ];
    return { sql: `KEY ${q(indexName('ix', qualified, n))} (${all.join(', ')})`, note: notes.join('; ') };
  }

  for (const c of index.columns) if (!columns.has(c.name)) throw new Error(`${at}: the index names "${c.name}", which is not a column`);
  // a plain index over an array or JSON column is not a thing in MySQL: §8.1 makes it a child table or a
  // multi-valued index, and which one depends on the query, so the spec has to say
  const unkeyable = index.columns.map((c) => c.name).filter((n) => notIndexable(n));
  if (unkeyable.length) {
    return {
      note:
        `no key for (${index.columns.map((c) => c.name).join(', ')}): ${unkeyable.join(', ')} is ${notIndexable(unkeyable[0]!)}. ` +
        `§8.1 makes this a child table or a multi-valued index — write the one the query needs in the spec as gin(...) or a child table`,
    };
  }
  const parts = index.columns.map(expr).join(', ');
  return { sql: index.unique ? `UNIQUE KEY ${q(indexName('uq', qualified, n))} (${parts})` : `KEY ${q(indexName('ix', qualified, n))} (${parts})` };
}
