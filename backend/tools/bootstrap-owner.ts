#!/usr/bin/env tsx
/**
 * Creates the first Business Owner: a staff invitation with the Business Owner role, which becomes
 * active when the person accepts (sets a password and an authenticator). Works only while nobody
 * holds or awaits the role; every later staff member is invited from the Admin Center.
 *
 *   npm run bootstrap-owner -- --email owner@example.com --name "Ana Lee"
 *
 * Runs against the configured database (DATABASE_URL or PGLITE_DIR); the in-memory default would
 * forget the account when the command ends, so it refuses that. Prints the invitation link (it is
 * also emailed through notifications).
 */
import { parseArgs } from 'node:util';
import { buildApp } from '../src/app.js';
import type { AccessService } from '../src/modules/access/service.js';

const { values } = parseArgs({ options: { email: { type: 'string' }, name: { type: 'string' } } });
if (!values.email || !values.name) {
  console.error('Usage: npm run bootstrap-owner -- --email owner@example.com --name "Ana Lee"');
  process.exit(1);
}
if (!process.env.DATABASE_URL && !process.env.PGLITE_DIR) {
  console.error('Set DATABASE_URL or PGLITE_DIR: an in-memory database would forget the Business Owner when this command ends.');
  process.exit(1);
}

const app = await buildApp({ config: { logLevel: 'warn', jobsEnabled: false } });
let link: string | undefined;
app.kernel.events.subscribe('bootstrap-owner', 'identity.invitation.created', (e) => {
  const p = e.payload as { email?: string; acceptUrl?: string };
  if (p.email?.toLowerCase() === values.email!.toLowerCase()) link = p.acceptUrl;
});
try {
  // the service itself: bootstrapBusinessOwner is an operator action, not part of access's public API
  const access = app.kernel.boot.apis.get('access') as AccessService | undefined;
  if (!access) throw new Error('The access module is not enabled');
  const { accountId } = await access.bootstrapBusinessOwner({ email: values.email, name: values.name });
  await app.kernel.events.drain();
  console.log(`Invited ${values.name} <${values.email}> as Business Owner (account ${accountId}).`);
  if (link) console.log(`Accept link: ${link}`);
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await app.close();
}
