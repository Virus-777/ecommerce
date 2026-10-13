// Development: prints the current 2-step code of a seeded staff account (from web-shared/.seed/state.json),
// for signing in to the Admin Center by hand.  npm run staff-code -- olivia   (or: morgan)
import { readFileSync } from 'node:fs';
import { totp } from './seed/lib/codes.mjs';

const who = (process.argv[2] ?? 'olivia').toLowerCase();
let state;
try {
  state = JSON.parse(readFileSync(new URL('../.seed/state.json', import.meta.url), 'utf8'));
} catch {
  console.error('No seed state: run `npm run seed` first.');
  process.exit(1);
}
const staff = state.owners?.[who];
if (!staff?.totpSecret) {
  console.error(`No seeded staff account "${who}". Known: ${Object.keys(state.owners ?? {}).join(', ')}`);
  process.exit(1);
}
const left = 30 - (Math.floor(Date.now() / 1000) % 30);
console.log(`${staff.email}: ${totp(staff.totpSecret)} (valid ${left}s more)`);
