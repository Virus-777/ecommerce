/** Status flows from the spec (stateMachines). Illegal moves throw ILLEGAL_TRANSITION (409). */
import { createStateMachine } from '../../../kernel/lib/state-machine.js';
import { spec } from '../../../spec/finance.js';

/** Earnings lot: EarningsLot.state. makeAvailable runs when the item is delivered and the hold window (availableAfterDeliveryDays) has passed. A refund after paid_out does not touch the lot: it is a refund_after_payout ledger entry that can make the balance negative. A failed payout returns its lots to available. */
export const earningsLotMachine = createStateMachine("Earnings lot", spec.stateMachines["Earnings lot"]);

/** Hold: Hold.status. Every hold has a reason and a review date shown to the seller. apply turns the held amount into a deduction (e.g. chargeback lost) with a reason. Placing or releasing above the approver's hold limit needs an access approval. */
export const holdMachine = createStateMachine("Hold", spec.stateMachines["Hold"]);

/** Payout run: PayoutRun.status. Runs above runSecondReviewerThreshold need two different Finance approvers (access approval request for the second). Approved is not paid: release sends each pending payout to the provider (processing). complete runs when every payout is paid, failed or cancelled. */
export const payoutRunMachine = createStateMachine("Payout run", spec.stateMachines["Payout run"]);

/** Payout: Payout.status. Plan ch. 14 payout statuses. Paid only when the provider confirms the deposit. A failed payout returns its money to the seller's available balance (payout_returned entry); recovery creates a new payout (retryOf) after the destination is fixed and verified. Payouts only go to a verified destination. */
export const payoutMachine = createStateMachine("Payout", spec.stateMachines["Payout"]);

/** Destination review: DestinationReview.status. Created when sellers publishes sellers.payout_account.changed. Checks: micro-deposits, owner re-authentication, callback to the registered phone. Payouts keep going to the current verified account until verify; payouts to the new one wait at least destinationChangePauseHours. */
export const destinationReviewMachine = createStateMachine("Destination review", spec.stateMachines["Destination review"]);

/** Fee rule set: FeeRuleSet.status. Proposed by the Platform Administrator or Finance, approved by the Business Owner (access). Fees on an order item use the version active when the order was accepted. */
export const feeRuleSetMachine = createStateMachine("Fee rule set", spec.stateMachines["Fee rule set"]);

/** Adjustment: Adjustment.status. Within the recorder's limit an adjustment is recorded at once; above adjustmentSecondReviewerThreshold it waits for a second Finance reviewer. */
export const adjustmentMachine = createStateMachine("Adjustment", spec.stateMachines["Adjustment"]);

/** Reconciliation item: ReconItem.status. explain records a reason when no money needs to move (timing, provider fee). Corrections above correctionSecondReviewerThreshold need a second reviewer; applying one posts the matching entry (refund via payments, seller adjustment, write-off). */
export const reconciliationItemMachine = createStateMachine("Reconciliation item", spec.stateMachines["Reconciliation item"]);

/** Amount owed: AmountOwed.status. Created when a negative balance is not covered within negativeBalanceOwedAfterDays. New earnings offset it first. Write-off needs a reason and approval. */
export const amountOwedMachine = createStateMachine("Amount owed", spec.stateMachines["Amount owed"]);

/** Statement: Statement.status. Issued at the payout cutoff; immutable afterwards. */
export const statementMachine = createStateMachine("Statement", spec.stateMachines["Statement"]);
