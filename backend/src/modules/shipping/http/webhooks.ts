import { routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/shipping.js';
import type { ShippingService } from '../service.js';

/**
 * Webhooks: /webhooks/shipping/…  (docs/api/modules/shipping.md)
 * The middleware verifies the carrier's signature (hmacWebhookVerifier, secret named by {carrier}); events are
 * deduplicated by the carrier's event id.
 */
export const webhooksRoutes = (service: ShippingService) =>
  routes(endpoints, 'webhooks', {
    /** POST /carriers/{carrier}/events: Tracking events from a carrier or carrier aggregator */
    carrierTrackingWebhook: async ({ params, body, request }) => {
      const id = request.headers['x-event-id'];
      return service.shipments.webhook(params.carrier, body, typeof id === 'string' && id ? id : undefined);
    },
  });
