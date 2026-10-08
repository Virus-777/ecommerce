/** Status flows from the spec (stateMachines). Illegal moves throw ILLEGAL_TRANSITION (409). */
import { createStateMachine } from '../../../kernel/lib/state-machine.js';
import { spec } from '../../../spec/returns.js';

/** Return: ReturnDetail.status. Customer labels: requested→Requested, info_requested→Waiting for you, approved→Approved (send it back), in_transit→Sent back, received→Received, awaiting_remedy→Inspected (or Approved without return), completed→Refunded / Replaced / Partly refunded, rejected→Rejected, cancelled→Cancelled. Seller labels: Return requested, Waiting on customer, Return in transit, Inspecting, Escalated (platformHandling flag), Decision made. The respond-by clock pauses while info_requested. approveWithoutReturn / waiveReturn require a recorded reason (refund-without-return exception). overturn is a platform action (returns.returns.manage) after a customer challenges a seller rejection. complete fires automatically when the remedy finishes: refund Sent, replacement shipped, or store credit issued. */
export const returnMachine = createStateMachine("Return", spec.stateMachines["Return"]);

/** Return shipment: ReturnShipment.status. Driven by shipping tracking events for the return label (first carrier scan = dropOff). Customer-arranged returns start at label_issued without a label and move to in_transit when the customer adds tracking (returns registers it with shipping.registerReturnTracking so carrier events arrive like any return parcel). A label activates when the carrier scans the QR code. Lost in transit to the warehouse leads to waiveReturn on the return with a carrier claim. */
export const returnShipmentMachine = createStateMachine("Return shipment", spec.stateMachines["Return shipment"]);

/** Refund request: RefundRequest.status. Plan ch. 13 refund statuses. requested = estimate shown at request time. Seller-issued refunds for the seller's own return go requested→approved (the seller is the approver). Official Store, platform-decided, case and exception refunds go through under_review and Finance approval (returns.refunds.approve); above the approver's limit approve returns APPROVAL_REQUIRED and an access approval request. handOver happens in the same transaction as approval by calling payments; confirmSent and fail mirror payments.refund.sent / payments.refund.failed. Retry is executed by payments (it checks the provider first so a refund is never sent twice). Approved never means money arrived; only sent does. */
export const refundRequestMachine = createStateMachine("Refund request", spec.stateMachines["Refund request"]);

/** Replacement: Replacement.status. Replacement stock is reserved through inventory; returns.replacement.created asks orders/warehouse (Official Store) or the seller to fulfil it as a zero-charge shipment. If stock is gone, cancel with a reason and offer a refund instead. A replacement gets a new 30-day return window. */
export const replacementMachine = createStateMachine("Replacement", spec.stateMachines["Replacement"]);

/** Policy version: PolicyVersion.status. Baseline changes need Business Owner approval (access approval request). activate runs at effectiveFrom. Orders placed before the effective date keep their snapshot. */
export const policyVersionMachine = createStateMachine("Policy version", spec.stateMachines["Policy version"]);

/** Category exception: CategoryException.status. A create or change that shortens a window (approval action returns.policies.shorten-window) is saved as pending_approval with an access approval request for the Business Owner ('Send for approval'); approve and reject come from access.approval.decided. Changes that do not shorten a window skip pending_approval and are saved as scheduled. activate runs at effectiveFrom. */
export const categoryExceptionMachine = createStateMachine("Category exception", spec.stateMachines["Category exception"]);
