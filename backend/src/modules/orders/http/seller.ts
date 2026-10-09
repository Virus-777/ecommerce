import { routes } from '../../../kernel/http/index.js';
import type * as identity from '../../../spec/identity.js';
import { endpoints } from '../../../spec/orders.js';
import { SELLER_DATASET } from '../service/admin.js';
import type { OrdersService } from '../service.js';

const p = (principal: unknown) => principal as identity.Principal;

/**
 * Seller API: /api/seller/orders/…  (docs/api/modules/orders.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 * `{id}` is the seller group (the seller's fulfillment task); another seller's group is NOT_FOUND.
 */
export const sellerRoutes = (service: OrdersService) =>
  routes(endpoints, 'seller', {
    /** GET /orders: The seller's fulfillment tasks by stage, with dispatch deadlines and next action */
    listSellerOrders: async ({ query, page, sellerId }) => service.reads.sellerRows(sellerId, query, page),
    /** GET /orders/counts: Tab counts plus overdue and due today */
    getSellerOrderCounts: async ({ sellerId }) => service.reads.sellerCounts(sellerId),
    /** GET /orders/{id}: One fulfillment task: own items, dispatch countdown, ship-to, money, shipments, cancellation requests and timeline */
    getSellerOrder: async ({ params, sellerId }) => service.reads.sellerDetail(sellerId, params.id),
    /** POST /orders/{id}/start-preparing: Mark the task as preparing (tells the buyer it is being packed) */
    startPreparing: async ({ params, sellerId, actor, requestId, principal }) => {
      await service.reads.sellerGroup(sellerId, params.id);
      await service.fulfillment.startPreparing(params.id, { actor, requestId, principal });
      return service.reads.sellerDetail(sellerId, params.id);
    },
    /** POST /orders/bulk-start-preparing: Mark several new tasks as preparing */
    bulkStartPreparing: async ({ body, sellerId, actor, requestId, principal }) => service.fulfillment.bulkStartPreparing(sellerId, body.orderIds, { actor, requestId, principal }),
    /** POST /orders/{id}/report-delay: Report that items will ship late, with a new dispatch date */
    reportDelay: async ({ params, body, sellerId, actor, requestId, principal }) => {
      await service.reads.sellerGroup(sellerId, params.id);
      await service.fulfillment.reportDelay(params.id, body, { actor, requestId, principal });
      return service.reads.sellerDetail(sellerId, params.id);
    },
    /** POST /orders/{id}/cancel-items: Cancel items the seller cannot fulfill */
    sellerCancelItems: async ({ params, body, sellerId, actor, requestId, principal, idempotencyKey }) => {
      const { agg } = await service.reads.sellerGroup(sellerId, params.id);
      return service.cancellations.sellerCancel(agg.order.id, params.id, body, { actor, requestId, principal, idempotencyKey });
    },
    /** POST /orders/{id}/cancellation-requests/{requestId}/accept: Accept the buyer's cancellation and refund */
    acceptCancellationRequest: async ({ params, sellerId, actor, requestId, principal }) => {
      const { agg } = await service.reads.sellerGroup(sellerId, params.id);
      return service.cancellations.accept(agg.order.id, params.requestId, { actor, requestId, principal }, { outcome: 'accepted', groupId: params.id });
    },
    /** POST /orders/{id}/cancellation-requests/{requestId}/decline: Decline because the items already shipped */
    declineCancellationRequest: async ({ params, body, sellerId, actor, requestId, principal }) => {
      const { agg } = await service.reads.sellerGroup(sellerId, params.id);
      return service.cancellations.decline(agg.order.id, params.requestId, { actor, requestId, principal }, { reason: body.reason, note: body.note, groupId: params.id });
    },
    /** GET /orders/{id}/packing-slip: Packing slip for this task (only this seller's items) */
    getPackingSlip: async ({ params, query, sellerId, principal }) => service.admin.packingSlip(sellerId, params.id, query.hidePrices, p(principal)),
    /** POST /packing-slips: One PDF with packing slips for several tasks */
    printPackingSlips: async ({ body, sellerId, principal }) => service.admin.packingSlips(sellerId, body.orderIds, body.hidePrices, p(principal), await service.fulfillment.resolveTasks(sellerId, body.orderIds)),
    /** POST /exports: Export the seller's orders (own items only) */
    createSellerExport: async ({ body, sellerId, principal, actor, requestId }) =>
      service.admin.requestExport(SELLER_DATASET, body, p(principal), { actor, requestId, principal }, { sellerId, contactVisible: false }),
    /** GET /exports/{id}: Export status and download link */
    getSellerExport: async ({ params, sellerId, principal }) => service.admin.getExport(params.id, p(principal), SELLER_DATASET, sellerId),
  });
