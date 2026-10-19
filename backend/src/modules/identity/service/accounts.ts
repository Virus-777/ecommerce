/**
 * Account administration (Admin Center): list and view accounts, lock and unlock, force a password reset, reset
 * 2-step, sign out everywhere, disable and enable staff accounts, account activity; and closing an account.
 */
import { AppError, isNotImplemented } from '../../../kernel/errors/index.js';
import { zonedTimeToUtc } from '../../../kernel/lib/clock.js';
import { isUuid } from '../../../kernel/lib/ids.js';
import type { PageRequest } from '../../../kernel/lib/pagination.js';
import type * as audit from '../../../spec/audit.js';
import type * as common from '../../../spec/common.js';
import type { AccountAdmin, AccountListItem, LockRequest, SecurityEvent } from '../../../spec/identity.js';
import { failuresInWindow, lockInForce, type Realm } from '../domain/policy.js';
import { accountStatusMachine } from '../domain/state-machines.js';
import * as map from '../mappers.js';
import type { AccountRow } from '../ports.js';
import { type Core, type Caller, issue } from './core.js';
import type { Security } from './security.js';
import type { Authentication } from './authentication.js';
import type { Passwords } from './passwords.js';
import type { Invitations } from './invitations.js';

export class Accounts {
  constructor(
    readonly core: Core,
    readonly security: Security,
    readonly authentication: Authentication,
    readonly passwords: Passwords,
    readonly invitations: Invitations,
  ) {}

  /** Staff-realm records need identity.staff-accounts.manage as well (permissionWhen on the target's realm) */
  private async assertRealmAccess(a: AccountRow, can: (p: string) => Promise<boolean>) {
    if (a.realm === 'staff' && !(await can('identity.staff-accounts.manage'))) throw new AppError('FORBIDDEN', 'Staff accounts need identity.staff-accounts.manage', { permission: 'identity.staff-accounts.manage' });
  }

  private async targetAccount(id: string, can: (p: string) => Promise<boolean>) {
    const a = isUuid(id) ? await this.core.repo.getAccount(id) : undefined;
    if (!a) throw new AppError('NOT_FOUND', 'Account not found');
    await this.assertRealmAccess(a, can);
    return a;
  }

  private notSelf(a: AccountRow, caller: Caller) {
    if (caller.principal?.accountId === a.id) throw new AppError('SELF_ACTION_NOT_ALLOWED', 'You cannot do this to your own account');
  }

  /** GET /accounts */
  async listAccounts(query: { realm: Realm; q?: string | null; status?: string | null; twoStepEnabled?: boolean | null }, page: PageRequest, can: (p: string) => Promise<boolean>): Promise<common.Page<AccountListItem>> {
    if (query.realm === 'staff' && !(await can('identity.staff-accounts.manage'))) throw new AppError('FORBIDDEN', 'Staff accounts need identity.staff-accounts.manage', { permission: 'identity.staff-accounts.manage' });
    const res = await this.core.repo.listAccounts(query, page);
    const ids = res.items.map((a) => a.id);
    const [twoStep, sellers] = await Promise.all([this.core.repo.withTwoStep(ids), this.core.repo.sellerCounts(ids)]);
    const now = this.core.now();
    return {
      ...res,
      items: res.items.map((a) => ({
        account: map.accountSummary(a, twoStep.has(a.id), now),
        lockedUntil: map.isoOrNull(lockInForce(a, now) ? a.locked_until : null),
        mustResetPassword: a.must_reset_password,
        sellerCount: sellers.get(a.id) ?? 0,
        createdAt: map.iso(a.created_at),
        lastSignInAt: map.isoOrNull(a.last_sign_in_at),
      })),
    };
  }

  private async accountAdmins(ids: string[], activityLimit = 20): Promise<Map<string, AccountAdmin>> {
    const s = await this.core.cfg();
    const now = this.core.now();
    const out = new Map<string, AccountAdmin>();
    for (const [id, x] of await this.security.securityOf(ids, activityLimit)) {
      const a = x.account;
      const locked = lockInForce(a, now);
      out.set(id, {
        account: map.accountSummary(a, x.methods.length > 0, now),
        lockedUntil: map.isoOrNull(locked ? a.locked_until : null),
        lockReason: locked ? a.lock_reason : null,
        mustResetPassword: a.must_reset_password,
        failedSignInsInWindow: failuresInWindow(a, now, s.lockoutMinutes),
        createdAt: map.iso(a.created_at),
        lastSignInAt: map.isoOrNull(a.last_sign_in_at),
        passwordChangedAt: map.isoOrNull(a.password_changed_at),
        twoStep: map.twoStepStatus(x.methods, x.recovery),
        devices: x.devices.map((d) => map.device(d)),
        sellerContexts: x.sellers.map(map.sellerContext),
        invitation: x.invitation ? map.invitation(x.invitation, now) : null,
        recentActivity: x.events.map(map.securityEvent),
      });
    }
    return out;
  }

  private async accountAdmin(id: string) {
    return (await this.accountAdmins([id])).get(id)!;
  }

  /** GET /accounts/{id} */
  async getAccountAdmin(id: string, can: (p: string) => Promise<boolean>): Promise<AccountAdmin> {
    const a = await this.targetAccount(id, can);
    return this.accountAdmin(a.id);
  }

  /** POST /accounts/{id}/lock: revokes every session */
  async lockAccount(id: string, body: LockRequest, caller: Caller, can: (p: string) => Promise<boolean>): Promise<AccountAdmin> {
    const now = this.core.now();
    const a = await this.targetAccount(id, can);
    this.notSelf(a, caller);
    const until = body.until ? new Date(body.until) : null;
    if (until && until <= now) throw new AppError('VALIDATION_FAILED', 'The lock must end in the future', issue('body.until', 'must be in the future'));
    const before = await this.accountAdmin(a.id);
    await this.core.repo.transaction(async (repo) => {
      let cur = (await repo.getAccount(a.id, { forUpdate: true }))!;
      cur = await this.authentication.liftExpiredLock(repo, cur, now);
      // an automatic lock in force can be turned into a staff lock; otherwise only active accounts lock
      const status = cur.status === 'locked' && !cur.locked_by ? 'locked' : accountStatusMachine.next(cur.status as never, 'lock');
      await repo.updateAccount(cur.id, { status, locked_until: until, lock_reason: body.reason, locked_by: caller.actor.id ?? 'staff' });
      await this.core.revoke(repo, { accountId: cur.id }, 'revokeByStaff', now, true);
      await this.core.securityEvent(repo, cur.id, 'account_locked', 'completed', { actor: caller.actor, reason: body.reason, client: caller.client, detail: { cause: 'staff_action', until: map.isoOrNull(until) } });
    });
    this.core.publish('identity.account.locked', { accountId: a.id, realm: a.realm, cause: 'staff_action', until: map.isoOrNull(until), by: caller.actor, reason: body.reason }, caller);
    const after = await this.accountAdmin(a.id);
    await this.core.audit({ action: 'identity.account.lock', actionLabel: 'Locked account', target: this.auditTarget(a), reason: body.reason, before: before.account, after: after.account, afterText: until ? `Locked until ${map.iso(until)}` : 'Locked until unlocked by staff' }, caller);
    return after;
  }

  private auditTarget(a: AccountRow): audit.AuditTarget {
    return { type: a.realm === 'staff' ? 'staff' : 'account', id: a.id, label: `${a.display_name} (${a.email})`, screen: a.realm === 'staff' ? 'admin/staff' : 'admin/customers' };
  }

  /** POST /accounts/{id}/unlock */
  async unlockAccount(id: string, reason: string, caller: Caller, can: (p: string) => Promise<boolean>): Promise<AccountAdmin> {
    const a = await this.targetAccount(id, can);
    const before = await this.accountAdmin(a.id);
    await this.core.repo.transaction(async (repo) => {
      const cur = (await repo.getAccount(a.id, { forUpdate: true }))!;
      const status = accountStatusMachine.next(cur.status as never, 'unlock');
      await repo.updateAccount(cur.id, { status, locked_until: null, lock_reason: null, locked_by: null, failed_sign_ins: 0, failed_window_started_at: null });
      await this.core.securityEvent(repo, cur.id, 'account_unlocked', 'completed', { actor: caller.actor, reason, client: caller.client });
    });
    this.core.publish('identity.account.unlocked', { accountId: a.id, by: caller.actor }, caller);
    const after = await this.accountAdmin(a.id);
    await this.core.audit({ action: 'identity.account.unlock', actionLabel: 'Unlocked account', target: this.auditTarget(a), reason, before: before.account, after: after.account }, caller);
    return after;
  }

  /** POST /accounts/{id}/force-password-reset: revokes every session; sign-in asks for a new password */
  async forcePasswordReset(id: string, body: { reason: string; sendLink: boolean }, caller: Caller, can: (p: string) => Promise<boolean>): Promise<AccountAdmin> {
    const s = await this.core.cfg();
    const now = this.core.now();
    const a = await this.targetAccount(id, can);
    this.notSelf(a, caller);
    let after = () => {};
    await this.core.repo.transaction(async (repo) => {
      const cur = await repo.updateAccount(a.id, { must_reset_password: true });
      await this.core.revoke(repo, { accountId: a.id }, 'revokeByStaff', now, true);
      await this.core.securityEvent(repo, a.id, 'forced_password_reset', 'completed', { actor: caller.actor, reason: body.reason, client: caller.client });
      if (body.sendLink && cur.password_hash) after = await this.passwords.issueReset(repo, cur, { forcedBy: caller.actor, reason: body.reason, client: caller.client }, s, now);
    });
    after();
    const result = await this.accountAdmin(a.id);
    await this.core.audit({ action: 'identity.account.force-password-reset', actionLabel: 'Required a new password', target: this.auditTarget(a), reason: body.reason, afterText: body.sendLink ? 'Reset link emailed; all sessions signed out' : 'All sessions signed out' }, caller);
    return result;
  }

  /** POST /accounts/{id}/reset-two-step: removes 2-step methods after an identity check */
  async resetTwoStep(id: string, body: { reason: string; identityCheck: string }, caller: Caller, can: (p: string) => Promise<boolean>): Promise<AccountAdmin> {
    const now = this.core.now();
    const a = await this.targetAccount(id, can);
    this.notSelf(a, caller);
    await this.core.repo.transaction(async (repo) => {
      await repo.removeAllMethods(a.id, now);
      await repo.deleteRecoveryCodes(a.id);
      await repo.clearDeviceTrust(a.id);
      await repo.supersedeChallenges(a.id, 'two_step_setup');
      await this.core.securityEvent(repo, a.id, 'two_step_disabled', 'completed', { actor: caller.actor, reason: body.reason, client: caller.client, detail: { byStaff: true, identityCheck: body.identityCheck } });
    });
    this.core.publish('identity.two_step.changed', { accountId: a.id, enabled: false, method: null, by: caller.actor }, caller);
    const result = await this.accountAdmin(a.id);
    await this.core.audit({ action: 'identity.account.reset-two-step', actionLabel: 'Reset 2-step verification', target: this.auditTarget(a), reason: body.reason, afterText: `Identity check: ${body.identityCheck}` }, caller);
    return result;
  }

  /** POST /accounts/{id}/sign-out-all */
  async signOutAccount(id: string, reason: string, caller: Caller, can: (p: string) => Promise<boolean>): Promise<{ sessionsRevoked: number }> {
    const now = this.core.now();
    const a = await this.targetAccount(id, can);
    const n = await this.core.repo.transaction(async (repo) => {
      const ids = await this.core.revoke(repo, { accountId: a.id }, 'revokeByStaff', now, true);
      await this.core.securityEvent(repo, a.id, 'signed_out_everywhere', 'completed', { actor: caller.actor, reason, client: caller.client, detail: { sessions: ids.length } });
      return ids.length;
    });
    await this.core.audit({ action: 'identity.account.sign-out-all', actionLabel: 'Signed account out everywhere', target: this.auditTarget(a), reason, afterText: `${n} sessions signed out` }, caller);
    return { sessionsRevoked: n };
  }

  private staffOnly(a: AccountRow, what: string) {
    if (a.realm !== 'staff') throw new AppError('VALIDATION_FAILED', `Only staff accounts can be ${what} here`, issue('params.id', 'not a staff account'));
  }

  /**
   * access.disableCheck for a signed-in staff member, when access is enabled and built (module tests run identity
   * alone). The operator tool on the server (npm run staff-link, no principal) can disable anyone, even the last
   * Business Owner: that is the break-glass path, and a new owner is bootstrapped after it.
   */
  private async disableCheck(accountId: string, caller: Caller) {
    if (!caller.principal) return undefined;
    try {
      return await this.core.ctx.tryUse('access')?.disableCheck(accountId, caller.actor.id ?? null);
    } catch (err) {
      if (isNotImplemented(err)) return undefined;
      throw err;
    }
  }

  /** POST /accounts/{id}/disable (staff accounts) */
  async disableAccount(id: string, reason: string, caller: Caller, can: (p: string) => Promise<boolean>): Promise<AccountAdmin> {
    const now = this.core.now();
    const a = await this.targetAccount(id, can);
    this.staffOnly(a, 'disabled');
    this.notSelf(a, caller);
    // disabling ends every role: a Business Owner only by another, and never the last one (access decides)
    const check = await this.disableCheck(a.id, caller);
    if (check && !check.allowed) throw new AppError(check.code === 'LAST_BUSINESS_OWNER' ? 'LAST_BUSINESS_OWNER' : 'FORBIDDEN', check.reason ?? 'You cannot disable this account');
    const before = await this.accountAdmin(a.id);
    await this.core.repo.transaction(async (repo) => {
      const cur = (await repo.getAccount(a.id, { forUpdate: true }))!;
      const status = accountStatusMachine.next(cur.status as never, 'disable');
      await repo.updateAccount(cur.id, { status });
      await this.core.revoke(repo, { accountId: cur.id }, 'revokeByStaff', now, true);
      await this.core.securityEvent(repo, cur.id, 'account_disabled', 'completed', { actor: caller.actor, reason, client: caller.client });
    });
    this.core.publish('identity.account.disabled', { accountId: a.id, realm: a.realm, reason, by: caller.actor }, caller);
    // the staff they invited and who have not accepted yet do not get in after they leave
    await this.invitations.revokeSentBy(a.id, `Inviter's account disabled: ${reason}`, caller);
    const after = await this.accountAdmin(a.id);
    await this.core.audit({ action: 'identity.account.disable', actionLabel: 'Disabled staff account', target: this.auditTarget(a), reason, before: before.account, after: after.account }, caller);
    return after;
  }

  /** POST /accounts/{id}/enable (staff accounts; roles are not restored) */
  async enableAccount(id: string, reason: string, caller: Caller, can: (p: string) => Promise<boolean>): Promise<AccountAdmin> {
    const a = await this.targetAccount(id, can);
    this.staffOnly(a, 'enabled');
    const before = await this.accountAdmin(a.id);
    await this.core.repo.transaction(async (repo) => {
      const cur = (await repo.getAccount(a.id, { forUpdate: true }))!;
      const status = accountStatusMachine.next(cur.status as never, 'enable');
      await repo.updateAccount(cur.id, { status, failed_sign_ins: 0, failed_window_started_at: null });
      await this.core.securityEvent(repo, cur.id, 'account_enabled', 'completed', { actor: caller.actor, reason, client: caller.client });
    });
    this.core.publish('identity.account.enabled', { accountId: a.id, by: caller.actor }, caller);
    const after = await this.accountAdmin(a.id);
    await this.core.audit({ action: 'identity.account.enable', actionLabel: 'Enabled staff account', target: this.auditTarget(a), reason, before: before.account, after: after.account }, caller);
    return after;
  }

  /** GET /accounts/{id}/security-activity */
  async listAccountActivity(id: string, query: { kind?: string | null; result?: string | null; from?: string | null; to?: string | null }, page: PageRequest, can: (p: string) => Promise<boolean>): Promise<common.Page<SecurityEvent>> {
    const a = await this.targetAccount(id, can);
    const tz = this.core.ctx.config.market.timeZone;
    const since = query.from ? zonedTimeToUtc(query.from, '00:00', tz) : undefined;
    let until: Date | undefined;
    if (query.to) {
      const next = new Date(`${query.to}T00:00:00Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      until = zonedTimeToUtc(next.toISOString().slice(0, 10), '00:00', tz);
    }
    const res = await this.core.repo.listSecurityEvents(a.id, { since, until, kind: query.kind, result: query.result }, page);
    return { ...res, items: res.items.map(map.securityEvent) };
  }

  /** Close the member credential after customers completes a closure (idempotent) */
  async closeAccount(accountId: string, reason: string): Promise<void> {
    const now = this.core.now();
    const closed = await this.core.repo.transaction(async (repo) => {
      const a = isUuid(accountId) ? await repo.getAccount(accountId, { forUpdate: true }) : undefined;
      if (!a || a.realm !== 'member') throw new AppError('NOT_FOUND', 'Member account not found');
      if (a.status === 'closed') return false;
      const status = accountStatusMachine.next(a.status as never, 'close');
      await repo.updateAccount(a.id, { status, closed_at: now, locked_until: null, lock_reason: null, locked_by: null });
      // every session ends; Seller Center sign-in stays possible while seller access remains
      await this.core.revoke(repo, { accountId: a.id }, 'account_closed', now, true);
      await repo.clearDeviceTrust(a.id);
      await this.core.securityEvent(repo, a.id, 'signed_out_everywhere', 'completed', { actor: { kind: 'system' }, reason, detail: { closed: true } });
      return true;
    });
    if (closed) this.core.publish('identity.account.closed', { accountId, at: map.iso(now) });
  }
}
