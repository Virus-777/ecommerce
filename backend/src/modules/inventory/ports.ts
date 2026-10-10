/**
 * What the inventory service needs from the outside world, database-agnostic.
 * The Postgres adapter lives in infra/postgres/; a MongoDB switch would add infra/mongo/.
 */
import type { Insertable, Selectable, Updateable } from 'kysely';
import type { PageRequest } from '../../kernel/lib/pagination.js';
import type { Page } from '../../spec/common.js';
import type { InventoryDb } from '../../spec/inventory.js';

export type Table = keyof InventoryDb & string;
export type Row<T extends Table> = Selectable<InventoryDb[T]>;
export type NewRow<T extends Table> = Insertable<InventoryDb[T]>;
export type Patch<T extends Table> = Updateable<InventoryDb[T]>;

/** Tables keyed by a uuid `id` column */
export type IdTable = Exclude<Table, 'stock_levels' | 'inbound_lines' | 'transfer_lines' | 'count_lines'>;

export interface Lock {
  /** SELECT … FOR UPDATE: the decision depends on this row */
  forUpdate?: boolean;
}

export interface ItemFilter {
  ownerType?: 'official' | 'seller';
  sellerId?: string;
  ids?: string[];
  skus?: string[];
  offerIds?: string[];
  variantIds?: string[];
  productIds?: string[];
  /** default false: archived items are left out of lists */
  includeArchived?: boolean;
}

export interface ItemListFilter extends ItemFilter {
  /** SKU, product label or bin */
  q?: string;
  state?: 'in_stock' | 'low_stock' | 'out_of_stock';
  /** low_or_out | has_damaged_or_held | has_returned | has_incoming */
  filter?: string;
  /** count quantities at this location only */
  locationId?: string;
  /** bin prefix */
  zone?: string;
  /** threshold of seller items without their own */
  defaultSellerThreshold: number;
}

export interface MovementFilter {
  stockItemIds?: string[];
  sellerId?: string;
  ownerType?: 'official' | 'seller';
  sku?: string;
  reasonCode?: string;
  referenceKind?: string;
  /** inclusive, YYYY-MM-DD in UTC */
  from?: string;
  to?: string;
}

/** Persistence for this module's own tables: inventory.locations, inventory.stock_items, inventory.stock_levels, inventory.stock_movements, inventory.incoming_expectations, inventory.reservations, inventory.reservation_lines, inventory.adjustments, inventory.held_stock, inventory.inbound_receipts, inventory.inbound_lines, inventory.return_outcomes, inventory.discrepancies, inventory.transfers, inventory.transfer_lines, inventory.stock_counts, inventory.count_lines. */
export interface InventoryRepository {
  /** Runs fn in one database transaction with a repository bound to it */
  transaction<T>(fn: (tx: InventoryRepository) => Promise<T>): Promise<T>;
  /**
   * Claims an event consumer's key (kernel inbox) on this repository's connection: inside a transaction the
   * claim commits with the effects. false when the key was already handled.
   */
  claimEvent(key: string): Promise<boolean>;

  /* ---------------------------------------------------------------- rows by id (tables with an id column) */
  get<T extends IdTable>(table: T, id: string, lock?: Lock): Promise<Row<T> | undefined>;
  /** Inserts a row; with `ignoreConflict` a unique violation returns undefined instead of failing */
  insert<T extends IdTable>(table: T, row: NewRow<T>, opts?: { ignoreConflict?: boolean }): Promise<Row<T> | undefined>;
  update<T extends IdTable>(table: T, id: string, patch: Patch<T>): Promise<Row<T>>;

  /* ---------------------------------------------------------------- locations */
  locations(filter: { ownerType?: 'official' | 'seller'; sellerId?: string; ids?: string[] }): Promise<Row<'locations'>[]>;
  locationByCode(code: string): Promise<Row<'locations'> | undefined>;

  /* ---------------------------------------------------------------- stock items */
  items(filter: ItemFilter): Promise<Row<'stock_items'>[]>;
  /** Archives items matching the filter; returns the ones changed */
  archiveItems(filter: { sellerId?: string; offerId?: string }, at: Date): Promise<Row<'stock_items'>[]>;
  /** Ids of a page of items (filters on aggregated quantities), sorted by SKU */
  pageItemIds(filter: ItemListFilter, page: PageRequest): Promise<Page<{ id: string }>>;
  /** Ids for exports and digests, sorted by SKU */
  itemIds(filter: ItemListFilter, limit: number, offset: number): Promise<string[]>;

  /* ---------------------------------------------------------------- stock levels */
  /** Levels of these items; with forUpdate the rows are locked in (item, location) order */
  levels(itemIds: string[], lock?: Lock): Promise<Row<'stock_levels'>[]>;
  /** Creates a zero level row when missing */
  ensureLevel(itemId: string, locationId: string, at: Date): Promise<void>;
  /** Writes quantities if the version still matches; false on a concurrent change */
  updateLevel(itemId: string, locationId: string, values: Omit<Row<'stock_levels'>, 'stock_item_id' | 'location_id' | 'version'>, expectedVersion: number): Promise<boolean>;
  /** Totals per location (summaries) */
  levelTotals(filter: { ownerType: 'official' | 'seller'; sellerId?: string; locationId?: string }): Promise<Row<'stock_levels'>[]>;

  /* ---------------------------------------------------------------- movement ledger (append-only) */
  insertMovement(row: NewRow<'stock_movements'>): Promise<Row<'stock_movements'>>;
  pageMovements(filter: MovementFilter, page: PageRequest): Promise<Page<Row<'stock_movements'>>>;
  /** Latest movements per item (limit each) */
  recentMovements(itemIds: string[], limit: number): Promise<Row<'stock_movements'>[]>;
  movementsByRef(refKind: string, refIds: string[]): Promise<Row<'stock_movements'>[]>;
  /** Units that left stock through dispatch since a time, per item */
  dispatchedSince(itemIds: string[], since: Date): Promise<Map<string, number>>;
  /** Units moved with these reason codes since a time, per item */
  unitsByReasonSince(itemIds: string[], since: Date, reasonCodes: string[]): Promise<Map<string, number>>;

  /* ---------------------------------------------------------------- incoming */
  expectations(filter: { sourceKind?: string; sourceId?: string; itemIds?: string[]; openOnly?: boolean }, lock?: Lock): Promise<Row<'incoming_expectations'>[]>;

  /* ---------------------------------------------------------------- reservations */
  reservationByKey(key: string): Promise<Row<'reservations'> | undefined>;
  reservationsByOrder(orderId: string, lock?: Lock): Promise<Row<'reservations'>[]>;
  lines(reservationIds: string[], lock?: Lock): Promise<Row<'reservation_lines'>[]>;
  linesWhere(filter: { orderItemIds?: string[]; itemIds?: string[]; states?: string[] }, lock?: Lock): Promise<Row<'reservation_lines'>[]>;
  /** Reservations whose key starts with a prefix (allocations made with allocateForOrder) for an order */
  reservationsByKeyPrefix(orderId: string, prefix: string): Promise<Row<'reservations'>[]>;
  pageReservations(filter: { orderId?: string; stockItemId?: string; state?: string }, page: PageRequest): Promise<Page<Row<'reservations'>>>;
  /** Held reservations past their expiry */
  dueHolds(now: Date, limit: number): Promise<Row<'reservations'>[]>;
  /** Allocations open since before a time */
  staleAllocations(before: Date, limit: number): Promise<Row<'reservations'>[]>;

  /* ---------------------------------------------------------------- adjustments and held stock */
  adjustmentByApproval(approvalRequestId: string): Promise<Row<'adjustments'> | undefined>;
  adjustmentsWhere(filter: { itemIds?: string[]; states?: string[] }): Promise<Row<'adjustments'>[]>;
  pageAdjustments(filter: { state?: string; stockItemId?: string }, page: PageRequest): Promise<Page<Row<'adjustments'>>>;
  openHeld(itemId: string, locationId: string, lock?: Lock): Promise<Row<'held_stock'>[]>;
  dueHeld(date: string, limit: number): Promise<Row<'held_stock'>[]>;

  /* ---------------------------------------------------------------- inbound receipts */
  inboundByReceipt(receiptId: string): Promise<Row<'inbound_receipts'> | undefined>;
  inboundLines(inboundIds: string[]): Promise<Row<'inbound_lines'>[]>;
  insertInboundLines(rows: NewRow<'inbound_lines'>[]): Promise<void>;
  updateInboundLine(inboundId: string, itemId: string, patch: Patch<'inbound_lines'>): Promise<void>;
  pageInbound(filter: { state?: string }, page: PageRequest): Promise<Page<Row<'inbound_receipts'>>>;

  /* ---------------------------------------------------------------- return outcomes */
  returnOutcomesWhere(filter: { returnId?: string; ids?: string[] }): Promise<Row<'return_outcomes'>[]>;
  pageReturnOutcomes(filter: { state?: string }, page: PageRequest): Promise<Page<Row<'return_outcomes'>>>;

  /* ---------------------------------------------------------------- discrepancies */
  discrepanciesWhere(filter: { itemIds?: string[]; states?: string[]; kinds?: string[] }): Promise<Row<'discrepancies'>[]>;
  pageDiscrepancies(filter: { state?: string; kind?: string }, page: PageRequest): Promise<Page<Row<'discrepancies'>>>;

  /* ---------------------------------------------------------------- transfers and counts (phase 4) */
  transferLines(transferId: string): Promise<Row<'transfer_lines'>[]>;
  insertTransferLines(rows: NewRow<'transfer_lines'>[]): Promise<void>;
  updateTransferLine(transferId: string, itemId: string, patch: Patch<'transfer_lines'>): Promise<void>;
  pageTransfers(filter: { state?: string }, page: PageRequest): Promise<Page<Row<'transfers'>>>;
  countLines(countId: string): Promise<Row<'count_lines'>[]>;
  insertCountLines(rows: NewRow<'count_lines'>[]): Promise<void>;
  updateCountLine(countId: string, itemId: string, patch: Patch<'count_lines'>): Promise<void>;
}
