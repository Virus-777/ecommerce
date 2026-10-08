/** Status flows from the spec (stateMachines). Illegal moves throw ILLEGAL_TRANSITION (409). */
import { createStateMachine } from '../../../kernel/lib/state-machine.js';
import { spec } from '../../../spec/wishlist.js';

/** Wishlist alert: Alert.state. trigger fires when a price drop meets the condition or stock returns (debounced; one notice per alert per alertCooldownHours). Price-drop alerts rearm automatically with the new price as reference; back-in-stock alerts stay triggered until the customer rearms or removes them. pause is automatic when the product becomes unavailable for good (merged, suspended) or the customer turns off wishlist alerts in preferences. */
export const wishlistAlertMachine = createStateMachine("Wishlist alert", spec.stateMachines["Wishlist alert"]);
