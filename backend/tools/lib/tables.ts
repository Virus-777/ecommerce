/**
 * Table notation (docs/api/spec/modules/*.json "tables", docs/api/spec/FORMAT.md) → parsed columns and row types.
 * lib/mongo.ts and lib/mongoose.ts turn the parsed tables into MongoDB collections (validators, indexes, Mongoose
 * schemas); lib/emit.ts writes the row types.
 *
 * Column notation: `<type>[?] [pk] [unique] [→ table] [check <expr>] [(comment)]`, e.g.
 *   "uuid pk", "uuid? → items", "text unique (MK-YYMMDD-NNNNN)", "int check >= 0", "text (open|closed)".
 * A parenthesised list of plain words separated by | is the column's set of allowed values.
 * Index notation: "(a, b)", "unique (a) where …", "(a, b) unique", "unique nulls not distinct (a, b)" (null keys count as
 * equal: one row per key even when some key columns are null), "pk (a, b)", "gin(expr)".
 */
import type { ModuleSpec, TableSpec } from './spec.js';

export interface Column {
  name: string;
  /** The type as the spec writes it: uuid, text, int, numeric(12,2), timestamptz, jsonb, text[] … */
  sqlType: string;
  nullable: boolean;
  pk: boolean;
  unique: boolean;
  ref: string | null;
  check: string | null;
  enumValues: string[] | null;
  identity: boolean;
  comment: string | null;
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
    return { name, sqlType: 'text', nullable: true, pk: false, unique: false, ref: null, check: null, enumValues: null, identity: false, comment: notation };
  }
  const sqlType = m[1]!;
  let flags = m[2]!;
  const pk = /\bpk\b/.test(flags);
  const unique = /\bunique\b/.test(flags);
  const refM = /→\s*([\w.]+)/.exec(flags);
  const checkM = /\bcheck\s+(.+)$/.exec(flags);
  flags = flags.replace(/\bpk\b|\bunique\b|→\s*[\w.]+|\bcheck\s+.+$/g, '').trim();
  if (flags) problems.push(`${where}: unknown column flags "${flags}" in "${notation}"`);
  let enumValues: string[] | null = null;
  let identity = false;
  let check = checkM ? `${name} ${checkM[1]!.trim()}` : null;
  const kept: string[] = [];
  for (const c of comments) {
    if (/^[a-z0-9_-]+(\|[a-z0-9_-]+)+$/.test(c)) enumValues = c.split('|');
    else if (c === 'identity') identity = true;
    else if (pk && /^\d+$/.test(c)) check = `${name} = ${c}`;
    else kept.push(c);
  }
  return { name, sqlType, nullable, pk, unique, ref: refM ? refM[1]! : null, check, enumValues, identity, comment: kept.join('; ') || null };
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
