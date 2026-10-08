/** Status flows from the spec (stateMachines). Illegal moves throw ILLEGAL_TRANSITION (409). */
import { createStateMachine } from '../../../kernel/lib/state-machine.js';
import { spec } from '../../../spec/advertising.js';

/** Ad campaign: AdCampaign.status. Plan ch. 16 lifecycle (Draft → In review/Submitted → Approved → Scheduled → Live/Active ⇄ Paused → Finished → Archived); Rejected is added for requests that fail review. approve completes only when every required ApprovalStep is approved (own promotions: Advertising plus Content or Marketing; seller and brand ads: Advertising, Content for claims). activate is allowed only if startsAt has passed and no linked promotion starts later. The final approve applies the campaign's afterApproval choice automatically (schedule, or activate when still allowed; if activation became impossible meanwhile it falls back to schedule and says so in the timeline). start/finish run from jobs at startsAt/endsAt; finish also fires on budget or delivery cap reached, linked promotion ended (stopWithPromotion), promoted offer unavailable, seller suspended. Staff pause takes the ad off the site within 1 minute (decision ttl). Renew creates a new draft copy; it is not a transition. Editing a seller request in review sends it back to draft (start of review). */
export const adCampaignMachine = createStateMachine("Ad campaign", spec.stateMachines["Ad campaign"]);

/** Creative review: Creative.status. Creatives are submitted with their campaign. approve needs every required reviewer role. revoke is used when a promoted offer is suspended or a trust enforcement names it (reason recorded; seller can appeal through trust). */
export const creativeReviewMachine = createStateMachine("Creative review", spec.stateMachines["Creative review"]);

/** Ad charge: AdCharge.state. Charges accrue per day from billable clicks/displays or the fixed daily fee and are capped at the daily and total limits. post sends them to finance (advertising.charge.posted) as an ad-charge line separate from commission. Invalid traffic or staff-cancelled delivery is voided (before posting) or credited (after posting) with a reason. Unused budget is never charged. */
export const adChargeMachine = createStateMachine("Ad charge", spec.stateMachines["Ad charge"]);
