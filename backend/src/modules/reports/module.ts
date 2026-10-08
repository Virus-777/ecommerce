import { defineModule } from '../../kernel/module-system/index.js';
import { spec } from '../../spec/reports.js';
import { resolvers } from './graphql/resolvers.js';
import { typeDefs } from './graphql/schema.js';
import { storeRoutes } from './http/store.js';
import { sellerRoutes } from './http/seller.js';
import { adminRoutes } from './http/admin.js';
import { migrations } from './infra/postgres/migrations/index.js';
import { createPostgresReportsRepository } from './infra/postgres/repository.js';
import { ReportsService } from './service.js';

/**
 * Reports: Business reporting with stated meanings: metric definitions with a named owner and versions, a report catalogue grouped by business area, report queries with an explicit date basis, currency and time zone, the admin and seller dashboards, and authorized export jobs. All figures come from read models fed by other modules' events, never from their tables.
 *
 * Name, launch phase, dependencies, permissions, events, jobs, settings and endpoints come from
 * docs/api/spec/modules/reports.json through `spec`; the server refuses to start if they drift.
 */
export default defineModule({
  spec,
  version: '0.1.0',
  migrations,
  graphql: typeDefs,
  register(ctx) {
    const repo = createPostgresReportsRepository(ctx.db);
    const service = new ReportsService({ repo, ctx });
    ctx.provide(service);
    ctx.http.routes(storeRoutes(service), sellerRoutes(service), adminRoutes(service));
    ctx.graphql.resolvers(resolvers(service));

    // Events this module reacts to (spec events.consumes)
    ctx.events.on("orders.order.placed", (e) => service.onOrderPlacedFromOrders(e.payload));
    ctx.events.on("orders.order.accepted", (e) => service.onOrderAcceptedFromOrders(e.payload));
    ctx.events.on("payments.payment.captured", (e) => service.onPaymentCapturedFromPayments(e.payload));
    ctx.events.on("shipping.shipment.dispatched", (e) => service.onShipmentDispatchedFromShipping(e.payload));
    ctx.events.on("shipping.dispatch.overdue", (e) => service.onDispatchOverdueFromShipping(e.payload));
    ctx.events.on("shipping.shipment.exception", (e) => service.onShipmentExceptionFromShipping(e.payload));
    ctx.events.on("orders.item.delivered", (e) => service.onItemDeliveredFromOrders(e.payload));
    ctx.events.on("orders.order.completed", (e) => service.onOrderCompletedFromOrders(e.payload));
    ctx.events.on("orders.item.cancelled", (e) => service.onItemCancelledFromOrders(e.payload));
    ctx.events.on("payments.refund.sent", (e) => service.onRefundSentFromPayments(e.payload));
    ctx.events.on("returns.return.requested", (e) => service.onReturnRequestedFromReturns(e.payload));
    ctx.events.on("returns.return.inspected", (e) => service.onReturnInspectedFromReturns(e.payload));
    ctx.events.on("inventory.stock.changed", (e) => service.onStockChangedFromInventory(e.payload));
    ctx.events.on("cart.item.added", (e) => service.onItemAddedFromCart(e.payload));
    ctx.events.on("messaging.message.sent", (e) => service.onMessageSentFromMessaging(e.payload));
    ctx.events.on("support.case.opened", (e) => service.onCaseOpenedFromSupport(e.payload));
    ctx.events.on("support.case.resolved", (e) => service.onCaseResolvedFromSupport(e.payload));
    ctx.events.on("finance.payout.paid", (e) => service.onPayoutPaidFromFinance(e.payload));
    ctx.events.on("finance.payout.failed", (e) => service.onPayoutFailedFromFinance(e.payload));
    ctx.events.on("finance.hold.placed", (e) => service.onHoldPlacedFromFinance(e.payload));
    ctx.events.on("finance.hold.released", (e) => service.onHoldReleasedFromFinance(e.payload));
    ctx.events.on("finance.amount_owed.created", (e) => service.onAmountOwedCreatedFromFinance(e.payload));
    ctx.events.on("promotions.coupon.redeemed", (e) => service.onCouponRedeemedFromPromotions(e.payload));
    ctx.events.on("promotions.redemption.reversed", (e) => service.onRedemptionReversedFromPromotions(e.payload));
    ctx.events.on("advertising.charge.posted", (e) => service.onChargePostedFromAdvertising(e.payload));
    ctx.events.on("advertising.charge.credited", (e) => service.onChargeCreditedFromAdvertising(e.payload));

    // Background jobs (spec jobs)
    ctx.jobs.handle("reports.run-exports", () => service.runExports());
    ctx.jobs.handle("reports.expire-exports", () => service.expireExports());
    ctx.jobs.handle("reports.pull-daily", () => service.pullDaily());
    ctx.jobs.handle("reports.run-schedules", () => service.runSchedules());
    ctx.jobs.handle("reports.check-lag", () => service.checkLag());
  },
});
