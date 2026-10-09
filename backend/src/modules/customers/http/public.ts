import { routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/customers.js';
import type { CustomersService } from '../service.js';

/**
 * Public API: /api/public/customers/…  (docs/api/modules/customers.md)
 */
export const publicRoutes = (service: CustomersService) =>
  routes(endpoints, 'public', {
    /** POST /unsubscribe: One-click stop of promotional messages from an email or SMS link */
    unsubscribe: async ({ body, actor, requestId, request }) => service.unsubscribe(body, { actor, requestId, ip: request.ip }),
  });
