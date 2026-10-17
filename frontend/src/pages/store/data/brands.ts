import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query';
import { call, useApi } from '@marketly/web-shared/api';

// All brands (store/brands): GET /api/store/catalog/brands, active brands only. Read in cursor batches with
// a "Show more" button, so the website and the phone app page the same way.

export type BrandSort = 'name' | 'popular';

export const BRANDS_PER_BATCH = 48;

export function useAllBrands(q: string, sort: BrandSort) {
  const { api } = useApi();
  const query = { ...(q ? { q } : {}), sort, limit: BRANDS_PER_BATCH };
  return useInfiniteQuery({
    queryKey: ['catalog', 'brands', 'all', query],
    queryFn: ({ pageParam }) => call(api.GET('/api/store/catalog/brands', { params: { query: { ...query, ...(pageParam ? { cursor: pageParam } : {}) } } })),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor ?? null,
    // keep the current grid on screen while a new search loads
    placeholderData: keepPreviousData,
  });
}
