/** Status flows from the spec (stateMachines). Illegal moves throw ILLEGAL_TRANSITION (409). */
import { createStateMachine } from '../../../kernel/lib/state-machine.js';
import { spec } from '../../../spec/sellers.js';

/** Seller account status: SellerAccount.status. The plan's seven statuses. A seller row is created on submit (applied). Rejection, withdrawal and expiry close the row with closedReason; reopenOnAppeal applies only when closedReason = application_rejected and an appeal is overturned. Restricted = at least one active restriction; adding more keeps it restricted. Suspend takes effect only after the second reviewer approves (access approval request); until then the suspension row is pending_approval and the status does not change. Suspending or restricting never blocks existing orders, returns, cases, messages or (unless finance holds them) payouts (scenario 7). Account status, product approval (catalog) and payout readiness (finance) are separate fields everywhere. */
export const sellerAccountStatusMachine = createStateMachine("Seller account status", spec.stateMachines["Seller account status"]);

/** Seller application: SellerApplication.state. Submit is blocked (APPLICATION_INCOMPLETE, details.missing) until every step is complete and all current agreement versions are accepted. Approve is blocked (CHECKS_UNRESOLVED) while a check is failed or needs attention without an accepted note. Reject requires reasonCode, an explanation the applicant reads and a reapply rule. Approval does not publish products or enable payouts. */
export const sellerApplicationMachine = createStateMachine("Seller application", spec.stateMachines["Seller application"]);

/** Restriction: Restriction.state. Created directly as active when the caller's limit allows it (access); otherwise pending_approval until a second reviewer decides. Editing an active restriction (scope, reason, review date) is audited and republished as sellers.restriction.updated. Lift needs a reason; an overturned appeal lifts automatically. */
export const restrictionMachine = createStateMachine("Restriction", spec.stateMachines["Restriction"]);

/** Suspension: suspensions.state. approve/decline come from access.approval.decided for the named second reviewer. Ending (reinstate, overturned appeal) moves the account through reinstate or reinstateWithRestrictions. */
export const suspensionMachine = createStateMachine("Suspension", spec.stateMachines["Suspension"]);

/** Seller warning: SellerWarning.state. Resolve records a note, e.g. 'resolved after 7 days on time'. */
export const sellerWarningMachine = createStateMachine("Seller warning", spec.stateMachines["Seller warning"]);

/** Seller invitation: SellerInvitation.state. apply happens when startApplication uses the invitation code. */
export const sellerInvitationMachine = createStateMachine("Seller invitation", spec.stateMachines["Seller invitation"]);

/** Appeal: Appeal.state. The reviewer can never be the person who made the original decision (SAME_REVIEWER_NOT_ALLOWED). After upheld the seller may file one level-2 appeal, which goes to secondAppealTo. Appeals must be filed before the route's deadline (APPEAL_WINDOW_CLOSED). */
export const appealMachine = createStateMachine("Appeal", spec.stateMachines["Appeal"]);

/** Change request: ChangeRequest.state. Store name, legal name, ownership and business address. The current value stays live until approval. Ownership changes may also re-run verification checks. */
export const changeRequestMachine = createStateMachine("Change request", spec.stateMachines["Change request"]);

/** Public claim: PublicClaim.state. Only approved claims show on the storefront. Revoke is used when trust finds the claim false; it records a policy violation. */
export const publicClaimMachine = createStateMachine("Public claim", spec.stateMachines["Public claim"]);

/** Seller member: SellerMember.status. Accept happens in identity (identity.invitation.accepted). The owner cannot be removed or suspended; ownership moves only through an ownership change request. */
export const sellerMemberMachine = createStateMachine("Seller member", spec.stateMachines["Seller member"]);

/** Launch readiness review: LaunchReview.state. Request unlocks when payout readiness is verified and at least one product or offer is submitted. Passing publishes sellers.launch_review.decided; offers then activates the seller's eligible offers (approved product, complete offer with stock). */
export const launchReadinessReviewMachine = createStateMachine("Launch readiness review", spec.stateMachines["Launch readiness review"]);

/** Payout readiness: PayoutReadiness.state. Mirror of finance's destination review: verified/rejected come from finance.destination.verified / finance.destination.rejected. During a change the old verified destination keeps receiving payouts. */
export const payoutReadinessMachine = createStateMachine("Payout readiness", spec.stateMachines["Payout readiness"]);

/** Verified seller label: VerificationLabel.state. Granted when identity, business registration, payout account and return address checks pass. Lapses when a checked document expires (e.g. business licence renewal). The label always says product authenticity was not checked. */
export const verifiedSellerLabelMachine = createStateMachine("Verified seller label", spec.stateMachines["Verified seller label"]);
