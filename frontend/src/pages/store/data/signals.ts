// Discovery signals (docs/api/modules/reports.md, POST /api/store/reports/signals).
// Product views are counted only from this op (reports read model discovery.product_views): the
// recently-viewed list (customers/recently-viewed) is a different thing and is not counted.
// The body is { signals: [{ kind: 'product_view', productId, at }] } (up to 50 per call); the op takes no
// offer id, source or placement. Consent is applied on the server: a signed-in shopper who turned off
// personalised recommendations is not counted, so the store sends the signal for everyone and never
// asks for a consent flag. Counts only, no customer id is stored.
import { useEffect, useRef } from 'react';
import { call, useApi } from '@marketly/web-shared/api';

/**
 * Last product view sent from this tab, so a re-mount of the same product page within a few seconds
 * (React StrictMode in development, a quick back-and-forth between variants) isn't counted twice.
 * A real new visit later is counted again.
 */
let lastSent: { productId: string; at: number } | null = null;
const SAME_VIEW_MS = 5_000;

/**
 * Records one product view when `productId` is known (pass null until the product has loaded, so a
 * 404 is never counted). Fire and forget: it never blocks the page and never shows an error (a rate
 * limit or a network problem only costs one count).
 */
export function useProductViewSignal(productId: string | null | undefined) {
  const { api } = useApi();
  const sentFor = useRef<string | null>(null);
  useEffect(() => {
    if (!productId || sentFor.current === productId) return;
    sentFor.current = productId;
    const now = Date.now();
    if (lastSent && lastSent.productId === productId && now - lastSent.at < SAME_VIEW_MS) return;
    lastSent = { productId, at: now };
    void call(api.POST('/api/store/reports/signals', { body: { signals: [{ kind: 'product_view', productId, at: new Date(now).toISOString() }] } })).catch(() => undefined);
  }, [api, productId]);
}
