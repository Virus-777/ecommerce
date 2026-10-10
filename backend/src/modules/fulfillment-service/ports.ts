/**
 * What the fulfillment-service service needs from the outside world, database-agnostic.
 * The Postgres adapter lives in infra/postgres/; a MongoDB switch would add infra/mongo/.
 */
import type { PageRequest } from '../../kernel/lib/pagination.js';
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

/** A column condition: a value (=), a list (in), null (is null) or an operator */
export type Cond<V> = V | readonly V[] | { op: '<' | '<=' | '>' | '>=' | '<>' | 'is not' | 'not in' | 'between'; value: V | readonly V[] | null };
export type Where<R> = { [K in keyof R]?: Cond<R[K]> };

export interface FindOptions<R> {
  orderBy?: [keyof R & string, 'asc' | 'desc'][];
  limit?: number;
  forUpdate?: boolean;
}

export interface PageOptions<R> {
  order: { column: keyof R & string; direction: 'asc' | 'desc' };
  /** Case-insensitive contains over these text columns */
  search?: { columns: (keyof R & string)[]; term: string };
}

/** Balance of each stock group per SKU enrollment */
export type Balances = Map<string, Partial<Record<StockGroup, number>>>;

/** Persistence for this module's own tables: fulfillment_service.enrollments, fulfillment_service.sku_enrollments, fulfillment_service.inbound_shipments, fulfillment_service.inbound_lines, fulfillment_service.inbound_receipts, fulfillment_service.discrepancies, fulfillment_service.ownership_ledger, fulfillment_service.fulfillment_requests, fulfillment_service.service_returns, fulfillment_service.removal_orders, fulfillment_service.stock_differences, fulfillment_service.fee_schedules, fulfillment_service.fee_charges, fulfillment_service.storage_snapshots. */
export interface FulfillmentServiceRepository {
  /** Runs fn in one transaction (nested calls join the outer one) */
  transaction<T>(fn: (tx: FulfillmentServiceRepository) => Promise<T>): Promise<T>;
  /** Inbox (ctx.inbox): true the first time this key is claimed; commits with the transaction it runs in */
  claim(key: string): Promise<boolean>;

  get<T extends IdTable>(table: T, id: string, o?: { forUpdate?: boolean }): Promise<Recs[T] | undefined>;
  find<T extends Table>(table: T, where: Where<Recs[T]>, o?: FindOptions<Recs[T]>): Promise<Recs[T][]>;
  findOne<T extends Table>(table: T, where: Where<Recs[T]>, o?: FindOptions<Recs[T]>): Promise<Recs[T] | undefined>;
  count<T extends Table>(table: T, where: Where<Recs[T]>): Promise<number>;
  insert<T extends Table>(table: T, row: Recs[T]): Promise<Recs[T]>;
  insertMany<T extends Table>(table: T, rows: Recs[T][]): Promise<void>;
  /** Inserts unless the row conflicts with a unique key; returns whether it was inserted */
  insertIfNew<T extends Table>(table: T, row: Recs[T]): Promise<boolean>;
  update<T extends IdTable>(table: T, id: string, patch: Partial<Recs[T]>): Promise<Recs[T]>;
  updateWhere<T extends Table>(table: T, where: Where<Recs[T]>, patch: Partial<Recs[T]>): Promise<number>;
  removeWhere<T extends Table>(table: T, where: Where<Recs[T]>): Promise<void>;
  page<T extends IdTable>(table: T, where: Where<Recs[T]>, page: PageRequest, o: PageOptions<Recs[T]>): Promise<common.Page<Recs[T]>>;

  /** Ledger balance of every stock group per SKU enrollment (sum in − sum out) */
  balances(skuEnrollmentIds: readonly string[]): Promise<Balances>;
  /** Units that entered the warehouse (arrivals, extra units, returns, found units), newest first, for ageing */
  inflows(skuEnrollmentIds: readonly string[]): Promise<LedgerRec[]>;
  /** Locks a SKU enrollment's ledger (serialises decisions on its balances) */
  lockSkus(ids: readonly string[]): Promise<void>;
  /** Inserts or replaces the day's snapshot of a SKU */
  upsertSnapshot(row: SnapshotRec): Promise<void>;
}
