import { notImplemented } from '../../kernel/errors/index.js';
import type { EventPayload } from '../../kernel/events/index.js';
import type { ModuleContext } from '../../kernel/module-system/index.js';
import type * as common from '../../spec/common.js';
import type * as identity from '../../spec/identity.js';
import type { OrdersPublicApi, Contact, OrderSummary, OrderDetail, DelayedItemAlert, FulfillmentTask, ItemPaidAmount, SellerOrderCounts, SellerOrderDetail, AdminOrderDetail, OrderCreateInput } from '../../spec/orders.js';
import type { OrdersRepository } from './ports.js';

export interface OrdersServiceDeps {
  repo: OrdersRepository;
  ctx: ModuleContext<'orders'>;
}

/**
 * Orders use cases. Depends only on ports, the event bus, the clock and other modules' public APIs.
 * Each method maps to a publicApi function, a consumed event or a job in docs/api/spec/modules/orders.json.
 */
export class OrdersService implements OrdersPublicApi {
  readonly #deps: OrdersServiceDeps;

  constructor(deps: OrdersServiceDeps) {
    this.#deps = deps;
  }

  protected get deps(): OrdersServiceDeps {
    return this.#deps;
  }

  /* ---------------- public API (in-process) */

  /** Create the order from an authorized or pending payment. Freezes catalog.snapshotForOrder and offers.snapshotForOrder per item. Status open when paymentState=accepted (publishes orders.order.placed and orders.order.accepted in one transaction), payment_pending otherwise (publishes orders.order.placed only). Idempotent per checkoutSessionId: a second call returns the existing order. */
  async createOrder(input: OrderCreateInput): Promise<OrderDetail> {
    throw notImplemented('orders.createOrder');
  }

  /** payment_pending → open when the payment result arrives (also done on payments.payment.authorized). Idempotent. */
  async acceptOrder(orderId: string, paymentIntentId: string): Promise<OrderDetail> {
    throw notImplemented('orders.acceptOrder');
  }

  /** payment_pending → cancelled when a pending payment is finally declined (also done on payments.payment.failed). */
  async cancelForDeclinedPayment(orderId: string): Promise<void> {
    throw notImplemented('orders.cancelForDeclinedPayment');
  }

  /** Full order for other modules (no access check) */
  async getOrder(orderId: string): Promise<OrderDetail | null> {
    throw notImplemented('orders.getOrder');
  }

  /** Seller group with ship-to address, delivery promise, dispatch deadline and items still to ship */
  async getFulfillmentTask(groupId: string): Promise<FulfillmentTask> {
    throw notImplemented('orders.getFulfillmentTask');
  }

  /** Items belong to the group, are not cancelled or already shipped, and quantities fit */
  async canShipItems(groupId: string, lines: { orderItemId: string, quantity: number }[]): Promise<{ ok: boolean, problems: string[] }> {
    throw notImplemented('orders.canShipItems');
  }

  /** Recalculated deadline (e.g. a payment accepted late) or a staff extension; publishes orders.dispatch_deadline.changed */
  async setDispatchDeadline(groupId: string, dueAt: string, reason: string, actor: common.Actor): Promise<void> {
    throw notImplemented('orders.setDispatchDeadline');
  }

  /** Per item: paid amount split into item, discount share, shipping share and tax share, for refund caps */
  async getPaidAmounts(orderId: string): Promise<ItemPaidAmount[]> {
    throw notImplemented('orders.getPaidAmounts');
  }

  /** Match a guest order by reference and checkout email (case-insensitive); used by the guest lookup */
  async findGuestOrder(orderRef: string, email: string): Promise<{ orderId: string } | null> {
    throw notImplemented('orders.findGuestOrder');
  }

  /** Guest orders for emailed order links */
  async listGuestOrdersByEmail(email: string): Promise<{ orderId: string, ref: string, placedAt: string }[]> {
    throw notImplemented('orders.listGuestOrdersByEmail');
  }

  /** Account overview tile */
  async countInProgress(customerId: string): Promise<{ inProgress: number, delayedPackages: number }> {
    throw notImplemented('orders.countInProgress');
  }

  /** Account overview recent orders */
  async listRecentForCustomer(customerId: string, limit: number): Promise<OrderSummary[]> {
    throw notImplemented('orders.listRecentForCustomer');
  }

  /** Account overview delay alerts with new estimate and options */
  async listDelayedItemsForCustomer(customerId: string): Promise<DelayedItemAlert[]> {
    throw notImplemented('orders.listDelayedItemsForCustomer');
  }

  /** Units bought recently, for per-customer purchase limits */
  async countPurchased(customerId: string, offerId: string, sinceDays: number): Promise<number> {
    throw notImplemented('orders.countPurchased');
  }

  /** Delivered purchase of the product for Verified Purchase labels */
  async isVerifiedPurchase(customerId: string, productId: string): Promise<{ orderItemId: string, deliveredAt: string } | null> {
    throw notImplemented('orders.isVerifiedPurchase');
  }

  /** Store order detail by reference. Returns the order only when it belongs to the signed-in customer or the guest session has access (identity.hasGuestOrderAccess); otherwise null (NOT_FOUND). */
  async getOrderForViewer(viewer: { customerId?: string, guestSessionId?: string }, ref: string): Promise<OrderDetail | null> {
    throw notImplemented('orders.getOrderForViewer');
  }

  /** Order history with search, date range and status tab (same filters as GET /orders); fields are resolved lazily so list cards stay cheap */
  async listOrdersForCustomer(customerId: string, filter: { q?: string, range?: string, from?: string, to?: string, tab?: string }, page: common.PageInput): Promise<common.Page<OrderDetail>> {
    throw notImplemented('orders.listOrdersForCustomer');
  }

  /** Counts per status tab plus delayed packages (account overview tiles, order list tabs, customer 360) */
  async countOrdersByTab(customerId: string, range?: string): Promise<{ all: number, inProgress: number, delivered: number, returns: number, cancelled: number, delayedPackages: number }> {
    throw notImplemented('orders.countOrdersByTab');
  }

  /** One order as a seller sees it: only the seller's own groups (items, money, ship-to while needed, cancellations, timeline) and seller-safe order fields. Null (NOT_FOUND) when the order has no group of this seller. */
  async getOrderForSeller(sellerId: string, ref: string): Promise<{ order: OrderDetail, groups: SellerOrderDetail[] } | null> {
    throw notImplemented('orders.getOrderForSeller');
  }

  /** The seller's orders by stage with dispatch deadlines (same filters as seller GET /orders); own groups only */
  async listOrdersForSeller(sellerId: string, filter: { tab?: string, tabs?: string[], q?: string, placedFrom?: string, placedTo?: string, overdueOnly?: boolean, sort?: string }, page: common.PageInput): Promise<common.Page<{ order: OrderDetail, groups: SellerOrderDetail[] }>> {
    throw notImplemented('orders.listOrdersForSeller');
  }

  /** Seller tab counts plus overdue and due today */
  async countSellerOrders(sellerId: string): Promise<SellerOrderCounts> {
    throw notImplemented('orders.countSellerOrders');
  }

  /** Order 360 across sellers for staff: groups, items, money by seller, after-sales, flags, notes and staff history. Contact details masked unless orders.customers.view-contact. */
  async getOrderAdmin(ref: string): Promise<AdminOrderDetail | null> {
    throw notImplemented('orders.getOrderAdmin');
  }

  /** Staff order list (same filters as admin GET /orders plus customerId) for the customer and seller 360 views */
  async listOrdersAdmin(filter: { q?: string, sellerType?: string, sellerId?: string, customerId?: string, fulfillmentStatus?: string, paymentState?: string, placedFrom?: string, placedTo?: string, flag?: string, savedFilterId?: string }, page: common.PageInput): Promise<common.Page<AdminOrderDetail>> {
    throw notImplemented('orders.listOrdersAdmin');
  }

  /** Batched order lookup for order fields on other modules' records (Case.order, Return.order, RefundRequest.order). Same visibility as order / sellerOrder / orderAdmin: store → only orders of the signed-in customer or a guest session with access; seller → only the caller's own groups and seller-safe fields (null when the order has no group of this seller); admin → order 360 (contact masked unless orders.customers.view-contact). Not visible → null (never an error that reveals the order exists). */
  async getOrdersByIds(viewer: { area: 'store'|'seller'|'admin', customerId?: string, guestSessionId?: string, sellerId?: string }, orderIds: string[]): Promise<Record<string, OrderDetail | { order: OrderDetail, groups: SellerOrderDetail[] } | AdminOrderDetail | null>> {
    throw notImplemented('orders.getOrdersByIds');
  }

  /** Seller 360 order tiles (staff): open orders (a group of the seller not yet delivered or cancelled), groups past their dispatch deadline, due today, pending customer cancellation requests and cancellations in the last 30 days. Recent orders use listOrdersAdmin with filter.sellerId. */
  async countOrdersForSellers(sellerIds: string[]): Promise<Record<string, { open: number, overdueDispatch: number, dueToday: number, cancellationRequests: number, cancellations30d: number }>> {
    throw notImplemented('orders.countOrdersForSellers');
  }

  /** Export rows for reports datasets orders.admin.orders and orders.seller.orders (seller rows are the seller's own groups; customer email and phone masked without orders.customers.view-contact) */
  async exportRows(dataset: string, filters: unknown, principal: identity.Principal, cursor?: string): Promise<{ rows: unknown[], nextCursor?: string }> {
    throw notImplemented('orders.exportRows');
  }

  /** Order items per product from the purchase snapshots: open (not yet delivered, cancelled or refunded) and past (everything else). Catalog publication-impact and merge previews. */
  async countOrderItemsForProducts(productIds: string[]): Promise<Record<string, { open: number, past: number }>> {
    throw notImplemented('orders.countOrderItemsForProducts');
  }

  /** Orders placed before the date with at least one item in the category (snapshot category, subcategories included) that is not yet delivered, cancelled or refunded. Returns category-exception preview. */
  async countOpenOrdersInCategory(categoryId: string, placedBefore: string): Promise<{ orders: number, items: number }> {
    throw notImplemented('orders.countOpenOrdersInCategory');
  }

  /* ---------------- events consumed */

  /** payments.payment.authorized: Accept a payment_pending order when its uncertain payment is confirmed (acceptOrder) */
  async onPaymentAuthorizedFromPayments(event: EventPayload<"payments.payment.authorized">): Promise<void> {
    void event;
    throw notImplemented('orders consumer of payments.payment.authorized');
  }

  /** payments.payment.failed: Cancel a payment_pending order whose payment was finally declined (no refund needed) */
  async onPaymentFailedFromPayments(event: EventPayload<"payments.payment.failed">): Promise<void> {
    void event;
    throw notImplemented('orders consumer of payments.payment.failed');
  }

  /** payments.payment.captured: Update payment progress (charged amount and date) */
  async onPaymentCapturedFromPayments(event: EventPayload<"payments.payment.captured">): Promise<void> {
    void event;
    throw notImplemented('orders consumer of payments.payment.captured');
  }

  /** payments.refund.status_changed: Mirror refund progress on the items (processing, sent, failed) and the order's refunded total */
  async onRefundStatusChangedFromPayments(event: EventPayload<"payments.refund.status_changed">): Promise<void> {
    void event;
    throw notImplemented('orders consumer of payments.refund.status_changed');
  }

  /** payments.refund.sent: Add to refundedAmount; move a line to refunded when its whole refundable amount is sent */
  async onRefundSentFromPayments(event: EventPayload<"payments.refund.sent">): Promise<void> {
    void event;
    throw notImplemented('orders consumer of payments.refund.sent');
  }

  /** payments.chargeback.opened: Flag the order (chargeback) */
  async onChargebackOpenedFromPayments(event: EventPayload<"payments.chargeback.opened">): Promise<void> {
    void event;
    throw notImplemented('orders consumer of payments.chargeback.opened');
  }

  /** shipping.shipment.created: Add the shipment to the group projection (carrier, tracking, contents) for display and tracking-number search */
  async onShipmentCreatedFromShipping(event: EventPayload<"shipping.shipment.created">): Promise<void> {
    void event;
    throw notImplemented('orders consumer of shipping.shipment.created');
  }

  /** shipping.shipment.dispatched: Items in the shipment become Shipped (splitting lines for partial quantities) */
  async onShipmentDispatchedFromShipping(event: EventPayload<"shipping.shipment.dispatched">): Promise<void> {
    void event;
    throw notImplemented('orders consumer of shipping.shipment.dispatched');
  }

  /** shipping.shipment.status_changed: Update the shipment projection and the delivery progress */
  async onShipmentStatusChangedFromShipping(event: EventPayload<"shipping.shipment.status_changed">): Promise<void> {
    void event;
    throw notImplemented('orders consumer of shipping.shipment.status_changed');
  }

  /** shipping.shipment.delivered: Items become Delivered; publish orders.item.delivered with the return window end */
  async onShipmentDeliveredFromShipping(event: EventPayload<"shipping.shipment.delivered">): Promise<void> {
    void event;
    throw notImplemented('orders consumer of shipping.shipment.delivered');
  }

  /** shipping.shipment.exception: Flag delivery issues on the group (failed delivery, lost or damaged, missing tracking) */
  async onShipmentExceptionFromShipping(event: EventPayload<"shipping.shipment.exception">): Promise<void> {
    void event;
    throw notImplemented('orders consumer of shipping.shipment.exception');
  }

  /** shipping.dispatch.overdue: Unshipped items of the group become Delayed; publish orders.item.delayed (customer is told and offered support) */
  async onDispatchOverdueFromShipping(event: EventPayload<"shipping.dispatch.overdue">): Promise<void> {
    void event;
    throw notImplemented('orders consumer of shipping.dispatch.overdue');
  }

  /** shipping.tracking.corrected: Update the projection and add a timeline entry */
  async onTrackingCorrectedFromShipping(event: EventPayload<"shipping.tracking.corrected">): Promise<void> {
    void event;
    throw notImplemented('orders consumer of shipping.tracking.corrected');
  }

  /** warehouse.fulfillment.status_changed: Official Store items become Preparing when picking starts (and close the window for instant cancellation) */
  async onFulfillmentStatusChangedFromWarehouse(event: EventPayload<"warehouse.fulfillment.status_changed">): Promise<void> {
    void event;
    throw notImplemented('orders consumer of warehouse.fulfillment.status_changed');
  }

  /** returns.return.requested: Items become Return requested */
  async onReturnRequestedFromReturns(event: EventPayload<"returns.return.requested">): Promise<void> {
    void event;
    throw notImplemented('orders consumer of returns.return.requested');
  }

  /** returns.return.received: Items become Returned */
  async onReturnReceivedFromReturns(event: EventPayload<"returns.return.received">): Promise<void> {
    void event;
    throw notImplemented('orders consumer of returns.return.received');
  }

  /** returns.return.cancelled: Items go back to Delivered */
  async onReturnCancelledFromReturns(event: EventPayload<"returns.return.cancelled">): Promise<void> {
    void event;
    throw notImplemented('orders consumer of returns.return.cancelled');
  }

  /** returns.return.rejected: Items go back to Delivered */
  async onReturnRejectedFromReturns(event: EventPayload<"returns.return.rejected">): Promise<void> {
    void event;
    throw notImplemented('orders consumer of returns.return.rejected');
  }

  /** returns.refund.approved: Item refund status Approved (shown as not yet sent) */
  async onRefundApprovedFromReturns(event: EventPayload<"returns.refund.approved">): Promise<void> {
    void event;
    throw notImplemented('orders consumer of returns.refund.approved');
  }

  /** returns.replacement.created: Add a replacement line (confirmed) linked to the original item; the original keeps its history */
  async onReplacementCreatedFromReturns(event: EventPayload<"returns.replacement.created">): Promise<void> {
    void event;
    throw notImplemented('orders consumer of returns.replacement.created');
  }

  /** support.case.opened: Flag the order and link the case to its items */
  async onCaseOpenedFromSupport(event: EventPayload<"support.case.opened">): Promise<void> {
    void event;
    throw notImplemented('orders consumer of support.case.opened');
  }

  /** sellers.seller.restricted: Flag open groups of the seller (seller_restricted); orders stay accessible and fulfillable */
  async onSellerRestrictedFromSellers(event: EventPayload<"sellers.seller.restricted">): Promise<void> {
    void event;
    throw notImplemented('orders consumer of sellers.seller.restricted');
  }

  /** identity.user.verified: Attach guest orders placed with the verified email to the new customer account */
  async onUserVerifiedFromIdentity(event: EventPayload<"identity.user.verified">): Promise<void> {
    void event;
    throw notImplemented('orders consumer of identity.user.verified');
  }

  /* ---------------- jobs */

  /** Job orders.auto-accept-cancellations (every 5 min): Accept customer cancellation requests past respondBy when nothing has shipped; publishes orders.cancellation.decided (auto_accepted) and orders.item.cancelled */
  async autoAcceptCancellations(): Promise<void> {
    throw notImplemented('job orders.auto-accept-cancellations');
  }

  /** Job orders.refresh-flags (every 5 min): Recompute order flags (due soon, overdue, payment checking) and saved filter counts */
  async refreshFlags(): Promise<void> {
    throw notImplemented('job orders.refresh-flags');
  }

  /** Job orders.complete-orders (daily 02:00 PT): Move open orders to completed when every item is final, return windows have closed and nothing is open; publishes orders.order.completed */
  async completeOrders(): Promise<void> {
    throw notImplemented('job orders.complete-orders');
  }
}
