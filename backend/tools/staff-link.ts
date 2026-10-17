#!/usr/bin/env tsx
/**
 * Staff accounts from the server, for a server without email or when no administrator can sign in: prints a new
 * invitation link and pass code for a person who has not accepted yet, or a password reset link for a staff member,
 * revokes an invitation not accepted yet, or does the Admin Center's account actions (disable, enable, lock, unlock,
 * sign out everywhere) for a leaver (tools/lib/staff-link.ts says what each does).
 *
 *   npm run staff-link -- --email ana@company.example                         new invitation (link + pass code) or reset link
 *   npm run staff-link -- --email ana@compnay.example --revoke "Mistyped email"
 *   npm run staff-link -- --email ana@company.example --disable "Left the company"   signs out everywhere, ends roles
 *   npm run staff-link -- --email ana@company.example --enable [--reason "Rehired"]
 *   npm run staff-link -- --email ana@company.example --lock "Laptop stolen"         signs out everywhere until unlocked
 *   npm run staff-link -- --email ana@company.example --unlock [--reason "Laptop found"]
 *   npm run staff-link -- --email ana@company.example --sign-out-all [--reason "Shared PC"]
 *
 * Runs against the configured database (MONGODB_URI, or MONGO_DATA_DIR), like npm run bootstrap-owner. Hand the link
 * and the pass code to the person in person (the pass code is printed only here): together they let them choose a
 * password and sign in to the Admin Center.
 */
import { parseArgs } from 'node:util';
import { buildApp } from '../src/app.js';
import { staffAccountAction, staffLink, type StaffAccountAction } from './lib/staff-link.js';

const USAGE = [
  'Usage: npm run staff-link -- --email person@example.com [and at most one of]',
  '         --revoke "reason" | --disable "reason" | --lock "reason"',
  '         --enable | --unlock | --sign-out-all   (with an optional --reason "reason")',
].join('\n');

const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    revoke: { type: 'string' },
    disable: { type: 'string' },
    lock: { type: 'string' },
    enable: { type: 'boolean' },
    unlock: { type: 'boolean' },
    'sign-out-all': { type: 'boolean' },
    reason: { type: 'string' },
  },
});
// the account action asked for and its reason (the audit trail needs one; the flag-only actions have a default)
const flagReason = values.reason ?? 'By the server operator';
const actions: { action: StaffAccountAction; reason: string }[] = [];
if (values.disable !== undefined) actions.push({ action: 'disable', reason: values.disable });
if (values.lock !== undefined) actions.push({ action: 'lock', reason: values.lock });
if (values.enable) actions.push({ action: 'enable', reason: flagReason });
if (values.unlock) actions.push({ action: 'unlock', reason: flagReason });
if (values['sign-out-all']) actions.push({ action: 'sign-out-all', reason: flagReason });
if (!values.email || actions.length + (values.revoke !== undefined ? 1 : 0) > 1) {
  console.error(USAGE);
  process.exit(1);
}
if (!process.env.MONGODB_URI && !process.env.MONGO_DATA_DIR) {
  console.error('Set MONGODB_URI or MONGO_DATA_DIR: the staff accounts are in that database.');
  process.exit(1);
}

const app = await buildApp({ config: { logLevel: 'warn', jobsEnabled: false } });
try {
  if (actions[0]) {
    console.log((await staffAccountAction(app, { email: values.email, ...actions[0] })).done);
  } else {
    const r = await staffLink(app, { email: values.email, revoke: values.revoke });
    console.log(r.done);
    if (r.link) console.log(`  Link: ${r.link}`);
    if (r.passCode) console.log(`  Pass code: ${r.passCode}`);
    if (r.expiresAt) console.log(`  Valid until: ${r.expiresAt}`);
  }
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await app.close();
}
