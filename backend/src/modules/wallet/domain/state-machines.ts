/** Status flows from the spec (stateMachines). Illegal moves throw ILLEGAL_TRANSITION (409). */
import { createStateMachine } from '../../../kernel/lib/state-machine.js';
import { spec } from '../../../spec/wallet.js';

/** Credit hold: CreditHold.state. A hold never outlives holdTtlMinutes; captured credit returns only through creditRefund. */
export const creditHoldMachine = createStateMachine("Credit hold", spec.stateMachines["Credit hold"]);

/** Goodwill grant: GoodwillGrant.state. Within the requester's goodwill limit the grant is approved immediately (pending_approval → granted in the same call). Above it, an access approval request is raised (e.g. Support limit $50, Finance $2,000). reverse removes unused credit only, with a reason. */
export const goodwillGrantMachine = createStateMachine("Goodwill grant", spec.stateMachines["Goodwill grant"]);

/** Credit correction: CreditCorrection.state. Within the caller's adjustment limit applied in the same call; above it the access approval applies, rejects or (credit no longer there) fails it. */
export const creditCorrectionMachine = createStateMachine("Credit correction", spec.stateMachines["Credit correction"]);

/** Gift card: GiftCard.state. Redeeming moves the full remaining value into a store credit lot (source gift_card). Expiry follows the law of the service region; default no expiry for sold cards. */
export const giftCardMachine = createStateMachine("Gift card", spec.stateMachines["Gift card"]);
