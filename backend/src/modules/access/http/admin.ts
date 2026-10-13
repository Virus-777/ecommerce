import { routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/access.js';
import type { AccessService, Caller } from '../service.js';

/** The caller of a handler, as the service sees it */
const caller = (i: { principal: Caller['principal']; actor: Caller['actor']; requestId: string; can(p: string): Promise<boolean> }): Caller => ({
  principal: i.principal,
  actor: i.actor,
  requestId: i.requestId,
  can: (p) => i.can(p),
});

/**
 * Admin API: /api/admin/access/…  (docs/api/modules/access.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const adminRoutes = (service: AccessService) =>
  routes(endpoints, 'admin', {
    /** GET /roles: Roles with people, lead, backups and approval-limit summary */
    listRoles: async (i) => service.roles.listRoles(caller(i), i.query),
    /** GET /roles/{id}: Role editor: permissions by area, approval limits, pending changes */
    getRole: async (i) => service.roles.getRole(caller(i), i.params.id),
    /** POST /roles: Create a task or custom role */
    createRole: async (i) => service.roles.createRole(caller(i), i.body),
    /** PATCH /roles/{id}: Rename a role, change its work area or escalation role */
    updateRole: async (i) => service.roles.updateRole(caller(i), i.params.id, i.body),
    /** POST /roles/{id}/archive: Archive an unused custom role */
    archiveRole: async (i) => service.roles.archiveRole(caller(i), i.params.id, i.body.reason),
    /** PUT /roles/{id}/permissions: Replace the permissions of a role */
    setRolePermissions: async (i) => service.roles.setRolePermissions(caller(i), i.params.id, i.body.permissionKeys, i.body.reason),
    /** PUT /roles/{id}/coverage: Set the lead, backups and escalation role */
    setRoleCoverage: async (i) => service.roles.setRoleCoverage(caller(i), i.params.id, i.body),
    /** GET /permissions: Permission registry grouped by work area */
    listPermissions: async (i) => service.roles.listPermissions(caller(i), i.query),
    /** GET /members: Staff members with roles, lead/backup duties, away status and 2-step state */
    listMembers: async (i) => service.members.listMembers(caller(i), i.query, i.page),
    /** GET /members/{accountId}: One staff member: assignments, effective permissions and limits, away periods */
    getMember: async (i) => service.members.getMember(caller(i), i.params.accountId),
    /** POST /staff-invitations: Invite a staff member with roles */
    inviteStaff: async (i) => service.members.inviteStaff(caller(i), i.body),
    /** POST /role-assignments: Give a staff member a role */
    assignRole: async (i) => service.members.assignRole(caller(i), i.body),
    /** POST /role-assignments/{id}/revoke: Remove a role from a staff member */
    revokeRoleAssignment: async (i) => service.members.revokeRoleAssignment(caller(i), i.params.id, i.body.reason),
    /** GET /approval-actions: Actions that can have approval limits */
    listApprovalActions: async () => service.roles.listApprovalActions(),
    /** GET /limits: Approval limits in force */
    listLimits: async (i) => service.limits.listLimits(i.query),
    /** POST /limit-changes: Propose new approval limits for a role */
    proposeLimitChange: async (i) => service.limits.proposeLimitChange(caller(i), i.body),
    /** GET /limit-changes: Proposed, scheduled and past limit changes */
    listLimitChanges: async (i) => service.limits.listLimitChanges(i.query, i.page),
    /** POST /limit-changes/{id}/cancel: Withdraw a pending or scheduled limit change */
    cancelLimitChange: async (i) => service.limits.cancelLimitChange(caller(i), i.params.id, i.body.reason),
    /** POST /authority-checks: Can I do this, or who must approve it? */
    checkAuthority: async (i) => service.limits.checkAuthority(caller(i), i.body),
    /** GET /approval-requests: Approval requests (waiting for me, mine, or all) */
    listApprovalRequests: async (i) => service.approvals.listApprovalRequests(caller(i), i.query, i.page),
    /** GET /approval-requests/{id}: One approval request with decisions and whether I can decide */
    getApprovalRequest: async (i) => service.approvals.getApprovalRequest(caller(i), i.params.id),
    /** POST /approval-requests/{id}/approve: Approve (first or second approval) */
    approveRequest: async (i) => {
      const header = i.request.headers['x-step-up-code'];
      return service.approvals.decideAs(caller(i), i.params.id, 'approve', { note: i.body.note, stepUpCode: i.body.stepUpCode ?? (typeof header === 'string' ? header : null) });
    },
    /** POST /approval-requests/{id}/reject: Reject with a reason */
    rejectRequest: async (i) => service.approvals.decideAs(caller(i), i.params.id, 'reject', { reason: i.body.reason }),
    /** POST /approval-requests/{id}/return: Send back to the requester with a comment */
    returnRequest: async (i) => service.approvals.decideAs(caller(i), i.params.id, 'return', { comment: i.body.comment }),
    /** POST /approval-requests/{id}/resubmit: Requester resubmits after a return */
    resubmitRequest: async (i) => service.approvals.resubmitRequest(caller(i), i.params.id, i.body.note),
    /** POST /approval-requests/{id}/cancel: Requester withdraws a request */
    cancelRequest: async (i) => service.approvals.cancelRequest(caller(i), i.params.id, i.body.reason),
    /** POST /approval-requests/{id}/remind: Remind eligible reviewers */
    remindReviewers: async (i) => service.approvals.remindReviewers(caller(i), i.params.id, i.body.message),
    /** GET /away-periods: Away periods (current and upcoming by default) */
    listAwayPeriods: async (i) => service.away.listAwayPeriods(i.query, i.page),
    /** POST /away-periods: Plan time away and who covers each role */
    createAwayPeriod: async (i) => service.away.createAwayPeriod(caller(i), i.body),
    /** POST /away-periods/{id}/end: End an away period early (back at work) */
    endAwayPeriod: async (i) => service.away.endAwayPeriod(caller(i), i.params.id),
    /** POST /away-periods/{id}/cancel: Cancel a planned away period */
    cancelAwayPeriod: async (i) => service.away.cancelAwayPeriod(caller(i), i.params.id, i.body.reason),
    /** GET /coverage: Who receives each role's work today, and coverage gaps */
    getCoverage: async () => service.away.getCoverage(),
    /** GET /me: My roles, permissions, limits and approvals waiting */
    getMyAccess: async (i) => service.members.getMyAccess(caller(i)),
  });
