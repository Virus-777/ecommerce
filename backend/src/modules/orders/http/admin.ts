import { notImplemented, routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/orders.js';
import type { OrdersService } from '../service.js';

/**
 * Admin API: /api/admin/orders/…  (docs/api/modules/orders.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const adminRoutes = (service: OrdersService) =>
  routes(endpoints, 'admin', {
    /** GET /orders: Company and seller orders with payment and fulfillment columns and flags */
    listOrdersAdmin: notImplemented,
    /** GET /orders/{id}: Order with item states per seller group, money by seller, after-sales per item, payment, notes and history */
    getOrderAdmin: notImplemented,
    /** GET /orders/{id}/history: Full action history and timeline (customer, seller and staff entries) */
    getOrderHistoryAdmin: notImplemented,
    /** POST /orders/{id}/notes: Add an internal note (never shown to customers or sellers) */
    addOrderNote: notImplemented,
    /** POST /orders/{id}/cancel-items: Cancel unshipped items as staff, with a reason */
    cancelItemsAdmin: notImplemented,
    /** POST /orders/{id}/cancellation-requests/{requestId}/decide: Decide a customer's cancellation request for the seller (or override a decline) */
    decideCancellationAdmin: notImplemented,
    /** POST /orders/{id}/groups/{groupId}/dispatch-deadline: Set a final dispatch date for an overdue group */
    setDispatchDeadlineAdmin: notImplemented,
    /** POST /orders/{id}/resend-confirmation: Send the order confirmation again */
    resendConfirmation: notImplemented,
    /** GET /saved-filters: My and shared saved filters with current counts */
    listSavedFilters: notImplemented,
    /** POST /saved-filters: Save the current filters */
    createSavedFilter: notImplemented,
    /** DELETE /saved-filters/{id}: Delete a saved filter (own, or shared with orders.orders.manage) */
    deleteSavedFilter: notImplemented,
    /** POST /exports: Export the filtered order list */
    createOrdersExport: notImplemented,
    /** GET /exports/{id}: Export status and download link (download is logged) */
    getOrdersExport: notImplemented,
  });
