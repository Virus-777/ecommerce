#!/usr/bin/env tsx
/**
 * Module boundaries (architecture §3, rule 2): code in src/modules/<a>/ may import
 *   - its own folder,
 *   - src/kernel/** and src/spec/** (the shared plumbing and the published API design),
 *   - another module's contract.ts, and nothing else of it.
 * The kernel and the spec layer never import modules.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { backendDir } from './lib/spec.js';

const src = join(backendDir, 'src');
const files: string[] = [];
const walk = (d: string) => {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (f.endsWith('.ts')) files.push(p);
  }
};
walk(src);

const IMPORT = /(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;
const problems: string[] = [];
const rel = (p: string) => relative(backendDir, p).split(sep).join('/');

for (const file of files) {
  const r = rel(file);
  const own = /^src\/modules\/([^/]+)\//.exec(r)?.[1];
  const code = readFileSync(file, 'utf8');
  for (const m of code.matchAll(IMPORT)) {
    const spec = m[1] ?? m[2]!;
    if (!spec.startsWith('.')) continue;
    const target = rel(resolve(dirname(file), spec));
    const targetModule = /^src\/modules\/([^/]+)\//.exec(target)?.[1];
    if (r.startsWith('src/kernel/') || r.startsWith('src/spec/')) {
      if (targetModule) problems.push(`${r} imports ${target}: the kernel and the spec layer must not depend on modules`);
      continue;
    }
    if (!own || !targetModule || targetModule === own) continue;
    if (!/^src\/modules\/[^/]+\/contract\.(js|ts)$/.test(target)) {
      problems.push(`${r} imports ${target}: use src/modules/${targetModule}/contract.ts or ctx.use('${targetModule}')`);
    }
  }
}

if (problems.length) {
  console.error(`Module boundary violations (${problems.length}):\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  process.exit(1);
}
console.log(`Module boundaries OK: ${files.length} files checked.`);
