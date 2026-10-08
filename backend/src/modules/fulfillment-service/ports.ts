/**
 * What the fulfillment-service service needs from the outside world, database-agnostic.
 * The Postgres adapter lives in infra/postgres/; a MongoDB switch would add infra/mongo/.
 */

/** Persistence for this module's own tables: fulfillment_service.enrollments, fulfillment_service.sku_enrollments, fulfillment_service.inbound_shipments, fulfillment_service.inbound_lines, fulfillment_service.discrepancies, fulfillment_service.ownership_ledger, fulfillment_service.fulfillment_requests, fulfillment_service.service_returns, fulfillment_service.removal_orders, fulfillment_service.fee_schedules, fulfillment_service.fee_charges, fulfillment_service.storage_snapshots. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface FulfillmentServiceRepository {}
