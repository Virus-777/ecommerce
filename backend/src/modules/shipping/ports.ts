/**
 * What the shipping service needs from the outside world, database-agnostic.
 * The Postgres adapter lives in infra/postgres/; a MongoDB switch would add infra/mongo/.
 */

/** Persistence for this module's own tables: shipping.carriers, shipping.carrier_services, shipping.methods, shipping.zones, shipping.profiles, shipping.seller_settings, shipping.closures, shipping.dispatch_targets, shipping.notices, shipping.free_shipping_rules, shipping.shipments, shipping.shipment_lines, shipping.tracking_events, shipping.tracking_corrections, shipping.labels, shipping.label_quotes, shipping.dispatch_watch, shipping.exceptions, shipping.exception_log, shipping.claims, shipping.webhook_events. */
export interface ShippingRepository {}
