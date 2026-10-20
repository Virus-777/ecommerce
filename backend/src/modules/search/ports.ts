/**
 * Row types the search repository and service share, and the search engine port with its two implementations:
 * mongo-engine.ts (development and tests: stemmed words and prefixes over this module's collections) and
 * providers/opensearch/ (production: its own index, fed from the repository's writes through SearchIndexFeed).
 * The engine is chosen by SEARCH_ENGINE (engine-config.ts); repository.ts is the read model either way.
 */
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

/** Texts a document is searched by: title A, brand A, category B, attributes C, description D */
export interface DocTexts {
  title: string;
  brand: string;
  category: string;
  attributes: string;
  description: string;
}

/** A document as the indexer writes it (terms, version, indexed_at and the embedded offers are set by the repository) */
export type DocWrite = Omit<DocRow, 'terms' | 'version' | 'indexed_at' | 'offers'> & { texts: DocTexts };

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

/** A document as an engine with its own index stores it: the read-model row, its offer rows and (for a full write) the searchable texts */
export interface IndexedDocument {
  doc: DocRow;
  offers: OfferRow[];
  /** Present when the document was (re)built from the source modules: the engine replaces the whole document. Absent: every field but the texts is replaced. */
  texts?: DocTexts;
}

/**
 * How an engine that keeps its own index (OpenSearch) is fed. The repository stays the read model; every write
 * to it is passed on after commit (index-feed.ts). The MongoDB engine reads the collections and has no feed.
 */
export interface SearchIndexFeed {
  /** Writes and removes documents; answers the products that could not be written (they are marked dirty and rebuilt) */
  write(upserts: IndexedDocument[], deletes: string[]): Promise<{ failed: string[] }>;
  /** A key when the engine's index needs a full reindex (new and empty, or an older mapping), else null */
  needsRebuild(): Promise<string | null>;
  /** Full reindex: starts a new index; until finishRebuild every write goes to the live index and the new one */
  beginRebuild(): Promise<void>;
  /** ok: the new index becomes the live one atomically (carryOver: products the rebuild could not build, copied from the old index). Not ok: the new index is dropped. */
  finishRebuild(ok: boolean, carryOver: string[]): Promise<void>;
}

export interface SearchEngine {
  /** e.g. mongo-text, opensearch */
  readonly name: string;
  /** Engines with their own index are fed by the indexer; undefined for the MongoDB engine */
  readonly feed?: SearchIndexFeed;
  /** Engine and index state for the index status screen, e.g. 'opensearch (green, index marketly-products-…)'; default: name */
  describe?(): Promise<string>;
  search(q: EngineQuery, sort: SortKey, weights: Record<RankingFactorKey, number>, window: { offset: number; limit: number }): Promise<{ hits: EngineHit[]; total: number }>;
  count(q: EngineQuery): Promise<number>;
  /** Total, distinct sellers and whether the Official Store is among them */
  summary(q: EngineQuery): Promise<{ total: number; sellers: number; official: boolean }>;
  facets(q: EngineQuery, attributeKeys: string[]): Promise<FacetCounts>;
  /**
   * For each price range (minor units, null = open), how many results the query gives with that range as its price
   * filter (its own price filter left out). Optional: without it the service counts each range with count().
   */
  priceRangeCounts?(q: EngineQuery, ranges: readonly { min: number | null; max: number | null }[]): Promise<number[]>;
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
