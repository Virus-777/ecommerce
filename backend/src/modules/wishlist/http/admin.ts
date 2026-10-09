import { routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/wishlist.js';
import type { WishlistService } from '../service.js';

/**
 * Admin API: /api/admin/wishlist/…  (docs/api/modules/wishlist.md)
 * Aggregates only: no customer data leaves the module here.
 */
export const adminRoutes = (service: WishlistService) =>
  routes(endpoints, 'admin', {
    /** GET /insights: Most saved products and alert counts (aggregates only, no customer data) */
    wishlistInsights: async ({ query, page }) => service.insights(query, page),
  });
