/** Status flows from the spec (stateMachines). Illegal moves throw ILLEGAL_TRANSITION (409). */
import { createStateMachine } from '../../../kernel/lib/state-machine.js';
import { spec } from '../../../spec/cart.js';

/** Cart lifecycle: CartAdminSummary.status. merge: a guest cart is folded into the customer cart on sign-in. convert: the last eligible lines became an accepted order. restore: a pending payment was declined and checkout put the lines back. A cart with unavailable lines left after an order stays active. */
export const cartLifecycleMachine = createStateMachine("Cart lifecycle", spec.stateMachines["Cart lifecycle"]);

/** Cart line availability: CartItem.state. Derived on every read from open notices. needs_attention lines are included in checkout only after the customer accepts (price increase) or reduces quantity. unavailable lines (out of stock, offer ended, seller unavailable, not shippable) stay in the cart, are excluded from checkout and never replaced by another seller's offer. Price decreases are info notices and accepted automatically. */
export const cartLineAvailabilityMachine = createStateMachine("Cart line availability", spec.stateMachines["Cart line availability"]);
