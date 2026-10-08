#!/usr/bin/env tsx
/**
 * Does the running server match the API design?
 *
 * Boots every module in the spec (launch phases included), takes the OpenAPI document the server
 * generates from its own route schemas (what /docs shows), and compares it with
 * docs/api/openapi.json, the published design:
 *   - the same operations (method + path), operation ids and auth schemes;
 *   - the same parameters (name, location, required) with the same types;
 *   - the same request bodies and success responses, field by field
 *     (names, types, formats, enums, required, nullable), following every named type;
 *   - the same documented status codes.
 *
 *   npm run check:api               report differences, exit 1 if any
 *   npm run check:api -- --verbose  also list matched operations per module
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildApp } from '../src/app.js';
import { moduleNames } from '../src/spec/index.js';
import { apiDir } from './lib/spec.js';

type Schema = Record<string, any>;
type Doc = { paths: Record<string, Record<string, any>>; components: { schemas: Record<string, Schema> } };

const verbose = process.argv.includes('--verbose');
const design = JSON.parse(readFileSync(join(apiDir, 'openapi.json'), 'utf8')) as Doc;

const app = await buildApp({ env: { NODE_ENV: 'test' }, modules: [...moduleNames], config: { launchPhase: 4 } });
await app.ready();
const actual = app.swagger() as unknown as Doc;
await app.close();

/* ---------------------------------------------------------------- shape signatures */

function resolver(doc: Doc) {
  return (ref: string) => {
    const name = decodeURIComponent(ref.replace('#/components/schemas/', ''));
    return { name, schema: doc.components?.schemas?.[name] };
  };
}

/** Structural signature of a schema; named types become their name, compared separately. */
function sig(s: Schema | undefined, doc: Doc, named: Set<string>): string {
  if (!s || Object.keys(s).filter((k) => !['description', 'title', 'example', 'examples', 'default'].includes(k)).length === 0) return 'any';
  if (s.$ref) {
    const { name } = resolver(doc)(s.$ref);
    named.add(name);
    return `#${name.replace(/Input$/, '')}`;
  }
  const variants = (s.anyOf ?? s.oneOf) as Schema[] | undefined;
  if (variants) {
    const nonNull = variants.filter((v) => v.type !== 'null' && !(Array.isArray(v.enum) && v.enum.length === 1 && v.enum[0] === null));
    const nullable = nonNull.length < variants.length;
    const inner = nonNull.length === 1 ? sig(nonNull[0], doc, named) : `union(${nonNull.map((v) => sig(v, doc, named)).sort().join('|')})`;
    // `any` already admits null (an optional json field)
    return nullable && inner !== 'any' ? `${inner}?` : inner;
  }
  if (s.allOf?.length === 1) return sig(s.allOf[0], doc, named);
  let types: string[] = Array.isArray(s.type) ? s.type : s.type ? [s.type] : [];
  const nullable = types.includes('null') || s.nullable === true;
  types = types.filter((t) => t !== 'null');
  const t = types[0] ?? (s.properties ? 'object' : s.items ? 'array' : s.enum ? 'string' : 'any');
  let out: string;
  if (s.enum) out = `enum(${[...s.enum].filter((v) => v !== null).sort().join('|')})`;
  else if (t === 'object') {
    const props = Object.entries((s.properties ?? {}) as Record<string, Schema>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}${(s.required ?? []).includes(k) ? '' : '~'}:${sig(v, doc, named)}`);
    const add = s.additionalProperties && typeof s.additionalProperties === 'object' ? `map<${sig(s.additionalProperties, doc, named)}>` : '';
    out = props.length ? `{${props.join(',')}}` : add || '{}';
  } else if (t === 'array') out = `[${sig(s.items, doc, named)}]`;
  else if (t === 'string') out = s.format ? `string:${s.format === 'uri' ? 'url' : s.format}` : 'string';
  else out = t;
  return nullable ? `${out}?` : out;
}

/* ---------------------------------------------------------------- compare */

const problems: string[] = [];
const namedPairs = new Set<string>();
const norm = (p: string) => p.replace(/\{[^}]+\}/g, '{}');
const ops = (doc: Doc) => {
  const m = new Map<string, { path: string; method: string; op: any }>();
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
      if (!path.startsWith('/api/') && !path.startsWith('/webhooks/')) continue;
      m.set(`${method.toUpperCase()} ${norm(path)}`, { path, method, op });
    }
  }
  return m;
};
const want = ops(design);
const got = ops(actual);

for (const k of want.keys()) if (!got.has(k)) problems.push(`missing operation ${k} (${want.get(k)!.op.operationId})`);
for (const k of got.keys()) if (!want.has(k)) problems.push(`operation not in the design: ${k} (${got.get(k)!.op.operationId})`);

const compare = (where: string, a: Schema | undefined, b: Schema | undefined, param = false) => {
  const na = new Set<string>();
  const nb = new Set<string>();
  // a query parameter is either sent or not: the design's nullable marker on optional params means the same as required: false
  const strip = (x: string) => (param ? x.replace(/\?$/, '') : x);
  const sa = strip(sig(a, design, na));
  const sb = strip(sig(b, actual, nb));
  if (sa !== sb) problems.push(`${where}\n      design: ${sa}\n      server: ${sb}`);
  for (const n of na) namedPairs.add(n);
};

let matched = 0;
for (const [k, w] of want) {
  const g = got.get(k);
  if (!g) continue;
  const W = `${w.op.operationId} (${k})`;
  if (w.op.operationId !== g.op.operationId) problems.push(`${W}: operationId is ${g.op.operationId}`);
  const sec = (op: any) => JSON.stringify((op.security ?? []).map((x: object) => Object.keys(x)[0]).sort());
  if (sec(w.op) !== sec(g.op)) problems.push(`${W}: security ${sec(g.op)}, design ${sec(w.op)}`);

  const params = (op: any) => new Map<string, any>((op.parameters ?? []).map((p: any) => [`${p.in}:${p.in === 'header' ? p.name.toLowerCase() : p.name}`, p]));
  const pw = params(w.op);
  const pg = params(g.op);
  for (const [n, p] of pw) {
    const q = pg.get(n);
    if (!q) {
      problems.push(`${W}: parameter ${n} missing`);
      continue;
    }
    if (Boolean(p.required) !== Boolean(q.required)) problems.push(`${W}: parameter ${n} required=${q.required}, design ${p.required}`);
    if (p.in !== 'header') compare(`${W}: parameter ${n}`, p.schema, q.schema, true);
  }
  for (const n of pg.keys()) if (!pw.has(n)) problems.push(`${W}: extra parameter ${n}`);

  const body = (op: any) => op.requestBody?.content?.['application/json']?.schema;
  if (Boolean(w.op.requestBody) !== Boolean(g.op.requestBody)) problems.push(`${W}: request body ${g.op.requestBody ? 'present' : 'missing'}`);
  else if (w.op.requestBody) compare(`${W}: request body`, body(w.op), body(g.op));

  const codes = (op: any) => Object.keys(op.responses ?? {}).sort().join(',');
  if (codes(w.op) !== codes(g.op)) problems.push(`${W}: status codes ${codes(g.op)}, design ${codes(w.op)}`);
  for (const [status, r] of Object.entries(w.op.responses ?? {}) as [string, any][]) {
    if (!status.startsWith('2')) continue;
    const ws = r.content?.['application/json']?.schema;
    const gs = g.op.responses?.[status]?.content?.['application/json']?.schema;
    if (ws) compare(`${W}: response ${status}`, ws, gs);
  }
  matched++;
}

/* named types: compare each one reached from an operation, transitively */
const seen = new Set<string>();
const queue = [...namedPairs];
while (queue.length) {
  const name = queue.pop()!;
  if (seen.has(name)) continue;
  seen.add(name);
  const w = design.components.schemas[name];
  const g = actual.components?.schemas?.[name] ?? actual.components?.schemas?.[`${name}Input`];
  if (!g) {
    problems.push(`type ${name}: not in the server's components`);
    continue;
  }
  const before = namedPairs.size;
  compare(`type ${name}`, w, g);
  if (namedPairs.size !== before) for (const n of namedPairs) if (!seen.has(n)) queue.push(n);
}

if (verbose) console.log(`Compared ${matched} operations and ${seen.size} named types.`);
if (problems.length) {
  console.error(`The server differs from docs/api/openapi.json in ${problems.length} place(s):\n${problems.slice(0, 200).map((p) => `  - ${p}`).join('\n')}${problems.length > 200 ? `\n  … ${problems.length - 200} more` : ''}`);
  process.exit(1);
}
console.log(`API matches the design: ${matched} operations, ${seen.size} named types, parameters, bodies, responses and status codes.`);
