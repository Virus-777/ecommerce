import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { call, useApi, type components, type paths } from '@marketly/web-shared/api';
import { useIsPhone } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import type { IconName } from '@marketly/web-shared/ui';
import type { MediaRef } from './catalog';

// Search reads shared by the store browse screens (Search, Category, Brand, Seller, Official, Home,
// Deals, Collection): product cards, the listing query in the URL, paged/infinite listings, facets.

type S = components['schemas'];
export type SearchCard = S['search.ProductCard'];
export type SearchHit = S['search.SearchHit'];
export type SearchContext = S['search.SearchContext'];
export type Facet = S['search.Facet'];
export type ProductTile = S['content.ProductTile'];
export type Money = S['Money'];
export type SearchQuery = NonNullable<paths['/api/store/search/products']['get']['parameters']['query']>;
export type SortKey = S['search.SortOption']['key'];

/** What a store product card shows (the design's .pcard), mapped from any API product shape. */
export interface StoreCard {
  id: string;
  /** Cosmetic slug for the product route (/p/:slug/:id); products resolve by id. */
  slug: string;
  title: string;
  image: MediaRef | null;
  /** Placeholder icon when there is no image. */
  icon: IconName;
  tint: string;
  price: Money | null;
  was: Money | null;
  /** "from" prefix: the price is the lowest of several offers. */
  from: boolean;
  rating: number | null;
  ratingCount: number;
  /** Delivery cue without the "Arrives " prefix, e.g. "Mon, Oct 19". */
  delivery: string | null;
  free: boolean;
  seller: { name: string; official: boolean; slug?: string | null } | null;
  sponsored?: boolean;
  /** Position in a search result list (search click reporting). */
  position?: number;
  /** Sponsored hits: the advertising token sent with the display and click events. */
  impressionToken?: string | null;
  availability?: 'in_stock' | 'low_stock' | 'out_of_stock' | null;
  /** The offer the card shows (its price and seller): what the card's add-to-cart button adds. */
  offerId?: string | null;
}

export const productHref = (p: { id: string; slug?: string | null }, view = '') => href('store/product', view, { slug: p.slug || 'product', id: p.id });

/** The date part of a delivery cue ("Free delivery Mon, Oct 26" → "Mon, Oct 26"): the card adds its own label. */
const cue = (s?: string | null) => (s ? s.replace(/^(Arrives|Free delivery)\s+/i, '') : null);

/** A search product card (search results, /search/cards, similar products, empty-result popular items). */
export function toCardProduct(c: SearchCard, hit?: Pick<SearchHit, 'kind' | 'position' | 'sponsored'>): StoreCard {
  return {
    id: c.productId,
    slug: c.slug,
    title: c.title,
    image: c.image ?? null,
    icon: 'package',
    tint: '1',
    price: c.price,
    was: c.wasPrice ?? null,
    from: c.priceIsFrom || c.offerCount > 1,
    rating: c.rating ?? null,
    ratingCount: c.ratingCount,
    delivery: cue(c.deliveryCue),
    free: c.freeDelivery,
    seller: { name: c.sellerName, official: c.official, slug: c.sellerSlug },
    sponsored: hit?.kind === 'sponsored',
    position: hit?.position,
    impressionToken: hit?.sponsored?.impressionToken ?? null,
    availability: c.availability,
    offerId: c.offerId ?? null,
  };
}

/**
 * A content product tile (homepage sections, collection pages). Tiles carry no delivery cue or offer
 * count: pass the matching /search/cards card to fill them in (useProductCards).
 */
export function tileToCard(t: ProductTile, card?: SearchCard): StoreCard {
  return {
    id: t.productId,
    slug: t.slug ?? card?.slug ?? '',
    title: t.title,
    image: t.image ?? card?.image ?? null,
    icon: 'package',
    tint: '1',
    price: t.price ?? card?.price ?? null,
    was: t.wasPrice ?? (t.price ? null : (card?.wasPrice ?? null)),
    from: t.fromPrice || (card?.offerCount ?? 1) > 1,
    rating: t.rating ?? card?.rating ?? null,
    ratingCount: t.ratingCount ?? card?.ratingCount ?? 0,
    delivery: cue(card?.deliveryCue),
    free: card?.freeDelivery ?? false,
    seller: t.sellerName
      ? { name: t.sellerName, official: t.officialStore, slug: card?.sellerName === t.sellerName ? card.sellerSlug : null }
      : card
        ? { name: card.sellerName, official: card.official, slug: card.sellerSlug }
        : null,
    availability: t.availability ?? card?.availability ?? null,
    offerId: t.offerId ?? card?.offerId ?? null,
  };
}

/** Product cards for a list of product ids (fills in delivery cues, offer counts and seller slugs for tiles and deals). */
export function useProductCards(ids: string[]) {
  const { api } = useApi();
  const unique = [...new Set(ids)].sort();
  return useQuery({
    queryKey: ['search', 'cards', unique],
    queryFn: async () => {
      const cards = await call(api.GET('/api/store/search/cards', { params: { query: { ids: unique } } }));
      return new Map(cards.map((c) => [c.productId, c]));
    },
    enabled: unique.length > 0,
  });
}

/* ---------------- The listing query in the page URL ---------------- */

// The page URL carries the REST search parameters as they are (docs/api search: q, exact, category,
// brand[], priceMin, priceMax, rating, seller[], condition[], availability, delivery[], arrivesBy,
// attrs, onSale, sort), so the server's `removeQuery` / `clearAllQuery` strings work as links.
const MULTI = ['brand', 'seller', 'condition', 'delivery'] as const;
const INTS = ['priceMin', 'priceMax', 'rating', 'listedWithinDays'] as const;
const BOOLS = ['exact', 'onSale'] as const;
const STRS = ['q', 'category', 'availability', 'arrivesBy', 'attrs', 'sort'] as const;
/** Parameters that are listing filters (cleared by "Clear all"); q, exact, sort and page are not. */
export const FILTER_PARAMS = ['category', 'brand', 'seller', 'condition', 'delivery', 'priceMin', 'priceMax', 'rating', 'availability', 'arrivesBy', 'attrs', 'onSale'];

export function readQuery(params: URLSearchParams, fixed: Partial<SearchQuery> = {}): SearchQuery {
  const q: Record<string, unknown> = {};
  for (const k of MULTI) {
    const v = params.getAll(k).filter(Boolean);
    if (v.length) q[k] = v;
  }
  for (const k of INTS) {
    const n = Number(params.get(k));
    if (params.get(k) && Number.isFinite(n)) q[k] = Math.round(n);
  }
  for (const k of BOOLS) if (params.get(k) === 'true') q[k] = true;
  for (const k of STRS) {
    const v = params.get(k)?.trim();
    if (v) q[k] = v;
  }
  return { ...(q as SearchQuery), ...fixed };
}

/** 1-based page from the URL (website numbered pages). */
export const readPage = (params: URLSearchParams) => Math.max(1, Number(params.get('page')) || 1);

/** A copy of the params without the page (any filter or sort change starts again at page 1). */
export function withoutPage(params: URLSearchParams): URLSearchParams {
  const p = new URLSearchParams(params);
  p.delete('page');
  return p;
}

/**
 * Applies a server query string (`removeQuery`, `clearAllQuery`) to the page URL: keeps `view`,
 * drops the parameters the route already carries (e.g. `category` on /c/:slug).
 */
export function fromServerQuery(qs: string, current: URLSearchParams, routeParams: string[] = []): URLSearchParams {
  const next = new URLSearchParams(qs);
  for (const k of routeParams) next.delete(k);
  const view = current.get('view');
  if (view) next.set('view', view);
  return next;
}

/* ---------------- Listings: website pages, phone infinite scroll ---------------- */

export interface Listing {
  hits: SearchHit[];
  /** From the paged response (website); on the phone use the facets' total. */
  total: number | null;
  totalPages: number;
  page: number;
  phone: boolean;
  isPending: boolean;
  isFetching: boolean;
  error: unknown;
  refetch: () => void;
  hasMore: boolean;
  loadMore: () => void;
  loadingMore: boolean;
}

/** Search products for a listing: `page` on the website, `cursor` + Load more on the phone (API.md rule 9). */
export function useListing(query: SearchQuery, page: number, { limit = 24, enabled = true }: { limit?: number; enabled?: boolean } = {}): Listing {
  const { api } = useApi();
  const phone = useIsPhone();
  const web = useQuery({
    queryKey: ['search', 'products', query, { page, limit }],
    queryFn: () => call(api.GET('/api/store/search/products', { params: { query: { ...query, page, limit } } })),
    enabled: enabled && !phone,
    placeholderData: keepPreviousData,
  });
  const app = useInfiniteQuery({
    queryKey: ['search', 'products', query, { cursor: true, limit }],
    queryFn: ({ pageParam }) => call(api.GET('/api/store/search/products', { params: { query: { ...query, limit, ...(pageParam ? { cursor: pageParam } : {}) } } })),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor ?? null,
    enabled: enabled && phone,
  });
  if (phone) {
    const first = app.data?.pages[0];
    return {
      hits: app.data?.pages.flatMap((p) => p.items) ?? [],
      total: first?.total ?? null,
      totalPages: 1,
      page: 1,
      phone,
      isPending: app.isPending && enabled,
      isFetching: app.isFetching,
      error: app.error,
      refetch: () => void app.refetch(),
      hasMore: !!app.hasNextPage,
      loadMore: () => void (app.hasNextPage && !app.isFetchingNextPage && app.fetchNextPage()),
      loadingMore: app.isFetchingNextPage,
    };
  }
  return {
    hits: web.data?.items ?? [],
    total: web.data?.total ?? null,
    totalPages: Math.max(1, web.data?.totalPages ?? 1),
    page,
    phone,
    isPending: web.isPending && enabled,
    isFetching: web.isFetching,
    error: web.error,
    refetch: () => void web.refetch(),
    hasMore: false,
    loadMore: () => undefined,
    loadingMore: false,
  };
}

/** Facets, applied filters, sorts, totals, store match, category context and empty guidance for a listing query. */
export function useFacets(query: SearchQuery, { enabled = true }: { enabled?: boolean } = {}) {
  const { api } = useApi();
  return useQuery({
    queryKey: ['search', 'facets', query],
    queryFn: () => call(api.GET('/api/store/search/facets', { params: { query } })),
    enabled,
    placeholderData: keepPreviousData,
  });
}

/** Records which result was opened (relevance and reports). Fire and forget. */
export function useSearchClick(searchId: string | null | undefined) {
  const { api } = useApi();
  return (c: StoreCard) => {
    if (!searchId || c.position === undefined) return;
    void api.POST('/api/store/search/searches/{searchId}/clicks', { params: { path: { searchId } }, body: { productId: c.id, position: c.position, sponsored: !!c.sponsored } }).catch(() => undefined);
  };
}

/** "Showing a–b of N" for the website pager. */
export function shownRange(page: number, perPage: number, count: number, total: number) {
  if (!total || !count) return { from: 0, to: 0 };
  const from = (page - 1) * perPage + 1;
  return { from, to: Math.min(from + count - 1, total) };
}
