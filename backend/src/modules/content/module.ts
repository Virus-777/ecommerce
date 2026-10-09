import { defineModule } from '../../kernel/module-system/index.js';
import { spec } from '../../spec/content.js';
import { resolvers } from './graphql/resolvers.js';
import { typeDefs } from './graphql/schema.js';
import { storeRoutes } from './http/store.js';
import { adminRoutes } from './http/admin.js';
import { migrations } from './infra/postgres/migrations/index.js';
import { createPostgresContentRepository } from './infra/postgres/repository.js';
import { ContentService } from './service.js';

/**
 * Content: Store content managed by the Content Manager: ordered and scheduled homepage sections, campaign pages and curated collections, Help Center articles and categories, policies with versions and effective dates, the About page and footer links. Every item has an owner, a preview, a publication status and schedule, a version history with restore, and a correction or removal action.
 *
 * Name, launch phase, dependencies, permissions, events, jobs, settings and endpoints come from
 * docs/api/spec/modules/content.json through `spec`; the server refuses to start if they drift.
 */
export default defineModule({
  spec,
  version: '1.0.0',
  migrations,
  graphql: typeDefs,
  register(ctx) {
    const service = new ContentService({ repo: createPostgresContentRepository(ctx.db), ctx });
    ctx.provide(service);
    ctx.http.routes(storeRoutes(service), adminRoutes(service));
    ctx.graphql.resolvers(resolvers(service));

    // Events this module reacts to (spec events.consumes)
    ctx.events.on("promotions.campaign.ended", (e) => service.onCampaignEndedFromPromotions(e.payload));
    ctx.events.on("promotions.campaign.started", (e) => service.onCampaignStartedFromPromotions(e.payload));
    ctx.events.on("catalog.product.publication_changed", (e) => service.onProductPublicationChangedFromCatalog(e.payload));
    ctx.events.on("catalog.product.merged", (e) => service.onProductMergedFromCatalog(e.payload));
    ctx.events.on("offers.offer.status_changed", (e) => service.onOfferStatusChangedFromOffers(e.payload));
    ctx.events.on("inventory.stock.changed", (e) => service.onStockChangedFromInventory(e.payload));
    ctx.events.on("sellers.seller.suspended", (e) => service.onSellerSuspendedFromSellers(e.payload));
    ctx.events.on("access.approval.decided", (e) => service.onApprovalDecidedFromAccess(e.payload));

    // ad positions from advertising (locked markers in the homepage layout), once every module is up
    ctx.afterBoot(async () => {
      try {
        await service.ensureAdPositions();
      } catch (err) {
        ctx.log.warn({ err }, 'content: ad positions not seeded');
      }
    });

    // Background jobs (spec jobs)
    ctx.jobs.handle("content.run-schedules", () => service.runSchedules());
    ctx.jobs.handle("content.policy-effective", () => service.policyEffective());
    ctx.jobs.handle("content.refresh-collections", () => service.refreshCollections());
    ctx.jobs.handle("content.article-review-due", () => service.articleReviewDue());
    ctx.jobs.handle("content.cache-warm", () => service.cacheWarm());
  },
});
