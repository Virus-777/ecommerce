import { defineModule } from '../../kernel/module-system/index.js';
import { spec } from '../../spec/cart.js';
import { resolvers } from './graphql/resolvers.js';
import { storeRoutes } from './http/store.js';
import { adminRoutes } from './http/admin.js';
import { CartRepository } from './repository.js';
import { schemas } from './schema.js';
import { CartService } from './service.js';

/**
 * Cart: One cart across the Official Store and marketplace sellers for customers and guests. Every line is bound to the exact offer the customer chose, lines are grouped into seller packages with delivery estimates and shipping, and every read re-checks price, stock and eligibility so changes are explained per item instead of discarding the cart.
 *
 * Name, launch phase, dependencies, permissions, events, jobs, settings and endpoints come from
 * docs/api/spec/modules/cart.json through `spec`; the server refuses to start if they drift.
 */
export default defineModule({
  spec,
  version: '2.0.1',
  schemas,
  register(ctx) {
    const service = new CartService({ repo: new CartRepository(ctx.mongo), ctx });
    ctx.provide(service);
    ctx.http.routes(storeRoutes(service), adminRoutes(service));
    ctx.graphql.resolvers(resolvers(service));

    // Events this module reacts to (spec events.consumes)
    ctx.events.on("offers.offer.price_changed", (e) => service.onOfferPriceChangedFromOffers(e.payload));
    ctx.events.on("offers.offer.status_changed", (e) => service.onOfferStatusChangedFromOffers(e.payload));
    ctx.events.on("inventory.stock.changed", (e) => service.onStockChangedFromInventory(e.payload));
    ctx.events.on("sellers.seller.restricted", (e) => service.onSellerRestrictedFromSellers(e.payload));
    ctx.events.on("sellers.seller.suspended", (e) => service.onSellerSuspendedFromSellers(e.payload));
    ctx.events.on("catalog.product.publication_changed", (e) => service.onProductPublicationChangedFromCatalog(e.payload));
    ctx.events.on("identity.guest_session.claimed", (e) => service.onGuestSessionClaimedFromIdentity(e.payload));

    // Background jobs (spec jobs)
    ctx.jobs.handle("cart.recheck-queued", () => service.recheckQueued());
    ctx.jobs.handle("cart.expire-idle", () => service.expireIdle());
  },
});
