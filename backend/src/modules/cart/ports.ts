/** Row types of the cart collections and the shapes the repository (repository.ts) and the service share. */
import type { CartDb } from '../../spec/cart.js';

export type CartRow = CartDb['carts'];
export type ItemRow = CartDb['cart_items'];
export type NoticeRow = CartDb['cart_item_notices'];
export type SavedRow = CartDb['saved_items'];
export type MergeRow = CartDb['cart_merges'];
export type QueueRow = CartDb['recheck_queue'];

/** Who a cart belongs to: a customer (customers' id) or a visitor (guest) session */
export type OwnerKey = { kind: 'customer'; customerId: string } | { kind: 'guest'; guestSessionId: string };

export interface Lock {
  forUpdate?: boolean;
}

/** Lines of active carts that other modules' events touch */
export interface ItemMatch {
  offerIds?: string[];
  stockItemIds?: string[];
  sellerIds?: string[];
  productIds?: string[];
}

export interface AdminCartFilter {
  customerId?: string;
  guestSessionId?: string;
  status?: CartRow['status'];
}

/** A cart with the aggregates the support list shows */
export interface CartAggregate {
  cart: CartRow;
  itemCount: number;
  /** Lines without an open blocking notice, at their accepted price (minor units) */
  itemsSubtotal: number;
  openNotices: number;
}
