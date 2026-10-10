/**
 * What the search service needs from the outside world, database-agnostic.
 * The Postgres adapters live in infra/postgres/: the repository (this module's own tables) and the search
 * engine (full-text + trigram queries over the index). An external engine (OpenSearch, Meilisearch) would
 * implement SearchEngine behind the same port (setting searchEngine).
 */
import type { Json } from '../../kernel/db/types.js';
import type { SearchDb } from '../../spec/search.js';
import type { ConditionGroup, SortKey } from './domain/types.js';
import type { RankingFactorKey } from './domain/ranking.js';

export type DocRow = SearchDb['search_documents'];
export type OfferRow = SearchDb['search_offers'];
export type TermRow = SearchDb['suggestion_terms'];
export type SynonymRow = SearchDb['synonyms'];
export type RecentRow = SearchDb['recent_searches'];
export type QueryLogRow = SearchDb['query_log'];
export type ReindexJobRow = SearchDb['reindex_jobs'];
export type PolicyRow = SearchDb['ranking_policies'];
export type TermKind = TermRow['kind'];

/** Texts the full-text vector is built from: title A, brand A, category B, attributes C, description D */
export interface DocTexts {
  title: string;
  brand: string;
  category: string;
  attributes: string;
  description: string;
}

/** A document as the indexer writes it (tsv, version and indexed_at are set by the repository) */
export type DocWrite = Omit<DocRow, 'tsv' | 'version' | 'indexed_at'> & { texts: DocTexts };

export interface SearchRepository {
  transaction<T>(fn: (tx: SearchRepository) => Promise<T>): Promise<T>;
  /** Claims a key in the inbox (ctx.inbox) within this repository's transaction; false when it was already handled */
  claim(key: string): Promise<boolean>;

  /* documents and offer rows */
  getDocument(productId: string): Promise<DocRow | undefined>;
  getDocuments(productIds: string[]): Promise<DocRow[]>;
  /** Insert or replace a document; `offers` replaces its offer rows (null keeps them) */
  upsertDocument(doc: DocWrite, offers: OfferRow[] | null, at: Date): Promise<void>;
  deleteDocument(productId: string): Promise<void>;
  updateDocument(productId: string, patch: Partial<Omit<DocRow, 'product_id' | 'tsv'>>, at: Date): Promise<void>;
  offerRows(productIds: string[]): Promise<OfferRow[]>;
  offerRow(offerId: string): Promise<OfferRow | undefined>;
  upsertOfferRow(row: OfferRow): Promise<void>;
  updateOfferRow(offerId: string, patch: Partial<Omit<OfferRow, 'offer_id' | 'product_id'>>): Promise<void>;
  deleteOfferRow(offerId: string): Promise<void>;
  documentIds(filter: { categoryIds?: string[]; brandIds?: string[]; sellerIds?: string[]; onSale?: boolean; productIds?: string[] }): Promise<string[]>;
  productIdsForOffers(offerIds: string[]): Promise<string[]>;
  productIdForVariant(variantId: string): Promise<string | undefined>;
  productIdsByGtin(gtin: string): Promise<DocRow[]>;
  documentStats(): Promise<{ documents: number; offerRows: number; lastIndexedAt: Date | null }>;

  /* best sellers and popularity */
  /**
   * Adds (sign 1) or subtracts (sign -1) an order's units per product on its market day in product_sales_daily
   * (never below 0), and moves the documents' live counts the same way until the nightly job recomputes them.
   */
  recordSales(day: string, units: { productId: string; units: number }[], sign: 1 | -1, at: Date): Promise<void>;
  /** sales_30d (and popularity) = units of the last 30 market days from product_sales_daily, `from` inclusive */
  sumSales(from: string): Promise<void>;
  /** Deletes daily rows before `before` (exclusive) */
  pruneSales(before: string): Promise<void>;
  platformUnits30d(): Promise<number>;
  rankBestSellers(top: number, enabled: boolean): Promise<void>;
  bestSellerRows(productIds: string[]): Promise<DocRow[]>;

  /* dirty documents */
  markDirty(productIds: string[], reason: string, at: Date): Promise<void>;
  takeDirty(limit: number): Promise<{ product_id: string; reason: string; queued_at: Date }[]>;
  clearDirty(productId: string, queuedAt: Date): Promise<void>;
  dirtyStats(): Promise<{ count: number; oldest: Date | null }>;

  /* suggestion terms */
  upsertTerm(kind: TermKind, targetId: string | null, term: string, weight: number, at: Date): Promise<void>;
  deleteTerms(kind: TermKind, targetIds: string[]): Promise<void>;
  replaceTerms(kind: TermKind, rows: { term: string; targetId: string | null; weight: number }[], at: Date): Promise<void>;
  terms(kind: TermKind, targetIds?: string[]): Promise<TermRow[]>;

  /* synonyms */
  listSynonyms(filter: { q?: string; active?: boolean }): Promise<SynonymRow[]>;
  getSynonym(id: string): Promise<SynonymRow | undefined>;
  insertSynonym(row: SynonymRow): Promise<SynonymRow>;
  updateSynonym(id: string, patch: Partial<Omit<SynonymRow, 'id'>>): Promise<SynonymRow>;
  deleteSynonym(id: string): Promise<void>;
  activeSynonyms(): Promise<SynonymRow[]>;

  /* recent searches */
  recentSearches(owner: { kind: 'customer' | 'guest'; id: string }, limit: number): Promise<RecentRow[]>;
  saveRecentSearch(row: RecentRow, max: number): Promise<void>;
  deleteRecentSearch(owner: { kind: 'customer' | 'guest'; id: string }, id: string): Promise<boolean>;
  clearRecentSearches(owner: { kind: 'customer' | 'guest'; id: string }): Promise<number>;
  moveRecentSearches(from: { kind: 'customer' | 'guest'; id: string }, to: { kind: 'customer' | 'guest'; id: string }, max: number): Promise<number>;
  pruneRecentSearches(before: Date): Promise<number>;

  /* logs */
  logQuery(row: QueryLogRow): Promise<void>;
  logClick(row: SearchDb['click_log']): Promise<void>;
  searchLogged(searchId: string): Promise<boolean>;
  zeroResults(from: Date, to: Date): Promise<{ query: string; normalized: string; count: number; lastAt: Date; lastFilters: Json | null; correctionOffered: boolean }[]>;
  popularQueries(since: Date, limit: number): Promise<{ normalized: string; count: number }[]>;
  pruneLogs(before: Date): Promise<{ queries: number; clicks: number }>;

  /* reindex jobs */
  insertJob(row: ReindexJobRow): Promise<ReindexJobRow>;
  getJob(id: string): Promise<ReindexJobRow | undefined>;
  updateJob(id: string, patch: Partial<Omit<ReindexJobRow, 'id'>>): Promise<ReindexJobRow>;
  activeFullJob(): Promise<ReindexJobRow | undefined>;
  queuedJobs(): Promise<ReindexJobRow[]>;
  lastCompletedFullJob(): Promise<ReindexJobRow | undefined>;

  /* ranking policies */
  currentPolicy(at: Date): Promise<PolicyRow | undefined>;
  latestPolicyVersion(): Promise<number>;
  insertPolicy(row: PolicyRow): Promise<PolicyRow>;
}

/* ------------------------------------------------------------------ search engine port */

/** Filters with every slug resolved to ids (what the engine filters on) */
export interface EngineFilters {
  categoryIds?: string[];
  brandIds?: string[];
  sellerIds?: string[];
  official?: boolean;
  priceMin?: number;
  priceMax?: number;
  minRating?: number;
  conditions?: ConditionGroup[];
  inStockOnly: boolean;
  freeDelivery?: boolean;
  shipsToday?: boolean;
  /** arrives-by filter as the most dispatch days that still arrive in time */
  maxDispatchDays?: number;
  onSale?: boolean;
  listedSince?: Date;
  attributes?: { key: string; values: string[] }[];
}

export interface EngineQuery {
  /** Full-text groups (all must match; any alternative in a group) and a GTIN; null for listings */
  text: { groups: string[][]; gtin: string | null } | null;
  filters: EngineFilters;
  /** Restrict to / leave out products */
  productIds?: string[];
  excludeProductIds?: string[];
  /** Market wall-clock time HH:mm, for same-day dispatch cutoffs */
  marketTime: string;
}

/** Which filter to leave out when counting a facet ("counts are computed against the other active filters") */
export type FacetOmit = 'category' | 'brand' | 'seller' | 'price' | 'rating' | 'condition' | 'availability' | 'delivery' | `attr:${string}`;

export interface EngineHit {
  doc: DocRow;
  score: number;
  /** Weighted contribution of each ranking factor (recommended sort), for explain */
  factors: Record<RankingFactorKey | 'gtin', number>;
  /** The offer the card shows (featured, or the matching offer under offer filters) */
  offer: { offerId: string; variantId: string; sellerId: string | null; official: boolean; condition: string; price: number; inStock: boolean; freeDelivery: boolean; dispatchDays: number; matching: number } | null;
}

export interface FacetCounts {
  categories: Map<string, number>;
  brands: { id: string; name: string; count: number }[];
  sellers: Map<string, number>;
  official: number;
  conditions: Map<string, number>;
  ratings: Map<number, number>;
  inStock: number;
  includingOutOfStock: number;
  freeDelivery: number;
  shipsToday: number;
  price: { min: number | null; max: number | null };
  attributes: Map<string, Map<string, number>>;
}

export interface SearchEngine {
  /** e.g. postgres-fts */
  readonly name: string;
  search(q: EngineQuery, sort: SortKey, weights: Record<RankingFactorKey, number>, window: { offset: number; limit: number }): Promise<{ hits: EngineHit[]; total: number }>;
  count(q: EngineQuery): Promise<number>;
  /** Total, distinct sellers and whether the Official Store is among them */
  summary(q: EngineQuery): Promise<{ total: number; sellers: number; official: boolean }>;
  facets(q: EngineQuery, attributeKeys: string[]): Promise<FacetCounts>;
  /** Most similar known word (titles, brands, categories, popular queries) above the threshold, null when the word is known */
  correctWord(word: string, threshold: number): Promise<string | null>;
  /** Whether a known word (titles, brands, categories, popular queries) starts with this text */
  knownPrefix(prefix: string): Promise<boolean>;
  /** Suggestion terms of a kind by prefix or trigram similarity */
  suggestTerms(kind: TermKind, prefix: string, threshold: number, limit: number): Promise<TermRow[]>;
  /** Products by title prefix or similarity (suggestions while typing) */
  suggestProducts(prefix: string, threshold: number, limit: number): Promise<DocRow[]>;
  /** Categories with the most products matching the prefix */
  categoriesForPrefix(prefix: string, limit: number): Promise<{ categoryId: string; count: number }[]>;
  /** Similar in-stock products: same category first, shared brand and title words */
  similar(productId: string, limit: number): Promise<string[]>;
  /** Live products per category for sellers (storefront chips) */
  sellerCategoryCounts(sellerIds: string[]): Promise<{ sellerId: string; categoryId: string; count: number }[]>;
  /** Live product counts by seller and brand (suggestions, store match) */
  productCountsBySeller(sellerIds: string[]): Promise<Map<string, number>>;
  productCountsByBrand(brandIds: string[]): Promise<Map<string, number>>;
  /** Most popular in-stock products, optionally within categories */
  popular(categoryIds: string[] | null, limit: number): Promise<string[]>;
  /** Admin lookup: listed products by title words or GTIN */
  lookupProducts(q: string, gtin: string | null, limit: number): Promise<DocRow[]>;
  /** best_selling is offered once the platform reaches this many units in 30 days */
  bestSellingAvailable(minOrders: number): Promise<boolean>;
}
