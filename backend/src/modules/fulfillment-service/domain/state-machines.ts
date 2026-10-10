/** Status flows from the spec (stateMachines). Illegal moves throw ILLEGAL_TRANSITION (409). */
import { createStateMachine } from '../../../kernel/lib/state-machine.js';
import { spec } from '../../../spec/fulfillment-service.js';

/** Service enrollment: Enrollment.state. activate happens when the first service receipt with sellable units is confirmed by inventory. suspend and offboard stop service-offer sales (offers Ineligible, never seller-shipped, decision D5) but accepted orders and returns go on; close needs all stock gone. */
export const serviceEnrollmentMachine = createStateMachine("Service enrollment", spec.stateMachines["Service enrollment"]);

/** SKU enrollment: SkuEnrollment.state. activate when a confirmed service receipt has sellable units (inventory.setServiceLocation, then offer.service_changed); deactivate needs no available units at the service location. */
export const skuEnrollmentMachine = createStateMachine("SKU enrollment", spec.stateMachines["SKU enrollment"]);

/** Inbound shipment: InboundShipment.state. Each receiving record is an inventory service receipt; its units become available only when the Inventory Manager confirms it (decision D3). Discrepancies (short, damaged, extra) open a discrepancy the seller accepts or claims; close happens when it is resolved or after discrepancyResponseDays. */
export const inboundShipmentMachine = createStateMachine("Inbound shipment", spec.stateMachines["Inbound shipment"]);

/** Removal order: RemovalOrder.state. Disposal completes without shipping. Approve takes available units out of sale (inventory damaged_held); complete takes the units out of stock. */
export const removalOrderMachine = createStateMachine("Removal order", spec.stateMachines["Removal order"]);

/** Stock difference: StockDifference.state. Opened by the reconcile job; resolved by staff (adjust_ledger, reimburse, no_change). */
export const stockDifferenceMachine = createStateMachine("Stock difference", spec.stateMachines["Stock difference"]);

/** Service fee charge: FeeCharge.state. Posted charges reach the seller statement as fulfillment-service lines separate from commission and ad charges. Reversal needs a reason; above the caller's limit it needs Finance approval. */
export const serviceFeeChargeMachine = createStateMachine("Service fee charge", spec.stateMachines["Service fee charge"]);
