import { routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/checkout.js';
import type { CheckoutService } from '../service.js';

/**
 * Admin API: /api/admin/checkout/…  (docs/api/modules/checkout.md)
 * Support views (checkout.sessions.view, checked by the middleware).
 */
export const adminRoutes = (service: CheckoutService) =>
  routes(endpoints, 'admin', {
    /** GET /sessions: Checkouts with payment problems or open changes (support view) */
    listSessionsAdmin: async ({ query, page }) => service.listSessionsAdmin(query, page),
    /** GET /sessions/{id}: One checkout with place attempts, idempotency keys, change sets and history */
    getSessionAdmin: async ({ params }) => service.getSessionAdmin(params.id),
  });
