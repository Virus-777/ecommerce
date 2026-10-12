import { defineModule } from '../../kernel/module-system/index.js';
import { spec } from '../../spec/orders.js';
import { resolvers } from './graphql/resolvers.js';
import { typeDefs } from './graphql/schema.js';
import { storeRoutes } from './http/store.js';
import { sellerRoutes } from './http/seller.js';
import { adminRoutes } from './http/admin.js';
import { migrations } from './infra/postgres/migrations/index.js';
import { createPostgresOrdersRepository } from './infra/postgres/repository.js';
import { OrdersService } from './service.js';
import { schemas } from './infra/mongo/schema.js';

/**
 * Orders: The accepted purchase: one order per checkout, one seller group per seller package, and items with their own state (Confirmed, Preparing, Delayed, Shipped, Delivered, cancellation, return, refund). Keeps frozen purchase snapshots, derives the overall status from the items, tracks payment, delivery and returns progress separately, and runs item-level cancellations, seller fulfillment tasks with dispatch deadlines, timelines and purchase documents.
 *
 * Name, launch phase, dependencies, permissions, events, jobs, settings and endpoints come from
 * docs/api/spec/modules/orders.json through `spec`; the server refuses to start if they drift.
 */
export default defineModule({
  spec,
  version: '1.4.0',
  schemas,
  migrations,
  graphql: typeDefs,
  register(ctx) {
    const service = new OrdersService({ repo: createPostgresOrdersRepository(ctx.db, ctx.inbox), ctx });
    ctx.provide(service);
    ctx.http.routes(storeRoutes(service), sellerRoutes(service), adminRoutes(service));
    ctx.graphql.resolvers(resolvers(service));
    // export datasets orders.admin.orders and orders.seller.orders (reports reads rows through exportRows)
    ctx.afterBoot(() => service.admin.registerDatasets());

    // Events this module reacts to (spec events.consumes)
    ctx.events.on("payments.payment.authorized", (e) => service.onPaymentAuthorizedFromPayments(e.payload));
    ctx.events.on("payments.payment.failed", (e) => service.onPaymentFailedFromPayments(e.payload));
    ctx.events.on("payments.payment.captured", (e) => service.onPaymentCapturedFromPayments(e.payload));
    ctx.events.on("payments.refund.status_changed", (e) => service.onRefundStatusChangedFromPayments(e.payload));
    ctx.events.on("payments.refund.sent", (e) => service.onRefundSentFromPayments(e.payload));
    ctx.events.on("payments.chargeback.opened", (e) => service.onChargebackOpenedFromPayments(e.payload));
    ctx.events.on("shipping.shipment.created", (e) => service.onShipmentCreatedFromShipping(e.payload));
    ctx.events.on("shipping.shipment.dispatched", (e) => service.onShipmentDispatchedFromShipping(e.payload));
    ctx.events.on("shipping.shipment.status_changed", (e) => service.onShipmentStatusChangedFromShipping(e.payload));
    ctx.events.on("shipping.shipment.delivered", (e) => service.onShipmentDeliveredFromShipping(e.payload));
    ctx.events.on("shipping.shipment.exception", (e) => service.onShipmentExceptionFromShipping(e.payload));
    ctx.events.on("shipping.dispatch.overdue", (e) => service.onDispatchOverdueFromShipping(e.payload));
    ctx.events.on("shipping.tracking.corrected", (e) => service.onTrackingCorrectedFromShipping(e.payload));
    ctx.events.on("warehouse.fulfillment.status_changed", (e) => service.onFulfillmentStatusChangedFromWarehouse(e.payload));
    ctx.events.on("returns.return.requested", (e) => service.onReturnRequestedFromReturns(e.payload));
    ctx.events.on("returns.return.received", (e) => service.onReturnReceivedFromReturns(e.payload));
    ctx.events.on("returns.return.cancelled", (e) => service.onReturnCancelledFromReturns(e.payload));
    ctx.events.on("returns.return.rejected", (e) => service.onReturnRejectedFromReturns(e.payload));
    ctx.events.on("returns.refund.approved", (e) => service.onRefundApprovedFromReturns(e.payload));
    ctx.events.on("returns.replacement.created", (e) => service.onReplacementCreatedFromReturns(e.payload));
    ctx.events.on("support.case.opened", (e) => service.onCaseOpenedFromSupport(e.payload));
    ctx.events.on("support.case.resolved", (e) => service.onCaseResolvedFromSupport(e.payload, e.id));
    ctx.events.on("support.case.reopened", (e) => service.onCaseReopenedFromSupport(e.payload, e.id));
    ctx.events.on("sellers.seller.restricted", (e) => service.onSellerRestrictedFromSellers(e.payload));
    ctx.events.on("identity.user.verified", (e) => service.onUserVerifiedFromIdentity(e.payload));

    // Background jobs (spec jobs)
    ctx.jobs.handle("orders.auto-accept-cancellations", () => service.autoAcceptCancellations());
    ctx.jobs.handle("orders.refresh-flags", () => service.refreshFlags());
    ctx.jobs.handle("orders.complete-orders", () => service.completeOrders());
  },
});
