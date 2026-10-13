/** Row types of the inventory collections and the filter shapes the repository (repository.ts) takes. */
import type { InventoryDb } from '../../spec/inventory.js';

export type Table = keyof InventoryDb & string;
export type Row<T extends Table> = InventoryDb[T];
type NullableKeys<R> = { [K in keyof R]: null extends R[K] ? K : never }[keyof R];
/** A row to insert: nullable columns may be left out (they are stored as null) */
export type NewRow<T extends Table> = Omit<Row<T>, NullableKeys<Row<T>>> & Partial<Pick<Row<T>, NullableKeys<Row<T>>>>;
export type Patch<T extends Table> = Partial<Row<T>>;

/** Tables keyed by a uuid `id` column */
export type IdTable = Exclude<Table, 'stock_levels' | 'inbound_lines' | 'transfer_lines' | 'count_lines'>;

export interface Lock {
  /** Lock the document for this transaction (lock-by-write, kernel/mongo/table.ts): the decision depends on it */
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
  /** inclusive market days, YYYY-MM-DD */
  from?: string;
  to?: string;
  /** the market time zone the days are in (default UTC) */
  timeZone?: string;
}
