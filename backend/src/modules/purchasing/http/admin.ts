import { routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/purchasing.js';
import type { Caller, PurchasingService } from '../service.js';

const by = (i: { principal: Caller['principal']; actor: Caller['actor']; requestId: string }): Caller => ({ principal: i.principal, actor: i.actor, requestId: i.requestId });

/**
 * Admin API: /api/admin/purchasing/…  (docs/api/modules/purchasing.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const adminRoutes = (service: PurchasingService) =>
  routes(endpoints, 'admin', {
    /** GET /summary: Open purchase orders, committed cost, incoming units, late or short, low-stock items */
    getPurchasingSummary: async () => service.summary.getSummary(),
    /** GET /suppliers: Suppliers with lead time, on-time rate and open POs */
    listSuppliers: async ({ query, page }) => service.suppliers.listSuppliers(query, page),
    /** POST /suppliers: Add a supplier */
    createSupplier: async (i) => service.suppliers.createSupplier(i.body, by(i)),
    /** GET /suppliers/{id}: Supplier with price list, performance, recent POs and open claims */
    getSupplier: async ({ params }) => service.suppliers.getSupplier(params.id),
    /** PATCH /suppliers/{id}: Edit or deactivate a supplier */
    updateSupplier: async (i) => service.suppliers.updateSupplier(i.params.id, i.body, by(i)),
    /** PUT /suppliers/{id}/items: Replace a supplier's price list (buying costs per SKU) */
    putSupplierItems: async (i) => service.suppliers.putSupplierItems(i.params.id, i.body.items, by(i)),
    /** GET /purchase-orders: Purchase orders with status, cost and expected arrival */
    listPurchaseOrders: async ({ query, page }) => service.purchaseOrders.listPurchaseOrders(query, page),
    /** POST /purchase-orders: Create a draft purchase order */
    createPurchaseOrder: async (i) => service.purchaseOrders.createPurchaseOrder(i.body, by(i)),
    /** GET /purchase-orders/{id}: Purchase order: lines expected vs received, costs, deliveries, receipts, claims, approval and timeline */
    getPurchaseOrder: async ({ params }) => service.purchaseOrders.getPurchaseOrder(params.id),
    /** PATCH /purchase-orders/{id}: Edit a draft, or update expected dates and notes after sending */
    updatePurchaseOrder: async (i) => service.purchaseOrders.updatePurchaseOrder(i.params.id, i.body, by(i)),
    /** POST /purchase-orders/{id}/send: Send to the supplier (or request approval when above the buyer's limit) */
    sendPurchaseOrder: async (i) => service.purchaseOrders.sendPurchaseOrder(i.params.id, i.body ?? {}, by(i)),
    /** POST /purchase-orders/{id}/cancel: Cancel a draft or a sent PO with nothing received */
    cancelPurchaseOrder: async (i) => service.purchaseOrders.cancelPurchaseOrder(i.params.id, i.body, by(i)),
    /** POST /purchase-orders/{id}/close: Close a partly received PO short (remaining units will not arrive) */
    closePurchaseOrder: async (i) => service.purchaseOrders.closePurchaseOrder(i.params.id, i.body, by(i)),
    /** GET /reorder-suggestions: SKUs at or below reorder point after incoming stock, with suggested quantity and preferred supplier */
    listReorderSuggestions: async ({ query, page }) => service.reorder.listReorderSuggestions(query, page),
    /** POST /purchase-orders/from-suggestions: Create draft POs (one per preferred supplier) from selected suggestions */
    createFromSuggestions: async (i) => service.reorder.createFromSuggestions(i.body, by(i)),
    /** GET /deliveries: Expected and arrived purchase deliveries for receiving */
    listDeliveries: async ({ query, page }) => service.deliveries.listDeliveries(query, page),
    /** POST /purchase-orders/{id}/deliveries: Add an expected delivery (carrier, reference, arrival window) */
    addDelivery: async (i) => service.deliveries.addDelivery(i.params.id, i.body, by(i)),
    /** PATCH /deliveries/{id}: Reschedule or mark a delivery delayed, with a reason */
    updateDelivery: async (i) => service.deliveries.updateDelivery(i.params.id, i.body, by(i)),
    /** POST /deliveries/{id}/arrive: Check in a delivery at the dock */
    arriveDelivery: async (i) => service.deliveries.arriveDelivery(i.params.id, i.body ?? {}, by(i)),
    /** POST /deliveries/{id}/receipts: Start receiving: creates the receiving record with expected quantities */
    startReceipt: async (i) => service.receipts.startReceipt(i.params.id, by(i)),
    /** GET /deliveries/stats: Receiving KPIs and tab counts */
    getReceivingStats: async ({ query }) => service.deliveries.getReceivingStats(query),
    /** GET /receipts: Receiving records (in progress, waiting for confirmation, with issues, completed) */
    listReceipts: async ({ query, page }) => service.receipts.listReceipts(query, page),
    /** GET /receipts/{id}: One receiving record: expected vs received, damage photos, bins, buying cost */
    getReceipt: async ({ params }) => service.receipts.getReceipt(params.id),
    /** PATCH /receipts/{id}: Record counted, damaged, bin and photos per line (save and finish later) */
    updateReceipt: async (i) => service.receipts.updateReceipt(i.params.id, i.body, by(i)),
    /** POST /receipts/{id}/submit: Finish counting: shortages go to Purchasing, units wait in Incoming for Inventory to confirm */
    submitReceipt: async (i) => service.receipts.submitReceipt(i.params.id, i.body ?? {}, by(i)),
    /** POST /receipts/{id}/cancel: Discard a receiving record started by mistake */
    cancelReceipt: async (i) => service.receipts.cancelReceipt(i.params.id, i.body, by(i)),
    /** GET /claims: Supplier claims for shortages and damage */
    listClaims: async ({ query, page }) => service.claims.listClaims(query, page),
    /** POST /claims: Open a supplier claim */
    createClaim: async (i) => service.claims.createClaim(i.body, by(i)),
    /** POST /claims/{id}/submit: Mark a claim as sent to the supplier */
    submitClaim: async (i) => service.claims.submitClaim(i.params.id, i.body ?? {}, by(i)),
    /** POST /claims/{id}/settle: Record the supplier's settlement (credit note, refund or replacement) */
    settleClaim: async (i) => service.claims.settleClaim(i.params.id, i.body, by(i)),
    /** POST /claims/{id}/close: Close a claim as rejected by the supplier or withdrawn */
    closeClaim: async (i) => service.claims.closeClaim(i.params.id, i.body, by(i)),
  });
