import { notImplemented, routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/support.js';
import type { SupportService } from '../service.js';

/**
 * Store API: /api/store/support/…  (docs/api/modules/support.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const storeRoutes = (service: SupportService) =>
  routes(endpoints, 'store', {
    /** GET /contact-options: Topics, channels, hours and expected reply times */
    getContactOptions: notImplemented,
    /** GET /orders/{orderId}/problem-context: Order problem form context: packages and items, who handles first, when Marketly steps in, open cases */
    getProblemContext: notImplemented,
    /** POST /cases: Contact support or report an order problem (missing, damaged, wrong item, not arrived) */
    createCase: notImplemented,
    /** GET /cases: My cases with who handles them, the next action and the expected reply */
    listCustomerCases: notImplemented,
    /** GET /cases/{id}: Case detail: handler, next action and expected response, linked items, conversation, decision, remedy progress, appeal and reopen rules */
    getCustomerCase: notImplemented,
    /** POST /cases/{id}/messages: Reply on a case (with photos) */
    customerReply: notImplemented,
    /** POST /cases/{id}/escalate: Ask Marketly to step in */
    customerEscalate: notImplemented,
    /** POST /cases/{id}/offers/{offerId}/respond: Accept or decline the seller's offer */
    respondToOffer: notImplemented,
    /** POST /cases/{id}/appeal: Appeal a decision before the appeal deadline */
    customerAppeal: notImplemented,
    /** POST /cases/{id}/reopen: Reopen a resolved case within the reopen window */
    customerReopen: notImplemented,
  });
