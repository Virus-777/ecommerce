import { routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/media.js';
import type { MediaService } from '../service.js';

/**
 * Webhooks: /webhooks/media/…  (docs/api/modules/media.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 * Signatures are verified by the middleware (hmacWebhookVerifier in module.ts); handlers are idempotent.
 */
export const webhooksRoutes = (service: MediaService) =>
  routes(endpoints, 'webhooks', {
    /** POST /storage-events: Object-created notifications from storage */
    storageEvent: async ({ body }) => {
      await service.handleStorageEvents(body.events);
    },
    /** POST /processing-results: Video transcoding results */
    processingResult: async ({ body }) => {
      await service.handleProcessingResult(body);
    },
  });
