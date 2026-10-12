/**
 * What the warehouse service needs from the outside world, database-agnostic.
 * The MongoDB adapter lives in infra/mongo/.
 */
import type { PageRequest } from '../../kernel/lib/pagination.js';
import type * as common from '../../spec/common.js';
import type { Dimensions, WarehouseDb, Weight } from '../../spec/warehouse.js';

type Db = WarehouseDb;

/**
 * A shortage or damage report of a fulfillment, kept in fulfillments.discrepancy_ids: inventory's discrepancy id
 * plus what warehouse needs to resume (the line, the quantity and whether inventory resolved it).
 */
export interface DiscrepancyNote {
  id: string;
  kind: 'pick_shortage' | 'damage_found';
  lineId: string;
  stockItemId: string;
  quantity: number;
  binCode: string | null;
  open: boolean;
  resolution: string | null;
  reportedAt: string;
}

export type BinRec = Db['bins'];
export type AssignmentRec = Db['bin_assignments'];
export interface FulfillmentRec extends Omit<Db['fulfillments'], 'ship_to' | 'discrepancy_ids'> {
  ship_to: common.Address;
  discrepancy_ids: DiscrepancyNote[];
}
export type LineRec = Db['fulfillment_lines'];
export type WaveRec = Db['waves'];
export type ScanRec = Db['scan_log'];
export interface BoxRec extends Omit<Db['box_types'], 'dimensions' | 'max_weight'> {
  dimensions: Dimensions;
  max_weight: Weight | null;
}
export interface PackageRec extends Omit<Db['packages'], 'dimensions' | 'weight'> {
  dimensions: Dimensions | null;
  weight: Weight | null;
}
export type PackageItemRec = Db['package_items'];
export type PutawayRec = Db['putaway_tasks'];
export interface ParcelRec extends Omit<Db['return_parcels'], 'expected_items' | 'photo_media_ids'> {
  expected_items: string[];
  photo_media_ids: string[];
}

export interface Recs {
  bins: BinRec;
  bin_assignments: AssignmentRec;
  fulfillments: FulfillmentRec;
  fulfillment_lines: LineRec;
  waves: WaveRec;
  scan_log: ScanRec;
  box_types: BoxRec;
  packages: PackageRec;
  package_items: PackageItemRec;
  putaway_tasks: PutawayRec;
  return_parcels: ParcelRec;
}
export type Table = keyof Recs;
/** Tables with an `id` primary key (bin_assignments and package_items have composite keys) */
export type IdTable = Exclude<Table, 'bin_assignments' | 'package_items'>;

/** A column condition: a value (=), a list (in), null (is null) or an operator */
export type Cond<V> = V | readonly V[] | { op: '<' | '<=' | '>' | '>=' | '<>' | 'is not'; value: V | null };
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

/** Persistence for this module's own tables: warehouse.bins, warehouse.bin_assignments, warehouse.fulfillments, warehouse.fulfillment_lines, warehouse.waves, warehouse.scan_log, warehouse.box_types, warehouse.packages, warehouse.package_items, warehouse.putaway_tasks, warehouse.return_parcels. */
export interface WarehouseRepository {
  /** Runs fn in one transaction (nested calls join the outer one) */
  transaction<T>(fn: (tx: WarehouseRepository) => Promise<T>): Promise<T>;
  /** Claims a consumer's or job's once-only key (kernel inbox) on this connection; false when already handled */
  claim(key: string): Promise<boolean>;

  get<T extends IdTable>(table: T, id: string, o?: { forUpdate?: boolean }): Promise<Recs[T] | undefined>;
  find<T extends Table>(table: T, where: Where<Recs[T]>, o?: FindOptions<Recs[T]>): Promise<Recs[T][]>;
  count<T extends Table>(table: T, where: Where<Recs[T]>): Promise<number>;
  insert<T extends Table>(table: T, row: Recs[T]): Promise<Recs[T]>;
  insertMany<T extends Table>(table: T, rows: Recs[T][]): Promise<void>;
  /** Inserts unless the row conflicts with a unique key; returns whether it was inserted */
  insertIfNew<T extends Table>(table: T, row: Recs[T]): Promise<boolean>;
  update<T extends IdTable>(table: T, id: string, patch: Partial<Recs[T]>): Promise<Recs[T]>;
  updateWhere<T extends Table>(table: T, where: Where<Recs[T]>, patch: Partial<Recs[T]>): Promise<number>;
  removeWhere<T extends Table>(table: T, where: Where<Recs[T]>): Promise<void>;
  page<T extends IdTable>(table: T, where: Where<Recs[T]>, page: PageRequest, o: PageOptions<Recs[T]>): Promise<common.Page<Recs[T]>>;
  /** Assigned stock items per bin */
  assignmentCounts(binIds: string[]): Promise<Map<string, number>>;
  /** The location with the most active bins (the main Official Store warehouse at launch) */
  busiestLocation(): Promise<string | null>;
}
