import { defineModule } from '../../kernel/module-system/index.js';
import { spec } from '../../spec/trust.js';
import { resolvers } from './graphql/resolvers.js';
import { typeDefs } from './graphql/schema.js';
import { storeRoutes } from './http/store.js';
import { sellerRoutes } from './http/seller.js';
import { adminRoutes } from './http/admin.js';
import { publicRoutes } from './http/public.js';
import { migrations } from './infra/postgres/migrations/index.js';
import { createPostgresTrustRepository } from './infra/postgres/repository.js';
import { TrustService } from './service.js';

/**
 * Trust and risk: Trust and Risk's case file: reports of counterfeit goods, suspicious orders, fake reviews and abuse from customers, sellers, staff, brand owners and automated signals, with evidence, a risk score, an investigation workflow, enforcement recommendations routed to the team that owns the action, recorded enforcement with reasons, and appeals decided by someone other than the original decider. Trust recommends; Catalog, Seller Manager, Support, Finance and the other owners act.
 *
 * Name, launch phase, dependencies, permissions, events, jobs, settings and endpoints come from
 * docs/api/spec/modules/trust.json through `spec`; the server refuses to start if they drift.
 */
export default defineModule({
  spec,
  version: '0.1.0',
  migrations,
  graphql: typeDefs,
  register(ctx) {
    const service = new TrustService({ repo: createPostgresTrustRepository(ctx.db), ctx });
    ctx.provide(service);
    ctx.http.routes(storeRoutes(service), sellerRoutes(service), adminRoutes(service), publicRoutes(service));
    ctx.graphql.resolvers(resolvers(service));

    // Events this module reacts to (spec events.consumes)
    ctx.events.on("reviews.content.referred", (e) => service.onContentReferredFromReviews(e.payload));
    ctx.events.on("messaging.message.reported", (e) => service.onMessageReportedFromMessaging(e.payload));
    ctx.events.on("orders.order.placed", (e) => service.onOrderPlacedFromOrders(e.payload));
    ctx.events.on("payments.chargeback.opened", (e) => service.onChargebackOpenedFromPayments(e.payload));
    ctx.events.on("payments.payment.failed", (e) => service.onPaymentFailedFromPayments(e.payload));
    ctx.events.on("reviews.review.published", (e) => service.onReviewPublishedFromReviews(e.payload));
    ctx.events.on("offers.offer.created", (e) => service.onOfferCreatedFromOffers(e.payload));
    ctx.events.on("catalog.product.publication_changed", (e) => service.onProductPublicationChangedFromCatalog(e.payload));
    ctx.events.on("offers.offer.status_changed", (e) => service.onOfferStatusChangedFromOffers(e.payload));
    ctx.events.on("sellers.seller.restricted", (e) => service.onSellerRestrictedFromSellers(e.payload));
    ctx.events.on("sellers.seller.suspended", (e) => service.onSellerSuspendedFromSellers(e.payload));
    ctx.events.on("sellers.appeal.submitted", (e) => service.onAppealSubmittedFromSellers(e.payload));
    ctx.events.on("sellers.appeal.decided", (e) => service.onAppealDecidedFromSellers(e.payload));
    ctx.events.on("customers.account.restricted", (e) => service.onAccountRestrictedFromCustomers(e.payload));
    ctx.events.on("customers.account.restriction_lifted", (e) => service.onAccountRestrictionLiftedFromCustomers(e.payload));
    ctx.events.on("finance.hold.placed", (e) => service.onHoldPlacedFromFinance(e.payload));
    ctx.events.on("orders.item.cancelled", (e) => service.onItemCancelledFromOrders(e.payload));
    ctx.events.on("returns.refund.approved", (e) => service.onRefundApprovedFromReturns(e.payload));
    ctx.events.on("support.case.opened", (e) => service.onCaseOpenedFromSupport(e.payload));
    ctx.events.on("sellers.application.submitted", (e) => service.onApplicationSubmittedFromSellers(e.payload));

    // Background jobs (spec jobs)
    ctx.jobs.handle("trust.run-detection", () => service.runDetection());
    ctx.jobs.handle("trust.rescore", () => service.rescore());
    ctx.jobs.handle("trust.evidence-deadlines", () => service.evidenceDeadlines());
    ctx.jobs.handle("trust.execution-check", () => service.executionCheck());
    ctx.jobs.handle("trust.appeal-deadlines", () => service.appealDeadlines());
  },
});
