#!/usr/bin/env tsx
/**
 * npm run modules                 every module: phase, on/off, version, endpoints built, dependencies
 * npm run modules -- --graph      dependency graph (Mermaid; dotted = optional)
 * npm run modules -- --without x  what has to go if module x is disabled
 */
import { parseArgs } from 'node:util';
import { isPlaceholder } from '../src/kernel/http/index.js';
import { allSpecs, dependencyProblems, dependentsOf, loadOrder } from '../src/kernel/module-system/loader.js';
import { enabledModules } from '../src/modules.config.js';
import { moduleLoaders } from '../src/modules/index.js';
import { buildOfflineApp } from './lib/offline.js';

const { values: opts } = parseArgs({ options: { graph: { type: 'boolean' }, without: { type: 'string' } } });
const specs = Object.values(allSpecs);
const enabled = new Set(enabledModules);
/** A module name as a Mermaid node id (no hyphens) */
const nodeId = (name: string) => name.replace(/-/g, '_');

if (opts.graph) {
  console.log('graph LR');
  for (const m of specs) {
    for (const d of m.dependsOn) console.log(`  ${nodeId(m.name)} --> ${nodeId(d)}`);
    for (const d of m.optionalDeps) console.log(`  ${nodeId(m.name)} -.-> ${nodeId(d)}`);
  }
  process.exit(0);
}

if (opts.without) {
  const name = opts.without;
  const stops = dependentsOf(name, [...enabled]);
  const optional = specs.filter((m) => enabled.has(m.name) && m.optionalDeps.includes(name)).map((m) => m.name);
  console.log(stops.length ? `Disabling ${name} also requires disabling: ${stops.join(', ')}` : `${name} can be disabled on its own.`);
  if (optional.length) console.log(`Used when present, and carry on without it: ${optional.join(', ')}`);
  process.exit(0);
}

// Boot every module folder (embedded MongoDB, schema not applied) and count the handlers that are still placeholders
const app = await buildOfflineApp();
const built = new Map<string, number>();
for (const e of app.kernel.boot.endpoints) if (!isPlaceholder(e.handler)) built.set(e.module, (built.get(e.module) ?? 0) + 1);
const versions = new Map(await Promise.all(Object.entries(moduleLoaders).map(async ([n, load]) => [n, (await load()).default.version] as const)));
await app.close();

let total = 0;
console.log(`${'Module'.padEnd(20)} Phase  On   Version  Built      Depends on`);
for (const m of [...specs].sort((a, b) => a.phase - b.phase || a.name.localeCompare(b.name))) {
  const count = Object.keys(m.endpoints).length;
  total += count;
  const progress = versions.has(m.name) ? `${String(built.get(m.name) ?? 0).padStart(3)} / ${String(count).padEnd(4)}` : '(no folder)';
  console.log(`${m.name.padEnd(20)} ${String(m.phase).padStart(5)}  ${enabled.has(m.name) ? 'yes' : ' - '}  ${(versions.get(m.name) ?? '').padEnd(8)} ${progress.padEnd(10)} ${m.dependsOn.join(', ') || '-'}`);
}
const builtTotal = [...built.values()].reduce((a, b) => a + b, 0);
console.log(`\nEndpoints built: ${builtTotal} of ${total} (the rest answer 501 NOT_IMPLEMENTED).`);

const problems = dependencyProblems([...enabled], Object.keys(moduleLoaders));
if (problems.length) {
  console.error(`\nConfiguration problems:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  process.exit(1);
}
console.log(`Load order: ${loadOrder([...enabled]).join(' → ')}`);
