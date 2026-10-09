import { routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/payments.js';
import type { PaymentsService } from '../service.js';

/**
 * Webhooks: /webhooks/payments/…  (docs/api/modules/payments.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 * The signature was verified by the middleware (hmacWebhookVerifier in module.ts).
 */
export const webhooksRoutes = (service: PaymentsService) =>
  routes(endpoints, 'webhooks', {
    /** POST /providers/{provider}/events: Payment provider events (authorization, capture, refund, dispute, card updates) */
    providerWebhook: ({ params, body, request }) => {
      const header = request.headers['x-event-id'];
      const eventId = request.auth?.provider?.eventId ?? (typeof header === 'string' && header ? header : undefined);
      return service.webhooks.receive(params.provider, body, eventId);
    },
  });
