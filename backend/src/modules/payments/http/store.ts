import { notImplemented, routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/payments.js';
import type { PaymentsService } from '../service.js';

/**
 * Store API: /api/store/payments/…  (docs/api/modules/payments.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const storeRoutes = (service: PaymentsService) =>
  routes(endpoints, 'store', {
    /** GET /options: Accepted methods, saved cards, wallet availability and new-card setup */
    getPaymentOptions: notImplemented,
    /** GET /intents/{id}: Payment result for the payment-result page (accepted, pending check, failed) */
    getPaymentStatus: notImplemented,
    /** POST /intents/{id}/check: Ask the provider for the result now ('Check now') */
    checkPaymentNow: notImplemented,
    /** GET /methods: Saved cards and wallets */
    listSavedMethods: notImplemented,
    /** POST /methods/setup: Start adding a card (provider fields receive the card number) */
    startMethodSetup: notImplemented,
    /** POST /methods: Save a card after the provider confirmed the setup */
    saveMethod: notImplemented,
    /** PATCH /methods/{id}: Change the label, billing address or expiry date */
    updateMethod: notImplemented,
    /** POST /methods/{id}/make-default: Use this card by default at checkout */
    makeMethodDefault: notImplemented,
    /** DELETE /methods/{id}: Remove a saved card */
    removeMethod: notImplemented,
    /** GET /refunds: My refunds with status (Requested, Processing, Sent, Failed) */
    listMyRefunds: notImplemented,
    /** GET /refunds/{id}: One refund with destination and timing */
    getMyRefund: notImplemented,
    /** POST /refunds/{id}/destination: Choose where a failed refund should go instead */
    chooseRefundDestination: notImplemented,
  });
