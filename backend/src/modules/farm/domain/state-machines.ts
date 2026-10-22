/** Status flows from the spec (stateMachines). Illegal moves throw ILLEGAL_TRANSITION (409). */
import { createStateMachine } from '../../../kernel/lib/state-machine.js';
import { spec } from '../../../spec/farm.js';

/** Farm order: FarmOrder.status. Pay in full starts in payment_pending; pay: the card is authorized (payments.authorizePurchase). Installments and pay on delivery need no card and start placed. confirm sets the delivery date and captures a pay-in-full card (payments.capturePurchase); reject, cancel and expire void it (payments.voidIntent). Customers cancel while placed or payment_failed; staff move and cancel on the dealer's behalf, but a captured card order is not cancelled in the app (refunds of purchases are not built). Placed orders not confirmed within confirmHours expire. */
export const farmOrderMachine = createStateMachine("Farm order", spec.stateMachines["Farm order"]);
