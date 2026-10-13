import { defineModule } from '../../kernel/module-system/index.js';
import { spec } from '../../spec/purchasing.js';
import { adminRoutes } from './http/admin.js';
import { PurchasingRepository } from './repository.js';
import { PurchasingService } from './service.js';
import { schemas } from './schema.js';

/**
 * Purchasing: Buying stock for the Official Store: suppliers and their price lists, purchase orders (Draft, Sent, Partly received, Received, Cancelled) with buying costs and expected deliveries, receiving records (expected vs received, shortages, damage) that feed inventory, and supplier claims.
 *
 * Name, launch phase, dependencies, permissions, events, jobs, settings and endpoints come from
 * docs/api/spec/modules/purchasing.json through `spec`; the server refuses to start if they drift.
 */
export default defineModule({
  spec,
  version: '2.0.0',
  schemas,
  register(ctx) {
    const service = new PurchasingService({ repo: new PurchasingRepository(ctx.mongo), ctx });
    ctx.provide(service);
    ctx.http.routes(adminRoutes(service));

    // Events this module reacts to (spec events.consumes)
    ctx.events.on("inventory.receipt.confirmed", (e) => service.onReceiptConfirmedFromInventory(e.payload, { at: e.at }));
    ctx.events.on("inventory.stock.low", (e) => service.onStockLowFromInventory(e.payload));
    ctx.events.on("access.approval.decided", (e) => service.onApprovalDecidedFromAccess(e.payload));

    // Background jobs (spec jobs)
    ctx.jobs.handle("purchasing.flag-late-deliveries", () => service.flagLateDeliveries());
    ctx.jobs.handle("purchasing.supplier-performance", () => service.supplierPerformance());
    ctx.jobs.handle("purchasing.reorder-suggestions", () => service.reorderSuggestions());

    // reports reads the receiving export through exportRows
    ctx.afterBoot(() => service.registerExportDataset());
  },
});
