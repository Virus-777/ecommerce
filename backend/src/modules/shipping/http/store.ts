import type { Scope } from '../../../kernel/auth/scope.js';
import { AppError } from '../../../kernel/errors/index.js';
import { routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/shipping.js';
import type { ShopperViewer } from '../service/shipments.js';
import type { ShippingService } from '../service.js';

/** The shopper behind a store request: a signed-in customer or a guest (visitor) session */
const viewerOf = (scope: Scope, principal: { guestSessionId?: string | null; sessionId?: string | null; kind: string }): ShopperViewer =>
  scope.kind === 'customer'
    ? { customerId: scope.customerId }
    : scope.kind === 'visitor'
      ? { guestSessionId: principal.guestSessionId ?? scope.visitorSessionId }
      : principal.kind === 'visitor'
        ? { guestSessionId: principal.guestSessionId ?? principal.sessionId ?? null }
        : {};

/**
 * Store API: /api/store/shipping/…  (docs/api/modules/shipping.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const storeRoutes = (service: ShippingService) =>
  routes(endpoints, 'store', {
    /** GET /estimates: Delivery estimate per offer for a location (product page, offers list) */
    getOfferEstimates: async ({ query }) => {
      const ids = query.offerIds
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 20);
      return service.estimateOffers(ids, query.postalCode || undefined);
    },
    /** GET /notices: Live holiday and service notices for a location */
    listCustomerNotices: async ({ query }) => service.activeNotices(query.postalCode || undefined, undefined, query.surface ?? undefined),
    /** GET /orders/{orderId}/shipments: Packages of an order with carrier, tracking and status */
    listOrderShipments: async ({ params, scope, principal }) => {
      if (!(await service.shipments.visibleToShopper(params.orderId, viewerOf(scope, principal)))) throw new AppError('NOT_FOUND', 'Order not found');
      return service.shipments.forOrder(params.orderId);
    },
    /** GET /shipments/{id}/tracking: Track one package: carrier, tracking number, contents, estimate and events */
    getTracking: async ({ params, scope, principal }) => service.shipments.trackingView(await service.shipments.shopperShipment(params.id, viewerOf(scope, principal))),
    /** POST /shipments/{id}/delivery-choice: Choose redelivery, pickup or return to seller after a failed delivery */
    chooseDeliveryNextStep: async ({ params, body, scope, principal, actor, requestId }) =>
      service.shipments.choose(params.id, viewerOf(scope, principal), { choice: body.choice, redeliveryDate: body.redeliveryDate ?? null }, { actor, requestId, principal }),
  });
