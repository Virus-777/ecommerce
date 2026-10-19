import type { EventPayload } from '../../kernel/events/index.js';
import { isUuid } from '../../kernel/lib/ids.js';
import type * as common from '../../spec/common.js';
import type * as identity from '../../spec/identity.js';
import type { AdminReturnRow, CustomerReturnsOverview, EffectiveTerms, RefundBreakdown, RefundRequest, Replacement, ReturnCase, ReturnDetail, ReturnEvidence, ReturnsPublicApi, ReturnSummary, SellerReturnCounts } from '../../spec/returns.js';
import { Automation } from './service/automation.js';
import { Core, type ReturnsServiceDeps } from './service/core.js';
import { Decisions } from './service/decisions.js';
import { Handling } from './service/handling.js';
import { Policies } from './service/policies.js';
import { Reads } from './service/reads.js';
import { registerReturnsSettingsSection } from './service/settings-section.js';
import { Refunds } from './service/refunds.js';
import { Requests } from './service/requests.js';
import { Views } from './service/views.js';

export type { ReturnsServiceDeps };

/**
 * Returns use cases. Depends on its repository, the event bus, the clock and other modules' public APIs.
 * The work is split by area (service/*.ts); this class is the module's public API, its event consumers and jobs.
 */
export class ReturnsService implements ReturnsPublicApi {
  readonly core: Core;
  readonly views: Views;
  readonly policies: Policies;
  readonly refunds: Refunds;
  readonly handling: Handling;
  readonly decisions: Decisions;
  readonly requests: Requests;
  readonly reads: Reads;
  readonly automation: Automation;

  constructor(deps: ReturnsServiceDeps) {
    this.core = new Core(deps);
    this.views = new Views(this.core);
    this.policies = new Policies(this.core);
    this.refunds = new Refunds(this.core, this.views);
    this.handling = new Handling(this.core, this.views, this.refunds);
    this.decisions = new Decisions(this.core, this.refunds, this.handling);
    this.requests = new Requests(this.core, this.views, this.policies, this.decisions, this.handling);
    this.reads = new Reads(this.core, this.views);
    this.automation = new Automation(this.core, this.views, this.requests, this.decisions, this.handling, this.refunds);
  }

  /** After boot: the Returns baseline section of the Admin Center settings page (G76) */
  registerSettingsSection(): Promise<void> {
    return registerReturnsSettingsSection(this.core.ctx.tryUse('settings'), this.policies, () => this.core.tz);
  }

  /* ---------------- public API (in-process) */

  resolveTerms(sellerId: string | null, categoryId: string | null, condition: string | null): Promise<EffectiveTerms> {
    return this.policies.resolveTerms(sellerId, categoryId, condition);
  }

  returnStateForItems(orderItemIds: string[]): Promise<{ orderItemId: string; returnId: string | null; ref: string | null; status: string | null; refundStatus: string | null }[]> {
    return this.reads.returnStateForItems(orderItemIds);
  }

  requestRefund(input: { source: 'case' | 'exception'; caseId?: string; orderId: string; orderItemIds: string[]; items?: { orderItemId: string; quantity: number }[]; breakdown: RefundBreakdown; fundedBy: string; reasonCode?: string; reason: string; proposedBy: common.Actor }): Promise<RefundRequest> {
    return this.refunds.requestRefund(input);
  }

  /** A replacement decided on a support case without a return (stock allocated through inventory) */
  requestReplacement(input: { caseId: string; orderId: string; orderItemId: string; quantity: number; variantId?: string; reason: string; requestedBy: common.Actor }, idempotencyKey: string): Promise<Replacement> {
    return this.handling.requestReplacement(input, idempotencyKey);
  }

  /** Baseline return window in force now (content's service strip warns when its text disagrees) */
  defaultWindowDays(): Promise<{ windowDays: number; policyVersion: string | null }> {
    return this.policies.defaultWindowDays();
  }

  /** Warehouse scanned an Official Store or Fulfilled by Marketly return at the dock (a second scan changes nothing) */
  async recordWarehouseReceipt(returnId: string, receivedAt: string, receivedBy: common.Actor, trackingNumber: string | null): Promise<ReturnDetail> {
    const agg = await this.core.visible(returnId, { area: 'admin' });
    await this.handling.receive(returnId, { receivedAt, trackingNumber, rescanOk: true }, { actor: receivedBy }, agg);
    return (await this.views.details([(await this.core.load(returnId))!], 'admin'))[0]!;
  }

  sellerReturnStats(sellerId: string, range: common.DateRange): Promise<{ requests: number; returnRatePct: number; respondedOnTimePct: number; unresolved: number }> {
    return this.reads.sellerReturnStats(sellerId, range);
  }

  listOpenForCustomer(customerId: string, limit: number): Promise<{ items: ReturnSummary[]; total: number }> {
    return this.reads.listOpenForCustomer(customerId, limit);
  }

  async getReturnForCustomer(customerId: string | null, guestSessionId: string | null, ref: string): Promise<ReturnDetail | null> {
    const agg = await this.reads.byRefFor(ref, { area: 'store', customerId, guestSessionId });
    return agg ? (await this.views.details([agg], 'store'))[0]! : null;
  }

  listForCustomer(customerId: string, filter: { state?: 'open' | 'completed' | 'all' }, page: common.PageInput): Promise<common.Page<ReturnSummary>> {
    return this.reads.listMine({ customerId }, { state: filter.state ?? 'all' }, this.reads.page(page));
  }

  customerOverview(customerId: string): Promise<CustomerReturnsOverview> {
    return this.reads.customerOverview(customerId);
  }

  async getReturnForSeller(sellerId: string, ref: string): Promise<ReturnCase | null> {
    const agg = await this.reads.byRefFor(ref, { area: 'seller', sellerId });
    return agg ? this.views.returnCase(agg, 'seller') : null;
  }

  async getReturnAdmin(ref: string): Promise<ReturnCase | null> {
    const agg = await this.reads.byRef(ref);
    return agg ? this.views.returnCase(agg, 'admin') : null;
  }

  listForOrder(orderId: string, viewer: { area: 'store' | 'seller' | 'admin'; customerId?: string; sellerId?: string }): Promise<ReturnCase[]> {
    return this.reads.listForOrder(orderId, viewer);
  }

  eligibilityForItems(orderItemIds: string[]): Promise<{ orderItemId: string; eligible: boolean; ineligibleReason: string | null; message: string; quantityPurchased: number; quantityReturnable: number; returnBy: string | null; latestReturn: { returnId: string; ref: string; status: string; statusLabel: string; refundStatus: string | null } | null }[]> {
    return this.reads.eligibilityForItems(orderItemIds);
  }

  sellerQueueCounts(sellerId: string): Promise<SellerReturnCounts> {
    return this.reads.sellerCounts(sellerId);
  }

  listEvidence(returnId: string): Promise<ReturnEvidence[]> {
    return this.reads.listEvidence(returnId);
  }

  listForSeller(sellerId: string, filter: { state?: 'open' | 'completed' | 'all'; q?: string }, page: common.PageInput): Promise<common.Page<AdminReturnRow>> {
    return this.reads.listForSeller(sellerId, filter, page);
  }

  listRefundRequests(filter: { status?: string; source?: string }, page: common.PageInput): Promise<common.Page<RefundRequest>> {
    return this.reads.listRefunds(filter, this.reads.page(page));
  }

  getRefundRequest(ref: string): Promise<RefundRequest | null> {
    return this.reads.refundByRef(ref);
  }

  listRefundRequestsForOrder(orderId: string): Promise<RefundRequest[]> {
    return this.reads.refundsWhere({ orderId });
  }

  listRefundRequestsForCase(caseId: string): Promise<RefundRequest[]> {
    return this.reads.refundsWhere({ caseId });
  }

  sellerReturnTermsFor(sellerIds: string[]): Promise<Record<string, EffectiveTerms>> {
    return this.policies.sellerReturnTermsFor(sellerIds);
  }

  exportRows(dataset: string, filters: unknown, principal: identity.Principal, cursor?: string): Promise<{ rows: unknown[]; nextCursor?: string }> {
    return this.reads.exportRows(dataset, filters, principal, cursor);
  }

  async getReturn(returnId: string): Promise<ReturnCase | null> {
    const agg = isUuid(returnId) ? await this.core.load(returnId) : undefined;
    return agg ? this.views.returnCase(agg, 'admin') : null;
  }

  cancelRefundsForCase(caseId: string, reason: string, actor: common.Actor): Promise<{ cancelled: RefundRequest[]; notCancellable: RefundRequest[] }> {
    return this.refunds.cancelForCase(caseId, reason, actor);
  }

  /** Customer data export hook: the customer's returns and refunds as plain records, with their uploaded photos */
  exportCustomerData(input: { customerId: string; accountId: string }): Promise<common.CustomerDataSection[]> {
    return this.reads.exportCustomerData(input);
  }

  countOpenReturnsForProducts(productIds: string[]): Promise<Record<string, number>> {
    return this.reads.countOpenReturnsForProducts(productIds);
  }

  /* ---------------- events consumed */

  onItemDeliveredFromOrders(event: EventPayload<'orders.item.delivered'>): Promise<void> {
    return this.automation.onItemDelivered(event);
  }

  onItemCancelledFromOrders(event: EventPayload<'orders.item.cancelled'>): Promise<void> {
    return this.automation.onItemCancelled(event);
  }

  onShipmentDispatchedFromShipping(event: EventPayload<'shipping.shipment.dispatched'>): Promise<void> {
    return this.automation.onShipmentDispatched(event);
  }

  onShipmentDeliveredFromShipping(event: EventPayload<'shipping.shipment.delivered'>): Promise<void> {
    return this.automation.onShipmentDelivered(event);
  }

  onShipmentExceptionFromShipping(event: EventPayload<'shipping.shipment.exception'>): Promise<void> {
    return this.automation.onShipmentException(event);
  }

  async onRefundSentFromPayments(event: EventPayload<'payments.refund.sent'>): Promise<void> {
    await this.refunds.onSent(event);
    await this.automation.closeOverlapping(event);
  }

  onRefundFailedFromPayments(event: EventPayload<'payments.refund.failed'>): Promise<void> {
    return this.refunds.onFailed(event);
  }

  /** Refund approvals, baseline versions and category exceptions waiting for access */
  async onApprovalDecidedFromAccess(event: EventPayload<'access.approval.decided'>): Promise<void> {
    if (event.module && event.module !== 'returns') return;
    if (await this.policies.onApprovalDecided(event)) return;
    if (event.actionKey === 'returns.refunds.approve') await this.refunds.onApprovalDecided(event);
  }

  onSellerSuspendedFromSellers(event: EventPayload<'sellers.seller.suspended'>): Promise<void> {
    return this.automation.onSellerSuspended(event);
  }

  onSellerApprovedFromSellers(event: EventPayload<'sellers.seller.approved'>): Promise<void> {
    return this.policies.onSellerApproved(event);
  }

  onShipmentStatusChangedFromShipping(event: EventPayload<'shipping.shipment.status_changed'>): Promise<void> {
    return this.automation.onShipmentStatusChanged(event);
  }

  onCaseDecidedFromSupport(event: EventPayload<'support.case.decided'>): Promise<void> {
    return this.automation.onCaseDecided(event);
  }

  /* ---------------- jobs */

  responseDeadlines(): Promise<void> {
    return this.automation.responseDeadlines();
  }

  inspectionDeadlines(): Promise<void> {
    return this.automation.inspectionDeadlines();
  }

  infoExpiry(): Promise<void> {
    return this.automation.infoExpiry();
  }

  dropoffExpiry(): Promise<void> {
    return this.automation.dropoffExpiry();
  }

  policyActivation(): Promise<void> {
    return this.policies.activateDue();
  }

}
