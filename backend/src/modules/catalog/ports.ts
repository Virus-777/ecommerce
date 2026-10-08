/**
 * What the catalog service needs from the outside world, database-agnostic.
 * The Postgres adapter lives in infra/postgres/; a MongoDB switch would add infra/mongo/.
 */

/** Persistence for this module's own tables: catalog.categories, catalog.attributes, catalog.image_standards, catalog.brands, catalog.products, catalog.variants, catalog.review_log, catalog.correction_suggestions, catalog.submissions, catalog.submission_checks, catalog.review_drafts, catalog.brand_authorized_sellers, catalog.offer_index, catalog.listing_stats, catalog.category_stats, catalog.brand_stats. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface CatalogRepository {}
