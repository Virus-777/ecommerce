/**
 * What the purchasing service needs from the outside world, database-agnostic.
 * The Postgres adapter lives in infra/postgres/; a MongoDB switch would add infra/mongo/.
 */
import type { Page, PageRequest } from '../../kernel/lib/pagination.js';
import type * as common from '../../spec/common.js';
import type * as identity from '../../spec/identity.js';
import type { ClaimLine } from '../../spec/purchasing.js';
import type { ClaimKind, ClaimStatus, DeliveryStatus, PoStatus, ReceiptStatus } from './domain/rules.js';

/* ------------------------------------------------------------------ rows (domain terms) */

export interface SupplierRow {
  id: string;
  name: string;
  location: string | null;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  address: common.Address | null;
  paymentTerms: string;
  leadTimeDays: number;
  active: boolean;
  notes: string | null;
  createdAt: Date;
}

export interface SupplierItemRow {
  supplierId: string;
  stockItemId: string;
  supplierSku: string | null;
  unitCostAmount: number;
  currency: string;
  minOrderQty: number | null;
  leadTimeDays: number | null;
  preferred: boolean;
  updatedAt: Date;
}

export interface PerformanceRow {
  supplierId: string;
  windowDays: number;
  onTimePct: number | null;
  avgLeadTimeDays: number | null;
  shortageRatePct: number | null;
  damageRatePct: number | null;
  deliveries: number;
  computedAt: Date;
}

export interface PoRow {
  id: string;
  ref: string;
  supplierId: string;
  shipToLocationId: string;
  status: PoStatus;
  paymentTerms: string;
  expectedDate: string | null;
  freightAmount: number;
  currency: string;
  totalAmount: number;
  approvalRequestId: string | null;
  approvalState: 'pending' | 'approved' | 'rejected' | null;
  notes: string | null;
  attachmentIds: string[];
  createdBy: common.Actor;
  createdAt: Date;
  sentAt: Date | null;
  closedAt: Date | null;
  closeReason: string | null;
}

export interface PoLineRow {
  id: string;
  purchaseOrderId: string;
  stockItemId: string;
  sku: string;
  label: string;
  qtyOrdered: number;
  qtyReceived: number;
  qtyDamaged: number;
  qtyClosed: number;
  unitCostAmount: number;
  expectedDate: string | null;
}

export interface PoEventRow {
  id: string;
  purchaseOrderId: string;
  label: string;
  detail: string | null;
  actorKind: string;
  actorId: string | null;
  at: Date;
}

export interface DeliveryRow {
  id: string;
  purchaseOrderId: string;
  carrier: string | null;
  trackingRef: string | null;
  windowFrom: Date;
  windowTo: Date;
  units: number;
  status: DeliveryStatus;
  delayReason: string | null;
  arrivedAt: Date | null;
  dock: string | null;
}

export interface ReceiptRow {
  id: string;
  ref: string;
  purchaseOrderId: string;
  deliveryId: string;
  locationId: string;
  status: ReceiptStatus;
  note: string | null;
  receivedBy: common.Actor;
  startedAt: Date;
  submittedAt: Date | null;
  confirmedBy: common.Actor | null;
  confirmedAt: Date | null;
}

export interface ReceiptLineRow {
  receiptId: string;
  purchaseOrderLineId: string;
  stockItemId: string;
  expected: number;
  received: number;
  damaged: number;
  binCode: string | null;
  photoIds: string[];
  note: string | null;
}

export interface ClaimRow {
  id: string;
  ref: string;
  supplierId: string;
  purchaseOrderId: string;
  receiptId: string | null;
  kind: ClaimKind;
  lines: ClaimLine[];
  amount: number;
  currency: string;
  status: ClaimStatus;
  settlement: 'credit_note' | 'refund' | 'replacement' | null;
  settledAmount: number | null;
  owner: common.Actor;
  notes: string | null;
  createdAt: Date;
  decidedAt: Date | null;
}

/* ------------------------------------------------------------------ queries */

export interface PoFilter {
  q?: string;
  status?: PoStatus;
  supplierId?: string;
  lateOrShort?: boolean;
  awaitingApproval?: boolean;
  /** YYYY-MM-DD in the market zone, for lateOrShort */
  today: string;
}

export interface DeliveryFilter {
  status?: DeliveryStatus;
  purchaseOrderId?: string;
  /** Window start within [from, to) */
  from?: Date;
  to?: Date;
}

export interface ReceiptFilter {
  status?: ReceiptStatus;
  withIssues?: boolean;
  purchaseOrderId?: string;
  from?: Date;
  to?: Date;
}

export interface ClaimFilter {
  status?: ClaimStatus;
  supplierId?: string;
  purchaseOrderIds?: string[];
  statuses?: readonly ClaimStatus[];
}

/** Per-supplier figures over the performance window */
export interface PerformanceInputs {
  supplierId: string;
  deliveries: number;
  onTime: number;
  leadTimeMsTotal: number;
  leadTimeCount: number;
  expected: number;
  received: number;
  shortage: number;
  damaged: number;
}

/** Persistence for this module's own tables: purchasing.suppliers, purchasing.supplier_items, purchasing.supplier_performance, purchasing.purchase_orders, purchasing.purchase_order_lines, purchasing.purchase_order_events, purchasing.deliveries, purchasing.receipts, purchasing.receipt_lines, purchasing.supplier_claims. */
export interface PurchasingRepository {
  transaction<T>(fn: (tx: PurchasingRepository) => Promise<T>): Promise<T>;

  /* suppliers */
  insertSupplier(row: SupplierRow): Promise<SupplierRow>;
  updateSupplier(id: string, patch: Partial<Omit<SupplierRow, 'id' | 'createdAt'>>): Promise<SupplierRow>;
  getSupplier(id: string, opts?: { forUpdate?: boolean }): Promise<SupplierRow | null>;
  getSuppliers(ids: readonly string[]): Promise<SupplierRow[]>;
  listSuppliers(filter: { q?: string; active?: boolean }, page: PageRequest): Promise<Page<SupplierRow>>;
  openPurchaseOrderCounts(supplierIds: readonly string[]): Promise<Map<string, number>>;

  /* price lists */
  supplierItems(supplierId: string): Promise<SupplierItemRow[]>;
  replaceSupplierItems(supplierId: string, rows: readonly SupplierItemRow[]): Promise<void>;
  /** Unset preferred on other suppliers' rows for these stock items */
  clearPreferred(stockItemIds: readonly string[], exceptSupplierId: string): Promise<void>;
  /** Rows of active suppliers for these stock items (all stock items when omitted, preferred only when asked) */
  itemsForStock(filter: { stockItemIds?: readonly string[]; preferredOnly?: boolean; supplierId?: string }): Promise<SupplierItemRow[]>;

  /* performance */
  performanceOf(supplierIds: readonly string[]): Promise<Map<string, PerformanceRow>>;
  savePerformance(row: PerformanceRow): Promise<void>;
  performanceInputs(since: Date): Promise<PerformanceInputs[]>;
  supplierIds(): Promise<string[]>;

  /* purchase orders */
  insertPurchaseOrder(row: PoRow): Promise<PoRow>;
  updatePurchaseOrder(id: string, patch: Partial<Omit<PoRow, 'id' | 'ref' | 'createdAt' | 'createdBy'>>): Promise<PoRow>;
  getPurchaseOrder(id: string, opts?: { forUpdate?: boolean }): Promise<PoRow | null>;
  getPurchaseOrders(ids: readonly string[]): Promise<PoRow[]>;
  purchaseOrderByApproval(requestId: string, opts?: { forUpdate?: boolean }): Promise<PoRow | null>;
  listPurchaseOrders(filter: PoFilter, page: PageRequest): Promise<Page<PoRow>>;
  purchaseOrdersBy(filter: { statuses?: readonly PoStatus[]; supplierId?: string; locationId?: string; limit?: number }): Promise<PoRow[]>;
  insertLines(rows: readonly PoLineRow[]): Promise<void>;
  deleteLines(purchaseOrderId: string): Promise<void>;
  linesOf(purchaseOrderIds: readonly string[]): Promise<PoLineRow[]>;
  updateLine(id: string, patch: Partial<Pick<PoLineRow, 'qtyReceived' | 'qtyDamaged' | 'qtyClosed' | 'expectedDate'>>): Promise<void>;
  /** Lines on purchase orders in these statuses for one stock item */
  linesForStock(stockItemIds: readonly string[], statuses: readonly PoStatus[]): Promise<(PoLineRow & { ref: string; status: PoStatus; poExpectedDate: string | null })[]>;
  /** Latest sku and label recorded on any PO line for these stock items */
  knownStock(stockItemIds: readonly string[]): Promise<Map<string, { sku: string; label: string }>>;
  addEvent(row: PoEventRow): Promise<void>;
  eventsOf(purchaseOrderId: string): Promise<PoEventRow[]>;

  /* deliveries */
  insertDelivery(row: DeliveryRow): Promise<DeliveryRow>;
  updateDelivery(id: string, patch: Partial<Omit<DeliveryRow, 'id' | 'purchaseOrderId'>>): Promise<DeliveryRow>;
  getDelivery(id: string, opts?: { forUpdate?: boolean }): Promise<DeliveryRow | null>;
  deliveriesOf(purchaseOrderIds: readonly string[]): Promise<DeliveryRow[]>;
  listDeliveries(filter: DeliveryFilter, page: PageRequest): Promise<Page<DeliveryRow>>;
  deliveriesBy(filter: { statuses?: readonly DeliveryStatus[]; from?: Date; to?: Date; windowToBefore?: Date; locationId?: string; limit?: number }): Promise<DeliveryRow[]>;
  cancelPendingDeliveries(purchaseOrderId: string, reason: string): Promise<number>;

  /* receipts */
  insertReceipt(row: ReceiptRow, lines: readonly ReceiptLineRow[]): Promise<ReceiptRow>;
  updateReceipt(id: string, patch: Partial<Omit<ReceiptRow, 'id' | 'ref' | 'purchaseOrderId' | 'deliveryId' | 'startedAt'>>): Promise<ReceiptRow>;
  getReceipt(id: string, opts?: { forUpdate?: boolean }): Promise<ReceiptRow | null>;
  receiptsBy(filter: { purchaseOrderIds?: readonly string[]; deliveryIds?: readonly string[]; statuses?: readonly ReceiptStatus[]; submittedFrom?: Date; locationId?: string }): Promise<ReceiptRow[]>;
  inProgressReceipt(deliveryId: string): Promise<ReceiptRow | null>;
  listReceipts(filter: ReceiptFilter, page: PageRequest): Promise<Page<ReceiptRow>>;
  receiptsAfter(filter: ReceiptFilter, after: { startedAt: Date; id: string } | null, limit: number): Promise<ReceiptRow[]>;
  receiptLines(receiptIds: readonly string[]): Promise<ReceiptLineRow[]>;
  updateReceiptLine(receiptId: string, purchaseOrderLineId: string, patch: Partial<Pick<ReceiptLineRow, 'received' | 'damaged' | 'binCode' | 'photoIds' | 'note'>>): Promise<void>;

  /* claims */
  insertClaim(row: ClaimRow): Promise<ClaimRow>;
  updateClaim(id: string, patch: Partial<Pick<ClaimRow, 'status' | 'settlement' | 'settledAmount' | 'notes' | 'decidedAt'>>): Promise<ClaimRow>;
  getClaim(id: string, opts?: { forUpdate?: boolean }): Promise<ClaimRow | null>;
  claimsBy(filter: ClaimFilter): Promise<ClaimRow[]>;
  listClaims(filter: ClaimFilter, page: PageRequest): Promise<Page<ClaimRow>>;
}

/* ------------------------------------------------------------------ stock items (inventory) */

export interface StockInfo {
  stockItemId: string;
  sku: string;
  label: string;
  /** null when the source does not say (treated as company stock) */
  ownerType: 'official' | 'seller' | null;
}

/**
 * SKU, label and owner of inventory stock items. Inventory's public API has no lookup by id
 * (spec gap), so the adapter combines what purchasing already knows with inventory's own export.
 */
export interface StockDirectory {
  /** Known items only; missing ids are not in the map */
  describe(stockItemIds: readonly string[], viewer?: identity.Principal | null): Promise<Map<string, StockInfo>>;
  /** Items seen in inventory events (inventory.stock.low) */
  remember(info: StockInfo): void;
}
