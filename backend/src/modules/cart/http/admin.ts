import { notImplemented, routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/cart.js';
import type { CartService } from '../service.js';

/**
 * Admin API: /api/admin/cart/…  (docs/api/modules/cart.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const adminRoutes = (service: CartService) =>
  routes(endpoints, 'admin', {
    /** GET /carts: Find a customer's or guest's cart (support) */
    listCartsAdmin: notImplemented,
    /** GET /carts/{id}: One cart with lines, notices and merge history */
    getCartAdmin: notImplemented,
  });
