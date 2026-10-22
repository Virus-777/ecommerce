/** Status flows from the spec (stateMachines). Illegal moves throw ILLEGAL_TRANSITION (409). */
import { createStateMachine } from '../../../kernel/lib/state-machine.js';
import { spec } from '../../../spec/food.js';

/** Food order: FoodOrder.status. pay: the card is authorized (payments.authorizePurchase), the basket is emptied and the restaurant is told. Customers cancel only while placed; staff accept, decline, move and cancel on the restaurant's behalf. deliver captures the payment (payments.capturePurchase); decline and cancel void it (payments.voidIntent). Placed orders not accepted within acceptMinutes are declined automatically. */
export const foodOrderMachine = createStateMachine("Food order", spec.stateMachines["Food order"]);
