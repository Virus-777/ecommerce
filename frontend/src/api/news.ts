import { useEffect, useSyncExternalStore } from 'react';
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { call, useApi, type components } from '@marketly/web-shared/api';
import { useIsPhone } from '@marketly/web-shared/lib/hooks';

// News (store/news, store/news-post, the home "Latest news" section, the Account tab's News item), designed in
// docs/06-news.md §5. Data: GET /api/store/content/news (pinned first, then newest; website `page`, phone
// `cursor`, API.md rule 9), /news/categories (the filter chips), /news/summary (the "new" dot) and /news/{slug}.
// The "new" dot compares the newest publish time with the last one this device showed, kept in localStorage.

export type NewsCard = components['schemas']['content.NewsCard'];
export type NewsPost = components['schemas']['content.NewsPost'];
/** Cards per website page and per phone batch (a 3-column grid fills evenly). */
export const NEWS_PER_PAGE = 12;

export interface NewsList {
  items: NewsCard[];
  total: number | null;
  page: number;
  totalPages: number;
  phone: boolean;
  isPending: boolean;
  isFetching: boolean;
  error: unknown;
  refetch: () => void;
  hasMore: boolean;
  loadMore: () => void;
  loadingMore: boolean;
}

/** The news list of one category (null = all): numbered pages on the website, cursor batches on the phone. */
export function useNewsList(category: string | null, page: number): NewsList {
  const { api } = useApi();
  const phone = useIsPhone();
  const base = { ...(category ? { category } : {}), limit: NEWS_PER_PAGE };
  const web = useQuery({
    queryKey: ['content', 'news', 'list', { ...base, page }],
    queryFn: () => call(api.GET('/api/store/content/news', { params: { query: { ...base, page } } })),
    enabled: !phone,
    placeholderData: keepPreviousData,
  });
  const app = useInfiniteQuery({
    queryKey: ['content', 'news', 'list', { ...base, cursor: true }],
    queryFn: ({ pageParam }) => call(api.GET('/api/store/content/news', { params: { query: { ...base, ...(pageParam ? { cursor: pageParam } : {}) } } })),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor ?? null,
    enabled: phone,
  });
  if (phone) {
    return {
      items: app.data?.pages.flatMap((p) => p.items) ?? [],
      total: app.data?.pages[0]?.total ?? null,
      page: 1,
      totalPages: 1,
      phone,
      isPending: app.isPending,
      isFetching: app.isFetching,
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
    isPending: web.isPending,
    isFetching: web.isFetching,
    error: web.error,
    refetch: () => void web.refetch(),
    hasMore: false,
    loadMore: () => undefined,
    loadingMore: false,
  };
}

/** Visible categories with posts, in staff order (the filter chips). */
export function useNewsCategories() {
  const { api } = useApi();
  return useQuery({
    queryKey: ['content', 'news', 'categories'],
    queryFn: () => call(api.GET('/api/store/content/news/categories')),
    staleTime: 5 * 60_000,
  });
}

/** { count, latestPublishedAt } of the listed posts (the "new" dot, without loading the list). */
export function useNewsSummary() {
  const { api } = useApi();
  return useQuery({
    queryKey: ['content', 'news', 'summary'],
    queryFn: () => call(api.GET('/api/store/content/news/summary')),
    staleTime: 5 * 60_000,
  });
}

/** One published post by its slug (an old slug answers the post with its current `slug`; 404 otherwise). */
export function useNewsPost(slug: string) {
  const { api } = useApi();
  return useQuery({
    queryKey: ['content', 'news', 'post', slug],
    queryFn: () => call(api.GET('/api/store/content/news/{slug}', { params: { path: { slug } } })),
    enabled: !!slug,
  });
}

/* ---------------- "new" dot: last seen publish time on this device ---------------- */

const SEEN_KEY = 'marketly.news.lastSeen';
const listeners = new Set<() => void>();

function readSeen(): string | null {
  try {
    return window.localStorage.getItem(SEEN_KEY);
  } catch {
    return null;
  }
}

const time = (iso: string | null | undefined) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? 0 : t;
};

/** Records that the newest of these publish times has been shown (never moves back). */
export function markNewsSeen(publishedAt: Array<string | null | undefined>) {
  const newest = publishedAt.reduce<string | null>((a, b) => (b && time(b) > time(a) ? b : a), null);
  if (!newest || time(newest) <= time(readSeen())) return;
  try {
    window.localStorage.setItem(SEEN_KEY, newest);
  } catch {
    // storage blocked (private window, previews): the dot just stays until storage works
  }
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  const onStorage = (e: StorageEvent) => e.key === SEEN_KEY && l();
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(l);
    window.removeEventListener('storage', onStorage);
  };
}

/** The last publish time this device showed, kept in sync across tabs. */
export function useNewsLastSeen(): string | null {
  return useSyncExternalStore(subscribe, readSeen, () => null);
}

/** Marks the shown posts as seen once they are on screen (the list page, a post). */
export function useMarkNewsSeen(publishedAt: Array<string | null | undefined>) {
  const key = publishedAt.join('|');
  useEffect(() => {
    if (key) markNewsSeen(key.split('|'));
  }, [key]);
}

/** True when there is a post newer than the last one this device showed. */
export function useNewsDot(): boolean {
  const summary = useNewsSummary();
  const seen = useNewsLastSeen();
  const latest = summary.data?.latestPublishedAt;
  return !!latest && (summary.data?.count ?? 0) > 0 && time(latest) > time(seen);
}
