// API access for the All offers page (store/offers): every offer for one variant, delivering to
// the shopper's location, with condition counts and the featured-offer rule.
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { call, useApi } from '@marketly/web-shared/api';
import type { OfferView } from './product';

export type ConditionGroup = 'new' | 'used' | 'refurbished';
export type OfferSort = 'total_cost' | 'fastest_delivery';

export const CONDITIONS: Array<{ value: ConditionGroup; label: string }> = [
  { value: 'new', label: 'New' },
  { value: 'used', label: 'Used' },
  { value: 'refurbished', label: 'Refurbished' },
];

/** GET /offers/products/{id}/offers: up to 100 offers, not paged. */
export function useOfferComparison(productId: string, opts: { variantId?: string; condition?: ConditionGroup | 'all'; sort?: OfferSort } = {}, enabled = true) {
  const { api } = useApi();
  const query = { variantId: opts.variantId, condition: opts.condition ?? 'all', sort: opts.sort ?? 'total_cost' };
  return useQuery({
    queryKey: ['offers', 'comparison', productId, query],
    queryFn: () => call(api.GET('/api/store/offers/products/{productId}/offers', { params: { path: { productId }, query } })),
    enabled: enabled && !!productId,
    placeholderData: keepPreviousData,
  });
}

/** "Complete: all accessories" for complete used/refurbished offers, "Missing: …" when items are absent. */
export function kitNote(o: OfferView): { warn: boolean; icon: 'package-check' | 'package-x'; text: string } | null {
  if (o.missingItems.length) return { warn: true, icon: 'package-x', text: `Missing: ${o.missingItems.join(', ').toLowerCase()}` };
  if (o.condition !== 'new' && o.complete) return { warn: false, icon: 'package-check', text: 'Complete: all accessories' };
  return null;
}

/** "Eligible: offer active, …" → ["Eligible", "offer active, …"] (bold lead-in of a rule step). */
export const splitStep = (s: string): [string, string] => {
  const i = s.indexOf(':');
  return i > 0 ? [s.slice(0, i), s.slice(i + 1).trim()] : ['', s];
};
