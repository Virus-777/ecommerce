// API access for product questions and answers (store/questions and the Q&A block of store/product):
// questions with answers (server-side search and sort, page numbers or cursor), asking a question
// and who answered (role labels).
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { call, useApi, type components } from '@marketly/web-shared/api';
import type { IconName, Tone } from '@marketly/web-shared/ui';
import { OFFICIAL_STORE_ID } from './product';

export type ApiQuestion = components['schemas']['reviews.Question'];
export type ApiAnswer = components['schemas']['reviews.Answer'];

/**
 * Who answered. Official Store = Marketly selling first-party; Seller = an outside seller of this
 * item; Marketly staff = platform product support; Verified buyer = bought this item on Marketly;
 * Customer = another shopper without a recorded purchase.
 */
export type QaRole = 'official' | 'seller' | 'staff' | 'buyer' | 'customer';

export const QA_ROLES: Record<QaRole, { tone: Tone; icon: IconName; label: string }> = {
  official: { tone: 'brand', icon: 'badge-check', label: 'Official Store' },
  seller: { tone: 'info', icon: 'store', label: 'Seller' },
  staff: { tone: 'solid', icon: 'shield-check', label: 'Marketly staff' },
  buyer: { tone: 'success', icon: 'user-round-check', label: 'Verified buyer' },
  customer: { tone: 'outline', icon: 'user-round', label: 'Customer' },
};

/** The role badge of an answer, from the API label and author. */
export function roleOf(a: ApiAnswer): QaRole {
  if (a.label === 'marketly_staff') return 'staff';
  if (a.label === 'seller') return a.by.sellerId === OFFICIAL_STORE_ID ? 'official' : 'seller';
  return a.by.verifiedPurchase ? 'buyer' : 'customer';
}

export type QaSort = 'helpful' | 'recent';
export const QA_SORTS: Array<{ value: QaSort; label: string }> = [
  { value: 'helpful', label: 'Most helpful' },
  { value: 'recent', label: 'Most recent' },
];
const API_SORT: Record<QaSort, 'most_helpful' | 'newest'> = { helpful: 'most_helpful', recent: 'newest' };

/** One website page of questions (page numbers). `q` searches questions and answers on the server. */
export function useQuestionPage(productId: string, q: string, sort: QaSort, page: number, limit: number, enabled = true) {
  const { api } = useApi();
  const query = { q: q || undefined, sort: API_SORT[sort] };
  return useQuery({
    queryKey: ['reviews', 'questions', productId, query, { page, limit }],
    queryFn: () => call(api.GET('/api/store/reviews/products/{productId}/questions', { params: { path: { productId }, query: { ...query, page, limit } } })),
    enabled: enabled && !!productId,
    placeholderData: keepPreviousData,
  });
}

/** Questions for the phone layout: "Load more" with the cursor. */
export function useQuestionFeed(productId: string, q: string, sort: QaSort, limit: number, enabled = true) {
  const { api } = useApi();
  const query = { q: q || undefined, sort: API_SORT[sort] };
  return useInfiniteQuery({
    queryKey: ['reviews', 'questions-feed', productId, query, { limit }],
    queryFn: ({ pageParam }) =>
      call(api.GET('/api/store/reviews/products/{productId}/questions', { params: { path: { productId }, query: { ...query, limit, cursor: pageParam ?? undefined } } })),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor ?? null,
    enabled: enabled && !!productId,
  });
}

/** Ask a question about the product (customers). */
export function useAskQuestion(productId: string) {
  const { api } = useApi();
  return useMutation({
    mutationFn: (text: string) => call(api.POST('/api/store/reviews/products/{productId}/questions', { params: { path: { productId } }, body: { text } })),
  });
}

/** The value after it stopped changing for `ms` (search as you type). */
export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}
