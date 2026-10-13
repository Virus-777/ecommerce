/**
 * Staff sign-in links for a server without email (npm run staff-link). Invitation and reset tokens are stored only as
 * hashes, so a link that was sent cannot be shown again: each run issues a new one, and the previous link stops
 * working. Every action goes through identity's own rules and is audited as the server operator.
 *
 *   - an invited person who has not accepted yet (link lost or expired): a new invitation link;
 *   - a person with an account: a password reset link (their password works until they use it);
 *   - resetTwoStep: removes their authenticator; at the next sign-in the admin area asks them to set one up again;
 *   - revoke: cancels an invitation not accepted yet (a mistyped email); the roles waiting for it end, so a
 *     Business Owner invitation can be made again with npm run bootstrap-owner.
 */
import type { FastifyInstance } from 'fastify';
import type * as common from '../../src/spec/common.js';
import type { IdentityService } from '../../src/modules/identity/service.js';
import { normalizeEmail } from '../../src/modules/identity/domain/policy.js';

export interface StaffLinkInput {
  email: string;
  /** Cancel the person's invitation instead (it must not be accepted yet) */
  revoke?: string;
  /** Remove the person's 2-step methods (lost phone); the reason is audited */
  resetTwoStep?: string;
}

export interface StaffLinkResult {
  /** What was done, for the operator */
  done: string;
  /** The link to hand to the person, when one was issued */
  link?: string;
  expiresAt?: string;
}

/** Who did it, in the audit trail and the person's security history */
const OPERATOR: common.Actor = { kind: 'system', id: null, name: 'Server operator (npm run staff-link)' };
const CALLER = { principal: null, actor: OPERATOR, client: { ip: null, userAgent: 'npm run staff-link' } };

export async function staffLink(app: FastifyInstance, input: StaffLinkInput): Promise<StaffLinkResult> {
  const identity = app.kernel.boot.apis.get('identity') as IdentityService | undefined;
  if (!identity) throw new Error('The identity module is not enabled');
  const email = normalizeEmail(input.email);
  const account = (await identity.core.repo.findAccountsByEmail(email)).find((a) => a.realm === 'staff');
  if (!account) throw new Error(`No staff account for ${email}. Invite the person from the Admin Center (Staff), or run npm run bootstrap-owner for the first Business Owner.`);
  const invitation = (await identity.core.repo.latestInvitations([account.id])).get(account.id);

  // the links travel in identity's events (they are never stored): catch the one this run publishes
  const links: { url: string; expiresAt: string }[] = [];
  app.kernel.events.subscribe('staff-link', 'identity.invitation.created', (e) => {
    const p = e.payload as { email: string; acceptUrl: string; expiresAt: string };
    if (normalizeEmail(p.email) === email) links.push({ url: p.acceptUrl, expiresAt: p.expiresAt });
  });
  app.kernel.events.subscribe('staff-link', 'identity.password_reset.requested', (e) => {
    const p = e.payload as { email: string; resetUrl: string; expiresAt: string };
    if (normalizeEmail(p.email) === email) links.push({ url: p.resetUrl, expiresAt: p.expiresAt });
  });
  const issued = async (done: string): Promise<StaffLinkResult> => {
    await app.kernel.events.drain();
    const last = links.at(-1);
    return last ? { done, link: last.url, expiresAt: last.expiresAt } : { done };
  };

  if (input.revoke) {
    if (account.status !== 'invited' || !invitation) throw new Error(`${email} has already accepted the invitation: there is nothing to revoke. Disable the account in the Admin Center instead.`);
    await identity.invitations.revokeInvitation(invitation.id, { reason: input.revoke, by: OPERATOR });
    await app.kernel.events.drain();
    return { done: `Revoked the invitation of ${email}; the roles waiting for it have ended.` };
  }

  if (input.resetTwoStep) {
    if (account.status === 'invited') throw new Error(`${email} has not accepted the invitation yet, so has no 2-step method: run this command without --reset-two-step for a new invitation link.`);
    await identity.accounts.resetTwoStep(account.id, { reason: input.resetTwoStep, identityCheck: 'In person, by the server operator' }, CALLER, async () => true);
    return { done: `Removed the 2-step methods of ${email}. At the next sign-in, the admin area asks them to set up an authenticator app again.` };
  }

  if (account.status === 'invited') {
    if (!invitation) throw new Error(`${email} is invited but has no invitation on record`);
    await identity.invitations.resendInvitation(invitation.id, CALLER);
    return issued(`New invitation link for ${email} (the previous one no longer works).`);
  }

  if (!account.password_hash) throw new Error(`${email} (status ${account.status}) has no password to reset`);
  const s = await identity.core.cfg();
  const now = identity.core.now();
  const after = await identity.core.repo.transaction((repo) => identity.passwords.issueReset(repo, account, { forcedBy: OPERATOR, reason: 'Reset link issued by the server operator', client: CALLER.client }, s, now));
  after();
  return issued(`Password reset link for ${email} (their current password works until they use it).`);
}
