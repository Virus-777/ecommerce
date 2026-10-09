import type { EventPayload } from '../../kernel/events/index.js';
import type { FulfillmentServicePublicApi, FulfillmentRequest } from '../../spec/fulfillment-service.js';
import { Core, type FulfillmentServiceServiceDeps, type Parts } from './service/core.js';
import { EnrollmentPart } from './service/enrollment.js';
import { FEES_ACTION, FeesPart, REVERSE_ACTION, SCHEDULE_TARGET, CHARGE_TARGET } from './service/fees.js';
import { DISCREPANCY_TARGET, InboundPart, REIMBURSE_ACTION } from './service/inbound.js';
import { RemovalsPart } from './service/removals.js';
import { RequestsPart } from './service/requests.js';
import { ReturnsPart } from './service/returns.js';
import { SkusPart } from './service/skus.js';
import { StockPart } from './service/stock.js';
import { Views } from './service/views.js';

export type { FulfillmentServiceServiceDeps } from './service/core.js';

/**
 * Fulfillment service use cases. Depends only on ports, the event bus, the clock and other modules' public APIs.
 * Each method maps to a publicApi function, a consumed event or a job in docs/api/spec/modules/fulfillment-service.json;
 * the HTTP handlers call the use-case groups (enrollment, skus, inbound, requests, returns, removals, fees, stock).
 */
export class FulfillmentServiceService implements FulfillmentServicePublicApi {
  readonly core: Core;
  readonly parts: Parts;

  constructor(deps: FulfillmentServiceServiceDeps) {
    this.core = new Core(deps);
    const parts = {} as Parts;
    parts.views = new Views(this.core, parts);
    parts.stock = new StockPart(this.core, parts);
    parts.enrollment = new EnrollmentPart(this.core, parts);
    parts.skus = new SkusPart(this.core, parts);
    parts.inbound = new InboundPart(this.core, parts);
    parts.requests = new RequestsPart(this.core, parts);
    parts.returns = new ReturnsPart(this.core, parts);
    parts.removals = new RemovalsPart(this.core, parts);
    parts.fees = new FeesPart(this.core, parts);
    this.parts = parts;
  }

  /* ---------------- public API (in-process) */

  /** True when the offer is fulfilled by Marketly. Offers shows 'Ships from Marketly' while the seller stays named; orders route the seller group's fulfillment to our warehouse. */
  isServiceOffer(offerId: string): Promise<boolean> {
    return this.parts.skus.isServiceOffer(offerId);
  }

  /** Owner of stock in our warehouse; reports and inventory use it to keep seller stock separate from company stock (plan ch. 9). */
  stockOwner(stockItemId: string): Promise<{ kind: 'company' | 'seller'; sellerId?: string }> {
    return this.parts.skus.stockOwner(stockItemId);
  }

  /** Called when a seller group contains service offers; creates the warehouse pick task. Also triggered by orders.order.placed. */
  createFulfillmentRequest(orderId: string, sellerGroupId: string, items: { orderItemId: string; offerId: string; quantity: number }[]): Promise<FulfillmentRequest> {
    return this.parts.requests.create(orderId, sellerGroupId, items);
  }

  /* ---------------- events consumed */

  /** orders.order.placed: Create fulfillment requests for seller groups with service offers */
  onOrderPlacedFromOrders(event: EventPayload<'orders.order.placed'>): Promise<void> {
    return this.parts.requests.onOrderPlaced(event);
  }

  /** orders.item.cancelled: Cancel or shorten open fulfillment requests and release seller-owned reservations */
  onItemCancelledFromOrders(event: EventPayload<'orders.item.cancelled'>): Promise<void> {
    return this.parts.requests.onItemCancelled(event);
  }

  /** shipping.shipment.dispatched: Mark requests shipped; accrue pick-and-pack and order handling fees */
  onShipmentDispatchedFromShipping(event: EventPayload<'shipping.shipment.dispatched'>): Promise<void> {
    return this.parts.requests.onShipmentDispatched(event);
  }

  /** returns.return.received: Create a service return for units returned to our warehouse; accrue the returns processing fee */
  onReturnReceivedFromReturns(event: EventPayload<'returns.return.received'>): Promise<void> {
    return this.parts.returns.onReturnReceived(event);
  }

  /** inventory.stock.low: Notify the seller to send more stock for service SKUs */
  async onStockLowFromInventory(event: EventPayload<'inventory.stock.low'>): Promise<void> {
    if (event.ownerType !== 'seller' || !event.sellerId || !event.offerId) return;
    const sku = await this.core.repo.findOne('sku_enrollments', { offer_id: event.offerId, state: 'active' });
    if (!sku || sku.seller_id !== event.sellerId) return;
    await this.core.notifySeller(
      sku.seller_id,
      'seller.stock.low',
      { stock: { label: `${event.label} at Marketly's warehouse: send more in an inbound shipment`, available: String(event.available) } },
      { kind: 'queue', id: sku.id, label: 'Plan an inbound shipment', screen: 'seller/inventory' },
      `fulfillment-service:low:${sku.id}:${this.core.today()}`,
    );
  }

  /** sellers.seller.suspended: Suspend the enrollment for new inbound; keep fulfilling accepted orders */
  onSellerSuspendedFromSellers(event: EventPayload<'sellers.seller.suspended'>): Promise<void> {
    return this.parts.enrollment.onSellerSuspended(event);
  }

  /** sellers.seller.closed: Start offboarding; ask the seller to remove stock */
  onSellerClosedFromSellers(event: EventPayload<'sellers.seller.closed'>): Promise<void> {
    return this.parts.enrollment.onSellerClosed(event);
  }

  /** access.approval.decided: Apply approved fee schedules, reimbursements and fee reversals */
  async onApprovalDecidedFromAccess(event: EventPayload<'access.approval.decided'>, eventId?: string): Promise<void> {
    if (event.actionKey === FEES_ACTION && event.target?.type === SCHEDULE_TARGET) await this.parts.fees.onScheduleDecided(event);
    else if (event.actionKey === REVERSE_ACTION && event.target?.type === CHARGE_TARGET) await this.parts.fees.onReverseDecided(event, eventId);
    else if (event.actionKey === REIMBURSE_ACTION && event.target?.type === DISCREPANCY_TARGET) await this.parts.inbound.onReimbursementDecided(event);
  }

  /* ---------------- jobs */

  /** Job fulfillment-service.storage-snapshot (daily 23:55 market time): Record units and volume per seller SKU with age buckets */
  async storageSnapshot(): Promise<void> {
    await this.parts.stock.snapshot();
  }

  /** Job fulfillment-service.monthly-storage-fees (monthly, 1st 03:00 market time): Accrue storage and long-term storage fees from the month's snapshots */
  async monthlyStorageFees(): Promise<void> {
    await this.parts.fees.monthlyStorage();
  }

  /** Job fulfillment-service.post-fees (daily 02:30 market time): Post accrued fees to finance (fee.charged) */
  async postFees(): Promise<void> {
    await this.core.syncSchedules();
    await this.parts.fees.postAll();
  }

  /** Job fulfillment-service.inbound-overdue (daily): Flag inbound shipments past expected arrival; close discrepancies without a seller response after discrepancyResponseDays */
  async inboundOverdue(): Promise<void> {
    await this.parts.inbound.overdue();
  }

  /** Job fulfillment-service.aged-stock-notice (weekly): Warn sellers about units approaching long-term storage */
  async agedStockNotice(): Promise<void> {
    await this.parts.stock.agedNotice();
  }

  /** Job fulfillment-service.reconcile (daily): Compare the ownership ledger with inventory quantities per seller SKU; open a work item for differences */
  async reconcile(): Promise<void> {
    await this.parts.stock.reconcile();
  }
}
