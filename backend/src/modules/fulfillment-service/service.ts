import type { EventPayload } from '../../kernel/events/index.js';
import type * as common from '../../spec/common.js';
import type { FulfillmentRequest, FulfillmentServicePublicApi, ServiceTerms } from '../../spec/fulfillment-service.js';
import type { Principal } from '../../spec/identity.js';
import { Core, type FulfillmentServiceServiceDeps, type Parts } from './service/core.js';
import { DIFFERENCE_TARGET, DifferencesPart } from './service/differences.js';
import { EnrollmentPart } from './service/enrollment.js';
import { ExportsPart } from './service/exports.js';
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
 * the HTTP handlers call the use-case groups (enrollment, skus, inbound, requests, returns, removals, fees, stock,
 * differences, exports).
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
    parts.differences = new DifferencesPart(this.core, parts);
    parts.exports = new ExportsPart(this.core, parts);
    this.parts = parts;
  }

  /* ---------------------------------------------------------------- public API (in-process) */

  /** True when Marketly fulfils the offer, sellable or not (the rule of getServiceTerms) */
  isServiceOffer(offerId: string): Promise<boolean> {
    return this.parts.skus.isServiceOffer(offerId);
  }

  /** Customer-facing fulfilment terms of Marketly-fulfilled offers; null when not Marketly-fulfilled */
  getServiceTerms(offerIds: string[]): Promise<Record<string, ServiceTerms | null>> {
    return this.parts.skus.serviceTerms(offerIds);
  }

  /** The company warehouse that holds and ships seller stock; null when no company location exists */
  getServiceLocation(): Promise<{ locationId: string; address: common.Address; shipsFrom: string } | null> {
    return this.parts.skus.serviceLocation();
  }

  /** Owner of stock in our warehouse; reports and inventory use it to keep seller stock separate from company stock (plan ch. 9). */
  stockOwner(stockItemId: string): Promise<{ kind: 'company' | 'seller'; sellerId?: string }> {
    return this.parts.skus.stockOwner(stockItemId);
  }

  /** Kept for staff tooling and tests: requests come from orders.order.accepted */
  async createFulfillmentRequest(orderId: string, sellerGroupId: string, items: { orderItemId: string; offerId: string; quantity: number }[]): Promise<FulfillmentRequest> {
    return (await this.parts.requests.create(orderId, sellerGroupId, items)).request;
  }

  /** Rows of the report datasets this module registers */
  exportRows(dataset: string, filters: unknown, principal: Principal, cursor?: string): Promise<{ rows: unknown[]; nextCursor?: string }> {
    return this.parts.exports.exportRows(dataset, filters, principal, cursor);
  }

  /* ---------------------------------------------------------------- events consumed */

  onOrderAcceptedFromOrders(event: EventPayload<'orders.order.accepted'>): Promise<void> {
    return this.parts.requests.onOrderAccepted(event);
  }

  onOrderCancelledFromOrders(event: EventPayload<'orders.order.cancelled'>): Promise<void> {
    return this.parts.requests.onOrderCancelled(event);
  }

  onItemCancelledFromOrders(event: EventPayload<'orders.item.cancelled'>): Promise<void> {
    return this.parts.requests.onItemCancelled(event);
  }

  onItemSplitFromOrders(event: EventPayload<'orders.item.split'>): Promise<void> {
    return this.parts.requests.onItemSplit(event);
  }

  onShipmentDispatchedFromShipping(event: EventPayload<'shipping.shipment.dispatched'>): Promise<void> {
    return this.parts.requests.onShipmentDispatched(event);
  }

  onFulfillmentStatusChangedFromWarehouse(event: EventPayload<'warehouse.fulfillment.status_changed'>): Promise<void> {
    return this.parts.requests.onWarehouseStatus(event);
  }

  onReturnReceivedFromReturns(event: EventPayload<'returns.return.received'>): Promise<void> {
    return this.parts.returns.onReturnReceived(event);
  }

  onReturnInspectedFromReturns(event: EventPayload<'returns.return.inspected'>): Promise<void> {
    return this.parts.returns.onReturnInspected(event);
  }

  onReceiptConfirmedFromInventory(event: EventPayload<'inventory.receipt.confirmed'>): Promise<void> {
    return this.parts.inbound.onReceiptConfirmed(event);
  }

  onAdjustmentRecordedFromInventory(event: EventPayload<'inventory.adjustment.recorded'>): Promise<void> {
    return this.parts.differences.onAdjustmentRecorded(event);
  }

  onStockLowFromInventory(event: EventPayload<'inventory.stock.low'>): Promise<void> {
    return this.parts.stock.onStockLow(event);
  }

  onSellerSuspendedFromSellers(event: EventPayload<'sellers.seller.suspended'>): Promise<void> {
    return this.parts.enrollment.onSellerSuspended(event);
  }

  onSellerReinstatedFromSellers(event: EventPayload<'sellers.seller.reinstated'>): Promise<void> {
    return this.parts.enrollment.onSellerReinstated(event);
  }

  onSellerClosedFromSellers(event: EventPayload<'sellers.seller.closed'>): Promise<void> {
    return this.parts.enrollment.onSellerClosed(event);
  }

  /** access.approval.decided: approved fee schedules, reimbursements (discrepancies, stock differences) and fee reversals */
  async onApprovalDecidedFromAccess(event: EventPayload<'access.approval.decided'>, eventId?: string): Promise<void> {
    if (event.actionKey === FEES_ACTION && event.target?.type === SCHEDULE_TARGET) await this.parts.fees.onScheduleDecided(event);
    else if (event.actionKey === REVERSE_ACTION && event.target?.type === CHARGE_TARGET) await this.parts.fees.onReverseDecided(event, eventId);
    else if (event.actionKey === REIMBURSE_ACTION && event.target?.type === DISCREPANCY_TARGET) await this.parts.inbound.onReimbursementDecided(event);
    else if (event.actionKey === REIMBURSE_ACTION && event.target?.type === DIFFERENCE_TARGET) await this.parts.differences.onReimbursementDecided(event);
  }

  /* ---------------------------------------------------------------- jobs */

  async storageSnapshot(): Promise<void> {
    await this.parts.stock.snapshot();
  }

  async monthlyStorageFees(): Promise<void> {
    await this.parts.fees.monthlyStorage();
  }

  async postFees(): Promise<void> {
    await this.core.syncSchedules();
    await this.parts.fees.postAll();
  }

  async inboundOverdue(): Promise<void> {
    await this.parts.inbound.overdue();
  }

  async agedStockNotice(): Promise<void> {
    await this.parts.stock.agedNotice();
  }

  async reconcile(): Promise<void> {
    await this.parts.differences.reconcile();
  }
}
