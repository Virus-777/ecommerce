import { routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/identity.js';
import type { IdentityService } from '../service.js';
import { caller, send } from './client.js';

/**
 * Seller API: /api/seller/identity/…  (docs/api/modules/identity.md)
 * The seller comes from the token, never the path; the session endpoints also work before one is chosen.
 */
export const sellerRoutes = (service: IdentityService) =>
  routes(endpoints, 'seller', {
    /** POST /reauth: Confirm it is you before a sensitive Seller Center action */
    reauthenticateSeller: async (input) => service.reauthenticate(input.body, caller(input)),
    /** GET /session/sellers: Sellers this member can act for (seller switcher) */
    listSellerContexts: async ({ principal }) => service.listSellerContexts(principal),
    /** POST /session/seller-context: Choose or switch the seller this session acts for */
    switchSellerContext: async (input) => send(input.reply, await service.switchSellerContext(input.body.sellerId, caller(input))),
  });
