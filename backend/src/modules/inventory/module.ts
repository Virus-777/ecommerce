import { defineModule } from '../../kernel/module-system/index.js';
import { spec } from '../../spec/inventory.js';
import { resolvers } from './graphql/resolvers.js';
import { typeDefs } from './graphql/schema.js';
import { sellerRoutes } from './http/seller.js';
import { adminRoutes } from './http/admin.js';
import { migrations } from './infra/postgres/migrations/index.js';
import { createPostgresInventoryRepository } from './infra/postgres/repository.js';
import { InventoryService } from './service.js';

/**
 * Inventory: How many units exist and in which stock group: stock items per offer/SKU with Available, Reserved, Incoming, Damaged or held and Returned quantities per location, checkout holds and order allocations, an append-only movement ledger, reasoned adjustments with second review, low-stock alerts, receipt confirmation and return stock outcomes.
 *
 * Name, launch phase, dependencies, permissions, events, jobs, settings and endpoints come from
 * docs/api/spec/modules/inventory.json through `spec`; the server refuses to start if they drift.
 */
export default defineModule({
  spec,
  version: '1.1.0',
  migrations,
  graphql: typeDefs,
  register(ctx) {
    const service = new InventoryService({ repo: createPostgresInventoryRepository(ctx.db, ctx.inbox), ctx });
    ctx.provide(service);
    ctx.http.routes(sellerRoutes(service), adminRoutes(service));
    ctx.graphql.resolvers(resolvers(service));
    // export datasets served through reports (inventory.seller.stock, inventory.admin.stock)
    ctx.afterBoot(() => service.registerDatasets().catch((err) => ctx.log.warn({ err }, 'inventory: export datasets not registered; retried on first export')));

    // Events this module reacts to (spec events.consumes)
    ctx.events.on("orders.order.accepted", (e) => service.onOrderAcceptedFromOrders(e.payload));
    ctx.events.on("orders.item.cancelled", (e) => service.onItemCancelledFromOrders(e.payload));
    ctx.events.on("orders.item.split", (e) => service.onItemSplitFromOrders(e.payload));
    ctx.events.on("catalog.product.merged", (e) => service.onProductMergedFromCatalog(e.payload));
    ctx.events.on("shipping.shipment.dispatched", (e) => service.onShipmentDispatchedFromShipping(e.payload));
    ctx.events.on("returns.return.received", (e) => service.onReturnReceivedFromReturns(e.payload));
    ctx.events.on("returns.return.inspected", (e) => service.onReturnInspectedFromReturns(e.payload, e));
    ctx.events.on("warehouse.bin.assigned", (e) => service.onBinAssignedFromWarehouse(e.payload));
    ctx.events.on("offers.offer.status_changed", (e) => service.onOfferStatusChangedFromOffers(e.payload));
    ctx.events.on("sellers.seller.closed", (e) => service.onSellerClosedFromSellers(e.payload));
    ctx.events.on("access.approval.decided", (e) => service.onApprovalDecidedFromAccess(e.payload));

    // Background jobs (spec jobs)
    ctx.jobs.handle("inventory.expire-holds", () => service.expireHolds());
    ctx.jobs.handle("inventory.reconcile-reservations", () => service.reconcileReservations());
    ctx.jobs.handle("inventory.low-stock-digest", () => service.lowStockDigest());
    ctx.jobs.handle("inventory.held-stock-review", () => service.heldStockReview());
    ctx.jobs.handle("inventory.valuation-snapshot", () => service.valuationSnapshot());
  },
});
