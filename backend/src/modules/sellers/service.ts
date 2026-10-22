import type { EventEnvelope, EventPayload } from '../../kernel/events/index.js';
import type * as common from '../../spec/common.js';
import type * as identity from '../../spec/identity.js';
import type { PerformanceSummary, Restriction, RestrictionInput, SellerSnapshot, SellerSummary, SellersPublicApi, Storefront } from '../../spec/sellers.js';
import { AccountsPart } from './service/accounts.js';
import { ApplicationsPart } from './service/applications.js';
import { Core, type SellersServiceDeps } from './service/core.js';
import { EnforcementPart } from './service/enforcement.js';
import { MembersPart } from './service/members.js';
import { PerformancePart } from './service/performance.js';
import { registerSellersSettingsSection } from './service/settings-section.js';
import { StorefrontPart } from './service/storefront.js';

export type { SellersServiceDeps };

/**
 * Sellers use cases. Depends only on its repository, its providers, the event bus, the clock and other modules'
 * public APIs. The work is split by area (service/*.ts); this class is the module's public API, its event consumers and jobs.
 */
export class SellersService implements SellersPublicApi {
  readonly core: Core;
  readonly applications: ApplicationsPart;
  readonly accounts: AccountsPart;
  readonly storefront: StorefrontPart;
  readonly members: MembersPart;
  readonly enforcement: EnforcementPart;
  readonly performance: PerformancePart;

  constructor(deps: SellersServiceDeps) {
    this.core = new Core(deps);
    this.applications = new ApplicationsPart(this.core);
    this.accounts = new AccountsPart(this.core);
    this.storefront = new StorefrontPart(this.core);
    this.members = new MembersPart(this.core);
    this.enforcement = new EnforcementPart(this.core);
    this.performance = new PerformancePart(this.core);
    this.core.parts = { applications: this.applications, accounts: this.accounts, storefront: this.storefront, members: this.members, enforcement: this.enforcement, performance: this.performance };
  }

  /** After boot: the Seller performance targets section of the settings page (G76) */
  registerSettingsSection(): Promise<void> {
    return registerSellersSettingsSection(this.core.ctx.tryUse('settings'), this.performance, () => this.core.today());
  }

  /* ---------------- public API (in-process) */

  getSeller(sellerId: string): Promise<SellerSnapshot | null> {
    return this.accounts.getSeller(sellerId);
  }

  getSellers(sellerIds: string[]): Promise<SellerSnapshot[]> {
    return this.accounts.getSellers(sellerIds);
  }

  canSell(sellerId: string, check: Parameters<SellersPublicApi['canSell']>[1]) {
    return this.enforcement.canSell(sellerId, check);
  }

  /** Called by the kernel guard on every seller-area request: one indexed lookup */
  getMemberAccess(sellerId: string, accountId: string) {
    return this.members.getMemberAccess(sellerId, accountId);
  }

  /** Active members with their identity account (notifications: owners and members who never opened Seller Center) */
  listMembers(sellerId: string) {
    return this.members.activeMembers(sellerId);
  }

  ownerOf(sellerId: string) {
    return this.members.ownerAccount(sellerId);
  }

  getPerformance(sellerId: string): Promise<PerformanceSummary> {
    return this.performance.getPerformance(sellerId);
  }

  getStorefrontCard(sellerIds: string[]): Promise<SellerSummary[]> {
    return this.storefront.getStorefrontCard(sellerIds);
  }

  /** Trust: same approval rules as the admin endpoint; a restriction above the caller's authority comes back pending_approval */
  requestRestriction(input: RestrictionInput & { sellerId: string; requestedBy: common.Actor }): Promise<Restriction> {
    const { sellerId, requestedBy, ...rest } = input;
    return this.enforcement.createRestriction(sellerId, rest, { actor: requestedBy }, { recommendedBy: rest.trustReportId ? { kind: 'system', id: null, name: 'Trust and Risk' } : null });
  }

  /** The applicant behind an application, so staff → applicant conversations can add them (messaging) */
  getApplicationParticipant(applicationId: string) {
    return this.applications.participant(applicationId);
  }

  getStorefrontBySlug(slug: string): Promise<Storefront | null> {
    return this.storefront.getStorefrontBySlug(slug);
  }

  searchSellers(filter: Parameters<SellersPublicApi['searchSellers']>[0], page: common.PageInput): Promise<common.Page<SellerSnapshot>> {
    return this.accounts.searchSellers(filter, page);
  }

  exportRows(dataset: string, filters: unknown, principal: identity.Principal, cursor?: string) {
    return this.accounts.exportRows(dataset, filters, principal, cursor);
  }

  /**
   * Link targets for advertising destination pickers: approved storefronts (/shop/{slug}) by name, or by id (any
   * status; only approved ones are available).
   */
  async linkTargets(input: { kind: 'seller_store'; q?: string; ids?: string[]; slugs?: string[]; limit?: number }): Promise<common.LinkTarget[]> {
    if (input.kind !== 'seller_store') return [];
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
    const bySlug = input.slugs ? (await Promise.all([...new Set(input.slugs)].map((s) => this.core.repo.sellerBySlug(s)))).flatMap((r) => (r ? [r.id] : [])) : null;
    const ids = input.ids ?? bySlug;
    const sellers = ids
      ? ids.length
        ? await this.getSellers([...new Set(ids)])
        : []
      : (await this.searchSellers({ ...(input.q?.trim() ? { search: input.q.trim() } : {}), statuses: ['approved'] }, { limit })).items;
    const cards = new Map((sellers.length ? await this.getStorefrontCard(sellers.map((x) => x.id)) : []).map((c) => [c.id, c]));
    return sellers.map((x) => ({
      id: x.id,
      label: x.storeName,
      meta: `Store · ${x.ref}${x.verified ? ' · Verified' : ''}`,
      path: `/shop/${x.slug}`,
      image: cards.get(x.id)?.logo ?? null,
      available: x.status === 'approved',
    }));
  }

  /* ---------------- events consumed */

  onInvitationAcceptedFromIdentity(event: EventPayload<'identity.invitation.accepted'>) {
    return this.members.onInvitationAccepted(event);
  }

  onAccountClosedFromIdentity(event: EventPayload<'identity.account.closed'>) {
    return this.members.onAccountClosed(event);
  }

  onApprovalDecidedFromAccess(event: EventPayload<'access.approval.decided'>, envelope?: Pick<EventEnvelope, 'actor'>) {
    return this.enforcement.onApprovalDecided(event, envelope?.actor);
  }

  onAssessmentCompletedFromTrust(event: EventPayload<'trust.assessment.completed'>) {
    return this.applications.onAssessmentCompleted(event);
  }

  onEnforcementRecordedFromTrust(event: EventPayload<'trust.enforcement.recorded'>, envelope?: Pick<EventEnvelope, 'actor'>) {
    return this.enforcement.onEnforcementRecorded(event, envelope);
  }

  /** trust.enforcement.reversed: undo the restriction, suspension or warning the enforcement created */
  onEnforcementReversedFromTrust(event: EventPayload<'trust.enforcement.reversed'>, eventId?: string) {
    return this.enforcement.onEnforcementReversed(event, eventId);
  }

  onDestinationVerifiedFromFinance(event: EventPayload<'finance.destination.verified'>) {
    return this.accounts.onDestinationVerified(event);
  }

  onDestinationRejectedFromFinance(event: EventPayload<'finance.destination.rejected'>) {
    return this.accounts.onDestinationRejected(event);
  }

  onProductSubmittedFromCatalog(event: EventPayload<'catalog.product.submitted'>) {
    return this.accounts.onProductEvent(event.ownerSellerId, true);
  }

  onProductApprovedFromCatalog(event: EventPayload<'catalog.product.approved'>) {
    return this.accounts.onProductEvent(event.ownerSellerId, false);
  }

  onProductChangesRequestedFromCatalog(event: EventPayload<'catalog.product.changes_requested'>) {
    return this.accounts.onProductEvent(event.ownerSellerId, false);
  }

  onProductRejectedFromCatalog(event: EventPayload<'catalog.product.rejected'>) {
    return this.accounts.onProductEvent(event.ownerSellerId, false);
  }

  onPolicyEffectiveFromContent(event: EventPayload<'content.policy.effective'>) {
    return this.accounts.onPolicyEffective(event);
  }

  onOrderAcceptedFromOrders(event: EventPayload<'orders.order.accepted'>) {
    return this.performance.onOrderAccepted(event);
  }

  onItemCancelledFromOrders(event: EventPayload<'orders.item.cancelled'>) {
    return this.performance.onItemCancelled(event);
  }

  onShipmentDispatchedFromShipping(event: EventPayload<'shipping.shipment.dispatched'>) {
    return this.performance.onShipmentDispatched(event);
  }

  onDispatchOverdueFromShipping(event: EventPayload<'shipping.dispatch.overdue'>) {
    return this.performance.onDispatchOverdue(event);
  }

  onShipmentDeliveredFromShipping(event: EventPayload<'shipping.shipment.delivered'>) {
    return this.performance.onShipmentDelivered(event);
  }

  onReturnRequestedFromReturns(event: EventPayload<'returns.return.requested'>) {
    return this.performance.onReturnRequested(event);
  }

  onCaseOpenedFromSupport(event: EventPayload<'support.case.opened'>) {
    return this.performance.onCaseOpened(event);
  }

  onCaseResolvedFromSupport(event: EventPayload<'support.case.resolved'>) {
    return this.performance.onCaseResolved(event);
  }

  onMessageSentFromMessaging(event: EventPayload<'messaging.message.sent'>) {
    return this.performance.onMessageSent(event);
  }

  /* ---------------- jobs */

  runVerificationChecks() {
    return this.applications.runVerificationChecks();
  }

  applicationDeadlines() {
    return this.applications.applicationDeadlines();
  }

  computePerformance() {
    return this.performance.computePerformance();
  }

  async restrictionReviews() {
    await this.enforcement.restrictionReviews();
    await this.storefront.expireClaims();
  }

  appealDeadlines() {
    return this.enforcement.appealDeadlines();
  }

  verificationLapse() {
    return this.accounts.verificationLapse();
  }

  async expireInvitations() {
    const now = this.core.now();
    await this.members.expireInvitations(now);
    await this.applications.expireSellerInvitations(now);
  }

  purgeDocuments() {
    return this.applications.purgeDocuments();
  }

  autoWarnings() {
    return this.performance.autoWarnings();
  }
}
