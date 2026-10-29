/**
 * The reads of this module that are not the same question in both databases (docs/10 §10.5e).
 *
 * Everything else lives in repository.ts, written once against `ctx.store`. What is here needs more than the
 * neutral vocabulary has a shape for:
 *
 *   - `itemIdsByQuantities` is a **join and a GROUP BY with four measures**: the stock list filters by
 *     quantities that are summed over an item's level rows, and whether a level's Available units count at all
 *     depends on the location it sits at (the sellable rule, domain/rules `sellsFrom`). MongoDB asks it with a
 *     nested `$lookup` and `$map/$filter` sums; MySQL asks it with two `LEFT JOIN`s and conditional `SUM`s.
 *   - `recentMovements` is "the latest n rows per key": `$firstN` after a `$sort` and `$group` on one side,
 *     `ROW_NUMBER() OVER (PARTITION BY …)` on the other (§13.1).
 *   - `unitsByReasonSince` is a **sum per key**. `countBy` counts per key and `sum` totals one column with no
 *     grouping; a sum *per key* is neither, so it belongs here rather than in the seam.
 *
 * All three are reads outside a transaction, which is why nothing here takes one: two serve list and detail
 * screens and the third serves the reorder suggestion. At the cutover `queries.mongo.ts` is deleted whole
 * rather than edited (Y4).
 */
import type { WhereWithOr } from '../../kernel/store/index.js';
import type { Row } from './ports.js';

/**
 * The quantity half of a stock-list filter: what the aggregated numbers have to say about an item. At least one
 * of the two is always set — the repository does not call the query at all when neither is, because then the
 * item filter answers the list on its own.
 */
export interface StockQuantityFilter {
  /** Computed from the item's *sellable* Available units against its threshold */
  state?: 'in_stock' | 'low_stock' | 'out_of_stock';
  /** `low_or_out` | `has_damaged_or_held` | `has_returned` | `has_incoming` */
  filter?: string;
  /** The threshold of an item that has none of its own (a setting, never null) */
  defaultThreshold: number;
}

export interface InventoryQueries {
  /**
   * Ids of the stock items matching `where` whose summed quantities also pass `f`.
   *
   * The sums are over every level row of the item — Available counted only where the item may sell from that
   * location — and the state is `out_of_stock` at zero or less, `low_stock` at or below the threshold, else
   * `in_stock`. An item with no level rows at all sums to zero and so is `out_of_stock`, which is why the join
   * has to be an outer one on either store.
   *
   * It answers ids rather than rows because both callers (`pageItemIds`, `itemIds`) then read the page they
   * want through the ordinary table, keeping the keyset paging and the row conversion written once.
   */
  itemIdsByQuantities(where: WhereWithOr<Row<'stock_items'>>, f: StockQuantityFilter): Promise<string[]>;

  /** The latest `limit` ledger rows of each item, newest first across the lot (empty for no items) */
  recentMovements(itemIds: readonly string[], limit: number): Promise<Row<'stock_movements'>[]>;

  /** Units moved with any of these reason codes at or after `since`, totalled per item (items with none left out) */
  unitsByReasonSince(itemIds: readonly string[], since: Date, reasonCodes: readonly string[]): Promise<Map<string, number>>;
}
