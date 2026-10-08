import { notImplemented } from '../../kernel/errors/index.js';
import type { EventPayload } from '../../kernel/events/index.js';
import type { ModuleContext } from '../../kernel/module-system/index.js';
import type * as common from '../../spec/common.js';
import type * as identity from '../../spec/identity.js';
import type { TrustPublicApi, TrustSubject, EvidenceInput, Enforcement, TrustReport } from '../../spec/trust.js';
import type { TrustRepository } from './ports.js';

export interface TrustServiceDeps {
  repo: TrustRepository;
  ctx: ModuleContext<'trust'>;
}

/**
 * Trust and risk use cases. Depends only on ports, the event bus, the clock and other modules' public APIs.
 * Each method maps to a publicApi function, a consumed event or a job in docs/api/spec/modules/trust.json.
 */
export class TrustService implements TrustPublicApi {
  constructor(protected readonly deps: TrustServiceDeps) {}

  /* ---------------- public API (in-process) */

  /** Automated signals from other modules' detectors; de-duplicated by dedupeKey (adds evidence to the open report instead of creating a new one) */
  async raiseSignal(input: { type: string, detector: string, title: string, subjects: TrustSubject[], evidence: EvidenceInput[], score?: number, dedupeKey: string }): Promise<TrustReport> {
    throw notImplemented("trust.raiseSignal");
  }

  /** Seller Manager asks Trust and Risk to assess an application or account; the answer comes back as trust.assessment.completed */
  async requestAssessment(input: { subjectType: 'seller_application' | 'seller' | 'customer', subjectId: string, sellerId?: string, question: string, requestedBy: common.Actor }): Promise<{ reportId: string, ref: string }> {
    throw notImplemented("trust.requestAssessment");
  }

  /** Counts for customer and seller detail pages */
  async reportsAbout(subjectType: string, subjectId: string): Promise<{ filedBy: number, against: number, open: number, reportIds: string[] }> {
    throw notImplemented("trust.reportsAbout");
  }

  /** Active enforcement on an offer, product, seller or customer, with appeal route */
  async enforcementsFor(subjectType: string, subjectId: string): Promise<Enforcement[]> {
    throw notImplemented("trust.enforcementsFor");
  }

  /** Reports filed by or about a customer or seller (including its offers, products and claims) for the admin 360 views; reporter identity, evidence and internal notes are left out */
  async listReportsAbout(subjectType: 'customer' | 'seller', subjectId: string, filter: { role?: 'filed_by' | 'against', statuses?: string[] }, page: common.PageInput): Promise<common.Page<TrustReport>> {
    throw notImplemented("trust.listReportsAbout");
  }

  /** Batch lookup of reports by id (e.g. the report behind a restriction) without reporter identity, evidence or internal notes */
  async getReportSummaries(reportIds: string[]): Promise<TrustReport[]> {
    throw notImplemented("trust.getReportSummaries");
  }

  /** Export rows for reports dataset trust.admin.reports (reporter identities only with trust.reports.export-identities) */
  async exportRows(dataset: string, filters: unknown, principal: identity.Principal, cursor?: string): Promise<{ rows: unknown[], nextCursor?: string }> {
    throw notImplemented("trust.exportRows");
  }

  /* ---------------- events consumed */

  /** reviews.content.referred: Open or extend a fake_reviews report with the referred reviews as subjects */
  async onContentReferredFromReviews(event: EventPayload<"reviews.content.referred">): Promise<void> {
    throw notImplemented("trust consumer of reviews.content.referred");
  }

  /** messaging.message.reported: Open an abuse report for the conversation */
  async onMessageReportedFromMessaging(event: EventPayload<"messaging.message.reported">): Promise<void> {
    throw notImplemented("trust consumer of messaging.message.reported");
  }

  /** orders.order.placed: Feed the linked-new-accounts detection rule (accounts, cards, shipping address) */
  async onOrderPlacedFromOrders(event: EventPayload<"orders.order.placed">): Promise<void> {
    throw notImplemented("trust consumer of orders.order.placed");
  }

  /** payments.chargeback.opened: Add a signal to suspicious-order detection and open reports for repeated chargebacks */
  async onChargebackOpenedFromPayments(event: EventPayload<"payments.chargeback.opened">): Promise<void> {
    throw notImplemented("trust consumer of payments.chargeback.opened");
  }

  /** payments.payment.failed: Signal for card-testing detection */
  async onPaymentFailedFromPayments(event: EventPayload<"payments.payment.failed">): Promise<void> {
    throw notImplemented("trust consumer of payments.payment.failed");
  }

  /** reviews.review.published: Feed the review-burst detection rule */
  async onReviewPublishedFromReviews(event: EventPayload<"reviews.review.published">): Promise<void> {
    throw notImplemented("trust consumer of reviews.review.published");
  }

  /** offers.offer.created: Feed the price-far-below-authorized and restricted-brand rules */
  async onOfferCreatedFromOffers(event: EventPayload<"offers.offer.created">): Promise<void> {
    throw notImplemented("trust consumer of offers.offer.created");
  }

  /** catalog.product.publication_changed: Confirm execution of suspend_product enforcements. setPublication accepts trustReportId; until catalog's publication_changed payload carries it (request to the catalog owner), match by the enforcement reference in the reason */
  async onProductPublicationChangedFromCatalog(event: EventPayload<"catalog.product.publication_changed">): Promise<void> {
    throw notImplemented("trust consumer of catalog.product.publication_changed");
  }

  /** offers.offer.status_changed: Confirm execution of suspend_offer enforcements */
  async onOfferStatusChangedFromOffers(event: EventPayload<"offers.offer.status_changed">): Promise<void> {
    throw notImplemented("trust consumer of offers.offer.status_changed");
  }

  /** sellers.seller.restricted: Confirm restrict_seller enforcements (trustEnforcementId) */
  async onSellerRestrictedFromSellers(event: EventPayload<"sellers.seller.restricted">): Promise<void> {
    throw notImplemented("trust consumer of sellers.seller.restricted");
  }

  /** sellers.seller.suspended: Confirm suspend_seller enforcements */
  async onSellerSuspendedFromSellers(event: EventPayload<"sellers.seller.suspended">): Promise<void> {
    throw notImplemented("trust consumer of sellers.seller.suspended");
  }

  /** sellers.appeal.submitted: Mirror appeals of restrictions that came from a trust report into the Appeals tab */
  async onAppealSubmittedFromSellers(event: EventPayload<"sellers.appeal.submitted">): Promise<void> {
    throw notImplemented("trust consumer of sellers.appeal.submitted");
  }

  /** sellers.appeal.decided: Update the mirrored appeal */
  async onAppealDecidedFromSellers(event: EventPayload<"sellers.appeal.decided">): Promise<void> {
    throw notImplemented("trust consumer of sellers.appeal.decided");
  }

  /** customers.account.restricted: Confirm customer restriction enforcements */
  async onAccountRestrictedFromCustomers(event: EventPayload<"customers.account.restricted">): Promise<void> {
    throw notImplemented("trust consumer of customers.account.restricted");
  }

  /** customers.account.restriction_lifted: Record that a customer restriction ended */
  async onAccountRestrictionLiftedFromCustomers(event: EventPayload<"customers.account.restriction_lifted">): Promise<void> {
    throw notImplemented("trust consumer of customers.account.restriction_lifted");
  }

  /** finance.hold.placed: Confirm hold_payout enforcements when the hold carries trustReportId */
  async onHoldPlacedFromFinance(event: EventPayload<"finance.hold.placed">): Promise<void> {
    throw notImplemented("trust consumer of finance.hold.placed");
  }

  /** orders.item.cancelled: When trustReportId is set: record the staff cancellation on the report (confirms hold_dispatch, review_payments or other recommendations that ended in cancellation) */
  async onItemCancelledFromOrders(event: EventPayload<"orders.item.cancelled">): Promise<void> {
    throw notImplemented("trust consumer of orders.item.cancelled");
  }

  /** returns.refund.approved: When trustReportId is set: confirm refund_buyers enforcements */
  async onRefundApprovedFromReturns(event: EventPayload<"returns.refund.approved">): Promise<void> {
    throw notImplemented("trust consumer of returns.refund.approved");
  }

  /** support.case.opened: Confirm inform_customers outreach cases that reference the report */
  async onCaseOpenedFromSupport(event: EventPayload<"support.case.opened">): Promise<void> {
    throw notImplemented("trust consumer of support.case.opened");
  }

  /** sellers.application.submitted: Run application detection rules (duplicate tax id, bank token or address of a closed account) and add signals to any assessment */
  async onApplicationSubmittedFromSellers(event: EventPayload<"sellers.application.submitted">): Promise<void> {
    throw notImplemented("trust consumer of sellers.application.submitted");
  }

  /* ---------------- jobs */

  /** Job trust.run-detection (every 5 min): Evaluate detection rules over risk_signals windows; raise or extend reports (de-duplicated) */
  async runDetection(): Promise<void> {
    throw notImplemented("job trust.run-detection");
  }

  /** Job trust.rescore (every 15 min): Recompute risk scores for open reports when evidence or signals change (overrides are kept) */
  async rescore(): Promise<void> {
    throw notImplemented("job trust.rescore");
  }

  /** Job trust.evidence-deadlines (hourly): Expire evidence requests past due and note it on the report */
  async evidenceDeadlines(): Promise<void> {
    throw notImplemented("job trust.evidence-deadlines");
  }

  /** Job trust.execution-check (every 15 min): Flag enforcement still pending after executionGraceMinutes as failed and raise a workqueue item for the owner team */
  async executionCheck(): Promise<void> {
    throw notImplemented("job trust.execution-check");
  }

  /** Job trust.appeal-deadlines (hourly): Raise workqueue items for appeals near decideBy */
  async appealDeadlines(): Promise<void> {
    throw notImplemented("job trust.appeal-deadlines");
  }
}
