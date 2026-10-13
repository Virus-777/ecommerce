/**
 * The purchasing rows in domain terms (the repository maps the collections to them), the query shapes the
 * repository (repository.ts) and the service share, and the stock directory (inventory's stock items).
 */
import type * as common from '../../spec/common.js';
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
  returnAuthorizationRequired: boolean;
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
  supplierReference: string | null;
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

/* ------------------------------------------------------------------ stock items (inventory) */

export interface StockInfo {
  stockItemId: string;
  sku: string;
  label: string;
  ownerType: 'official' | 'seller';
}

/** SKU, label and owner of inventory stock items (inventory.getStockItems) */
export interface StockDirectory {
  /** Known items only; missing ids are not in the map */
  describe(stockItemIds: readonly string[]): Promise<Map<string, StockInfo>>;
}
