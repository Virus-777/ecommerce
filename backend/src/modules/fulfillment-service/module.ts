import { defineModule } from '../../kernel/module-system/index.js';
import { spec } from '../../spec/fulfillment-service.js';
import { sellerRoutes } from './http/seller.js';
import { adminRoutes } from './http/admin.js';
import { migrations } from './infra/postgres/migrations/index.js';
import { createPostgresFulfillmentServiceRepository } from './infra/postgres/repository.js';
import { FulfillmentServiceService } from './service.js';

/**
 * Fulfillment service: Platform storage and shipping for sellers: seller enrollment under service terms, SKU enrollment, inbound shipments to our warehouse, receiving into seller-owned stock, picking and shipping by us while the seller stays the seller of record, returns handling, removal of stock, and storage and handling fees with full seller visibility.
 *
 * Name, launch phase, dependencies, permissions, events, jobs, settings and endpoints come from
 * docs/api/spec/modules/fulfillment-service.json through `spec`; the server refuses to start if they drift.
 */
export default defineModule({
  spec,
  version: '1.0.0',
  migrations,
  register(ctx) {
    const service = new FulfillmentServiceService({ repo: createPostgresFulfillmentServiceRepository(ctx.db), ctx });
    ctx.provide(service);
    ctx.http.routes(sellerRoutes(service), adminRoutes(service));

    // Events this module reacts to (spec events.consumes)
    ctx.events.on("orders.order.placed", (e) => service.onOrderPlacedFromOrders(e.payload));
    ctx.events.on("orders.item.cancelled", (e) => service.onItemCancelledFromOrders(e.payload));
    ctx.events.on("shipping.shipment.dispatched", (e) => service.onShipmentDispatchedFromShipping(e.payload));
    ctx.events.on("returns.return.received", (e) => service.onReturnReceivedFromReturns(e.payload));
    ctx.events.on("inventory.stock.low", (e) => service.onStockLowFromInventory(e.payload));
    ctx.events.on("sellers.seller.suspended", (e) => service.onSellerSuspendedFromSellers(e.payload));
    ctx.events.on("sellers.seller.closed", (e) => service.onSellerClosedFromSellers(e.payload));
    ctx.events.on("access.approval.decided", (e) => service.onApprovalDecidedFromAccess(e.payload));

    // Background jobs (spec jobs)
    ctx.jobs.handle("fulfillment-service.storage-snapshot", () => service.storageSnapshot());
    ctx.jobs.handle("fulfillment-service.monthly-storage-fees", () => service.monthlyStorageFees());
    ctx.jobs.handle("fulfillment-service.post-fees", () => service.postFees());
    ctx.jobs.handle("fulfillment-service.inbound-overdue", () => service.inboundOverdue());
    ctx.jobs.handle("fulfillment-service.aged-stock-notice", () => service.agedStockNotice());
    ctx.jobs.handle("fulfillment-service.reconcile", () => service.reconcile());
  },
});
