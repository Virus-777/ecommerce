import { notImplemented, routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/media.js';
import type { MediaService } from '../service.js';

/**
 * Webhooks: /webhooks/media/…  (docs/api/modules/media.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const webhooksRoutes = (service: MediaService) =>
  routes(endpoints, 'webhooks', {
    /** POST /storage-events: Object-created notifications from storage */
    storageEvent: notImplemented,
    /** POST /processing-results: Video transcoding results */
    processingResult: notImplemented,
  });
