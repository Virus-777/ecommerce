#!/usr/bin/env node
/** Regenerate the module catalog table in docs/02-backend-architecture.md from the module specs. */
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const apiDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const docPath = join(apiDir, '..', '02-backend-architecture.md');
const order = ['Platform', 'Participants', 'Catalog and stock', 'Buying', 'After-sales and money', 'Growth', 'Later phases'];
const mods = readdirSync(join(apiDir, 'spec', 'modules')).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(apiDir, 'spec', 'modules', f), 'utf8')));
mods.sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group) || a.name.localeCompare(b.name));
const gql = (n) => existsSync(join(apiDir, 'graphql', 'modules', `${n}.graphql`)) ? 'yes' : '-';
const rows = mods.map((m) => `| [${m.name}](api/modules/${m.name}.md) | ${(m.chapters ?? []).join(', ')} | ${m.summary.replace(/\|/g, '/')} | ${(m.dependsOn ?? []).join(', ') || '-'} | ${m.endpoints.length} | ${gql(m.name)} | ${m.phase}${m.phase > 2 ? ' (off)' : ''} |`);
const table = ['| Module | Plan ch. | Owns | Depends on | REST endpoints | GraphQL | Phase |', '|---|---|---|---|---|---|---|', ...rows].join('\n');
let doc = readFileSync(docPath, 'utf8');
const start = doc.indexOf('## 4. Module catalog');
const end = doc.indexOf('## 5. Cross-cutting rules');
const section = `## 4. Module catalog\n\nGenerated from the module specs (\`docs/api/spec/modules/\`, \`docs/api/graphql/modules/\`) by \`node docs/api/tools/sync-architecture.mjs\`. Launch phase follows plan ch. 20: phase-1 and phase-2 modules are designed for launch; phase 3–4 modules are designed now and stay off at launch. Optional dependencies are listed on each module page.\n\n${table}\n\n`;
doc = doc.slice(0, start) + section + doc.slice(end);
writeFileSync(docPath, doc);
console.log(`Module catalog synced: ${rows.length} modules.`);
