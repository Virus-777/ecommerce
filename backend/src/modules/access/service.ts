import { notImplemented } from '../../kernel/errors/index.js';
import type { EventPayload } from '../../kernel/events/index.js';
import type { ModuleContext } from '../../kernel/module-system/index.js';
import type * as common from '../../spec/common.js';
import type * as identity from '../../spec/identity.js';
import type { AccessPublicApi, RoleRef, StaffRef, AmountInput, AuthorityCheck, ApprovalTarget, ApprovalRequest, RequestApprovalInput, RoleCoverage, RecipientResolution, MyActionLimit } from '../../spec/access.js';
import type { AccessRepository } from './ports.js';

export interface AccessServiceDeps {
  repo: AccessRepository;
  ctx: ModuleContext<'access'>;
}

/**
 * Access and approvals use cases. Depends only on ports, the event bus, the clock and other modules' public APIs.
 * Each method maps to a publicApi function, a consumed event or a job in docs/api/spec/modules/access.json.
 */
export class AccessService implements AccessPublicApi {
  constructor(protected readonly deps: AccessServiceDeps) {}

  /* ---------------- public API (in-process) */

  /** Kernel guard for every admin endpoint with a `permission`. Includes roles covered as a backup only where the away period grants them. */
  async hasPermission(principal: identity.Principal, permissionKey: string): Promise<boolean> {
    throw notImplemented("access.hasPermission");
  }

  /** Effective staff permissions (cached, invalidated on access.role.changed) */
  async permissionsOf(accountId: string): Promise<string[]> {
    throw notImplemented("access.permissionsOf");
  }

  /** allowed | approval_required | denied for this person, action and amount, with who could approve. Uses the limits in force now. Permissions alone never make a money action allowed. */
  async check(principal: identity.Principal, action: string, amount?: AmountInput): Promise<AuthorityCheck> {
    throw notImplemented("access.check");
  }

  /** Create an approval request (or return the open one for the same action and target). The requesting module keeps its record pending and finishes on access.approval.decided. */
  async requestApproval(input: RequestApprovalInput): Promise<ApprovalRequest> {
    throw notImplemented("access.requestApproval");
  }

  /** Same rules as the admin approve/reject/return endpoints, for modules that show the decision inside their own screen (payout run approval) */
  async decide(requestId: string, principal: identity.Principal, decision: { kind: 'approve' | 'reject' | 'return', note?: string, stepUpCode?: string }): Promise<ApprovalRequest> {
    throw notImplemented("access.decide");
  }

  /** The requesting module withdraws a request (record changed or deleted) */
  async cancelApproval(requestId: string, by: common.Actor, reason: string): Promise<void> {
    throw notImplemented("access.cancelApproval");
  }

  /** Full request with decisions */
  async getApproval(requestId: string): Promise<ApprovalRequest | null> {
    throw notImplemented("access.getApproval");
  }

  /** Compact common.ApprovalInfo for embedding in other modules' responses */
  async approvalInfo(requestId: string): Promise<common.ApprovalInfo> {
    throw notImplemented("access.approvalInfo");
  }

  /** Who receives a role's work and notices right now: lead, or the covering backup while the lead is away (the lead keeps a copy) */
  async resolveRecipients(roleKey: string): Promise<RecipientResolution> {
    throw notImplemented("access.resolveRecipients");
  }

  /** Active roles of a staff member (audit stores them with each entry) */
  async rolesOf(accountId: string): Promise<RoleRef[]> {
    throw notImplemented("access.rolesOf");
  }

  /** Everyone holding a role (assignment pickers in workqueues and support) */
  async membersOfRole(roleKey: string): Promise<StaffRef[]> {
    throw notImplemented("access.membersOfRole");
  }

  /** Requests the caller may decide now, oldest due first (same rules as GET /approval-requests?view=to_decide). canDecide and steps are computed for the caller. */
  async listApprovalsToDecide(principal: identity.Principal, filter: { module?: string, actionKey?: string, overdue?: boolean }, page: common.PageInput): Promise<common.Page<ApprovalRequest>> {
    throw notImplemented("access.listApprovalsToDecide");
  }

  /** Approval counts for the admin dashboard and inbox */
  async approvalSummaryFor(principal: identity.Principal): Promise<{ toDecide: number, overdue: number, dueSoon: number, myOpenRequests: number, returnedToMe: number }> {
    throw notImplemented("access.approvalSummaryFor");
  }

  /** One request with decisions and steps, null unless the caller is the requester, an eligible approver or holds access.approvals.view-all. canDecide and cannotDecideReason are for the caller. */
  async getApprovalForViewer(principal: identity.Principal, requestId: string): Promise<ApprovalRequest | null> {
    throw notImplemented("access.getApprovalForViewer");
  }

  /** Batched: the current approval request per target record (open request first, else the latest decided one), for approval panels embedded in other modules' admin views (payout run, hold, refund request). Visibility follows the parent record; canDecide is for the caller. */
  async approvalForTargets(principal: identity.Principal, targetType: string, targetIds: string[]): Promise<Map<string, ApprovalRequest | null>> {
    throw notImplemented("access.approvalForTargets");
  }

  /** Batched: open requests whose target belongs to each seller (ApprovalTarget.sellerId), for the admin seller 360 */
  async approvalsForSellers(principal: identity.Principal, sellerIds: string[]): Promise<Map<string, ApprovalRequest[]>> {
    throw notImplemented("access.approvalsForSellers");
  }

  /** Leads, backups and who receives each role's work today (GET /coverage without gaps), for the admin dashboard */
  async coverageNow(filter: { workArea?: string }): Promise<RoleCoverage[]> {
    throw notImplemented("access.coverageNow");
  }

  /** The caller's own authority, limit, second-review rule and approval route for one action (decision panels) */
  async myLimitFor(principal: identity.Principal, actionKey: string): Promise<MyActionLimit> {
    throw notImplemented("access.myLimitFor");
  }

  /** A staff member's display name and role label (roleLabel) for assignee, owner, reviewer and decider columns */
  async getStaffRef(staffId: string): Promise<StaffRef | null> {
    throw notImplemented("access.getStaffRef");
  }

  /* ---------------- events consumed */

  /** identity.invitation.accepted: Activate pending_acceptance role assignments of a newly accepted staff member */
  async onInvitationAcceptedFromIdentity(event: EventPayload<"identity.invitation.accepted">): Promise<void> {
    throw notImplemented("access consumer of identity.invitation.accepted");
  }

  /** identity.account.disabled: Revoke all role assignments, remove the person as lead/backup, drop them from eligible approvers of open requests, and publish access.coverage.changed with the gap */
  async onAccountDisabledFromIdentity(event: EventPayload<"identity.account.disabled">): Promise<void> {
    throw notImplemented("access consumer of identity.account.disabled");
  }

  /** identity.account.locked: Treat a locked staff member as unavailable for routing (backup receives) until unlocked */
  async onAccountLockedFromIdentity(event: EventPayload<"identity.account.locked">): Promise<void> {
    throw notImplemented("access consumer of identity.account.locked");
  }

  /** identity.account.unlocked: Restore routing to the unlocked staff member */
  async onAccountUnlockedFromIdentity(event: EventPayload<"identity.account.unlocked">): Promise<void> {
    throw notImplemented("access consumer of identity.account.unlocked");
  }

  /* ---------------- jobs */

  /** Job access.sync-registry (on boot): Upsert permissions and approval actions from enabled module manifests; mark those of disabled modules unavailable (kept for history); seed the system roles on first boot */
  async syncRegistry(): Promise<void> {
    throw notImplemented("job access.sync-registry");
  }

  /** Job access.apply-limit-changes (every minute): Apply scheduled limit changes whose effectiveFrom has passed; publish access.limits.changed */
  async applyLimitChanges(): Promise<void> {
    throw notImplemented("job access.apply-limit-changes");
  }

  /** Job access.run-away-periods (every 5 min): Start scheduled away periods and end active ones at their time; publish access.away.started/ended and access.coverage.changed */
  async runAwayPeriods(): Promise<void> {
    throw notImplemented("job access.run-away-periods");
  }

  /** Job access.expire-approval-requests (every 15 min): Expire open requests past expires_at (dueAt + grace, or approvalRequestTtlHours) and publish access.approval.decided with outcome expired */
  async expireApprovalRequests(): Promise<void> {
    throw notImplemented("job access.expire-approval-requests");
  }

  /** Job access.remind-approvals (every 30 min): Remind eligible reviewers of requests due within reminderHoursBeforeDue or waiting longer than reminderAfterHours; escalate to the role's escalation role when overdue */
  async remindApprovals(): Promise<void> {
    throw notImplemented("job access.remind-approvals");
  }

  /** Job access.expire-assignments (hourly): Expire role assignments past expiresAt (temporary access) */
  async expireAssignments(): Promise<void> {
    throw notImplemented("job access.expire-assignments");
  }
}
