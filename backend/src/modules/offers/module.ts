import { defineModule } from '../../kernel/module-system/index.js';
import { spec } from '../../spec/offers.js';
import { resolvers } from './graphql/resolvers.js';
import { typeDefs } from './graphql/schema.js';
import { storeRoutes } from './http/store.js';
import { sellerRoutes } from './http/seller.js';
import { adminRoutes } from './http/admin.js';
import { mediaBulkFileReader } from './infra/files/media.js';
import { createMongoOffersRepository } from './infra/mongo/repository.js';
import { OffersService } from './service.js';
import { schemas } from './infra/mongo/schema.js';

/**
 * Offers: How one seller (or the Official Store) sells one variant in one condition: price and authentic was-price, purchase limit, seller SKU, dispatch, shipping profile, return and warranty terms, offer status, and the published featured-offer rule that picks the main offer for a delivery location.
 *
 * Name, launch phase, dependencies, permissions, events, jobs, settings and endpoints come from
 * docs/api/spec/modules/offers.json through `spec`; the server refuses to start if they drift.
 */
export default defineModule({
  spec,
  version: '2.0.0',
  store: 'mongo',
  schemas,
  migrations: [],
  graphql: typeDefs,
  register(ctx) {
    const service = new OffersService({ repo: createMongoOffersRepository(ctx.mongo), ctx, files: mediaBulkFileReader(ctx) });
    ctx.provide(service);
    ctx.http.routes(storeRoutes(service), sellerRoutes(service), adminRoutes(service));
    ctx.graphql.resolvers(resolvers(service));
    ctx.afterBoot(() => service.views.registerDatasets().catch((err) => ctx.log.warn({ err }, 'offers: export datasets not registered; retried on first export')));

    // Events this module reacts to (spec events.consumes)
    ctx.events.on("sellers.seller.restricted", (e) => service.onSellerRestrictedFromSellers(e.payload, e));
    ctx.events.on("sellers.restriction.updated", (e) => service.onRestrictionUpdatedFromSellers(e.payload));
    ctx.events.on("sellers.restriction.lifted", (e) => service.onRestrictionLiftedFromSellers(e.payload));
    ctx.events.on("sellers.seller.suspended", (e) => service.onSellerSuspendedFromSellers(e.payload));
    ctx.events.on("sellers.seller.reinstated", (e) => service.onSellerReinstatedFromSellers(e.payload));
    ctx.events.on("sellers.launch_review.decided", (e) => service.onLaunchReviewDecidedFromSellers(e.payload));
    ctx.events.on("sellers.seller.closed", (e) => service.onSellerClosedFromSellers(e.payload));
    ctx.events.on("catalog.product.publication_changed", (e) => service.onProductPublicationChangedFromCatalog(e.payload));
    ctx.events.on("catalog.product.approved", (e) => service.onProductApprovedFromCatalog(e.payload));
    ctx.events.on("catalog.product.merged", (e) => service.onProductMergedFromCatalog(e.payload));
    ctx.events.on("catalog.product.updated", (e) => service.onProductUpdatedFromCatalog(e.payload));
    ctx.events.on("inventory.stock.changed", (e) => service.onStockChangedFromInventory(e.payload));
    ctx.events.on("access.approval.decided", (e) => service.onApprovalDecidedFromAccess(e.payload));
    ctx.events.on("trust.enforcement.recorded", (e) => service.onEnforcementRecordedFromTrust(e.payload, e));
    ctx.events.on("trust.enforcement.reversed", (e) => service.onEnforcementReversedFromTrust(e.payload, e));
    ctx.events.on("promotions.campaign.started", (e) => service.onCampaignStartedFromPromotions(e.payload));
    ctx.events.on("promotions.campaign.ended", (e) => service.onCampaignEndedFromPromotions(e.payload));
    ctx.events.on("fulfillment-service.offer.service_changed", (e) => service.onServiceChangedFromFulfillmentService(e.payload, e));

    // Background jobs (spec jobs)
    ctx.jobs.handle("offers.apply-price-schedule", () => service.applyPriceSchedule());
    ctx.jobs.handle("offers.recompute-featured", () => service.recomputeFeatured());
    ctx.jobs.handle("offers.reevaluate-eligibility", () => service.reevaluateEligibility());
    ctx.jobs.handle("offers.verify-compare-at", () => service.verifyCompareAt());
    ctx.jobs.handle("offers.expire-bulk-previews", () => service.expireBulkPreviews());
    ctx.jobs.handle("offers.parse-bulk-file", () => service.parseBulkFile());
  },
});
