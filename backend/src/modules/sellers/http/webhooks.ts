import { notImplemented, routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/sellers.js';
import type { SellersService } from '../service.js';

/**
 * Webhooks: /webhooks/sellers/…  (docs/api/modules/sellers.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const webhooksRoutes = (service: SellersService) =>
  routes(endpoints, 'webhooks', {
    /** POST /verification-results: Identity and business verification results from the provider */
    verificationProviderResult: notImplemented,
  });
