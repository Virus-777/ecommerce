/**
 * What the warehouse service needs from the outside world, database-agnostic.
 * The Postgres adapter lives in infra/postgres/; a MongoDB switch would add infra/mongo/.
 */

/** Persistence for this module's own tables: warehouse.bins, warehouse.bin_assignments, warehouse.fulfillments, warehouse.fulfillment_lines, warehouse.waves, warehouse.scan_log, warehouse.box_types, warehouse.packages, warehouse.package_items, warehouse.putaway_tasks, warehouse.return_parcels. */
export interface WarehouseRepository {}
