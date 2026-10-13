import type * as common from '../../spec/common.js';
import type * as identity from '../../spec/identity.js';
import type { PurchasingPublicApi } from '../../spec/purchasing.js';
import { Claims } from './service/claims.js';
import { Core, type Caller, type PurchasingServiceDeps } from './service/core.js';
import { Deliveries } from './service/deliveries.js';
import { PurchaseOrders } from './service/purchase-orders.js';
import { Receipts } from './service/receipts.js';
import { ReorderSuggestions } from './service/reorder-suggestions.js';
import { Summary } from './service/summary.js';
import { Suppliers } from './service/suppliers.js';

export type { Caller, PurchasingServiceDeps };

/**
 * Purchasing use cases. Depends only on its repository, the stock directory, the event bus, the clock and other
 * modules' public APIs. The work is split by feature (service/*.ts); handlers call `service.<feature>.<method>`, and
 * this class is the module's public API. Each method maps to an endpoint, a publicApi function, a consumed event or a
 * job in docs/api/spec/modules/purchasing.json.
 */
export class PurchasingService implements PurchasingPublicApi {
  readonly core: Core;
  readonly suppliers: Suppliers;
  readonly purchaseOrders: PurchaseOrders;
  readonly reorder: ReorderSuggestions;
  readonly deliveries: Deliveries;
  readonly receipts: Receipts;
  readonly claims: Claims;
  readonly summary: Summary;

  constructor(deps: PurchasingServiceDeps) {
    this.core = new Core(deps);
    this.suppliers = new Suppliers(this.core);
    this.purchaseOrders = new PurchaseOrders(this.core);
    this.reorder = new ReorderSuggestions(this.core);
    this.deliveries = new Deliveries(this.core);
    this.receipts = new Receipts(this.core);
    this.claims = new Claims(this.core);
    this.summary = new Summary(this.core, this.reorder);
  }

  /* ---------------- public API (in-process) */

  getPreferredSupplier(stockItemId: string): Promise<{ supplierId: string; name: string; supplierSku: string | null; unitCost: common.Money; returnAuthorizationRequired: boolean } | null> {
    return this.suppliers.getPreferredSupplier(stockItemId);
  }

  getOpenPurchaseOrders(stockItemId: string): Promise<{ purchaseOrderId: string; ref: string; quantityOpen: number; expectedDate: string | null }[]> {
    return this.purchaseOrders.getOpenPurchaseOrders(stockItemId);
  }

  exportRows(dataset: string, filters: unknown, principal: identity.Principal, cursor?: string): Promise<{ rows: unknown[]; nextCursor?: string }> {
    return this.receipts.exportRows(dataset, filters, principal, cursor);
  }
}
