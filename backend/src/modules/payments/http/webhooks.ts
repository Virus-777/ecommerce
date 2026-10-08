import { notImplemented, routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/payments.js';
import type { PaymentsService } from '../service.js';

/**
 * Webhooks: /webhooks/payments/…  (docs/api/modules/payments.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const webhooksRoutes = (service: PaymentsService) => {
  void service;
  return routes(endpoints, 'webhooks', {
    /** POST /providers/{provider}/events: Payment provider events (authorization, capture, refund, dispute, card updates) */
    providerWebhook: notImplemented,
  });
};
