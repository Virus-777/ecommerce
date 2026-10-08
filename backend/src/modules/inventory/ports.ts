/**
 * What the inventory service needs from the outside world, database-agnostic.
 * The Postgres adapter lives in infra/postgres/; a MongoDB switch would add infra/mongo/.
 */

/** Persistence for this module's own tables: inventory.locations, inventory.stock_items, inventory.stock_levels, inventory.stock_movements, inventory.incoming_expectations, inventory.reservations, inventory.reservation_lines, inventory.adjustments, inventory.held_stock, inventory.inbound_receipts, inventory.inbound_lines, inventory.return_outcomes, inventory.discrepancies, inventory.transfers, inventory.transfer_lines, inventory.stock_counts, inventory.count_lines. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface InventoryRepository {}
