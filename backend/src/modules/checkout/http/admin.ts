import { notImplemented, routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/checkout.js';
import type { CheckoutService } from '../service.js';

/**
 * Admin API: /api/admin/checkout/…  (docs/api/modules/checkout.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const adminRoutes = (service: CheckoutService) => {
  void service;
  return routes(endpoints, 'admin', {
    /** GET /sessions: Checkouts with payment problems or open changes (support view) */
    listSessionsAdmin: notImplemented,
    /** GET /sessions/{id}: One checkout with place attempts, idempotency keys, change sets and history */
    getSessionAdmin: notImplemented,
  });
};
