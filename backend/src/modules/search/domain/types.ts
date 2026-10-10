/**
 * Search types. SearchQuery, SearchFilters, SearchMatch and SponsoredSlot are spec types (src/spec/search.ts) and
 * PageInfo is common; they are re-exported here next to the module-only shapes (sort keys, result set, session).
 */
import type { PageInfo } from '../../../spec/common.js';
import type { SearchContext, SearchMatch, SponsoredSlot } from '../../../spec/search.js';

export type { PageInfo } from '../../../spec/common.js';
export type { AttributeFilter, SearchFilters, SearchMatch, SearchQuery, SponsoredSlot } from '../../../spec/search.js';

export type SortKey = 'recommended' | 'price_asc' | 'price_desc' | 'newest' | 'rating' | 'best_selling';
export const SORT_KEYS: readonly SortKey[] = ['recommended', 'price_asc', 'price_desc', 'newest', 'rating', 'best_selling'];

export type ConditionGroup = 'new' | 'used' | 'refurbished';
export const CONDITION_GROUPS: readonly ConditionGroup[] = ['new', 'used', 'refurbished'];

/** What runSearch, listCategoryProducts and listSellerProducts answer */
export interface SearchResultSet {
  context: SearchContext;
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
