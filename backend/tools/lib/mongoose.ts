/**
 * Spec tables → each module's generated Mongoose schemas (src/modules/<m>/schema.ts,
 * docs/04-mongodb-migration.md §3): one schema per collection `<module>.<table>`, with the field types, NOT NULL,
 * enum values, checks and indexes of the spec (the same collection definitions as lib/mongo.ts).
 */
import type { CollectionDef } from './mongo.js';
import type { ModuleSpec } from './spec.js';
import type { Column, TablePlan } from './tables.js';

const str = (s: string) => JSON.stringify(s);
const ident = (s: string) => (/^[a-z_$][a-z0-9_$]*$/i.test(s) ? s : str(s));
const RESERVED = new Set(['default', 'delete', 'new', 'class', 'function', 'return', 'export', 'import', 'package', 'public', 'private', 'static', 'interface', 'enum', 'case', 'switch', 'in', 'do', 'for', 'if', 'var', 'let', 'const', 'with', 'yield', 'void', 'typeof', 'this', 'super', 'null', 'true', 'false', 'try', 'catch', 'finally', 'throw', 'while', 'break', 'continue', 'debugger', 'else', 'extends', 'instanceof', 'await']);
/** A table's variable name in the generated file */
const varOf = (table: string) => {
  const v = table.replace(/[^a-z0-9_]/gi, '_');
  return RESERVED.has(v) ? `${v}Schema` : v;
};

/** The Mongoose type of a column's base SQL type */
function typeOf(sqlType: string): string {
  const base = sqlType.replace(/\(.*\)/, '');
  if (base.endsWith('[]')) return `[${typeOf(base.slice(0, -2))}]`;
  switch (base) {
    case 'int':
    case 'integer':
    case 'smallint':
    case 'bigint':
    case 'bigserial':
    case 'serial':
      return 'Number';
    case 'numeric':
      return 'Schema.Types.Decimal128';
    case 'bool':
    case 'boolean':
      return 'Boolean';
    case 'timestamptz':
    case 'timestamp':
      return 'Date';
    case 'bytea':
      return 'Buffer';
    case 'jsonb':
    case 'json':
      return 'Schema.Types.Mixed';
    default:
      return 'String';
  }
}

function field(c: Column): string {
  const base = c.sqlType.replace(/\(.*\)/, '');
  const array = base.endsWith('[]');
  const parts = [`type: ${typeOf(c.sqlType)}`];
  // arrays: Mongoose's required means "not empty"; json: a NOT NULL jsonb column may hold JSON null (a value in
  // the spec, null in MongoDB). The database validator requires both to be present instead.
  const json = base === 'jsonb' || base === 'json';
  if (!c.nullable && !array && !json) parts.push('required: true');
  if (c.nullable) parts.push('default: null');
  else if (array) parts.push('default: undefined');
  if (c.enumValues) parts.push(`enum: ${JSON.stringify(c.nullable ? [...c.enumValues, null] : c.enumValues)}`);
  if (/^(int|integer|smallint|bigint|bigserial|serial)$/.test(base)) {
    const check = c.check && /\s(>=|>)\s*(-?\d+(?:\.\d+)?)$/.exec(c.check);
    if (check?.[1] === '>=') parts.push(`min: ${check[2]}`, 'validate: integer');
    else if (check?.[1] === '>' && check[2] === '0') parts.push('validate: [integer, positive]');
    else parts.push('validate: integer');
  } else if (c.check) {
    const check = /\s(>=|>)\s*(-?\d+(?:\.\d+)?)$/.exec(c.check);
    if (check?.[1] === '>=') parts.push(`min: ${check[2]}`);
    else if (check?.[1] === '>' && check[2] === '0') parts.push('validate: positive');
  }
  if (base === 'date') parts.push('match: DATE');
  return `{ ${parts.join(', ')} }`;
}

/** The generated schema file of one module */
export function emitMongooseSchemas(mod: ModuleSpec, plans: TablePlan[], defs: Record<string, CollectionDef>, header: string): string {
  const out: string[] = [header.trimEnd()];
  out.push(`/**
 * Mongoose schemas of the ${mod.name} module's collections (docs/04-mongodb-migration.md): one per spec table,
 * collection \`${mod.name}.<table>\`. A single-column primary key is stored as _id; numeric is Decimal128, bytea a
 * Buffer, json Mixed. The kernel creates the collections with their database validator and syncs these indexes
 * (kernel/mongo/schema.ts); repositories reach them through ctx.mongo.table(name).
 */
import { Schema } from 'mongoose';
import { __HELPERS__ } from '../../kernel/mongo/schemas.js';
`);
  for (const { table, columns } of plans) {
    const def = defs[table.name]!;
    const v = varOf(table.name);
    const lines: string[] = [];
    for (const c of columns) {
      if (c.sqlType === 'tsvector') continue;
      const note = c.comment ? ` // ${c.comment.replace(/\s+/g, ' ').slice(0, 140)}` : '';
      if (c.name === def.idField) lines.push(`    _id: ${field({ ...c, nullable: false })}, // ${c.name}${c.comment ? `: ${c.comment.replace(/\s+/g, ' ').slice(0, 120)}` : ''}`);
      else lines.push(`    ${ident(c.name)}: ${field(c)},${note}`);
    }
    lines.push('    /** lock-by-write counter (kernel/mongo/table.ts) */');
    lines.push('    _lock: Number,');
    if (table.desc) out.push(`/** ${table.desc.replace(/\*\//g, '* /')} */`);
    out.push(`const ${v} = new Schema(\n  {\n${lines.join('\n')}\n  },\n  collectionOptions(${str(`${mod.name}.${table.name}`)}${def.idField ? '' : ', { generatedId: true }'}),\n);`);
    for (const i of def.indexes) {
      const opts = { name: i.name, ...(i.unique ? { unique: true } : {}), ...(i.partial ? { partialFilterExpression: i.partial } : {}), ...(i.collation ? { collation: i.collation } : {}) };
      out.push(`${v}.index(${JSON.stringify(i.key)}, ${JSON.stringify(opts)});`);
    }
    for (const u of def.unenforced) out.push(`// not enforced by MongoDB yet (the repository enforces it, docs/04 §2): ${u.replace(/\n/g, ' ')}`);
    out.push('');
  }
  // import only the helpers the schemas use (the import line itself names none of them)
  const body = out.join('\n');
  const schemasPart = body.slice(body.indexOf('\nconst ') + 1);
  const helpers = ['collectionOptions', ...['DATE', 'integer', 'positive'].filter((h) => new RegExp(`\\b${h}\\b`).test(schemasPart))].sort((a, b) =>
    a.localeCompare(b, 'en', { sensitivity: 'base' }),
  );
  out.splice(0, out.length, body.replace('__HELPERS__', helpers.join(', ')));
  out.push(`/** Table name → schema */
export const schemas = {
${plans.map(({ table }) => `  ${ident(table.name)}: ${varOf(table.name)},`).join('\n')}
};
`);
  return out.join('\n');
}
