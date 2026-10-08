/**
 * What the purchasing service needs from the outside world, database-agnostic.
 * The Postgres adapter lives in infra/postgres/; a MongoDB switch would add infra/mongo/.
 */

/** Persistence for this module's own tables: purchasing.suppliers, purchasing.supplier_items, purchasing.supplier_performance, purchasing.purchase_orders, purchasing.purchase_order_lines, purchasing.purchase_order_events, purchasing.deliveries, purchasing.receipts, purchasing.receipt_lines, purchasing.supplier_claims. */
export interface PurchasingRepository {}
