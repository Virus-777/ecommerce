#!/usr/bin/env tsx
/**
 * Staff sign-in links on a server without email: prints a new invitation link and pass code for a person who has not
 * accepted yet, or a password reset link for a staff member, or revokes an invitation not accepted yet
 * (tools/lib/staff-link.ts says what each does).
 *
 *   npm run staff-link -- --email ana@company.example                         new invitation (link + pass code) or reset link
 *   npm run staff-link -- --email ana@compnay.example --revoke "Mistyped email"
 *
 * Runs against the configured database (MONGODB_URI, or MONGO_DATA_DIR), like npm run bootstrap-owner. Hand the link
 * and the pass code to the person in person (the pass code is printed only here): together they let them choose a
 * password and sign in to the Admin Center.
 */
import { parseArgs } from 'node:util';
import { buildApp } from '../src/app.js';
import { staffLink } from './lib/staff-link.js';

const { values } = parseArgs({ options: { email: { type: 'string' }, revoke: { type: 'string' } } });
if (!values.email) {
  console.error('Usage: npm run staff-link -- --email person@example.com [--revoke "reason"]');
  process.exit(1);
}
if (!process.env.MONGODB_URI && !process.env.MONGO_DATA_DIR) {
  console.error('Set MONGODB_URI or MONGO_DATA_DIR: the staff accounts are in that database.');
  process.exit(1);
}

const app = await buildApp({ config: { logLevel: 'warn', jobsEnabled: false } });
try {
  const r = await staffLink(app, { email: values.email, revoke: values.revoke });
  console.log(r.done);
  if (r.link) console.log(`  Link: ${r.link}`);
  if (r.passCode) console.log(`  Pass code: ${r.passCode}`);
  if (r.expiresAt) console.log(`  Valid until: ${r.expiresAt}`);
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await app.close();
}
