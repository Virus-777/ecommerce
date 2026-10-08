import { notImplemented, routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/notifications.js';
import type { NotificationsService } from '../service.js';

/**
 * Webhooks: /webhooks/notifications/…  (docs/api/modules/notifications.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const webhooksRoutes = (service: NotificationsService) =>
  routes(endpoints, 'webhooks', {
    /** POST /email-events: Delivery, bounce, complaint and open events from the email provider */
    emailProviderEvents: notImplemented,
    /** POST /sms-events: SMS delivery receipts and STOP replies */
    smsProviderEvents: notImplemented,
    /** POST /inbound-email: Replies to case and message emails */
    inboundEmail: notImplemented,
  });
