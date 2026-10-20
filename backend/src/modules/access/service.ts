import { SYSTEM_ACTOR } from '../../kernel/auth/index.js';
import { AppError } from '../../kernel/errors/index.js';
import type { EventPayload } from '../../kernel/events/index.js';
import type * as common from '../../spec/common.js';
import type * as identity from '../../spec/identity.js';
import type {
  AccessPublicApi,
  ApprovalRequest,
  AuthorityCheck,
  AmountInput,
  MyActionLimit,
  RecipientResolution,
  RequestApprovalInput,
  RoleCoverage,
  RoleRef,
  StaffRef,
} from '../../spec/access.js';
import { loadDirectory } from './directory.js';
import { stepRoleKeys } from './domain/limits.js';
import { OPEN_ASSIGNMENT, OPEN_REQUEST } from './ports.js';
import {
  Core,
  type AccessServiceDeps,
  type BootstrapOwnerInput,
  type BootstrapOwnerResult,
  DECIDABLE,
  BATCH,
  groupBy,
  iso,
} from './service/core.js';
import { Roles } from './service/roles.js';
import { Members } from './service/members.js';
import { Limits } from './service/limits.js';
import { Approvals } from './service/approvals.js';
import { AwayPeriods } from './service/away.js';

export type { AccessServiceDeps, Caller, BootstrapOwnerInput, BootstrapOwnerResult } from './service/core.js';

/**
 * Access and approvals use cases. Depends only on its repository, the event bus, the clock and other modules'
 * public APIs. The work is split by feature (service/*.ts; endpoints call service.<feature>.<method>); this class is
 * the module's public API, its event consumers and jobs (docs/api/spec/modules/access.json).
 */
export class AccessService implements AccessPublicApi {
  readonly core: Core;
  readonly roles: Roles;
  readonly members: Members;
  readonly limits: Limits;
  readonly approvals: Approvals;
  readonly away: AwayPeriods;

  constructor(deps: AccessServiceDeps) {
    this.core = new Core(deps);
    this.roles = new Roles(this.core);
    this.members = new Members(this.core);
    this.limits = new Limits(this.core);
    this.approvals = new Approvals(this.core);
    this.away = new AwayPeriods(this.core);
    this.core.parts = { roles: this.roles, members: this.members, limits: this.limits, approvals: this.approvals, away: this.away };
  }

  /** Kernel guard for every admin endpoint with a `permission`. Includes roles covered as a backup only where the away period grants them. */
  hasPermission(principal: identity.Principal, permissionKey: string): Promise<boolean> {
    return this.core.hasPermission(principal, permissionKey);
  }

  /** Effective staff permissions (cached, invalidated on access.role.changed) */
  permissionsOf(accountId: string): Promise<string[]> {
    return this.core.permissionsOf(accountId);
  }

  /** allowed | approval_required | denied for this person, action and amount, with who could approve. Uses the limits in force now. Permissions alone never make a money action allowed. */
  check(principal: identity.Principal, action: string, amount?: AmountInput): Promise<AuthorityCheck> {
    return this.approvals.check(principal, action, amount);
  }

  /** Create an approval request (or return the open one for the same action and target). The requesting module keeps its record pending and finishes on access.approval.decided. */
  requestApproval(input: RequestApprovalInput): Promise<ApprovalRequest> {
    return this.approvals.requestApproval(input);
  }

  /** Same rules as the admin approve/reject/return endpoints, for modules that show the decision inside their own screen (payout run approval) */
  decide(requestId: string, principal: identity.Principal, decision: { kind: 'approve' | 'reject' | 'return'; note?: string; reauthToken?: string }): Promise<ApprovalRequest> {
    return this.approvals.decide(requestId, principal, decision);
  }

  /** The requesting module withdraws a request (record changed or deleted) */
  cancelApproval(requestId: string, by: common.Actor, reason: string): Promise<void> {
    return this.approvals.cancelApproval(requestId, by, reason);
  }

  /** Full request with decisions */
  getApproval(requestId: string): Promise<ApprovalRequest | null> {
    return this.approvals.getApproval(requestId);
  }

  /** Compact common.ApprovalInfo for embedding in other modules' responses */
  approvalInfo(requestId: string): Promise<common.ApprovalInfo> {
    return this.approvals.approvalInfo(requestId);
  }

  /** Who receives a role's work and notices right now: lead, or the covering backup while the lead is away (the lead keeps a copy) */
  resolveRecipients(roleKey: string): Promise<RecipientResolution> {
    return this.away.resolveRecipients(roleKey);
  }

  /** Active roles of a staff member (audit stores them with each entry) */
  rolesOf(accountId: string): Promise<RoleRef[]> {
    return this.members.rolesOf(accountId);
  }

  /** Everyone holding a role (assignment pickers in workqueues and support) */
  membersOfRole(roleKey: string): Promise<StaffRef[]> {
    return this.members.membersOfRole(roleKey);
  }

  /** Whether a staff member may disable an account (Business Owners: only by another, never the last) */
  disableCheck(accountId: string, byAccountId: string | null): Promise<{ allowed: boolean; code: string | null; reason: string | null }> {
    return this.members.disableCheck(accountId, byAccountId);
  }

  /**
   * Active staff whose active role assignments grant the permission (the hasPermission rule: own roles plus roles
   * covered with an approved delegation). Disabled or closed accounts are left out; locked ones are shown away.
   * includeCovering adds people who hold it only as an away-period backup (without delegation).
   */
  staffWithPermission(permissionKey: string, opts?: { includeCovering?: boolean }): Promise<StaffRef[]> {
    return this.members.staffWithPermission(permissionKey, opts);
  }

  /** Requests the caller may decide now, oldest due first (same rules as GET /approval-requests?view=to_decide). canDecide and steps are computed for the caller. */
  listApprovalsToDecide(principal: identity.Principal, filter: { module?: string; actionKey?: string; overdue?: boolean }, page: common.PageInput): Promise<common.Page<ApprovalRequest>> {
    return this.approvals.listApprovalsToDecide(principal, filter, page);
  }

  /** Approval counts for the admin dashboard and inbox */
  approvalSummaryFor(principal: identity.Principal): Promise<{ toDecide: number; overdue: number; dueSoon: number; myOpenRequests: number; returnedToMe: number }> {
    return this.approvals.approvalSummaryFor(principal);
  }

  /** One request with decisions and steps, null unless the caller is the requester, an eligible approver or holds access.approvals.view-all. canDecide and cannotDecideReason are for the caller. */
  getApprovalForViewer(principal: identity.Principal, requestId: string): Promise<ApprovalRequest | null> {
    return this.approvals.getApprovalForViewer(principal, requestId);
  }

  /** Batched: the current approval request per target record (open request first, else the latest decided one), for approval panels embedded in other modules' admin views (payout run, hold, refund request). Visibility follows the parent record; canDecide is for the caller. */
  approvalForTargets(principal: identity.Principal, targetType: string, targetIds: string[]): Promise<Map<string, ApprovalRequest | null>> {
    return this.approvals.approvalForTargets(principal, targetType, targetIds);
  }

  /** Batched: open requests whose target belongs to each seller (ApprovalTarget.sellerId), for the admin seller 360 */
  approvalsForSellers(principal: identity.Principal, sellerIds: string[]): Promise<Map<string, ApprovalRequest[]>> {
    return this.approvals.approvalsForSellers(principal, sellerIds);
  }

  /** Leads, backups and who receives each role's work today (GET /coverage without gaps), for the admin dashboard */
  coverageNow(filter: { workArea?: string }): Promise<RoleCoverage[]> {
    return this.away.coverageNow(filter);
  }

  /** The caller's own authority, limit, second-review rule and approval route for one action (decision panels) */
  myLimitFor(principal: identity.Principal, actionKey: string): Promise<MyActionLimit> {
    return this.limits.myLimitFor(principal, actionKey);
  }

  /** A staff member's display name and role label (roleLabel) for assignee, owner, reviewer and decider columns */
  getStaffRef(staffId: string): Promise<StaffRef | null> {
    return this.members.getStaffRef(staffId);
  }

  /** Job access.sync-registry (on boot): Upsert permissions and approval actions from enabled module manifests; mark those of disabled modules unavailable (kept for history); seed the system roles on first boot */
  syncRegistry(): Promise<void> {
    return this.core.syncRegistry();
  }

  /**
   * The first Business Owner (operator command `npm run bootstrap-owner`, never reachable over HTTP).
   * Every other Business Owner grant needs a Business Owner's approval, so the first one is created
   * here, only while nobody holds or awaits the role. The person also gets Platform Administrator, so
   * they can invite the rest of the staff (the Business Owner role itself doesn't manage staff); they can
   * hand that role to someone else later. Invites the person through identity; the roles become active
   * when they accept (onInvitationAcceptedFromIdentity).
   *
   * With a deputy, both people are invited and both get Business Owner and Platform Administrator, so
   * the two-person rules work from day one: either can approve the sensitive grants the other requests
   * (a Finance Manager, another Business Owner), and neither can approve their own.
   */
  bootstrapBusinessOwner(input: BootstrapOwnerInput): Promise<BootstrapOwnerResult> {
    return this.members.bootstrapBusinessOwner(input);
  }

  /**
   * identity.invitation.accepted: Activate pending_acceptance role assignments of a newly accepted staff member
   * (including sensitive grants already approved); assignments still pending_approval wait for their approval
   * and then become active.
   */
  async onInvitationAcceptedFromIdentity(event: EventPayload<'identity.invitation.accepted'>): Promise<void> {
    if (event.purpose !== 'staff') return;
    await this.core.ready();
    await this.members.activateAcceptedAssignments(event.accountId);
  }

  /**
   * identity.invitation.revoked: End the role assignments still waiting for the revoked staff invitation, so the roles
   * can be granted again (a Business Owner bootstrap stays blocked while one waits). Seller member invitations and
   * events without an account (sent before identity added it) change nothing.
   */
  async onInvitationRevokedFromIdentity(event: EventPayload<'identity.invitation.revoked'>): Promise<void> {
    if (event.purpose !== 'staff' || !event.accountId) return;
    await this.core.ready();
    await this.endOpenAssignments(event.accountId, SYSTEM_ACTOR, 'Invitation revoked');
  }

  /** identity.account.disabled: Revoke all role assignments, remove the person as lead/backup, drop them from eligible approvers of open requests, cancel the open requests they made, and publish access.coverage.changed with the gap */
  async onAccountDisabledFromIdentity(event: EventPayload<'identity.account.disabled'>): Promise<void> {
    await this.core.ready();
    const accountId = event.accountId;
    const reason = `Account disabled: ${event.reason}`;
    const open = await this.endOpenAssignments(accountId, event.by ?? SYSTEM_ACTOR, reason);
    const coverage = await this.core.repo.listCoverage();
    const touched: string[] = [];
    for (const c of coverage) {
      const backups = (c.backup_account_ids as string[]) ?? [];
      if (c.lead_account_id !== accountId && !backups.includes(accountId)) continue;
      await this.core.repo.upsertCoverage({ ...c, lead_account_id: c.lead_account_id === accountId ? null : c.lead_account_id, backup_account_ids: backups.filter((b) => b !== accountId), updated_by: 'system', updated_at: this.core.now() });
      touched.push(c.role_id);
    }
    const nominated = await this.core.repo.findRequests({ statuses: OPEN_REQUEST, nominatedReviewerId: accountId });
    for (const r of nominated) await this.core.repo.updateRequest(r.id, { nominated_reviewer_id: null });
    // what the person asked for leaves with them: an approver must not grant it after they are gone
    const requested = await this.core.repo.findRequests({ statuses: OPEN_REQUEST, requestedById: accountId });
    for (const r of requested) await this.approvals.cancelApproval(r.id, event.by ?? SYSTEM_ACTOR, `${reason} (the requester left)`);
    await this.away.publishCoverageFor(touched);
    if (open.length || touched.length || requested.length) {
      await this.core.audit(
        {
          action: 'access.staff.disabled',
          actionLabel: 'Removed the roles and cover duties of a disabled account',
          target: { type: 'staff', id: accountId },
          before: { assignments: open.map((a) => ({ id: a.id, roleId: a.role_id, status: a.status })), coverageRoleIds: touched, openRequestIds: requested.map((r) => r.id) },
          after: { assignments: [], coverageRoleIds: [], openRequestIds: [] },
          reason,
        },
        { actor: event.by ?? SYSTEM_ACTOR },
      );
    }
  }

  /** identity.account.locked: Treat a locked staff member as unavailable for routing (backup receives) until unlocked */
  async onAccountLockedFromIdentity(event: EventPayload<'identity.account.locked'>): Promise<void> {
    await this.core.ready();
    await this.away.publishCoverageFor(await this.away.rolesRoutedTo(event.accountId), new Set([event.accountId]));
  }

  /** identity.account.unlocked: Restore routing to the unlocked staff member */
  async onAccountUnlockedFromIdentity(event: EventPayload<'identity.account.unlocked'>): Promise<void> {
    await this.core.ready();
    await this.away.publishCoverageFor(await this.away.rolesRoutedTo(event.accountId), undefined, new Set([event.accountId]));
  }

  /** Job access.apply-limit-changes (every minute): Apply scheduled limit changes whose effectiveFrom has passed; publish access.limits.changed */
  async applyLimitChanges(): Promise<void> {
    await this.core.ready();
    for (;;) {
      const due = await this.core.repo.dueLimitChanges(this.core.now(), BATCH);
      for (const lc of due) await this.limits.applyLimitChange(lc.id);
      if (due.length < BATCH) return;
    }
  }

  /** Job access.run-away-periods (every 5 min): Start scheduled away periods and end active ones at their time; publish access.away.started/ended and access.coverage.changed */
  async runAwayPeriods(): Promise<void> {
    await this.core.ready();
    const now = this.core.now();
    const scheduled = await this.core.repo.findAway({ statuses: ['scheduled'], to: new Date(now.getTime() + 1) });
    for (const p of scheduled) await this.away.startAway(p.id);
    const active = await this.core.repo.findAway({ statuses: ['active'] });
    for (const p of active.filter((x) => x.ends_at <= now)) await this.away.finishAway(p.id);
  }

  /** Job access.expire-approval-requests (every 15 min): Expire open requests past expires_at (dueAt + grace, or approvalRequestTtlHours) and publish access.approval.decided with outcome expired */
  async expireApprovalRequests(): Promise<void> {
    await this.core.ready();
    for (;;) {
      const due = await this.core.repo.findRequests({ statuses: OPEN_REQUEST, expiresBefore: this.core.now() }, { limit: BATCH, order: 'created_asc' });
      for (const r of due) await this.approvals.closeRequest(r.id, 'expire', SYSTEM_ACTOR, 'No decision before the request expired');
      if (due.length < BATCH) return;
    }
  }

  /** Job access.remind-approvals (every 30 min): Remind eligible reviewers of requests due within reminderHoursBeforeDue or waiting longer than reminderAfterHours; escalate to the role's escalation role when overdue */
  async remindApprovals(): Promise<void> {
    await this.core.ready();
    const now = this.core.now();
    const before = Number(await this.core.ctx.settings.get('reminderHoursBeforeDue')) * 3_600_000;
    const after = Number(await this.core.ctx.settings.get('reminderAfterHours')) * 3_600_000;
    const open = await this.core.repo.findRequests({ statuses: DECIDABLE }, { order: 'created_asc', limit: 1000 });
    if (!open.length) return;
    const dir = await loadDirectory(this.core.repo, now);
    const decisions = groupBy(await this.core.repo.decisionsOf(open.map((r) => r.id)), (d) => d.request_id);
    for (const r of open) {
      const last = r.last_reminded_at?.getTime() ?? 0;
      let overdue = false;
      if (r.due_at) {
        const due = r.due_at.getTime();
        overdue = now.getTime() > due;
        const windowStart = overdue ? due : due - before;
        if (now.getTime() < due - before || last >= windowStart) continue;
      } else if (now.getTime() - r.created_at.getTime() < after || now.getTime() - last < after) continue;
      const snapshot = this.approvals.snapshotOf(r);
      const state = this.approvals.stateOf(r, decisions.get(r.id) ?? []);
      const to = new Set(this.approvals.eligiblePeople(snapshot, state, dir, null));
      if (overdue) {
        for (const key of stepRoleKeys(snapshot, state)) {
          const esc = dir.roleByKey.get(key)?.escalation_role_id;
          if (esc) for (const acc of dir.membersOf(esc)) if (acc !== r.requested_by_id) to.add(acc);
        }
      }
      await this.core.repo.updateRequest(r.id, { last_reminded_at: now });
      this.core.ctx.events.publish('access.approval.reminder_sent', { requestId: r.id, toAccountIds: [...to], by: SYSTEM_ACTOR, message: overdue ? 'Overdue: escalated' : null }, { actor: SYSTEM_ACTOR });
    }
  }

  /** Job access.expire-assignments (hourly): Expire role assignments past expiresAt (temporary access) */
  async expireAssignments(): Promise<void> {
    await this.core.ready();
    for (const a of await this.core.repo.expiredAssignments(this.core.now())) {
      const after = await this.members.endAssignment(a.id, 'expire', SYSTEM_ACTOR, 'Temporary access ended');
      await this.core.audit(
        { action: 'access.role.expire', actionLabel: 'Temporary role ended', target: { type: 'staff', id: a.account_id }, relatedTargets: [{ type: 'role', id: a.role_id }], before: { status: a.status, expiresAt: iso(a.expires_at!) }, after: { status: after.status } },
        { actor: SYSTEM_ACTOR },
      );
    }
  }

  /**
   * Ends every assignment of the account that is active or still waiting (a waiting approval is rejected); one already
   * ended in between is skipped. Returns the assignments that were open.
   */
  private async endOpenAssignments(accountId: string, actor: common.Actor, reason: string) {
    const open = await this.core.repo.listAssignments({ accountId, statuses: OPEN_ASSIGNMENT });
    for (const a of open) {
      try {
        await this.members.endAssignment(a.id, a.status === 'pending_approval' ? 'reject' : 'revoke', actor, reason);
      } catch (err) {
        if (!(err instanceof AppError && err.code === 'ILLEGAL_TRANSITION')) throw err;
      }
    }
    return open;
  }
}
