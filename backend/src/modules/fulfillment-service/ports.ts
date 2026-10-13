/** Row types of the fulfillment-service collections, with their json columns typed (repository.ts reads and writes them). */
import type * as common from '../../spec/common.js';
import type { Dimensions, FeeRate, FulfillmentServiceDb } from '../../spec/fulfillment-service.js';

type Db = FulfillmentServiceDb;

/** Stock groups of seller-owned units tracked by the ownership ledger */
export type StockGroup = 'inbound' | 'receiving' | 'available' | 'reserved' | 'unsellable' | 'returned' | 'removal_pending';

/** One line of a fulfillment request (fulfillment_requests.items) */
export interface RequestItem {
  orderItemId: string;
  offerId: string;
  skuEnrollmentId: string;
  stockItemId: string | null;
  sku: string;
  title: string;
  sizeTier: string;
  quantity: number;
  /** Units cancelled before dispatch */
  cancelled: number;
  picked: number;
  /** Units dispatched so far (across packages) */
  shipped: number;
  /** Units reserved out of available seller-owned stock when the request was created (and not yet shipped or released) */
  reserved: number;
  orderRef: string;
}

/** One line of a receiving record (inbound_receipts.lines) */
export interface ReceiptLine {
  skuEnrollmentId: string;
  stockItemId: string | null;
  received: number;
  damaged: number;
}

/** Quantities compared by the reconciliation, in inventory's groups */
export interface Levels {
  incoming: number;
  available: number;
  reserved: number;
  damagedHeld: number;
  returned: number;
}

/** One line of a removal order (removal_orders.lines) */
export interface RemovalLineRec {
  skuEnrollmentId: string;
  quantity: number;
  fromGroup: 'available' | 'unsellable';
}

export interface EnrollmentRec extends Omit<Db['enrollments'], 'categories'> {
  categories: string[];
}
export interface ReceiptRec extends Omit<Db['inbound_receipts'], 'lines'> {
  lines: ReceiptLine[];
}
export interface StockDifferenceRec extends Omit<Db['stock_differences'], 'ledger' | 'inventory'> {
  ledger: Levels;
  inventory: Levels;
}
export interface SkuRec extends Omit<Db['sku_enrollments'], 'dimensions'> {
  dimensions: Dimensions;
}
export interface InboundRec extends Omit<Db['inbound_shipments'], 'ship_from' | 'destination'> {
  ship_from: common.Address;
  destination: common.Address;
}
export type InboundLineRec = Db['inbound_lines'];
export interface DiscrepancyRec extends Omit<Db['discrepancies'], 'evidence_media_ids'> {
  evidence_media_ids: string[];
}
export type LedgerRec = Db['ownership_ledger'];
export interface RequestRec extends Omit<Db['fulfillment_requests'], 'items'> {
  items: RequestItem[];
}
export interface ServiceReturnRec extends Omit<Db['service_returns'], 'evidence_media_ids'> {
  evidence_media_ids: string[];
}
export interface RemovalRec extends Omit<Db['removal_orders'], 'lines' | 'ship_to'> {
  lines: RemovalLineRec[];
  ship_to: common.Address | null;
}
export interface ScheduleRec extends Omit<Db['fee_schedules'], 'rates'> {
  rates: FeeRate[];
}
export type ChargeRec = Db['fee_charges'];
export interface SnapshotRec extends Omit<Db['storage_snapshots'], 'aged_units'> {
  aged_units: Record<string, number>;
}

export interface Recs {
  enrollments: EnrollmentRec;
  sku_enrollments: SkuRec;
  inbound_shipments: InboundRec;
  inbound_lines: InboundLineRec;
  inbound_receipts: ReceiptRec;
  discrepancies: DiscrepancyRec;
  ownership_ledger: LedgerRec;
  fulfillment_requests: RequestRec;
  service_returns: ServiceReturnRec;
  removal_orders: RemovalRec;
  stock_differences: StockDifferenceRec;
  fee_schedules: ScheduleRec;
  fee_charges: ChargeRec;
  storage_snapshots: SnapshotRec;
}
export type Table = keyof Recs;
/** Tables with an `id` primary key */
export type IdTable = Exclude<Table, 'inbound_lines' | 'storage_snapshots'>;

/** Balance of each stock group per SKU enrollment */
export type Balances = Map<string, Partial<Record<StockGroup, number>>>;
