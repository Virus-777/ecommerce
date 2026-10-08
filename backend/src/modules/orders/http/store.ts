import { notImplemented, routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/orders.js';
import type { OrdersService } from '../service.js';

/**
 * Store API: /api/store/orders/…  (docs/api/modules/orders.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const storeRoutes = (service: OrdersService) =>
  routes(endpoints, 'store', {
    /** GET /orders: Order history with search, date range and status tab */
    listMyOrders: notImplemented,
    /** GET /orders/counts: Counts per status tab */
    getMyOrderCounts: notImplemented,
    /** GET /orders/{id}: Order detail by seller group, with item states and separate payment, delivery and returns progress */
    getMyOrder: notImplemented,
    /** GET /orders/{id}/cancellation-options: Which items can be cancelled now and why others cannot */
    getCancellationOptions: notImplemented,
    /** POST /orders/{id}/cancellation-preview: Refund estimate for the selected items and quantities */
    previewCancellation: notImplemented,
    /** POST /orders/{id}/cancellations: Request cancellation of selected items */
    requestCancellation: notImplemented,
    /** GET /orders/{id}/cancellations/{cancellationId}: A cancellation request with seller deadline and refund status */
    getCancellation: notImplemented,
    /** POST /orders/{id}/cancellations/{cancellationId}/withdraw: Withdraw a pending cancellation request */
    withdrawCancellation: notImplemented,
    /** GET /orders/{id}/documents: Receipt and per-seller invoices */
    listOrderDocuments: notImplemented,
    /** GET /orders/{id}/documents/{documentId}: Short-lived download link for a receipt or invoice PDF */
    downloadOrderDocument: notImplemented,
  });
