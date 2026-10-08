import { notImplemented, routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/shipping.js';
import type { ShippingService } from '../service.js';

/**
 * Store API: /api/store/shipping/…  (docs/api/modules/shipping.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const storeRoutes = (service: ShippingService) => {
  void service;
  return routes(endpoints, 'store', {
    /** GET /estimates: Delivery estimate per offer for a location (product page, offers list) */
    getOfferEstimates: notImplemented,
    /** GET /notices: Live holiday and service notices for a location */
    listCustomerNotices: notImplemented,
    /** GET /orders/{orderId}/shipments: Packages of an order with carrier, tracking and status */
    listOrderShipments: notImplemented,
    /** GET /shipments/{id}/tracking: Track one package: carrier, tracking number, contents, estimate and events */
    getTracking: notImplemented,
    /** POST /shipments/{id}/delivery-choice: Choose redelivery, pickup or return to seller after a failed delivery */
    chooseDeliveryNextStep: notImplemented,
  });
};
