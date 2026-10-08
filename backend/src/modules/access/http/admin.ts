import { notImplemented, routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/access.js';
import type { AccessService } from '../service.js';

/**
 * Admin API: /api/admin/access/…  (docs/api/modules/access.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const adminRoutes = (service: AccessService) => {
  void service;
  return routes(endpoints, 'admin', {
    /** GET /roles: Roles with people, lead, backups and approval-limit summary */
    listRoles: notImplemented,
    /** GET /roles/{id}: Role editor: permissions by area, approval limits, pending changes */
    getRole: notImplemented,
    /** POST /roles: Create a task or custom role */
    createRole: notImplemented,
    /** PATCH /roles/{id}: Rename a role, change its work area or escalation role */
    updateRole: notImplemented,
    /** POST /roles/{id}/archive: Archive an unused custom role */
    archiveRole: notImplemented,
    /** PUT /roles/{id}/permissions: Replace the permissions of a role */
    setRolePermissions: notImplemented,
    /** PUT /roles/{id}/coverage: Set the lead, backups and escalation role */
    setRoleCoverage: notImplemented,
    /** GET /permissions: Permission registry grouped by work area */
    listPermissions: notImplemented,
    /** GET /members: Staff members with roles, lead/backup duties, away status and 2-step state */
    listMembers: notImplemented,
    /** GET /members/{accountId}: One staff member: assignments, effective permissions and limits, away periods */
    getMember: notImplemented,
    /** POST /staff-invitations: Invite a staff member with roles */
    inviteStaff: notImplemented,
    /** POST /role-assignments: Give a staff member a role */
    assignRole: notImplemented,
    /** POST /role-assignments/{id}/revoke: Remove a role from a staff member */
    revokeRoleAssignment: notImplemented,
    /** GET /approval-actions: Actions that can have approval limits */
    listApprovalActions: notImplemented,
    /** GET /limits: Approval limits in force */
    listLimits: notImplemented,
    /** POST /limit-changes: Propose new approval limits for a role */
    proposeLimitChange: notImplemented,
    /** GET /limit-changes: Proposed, scheduled and past limit changes */
    listLimitChanges: notImplemented,
    /** POST /limit-changes/{id}/cancel: Withdraw a pending or scheduled limit change */
    cancelLimitChange: notImplemented,
    /** POST /authority-checks: Can I do this, or who must approve it? */
    checkAuthority: notImplemented,
    /** GET /approval-requests: Approval requests (waiting for me, mine, or all) */
    listApprovalRequests: notImplemented,
    /** GET /approval-requests/{id}: One approval request with decisions and whether I can decide */
    getApprovalRequest: notImplemented,
    /** POST /approval-requests/{id}/approve: Approve (first or second approval) */
    approveRequest: notImplemented,
    /** POST /approval-requests/{id}/reject: Reject with a reason */
    rejectRequest: notImplemented,
    /** POST /approval-requests/{id}/return: Send back to the requester with a comment */
    returnRequest: notImplemented,
    /** POST /approval-requests/{id}/resubmit: Requester resubmits after a return */
    resubmitRequest: notImplemented,
    /** POST /approval-requests/{id}/cancel: Requester withdraws a request */
    cancelRequest: notImplemented,
    /** POST /approval-requests/{id}/remind: Remind eligible reviewers */
    remindReviewers: notImplemented,
    /** GET /away-periods: Away periods (current and upcoming by default) */
    listAwayPeriods: notImplemented,
    /** POST /away-periods: Plan time away and who covers each role */
    createAwayPeriod: notImplemented,
    /** POST /away-periods/{id}/end: End an away period early (back at work) */
    endAwayPeriod: notImplemented,
    /** POST /away-periods/{id}/cancel: Cancel a planned away period */
    cancelAwayPeriod: notImplemented,
    /** GET /coverage: Who receives each role's work today, and coverage gaps */
    getCoverage: notImplemented,
    /** GET /me: My roles, permissions, limits and approvals waiting */
    getMyAccess: notImplemented,
  });
};
