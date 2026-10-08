import { notImplemented } from '../../kernel/errors/index.js';
import type { EventPayload } from '../../kernel/events/index.js';
import type { ModuleContext } from '../../kernel/module-system/index.js';
import type * as common from '../../spec/common.js';
import type * as identity from '../../spec/identity.js';
import type { InventoryPublicApi, IncomingCue, StockItem, SellerStockSummary, StockSummary, Reservation, InboundReceipt, Discrepancy } from '../../spec/inventory.js';
import type { InventoryRepository } from './ports.js';

export interface InventoryServiceDeps {
  repo: InventoryRepository;
  ctx: ModuleContext<'inventory'>;
}

/**
 * Inventory use cases. Depends only on ports, the event bus, the clock and other modules' public APIs.
 * Each method maps to a publicApi function, a consumed event or a job in docs/api/spec/modules/inventory.json.
 */
export class InventoryService implements InventoryPublicApi {
  readonly #deps: InventoryServiceDeps;

  constructor(deps: InventoryServiceDeps) {
    this.#deps = deps;
  }

  protected get deps(): InventoryServiceDeps {
    return this.#deps;
  }

  /* ---------------- public API (in-process) */

  /** Called when an offer is created. Seller items get the seller's virtual location. */
  async createStockItem(input: { ownerType: 'official'|'seller', sellerId?: string, offerId?: string, sku: string, productId: string, variantId: string, condition: string, label: string, initialAvailable: number, lowStockThreshold?: number, locationId?: string }): Promise<StockItem> {
    throw notImplemented('inventory.createStockItem');
  }

  /** Sellable quantity summed over sellable locations */
  async getAvailability(stockItemIds: string[]): Promise<Record<string, { available: number, state: string, lowStockThreshold: number|null, nextIncoming: IncomingCue|null }>> {
    throw notImplemented('inventory.getAvailability');
  }

  /** All-or-nothing checkout hold; throws INSUFFICIENT_STOCK with details per line. Same key returns the existing hold (idempotent). */
  async hold(key: string, lines: { stockItemId: string, quantity: number }[], ttlMinutes?: number): Promise<Reservation> {
    throw notImplemented('inventory.hold');
  }

  /** Keeps stock while a payment result is being checked (scenario 3) */
  async extendHold(reservationId: string, until: string): Promise<Reservation> {
    throw notImplemented('inventory.extendHold');
  }

  /** Links a hold to the placed order so acceptance can allocate it */
  async attachOrder(reservationId: string, orderId: string, lines: { stockItemId: string, orderItemId: string }[]): Promise<Reservation> {
    throw notImplemented('inventory.attachOrder');
  }

  /** Abandoned checkout or failed purchase */
  async releaseHold(reservationId: string, reason: string): Promise<void> {
    throw notImplemented('inventory.releaseHold');
  }

  /** Seller bulk file quantities, recorded as 'Bulk update' movements */
  async applyBulkQuantities(sellerId: string, rows: { stockItemId: string, newAvailable: number }[], jobId: string, actor: common.Actor): Promise<{ stockItemId: string, ok: boolean, error?: string }[]> {
    throw notImplemented('inventory.applyBulkQuantities');
  }

  /** Weighted average buying cost of company stock */
  async getUnitCost(stockItemId: string): Promise<common.Money | null> {
    throw notImplemented('inventory.getUnitCost');
  }

  /** Adds Incoming when a purchase order is sent; repeated calls replace the open quantities for that PO */
  async expectIncoming(purchaseOrderId: string, purchaseOrderRef: string, locationId: string, lines: { stockItemId: string, quantity: number, expectedDate: string }[]): Promise<void> {
    throw notImplemented('inventory.expectIncoming');
  }

  /** Cancelled or short-closed purchase orders */
  async cancelIncoming(purchaseOrderId: string, lines?: { stockItemId: string, quantity: number }[]): Promise<void> {
    throw notImplemented('inventory.cancelIncoming');
  }

  /** Counted receipt waiting for the Inventory Manager to confirm what can be sold */
  async submitInbound(receipt: { receiptId: string, receiptRef: string, purchaseOrderId: string, purchaseOrderRef: string, supplierName: string, locationId: string, receivedBy: common.Actor, receivedAt: string, lines: { stockItemId: string, expected: number, received: number, damaged: number, binCode?: string, unitCost: common.Money }[] }): Promise<InboundReceipt> {
    throw notImplemented('inventory.submitInbound');
  }

  /** Called from pick and pack. Damaged reserved units move to Damaged or held at once. */
  async reportDiscrepancy(input: { kind: 'pick_shortage'|'damage_found', stockItemId: string, locationId: string, binCode?: string, quantity: number, orderId?: string, orderRef?: string, note?: string, photoIds?: string[], reportedBy: common.Actor }): Promise<Discrepancy> {
    throw notImplemented('inventory.reportDiscrepancy');
  }

  /** Resolve SKUs from scans and files */
  async findBySku(ownerType: 'official'|'seller', skus: string[], sellerId?: string): Promise<StockItem[]> {
    throw notImplemented('inventory.findBySku');
  }

  /** Customer view of offer stock: state, low-stock count, quantity selector limit and restock estimate */
  async getOfferAvailability(offers: { offerId: string, stockItemId: string, purchaseLimit?: number }[]): Promise<Record<string, { state: string, quantity: number|null, maxPerOrder: number, purchaseLimit: number|null, label: string, expectedRestockDate: string|null }>> {
    throw notImplemented('inventory.getOfferAvailability');
  }

  /** Stock item per offer; with sellerId only that seller's items resolve */
  async getStockForOffers(offerIds: string[], viewer: { sellerId?: string }): Promise<Record<string, StockItem | null>> {
    throw notImplemented('inventory.getStockForOffers');
  }

  /** Stock items per variant: the seller's own items, or (staff) company and seller items, never summed */
  async listStockForVariants(variantIds: string[], viewer: { sellerId?: string }): Promise<Record<string, StockItem[]>> {
    throw notImplemented('inventory.listStockForVariants');
  }

  /** In stock, low, out of stock and reserved totals for the seller dashboard */
  async getSellerStockSummary(sellerId: string): Promise<SellerStockSummary> {
    throw notImplemented('inventory.getSellerStockSummary');
  }

  /** Official Store units and value at cost per stock group with low and out-of-stock counts */
  async getStockSummary(locationId?: string): Promise<StockSummary> {
    throw notImplemented('inventory.getStockSummary');
  }

  /** Export rows for reports datasets inventory.admin.stock and inventory.seller.stock (seller rows scoped to the principal's seller) */
  async exportRows(dataset: string, filters: unknown, principal: identity.Principal, cursor?: string): Promise<{ rows: unknown[], nextCursor?: string }> {
    throw notImplemented('inventory.exportRows');
  }

  /* ---------------- events consumed */

  /** orders.order.accepted: Allocate the order's held reservation lines to order items */
  async onOrderAcceptedFromOrders(event: EventPayload<"orders.order.accepted">): Promise<void> {
    void event;
    throw notImplemented('inventory consumer of orders.order.accepted');
  }

  /** orders.item.cancelled: Release that item's held or allocated units back to Available */
  async onItemCancelledFromOrders(event: EventPayload<"orders.item.cancelled">): Promise<void> {
    void event;
    throw notImplemented('inventory consumer of orders.item.cancelled');
  }

  /** shipping.shipment.dispatched: Fulfil the allocated lines in the shipment (Reserved → leaves stock) */
  async onShipmentDispatchedFromShipping(event: EventPayload<"shipping.shipment.dispatched">): Promise<void> {
    void event;
    throw notImplemented('inventory consumer of shipping.shipment.dispatched');
  }

  /** returns.return.received: Official Store items: add the units to Returned at the receiving warehouse. Seller returns are recorded by sellers through adjustments. */
  async onReturnReceivedFromReturns(event: EventPayload<"returns.return.received">): Promise<void> {
    void event;
    throw notImplemented('inventory consumer of returns.return.received');
  }

  /** returns.return.inspected: Create a pending return stock outcome with the inspector's proposed outcome */
  async onReturnInspectedFromReturns(event: EventPayload<"returns.return.inspected">): Promise<void> {
    void event;
    throw notImplemented('inventory consumer of returns.return.inspected');
  }

  /** warehouse.bin.assigned: Update the stock item's primary bin code shown in stock lists */
  async onBinAssignedFromWarehouse(event: EventPayload<"warehouse.bin.assigned">): Promise<void> {
    void event;
    throw notImplemented('inventory consumer of warehouse.bin.assigned');
  }

  /** offers.offer.status_changed: Archive a seller stock item when its offer is removed (reserved units stay with their orders) */
  async onOfferStatusChangedFromOffers(event: EventPayload<"offers.offer.status_changed">): Promise<void> {
    void event;
    throw notImplemented('inventory consumer of offers.offer.status_changed');
  }

  /** sellers.seller.closed: Archive the seller's stock items */
  async onSellerClosedFromSellers(event: EventPayload<"sellers.seller.closed">): Promise<void> {
    void event;
    throw notImplemented('inventory consumer of sellers.seller.closed');
  }

  /** access.approval.decided: Apply or reject adjustments waiting for second review */
  async onApprovalDecidedFromAccess(event: EventPayload<"access.approval.decided">): Promise<void> {
    void event;
    throw notImplemented('inventory consumer of access.approval.decided');
  }

  /* ---------------- jobs */

  /** Job inventory.expire-holds (every 1 min): Expire held reservations past expiresAt (Reserved → Available); publish inventory.reservation.released with reason expired */
  async expireHolds(): Promise<void> {
    throw notImplemented('job inventory.expire-holds');
  }

  /** Job inventory.reconcile-reservations (every 15 min): Find allocations whose order items are cancelled, completed or delivered without a matching event and raise them for review (no automatic release of allocated units) */
  async reconcileReservations(): Promise<void> {
    throw notImplemented('job inventory.reconcile-reservations');
  }

  /** Job inventory.low-stock-digest (daily 07:00 market time): Low and out-of-stock summary per seller and for the Official Store (notifications) */
  async lowStockDigest(): Promise<void> {
    throw notImplemented('job inventory.low-stock-digest');
  }

  /** Job inventory.held-stock-review (daily 07:00 market time): Publish inventory.hold.review_due for Damaged or held stock past its review date (work queue for the Inventory Manager) */
  async heldStockReview(): Promise<void> {
    throw notImplemented('job inventory.held-stock-review');
  }

  /** Job inventory.valuation-snapshot (daily 23:59 market time): Snapshot units and value at cost per group for company trading reports */
  async valuationSnapshot(): Promise<void> {
    throw notImplemented('job inventory.valuation-snapshot');
  }
}
