/**
 * What the wishlist service needs from the outside world, database-agnostic.
 * The Postgres adapter lives in infra/postgres/; a MongoDB switch would add infra/mongo/.
 */
import type { Page } from '../../kernel/lib/pagination.js';
import type { PageRequest } from '../../kernel/lib/pagination.js';
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

/** Persistence for this module's own tables: wishlist.lists, wishlist.items, wishlist.alerts. */
export interface WishlistRepository {
  /** Runs fn with a repository bound to one transaction */
  transaction<T>(fn: (tx: WishlistRepository) => Promise<T>): Promise<T>;
  /** Inbox (ctx.inbox): true the first time this key is claimed; commits with the transaction it runs in */
  claim(key: string): Promise<boolean>;

  /* ---------------- lists */
  /** The customer's default list, created when missing (safe under concurrency) */
  ensureDefaultList(row: ListRow): Promise<ListRow>;
  getList(customerId: string, id: string, lock?: Lock): Promise<ListRow | undefined>;
  getListByShareToken(token: string): Promise<ListRow | undefined>;
  listLists(customerId: string): Promise<ListWithCount[]>;
  countLists(customerId: string): Promise<number>;
  insertList(row: ListRow): Promise<ListRow>;
  updateList(id: string, patch: Partial<ListRow>): Promise<ListRow>;
  deleteList(id: string): Promise<void>;

  /* ---------------- items */
  getItem(customerId: string, id: string, lock?: Lock): Promise<ItemRow | undefined>;
  findItem(listId: string, productId: string, variantId: string | null): Promise<ItemRow | undefined>;
  /** A saved item of the customer for a product (and variant when given), default list first */
  findCustomerItem(customerId: string, productId: string, variantId: string | null): Promise<ItemRow | undefined>;
  countItems(listId: string): Promise<number>;
  insertItem(row: ItemRow): Promise<ItemRow>;
  updateItem(id: string, patch: Partial<ItemRow>): Promise<ItemRow>;
  deleteItem(id: string): Promise<void>;
  /** Items of a list, newest first */
  pageItems(listId: string, page: PageRequest): Promise<Page<ItemRow>>;
  allItems(listId: string, limit: number): Promise<ItemRow[]>;
  savedProductIds(customerId: string, productIds: string[]): Promise<string[]>;
  countSavers(productId: string): Promise<number>;
  itemsOfProduct(productId: string): Promise<ItemRow[]>;
  /** Clears the saved offer of every item that saved it; returns how many */
  clearOffer(offerId: string): Promise<number>;
  /** Product ids saved or watched with a variant (stock events name the variant only) */
  productIdsForVariant(variantId: string): Promise<string[]>;

  /* ---------------- alerts */
  getAlert(customerId: string, id: string, lock?: Lock): Promise<AlertRow | undefined>;
  getAlertById(id: string, lock?: Lock): Promise<AlertRow | undefined>;
  /** Alerts (not removed) of the given items */
  alertsOfItems(itemIds: string[]): Promise<AlertRow[]>;
  /** The customer's alerts that are not removed, newest first */
  pageAlerts(customerId: string, state: AlertState | undefined, page: PageRequest): Promise<Page<AlertRow>>;
  allAlerts(customerId: string, limit: number): Promise<AlertRow[]>;
  countActiveAlerts(customerId: string): Promise<number>;
  /** An equivalent alert that is not removed (same product, variant, seller and kind) */
  findEquivalentAlert(customerId: string, a: { productId: string; variantId: string | null; sellerId: string | null; kind: AlertKind }): Promise<AlertRow | undefined>;
  insertAlert(row: AlertRow): Promise<AlertRow>;
  updateAlert(id: string, patch: Partial<AlertRow>): Promise<AlertRow>;
  /** Every alert of an item becomes removed and lets go of the item */
  removeAlertsOfItem(itemId: string): Promise<number>;
  /** Alerts of a product in the given states, with the saved offer of their item */
  candidates(productId: string, kind: AlertKind | null, states: AlertState[]): Promise<AlertCandidate[]>;
  /** Triggered price-drop alerts whose last notice is older than `before` */
  dueForRearm(before: Date, limit: number): Promise<AlertRow[]>;
  /** Customers with alerts paused for a reason */
  customersPausedFor(reason: string, limit: number): Promise<string[]>;
  pausedFor(customerId: string, reason: string): Promise<AlertRow[]>;
  /** Active alerts of a kind after an id, in id order (job batches) */
  activeAlertsAfter(kind: AlertKind, afterId: string | null, limit: number): Promise<AlertCandidate[]>;

  /* ---------------- customer data (export and account closure) */
  /** Every list, item and alert (not removed) of the customer ids */
  customerData(customerIds: string[]): Promise<{ lists: ListRow[]; items: ItemRow[]; alerts: AlertRow[] }>;
  /** Deletes every alert, item and list of the customer ids */
  deleteCustomerData(customerIds: string[]): Promise<{ lists: number; items: number; alerts: number }>;

  /* ---------------- insights (aggregates, no customer data) */
  insights(o: { from?: Date; to?: Date; limit: number }): Promise<InsightRow[]>;
}
