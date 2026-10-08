import { notImplemented, routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/checkout.js';
import type { CheckoutService } from '../service.js';

/**
 * Store API: /api/store/checkout/…  (docs/api/modules/checkout.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const storeRoutes = (service: CheckoutService) => {
  void service;
  return routes(endpoints, 'store', {
    /** POST /sessions: Start checkout from the cart or Buy now */
    startCheckout: notImplemented,
    /** GET /sessions/{id}: The whole checkout: steps, contact, address, packages with options, coupons, payment, review and totals */
    getCheckout: notImplemented,
    /** PUT /sessions/{id}/contact: Guest contact details (email, optional phone) and the account-after-checkout choice */
    setGuestContact: notImplemented,
    /** PUT /sessions/{id}/address: Choose a saved address or enter one; checks every item can ship there */
    setAddress: notImplemented,
    /** PUT /sessions/{id}/delivery: Pick a delivery option for each package */
    setDeliveryOptions: notImplemented,
    /** POST /sessions/{id}/coupons: Apply a coupon code */
    applyCoupon: notImplemented,
    /** DELETE /sessions/{id}/coupons/{code}: Remove a coupon */
    removeCoupon: notImplemented,
    /** PUT /sessions/{id}/credit: Use store credit for part or all of the total */
    setCredit: notImplemented,
    /** PUT /sessions/{id}/payment-method: Choose a saved card, a new card (provider token) or a digital wallet */
    setPaymentMethod: notImplemented,
    /** PUT /sessions/{id}/preferences: Gift note and hide prices on packing slips */
    setPreferences: notImplemented,
    /** POST /sessions/{id}/revalidate: Check price, stock, delivery, coupons and shippability again */
    revalidate: notImplemented,
    /** GET /sessions/{id}/changes/{changeSetId}: The changes found, with choices, alternatives and the revised total */
    getChangeSet: notImplemented,
    /** POST /sessions/{id}/changes/{changeSetId}/accept: Apply the customer's choice for every change and continue */
    acceptChanges: notImplemented,
    /** POST /sessions/{id}/place: Place the order and pay */
    placeOrder: notImplemented,
    /** POST /sessions/{id}/complete-action: Finish Place order after a bank challenge or wallet confirmation */
    completePaymentAction: notImplemented,
    /** POST /sessions/{id}/retry-payment: Pay again with the same or another method after a decline */
    retryPayment: notImplemented,
    /** GET /sessions/{id}/confirmation: Order confirmation (only after the payment is accepted) */
    getConfirmation: notImplemented,
    /** DELETE /sessions/{id}: Leave checkout (releases holds, voids any authorization) */
    abandonCheckout: notImplemented,
  });
};
