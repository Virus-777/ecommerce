import { defineModule } from '../../kernel/module-system/index.js';
import { spec } from '../../spec/promotions.js';
import { resolvers } from './graphql/resolvers.js';
import { typeDefs } from './graphql/schema.js';
import { storeRoutes } from './http/store.js';
import { sellerRoutes } from './http/seller.js';
import { adminRoutes } from './http/admin.js';
import { migrations } from './infra/postgres/migrations/index.js';
import { createPostgresPromotionsRepository } from './infra/postgres/repository.js';
import { PromotionsService } from './service.js';
import { schemas } from './infra/mongo/schema.js';

/**
 * Promotions: Discounts and sales campaigns: markdowns, percentage and fixed coupons, minimum-spend and free-shipping offers, flash sales, seller discounts and platform campaigns with seller consent. Owns eligibility, stacking, budgets and caps, the funding owner of every discount, coupon clipping and redemption, the Deals page data and campaign results.
 *
 * Name, launch phase, dependencies, permissions, events, jobs, settings and endpoints come from
 * docs/api/spec/modules/promotions.json through `spec`; the server refuses to start if they drift.
 */
export default defineModule({
  spec,
  version: '1.2.0',
  schemas,
  migrations,
  graphql: typeDefs,
  register(ctx) {
    const service = new PromotionsService({ repo: createPostgresPromotionsRepository(ctx.db, ctx.inbox), ctx });
    ctx.provide(service);
    ctx.http.routes(storeRoutes(service), sellerRoutes(service), adminRoutes(service));
    ctx.graphql.resolvers(resolvers(service));
    ctx.afterBoot(() => service.campaigns.registerDataset());

    // Events this module reacts to (spec events.consumes)
    ctx.events.on("orders.order.placed", (e) => service.onOrderPlacedFromOrders(e.payload));
    ctx.events.on("orders.item.cancelled", (e) => service.onItemCancelledFromOrders(e.payload));
    ctx.events.on("returns.refund.approved", (e) => service.onRefundApprovedFromReturns(e.payload));
    ctx.events.on("orders.item.split", (e) => service.onItemSplitFromOrders(e.payload));
    ctx.events.on("payments.payment.failed", (e) => service.onPaymentFailedFromPayments(e.payload));
    ctx.events.on("offers.offer.price_changed", (e) => service.onOfferPriceChangedFromOffers(e.payload));
    ctx.events.on("offers.offer.status_changed", (e) => service.onOfferStatusChangedFromOffers(e.payload));
    ctx.events.on("inventory.stock.changed", (e) => service.onStockChangedFromInventory(e.payload));
    ctx.events.on("catalog.product.publication_changed", (e) => service.onProductPublicationChangedFromCatalog(e.payload));
    ctx.events.on("catalog.product.merged", (e) => service.onProductMergedFromCatalog(e.payload));
    ctx.events.on("sellers.seller.restricted", (e) => service.onSellerRestrictedFromSellers(e.payload));
    ctx.events.on("sellers.seller.suspended", (e) => service.onSellerSuspendedFromSellers(e.payload));
    ctx.events.on("access.approval.decided", (e) => service.onApprovalDecidedFromAccess(e.payload));

    // Background jobs (spec jobs)
    ctx.jobs.handle("promotions.start-due", () => service.startDue());
    ctx.jobs.handle("promotions.end-due", () => service.endDue());
    ctx.jobs.handle("promotions.release-expired-reservations", () => service.releaseExpiredReservations());
    ctx.jobs.handle("promotions.invitation-deadlines", () => service.invitationDeadlines());
    ctx.jobs.handle("promotions.refresh-eligible-offers", () => service.refreshEligibleOffers());
    ctx.jobs.handle("promotions.results-rollup", () => service.resultsRollup());
    ctx.jobs.handle("promotions.event-reminders", () => service.eventReminders());
  },
});
