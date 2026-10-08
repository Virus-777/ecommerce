#!/usr/bin/env tsx
/**
 * npm run modules                 every module: phase, on/off, version, endpoints built, dependencies
 * npm run modules -- --graph      dependency graph (Mermaid; dotted = optional)
 * npm run modules -- --without x  what has to go if module x is disabled
 */
import { isPlaceholder, type RouteSet } from '../src/kernel/http/index.js';
import { dependencyProblems, dependentsOf, loadOrder } from '../src/kernel/module-system/loader.js';
import type { ModuleSpecDef } from '../src/kernel/spec/define.js';
import { enabledModules } from '../src/modules.config.js';
import { moduleLoaders } from '../src/modules/index.js';
import { specs } from '../src/spec/index.js';

const args = process.argv.slice(2);
const all = Object.values(specs) as unknown as ModuleSpecDef[];
const enabled = new Set(enabledModules);
const id = (n: string) => n.replace(/-/g, '_');

if (args.includes('--graph')) {
  console.log('graph LR');
  for (const m of all) {
    for (const d of m.dependsOn) console.log(`  ${id(m.name)} --> ${id(d)}`);
    for (const d of m.optionalDeps) console.log(`  ${id(m.name)} -.-> ${id(d)}`);
  }
  process.exit(0);
}

const without = args.includes('--without') ? args[args.indexOf('--without') + 1] : undefined;
if (without) {
  const stops = dependentsOf(without, [...enabled]);
  const optional = all.filter((m) => enabled.has(m.name) && m.optionalDeps.includes(without)).map((m) => m.name);
  console.log(stops.length ? `Disabling ${without} also requires disabling: ${stops.join(', ')}` : `${without} can be disabled on its own.`);
  if (optional.length) console.log(`Used when present, and carry on without it: ${optional.join(', ')}`);
  process.exit(0);
}

/** Registers a module against a recording context to count handlers that are still placeholders. */
async function progress(name: string) {
  const load = moduleLoaders[name];
  if (!load) return null;
  const def = (await load()).default;
  const sets: RouteSet[] = [];
  const noop = () => undefined;
  const anything: object = new Proxy(noop, { get: () => anything, apply: () => anything });
  const ctx = new Proxy({} as Record<string | symbol, unknown>, {
    get: (_, k) => (k === 'http' ? { routes: (...s: RouteSet[]) => sets.push(...s), webhookVerifier: noop } : k === 'spec' ? def.spec : k === 'name' ? name : anything),
  });
  try {
    await def.register(ctx as never);
  } catch {
    return { built: NaN, total: Object.keys(def.spec.endpoints).length, version: def.version };
  }
  const handlers = sets.flatMap((s) => Object.values(s.handlers));
  return { built: handlers.filter((h) => !isPlaceholder(h)).length, total: Object.keys(def.spec.endpoints).length, version: def.version };
}

const problems = dependencyProblems([...enabled], Object.keys(moduleLoaders));
console.log(`${'Module'.padEnd(20)} Phase  On   Version  Built      Depends on`);
let built = 0;
let total = 0;
for (const m of [...all].sort((a, b) => a.phase - b.phase || a.name.localeCompare(b.name))) {
  const p = await progress(m.name);
  if (p && !Number.isNaN(p.built)) built += p.built;
  total += Object.keys(m.endpoints).length;
  const b = p ? `${String(p.built).padStart(3)} / ${String(p.total).padEnd(4)}` : '(no folder)';
  console.log(`${m.name.padEnd(20)} ${String(m.phase).padStart(5)}  ${enabled.has(m.name) ? 'yes' : ' - '}  ${(p?.version ?? '').padEnd(8)} ${b.padEnd(10)} ${m.dependsOn.join(', ') || '-'}`);
}
console.log(`\nEndpoints built: ${built} of ${total} (the rest answer 501 NOT_IMPLEMENTED).`);
if (problems.length) {
  console.error(`\nConfiguration problems:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  process.exit(1);
}
console.log(`Load order: ${loadOrder([...enabled]).join(' → ')}`);
