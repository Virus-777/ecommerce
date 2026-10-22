/** Status flows from the spec (stateMachines). Illegal moves throw ILLEGAL_TRANSITION (409). */
import { createStateMachine } from '../../../kernel/lib/state-machine.js';
import { spec } from '../../../spec/services.js';

/** Service request: ServiceRequest.status. Customers cancel while requested or confirmed (a booking up to 2 hours before its slot). Staff confirm, start, complete, decline or cancel on the provider's behalf. A cancelled or declined booking frees its slot. */
export const serviceRequestMachine = createStateMachine("Service request", spec.stateMachines["Service request"]);

/** Registered device: Device.status. Customers register a device (pending) and may change it while pending or rejected; changing a rejected one resubmits it. Staff verify it with a cover end date or reject it, and may withdraw a verification. */
export const registeredDeviceMachine = createStateMachine("Registered device", spec.stateMachines["Registered device"]);
