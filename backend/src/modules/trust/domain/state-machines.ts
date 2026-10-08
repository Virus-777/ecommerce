/** Status flows from the spec (stateMachines). Illegal moves throw ILLEGAL_TRANSITION (409). */
import { createStateMachine } from '../../../kernel/lib/state-machine.js';
import { spec } from '../../../spec/trust.js';

/** Trust report: TrustReport.status. Resolve needs an outcome and a summary; it is blocked while a recommendation is still sent_to_owner (RECOMMENDATIONS_OPEN) unless the outcome is referred. Dismiss needs a reason and a reporter-facing message. Escalated = high risk or needs the Trust and Risk Manager / Business Owner. Merge moves subjects, evidence and reporters into the kept report. */
export const trustReportMachine = createStateMachine("Trust report", spec.stateMachines["Trust report"]);

/** Recommendation: Recommendation.state. Route sends it to the owner team's queue (workqueues). Accept is done by someone holding the owner team's permission for that action (e.g. catalog.products.publish for suspend_product, sellers.accounts.restrict for restrict_seller, customers.accounts.act for customer restrictions) and records an Enforcement with the owner's reason. Decline needs a reason. Trust staff cannot accept their own recommendations (separate duties, plan ch. 18). */
export const recommendationMachine = createStateMachine("Recommendation", spec.stateMachines["Recommendation"]);

/** Enforcement execution: Enforcement.executionState. Confirmed when the owning module's event arrives carrying the enforcement id (catalog.product.publication_changed, offers.offer.status_changed, sellers.seller.restricted, customers.account.restricted, finance.hold.placed...) or when the owner records the external reference. Reverse (e.g. appeal overturned) publishes trust.enforcement.reversed so the owner undoes it. */
export const enforcementExecutionMachine = createStateMachine("Enforcement execution", spec.stateMachines["Enforcement execution"]);

/** Evidence request: EvidenceRequest.state. Expiry is noted on the report as missing proof; it is not a decision by itself. */
export const evidenceRequestMachine = createStateMachine("Evidence request", spec.stateMachines["Evidence request"]);

/** Trust appeal: TrustAppeal.state. The reviewer must differ from the person who recommended and the person who accepted the enforcement (SAME_REVIEWER_NOT_ALLOWED). Mirrored seller appeals (source sellers) follow the sellers state machine and are read-only here. */
export const trustAppealMachine = createStateMachine("Trust appeal", spec.stateMachines["Trust appeal"]);
