import { defineModule } from '../../kernel/module-system/index.js';
import { spec } from '../../spec/reports.js';
import { resolvers } from './graphql/resolvers.js';
import { typeDefs } from './graphql/schema.js';
import { storeRoutes } from './http/store.js';
import { sellerRoutes } from './http/seller.js';
import { adminRoutes } from './http/admin.js';
import { createMongoReportsRepository } from './infra/mongo/repository.js';
import { ReportsService } from './service.js';
import { schemas } from './infra/mongo/schema.js';

/**
 * Reports: Business reporting with stated meanings: metric definitions with a named owner and versions, a report catalogue grouped by business area, report queries with an explicit date basis, currency and time zone, the admin and seller dashboards, and authorized export jobs. All figures come from read models fed by other modules' events, never from their tables.
 *
 * Name, launch phase, dependencies, permissions, events, jobs, settings and endpoints come from
 * docs/api/spec/modules/reports.json through `spec`; the server refuses to start if they drift.
 */
export default defineModule({
  spec,
  version: '2.0.0',
  store: 'mongo',
  schemas,
  migrations: [],
  graphql: typeDefs,
  register(ctx) {
    const service = new ReportsService({ repo: createMongoReportsRepository(ctx.mongo), ctx });
    ctx.provide(service);
    ctx.http.routes(storeRoutes(service), sellerRoutes(service), adminRoutes(service));
    ctx.graphql.resolvers(resolvers(service));
    // the report library, metric definitions and the export registry; owners register their columns at their own boot
    ctx.afterBoot(() => service.seed());

    // Events this module reacts to (spec events.consumes)
    ctx.events.on("orders.order.placed", (e) => service.onOrderPlacedFromOrders(e.payload, e));
    ctx.events.on("orders.order.accepted", (e) => service.onOrderAcceptedFromOrders(e.payload, e));
    ctx.events.on("payments.payment.captured", (e) => service.onPaymentCapturedFromPayments(e.payload, e));
    ctx.events.on("shipping.shipment.dispatched", (e) => service.onShipmentDispatchedFromShipping(e.payload, e));
    ctx.events.on("shipping.dispatch.overdue", (e) => service.onDispatchOverdueFromShipping(e.payload, e));
    ctx.events.on("shipping.shipment.exception", (e) => service.onShipmentExceptionFromShipping(e.payload, e));
    ctx.events.on("orders.item.delivered", (e) => service.onItemDeliveredFromOrders(e.payload, e));
    ctx.events.on("orders.order.completed", (e) => service.onOrderCompletedFromOrders(e.payload, e));
    ctx.events.on("orders.item.cancelled", (e) => service.onItemCancelledFromOrders(e.payload, e));
    ctx.events.on("payments.refund.sent", (e) => service.onRefundSentFromPayments(e.payload, e));
    ctx.events.on("returns.return.requested", (e) => service.onReturnRequestedFromReturns(e.payload, e));
    ctx.events.on("returns.return.inspected", (e) => service.onReturnInspectedFromReturns(e.payload, e));
    ctx.events.on("inventory.stock.changed", (e) => service.onStockChangedFromInventory(e.payload, e));
    ctx.events.on("cart.item.added", (e) => service.onItemAddedFromCart(e.payload, e));
    ctx.events.on("messaging.message.sent", (e) => service.onMessageSentFromMessaging(e.payload, e));
    ctx.events.on("support.case.opened", (e) => service.onCaseOpenedFromSupport(e.payload, e));
    ctx.events.on("support.case.resolved", (e) => service.onCaseResolvedFromSupport(e.payload, e));
    ctx.events.on("finance.payout.paid", (e) => service.onPayoutPaidFromFinance(e.payload, e));
    ctx.events.on("finance.payout.failed", (e) => service.onPayoutFailedFromFinance(e.payload, e));
    ctx.events.on("finance.hold.placed", (e) => service.onHoldPlacedFromFinance(e.payload, e));
    ctx.events.on("finance.hold.released", (e) => service.onHoldReleasedFromFinance(e.payload, e));
    ctx.events.on("finance.amount_owed.created", (e) => service.onAmountOwedCreatedFromFinance(e.payload, e));
    ctx.events.on("promotions.coupon.redeemed", (e) => service.onCouponRedeemedFromPromotions(e.payload, e));
    ctx.events.on("promotions.redemption.reversed", (e) => service.onRedemptionReversedFromPromotions(e.payload, e));
    ctx.events.on("advertising.charge.posted", (e) => service.onChargePostedFromAdvertising(e.payload, e));
    ctx.events.on("advertising.charge.credited", (e) => service.onChargeCreditedFromAdvertising(e.payload, e));
    ctx.events.on("fulfillment-service.fee.charged", (e) => service.onFeeChargedFromFulfillmentService(e.payload, e));
    ctx.events.on("fulfillment-service.fee.reversed", (e) => service.onFeeReversedFromFulfillmentService(e.payload, e));

    // Background jobs (spec jobs)
    ctx.jobs.handle("reports.run-exports", () => service.runExports());
    ctx.jobs.handle("reports.expire-exports", () => service.expireExports());
    ctx.jobs.handle("reports.pull-daily", () => service.pullDaily());
    ctx.jobs.handle("reports.run-schedules", () => service.runSchedules());
    ctx.jobs.handle("reports.check-lag", () => service.checkLag());
  },
});
