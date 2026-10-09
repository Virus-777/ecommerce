import { defineModule } from '../../kernel/module-system/index.js';
import { spec } from '../../spec/reviews.js';
import { resolvers } from './graphql/resolvers.js';
import { typeDefs } from './graphql/schema.js';
import { storeRoutes } from './http/store.js';
import { sellerRoutes } from './http/seller.js';
import { adminRoutes } from './http/admin.js';
import { migrations } from './infra/postgres/migrations/index.js';
import { createPostgresReviewsRepository } from './infra/postgres/repository.js';
import { ReviewsService } from './service.js';

/**
 * Reviews: Product reviews (Verified Purchase), seller feedback kept separate from product reviews, public seller responses under rules, product questions and answers labelled by who answered, reports of inappropriate content, moderation with outcomes visible to reporter and author, appeals, and rating summaries for products and sellers.
 *
 * Name, launch phase, dependencies, permissions, events, jobs, settings and endpoints come from
 * docs/api/spec/modules/reviews.json through `spec`; the server refuses to start if they drift.
 */
export default defineModule({
  spec,
  version: '1.0.0',
  migrations,
  graphql: typeDefs,
  register(ctx) {
    const service = new ReviewsService({ repo: createPostgresReviewsRepository(ctx.db), ctx });
    ctx.provide(service);
    ctx.http.routes(storeRoutes(service), sellerRoutes(service), adminRoutes(service));
    ctx.graphql.resolvers(resolvers(service));

    // Events this module reacts to (spec events.consumes)
    ctx.events.on("orders.item.delivered", (e) => service.onItemDeliveredFromOrders(e.payload));
    ctx.events.on("orders.item.cancelled", (e) => service.onItemCancelledFromOrders(e.payload));
    ctx.events.on("catalog.product.merged", (e) => service.onProductMergedFromCatalog(e.payload));
    ctx.events.on("trust.enforcement.recorded", (e) => service.onEnforcementRecordedFromTrust(e.payload));
    ctx.events.on("sellers.seller.closed", (e) => service.onSellerClosedFromSellers(e.payload));

    // Background jobs (spec jobs)
    ctx.jobs.handle("reviews.invites", () => service.invites());
    ctx.jobs.handle("reviews.summaries", () => service.summariesJob());
    ctx.jobs.handle("reviews.moderation-sla", () => service.moderationSla());
  },
});
