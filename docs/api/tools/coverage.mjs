#!/usr/bin/env node
/**
 * Screen coverage: which prototype screens (and states) are served by which REST endpoints and
 * GraphQL screen queries, and which screens have none.
 *   node docs/api/tools/coverage.mjs           summary + screens without any API
 *   node docs/api/tools/coverage.mjs --json    write docs/api/coverage.json (used by the viewer)
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const apiDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = join(apiDir, '..', '..');
const proto = join(repo, 'design', 'prototype', 'js');

const noop = () => {};
const ctx = { console: { log: noop, warn: noop, error: noop }, document: { createElement: () => ({ dataset: {}, style: {} }), head: { appendChild: noop } }, location: { hash: '' } };
ctx.window = ctx;
vm.createContext(ctx);
for (const f of ['core.js', 'data.js', ...readdirSync(join(proto, 'screens')).map((s) => `screens/${s}`)]) vm.runInContext(readFileSync(join(proto, f), 'utf8'), ctx);
const screens = [];
for (const [area, groups] of Object.entries(ctx.UI.CATALOGUE)) {
  if (area === 'theme') continue;
  for (const [group, ids] of groups) for (const id of ids) screens.push({ id, area, group, title: ctx.UI.screens[id]?.title ?? id, states: ctx.UI.screens[id]?.states ?? [] });
}

const rest = {};
for (const f of readdirSync(join(apiDir, 'spec', 'modules')).filter((x) => x.endsWith('.json'))) {
  const m = JSON.parse(readFileSync(join(apiDir, 'spec', 'modules', f), 'utf8'));
  for (const e of m.endpoints) for (const s of e.screens ?? []) (rest[s] ??= []).push({ module: m.name, id: e.id, method: e.method, area: e.area, path: e.path, summary: e.summary, write: e.method !== 'GET' });
}
const gql = {};
for (const area of ['store', 'seller', 'admin']) {
  const dir = join(apiDir, 'graphql', 'operations', area);
  if (!existsSync(dir)) continue;
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.graphql'))) {
    const src = readFileSync(join(dir, f), 'utf8');
    const list = (src.match(/^#\s*screens?:\s*(.+)$/m)?.[1] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    for (const s of list) (gql[s] ??= []).push(`${area}/${f.replace('.graphql', '')}`);
  }
}

const rows = screens.map((s) => ({ ...s, reads: (rest[s.id] ?? []).filter((e) => !e.write).length, writes: (rest[s.id] ?? []).filter((e) => e.write).length, endpoints: rest[s.id] ?? [], queries: gql[s.id] ?? [] }));
const none = rows.filter((r) => !r.endpoints.length && !r.queries.length);
const noWrites = rows.filter((r) => r.endpoints.length && !r.writes);
console.log(`${rows.length} screens · ${rows.length - none.length} served by the API · ${none.length} with no endpoint or query`);
for (const r of none) console.log(`  NO API      ${r.id}  (${r.title})`);
console.log(`\nScreens with reads but no write endpoint (check whether they have actions):`);
for (const r of noWrites) console.log(`  read-only   ${r.id}  (${r.title})`);
if (process.argv.includes('--json')) {
  writeFileSync(join(apiDir, 'coverage.json'), JSON.stringify(rows, null, 2));
  console.log('\nWrote docs/api/coverage.json');
}
