import { defineModule } from '../../kernel/module-system/index.js';
import { spec } from '../../spec/wishlist.js';
import { resolvers } from './graphql/resolvers.js';
import { typeDefs } from './graphql/schema.js';
import { storeRoutes } from './http/store.js';
import { adminRoutes } from './http/admin.js';
import { migrations } from './infra/postgres/migrations/index.js';
import { createPostgresWishlistRepository } from './infra/postgres/repository.js';
import { WishlistService } from './service.js';

/**
 * Wishlist: Saved shopping for customers: saved items in one or more lists, price-drop and back-in-stock alerts, and shareable lists. Alerts are delivered through notifications under the customer's promotional preferences.
 *
 * Name, launch phase, dependencies, permissions, events, jobs, settings and endpoints come from
 * docs/api/spec/modules/wishlist.json through `spec`; the server refuses to start if they drift.
 */
export default defineModule({
  spec,
  version: '1.0.0',
  migrations,
  graphql: typeDefs,
  register(ctx) {
    const service = new WishlistService({ repo: createPostgresWishlistRepository(ctx.db), ctx });
    ctx.provide(service);
    ctx.http.routes(storeRoutes(service), adminRoutes(service));
    ctx.graphql.resolvers(resolvers(service));

    // Events this module reacts to (spec events.consumes)
    ctx.events.on("offers.offer.price_changed", (e) => service.onOfferPriceChangedFromOffers(e.payload));
    ctx.events.on("inventory.stock.changed", (e) => service.onStockChangedFromInventory(e.payload));
    ctx.events.on("offers.offer.status_changed", (e) => service.onOfferStatusChangedFromOffers(e.payload));
    ctx.events.on("catalog.product.merged", (e) => service.onProductMergedFromCatalog(e.payload));
    ctx.events.on("catalog.product.publication_changed", (e) => service.onProductPublicationChangedFromCatalog(e.payload));

    // Background jobs (spec jobs)
    ctx.jobs.handle("wishlist.evaluate-alerts", () => service.evaluateAlerts());
  },
});
