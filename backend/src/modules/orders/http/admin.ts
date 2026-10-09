import { AppError } from '../../../kernel/errors/index.js';
import { routes } from '../../../kernel/http/index.js';
import type * as identity from '../../../spec/identity.js';
import { endpoints } from '../../../spec/orders.js';
import { ADMIN_DATASET } from '../service/admin.js';
import type { OrdersService } from '../service.js';

const p = (principal: unknown) => principal as identity.Principal;
const CONTACT = 'orders.customers.view-contact';

/**
 * Admin API: /api/admin/orders/…  (docs/api/modules/orders.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const adminRoutes = (service: OrdersService) => {
  const target = (o: { id: string; ref: string }) => ({ type: 'order', id: o.id, ref: o.ref, label: `Order ${o.ref}`, screen: 'admin/order' });
  return routes(endpoints, 'admin', {
    /** GET /orders: Company and seller orders with payment and fulfillment columns and flags */
    listOrdersAdmin: async ({ query, page, principal }) => service.reads.adminRows(query, page, principal.accountId ?? null),
    /** GET /orders/{id}: Order with item states per seller group, money by seller, after-sales per item, payment, notes and history */
    getOrderAdmin: async ({ params, can }) => service.reads.adminDetail(await service.reads.adminOrder(params.id), await can(CONTACT)),
    /** GET /orders/{id}/history: Full action history and timeline (customer, seller and staff entries) */
    getOrderHistoryAdmin: async ({ params, query, page }) => {
      await service.reads.adminOrder(params.id);
      const rows = await service.core.repo.timelinePage(params.id, query.visibility, page);
      return { ...rows, items: service.views.timeline(rows.items, 'admin') };
    },
    /** POST /orders/{id}/notes: Add an internal note (never shown to customers or sellers) */
    addOrderNote: async ({ params, body, actor, requestId, principal }) => service.admin.addNote(params.id, body.text, { actor, requestId, principal }),
    /** POST /orders/{id}/cancel-items: Cancel unshipped items as staff, with a reason */
    cancelItemsAdmin: async ({ params, body, actor, requestId, principal, idempotencyKey }) => {
      const agg = await service.reads.adminOrder(params.id);
      const by = { actor, requestId, principal };
      const result = await service.cancellations.staffCancel(params.id, body, { ...by, idempotencyKey });
      await service.core.audit(
        {
          action: 'orders.items.cancel',
          actionLabel: 'Cancelled order items',
          category: 'orders',
          target: target(agg.order),
          reason: body.reason,
          after: { items: body.items, reasonCode: body.reasonCode, notifyCustomer: body.notifyCustomer, trustReportId: body.trustReportId ?? null, cancellations: result.requests.map((r) => r.id), refund: result.requests.map((r) => r.refundPreview.total) },
        },
        by,
      );
      return result;
    },
    /** POST /orders/{id}/cancellation-requests/{requestId}/decide: Decide a customer's cancellation request for the seller (or override a decline) */
    decideCancellationAdmin: async ({ params, body, actor, requestId, principal }) => {
      if (!body.reason?.trim()) throw new AppError('VALIDATION_FAILED', 'Give a reason', { issues: [{ path: 'reason', message: 'Give a reason' }] });
      const agg = await service.reads.adminOrder(params.id);
      const before = agg.cancellations.find((c) => c.id === params.requestId);
      if (!before) throw new AppError('NOT_FOUND', 'Cancellation not found');
      const by = { actor, requestId, principal };
      const result = body.accept
        ? await service.cancellations.accept(params.id, params.requestId, by, { outcome: 'accepted', reason: body.reason })
        : await service.cancellations.decline(params.id, params.requestId, by, { reason: 'other', note: body.reason, byStaff: true });
      await service.core.audit(
        {
          action: body.accept ? (before.status === 'declined' ? 'orders.cancellation.override' : 'orders.cancellation.accept') : 'orders.cancellation.decline',
          actionLabel: body.accept ? (before.status === 'declined' ? 'Overrode a declined cancellation' : 'Accepted a cancellation for the seller') : 'Declined a cancellation for the seller',
          category: 'orders',
          target: target(agg.order),
          reason: body.reason,
          before: { status: before.status },
          after: { status: result.status, refund: result.refundPreview.total },
        },
        by,
      );
      return result;
    },
    /** POST /orders/{id}/groups/{groupId}/dispatch-deadline: Set a final dispatch date for an overdue group */
    setDispatchDeadlineAdmin: async ({ params, body, actor, requestId, principal, can }) => {
      const agg = await service.reads.adminOrder(params.id);
      const group = agg.groups.find((g) => g.id === params.groupId);
      if (!group) throw new AppError('NOT_FOUND', 'Package not found');
      if (new Date(body.dueAt).getTime() <= service.core.now().getTime()) throw new AppError('VALIDATION_FAILED', 'Choose a date in the future', { issues: [{ path: 'dueAt', message: 'Choose a date in the future' }] });
      await service.fulfillment.setDispatchDeadline(params.groupId, body.dueAt, body.reason, actor, { notifyCustomer: body.notifyCustomer, orderId: params.id });
      await service.core.audit(
        {
          action: 'orders.dispatch_deadline.set',
          actionLabel: 'Set a final dispatch date',
          category: 'orders',
          target: { ...target(agg.order), sellerId: group.seller_id },
          reason: body.reason,
          before: { dueAt: group.dispatch_by.toISOString() },
          after: { dueAt: body.dueAt, notifyCustomer: body.notifyCustomer },
        },
        { actor, requestId, principal },
      );
      return service.reads.adminDetail(await service.reads.adminOrder(params.id), await can(CONTACT));
    },
    /** POST /orders/{id}/resend-confirmation: Send the order confirmation again */
    resendConfirmation: async ({ params, body, actor, requestId, principal }) => service.admin.resendConfirmation(params.id, body.email, { actor, requestId, principal }),
    /** GET /saved-filters: My and shared saved filters with current counts */
    listSavedFilters: async ({ principal }) => service.admin.listSavedFilters(principal.accountId!),
    /** POST /saved-filters: Save the current filters */
    createSavedFilter: async ({ body, principal }) => service.admin.createSavedFilter(principal.accountId!, body),
    /** DELETE /saved-filters/{id}: Delete a saved filter (own, or shared with orders.orders.manage) */
    deleteSavedFilter: async ({ params, principal, can }) => service.admin.deleteSavedFilter(principal.accountId!, params.id, await can('orders.orders.manage')),
    /** POST /exports: Export the filtered order list */
    createOrdersExport: async ({ body, principal, actor, requestId }) => service.admin.requestExport(ADMIN_DATASET, body, p(principal), { actor, requestId, principal }),
    /** GET /exports/{id}: Export status and download link (download is logged) */
    getOrdersExport: async ({ params, principal }) => service.admin.getExport(params.id, p(principal), ADMIN_DATASET),
  });
};
