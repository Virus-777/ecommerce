import type { EventPayload } from '../../kernel/events/index.js';
import { isUuid } from '../../kernel/lib/ids.js';
import type * as common from '../../spec/common.js';
import type * as identity from '../../spec/identity.js';
import type { AdminCaseDetail, CaseSummary, CaseView, SellerCaseRow, SupportPublicApi } from '../../spec/support.js';
import { UNRESOLVED_REMEDY } from './domain/rules.js';
import { Automation } from './service/automation.js';
import { Cases } from './service/cases.js';
import { Core, type SupportServiceDeps } from './service/core.js';
import { Decisions } from './service/decisions.js';
import { Reads } from './service/reads.js';
import { Views } from './service/views.js';

export type { SupportServiceDeps };

/**
 * Support use cases. Depends only on ports, the event bus, the clock and other modules' public APIs.
 * The work is split by area (service/*.ts); this class is the module's public API, its event consumers and jobs.
 */
export class SupportService implements SupportPublicApi {
  readonly core: Core;
  readonly views: Views;
  readonly cases: Cases;
  readonly decisions: Decisions;
  readonly reads: Reads;
  readonly automation: Automation;

  constructor(deps: SupportServiceDeps) {
    this.core = new Core(deps);
    this.views = new Views(this.core);
    this.cases = new Cases(this.core, this.views);
    this.decisions = new Decisions(this.core, this.views, this.cases);
    this.reads = new Reads(this.core, this.views, this.cases);
    this.automation = new Automation(this.core, this.cases, this.decisions);
  }

  /* ---------------- public API (in-process) */

  /** Open a case from another module (return escalation, delivery exception, failed refund). With returnId the return's evidence is copied in through returns.listEvidence. */
  async openCase(input: { kind: string; category: string; orderId?: string; orderItemIds?: string[]; customerId?: string; sellerId?: string; returnId?: string; subject: string; message: string; openedBy: common.Actor }): Promise<CaseView> {
    return this.views.view(await this.cases.openFromModule(input), 'admin');
  }

  /** Open and recent cases per order item for the order page */
  casesForOrder(orderId: string): Promise<{ caseId: string; ref: string; status: string; orderItemIds: string[] }[]> {
    return this.reads.casesForOrder(orderId);
  }

  /** Unresolved cases for seller performance */
  sellerCaseStats(sellerId: string, range: common.DateRange): Promise<{ open: number; unresolved: number; decidedAgainstSeller: number; medianReplyMinutes: number }> {
    return this.reads.sellerCaseStats(sellerId, range);
  }

  /** Whether a promised refund or replacement is still open */
  async hasUnresolvedRemedy(caseId: string): Promise<boolean> {
    if (!isUuid(caseId)) return false;
    return (await this.core.repo.count('case_remedies', { case_id: caseId, status: [...UNRESOLVED_REMEDY] })) > 0;
  }

  /** Open cases of a customer, most recently updated first, for the account overview. */
  listOpenCasesForCustomer(customerId: string, limit: number): Promise<{ items: CaseSummary[]; total: number }> {
    return this.reads.listOpenForCustomer(customerId, limit);
  }

  /** Case detail for the customer or guest order session (no internal notes) */
  async getCaseForCustomer(customerId: string | null, guestSessionId: string | null, ref: string): Promise<CaseView | null> {
    const agg = await this.core.byRef(ref);
    if (!agg || !(await this.core.canSee(agg.c, { area: 'store', customerId, guestSessionId }))) return null;
    return this.views.view(agg, 'store');
  }

  /** A customer's cases, most recently updated first (store list, admin customer 360) */
  listCasesForCustomer(customerId: string, filter: { open?: boolean }, page: common.PageInput): Promise<common.Page<CaseSummary>> {
    return this.reads.listForCustomer(customerId, filter ?? {}, page);
  }

  /** A case about this seller's orders or the seller's own support request (no internal notes) */
  async getCaseForSeller(sellerId: string, ref: string): Promise<CaseView | null> {
    const agg = await this.core.byRef(ref);
    if (!agg || !(await this.core.canSee(agg.c, { area: 'seller', sellerId }))) return null;
    return this.views.view(agg, 'seller');
  }

  /** Dispute review with parties, purchase terms, shipment evidence, files, internal notes, deadlines and history */
  async getCaseAdmin(ref: string): Promise<AdminCaseDetail | null> {
    const agg = await this.core.byRef(ref);
    return agg ? this.views.adminDetail(agg) : null;
  }

  /** Open and recent cases on one order with linked items, filtered to what the viewer may see. Batched per order (Order.cases). */
  async listCasesForOrder(orderId: string, viewer: { area: 'store' | 'seller' | 'admin'; customerId?: string; sellerId?: string }): Promise<CaseView[]> {
    return this.views.views(await this.reads.listForOrder(orderId, viewer), viewer.area);
  }

  /** Cases and disputes about a seller's orders (admin seller 360) */
  listCasesForSeller(sellerId: string, filter: { open?: boolean }, page: common.PageInput): Promise<common.Page<SellerCaseRow>> {
    return this.reads.listForSeller(sellerId, { open: filter?.open }, this.reads.page(page));
  }

  /** The case opened about each return (escalation or report), as the viewer may see it */
  getCasesForReturns(returnIds: string[], viewer: { area: 'store' | 'seller' | 'admin'; customerId?: string; guestSessionId?: string; sellerId?: string }): Promise<Record<string, CaseView | AdminCaseDetail | null>> {
    return this.reads.casesForReturns(returnIds, viewer);
  }

  /** Export rows for reports dataset support.admin.cases (support cases) */
  exportRows(dataset: string, filters: unknown, principal: identity.Principal, cursor?: string): Promise<{ rows: unknown[]; nextCursor?: string }> {
    return this.reads.exportRows(dataset, filters, principal, cursor);
  }

  /** Open customer cases per product (cases linked to an order item of the product, not resolved or closed). Catalog publication-impact preview. */
  countOpenCasesForProducts(productIds: string[]): Promise<Record<string, number>> {
    return this.reads.countOpenForProducts(productIds);
  }

  /* ---------------- events consumed */

  /** returns.return.escalated: Open or link a dispute case for the return and assign it to the Returns team */
  onReturnEscalatedFromReturns(event: EventPayload<'returns.return.escalated'>): Promise<void> {
    return this.automation.onReturnEscalated(event);
  }

  /** returns.refund.approved: Move the matching refund remedy to approved/in progress */
  onRefundApprovedFromReturns(event: EventPayload<'returns.refund.approved'>): Promise<void> {
    return this.automation.onRefundApproved(event);
  }

  /** payments.refund.sent: Complete the refund remedy; the case can now be resolved */
  onRefundSentFromPayments(event: EventPayload<'payments.refund.sent'>): Promise<void> {
    return this.automation.onRefundSent(event);
  }

  /** payments.refund.failed: Mark the refund remedy failed and put the case back in the owner's queue */
  onRefundFailedFromPayments(event: EventPayload<'payments.refund.failed'>): Promise<void> {
    return this.automation.onRefundFailed(event);
  }

  /** returns.replacement.created: Link the replacement to its remedy */
  onReplacementCreatedFromReturns(event: EventPayload<'returns.replacement.created'>): Promise<void> {
    return this.automation.onReplacementCreated(event);
  }

  /** shipping.shipment.delivered: Complete replacement remedies when their shipment is delivered */
  onShipmentDeliveredFromShipping(event: EventPayload<'shipping.shipment.delivered'>): Promise<void> {
    return this.automation.onShipmentDelivered(event);
  }

  /** shipping.dispatch.overdue: Add the overdue dispatch to open cases for the item and expose the customer escalation route */
  onDispatchOverdueFromShipping(event: EventPayload<'shipping.dispatch.overdue'>): Promise<void> {
    return this.automation.onDispatchOverdue(event);
  }

  /** shipping.shipment.exception: Open a case for lost or damaged packages when the customer has not already */
  onShipmentExceptionFromShipping(event: EventPayload<'shipping.shipment.exception'>): Promise<void> {
    return this.automation.onShipmentException(event);
  }

  /** orders.item.cancelled: Note cancellations on linked cases (e.g. ship-by remedy fell back to cancellation) */
  onItemCancelledFromOrders(event: EventPayload<'orders.item.cancelled'>): Promise<void> {
    return this.automation.onItemCancelled(event);
  }

  /** sellers.seller.restricted: Keep cases open; route seller-handled cases of a suspended seller to Marketly support */
  onSellerRestrictedFromSellers(event: EventPayload<'sellers.seller.restricted'>): Promise<void> {
    return this.automation.onSellerRestricted(event);
  }

  /** access.approval.decided: Finish approval-required remedies */
  onApprovalDecidedFromAccess(event: EventPayload<'access.approval.decided'>): Promise<void> {
    return this.decisions.onApprovalDecided(event);
  }

  /* ---------------- jobs */

  /** Job support.sla-timers (every 5 min): Recalculate deadlines in business hours (settings), flag due soon and overdue, publish support.case.overdue (workqueues raises it to the lead and backup) */
  slaTimers(): Promise<void> {
    return this.automation.slaTimers();
  }

  /** Job support.seller-deadline (every 15 min): Escalate seller-handled cases whose seller missed the reply deadline (Marketly steps in) */
  sellerDeadline(): Promise<void> {
    return this.automation.sellerDeadline();
  }

  /** Job support.offer-expiry (hourly): Expire unanswered offers */
  offerExpiry(): Promise<void> {
    return this.automation.offerExpiry();
  }

  /** Job support.auto-close (daily 03:00 PT): Close resolved cases after autoCloseAfterDays; end reopen and appeal windows */
  autoClose(): Promise<void> {
    return this.automation.autoClose();
  }
}
