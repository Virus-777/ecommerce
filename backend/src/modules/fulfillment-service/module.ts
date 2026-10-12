import { defineModule } from '../../kernel/module-system/index.js';
import { spec } from '../../spec/fulfillment-service.js';
import { sellerRoutes } from './http/seller.js';
import { adminRoutes } from './http/admin.js';
import { seed } from './domain/seed.js';
import { createMongoFulfillmentServiceRepository } from './infra/mongo/repository.js';
import { FulfillmentServiceService } from './service.js';
import { schemas } from './infra/mongo/schema.js';

/**
 * Fulfillment service: Platform storage and shipping for sellers: seller enrollment under service terms, SKU enrollment, inbound shipments to our warehouse, receiving into seller-owned stock, picking and shipping by us while the seller stays the seller of record, returns handling, removal of stock, and storage and handling fees with full seller visibility.
 *
 * Name, launch phase, dependencies, permissions, events, jobs, settings and endpoints come from
 * docs/api/spec/modules/fulfillment-service.json through `spec`; the server refuses to start if they drift.
 */
export default defineModule({
  spec,
  version: '2.0.0',
  schemas,
  async register(ctx) {
    const repo = createMongoFulfillmentServiceRepository(ctx.mongo);
    // the example fee schedule (domain/seed.ts)
    await seed(repo);
    const service = new FulfillmentServiceService({ repo, ctx });
    ctx.provide(service);
    ctx.http.routes(sellerRoutes(service), adminRoutes(service));
    // the report datasets (K16), once every module has registered
    ctx.afterBoot(() => service.parts.exports.registerDatasets());

    // Events this module reacts to (spec events.consumes)
    ctx.events.on("orders.order.accepted", (e) => service.onOrderAcceptedFromOrders(e.payload));
    ctx.events.on("orders.order.cancelled", (e) => service.onOrderCancelledFromOrders(e.payload));
    ctx.events.on("orders.item.cancelled", (e) => service.onItemCancelledFromOrders(e.payload));
    ctx.events.on("orders.item.split", (e) => service.onItemSplitFromOrders(e.payload));
    ctx.events.on("shipping.shipment.dispatched", (e) => service.onShipmentDispatchedFromShipping(e.payload));
    ctx.events.on("warehouse.fulfillment.status_changed", (e) => service.onFulfillmentStatusChangedFromWarehouse(e.payload));
    ctx.events.on("returns.return.received", (e) => service.onReturnReceivedFromReturns(e.payload));
    ctx.events.on("returns.return.inspected", (e) => service.onReturnInspectedFromReturns(e.payload));
    ctx.events.on("inventory.receipt.confirmed", (e) => service.onReceiptConfirmedFromInventory(e.payload));
    ctx.events.on("inventory.adjustment.recorded", (e) => service.onAdjustmentRecordedFromInventory(e.payload));
    ctx.events.on("inventory.stock.low", (e) => service.onStockLowFromInventory(e.payload));
    ctx.events.on("sellers.seller.suspended", (e) => service.onSellerSuspendedFromSellers(e.payload));
    ctx.events.on("sellers.seller.reinstated", (e) => service.onSellerReinstatedFromSellers(e.payload));
    ctx.events.on("sellers.seller.closed", (e) => service.onSellerClosedFromSellers(e.payload));
    ctx.events.on("access.approval.decided", (e) => service.onApprovalDecidedFromAccess(e.payload, e.id));

    // Background jobs (spec jobs)
    ctx.jobs.handle("fulfillment-service.storage-snapshot", () => service.storageSnapshot());
    ctx.jobs.handle("fulfillment-service.monthly-storage-fees", () => service.monthlyStorageFees());
    ctx.jobs.handle("fulfillment-service.post-fees", () => service.postFees());
    ctx.jobs.handle("fulfillment-service.inbound-overdue", () => service.inboundOverdue());
    ctx.jobs.handle("fulfillment-service.aged-stock-notice", () => service.agedStockNotice());
    ctx.jobs.handle("fulfillment-service.reconcile", () => service.reconcile());
  },
});
