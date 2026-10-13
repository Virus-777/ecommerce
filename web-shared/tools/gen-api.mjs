// Regenerates the API client's inputs from the backend's API docs:
//   src/api/openapi.d.ts                       REST types (openapi-typescript, run with TypeScript 5 through npx:
//                                              the repo uses TypeScript 7, whose compiler has no JS API)
//   src/api/graphql/<area>/*.graphql + manifest.json   GraphQL screen queries and their persisted ids
// Usage: npm run gen:api [-- <docs/api directory>]   (default: ../docs/api, i.e. this repository's API docs)
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const docs = resolve(process.argv[2] ?? '../docs/api');
const spec = resolve(docs, 'openapi.json');
if (!existsSync(spec)) {
  console.error(`No openapi.json in ${docs}. Pass the backend's docs/api directory: npm run gen:api -- <path>`);
  process.exit(1);
}
execFileSync('npx', ['-y', '-p', 'openapi-typescript@7', '-p', 'typescript@5', 'openapi-typescript', spec, '-o', 'src/api/openapi.d.ts'], { stdio: 'inherit', shell: process.platform === 'win32' });

const ops = resolve(docs, 'graphql/operations');
if (existsSync(ops)) {
  rmSync('src/api/graphql', { recursive: true, force: true });
  mkdirSync('src/api/graphql', { recursive: true });
  cpSync(ops, 'src/api/graphql', { recursive: true });
  console.log('GraphQL operations copied to src/api/graphql/');
}
