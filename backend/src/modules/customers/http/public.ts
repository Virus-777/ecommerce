import { notImplemented, routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/customers.js';
import type { CustomersService } from '../service.js';

/**
 * Public API: /api/public/customers/…  (docs/api/modules/customers.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const publicRoutes = (service: CustomersService) =>
  routes(endpoints, 'public', {
    /** POST /unsubscribe: One-click stop of promotional messages from an email or SMS link */
    unsubscribe: notImplemented,
  });
