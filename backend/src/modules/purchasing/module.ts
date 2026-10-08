import { defineModule } from '../../kernel/module-system/index.js';
import { spec } from '../../spec/purchasing.js';
import { adminRoutes } from './http/admin.js';
import { migrations } from './infra/postgres/migrations/index.js';
import { createPostgresPurchasingRepository } from './infra/postgres/repository.js';
import { PurchasingService } from './service.js';

/**
 * Purchasing: Buying stock for the Official Store: suppliers and their price lists, purchase orders (Draft, Sent, Partly received, Received, Cancelled) with buying costs and expected deliveries, receiving records (expected vs received, shortages, damage) that feed inventory, and supplier claims.
 *
 * Name, launch phase, dependencies, permissions, events, jobs, settings and endpoints come from
 * docs/api/spec/modules/purchasing.json through `spec`; the server refuses to start if they drift.
 */
export default defineModule({
  spec,
  version: '0.1.0',
  migrations,
  register(ctx) {
    const service = new PurchasingService({ repo: createPostgresPurchasingRepository(ctx.db), ctx });
    ctx.provide(service);
    ctx.http.routes(adminRoutes(service));

    // Events this module reacts to (spec events.consumes)
    ctx.events.on("inventory.receipt.confirmed", (e) => service.onReceiptConfirmedFromInventory(e.payload));
    ctx.events.on("inventory.stock.low", (e) => service.onStockLowFromInventory(e.payload));
    ctx.events.on("access.approval.decided", (e) => service.onApprovalDecidedFromAccess(e.payload));

    // Background jobs (spec jobs)
    ctx.jobs.handle("purchasing.flag-late-deliveries", () => service.flagLateDeliveries());
    ctx.jobs.handle("purchasing.supplier-performance", () => service.supplierPerformance());
    ctx.jobs.handle("purchasing.reorder-suggestions", () => service.reorderSuggestions());
  },
});
