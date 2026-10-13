/** Row types and shapes the wishlist repository and service share. */
import type { WishlistDb } from '../../spec/wishlist.js';

export type ListRow = WishlistDb['lists'];
export type ItemRow = WishlistDb['items'];
export type AlertRow = WishlistDb['alerts'];
export type AlertKind = 'price_drop' | 'back_in_stock';
export type AlertState = 'active' | 'triggered' | 'paused' | 'removed';

export interface ListWithCount extends ListRow {
  item_count: number;
}

/** An alert with the saved offer of the item it belongs to (alerts of an item that saved an offer follow that offer) */
export interface AlertCandidate extends AlertRow {
  item_offer_id: string | null;
}

export interface InsightRow {
  product_id: string;
  saves: number;
  active_price_alerts: number;
  active_stock_alerts: number;
}

export interface Lock {
  forUpdate?: boolean;
}
