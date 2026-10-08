/**
 * What the search service needs from the outside world, database-agnostic.
 * The Postgres adapter lives in infra/postgres/; a MongoDB switch would add infra/mongo/.
 */

/** Persistence for this module's own tables: search.search_documents, search.search_offers, search.suggestion_terms, search.synonyms, search.recent_searches, search.query_log, search.click_log, search.dirty_documents, search.reindex_jobs, search.ranking_policies. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface SearchRepository {}
