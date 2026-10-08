import { notImplemented, routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/shipping.js';
import type { ShippingService } from '../service.js';

/**
 * Webhooks: /webhooks/shipping/…  (docs/api/modules/shipping.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const webhooksRoutes = (service: ShippingService) =>
  routes(endpoints, 'webhooks', {
    /** POST /carriers/{carrier}/events: Tracking events from a carrier or carrier aggregator */
    carrierTrackingWebhook: notImplemented,
  });
