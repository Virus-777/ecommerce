/**
 * Table notation (docs/api/spec/modules/*.json "tables", docs/api/spec/FORMAT.md) → parsed columns and row types.
 * lib/mongo.ts and lib/mongoose.ts turn the parsed tables into MongoDB collections (validators, indexes, Mongoose
 * schemas); lib/emit.ts writes the row types.
 *
 * Column notation: `<type>[?] [pk] [unique] [ci] [→ table [cascade|nofk]] [check <expr>] [(comment)]`, e.g.
 *   "uuid pk", "uuid? → items", "uuid → orders cascade", "text unique ci", "int check >= 0", "text (open|closed)".
 * A parenthesised list of plain words separated by | is the column's set of allowed values.
 * `varchar(n)`, `mediumtext` and `longtext` are text with a size; MongoDB stores them as strings either way.
 * `ci` and the foreign-key options are read only by the MySQL generator (docs/10-mysql-migration.md §5.2, §6.2).
 * Index notation: "(a, b)", "unique (a) where …", "(a, b) unique", "unique nulls not distinct (a, b)" (null keys count as
 * equal: one row per key even when some key columns are null), "pk (a, b)", "gin(expr)".
 */
import type { ModuleSpec, TableSpec } from './spec.js';

export interface Column {
  name: string;
  /** The type as the spec writes it: uuid, text, varchar(120), mediumtext, int, numeric(12,2), timestamptz, jsonb, text[] … */
  sqlType: string;
  nullable: boolean;
  pk: boolean;
  unique: boolean;
  ref: string | null;
  check: string | null;
  enumValues: string[] | null;
  identity: boolean;
  comment: string | null;
  /**
   * `ci`: compare and sort without case, so a unique key treats `ABC` and `abc` as one value and `LIKE` uses the
   * index. MySQL gives the column `utf8mb4_0900_as_ci`; accents still count. MongoDB passes a collation per query
   * instead, so this is a no-op there (docs/10-mysql-migration.md §5.2).
   */
  caseInsensitive: boolean;
  /**
   * What becomes of this row when the row it points at is deleted (docs/10-mysql-migration.md §6.2; MySQL only).
   * `restrict` (the default) refuses the delete while children exist. `cascade` is for a pure child list the code
   * already deletes with its parent. `nofk` writes no foreign key at all — for an append-only log whose parent is
   * so hot that the key's shared lock would be felt.
   */
  refOption: 'restrict' | 'cascade' | 'nofk';
}

export function parseColumn(name: string, notation: string, where: string, problems: string[]): Column {
  const comments: string[] = [];
  // comments are parentheses preceded by whitespace; type modifiers such as numeric(5,2) are attached
  let rest = notation.replace(/\s\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g, (_, c: string) => {
    comments.push(c.trim());
    return ' ';
  });
  const nullable = rest.includes('?');
  rest = rest.replace(/\?/g, ' ').replace(/\s+/g, ' ').trim();
  const m = /^([a-z]+(?:\(\d+(?:,\d+)?\))?(?:\[\])?)\s*(.*)$/.exec(rest);
  if (!m) {
    problems.push(`${where}: cannot parse column "${notation}"`);
    return { name, sqlType: 'text', nullable: true, pk: false, unique: false, ref: null, check: null, enumValues: null, identity: false, comment: notation, caseInsensitive: false, refOption: 'restrict' };
  }
  const sqlType = m[1]!;
  let flags = m[2]!;
  const pk = /\bpk\b/.test(flags);
  const unique = /\bunique\b/.test(flags);
  const caseInsensitive = /\bci\b/.test(flags);
  const refM = /→\s*([\w.]+)(?:\s+(cascade|nofk))?/.exec(flags);
  const checkM = /\bcheck\s+(.+)$/.exec(flags);
  // check is stripped last: its expression runs to the end of the notation and would swallow a later flag
  flags = flags.replace(/\bpk\b|\bunique\b|\bci\b|→\s*[\w.]+(?:\s+(?:cascade|nofk))?|\bcheck\s+.+$/g, '').trim();
  if (flags) problems.push(`${where}: unknown column flags "${flags}" in "${notation}"`);
  const refOption = (refM?.[2] as 'cascade' | 'nofk' | undefined) ?? 'restrict';
  if (!refM && refOption !== 'restrict') problems.push(`${where}: "${refOption}" needs a reference (→ table) in "${notation}"`);
  let enumValues: string[] | null = null;
  // `bigserial` *is* an identity column: PostgreSQL numbered it from a sequence, MongoDB numbers it from a
  // kernel counter and MySQL from AUTO_INCREMENT. Only `(identity)` used to say so, which left the one
  // bigserial in the spec (identity.sign_in_attempts.id) as a plain BIGINT that every insert had to fill —
  // 1364 on MySQL, and before that a hand-numbered column inside a transaction, which is a pool deadlock
  // waiting to happen (docs/10 §10.5e, audit's seq).
  let identity = /^(?:big)?serial\b/.test(sqlType);
  let check = checkM ? `${name} ${checkM[1]!.trim()}` : null;
  const kept: string[] = [];
  for (const c of comments) {
    if (/^[a-z0-9_-]+(\|[a-z0-9_-]+)+$/.test(c)) enumValues = c.split('|');
    else if (c === 'identity') identity = true;
    else if (pk && /^\d+$/.test(c)) check = `${name} = ${c}`;
    else kept.push(c);
  }
  return { name, sqlType, nullable, pk, unique, ref: refM ? refM[1]! : null, check, enumValues, identity, comment: kept.join('; ') || null, caseInsensitive, refOption };
}

/** Spec column type → TypeScript type of the value a repository reads (kernel/mongo/table.ts converts documents) */
const TS_OF_TYPE: Record<string, string> = {
  ...Object.fromEntries(['int', 'integer', 'smallint', 'bigint', 'bigserial', 'serial'].map((t) => [t, 'number'])),
  bool: 'boolean',
  boolean: 'boolean',
  timestamptz: 'Date',
  timestamp: 'Date',
  jsonb: 'Json',
  json: 'Json',
  bytea: 'Uint8Array',
};

export function tsOfColumn(c: Column): string {
  const base = c.sqlType.replace(/\(.*\)/, '');
  const arr = base.endsWith('[]');
  const t = arr ? base.slice(0, -2) : base;
  // everything else is text in JS: uuid, text, char, date (YYYY-MM-DD), time, inet, numeric (exact), tsvector
  let ts = TS_OF_TYPE[t] ?? 'string';
  if (c.enumValues && ts === 'string') ts = c.enumValues.map((v) => `'${v}'`).join(' | ');
  if (arr) ts = `${ts.includes('|') ? `(${ts})` : ts}[]`;
  if (c.nullable || t === 'tsvector') ts += ' | null';
  return ts;
}

export interface TablePlan {
  table: TableSpec;
  columns: Column[];
}

export function planTables(mod: ModuleSpec, problems: string[]): TablePlan[] {
  return (mod.tables ?? []).map((t) => ({
    table: t,
    columns: Object.entries(t.columns).map(([n, v]) => parseColumn(n, v, `${mod.name}.${t.name}.${n}`, problems)),
  }));
}
