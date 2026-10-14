#!/usr/bin/env tsx
/**
 * npm run keys [-- --env <file>] [-- --rotate]     (production: node dist/tools/keys.js --env /etc/marketly/marketly.env)
 *
 * Writes the production secrets into an env file (default .env.production): a new token signing key
 * (AUTH_SIGNING_JWK), its public key (AUTH_JWKS) and APP_SECRET; tools/lib/keys.ts says what each is for. A missing
 * file is created from .env.production.example. Values already in the file are kept; --rotate replaces the signing
 * key and keeps the previous public key in AUTH_JWKS. Secret values are never printed.
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { fillKeys } from './lib/keys.js';

const { values } = parseArgs({ options: { env: { type: 'string', default: '.env.production' }, rotate: { type: 'boolean', default: false }, help: { type: 'boolean', default: false } } });
if (values.help) {
  console.log('Usage: npm run keys -- [--env <file>] [--rotate]   (default file .env.production)');
  process.exit(0);
}
const file = resolve(values.env);

/** .env.production.example next to package.json: one folder up from tools/ (tsx), two from dist/tools/ (production) */
function findTemplate(): string | undefined {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 3; i++) {
    const candidate = join(dir, '.env.production.example');
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  return undefined;
}

let text: string;
if (existsSync(file)) text = readFileSync(file, 'utf8');
else {
  const template = findTemplate();
  if (!template) {
    console.error(`${file} does not exist and .env.production.example was not found to create it from.`);
    process.exit(1);
  }
  text = readFileSync(template, 'utf8');
  console.log(`Created ${file} from ${template}: fill in the addresses (ADMIN_URL, API_URL, …) before starting the server.`);
}

const result = fillKeys(text, { rotate: values.rotate });
if (!result.written.length) {
  console.log(`${file} already has AUTH_SIGNING_JWK, AUTH_JWKS and APP_SECRET; nothing changed.`);
  console.log('To replace the token signing key: npm run keys -- --env <file> --rotate');
  process.exit(0);
}
// mode 600: only the owner reads it (on Linux; Windows ignores the mode)
writeFileSync(file, result.text, { mode: 0o600 });
chmodSync(file, 0o600);
console.log(`Wrote to ${file}:`);
for (const w of result.written) console.log(`  ${w}`);
if (result.kept.length) console.log(`Kept: ${result.kept.join(', ')}`);
if (values.rotate) {
  console.log('Rotated the signing key. Tokens signed with the previous key keep working until they expire (15 minutes), and');
  console.log('refresh tokens are not signed with it, so nobody is signed out. Restart the server to use the new key.');
  console.log('APP_SECRET is never rotated by this tool: stored pass codes, audit checkpoints and file links depend on it.');
}
console.log(`The file holds secrets: keep it readable by the service user only (chmod 600 ${file}; chown marketly:marketly on the server).`);
