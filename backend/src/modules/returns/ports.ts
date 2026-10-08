/**
 * What the returns service needs from the outside world, database-agnostic.
 * The Postgres adapter lives in infra/postgres/; a MongoDB switch would add infra/mongo/.
 */

/** Persistence for this module's own tables: returns.policy_versions, returns.category_exceptions, returns.seller_terms, returns.returns, returns.return_items, returns.return_shipments, returns.inspection_drafts, returns.return_evidence, returns.inspections, returns.refund_requests, returns.replacements, returns.return_events. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ReturnsRepository {}
