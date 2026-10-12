import { defineModule } from '../../kernel/module-system/index.js';
import { spec } from '../../spec/advertising.js';
import { resolvers } from './graphql/resolvers.js';
import { typeDefs } from './graphql/schema.js';
import { storeRoutes } from './http/store.js';
import { sellerRoutes } from './http/seller.js';
import { adminRoutes } from './http/admin.js';
import { createMongoAdvertisingRepository } from './infra/mongo/repository.js';
import { AdvertisingService } from './service.js';
import { schemas } from './infra/mongo/schema.js';

/**
 * Advertising: Ad placements and their rules, ad campaigns through the full lifecycle, creatives and their review, audiences, schedules, frequency caps and dismissal suppression, rotation and priority, the serving decision for each page view, display/click/dismissal tracking with attribution, and seller sponsored campaigns with spending limits and ad charges kept separate from commission.
 *
 * Name, launch phase, dependencies, permissions, events, jobs, settings and endpoints come from
 * docs/api/spec/modules/advertising.json through `spec`; the server refuses to start if they drift.
 */
export default defineModule({
  spec,
  version: '2.0.0',
  store: 'mongo',
  schemas,
  migrations: [],
  graphql: typeDefs,
  async register(ctx) {
    const service = new AdvertisingService({ repo: createMongoAdvertisingRepository(ctx.mongo), ctx });
    // install seed: the launch placements and global rules version 1 (domain/seed.ts)
    await service.seed();
    ctx.provide(service);
    ctx.http.routes(storeRoutes(service), sellerRoutes(service), adminRoutes(service));
    ctx.graphql.resolvers(resolvers(service));

    // Events this module reacts to (spec events.consumes)
    ctx.events.on("promotions.campaign.ended", (e) => service.onCampaignEndedFromPromotions(e.payload));
    ctx.events.on("promotions.campaign.paused", (e) => service.onCampaignPausedFromPromotions(e.payload));
    ctx.events.on("promotions.campaign.resumed", (e) => service.onCampaignResumedFromPromotions(e.payload));
    ctx.events.on("offers.offer.status_changed", (e) => service.onOfferStatusChangedFromOffers(e.payload));
    ctx.events.on("inventory.stock.low", (e) => service.onStockLowFromInventory(e.payload));
    ctx.events.on("inventory.stock.changed", (e) => service.onStockChangedFromInventory(e.payload));
    ctx.events.on("catalog.product.publication_changed", (e) => service.onProductPublicationChangedFromCatalog(e.payload));
    ctx.events.on("sellers.seller.restricted", (e) => service.onSellerRestrictedFromSellers(e.payload));
    ctx.events.on("sellers.seller.suspended", (e) => service.onSellerSuspendedFromSellers(e.payload));
    ctx.events.on("trust.enforcement.recorded", (e) => service.onEnforcementRecordedFromTrust(e.payload));
    ctx.events.on("trust.enforcement.reversed", (e) => service.onEnforcementReversedFromTrust(e.payload, e.id));
    ctx.events.on("orders.order.placed", (e) => service.onOrderPlacedFromOrders(e.payload));
    ctx.events.on("orders.item.cancelled", (e) => service.onItemCancelledFromOrders(e.payload));
    ctx.events.on("content.page.published", (e) => service.onPagePublishedFromContent(e.payload));
    ctx.events.on("access.approval.decided", (e) => service.onApprovalDecidedFromAccess(e.payload, e.id));
    ctx.events.on("catalog.product.merged", (e) => service.onProductMergedFromCatalog(e.payload));

    // Background jobs (spec jobs)
    ctx.jobs.handle("advertising.start-due", () => service.startDue());
    ctx.jobs.handle("advertising.finish-due", () => service.finishDue());
    ctx.jobs.handle("advertising.availability-sweep", () => service.availabilitySweep());
    ctx.jobs.handle("advertising.link-check", () => service.linkCheck());
    ctx.jobs.handle("advertising.stats-rollup", () => service.statsRollup());
    ctx.jobs.handle("advertising.accrue-charges", () => service.accrueCharges());
    ctx.jobs.handle("advertising.post-charges", () => service.postCharges());
    ctx.jobs.handle("advertising.expire-frequency-state", () => service.expireFrequencyState());
    ctx.jobs.handle("advertising.ending-soon-notice", () => service.endingSoonNotice());
  },
});
