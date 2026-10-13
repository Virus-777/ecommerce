/**
 * Staff sign-in links for a server without email (npm run staff-link). Invitation and reset tokens, and invitation
 * pass codes, are stored only as hashes, so what was sent cannot be shown again: each run issues a new link (and pass
 * code), and the previous ones stop working. Every action goes through identity's own rules and is audited as the
 * server operator.
 *
 *   - an invited person who has not accepted yet (link lost or expired, invited from the Admin Center, or a link
 *     ended by 5 wrong pass codes): a new invitation link and pass code; hand both over;
 *   - a person with an account: a password reset link (their password works until they use it);
 *   - revoke: cancels an invitation not accepted yet (a mistyped email); the roles waiting for it end, so a
 *     Business Owner invitation can be made again with npm run bootstrap-owner.
 *
 * Staff have no 2-step sign-in (owner decision 2026-10-14), so there is nothing to reset for a lost phone.
 */
import type { FastifyInstance } from 'fastify';
import type * as common from '../../src/spec/common.js';
import type { IdentityService } from '../../src/modules/identity/service.js';
import { normalizeEmail } from '../../src/modules/identity/domain/policy.js';

export interface StaffLinkInput {
  email: string;
  /** Cancel the person's invitation instead (it must not be accepted yet) */
  revoke?: string;
}

export interface StaffLinkResult {
  /** What was done, for the operator */
  done: string;
  /** The link to hand to the person, when one was issued */
  link?: string;
  /** The invitation pass code to hand over with the link (new invitation links only) */
  passCode?: string;
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

  if (input.revoke) {
    if (account.status !== 'invited' || !invitation) throw new Error(`${email} has already accepted the invitation: there is nothing to revoke. Disable the account in the Admin Center instead.`);
    await identity.invitations.revokeInvitation(invitation.id, { reason: input.revoke, by: OPERATOR });
    await app.kernel.events.drain();
    return { done: `Revoked the invitation of ${email}; the roles waiting for it have ended.` };
  }

  if (account.status === 'invited') {
    if (!invitation) throw new Error(`${email} is invited but has no invitation on record`);
    // the link and pass code come back from identity in-process: the pass code is in no event, email or log
    const issued = await identity.invitations.resendInvitation(invitation.id, CALLER);
    await app.kernel.events.drain();
    return {
      done: `New invitation link and pass code for ${email} (the previous ones no longer work). They open the link, enter the pass code and choose a password.`,
      link: issued.acceptUrl,
      passCode: issued.passCode,
      expiresAt: issued.invitation.expiresAt,
    };
  }

  if (!account.password_hash) throw new Error(`${email} (status ${account.status}) has no password to reset`);
  // the reset link travels in identity's event (it is never stored): catch the one this run publishes
  const links: { url: string; expiresAt: string }[] = [];
  app.kernel.events.subscribe('staff-link', 'identity.password_reset.requested', (e) => {
    const p = e.payload as { email: string; resetUrl: string; expiresAt: string };
    if (normalizeEmail(p.email) === email) links.push({ url: p.resetUrl, expiresAt: p.expiresAt });
  });
  const s = await identity.core.cfg();
  const now = identity.core.now();
  const after = await identity.core.repo.transaction((repo) => identity.passwords.issueReset(repo, account, { forcedBy: OPERATOR, reason: 'Reset link issued by the server operator', client: CALLER.client }, s, now));
  after();
  await app.kernel.events.drain();
  const last = links.at(-1);
  const done = `Password reset link for ${email} (their current password works until they use it).`;
  return last ? { done, link: last.url, expiresAt: last.expiresAt } : { done };
}
