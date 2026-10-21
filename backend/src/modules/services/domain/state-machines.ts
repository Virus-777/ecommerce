/** Status flows from the spec (stateMachines). Illegal moves throw ILLEGAL_TRANSITION (409). */
import { createStateMachine } from '../../../kernel/lib/state-machine.js';
import { spec } from '../../../spec/services.js';

/** Service request: ServiceRequest.status. Customers cancel while requested or confirmed (a booking up to 2 hours before its slot). Staff confirm, start, complete, decline or cancel on the provider's behalf. A cancelled or declined booking frees its slot. */
export const serviceRequestMachine = createStateMachine("Service request", spec.stateMachines["Service request"]);
