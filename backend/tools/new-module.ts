#!/usr/bin/env tsx
/**
 * npm run module:new <name>
 * Scaffolds src/modules/<name>/ from docs/api/spec/modules/<name>.json. Write the spec first
 * (docs/api/spec/FORMAT.md, validate with node docs/api/tools/build.mjs), then enable the module
 * in src/modules.config.ts.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { backendDir, specDir } from './lib/spec.js';

const name = process.argv[2];
if (!name || !/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(name)) {
  console.error('Usage: npm run module:new <kebab-case-name>');
  process.exit(1);
}
if (!existsSync(join(specDir, 'modules', `${name}.json`))) {
  console.error(`No spec for "${name}". Write docs/api/spec/modules/${name}.json first (format: docs/api/spec/FORMAT.md).`);
  process.exit(1);
}
const r = spawnSync(process.execPath, ['--import', 'tsx', join(backendDir, 'tools', 'generate.ts'), '--only', name], { stdio: 'inherit' });
if (r.status !== 0) process.exit(r.status ?? 1);
console.log(`\nNext: add '${name}' to src/modules.config.ts, build its handlers in src/modules/${name}/http/, then npm test.`);
