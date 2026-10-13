#!/usr/bin/env tsx
/**
 * Staff sign-in links on a server without email: prints a new invitation or password reset link for a staff member,
 * or resets their 2-step sign-in, or revokes an invitation not accepted yet (tools/lib/staff-link.ts says what each does).
 *
 *   npm run staff-link -- --email ana@company.example                         new invitation or reset link
 *   npm run staff-link -- --email ana@company.example --reset-two-step "Lost phone, checked in person"
 *   npm run staff-link -- --email ana@compnay.example --revoke "Mistyped email"
 *
 * Runs against the configured database (MONGODB_URI, or MONGO_DATA_DIR), like npm run bootstrap-owner. Hand the link
 * to the person in person: it signs them in to the Admin Center.
 */
import { parseArgs } from 'node:util';
import { buildApp } from '../src/app.js';
import { staffLink } from './lib/staff-link.js';

const { values } = parseArgs({ options: { email: { type: 'string' }, revoke: { type: 'string' }, 'reset-two-step': { type: 'string' } } });
if (!values.email || (values.revoke && values['reset-two-step'])) {
  console.error('Usage: npm run staff-link -- --email person@example.com [--reset-two-step "reason" | --revoke "reason"]');
  process.exit(1);
}
if (!process.env.MONGODB_URI && !process.env.MONGO_DATA_DIR) {
  console.error('Set MONGODB_URI or MONGO_DATA_DIR: the staff accounts are in that database.');
  process.exit(1);
}

const app = await buildApp({ config: { logLevel: 'warn', jobsEnabled: false } });
try {
  const r = await staffLink(app, { email: values.email, revoke: values.revoke, resetTwoStep: values['reset-two-step'] });
  console.log(r.done);
  if (r.link) console.log(`  Link: ${r.link}\n  Valid until: ${r.expiresAt}`);
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await app.close();
}
