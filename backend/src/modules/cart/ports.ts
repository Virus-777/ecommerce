/**
 * What the cart service needs from the outside world, database-agnostic.
 * The Postgres adapter lives in infra/postgres/; a MongoDB switch would add infra/mongo/.
 */
import type { Page } from '../../kernel/lib/pagination.js';
import type { PageRequest } from '../../kernel/lib/pagination.js';
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

/** Persistence for this module's own tables: cart.carts, cart.cart_items, cart.cart_item_notices, cart.saved_items, cart.cart_merges, cart.recheck_queue. */
export interface CartRepository {
  /** Runs fn with a repository bound to one transaction */
  transaction<T>(fn: (tx: CartRepository) => Promise<T>): Promise<T>;

  /* ---------------------------------------------------------------- carts */
  getActiveCart(owner: OwnerKey, lock?: Lock): Promise<CartRow | undefined>;
  getCart(id: string, lock?: Lock): Promise<CartRow | undefined>;
  /** The most recent cart of a guest session in any status (active first) */
  getGuestCart(guestSessionId: string, lock?: Lock): Promise<CartRow | undefined>;
  /** undefined when the owner already has an active cart (unique index) */
  insertCart(row: CartRow): Promise<CartRow | undefined>;
  updateCart(id: string, patch: Partial<CartRow>): Promise<CartRow>;
  /** Active carts idle past their expiry */
  listExpiredCarts(now: Date, limit: number): Promise<CartRow[]>;
  listCartsAdmin(filter: AdminCartFilter, page: PageRequest): Promise<Page<CartAggregate>>;
  aggregateCart(cartId: string): Promise<CartAggregate | undefined>;

  /* ---------------------------------------------------------------- lines */
  listItems(cartId: string): Promise<ItemRow[]>;
  getItem(cartId: string, itemId: string, lock?: Lock): Promise<ItemRow | undefined>;
  getItemByOffer(cartId: string, offerId: string): Promise<ItemRow | undefined>;
  countItems(cartId: string): Promise<number>;
  insertItem(row: ItemRow): Promise<ItemRow>;
  updateItem(id: string, patch: Partial<ItemRow>): Promise<ItemRow>;
  /** Moves lines to another cart (merge) */
  moveItems(itemIds: string[], toCartId: string, at: Date): Promise<void>;
  /** Deletes lines with their notices and queue entries */
  deleteItems(itemIds: string[]): Promise<void>;
  /** Lines by id (any cart) */
  getItemsByIds(itemIds: string[]): Promise<ItemRow[]>;
  /** Lines of active carts matching any of the given ids */
  findActiveItems(match: ItemMatch): Promise<ItemRow[]>;
  countActiveCartsWithOffer(offerId: string): Promise<number>;

  /* ---------------------------------------------------------------- notices */
  listNotices(itemIds: string[]): Promise<NoticeRow[]>;
  insertNotices(rows: NoticeRow[]): Promise<void>;
  resolveNotices(ids: string[], at: Date): Promise<void>;
  acceptNotices(ids: string[], at: Date): Promise<void>;
  /** Counts open warning or blocking notices per cart line, for the badge */
  countAttentionLines(cartId: string): Promise<number>;

  /* ---------------------------------------------------------------- merges */
  insertMerge(row: MergeRow): Promise<void>;
  getMergeFrom(fromCartId: string): Promise<MergeRow | undefined>;
  listMerges(cartId: string): Promise<MergeRow[]>;

  /* ---------------------------------------------------------------- recheck queue */
  enqueue(itemIds: string[], reason: string, at: Date): Promise<void>;
  takeQueue(limit: number): Promise<QueueRow[]>;
  dequeue(itemIds: string[]): Promise<void>;

  /* ---------------------------------------------------------------- saved for later */
  listSaved(owner: OwnerKey, page: PageRequest): Promise<Page<SavedRow>>;
  getSaved(owner: OwnerKey, id: string): Promise<SavedRow | undefined>;
  findSavedByOffer(owner: OwnerKey, offerId: string): Promise<SavedRow | undefined>;
  countSaved(owner: OwnerKey): Promise<number>;
  insertSaved(row: SavedRow): Promise<void>;
  updateSaved(id: string, patch: Partial<SavedRow>): Promise<void>;
  deleteSaved(id: string): Promise<void>;
  /**
   * Moves a guest session's saved items to a customer (sign-in merge): an offer the customer already
   * saved keeps the customer's row and drops the guest's. Returns how many rows moved.
   */
  moveGuestSaved(guestSessionId: string, customerId: string): Promise<number>;
}
