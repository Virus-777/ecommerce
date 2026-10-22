/** Status flows from the spec (stateMachines). Illegal moves throw ILLEGAL_TRANSITION (409). */
import { createStateMachine } from '../../../kernel/lib/state-machine.js';
import { spec } from '../../../spec/software.js';

/** Software purchase: SoftwarePurchase.status. pay: the card is authorized and the purchase captures it at once (payments.capturePurchase), then grants the entitlements. A pending check stays pending_payment until payments.purchase.authorized or payments.purchase.failed. requires_action purchases older than 30 minutes are abandoned (the intent is voided). */
export const softwarePurchaseMachine = createStateMachine("Software purchase", spec.stateMachines["Software purchase"]);
