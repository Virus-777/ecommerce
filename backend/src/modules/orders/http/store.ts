import { AppError } from '../../../kernel/errors/index.js';
import type { Scope } from '../../../kernel/auth/scope.js';
import { routes } from '../../../kernel/http/index.js';
import type * as identity from '../../../spec/identity.js';
import { endpoints } from '../../../spec/orders.js';
import type { StoreViewer } from '../service/reads.js';
import type { OrdersService } from '../service.js';

/** The shopper behind a store request: a signed-in customer or a guest (visitor) session */
const viewerOf = (scope: Scope, principal: { guestSessionId?: string | null; sessionId: string; kind: string }): StoreViewer =>
  scope.kind === 'customer' ? { customerId: scope.customerId } : scope.kind === 'visitor' ? { guestSessionId: principal.guestSessionId ?? scope.visitorSessionId } : principal.kind === 'visitor' ? { guestSessionId: principal.sessionId } : {};

const customerIdOf = (scope: Scope) => (scope.kind === 'customer' ? scope.customerId : null);

/**
 * Store API: /api/store/orders/…  (docs/api/modules/orders.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const storeRoutes = (service: OrdersService) =>
  routes(endpoints, 'store', {
    /** GET /orders: Order history with search, date range and status tab */
    listMyOrders: async ({ query, page, scope }) => service.reads.listMyOrders(customerIdOf(scope), query, page),
    /** GET /orders/counts: Counts per status tab */
    getMyOrderCounts: async ({ query, scope }) => {
      const c = await service.reads.countByTab(customerIdOf(scope), query.range, query.q);
      return { all: c.all, inProgress: c.inProgress, delivered: c.delivered, returns: c.returns, cancelled: c.cancelled };
    },
    /** GET /orders/spending: What the customer spent in a period: totals, trend and breakdowns */
    getMySpending: async ({ query, scope }) => service.spending.forCustomer(customerIdOf(scope), query),
    /** GET /orders/{id}: Order detail by seller group, with item states and separate payment, delivery and returns progress */
    getMyOrder: async ({ params, scope, principal }) => service.reads.storeDetail(await service.reads.shopperOrder(params.id, viewerOf(scope, principal))),
    /** GET /orders/{id}/cancellation-options: Which items can be cancelled now and why others cannot */
    getCancellationOptions: async ({ params, scope, principal }) => service.cancellations.options(await service.reads.shopperOrder(params.id, viewerOf(scope, principal))),
    /** POST /orders/{id}/cancellation-preview: Refund estimate for the selected items and quantities */
    previewCancellation: async ({ params, body, scope, principal }) => service.cancellations.previewFor(await service.reads.shopperOrder(params.id, viewerOf(scope, principal)), body.items),
    /** POST /orders/{id}/cancellations: Request cancellation of selected items */
    requestCancellation: async ({ params, body, scope, principal, actor, requestId, idempotencyKey }) => {
      await service.reads.shopperOrder(params.id, viewerOf(scope, principal));
      return service.cancellations.request(params.id, body, { actor, requestId, principal, idempotencyKey });
    },
    /** GET /orders/{id}/cancellations/{cancellationId}: A cancellation request with seller deadline and refund status */
    getCancellation: async ({ params, scope, principal }) => {
      await service.reads.shopperOrder(params.id, viewerOf(scope, principal));
      return service.cancellations.one(params.id, params.cancellationId);
    },
    /** POST /orders/{id}/cancellations/{cancellationId}/withdraw: Withdraw a pending cancellation request */
    withdrawCancellation: async ({ params, scope, principal, actor, requestId }) => {
      const agg = await service.reads.shopperOrder(params.id, viewerOf(scope, principal));
      if (!agg.cancellations.some((c) => c.id === params.cancellationId && c.initiated_by === 'customer')) throw new AppError('NOT_FOUND', 'Cancellation not found');
      return service.cancellations.withdraw(params.id, params.cancellationId, { actor, requestId, principal });
    },
    /** GET /orders/{id}/documents: Receipt and per-seller invoices */
    listOrderDocuments: async ({ params, scope, principal }) => service.views.documents(await service.reads.shopperOrder(params.id, viewerOf(scope, principal))),
    /** GET /orders/{id}/documents/{documentId}: Short-lived download link for a receipt or invoice PDF */
    downloadOrderDocument: async ({ params, scope, principal }) =>
      service.admin.downloadDocument(await service.reads.shopperOrder(params.id, viewerOf(scope, principal)), params.documentId, principal as unknown as identity.Principal),
  });
