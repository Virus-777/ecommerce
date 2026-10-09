import { defineModule } from '../../kernel/module-system/index.js';
import { spec } from '../../spec/warehouse.js';
import { resolvers } from './graphql/resolvers.js';
import { typeDefs } from './graphql/schema.js';
import { adminRoutes } from './http/admin.js';
import { migrations } from './infra/postgres/migrations/index.js';
import { createPostgresWarehouseRepository } from './infra/postgres/repository.js';
import { WarehouseService } from './service.js';

/**
 * Warehouse: Physical work for Official Store stock: bins, put-away of received goods, pick waves and pick lists by order with bin locations and scanning, packing stations (item checklist, box and weight, carrier label through shipping, packing slip), shortage and damage reports, and receipt of return parcels handed over to returns inspection.
 *
 * Name, launch phase, dependencies, permissions, events, jobs, settings and endpoints come from
 * docs/api/spec/modules/warehouse.json through `spec`; the server refuses to start if they drift.
 */
export default defineModule({
  spec,
  version: '1.0.0',
  migrations,
  graphql: typeDefs,
  register(ctx) {
    const service = new WarehouseService({ repo: createPostgresWarehouseRepository(ctx.db), ctx });
    ctx.provide(service);
    ctx.http.routes(adminRoutes(service));
    ctx.graphql.resolvers(resolvers(service));

    // Events this module reacts to (spec events.consumes)
    ctx.events.on("orders.order.accepted", (e) => service.onOrderAcceptedFromOrders(e.payload));
    ctx.events.on("orders.item.cancelled", (e) => service.onItemCancelledFromOrders(e.payload));
    ctx.events.on("inventory.discrepancy.resolved", (e) => service.onDiscrepancyResolvedFromInventory(e.payload));
    ctx.events.on("purchasing.receipt.recorded", (e) => service.onReceiptRecordedFromPurchasing(e.payload));
    ctx.events.on("returns.return.approved", (e) => service.onReturnApprovedFromReturns(e.payload));
    ctx.events.on("shipping.shipment.dispatched", (e) => service.onShipmentDispatchedFromShipping(e.payload));
    ctx.events.on("shipping.dispatch.overdue", (e) => service.onDispatchOverdueFromShipping(e.payload));

    // Background jobs (spec jobs)
    ctx.jobs.handle("warehouse.flag-at-risk", () => service.flagAtRisk());
    ctx.jobs.handle("warehouse.auto-wave", () => service.autoWave());
    ctx.jobs.handle("warehouse.overdue-return-parcels", () => service.overdueReturnParcels());
  },
});
