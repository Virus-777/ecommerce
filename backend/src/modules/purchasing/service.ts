import { notImplemented } from '../../kernel/errors/index.js';
import type { EventPayload } from '../../kernel/events/index.js';
import type { ModuleContext } from '../../kernel/module-system/index.js';
import type * as common from '../../spec/common.js';
import type * as identity from '../../spec/identity.js';
import type { PurchasingPublicApi } from '../../spec/purchasing.js';
import type { PurchasingRepository } from './ports.js';

export interface PurchasingServiceDeps {
  repo: PurchasingRepository;
  ctx: ModuleContext<'purchasing'>;
}

/**
 * Purchasing use cases. Depends only on ports, the event bus, the clock and other modules' public APIs.
 * Each method maps to a publicApi function, a consumed event or a job in docs/api/spec/modules/purchasing.json.
 */
export class PurchasingService implements PurchasingPublicApi {
  constructor(protected readonly deps: PurchasingServiceDeps) {}

  /* ---------------- public API (in-process) */

  /** Used when a return outcome is 'return to supplier' */
  async getPreferredSupplier(stockItemId: string): Promise<{ supplierId: string, name: string, supplierSku: string|null, unitCost: common.Money, returnAuthorizationRequired: boolean } | null> {
    throw notImplemented("purchasing.getPreferredSupplier");
  }

  /** Incoming detail for stock screens and restock estimates */
  async getOpenPurchaseOrders(stockItemId: string): Promise<{ purchaseOrderId: string, ref: string, quantityOpen: number, expectedDate: string|null }[]> {
    throw notImplemented("purchasing.getOpenPurchaseOrders");
  }

  /** Export rows for reports dataset purchasing.admin.receiving (receiving records) */
  async exportRows(dataset: string, filters: unknown, principal: identity.Principal, cursor?: string): Promise<{ rows: unknown[], nextCursor?: string }> {
    throw notImplemented("purchasing.exportRows");
  }

  /* ---------------- events consumed */

  /** inventory.receipt.confirmed: Mark the receipt confirmed (who made the stock sellable) and add it to the PO timeline */
  async onReceiptConfirmedFromInventory(event: EventPayload<"inventory.receipt.confirmed">): Promise<void> {
    throw notImplemented("purchasing consumer of inventory.receipt.confirmed");
  }

  /** inventory.stock.low: Refresh reorder suggestions for company stock items */
  async onStockLowFromInventory(event: EventPayload<"inventory.stock.low">): Promise<void> {
    throw notImplemented("purchasing consumer of inventory.stock.low");
  }

  /** access.approval.decided: Send an approved PO; record a rejection on the PO timeline */
  async onApprovalDecidedFromAccess(event: EventPayload<"access.approval.decided">): Promise<void> {
    throw notImplemented("purchasing consumer of access.approval.decided");
  }

  /* ---------------- jobs */

  /** Job purchasing.flag-late-deliveries (every 30 min): Deliveries past windowTo + grace without arrival → delayed; publish purchasing.delivery.late (work queue for the Purchasing Manager) */
  async flagLateDeliveries(): Promise<void> {
    throw notImplemented("job purchasing.flag-late-deliveries");
  }

  /** Job purchasing.supplier-performance (nightly 02:30 market time): Recompute on-time %, average lead time, shortage and damage rates per supplier over the window */
  async supplierPerformance(): Promise<void> {
    throw notImplemented("job purchasing.supplier-performance");
  }

  /** Job purchasing.reorder-suggestions (hourly): Rebuild suggestions from inventory low stock, incoming quantities and 30-day sales velocity */
  async reorderSuggestions(): Promise<void> {
    throw notImplemented("job purchasing.reorder-suggestions");
  }
}
