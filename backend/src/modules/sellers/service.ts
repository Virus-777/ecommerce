import { notImplemented } from '../../kernel/errors/index.js';
import type { EventPayload } from '../../kernel/events/index.js';
import type { ModuleContext } from '../../kernel/module-system/index.js';
import type * as common from '../../spec/common.js';
import type * as identity from '../../spec/identity.js';
import type { SellersPublicApi, SellerSnapshot, SellerSummary, Storefront, PerformanceSummary, Restriction, RestrictionInput } from '../../spec/sellers.js';
import type { SellersRepository } from './ports.js';

export interface SellersServiceDeps {
  repo: SellersRepository;
  ctx: ModuleContext<'sellers'>;
}

/**
 * Sellers use cases. Depends only on ports, the event bus, the clock and other modules' public APIs.
 * Each method maps to a publicApi function, a consumed event or a job in docs/api/spec/modules/sellers.json.
 */
export class SellersService implements SellersPublicApi {
  constructor(protected readonly deps: SellersServiceDeps) {}

  /* ---------------- public API (in-process) */

  /** Store name, slug, status, verified label and whether new sales are allowed (marketplace sellers only; the Official Store is ownerType official with sellerId null and has no seller record) */
  async getSeller(sellerId: string): Promise<SellerSnapshot | null> {
    throw notImplemented("sellers.getSeller");
  }

  /** Batch version for lists */
  async getSellers(sellerIds: string[]): Promise<SellerSnapshot[]> {
    throw notImplemented("sellers.getSellers");
  }

  /** Single answer to 'does any active restriction or suspension block this?'. Offers, catalog, promotions and advertising call it before accepting new work. */
  async canSell(sellerId: string, check: { activity: 'new_offers' | 'new_listings' | 'product_submissions' | 'offer_reactivation' | 'sales' | 'advertising' | 'promotions', categoryId?: string, condition?: string, offerId?: string }): Promise<{ allowed: boolean, restrictionId?: string, reason?: string, appealRoute?: string }> {
    throw notImplemented("sellers.canSell");
  }

  /** Seller-area permission check used by the kernel auth guard for every seller endpoint */
  async getMemberAccess(sellerId: string, accountId: string): Promise<{ memberId: string, role: string, permissions: string[], isOwner: boolean } | null> {
    throw notImplemented("sellers.getMemberAccess");
  }

  /** Latest metrics vs targets; offers uses it for main-offer eligibility, reports for seller dashboards */
  async getPerformance(sellerId: string): Promise<PerformanceSummary> {
    throw notImplemented("sellers.getPerformance");
  }

  /** Name, logo, verified label, rating and slug for product pages and offer lists */
  async getStorefrontCard(sellerIds: string[]): Promise<SellerSummary[]> {
    throw notImplemented("sellers.getStorefrontCard");
  }

  /** Used by trust when a Seller Manager accepts a restriction recommendation in the trust screen; follows the same approval rules as the admin endpoint */
  async requestRestriction(input: RestrictionInput & { sellerId: string, requestedBy: common.Actor }): Promise<Restriction> {
    throw notImplemented("sellers.requestRestriction");
  }

  /** Public storefront by slug, same data as GET /api/store/sellers/stores/{slug}; null for unknown, unapproved or closed stores */
  async getStorefrontBySlug(slug: string): Promise<Storefront | null> {
    throw notImplemented("sellers.getStorefrontBySlug");
  }

  /** Admin seller list with the same filters as GET /api/admin/sellers/sellers */
  async searchSellers(filter: { search?: string, statuses?: string[], verified?: boolean, dispatchBelowPct?: number, mainCategoryId?: string }, page: common.PageInput): Promise<common.Page<SellerSnapshot>> {
    throw notImplemented("sellers.searchSellers");
  }

  /** Export rows for reports dataset sellers.admin.accounts (the filtered seller list) */
  async exportRows(dataset: string, filters: unknown, principal: identity.Principal, cursor?: string): Promise<{ rows: unknown[], nextCursor?: string }> {
    throw notImplemented("sellers.exportRows");
  }

  /* ---------------- events consumed */

  /** identity.invitation.accepted: Activate the invited member and call identity.grantSellerContext */
  async onInvitationAcceptedFromIdentity(event: EventPayload<"identity.invitation.accepted">): Promise<void> {
    throw notImplemented("sellers consumer of identity.invitation.accepted");
  }

  /** identity.account.closed: Remove the account's memberships; if it was an owner, open a Seller Manager work item */
  async onAccountClosedFromIdentity(event: EventPayload<"identity.account.closed">): Promise<void> {
    throw notImplemented("sellers consumer of identity.account.closed");
  }

  /** access.approval.decided: Finish pending suspensions, restrictions, closures and target changes (approved) or cancel them (declined) */
  async onApprovalDecidedFromAccess(event: EventPayload<"access.approval.decided">): Promise<void> {
    throw notImplemented("sellers consumer of access.approval.decided");
  }

  /** trust.assessment.completed: Store risk level, flags and recommendation on the application's risk review */
  async onAssessmentCompletedFromTrust(event: EventPayload<"trust.assessment.completed">): Promise<void> {
    throw notImplemented("sellers consumer of trust.assessment.completed");
  }

  /** trust.enforcement.recorded: When the action is restrict_seller, warn_seller or suspend_seller, create the restriction or warning from the enforcement parameters (recommendedBy Trust) or start a suspension that still needs its second reviewer */
  async onEnforcementRecordedFromTrust(event: EventPayload<"trust.enforcement.recorded">): Promise<void> {
    throw notImplemented("sellers consumer of trust.enforcement.recorded");
  }

  /** finance.destination.verified: Payout readiness → verified; setup checklist step done */
  async onDestinationVerifiedFromFinance(event: EventPayload<"finance.destination.verified">): Promise<void> {
    throw notImplemented("sellers consumer of finance.destination.verified");
  }

  /** finance.destination.rejected: Payout readiness back to not_added (new account) or verified (change rejected, old account stays); tell the owner why */
  async onDestinationRejectedFromFinance(event: EventPayload<"finance.destination.rejected">): Promise<void> {
    throw notImplemented("sellers consumer of finance.destination.rejected");
  }

  /** catalog.product.submitted: Update product approval summary and the first-submission setup step */
  async onProductSubmittedFromCatalog(event: EventPayload<"catalog.product.submitted">): Promise<void> {
    throw notImplemented("sellers consumer of catalog.product.submitted");
  }

  /** catalog.product.approved: Update product approval summary */
  async onProductApprovedFromCatalog(event: EventPayload<"catalog.product.approved">): Promise<void> {
    throw notImplemented("sellers consumer of catalog.product.approved");
  }

  /** catalog.product.changes_requested: Update product approval summary */
  async onProductChangesRequestedFromCatalog(event: EventPayload<"catalog.product.changes_requested">): Promise<void> {
    throw notImplemented("sellers consumer of catalog.product.changes_requested");
  }

  /** catalog.product.rejected: Update product approval summary */
  async onProductRejectedFromCatalog(event: EventPayload<"catalog.product.rejected">): Promise<void> {
    throw notImplemented("sellers consumer of catalog.product.rejected");
  }

  /** content.policy.effective: When a seller agreement, product rules, fee schedule or service standards version becomes effective, mark it pending for every owner */
  async onPolicyEffectiveFromContent(event: EventPayload<"content.policy.effective">): Promise<void> {
    throw notImplemented("sellers consumer of content.policy.effective");
  }

  /** orders.order.accepted: Performance: count accepted orders and units per seller group */
  async onOrderAcceptedFromOrders(event: EventPayload<"orders.order.accepted">): Promise<void> {
    throw notImplemented("sellers consumer of orders.order.accepted");
  }

  /** orders.item.cancelled: Performance: count seller-caused cancellations */
  async onItemCancelledFromOrders(event: EventPayload<"orders.item.cancelled">): Promise<void> {
    throw notImplemented("sellers consumer of orders.item.cancelled");
  }

  /** shipping.shipment.dispatched: Performance: on-time vs late dispatch and whether tracking is valid */
  async onShipmentDispatchedFromShipping(event: EventPayload<"shipping.shipment.dispatched">): Promise<void> {
    throw notImplemented("sellers consumer of shipping.shipment.dispatched");
  }

  /** shipping.dispatch.overdue: Performance: overdue dispatch counts towards dispatch reliability */
  async onDispatchOverdueFromShipping(event: EventPayload<"shipping.dispatch.overdue">): Promise<void> {
    throw notImplemented("sellers consumer of shipping.dispatch.overdue");
  }

  /** shipping.shipment.delivered: Performance: confirm carrier-scanned tracking */
  async onShipmentDeliveredFromShipping(event: EventPayload<"shipping.shipment.delivered">): Promise<void> {
    throw notImplemented("sellers consumer of shipping.shipment.delivered");
  }

  /** returns.return.requested: Performance: return rate */
  async onReturnRequestedFromReturns(event: EventPayload<"returns.return.requested">): Promise<void> {
    throw notImplemented("sellers consumer of returns.return.requested");
  }

  /** support.case.opened: Performance: open cases per seller */
  async onCaseOpenedFromSupport(event: EventPayload<"support.case.opened">): Promise<void> {
    throw notImplemented("sellers consumer of support.case.opened");
  }

  /** support.case.resolved: Performance: unresolved cases past deadline */
  async onCaseResolvedFromSupport(event: EventPayload<"support.case.resolved">): Promise<void> {
    throw notImplemented("sellers consumer of support.case.resolved");
  }

  /** messaging.message.sent: Performance: buyer message received and first seller reply times */
  async onMessageSentFromMessaging(event: EventPayload<"messaging.message.sent">): Promise<void> {
    throw notImplemented("sellers consumer of messaging.message.sent");
  }

  /* ---------------- jobs */

  /** Job sellers.run-verification-checks (on submit + every 5 min for pending): Send identity, registration, tax id, payout-name match and return-address checks to providers; refer automatically to trust for riskReviewCategories */
  async runVerificationChecks(): Promise<void> {
    throw notImplemented("job sellers.run-verification-checks");
  }

  /** Job sellers.application-deadlines (hourly): Send reminders before information deadlines; expire applications past due; raise workqueue items for applications past the decision target */
  async applicationDeadlines(): Promise<void> {
    throw notImplemented("job sellers.application-deadlines");
  }

  /** Job sellers.compute-performance (daily 06:00 market time): Recompute 30-day (and 90-day for violations) metrics from performance_events against effective targets; publish sellers.performance.below_target for new misses */
  async computePerformance(): Promise<void> {
    throw notImplemented("job sellers.compute-performance");
  }

  /** Job sellers.restriction-reviews (daily 07:00 market time): Expire restrictions past endsAt; raise workqueue items for restrictions and suspensions reaching their review date */
  async restrictionReviews(): Promise<void> {
    throw notImplemented("job sellers.restriction-reviews");
  }

  /** Job sellers.appeal-deadlines (hourly): Raise workqueue items for appeals near or past decideBy */
  async appealDeadlines(): Promise<void> {
    throw notImplemented("job sellers.appeal-deadlines");
  }

  /** Job sellers.verification-lapse (daily): Lapse Verified labels whose checked documents expired; tell the seller what to renew */
  async verificationLapse(): Promise<void> {
    throw notImplemented("job sellers.verification-lapse");
  }

  /** Job sellers.expire-invitations (hourly): Expire member invitations and seller invitations past their expiry */
  async expireInvitations(): Promise<void> {
    throw notImplemented("job sellers.expire-invitations");
  }

  /** Job sellers.purge-documents (daily): Delete ID and rejected-application documents after their retention period */
  async purgeDocuments(): Promise<void> {
    throw notImplemented("job sellers.purge-documents");
  }

  /** Job sellers.auto-warnings (daily 06:30 market time): Phase 2 performance controls: issue warnings automatically for repeated misses and propose restrictions to the Seller Manager (never restrict automatically) */
  async autoWarnings(): Promise<void> {
    throw notImplemented("job sellers.auto-warnings");
  }
}
