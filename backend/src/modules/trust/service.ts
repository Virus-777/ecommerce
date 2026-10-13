import type { EventPayload } from '../../kernel/events/index.js';
import type * as common from '../../spec/common.js';
import type * as identity from '../../spec/identity.js';
import type { Enforcement, EvidenceInput, TrustPublicApi, TrustReport, TrustSubject } from '../../spec/trust.js';
import { Actions } from './service/actions.js';
import { Appeals } from './service/appeals.js';
import { Core, type TrustServiceDeps } from './service/core.js';
import { Detection } from './service/detection.js';
import { Reports } from './service/reports.js';
import { Views } from './service/views.js';

export type { TrustServiceDeps };

/**
 * Trust and risk use cases. Depends on its repository, the event bus, the clock and other modules' public APIs.
 * The work is split by area (service/*.ts); this class is the module's public API, its event consumers and jobs.
 */
export class TrustService implements TrustPublicApi {
  readonly core: Core;
  readonly views: Views;
  readonly reports: Reports;
  readonly actions: Actions;
  readonly appeals: Appeals;
  readonly detection: Detection;

  constructor(deps: TrustServiceDeps) {
    this.core = new Core(deps);
    this.views = new Views(this.core);
    this.reports = new Reports(this.core, this.views);
    this.actions = new Actions(this.core, this.views);
    this.appeals = new Appeals(this.core, this.views, this.actions);
    this.detection = new Detection(this.core, this.views, this.reports);
  }

  /* ---------------- public API (in-process) */

  /** Automated signals from other modules' detectors; de-duplicated by dedupeKey (adds evidence to the open report instead of creating a new one) */
  raiseSignal(input: { type: string; detector: string; title: string; subjects: TrustSubject[]; evidence: EvidenceInput[]; score?: number; dedupeKey: string }): Promise<TrustReport> {
    return this.reports.raiseSignal(input);
  }

  /** Seller Manager asks Trust and Risk to assess an application or account; the answer comes back as trust.assessment.completed */
  requestAssessment(input: { subjectType: 'seller_application' | 'seller' | 'customer'; subjectId: string; sellerId?: string; question: string; requestedBy: common.Actor }): Promise<{ reportId: string; ref: string }> {
    return this.reports.requestAssessment(input);
  }

  /** Counts for customer and seller detail pages */
  reportsAbout(subjectType: string, subjectId: string): Promise<{ filedBy: number; against: number; open: number; reportIds: string[] }> {
    return this.reports.reportsAbout(subjectType, subjectId);
  }

  /** Active enforcement on an offer, product, seller or customer, with appeal route */
  enforcementsFor(subjectType: string, subjectId: string): Promise<Enforcement[]> {
    return this.actions.enforcementsFor(subjectType, subjectId);
  }

  /** Ids of customers or sellers with reports filed by them or about them (filters hasAbuseReports before paging) */
  subjectIdsWithReports(subjectType: 'customer' | 'seller', filter: { role?: 'filed_by' | 'against'; openOnly?: boolean; ids?: string[] }): Promise<string[]> {
    return this.reports.subjectIdsWithReports(subjectType, filter);
  }

  /** Reports filed by or about a customer or seller for the admin 360 views; reporter identity, evidence and internal notes are left out */
  listReportsAbout(subjectType: 'customer' | 'seller', subjectId: string, filter: { role?: 'filed_by' | 'against'; statuses?: string[] }, page: common.PageInput): Promise<common.Page<TrustReport>> {
    return this.reports.listAbout(subjectType, subjectId, filter, page);
  }

  /** Batch lookup of reports by id without reporter identity, evidence or internal notes */
  getReportSummaries(reportIds: string[]): Promise<TrustReport[]> {
    return this.reports.summaries(reportIds);
  }

  /** Export rows for reports dataset trust.admin.reports (reporter identities only with trust.reports.export-identities) */
  exportRows(dataset: string, filters: unknown, principal: identity.Principal, cursor?: string): Promise<{ rows: unknown[]; nextCursor?: string }> {
    return this.reports.exportRows(dataset, filters, principal, cursor);
  }

  /* ---------------- events consumed */

  /** access.approval.decided: finish an accept or reversal that needed approval (approved: apply; otherwise it stays as it was) */
  onApprovalDecidedFromAccess(event: EventPayload<'access.approval.decided'>, eventId?: string): Promise<void> {
    return this.actions.onApprovalDecided(event, eventId);
  }

  onContentReferredFromReviews(event: EventPayload<'reviews.content.referred'>): Promise<void> {
    return this.detection.onContentReferred(event);
  }

  onMessageReportedFromMessaging(event: EventPayload<'messaging.message.reported'>): Promise<void> {
    return this.detection.onMessageReported(event);
  }

  onOrderPlacedFromOrders(event: EventPayload<'orders.order.placed'>): Promise<void> {
    return this.detection.onOrderPlaced(event);
  }

  onChargebackOpenedFromPayments(event: EventPayload<'payments.chargeback.opened'>): Promise<void> {
    return this.detection.onChargebackOpened(event);
  }

  onPaymentFailedFromPayments(event: EventPayload<'payments.payment.failed'>): Promise<void> {
    return this.detection.onPaymentFailed(event);
  }

  onReviewPublishedFromReviews(event: EventPayload<'reviews.review.published'>): Promise<void> {
    return this.detection.onReviewPublished(event);
  }

  onOfferCreatedFromOffers(event: EventPayload<'offers.offer.created'>): Promise<void> {
    return this.detection.onOfferCreated(event);
  }

  onProductPublicationChangedFromCatalog(event: EventPayload<'catalog.product.publication_changed'>): Promise<void> {
    return this.actions.onProductPublicationChanged(event);
  }

  onOfferStatusChangedFromOffers(event: EventPayload<'offers.offer.status_changed'>): Promise<void> {
    return this.actions.onOfferStatusChanged(event);
  }

  onSellerRestrictedFromSellers(event: EventPayload<'sellers.seller.restricted'>): Promise<void> {
    return this.actions.onSellerRestricted(event);
  }

  onSellerSuspendedFromSellers(event: EventPayload<'sellers.seller.suspended'>): Promise<void> {
    return this.actions.onSellerSuspended(event);
  }

  onWarningIssuedFromSellers(event: EventPayload<'sellers.warning.issued'>): Promise<void> {
    return this.actions.onWarningIssued(event);
  }

  onModerationDecidedFromReviews(event: EventPayload<'reviews.moderation.decided'>): Promise<void> {
    return this.actions.onModerationDecided(event);
  }

  onConversationLockedFromMessaging(event: EventPayload<'messaging.conversation.locked'>): Promise<void> {
    return this.actions.onConversationLocked(event);
  }

  onAppealSubmittedFromSellers(event: EventPayload<'sellers.appeal.submitted'>): Promise<void> {
    return this.appeals.onSellerAppealSubmitted(event);
  }

  onAppealDecidedFromSellers(event: EventPayload<'sellers.appeal.decided'>): Promise<void> {
    return this.appeals.onSellerAppealDecided(event);
  }

  onAccountRestrictedFromCustomers(event: EventPayload<'customers.account.restricted'>): Promise<void> {
    return this.actions.onAccountRestricted(event);
  }

  onAccountRestrictionLiftedFromCustomers(event: EventPayload<'customers.account.restriction_lifted'>): Promise<void> {
    return this.actions.onAccountRestrictionLifted(event);
  }

  onHoldPlacedFromFinance(event: EventPayload<'finance.hold.placed'>): Promise<void> {
    return this.actions.onHoldPlaced(event);
  }

  onItemCancelledFromOrders(event: EventPayload<'orders.item.cancelled'>): Promise<void> {
    return this.actions.onItemCancelled(event);
  }

  onRefundApprovedFromReturns(event: EventPayload<'returns.refund.approved'>): Promise<void> {
    return this.actions.onRefundApproved(event);
  }

  onCaseOpenedFromSupport(event: EventPayload<'support.case.opened'>): Promise<void> {
    return this.actions.onCaseOpened(event);
  }

  onApplicationSubmittedFromSellers(event: EventPayload<'sellers.application.submitted'>): Promise<void> {
    return this.detection.onApplicationSubmitted(event);
  }

  /* ---------------- jobs */

  /** Job trust.run-detection (every 5 min) */
  runDetection(): Promise<void> {
    return this.detection.runDetection();
  }

  /** Job trust.rescore (every 15 min) */
  rescore(): Promise<void> {
    return this.detection.rescore();
  }

  /** Job trust.evidence-deadlines (hourly) */
  evidenceDeadlines(): Promise<void> {
    return this.detection.evidenceDeadlines();
  }

  /** Job trust.execution-check (every 15 min) */
  executionCheck(): Promise<void> {
    return this.actions.executionCheck();
  }

  /** Job trust.appeal-deadlines (hourly) */
  appealDeadlines(): Promise<void> {
    return this.appeals.deadlines();
  }
}
