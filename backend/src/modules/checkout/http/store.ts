import { routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/checkout.js';
import type { CheckoutService } from '../service.js';

/**
 * Store API: /api/store/checkout/…  (docs/api/modules/checkout.md)
 * Every handler acts for the caller's own checkout: the signed-in customer or the visitor (guest) session.
 * Another shopper's session is NOT_FOUND.
 */
export const storeRoutes = (service: CheckoutService) =>
  routes(endpoints, 'store', {
    /** POST /sessions: Start checkout from the cart or Buy now */
    startCheckout: async ({ scope, body, actor, requestId, principal }) => service.startCheckout(scope, body, { actor, requestId }, principal),
    /** GET /sessions/{id}: The whole checkout: steps, contact, address, packages with options, coupons, payment, review and totals */
    getCheckout: async ({ scope, params }) => service.getCheckout(scope, params.id),
    /** PUT /sessions/{id}/contact: Guest contact details (email, optional phone) and the account-after-checkout choice */
    setGuestContact: async ({ scope, params, body }) => service.setGuestContact(await service.readerOf(scope), params.id, body),
    /** PUT /sessions/{id}/address: Choose a saved address or enter one; checks every item can ship there */
    setAddress: async ({ scope, params, body }) => service.setAddress(await service.readerOf(scope), params.id, body),
    /** PUT /sessions/{id}/delivery: Pick a delivery option for each package */
    setDeliveryOptions: async ({ scope, params, body }) => service.setDeliveryOptions(await service.readerOf(scope), params.id, body.selections),
    /** POST /sessions/{id}/coupons: Apply a coupon code */
    applyCoupon: async ({ scope, params, body }) => service.applyCoupon(await service.readerOf(scope), params.id, body.code),
    /** DELETE /sessions/{id}/coupons/{code}: Remove a coupon */
    removeCoupon: async ({ scope, params }) => service.removeCoupon(await service.readerOf(scope), params.id, params.code),
    /** PUT /sessions/{id}/credit: Use store credit for part or all of the total */
    setCredit: async ({ scope, params, body }) => service.setCredit(await service.readerOf(scope), params.id, body),
    /** PUT /sessions/{id}/payment-method: Choose a saved card, a new card (provider token) or a digital wallet */
    setPaymentMethod: async ({ scope, params, body }) => service.setPaymentMethod(await service.readerOf(scope), params.id, body),
    /** PUT /sessions/{id}/preferences: Gift note and hide prices on packing slips */
    setPreferences: async ({ scope, params, body }) => service.setPreferences(await service.readerOf(scope), params.id, body),
    /** POST /sessions/{id}/revalidate: Check price, stock, delivery, coupons and shippability again */
    revalidate: async ({ scope, params, actor, requestId }) => service.revalidate(await service.readerOf(scope), params.id, { actor, requestId }),
    /** GET /sessions/{id}/changes/{changeSetId}: The changes found, with choices, alternatives and the revised total */
    getChangeSet: async ({ scope, params }) => service.getChangeSet(await service.readerOf(scope), params.id, params.changeSetId),
    /** POST /sessions/{id}/changes/{changeSetId}/accept: Apply the customer's choice for every change and continue */
    acceptChanges: async ({ scope, params, body, actor, requestId }) => service.acceptChanges(await service.readerOf(scope), params.id, params.changeSetId, body, { actor, requestId }),
    /** POST /sessions/{id}/place: Place the order and pay */
    placeOrder: async ({ scope, params, body, idempotencyKey, actor, requestId }) => service.placeOrder(await service.readerOf(scope), params.id, body, idempotencyKey, { actor, requestId }),
    /** POST /sessions/{id}/complete-action: Finish Place order after a bank challenge or wallet confirmation */
    completePaymentAction: async ({ scope, params, body, idempotencyKey, actor, requestId }) => service.completePaymentAction(await service.readerOf(scope), params.id, body.resultToken, idempotencyKey, { actor, requestId }),
    /** POST /sessions/{id}/retry-payment: Pay again with the same or another method after a decline */
    retryPayment: async ({ scope, params, body, idempotencyKey, actor, requestId }) => service.retryPayment(await service.readerOf(scope), params.id, body, idempotencyKey, { actor, requestId }),
    /** GET /sessions/{id}/confirmation: Order confirmation (only after the payment is accepted) */
    getConfirmation: async ({ scope, params }) => service.getConfirmationFor(scope, params.id),
    /** DELETE /sessions/{id}: Leave checkout (releases holds, voids any authorization) */
    abandonCheckout: async ({ scope, params, actor, requestId }) => service.abandon(await service.readerOf(scope), params.id, { actor, requestId }),
  });
