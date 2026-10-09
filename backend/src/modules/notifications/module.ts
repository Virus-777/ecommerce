import { defineModule } from '../../kernel/module-system/index.js';
import { spec } from '../../spec/notifications.js';
import { resolvers } from './graphql/resolvers.js';
import { typeDefs } from './graphql/schema.js';
import { storeRoutes } from './http/store.js';
import { sellerRoutes } from './http/seller.js';
import { adminRoutes } from './http/admin.js';
import { webhooksRoutes } from './http/webhooks.js';
import { migrations } from './infra/postgres/migrations/index.js';
import { createPostgresNotificationsRepository } from './infra/postgres/repository.js';
import { NotificationsService } from './service.js';
import { hmacWebhookVerifier } from '../../kernel/http/webhooks.js';
import { createDevEmailProvider } from './infra/email/dev.js';
import { createDevSmsProvider } from './infra/sms/dev.js';
import { createDevPushProvider } from './infra/push/dev.js';

/**
 * Notifications: Who is told what, on which channel: notification topics for customers, sellers and staff, routing from platform events to recipients (staff by role, with backups), templates with versions and preview, in-app inboxes for the store, Seller Center and Admin Center, email delivery with retries and suppression, seller and staff channel preferences, promotional broadcasts under consent, and Android push devices (phase 3).
 *
 * Name, launch phase, dependencies, permissions, events, jobs, settings and endpoints come from
 * docs/api/spec/modules/notifications.json through `spec`; the server refuses to start if they drift.
 */
export default defineModule({
  spec,
  version: '1.0.0',
  migrations,
  graphql: typeDefs,
  async register(ctx) {
    // Providers: deterministic development adapters (no network); real adapters plug in behind the same ports
    const providers = { email: createDevEmailProvider(), sms: createDevSmsProvider(), push: createDevPushProvider() };
    const service = new NotificationsService({ repo: createPostgresNotificationsRepository(ctx.db), ctx, providers });
    ctx.provide(service);
    ctx.http.routes(storeRoutes(service), sellerRoutes(service), adminRoutes(service), webhooksRoutes(service));
    ctx.http.webhookVerifier(hmacWebhookVerifier(ctx.config, ctx.name));
    ctx.graphql.resolvers(resolvers(service));
    // topic catalogue and default templates (idempotent; retried lazily on first use if the tables are not ready)
    await service.seed().catch((err) => ctx.log.warn({ err }, 'notifications: seeding topics and templates failed; retrying on first use'));

    // Events this module reacts to (spec events.consumes)
    ctx.events.on("identity.verification.code_issued", (e) => service.onVerificationCodeIssuedFromIdentity(e.payload, e.id));
    ctx.events.on("identity.password_reset.requested", (e) => service.onPasswordResetRequestedFromIdentity(e.payload, e.id));
    ctx.events.on("identity.password.changed", (e) => service.onPasswordChangedFromIdentity(e.payload, e.id));
    ctx.events.on("identity.session.new_device", (e) => service.onSessionNewDeviceFromIdentity(e.payload, e.id));
    ctx.events.on("identity.email.changed", (e) => service.onEmailChangedFromIdentity(e.payload, e.id));
    ctx.events.on("identity.two_step.changed", (e) => service.onTwoStepChangedFromIdentity(e.payload, e.id));
    ctx.events.on("identity.account.locked", (e) => service.onAccountLockedFromIdentity(e.payload, e.id));
    ctx.events.on("identity.invitation.created", (e) => service.onInvitationCreatedFromIdentity(e.payload, e.id));
    ctx.events.on("identity.user.verified", (e) => service.onUserVerifiedFromIdentity(e.payload, e.id));
    ctx.events.on("customers.marketing_preferences.changed", (e) => service.onMarketingPreferencesChangedFromCustomers(e.payload, e.id));
    ctx.events.on("customers.account.closed", (e) => service.onAccountClosedFromCustomers(e.payload, e.id));
    ctx.events.on("customers.data_export.ready", (e) => service.onDataExportReadyFromCustomers(e.payload, e.id));
    ctx.events.on("orders.order.accepted", (e) => service.onOrderAcceptedFromOrders(e.payload, e.id));
    ctx.events.on("orders.item.cancelled", (e) => service.onItemCancelledFromOrders(e.payload, e.id));
    ctx.events.on("orders.item.delayed", (e) => service.onItemDelayedFromOrders(e.payload, e.id));
    ctx.events.on("orders.cancellation.decided", (e) => service.onCancellationDecidedFromOrders(e.payload, e.id));
    ctx.events.on("payments.payment.captured", (e) => service.onPaymentCapturedFromPayments(e.payload, e.id));
    ctx.events.on("payments.payment.failed", (e) => service.onPaymentFailedFromPayments(e.payload, e.id));
    ctx.events.on("payments.payment.pending_check", (e) => service.onPaymentPendingCheckFromPayments(e.payload, e.id));
    ctx.events.on("payments.refund.sent", (e) => service.onRefundSentFromPayments(e.payload, e.id));
    ctx.events.on("payments.refund.failed", (e) => service.onRefundFailedFromPayments(e.payload, e.id));
    ctx.events.on("payments.chargeback.opened", (e) => service.onChargebackOpenedFromPayments(e.payload, e.id));
    ctx.events.on("shipping.shipment.dispatched", (e) => service.onShipmentDispatchedFromShipping(e.payload, e.id));
    ctx.events.on("shipping.shipment.delivered", (e) => service.onShipmentDeliveredFromShipping(e.payload, e.id));
    ctx.events.on("shipping.shipment.exception", (e) => service.onShipmentExceptionFromShipping(e.payload, e.id));
    ctx.events.on("shipping.dispatch.overdue", (e) => service.onDispatchOverdueFromShipping(e.payload, e.id));
    ctx.events.on("returns.return.requested", (e) => service.onReturnRequestedFromReturns(e.payload, e.id));
    ctx.events.on("returns.return.info_requested", (e) => service.onReturnInfoRequestedFromReturns(e.payload, e.id));
    ctx.events.on("returns.return.approved", (e) => service.onReturnApprovedFromReturns(e.payload, e.id));
    ctx.events.on("returns.return.rejected", (e) => service.onReturnRejectedFromReturns(e.payload, e.id));
    ctx.events.on("returns.label.created", (e) => service.onLabelCreatedFromReturns(e.payload, e.id));
    ctx.events.on("returns.return.received", (e) => service.onReturnReceivedFromReturns(e.payload, e.id));
    ctx.events.on("returns.return.inspected", (e) => service.onReturnInspectedFromReturns(e.payload, e.id));
    ctx.events.on("returns.return.escalated", (e) => service.onReturnEscalatedFromReturns(e.payload, e.id));
    ctx.events.on("returns.refund.approved", (e) => service.onRefundApprovedFromReturns(e.payload, e.id));
    ctx.events.on("returns.replacement.created", (e) => service.onReplacementCreatedFromReturns(e.payload, e.id));
    ctx.events.on("support.case.opened", (e) => service.onCaseOpenedFromSupport(e.payload, e.id));
    ctx.events.on("support.case.message_added", (e) => service.onCaseMessageAddedFromSupport(e.payload, e.id));
    ctx.events.on("support.case.escalated", (e) => service.onCaseEscalatedFromSupport(e.payload, e.id));
    ctx.events.on("support.case.overdue", (e) => service.onCaseOverdueFromSupport(e.payload, e.id));
    ctx.events.on("support.case.decided", (e) => service.onCaseDecidedFromSupport(e.payload, e.id));
    ctx.events.on("support.case.resolved", (e) => service.onCaseResolvedFromSupport(e.payload, e.id));
    ctx.events.on("messaging.message.sent", (e) => service.onMessageSentFromMessaging(e.payload, e.id));
    ctx.events.on("sellers.application.submitted", (e) => service.onApplicationSubmittedFromSellers(e.payload, e.id));
    ctx.events.on("sellers.application.information_requested", (e) => service.onApplicationInformationRequestedFromSellers(e.payload, e.id));
    ctx.events.on("sellers.application.decided", (e) => service.onApplicationDecidedFromSellers(e.payload, e.id));
    ctx.events.on("sellers.seller.restricted", (e) => service.onSellerRestrictedFromSellers(e.payload, e.id));
    ctx.events.on("sellers.seller.suspended", (e) => service.onSellerSuspendedFromSellers(e.payload, e.id));
    ctx.events.on("sellers.seller.reinstated", (e) => service.onSellerReinstatedFromSellers(e.payload, e.id));
    ctx.events.on("sellers.warning.issued", (e) => service.onWarningIssuedFromSellers(e.payload, e.id));
    ctx.events.on("sellers.appeal.decided", (e) => service.onAppealDecidedFromSellers(e.payload, e.id));
    ctx.events.on("sellers.payout_account.changed", (e) => service.onPayoutAccountChangedFromSellers(e.payload, e.id));
    ctx.events.on("sellers.change_request.decided", (e) => service.onChangeRequestDecidedFromSellers(e.payload, e.id));
    ctx.events.on("sellers.verification.changed", (e) => service.onVerificationChangedFromSellers(e.payload, e.id));
    ctx.events.on("sellers.launch_review.decided", (e) => service.onLaunchReviewDecidedFromSellers(e.payload, e.id));
    ctx.events.on("sellers.invitation.sent", (e) => service.onInvitationSentFromSellers(e.payload, e.id));
    ctx.events.on("finance.destination.verified", (e) => service.onDestinationVerifiedFromFinance(e.payload, e.id));
    ctx.events.on("finance.destination.rejected", (e) => service.onDestinationRejectedFromFinance(e.payload, e.id));
    ctx.events.on("catalog.product.changes_requested", (e) => service.onProductChangesRequestedFromCatalog(e.payload, e.id));
    ctx.events.on("catalog.product.approved", (e) => service.onProductApprovedFromCatalog(e.payload, e.id));
    ctx.events.on("catalog.product.rejected", (e) => service.onProductRejectedFromCatalog(e.payload, e.id));
    ctx.events.on("inventory.stock.low", (e) => service.onStockLowFromInventory(e.payload, e.id));
    ctx.events.on("finance.payout.paid", (e) => service.onPayoutPaidFromFinance(e.payload, e.id));
    ctx.events.on("finance.payout.failed", (e) => service.onPayoutFailedFromFinance(e.payload, e.id));
    ctx.events.on("finance.hold.placed", (e) => service.onHoldPlacedFromFinance(e.payload, e.id));
    ctx.events.on("finance.hold.released", (e) => service.onHoldReleasedFromFinance(e.payload, e.id));
    ctx.events.on("finance.balance.negative", (e) => service.onBalanceNegativeFromFinance(e.payload, e.id));
    ctx.events.on("finance.statement.issued", (e) => service.onStatementIssuedFromFinance(e.payload, e.id));
    ctx.events.on("finance.reconciliation.mismatch_found", (e) => service.onReconciliationMismatchFoundFromFinance(e.payload, e.id));
    ctx.events.on("promotions.participation.invited", (e) => service.onParticipationInvitedFromPromotions(e.payload, e.id));
    ctx.events.on("advertising.campaign.status_changed", (e) => service.onCampaignStatusChangedFromAdvertising(e.payload, e.id));
    ctx.events.on("reviews.invite.due", (e) => service.onInviteDueFromReviews(e.payload, e.id));
    ctx.events.on("reviews.report.created", (e) => service.onReportCreatedFromReviews(e.payload, e.id));
    ctx.events.on("trust.report.created", (e) => service.onReportCreatedFromTrust(e.payload, e.id));
    ctx.events.on("wishlist.alert.triggered", (e) => service.onAlertTriggeredFromWishlist(e.payload, e.id));
    ctx.events.on("access.approval.requested", (e) => service.onApprovalRequestedFromAccess(e.payload, e.id));
    ctx.events.on("access.approval.partially_approved", (e) => service.onApprovalPartiallyApprovedFromAccess(e.payload, e.id));
    ctx.events.on("access.approval.returned", (e) => service.onApprovalReturnedFromAccess(e.payload, e.id));
    ctx.events.on("access.approval.decided", (e) => service.onApprovalDecidedFromAccess(e.payload, e.id));
    ctx.events.on("access.approval.reminder_sent", (e) => service.onApprovalReminderSentFromAccess(e.payload, e.id));
    ctx.events.on("access.coverage.changed", (e) => service.onCoverageChangedFromAccess(e.payload, e.id));
    ctx.events.on("access.away.ended", (e) => service.onAwayEndedFromAccess(e.payload, e.id));
    ctx.events.on("workqueues.item.overdue", (e) => service.onItemOverdueFromWorkqueues(e.payload, e.id));
    ctx.events.on("workqueues.item.escalated", (e) => service.onItemEscalatedFromWorkqueues(e.payload, e.id));
    ctx.events.on("workqueues.item.resolved", (e) => service.onItemResolvedFromWorkqueues(e.payload, e.id));
    ctx.events.on("settings.change.scheduled", (e) => service.onChangeScheduledFromSettings(e.payload, e.id));
    ctx.events.on("audit.integrity.failed", (e) => service.onIntegrityFailedFromAudit(e.payload, e.id));
    ctx.events.on("reports.export.ready", (e) => service.onExportReadyFromReports(e.payload, e.id));
    ctx.events.on("reports.scheduled_report.ready", (e) => service.onScheduledReportReadyFromReports(e.payload, e.id));
    ctx.events.on("purchasing.purchase_order.sent", (e) => service.onPurchaseOrderSentFromPurchasing(e.payload, e.id));
    ctx.events.on("wallet.credit.expiring", (e) => service.onCreditExpiringFromWallet(e.payload, e.id));
    ctx.events.on("workqueues.day_end.prepared", (e) => service.onDayEndPreparedFromWorkqueues(e.payload, e.id));
    ctx.events.on("advertising.campaign.ending_soon", (e) => service.onCampaignEndingSoonFromAdvertising(e.payload, e.id));
    ctx.events.on("content.article.review_due", (e) => service.onArticleReviewDueFromContent(e.payload, e.id));
    ctx.events.on("reviews.moderation.decided", (e) => service.onModerationDecidedFromReviews(e.payload, e.id));
    ctx.events.on("trust.report.resolved", (e) => service.onReportResolvedFromTrust(e.payload, e.id));
    ctx.events.on("trust.rights_report.received", (e) => service.onRightsReportReceivedFromTrust(e.payload, e.id));

    // Background jobs (spec jobs)
    ctx.jobs.handle("notifications.dispatch", () => service.dispatch());
    ctx.jobs.handle("notifications.retry", () => service.retry());
    ctx.jobs.handle("notifications.send-scheduled", () => service.sendScheduled());
    ctx.jobs.handle("notifications.send-broadcasts", () => service.sendBroadcasts());
    ctx.jobs.handle("notifications.staff-digest", () => service.staffDigest());
    ctx.jobs.handle("notifications.purge", () => service.purge());
  },
});
