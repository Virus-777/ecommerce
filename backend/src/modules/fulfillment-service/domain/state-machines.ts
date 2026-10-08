/** Status flows from the spec (stateMachines). Illegal moves throw ILLEGAL_TRANSITION (409). */
import { createStateMachine } from '../../../kernel/lib/state-machine.js';
import { spec } from '../../../spec/fulfillment-service.js';

/** Service enrollment: Enrollment.state. activate happens when the first inbound shipment is received. suspend stops new inbound shipments and new service-offer sales but keeps fulfilling accepted orders and returns (plan ch. 10). offboarding requires all stock to be removed or disposed before close; storage keeps accruing until then. */
export const serviceEnrollmentMachine = createStateMachine("Service enrollment", spec.stateMachines["Service enrollment"]);

/** SKU enrollment: SkuEnrollment.state. activate when stock is received; the offer then shows 'Ships from Marketly'. deactivate when the seller stops using the service for the SKU (requires zero available stock or a removal order). */
export const skuEnrollmentMachine = createStateMachine("SKU enrollment", spec.stateMachines["SKU enrollment"]);

/** Inbound shipment: InboundShipment.state. Received units become available seller-owned stock only after inspection (Inventory Manager confirms). Discrepancies (short, damaged, extra) open a discrepancy the seller accepts or claims; close happens when it is resolved or after discrepancyResponseDays. */
export const inboundShipmentMachine = createStateMachine("Inbound shipment", spec.stateMachines["Inbound shipment"]);

/** Removal order: RemovalOrder.state. Disposal completes without shipping. Units are reserved out of available when approved. */
export const removalOrderMachine = createStateMachine("Removal order", spec.stateMachines["Removal order"]);

/** Service fee charge: FeeCharge.state. Posted charges reach the seller statement as fulfillment-service lines separate from commission and ad charges. Reversal needs a reason; above the caller's limit it needs Finance approval. */
export const serviceFeeChargeMachine = createStateMachine("Service fee charge", spec.stateMachines["Service fee charge"]);
