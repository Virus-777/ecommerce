/**
 * What the checkout service needs from the outside world, database-agnostic.
 * The Postgres adapter lives in infra/postgres/; a MongoDB switch would add infra/mongo/.
 */

/** Persistence for this module's own tables: checkout.sessions, checkout.session_lines, checkout.session_packages, checkout.change_sets, checkout.place_requests, checkout.session_log. */
export interface CheckoutRepository {}
