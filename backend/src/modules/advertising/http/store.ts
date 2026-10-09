import { routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/advertising.js';
import type { AdvertisingService } from '../service.js';

/**
 * Store API: /api/store/advertising/…  (docs/api/modules/advertising.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const storeRoutes = (service: AdvertisingService) =>
  routes(endpoints, 'store', {
    /** POST /decisions: Decide which ads to show on this page view now */
    serveAds: async ({ body, scope, principal }) => service.serving.serve(body, { scope, principal }),
    /** POST /events: Record displays, clicks and dismissals (batched) */
    trackAdEvents: async ({ body }) => service.serving.track(body.events),
  });
