#!/usr/bin/env tsx
/**
 * Creates the first Business Owner and a deputy: staff invitations with the Business Owner and
 * Platform Administrator roles, active when each person accepts (password + authenticator). Two people
 * from day one, so every two-person rule works (each approves the other's sensitive grants, e.g. the
 * Finance team). Works only while nobody holds or awaits the role; later staff are invited from the
 * Admin Center.
 *
 *   npm run bootstrap-owner -- --email owner@example.com --name "Ana Lee" --deputy-email cfo@example.com --deputy-name "Ben Ruiz"
 *
 * Runs against the configured database (DATABASE_URL or PGLITE_DIR); the in-memory default would
 * forget the accounts when the command ends, so it refuses that. Prints the invitation links (they are
 * also emailed through notifications). The deputy is optional but recommended: without one, sensitive
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
if (!process.env.DATABASE_URL && !process.env.PGLITE_DIR) {
  console.error('Set DATABASE_URL or PGLITE_DIR: an in-memory database would forget the Business Owner when this command ends.');
  process.exit(1);
}

const app = await buildApp({ config: { logLevel: 'warn', jobsEnabled: false } });
const links = new Map<string, string>();
app.kernel.events.subscribe('bootstrap-owner', 'identity.invitation.created', (e) => {
  const p = e.payload as { email?: string; acceptUrl?: string };
  if (p.email && p.acceptUrl) links.set(p.email.toLowerCase(), p.acceptUrl);
});
try {
  // the service itself: bootstrapBusinessOwner is an operator action, not part of access's public API
  const access = app.kernel.boot.apis.get('access') as AccessService | undefined;
  if (!access) throw new Error('The access module is not enabled');
  const result = await access.bootstrapBusinessOwner({ email: values.email, name: values.name, deputy });
  await app.kernel.events.drain();
  const show = (name: string, email: string, accountId: string, as: string) => {
    console.log(`Invited ${name} <${email}> as ${as} (account ${accountId}).`);
    const link = links.get(email.toLowerCase());
    if (link) console.log(`  Accept link: ${link}`);
  };
  show(values.name, values.email, result.accountId, 'Business Owner');
  if (deputy && result.deputy) show(deputy.name, deputy.email, result.deputy.accountId, 'deputy Business Owner');
  if (!deputy) console.log('No deputy: sensitive grants (e.g. Finance roles) need a second Business Owner to approve them.');
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await app.close();
}
