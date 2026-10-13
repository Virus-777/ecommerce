#!/usr/bin/env tsx
/**
 * Creates the first Business Owner and a deputy: staff invitations with the Business Owner and
 * Platform Administrator roles, active when each person accepts (link + pass code + a new password). Two people
 * from day one, so every two-person rule works (each approves the other's sensitive grants, e.g. the
 * Finance team). Works only while nobody holds or awaits the role; later staff are invited from the
 * Admin Center.
 *
 *   npm run bootstrap-owner -- --email owner@example.com --name "Ana Lee" --deputy-email cfo@example.com --deputy-name "Ben Ruiz"
 *
 * Runs against the configured database (MONGODB_URI, or the embedded one kept in MONGO_DATA_DIR); the in-memory
 * default would forget the accounts when the command ends, so it refuses that. Prints each person's link and pass
 * code: hand both over in person. The link is also emailed through notifications when email works; the pass code
 * never is (it is printed only here). The deputy is optional but recommended: without one, sensitive
 * grants can't be approved until a second Business Owner exists.
 */
import { parseArgs } from 'node:util';
import { buildApp } from '../src/app.js';
import type { AccessService } from '../src/modules/access/service.js';

const { values } = parseArgs({ options: { email: { type: 'string' }, name: { type: 'string' }, 'deputy-email': { type: 'string' }, 'deputy-name': { type: 'string' } } });
if (!values.email || !values.name || Boolean(values['deputy-email']) !== Boolean(values['deputy-name'])) {
  console.error('Usage: npm run bootstrap-owner -- --email owner@example.com --name "Ana Lee" [--deputy-email deputy@example.com --deputy-name "Ben Ruiz"]');
  process.exit(1);
}
const deputy = values['deputy-email'] ? { email: values['deputy-email'], name: values['deputy-name']! } : null;
if (!process.env.MONGODB_URI && !process.env.MONGO_DATA_DIR) {
  console.error('Set MONGODB_URI or MONGO_DATA_DIR: an in-memory database would forget the Business Owner when this command ends.');
  process.exit(1);
}

const app = await buildApp({ config: { logLevel: 'warn', jobsEnabled: false } });
try {
  // the service itself: bootstrapBusinessOwner is an operator action, not part of access's public API
  const access = app.kernel.boot.apis.get('access') as AccessService | undefined;
  if (!access) throw new Error('The access module is not enabled');
  const result = await access.bootstrapBusinessOwner({ email: values.email, name: values.name, deputy });
  await app.kernel.events.drain();
  const show = (name: string, email: string, p: { accountId: string; acceptUrl: string; passCode: string }, as: string) => {
    console.log(`Invited ${name} <${email}> as ${as} (account ${p.accountId}).`);
    console.log(`  Link: ${p.acceptUrl}`);
    console.log(`  Pass code: ${p.passCode}`);
  };
  show(values.name, values.email, result, 'Business Owner');
  if (deputy && result.deputy) show(deputy.name, deputy.email, result.deputy, 'deputy Business Owner');
  console.log('Each person opens their link, enters the pass code and chooses a password. A link works 7 days; 5 wrong pass codes end it.');
  if (!deputy) console.log('No deputy: sensitive grants (e.g. Finance roles) need a second Business Owner to approve them.');
} catch (err) {
  console.error((err as Error).message);
  if ((err as { code?: string }).code === 'CONFLICT') {
    console.error('A lost or expired link:  npm run staff-link -- --email <their email>   (prints a new link and pass code)');
    console.error('A mistyped email:        npm run staff-link -- --email <that email> --revoke "Mistyped email", then run this command again');
  }
  process.exitCode = 1;
} finally {
  await app.close();
}
