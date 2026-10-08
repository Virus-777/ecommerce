/** Status flows from the spec (stateMachines). Illegal moves throw ILLEGAL_TRANSITION (409). */
import { createStateMachine } from '../../../kernel/lib/state-machine.js';
import { spec } from '../../../spec/inventory.js';

/** Reservation: Reservation.state. held: checkout hold (Available → Reserved) with expiresAt, extended while a payment result is checked. allocate on orders.order.accepted. fulfill on shipping.shipment.dispatched (Reserved → outside). release on cancellation (orders.item.cancelled) or abandoned checkout: Reserved → Available. Released units return to Available only when the purchase has ended or been cancelled (plan ch. 9). Lines move individually (partial cancel or partial shipment); the reservation state is the furthest state of its open lines. */
export const reservationMachine = createStateMachine("Reservation", spec.stateMachines["Reservation"]);

/** Adjustment: Adjustment.state. requestReview when access says the quantity or value at cost is above the requester's adjustment limit (example: Inventory Manager 50 units). approve/reject come from access.approval.decided; the reviewer must be a different person. Nothing moves until applied. Seller adjustments on their own stock apply directly. */
export const adjustmentMachine = createStateMachine("Adjustment", spec.stateMachines["Adjustment"]);

/** Inbound confirmation: InboundReceipt.state. Units stay in Incoming until confirm: sellable → Available, damaged → Damaged or held (review date = supplier claim follow-up). Out-of-stock SKUs allocate waiting orders first. */
export const inboundConfirmationMachine = createStateMachine("Inbound confirmation", spec.stateMachines["Inbound confirmation"]);

/** Return stock outcome: ReturnOutcome.state. Created on returns.return.inspected. restock: Returned → Available. different_condition: Returned → outside on this item and outside → Available on the target item, at the original unit cost. damaged_stock: Returned → Damaged or held (kept, not for sale) with a review date. repair / return_to_supplier: Returned → Damaged or held with a review date. write_off: Returned → outside; value at cost reported to finance. */
export const returnStockOutcomeMachine = createStateMachine("Return stock outcome", spec.stateMachines["Return stock outcome"]);

/** Discrepancy: Discrepancy.state. Opened by warehouse pick shortages and damage at packing. The affected order stays on hold in warehouse until resolved (inventory.discrepancy.resolved). */
export const discrepancyMachine = createStateMachine("Discrepancy", spec.stateMachines["Discrepancy"]);

/** Transfer: Transfer.state. Phase 4 (multiple warehouses). ship: Available at source → outside, Incoming at destination; receive: Incoming → Available. */
export const transferMachine = createStateMachine("Transfer", spec.stateMachines["Transfer"]);

/** Stock count: StockCount.state. Phase 4. apply creates count_correction adjustments; those above the limit go to second review. */
export const stockCountMachine = createStateMachine("Stock count", spec.stateMachines["Stock count"]);
