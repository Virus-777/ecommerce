import { notImplemented } from '../../kernel/errors/index.js';
import type { EventPayload } from '../../kernel/events/index.js';
import type { ModuleContext } from '../../kernel/module-system/index.js';
import type * as common from '../../spec/common.js';
import type * as identity from '../../spec/identity.js';
import type { ReturnsPublicApi, EffectiveTerms, RefundBreakdown, ReturnDetail, ReturnSummary, CustomerReturnsOverview, ReturnEvidence, RefundRequest, ReturnCase, SellerReturnCounts, AdminReturnRow } from '../../spec/returns.js';
import type { ReturnsRepository } from './ports.js';

export interface ReturnsServiceDeps {
  repo: ReturnsRepository;
  ctx: ModuleContext<'returns'>;
}

/**
 * Returns use cases. Depends only on ports, the event bus, the clock and other modules' public APIs.
 * Each method maps to a publicApi function, a consumed event or a job in docs/api/spec/modules/returns.json.
 */
export class ReturnsService implements ReturnsPublicApi {
  readonly #deps: ReturnsServiceDeps;

  constructor(deps: ReturnsServiceDeps) {
    this.#deps = deps;
  }

  protected get deps(): ReturnsServiceDeps {
    return this.#deps;
  }

  /* ---------------- public API (in-process) */

  /** sellerId null = Official Store (ownerType official). Effective return terms for an offer: baseline, category exception and seller terms combined. Shown before purchase and frozen on the order item. */
  async resolveTerms(sellerId: string | null, categoryId: string | null, condition: string | null): Promise<EffectiveTerms> {
    throw notImplemented('returns.resolveTerms');
  }

  /** After-sales column of the order detail (return and refund progress per item) */
  async returnStateForItems(orderItemIds: string[]): Promise<{ orderItemId: string, returnId: string | null, ref: string | null, status: string | null, refundStatus: string | null }[]> {
    throw notImplemented('returns.returnStateForItems');
  }

  /** Creates a refund request in the Finance approval queue for remedies decided outside a return (dispute decisions). Approved does not mean sent. */
  async requestRefund(input: { source: 'case' | 'exception', caseId?: string, orderId: string, orderItemIds: string[], breakdown: RefundBreakdown, fundedBy: string, reason: string, proposedBy: common.Actor }): Promise<RefundRequest> {
    throw notImplemented('returns.requestRefund');
  }

  /** Called by warehouse when an Official Store return is scanned at the dock */
  async recordWarehouseReceipt(returnId: string, receivedAt: string, receivedBy: common.Actor, trackingNumber: string | null): Promise<ReturnDetail> {
    throw notImplemented('returns.recordWarehouseReceipt');
  }

  /** Inputs to seller performance and reports */
  async sellerReturnStats(sellerId: string, range: common.DateRange): Promise<{ requests: number, returnRatePct: number, respondedOnTimePct: number, unresolved: number }> {
    throw notImplemented('returns.sellerReturnStats');
  }

  /** Open returns of a customer, newest first (open = not closed or cancelled), for the account overview tile and list. */
  async listOpenForCustomer(customerId: string, limit: number): Promise<{ items: ReturnSummary[], total: number }> {
    throw notImplemented('returns.listOpenForCustomer');
  }

  /** Return detail for the order's customer or guest order session (GraphQL store `return`) */
  async getReturnForCustomer(customerId: string | null, guestSessionId: string | null, ref: string): Promise<ReturnDetail | null> {
    throw notImplemented('returns.getReturnForCustomer');
  }

  /** A customer's returns, newest first, return status and refund status side by side (store list, admin customer 360) */
  async listForCustomer(customerId: string, filter: { state?: 'open' | 'completed' | 'all' }, page: common.PageInput): Promise<common.Page<ReturnSummary>> {
    throw notImplemented('returns.listForCustomer');
  }

  /** Open returns, refunds on the way and refunded this year for the account overview */
  async customerOverview(customerId: string): Promise<CustomerReturnsOverview> {
    throw notImplemented('returns.customerOverview');
  }

  /** A return of this seller with policy, payment, deadlines, shipment, inspection and earnings impact (GraphQL seller `sellerReturn`) */
  async getReturnForSeller(sellerId: string, ref: string): Promise<ReturnCase | null> {
    throw notImplemented('returns.getReturnForSeller');
  }

  /** Any return with owner, exception record, refund request and action history (staff) */
  async getReturnAdmin(ref: string): Promise<ReturnCase | null> {
    throw notImplemented('returns.getReturnAdmin');
  }

  /** Returns on one order, newest first. Seller viewer: only that seller's returns; store viewer: customer fields only. Batched per order (Order.returns). */
  async listForOrder(orderId: string, viewer: { area: 'store' | 'seller' | 'admin', customerId?: string, sellerId?: string }): Promise<ReturnCase[]> {
    throw notImplemented('returns.listForOrder');
  }

  /** Return eligibility now and the latest return per order item, batched (OrderItem.returnEligibility) */
  async eligibilityForItems(orderItemIds: string[]): Promise<{ orderItemId: string, eligible: boolean, ineligibleReason: string | null, message: string, quantityPurchased: number, quantityReturnable: number, returnBy: string | null, latestReturn: { returnId: string, ref: string, status: string, statusLabel: string, refundStatus: string | null } | null }[]> {
    throw notImplemented('returns.eligibilityForItems');
  }

  /** Returns queue tiles for the seller dashboard: overdue, awaiting response, to inspect, disputes needing evidence */
  async sellerQueueCounts(sellerId: string): Promise<SellerReturnCounts> {
    throw notImplemented('returns.sellerQueueCounts');
  }

  /** Evidence the seller (or staff) attached to a return before escalation; support copies it into the case it opens for this return */
  async listEvidence(returnId: string): Promise<ReturnEvidence[]> {
    throw notImplemented('returns.listEvidence');
  }

  /** A seller's returns for the admin seller 360 */
  async listForSeller(sellerId: string, filter: { state?: 'open' | 'completed' | 'all', q?: string }, page: common.PageInput): Promise<common.Page<AdminReturnRow>> {
    throw notImplemented('returns.listForSeller');
  }

  /** Refund approval queue for Finance */
  async listRefundRequests(filter: { status?: string, source?: string }, page: common.PageInput): Promise<common.Page<RefundRequest>> {
    throw notImplemented('returns.listRefundRequests');
  }

  /** One refund request with breakdown, funding, earnings impact and approval */
  async getRefundRequest(ref: string): Promise<RefundRequest | null> {
    throw notImplemented('returns.getRefundRequest');
  }

  /** Refund requests of an order from returns, case decisions and exceptions (admin order 360) */
  async listRefundRequestsForOrder(orderId: string): Promise<RefundRequest[]> {
    throw notImplemented('returns.listRefundRequestsForOrder');
  }

  /** Refund requests created by a case decision, with Finance approval state (admin dispute view) */
  async listRefundRequestsForCase(caseId: string): Promise<RefundRequest[]> {
    throw notImplemented('returns.listRefundRequestsForCase');
  }

  /** Storefront returns section: the seller's standard terms for new items (resolveTerms with no category or condition). Category exceptions and per-offer terms show on the product page and are frozen on the order item. */
  async sellerReturnTermsFor(sellerIds: string[]): Promise<Record<string, EffectiveTerms>> {
    throw notImplemented('returns.sellerReturnTermsFor');
  }

  /** Export rows for reports datasets returns.admin.requests, returns.admin.inspections and returns.seller.requests (seller rows scoped to the principal's seller) */
  async exportRows(dataset: string, filters: unknown, principal: identity.Principal, cursor?: string): Promise<{ rows: unknown[], nextCursor?: string }> {
    throw notImplemented('returns.exportRows');
  }

  /** Open return requests per product (not closed, refunded or rejected). Catalog publication-impact preview. */
  async countOpenReturnsForProducts(productIds: string[]): Promise<Record<string, number>> {
    throw notImplemented('returns.countOpenReturnsForProducts');
  }

  /* ---------------- events consumed */

  /** orders.item.delivered: Start the return window for the item (deadline = delivery + effective window) */
  async onItemDeliveredFromOrders(event: EventPayload<"orders.item.delivered">): Promise<void> {
    void event;
    throw notImplemented('returns consumer of orders.item.delivered');
  }

  /** orders.item.cancelled: Mark the item not returnable; cancel any requested return for it */
  async onItemCancelledFromOrders(event: EventPayload<"orders.item.cancelled">): Promise<void> {
    void event;
    throw notImplemented('returns consumer of orders.item.cancelled');
  }

  /** shipping.shipment.dispatched: Return label first scan → return shipment in transit; replacement shipment shipped */
  async onShipmentDispatchedFromShipping(event: EventPayload<"shipping.shipment.dispatched">): Promise<void> {
    void event;
    throw notImplemented('returns consumer of shipping.shipment.dispatched');
  }

  /** shipping.shipment.delivered: Return parcel delivered to the destination; replacement delivered (completes the return) */
  async onShipmentDeliveredFromShipping(event: EventPayload<"shipping.shipment.delivered">): Promise<void> {
    void event;
    throw notImplemented('returns consumer of shipping.shipment.delivered');
  }

  /** shipping.shipment.exception: Flag return or replacement shipment exceptions to the owner */
  async onShipmentExceptionFromShipping(event: EventPayload<"shipping.shipment.exception">): Promise<void> {
    void event;
    throw notImplemented('returns consumer of shipping.shipment.exception');
  }

  /** payments.refund.sent: Refund request → sent; completes the return when it is the remedy */
  async onRefundSentFromPayments(event: EventPayload<"payments.refund.sent">): Promise<void> {
    void event;
    throw notImplemented('returns consumer of payments.refund.sent');
  }

  /** payments.refund.failed: Refund request → failed with the reason; flags the return in the queue */
  async onRefundFailedFromPayments(event: EventPayload<"payments.refund.failed">): Promise<void> {
    void event;
    throw notImplemented('returns consumer of payments.refund.failed');
  }

  /** access.approval.decided: Finish an approval-required refund approval, baseline change or category exception (pending_approval → scheduled or rejected) */
  async onApprovalDecidedFromAccess(event: EventPayload<"access.approval.decided">): Promise<void> {
    void event;
    throw notImplemented('returns consumer of access.approval.decided');
  }

  /** sellers.seller.suspended: Open returns of the seller move to platform handling; existing returns stay accessible */
  async onSellerSuspendedFromSellers(event: EventPayload<"sellers.seller.suspended">): Promise<void> {
    void event;
    throw notImplemented('returns consumer of sellers.seller.suspended');
  }

  /** sellers.seller.approved: Create version 1 of the seller's return terms from the current baseline (window, remedies, response targets) with returnAddress and returnContact from the application, so return labels and drop-off addresses work from the first order. The seller can change terms later, never below the baseline */
  async onSellerApprovedFromSellers(event: EventPayload<"sellers.seller.approved">): Promise<void> {
    void event;
    throw notImplemented('returns consumer of sellers.seller.approved');
  }

  /** shipping.shipment.status_changed: For kind = return: update the return shipment tracking step and estimated arrival shown on the return */
  async onShipmentStatusChangedFromShipping(event: EventPayload<"shipping.shipment.status_changed">): Promise<void> {
    void event;
    throw notImplemented('returns consumer of shipping.shipment.status_changed');
  }

  /** support.case.decided: Apply a dispute decision that concerns a return (overturn, approve without return, close) */
  async onCaseDecidedFromSupport(event: EventPayload<"support.case.decided">): Promise<void> {
    void event;
    throw notImplemented('returns consumer of support.case.decided');
  }

  /* ---------------- jobs */

  /** Job returns.response-deadlines (every 15 min): Flag seller responses due soon and overdue; after the grace period move the return to platform handling and publish returns.return.escalated (workqueues picks it up) */
  async responseDeadlines(): Promise<void> {
    throw notImplemented('job returns.response-deadlines');
  }

  /** Job returns.inspection-deadlines (every 30 min): Flag received returns past the inspection target and refunds past the refund target; escalate seller cases to the platform */
  async inspectionDeadlines(): Promise<void> {
    throw notImplemented('job returns.inspection-deadlines');
  }

  /** Job returns.info-expiry (hourly): Cancel returns whose information request was not answered in time */
  async infoExpiry(): Promise<void> {
    throw notImplemented('job returns.info-expiry');
  }

  /** Job returns.dropoff-expiry (daily 02:00 PT): Cancel approved returns not dropped off by the deadline; void unused labels through shipping */
  async dropoffExpiry(): Promise<void> {
    throw notImplemented('job returns.dropoff-expiry');
  }

  /** Job returns.policy-activation (every 5 min): Activate scheduled baseline versions and category exceptions at their effective time */
  async policyActivation(): Promise<void> {
    throw notImplemented('job returns.policy-activation');
  }
}
