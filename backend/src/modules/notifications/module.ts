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

/**
 * Notifications: Who is told what, on which channel: notification topics for customers, sellers and staff, routing from platform events to recipients (staff by role, with backups), templates with versions and preview, in-app inboxes for the store, Seller Center and Admin Center, email delivery with retries and suppression, seller and staff channel preferences, promotional broadcasts under consent, and Android push devices (phase 3).
 *
 * Name, launch phase, dependencies, permissions, events, jobs, settings and endpoints come from
 * docs/api/spec/modules/notifications.json through `spec`; the server refuses to start if they drift.
 */
export default defineModule({
  spec,
  version: '0.1.0',
  migrations,
  graphql: typeDefs,
  register(ctx) {
    const repo = createPostgresNotificationsRepository(ctx.db);
    const service = new NotificationsService({ repo, ctx });
    ctx.provide(service);
    ctx.http.routes(storeRoutes(service), sellerRoutes(service), adminRoutes(service), webhooksRoutes(service));
    ctx.graphql.resolvers(resolvers(service));

    // Events this module reacts to (spec events.consumes)
    ctx.events.on("identity.verification.code_issued", (e) => service.onVerificationCodeIssuedFromIdentity(e.payload));
    ctx.events.on("identity.password_reset.requested", (e) => service.onPasswordResetRequestedFromIdentity(e.payload));
    ctx.events.on("identity.password.changed", (e) => service.onPasswordChangedFromIdentity(e.payload));
    ctx.events.on("identity.session.new_device", (e) => service.onSessionNewDeviceFromIdentity(e.payload));
    ctx.events.on("identity.email.changed", (e) => service.onEmailChangedFromIdentity(e.payload));
    ctx.events.on("identity.two_step.changed", (e) => service.onTwoStepChangedFromIdentity(e.payload));
    ctx.events.on("identity.account.locked", (e) => service.onAccountLockedFromIdentity(e.payload));
    ctx.events.on("identity.invitation.created", (e) => service.onInvitationCreatedFromIdentity(e.payload));
    ctx.events.on("identity.user.verified", (e) => service.onUserVerifiedFromIdentity(e.payload));
    ctx.events.on("customers.marketing_preferences.changed", (e) => service.onMarketingPreferencesChangedFromCustomers(e.payload));
    ctx.events.on("customers.account.closed", (e) => service.onAccountClosedFromCustomers(e.payload));
    ctx.events.on("customers.data_export.ready", (e) => service.onDataExportReadyFromCustomers(e.payload));
    ctx.events.on("orders.order.accepted", (e) => service.onOrderAcceptedFromOrders(e.payload));
    ctx.events.on("orders.item.cancelled", (e) => service.onItemCancelledFromOrders(e.payload));
    ctx.events.on("orders.item.delayed", (e) => service.onItemDelayedFromOrders(e.payload));
    ctx.events.on("orders.cancellation.decided", (e) => service.onCancellationDecidedFromOrders(e.payload));
    ctx.events.on("payments.payment.captured", (e) => service.onPaymentCapturedFromPayments(e.payload));
    ctx.events.on("payments.payment.failed", (e) => service.onPaymentFailedFromPayments(e.payload));
    ctx.events.on("payments.payment.pending_check", (e) => service.onPaymentPendingCheckFromPayments(e.payload));
    ctx.events.on("payments.refund.sent", (e) => service.onRefundSentFromPayments(e.payload));
    ctx.events.on("payments.refund.failed", (e) => service.onRefundFailedFromPayments(e.payload));
    ctx.events.on("payments.chargeback.opened", (e) => service.onChargebackOpenedFromPayments(e.payload));
    ctx.events.on("shipping.shipment.dispatched", (e) => service.onShipmentDispatchedFromShipping(e.payload));
    ctx.events.on("shipping.shipment.delivered", (e) => service.onShipmentDeliveredFromShipping(e.payload));
    ctx.events.on("shipping.shipment.exception", (e) => service.onShipmentExceptionFromShipping(e.payload));
    ctx.events.on("shipping.dispatch.overdue", (e) => service.onDispatchOverdueFromShipping(e.payload));
    ctx.events.on("returns.return.requested", (e) => service.onReturnRequestedFromReturns(e.payload));
    ctx.events.on("returns.return.info_requested", (e) => service.onReturnInfoRequestedFromReturns(e.payload));
    ctx.events.on("returns.return.approved", (e) => service.onReturnApprovedFromReturns(e.payload));
    ctx.events.on("returns.return.rejected", (e) => service.onReturnRejectedFromReturns(e.payload));
    ctx.events.on("returns.label.created", (e) => service.onLabelCreatedFromReturns(e.payload));
    ctx.events.on("returns.return.received", (e) => service.onReturnReceivedFromReturns(e.payload));
    ctx.events.on("returns.return.inspected", (e) => service.onReturnInspectedFromReturns(e.payload));
    ctx.events.on("returns.return.escalated", (e) => service.onReturnEscalatedFromReturns(e.payload));
    ctx.events.on("returns.refund.approved", (e) => service.onRefundApprovedFromReturns(e.payload));
    ctx.events.on("returns.replacement.created", (e) => service.onReplacementCreatedFromReturns(e.payload));
    ctx.events.on("support.case.opened", (e) => service.onCaseOpenedFromSupport(e.payload));
    ctx.events.on("support.case.message_added", (e) => service.onCaseMessageAddedFromSupport(e.payload));
    ctx.events.on("support.case.escalated", (e) => service.onCaseEscalatedFromSupport(e.payload));
    ctx.events.on("support.case.overdue", (e) => service.onCaseOverdueFromSupport(e.payload));
    ctx.events.on("support.case.decided", (e) => service.onCaseDecidedFromSupport(e.payload));
    ctx.events.on("support.case.resolved", (e) => service.onCaseResolvedFromSupport(e.payload));
    ctx.events.on("messaging.message.sent", (e) => service.onMessageSentFromMessaging(e.payload));
    ctx.events.on("sellers.application.submitted", (e) => service.onApplicationSubmittedFromSellers(e.payload));
    ctx.events.on("sellers.application.information_requested", (e) => service.onApplicationInformationRequestedFromSellers(e.payload));
    ctx.events.on("sellers.application.decided", (e) => service.onApplicationDecidedFromSellers(e.payload));
    ctx.events.on("sellers.seller.restricted", (e) => service.onSellerRestrictedFromSellers(e.payload));
    ctx.events.on("sellers.seller.suspended", (e) => service.onSellerSuspendedFromSellers(e.payload));
    ctx.events.on("sellers.seller.reinstated", (e) => service.onSellerReinstatedFromSellers(e.payload));
    ctx.events.on("sellers.warning.issued", (e) => service.onWarningIssuedFromSellers(e.payload));
    ctx.events.on("sellers.appeal.decided", (e) => service.onAppealDecidedFromSellers(e.payload));
    ctx.events.on("sellers.payout_account.changed", (e) => service.onPayoutAccountChangedFromSellers(e.payload));
    ctx.events.on("sellers.change_request.decided", (e) => service.onChangeRequestDecidedFromSellers(e.payload));
    ctx.events.on("sellers.verification.changed", (e) => service.onVerificationChangedFromSellers(e.payload));
    ctx.events.on("sellers.launch_review.decided", (e) => service.onLaunchReviewDecidedFromSellers(e.payload));
    ctx.events.on("finance.destination.verified", (e) => service.onDestinationVerifiedFromFinance(e.payload));
    ctx.events.on("finance.destination.rejected", (e) => service.onDestinationRejectedFromFinance(e.payload));
    ctx.events.on("catalog.product.changes_requested", (e) => service.onProductChangesRequestedFromCatalog(e.payload));
    ctx.events.on("catalog.product.approved", (e) => service.onProductApprovedFromCatalog(e.payload));
    ctx.events.on("catalog.product.rejected", (e) => service.onProductRejectedFromCatalog(e.payload));
    ctx.events.on("inventory.stock.low", (e) => service.onStockLowFromInventory(e.payload));
    ctx.events.on("finance.payout.paid", (e) => service.onPayoutPaidFromFinance(e.payload));
    ctx.events.on("finance.payout.failed", (e) => service.onPayoutFailedFromFinance(e.payload));
    ctx.events.on("finance.hold.placed", (e) => service.onHoldPlacedFromFinance(e.payload));
    ctx.events.on("finance.hold.released", (e) => service.onHoldReleasedFromFinance(e.payload));
    ctx.events.on("finance.balance.negative", (e) => service.onBalanceNegativeFromFinance(e.payload));
    ctx.events.on("finance.statement.issued", (e) => service.onStatementIssuedFromFinance(e.payload));
    ctx.events.on("finance.reconciliation.mismatch_found", (e) => service.onReconciliationMismatchFoundFromFinance(e.payload));
    ctx.events.on("promotions.participation.invited", (e) => service.onParticipationInvitedFromPromotions(e.payload));
    ctx.events.on("advertising.campaign.status_changed", (e) => service.onCampaignStatusChangedFromAdvertising(e.payload));
    ctx.events.on("reviews.invite.due", (e) => service.onInviteDueFromReviews(e.payload));
    ctx.events.on("reviews.report.created", (e) => service.onReportCreatedFromReviews(e.payload));
    ctx.events.on("trust.report.created", (e) => service.onReportCreatedFromTrust(e.payload));
    ctx.events.on("wishlist.alert.triggered", (e) => service.onAlertTriggeredFromWishlist(e.payload));
    ctx.events.on("access.approval.requested", (e) => service.onApprovalRequestedFromAccess(e.payload));
    ctx.events.on("access.approval.partially_approved", (e) => service.onApprovalPartiallyApprovedFromAccess(e.payload));
    ctx.events.on("access.approval.returned", (e) => service.onApprovalReturnedFromAccess(e.payload));
    ctx.events.on("access.approval.decided", (e) => service.onApprovalDecidedFromAccess(e.payload));
    ctx.events.on("access.approval.reminder_sent", (e) => service.onApprovalReminderSentFromAccess(e.payload));
    ctx.events.on("access.coverage.changed", (e) => service.onCoverageChangedFromAccess(e.payload));
    ctx.events.on("access.away.ended", (e) => service.onAwayEndedFromAccess(e.payload));
    ctx.events.on("workqueues.item.overdue", (e) => service.onItemOverdueFromWorkqueues(e.payload));
    ctx.events.on("workqueues.item.escalated", (e) => service.onItemEscalatedFromWorkqueues(e.payload));
    ctx.events.on("workqueues.item.resolved", (e) => service.onItemResolvedFromWorkqueues(e.payload));
    ctx.events.on("settings.change.scheduled", (e) => service.onChangeScheduledFromSettings(e.payload));
    ctx.events.on("audit.integrity.failed", (e) => service.onIntegrityFailedFromAudit(e.payload));
    ctx.events.on("reports.export.ready", (e) => service.onExportReadyFromReports(e.payload));

    // Background jobs (spec jobs)
    ctx.jobs.handle("notifications.dispatch", () => service.dispatch());
    ctx.jobs.handle("notifications.retry", () => service.retry());
    ctx.jobs.handle("notifications.send-scheduled", () => service.sendScheduled());
    ctx.jobs.handle("notifications.send-broadcasts", () => service.sendBroadcasts());
    ctx.jobs.handle("notifications.staff-digest", () => service.staffDigest());
    ctx.jobs.handle("notifications.purge", () => service.purge());
  },
});
