/**
 * Which modules run, and in which order. The loader refuses to start when an enabled module's
 * dependency is off, when dependencies form a cycle, or when a module's code no longer matches
 * its spec, and explains which module needs which.
 */
import { specs } from '../../spec/index.js';
import type { ModuleSpecDef } from '../spec/define.js';
import type { ModuleDefinition } from './index.js';

/** Every module spec, as the kernel reads them */
export const allSpecs: Readonly<Record<string, ModuleSpecDef>> = specs;
export const specOf = (name: string): ModuleSpecDef | undefined => allSpecs[name];

export function dependencyProblems(enabled: readonly string[], available: readonly string[]): string[] {
  const on = new Set(enabled);
  const problems: string[] = [];
  for (const name of enabled) {
    const spec = specOf(name);
    if (!spec) {
      problems.push(`"${name}" has no spec in docs/api/spec/modules (run npm run gen after adding it)`);
      continue;
    }
    if (!available.includes(name)) problems.push(`"${name}" is enabled but src/modules/${name} does not exist (npm run module:new ${name})`);
    for (const dep of spec.dependsOn) {
      if (!on.has(dep)) problems.push(`"${name}" needs "${dep}" (dependsOn), which is not enabled in src/modules.config.ts`);
    }
  }
  return problems;
}

/**
 * Dependencies first (dependsOn is a hard rule). Enabled optional dependencies also load first
 * where possible; optional edges may form loops (identity ⇢ audit ⇢ notifications → identity),
 * which is fine because modules call each other lazily at request time.
 */
export function loadOrder(enabled: readonly string[]): string[] {
  const on = new Set(enabled);
  const hard = (n: string) => specOf(n)!.dependsOn.filter((d) => on.has(d));
  const optional = (n: string) => specOf(n)!.optionalDeps.filter((d) => on.has(d));
  const placed = new Set<string>();
  const order: string[] = [];
  const remaining = new Set([...enabled].sort());
  while (remaining.size) {
    const ready = [...remaining].filter((n) => hard(n).every((d) => placed.has(d)));
    if (!ready.length) throw new Error(`Module dependency cycle: ${hardCycle([...remaining], hard).join(' → ')}`);
    const unplacedOptional = (n: string) => optional(n).filter((d) => !placed.has(d)).length;
    const pick = ready.reduce((best, n) => (unplacedOptional(n) < unplacedOptional(best) ? n : best));
    placed.add(pick);
    remaining.delete(pick);
    order.push(pick);
  }
  return order;
}

function hardCycle(nodes: string[], hard: (n: string) => string[]): string[] {
  const path: string[] = [];
  const seen = new Set<string>();
  const walk = (n: string): string[] | null => {
    const i = path.indexOf(n);
    if (i >= 0) return [...path.slice(i), n];
    if (seen.has(n)) return null;
    seen.add(n);
    path.push(n);
    for (const d of hard(n)) {
      const c = walk(d);
      if (c) return c;
    }
    path.pop();
    return null;
  };
  for (const n of nodes) {
    const c = walk(n);
    if (c) return c;
  }
  return nodes;
}

/** Modules that require `name` (directly or through others): disabling it would stop them. */
export function dependentsOf(name: string, among: readonly string[]): string[] {
  const out = new Set<string>();
  let frontier = [name];
  while (frontier.length) {
    const next: string[] = [];
    for (const m of among) {
      if (out.has(m)) continue;
      if (specOf(m)?.dependsOn.some((d) => frontier.includes(d))) {
        out.add(m);
        next.push(m);
      }
    }
    frontier = next;
  }
  return [...out].sort();
}

/** Enabled modules plus everything they need (tests boot one module with its dependencies). */
export function withDependencies(names: readonly string[]): string[] {
  const out = new Set<string>();
  const add = (n: string) => {
    if (out.has(n)) return;
    out.add(n);
    for (const d of specOf(n)?.dependsOn ?? []) add(d);
  };
  names.forEach(add);
  return [...out].sort();
}

export async function loadDefinitions(
  enabled: readonly string[],
  loaders: Record<string, () => Promise<{ default: ModuleDefinition }>>,
): Promise<ModuleDefinition[]> {
  const problems = dependencyProblems(enabled, Object.keys(loaders));
  if (problems.length) throw new Error(`Cannot start: module configuration problems\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  const order = loadOrder(enabled);
  const defs = await Promise.all(order.map(async (name) => (await loaders[name]!()).default));
  for (const [i, def] of defs.entries()) {
    const name = order[i]!;
    if (def.spec.name !== name) throw new Error(`src/modules/${name}/module.ts declares spec "${def.spec.name}"`);
    if (def.spec !== specOf(name)) throw new Error(`src/modules/${name}/module.ts must use the generated spec from src/spec/${name}.ts`);
  }
  return defs;
}
