import type { EventPayload } from '../../kernel/events/index.js';
import type * as common from '../../spec/common.js';
import type * as identity from '../../spec/identity.js';
import { isUuid } from '../../kernel/lib/ids.js';
import type { AdminOrderDetail, DelayedItemAlert, FulfillmentTask, ItemPaidAmount, OrderCreateInput, OrderDetail, OrderItemInfo, OrdersPublicApi, OrderSummary, SellerOrderCounts, SellerOrderDetail } from '../../spec/orders.js';
import type { ItemInfoRow } from './ports.js';
import { Admin, CONTACT_PERMISSION } from './service/admin.js';
import { AfterSales } from './service/aftersales.js';
import { Cancellations } from './service/cancellations.js';
import { Core, invalid, notFound, type OrdersServiceDeps } from './service/core.js';
import { Fulfillment } from './service/fulfillment.js';
import { Placement } from './service/placement.js';
import { Reads, type StoreViewer } from './service/reads.js';
import { Views } from './service/views.js';

export type { OrdersServiceDeps };

const itemInfo = (r: ItemInfoRow): OrderItemInfo => ({
  id: r.id,
  orderId: r.order_id,
  orderRef: r.order_ref,
  groupId: r.group_id,
  ownerType: r.owner_type as OrderItemInfo['ownerType'],
  sellerId: r.seller_id,
  customerId: r.customer_id,
  offerId: r.offer_id,
  productId: r.product_id,
  variantId: r.variant_id,
  stockItemId: r.stock_item_id,
  categoryId: r.category_id,
  quantity: r.quantity,
  state: r.state as OrderItemInfo['state'],
  deliveredAt: r.delivered_at ? r.delivered_at.toISOString() : null,
  returnWindowEndsAt: r.return_window_ends_at ? r.return_window_ends_at.toISOString() : null,
});

/**
 * Orders use cases. Depends only on ports, the event bus, the clock and other modules' public APIs.
 * The work is split by area (service/*.ts); this class is the module's public API, its event consumers and jobs.
 */
export class OrdersService implements OrdersPublicApi {
  readonly core: Core;
  readonly views: Views;
  readonly reads: Reads;
  readonly placement: Placement;
  readonly cancellations: Cancellations;
  readonly fulfillment: Fulfillment;
  readonly afterSales: AfterSales;
  readonly admin: Admin;

  constructor(deps: OrdersServiceDeps) {
    this.core = new Core(deps);
    this.views = new Views(this.core);
    this.reads = new Reads(this.core, this.views);
    this.placement = new Placement(this.core, this.views);
    this.cancellations = new Cancellations(this.core, this.views);
    this.fulfillment = new Fulfillment(this.core, this.views);
    this.afterSales = new AfterSales(this.core);
    this.admin = new Admin(this.core, this.views, this.reads);
  }

  /* ---------------- public API (in-process) */

  createOrder(input: OrderCreateInput): Promise<OrderDetail> {
    return this.placement.createOrder(input);
  }

  acceptOrder(orderId: string, paymentIntentId: string): Promise<OrderDetail> {
    return this.placement.acceptOrder(orderId, paymentIntentId);
  }

  cancelForDeclinedPayment(orderId: string): Promise<void> {
    return this.placement.cancelForDeclinedPayment(orderId);
  }

  async getOrder(orderId: string): Promise<OrderDetail | null> {
    const agg = await this.core.load(orderId).catch(() => undefined);
    if (!agg) return null;
    return this.views.detail(agg, await this.core.timelineOf(orderId, ['customer']), 'internal', await this.core.cfg());
  }

  getFulfillmentTask(groupId: string): Promise<FulfillmentTask> {
    return this.fulfillment.getFulfillmentTask(groupId);
  }

  canShipItems(groupId: string, lines: { orderItemId: string; quantity: number }[]): Promise<{ ok: boolean; problems: string[] }> {
    return this.fulfillment.canShipItems(groupId, lines);
  }

  setDispatchDeadline(groupId: string, dueAt: string, reason: string, actor: common.Actor): Promise<void> {
    return this.fulfillment.setDispatchDeadline(groupId, dueAt, reason, actor);
  }

  getPaidAmounts(orderId: string): Promise<ItemPaidAmount[]> {
    return this.reads.paidAmounts(orderId);
  }

  async findGuestOrder(orderRef: string, email: string): Promise<{ orderId: string } | null> {
    const o = (await this.core.repo.find('orders', { ref: orderRef.trim().toUpperCase() }))[0];
    if (!o || o.contact_email.trim().toLowerCase() !== email.trim().toLowerCase()) return null;
    return { orderId: o.id };
  }

  async listGuestOrdersByEmail(email: string): Promise<{ orderId: string; ref: string; placedAt: string }[]> {
    return (await this.core.repo.guestOrdersByEmail(email)).map((o) => ({ orderId: o.id, ref: o.ref, placedAt: o.placed_at.toISOString() }));
  }

  async countInProgress(customerId: string): Promise<{ inProgress: number; delayedPackages: number }> {
    const c = await this.reads.countByTab(customerId);
    return { inProgress: c.inProgress, delayedPackages: c.delayedPackages };
  }

  listRecentForCustomer(customerId: string, limit: number): Promise<OrderSummary[]> {
    return this.reads.recent(customerId, limit);
  }

  listDelayedItemsForCustomer(customerId: string): Promise<DelayedItemAlert[]> {
    return this.reads.delayedItems(customerId);
  }

  countPurchased(customerId: string, offerId: string, sinceDays: number): Promise<number> {
    return this.core.repo.countPurchased(customerId, offerId, new Date(this.core.now().getTime() - Math.max(0, sinceDays) * 86_400_000));
  }

  /** An accepted order exists for the customer (or, for guests, the normalised contact email): promotions new_customers */
  hasPlacedOrder(who: { customerId?: string; email?: string }): Promise<boolean> {
    if (who.customerId && !isUuid(who.customerId)) return Promise.resolve(false);
    return this.core.repo.hasAcceptedOrder({ customerId: who.customerId ?? null, email: who.customerId ? null : (who.email ?? null) });
  }

  async isVerifiedPurchase(customerId: string, productId: string): Promise<{ orderItemId: string; deliveredAt: string } | null> {
    const i = await this.core.repo.verifiedPurchase(customerId, productId);
    return i?.delivered_at ? { orderItemId: i.id, deliveredAt: i.delivered_at.toISOString() } : null;
  }

  getOrderForViewer(viewer: StoreViewer & { customerId?: string; guestSessionId?: string }, ref: string): Promise<OrderDetail | null> {
    return this.reads.getOrderForViewer(viewer, ref);
  }

  listOrdersForCustomer(customerId: string, filter: { q?: string; range?: string; from?: string; to?: string; tab?: string }, page: common.PageInput): Promise<common.Page<OrderDetail>> {
    return this.reads.listOrdersForCustomer(customerId, filter, page);
  }

  countOrdersByTab(customerId: string, range?: string) {
    return this.reads.countByTab(customerId, range);
  }

  getOrderForSeller(sellerId: string, ref: string): Promise<{ order: OrderDetail; groups: SellerOrderDetail[] } | null> {
    return this.reads.getOrderForSeller(sellerId, ref);
  }

  listOrdersForSeller(
    sellerId: string,
    filter: { tab?: string; tabs?: string[]; q?: string; placedFrom?: string; placedTo?: string; overdueOnly?: boolean; sort?: string },
    page: common.PageInput,
  ): Promise<common.Page<{ order: OrderDetail; groups: SellerOrderDetail[] }>> {
    return this.reads.listOrdersForSeller(sellerId, filter, page);
  }

  countSellerOrders(sellerId: string): Promise<SellerOrderCounts> {
    return this.reads.sellerCounts(sellerId);
  }

  /** Contact details masked unless the principal (when given) holds orders.customers.view-contact */
  async getOrderAdmin(ref: string, principal?: identity.Principal | null): Promise<AdminOrderDetail | null> {
    const canViewContact = principal ? await this.core.can(principal, CONTACT_PERMISSION) : false;
    return this.reads.getOrderAdmin(ref, canViewContact);
  }

  listOrdersAdmin(
    filter: { q?: string; sellerType?: string; sellerId?: string; customerId?: string; fulfillmentStatus?: string; paymentState?: string; placedFrom?: string; placedTo?: string; flag?: string; savedFilterId?: string },
    page: common.PageInput,
  ): Promise<common.Page<AdminOrderDetail>> {
    return this.reads.listOrdersAdmin(filter as never, page);
  }

  getOrdersByIds(
    viewer: { area: 'store' | 'seller' | 'admin'; customerId?: string; guestSessionId?: string; sellerId?: string },
    orderIds: string[],
  ): Promise<Record<string, OrderDetail | { order: OrderDetail; groups: SellerOrderDetail[] } | AdminOrderDetail | null>> {
    return this.reads.getOrdersByIds(viewer, orderIds);
  }

  countOrdersForSellers(sellerIds: string[]) {
    return this.reads.countOrdersForSellers(sellerIds);
  }

  exportRows(dataset: string, filters: unknown, principal: identity.Principal, cursor?: string): Promise<{ rows: unknown[]; nextCursor?: string }> {
    return this.admin.exportRows(dataset, filters, principal, cursor);
  }

  async countOrderItemsForProducts(productIds: string[]): Promise<Record<string, { open: number; past: number }>> {
    const rows = await this.core.repo.itemCountsForProducts([...new Set(productIds)]);
    const out: Record<string, { open: number; past: number }> = {};
    for (const id of productIds) out[id] = { open: 0, past: 0 };
    for (const r of rows) out[r.product_id] = { open: r.open, past: r.past };
    return out;
  }

  /** One order item with its order, group owner, customer, state and delivery time (no access check) */
  async getOrderItem(orderItemId: string): Promise<OrderItemInfo | null> {
    if (!isUuid(orderItemId)) return null;
    const row = await this.core.repo.itemInfo(orderItemId);
    return row ? itemInfo(row) : null;
  }

  /** Items delivered to the customer (optionally since a time), newest delivery first: review eligibility */
  async listDeliveredItems(customerId: string, since?: string): Promise<OrderItemInfo[]> {
    if (!isUuid(customerId)) return [];
    let from: Date | null = null;
    if (since) {
      from = new Date(since);
      if (Number.isNaN(from.getTime())) throw invalid([{ path: 'since', message: 'Use an ISO date and time' }]);
    }
    return (await this.core.repo.deliveredItemsOf(customerId, from)).map(itemInfo);
  }

  /** Snapshot category of the items, with its subcategories (catalog's tree) */
  async countOpenOrdersInCategory(categoryId: string, placedBefore: string): Promise<{ orders: number; items: number }> {
    const ids = new Set([categoryId]);
    const tree = await this.core.ctx
      .use('catalog')
      .listCategories({ includeHidden: true })
      .catch(() => []);
    const walk = (list: typeof tree, inside: boolean) => {
      for (const c of list) {
        const here = inside || c.id === categoryId;
        if (here) ids.add(c.id);
        walk(c.children ?? [], here);
      }
    };
    walk(tree, false);
    const before = new Date(placedBefore);
    if (Number.isNaN(before.getTime())) throw notFound('Date');
    return this.core.repo.openInCategories([...ids], before);
  }

  /* ---------------- events consumed */

  onPaymentAuthorizedFromPayments(event: EventPayload<'payments.payment.authorized'>) {
    return this.placement.onPaymentAuthorized(event);
  }

  onPaymentFailedFromPayments(event: EventPayload<'payments.payment.failed'>) {
    return this.placement.onPaymentFailed(event);
  }

  onPaymentCapturedFromPayments(event: EventPayload<'payments.payment.captured'>) {
    return this.placement.onPaymentCaptured(event);
  }

  onRefundStatusChangedFromPayments(event: EventPayload<'payments.refund.status_changed'>) {
    return this.afterSales.onRefundStatusChanged(event);
  }

  onRefundSentFromPayments(event: EventPayload<'payments.refund.sent'>) {
    return this.afterSales.onRefundSent(event);
  }

  onChargebackOpenedFromPayments(event: EventPayload<'payments.chargeback.opened'>) {
    return this.afterSales.onChargebackOpened(event);
  }

  onShipmentCreatedFromShipping(event: EventPayload<'shipping.shipment.created'>) {
    return this.fulfillment.onShipmentCreated(event);
  }

  onShipmentDispatchedFromShipping(event: EventPayload<'shipping.shipment.dispatched'>) {
    return this.fulfillment.onShipmentDispatched(event);
  }

  onShipmentStatusChangedFromShipping(event: EventPayload<'shipping.shipment.status_changed'>) {
    return this.fulfillment.onShipmentStatusChanged(event);
  }

  onShipmentDeliveredFromShipping(event: EventPayload<'shipping.shipment.delivered'>) {
    return this.fulfillment.onShipmentDelivered(event);
  }

  onShipmentExceptionFromShipping(event: EventPayload<'shipping.shipment.exception'>) {
    return this.fulfillment.onShipmentException(event);
  }

  onDispatchOverdueFromShipping(event: EventPayload<'shipping.dispatch.overdue'>) {
    return this.fulfillment.onDispatchOverdue(event);
  }

  onTrackingCorrectedFromShipping(event: EventPayload<'shipping.tracking.corrected'>) {
    return this.fulfillment.onTrackingCorrected(event);
  }

  onFulfillmentStatusChangedFromWarehouse(event: EventPayload<'warehouse.fulfillment.status_changed'>) {
    return this.fulfillment.onWarehouseStatusChanged(event);
  }

  onReturnRequestedFromReturns(event: EventPayload<'returns.return.requested'>) {
    return this.afterSales.onReturnRequested(event);
  }

  onReturnReceivedFromReturns(event: EventPayload<'returns.return.received'>) {
    return this.afterSales.onReturnReceived(event);
  }

  onReturnCancelledFromReturns(event: EventPayload<'returns.return.cancelled'>) {
    return this.afterSales.onReturnCancelled(event);
  }

  onReturnRejectedFromReturns(event: EventPayload<'returns.return.rejected'>) {
    return this.afterSales.onReturnRejected(event);
  }

  onRefundApprovedFromReturns(event: EventPayload<'returns.refund.approved'>) {
    return this.afterSales.onRefundApproved(event);
  }

  onReplacementCreatedFromReturns(event: EventPayload<'returns.replacement.created'>) {
    return this.afterSales.onReplacementCreated(event);
  }

  onCaseOpenedFromSupport(event: EventPayload<'support.case.opened'>) {
    return this.afterSales.onCaseOpened(event);
  }

  onCaseResolvedFromSupport(event: EventPayload<'support.case.resolved'>, eventId?: string) {
    return this.afterSales.onCaseStatus(event, 'resolved', eventId);
  }

  onCaseReopenedFromSupport(event: EventPayload<'support.case.reopened'>, eventId?: string) {
    return this.afterSales.onCaseStatus(event, 'open', eventId);
  }

  onSellerRestrictedFromSellers(event: EventPayload<'sellers.seller.restricted'>) {
    return this.afterSales.onSellerRestricted(event);
  }

  onUserVerifiedFromIdentity(event: EventPayload<'identity.user.verified'>) {
    return this.afterSales.onUserVerified(event);
  }

  /* ---------------- jobs */

  autoAcceptCancellations() {
    return this.cancellations.autoAccept();
  }

  refreshFlags() {
    return this.afterSales.refreshFlags(() => this.admin.countSavedFilters());
  }

  completeOrders() {
    return this.afterSales.completeOrders();
  }
}
