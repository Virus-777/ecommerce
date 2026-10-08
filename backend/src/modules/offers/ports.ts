/**
 * What the offers service needs from the outside world, database-agnostic.
 * The Postgres adapter lives in infra/postgres/; a MongoDB switch would add infra/mongo/.
 */

/** Persistence for this module's own tables: offers.offers, offers.offer_price_history, offers.price_changes, offers.offer_status_log, offers.offer_eligibility, offers.featured_offers, offers.featured_rules, offers.bulk_update_jobs, offers.bulk_update_rows. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface OffersRepository {}
