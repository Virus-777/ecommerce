/**
 * Account actions by staff: restrictions (ordering, messaging, account), suspend and reinstate, security actions
 * and closure by staff, with approvals where the action needs them, and the enforcement trust records.
 */
import { SYSTEM_ACTOR } from '../../../kernel/auth/index.js';
import { AppError } from '../../../kernel/errors/index.js';
import type { EventPayload } from '../../../kernel/events/index.js';
import { isUuid, newId } from '../../../kernel/lib/ids.js';
import type * as common from '../../../spec/common.js';
import type { AccountActionInput, AccountActionResult } from '../../../spec/customers.js';
import type * as identity from '../../../spec/identity.js';
import {
  customerMessageFor,
  displayName,
  effectsOf,
  REASON_CODES,
  RESTRICT_ACTIONS,
  scopeOfTrustAction,
  SECURITY_ACTIONS,
  STAFF_APPEAL_ROUTE,
  stillWorksFor,
  trustAppealRoute,
  type AccountStatus,
  type ReasonCode,
  type RestrictionScope,
} from '../domain/rules.js';
import { accountRestrictionMachine, customerAccountStatusMachine } from '../domain/state-machines.js';
import * as map from '../mappers.js';
import type { CustomerRow, RestrictionRow } from '../ports.js';
import type { CustomersRepository } from '../repository.js';
import {
  type Core,
  type By,
  type StaffBy,
  CLOSE_WITH_OBLIGATIONS,
  BATCH,
  invalid,
  notFound,
  ACTION_LABEL,
} from './core.js';
import type { DataRequests } from './data-requests.js';

export class AccountActions {
  constructor(
    readonly core: Core,
    readonly dataRequests: DataRequests,
  ) {}

  /** Adds a scoped restriction inside a transaction; moves active / under_review accounts to restricted */
  private async addRestriction(
    repo: CustomersRepository,
    c: CustomerRow,
    r: { scope: RestrictionScope; reasonCode: ReasonCode; reason: string; endsAt: Date | null; appealRoute: string; appealDeadline: Date | null; setBy: common.Actor; trustReportId?: string | null; trustEnforcementId?: string | null },
    now: Date,
    opts: { keepSuspension: boolean },
  ): Promise<{ row: RestrictionRow; from: AccountStatus; to: AccountStatus }> {
    const from = map.status(c);
    let to = from;
    if (from !== 'restricted' && !(opts.keepSuspension && from === 'suspended')) to = customerAccountStatusMachine.next(from, 'restrict');
    const row = await repo.insertRestriction({
      id: newId(),
      customer_id: c.id,
      scope: r.scope,
      reason_code: r.reasonCode,
      reason: r.reason,
      still_works: stillWorksFor(r.scope),
      appeal_route: r.appealRoute,
      appeal_deadline: r.appealDeadline,
      starts_at: now,
      ends_at: r.endsAt,
      state: accountRestrictionMachine.initial,
      set_by_kind: r.setBy.kind,
      set_by_id: r.setBy.id ?? null,
      trust_report_id: r.trustReportId ?? null,
      trust_enforcement_id: r.trustEnforcementId ?? null,
      lifted_at: null,
      lift_reason: null,
    });
    if (to !== from) await repo.updateCustomer(c.id, { account_status: to, updated_at: now });
    return { row, from, to };
  }

  /** Lifts or expires a restriction inside a transaction; the last one returns a restricted account to active */
  private async endRestriction(
    repo: CustomersRepository,
    c: CustomerRow,
    r: RestrictionRow,
    event: 'lift' | 'expire',
    reason: string | null,
    now: Date,
  ): Promise<{ row: RestrictionRow; from: AccountStatus; to: AccountStatus }> {
    const state = accountRestrictionMachine.next(r.state as never, event);
    const row = await repo.updateRestriction(r.id, { state, lifted_at: event === 'lift' ? now : null, lift_reason: reason });
    const from = map.status(c);
    let to = from;
    if (from === 'restricted' && (await repo.countActiveRestrictions(c.id, now)) === 0) {
      to = customerAccountStatusMachine.next('restricted', 'liftLastRestriction');
      await repo.updateCustomer(c.id, { account_status: to, updated_at: now });
    }
    return { row, from, to };
  }

  private restricted(c: CustomerRow, r: RestrictionRow, by: By) {
    this.core.ctx.events.publish(
      'customers.account.restricted',
      { customerId: c.id, restrictionId: r.id, scope: r.scope, endsAt: map.isoOrNull(r.ends_at), trustReportId: r.trust_report_id, trustEnforcementId: r.trust_enforcement_id },
      this.core.meta(by),
    );
  }

  private lifted(c: CustomerRow, r: RestrictionRow, by: By) {
    this.core.ctx.events.publish('customers.account.restriction_lifted', { customerId: c.id, restrictionId: r.id, scope: r.scope, trustEnforcementId: r.trust_enforcement_id }, this.core.meta(by));
  }

  async applyAccountAction(customerId: string, input: AccountActionInput, by: StaffBy): Promise<AccountActionResult> {
    const details = input.details?.trim();
    if (!details) throw invalid('details', 'Say what happened and what evidence you checked');
    if (!REASON_CODES.includes(input.reasonCode)) throw invalid('reasonCode', 'Choose a reason');
    const c = await this.core.repo.getCustomer(customerId);
    if (!c) throw notFound('Customer');
    const now = this.core.now();

    if (SECURITY_ACTIONS.includes(input.action)) return this.securityAction(c, input, details, by);
    if (input.action === 'close') return this.closeByStaff(c, input, details, by);

    const scope = RESTRICT_ACTIONS[input.action];
    let endsAt: Date | null = null;
    if (scope && input.endsAt) {
      endsAt = new Date(input.endsAt);
      if (endsAt <= now) throw invalid('endsAt', 'The end date must be in the future');
    }
    const out = await this.core.repo.transaction(async (repo) => {
      const cur = (await repo.getCustomer(c.id, { forUpdate: true }))!;
      if (scope) {
        const r = await this.addRestriction(
          repo,
          cur,
          {
            scope,
            reasonCode: input.reasonCode,
            reason: input.customerMessage?.trim() || customerMessageFor(scope, input.reasonCode),
            endsAt,
            appealRoute: STAFF_APPEAL_ROUTE,
            appealDeadline: null,
            setBy: by.actor,
            trustReportId: input.trustReportId ?? null,
          },
          now,
          { keepSuspension: false },
        );
        const action = await repo.insertAction(this.core.actionRow(cur, { action: 'restrict', reasonCode: input.reasonCode, details, from: r.from, to: r.to, restrictionId: r.row.id, actor: by.actor, at: now }));
        return { cur, from: r.from as string, to: r.to as string, steps: [[r.from, r.to]] as [string, string][], restriction: r.row, action };
      }
      const event = ({ mark_under_review: 'markUnderReview', clear_review: 'clearReview', suspend: 'suspend', reinstate: 'reinstate' } as const)[
        input.action as 'mark_under_review' | 'clear_review' | 'suspend' | 'reinstate'
      ];
      if (!event) throw invalid('action', 'Unknown account action');
      const from = map.status(cur);
      const steps: [string, string][] = [];
      let to = customerAccountStatusMachine.next(from, event);
      steps.push([from, to]);
      // a reinstated account with restrictions still in force is restricted, not active
      if (input.action === 'reinstate' && (await repo.countActiveRestrictions(cur.id, now)) > 0) {
        const next = customerAccountStatusMachine.next(to, 'restrict');
        steps.push([to, next]);
        to = next;
      }
      await repo.updateCustomer(cur.id, { account_status: to, updated_at: now });
      const action = await repo.insertAction(this.core.actionRow(cur, { action: input.action, reasonCode: input.reasonCode, details, from, to, actor: by.actor, at: now }));
      return { cur, from: from as string, to: to as string, steps, restriction: undefined, action };
    });

    for (const [f, t] of out.steps) this.core.statusChanged(c, f, t, input.reasonCode, by);
    if (out.restriction) this.restricted(c, out.restriction, by);
    await this.core.audit(
      {
        action: `customers.account.${out.action.action}`,
        actionLabel: ACTION_LABEL[out.action.action] ?? 'Account action',
        category: 'customers',
        target: this.core.target(c),
        reason: `${input.reasonCode}: ${details}`,
        before: { accountStatus: out.from },
        after: { accountStatus: out.to, ...(out.restriction ? { restrictionId: out.restriction.id, scope: out.restriction.scope, endsAt: map.isoOrNull(out.restriction.ends_at) } : {}) },
      },
      by,
    );
    return {
      accountStatus: out.to as AccountStatus,
      record: map.action(out.action),
      restriction: out.restriction ? map.restriction(out.restriction) : null,
      effects: effectsOf(out.action.action, out.restriction?.scope as RestrictionScope | undefined, map.isoOrNull(out.restriction?.ends_at)),
    };
  }

  /** send_password_reset and sign_out_everywhere: identity does it; customers records the reason */
  private async securityAction(c: CustomerRow, input: AccountActionInput, details: string, by: StaffBy): Promise<AccountActionResult> {
    if (!(await by.can('customers.accounts.security'))) {
      throw new AppError('FORBIDDEN', 'Sending reset links and signing customers out needs the security permission', { permission: 'customers.accounts.security' });
    }
    const identityApi = this.core.ctx.use('identity');
    if (input.action === 'send_password_reset') await identityApi.sendPasswordReset(c.user_id, { reason: details, by: by.actor, revokeSessions: false });
    else await identityApi.revokeSessions(c.user_id, details);
    const st = map.status(c);
    const row = await this.core.repo.insertAction(this.core.actionRow(c, { action: input.action, reasonCode: input.reasonCode, details, from: st, to: st, actor: by.actor, at: this.core.now() }));
    await this.core.audit(
      { action: `customers.account.${input.action}`, actionLabel: ACTION_LABEL[input.action] ?? 'Account action', category: 'security', target: this.core.target(c), reason: `${input.reasonCode}: ${details}` },
      by,
    );
    return { accountStatus: st, record: map.action(row), restriction: null, effects: effectsOf(input.action) };
  }

  /**
   * Close by staff: same obligation check as a customer request unless the reason is suspected fraud
   * (payment_fraud_review). Open obligations need a second reviewer (access approval request): the account stays
   * as it is (APPROVAL_REQUIRED with details.approvalRequestId) and closes when the request is approved
   * (onApprovalDecidedFromAccess). Nothing is stored here while it waits; the request carries the reason.
   */
  private async closeByStaff(c: CustomerRow, input: AccountActionInput, details: string, by: StaffBy): Promise<AccountActionResult> {
    customerAccountStatusMachine.next(map.status(c), 'close'); // ILLEGAL_TRANSITION before asking anyone
    if (input.reasonCode !== 'payment_fraud_review') {
      const blockers = await this.dataRequests.obligations(c.id);
      if (blockers.length) {
        const access = this.core.ctx.tryUse('access');
        if (!access) throw new AppError('APPROVAL_REQUIRED', 'Closing an account with open obligations needs a second reviewer, and approvals are unavailable right now', { blockers });
        const principal = by.principal as identity.Principal;
        const check = await access.check(principal, CLOSE_WITH_OBLIGATIONS);
        if (check.decision === 'denied') throw new AppError('FORBIDDEN', check.reason, { action: CLOSE_WITH_OBLIGATIONS });
        if (check.decision === 'approval_required') {
          const latest = (await access.approvalForTargets(principal, 'customer', [c.id])).get(c.id);
          const req =
            latest && ['pending', 'partially_approved'].includes(latest.status) && latest.action.key === CLOSE_WITH_OBLIGATIONS
              ? latest
              : await access.requestApproval({
                  action: CLOSE_WITH_OBLIGATIONS,
                  target: { type: 'customer', id: c.id, ref: c.ref, label: displayName(c.first_name, c.last_name), screen: 'admin/customers' },
                  summary: `Close customer account ${c.ref} with ${blockers.map((b) => b.detail).join(', ')}`,
                  details: { blockers, reasonCode: input.reasonCode, details },
                  reason: details,
                  requestedBy: principal,
                });
          throw new AppError('APPROVAL_REQUIRED', 'Closing an account with open orders, returns or cases needs a second reviewer. It closes once approved.', {
            approvalRequestId: req.id,
            approvers: req.eligibleApprovers.map((a) => a.name),
            blockers,
          });
        }
      }
    }
    const done = await this.dataRequests.closeAccountTx(c.id, { source: 'staff', actor: by.actor, reasonCode: input.reasonCode, details, anonymise: false });
    await this.dataRequests.afterClosure(c, done, input.reasonCode, by, `${input.reasonCode}: ${details}`);
    return { accountStatus: 'closed', record: map.action(done.action!), restriction: null, effects: effectsOf('close') };
  }

  /**
   * access.approval.decided for customers.accounts.close-with-obligations: approved closes the account as the
   * requester, with the reason they gave; rejected, cancelled or expired leaves it as it is (the pending closure
   * lived only in the approval request). A status the close no longer applies to is logged and ignored.
   */
  async onApprovalDecidedFromAccess(event: EventPayload<'access.approval.decided'>, eventId?: string): Promise<void> {
    if (event.actionKey !== CLOSE_WITH_OBLIGATIONS || event.target?.type !== 'customer') return;
    const key = `approval-decided:${event.requestId}`;
    const c = await this.core.repo.getCustomer(event.target.id);
    if (!c) {
      this.core.ctx.log.info({ customerId: event.target.id, approvalRequestId: event.requestId, eventId }, 'customers: approval decided for an unknown customer; ignored');
      return;
    }
    if (event.outcome !== 'approved' || !customerAccountStatusMachine.can(map.status(c), 'close')) {
      if (event.outcome === 'approved') this.core.ctx.log.info({ customerId: c.id, status: c.account_status, approvalRequestId: event.requestId }, 'customers: approved closure no longer applies');
      await this.core.repo.transaction((repo) => repo.claim(key));
      return;
    }
    const request = await this.core.ctx
      .tryUse('access')
      ?.getApproval(event.requestId)
      .catch(() => null);
    const asked = (request?.details ?? {}) as { reasonCode?: string; details?: string };
    const reasonCode = asked.reasonCode && REASON_CODES.includes(asked.reasonCode as never) ? asked.reasonCode : 'other';
    const details = asked.details?.trim() || request?.reason?.trim() || 'Closure approved by a second reviewer';
    const actor: common.Actor = request?.requestedBy ?? { kind: 'staff', id: event.requestedById };
    const done = await this.dataRequests.closeAccountTx(c.id, { source: 'staff', actor, reasonCode, details, anonymise: false, claim: key });
    await this.dataRequests.afterClosure(c, done, reasonCode, { actor }, `${reasonCode}: ${details}`, event.requestId);
  }

  async liftRestriction(customerId: string, restrictionId: string, body: { reason: string }, by: StaffBy): Promise<AccountActionResult> {
    const reason = body.reason?.trim();
    if (!reason) throw invalid('reason', 'Say why the restriction is lifted');
    const c = await this.core.repo.getCustomer(customerId);
    if (!c) throw notFound('Customer');
    const now = this.core.now();
    const out = await this.core.repo.transaction(async (repo) => {
      const cur = (await repo.getCustomer(c.id, { forUpdate: true }))!;
      const r = await repo.getRestriction(c.id, restrictionId, { forUpdate: true });
      if (!r) throw notFound('Restriction');
      const ended = await this.endRestriction(repo, cur, r, 'lift', reason, now);
      const action = await repo.insertAction(
        this.core.actionRow(cur, { action: 'lift_restriction', reasonCode: r.reason_code, details: reason, from: ended.from, to: ended.to, restrictionId: r.id, actor: by.actor, at: now }),
      );
      return { ...ended, action };
    });
    this.lifted(c, out.row, by);
    this.core.statusChanged(c, out.from, out.to, out.row.reason_code, by);
    await this.core.audit(
      {
        action: 'customers.account.lift_restriction',
        actionLabel: 'Lifted a customer restriction',
        category: 'customers',
        target: this.core.target(c),
        reason,
        before: { restriction: 'active', accountStatus: out.from },
        after: { restriction: 'lifted', accountStatus: out.to, restrictionId: out.row.id },
      },
      by,
    );
    return { accountStatus: out.to, record: map.action(out.action), restriction: map.restriction(out.row), effects: effectsOf('lift_restriction', out.row.scope as RestrictionScope) };
  }

  /** trust.enforcement.recorded: customer restrictions with the enforcement's reason, end date and appeal route */
  async onEnforcementRecordedFromTrust(event: EventPayload<'trust.enforcement.recorded'>, actor?: common.Actor): Promise<void> {
    const scope = scopeOfTrustAction(event.action);
    if (!scope || event.alreadyApplied) return;
    const params = (event.params && typeof event.params === 'object' ? event.params : {}) as { endsAt?: unknown; customerMessage?: unknown; reasonCode?: unknown };
    const endsAt = typeof params.endsAt === 'string' && !Number.isNaN(Date.parse(params.endsAt)) ? new Date(params.endsAt) : null;
    const reasonCode: ReasonCode =
      typeof params.reasonCode === 'string' && (REASON_CODES as readonly string[]).includes(params.reasonCode) ? (params.reasonCode as ReasonCode) : scope === 'messaging' ? 'abusive_messages' : 'policy_violation';
    const by: By = { actor: actor ?? SYSTEM_ACTOR };
    for (const t of event.targets as { type?: string; id?: string }[]) {
      if (t?.type !== 'customer' || !t.id || !isUuid(t.id)) continue;
      const c = await this.core.repo.getCustomer(t.id);
      if (!c) {
        this.core.ctx.log.warn({ customerId: t.id, enforcementId: event.enforcementId }, 'customers: trust enforcement for an unknown customer; ignored');
        continue;
      }
      if (c.account_status === 'closed' || (await this.core.repo.findRestrictionByEnforcement(c.id, event.enforcementId))) continue;
      const now = this.core.now();
      const out = await this.core.repo.transaction(async (repo) => {
        const cur = (await repo.getCustomer(c.id, { forUpdate: true }))!;
        if (await repo.findRestrictionByEnforcement(c.id, event.enforcementId)) return undefined;
        const r = await this.addRestriction(
          repo,
          cur,
          {
            scope,
            reasonCode,
            reason: (typeof params.customerMessage === 'string' && params.customerMessage.trim()) || event.reason || customerMessageFor(scope, reasonCode),
            endsAt: endsAt && endsAt > now ? endsAt : null,
            appealRoute: trustAppealRoute(event.appealDeadline),
            appealDeadline: event.appealDeadline ? new Date(event.appealDeadline) : null,
            setBy: by.actor,
            trustReportId: event.reportId,
            trustEnforcementId: event.enforcementId,
          },
          now,
          { keepSuspension: true },
        );
        await repo.insertAction(
          this.core.actionRow(cur, { action: 'restrict', reasonCode, details: `Trust enforcement: ${event.reason}`, from: r.from, to: r.to, restrictionId: r.row.id, actor: by.actor, at: now }),
        );
        return r;
      });
      if (!out) continue;
      this.core.statusChanged(c, out.from, out.to, reasonCode, by);
      this.restricted(c, out.row, by);
    }
  }

  /**
   * trust.enforcement.reversed: lift every active restriction that enforcement created (actor system on behalf of trust);
   * the last one returns the account to active. Restrictions already lifted or expired stay as they are, so a
   * redelivered event changes nothing; each lift also claims (event, restriction) in the inbox.
   */
  async onEnforcementReversedFromTrust(event: EventPayload<'trust.enforcement.reversed'>, eventId?: string): Promise<void> {
    const rows = await this.core.repo.activeRestrictionsByEnforcement(event.enforcementId);
    if (!rows.length) return;
    const reason = `Trust reversed enforcement ${event.ref}: ${event.reason}`.slice(0, 1000);
    const by: By = { actor: SYSTEM_ACTOR };
    for (const r of rows) {
      const now = this.core.now();
      const out = await this.core.repo.transaction(async (repo) => {
        if (!(await repo.claim(`enforcement-reversed:${eventId ?? event.enforcementId}:${r.id}`))) return undefined;
        const c = await repo.getCustomer(r.customer_id, { forUpdate: true });
        const cur = c && (await repo.getRestriction(r.customer_id, r.id, { forUpdate: true }));
        if (!c || !cur || cur.state !== 'active') return undefined;
        const ended = await this.endRestriction(repo, c, cur, 'lift', reason, now);
        await repo.insertAction(
          this.core.actionRow(c, { action: 'lift_restriction', reasonCode: cur.reason_code, details: reason, from: ended.from, to: ended.to, restrictionId: cur.id, actor: by.actor, at: now }),
        );
        return { c, ...ended };
      });
      if (!out) continue;
      this.lifted(out.c, out.row, by);
      this.core.statusChanged(out.c, out.from, out.to, out.row.reason_code, by);
      await this.core.audit(
        {
          action: 'customers.account.lift_restriction',
          actionLabel: 'Lifted a customer restriction (trust enforcement reversed)',
          category: 'customers',
          target: this.core.target(out.c),
          reason,
          before: { restriction: 'active', accountStatus: out.from },
          after: { restriction: 'lifted', accountStatus: out.to, restrictionId: out.row.id, trustEnforcementId: event.enforcementId },
        },
        by,
      );
    }
  }

  /** customers.expire-restrictions: expire restrictions past endsAt; the last one returns the account to active */
  async expireRestrictions(): Promise<{ expired: number }> {
    let expired = 0;
    for (let round = 0; round < 20; round++) {
      const now = this.core.now();
      const due = await this.core.repo.dueRestrictions(now, BATCH);
      if (!due.length) break;
      for (const r of due) {
        const out = await this.core.repo.transaction(async (repo) => {
          const c = await repo.getCustomer(r.customer_id, { forUpdate: true });
          const cur = c && (await repo.getRestriction(r.customer_id, r.id, { forUpdate: true }));
          if (!c || !cur || cur.state !== 'active' || !cur.ends_at || cur.ends_at > now) return undefined;
          return { c, ...(await this.endRestriction(repo, c, cur, 'expire', null, now)) };
        });
        if (!out) continue;
        expired++;
        const by = { actor: SYSTEM_ACTOR };
        this.lifted(out.c, out.row, by);
        this.core.statusChanged(out.c, out.from, out.to, out.row.reason_code, by);
      }
      if (due.length < BATCH) break;
    }
    return { expired };
  }
}
