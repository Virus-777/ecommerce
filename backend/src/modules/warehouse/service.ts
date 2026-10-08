import { notImplemented } from '../../kernel/errors/index.js';
import type { EventPayload } from '../../kernel/events/index.js';
import type { ModuleContext } from '../../kernel/module-system/index.js';

import type { WarehousePublicApi, Bin, Fulfillment, WarehouseSummary } from '../../spec/warehouse.js';
import type { WarehouseRepository } from './ports.js';

export interface WarehouseServiceDeps {
  repo: WarehouseRepository;
  ctx: ModuleContext<'warehouse'>;
}

/**
 * Warehouse use cases. Depends only on ports, the event bus, the clock and other modules' public APIs.
 * Each method maps to a publicApi function, a consumed event or a job in docs/api/spec/modules/warehouse.json.
 */
export class WarehouseService implements WarehousePublicApi {
  readonly #deps: WarehouseServiceDeps;

  constructor(deps: WarehouseServiceDeps) {
    this.#deps = deps;
  }

  protected get deps(): WarehouseServiceDeps {
    return this.#deps;
  }

  /* ---------------- public API (in-process) */

  /** Serial numbers recorded at packing per order item, for the return inspection checklist ('Serial number matches order') */
  async getShippedSerials(orderItemIds: string[]): Promise<Record<string, string[]>> {
    throw notImplemented('warehouse.getShippedSerials');
  }

  /** Warehouse progress for an order's Official Store group (picking, packed, on hold) */
  async getFulfillmentForOrder(orderId: string): Promise<Fulfillment | null> {
    throw notImplemented('warehouse.getFulfillmentForOrder');
  }

  /** Primary bin, or a free bin in the item's zone, for put-away suggestions on receipts */
  async suggestBin(stockItemId: string, locationId: string): Promise<Bin | null> {
    throw notImplemented('warehouse.suggestBin');
  }

  /** Warehouse task per order seller group (null for groups outside sellers ship), batched for the admin order view */
  async getTasksForOrderGroups(sellerGroupIds: string[]): Promise<Record<string, Fulfillment | null>> {
    throw notImplemented('warehouse.getTasksForOrderGroups');
  }

  /** Today's Official Store warehouse work (OpsQueues): to pick, to pack, packed waiting for pickup, dispatched today, on hold, at risk and late (ship-by passed, not dispatched), the next carrier pickup as the ship-by cutoff, and the most urgent tasks. Same counts as GET /summary. */
  async getTodaySummary(locationId?: string): Promise<WarehouseSummary & { date: string, toShip: number, shipToday: number, dispatchedToday: number, late: number, shipByCutoff: string | null, pickupsToday: string[], urgent: Fulfillment[] }> {
    throw notImplemented('warehouse.getTodaySummary');
  }

  /* ---------------- events consumed */

  /** orders.order.accepted: Create a fulfillment for the order's Official Store seller group (lines carry stock item ids from the purchase snapshot and ship-by from shipping) */
  async onOrderAcceptedFromOrders(event: EventPayload<"orders.order.accepted">): Promise<void> {
    void event;
    throw notImplemented('warehouse consumer of orders.order.accepted');
  }

  /** orders.item.cancelled: Cancel the line; if already picked, return units to the bin; if packed, flag the package to be reopened */
  async onItemCancelledFromOrders(event: EventPayload<"orders.item.cancelled">): Promise<void> {
    void event;
    throw notImplemented('warehouse consumer of orders.item.cancelled');
  }

  /** inventory.discrepancy.resolved: Resume a held fulfillment when the shortage or damage was reallocated */
  async onDiscrepancyResolvedFromInventory(event: EventPayload<"inventory.discrepancy.resolved">): Promise<void> {
    void event;
    throw notImplemented('warehouse consumer of inventory.discrepancy.resolved');
  }

  /** purchasing.receipt.recorded: Create put-away tasks for received units (damaged units to a quarantine bin) */
  async onReceiptRecordedFromPurchasing(event: EventPayload<"purchasing.receipt.recorded">): Promise<void> {
    void event;
    throw notImplemented('warehouse consumer of purchasing.receipt.recorded');
  }

  /** returns.return.approved: Expect a return parcel when the return goes to an Official Store warehouse */
  async onReturnApprovedFromReturns(event: EventPayload<"returns.return.approved">): Promise<void> {
    void event;
    throw notImplemented('warehouse consumer of returns.return.approved');
  }

  /** shipping.shipment.dispatched: Mark packages and the fulfillment dispatched */
  async onShipmentDispatchedFromShipping(event: EventPayload<"shipping.shipment.dispatched">): Promise<void> {
    void event;
    throw notImplemented('warehouse consumer of shipping.shipment.dispatched');
  }

  /** shipping.dispatch.overdue: Raise the fulfillment to the top of the pick list and flag it */
  async onDispatchOverdueFromShipping(event: EventPayload<"shipping.dispatch.overdue">): Promise<void> {
    void event;
    throw notImplemented('warehouse consumer of shipping.dispatch.overdue');
  }

  /* ---------------- jobs */

  /** Job warehouse.flag-at-risk (every 15 min): Publish warehouse.fulfillment.at_risk for fulfillments not packed within atRiskMinutes of ship-by (work queue for the Warehouse and Shipping Managers) */
  async flagAtRisk(): Promise<void> {
    throw notImplemented('job warehouse.flag-at-risk');
  }

  /** Job warehouse.auto-wave (every 30 min during business hours (when enabled)): Create waves from fulfillments awaiting pick ahead of each carrier pickup time */
  async autoWave(): Promise<void> {
    throw notImplemented('job warehouse.auto-wave');
  }

  /** Job warehouse.overdue-return-parcels (daily 08:00 market time): List expected return parcels past their expected date for returns follow-up */
  async overdueReturnParcels(): Promise<void> {
    throw notImplemented('job warehouse.overdue-return-parcels');
  }
}
