import { routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/notifications.js';
import type { NotificationsService } from '../service.js';

/**
 * Webhooks: /webhooks/notifications/…  (docs/api/modules/notifications.md)
 * Signatures are verified by the middleware (hmacWebhookVerifier in module.ts); replays of the same
 * X-Event-Id are answered there. Handlers are idempotent per provider event id as well.
 */
export const webhooksRoutes = (service: NotificationsService) =>
  routes(endpoints, 'webhooks', {
    /** POST /email-events: Delivery, bounce, complaint and open events from the email provider */
    emailProviderEvents: async ({ body }) => {
      await service.webhooks.emailEvents(body.events);
    },
    /** POST /sms-events: SMS delivery receipts and STOP replies */
    smsProviderEvents: async ({ body }) => {
      await service.webhooks.smsEvent(body);
    },
    /** POST /inbound-email: Replies to case and message emails */
    inboundEmail: async ({ body }) => {
      await service.webhooks.inbound(body);
    },
  });
