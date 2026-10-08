/** Status flows from the spec (stateMachines). Illegal moves throw ILLEGAL_TRANSITION (409). */
import { createStateMachine } from '../../../kernel/lib/state-machine.js';
import { spec } from '../../../spec/access.js';

/** Approval request: ApprovalRequest.status. approve moves to partially_approved while approvals < requiredApprovals; approveFinal is the approval that completes it. Each approver must be eligible (a role whose limit covers the amount, or a second-reviewer role above the threshold, or authority delegated during an away period), must not be the requester, and must not have approved the same request already. resubmit clears earlier approvals. approved, rejected, cancelled and expired publish access.approval.decided; the requesting module then acts. Approved is not executed: e.g. a payout shows Paid only after the bank confirms. */
export const approvalRequestMachine = createStateMachine("Approval request", spec.stateMachines["Approval request"]);

/** Limit change: LimitChange.status. Every limit change needs Business Owner approval (action access.limits.change). A change proposed by a Business Owner is approved on creation for other roles' limits; a Business Owner cannot approve a change to a role they hold themselves when another Business Owner exists. Platform Administrators can propose but never approve. apply runs at effectiveFrom (job access.apply-limit-changes) and closes the previous rows (effective_to). */
export const limitChangeMachine = createStateMachine("Limit change", spec.stateMachines["Limit change"]);

/** Role assignment: RoleAssignment.status. Assignments to invited staff wait for identity.invitation.accepted. Assigning a role that carries sensitive permissions, or assigning any role to yourself, creates pending_approval with a second reviewer (action access.roles.sensitive-grant). Disabling the account (identity.account.disabled) revokes all assignments. */
export const roleAssignmentMachine = createStateMachine("Role assignment", spec.stateMachines["Role assignment"]);

/** Away period: AwayPeriod.status. Periods with delegateApprovals start in pending_approval (Business Owner approves the delegation: granting access is not financial authority). start and end run from the job at from/to; end can also be called early. Coverage only re-routes work and notices; covering people use their own limits unless delegation was approved, and then never more than the away person's limits. */
export const awayPeriodMachine = createStateMachine("Away period", spec.stateMachines["Away period"]);
