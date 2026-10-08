import { notImplemented, routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/orders.js';
import type { OrdersService } from '../service.js';

/**
 * Seller API: /api/seller/orders/…  (docs/api/modules/orders.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const sellerRoutes = (service: OrdersService) =>
  routes(endpoints, 'seller', {
    /** GET /orders: The seller's fulfillment tasks by stage, with dispatch deadlines and next action */
    listSellerOrders: notImplemented,
    /** GET /orders/counts: Tab counts plus overdue and due today */
    getSellerOrderCounts: notImplemented,
    /** GET /orders/{id}: One fulfillment task: own items, dispatch countdown, ship-to, money, shipments, cancellation requests and timeline */
    getSellerOrder: notImplemented,
    /** POST /orders/{id}/start-preparing: Mark the task as preparing (tells the buyer it is being packed) */
    startPreparing: notImplemented,
    /** POST /orders/bulk-start-preparing: Mark several new tasks as preparing */
    bulkStartPreparing: notImplemented,
    /** POST /orders/{id}/report-delay: Report that items will ship late, with a new dispatch date */
    reportDelay: notImplemented,
    /** POST /orders/{id}/cancel-items: Cancel items the seller cannot fulfill */
    sellerCancelItems: notImplemented,
    /** POST /orders/{id}/cancellation-requests/{requestId}/accept: Accept the buyer's cancellation and refund */
    acceptCancellationRequest: notImplemented,
    /** POST /orders/{id}/cancellation-requests/{requestId}/decline: Decline because the items already shipped */
    declineCancellationRequest: notImplemented,
    /** GET /orders/{id}/packing-slip: Packing slip for this task (only this seller's items) */
    getPackingSlip: notImplemented,
    /** POST /packing-slips: One PDF with packing slips for several tasks */
    printPackingSlips: notImplemented,
    /** POST /exports: Export the seller's orders (own items only) */
    createSellerExport: notImplemented,
    /** GET /exports/{id}: Export status and download link */
    getSellerExport: notImplemented,
  });
