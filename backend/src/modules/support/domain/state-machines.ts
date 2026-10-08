/** Status flows from the spec (stateMachines). Illegal moves throw ILLEGAL_TRANSITION (409). */
import { createStateMachine } from '../../../kernel/lib/state-machine.js';
import { spec } from '../../../spec/support.js';

/** Case: CaseView.status. Order problems about seller items start with sendToSeller (seller handles first, support follows). The job escalates automatically when the seller misses its reply deadline; a customer can escalate when they disagree, a promised refund is late, or the seller misses its deadline. escalate turns an order problem into a dispute (kind = dispute). resolve is refused with REMEDY_PENDING while any remedy is pending_approval, approved or in_progress (plan ch. 17: do not close while a promised refund or replacement is unresolved). close runs automatically autoCloseAfterDays after resolve. reopen is allowed within reopenWindowDays of resolution. appeal is allowed until appealDeadline; decideAppeal must be done by a different staff member than the original decider and makes the decision final. */
export const caseMachine = createStateMachine("Case", spec.stateMachines["Case"]);

/** Remedy: Remedy.status. Refund remedies mirror the returns refund request and payments: approve on returns.refund.approved, start on handover, complete on payments.refund.sent, fail on payments.refund.failed. Replacement remedies complete on delivery of the replacement shipment. Ship-by-deadline remedies complete when the item ships by the date and otherwise fall back to a refund. */
export const remedyMachine = createStateMachine("Remedy", spec.stateMachines["Remedy"]);

/** Case offer: CaseOffer.status. An accepted refund or replacement offer becomes a remedy on the case. */
export const caseOfferMachine = createStateMachine("Case offer", spec.stateMachines["Case offer"]);

/** Appeal: Appeal.status. Reviewer must differ from the original decider (SAME_DECIDER). */
export const appealMachine = createStateMachine("Appeal", spec.stateMachines["Appeal"]);
