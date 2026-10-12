import { defineModule } from '../../kernel/module-system/index.js';
import { spec } from '../../spec/workqueues.js';
import { resolvers } from './graphql/resolvers.js';
import { typeDefs } from './graphql/schema.js';
import { sellerRoutes } from './http/seller.js';
import { adminRoutes } from './http/admin.js';
import { createMongoWorkqueuesRepository } from './infra/mongo/repository.js';
import { WorkqueuesService } from './service.js';
import { schemas } from './infra/mongo/schema.js';

/**
 * Work queues: The Operations Center's shared to-do system: queue definitions with an owner role, a named lead, a backup and an escalation route, and work items raised from other modules' events (overdue dispatch, low stock, waiting approvals, cases past target, failed payouts, mismatches) with deadlines, assignment and automatic escalation. Also the My work queues view, the dashboard's needs-attention tiles, the day-end review, the daily routine and saved filters.
 *
 * Name, launch phase, dependencies, permissions, events, jobs, settings and endpoints come from
 * docs/api/spec/modules/workqueues.json through `spec`; the server refuses to start if they drift.
 */
export default defineModule({
  spec,
  version: '2.0.0',
  schemas,
  graphql: typeDefs,
  register(ctx) {
    const service = new WorkqueuesService({ repo: createMongoWorkqueuesRepository(ctx.mongo), ctx });
    ctx.provide(service);
    ctx.http.routes(sellerRoutes(service), adminRoutes(service));
    ctx.graphql.resolvers(resolvers(service));
    // install seed (queues, intake rules, daily routine) and the reports export dataset, once every module is up
    ctx.afterBoot(() => service.boot());

    // Events this module reacts to (spec events.consumes)
    ctx.events.on("shipping.dispatch.overdue", (e) => service.onDispatchOverdueFromShipping(e.payload));
    ctx.events.on("shipping.shipment.dispatched", (e) => service.onShipmentDispatchedFromShipping(e.payload));
    ctx.events.on("shipping.shipment.exception", (e) => service.onShipmentExceptionFromShipping(e.payload));
    ctx.events.on("shipping.shipment.delivered", (e) => service.onShipmentDeliveredFromShipping(e.payload));
    ctx.events.on("orders.item.cancelled", (e) => service.onItemCancelledFromOrders(e.payload));
    ctx.events.on("inventory.stock.low", (e) => service.onStockLowFromInventory(e.payload));
    ctx.events.on("inventory.stock.changed", (e) => service.onStockChangedFromInventory(e.payload));
    ctx.events.on("access.approval.requested", (e) => service.onApprovalRequestedFromAccess(e.payload));
    ctx.events.on("access.approval.decided", (e) => service.onApprovalDecidedFromAccess(e.payload));
    ctx.events.on("access.away.started", (e) => service.onAwayStartedFromAccess(e.payload));
    ctx.events.on("access.away.ended", (e) => service.onAwayEndedFromAccess(e.payload));
    ctx.events.on("access.coverage.changed", (e) => service.onCoverageChangedFromAccess(e.payload));
    ctx.events.on("support.case.overdue", (e) => service.onCaseOverdueFromSupport(e.payload));
    ctx.events.on("support.case.escalated", (e) => service.onCaseEscalatedFromSupport(e.payload));
    ctx.events.on("support.case.resolved", (e) => service.onCaseResolvedFromSupport(e.payload));
    ctx.events.on("returns.return.escalated", (e) => service.onReturnEscalatedFromReturns(e.payload));
    ctx.events.on("returns.refund.approved", (e) => service.onRefundApprovedFromReturns(e.payload));
    ctx.events.on("finance.payout.failed", (e) => service.onPayoutFailedFromFinance(e.payload));
    ctx.events.on("finance.payout.paid", (e) => service.onPayoutPaidFromFinance(e.payload));
    ctx.events.on("finance.reconciliation.mismatch_found", (e) => service.onReconciliationMismatchFoundFromFinance(e.payload));
    ctx.events.on("payments.payment.pending_check", (e) => service.onPaymentPendingCheckFromPayments(e.payload));
    ctx.events.on("payments.payment.captured", (e) => service.onPaymentCapturedFromPayments(e.payload));
    ctx.events.on("payments.payment.failed", (e) => service.onPaymentFailedFromPayments(e.payload));
    ctx.events.on("payments.chargeback.opened", (e) => service.onChargebackOpenedFromPayments(e.payload));
    ctx.events.on("catalog.product.submitted", (e) => service.onProductSubmittedFromCatalog(e.payload));
    ctx.events.on("catalog.product.approved", (e) => service.onProductApprovedFromCatalog(e.payload));
    ctx.events.on("catalog.product.changes_requested", (e) => service.onProductChangesRequestedFromCatalog(e.payload));
    ctx.events.on("catalog.product.rejected", (e) => service.onProductRejectedFromCatalog(e.payload));
    ctx.events.on("sellers.application.submitted", (e) => service.onApplicationSubmittedFromSellers(e.payload));
    ctx.events.on("sellers.application.information_provided", (e) => service.onApplicationInformationProvidedFromSellers(e.payload));
    ctx.events.on("sellers.application.decided", (e) => service.onApplicationDecidedFromSellers(e.payload));
    ctx.events.on("sellers.launch_review.requested", (e) => service.onLaunchReviewRequestedFromSellers(e.payload));
    ctx.events.on("sellers.launch_review.decided", (e) => service.onLaunchReviewDecidedFromSellers(e.payload));
    ctx.events.on("sellers.appeal.submitted", (e) => service.onAppealSubmittedFromSellers(e.payload));
    ctx.events.on("sellers.appeal.decided", (e) => service.onAppealDecidedFromSellers(e.payload));
    ctx.events.on("sellers.restriction.evidence_submitted", (e) => service.onRestrictionEvidenceSubmittedFromSellers(e.payload));
    ctx.events.on("sellers.performance.below_target", (e) => service.onPerformanceBelowTargetFromSellers(e.payload));
    ctx.events.on("sellers.change_request.submitted", (e) => service.onChangeRequestSubmittedFromSellers(e.payload));
    ctx.events.on("sellers.change_request.decided", (e) => service.onChangeRequestDecidedFromSellers(e.payload));
    ctx.events.on("trust.report.created", (e) => service.onReportCreatedFromTrust(e.payload));
    ctx.events.on("trust.report.resolved", (e) => service.onReportResolvedFromTrust(e.payload));
    ctx.events.on("trust.recommendation.routed", (e) => service.onRecommendationRoutedFromTrust(e.payload));
    ctx.events.on("trust.recommendation.decided", (e) => service.onRecommendationDecidedFromTrust(e.payload));
    ctx.events.on("messaging.reply.overdue", (e) => service.onReplyOverdueFromMessaging(e.payload));
    ctx.events.on("messaging.message.sent", (e) => service.onMessageSentFromMessaging(e.payload));
    ctx.events.on("customers.data_export.requested", (e) => service.onDataExportRequestedFromCustomers(e.payload));
    ctx.events.on("customers.data_export.ready", (e) => service.onDataExportReadyFromCustomers(e.payload));
    ctx.events.on("finance.reconciliation.item_closed", (e) => service.onReconciliationItemClosedFromFinance(e.payload));
    ctx.events.on("payments.payment.authorized", (e) => service.onPaymentAuthorizedFromPayments(e.payload));
    ctx.events.on("payments.chargeback.decided", (e) => service.onChargebackDecidedFromPayments(e.payload));
    ctx.events.on("sellers.restriction.lifted", (e) => service.onRestrictionLiftedFromSellers(e.payload));
    ctx.events.on("sellers.restriction.updated", (e) => service.onRestrictionUpdatedFromSellers(e.payload));
    ctx.events.on("warehouse.return_parcel.received", (e) => service.onReturnParcelReceivedFromWarehouse(e.payload));
    ctx.events.on("reviews.moderation.decided", (e) => service.onModerationDecidedFromReviews(e.payload, e.id));

    // Background jobs (spec jobs)
    ctx.jobs.handle("workqueues.deadline-sweep", () => service.deadlineSweep());
    ctx.jobs.handle("workqueues.routine-generate", () => service.routineGenerate());
    ctx.jobs.handle("workqueues.routine-late", () => service.routineLate());
    ctx.jobs.handle("workqueues.day-end-prepare", () => service.dayEndPrepare());
    ctx.jobs.handle("workqueues.day-end-close", () => service.dayEndClose());
    ctx.jobs.handle("workqueues.archive", () => service.archive());
  },
});
