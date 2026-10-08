import { notImplemented } from '../../kernel/errors/index.js';
import type { EventPayload } from '../../kernel/events/index.js';
import type { ModuleContext } from '../../kernel/module-system/index.js';
import type * as identity from '../../spec/identity.js';
import type { ReportsPublicApi, MetricDefinition, ExportDatasetKey, ExportDataset, ExportJob, AdminDashboard, SellerDashboard } from '../../spec/reports.js';
import type { ReportsRepository } from './ports.js';

export interface ReportsServiceDeps {
  repo: ReportsRepository;
  ctx: ModuleContext<'reports'>;
}

/**
 * Reports use cases. Depends only on ports, the event bus, the clock and other modules' public APIs.
 * Each method maps to a publicApi function, a consumed event or a job in docs/api/spec/modules/reports.json.
 */
export class ReportsService implements ReportsPublicApi {
  constructor(protected readonly deps: ReportsServiceDeps) {}

  /* ---------------- public API (in-process) */

  /** Owner modules register the columns of their datasets at boot. Only keys in the export dataset registry (ExportDatasetKey, setting exportDatasets) are accepted. Rows are read page by page through the owner's own publicApi function exportRows(dataset, filters, principal, cursor); reports runs the job, filters columns by permission and stores the file. */
  async registerDataset(dataset: ExportDataset): Promise<void> {
    throw notImplemented("reports.registerDataset");
  }

  /** Used by other modules' export endpoints; same rules as POST /exports (jsonl only for audit.admin.entries). Their status endpoints read the job back with getExport. */
  async requestExport(input: { dataset: string, filters: unknown, format: 'csv' | 'xlsx' | 'jsonl', principal: identity.Principal, sellerId?: string }): Promise<ExportJob> {
    throw notImplemented("reports.requestExport");
  }

  /** Discovery signals that are not events (anonymous counts only) */
  async recordSignal(signal: { kind: 'product_view' | 'search_no_result' | 'cart_add', productId?: string, offerId?: string, query?: string, sessionKey?: string, at: string }): Promise<void> {
    throw notImplemented("reports.recordSignal");
  }

  /** Published definition text for tooltips in other modules' screens */
  async metric(key: string): Promise<MetricDefinition | null> {
    throw notImplemented("reports.metric");
  }

  /** Admin dashboard figures with definitions (same as GET /api/admin/reports/dashboard) */
  async getAdminDashboard(period: 'today' | 'last_7_days' | 'last_14_days' | 'last_30_days', principal: identity.Principal): Promise<AdminDashboard> {
    throw notImplemented("reports.getAdminDashboard");
  }

  /** The seller's own dashboard figures and work tiles (same as GET /api/seller/reports/dashboard); sellerId always comes from the session */
  async getSellerDashboard(sellerId: string, period: 'today' | 'last_7_days' | 'last_14_days' | 'last_30_days'): Promise<SellerDashboard> {
    throw notImplemented("reports.getSellerDashboard");
  }

  /** One export job for its requester (NOT_FOUND for anyone else); while ready each call signs a fresh download link and records it. The module status endpoints GET …/exports/{id} proxy it. */
  async getExport(id: string, principal: identity.Principal): Promise<ExportJob> {
    throw notImplemented("reports.getExport");
  }

  /** Export jobs for one dataset, newest first: the principal's own, or every requester's when allRequesters is set (the calling module checks its own permission first). Used by the audit export list. */
  async listExports(filter: { dataset: string, state?: string, allRequesters?: boolean }, principal: identity.Principal, cursor?: string): Promise<{ items: ExportJob[], nextCursor?: string }> {
    throw notImplemented("reports.listExports");
  }

  /* ---------------- events consumed */

  /** orders.order.placed: fact_order_items rows with placement date; fact_customers */
  async onOrderPlacedFromOrders(event: EventPayload<"orders.order.placed">): Promise<void> {
    throw notImplemented("reports consumer of orders.order.placed");
  }

  /** orders.order.accepted: Mark items accepted (orders count from acceptance) */
  async onOrderAcceptedFromOrders(event: EventPayload<"orders.order.accepted">): Promise<void> {
    throw notImplemented("reports consumer of orders.order.accepted");
  }

  /** payments.payment.captured: Payment date basis */
  async onPaymentCapturedFromPayments(event: EventPayload<"payments.payment.captured">): Promise<void> {
    throw notImplemented("reports consumer of payments.payment.captured");
  }

  /** shipping.shipment.dispatched: Shipment date basis; on-time dispatch in fact_service_daily */
  async onShipmentDispatchedFromShipping(event: EventPayload<"shipping.shipment.dispatched">): Promise<void> {
    throw notImplemented("reports consumer of shipping.shipment.dispatched");
  }

  /** shipping.dispatch.overdue: Overdue counts in fact_service_daily */
  async onDispatchOverdueFromShipping(event: EventPayload<"shipping.dispatch.overdue">): Promise<void> {
    throw notImplemented("reports consumer of shipping.dispatch.overdue");
  }

  /** shipping.shipment.exception: Delivery issues */
  async onShipmentExceptionFromShipping(event: EventPayload<"shipping.shipment.exception">): Promise<void> {
    throw notImplemented("reports consumer of shipping.shipment.exception");
  }

  /** orders.item.delivered: Delivered date */
  async onItemDeliveredFromOrders(event: EventPayload<"orders.item.delivered">): Promise<void> {
    throw notImplemented("reports consumer of orders.item.delivered");
  }

  /** orders.order.completed: Completion date basis */
  async onOrderCompletedFromOrders(event: EventPayload<"orders.order.completed">): Promise<void> {
    throw notImplemented("reports consumer of orders.order.completed");
  }

  /** orders.item.cancelled: Cancellations (by customer or seller) and cancelled amounts */
  async onItemCancelledFromOrders(event: EventPayload<"orders.item.cancelled">): Promise<void> {
    throw notImplemented("reports consumer of orders.item.cancelled");
  }

  /** payments.refund.sent: Refunds sent (refund date and amount); 'approved' refunds are never counted as sent */
  async onRefundSentFromPayments(event: EventPayload<"payments.refund.sent">): Promise<void> {
    throw notImplemented("reports consumer of payments.refund.sent");
  }

  /** returns.return.requested: fact_returns with reason */
  async onReturnRequestedFromReturns(event: EventPayload<"returns.return.requested">): Promise<void> {
    throw notImplemented("reports consumer of returns.return.requested");
  }

  /** returns.return.inspected: Return outcome */
  async onReturnInspectedFromReturns(event: EventPayload<"returns.return.inspected">): Promise<void> {
    throw notImplemented("reports consumer of returns.return.inspected");
  }

  /** inventory.stock.changed: Stockout minutes per product */
  async onStockChangedFromInventory(event: EventPayload<"inventory.stock.changed">): Promise<void> {
    throw notImplemented("reports consumer of inventory.stock.changed");
  }

  /** cart.item.added: Cart additions per product */
  async onItemAddedFromCart(event: EventPayload<"cart.item.added">): Promise<void> {
    throw notImplemented("reports consumer of cart.item.added");
  }

  /** messaging.message.sent: Response time per seller */
  async onMessageSentFromMessaging(event: EventPayload<"messaging.message.sent">): Promise<void> {
    throw notImplemented("reports consumer of messaging.message.sent");
  }

  /** support.case.opened: Case backlog and complaint patterns */
  async onCaseOpenedFromSupport(event: EventPayload<"support.case.opened">): Promise<void> {
    throw notImplemented("reports consumer of support.case.opened");
  }

  /** support.case.resolved: Case backlog */
  async onCaseResolvedFromSupport(event: EventPayload<"support.case.resolved">): Promise<void> {
    throw notImplemented("reports consumer of support.case.resolved");
  }

  /** finance.payout.paid: Completed payouts */
  async onPayoutPaidFromFinance(event: EventPayload<"finance.payout.paid">): Promise<void> {
    throw notImplemented("reports consumer of finance.payout.paid");
  }

  /** finance.payout.failed: Failed payouts */
  async onPayoutFailedFromFinance(event: EventPayload<"finance.payout.failed">): Promise<void> {
    throw notImplemented("reports consumer of finance.payout.failed");
  }

  /** finance.hold.placed: Held amounts */
  async onHoldPlacedFromFinance(event: EventPayload<"finance.hold.placed">): Promise<void> {
    throw notImplemented("reports consumer of finance.hold.placed");
  }

  /** finance.hold.released: Held amounts */
  async onHoldReleasedFromFinance(event: EventPayload<"finance.hold.released">): Promise<void> {
    throw notImplemented("reports consumer of finance.hold.released");
  }

  /** finance.amount_owed.created: Amounts owed by sellers */
  async onAmountOwedCreatedFromFinance(event: EventPayload<"finance.amount_owed.created">): Promise<void> {
    throw notImplemented("reports consumer of finance.amount_owed.created");
  }

  /** promotions.coupon.redeemed: Campaign sales, discount cost and funding owner */
  async onCouponRedeemedFromPromotions(event: EventPayload<"promotions.coupon.redeemed">): Promise<void> {
    throw notImplemented("reports consumer of promotions.coupon.redeemed");
  }

  /** promotions.redemption.reversed: Reverse discount cost on cancellation */
  async onRedemptionReversedFromPromotions(event: EventPayload<"promotions.redemption.reversed">): Promise<void> {
    throw notImplemented("reports consumer of promotions.redemption.reversed");
  }

  /** advertising.charge.posted: Ad spending per campaign and seller */
  async onChargePostedFromAdvertising(event: EventPayload<"advertising.charge.posted">): Promise<void> {
    throw notImplemented("reports consumer of advertising.charge.posted");
  }

  /** advertising.charge.credited: Ad credits */
  async onChargeCreditedFromAdvertising(event: EventPayload<"advertising.charge.credited">): Promise<void> {
    throw notImplemented("reports consumer of advertising.charge.credited");
  }

  /* ---------------- jobs */

  /** Job reports.run-exports (every 1 min): Run queued export jobs in batches: call the owner module's exportRows(dataset, filters, principal, cursor) until nextCursor is empty (report results come from runReport), drop columns the requester may not see, write the file to media; publish reports.export.ready */
  async runExports(): Promise<void> {
    throw notImplemented("job reports.run-exports");
  }

  /** Job reports.expire-exports (hourly): Expire ready exports after exportLinkHours and delete files */
  async expireExports(): Promise<void> {
    throw notImplemented("job reports.expire-exports");
  }

  /** Job reports.pull-daily (daily 02:30 market time): Pull figures that have no event: search.zeroResultStats (unavailable searches), finance fee income per seller and day (finance.marketplaceIncomeByDay), advertising displays/clicks/dismissals and attributed purchases (advertising.dailyPerformance), inventory unit costs for Official Store items */
  async pullDaily(): Promise<void> {
    throw notImplemented("job reports.pull-daily");
  }

  /** Job reports.run-schedules (every 15 min): Phase 2: send scheduled report emails */
  async runSchedules(): Promise<void> {
    throw notImplemented("job reports.run-schedules");
  }

  /** Job reports.check-lag (every 5 min): Mark read models stale when their lag exceeds readModelMaxLagMinutes */
  async checkLag(): Promise<void> {
    throw notImplemented("job reports.check-lag");
  }
}
