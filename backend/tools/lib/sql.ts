/**
 * Table notation (docs/api/spec/modules/*.json "tables") → PostgreSQL DDL and Kysely row types.
 *
 * Column notation: `<type>[?] [pk] [unique] [→ table] [check <expr>] [(comment)]`, e.g.
 *   "uuid pk", "uuid? → items", "text unique (MK-YYMMDD-NNNNN)", "int check >= 0", "text (open|closed)".
 * A parenthesised list of plain words separated by | becomes a CHECK constraint.
 * Index notation: "(a, b)", "unique (a) where …", "(a, b) unique", "unique nulls not distinct (a, b)" (null keys count as
 * equal: one row per key even when some key columns are null), "pk (a, b)", "gin(expr)".
 */
import { snake, type ModuleSpec, type TableSpec } from './spec.js';

export interface Column {
  name: string;
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
  let check = checkM ? `${ident(name)} ${checkM[1]!.trim()}` : null;
  const kept: string[] = [];
  for (const c of comments) {
    if (/^[a-z0-9_-]+(\|[a-z0-9_-]+)+$/.test(c)) enumValues = c.split('|');
    else if (c === 'identity') identity = true;
    else if (pk && /^\d+$/.test(c)) check = `${ident(name)} = ${c}`;
    else kept.push(c);
  }
  return { name, sqlType, nullable, pk, unique, ref: refM ? refM[1]! : null, check, enumValues, identity, comment: kept.join('; ') || null };
}

/** Postgres column type → TypeScript type of the value Kysely returns (see kernel/db type parsers). */
const TS_OF_SQL: Record<string, string> = {
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
  // everything else is text in JS: uuid, text, char, date (parsed as text), time, inet, numeric (exact), tsvector
  let ts = TS_OF_SQL[t] ?? 'string';
  if (c.enumValues && ts === 'string') ts = c.enumValues.map((v) => `'${v}'`).join(' | ');
  if (arr) ts = `${ts.includes('|') ? `(${ts})` : ts}[]`;
  if (c.nullable || t === 'tsvector') ts += ' | null';
  if (base === 'bigserial' || c.identity) ts = `Generated<${ts}>`;
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

/** PostgreSQL reserved words cannot be bare column names (e.g. finance.recon_items.check). */
const RESERVED = new Set('all analyse analyze and any array as asc asymmetric authorization binary both case cast check collate collation column concurrently constraint create cross current_catalog current_date current_role current_schema current_time current_timestamp current_user default deferrable desc distinct do else end except false fetch for foreign freeze from full grant group having ilike in initially inner intersect into is isnull join lateral leading left like limit localtime localtimestamp natural not notnull null offset on only or order outer overlaps placing primary references returning right select session_user similar some symmetric system_user table tablesample then to trailing true union unique user using variadic verbose when where window with'.split(' '));
export const ident = (name: string) => (RESERVED.has(name.toLowerCase()) ? `"${name}"` : name);

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** The module's first migration: every table, constraint and index of its spec. */
export function migrationSql(mod: ModuleSpec, plans: TablePlan[], problems: string[]): string {
  const schema = snake(mod.name);
  const q = (t: string) => `${schema}.${t}`;
  const out: string[] = [];
  const after: string[] = [];
  const pkOf = new Map<string, string | null>();
  for (const { table, columns } of plans) {
    const compositePk = (table.indexes ?? []).find((i) => /^pk\s*\(/.test(i));
    pkOf.set(table.name, compositePk ? null : (columns.find((c) => c.pk)?.name ?? null));
  }
  for (const { table, columns } of plans) {
    const lines: string[] = [];
    for (const c of columns) {
      if (c.sqlType === 'tsvector') {
        lines.push(`  ${c.name} tsvector`);
        continue;
      }
      const parts = [`  ${ident(c.name)} ${c.sqlType}`];
      if (c.identity) parts.push('generated always as identity');
      if (!c.nullable && !c.pk) parts.push('not null');
      if (c.pk) parts.push('primary key');
      if (c.unique) parts.push('unique');
      if (c.enumValues) parts.push(`check (${ident(c.name)} in (${c.enumValues.map(lit).join(', ')}))`);
      if (c.check) parts.push(`check (${c.check})`);
      lines.push(parts.join(' '));
      if (c.ref) {
        const [tName, tCol] = c.ref.split('.') as [string, string?];
        if (!plans.some((p) => p.table.name === tName)) {
          problems.push(`${mod.name}.${table.name}.${c.name}: references unknown table "${c.ref}" (no cross-module foreign keys)`);
        } else {
          const col = tCol ?? pkOf.get(tName);
          if (col) after.push(`alter table ${q(table.name)} add foreign key (${ident(c.name)}) references ${q(tName)} (${ident(col)});`);
        }
      }
    }
    for (const idx of table.indexes ?? []) {
      const pk = /^pk\s*\((.+)\)$/.exec(idx);
      if (!pk) continue;
      const keyCols = pk[1]!.split(',').map((x) => x.trim());
      // A key column the spec allows to be null (e.g. "null = all categories") can't be in a primary key:
      // keep one row per key with a unique constraint that treats nulls as equal
      const nullableKey = keyCols.some((k) => columns.find((c) => c.name === k)?.nullable);
      lines.push(`  ${nullableKey ? 'unique nulls not distinct' : 'primary key'} (${keyCols.map(ident).join(', ')})`);
    }
    out.push(`create table ${q(table.name)} (\n${lines.join(',\n')}\n);`);
    if (table.desc) out.push(`comment on table ${q(table.name)} is ${lit(table.desc)};`);
    for (const c of columns) if (c.comment) out.push(`comment on column ${q(table.name)}.${ident(c.name)} is ${lit(c.comment)};`);
    for (const idx of table.indexes ?? []) {
      if (/^pk\s*\(/.test(idx)) continue;
      const sql = indexSql(idx, q(table.name));
      if (sql) out.push(sql);
      else problems.push(`${mod.name}.${table.name}: cannot parse index "${idx}"`);
    }
  }
  return [...out, ...after].join('\n');
}

function indexSql(idx: string, table: string): string | null {
  let s = idx.trim();
  let unique = false;
  let where = '';
  const w = /\swhere\s(.+)$/i.exec(s);
  if (w) {
    where = ` where ${w[1]}`;
    s = s.slice(0, w.index).trim();
  }
  let nullsNotDistinct = false;
  if (/^unique\s+nulls\s+not\s+distinct\b/i.test(s)) {
    nullsNotDistinct = true;
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
  let using = '';
  const gin = /^gin\s*\((.+)\)$/.exec(s);
  if (gin) {
    using = ' using gin';
    s = `(${gin[1]})`;
  }
  if (!/^\(.+\)$/.test(s)) return null;
  // to_tsvector() without a configuration is not immutable and cannot be indexed
  s = s.replace(/to_tsvector\((?!\s*')/g, "to_tsvector('simple', ");
  // expressions inside an index column list need their own parentheses
  const cols = splitTopLevel(s.slice(1, -1)).map((raw) => {
    const c = raw.trim();
    if (/\(/.test(c) && !/^\(/.test(c) && !/^\w+\s+\w+_ops$/.test(c)) return `(${c})`;
    return c.replace(/^\w+/, (w) => ident(w));
  });
  return `create ${unique ? 'unique ' : ''}index on ${table}${using} (${cols.join(', ')})${nullsNotDistinct ? ' nulls not distinct' : ''}${where};`;
}

function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  let quote = false;
  for (const ch of s) {
    if (ch === "'") quote = !quote;
    if (!quote && ch === '(') depth++;
    if (!quote && ch === ')') depth--;
    if (!quote && depth === 0 && ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}
