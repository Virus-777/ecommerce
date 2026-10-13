#!/usr/bin/env tsx
/**
 * Spec → code.
 *
 *   npm run gen                  regenerate src/spec/**, module READMEs and GraphQL fragments;
 *                                scaffold hand-written files that are missing (never overwrites them)
 *   npm run gen -- --check       fail if generated files are stale (CI)
 *   npm run gen -- --only <m>    regenerate everything, scaffold only module <m> (npm run module:new)
 *   npm run gen -- --all         scaffold every module in the spec (first build only)
 *
 * Inputs : docs/api/spec/common.json, docs/api/spec/modules/*.json, docs/api/graphql/**
 * Outputs: src/spec/*.ts (generated), src/modules/index.ts (generated),
 *          src/modules/<m>/README.md and graphql/schema.ts (generated), other module files (scaffolded once)
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { parse, print, valueFromASTUntyped } from 'graphql';
import { emitCommon, emitModule, GENERATED } from './lib/emit.js';
import { collectionDefs } from './lib/mongo.js';
import { emitMongooseSchemas } from './lib/mongoose.js';
import { planTables } from './lib/tables.js';
import { scaffoldFiles } from './lib/scaffold.js';
import { apiDir, backendDir, camel, gqlDir, loadCommon, loadFragment, loadModules, readText, type ModuleSpec } from './lib/spec.js';
import { TypeContext } from './lib/types.js';

const { values: opts } = parseArgs({ options: { check: { type: 'boolean' }, all: { type: 'boolean' }, only: { type: 'string' } } });
const CHECK = Boolean(opts.check);
const ALL = Boolean(opts.all);
const only = opts.only ?? null;
const srcDir = join(backendDir, 'src');
const modulesDir = join(srcDir, 'modules');

const common = loadCommon();
const modules = loadModules();
const byName = new Map(modules.map((m) => [m.name, m]));
if (only && !byName.has(only)) {
  console.error(`No spec for module "${only}". Write docs/api/spec/modules/${only}.json first (format: docs/api/spec/FORMAT.md).`);
  process.exit(1);
}

const generated = new Map<string, string>();
const problems: string[] = [];
const warnings: string[] = [];

/* ---------------------------------------------------------------- src/spec */
{
  const r = emitCommon(common);
  problems.push(...r.problems);
  generated.set(join(srcDir, 'spec', 'common.ts'), r.code);
}
for (const m of modules) {
  const r = emitModule(m, common, byName);
  problems.push(...r.problems);
  warnings.push(...r.warnings);
  generated.set(join(srcDir, 'spec', `${m.name}.ts`), r.code);
}
generated.set(
  join(srcDir, 'spec', 'index.ts'),
  `${GENERATED('docs/api/spec')}
/** Every module spec, keyed by module name. Importing this registers all event and public API types. */
${modules.map((m) => `import { spec as ${camel(m.name)} } from './${m.name}.js';`).join('\n')}

export const specs = {
${modules.map((m) => `  ${JSON.stringify(m.name)}: ${camel(m.name)},`).join('\n')}
} as const;

export type ModuleName = keyof typeof specs;
export const moduleNames = Object.keys(specs) as ModuleName[];
`,
);

/* ---------------------------------------------------------------- GraphQL base + persisted queries */
{
  const base = readText(join(gqlDir, 'base.graphql'));
  const ops: Record<string, Record<string, { name: string; screens: string[]; query: string }>> = {};
  for (const area of ['store', 'seller', 'admin']) {
    ops[area] = {};
    const dir = join(gqlDir, 'operations', area);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.graphql')).sort()) {
      const src = readText(join(dir, f));
      const doc = parse(src);
      const normalized = print(doc); // same id as docs/api/tools/graphql.mjs → manifest.json
      const id = createHash('sha256').update(normalized).digest('hex');
      const screens = (src.match(/^#\s*screens?:\s*(.+)$/m)?.[1] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      ops[area]![id] = { name: f.replace(/\.graphql$/, ''), screens, query: normalized };
    }
    const manifestPath = join(dir, 'manifest.json');
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, { id: string }>;
      for (const [name, { id }] of Object.entries(manifest)) if (!ops[area]![id]) problems.push(`graphql operations/${area}/${name}: manifest id does not match the query text (run node docs/api/tools/graphql.mjs)`);
    }
  }
  generated.set(
    join(srcDir, 'spec', 'graphql.ts'),
    `${GENERATED('docs/api/graphql/base.graphql and docs/api/graphql/operations')}
/** Shared scalars, types and directives of the three GraphQL schemas. */
export const baseTypeDefs = ${JSON.stringify(base)};

/** Persisted screen queries per area, keyed by sha256 id (same ids as operations/<area>/manifest.json). */
export const persistedQueries: Record<'store' | 'seller' | 'admin', Record<string, { name: string; screens: string[]; query: string }>> = ${JSON.stringify(ops, null, 2)};
`,
  );
}

/* ---------------------------------------------------------------- per-module generated files */
/** GraphQL fields a module resolves: those whose @source names it */
function sourceFieldsOf(m: ModuleSpec, fragment: string | null) {
  const out: { field: string; fn: string }[] = [];
  for (const d of fragment ? parse(fragment).definitions : []) {
    if (!('fields' in d) || !d.fields || !('name' in d)) continue;
    for (const f of d.fields) {
      const src = f.directives?.find((x) => x.name.value === 'source');
      const arg = (k: string) => String(valueFromASTUntyped(src!.arguments!.find((a) => a.name.value === k)!.value));
      if (src && arg('module') === m.name) out.push({ field: `${d.name.value}.${f.name.value}`, fn: arg('fn') });
    }
  }
  return out;
}

const commonTypes = new Set(Object.keys(common.types));
const scaffolded: string[] = [];
const missingHand: string[] = [];
for (const m of modules) {
  const dir = join(modulesDir, m.name);
  const fragment = loadFragment(m.name);
  const exists = existsSync(dir);
  // Generated files only for modules that have a folder (or are being scaffolded now)
  // A deleted module folder stays deleted: only --all (first build) or --only <m> (module:new) creates folders
  const scaffoldNow = !CHECK && (only ? only === m.name : exists || ALL);
  if (!exists && !scaffoldNow) continue;
  const readmeSrc = join(apiDir, 'modules', `${m.name}.md`);
  if (existsSync(readmeSrc)) {
    const md = readText(readmeSrc).replace(/\]\(([a-z0-9-]+)\.md(#[^)]*)?\)/g, (_, x: string, h = '') => `](../${x}/README.md${h})`);
    generated.set(join(dir, 'README.md'), `<!-- ${GENERATED(`docs/api/modules/${m.name}.md`).trim().replace(/^\/\/ /, '')} -->\n\n${md}`);
  }
  if (fragment) {
    generated.set(
      join(dir, 'graphql', 'schema.ts'),
      `${GENERATED(`docs/api/graphql/modules/${m.name}.graphql`)}
/** This module's GraphQL fragment: its own types and the fields it adds to other modules' types. */
export const typeDefs = ${JSON.stringify(fragment)};
`,
    );
  }
  {
    // Mongoose schemas of the module's collections (problems are reported by the spec emitter)
    const plans = planTables(m, []);
    generated.set(join(dir, 'schema.ts'), emitMongooseSchemas(m, plans, collectionDefs(m, plans, []), GENERATED(`docs/api/spec/modules/${m.name}.json`)));
  }
  const files = scaffoldFiles({ mod: m, common, types: new TypeContext(m, commonTypes, byName), hasFragment: Boolean(fragment), sourceFields: sourceFieldsOf(m, fragment) });
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel);
    if (existsSync(p)) continue;
    if (scaffoldNow) {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, content());
      scaffolded.push(relative(backendDir, p));
    } else if (exists) missingHand.push(relative(backendDir, p));
  }
}

/* ---------------------------------------------------------------- module registry (from folders on disk) */
{
  const present = (existsSync(modulesDir) ? readdirSync(modulesDir, { withFileTypes: true }) : [])
    .filter((d) => d.isDirectory() && existsSync(join(modulesDir, d.name, 'module.ts')))
    .map((d) => d.name)
    .sort();
  generated.set(
    join(modulesDir, 'index.ts'),
    `${GENERATED('the module folders in src/modules')}
import type { ModuleDefinition } from '../kernel/module-system/index.js';

/** Every module folder present in the codebase. Which ones run is decided in src/modules.config.ts. */
export const moduleLoaders: Record<string, () => Promise<{ default: ModuleDefinition }>> = {
${present.map((n) => `  ${JSON.stringify(n)}: () => import('./${n}/module.js'),`).join('\n')}
};
`,
  );
}

/* ---------------------------------------------------------------- write or check */
const stale: string[] = [];
for (const [p, content] of generated) {
  const cur = existsSync(p) ? readText(p) : null;
  if (cur === content) continue;
  if (CHECK) stale.push(relative(backendDir, p));
  else {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
}

if (warnings.length) console.warn(`Spec gaps (${warnings.length}), fix them in docs/api/spec:\n${warnings.map((w) => `  - ${w}`).join('\n')}`);
if (problems.length) {
  console.error(`Spec problems (${problems.length}):\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  process.exitCode = 1;
}
if (CHECK) {
  if (stale.length) {
    console.error(`Generated files are out of date with docs/api/spec (run npm run gen):\n${stale.map((s) => `  - ${s}`).join('\n')}`);
    process.exitCode = 1;
  }
  if (missingHand.length) console.warn(`Hand-written files missing (npm run gen scaffolds them):\n${missingHand.map((s) => `  - ${s}`).join('\n')}`);
  if (!stale.length && !problems.length) console.log(`Generated code matches the spec: ${modules.length} modules, ${modules.reduce((n, m) => n + m.endpoints.length, 0)} endpoints.`);
} else {
  console.log(`Generated ${generated.size} files from the spec (${modules.length} modules, ${modules.reduce((n, m) => n + m.endpoints.length, 0)} endpoints).`);
  if (scaffolded.length) console.log(`Scaffolded ${scaffolded.length} hand-written files${only ? ` for ${only}` : ''}.`);
}
