import type { EventEnvelope, EventPayload } from '../../kernel/events/index.js';
import type * as common from '../../spec/common.js';
import type * as identity from '../../spec/identity.js';
import type {
  Discrepancy,
  IncomingCue,
  InboundReceipt,
  InventoryPublicApi,
  Location,
  Reservation,
  SellerStockSummary,
  StockItem,
  StockItemRef,
  StockQuantities,
  StockSummary,
} from '../../spec/inventory.js';
import { Core, type InventoryServiceDeps } from './service/core.js';
import { Items } from './service/items.js';
import { Reservations } from './service/reservations.js';
import { Receiving } from './service/receiving.js';
import { ServiceStock } from './service/service-stock.js';
import { SellerStock } from './service/seller-stock.js';
import { CompanyStock } from './service/company-stock.js';
import { Reports } from './service/reports.js';
import { Adjustments } from './service/adjustments.js';
import { Returns } from './service/returns.js';
import { Discrepancies } from './service/discrepancies.js';
import { Locations } from './service/locations.js';
import { Transfers } from './service/transfers.js';
import { Counts } from './service/counts.js';

export type { By, InventoryServiceDeps, SellerBy, StaffBy } from './service/core.js';

/**
 * Inventory use cases. Depends only on its repository, the event bus, the clock and other modules' public APIs.
 * The work is split by feature (service/*.ts); this class is the module's public API, its event consumers and jobs.
 * The HTTP and GraphQL handlers call the features directly (service.<feature>.<method>).
 */
export class InventoryService implements InventoryPublicApi {
  readonly core: Core;
  readonly items: Items;
  readonly reservations: Reservations;
  readonly receiving: Receiving;
  readonly serviceStock: ServiceStock;
  readonly sellerStock: SellerStock;
  readonly companyStock: CompanyStock;
  readonly reports: Reports;
  readonly adjustments: Adjustments;
  readonly returns: Returns;
  readonly discrepancies: Discrepancies;
  readonly locations: Locations;
  readonly transfers: Transfers;
  readonly counts: Counts;

  constructor(deps: InventoryServiceDeps) {
    this.core = new Core(deps);
    this.items = new Items(this.core);
    this.reservations = new Reservations(this.core);
    this.receiving = new Receiving(this.core);
    this.serviceStock = new ServiceStock(this.core, this.receiving);
    this.sellerStock = new SellerStock(this.core);
    this.companyStock = new CompanyStock(this.core, this.items);
    this.reports = new Reports(this.core, this.sellerStock, this.companyStock);
    this.adjustments = new Adjustments(this.core);
    this.returns = new Returns(this.core, this.adjustments);
    this.discrepancies = new Discrepancies(this.core, this.adjustments, this.reservations);
    this.locations = new Locations(this.core);
    this.transfers = new Transfers(this.core);
    this.counts = new Counts(this.core, this.adjustments);
  }

  /* ---------------- public API (in-process) */

  async createStockItem(input: { ownerType: 'official' | 'seller'; sellerId?: string; offerId?: string; sku: string; productId: string; variantId: string; condition: string; label: string; initialAvailable: number; lowStockThreshold?: number; locationId?: string }): Promise<StockItem> {
    return this.items.createStockItem(input);
  }

  async getAvailability(stockItemIds: string[]): Promise<Record<string, { available: number; state: string; lowStockThreshold: number | null; nextIncoming: IncomingCue | null }>> {
    return this.items.getAvailability(stockItemIds);
  }

  async hold(key: string, lines: { stockItemId: string; quantity: number }[], ttlMinutes?: number): Promise<Reservation> {
    return this.reservations.hold(key, lines, ttlMinutes);
  }

  async extendHold(reservationId: string, until: string): Promise<Reservation> {
    return this.reservations.extendHold(reservationId, until);
  }

  async attachOrder(reservationId: string, orderId: string, lines: { stockItemId: string; orderItemId: string }[]): Promise<Reservation> {
    return this.reservations.attachOrder(reservationId, orderId, lines);
  }

  async releaseHold(reservationId: string, reason: string): Promise<void> {
    return this.reservations.releaseHold(reservationId, reason);
  }

  async allocateForOrder(input: {
    key: string;
    orderId: string;
    orderRef?: string;
    source: { kind: 'replacement' | 'exchange'; id: string; ref?: string };
    lines: { stockItemId: string; quantity: number; orderItemId?: string }[];
    actor: common.Actor;
  }): Promise<Reservation> {
    return this.reservations.allocateForOrder(input);
  }

  async getLocations(opts: { ownerType?: 'official' | 'seller'; sellerId?: string; activeOnly?: boolean } = {}): Promise<Location[]> {
    return this.locations.getLocations(opts);
  }

  async getDefaultLocation(): Promise<Location | null> {
    return this.locations.getDefaultLocation();
  }

  async updateStockItem(stockItemId: string, patch: { productId?: string; variantId?: string; condition?: string; sku?: string; label?: string; offerId?: string }, actor: common.Actor): Promise<StockItem> {
    return this.items.updateStockItem(stockItemId, patch, actor);
  }

  async unarchiveStockItem(stockItemId: string, actor: common.Actor): Promise<StockItem> {
    return this.items.unarchiveStockItem(stockItemId, actor);
  }

  async mergeStockItems(fromStockItemId: string, intoStockItemId: string, reason: string, actor: common.Actor): Promise<StockItem> {
    return this.items.mergeStockItems(fromStockItemId, intoStockItemId, reason, actor);
  }

  async getSalesRate(stockItemIds: string[], days = 30): Promise<Record<string, { unitsSold: number; days: number; avgDailySales: number }>> {
    return this.items.getSalesRate(stockItemIds, days);
  }

  async applyBulkQuantities(sellerId: string, rows: { stockItemId: string; newAvailable: number }[], jobId: string, actor: common.Actor): Promise<{ stockItemId: string; ok: boolean; error?: string }[]> {
    return this.sellerStock.applyBulkQuantities(sellerId, rows, jobId, actor);
  }

  async getUnitCost(stockItemId: string): Promise<common.Money | null> {
    return this.items.getUnitCost(stockItemId);
  }

  async expectIncoming(purchaseOrderId: string, purchaseOrderRef: string, locationId: string, lines: { stockItemId: string; quantity: number; expectedDate: string }[]): Promise<void> {
    return this.receiving.expectIncoming(purchaseOrderId, purchaseOrderRef, locationId, lines);
  }

  async cancelIncoming(purchaseOrderId: string, lines?: { stockItemId: string; quantity: number }[]): Promise<void> {
    return this.receiving.cancelIncoming(purchaseOrderId, lines);
  }

  async submitInbound(receipt: { receiptId: string; receiptRef: string; purchaseOrderId: string; purchaseOrderRef: string; supplierName: string; locationId: string; receivedBy: common.Actor; receivedAt: string; lines: { stockItemId: string; expected: number; received: number; damaged: number; binCode?: string; unitCost: common.Money }[] }): Promise<InboundReceipt> {
    return this.receiving.submitInbound(receipt);
  }

  async reportDiscrepancy(input: { kind: 'pick_shortage' | 'damage_found'; stockItemId: string; locationId: string; binCode?: string; quantity: number; orderId?: string; orderRef?: string; note?: string; photoIds?: string[]; reportedBy: common.Actor }): Promise<Discrepancy> {
    return this.discrepancies.reportDiscrepancy(input);
  }

  async findBySku(ownerType: 'official' | 'seller', skus: string[], sellerId?: string): Promise<StockItem[]> {
    return this.items.findBySku(ownerType, skus, sellerId);
  }

  async getStockItems(stockItemIds: string[]): Promise<StockItemRef[]> {
    return this.items.getStockItems(stockItemIds);
  }

  async getOfferAvailability(offers: { offerId: string; stockItemId: string; purchaseLimit?: number }[]): Promise<Record<string, { state: string; quantity: number | null; maxPerOrder: number; purchaseLimit: number | null; label: string; expectedRestockDate: string | null }>> {
    return this.items.getOfferAvailability(offers);
  }

  async getStockForOffers(offerIds: string[], viewer: { sellerId?: string }): Promise<Record<string, StockItem | null>> {
    return this.items.getStockForOffers(offerIds, viewer);
  }

  async listStockForVariants(variantIds: string[], viewer: { sellerId?: string }): Promise<Record<string, StockItem[]>> {
    return this.items.listStockForVariants(variantIds, viewer);
  }

  async getSellerStockSummary(sellerId: string): Promise<SellerStockSummary> {
    return this.sellerStock.getSellerStockSummary(sellerId);
  }

  async getStockSummary(locationId?: string): Promise<StockSummary> {
    return this.reports.getStockSummary(locationId);
  }

  async exportRows(dataset: string, filters: unknown, principal: identity.Principal, cursor?: string): Promise<{ rows: unknown[]; nextCursor?: string }> {
    return this.reports.exportRows(dataset, filters, principal, cursor);
  }

  async setServiceLocation(stockItemId: string, locationId: string | null, actor: common.Actor): Promise<StockItem> {
    return this.serviceStock.setServiceLocation(stockItemId, locationId, actor);
  }

  async moveServiceStock(input: Parameters<InventoryPublicApi['moveServiceStock']>[0]): Promise<{ movementId: string; levels: StockQuantities }> {
    return this.serviceStock.moveServiceStock(input);
  }

  async expectServiceInbound(input: { inboundId: string; ref: string; locationId: string; lines: { stockItemId: string; quantity: number; expectedDate?: string }[] }): Promise<void> {
    return this.serviceStock.expectServiceInbound(input);
  }

  async cancelServiceInbound(inboundId: string): Promise<void> {
    return this.serviceStock.cancelServiceInbound(inboundId);
  }

  async submitServiceReceipt(receipt: Parameters<InventoryPublicApi['submitServiceReceipt']>[0]): Promise<InboundReceipt> {
    return this.serviceStock.submitServiceReceipt(receipt);
  }

  async getLevels(stockItemIds: string[], locationId: string): Promise<Record<string, StockQuantities>> {
    return this.items.getLevels(stockItemIds, locationId);
  }

  /* ---------------- events consumed */

  async onOrderAcceptedFromOrders(event: EventPayload<'orders.order.accepted'>): Promise<void> {
    return this.reservations.onOrderAcceptedFromOrders(event);
  }

  async onItemSplitFromOrders(event: EventPayload<'orders.item.split'>): Promise<void> {
    return this.reservations.onItemSplitFromOrders(event);
  }

  async onItemCancelledFromOrders(event: EventPayload<'orders.item.cancelled'>): Promise<void> {
    return this.reservations.onItemCancelledFromOrders(event);
  }

  async onShipmentDispatchedFromShipping(event: EventPayload<'shipping.shipment.dispatched'>): Promise<void> {
    return this.reservations.onShipmentDispatchedFromShipping(event);
  }

  async onReturnReceivedFromReturns(event: EventPayload<'returns.return.received'>): Promise<void> {
    return this.returns.onReturnReceivedFromReturns(event);
  }

  async onReturnInspectedFromReturns(event: EventPayload<'returns.return.inspected'>, envelope?: Pick<EventEnvelope, 'at'>): Promise<void> {
    return this.returns.onReturnInspectedFromReturns(event, envelope);
  }

  async onBinAssignedFromWarehouse(event: EventPayload<'warehouse.bin.assigned'>): Promise<void> {
    return this.items.onBinAssignedFromWarehouse(event);
  }

  async onOfferStatusChangedFromOffers(event: EventPayload<'offers.offer.status_changed'>): Promise<void> {
    return this.items.onOfferStatusChangedFromOffers(event);
  }

  async onProductMergedFromCatalog(event: EventPayload<'catalog.product.merged'>): Promise<void> {
    return this.items.onProductMergedFromCatalog(event);
  }

  async onSellerClosedFromSellers(event: EventPayload<'sellers.seller.closed'>): Promise<void> {
    return this.items.onSellerClosedFromSellers(event);
  }

  async onApprovalDecidedFromAccess(event: EventPayload<'access.approval.decided'>): Promise<void> {
    return this.adjustments.onApprovalDecidedFromAccess(event);
  }

  /* ---------------- jobs */

  async expireHolds(): Promise<void> {
    return this.reservations.expireHolds();
  }

  async reconcileReservations(): Promise<number> {
    return this.reservations.reconcileReservations();
  }

  async lowStockDigest(): Promise<{ owners: number; items: number }> {
    return this.reports.lowStockDigest();
  }

  async heldStockReview(): Promise<number> {
    return this.adjustments.heldStockReview();
  }

  async valuationSnapshot(): Promise<StockSummary> {
    return this.reports.valuationSnapshot();
  }

  /* ---------------- export datasets (registered after boot) */

  async registerDatasets(): Promise<void> {
    return this.reports.registerDatasets();
  }
}
