// API access for product reviews (store/reviews and the reviews block of store/product):
// filtered and sorted review lists (page numbers on the website, cursor on the phone), review
// photos, helpful votes and reports. `q` searches headline, text and reviewer name on the server.
// There is no AI review summary (the server is offline).
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
import { call, useApi, type components } from '@marketly/web-shared/api';

export type ApiReview = components['schemas']['reviews.ProductReview'];
export type ReviewMedia = components['schemas']['MediaRef'];

/** A review photo with the review it belongs to (photo strip and viewer). */
export interface ReviewPhoto {
  id: string;
  url: string;
  alt: string;
  review: ApiReview;
  /** 1-based position in its review. */
  n: number;
}

export const photosOf = (list: ApiReview[]): ReviewPhoto[] =>
  list.flatMap((r) => r.media.map((m, i) => ({ id: m.id, url: m.url, alt: m.alt ?? `Photo ${i + 1} from ${r.author.displayName}’s review`, review: r, n: i + 1 })));

export type ReviewSort = 'helpful' | 'recent' | 'highest' | 'lowest';
export const REVIEW_SORTS: Array<{ value: ReviewSort; label: string }> = [
  { value: 'helpful', label: 'Most helpful' },
  { value: 'recent', label: 'Most recent' },
  { value: 'highest', label: 'Highest rating' },
  { value: 'lowest', label: 'Lowest rating' },
];
const API_SORT: Record<ReviewSort, 'most_helpful' | 'newest' | 'highest' | 'lowest'> = {
  helpful: 'most_helpful',
  recent: 'newest',
  highest: 'highest',
  lowest: 'lowest',
};

export interface ReviewFilters {
  rating?: number | null;
  verifiedOnly?: boolean;
  withPhotos?: boolean;
  critical?: boolean;
  variantId?: string | null;
  /** Keyword search on the server (headline, text, reviewer name). */
  q?: string | null;
  sort?: ReviewSort;
}

const toQuery = (f: ReviewFilters) => ({
  rating: f.rating ?? undefined,
  verifiedOnly: f.verifiedOnly || undefined,
  withPhotos: f.withPhotos || undefined,
  critical: f.critical || undefined,
  variantId: f.variantId ?? undefined,
  q: f.q || undefined,
  sort: API_SORT[f.sort ?? 'helpful'],
});

/** One website page of reviews (page numbers). */
export function useReviewPage(productId: string, filters: ReviewFilters, page: number, limit: number, enabled = true) {
  const { api } = useApi();
  const query = toQuery(filters);
  return useQuery({
    queryKey: ['reviews', 'list', productId, query, { page, limit }],
    queryFn: () => call(api.GET('/api/store/reviews/products/{productId}/reviews', { params: { path: { productId }, query: { ...query, page, limit } } })),
    enabled: enabled && !!productId,
    placeholderData: keepPreviousData,
  });
}

/** Reviews for the phone layout: "Load more" with the cursor. */
export function useReviewFeed(productId: string, filters: ReviewFilters, limit: number, enabled = true) {
  const { api } = useApi();
  const query = toQuery(filters);
  return useInfiniteQuery({
    queryKey: ['reviews', 'feed', productId, query, { limit }],
    queryFn: ({ pageParam }) =>
      call(api.GET('/api/store/reviews/products/{productId}/reviews', { params: { path: { productId }, query: { ...query, limit, cursor: pageParam ?? undefined } } })),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor ?? null,
    enabled: enabled && !!productId,
  });
}

/** Every photo from reviews with photos (first 100 such reviews). */
export function useReviewPhotos(productId: string, enabled = true) {
  const { api } = useApi();
  return useQuery({
    queryKey: ['reviews', 'list', productId, { withPhotos: true }, { page: 1, limit: 100 }],
    queryFn: () => call(api.GET('/api/store/reviews/products/{productId}/reviews', { params: { path: { productId }, query: { withPhotos: true, sort: 'newest', page: 1, limit: 100 } } })),
    enabled: enabled && !!productId,
    select: (d) => photosOf(d.items),
  });
}

/** Helpful vote on a review or an answer (customers). Returns the new count. */
export function useHelpfulVote() {
  const { api } = useApi();
  return useMutation({
    mutationFn: (v: { targetType: 'product_review' | 'answer'; targetId: string; helpful: boolean }) => call(api.POST('/api/store/reviews/votes', { body: v })),
  });
}

/** Report reasons offered for a review, with the API reason each one is sent as. */
export const REPORT_REASONS = [
  { id: 'seller', label: 'It’s about the seller or delivery, not the product', api: 'off_topic' },
  { id: 'false', label: 'False or misleading information', api: 'inaccurate' },
  { id: 'offensive', label: 'Offensive, hateful or sexual content', api: 'offensive' },
  { id: 'spam', label: 'Spam, advertising or links', api: 'spam_or_links' },
  { id: 'fake', label: 'A fake or paid review', api: 'fake_or_paid' },
  { id: 'personal', label: 'Shares personal information', api: 'personal_information' },
  { id: 'other-product', label: 'It’s about a different product', api: 'off_topic' },
  { id: 'other', label: 'Something else', api: 'other' },
] as const;
export type ReportReason = (typeof REPORT_REASONS)[number]['id'];
export type ApiReportReason = components['schemas']['reviews.ReportInput']['reason'];

export function useReport() {
  const { api } = useApi();
  return useMutation({
    mutationFn: (v: { targetType: 'product_review' | 'answer' | 'question' | 'seller_response'; targetId: string; reason: ApiReportReason; note?: string }) =>
      call(api.POST('/api/store/reviews/reports', { body: { ...v, note: v.note || null } })),
  });
}
