/**
 * Row types of the orders collections (typed json fields) and the list filters the repository
 * (repository.ts) takes.
 */
import type * as catalog from '../../spec/catalog.js';
import type * as common from '../../spec/common.js';
import type * as offers from '../../spec/offers.js';
import type { AcceptedPolicyVersion, CancellationLine, DeliveryPromise, DiscountAllocation, OrdersDb, RefundPreview, ReturnTermsSnapshot, SellerLabel } from '../../spec/orders.js';

type Db = OrdersDb;

/** Event-fed facts of an order (orders.order_facts rows) as the views read them (core.factsOf) */
export interface FlagData {
  chargebacks?: { disputeId: string; kind: string; groupId?: string | null; at: string }[];
  deliveryIssues?: { exceptionId: string; kind: string; groupId: string; shipmentId?: string | null; dueAt: string; customerAction?: string | null; at: string }[];
  cases?: { caseId: string; ref: string; itemIds: string[]; status: string; nextUpdateBy?: string | null }[];
  restrictedGroups?: string[];
  captures?: { captureId: string; amount: number; at: string }[];
  /** payments.refund.sent already applied (idempotency) */
  refundsSent?: string[];
  /** Approved return refunds not sent yet (returns.refund.approved) */
  refundApprovals?: { id: string; returnRef?: string | null; amount: number; itemIds: string[] }[];
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

export interface OrderRec extends Omit<Db['orders'], 'delivery_address' | 'policy_versions' | 'coupon_codes'> {
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
export type FactRec = Db['order_facts'];
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
  order_facts: FactRec;
}
/** The orders collections (spec tables) */
export type TableName = keyof Recs;

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
  /** Only self-shipped (seller) or only Fulfilled by Marketly (marketly_service) groups */
  fulfilledBy?: 'seller' | 'marketly_service';
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
  /** Orders with at least one group fulfilled this way */
  fulfilledBy?: 'official_warehouse' | 'seller' | 'marketly_service';
}

export interface SellerCounts {
  new: number;
  preparing: number;
  shipped: number;
  completed: number;
  cancellationRequests: number;
  overdue: number;
  dueToday: number;
  /** Open Fulfilled by Marketly groups (left out of new, preparing, cancellationRequests, overdue and dueToday) */
  fulfilledByMarketly: number;
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
