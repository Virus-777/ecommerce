/** Status flows from the spec (stateMachines). Illegal moves throw ILLEGAL_TRANSITION (409). */
import { createStateMachine } from '../../../kernel/lib/state-machine.js';
import { spec } from '../../../spec/checkout.js';

/** Checkout session: CheckoutView.status. placing is held under a row lock; a second Place order (any key) while placing, payment_pending or completed returns the current result instead of a new attempt. payment_failed keeps lines, delivery choices, coupons, the stock hold and the promotion reservation until holdUntil (retry window). After a pending payment is finally declined the order is cancelled by orders, the lines are restored to the cart and the session returns to payment_failed; a retry then creates a new order. expire releases holds and voids any authorization. */
export const checkoutSessionMachine = createStateMachine("Checkout session", spec.stateMachines["Checkout session"]);
