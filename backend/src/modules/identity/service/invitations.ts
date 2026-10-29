/**
 * Invitations: staff and seller-member invitations, accepting one (password and, for staff, the invitation pass
 * code), and the staff list with resend and revoke.
 *
 * Staff pass codes (owner decision 2026-10-14: the server runs offline, staff use no authenticator app): each staff
 * link comes with a pass code that only the code which created the invitation sees (StaffInvitationIssued: shown once
 * to the inviter in the invite and resend responses, printed by npm run bootstrap-owner and npm run staff-link). The link alone, e.g. from a forwarded email, does not let
 * anyone in. Only a keyed hash is stored, and the 5th wrong pass code ends the link.
 */
import { maskEmail } from '../../../kernel/lib/mask.js';
import { AppError } from '../../../kernel/errors/index.js';
import { isUuid, newId } from '../../../kernel/lib/ids.js';
import type { PageRequest } from '../../../kernel/lib/pagination.js';
import type * as common from '../../../spec/common.js';
import type {
  AcceptInvitationRequest,
  AcceptInvitationResult,
  Invitation,
  InvitationView,
  StaffInvitationIssued,
} from '../../../spec/identity.js';
import { hashPassword, newPassCode, randomToken, safeEqual, tokenHash, verifyPassword } from '../domain/crypto.js';
import { lockInForce, normalizeEmail, type Realm } from '../domain/policy.js';
import { accountStatusMachine, invitationMachine } from '../domain/state-machines.js';
import * as map from '../mappers.js';
import type { AccountRow, InvitationRow } from '../ports.js';
import type { IdentityRepository } from '../repository.js';
import { type Core, type ClientInfo, type Caller, type WithCookie, DAY, issue } from './core.js';
import type { Authentication } from './authentication.js';

/** Wrong pass codes a staff link allows; the last one revokes it (the operator issues a new link with npm run staff-link) */
export const PASS_CODE_ATTEMPTS = 5;
const PASS_CODE_LOCKED = 'Too many wrong pass codes';

export class Invitations {
  constructor(
    readonly core: Core,
    readonly authentication: Authentication,
  ) {}

  private invitationUrl(i: Pick<InvitationRow, 'purpose'>, token: string) {
    return `${this.core.appUrl(i.purpose === 'staff' ? 'admin' : 'seller')}/invitation#token=${token}`;
  }

  /** The pass code typed on the accept page matches the one handed over with this link */
  private passCodeMatches(i: InvitationRow, passCode: string | null | undefined): boolean {
    if (!i.pass_code_hash || typeof passCode !== 'string' || !passCode.trim()) return false;
    return safeEqual(i.pass_code_hash, this.core.passCodeHash(i.id, passCode));
  }

  /**
   * Counts a wrong pass code on the link. The 5th revokes the link but keeps the account invited and its roles
   * waiting (no identity.invitation.revoked), so npm run staff-link can hand over a new link and pass code.
   */
  private async wrongPassCode(repo: IdentityRepository, i: InvitationRow, a: AccountRow, caller: Caller, now: Date): Promise<AppError> {
    const attempts = (i.pass_code_attempts ?? 0) + 1;
    const revoked = attempts >= PASS_CODE_ATTEMPTS;
    await repo.updateInvitation(i.id, revoked ? { pass_code_attempts: attempts, status: invitationMachine.next('pending', 'revoke'), revoked_at: now, revoke_reason: PASS_CODE_LOCKED } : { pass_code_attempts: attempts });
    await this.core.securityEvent(repo, a.id, 'sign_in_failed', 'failed', { client: caller.client, audience: 'admin', detail: { reason: 'invitation_pass_code', revoked } });
    if (revoked) return new AppError('PASS_CODE_INVALID', 'Too many wrong pass codes: this invitation link no longer works. Ask for a new link and pass code.', { attemptsLeft: 0 });
    return new AppError('PASS_CODE_INVALID', 'That pass code is not right', { attemptsLeft: PASS_CODE_ATTEMPTS - attempts });
  }

  private invitationCreated(i: InvitationRow, token: string, by?: { actor?: common.Actor; requestId?: string }) {
    this.core.publish(
      'identity.invitation.created',
      {
        invitationId: i.id,
        purpose: i.purpose,
        email: i.email,
        name: i.name,
        acceptUrl: this.invitationUrl(i, token),
        contextRef: i.context_ref,
        contextLabel: i.context_label,
        invitedBy: map.actorOfRow(i.invited_by_kind, i.invited_by_id) ?? { kind: 'system' },
        expiresAt: map.iso(i.expires_at),
      },
      by,
    );
  }

  private async liveInvitation(repo: IdentityRepository, token: string, now: Date, forUpdate = false) {
    const i = typeof token === 'string' && token.length >= 20 ? await repo.findInvitationByHash(tokenHash(token), { forUpdate }) : undefined;
    if (!i || i.status !== 'pending' || i.expires_at <= now) throw new AppError('INVITATION_INVALID', 'This invitation was accepted, cancelled or has expired');
    return i;
  }

  /** The account an invitation is for, if it has one already */
  private async invitedAccount(repo: IdentityRepository, i: InvitationRow, forUpdate = false) {
    if (i.account_id) return repo.getAccount(i.account_id, { forUpdate });
    return repo.findAccount(i.realm as Realm, normalizeEmail(i.email), { forUpdate });
  }

  /** POST /invitations/lookups */
  async getInvitation(token: string): Promise<InvitationView> {
    const s = await this.core.cfg();
    const now = this.core.now();
    const i = await this.liveInvitation(this.core.repo, token, now);
    const a = await this.invitedAccount(this.core.repo, i);
    return {
      purpose: i.purpose,
      emailMasked: maskEmail(i.email),
      name: i.name,
      contextLabel: i.context_label,
      existingAccount: i.purpose === 'seller_member' && Boolean(a?.password_hash) && a?.status !== 'invited',
      requiresPassCode: i.purpose === 'staff',
      policy: this.core.policyFor(i.realm as Realm, s),
      expiresAt: map.iso(i.expires_at),
    };
  }

  /** POST /invitations/accept */
  async acceptInvitation(body: AcceptInvitationRequest, caller: Caller): Promise<WithCookie<AcceptInvitationResult>> {
    const s = await this.core.cfg();
    const now = this.core.now();
    const peek = await this.liveInvitation(this.core.repo, body.token, now);
    // a missing pass code is a form problem, not a guess: refused before anything is counted
    if (peek.purpose === 'staff' && !body.passCode?.trim()) throw new AppError('PASS_CODE_INVALID', 'Enter the pass code you were given with the link', { attemptsLeft: PASS_CODE_ATTEMPTS - (peek.pass_code_attempts ?? 0) });
    const peekAccount = await this.invitedAccount(this.core.repo, peek);
    const existingMember = peek.purpose === 'seller_member' && peekAccount && peekAccount.password_hash && peekAccount.status !== 'invited' ? peekAccount : undefined;
    const name = body.name?.trim() || peek.name;
    let hash: string | null = null;
    if (existingMember) {
      if (!body.currentPassword) throw new AppError('VALIDATION_FAILED', 'Enter your current password', issue('body.currentPassword', 'required for an existing account'));
    } else {
      if (!body.password) throw new AppError('VALIDATION_FAILED', 'Choose a password', issue('body.password', 'required'));
      const [first, ...rest] = name.split(' ');
      this.core.assertStrong(body.password, peek.realm as Realm, [peek.email, first, rest.join(' ')], s);
      hash = await hashPassword(body.password);
    }
    const passwordOk = existingMember ? await verifyPassword(existingMember.password_hash, body.currentPassword!) : true;
    let after = () => {};
    const web = body.device.kind === 'web';
    const outcome = await this.core.repo.transaction(async (repo): Promise<{ error: AppError } | { result: AcceptInvitationResult }> => {
      const i = await this.liveInvitation(repo, body.token, now, true);
      let a = await this.invitedAccount(repo, i, true);

      if (i.purpose === 'staff') {
        if (!a || a.status !== 'invited') throw new AppError('INVITATION_INVALID', 'This invitation is no longer valid');
        // counted in this transaction, which commits: the error is returned, not thrown
        if (!this.passCodeMatches(i, body.passCode)) {
          const error = await this.wrongPassCode(repo, i, a, caller, now);
          return { error };
        }
        // the link and the pass code are the proof: the account is active and signed in at once (no 2-step set-up)
        a = await this.core.storePassword(repo, a.id, hash!, now, { display_name: name, status: accountStatusMachine.next('invited', 'acceptInvitation'), email_verified_at: now });
        await repo.updateInvitation(i.id, { status: invitationMachine.next('pending', 'accept'), accepted_at: now, account_id: a.id });
        const done = await this.core.completeSignIn(repo, a, { audience: 'admin', device: body.device, client: caller.client, keepSignedIn: false, twoStepVerified: false, method: 'invitation' }, s, now);
        after = () => {
          this.core.publish('identity.invitation.accepted', { invitationId: i.id, accountId: a!.id, purpose: i.purpose, contextRef: i.context_ref }, caller);
          done.after();
        };
        return { result: { status: 'signed_in', account: done.result.account!, tokens: done.result.tokens } };
      }

      // seller member: an existing member account confirms with its password; otherwise one is created
      if (existingMember) {
        if (!passwordOk) {
          const f = await this.authentication.countFailure(repo, a!, s, now, { client: caller.client, audience: 'seller', reason: 'password' });
          after = f.after;
          return { error: new AppError('INVALID_CREDENTIALS', "That password doesn't match this account", { attemptsLeft: f.attemptsLeft, lockoutMinutes: s.lockoutMinutes }) };
        }
        a = await this.authentication.liftExpiredLock(repo, a!, now);
        if (lockInForce(a, now)) return { error: this.authentication.lockedError(a) };
        if (a.status === 'disabled') return { error: new AppError('ACCOUNT_DISABLED', 'This account is disabled') };
        if (a.status === 'pending_verification') a = await repo.updateAccount(a.id, { status: accountStatusMachine.next('pending_verification', 'verifyEmail'), email_verified_at: now });
      } else if (a && a.status === 'pending_verification') {
        // an unconfirmed registration with this email: the invitation link proves the address
        a = await this.core.storePassword(repo, a.id, hash!, now, { display_name: name, status: accountStatusMachine.next('pending_verification', 'verifyEmail'), email_verified_at: now });
      } else if (!a) {
        a = {
          id: newId(),
          realm: 'member',
          email: i.email,
          email_normalized: normalizeEmail(i.email),
          email_verified_at: now,
          display_name: name,
          status: accountStatusMachine.initial,
          password_hash: hash,
          password_changed_at: now,
          must_reset_password: false,
          failed_sign_ins: 0,
          failed_window_started_at: null,
          locked_until: null,
          lock_reason: null,
          locked_by: null,
          closed_at: null,
          accepted_terms_version: null,
          created_at: now,
          last_sign_in_at: null,
          last_active_at: null,
          version: 1,
          tokens_valid_after: null,
        };
        await repo.insertAccount(a);
        await repo.addPasswordHistory({ id: newId(), account_id: a.id, password_hash: hash!, created_at: now });
      } else {
        return { error: new AppError('INVITATION_INVALID', 'This invitation is no longer valid') };
      }
      const account = a;
      await repo.updateInvitation(i.id, { status: invitationMachine.next('pending', 'accept'), accepted_at: now, account_id: account.id });
      // seller access arrives when sellers consumes identity.invitation.accepted (grantSellerContext);
      // until then the session has no seller and the app picks it with POST /session/seller-context
      // openSession stamps last_used_at on this row, so it is locked when it is read (§11.2 rule 1)
      const access = i.context_ref ? await repo.getSellerAccess(account.id, i.context_ref, { forUpdate: true }) : undefined;
      const opened = await this.core.openSession(
        repo,
        account,
        { audience: 'seller', device: body.device, client: caller.client, keepSignedIn: false, twoStepVerified: false, seller: access && !access.revoked_at ? access : null, method: 'invitation' },
        s,
        now,
      );
      after = () => {
        this.core.publish('identity.invitation.accepted', { invitationId: i.id, accountId: account.id, purpose: i.purpose, contextRef: i.context_ref }, caller);
        opened.after();
      };
      const fresh = (await repo.getAccount(account.id))!;
      return { result: { status: 'signed_in', account: await this.core.summaryOf(fresh, repo), tokens: this.core.sessionTokens(opened.session, fresh, opened.refreshToken, s) } };
    });
    after();
    if ('error' in outcome) throw outcome.error;
    return this.core.deliver(outcome.result, web, now);
  }

  /**
   * Public API: invite a staff member (access assigns the roles). The link is emailed (identity.invitation.created);
   * the pass code only comes back here, for the server tools to print.
   */
  async inviteStaff(input: { email: string; name: string; invitedBy: common.Actor }): Promise<StaffInvitationIssued> {
    const s = await this.core.cfg();
    const now = this.core.now();
    const email = normalizeEmail(input.email);
    const token = randomToken();
    const passCode = newPassCode();
    const invitationId = newId();
    const row = await this.core.repo.transaction(async (repo) => {
      let a = await repo.findAccount('staff', email, { forUpdate: true });
      if (a && a.status !== 'invited') throw new AppError('EMAIL_IN_USE', 'A staff account already uses that email');
      if (!a) {
        a = {
          id: newId(),
          realm: 'staff',
          email: input.email.trim(),
          email_normalized: email,
          email_verified_at: null,
          display_name: input.name.trim(),
          status: 'invited',
          password_hash: null,
          password_changed_at: null,
          must_reset_password: false,
          failed_sign_ins: 0,
          failed_window_started_at: null,
          locked_until: null,
          lock_reason: null,
          locked_by: null,
          closed_at: null,
          accepted_terms_version: null,
          created_at: now,
          last_sign_in_at: null,
          last_active_at: null,
          version: 1,
          tokens_valid_after: null,
        };
        await repo.insertAccount(a);
      }
      await repo.revokePendingInvitations({ email: a.email, purpose: 'staff', contextRef: null }, 'replaced', now);
      const i: InvitationRow = {
        id: invitationId,
        realm: 'staff',
        purpose: 'staff',
        email: a.email,
        name: input.name.trim(),
        account_id: a.id,
        context_ref: null,
        context_label: null,
        token_hash: tokenHash(token),
        pass_code_hash: this.core.passCodeHash(invitationId, passCode),
        pass_code_attempts: 0,
        invited_by_kind: input.invitedBy.kind,
        invited_by_id: input.invitedBy.id ?? '',
        status: invitationMachine.initial,
        sent_at: now,
        expires_at: new Date(now.getTime() + s.invitationTtlDays * DAY),
        accepted_at: null,
        revoked_at: null,
        revoke_reason: null,
      };
      await repo.insertInvitation(i);
      return i;
    });
    this.invitationCreated(row, token, { actor: input.invitedBy });
    return { invitation: map.invitation(row, now), acceptUrl: this.invitationUrl(row, token), passCode };
  }

  /** Public API: invite a person to act for a seller (reuses their member account) */
  async inviteSellerMember(input: { email: string; name: string; sellerId: string; sellerName: string; invitedBy: common.Actor }): Promise<Invitation> {
    const s = await this.core.cfg();
    const now = this.core.now();
    const token = randomToken();
    const email = normalizeEmail(input.email);
    const row = await this.core.repo.transaction(async (repo) => {
      const a = await repo.findAccount('member', email);
      await repo.revokePendingInvitations({ email: a?.email ?? input.email.trim(), purpose: 'seller_member', contextRef: input.sellerId }, 'replaced', now);
      const i: InvitationRow = {
        id: newId(),
        realm: 'member',
        purpose: 'seller_member',
        email: a?.email ?? input.email.trim(),
        name: input.name.trim(),
        account_id: a?.id ?? null,
        context_ref: input.sellerId,
        context_label: input.sellerName,
        token_hash: tokenHash(token),
        // seller members accept with the link alone (unchanged): pass codes are for staff only
        pass_code_hash: null,
        pass_code_attempts: 0,
        invited_by_kind: input.invitedBy.kind,
        invited_by_id: input.invitedBy.id ?? '',
        status: invitationMachine.initial,
        sent_at: now,
        expires_at: new Date(now.getTime() + s.invitationTtlDays * DAY),
        accepted_at: null,
        revoked_at: null,
        revoke_reason: null,
      };
      await repo.insertInvitation(i);
      return i;
    });
    this.invitationCreated(row, token, { actor: input.invitedBy });
    return map.invitation(row, now);
  }

  /** GET /invitations (staff invitations) */
  async listInvitations(status: string | null | undefined, page: PageRequest): Promise<common.Page<Invitation>> {
    const now = this.core.now();
    const res = await this.core.repo.listInvitations({ purpose: 'staff', status }, page);
    return { ...res, items: res.items.map((i) => map.invitation(i, now)) };
  }

  private async staffInvitation(id: string) {
    const i = isUuid(id) ? await this.core.repo.getInvitation(id) : undefined;
    if (!i || i.purpose !== 'staff') throw new AppError('NOT_FOUND', 'Invitation not found');
    return i;
  }

  /**
   * POST /invitations/{id}/resend and npm run staff-link: a new 7-day link and pass code; the old ones stop working.
   * The HTTP endpoint answers only the invitation: the pass code reaches the person through the server operator.
   */
  async resendInvitation(id: string, caller: Caller): Promise<StaffInvitationIssued> {
    const s = await this.core.cfg();
    const now = this.core.now();
    await this.staffInvitation(id);
    const token = randomToken();
    const passCode = newPassCode();
    const row = await this.core.repo.transaction(async (repo) => {
      const i = (await repo.getInvitation(id, { forUpdate: true }))!;
      const from = i.status === 'pending' && i.expires_at <= now ? 'expired' : i.status;
      const status = invitationMachine.next(from as never, 'resend');
      const a = i.account_id ? await repo.getAccount(i.account_id) : undefined;
      if (a && a.status === 'closed') throw new AppError('ILLEGAL_TRANSITION', 'This invitation was cancelled; invite the person again', { from: i.status, event: 'resend' });
      if (a && a.status !== 'invited') throw new AppError('ILLEGAL_TRANSITION', 'This person already has an active staff account', { from: a.status, event: 'resend' });
      // one live link per person: a newer invitation still pending is replaced by this one
      await repo.revokePendingInvitations({ email: i.email, purpose: 'staff', contextRef: null }, 'replaced', now);
      return repo.updateInvitation(i.id, {
        status,
        token_hash: tokenHash(token),
        pass_code_hash: this.core.passCodeHash(i.id, passCode),
        pass_code_attempts: 0,
        sent_at: now,
        expires_at: new Date(now.getTime() + s.invitationTtlDays * DAY),
        revoked_at: null,
        revoke_reason: null,
      });
    });
    this.invitationCreated(row, token, caller);
    await this.core.audit({ action: 'identity.invitation.resend', actionLabel: 'Resent staff invitation', target: { type: 'staff_invitation', id: row.id, label: `${row.name} (${row.email})`, screen: 'admin/staff' } }, caller);
    return { invitation: map.invitation(row, now), acceptUrl: this.invitationUrl(row, token), passCode };
  }

  /** POST /invitations/{id}/revoke: the invited account closes */
  async revokeStaffInvitation(id: string, reason: string, caller: Caller): Promise<Invitation> {
    await this.staffInvitation(id);
    return this.revokeInvitationCore(id, { reason, by: caller.actor, requestId: caller.requestId, client: caller.client });
  }

  /**
   * Public API: cancel a pending invitation (sellers passes its sellerId as contextRef). Another context's
   * invitation is NOT_FOUND; an already revoked one comes back unchanged; accepted or expired ones are
   * ILLEGAL_TRANSITION.
   */
  async revokeInvitation(invitationId: string, input: { reason: string; by: common.Actor; contextRef?: string }): Promise<Invitation> {
    return this.revokeInvitationCore(invitationId, { reason: input.reason, by: input.by, contextRef: input.contextRef });
  }

  /** The pending staff invitations a staff member sent, cancelled when their account is disabled */
  async revokeSentBy(accountId: string, reason: string, caller: Caller): Promise<number> {
    const rows = await this.core.repo.pendingStaffInvitationsBy(accountId);
    for (const r of rows) await this.revokeInvitationCore(r.id, { reason, by: caller.actor, requestId: caller.requestId, client: caller.client });
    return rows.length;
  }

  private async revokeInvitationCore(id: string, o: { reason: string; by: common.Actor; contextRef?: string; requestId?: string; client?: ClientInfo }): Promise<Invitation> {
    const now = this.core.now();
    const result = await this.core.repo.transaction(async (repo) => {
      const i = isUuid(id) ? await repo.getInvitation(id, { forUpdate: true }) : undefined;
      if (!i || (o.contextRef !== undefined && i.context_ref !== o.contextRef)) throw new AppError('NOT_FOUND', 'Invitation not found');
      const a = i.account_id ? await repo.getAccount(i.account_id, { forUpdate: true }) : undefined;
      // a staff link ended by wrong pass codes is revoked but its account still waits: cancelling it closes the account
      const lockedOut = i.status === 'revoked' && i.revoke_reason === PASS_CODE_LOCKED && a?.status === 'invited';
      if (i.status === 'revoked' && !lockedOut) return { row: i, changed: false };
      // a pending link past its end is expired even before the hourly job marks it
      const from = i.status === 'pending' && i.expires_at <= now ? 'expired' : i.status;
      const updated = await repo.updateInvitation(i.id, lockedOut ? { revoked_at: now, revoke_reason: o.reason } : { status: invitationMachine.next(from as never, 'revoke'), revoked_at: now, revoke_reason: o.reason });
      if (a && a.status === 'invited') await repo.updateAccount(a.id, { status: accountStatusMachine.next('invited', 'revokeInvitation'), closed_at: now });
      return { row: updated, changed: true };
    });
    const row = result.row;
    if (result.changed) {
      const by = { actor: o.by, requestId: o.requestId, client: o.client };
      this.core.publish('identity.invitation.revoked', { invitationId: row.id, purpose: row.purpose, contextRef: row.context_ref, accountId: row.account_id }, by);
      // seller member invitations are audited by sellers (the action the seller took)
      if (row.purpose === 'staff') {
        await this.core.audit({ action: 'identity.invitation.revoke', actionLabel: 'Cancelled staff invitation', target: { type: 'staff_invitation', id: row.id, label: `${row.name} (${row.email})`, screen: 'admin/staff' }, reason: o.reason }, by);
      }
    }
    return map.invitation(row, now);
  }
}
