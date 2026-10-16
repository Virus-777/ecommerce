import { defineModule } from '../../kernel/module-system/index.js';
import { spec } from '../../spec/search.js';
import { resolvers } from './graphql/resolvers.js';
import { storeRoutes } from './http/store.js';
import { sellerRoutes } from './http/seller.js';
import { adminRoutes } from './http/admin.js';
import { selectSearchEngine } from './engine-select.js';
import { SearchService } from './service.js';
import { schemas } from './schema.js';

/**
 * Search: Finding products: a product index built from catalog, offers, inventory and reviews events; search with misspelling tolerance and corrections, suggestions (queries, categories, brands, stores, products, recent searches), universal and category filters with counts, sorting, sponsored slots from advertising, and guidance for empty or unavailable results.
 *
 * Name, launch phase, dependencies, permissions, events, jobs, settings and endpoints come from
 * docs/api/spec/modules/search.json through `spec`; the server refuses to start if they drift.
 */
export default defineModule({
  spec,
  version: '2.1.1',
  schemas,
  register(ctx) {
    // SEARCH_ENGINE: mongo (stemmed words and prefixes over the read model; development and tests) or opensearch (production)
    const { repo, engine } = selectSearchEngine(ctx);
    ctx.log.debug({ engine: engine.name }, 'search: engine');
    const service = new SearchService({ repo, engine, ctx });
    ctx.provide(service);
    // an engine with its own index: a new or outdated index is filled by a queued full reindex (in the background: never blocks startup)
    if (engine.feed) ctx.afterBoot(() => void service.bootstrapEngineIndex().catch((err) => ctx.log.warn({ err }, 'search: could not check the search engine index')));
    ctx.http.routes(storeRoutes(service), sellerRoutes(service), adminRoutes(service));
    ctx.graphql.resolvers(resolvers(service));

    // Events this module reacts to (spec events.consumes)
    ctx.events.on("catalog.product.approved", (e) => service.onProductApprovedFromCatalog(e.payload));
    ctx.events.on("catalog.product.publication_changed", (e) => service.onProductPublicationChangedFromCatalog(e.payload));
    ctx.events.on("catalog.product.updated", (e) => service.onProductUpdatedFromCatalog(e.payload));
    ctx.events.on("catalog.product.merged", (e) => service.onProductMergedFromCatalog(e.payload));
    ctx.events.on("media.product_images.rebuilt", (e) => service.onProductImagesRebuiltFromMedia(e.payload));
    ctx.events.on("offers.offer.created", (e) => service.onOfferCreatedFromOffers(e.payload));
    ctx.events.on("offers.offer.price_changed", (e) => service.onOfferPriceChangedFromOffers(e.payload));
    ctx.events.on("offers.offer.status_changed", (e) => service.onOfferStatusChangedFromOffers(e.payload));
    ctx.events.on("offers.featured.changed", (e) => service.onFeaturedChangedFromOffers(e.payload));
    ctx.events.on("inventory.stock.changed", (e) => service.onStockChangedFromInventory(e.payload));
    ctx.events.on("reviews.review.published", (e) => service.onReviewPublishedFromReviews(e.payload));
    ctx.events.on("sellers.seller.approved", (e) => service.onSellerApprovedFromSellers(e.payload));
    ctx.events.on("sellers.seller.restricted", (e) => service.onSellerRestrictedFromSellers(e.payload));
    ctx.events.on("sellers.seller.suspended", (e) => service.onSellerSuspendedFromSellers(e.payload));
    ctx.events.on("sellers.seller.reinstated", (e) => service.onSellerReinstatedFromSellers(e.payload));
    ctx.events.on("sellers.seller.closed", (e) => service.onSellerClosedFromSellers(e.payload));
    ctx.events.on("promotions.campaign.started", (e) => service.onCampaignStartedFromPromotions(e.payload));
    ctx.events.on("promotions.campaign.ended", (e) => service.onCampaignEndedFromPromotions(e.payload));
    ctx.events.on("orders.order.placed", (e) => service.onOrderPlacedFromOrders(e.payload));
    ctx.events.on("orders.order.cancelled", (e) => service.onOrderCancelledFromOrders(e.payload));
    ctx.events.on("identity.guest_session.claimed", (e) => service.onGuestSessionClaimedFromIdentity(e.payload));
    ctx.events.on("catalog.brand.changed", (e) => service.onBrandChangedFromCatalog(e.payload));
    ctx.events.on("customers.marketing_preferences.changed", (e) => service.onMarketingPreferencesChangedFromCustomers(e.payload));

    // Background jobs (spec jobs)
    ctx.jobs.handle("search.process-dirty", () => service.processDirty());
    ctx.jobs.handle("search.refresh-delivery-flags", () => service.refreshDeliveryFlags());
    ctx.jobs.handle("search.refresh-suggestions", () => service.refreshSuggestions());
    ctx.jobs.handle("search.full-reindex", () => service.fullReindex());
    ctx.jobs.handle("search.sales-counts", () => service.salesCounts());
    ctx.jobs.handle("search.prune-logs", () => service.pruneLogs());
  },
});
