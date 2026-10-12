#!/usr/bin/env tsx
/**
 * Does the running server match the API design?
 *
 * Boots every module in the spec (launch phases included, on the embedded MongoDB), takes the OpenAPI document
 * the server generates from its own route schemas (what /docs shows), and compares it with
 * docs/api/openapi.json, the published design:
 *   - the same operations (method + path), operation ids and auth schemes;
 *   - the same parameters (name, location, required) with the same types;
 *   - the same request bodies and success responses, field by field
 *     (names, types, formats, enums, required, nullable), following every named type;
 *   - the same documented status codes.
 *
 *   npm run check:api               report differences, exit 1 if any
 *   npm run check:api -- --verbose  also print how much was compared
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildOfflineApp } from './lib/offline.js';
import { apiDir } from './lib/spec.js';

type Schema = Record<string, any>;
type Doc = { paths: Record<string, Record<string, any>>; components: { schemas: Record<string, Schema> } };

const verbose = process.argv.includes('--verbose');
const design = JSON.parse(readFileSync(join(apiDir, 'openapi.json'), 'utf8')) as Doc;

const app = await buildOfflineApp();
const actual = app.swagger() as unknown as Doc;
await app.close();

/* ---------------------------------------------------------------- shape signatures */

const refName = (ref: string) => decodeURIComponent(ref.replace('#/components/schemas/', ''));
const ANNOTATIONS = new Set(['description', 'title', 'example', 'examples', 'default']);

/** Structural signature of a schema; named types become their name (collected in `named`) and are compared separately. */
function sig(s: Schema | undefined, named: Set<string>): string {
  if (!s || Object.keys(s).every((k) => ANNOTATIONS.has(k))) return 'any';
  if (s.$ref) {
    const name = refName(s.$ref);
    named.add(name);
    return `#${name}`;
  }
  const variants = (s.anyOf ?? s.oneOf) as Schema[] | undefined;
  if (variants) {
    const nonNull = variants.filter((v) => v.type !== 'null' && !(Array.isArray(v.enum) && v.enum.length === 1 && v.enum[0] === null));
    const inner = nonNull.length === 1 ? sig(nonNull[0], named) : `union(${nonNull.map((v) => sig(v, named)).sort().join('|')})`;
    // `any` already admits null (an optional json field)
    return nonNull.length < variants.length && inner !== 'any' ? `${inner}?` : inner;
  }
  if (s.allOf?.length === 1) return sig(s.allOf[0], named);
  const types: string[] = Array.isArray(s.type) ? s.type : s.type ? [s.type] : [];
  const nullable = types.includes('null') || s.nullable === true;
  const t = types.find((x) => x !== 'null') ?? (s.properties ? 'object' : s.items ? 'array' : s.enum ? 'string' : 'any');
  let out: string;
  if (s.enum) out = `enum(${s.enum.filter((v: unknown) => v !== null).sort().join('|')})`;
  else if (t === 'object') {
    const required = new Set<string>(s.required ?? []);
    const props = Object.entries((s.properties ?? {}) as Record<string, Schema>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}${required.has(k) ? '' : '~'}:${sig(v, named)}`);
    const map = s.additionalProperties && typeof s.additionalProperties === 'object' ? `map<${sig(s.additionalProperties, named)}>` : '';
    out = props.length ? `{${props.join(',')}}` : map || '{}';
  } else if (t === 'array') out = `[${sig(s.items, named)}]`;
  else if (t === 'string') out = s.format ? `string:${s.format}` : 'string';
  else out = t;
  return nullable ? `${out}?` : out;
}

/* ---------------------------------------------------------------- compare */

const problems: string[] = [];
/** Named types reached from operations, compared after them */
const queue: string[] = [];

const compare = (where: string, a: Schema | undefined, b: Schema | undefined, param = false) => {
  const named = new Set<string>();
  // a query parameter is either sent or not: the design's nullable marker on optional params means the same as required: false
  const strip = (x: string) => (param ? x.replace(/\?$/, '') : x);
  const sa = strip(sig(a, named));
  const sb = strip(sig(b, new Set()));
  if (sa !== sb) problems.push(`${where}\n      design: ${sa}\n      server: ${sb}`);
  queue.push(...named);
};

const operations = (doc: Doc) => {
  const m = new Map<string, any>();
  for (const [path, item] of Object.entries(doc.paths)) {
    if (!path.startsWith('/api/') && !path.startsWith('/webhooks/')) continue;
    for (const [method, op] of Object.entries(item)) {
      if (['get', 'post', 'put', 'patch', 'delete'].includes(method)) m.set(`${method.toUpperCase()} ${path.replace(/\{[^}]+\}/g, '{}')}`, op);
    }
  }
  return m;
};
const want = operations(design);
const got = operations(actual);

for (const [k, op] of want) if (!got.has(k)) problems.push(`missing operation ${k} (${op.operationId})`);
for (const [k, op] of got) if (!want.has(k)) problems.push(`operation not in the design: ${k} (${op.operationId})`);

const security = (op: any) => JSON.stringify((op.security ?? []).map((x: object) => Object.keys(x)[0]).sort());
const parameters = (op: any) => new Map<string, any>((op.parameters ?? []).map((p: any) => [`${p.in}:${p.in === 'header' ? p.name.toLowerCase() : p.name}`, p]));
const jsonBody = (x: any) => x?.content?.['application/json']?.schema;
const statusCodes = (op: any) => Object.keys(op.responses ?? {}).sort().join(',');

let matched = 0;
for (const [k, w] of want) {
  const g = got.get(k);
  if (!g) continue;
  const W = `${w.operationId} (${k})`;
  if (w.operationId !== g.operationId) problems.push(`${W}: operationId is ${g.operationId}`);
  if (security(w) !== security(g)) problems.push(`${W}: security ${security(g)}, design ${security(w)}`);

  const pw = parameters(w);
  const pg = parameters(g);
  for (const [n, p] of pw) {
    const q = pg.get(n);
    if (!q) problems.push(`${W}: parameter ${n} missing`);
    else {
      if (Boolean(p.required) !== Boolean(q.required)) problems.push(`${W}: parameter ${n} required=${q.required}, design ${p.required}`);
      if (p.in !== 'header') compare(`${W}: parameter ${n}`, p.schema, q.schema, true);
    }
  }
  for (const n of pg.keys()) if (!pw.has(n)) problems.push(`${W}: extra parameter ${n}`);

  if (Boolean(w.requestBody) !== Boolean(g.requestBody)) problems.push(`${W}: request body ${g.requestBody ? 'present' : 'missing'}`);
  else if (w.requestBody) compare(`${W}: request body`, jsonBody(w.requestBody), jsonBody(g.requestBody));

  if (statusCodes(w) !== statusCodes(g)) problems.push(`${W}: status codes ${statusCodes(g)}, design ${statusCodes(w)}`);
  for (const [status, r] of Object.entries(w.responses ?? {})) {
    if (status.startsWith('2') && jsonBody(r)) compare(`${W}: response ${status}`, jsonBody(r), jsonBody(g.responses?.[status]));
  }
  matched++;
}

/* named types: each one reached from an operation, transitively */
const seen = new Set<string>();
for (let name = queue.pop(); name !== undefined; name = queue.pop()) {
  if (seen.has(name)) continue;
  seen.add(name);
  const g = actual.components?.schemas?.[name];
  if (g) compare(`type ${name}`, design.components.schemas[name], g);
  else problems.push(`type ${name}: not in the server's components`);
}

if (verbose) console.log(`Compared ${matched} operations and ${seen.size} named types.`);
if (problems.length) {
  console.error(`The server differs from docs/api/openapi.json in ${problems.length} place(s):\n${problems.slice(0, 200).map((p) => `  - ${p}`).join('\n')}${problems.length > 200 ? `\n  … ${problems.length - 200} more` : ''}`);
  process.exit(1);
}
console.log(`API matches the design: ${matched} operations, ${seen.size} named types, parameters, bodies, responses and status codes.`);
