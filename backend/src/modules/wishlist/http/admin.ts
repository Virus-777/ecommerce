import { notImplemented, routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/wishlist.js';
import type { WishlistService } from '../service.js';

/**
 * Admin API: /api/admin/wishlist/…  (docs/api/modules/wishlist.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const adminRoutes = (service: WishlistService) => {
  void service;
  return routes(endpoints, 'admin', {
    /** GET /insights: Most saved products and alert counts (aggregates only, no customer data) */
    wishlistInsights: notImplemented,
  });
};
