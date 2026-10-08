/**
 * What the orders service needs from the outside world, database-agnostic.
 * The Postgres adapter lives in infra/postgres/; a MongoDB switch would add infra/mongo/.
 */

/** Persistence for this module's own tables: orders.orders, orders.seller_groups, orders.order_items, orders.item_state_log, orders.cancellations, orders.shipment_refs, orders.timeline, orders.notes, orders.documents, orders.saved_filters, orders.ref_sequences. */
export interface OrdersRepository {}
