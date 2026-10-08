#!/usr/bin/env node
/**
 * Cross-module consistency report (complements build.mjs).
 *   node docs/api/tools/crossref.mjs
 * Lists `module.function` references (in notes, descriptions, publicApi.usedBy text …) that point
 * to a function the target module does not declare in its publicApi, plus publicApi `usedBy`
 * entries naming modules that don't exist.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'spec', 'modules');
const mods = Object.fromEntries(readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => {
  const m = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  return [m.name, m];
}));
const names = Object.keys(mods).sort((a, b) => b.length - a.length);
const re = new RegExp(`(?<![\\w.-])(${names.map((n) => n.replace(/-/g, '\\-')).join('|')})\\.([a-z][A-Za-z0-9]+)(?![\\w.])`, 'g');

const missing = new Map();
for (const [owner, m] of Object.entries(mods)) {
  const text = JSON.stringify({ ...m, types: undefined, events: { publishes: (m.events?.publishes ?? []).map((e) => e.when), consumes: (m.events?.consumes ?? []).map((e) => e.does) }, permissions: (m.permissions ?? []).map((p) => p.desc) });
  for (const [, mod, fn] of text.matchAll(re)) {
    const target = mods[mod];
    if ((target.publicApi ?? []).some((p) => p.name === fn)) continue;
    if (target.types?.[fn]) continue;
    const known = [...(target.jobs ?? []).map((j) => j.name), ...(target.settings ?? []).map((x) => `${mod}.${x.key}`), ...Object.values(mods).flatMap((x) => (x.settings ?? []).map((y) => y.key))];
    if (known.some((k) => k === `${mod}.${fn}` || k.startsWith(`${mod}.${fn}`) || k === fn)) continue;
    const key = `${mod}.${fn}`;
    if (!missing.has(key)) missing.set(key, new Set());
    missing.get(key).add(owner);
  }
  for (const f of m.publicApi ?? []) for (const u of f.usedBy ?? []) if (!mods[u] && !['kernel', '*', 'graphql'].includes(u)) console.log(`usedBy: ${owner}.${f.name} names unknown module "${u}"`);
}
const rows = [...missing].sort();
console.log(`${rows.length} referenced functions not declared in the target module's publicApi:`);
for (const [k, v] of rows) console.log(`  ${k}  ← ${[...v].join(', ')}`);
