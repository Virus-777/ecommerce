import { notImplemented } from '../../kernel/errors/index.js';
import type { EventPayload } from '../../kernel/events/index.js';
import type { ModuleContext } from '../../kernel/module-system/index.js';
import type * as common from '../../spec/common.js';
import type * as identity from '../../spec/identity.js';
import type { SupportPublicApi, CaseView, CaseSummary, AdminCaseDetail, SellerCaseRow } from '../../spec/support.js';
import type { SupportRepository } from './ports.js';

export interface SupportServiceDeps {
  repo: SupportRepository;
  ctx: ModuleContext<'support'>;
}

/**
 * Support use cases. Depends only on ports, the event bus, the clock and other modules' public APIs.
 * Each method maps to a publicApi function, a consumed event or a job in docs/api/spec/modules/support.json.
 */
export class SupportService implements SupportPublicApi {
  readonly #deps: SupportServiceDeps;

  constructor(deps: SupportServiceDeps) {
    this.#deps = deps;
  }

  protected get deps(): SupportServiceDeps {
    return this.#deps;
  }

  /* ---------------- public API (in-process) */

  /** Open a case from another module (return escalation, delivery exception, failed refund). With returnId the return's evidence is copied in through returns.listEvidence. */
  async openCase(input: { kind: string, category: string, orderId?: string, orderItemIds?: string[], customerId?: string, sellerId?: string, returnId?: string, subject: string, message: string, openedBy: common.Actor }): Promise<CaseView> {
    throw notImplemented('support.openCase');
  }

  /** Open and recent cases per order item for the order page */
  async casesForOrder(orderId: string): Promise<{ caseId: string, ref: string, status: string, orderItemIds: string[] }[]> {
    throw notImplemented('support.casesForOrder');
  }

  /** Unresolved cases for seller performance */
  async sellerCaseStats(sellerId: string, range: common.DateRange): Promise<{ open: number, unresolved: number, decidedAgainstSeller: number, medianReplyMinutes: number }> {
    throw notImplemented('support.sellerCaseStats');
  }

  /** Whether a promised refund or replacement is still open */
  async hasUnresolvedRemedy(caseId: string): Promise<boolean> {
    throw notImplemented('support.hasUnresolvedRemedy');
  }

  /** Open cases of a customer, most recently updated first, for the account overview. */
  async listOpenCasesForCustomer(customerId: string, limit: number): Promise<{ items: CaseSummary[], total: number }> {
    throw notImplemented('support.listOpenCasesForCustomer');
  }

  /** Case detail for the customer or guest order session (no internal notes) */
  async getCaseForCustomer(customerId: string | null, guestSessionId: string | null, ref: string): Promise<CaseView | null> {
    throw notImplemented('support.getCaseForCustomer');
  }

  /** A customer's cases, most recently updated first (store list, admin customer 360) */
  async listCasesForCustomer(customerId: string, filter: { open?: boolean }, page: common.PageInput): Promise<common.Page<CaseSummary>> {
    throw notImplemented('support.listCasesForCustomer');
  }

  /** A case about this seller's orders or the seller's own support request (no internal notes) */
  async getCaseForSeller(sellerId: string, ref: string): Promise<CaseView | null> {
    throw notImplemented('support.getCaseForSeller');
  }

  /** Dispute review with parties, purchase terms, shipment evidence, files, internal notes, deadlines and history */
  async getCaseAdmin(ref: string): Promise<AdminCaseDetail | null> {
    throw notImplemented('support.getCaseAdmin');
  }

  /** Open and recent cases on one order with linked items, filtered to what the viewer may see. Batched per order (Order.cases). */
  async listCasesForOrder(orderId: string, viewer: { area: 'store' | 'seller' | 'admin', customerId?: string, sellerId?: string }): Promise<CaseView[]> {
    throw notImplemented('support.listCasesForOrder');
  }

  /** Cases and disputes about a seller's orders (admin seller 360) */
  async listCasesForSeller(sellerId: string, filter: { open?: boolean }, page: common.PageInput): Promise<common.Page<SellerCaseRow>> {
    throw notImplemented('support.listCasesForSeller');
  }

  /** The case opened about each return (escalation or report), as the viewer may see it */
  async getCasesForReturns(returnIds: string[], viewer: { area: 'store' | 'seller' | 'admin', customerId?: string, guestSessionId?: string, sellerId?: string }): Promise<Record<string, CaseView | AdminCaseDetail | null>> {
    throw notImplemented('support.getCasesForReturns');
  }

  /** Export rows for reports dataset support.admin.cases (support cases) */
  async exportRows(dataset: string, filters: unknown, principal: identity.Principal, cursor?: string): Promise<{ rows: unknown[], nextCursor?: string }> {
    throw notImplemented('support.exportRows');
  }

  /** Open customer cases per product (cases linked to an order item of the product, not resolved or closed). Catalog publication-impact preview. */
  async countOpenCasesForProducts(productIds: string[]): Promise<Record<string, number>> {
    throw notImplemented('support.countOpenCasesForProducts');
  }

  /* ---------------- events consumed */

  /** returns.return.escalated: Open or link a dispute case for the return and assign it to the Returns team */
  async onReturnEscalatedFromReturns(event: EventPayload<"returns.return.escalated">): Promise<void> {
    void event;
    throw notImplemented('support consumer of returns.return.escalated');
  }

  /** returns.refund.approved: Move the matching refund remedy to approved/in progress */
  async onRefundApprovedFromReturns(event: EventPayload<"returns.refund.approved">): Promise<void> {
    void event;
    throw notImplemented('support consumer of returns.refund.approved');
  }

  /** payments.refund.sent: Complete the refund remedy; the case can now be resolved */
  async onRefundSentFromPayments(event: EventPayload<"payments.refund.sent">): Promise<void> {
    void event;
    throw notImplemented('support consumer of payments.refund.sent');
  }

  /** payments.refund.failed: Mark the refund remedy failed and put the case back in the owner's queue */
  async onRefundFailedFromPayments(event: EventPayload<"payments.refund.failed">): Promise<void> {
    void event;
    throw notImplemented('support consumer of payments.refund.failed');
  }

  /** returns.replacement.created: Link the replacement to its remedy */
  async onReplacementCreatedFromReturns(event: EventPayload<"returns.replacement.created">): Promise<void> {
    void event;
    throw notImplemented('support consumer of returns.replacement.created');
  }

  /** shipping.shipment.delivered: Complete replacement remedies when their shipment is delivered */
  async onShipmentDeliveredFromShipping(event: EventPayload<"shipping.shipment.delivered">): Promise<void> {
    void event;
    throw notImplemented('support consumer of shipping.shipment.delivered');
  }

  /** shipping.dispatch.overdue: Add the overdue dispatch to open cases for the item and expose the customer escalation route */
  async onDispatchOverdueFromShipping(event: EventPayload<"shipping.dispatch.overdue">): Promise<void> {
    void event;
    throw notImplemented('support consumer of shipping.dispatch.overdue');
  }

  /** shipping.shipment.exception: Open a case for lost or damaged packages when the customer has not already */
  async onShipmentExceptionFromShipping(event: EventPayload<"shipping.shipment.exception">): Promise<void> {
    void event;
    throw notImplemented('support consumer of shipping.shipment.exception');
  }

  /** orders.item.cancelled: Note cancellations on linked cases (e.g. ship-by remedy fell back to cancellation) */
  async onItemCancelledFromOrders(event: EventPayload<"orders.item.cancelled">): Promise<void> {
    void event;
    throw notImplemented('support consumer of orders.item.cancelled');
  }

  /** sellers.seller.restricted: Keep cases open; route seller-handled cases of a suspended seller to Marketly support */
  async onSellerRestrictedFromSellers(event: EventPayload<"sellers.seller.restricted">): Promise<void> {
    void event;
    throw notImplemented('support consumer of sellers.seller.restricted');
  }

  /** access.approval.decided: Finish approval-required remedies */
  async onApprovalDecidedFromAccess(event: EventPayload<"access.approval.decided">): Promise<void> {
    void event;
    throw notImplemented('support consumer of access.approval.decided');
  }

  /* ---------------- jobs */

  /** Job support.sla-timers (every 5 min): Recalculate deadlines in business hours (settings), flag due soon and overdue, publish support.case.overdue (workqueues raises it to the lead and backup) */
  async slaTimers(): Promise<void> {
    throw notImplemented('job support.sla-timers');
  }

  /** Job support.seller-deadline (every 15 min): Escalate seller-handled cases whose seller missed the reply deadline (Marketly steps in) */
  async sellerDeadline(): Promise<void> {
    throw notImplemented('job support.seller-deadline');
  }

  /** Job support.offer-expiry (hourly): Expire unanswered offers */
  async offerExpiry(): Promise<void> {
    throw notImplemented('job support.offer-expiry');
  }

  /** Job support.auto-close (daily 03:00 PT): Close resolved cases after autoCloseAfterDays; end reopen and appeal windows */
  async autoClose(): Promise<void> {
    throw notImplemented('job support.auto-close');
  }
}
