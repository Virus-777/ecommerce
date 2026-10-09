import { routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/cart.js';
import type { CartService } from '../service.js';

/**
 * Admin API: /api/admin/cart/…  (docs/api/modules/cart.md)
 * Read-only support views (cart.carts.view is checked by the middleware).
 */
export const adminRoutes = (service: CartService) =>
  routes(endpoints, 'admin', {
    /** GET /carts: Find a customer's or guest's cart (support) */
    listCartsAdmin: async ({ query, page }) => service.listCartsAdmin({ customerId: query.customerId, guestSessionId: query.guestSessionId, status: query.status }, page),
    /** GET /carts/{id}: One cart with lines, notices and merge history */
    getCartAdmin: async ({ params }) => service.getCartAdmin(params.id),
  });
