import { defineModule } from '../../kernel/module-system/index.js';
import { spec } from '../../spec/finance.js';
import { resolvers } from './graphql/resolvers.js';
import { typeDefs } from './graphql/schema.js';
import { sellerRoutes } from './http/seller.js';
import { adminRoutes } from './http/admin.js';
import { publicRoutes } from './http/public.js';
import { webhooksRoutes } from './http/webhooks.js';
import { migrations } from './infra/postgres/migrations/index.js';
import { createPostgresFinanceRepository } from './infra/postgres/repository.js';
import { FinanceService } from './service.js';

/**
 * Finance: Seller money and company money kept apart: the seller ledger (proceeds, pending, available, held, negative and amounts owed), fee rules, holds, adjustments, payout runs and payouts, statements, payout-destination verification, daily reconciliation checks, and company trading margins separate from marketplace fee income.
 *
 * Name, launch phase, dependencies, permissions, events, jobs, settings and endpoints come from
 * docs/api/spec/modules/finance.json through `spec`; the server refuses to start if they drift.
 */
export default defineModule({
  spec,
  version: '0.1.0',
  migrations,
  graphql: typeDefs,
  register(ctx) {
    const service = new FinanceService({ repo: createPostgresFinanceRepository(ctx.db), ctx });
    ctx.provide(service);
    ctx.http.routes(sellerRoutes(service), adminRoutes(service), publicRoutes(service), webhooksRoutes(service));
    ctx.graphql.resolvers(resolvers(service));

    // Events this module reacts to (spec events.consumes)
    ctx.events.on("orders.order.accepted", (e) => service.onOrderAcceptedFromOrders(e.payload));
    ctx.events.on("orders.item.cancelled", (e) => service.onItemCancelledFromOrders(e.payload));
    ctx.events.on("orders.item.delivered", (e) => service.onItemDeliveredFromOrders(e.payload));
    ctx.events.on("payments.payment.captured", (e) => service.onPaymentCapturedFromPayments(e.payload));
    ctx.events.on("returns.refund.approved", (e) => service.onRefundApprovedFromReturns(e.payload));
    ctx.events.on("payments.refund.sent", (e) => service.onRefundSentFromPayments(e.payload));
    ctx.events.on("payments.chargeback.opened", (e) => service.onChargebackOpenedFromPayments(e.payload));
    ctx.events.on("payments.chargeback.decided", (e) => service.onChargebackDecidedFromPayments(e.payload));
    ctx.events.on("returns.label.created", (e) => service.onLabelCreatedFromReturns(e.payload));
    ctx.events.on("shipping.label.purchased", (e) => service.onLabelPurchasedFromShipping(e.payload));
    ctx.events.on("shipping.label.voided", (e) => service.onLabelVoidedFromShipping(e.payload));
    ctx.events.on("shipping.claim.status_changed", (e) => service.onClaimStatusChangedFromShipping(e.payload));
    ctx.events.on("promotions.coupon.redeemed", (e) => service.onCouponRedeemedFromPromotions(e.payload));
    ctx.events.on("sellers.seller.approved", (e) => service.onSellerApprovedFromSellers(e.payload));
    ctx.events.on("sellers.seller.suspended", (e) => service.onSellerSuspendedFromSellers(e.payload));
    ctx.events.on("sellers.seller.closed", (e) => service.onSellerClosedFromSellers(e.payload));
    ctx.events.on("sellers.payout_account.changed", (e) => service.onPayoutAccountChangedFromSellers(e.payload));
    ctx.events.on("access.approval.decided", (e) => service.onApprovalDecidedFromAccess(e.payload));
    ctx.events.on("support.case.decided", (e) => service.onCaseDecidedFromSupport(e.payload));
    ctx.events.on("wallet.credit.granted", (e) => service.onCreditGrantedFromWallet(e.payload));
    ctx.events.on("wallet.credit.used", (e) => service.onCreditUsedFromWallet(e.payload));

    // Background jobs (spec jobs)
    ctx.jobs.handle("finance.release-pending", () => service.releasePending());
    ctx.jobs.handle("finance.payout-run.create", () => service.payoutRunCreate());
    ctx.jobs.handle("finance.payout-run.release", () => service.payoutRunRelease());
    ctx.jobs.handle("finance.payout-status.poll", () => service.payoutStatusPoll());
    ctx.jobs.handle("finance.reconcile.daily", () => service.reconcileDaily());
    ctx.jobs.handle("finance.holds.review-due", () => service.holdsReviewDue());
    ctx.jobs.handle("finance.negative-balance.age", () => service.negativeBalanceAge());
    ctx.jobs.handle("finance.fee-rules.activate", () => service.feeRulesActivate());
  },
});
