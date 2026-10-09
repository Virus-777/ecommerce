/**
 * Search types the spec's publicApi names but does not define (SearchQuery, SearchMatch, SponsoredSlot,
 * PageInfo: typed `unknown` in src/spec/search.ts). Defined here from the spec text: the REST query
 * parameters of GET /products, the GraphQL SearchFilterInput, SearchMatch and SearchSponsoredSlot.
 */

export type SortKey = 'recommended' | 'price_asc' | 'price_desc' | 'newest' | 'rating' | 'best_selling';
export const SORT_KEYS: readonly SortKey[] = ['recommended', 'price_asc', 'price_desc', 'newest', 'rating', 'best_selling'];

export type ConditionGroup = 'new' | 'used' | 'refurbished';
export const CONDITION_GROUPS: readonly ConditionGroup[] = ['new', 'used', 'refurbished'];

/** Filters: the same meaning as the REST query parameters and GraphQL SearchFilterInput */
export interface SearchFilters {
  /** Category ids (GraphQL); REST `category` is a slug, resolved to its id */
  categoryIds?: string[];
  /** Category slug (REST `category`) */
  categorySlug?: string;
  /** Minor units */
  priceMin?: number;
  priceMax?: number;
  brandIds?: string[];
  /** REST `brand`: brand slugs (ids are accepted too) */
  brandSlugs?: string[];
  sellerIds?: string[];
  /** REST `seller`: seller slugs ('official' is the Official Store) */
  sellerSlugs?: string[];
  /** Official Store offers only */
  official?: boolean;
  /** 1–5: 'N stars and up' */
  minRating?: number;
  conditions?: ConditionGroup[];
  /** Default true (setting excludeOutOfStockByDefault): in stock now */
  inStockOnly?: boolean;
  freeDelivery?: boolean;
  shipsToday?: boolean;
  /** YYYY-MM-DD */
  arrivesBy?: string;
  onSale?: boolean;
  /** New arrivals */
  listedWithinDays?: number;
  /** Category attribute filters, e.g. noise_cancelling = [active] */
  attributes?: { key: string; values: string[] }[];
}

/** What to search: free text (optional: without it this is a listing), filters and sort */
export interface SearchQuery {
  q?: string | null;
  filters?: SearchFilters;
  sort?: SortKey;
}

/** Per-result context: the variant and offer the card shows for the active filters (GraphQL SearchMatch) */
export interface SearchMatch {
  /** 1-based position among organic results */
  position: number;
  variantId: string | null;
  variantCue: string | null;
  /** The offer whose price the card shows */
  offerId: string | null;
  priceIsFrom: boolean;
  badges: string[];
}

/** Placeholder for sponsored content; advertising decides what fills it (GraphQL SearchSponsoredSlot) */
export interface SponsoredSlot {
  /** Advertising placement key: search_top_row, category_inline, category_banner */
  placement: string;
  kind: 'top_row' | 'inline' | 'banner';
  /** Inline only: 1-based grid positions where a labelled sponsored card may be inserted */
  positions: number[];
  maxItems: number;
}

/** Paging of a result list (the Paged fields of SearchResults) */
export interface PageInfo {
  nextCursor: string | null;
  page?: number;
  totalPages?: number;
  total?: number;
}

/** What runSearch, listCategoryProducts and listSellerProducts answer */
export interface SearchResultSet {
  context: import('../../../spec/search.js').SearchContext;
  items: { productId: string; match: SearchMatch }[];
  sponsoredSlots: SponsoredSlot[];
  page: PageInfo;
}

/** Who is searching: for recent searches, query logs and sponsored requests */
export interface SearchSession {
  customerId?: string;
  guestSessionId?: string;
  /** Query log session key (the token's session) */
  sessionKey?: string;
}
