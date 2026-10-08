#!/usr/bin/env node
/**
 * Marketly GraphQL design build.
 *
 *   node docs/api/tools/graphql.mjs              compose + validate + write outputs
 *   node docs/api/tools/graphql.mjs --partial    stub types from fragments that don't exist yet (while writing)
 *   node docs/api/tools/graphql.mjs --only orders   check one fragment (implies --partial, no outputs)
 *
 * Inputs : docs/api/graphql/base.graphql, docs/api/graphql/modules/<module>.graphql,
 *          docs/api/graphql/operations/<area>/*.graphql, docs/api/spec/modules/*.json (publicApi, permissions)
 * Outputs: docs/api/graphql/schema.<area>.graphql, docs/api/graphql/operations/<area>/manifest.json,
 *          docs/api/viewer/graphql-data.js
 * Needs  : `npm install` in docs/api/tools (graphql package)
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Kind, buildASTSchema, parse, print, validate, validateSchema, visit } from 'graphql';

const here = dirname(fileURLToPath(import.meta.url));
const apiDir = join(here, '..');
const gqlDir = join(apiDir, 'graphql');
const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const PARTIAL = args.includes('--partial') || Boolean(only);
const AREAS = ['STORE', 'SELLER', 'ADMIN'];
const MAX_DEPTH = 9;

const errors = [];
const warnings = [];
const err = (w, m) => errors.push(`${w}: ${m}`);
const soft = (w, m) => (PARTIAL ? warnings : errors).push(`${w}: ${m}`);

/* ---------------------------------------------------------------- load */
const specs = new Map(readdirSync(join(apiDir, 'spec', 'modules')).filter((f) => f.endsWith('.json')).map((f) => {
  const m = JSON.parse(readFileSync(join(apiDir, 'spec', 'modules', f), 'utf8'));
  return [m.name, m];
}));
const permissions = new Set([...specs.values()].flatMap((m) => (m.permissions ?? []).map((p) => p.key)));

const baseSrc = readFileSync(join(gqlDir, 'base.graphql'), 'utf8');
const baseDoc = parse(baseSrc);
const fragments = [];
for (const f of readdirSync(join(gqlDir, 'modules')).filter((x) => x.endsWith('.graphql')).sort()) {
  const module = f.replace(/\.graphql$/, '');
  const src = readFileSync(join(gqlDir, 'modules', f), 'utf8');
  try {
    fragments.push({ module, src, doc: parse(src) });
  } catch (e) {
    err(`modules/${f}`, `syntax error: ${e.message}`);
  }
  if (!specs.has(module)) err(`modules/${f}`, `no REST spec module named "${module}"`);
}

/* ---------------------------------------------------------------- ownership + directives */
const DEF_KINDS = new Set([Kind.OBJECT_TYPE_DEFINITION, Kind.ENUM_TYPE_DEFINITION, Kind.INPUT_OBJECT_TYPE_DEFINITION, Kind.UNION_TYPE_DEFINITION, Kind.INTERFACE_TYPE_DEFINITION, Kind.SCALAR_TYPE_DEFINITION]);
const EXT_KINDS = new Set([Kind.OBJECT_TYPE_EXTENSION, Kind.ENUM_TYPE_EXTENSION, Kind.INPUT_OBJECT_TYPE_EXTENSION, Kind.UNION_TYPE_EXTENSION, Kind.INTERFACE_TYPE_EXTENSION]);
const owner = new Map();
for (const d of baseDoc.definitions) if (DEF_KINDS.has(d.kind)) owner.set(d.name.value, 'base');
for (const fr of fragments) {
  for (const d of fr.doc.definitions) {
    if (d.kind === Kind.SCHEMA_DEFINITION || d.kind === Kind.DIRECTIVE_DEFINITION) err(fr.module, 'fragments may not define the schema or directives (base.graphql does)');
    if (DEF_KINDS.has(d.kind)) {
      if (owner.has(d.name.value)) err(fr.module, `type ${d.name.value} is already defined by ${owner.get(d.name.value)}`);
      else owner.set(d.name.value, fr.module);
    }
  }
}

const argOf = (dir, name) => dir.arguments?.find((a) => a.name.value === name)?.value;
const strArg = (dir, name) => { const v = argOf(dir, name); return v?.kind === Kind.STRING ? v.value : null; };
const areasOf = (node) => {
  const d = node.directives?.find((x) => x.name.value === 'areas');
  if (!d) return null;
  const v = argOf(d, 'in');
  return v?.kind === Kind.LIST ? v.values.map((x) => x.value) : null;
};

for (const fr of fragments) {
  if (only && fr.module !== only) continue;
  const W = `modules/${fr.module}.graphql`;
  for (const d of fr.doc.definitions) {
    const isExt = EXT_KINDS.has(d.kind);
    const typeName = d.name?.value;
    if (isExt && typeName !== 'Query' && !owner.has(typeName)) soft(W, `extends ${typeName}, which no fragment defines yet`);
    if (isExt && owner.get(typeName) === fr.module) err(W, `extends its own type ${typeName}; add the fields to the definition`);
    for (const field of d.fields ?? []) {
      const where = `${W} ${typeName}.${field.name.value}`;
      const src = field.directives?.find((x) => x.name.value === 'source');
      if (src) {
        const mod = strArg(src, 'module');
        const fn = strArg(src, 'fn');
        if (mod !== fr.module) err(where, `@source module must be "${fr.module}" (the module that owns the data resolves the field)`);
        const spec = specs.get(mod);
        if (spec && !(spec.publicApi ?? []).some((p) => p.name === fn)) err(where, `@source fn "${fn}" is not in ${mod}'s publicApi (REST spec)`);
      } else if (isExt) {
        err(where, 'fields added to another module\'s type (or to Query) need @source(module, fn)');
      }
      const auth = field.directives?.find((x) => x.name.value === 'auth');
      const perm = auth && strArg(auth, 'permission');
      if (perm && !permissions.has(perm)) err(where, `@auth permission "${perm}" is not declared in any REST spec`);
      for (const a of areasOf(field) ?? []) if (!AREAS.includes(a)) err(where, `unknown area ${a}`);
    }
  }
}

/* ---------------------------------------------------------------- compose per area */
function namedTypesIn(doc) {
  const names = new Set();
  visit(doc, { NamedType(n) { names.add(n.name.value); } });
  return names;
}
const BUILTIN = new Set(['String', 'Int', 'Float', 'Boolean', 'ID']);

function filterForArea(doc, area) {
  return visit(doc, {
    enter(node) {
      if ((DEF_KINDS.has(node.kind) || EXT_KINDS.has(node.kind) || node.kind === Kind.FIELD_DEFINITION || node.kind === Kind.ENUM_VALUE_DEFINITION || node.kind === Kind.INPUT_VALUE_DEFINITION) && node.directives) {
        const a = areasOf(node);
        if (a && !a.includes(area)) return null;
      }
      return undefined;
    },
  });
}

/**
 * Remove what can't exist when some modules are off (the same rule the server applies at startup):
 * extensions of missing types, and fields/arguments whose types are missing. Repeats until stable.
 */
function pruneMissing(defs, dropped) {
  for (;;) {
    const defined = new Set(defs.filter((d) => DEF_KINDS.has(d.kind)).map((d) => d.name.value));
    const ok = (typeNode) => { let n = typeNode; while (n.type) n = n.type; return BUILTIN.has(n.name.value) || defined.has(n.name.value); };
    let changed = false;
    const next = [];
    for (const d of defs) {
      if (EXT_KINDS.has(d.kind) && !defined.has(d.name.value)) { dropped.push(`${d.name.value} (all fields added by this fragment)`); changed = true; continue; }
      if (!d.fields) { next.push(d); continue; }
      const fields = d.fields.filter((f) => {
        const keep = ok(f.type) && (f.arguments ?? []).every((a) => ok(a.type));
        if (!keep) { dropped.push(`${d.name.value}.${f.name.value}`); changed = true; }
        return keep;
      });
      if (fields.length || !EXT_KINDS.has(d.kind)) next.push({ ...d, fields });
      else changed = true;
    }
    defs = next;
    if (!changed) return defs;
  }
}

function compose(area, without = new Set()) {
  const docs = [baseDoc, ...fragments.filter((f) => !without.has(f.module)).map((f) => f.doc)].map((d) => filterForArea(d, area));
  // Drop extensions left with no fields (all filtered out)
  let defs = docs.flatMap((d) => d.definitions).filter((d) => !(EXT_KINDS.has(d.kind) && d.kind === Kind.OBJECT_TYPE_EXTENSION && !(d.fields ?? []).length));
  const dropped = [];
  if (without.size) defs = pruneMissing(defs, dropped);
  let doc = { kind: Kind.DOCUMENT, definitions: defs };
  // Partial mode: stub missing types so syntax and wiring can be checked
  if (PARTIAL) {
    const defined = new Set(defs.filter((d) => DEF_KINDS.has(d.kind)).map((d) => d.name.value));
    const missing = [...new Set([...namedTypesIn(doc), ...defs.filter((d) => EXT_KINDS.has(d.kind)).map((d) => d.name.value)])].filter((n) => !defined.has(n) && !BUILTIN.has(n));
    if (missing.length) doc = { kind: Kind.DOCUMENT, definitions: [...defs, ...parse(missing.map((n) => `type ${n} { _stub: Boolean }`).join('\n')).definitions] };
  }
  try {
    const schema = buildASTSchema(doc, { assumeValidSDL: false });
    for (const e of validateSchema(schema)) err(`schema ${area}`, e.message);
    return { schema, doc, dropped };
  } catch (e) {
    err(`schema ${area}`, e.message);
    return { schema: null, doc, dropped };
  }
}

/* ---------------------------------------------------------------- removal check
   node graphql.mjs --removal-check   compose every area without each module in turn and report
   which fields disappear and which screen queries would stop validating. */
if (args.includes('--removal-check')) {
  const opsByArea = Object.fromEntries(AREAS.map((a) => {
    const dir = join(gqlDir, 'operations', a.toLowerCase());
    const list = existsSync(dir) ? readdirSync(dir).filter((x) => x.endsWith('.graphql')).map((f) => ({ name: f.replace('.graphql', ''), doc: parse(readFileSync(join(dir, f), 'utf8')) })) : [];
    return [a, list];
  }));
  const report = [];
  for (const fr of fragments) {
    const row = { module: fr.module, ok: true, dropped: 0, broken: [] };
    for (const area of AREAS) {
      const before = errors.length;
      const c = compose(area, new Set([fr.module]));
      if (errors.length > before) { row.ok = false; errors.splice(before); }
      row.dropped += c.dropped.length;
      if (c.schema) for (const op of opsByArea[area]) if (validate(c.schema, op.doc).length) row.broken.push(`${area.toLowerCase()}/${op.name}`);
    }
    report.push(row);
  }
  for (const r of report) console.log(`${r.ok ? 'OK  ' : 'FAIL'} without ${r.module.padEnd(20)} ${String(r.dropped).padStart(3)} fields in other modules dropped${r.broken.length ? ` · screen queries needing it: ${r.broken.join(', ')}` : ''}`);
  const failed = report.filter((r) => !r.ok);
  console.log(failed.length ? `\n${failed.length} module(s) cannot be removed cleanly.` : `\nEvery module can be removed: the remaining schemas stay valid.`);
  process.exit(failed.length ? 1 : 0);
}

const composed = Object.fromEntries(AREAS.map((a) => [a, compose(a)]));

/* ---------------------------------------------------------------- operations */
/** Selection depth with fragment spreads expanded (spreads don't add a level; their fields do). */
function depth(selectionSet, d, frags, seen = new Set()) {
  if (!selectionSet) return d;
  let max = d;
  for (const s of selectionSet.selections) {
    if (s.kind === Kind.FRAGMENT_SPREAD) {
      const f = frags.get(s.name.value);
      if (f && !seen.has(f.name.value)) max = Math.max(max, depth(f.selectionSet, d, frags, new Set([...seen, f.name.value])));
    } else if (s.kind === Kind.INLINE_FRAGMENT) {
      max = Math.max(max, depth(s.selectionSet, d, frags, seen));
    } else {
      max = Math.max(max, depth(s.selectionSet, d + 1, frags, seen));
    }
  }
  return max;
}
const operations = [];
for (const area of AREAS) {
  const dir = join(gqlDir, 'operations', area.toLowerCase());
  if (!existsSync(dir)) continue;
  const manifest = {};
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.graphql')).sort()) {
    const W = `operations/${area.toLowerCase()}/${f}`;
    const src = readFileSync(join(dir, f), 'utf8');
    let doc;
    try { doc = parse(src); } catch (e) { err(W, `syntax error: ${e.message}`); continue; }
    const ops = doc.definitions.filter((d) => d.kind === Kind.OPERATION_DEFINITION);
    if (ops.length !== 1 || !ops[0].name) { err(W, 'must contain exactly one named operation'); continue; }
    if (ops[0].operation !== 'query') err(W, 'only queries are allowed; writes use REST');
    const name = ops[0].name.value;
    if (`${name}.graphql` !== f) err(W, `file name must be ${name}.graphql`);
    const screens = (src.match(/^#\s*screens?:\s*(.+)$/m)?.[1] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!screens.length) err(W, 'add a "# screens: store/product, …" comment');
    const rest = (src.match(/^#\s*replaces:\s*(.+)$/m)?.[1] ?? '').trim();
    const why = (src.match(/^#\s*why:\s*(.+)$/m)?.[1] ?? '').trim();
    const schema = composed[area].schema;
    if (schema && !PARTIAL) for (const e of validate(schema, doc)) err(W, e.message);
    const frags = new Map(doc.definitions.filter((d) => d.kind === Kind.FRAGMENT_DEFINITION).map((f) => [f.name.value, f]));
    const dpt = depth(ops[0].selectionSet, 0, frags);
    if (dpt > MAX_DEPTH) err(W, `query depth ${dpt} exceeds ${MAX_DEPTH}`);
    const normalized = print(doc);
    const id = createHash('sha256').update(normalized).digest('hex');
    manifest[name] = { id, screens };
    operations.push({ area: area.toLowerCase(), name, screens, replaces: rest, why, depth: dpt, id, text: src.replace(/^#.*\n/gm, '').trim() });
  }
  if (!only && !errors.length) writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

if (warnings.length) console.log(`Warnings (${warnings.length}):\n${warnings.map((w) => `  - ${w}`).join('\n')}\n`);
if (errors.length) {
  console.error(`Errors (${errors.length}):\n${errors.map((e) => `  - ${e}`).join('\n')}`);
  process.exit(1);
}
const stat = (a) => {
  const s = composed[a].schema;
  if (!s) return '';
  const types = Object.values(s.getTypeMap()).filter((t) => !t.name.startsWith('__'));
  return `${a.toLowerCase()}: ${types.length} types, ${Object.keys(s.getQueryType().getFields()).length} query fields`;
};
console.log(`GraphQL OK: ${fragments.length} module fragments · ${AREAS.map(stat).join(' · ')} · ${operations.length} screen queries.`);
if (only || PARTIAL) process.exit(0);

/* ---------------------------------------------------------------- outputs */
const header = (area) => `# Marketly GraphQL schema: ${area.toLowerCase()} area\n# Generated by docs/api/tools/graphql.mjs from base.graphql + modules/*.graphql. Do not edit.\n# Reads only: writes use the REST API (docs/api/openapi.json).\n\n`;
for (const area of AREAS) {
  const parts = [print(filterForArea(baseDoc, area))];
  for (const fr of fragments) {
    const filtered = filterForArea(fr.doc, area);
    if (filtered.definitions.length) parts.push(`# ---------------------------------------------------------------- module: ${fr.module}\n\n${print(filtered)}`);
  }
  writeFileSync(join(gqlDir, `schema.${area.toLowerCase()}.graphql`), header(area) + parts.join('\n\n') + '\n');
}

const typeSummary = (area) => {
  const s = composed[area].schema;
  return Object.values(s.getTypeMap()).filter((t) => !t.name.startsWith('__') && !['String', 'Int', 'Float', 'Boolean', 'ID'].includes(t.name)).map((t) => {
    const fields = typeof t.getFields === 'function' ? Object.values(t.getFields()).map((f) => ({ name: f.name, type: String(f.type), args: (f.args ?? []).map((a) => `${a.name}: ${a.type}`), desc: f.description ?? null })) : [];
    const values = typeof t.getValues === 'function' ? t.getValues().map((v) => v.name) : undefined;
    return { name: t.name, kind: t.constructor.name.replace('GraphQL', '').replace('Type', ''), desc: t.description ?? null, owner: owner.get(t.name) ?? null, fields, values };
  });
};
// Which module contributes each field (definition owner, or the extending fragment)
const fieldOwner = {};
for (const fr of fragments) for (const d of fr.doc.definitions) for (const f of d.fields ?? []) fieldOwner[`${d.name.value}.${f.name.value}`] = fr.module;
const data = {
  areas: Object.fromEntries(AREAS.map((a) => [a.toLowerCase(), { types: typeSummary(a), queries: Object.values(composed[a].schema.getQueryType().getFields()).filter((f) => f.name !== 'ping').map((f) => ({ name: f.name, type: String(f.type), args: f.args.map((x) => `${x.name}: ${x.type}`), desc: f.description ?? null, module: fieldOwner[`Query.${f.name}`] ?? null })) }])),
  fieldOwner,
  fragments: Object.fromEntries(fragments.map((f) => [f.module, f.src])),
  operations,
};
writeFileSync(join(apiDir, 'viewer', 'graphql-data.js'), `/* Generated by docs/api/tools/graphql.mjs. Do not edit. */\nwindow.API_GQL = ${JSON.stringify(data)};\n`);
console.log('Wrote schema.{store,seller,admin}.graphql, operations/*/manifest.json, viewer/graphql-data.js');
