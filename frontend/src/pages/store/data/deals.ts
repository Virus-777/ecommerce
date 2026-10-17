import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { call, useApi, type components } from '@marketly/web-shared/api';
import { useIsPhone } from '@marketly/web-shared/lib/hooks';

// The Deals page's Clearance and Coupons tabs. GET /api/store/promotions/deals answers at most 12
// clearance products and 12 coupons (enough for the "All deals" overview), so the single-type tabs read
// the paged lists instead: GET /api/store/promotions/deals/clearance and /deals/coupons. Same paging as the
// other store lists (API.md rule 9): website page numbers (`page` + Pager), phone lazy-load (`cursor`).

type DealProduct = components['schemas']['promotions.DealProduct'];
type Coupon = components['schemas']['promotions.CouponCard'];

const LIMIT = 24;

export interface DealList<T> {
  items: T[];
  total: number | null;
  page: number;
  totalPages: number;
  phone: boolean;
  isPending: boolean;
  error: unknown;
  refetch: () => void;
  hasMore: boolean;
  loadMore: () => void;
  loadingMore: boolean;
}

/** One paged deal list. Keys start with 'promotions' so clipping a coupon (which invalidates ['promotions']) refreshes it. */
function useDealList<T>(kind: 'clearance' | 'coupons', page: number, enabled: boolean, fetchPage: (q: { page?: number; cursor?: string; limit: number }) => Promise<{ items: T[]; nextCursor?: string | null; page?: number; totalPages?: number; total?: number }>): DealList<T> {
  const phone = useIsPhone();
  const web = useQuery({
    queryKey: ['promotions', 'deals', kind, 'list', { page, limit: LIMIT }],
    queryFn: () => fetchPage({ page, limit: LIMIT }),
    enabled: enabled && !phone,
    placeholderData: keepPreviousData,
  });
  const app = useInfiniteQuery({
    queryKey: ['promotions', 'deals', kind, 'list', { cursor: true, limit: LIMIT }],
    queryFn: ({ pageParam }) => fetchPage({ limit: LIMIT, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor ?? null,
    enabled: enabled && phone,
  });
  if (phone) {
    return {
      items: app.data?.pages.flatMap((p) => p.items) ?? [],
      total: app.data?.pages[0]?.total ?? null,
      page: 1,
      totalPages: 1,
      phone,
      isPending: app.isPending && enabled,
      error: app.error,
      refetch: () => void app.refetch(),
      hasMore: !!app.hasNextPage,
      loadMore: () => void (app.hasNextPage && !app.isFetchingNextPage && app.fetchNextPage()),
      loadingMore: app.isFetchingNextPage,
    };
  }
  return {
    items: web.data?.items ?? [],
    total: web.data?.total ?? null,
    page,
    totalPages: Math.max(1, web.data?.totalPages ?? 1),
    phone,
    isPending: web.isPending && enabled,
    error: web.error,
    refetch: () => void web.refetch(),
    hasMore: false,
    loadMore: () => undefined,
    loadingMore: false,
  };
}

/** All clearance products, paged (the Clearance tab). */
export function useClearanceList(page: number, enabled: boolean): DealList<DealProduct> {
  const { api } = useApi();
  return useDealList('clearance', page, enabled, (query) => call(api.GET('/api/store/promotions/deals/clearance', { params: { query } })));
}

/** All clippable coupons, paged (the Coupons tab). */
export function useCouponList(page: number, enabled: boolean): DealList<Coupon> {
  const { api } = useApi();
  return useDealList('coupons', page, enabled, (query) => call(api.GET('/api/store/promotions/deals/coupons', { params: { query } })));
}
