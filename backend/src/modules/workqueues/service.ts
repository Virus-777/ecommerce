import { notImplemented } from '../../kernel/errors/index.js';
import type { EventPayload } from '../../kernel/events/index.js';
import type { ModuleContext } from '../../kernel/module-system/index.js';
import type * as common from '../../spec/common.js';
import type * as identity from '../../spec/identity.js';
import type { WorkqueuesPublicApi, WorkItem, RaiseInput, MyQueues, WorkSummary } from '../../spec/workqueues.js';
import type { WorkqueuesRepository } from './ports.js';

export interface WorkqueuesServiceDeps {
  repo: WorkqueuesRepository;
  ctx: ModuleContext<'workqueues'>;
}

/**
 * Work queues use cases. Depends only on ports, the event bus, the clock and other modules' public APIs.
 * Each method maps to a publicApi function, a consumed event or a job in docs/api/spec/modules/workqueues.json.
 */
export class WorkqueuesService implements WorkqueuesPublicApi {
  readonly #deps: WorkqueuesServiceDeps;

  constructor(deps: WorkqueuesServiceDeps) {
    this.#deps = deps;
  }

  protected get deps(): WorkqueuesServiceDeps {
    return this.#deps;
  }

  /* ---------------- public API (in-process) */

  /** Create or refresh a work item. Idempotent on dedupeKey: a second call updates title, deadline and amount instead of creating a duplicate. For checks that are not events (e.g. finance's daily reconciliation, returns' deadline job). */
  async raise(input: RaiseInput): Promise<WorkItem> {
    throw notImplemented('workqueues.raise');
  }

  /** Close open items for a fixed source; returns how many closed */
  async resolveBySource(dedupeKey: string, outcome: { note: string, by: common.Actor }): Promise<number> {
    throw notImplemented('workqueues.resolveBySource');
  }

  /** Open items about one order, seller, case or payout, for detail pages */
  async listForSubject(subjectType: string, subjectId: string): Promise<WorkItem[]> {
    throw notImplemented('workqueues.listForSubject');
  }

  /** Counts for other dashboards */
  async openCounts(queueKeys: string[]): Promise<Record<string, { open: number, overdue: number }>> {
    throw notImplemented('workqueues.openCounts');
  }

  /** Open seller-visible tasks by kind for the seller dashboard */
  async sellerTaskCounts(sellerId: string): Promise<Record<string, number>> {
    throw notImplemented('workqueues.sellerTaskCounts');
  }

  /** The My work queues screen for the calling staff member (same as GET /api/admin/workqueues/me) */
  async getMyQueues(principal: identity.Principal): Promise<MyQueues> {
    throw notImplemented('workqueues.getMyQueues');
  }

  /** Needs-attention tiles, overdue dispatch items and team on shift for the admin dashboard (same as GET /summary), limited to the queues the caller may see */
  async getWorkSummary(principal: identity.Principal): Promise<WorkSummary> {
    throw notImplemented('workqueues.getWorkSummary');
  }

  /** Work items in the queues the caller may see (same as GET /items) */
  async listItems(filter: { queueKeys?: string[], areas?: string[], kinds?: string[], states?: string[], assignedToMe?: boolean, overdueOnly?: boolean, overdueOver?: string, sellerId?: string, sellerKind?: string, search?: string }, page: common.PageInput, principal: identity.Principal): Promise<common.Page<WorkItem>> {
    throw notImplemented('workqueues.listItems');
  }

  /** One work item with notes and history, if the caller may see its queue */
  async getItem(itemId: string, principal: identity.Principal): Promise<WorkItem | null> {
    throw notImplemented('workqueues.getItem');
  }

  /** Export rows for reports dataset workqueues.admin.items (limited to the principal's queue areas) */
  async exportRows(dataset: string, filters: unknown, principal: identity.Principal, cursor?: string): Promise<{ rows: unknown[], nextCursor?: string }> {
    throw notImplemented('workqueues.exportRows');
  }

  /* ---------------- events consumed */

  /** shipping.dispatch.overdue: Open an overdue_dispatch item about the order (seller-visible for marketplace sellers) with the payload exceptionId as a related delivery_exception subject, so Remind seller can call shipping; resolves on shipping.shipment.dispatched or orders.item.cancelled */
  async onDispatchOverdueFromShipping(event: EventPayload<"shipping.dispatch.overdue">): Promise<void> {
    void event;
    throw notImplemented('workqueues consumer of shipping.dispatch.overdue');
  }

  /** shipping.shipment.dispatched: Resolve overdue dispatch and missing tracking items for that order item */
  async onShipmentDispatchedFromShipping(event: EventPayload<"shipping.shipment.dispatched">): Promise<void> {
    void event;
    throw notImplemented('workqueues consumer of shipping.shipment.dispatched');
  }

  /** shipping.shipment.exception: Open a delivery_exception item (lost, damaged, failed delivery, missing tracking) */
  async onShipmentExceptionFromShipping(event: EventPayload<"shipping.shipment.exception">): Promise<void> {
    void event;
    throw notImplemented('workqueues consumer of shipping.shipment.exception');
  }

  /** shipping.shipment.delivered: Resolve delivery exception items for the shipment */
  async onShipmentDeliveredFromShipping(event: EventPayload<"shipping.shipment.delivered">): Promise<void> {
    void event;
    throw notImplemented('workqueues consumer of shipping.shipment.delivered');
  }

  /** orders.item.cancelled: Resolve dispatch items for the cancelled item */
  async onItemCancelledFromOrders(event: EventPayload<"orders.item.cancelled">): Promise<void> {
    void event;
    throw notImplemented('workqueues consumer of orders.item.cancelled');
  }

  /** inventory.stock.low: Open a low_stock item for Official Store stock */
  async onStockLowFromInventory(event: EventPayload<"inventory.stock.low">): Promise<void> {
    void event;
    throw notImplemented('workqueues consumer of inventory.stock.low');
  }

  /** inventory.stock.changed: Resolve low_stock when available is back above the reorder point */
  async onStockChangedFromInventory(event: EventPayload<"inventory.stock.changed">): Promise<void> {
    void event;
    throw notImplemented('workqueues consumer of inventory.stock.changed');
  }

  /** access.approval.requested: Open an approval_waiting item for the approvers' role */
  async onApprovalRequestedFromAccess(event: EventPayload<"access.approval.requested">): Promise<void> {
    void event;
    throw notImplemented('workqueues consumer of access.approval.requested');
  }

  /** access.approval.decided: Resolve the approval item */
  async onApprovalDecidedFromAccess(event: EventPayload<"access.approval.decided">): Promise<void> {
    void event;
    throw notImplemented('workqueues consumer of access.approval.decided');
  }

  /** access.away.started: Route new and escalating items of queues led by the absent person to the backup (access.resolveRecipients) */
  async onAwayStartedFromAccess(event: EventPayload<"access.away.started">): Promise<void> {
    void event;
    throw notImplemented('workqueues consumer of access.away.started');
  }

  /** access.away.ended: Return routing to the lead; items stay with whoever holds them */
  async onAwayEndedFromAccess(event: EventPayload<"access.away.ended">): Promise<void> {
    void event;
    throw notImplemented('workqueues consumer of access.away.ended');
  }

  /** access.coverage.changed: Refresh lead and backup on queues whose owner role coverage changed; re-run coverage gaps */
  async onCoverageChangedFromAccess(event: EventPayload<"access.coverage.changed">): Promise<void> {
    void event;
    throw notImplemented('workqueues consumer of access.coverage.changed');
  }

  /** support.case.overdue: Open a case_past_target item */
  async onCaseOverdueFromSupport(event: EventPayload<"support.case.overdue">): Promise<void> {
    void event;
    throw notImplemented('workqueues consumer of support.case.overdue');
  }

  /** support.case.escalated: Open or raise priority of a case_escalated item */
  async onCaseEscalatedFromSupport(event: EventPayload<"support.case.escalated">): Promise<void> {
    void event;
    throw notImplemented('workqueues consumer of support.case.escalated');
  }

  /** support.case.resolved: Resolve case items */
  async onCaseResolvedFromSupport(event: EventPayload<"support.case.resolved">): Promise<void> {
    void event;
    throw notImplemented('workqueues consumer of support.case.resolved');
  }

  /** returns.return.escalated: Open a return_decision item when a seller missed the response deadline */
  async onReturnEscalatedFromReturns(event: EventPayload<"returns.return.escalated">): Promise<void> {
    void event;
    throw notImplemented('workqueues consumer of returns.return.escalated');
  }

  /** returns.refund.approved: Resolve return decision items for that return */
  async onRefundApprovedFromReturns(event: EventPayload<"returns.refund.approved">): Promise<void> {
    void event;
    throw notImplemented('workqueues consumer of returns.refund.approved');
  }

  /** finance.payout.failed: Open a payout_failed item (also listed in the day-end review) */
  async onPayoutFailedFromFinance(event: EventPayload<"finance.payout.failed">): Promise<void> {
    void event;
    throw notImplemented('workqueues consumer of finance.payout.failed');
  }

  /** finance.payout.paid: Resolve payout_failed items for that payout */
  async onPayoutPaidFromFinance(event: EventPayload<"finance.payout.paid">): Promise<void> {
    void event;
    throw notImplemented('workqueues consumer of finance.payout.paid');
  }

  /** finance.reconciliation.mismatch_found: Open a payment_mismatch item in Daily finance checks */
  async onReconciliationMismatchFoundFromFinance(event: EventPayload<"finance.reconciliation.mismatch_found">): Promise<void> {
    void event;
    throw notImplemented('workqueues consumer of finance.reconciliation.mismatch_found');
  }

  /** payments.payment.pending_check: Open a payment_check item */
  async onPaymentPendingCheckFromPayments(event: EventPayload<"payments.payment.pending_check">): Promise<void> {
    void event;
    throw notImplemented('workqueues consumer of payments.payment.pending_check');
  }

  /** payments.payment.captured: Resolve payment_check items */
  async onPaymentCapturedFromPayments(event: EventPayload<"payments.payment.captured">): Promise<void> {
    void event;
    throw notImplemented('workqueues consumer of payments.payment.captured');
  }

  /** payments.payment.failed: Resolve payment_check items (the customer is told by payments) */
  async onPaymentFailedFromPayments(event: EventPayload<"payments.payment.failed">): Promise<void> {
    void event;
    throw notImplemented('workqueues consumer of payments.payment.failed');
  }

  /** payments.chargeback.opened: Open a chargeback item for Finance */
  async onChargebackOpenedFromPayments(event: EventPayload<"payments.chargeback.opened">): Promise<void> {
    void event;
    throw notImplemented('workqueues consumer of payments.chargeback.opened');
  }

  /** catalog.product.submitted: Open a product_review item */
  async onProductSubmittedFromCatalog(event: EventPayload<"catalog.product.submitted">): Promise<void> {
    void event;
    throw notImplemented('workqueues consumer of catalog.product.submitted');
  }

  /** catalog.product.approved: Resolve product review items */
  async onProductApprovedFromCatalog(event: EventPayload<"catalog.product.approved">): Promise<void> {
    void event;
    throw notImplemented('workqueues consumer of catalog.product.approved');
  }

  /** catalog.product.changes_requested: Resolve product review items */
  async onProductChangesRequestedFromCatalog(event: EventPayload<"catalog.product.changes_requested">): Promise<void> {
    void event;
    throw notImplemented('workqueues consumer of catalog.product.changes_requested');
  }

  /** catalog.product.rejected: Resolve product review items */
  async onProductRejectedFromCatalog(event: EventPayload<"catalog.product.rejected">): Promise<void> {
    void event;
    throw notImplemented('workqueues consumer of catalog.product.rejected');
  }

  /** sellers.application.submitted: Open an application_waiting item with the decision target as deadline */
  async onApplicationSubmittedFromSellers(event: EventPayload<"sellers.application.submitted">): Promise<void> {
    void event;
    throw notImplemented('workqueues consumer of sellers.application.submitted');
  }

  /** sellers.application.information_provided: Reopen the application item for review */
  async onApplicationInformationProvidedFromSellers(event: EventPayload<"sellers.application.information_provided">): Promise<void> {
    void event;
    throw notImplemented('workqueues consumer of sellers.application.information_provided');
  }

  /** sellers.application.decided: Resolve application items */
  async onApplicationDecidedFromSellers(event: EventPayload<"sellers.application.decided">): Promise<void> {
    void event;
    throw notImplemented('workqueues consumer of sellers.application.decided');
  }

  /** sellers.launch_review.requested: Open a launch_review item */
  async onLaunchReviewRequestedFromSellers(event: EventPayload<"sellers.launch_review.requested">): Promise<void> {
    void event;
    throw notImplemented('workqueues consumer of sellers.launch_review.requested');
  }

  /** sellers.launch_review.decided: Resolve the launch review item */
  async onLaunchReviewDecidedFromSellers(event: EventPayload<"sellers.launch_review.decided">): Promise<void> {
    void event;
    throw notImplemented('workqueues consumer of sellers.launch_review.decided');
  }

  /** sellers.appeal.submitted: Open an appeal_due item with decideBy as deadline */
  async onAppealSubmittedFromSellers(event: EventPayload<"sellers.appeal.submitted">): Promise<void> {
    void event;
    throw notImplemented('workqueues consumer of sellers.appeal.submitted');
  }

  /** sellers.appeal.decided: Resolve appeal items */
  async onAppealDecidedFromSellers(event: EventPayload<"sellers.appeal.decided">): Promise<void> {
    void event;
    throw notImplemented('workqueues consumer of sellers.appeal.decided');
  }

  /** sellers.restriction.evidence_submitted: Open a restriction_evidence item for the Seller Manager */
  async onRestrictionEvidenceSubmittedFromSellers(event: EventPayload<"sellers.restriction.evidence_submitted">): Promise<void> {
    void event;
    throw notImplemented('workqueues consumer of sellers.restriction.evidence_submitted');
  }

  /** sellers.performance.below_target: Open a seller_performance item */
  async onPerformanceBelowTargetFromSellers(event: EventPayload<"sellers.performance.below_target">): Promise<void> {
    void event;
    throw notImplemented('workqueues consumer of sellers.performance.below_target');
  }

  /** sellers.change_request.submitted: Open a storefront_review item */
  async onChangeRequestSubmittedFromSellers(event: EventPayload<"sellers.change_request.submitted">): Promise<void> {
    void event;
    throw notImplemented('workqueues consumer of sellers.change_request.submitted');
  }

  /** sellers.change_request.decided: Resolve storefront review items */
  async onChangeRequestDecidedFromSellers(event: EventPayload<"sellers.change_request.decided">): Promise<void> {
    void event;
    throw notImplemented('workqueues consumer of sellers.change_request.decided');
  }

  /** trust.report.created: Open a trust_report item (priority from risk score) */
  async onReportCreatedFromTrust(event: EventPayload<"trust.report.created">): Promise<void> {
    void event;
    throw notImplemented('workqueues consumer of trust.report.created');
  }

  /** trust.report.resolved: Resolve trust report items */
  async onReportResolvedFromTrust(event: EventPayload<"trust.report.resolved">): Promise<void> {
    void event;
    throw notImplemented('workqueues consumer of trust.report.resolved');
  }

  /** trust.recommendation.routed: Open a trust_recommendation item in the owning team's queue (Catalog, Seller Manager, Support, Finance) */
  async onRecommendationRoutedFromTrust(event: EventPayload<"trust.recommendation.routed">): Promise<void> {
    void event;
    throw notImplemented('workqueues consumer of trust.recommendation.routed');
  }

  /** trust.recommendation.decided: Resolve the recommendation item */
  async onRecommendationDecidedFromTrust(event: EventPayload<"trust.recommendation.decided">): Promise<void> {
    void event;
    throw notImplemented('workqueues consumer of trust.recommendation.decided');
  }

  /** messaging.reply.overdue: Open a seller-visible seller_reply_overdue task */
  async onReplyOverdueFromMessaging(event: EventPayload<"messaging.reply.overdue">): Promise<void> {
    void event;
    throw notImplemented('workqueues consumer of messaging.reply.overdue');
  }

  /** messaging.message.sent: Resolve seller_reply_overdue when the seller replies */
  async onMessageSentFromMessaging(event: EventPayload<"messaging.message.sent">): Promise<void> {
    void event;
    throw notImplemented('workqueues consumer of messaging.message.sent');
  }

  /** customers.data_export.requested: Open a data_request item with the promised delivery time */
  async onDataExportRequestedFromCustomers(event: EventPayload<"customers.data_export.requested">): Promise<void> {
    void event;
    throw notImplemented('workqueues consumer of customers.data_export.requested');
  }

  /** customers.data_export.ready: Resolve the data request item */
  async onDataExportReadyFromCustomers(event: EventPayload<"customers.data_export.ready">): Promise<void> {
    void event;
    throw notImplemented('workqueues consumer of customers.data_export.ready');
  }

  /* ---------------- jobs */

  /** Job workqueues.deadline-sweep (every 1 min): Move items to due_soon and overdue; publish workqueues.item.overdue once; escalate along each queue's route; route to the backup when the lead is away (access absences) */
  async deadlineSweep(): Promise<void> {
    throw notImplemented('job workqueues.deadline-sweep');
  }

  /** Job workqueues.routine-generate (daily 00:05 market time): Create today's routine checks from templates; mark yesterday's unfinished checks late */
  async routineGenerate(): Promise<void> {
    throw notImplemented('job workqueues.routine-generate');
  }

  /** Job workqueues.routine-late (every 15 min): Mark routine checks past their due time as late */
  async routineLate(): Promise<void> {
    throw notImplemented('job workqueues.routine-late');
  }

  /** Job workqueues.day-end-prepare (daily 15:00 market time): Build today's day-end review from open items and other modules' forecasts */
  async dayEndPrepare(): Promise<void> {
    throw notImplemented('job workqueues.day-end-prepare');
  }

  /** Job workqueues.day-end-close (daily 23:59 market time): Mark an uncompleted review missed; snapshot daily_counts */
  async dayEndClose(): Promise<void> {
    throw notImplemented('job workqueues.day-end-close');
  }

  /** Job workqueues.archive (monthly): Move resolved items older than itemRetentionDays to cold storage */
  async archive(): Promise<void> {
    throw notImplemented('job workqueues.archive');
  }
}
