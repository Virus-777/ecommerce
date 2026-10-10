/**
 * What the orders service needs from the outside world, database-agnostic.
 * The Postgres adapter lives in infra/postgres/; a MongoDB switch would add infra/mongo/.
 */
import type { PageRequest } from '../../kernel/lib/pagination.js';
import type * as catalog from '../../spec/catalog.js';
import type * as common from '../../spec/common.js';
import type * as offers from '../../spec/offers.js';
import type { AcceptedPolicyVersion, CancellationLine, DeliveryPromise, DiscountAllocation, OrdersDb, RefundPreview, ReturnTermsSnapshot, SellerLabel } from '../../spec/orders.js';

type Db = OrdersDb;

/** Event-fed facts kept on the order (orders.flags) next to the materialized flag kinds */
export interface FlagData {
  /** OrderFlag kinds in force, refreshed on every change and by orders.refresh-flags */
  kinds: string[];
  chargebacks?: { disputeId: string; kind: string; groupId?: string | null; at: string }[];
  deliveryIssues?: { exceptionId: string; kind: string; groupId: string; shipmentId?: string | null; dueAt: string; customerAction?: string | null; at: string }[];
  cases?: { caseId: string; ref: string; itemIds: string[]; status: string; nextUpdateBy?: string | null }[];
  restrictedGroups?: string[];
  captures?: { captureId: string; amount: number; at: string }[];
  /** payments.refund.sent already applied (idempotency) */
  refundsSent?: string[];
  /** Approved return refunds not sent yet (returns.refund.approved) */
  refundApprovals?: { id: string; returnRef?: string | null; amount: number; itemIds: string[] }[];
  paymentFailed?: boolean;
  confirmationsResent?: number;
}

/** orders.product_snapshot: catalog.ProductSnapshot plus the category at purchase */
export type StoredProduct = catalog.ProductSnapshot & { categoryId?: string | null };
/** orders.offer_snapshot: offers.OfferSnapshot plus the seller SKU at purchase */
export type StoredOffer = Omit<Partial<offers.OfferSnapshot>, 'sellerSku'> & { offerId: string; termsVersion: number; condition: string; sellerSku?: string | null; conditionLabel?: string };
/** seller_groups.delivery: the promise accepted at checkout plus the seller label shown at purchase */
export type StoredDelivery = DeliveryPromise & { seller?: SellerLabel };
export interface DispatchChange {
  kind: 'recalculated' | 'extension' | 'seller_estimate';
  from: string;
  to: string;
  reason: string;
  by: common.Actor;
  at: string;
}
export type StoredCancellationLine = CancellationLine & { groupId?: string };

export interface OrderRec extends Omit<Db['orders'], 'flags' | 'delivery_address' | 'policy_versions' | 'coupon_codes'> {
  flags: FlagData;
  delivery_address: common.Address;
  policy_versions: AcceptedPolicyVersion[];
  coupon_codes: string[];
}
export interface GroupRec extends Omit<Db['seller_groups'], 'delivery' | 'dispatch_by_history'> {
  delivery: StoredDelivery;
  dispatch_by_history: DispatchChange[];
}
export interface ItemRec extends Omit<Db['order_items'], 'product_snapshot' | 'offer_snapshot' | 'return_terms' | 'discounts'> {
  product_snapshot: StoredProduct;
  offer_snapshot: StoredOffer;
  return_terms: ReturnTermsSnapshot;
  discounts: DiscountAllocation[];
}
export interface CancellationRec extends Omit<Db['cancellations'], 'items' | 'decided_by' | 'refund_preview'> {
  items: StoredCancellationLine[];
  decided_by: common.Actor | null;
  refund_preview: RefundPreview;
}
export interface ShipmentRec extends Omit<Db['shipment_refs'], 'estimated_arrival' | 'item_ids'> {
  estimated_arrival: common.DateRange | null;
  item_ids: string[];
}
export interface SavedFilterRec extends Omit<Db['saved_filters'], 'query'> {
  query: Record<string, unknown>;
}
export type StateLogRec = Db['item_state_log'];
export type TimelineRec = Db['timeline'];
export type NoteRec = Db['notes'];
export type DocumentRec = Db['documents'];

export interface Recs {
  orders: OrderRec;
  seller_groups: GroupRec;
  order_items: ItemRec;
  item_state_log: StateLogRec;
  cancellations: CancellationRec;
  shipment_refs: ShipmentRec;
  timeline: TimelineRec;
  notes: NoteRec;
  documents: DocumentRec;
  saved_filters: SavedFilterRec;
}
export type Table = keyof Recs;

/** A column condition: a value (=), a list (in), null (is null) or an operator */
export type Cond<V> = V | readonly V[] | { op: '<' | '<=' | '>' | '>=' | '<>' | 'is not'; value: V | null };
export type Where<R> = { [K in keyof R]?: Cond<R[K]> };

export interface FindOptions<R> {
  orderBy?: [keyof R & string, 'asc' | 'desc'][];
  limit?: number;
  forUpdate?: boolean;
}

export interface CustomerOrderFilter {
  q?: string;
  placedFrom?: Date | null;
  placedTo?: Date | null;
  tab?: string;
}

export interface SellerGroupFilter {
  tabs?: string[];
  q?: string;
  placedFrom?: Date | null;
  placedTo?: Date | null;
  overdueOnly?: boolean;
  sort?: 'dispatch_deadline' | 'newest' | 'oldest';
}

export interface AdminOrderFilter {
  q?: string;
  sellerType?: 'all' | 'official' | 'marketplace';
  sellerId?: string;
  customerId?: string;
  fulfillmentStatus?: string;
  paymentState?: string;
  placedFrom?: Date | null;
  placedTo?: Date | null;
  flag?: string;
}

export interface SellerCounts {
  new: number;
  preparing: number;
  shipped: number;
  completed: number;
  cancellationRequests: number;
  overdue: number;
  dueToday: number;
}

/** An item with its order, group owner and customer (OrderItemInfo) */
export interface ItemInfoRow {
  id: string;
  order_id: string;
  order_ref: string;
  group_id: string;
  owner_type: string;
  seller_id: string | null;
  customer_id: string | null;
  offer_id: string;
  product_id: string;
  variant_id: string;
  stock_item_id: string;
  category_id: string | null;
  quantity: number;
  state: string;
  delivered_at: Date | null;
  return_window_ends_at: Date | null;
}

/** Persistence for this module's own tables: orders.orders, orders.seller_groups, orders.order_items, orders.item_state_log, orders.cancellations, orders.shipment_refs, orders.timeline, orders.notes, orders.documents, orders.saved_filters, orders.ref_sequences. */
export interface OrdersRepository {
  /** Runs fn in one transaction (nested calls join the outer one) */
  transaction<T>(fn: (tx: OrdersRepository) => Promise<T>): Promise<T>;

  /* generic table access (rows are mapped to typed jsonb at this boundary) */
  get<T extends Table>(table: T, id: string, o?: { forUpdate?: boolean }): Promise<Recs[T] | undefined>;
  find<T extends Table>(table: T, where: Where<Recs[T]>, o?: FindOptions<Recs[T]>): Promise<Recs[T][]>;
  count<T extends Table>(table: T, where: Where<Recs[T]>): Promise<number>;
  insert<T extends Table>(table: T, row: Recs[T]): Promise<Recs[T]>;
  insertMany<T extends Table>(table: T, rows: Recs[T][]): Promise<void>;
  update<T extends Table>(table: T, id: string, patch: Partial<Recs[T]>): Promise<Recs[T]>;
  remove<T extends Table>(table: T, id: string): Promise<void>;

  /** Inbox claim (ctx.inbox): true the first time this key is claimed; commits with the transaction it runs in */
  claim(key: string): Promise<boolean>;
  /** Inserts the order unless the (checkout session, attempt) pair already has one (then null) */
  insertOrderIfNew(row: OrderRec): Promise<OrderRec | null>;
  upsertShipment(row: ShipmentRec): Promise<ShipmentRec>;

  /* lists */
  customerOrders(customerId: string, f: CustomerOrderFilter, page: PageRequest): Promise<common.Page<OrderRec>>;
  customerTabCounts(customerId: string, placedFrom: Date | null): Promise<{ all: number; inProgress: number; delivered: number; returns: number; cancelled: number }>;
  /** Packages (groups) of the customer's open orders that are delayed or past their dispatch deadline */
  delayedGroupsOfCustomer(customerId: string, now: Date): Promise<GroupRec[]>;
  sellerGroups(sellerId: string, f: SellerGroupFilter, page: PageRequest, now: Date): Promise<common.Page<GroupRec>>;
  sellerCounts(sellerId: string, now: Date, endOfDay: Date): Promise<SellerCounts>;
  sellerTiles(sellerIds: string[], now: Date, endOfDay: Date, since30d: Date): Promise<Map<string, { open: number; overdueDispatch: number; dueToday: number; cancellationRequests: number; cancellations30d: number }>>;
  adminOrders(f: AdminOrderFilter, page: PageRequest, now: Date): Promise<common.Page<OrderRec>>;
  adminCount(f: AdminOrderFilter, now: Date): Promise<number>;
  guestOrdersByEmail(email: string): Promise<OrderRec[]>;
  /** Whether the customer (or, without one, the contact email) has an order whose payment was accepted */
  hasAcceptedOrder(who: { customerId?: string | null; email?: string | null }): Promise<boolean>;
  /** Orders in a lifecycle, by id, in bounded batches (jobs) */
  ordersInLifecycle(lifecycles: string[], afterId: string | null, limit: number): Promise<OrderRec[]>;
  ordersWithOpenGroupsOfSeller(sellerId: string): Promise<GroupRec[]>;
  countPurchased(customerId: string, offerId: string, since: Date): Promise<number>;
  verifiedPurchase(customerId: string, productId: string): Promise<ItemRec | undefined>;
  /** One item with its order, group and customer */
  itemInfo(itemId: string): Promise<ItemInfoRow | undefined>;
  /** Items delivered to the customer (delivered_at set), optionally since a time, newest delivery first */
  deliveredItemsOf(customerId: string, since: Date | null): Promise<ItemInfoRow[]>;
  itemCountsForProducts(productIds: string[]): Promise<{ product_id: string; open: number; past: number }[]>;
  openInCategories(categoryIds: string[], placedBefore: Date): Promise<{ orders: number; items: number }>;
  timelinePage(orderId: string, visibility: string | undefined, page: PageRequest): Promise<common.Page<TimelineRec>>;
  dueCancellationRequests(now: Date, limit: number): Promise<CancellationRec[]>;
  savedFiltersFor(staffId: string): Promise<SavedFilterRec[]>;
}
