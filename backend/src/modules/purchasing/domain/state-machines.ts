/** Status flows from the spec (stateMachines). Illegal moves throw ILLEGAL_TRANSITION (409). */
import { createStateMachine } from '../../../kernel/lib/state-machine.js';
import { spec } from '../../../spec/purchasing.js';

/** Purchase order: PurchaseOrder.status. send checks the buyer's purchase limit in access (example: Purchasing Manager up to $25,000). Above it the PO stays Draft with approval.required and an approval request; it is sent automatically when access.approval.decided approves. send adds Incoming in inventory (expectIncoming). cancel from Sent only while nothing was received; it removes Incoming. receivePart / receiveAll follow submitted receipts. closeShort ends a partly received PO with a reason; open quantities leave Incoming and a shortage claim can be raised. */
export const purchaseOrderMachine = createStateMachine("Purchase order", spec.stateMachines["Purchase order"]);

/** Delivery: Delivery.status. delay is set by the buyer or by the late-delivery job when the window passes without arrival. completeWithIssues when the submitted receipt has shortages, damage or over-receipt. */
export const deliveryMachine = createStateMachine("Delivery", spec.stateMachines["Delivery"]);

/** Receipt: Receipt.status. Warehouse staff count lines (received, damaged with photos, bin) and submit. Units stay in Incoming until the Inventory Manager confirms in inventory; confirm comes from inventory.receipt.confirmed. */
export const receiptMachine = createStateMachine("Receipt", spec.stateMachines["Receipt"]);

/** Supplier claim: SupplierClaim.status. Damaged units stay in Damaged or held (inventory) until the claim is settled; settlement is reported to finance. */
export const supplierClaimMachine = createStateMachine("Supplier claim", spec.stateMachines["Supplier claim"]);
