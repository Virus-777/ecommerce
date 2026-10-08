import { notImplemented } from '../../kernel/errors/index.js';
import type { EventPayload } from '../../kernel/events/index.js';
import type { ModuleContext } from '../../kernel/module-system/index.js';

import type { FulfillmentServicePublicApi, FulfillmentRequest } from '../../spec/fulfillment-service.js';
import type { FulfillmentServiceRepository } from './ports.js';

export interface FulfillmentServiceServiceDeps {
  repo: FulfillmentServiceRepository;
  ctx: ModuleContext<'fulfillment-service'>;
}

/**
 * Fulfillment service use cases. Depends only on ports, the event bus, the clock and other modules' public APIs.
 * Each method maps to a publicApi function, a consumed event or a job in docs/api/spec/modules/fulfillment-service.json.
 */
export class FulfillmentServiceService implements FulfillmentServicePublicApi {
  readonly #deps: FulfillmentServiceServiceDeps;

  constructor(deps: FulfillmentServiceServiceDeps) {
    this.#deps = deps;
  }

  protected get deps(): FulfillmentServiceServiceDeps {
    return this.#deps;
  }

  /* ---------------- public API (in-process) */

  /** True when the offer is fulfilled by Marketly. Offers shows 'Ships from Marketly' while the seller stays named; orders route the seller group's fulfillment to our warehouse. */
  async isServiceOffer(offerId: string): Promise<boolean> {
    throw notImplemented('fulfillment-service.isServiceOffer');
  }

  /** Owner of stock in our warehouse; reports and inventory use it to keep seller stock separate from company stock (plan ch. 9). */
  async stockOwner(stockItemId: string): Promise<{ kind: 'company' | 'seller', sellerId?: string }> {
    throw notImplemented('fulfillment-service.stockOwner');
  }

  /** Called when a seller group contains service offers; creates the warehouse pick task. Also triggered by orders.order.placed. */
  async createFulfillmentRequest(orderId: string, sellerGroupId: string, items: { orderItemId: string, offerId: string, quantity: number }[]): Promise<FulfillmentRequest> {
    throw notImplemented('fulfillment-service.createFulfillmentRequest');
  }

  /* ---------------- events consumed */

  /** orders.order.placed: Create fulfillment requests for seller groups with service offers */
  async onOrderPlacedFromOrders(event: EventPayload<"orders.order.placed">): Promise<void> {
    void event;
    throw notImplemented('fulfillment-service consumer of orders.order.placed');
  }

  /** orders.item.cancelled: Cancel or shorten open fulfillment requests and release seller-owned reservations */
  async onItemCancelledFromOrders(event: EventPayload<"orders.item.cancelled">): Promise<void> {
    void event;
    throw notImplemented('fulfillment-service consumer of orders.item.cancelled');
  }

  /** shipping.shipment.dispatched: Mark requests shipped; accrue pick-and-pack and order handling fees */
  async onShipmentDispatchedFromShipping(event: EventPayload<"shipping.shipment.dispatched">): Promise<void> {
    void event;
    throw notImplemented('fulfillment-service consumer of shipping.shipment.dispatched');
  }

  /** returns.return.received: Create a service return for units returned to our warehouse; accrue the returns processing fee */
  async onReturnReceivedFromReturns(event: EventPayload<"returns.return.received">): Promise<void> {
    void event;
    throw notImplemented('fulfillment-service consumer of returns.return.received');
  }

  /** inventory.stock.low: Notify the seller to send more stock for service SKUs */
  async onStockLowFromInventory(event: EventPayload<"inventory.stock.low">): Promise<void> {
    void event;
    throw notImplemented('fulfillment-service consumer of inventory.stock.low');
  }

  /** sellers.seller.suspended: Suspend the enrollment for new inbound; keep fulfilling accepted orders */
  async onSellerSuspendedFromSellers(event: EventPayload<"sellers.seller.suspended">): Promise<void> {
    void event;
    throw notImplemented('fulfillment-service consumer of sellers.seller.suspended');
  }

  /** sellers.seller.closed: Start offboarding; ask the seller to remove stock */
  async onSellerClosedFromSellers(event: EventPayload<"sellers.seller.closed">): Promise<void> {
    void event;
    throw notImplemented('fulfillment-service consumer of sellers.seller.closed');
  }

  /** access.approval.decided: Apply approved fee schedules, reimbursements and fee reversals */
  async onApprovalDecidedFromAccess(event: EventPayload<"access.approval.decided">): Promise<void> {
    void event;
    throw notImplemented('fulfillment-service consumer of access.approval.decided');
  }

  /* ---------------- jobs */

  /** Job fulfillment-service.storage-snapshot (daily 23:55 market time): Record units and volume per seller SKU with age buckets */
  async storageSnapshot(): Promise<void> {
    throw notImplemented('job fulfillment-service.storage-snapshot');
  }

  /** Job fulfillment-service.monthly-storage-fees (monthly, 1st 03:00 market time): Accrue storage and long-term storage fees from the month's snapshots */
  async monthlyStorageFees(): Promise<void> {
    throw notImplemented('job fulfillment-service.monthly-storage-fees');
  }

  /** Job fulfillment-service.post-fees (daily 02:30 market time): Post accrued fees to finance (fee.charged) */
  async postFees(): Promise<void> {
    throw notImplemented('job fulfillment-service.post-fees');
  }

  /** Job fulfillment-service.inbound-overdue (daily): Flag inbound shipments past expected arrival; close discrepancies without a seller response after discrepancyResponseDays */
  async inboundOverdue(): Promise<void> {
    throw notImplemented('job fulfillment-service.inbound-overdue');
  }

  /** Job fulfillment-service.aged-stock-notice (weekly): Warn sellers about units approaching long-term storage */
  async agedStockNotice(): Promise<void> {
    throw notImplemented('job fulfillment-service.aged-stock-notice');
  }

  /** Job fulfillment-service.reconcile (daily): Compare the ownership ledger with inventory quantities per seller SKU; open a work item for differences */
  async reconcile(): Promise<void> {
    throw notImplemented('job fulfillment-service.reconcile');
  }
}
