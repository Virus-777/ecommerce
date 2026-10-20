/**
 * Password reset: reset links (asked for, sent by staff or another module), checking and completing them, and the
 * password policy.
 */
import { maskEmail } from '../../../kernel/lib/mask.js';
import { AppError } from '../../../kernel/errors/index.js';
import { isUuid, newId } from '../../../kernel/lib/ids.js';
import type * as common from '../../../spec/common.js';
import type { CompleteResetRequest, PasswordPolicy, PasswordResetStatus } from '../../../spec/identity.js';
import { hashPassword, randomToken, tokenHash } from '../domain/crypto.js';
import { normalizeEmail, type Realm } from '../domain/policy.js';
import { accountStatusMachine } from '../domain/state-machines.js';
import * as map from '../mappers.js';
import type { AccountRow } from '../ports.js';
import type { IdentityRepository } from '../repository.js';
import { type Core, type ClientInfo, type Caller, MIN } from './core.js';

export class Passwords {
  constructor(readonly core: Core) {}

  private resetUrl(realm: Realm, token: string) {
    return `${this.core.appUrl(realm === 'staff' ? 'admin' : 'store')}/reset-password#token=${token}`;
  }

  /** Issues a reset link for an account (self-service or by staff) and publishes it */
  async issueReset(repo: IdentityRepository, a: AccountRow, o: { client?: ClientInfo; forcedBy?: common.Actor | null; reason?: string | null }, s: { passwordResetTtlMinutes: number }, now: Date) {
    await repo.invalidateResets(a.id, now);
    const token = randomToken();
    const expiresAt = new Date(now.getTime() + s.passwordResetTtlMinutes * MIN);
    await repo.insertReset({
      id: newId(),
      account_id: a.id,
      token_hash: tokenHash(token),
      forced_by: o.forcedBy ? (o.forcedBy.id ?? o.forcedBy.kind) : null,
      forced_reason: o.reason ?? null,
      expires_at: expiresAt,
      used_at: null,
      requested_ip: o.client?.ip ?? null,
      created_at: now,
    });
    await this.core.securityEvent(repo, a.id, 'password_reset_requested', 'completed', { client: o.client, actor: o.forcedBy ?? null, reason: o.reason ?? null, detail: { forced: Boolean(o.forcedBy) } });
    return () => this.core.publish('identity.password_reset.requested', { accountId: a.id, email: a.email, resetUrl: this.resetUrl(a.realm, token), expiresAt: map.iso(expiresAt), forcedBy: o.forcedBy ?? null });
  }

  /** POST /password-resets: always 202 with the masked email */
  async requestPasswordReset(email: string, caller: Caller): Promise<{ emailMasked: string; expiresInMinutes: number; resendAvailableAt: string }> {
    const s = await this.core.cfg();
    const now = this.core.now();
    const normalized = normalizeEmail(email);
    const accounts = (await this.core.repo.findAccountsByEmail(normalized)).filter((a) => ['active', 'locked', 'pending_verification'].includes(a.status) && a.password_hash);
    const afters: (() => void)[] = [];
    for (const a of accounts) {
      const last = await this.core.repo.latestReset(a.id);
      if (last && now.getTime() - last.created_at.getTime() < s.codeResendSeconds * 1000) continue; // resend timer: same answer, no new link
      afters.push(await this.core.repo.transaction((repo) => this.issueReset(repo, a, { client: caller.client }, s, now)));
    }
    for (const f of afters) f();
    return { emailMasked: maskEmail(email.trim()), expiresInMinutes: s.passwordResetTtlMinutes, resendAvailableAt: map.iso(new Date(now.getTime() + s.codeResendSeconds * 1000)) };
  }

  private async liveReset(repo: IdentityRepository, token: string, now: Date, forUpdate = false) {
    if (typeof token !== 'string' || token.length < 20) return undefined;
    const r = await repo.findResetByHash(tokenHash(token), { forUpdate });
    if (!r || r.used_at || r.expires_at <= now) return undefined;
    const a = await repo.getAccount(r.account_id, { forUpdate });
    if (!a || ['disabled', 'closed', 'invited'].includes(a.status)) return undefined;
    return { reset: r, account: a };
  }

  /** POST /password-resets/lookups */
  async getPasswordReset(token: string): Promise<PasswordResetStatus> {
    const s = await this.core.cfg();
    const found = await this.liveReset(this.core.repo, token, this.core.now());
    if (!found) return { valid: false, emailMasked: null, expiresAt: null, policy: this.core.policyFor('member', s), forced: false };
    return { valid: true, emailMasked: maskEmail(found.account.email), expiresAt: map.iso(found.reset.expires_at), policy: this.core.policyFor(found.account.realm, s), forced: found.reset.forced_by !== null };
  }

  /** POST /password-resets/complete */
  async completePasswordReset(body: CompleteResetRequest, caller: Caller): Promise<void> {
    const s = await this.core.cfg();
    const now = this.core.now();
    const peek = await this.liveReset(this.core.repo, body.token, now);
    if (!peek) throw new AppError('RESET_LINK_INVALID', 'This reset link was used, replaced or has expired');
    const [first, ...rest] = peek.account.display_name.split(' ');
    this.core.assertStrong(body.newPassword, peek.account.realm, [peek.account.email, first, rest.join(' ')], s);
    await this.core.assertNotReused(peek.account.id, body.newPassword, s.passwordHistoryCount);
    const hash = await hashPassword(body.newPassword);
    const out = await this.core.repo.transaction(async (repo) => {
      const found = await this.liveReset(repo, body.token, now, true);
      if (!found) throw new AppError('RESET_LINK_INVALID', 'This reset link was used, replaced or has expired');
      const { reset, account } = found;
      const forced = reset.forced_by !== null || account.must_reset_password;
      await repo.updateReset(reset.id, { used_at: now });
      await repo.invalidateResets(account.id, now);
      // clears automatic lockouts (failed sign-ins); a lock set by staff stays until staff unlock it
      const autoLocked = account.status === 'locked' && !account.locked_by;
      await this.core.storePassword(repo, account.id, hash, now, {
        must_reset_password: false,
        failed_sign_ins: 0,
        failed_window_started_at: null,
        ...(autoLocked ? { status: accountStatusMachine.next('locked', 'unlock'), locked_until: null, lock_reason: null } : {}),
      });
      const signOut = forced || body.signOutOtherDevices;
      if (signOut) await this.core.revoke(repo, { accountId: account.id }, 'passwordChanged', now, true);
      await this.core.securityEvent(repo, account.id, 'password_reset_completed', 'completed', { client: caller.client, detail: { forced, signedOutOthers: signOut } });
      return { account, forced, signOut };
    });
    this.core.publish('identity.password.changed', { accountId: out.account.id, realm: out.account.realm, via: out.forced ? 'forced_reset' : 'reset', otherSessionsRevoked: out.signOut, at: map.iso(now) }, caller);
  }

  /** GET /password-policy */
  async getPasswordPolicy(realm?: Realm | null): Promise<PasswordPolicy> {
    return this.core.policyFor(realm ?? 'member', await this.core.cfg());
  }

  /** Staff-initiated reset link from another module's screen */
  async sendPasswordReset(accountId: string, input: { reason: string; by: common.Actor; revokeSessions: boolean }): Promise<void> {
    const s = await this.core.cfg();
    const now = this.core.now();
    const after = await this.core.repo.transaction(async (repo) => {
      const a = isUuid(accountId) ? await repo.getAccount(accountId, { forUpdate: true }) : undefined;
      if (!a) throw new AppError('NOT_FOUND', 'Account not found');
      if (!a.password_hash || ['disabled', 'closed', 'invited'].includes(a.status)) throw new AppError('ILLEGAL_TRANSITION', 'This account cannot reset its password', { from: a.status, event: 'reset' });
      if (input.revokeSessions) await this.core.revoke(repo, { accountId: a.id }, 'revokeByStaff', now, true);
      return this.issueReset(repo, a, { forcedBy: input.by, reason: input.reason }, s, now);
    });
    after();
  }
}
