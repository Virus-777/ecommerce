/**
 * What the sellers service needs from the outside world, database-agnostic.
 * The Postgres adapter lives in infra/postgres/; a MongoDB switch would add infra/mongo/.
 */

/** Persistence for this module's own tables: sellers.sellers, sellers.applications, sellers.application_documents, sellers.verification_checks, sellers.information_requests, sellers.risk_reviews, sellers.agreement_acceptances, sellers.store_profiles, sellers.featured_collections, sellers.public_claims, sellers.change_requests, sellers.members, sellers.performance_events, sellers.performance_snapshots, sellers.performance_targets, sellers.warnings, sellers.restrictions, sellers.suspensions, sellers.appeals, sellers.seller_notes, sellers.account_events, sellers.seller_invitations. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface SellersRepository {}
