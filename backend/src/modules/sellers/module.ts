import { defineModule } from '../../kernel/module-system/index.js';
import { spec } from '../../spec/sellers.js';
import { resolvers } from './graphql/resolvers.js';
import { typeDefs } from './graphql/schema.js';
import { storeRoutes } from './http/store.js';
import { sellerRoutes } from './http/seller.js';
import { adminRoutes } from './http/admin.js';
import { webhooksRoutes } from './http/webhooks.js';
import { migrations } from './infra/postgres/migrations/index.js';
import { createPostgresSellersRepository } from './infra/postgres/repository.js';
import { hmacWebhookVerifier } from '../../kernel/http/webhooks.js';
import { devProviders } from './infra/providers/dev.js';
import { SellersService } from './service.js';

/**
 * Sellers: Seller admission and the seller account: the Sell with us programme and multi-step application, verification checks and review decisions, seller statuses with account status, product approval and payout readiness kept separate, setup and launch readiness, storefront profile and public storefront, seller members and permissions, performance against targets, warnings, restrictions, suspensions and appeals.
 *
 * Name, launch phase, dependencies, permissions, events, jobs, settings and endpoints come from
 * docs/api/spec/modules/sellers.json through `spec`; the server refuses to start if they drift.
 */
export default defineModule({
  spec,
  version: '1.0.0',
  migrations,
  graphql: typeDefs,
  register(ctx) {
    // KYC/KYB, payout tokenisation and address checks: deterministic dev adapters until real providers are wired
    const service = new SellersService({ repo: createPostgresSellersRepository(ctx.db), ctx, providers: devProviders });
    ctx.provide(service);
    ctx.http.routes(storeRoutes(service), sellerRoutes(service), adminRoutes(service), webhooksRoutes(service));
    ctx.graphql.resolvers(resolvers(service));
    ctx.http.webhookVerifier(hmacWebhookVerifier(ctx.config, ctx.name));

    // Events this module reacts to (spec events.consumes)
    ctx.events.on("identity.invitation.accepted", (e) => service.onInvitationAcceptedFromIdentity(e.payload));
    ctx.events.on("identity.account.closed", (e) => service.onAccountClosedFromIdentity(e.payload));
    ctx.events.on("access.approval.decided", (e) => service.onApprovalDecidedFromAccess(e.payload, e));
    ctx.events.on("trust.assessment.completed", (e) => service.onAssessmentCompletedFromTrust(e.payload));
    ctx.events.on("trust.enforcement.recorded", (e) => service.onEnforcementRecordedFromTrust(e.payload, e));
    ctx.events.on("finance.destination.verified", (e) => service.onDestinationVerifiedFromFinance(e.payload));
    ctx.events.on("finance.destination.rejected", (e) => service.onDestinationRejectedFromFinance(e.payload));
    ctx.events.on("catalog.product.submitted", (e) => service.onProductSubmittedFromCatalog(e.payload));
    ctx.events.on("catalog.product.approved", (e) => service.onProductApprovedFromCatalog(e.payload));
    ctx.events.on("catalog.product.changes_requested", (e) => service.onProductChangesRequestedFromCatalog(e.payload));
    ctx.events.on("catalog.product.rejected", (e) => service.onProductRejectedFromCatalog(e.payload));
    ctx.events.on("content.policy.effective", (e) => service.onPolicyEffectiveFromContent(e.payload));
    ctx.events.on("orders.order.accepted", (e) => service.onOrderAcceptedFromOrders(e.payload));
    ctx.events.on("orders.item.cancelled", (e) => service.onItemCancelledFromOrders(e.payload));
    ctx.events.on("shipping.shipment.dispatched", (e) => service.onShipmentDispatchedFromShipping(e.payload));
    ctx.events.on("shipping.dispatch.overdue", (e) => service.onDispatchOverdueFromShipping(e.payload));
    ctx.events.on("shipping.shipment.delivered", (e) => service.onShipmentDeliveredFromShipping(e.payload));
    ctx.events.on("returns.return.requested", (e) => service.onReturnRequestedFromReturns(e.payload));
    ctx.events.on("support.case.opened", (e) => service.onCaseOpenedFromSupport(e.payload));
    ctx.events.on("support.case.resolved", (e) => service.onCaseResolvedFromSupport(e.payload));
    ctx.events.on("messaging.message.sent", (e) => service.onMessageSentFromMessaging(e.payload));

    // Background jobs (spec jobs)
    ctx.jobs.handle("sellers.run-verification-checks", () => service.runVerificationChecks());
    ctx.jobs.handle("sellers.application-deadlines", () => service.applicationDeadlines());
    ctx.jobs.handle("sellers.compute-performance", () => service.computePerformance());
    ctx.jobs.handle("sellers.restriction-reviews", () => service.restrictionReviews());
    ctx.jobs.handle("sellers.appeal-deadlines", () => service.appealDeadlines());
    ctx.jobs.handle("sellers.verification-lapse", () => service.verificationLapse());
    ctx.jobs.handle("sellers.expire-invitations", () => service.expireInvitations());
    ctx.jobs.handle("sellers.purge-documents", () => service.purgeDocuments());
    ctx.jobs.handle("sellers.auto-warnings", () => service.autoWarnings());
  },
});
