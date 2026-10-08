import { notImplemented, routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/identity.js';
import type { IdentityService } from '../service.js';

/**
 * Seller API: /api/seller/identity/…  (docs/api/modules/identity.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const sellerRoutes = (service: IdentityService) =>
  routes(endpoints, 'seller', {
    /** POST /reauth: Confirm it is you before a sensitive Seller Center action */
    reauthenticateSeller: notImplemented,
    /** GET /session/sellers: Sellers this member can act for (seller switcher) */
    listSellerContexts: notImplemented,
    /** POST /session/seller-context: Choose or switch the seller this session acts for */
    switchSellerContext: notImplemented,
  });
