import { defineModule } from '../../kernel/module-system/index.js';
import { spec } from '../../spec/catalog.js';
import { resolvers } from './graphql/resolvers.js';
import { typeDefs } from './graphql/schema.js';
import { storeRoutes } from './http/store.js';
import { sellerRoutes } from './http/seller.js';
import { adminRoutes } from './http/admin.js';
import { createMongoCatalogRepository } from './infra/mongo/repository.js';
import { CatalogService } from './service.js';
import { schemas } from './infra/mongo/schema.js';

/**
 * Catalog: What a product is: categories, attributes, brands, products, variants, and the review workflow that decides whether a product may be sold. How a seller sells it (price, stock, condition) belongs to offers.
 *
 * Name, launch phase, dependencies, permissions, events, jobs, settings and endpoints come from
 * docs/api/spec/modules/catalog.json through `spec`; the server refuses to start if they drift.
 */
export default defineModule({
  spec,
  version: '2.0.0',
  schemas,
  graphql: typeDefs,
  register(ctx) {
    const service = new CatalogService({ repo: createMongoCatalogRepository(ctx.mongo), ctx });
    ctx.provide(service);
    ctx.http.routes(storeRoutes(service), sellerRoutes(service), adminRoutes(service));
    ctx.graphql.resolvers(resolvers(service));

    // Events this module reacts to (spec events.consumes)
    ctx.events.on("access.approval.decided", (e) => service.onApprovalDecidedFromAccess(e.payload, e.id));
    ctx.events.on("sellers.seller.restricted", (e) => service.onSellerRestrictedFromSellers(e.payload));
    ctx.events.on("sellers.seller.suspended", (e) => service.onSellerSuspendedFromSellers(e.payload));
    ctx.events.on("sellers.seller.reinstated", (e) => service.onSellerReinstatedFromSellers(e.payload));
    ctx.events.on("trust.enforcement.recorded", (e) => service.onEnforcementRecordedFromTrust(e.payload));
    ctx.events.on("trust.enforcement.reversed", (e) => service.onEnforcementReversedFromTrust(e.payload));
    ctx.events.on("offers.offer.created", (e) => service.onOfferCreatedFromOffers(e.payload));
    ctx.events.on("offers.offer.status_changed", (e) => service.onOfferStatusChangedFromOffers(e.payload));
    ctx.events.on("offers.offer.price_changed", (e) => service.onOfferPriceChangedFromOffers(e.payload));
    ctx.events.on("inventory.stock.changed", (e) => service.onStockChangedFromInventory(e.payload));
    ctx.events.on("sellers.change_request.decided", (e) => service.onChangeRequestDecidedFromSellers(e.payload));

    // reports lists catalog.admin.products once every module is up
    ctx.afterBoot(() => service.registerExportDataset());

    // Background jobs (spec jobs)
    ctx.jobs.handle("catalog.refresh-counts", () => service.refreshCounts());
  },
});
