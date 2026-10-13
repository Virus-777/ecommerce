/**
 * Approval requests: the authority check, opening a request, deciding (approve, reject, return), resubmitting,
 * cancelling and reminding, and the views of requests other modules embed.
 */
import { SYSTEM_ACTOR } from '../../../kernel/auth/index.js';
import { AppError, isNotImplemented } from '../../../kernel/errors/index.js';
import { newId } from '../../../kernel/lib/ids.js';
import { pageOf, toPageRequest, type PageRequest } from '../../../kernel/lib/pagination.js';
import type * as audit from '../../../spec/audit.js';
import type * as common from '../../../spec/common.js';
import type * as identity from '../../../spec/identity.js';
import type {
  ApprovalDecision,
  ApprovalRequest,
  ApprovalTarget,
  AuthorityCheck,
  AmountInput,
  LimitValue,
  RequestApprovalInput,
  RoleRef,
  StaffRef,
} from '../../../spec/access.js';
import { loadDirectory, type Directory } from '../directory.js';
import {
  amountText,
  bestFor,
  evaluate,
  expectedApprovals,
  isComplete,
  limitSummary,
  NOT_PERMITTED,
  standing,
  stepRoleKeys,
  type Amount,
  type Candidate,
  type Issue,
  type LimitKind,
  type RequestState,
  type SecondMode,
  type Snapshot,
} from '../domain/limits.js';
import { BUSINESS_OWNER, defaultEligibleRoleKeys } from '../domain/seed.js';
import {
  approvalRequestMachine,
  awayPeriodMachine,
  limitChangeMachine,
  roleAssignmentMachine,
} from '../domain/state-machines.js';
import { OPEN_REQUEST, type ActionRow, type DecisionRow, type RequestFilter, type RequestRow } from '../ports.js';
import {
  type Core,
  type Caller,
  SENSITIVE_GRANT,
  LIMITS_CHANGE,
  DELEGATIONS,
  DECIDABLE,
  FINAL,
  DUE_SOON_MS,
  EXPIRY_GRACE_MS,
  iso,
  uniq,
  by,
  roleRef,
  moneyOf,
  num,
  validation,
  notFound,
  TIMELINE_LABEL,
} from './core.js';
import type { Limits } from './limits.js';
import type { Members } from './members.js';
import type { Roles } from './roles.js';
import type { AwayPeriods } from './away.js';

export class Approvals {
  constructor(readonly core: Core) {}

  private get limits(): Limits {
    return this.core.parts.limits;
  }

  private get members(): Members {
    return this.core.parts.members;
  }

  private get roles(): Roles {
    return this.core.parts.roles;
  }

  private get away(): AwayPeriods {
    return this.core.parts.away;
  }

  /** allowed | approval_required | denied for this person, action and amount, with who could approve. Uses the limits in force now. Permissions alone never make a money action allowed. */
  async check(principal: identity.Principal, action: string, amount?: AmountInput): Promise<AuthorityCheck> {
    await this.core.ready();
    const act = await this.core.requireAction(action);
    const dir = await loadDirectory(this.core.repo, this.core.now());
    const snapshot = await this.snapshotFor(act, dir, principal.accountId ?? null, this.amountOf(act, amount));
    const amt = this.amountOf(act, amount);
    const kind = act.limit_kind as LimitKind;
    const mode = act.second_reviewer as SecondMode;
    const label = act.label;
    const mine = snapshot.requester;
    const base = { action: act.key, callerLimit: mine?.value ?? null, stepUpRequired: await this.stepUpNeeded(amt) };

    if (principal.kind !== 'staff' || !principal.accountId || !mine || mine.value.authority === 'not_permitted') {
      return { ...base, decision: 'denied', reason: `Your role has no authority to ${label.charAt(0).toLowerCase()}${label.slice(1)}`, requiresSecondReviewer: false, approvalsNeeded: 0, eligibleApproverRoles: [], eligibleApprovers: [] };
    }
    const s = standing(kind, mode, mine.value, amt, true);
    if (s === 3) {
      const limitText = kind === 'none' ? '' : ` ${limitSummary(kind, mode, mine.value).replace(/^Up to /, '')}`;
      return { ...base, decision: 'allowed', reason: kind === 'none' ? 'Within your authority' : `Within your${limitText} limit`, requiresSecondReviewer: false, approvalsNeeded: 0, eligibleApproverRoles: [], eligibleApprovers: [] };
    }
    const countsAsFirst = s === 2;
    const state: RequestState = { requesterId: principal.accountId, requesterCountsAsFirst: countsAsFirst, approvals: [], amount: amt };
    const roleKeys = stepRoleKeys(snapshot, state);
    const needed = expectedApprovals(snapshot, state);
    const eligibleRoles = this.core.roleRefsOf(roleKeys, dir);
    const people = this.eligiblePeople(snapshot, state, dir, null);
    const refs = await this.core.staffRefs(people, dir);
    const routeNames = eligibleRoles.map((r) => r.name).join(' or ') || 'another approver';
    const reason =
      mine.value.authority === 'recommend_only'
        ? 'Your role can recommend only'
        : countsAsFirst
          ? mode === 'always'
            ? `Always needs a second person: ${routeNames}`
            : `Needs a second reviewer: ${routeNames}`
          : `Above your limit: ${routeNames} approval`;
    return {
      ...base,
      decision: 'approval_required',
      reason,
      requiresSecondReviewer: countsAsFirst || needed > 1,
      approvalsNeeded: needed,
      eligibleApproverRoles: eligibleRoles,
      eligibleApprovers: people.map((id) => refs.get(id)!).filter(Boolean),
    };
  }

  /** Create an approval request (or return the open one for the same action and target). The requesting module keeps its record pending and finishes on access.approval.decided. */
  async requestApproval(input: RequestApprovalInput): Promise<ApprovalRequest> {
    const row = await this.openRequest(input, {});
    return this.viewOne(row, input.requestedBy);
  }

  /** Same rules as the admin approve/reject/return endpoints, for modules that show the decision inside their own screen (payout run approval) */
  async decide(requestId: string, principal: identity.Principal, decision: { kind: 'approve' | 'reject' | 'return'; note?: string; reauthToken?: string }): Promise<ApprovalRequest> {
    const caller: Caller = { principal, actor: { kind: principal.kind === 'staff' ? 'staff' : principal.kind, id: principal.accountId ?? null } };
    return this.decideAs(caller, requestId, decision.kind, { note: decision.note, reauthToken: decision.reauthToken });
  }

  /** The requesting module withdraws a request (record changed or deleted) */
  async cancelApproval(requestId: string, by: common.Actor, reason: string): Promise<void> {
    await this.core.ready();
    const row = await this.core.repo.getRequest(requestId);
    if (!row) throw notFound('Approval request');
    if (FINAL.has(row.status)) return; // already decided: nothing to withdraw
    await this.closeRequest(row.id, 'cancel', by, reason);
  }

  /** Full request with decisions */
  async getApproval(requestId: string): Promise<ApprovalRequest | null> {
    await this.core.ready();
    const row = await this.core.repo.getRequest(requestId);
    return row ? this.viewOne(row, null) : null;
  }

  /** Compact common.ApprovalInfo for embedding in other modules' responses */
  async approvalInfo(requestId: string): Promise<common.ApprovalInfo> {
    await this.core.ready();
    const row = await this.core.repo.getRequest(requestId);
    if (!row) return { required: false, reason: 'Approval request not found', approvalRequestId: requestId, approvers: [] };
    const dir = await loadDirectory(this.core.repo, this.core.now());
    const [info] = await this.approvalInfos([row], dir);
    return info!;
  }

  /** Requests the caller may decide now, oldest due first (same rules as GET /approval-requests?view=to_decide). canDecide and steps are computed for the caller. */
  async listApprovalsToDecide(principal: identity.Principal, filter: { module?: string; actionKey?: string; overdue?: boolean }, page: common.PageInput): Promise<common.Page<ApprovalRequest>> {
    await this.core.ready();
    const items = await this.toDecide(principal, filter);
    return pageOf(items, toPageRequest(page));
  }

  /** Approval counts for the admin dashboard and inbox */
  async approvalSummaryFor(principal: identity.Principal): Promise<{ toDecide: number; overdue: number; dueSoon: number; myOpenRequests: number; returnedToMe: number }> {
    await this.core.ready();
    const now = this.core.now().getTime();
    const decide = await this.toDecide(principal, {});
    const mine = principal.accountId ? await this.core.repo.findRequests({ requestedById: principal.accountId, statuses: OPEN_REQUEST }) : [];
    const due = (r: ApprovalRequest) => (r.deadline ? new Date(r.deadline.dueAt).getTime() : null);
    return {
      toDecide: decide.length,
      overdue: decide.filter((r) => (due(r) ?? Infinity) < now).length,
      dueSoon: decide.filter((r) => {
        const d = due(r);
        return d !== null && d >= now && d - now <= DUE_SOON_MS;
      }).length,
      myOpenRequests: mine.length,
      returnedToMe: mine.filter((r) => r.status === 'returned').length,
    };
  }

  /** One request with decisions and steps, null unless the caller is the requester, an eligible approver or holds access.approvals.view-all. canDecide and cannotDecideReason are for the caller. */
  async getApprovalForViewer(principal: identity.Principal, requestId: string): Promise<ApprovalRequest | null> {
    await this.core.ready();
    const row = await this.core.repo.getRequest(requestId);
    if (!row) return null;
    const dir = await loadDirectory(this.core.repo, this.core.now());
    const [view] = await this.views([row], principal, dir);
    if (!view) return null;
    if (await this.mayView(row, view, principal, dir, (p) => this.core.hasPermission(principal, p))) return view;
    return null;
  }

  /** Batched: the current approval request per target record (open request first, else the latest decided one), for approval panels embedded in other modules' admin views (payout run, hold, refund request). Visibility follows the parent record; canDecide is for the caller. */
  async approvalForTargets(principal: identity.Principal, targetType: string, targetIds: string[]): Promise<Map<string, ApprovalRequest | null>> {
    await this.core.ready();
    const out = new Map<string, ApprovalRequest | null>(targetIds.map((id) => [id, null]));
    if (!targetIds.length) return out;
    const rows = await this.core.repo.findRequests({ targetType, targetIds: uniq(targetIds) });
    const pick = new Map<string, RequestRow>();
    for (const r of rows) {
      const cur = pick.get(r.target_id);
      const open = (x: RequestRow) => (OPEN_REQUEST as readonly string[]).includes(x.status);
      if (!cur || (open(r) && !open(cur))) pick.set(r.target_id, r); // rows are newest first
    }
    const views = await this.views([...pick.values()], principal);
    for (const v of views) out.set(v.target.id, v);
    return out;
  }

  /** Batched: open requests whose target belongs to each seller (ApprovalTarget.sellerId), for the admin seller 360 */
  async approvalsForSellers(principal: identity.Principal, sellerIds: string[]): Promise<Map<string, ApprovalRequest[]>> {
    await this.core.ready();
    const out = new Map<string, ApprovalRequest[]>(sellerIds.map((id) => [id, []]));
    if (!sellerIds.length) return out;
    const rows = await this.core.repo.findRequests({ sellerIds: uniq(sellerIds), statuses: OPEN_REQUEST });
    for (const v of await this.views(rows, principal)) if (v.target.sellerId) out.get(v.target.sellerId)?.push(v);
    return out;
  }

  async listApprovalRequests(
    caller: Caller,
    query: { view?: 'to_decide' | 'requested_by_me' | 'all'; status?: ApprovalRequest['status']; actionKey?: string; module?: string; targetType?: string; targetId?: string; overdue?: boolean },
    page: PageRequest,
  ): Promise<common.Page<ApprovalRequest>> {
    await this.core.ready();
    const me = caller.principal.accountId ?? '';
    const filter: RequestFilter = {
      ...(query.status ? { statuses: [query.status] } : {}),
      ...(query.actionKey ? { actionKey: query.actionKey } : {}),
      ...(query.module ? { module: query.module } : {}),
      ...(query.targetType ? { targetType: query.targetType } : {}),
      ...(query.targetId ? { targetIds: [query.targetId] } : {}),
      ...(query.overdue ? { dueBefore: this.core.now(), statuses: query.status ? [query.status] : OPEN_REQUEST } : {}),
    };
    const viewAll = query.view === 'all' || (!query.view && (await this.core.can(caller, 'access.approvals.view-all')));
    if (query.view === 'to_decide') {
      const items = await this.toDecide(caller.principal, { module: query.module, actionKey: query.actionKey, overdue: query.overdue }, undefined, filter);
      return pageOf(items, page);
    }
    if (viewAll || query.view === 'requested_by_me') {
      const rows = await this.core.repo.pageRequests(query.view === 'requested_by_me' ? { ...filter, requestedById: me } : filter, page);
      return { ...rows, items: await this.views(rows.items, caller.principal) };
    }
    // default: what I requested and what I may decide now
    const dir = await loadDirectory(this.core.repo, this.core.now());
    const mine = await this.core.repo.findRequests({ ...filter, requestedById: me });
    const decide = await this.toDecide(caller.principal, {}, dir, filter);
    const views = await this.views(mine, caller.principal, dir);
    const all = [...views, ...decide.filter((d) => !views.some((v) => v.id === d.id))].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return pageOf(all, page);
  }

  async getApprovalRequest(caller: Caller, id: string): Promise<ApprovalRequest> {
    await this.core.ready();
    const row = await this.core.repo.getRequest(id);
    if (!row) throw notFound('Approval request');
    const dir = await loadDirectory(this.core.repo, this.core.now());
    const [view] = await this.views([row], caller.principal, dir);
    if (!view || !(await this.mayView(row, view, caller.principal, dir, (p) => this.core.can(caller, p)))) throw notFound('Approval request');
    return view;
  }

  async decideAs(caller: Caller, id: string, kind: 'approve' | 'reject' | 'return', input: { note?: string | null; reauthToken?: string | null; reason?: string; comment?: string }): Promise<ApprovalRequest> {
    await this.core.ready();
    const row = await this.core.repo.getRequest(id);
    if (!row) throw notFound('Approval request');
    const dir = await loadDirectory(this.core.repo, this.core.now());
    const me = caller.principal.accountId ?? '';
    const event = kind === 'approve' ? 'approve' : kind;
    if (kind === 'approve') {
      if (!(DECIDABLE as readonly string[]).includes(row.status)) approvalRequestMachine.next(row.status as never, 'approveFinal');
    } else approvalRequestMachine.next(row.status as never, event as 'reject' | 'return');
    if (caller.principal.kind !== 'staff' || !me) throw new AppError('NOT_ELIGIBLE_APPROVER', 'Only staff decide approval requests');

    const decisions = await this.core.repo.decisionsOf([row.id]);
    const snapshot = this.snapshotOf(row);
    const state = this.stateOf(row, decisions);
    if (row.requested_by_id === me) {
      if (kind === 'return') throw new AppError('NOT_ELIGIBLE_APPROVER', 'You cannot return your own request; cancel or change it instead', { eligibleRoles: this.core.roleRefsOf(stepRoleKeys(snapshot, state), dir) });
      throw new AppError('SELF_APPROVAL_NOT_ALLOWED', 'You cannot approve or reject your own request');
    }
    const elig = evaluate(snapshot, state, this.candidate(me, dir, snapshot));
    if (!elig.ok) {
      const code = kind === 'approve' ? elig.code : elig.code === 'SELF_APPROVAL_NOT_ALLOWED' ? elig.code : 'NOT_ELIGIBLE_APPROVER';
      throw new AppError(code, elig.code === 'ALREADY_APPROVED_BY_YOU' ? 'The second approval must come from a different person' : elig.reason, { eligibleRoles: this.core.roleRefsOf(stepRoleKeys(snapshot, state), dir) });
    }
    const claimedToken = kind === 'approve' ? await this.requireStepUp(row, caller.principal, input.reauthToken ?? null) : null;

    const now = this.core.now();
    const role = dir.roleByKey.get(elig.roleKey);
    const step = state.approvals.length + 1;
    const note = kind === 'approve' ? (input.note ?? null) : kind === 'reject' ? (input.reason ?? null) : (input.comment ?? null);
    const decision: DecisionRow = {
      id: newId(),
      request_id: row.id,
      step,
      decision: kind === 'approve' ? 'approved' : kind === 'reject' ? 'rejected' : 'returned',
      by_account_id: me,
      roles: (role ? [roleRef(role)] : []) as never,
      note,
      via_delegation_from: elig.viaDelegationFrom ?? null,
      at: now,
    };
    const record = () => this.core.repo.transaction(async (tx) => {
      const locked = await tx.getRequest(row.id, { forUpdate: true });
      if (!locked || locked.version !== row.version) throw new AppError('CONFLICT', 'This request changed while you were deciding; reload and try again');
      await tx.insertDecision(decision);
      if (kind === 'approve') {
        const next: RequestState = { ...state, approvals: [...state.approvals, { accountId: me, roleKeys: [elig.roleKey] }] };
        const done = isComplete(snapshot, next);
        const status = approvalRequestMachine.next(locked.status as never, done ? 'approveFinal' : 'approve');
        return tx.updateRequest(row.id, {
          status,
          ...(done
            ? { decided_at: now, required_approvals: Math.min(locked.required_approvals, next.approvals.length) || 1 }
            : { required_approvals: Math.max(locked.required_approvals, next.approvals.length + 1), eligible_role_keys: stepRoleKeys(snapshot, next) as never }),
          version: locked.version + 1,
        });
      }
      const status = approvalRequestMachine.next(locked.status as never, kind);
      return tx.updateRequest(row.id, { status, outcome_reason: note, ...(kind === 'reject' ? { decided_at: now } : {}), version: locked.version + 1 });
    });
    let after: Awaited<ReturnType<typeof record>>;
    try {
      after = await record();
    } catch (err) {
      // the decision was not recorded: the re-auth token works again, so the approver can retry without re-entering the password
      if (claimedToken) await this.core.ctx.use('identity').releaseReauthToken(claimedToken).catch(() => {});
      throw err;
    }

    const target = this.targetOf(after);
    const meta = { actor: caller.actor, requestId: caller.requestId };
    if (after.status === 'partially_approved') {
      const nextState = this.stateOf(after, [...decisions, decision]);
      this.core.ctx.events.publish(
        'access.approval.partially_approved',
        { requestId: after.id, actionKey: after.action_key, module: after.module, target, approvedBy: caller.actor, remainingApprovals: Math.max(1, after.required_approvals - nextState.approvals.length), eligibleAccountIds: this.eligiblePeople(snapshot, nextState, dir, null) },
        meta,
      );
    } else if (after.status === 'returned') {
      this.core.ctx.events.publish('access.approval.returned', { requestId: after.id, actionKey: after.action_key, module: after.module, target, by: caller.actor, comment: note ?? '', requestedById: after.requested_by_id }, meta);
    } else {
      await this.finish(after, caller.actor, note, caller.requestId);
    }
    await this.core.audit(
      {
        action: `access.approval.${kind}`,
        actionLabel: kind === 'approve' ? (after.status === 'approved' ? 'Approved request' : 'Gave first approval') : kind === 'reject' ? 'Rejected request' : 'Returned request',
        target: this.auditTarget(after),
        before: { status: row.status },
        after: { status: after.status, step },
        reason: note,
        approvalRequestId: after.id,
      },
      caller,
    );
    return this.viewOne(after, caller.principal);
  }

  async resubmitRequest(caller: Caller, id: string, note: string): Promise<ApprovalRequest> {
    await this.core.ready();
    const row = await this.core.repo.getRequest(id);
    if (!row) throw notFound('Approval request');
    if (row.requested_by_id !== caller.principal.accountId) throw new AppError('FORBIDDEN', 'Only the requester can resubmit this request');
    const status = approvalRequestMachine.next(row.status as never, 'resubmit');
    const snapshot = this.snapshotOf(row);
    const fresh: RequestState = { requesterId: row.requested_by_id, requesterCountsAsFirst: row.requester_counts_as_first, approvals: [], amount: this.amountOfRow(row) };
    const after = await this.core.repo.transaction(async (tx) => {
      const locked = await tx.getRequest(id, { forUpdate: true });
      if (!locked || locked.version !== row.version) throw new AppError('CONFLICT', 'This request changed meanwhile; reload and try again');
      await tx.supersedeDecisions(id);
      await tx.insertDecision({ id: newId(), request_id: id, step: 0, decision: 'resubmitted', by_account_id: caller.principal.accountId!, roles: [] as never, note, via_delegation_from: null, at: this.core.now() });
      return tx.updateRequest(id, {
        status,
        outcome_reason: null,
        required_approvals: expectedApprovals(snapshot, fresh),
        eligible_role_keys: stepRoleKeys(snapshot, fresh) as never,
        version: locked.version + 1,
      });
    });
    const dir = await loadDirectory(this.core.repo, this.core.now());
    this.publishRequested(after, snapshot, dir, { actor: caller.actor, requestId: caller.requestId });
    await this.core.audit({ action: 'access.approval.resubmit', actionLabel: 'Resubmitted request', target: this.auditTarget(after), before: { status: row.status }, after: { status: after.status }, reason: note, approvalRequestId: id }, caller);
    return this.viewOne(after, caller.principal);
  }

  async cancelRequest(caller: Caller, id: string, reason: string): Promise<ApprovalRequest> {
    await this.core.ready();
    const row = await this.core.repo.getRequest(id);
    if (!row) throw notFound('Approval request');
    if (row.requested_by_id !== caller.principal.accountId) throw new AppError('FORBIDDEN', 'Only the requester can withdraw this request');
    approvalRequestMachine.next(row.status as never, 'cancel');
    const after = await this.closeRequest(id, 'cancel', caller.actor, reason, caller.requestId);
    await this.core.audit({ action: 'access.approval.cancel', actionLabel: 'Withdrew request', target: this.auditTarget(after), before: { status: row.status }, after: { status: after.status }, reason, approvalRequestId: id }, caller);
    return this.viewOne(after, caller.principal);
  }

  async remindReviewers(caller: Caller, id: string, message: string | null | undefined): Promise<{ notified: StaffRef[] }> {
    await this.core.ready();
    const row = await this.core.repo.getRequest(id);
    if (!row) throw notFound('Approval request');
    const dir = await loadDirectory(this.core.repo, this.core.now());
    const [view] = await this.views([row], caller.principal, dir);
    if (!view || !(await this.mayView(row, view, caller.principal, dir, (p) => this.core.can(caller, p)))) throw notFound('Approval request');
    if (!(DECIDABLE as readonly string[]).includes(row.status)) {
      throw new AppError('ILLEGAL_TRANSITION', `Approval request: reviewers cannot be reminded of a ${row.status} request`, { machine: 'Approval request', from: row.status, event: 'remind' });
    }
    const minutes = Number(await this.core.ctx.settings.get('reminderMinIntervalMinutes'));
    if (row.last_reminded_at) {
      const next = new Date(row.last_reminded_at.getTime() + minutes * 60_000);
      if (next > this.core.now()) throw new AppError('REMINDER_TOO_SOON', `Reviewers were reminded recently; try again after ${next.toISOString()}`, { nextAllowedAt: next.toISOString() });
    }
    const ids = view.eligibleApprovers.map((s) => s.accountId);
    await this.core.repo.updateRequest(id, { last_reminded_at: this.core.now() });
    this.core.ctx.events.publish('access.approval.reminder_sent', { requestId: id, toAccountIds: ids, by: caller.actor, message: message ?? null }, { actor: caller.actor, requestId: caller.requestId });
    return { notified: view.eligibleApprovers };
  }

  /** Creates the request (or returns the open one for the same action and target) and announces it. */
  async openRequest(
    input: RequestApprovalInput,
    opts: { restrictToBusinessOwner?: boolean; requestedByActor?: common.Actor; requestId?: string },
  ): Promise<RequestRow> {
    await this.core.ready();
    const act = await this.core.requireAction(input.action);
    const existing = await this.core.repo.findOpenRequest(act.key, input.target.type, input.target.id);
    if (existing) return existing;
    const issues: Issue[] = [];
    if (!input.summary?.trim()) issues.push({ path: 'summary', message: 'Summarise the request' });
    if (input.nominatedReviewerId && input.nominatedReviewerId === input.requestedBy.accountId) issues.push({ path: 'nominatedReviewerId', message: 'Nominate someone other than the requester' });
    if (input.amount && (!Number.isSafeInteger(input.amount.amount) || input.amount.amount < 0)) issues.push({ path: 'amount', message: 'Amounts are whole minor units, zero or more' });
    if (issues.length) throw validation('The approval request is not valid', issues);

    const now = this.core.now();
    const dir = await loadDirectory(this.core.repo, now);
    const amount = this.amountOf(act, { money: input.amount ?? null, number: input.quantity ?? null });
    const requesterId = input.requestedBy.accountId ?? '';
    const snapshot = await this.snapshotFor(act, dir, input.requestedBy.kind === 'staff' ? requesterId : null, amount, opts.restrictToBusinessOwner);
    const reqStanding = snapshot.requester ? standing(snapshot.limitKind, snapshot.secondReviewer, snapshot.requester.value, amount, true) : 0;
    const countsAsFirst = snapshot.permissionRule ? this.candidate(requesterId, dir, snapshot).hasPermission || reqStanding >= 2 : reqStanding === 2;
    const state: RequestState = { requesterId, requesterCountsAsFirst: countsAsFirst, approvals: [], amount };
    const ttl = Number(await this.core.ctx.settings.get('approvalRequestTtlHours')) * 3_600_000;
    const dueAt = input.dueAt ? new Date(input.dueAt) : null;
    const ref = await this.core.ctx.refs.next('AP', { digits: 4 });
    const requesterRoles = this.core.sortRoles(dir.rolesOf(requesterId)).map(roleRef);
    const row: RequestRow = {
      id: newId(),
      ref,
      action_key: act.key,
      module: act.module,
      target_type: input.target.type,
      target_id: input.target.id,
      target_ref: input.target.ref ?? null,
      target_label: input.target.label ?? null,
      target_screen: input.target.screen ?? null,
      seller_id: input.target.sellerId ?? null,
      amount_minor: input.amount?.amount ?? null,
      currency: input.amount?.currency ?? null,
      quantity: input.quantity != null ? String(input.quantity) : null,
      summary: input.summary.trim(),
      details: (input.details ?? {}) as never,
      reason: input.reason,
      requested_by_kind: opts.requestedByActor?.kind ?? input.requestedBy.kind,
      requested_by_id: requesterId || (input.requestedBy.sessionId ?? 'unknown'),
      requester_roles: requesterRoles as never,
      requester_counts_as_first: countsAsFirst,
      required_approvals: expectedApprovals(snapshot, state),
      status: approvalRequestMachine.initial,
      eligible_role_keys: stepRoleKeys(snapshot, state) as never,
      nominated_reviewer_id: input.nominatedReviewerId ?? null,
      limit_snapshot: snapshot as never,
      due_at: dueAt,
      expires_at: new Date(dueAt ? dueAt.getTime() + EXPIRY_GRACE_MS : now.getTime() + ttl),
      created_at: now,
      decided_at: null,
      outcome_reason: null,
      last_reminded_at: null,
      version: 1,
    };
    let saved: RequestRow;
    try {
      saved = await this.core.repo.insertRequest(row);
    } catch (err) {
      const again = await this.core.repo.findOpenRequest(act.key, input.target.type, input.target.id);
      if (again) return again; // created concurrently for the same target
      throw err;
    }
    const actor = opts.requestedByActor ?? { kind: input.requestedBy.kind, id: requesterId || null };
    this.publishRequested(saved, snapshot, dir, { actor, requestId: opts.requestId });
    await this.core.audit(
      { action: 'access.approval.request', actionLabel: 'Requested approval', target: this.auditTarget(saved), after: { actionKey: act.key, summary: saved.summary, amount: input.amount ?? null, requiredApprovals: saved.required_approvals }, reason: input.reason, approvalRequestId: saved.id },
      { actor, requestId: opts.requestId },
    );
    return saved;
  }

  private publishRequested(row: RequestRow, snapshot: Snapshot, dir: Directory, meta: { actor: common.Actor; requestId?: string }) {
    const state = this.stateOf(row, []);
    this.core.ctx.events.publish(
      'access.approval.requested',
      {
        requestId: row.id,
        ref: row.ref,
        actionKey: row.action_key,
        module: row.module,
        target: this.targetOf(row),
        amount: moneyOf(row.amount_minor, row.currency),
        summary: row.summary,
        requestedBy: meta.actor,
        eligibleRoleKeys: (row.eligible_role_keys as string[]) ?? [],
        eligibleAccountIds: this.eligiblePeople(snapshot, state, dir, row.nominated_reviewer_id),
        nominatedReviewerId: row.nominated_reviewer_id,
        dueAt: row.due_at ? iso(row.due_at) : null,
      },
      meta,
    );
  }

  /** cancel or expire an open request, announce the outcome and finish this module's own targets */
  async closeRequest(id: string, event: 'cancel' | 'expire', actor: common.Actor, reason: string, requestId?: string): Promise<RequestRow> {
    const after = await this.core.repo.transaction(async (tx) => {
      const locked = await tx.getRequest(id, { forUpdate: true });
      if (!locked) throw notFound('Approval request');
      const status = approvalRequestMachine.next(locked.status as never, event);
      return tx.updateRequest(id, { status, decided_at: this.core.now(), outcome_reason: reason, version: locked.version + 1 });
    });
    await this.finish(after, event === 'expire' ? null : actor, reason, requestId);
    return after;
  }

  /** A request reached a final outcome: announce it, and finish the records this module itself is waiting on */
  private async finish(row: RequestRow, decidedBy: common.Actor | null, reason: string | null, requestId?: string) {
    const outcome = row.status as 'approved' | 'rejected' | 'cancelled' | 'expired';
    const decisions = await this.core.repo.decisionsOf([row.id]);
    this.core.ctx.events.publish(
      'access.approval.decided',
      {
        requestId: row.id,
        ref: row.ref,
        actionKey: row.action_key,
        module: row.module,
        target: this.targetOf(row),
        outcome,
        decidedBy,
        reason,
        amount: moneyOf(row.amount_minor, row.currency),
        approverIds: decisions.filter((d) => d.decision === 'approved').map((d) => d.by_account_id),
        requestedById: row.requested_by_id,
      },
      { actor: decidedBy ?? SYSTEM_ACTOR, requestId },
    );
    if (row.module === 'access') await this.onOwnApprovalDecided(row, outcome, decidedBy ?? SYSTEM_ACTOR);
  }

  /** access's own approval actions: limit changes, sensitive grants and delegations */
  private async onOwnApprovalDecided(row: RequestRow, outcome: 'approved' | 'rejected' | 'cancelled' | 'expired', actor: common.Actor) {
    const approved = outcome === 'approved';
    if (row.target_type === 'limit_change') {
      const lc = await this.core.repo.getLimitChange(row.target_id);
      if (lc?.status !== 'pending_approval') return;
      const status = limitChangeMachine.next('pending_approval', approved ? 'approve' : outcome === 'cancelled' ? 'cancel' : 'reject');
      await this.core.repo.updateLimitChange(lc.id, { status, ...(approved ? {} : { cancel_reason: row.outcome_reason }) });
      if (approved && lc.effective_from <= this.core.now()) await this.limits.applyLimitChange(lc.id);
      return;
    }
    if (row.target_type === 'role_assignment') {
      const a = await this.core.repo.getAssignment(row.target_id);
      if (a?.status !== 'pending_approval') return;
      if (approved) {
        // guarded: a person who hasn't accepted their invitation yet waits in pending_acceptance (identity.invitation.accepted activates it)
        const target = (await this.members.hasAcceptedInvitation(a.account_id)) ? 'active' : 'pending_acceptance';
        const after = await this.core.repo.transaction(async (tx) => {
          const locked = await tx.getAssignment(a.id, { forUpdate: true });
          if (locked?.status !== 'pending_approval') return null;
          return tx.updateAssignment(a.id, { status: roleAssignmentMachine.next('pending_approval', 'approve', target) });
        });
        if (!after) return;
        if (after.status === 'active') {
          const role = await this.core.repo.getRole(after.role_id);
          if (role) this.core.publishRoleChanged(role, 'assigned', after.account_id, actor);
        } else if (await this.members.hasAcceptedInvitation(after.account_id)) {
          // accepted while the approval was being recorded: its event found nothing to activate
          await this.members.activateAcceptedAssignments(after.account_id);
        }
      } else {
        await this.core.repo.updateAssignment(a.id, { status: roleAssignmentMachine.next('pending_approval', 'reject'), revoked_at: this.core.now(), revoked_by: by(actor), revoke_reason: row.outcome_reason ?? `Approval ${outcome}` });
      }
      return;
    }
    if (row.target_type === 'role_permissions' && approved) {
      const role = await this.core.repo.getRole(row.target_id);
      const keys = ((row.details as { permissionKeys?: string[] } | null)?.permissionKeys ?? []).filter((k) => typeof k === 'string');
      if (!role || role.archived_at || !keys.length) return;
      const registry = new Map((await this.core.repo.listPermissions()).map((p) => [p.key, p]));
      const grant = keys.filter((k) => registry.get(k) && !registry.get(k)!.unavailable_since);
      await this.core.repo.addRolePermissions(role.id, grant, by(actor), this.core.now());
      this.core.publishRoleChanged(role, 'permissions_changed', null, actor);
      await this.core.audit({ action: 'access.role.permissions', actionLabel: 'Granted approved permissions', target: this.roles.roleTarget(role), after: { added: grant }, approvalRequestId: row.id }, { actor });
      return;
    }
    if (row.target_type === 'away_period') {
      const p = await this.core.repo.getAway(row.target_id);
      if (p?.status !== 'pending_approval') return;
      const status = awayPeriodMachine.next('pending_approval', approved ? 'approve' : outcome === 'cancelled' ? 'cancel' : 'reject');
      await this.core.repo.updateAway(p.id, { status });
      if (approved && p.starts_at <= this.core.now() && p.ends_at > this.core.now()) await this.away.startAway(p.id);
    }
  }

  /** The amount is above stepUpAbove (money in the same currency): acting or approving needs the password again (a re-auth token) */
  private async stepUpNeeded(amount: Amount): Promise<boolean> {
    const m = amount.money;
    if (!m) return false;
    const above = (await this.core.ctx.settings.get('stepUpAbove')) as common.Money | null;
    return !!above && above.currency === m.currency && m.amount > above.amount;
  }

  /**
   * Approving above stepUpAbove: the approver confirms with their password again (owner decision 2026-10-14: staff
   * have no 2-step), proven by a re-auth token for purpose approval issued to this session. The token is claimed here
   * (single use) and returned, so the caller can give it back if the decision then fails; null when none was needed.
   */
  private async requireStepUp(row: RequestRow, principal: identity.Principal, token: string | null): Promise<string | null> {
    if (row.amount_minor == null || !row.currency) return null;
    const above = (await this.core.ctx.settings.get('stepUpAbove')) as common.Money | null;
    if (!above || above.currency !== row.currency || Number(row.amount_minor) <= above.amount) return null;
    const refuse = () => new AppError('STEP_UP_REQUIRED', `Approvals above ${amountText('money', { money: above })} need your password again`, { kind: 'reauth', purpose: 'approval' });
    if (!token) throw refuse();
    const idp = this.core.ctx.use('identity');
    let ok = false;
    try {
      ok = (await idp.verifyReauthToken(principal, token, 'approval')) && (await idp.consumeReauthToken(token));
    } catch (err) {
      if (!isNotImplemented(err)) throw err; // identity not built yet: fail closed
    }
    if (!ok) throw refuse();
    return token;
  }

  /** Limits in force for this action, the requester's best one and the special rules of access's own actions */
  private async snapshotFor(act: ActionRow, dir: Directory, requesterId: string | null, amount: Amount, restrictToBusinessOwner?: boolean): Promise<Snapshot> {
    const kind = act.limit_kind as LimitKind;
    const mode = act.second_reviewer as SecondMode;
    const limits = await this.core.repo.limitsInForce(dir.now, { actionKey: act.key });
    const roles: Record<string, LimitValue> = {};
    for (const l of limits) {
      const role = dir.roleById.get(l.role_id);
      if (role && !role.archived_at && !roles[role.key]) roles[role.key] = this.limits.limitValue(l);
    }
    const snapshot: Snapshot = { actionKey: act.key, limitKind: kind, secondReviewer: mode, roles, requester: null };
    if (act.key === LIMITS_CHANGE || act.key === DELEGATIONS || restrictToBusinessOwner) snapshot.restrictRoleKeys = [BUSINESS_OWNER];
    if (act.key === SENSITIVE_GRANT) {
      const holders = dir.roles.filter((r) => !r.archived_at && (dir.permsByRole.get(r.id)?.has('access.roles.manage') || r.key === BUSINESS_OWNER)).map((r) => r.key);
      snapshot.permissionRule = { permission: 'access.roles.manage', roleKeys: uniq([BUSINESS_OWNER, ...holders]) };
    }
    if (requesterId) {
      const mine = this.limits.limitsOfPerson(requesterId, dir, limits, kind);
      const best = bestFor(kind, mode, mine, amount, true);
      if (best) snapshot.requester = { roleKey: best.roleKey, value: dir.blocked.has(requesterId) ? this.limits.blockedValue(best.value) : best.value };
      else snapshot.requester = { roleKey: null, value: NOT_PERMITTED };
    }
    return snapshot;
  }

  private candidate(accountId: string, dir: Directory, snapshot: Snapshot): Candidate {
    const delegated: Record<string, string> = {};
    for (const c of dir.covering(accountId)) {
      const role = dir.roleById.get(c.roleId);
      if (c.delegated && role) delegated[role.key] = c.from;
    }
    return {
      accountId,
      roleKeys: dir.rolesOf(accountId).map((r) => r.key),
      delegated,
      hasPermission: snapshot.permissionRule ? dir.permissionsOf(accountId).has(snapshot.permissionRule.permission) : false,
      blocked: dir.blocked.has(accountId),
    };
  }

  /** People who could decide the current step now (backups covering with delegated authority included) */
  eligiblePeople(snapshot: Snapshot, state: RequestState, dir: Directory, nominated: string | null): string[] {
    const keys = stepRoleKeys(snapshot, state);
    const pool = new Set<string>();
    for (const k of keys) {
      const role = dir.roleByKey.get(k);
      if (!role) continue;
      for (const acc of dir.membersOf(role.id)) pool.add(acc);
    }
    for (const { coverage } of dir.away) for (const c of coverage) pool.add(c.covered_by_account_id);
    if (snapshot.permissionRule) for (const a of dir.assignments) pool.add(a.account_id);
    if (nominated) pool.add(nominated);
    const out = [...pool].filter((acc) => evaluate(snapshot, state, this.candidate(acc, dir, snapshot)).ok);
    if (nominated && out.includes(nominated)) return [nominated, ...out.filter((x) => x !== nominated)];
    return out;
  }

  snapshotOf(row: RequestRow): Snapshot {
    const s = row.limit_snapshot as unknown as Snapshot;
    return { ...s, roles: s?.roles ?? {}, requester: s?.requester ?? null, limitKind: s?.limitKind ?? 'none', secondReviewer: s?.secondReviewer ?? 'always', actionKey: s?.actionKey ?? row.action_key };
  }

  stateOf(row: RequestRow, decisions: DecisionRow[]): RequestState {
    const approvals = decisions
      .filter((d) => d.request_id === row.id && d.decision === 'approved')
      .sort((a, b) => a.step - b.step)
      .map((d) => ({ accountId: d.by_account_id, roleKeys: ((d.roles as unknown as RoleRef[]) ?? []).map((r) => r.key) }));
    return { requesterId: row.requested_by_id, requesterCountsAsFirst: row.requester_counts_as_first, approvals, amount: this.amountOfRow(row) };
  }

  private amountOf(act: ActionRow, amount?: AmountInput | null): Amount {
    return act.limit_kind === 'money' ? { money: amount?.money ?? null } : act.limit_kind === 'none' ? {} : { number: amount?.number ?? null };
  }

  private amountOfRow(row: RequestRow): Amount {
    return { money: moneyOf(row.amount_minor, row.currency), number: num(row.quantity) };
  }

  private targetOf(row: RequestRow): ApprovalTarget {
    return { type: row.target_type, id: row.target_id, ref: row.target_ref, label: row.target_label, sellerId: row.seller_id, screen: row.target_screen };
  }

  private auditTarget(row: RequestRow): audit.AuditTarget {
    return { type: row.target_type, id: row.target_id, ref: row.target_ref ?? row.ref, label: row.target_label ?? row.summary, sellerId: row.seller_id, screen: row.target_screen };
  }

  /** Requests the person may decide now, oldest due first */
  async toDecide(principal: identity.Principal, filter: { module?: string; actionKey?: string; overdue?: boolean }, dirIn?: Directory, base: RequestFilter = {}): Promise<ApprovalRequest[]> {
    const me = principal.accountId;
    if (principal.kind !== 'staff' || !me) return [];
    const dir = dirIn ?? (await loadDirectory(this.core.repo, this.core.now()));
    const keys = uniq([...dir.rolesOf(me).map((r) => r.key), ...dir.covering(me).map((c) => dir.roleById.get(c.roleId)?.key ?? '')]).filter(Boolean);
    const rows = await this.core.repo.candidateRequests(keys, me, {
      ...base,
      statuses: [...DECIDABLE].filter((s) => !base.statuses || base.statuses.includes(s)),
      ...(filter.module ? { module: filter.module } : {}),
      ...(filter.actionKey ? { actionKey: filter.actionKey } : {}),
      ...(filter.overdue ? { dueBefore: this.core.now() } : {}),
    });
    const views = (await this.views(rows, principal, dir)).filter((v) => v.canDecide);
    const due = (v: ApprovalRequest) => (v.deadline ? new Date(v.deadline.dueAt).getTime() : Infinity);
    return views.sort((a, b) => due(a) - due(b) || a.createdAt.localeCompare(b.createdAt));
  }

  private async mayView(row: RequestRow, view: ApprovalRequest, principal: identity.Principal, dir: Directory, can: (p: string) => Promise<boolean>): Promise<boolean> {
    const me = principal.accountId;
    if (!me) return false;
    if (row.requested_by_id === me || row.nominated_reviewer_id === me || view.canDecide) return true;
    if (view.approvals.some((a) => a.by.id === me)) return true;
    const mine = new Set(dir.rolesOf(me).map((r) => r.key));
    if (((row.eligible_role_keys as string[]) ?? []).some((k) => mine.has(k))) return true;
    return can('access.approvals.view-all');
  }

  private async viewOne(row: RequestRow, viewer: identity.Principal | null): Promise<ApprovalRequest> {
    return (await this.views([row], viewer))[0]!;
  }

  private async views(rows: RequestRow[], viewer: identity.Principal | null, dirIn?: Directory): Promise<ApprovalRequest[]> {
    if (!rows.length) return [];
    const now = this.core.now();
    const dir = dirIn ?? (await loadDirectory(this.core.repo, now));
    const [decisions, actions] = await Promise.all([this.core.repo.decisionsOf(rows.map((r) => r.id)), this.core.repo.listActions()]);
    const actionByKey = new Map(actions.map((a) => [a.key, a]));
    const prepared = rows.map((row) => {
      const ds = decisions.filter((d) => d.request_id === row.id);
      const snapshot = this.snapshotOf(row);
      const state = this.stateOf(row, ds);
      const open = (DECIDABLE as readonly string[]).includes(row.status);
      const eligible = open ? this.eligiblePeople(snapshot, state, dir, row.nominated_reviewer_id) : [];
      return { row, ds, snapshot, state, open, eligible };
    });
    const people = uniq(
      prepared.flatMap((p) => [
        ...(p.row.requested_by_kind === 'staff' ? [p.row.requested_by_id] : []),
        ...p.ds.map((d) => d.by_account_id),
        ...p.ds.map((d) => d.via_delegation_from).filter((x): x is string => Boolean(x)),
        ...(p.row.nominated_reviewer_id ? [p.row.nominated_reviewer_id] : []),
        ...p.eligible,
      ]),
    );
    const refs = await this.core.staffRefs(people, dir);
    const actor = (id: string, kind = 'staff'): common.Actor => ({ kind: kind as common.Actor['kind'], id, ...(refs.get(id) ? { name: refs.get(id)!.name } : {}) });
    const viewerId = viewer?.accountId ?? null;

    return prepared.map(({ row, ds, snapshot, state, open, eligible }) => {
      const act = actionByKey.get(row.action_key);
      const approvals: ApprovalDecision[] = ds
        .filter((d) => d.decision === 'approved' || d.decision === 'rejected' || d.decision === 'returned')
        .sort((a, b) => a.at.getTime() - b.at.getTime() || a.step - b.step)
        .map((d) => ({
          step: d.step,
          decision: d.decision as ApprovalDecision['decision'],
          by: actor(d.by_account_id),
          roles: (d.roles as unknown as RoleRef[]) ?? [],
          note: d.note,
          viaDelegationFrom: d.via_delegation_from ? (refs.get(d.via_delegation_from) ?? null) : null,
          at: iso(d.at),
        }));
      let canDecide = false;
      let cannot: string | null = null;
      if (!viewerId || viewer?.kind !== 'staff') cannot = 'Only staff decide approval requests';
      else if (row.status === 'returned') cannot = 'Waiting for the requester';
      else if (!open) cannot = `Already ${row.status.replace('_', ' ')}`;
      else {
        const e = evaluate(snapshot, state, this.candidate(viewerId, dir, snapshot));
        canDecide = e.ok;
        cannot = e.ok ? null : e.reason;
      }
      const timeline: common.TimelineEvent[] = [
        { at: iso(row.created_at), label: 'Approval requested', detail: row.reason, actor: row.requested_by_kind === 'staff' ? actor(row.requested_by_id) : { kind: row.requested_by_kind as common.Actor['kind'], id: row.requested_by_id } },
        ...ds.map((d) => ({
          at: iso(d.at),
          label: TIMELINE_LABEL[d.decision] ?? d.decision,
          detail: d.note,
          actor: actor(d.by_account_id),
        })),
        ...(row.last_reminded_at ? [{ at: iso(row.last_reminded_at), label: 'Reviewers reminded', detail: null, actor: null }] : []),
        ...(row.status === 'cancelled' || row.status === 'expired' ? [{ at: iso(row.decided_at ?? now), label: row.status === 'cancelled' ? 'Request withdrawn' : 'Request expired', detail: row.outcome_reason, actor: null }] : []),
      ].sort((a, b) => a.at.localeCompare(b.at));
      return {
        id: row.id,
        ref: row.ref,
        action: act ? this.roles.actionView(act) : { key: row.action_key, module: row.module, label: row.action_key, limit: snapshot.limitKind, secondReviewer: snapshot.secondReviewer, approvers: null, defaultEligibleRoleKeys: [], available: false },
        target: this.targetOf(row),
        amount: moneyOf(row.amount_minor, row.currency),
        quantity: num(row.quantity),
        summary: row.summary,
        details: row.details ?? {},
        reason: row.reason,
        requestedBy: row.requested_by_kind === 'staff' ? actor(row.requested_by_id) : { kind: row.requested_by_kind as common.Actor['kind'], id: row.requested_by_id },
        requestedByRoles: (row.requester_roles as unknown as RoleRef[]) ?? [],
        requesterCountsAsFirst: row.requester_counts_as_first,
        status: row.status as ApprovalRequest['status'],
        requiredApprovals: row.required_approvals,
        approvals,
        eligibleApprovers: eligible.map((id) => refs.get(id)!).filter(Boolean),
        nominatedReviewer: row.nominated_reviewer_id ? (refs.get(row.nominated_reviewer_id) ?? null) : null,
        deadline: row.due_at ? this.deadline(row.due_at, open) : null,
        limitSnapshot: row.limit_snapshot ?? {},
        timeline,
        createdAt: iso(row.created_at),
        decidedAt: row.decided_at ? iso(row.decided_at) : null,
        canDecide,
        cannotDecideReason: cannot,
      };
    });
  }

  private deadline(due: Date, open: boolean): common.Deadline {
    const left = due.getTime() - this.core.now().getTime();
    return { dueAt: iso(due), state: open && left < 0 ? 'overdue' : open && left <= DUE_SOON_MS ? 'due_soon' : 'on_time' };
  }

  async approvalInfos(rows: RequestRow[], dir: Directory): Promise<common.ApprovalInfo[]> {
    const decisions = await this.core.repo.decisionsOf(rows.map((r) => r.id));
    const ids = uniq(decisions.filter((d) => d.decision === 'approved' || d.decision === 'rejected').map((d) => d.by_account_id));
    const refs = await this.core.staffRefs(ids, dir);
    return rows.map((row) => {
      const ds = decisions.filter((d) => d.request_id === row.id);
      const snapshot = this.snapshotOf(row);
      const state = this.stateOf(row, ds);
      const names = (decision: string) => ds.filter((d) => d.decision === decision).map((d) => refs.get(d.by_account_id)?.name ?? 'Staff member');
      const roleNames = this.core.roleRefsOf(stepRoleKeys(snapshot, state), dir).map((r) => r.name);
      const reason =
        row.status === 'approved'
          ? `Approved by ${names('approved').join(' and ')}`
          : row.status === 'rejected'
            ? `Rejected${row.outcome_reason ? `: ${row.outcome_reason}` : ''}`
            : row.status === 'returned'
              ? `Returned for changes${row.outcome_reason ? `: ${row.outcome_reason}` : ''}`
              : row.status === 'cancelled'
                ? 'Withdrawn'
                : row.status === 'expired'
                  ? 'Expired without a decision'
                  : `Waiting for ${roleNames.join(' or ') || 'an approver'}`;
      return { required: true, reason, approvalRequestId: row.id, approvers: row.status === 'approved' ? names('approved') : roleNames };
    });
  }
}
