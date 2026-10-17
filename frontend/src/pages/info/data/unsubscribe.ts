// One-click unsubscribe from a promotional email or text (POST /api/public/customers/unsubscribe).
// The token in the link is signed by notifications and names the customer and the channel it was sent on;
// `channel: 'all'` stops every promotional channel (email, texts, app promotions and wishlist alerts).
// Essential messages (orders, delivery, returns, refunds, cases, security) are never affected.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ApiError, call, useApi, type components } from '@marketly/web-shared/api';

export type MarketingPreferences = components['schemas']['customers.MarketingPreferences'];

/** The link's token is wrong, tampered with or too old (400 UNSUBSCRIBE_TOKEN_INVALID). */
export const isBadToken = (e: unknown) => e instanceof ApiError && e.code === 'UNSUBSCRIBE_TOKEN_INVALID';

export function useUnsubscribe() {
  const { api } = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ token, all }: { token: string; all: boolean }) =>
      call(api.POST('/api/public/customers/unsubscribe', { body: { token, ...(all ? { channel: 'all' as const } : {}) } })),
    // a signed-in customer's Profile switches show the new consent
    onSuccess: (prefs) => qc.setQueryData(['customers', 'marketing-preferences'], prefs),
  });
}
