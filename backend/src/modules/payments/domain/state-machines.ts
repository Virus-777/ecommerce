/** Status flows from the spec (stateMachines). Illegal moves throw ILLEGAL_TRANSITION (409). */
import { createStateMachine } from '../../../kernel/lib/state-machine.js';
import { spec } from '../../../spec/payments.js';

/** Payment intent: PaymentDetail.status. Customer view: Accepted = authorized, partially_captured or captured; Pending = authorizing, requires_action or pending_check; Failed = failed, voided before an order or expired. Refunded and Partly refunded are derived from refunds. A retry after failed is a new intent (attempt n+1) for the same checkout session; only one non-failed intent per session can exist, so a double submit cannot authorize twice. pending_check is resolved only by asking the provider (job or webhook), never by charging again. */
export const paymentIntentMachine = createStateMachine("Payment intent", spec.stateMachines["Payment intent"]);

/** Refund execution: Refund.status. Starts when returns hands over an approved refund request, orders cancels items, finance records a correction or payments finds an orphan payment. Approval (Under review, Approved) lives in returns. processing covers provider-pending and unknown outcomes (outcomeUnknown); retry first retrieves the provider's record of the earlier attempt and only resends when the provider confirms nothing was sent, so a refund is never sent twice. Retries stop at refundMaxAttempts; then the customer is asked for a new destination or support takes over. Store credit destinations (phase 3) go through wallet.creditRefund and are sent immediately. cancel requires a reason (e.g. settled another way) and releases the in-flight amount. */
export const refundExecutionMachine = createStateMachine("Refund execution", spec.stateMachines["Refund execution"]);

/** Payment dispute: Dispute.status. The provider takes the money back when a chargeback opens; finance holds the seller amount on payments.chargeback.opened and applies or releases it on payments.chargeback.decided. accept (concede) is audited and needs approval above the staff member's limit. Inquiries that close without a chargeback end as won. */
export const paymentDisputeMachine = createStateMachine("Payment dispute", spec.stateMachines["Payment dispute"]);
