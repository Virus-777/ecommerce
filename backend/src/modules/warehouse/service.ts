import type { EventPayload } from '../../kernel/events/index.js';
import type { WarehousePublicApi, Bin, Fulfillment } from '../../spec/warehouse.js';
import { Bins } from './service/bins.js';
import { Core, type WarehouseServiceDeps } from './service/core.js';
import { Fulfillments } from './service/fulfillments.js';
import { Packing } from './service/packing.js';
import { Parcels } from './service/parcels.js';
import { Putaway } from './service/putaway.js';
import { Summary, type TodaySummary } from './service/summary.js';
import { Views } from './service/views.js';

export type { WarehouseServiceDeps } from './service/core.js';

/**
 * Warehouse use cases. Depends only on ports, the event bus, the clock and other modules' public APIs.
 * Each method maps to a publicApi function, a consumed event or a job in docs/api/spec/modules/warehouse.json;
 * the HTTP handlers call the use-case groups (bins, fulfillments, packing, putaway, parcels, summary) directly.
 */
export class WarehouseService implements WarehousePublicApi {
  readonly core: Core;
  readonly views: Views;
  readonly bins: Bins;
  readonly fulfillments: Fulfillments;
  readonly packing: Packing;
  readonly putaway: Putaway;
  readonly parcels: Parcels;
  readonly summary: Summary;

  constructor(deps: WarehouseServiceDeps) {
    this.core = new Core(deps);
    this.views = new Views(this.core);
    this.bins = new Bins(this.core);
    this.fulfillments = new Fulfillments(this.core, this.views, this.bins);
    this.packing = new Packing(this.core, this.views, this.fulfillments);
    this.putaway = new Putaway(this.core, this.views, this.bins);
    this.parcels = new Parcels(this.core, this.views);
    this.summary = new Summary(this.core, this.views, this.bins, this.fulfillments);
  }

  /* ---------------- public API (in-process) */

  /** Serial numbers recorded at packing per order item, for the return inspection checklist ('Serial number matches order') */
  getShippedSerials(orderItemIds: string[]): Promise<Record<string, string[]>> {
    return this.packing.shippedSerials(orderItemIds);
  }

  /** Warehouse progress for an order's Official Store group (picking, packed, on hold) */
  getFulfillmentForOrder(orderId: string): Promise<Fulfillment | null> {
    return this.fulfillments.forOrder(orderId);
  }

  /** Primary bin, or a free bin in the item's zone, for put-away suggestions on receipts */
  suggestBin(stockItemId: string, locationId: string): Promise<Bin | null> {
    return this.bins.suggest(stockItemId, locationId);
  }

  /** Warehouse task per order seller group (null for groups outside sellers ship), batched for the admin order view */
  getTasksForOrderGroups(sellerGroupIds: string[]): Promise<Record<string, Fulfillment | null>> {
    return this.fulfillments.forGroups(sellerGroupIds);
  }

  /** Today's Official Store warehouse work (OpsQueues): to pick, to pack, packed waiting for pickup, dispatched today, on hold, at risk and late (ship-by passed, not dispatched), the next carrier pickup as the ship-by cutoff, and the most urgent tasks. Same counts as GET /summary. */
  getTodaySummary(locationId?: string): Promise<TodaySummary> {
    return this.summary.today(locationId);
  }

  /* ---------------- events consumed */

  /** orders.order.accepted: Create a fulfillment for the order's Official Store seller group (lines carry stock item ids from the purchase snapshot and ship-by from shipping) */
  onOrderAcceptedFromOrders(event: EventPayload<'orders.order.accepted'>): Promise<void> {
    return this.fulfillments.onOrderAccepted(event);
  }

  /** orders.item.cancelled: Cancel the line; if already picked, return units to the bin; if packed, flag the package to be reopened */
  onItemCancelledFromOrders(event: EventPayload<'orders.item.cancelled'>): Promise<void> {
    return this.fulfillments.onItemCancelled(event);
  }

  /** orders.item.split: split the fulfillment line so newItemId gets its own line (idempotent per newItemId) */
  onItemSplitFromOrders(event: EventPayload<'orders.item.split'>): Promise<void> {
    return this.fulfillments.onItemSplit(event);
  }

  /** inventory.discrepancy.resolved: Resume a held fulfillment when the shortage or damage was reallocated */
  onDiscrepancyResolvedFromInventory(event: EventPayload<'inventory.discrepancy.resolved'>): Promise<void> {
    return this.fulfillments.onDiscrepancyResolved(event);
  }

  /** purchasing.receipt.recorded: Create put-away tasks for received units (damaged units to a quarantine bin) */
  onReceiptRecordedFromPurchasing(event: EventPayload<'purchasing.receipt.recorded'>): Promise<void> {
    return this.putaway.onReceiptRecorded(event);
  }

  /** returns.return.approved: Expect a return parcel when the return goes to an Official Store warehouse */
  onReturnApprovedFromReturns(event: EventPayload<'returns.return.approved'>): Promise<void> {
    return this.parcels.onReturnApproved(event);
  }

  /** shipping.shipment.dispatched: Mark packages and the fulfillment dispatched */
  onShipmentDispatchedFromShipping(event: EventPayload<'shipping.shipment.dispatched'>): Promise<void> {
    return this.packing.onShipmentDispatched(event);
  }

  /** shipping.dispatch.overdue: Raise the fulfillment to the top of the pick list and flag it */
  onDispatchOverdueFromShipping(event: EventPayload<'shipping.dispatch.overdue'>): Promise<void> {
    return this.fulfillments.onDispatchOverdue(event);
  }

  /* ---------------- jobs */

  /** Job warehouse.flag-at-risk (every 15 min): Publish warehouse.fulfillment.at_risk for fulfillments not packed within atRiskMinutes of ship-by (work queue for the Warehouse and Shipping Managers) */
  async flagAtRisk(): Promise<void> {
    await this.summary.flagAtRisk();
  }

  /** Job warehouse.auto-wave (every 30 min during business hours (when enabled)): Create waves from fulfillments awaiting pick ahead of each carrier pickup time */
  async autoWave(): Promise<void> {
    await this.summary.autoWave();
  }

  /** Job warehouse.overdue-return-parcels (daily 08:00 market time): List expected return parcels past their expected date for returns follow-up */
  async overdueReturnParcels(): Promise<void> {
    await this.parcels.overdue();
  }
}
