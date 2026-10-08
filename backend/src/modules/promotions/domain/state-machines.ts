/** Status flows from the spec (stateMachines). Illegal moves throw ILLEGAL_TRANSITION (409). */
import { createStateMachine } from '../../../kernel/lib/state-machine.js';
import { spec } from '../../../spec/promotions.js';

/** Promotion campaign: Campaign.status. Platform and shared campaigns must pass Finance (confirmFunding) before schedule. draft → schedule is allowed only for seller-funded discounts owned by a seller. Edits are locked in in_review. Material edits to an approved or scheduled campaign (discount, scope, budget, funding, period) reopen it to draft and need a new Finance confirmation; cosmetic edits (name, description, terms) do not. start/end run from jobs at startsAt/endsAt; end also fires on budget exhausted, usage cap reached or sold out (endedReason). resume returns to scheduled when the start time has not arrived. Live campaigns cannot be cancelled, only ended (redemptions already exist). */
export const promotionCampaignMachine = createStateMachine("Promotion campaign", spec.stateMachines["Promotion campaign"]);

/** Seller participation: Participation.state. accept records the exact consent text, the offers and the seller share; a seller's offers are included only after consent (plan ch. 15). withdraw is allowed before the campaign starts; after start it becomes requestWithdrawal and Marketing decides. remove is a staff or system action with a reason (offer became ineligible, seller restricted or suspended). */
export const sellerParticipationMachine = createStateMachine("Seller participation", spec.stateMachines["Seller participation"]);

/** Redemption: Redemption.state. Reservations expire after reservationTtlMinutes unless committed. Reversal happens on item cancellation and refunds; usage counts are restored only for full cancellations before dispatch (setting restoreUsageOnCancel). Budget is not credited back for refunds after delivery unless refundRestoresBudget is on. */
export const redemptionMachine = createStateMachine("Redemption", spec.stateMachines["Redemption"]);

/** Flash item: FlashItem.state. sellOut fires when claimed + reserved reaches dealStock. The regular offer stays purchasable at its regular price and is shown separately. restock is a staff edit that raises deal stock (audited). */
export const flashItemMachine = createStateMachine("Flash item", spec.stateMachines["Flash item"]);
