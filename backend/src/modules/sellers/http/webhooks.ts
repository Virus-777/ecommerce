import { routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/sellers.js';
import type { SellersService } from '../service.js';

/**
 * Webhooks: /webhooks/sellers/…  (docs/api/modules/sellers.md)
 * The middleware verifies the provider signature and answers replays of a seen event id.
 */
export const webhooksRoutes = (service: SellersService) =>
  routes(endpoints, 'webhooks', {
    verificationProviderResult: async ({ body }) => {
      await service.applications.verificationProviderResult(body);
    },
  });
