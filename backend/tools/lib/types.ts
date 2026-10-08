/**
 * Translates the spec's type notation (docs/api/spec/FORMAT.md, "Type notation") into
 * TypeScript types and Zod schemas. Resolution order matches docs/api/tools/build.mjs:
 * primitives, common.json types, `module.Type`, then the module's own types.
 */
import { camel, doc, propKey, type ModuleSpec, type ObjectExpr, type TypeExpr } from './spec.js';

export type Mode = 'data' | 'query';

type Node =
  | { k: 'prim'; name: string }
  | { k: 'enum'; values: string[] }
  | { k: 'array'; of: Parsed }
  | { k: 'map'; of: Parsed }
  | { k: 'page'; of: Parsed }
  | { k: 'ref'; ns: string | null; name: string }
  | { k: 'object'; fields: [string, Parsed][] };

export interface Parsed {
  node: Node;
  optional: boolean;
  desc?: string;
  /** Sensitive field: masked for staff and sellers without the permission */
  sensitive?: { permission: string; mask: string };
}

/** Spec primitive → TypeScript type, Zod schema, and Zod schema in a query string (where values arrive as text) */
const PRIM: Record<string, { ts: string; zod: string; query?: string }> = {
  string: { ts: 'string', zod: 'z.string()' },
  text: { ts: 'string', zod: 'z.string()' },
  int: { ts: 'number', zod: 'z.number().int()', query: 'z.coerce.number().int()' },
  number: { ts: 'number', zod: 'z.number()', query: 'z.coerce.number()' },
  bool: { ts: 'boolean', zod: 'z.boolean()', query: 'z.stringbool()' },
  json: { ts: 'unknown', zod: 'z.unknown()' },
  uuid: { ts: 'string', zod: 'z.uuid()' },
  email: { ts: 'string', zod: 'z.email()' },
  url: { ts: 'string', zod: 'z.url()' },
  date: { ts: 'string', zod: 'z.iso.date()' },
  datetime: { ts: 'string', zod: 'z.iso.datetime({ offset: true })' },
};

/** A field descriptor { type, desc?, permission?, mask? }, as opposed to an object with a field named "type" */
const DESCRIPTOR_KEYS = new Set(['type', 'desc', 'permission', 'mask']);
const isDescriptor = (e: object): boolean => typeof (e as { type?: unknown }).type === 'string' && Object.keys(e).every((k) => DESCRIPTOR_KEYS.has(k));

export class TypeContext {
  /** Other spec files this module's generated file must import (module names), plus 'common'. */
  readonly imports = new Set<string>();
  readonly problems: string[] = [];
  readonly warnings: string[] = [];

  constructor(
    readonly mod: ModuleSpec | null,
    readonly commonTypes: Set<string>,
    readonly byName: Map<string, ModuleSpec>,
  ) {}

  parse(expr: TypeExpr, where: string): Parsed {
    if (expr && typeof expr === 'object' && !Array.isArray(expr)) {
      if (isDescriptor(expr)) {
        const e = expr as { type: string; desc?: string; permission?: string; mask?: string };
        const p = this.parse(e.type, where);
        return { ...p, desc: e.desc ?? p.desc, ...(e.permission ? { sensitive: { permission: e.permission, mask: e.mask ?? 'hide' } } : {}) };
      }
      return { node: this.object(expr as ObjectExpr, where), optional: false };
    }
    if (typeof expr !== 'string') {
      this.problems.push(`${where}: bad type ${JSON.stringify(expr)}`);
      return { node: { k: 'prim', name: 'json' }, optional: false };
    }
    let t = expr.trim();
    let optional = false;
    if (t.endsWith('?')) {
      optional = true;
      t = t.slice(0, -1).trim();
    }
    return { node: this.node(t, where), optional };
  }

  private node(t: string, where: string): Node {
    if (t.endsWith('[]')) return { k: 'array', of: { node: this.node(t.slice(0, -2), where), optional: false } };
    if (/^enum\(.+\)$/.test(t)) return { k: 'enum', values: t.slice(5, -1).split('|').map((s) => s.trim()) };
    if (/^map<.+>$/.test(t)) return { k: 'map', of: this.parse(t.slice(4, -1), where) };
    if (/^Page<.+>$/.test(t)) return { k: 'page', of: this.parse(t.slice(5, -1), where) };
    if (t in PRIM) return { k: 'prim', name: t };
    if (this.commonTypes.has(t)) {
      this.useCommon();
      return { k: 'ref', ns: this.mod ? 'common' : null, name: t };
    }
    if (t.includes('.')) {
      const [m, name] = t.split('.') as [string, string];
      const target = this.byName.get(m);
      if (!target?.types?.[name]) this.problems.push(`${where}: unknown type ${t}`);
      if (m === this.mod?.name) return { k: 'ref', ns: null, name };
      this.imports.add(m);
      return { k: 'ref', ns: camel(m), name };
    }
    if (this.mod?.types?.[t]) return { k: 'ref', ns: null, name: t };
    this.problems.push(`${where}: unknown type "${t}"`);
    return { k: 'prim', name: 'json' };
  }

  private object(obj: ObjectExpr, where: string): Node {
    return { k: 'object', fields: Object.entries(obj).map(([k, v]) => [k, this.parse(v, `${where}.${k}`)]) };
  }

  objectParsed(obj: ObjectExpr, where: string): Parsed {
    return { node: this.object(obj, where), optional: false };
  }

  /* ------------------------------------------------------------ TypeScript */

  ts(p: Parsed, indent = ''): string {
    const n = p.node;
    switch (n.k) {
      case 'prim':
        return PRIM[n.name]!.ts;
      case 'enum':
        return n.values.map((v) => JSON.stringify(v)).join(' | ');
      case 'array': {
        const inner = this.ts(n.of, indent);
        return /[|&\s]/.test(inner) && !inner.startsWith('{') ? `(${inner})[]` : `${inner}[]`;
      }
      case 'map':
        return `Record<string, ${this.tsValue(n.of, indent)}>`;
      case 'page':
        this.useCommon();
        return `${this.c()}Page<${this.tsValue(n.of, indent)}>`;
      case 'ref':
        return n.ns ? `${n.ns}.${n.name}` : n.name;
      case 'object':
        return this.tsObject(n.fields, indent);
    }
  }

  /** A value whose optionality is expressed as `| null` (array items, map values). */
  private tsValue(p: Parsed, indent: string): string {
    const t = this.ts(p, indent);
    return p.optional ? `${t} | null` : t;
  }

  tsObject(fields: [string, Parsed][], indent: string): string {
    if (!fields.length) return 'Record<string, never>';
    const inner = `${indent}  `;
    const lines = fields.map(([k, f]) => {
      // `json` fields are optional in Zod's output type, so they are optional here too
      const opt = f.optional || (f.node.k === 'prim' && f.node.name === 'json');
      return `${doc(f.desc, inner)}${inner}${propKey(k)}${opt ? '?' : ''}: ${this.ts(f, inner)}${f.optional ? ' | null' : ''};`;
    });
    return `{\n${lines.join('\n')}\n${indent}}`;
  }

  /* ------------------------------------------------------------ Zod */

  /** Zod expression, and whether it references a named type (then it must be read lazily). */
  zod(p: Parsed, mode: Mode, indent = ''): { code: string; lazy: boolean } {
    const n = p.node;
    let code: string;
    let lazy = false;
    switch (n.k) {
      case 'prim':
        code = (mode === 'query' && PRIM[n.name]!.query) || PRIM[n.name]!.zod;
        break;
      case 'enum':
        code = `z.enum([${n.values.map((v) => JSON.stringify(v)).join(', ')}])`;
        break;
      case 'array': {
        const inner = this.zod(n.of, mode, indent);
        lazy = inner.lazy;
        code = mode === 'query' ? `${this.c()}queryArray(${inner.code})` : `z.array(${inner.code})`;
        if (mode === 'query') this.useCommon();
        break;
      }
      case 'map': {
        const inner = this.zodValue(n.of, indent);
        lazy = inner.lazy;
        code = `z.record(z.string(), ${inner.code})`;
        break;
      }
      case 'page': {
        const inner = this.zodValue(n.of, indent);
        lazy = inner.lazy;
        this.useCommon();
        code = `${this.c()}page(${inner.code})`;
        break;
      }
      case 'ref':
        lazy = true;
        code = n.ns ? `${n.ns}.${n.name}` : n.name;
        break;
      case 'object':
        code = this.zodObject(n.fields, mode, indent);
        break;
    }
    if (p.desc && !lazy && n.k !== 'object') code += `.describe(${JSON.stringify(p.desc)})`;
    return { code, lazy };
  }

  private zodValue(p: Parsed, indent: string) {
    const r = this.zod(p, 'data', indent);
    return p.optional ? { code: `${r.code}.nullable()`, lazy: r.lazy } : r;
  }

  zodObject(fields: [string, Parsed][], mode: Mode, indent: string): string {
    if (!fields.length) return 'z.object({})';
    const inner = `${indent}  `;
    const lines = fields.map(([k, f]) => {
      const key = propKey(k);
      const r = this.zod(f, mode, inner);
      const code = f.optional ? `${r.code}${mode === 'query' ? '.optional()' : '.nullish()'}` : r.code;
      return r.lazy ? `${inner}get ${key}() {\n${inner}  return ${code};\n${inner}},` : `${inner}${key}: ${code},`;
    });
    return `z.object({\n${lines.join('\n')}\n${indent}})`;
  }

  private c() {
    return this.mod ? 'common.' : '';
  }

  private useCommon() {
    if (this.mod) this.imports.add('common');
  }
}

/* ------------------------------------------------------------ public API signatures */

const TS_BUILTINS = new Set(['Partial', 'Record', 'Map', 'Promise', 'ReadableStream', 'Array', 'Pick', 'Omit', 'Uint8Array', 'Buffer', 'null', 'void', 'undefined', 'true', 'false', 'string', 'number', 'boolean', 'unknown', 'never']);

/**
 * Converts a publicApi signature such as
 *   (customerId: uuid, opts: { listId?: uuid, paging: PageInput }) => Paged<SavedItem>
 * into a TypeScript method signature with a Promise return type.
 */
export function translateSignature(sig: string, ctx: TypeContext, where: string): { generics: string; params: string; returns: string } {
  let s = sig.trim();
  let generics = '';
  const g = /^<([^>]+)>\s*/.exec(s);
  if (g) {
    generics = `<${g[1]}>`;
    s = s.slice(g[0].length);
  }
  const typeParams = new Set(g ? g[1]!.split(',').map((x) => x.trim()) : []);
  if (!s.startsWith('(')) throw new Error(`${where}: signature must start with "(": ${sig}`);
  let depth = 0;
  let end = -1;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const params = s.slice(1, end);
  const rest = s.slice(end + 1).trim();
  if (!rest.startsWith('=>')) throw new Error(`${where}: signature needs "=> ReturnType": ${sig}`);
  const returns = rest.slice(2).trim();
  const conv = (x: string) => convertTypeText(x, ctx, typeParams, where);
  return { generics, params: conv(params), returns: conv(returns) };
}

function convertTypeText(text: string, ctx: TypeContext, typeParams: Set<string>, where: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === "'" || ch === '"') {
      const j = text.indexOf(ch, i + 1);
      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    const m = /^[A-Za-z_][\w]*(?:\.[A-Za-z_]\w*)?/.exec(text.slice(i));
    if (!m) {
      out += ch;
      i++;
      continue;
    }
    const word = m[0];
    const after = text.slice(i + word.length);
    i += word.length;
    // a property or parameter name: followed by ':' or '?:'; a method name: followed by '('
    if (/^\s*\??\s*:/.test(after) || after.startsWith('(')) {
      out += word;
      continue;
    }
    // an untyped optional key in an inline object: { kind?, categoryId? }
    const bare = /^\?\s*(?=[,}])/.exec(after);
    if (bare) {
      out += `${word}?: unknown`;
      i += bare[0].length;
      continue;
    }
    if (word === 'map' && after.startsWith('<')) {
      out += 'Record<string, ';
      i += 1;
      continue;
    }
    out += mapIdent(word, ctx, typeParams, where);
  }
  return out;
}

function mapIdent(word: string, ctx: TypeContext, typeParams: Set<string>, where: string): string {
  if (typeParams.has(word)) return word;
  if (word in PRIM) return PRIM[word]!.ts;
  if (word === 'Page' || word === 'Paged') {
    ctx.imports.add('common');
    return 'common.Page';
  }
  if (word === 'PageInput' && !ctx.mod?.types?.PageInput) {
    ctx.imports.add('common');
    return 'common.PageInput';
  }
  if (ctx.mod?.types?.[word]) return word;
  if (ctx.commonTypes.has(word)) {
    ctx.imports.add('common');
    return `common.${word}`;
  }
  if (word.includes('.')) {
    const [m, name] = word.split('.') as [string, string];
    if (ctx.byName.get(m)?.types?.[name]) {
      if (m === ctx.mod?.name) return name;
      ctx.imports.add(m);
      return `${camel(m)}.${name}`;
    }
  }
  if (TS_BUILTINS.has(word)) return word;
  ctx.warnings.push(`${where}: publicApi type "${word}" is not defined in the spec; typed as unknown`);
  return 'unknown';
}
