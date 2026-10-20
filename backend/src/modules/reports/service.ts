import { actorOfPrincipal } from '../../kernel/auth/index.js';
import { stringList } from '../../kernel/lib/text.js';
import type { EventPayload } from '../../kernel/events/index.js';
import { newId } from '../../kernel/lib/ids.js';
import type * as common from '../../spec/common.js';
import type * as identity from '../../spec/identity.js';
import type { AdminDashboard, ExportDataset, ExportJob, MetricDefinition, ReportQuery, ReportResult, ReportsPublicApi, SellerDashboard } from '../../spec/reports.js';
import { nextRun, periodLabel } from './domain/rules.js';

import { ReportsCore, SYSTEM, type Caller, type ReportsServiceDeps } from './service/core.js';
import { Definitions, staffId } from './service/definitions.js';
import { Exports, REPORT_DATASET } from './service/exports.js';
import { Queries, type Period, type ReportScope } from './service/queries.js';
import { ReadModels, type Env } from './service/readmodels.js';

export type { ReportsServiceDeps, Caller };


/** Events delivered straight to a consumer (tests) get an envelope of their own */
const envOf = (e?: Partial<Env>): Env => ({ id: e?.id ?? newId(), at: e?.at ?? new Date().toISOString() });

/**
 * Reports use cases. Depends only on its repository, the event bus, the clock and other modules' public APIs.
 * Each method maps to a publicApi function, a consumed event or a job in docs/api/spec/modules/reports.json.
 */
export class ReportsService implements ReportsPublicApi {
  readonly core: ReportsCore;
  readonly defs: Definitions;
  readonly queries: Queries;
  readonly exports: Exports;
  readonly readModels: ReadModels;

  constructor(protected readonly deps: ReportsServiceDeps) {
    this.core = new ReportsCore(deps);
    this.defs = new Definitions(this.core);
    this.queries = new Queries(this.core, this.defs);
    this.exports = new Exports(this.core, this.defs, this.queries);
    this.readModels = new ReadModels(this.core);
  }

  /** At boot: the report library, metric definitions and the export registry (idempotent) */
  async seed() {
    await this.defs.seed();
    await this.exports.seedRegistry();
  }

  private env(e?: Partial<Env>): Env {
    return e?.id && e.at ? { id: e.id, at: e.at } : { ...envOf(e), at: e?.at ?? this.core.now().toISOString() };
  }

  /* ---------------------------------------------------------------- reports (REST) */

  async runReport(key: string, query: ReportQuery | null | undefined, by: Caller): Promise<ReportResult> {
    const report = await this.defs.staffReport(key, by);
    const rq = await this.queries.resolve(query);
    return this.queries.run(report, rq, { kind: 'platform' });
  }

  async runSellerReport(key: string, query: ReportQuery | null | undefined, sellerId: string): Promise<ReportResult> {
    const report = await this.defs.sellerReport(key);
    const rq = await this.queries.resolve(query, { seller: true });
    return this.queries.run(report, rq, { kind: 'seller', sellerId } satisfies ReportScope);
  }

  async createSavedView(body: { reportKey: string; name: string; query: ReportQuery; shared?: boolean | null }, by: Caller) {
    return this.defs.createSavedView(body, by, (q) => this.queries.resolve(q));
  }

  /* ---------------------------------------------------------------- public API (in-process) */

  /** Owner modules register the columns of their datasets at boot. Only keys in the export dataset registry (ExportDatasetKey, setting exportDatasets) are accepted. Rows are read page by page through the owner's own publicApi function exportRows(dataset, filters, principal, cursor); reports runs the job, filters columns by permission and stores the file. */
  async registerDataset(dataset: ExportDataset): Promise<void> {
    return this.exports.registerDataset(dataset);
  }

  /** Used by other modules' export endpoints; same rules as POST /exports (jsonl only for audit.admin.entries). Their status endpoints read the job back with getExport. */
  async requestExport(input: { dataset: string; filters: unknown; format: 'csv' | 'xlsx' | 'jsonl'; principal: identity.Principal; sellerId?: string }): Promise<ExportJob> {
    return this.exports.request({ dataset: input.dataset, filters: input.filters, format: input.format, sellerId: input.sellerId ?? null }, { principal: input.principal, actor: actorOfPrincipal(input.principal) }, 'api');
  }

  /** Discovery signals that are not events (anonymous counts only) */
  async recordSignal(signal: { kind: 'product_view' | 'search_no_result' | 'cart_add'; productId?: string; offerId?: string; query?: string; sessionKey?: string; at: string }): Promise<void> {
    return this.readModels.recordSignal(signal);
  }

  /** Published definition text for tooltips in other modules' screens */
  async metric(key: string): Promise<MetricDefinition | null> {
    return this.defs.metric(key);
  }

  /** Official Store gross margin for a range of market days, by order placement date (promotions: before and during a campaign range) */
  async officialMargin(range: common.DateRange): Promise<{ sales: common.Money; costedSales: common.Money; cost: common.Money; marginPct: number | null }> {
    return this.queries.officialMargin(range);
  }

  /** Store-wide return rate for a range of market days (units asked to return ÷ units sold, in percent) */
  async storeReturnRate(range: common.DateRange): Promise<{ returnedUnits: number; soldUnits: number; returnRatePct: number | null }> {
    return this.queries.storeReturnRate(range);
  }

  /** Admin dashboard figures with definitions (same as GET /api/admin/reports/dashboard) */
  async getAdminDashboard(period: 'today' | 'last_7_days' | 'last_14_days' | 'last_30_days', _principal: identity.Principal): Promise<AdminDashboard> {
    return this.queries.toAdminDashboard(await this.queries.adminDashboard(period));
  }

  /** The seller's own dashboard figures and work tiles (same as GET /api/seller/reports/dashboard); sellerId always comes from the session */
  async getSellerDashboard(sellerId: string, period: 'today' | 'last_7_days' | 'last_14_days' | 'last_30_days', opts: { canViewFinance?: boolean; canViewServiceFees?: boolean } = {}): Promise<SellerDashboard> {
    return this.queries.toSellerDashboard(await this.queries.sellerDashboard(sellerId, period as Period, opts));
  }

  /** One export job for its requester (NOT_FOUND for anyone else); while ready each call signs a fresh download link and records it. The module status endpoints GET …/exports/{id} proxy it. */
  async getExport(id: string, principal: identity.Principal): Promise<ExportJob> {
    return this.exports.get(id, principal);
  }

  /** Export jobs for one dataset, newest first: the principal's own, or every requester's when allRequesters is set (the calling module checks its own permission first). Used by the audit export list. */
  async listExports(filter: { dataset: string; state?: string; allRequesters?: boolean }, principal: identity.Principal, cursor?: string): Promise<{ items: ExportJob[]; nextCursor?: string }> {
    return this.exports.list(filter, principal, cursor);
  }

  /* ---------------------------------------------------------------- events consumed */

  /** orders.order.placed: fact_order_items rows with placement date; fact_customers */
  async onOrderPlacedFromOrders(event: EventPayload<'orders.order.placed'>, env?: Partial<Env>): Promise<void> {
    return this.readModels.onOrderPlaced(event, this.env(env));
  }

  /** orders.order.accepted: Mark items accepted (orders count from acceptance) */
  async onOrderAcceptedFromOrders(event: EventPayload<'orders.order.accepted'>, env?: Partial<Env>): Promise<void> {
    return this.readModels.onOrderAccepted(event, this.env(env));
  }

  /** payments.payment.captured: Payment date basis */
  async onPaymentCapturedFromPayments(event: EventPayload<'payments.payment.captured'>, env?: Partial<Env>): Promise<void> {
    return this.readModels.onPaymentCaptured(event, this.env(env));
  }

  /** shipping.shipment.dispatched: Shipment date basis; on-time dispatch in fact_service_daily */
  async onShipmentDispatchedFromShipping(event: EventPayload<'shipping.shipment.dispatched'>, env?: Partial<Env>): Promise<void> {
    return this.readModels.onShipmentDispatched(event, this.env(env));
  }

  /** shipping.dispatch.overdue: Overdue counts in fact_service_daily */
  async onDispatchOverdueFromShipping(event: EventPayload<'shipping.dispatch.overdue'>, env?: Partial<Env>): Promise<void> {
    return this.readModels.onDispatchOverdue(event, this.env(env));
  }

  /** shipping.shipment.exception: Delivery issues */
  async onShipmentExceptionFromShipping(event: EventPayload<'shipping.shipment.exception'>, env?: Partial<Env>): Promise<void> {
    return this.readModels.onShipmentException(event, this.env(env));
  }

  /** orders.item.delivered: Delivered date */
  async onItemDeliveredFromOrders(event: EventPayload<'orders.item.delivered'>, env?: Partial<Env>): Promise<void> {
    return this.readModels.onItemDelivered(event, this.env(env));
  }

  /** orders.order.completed: Completion date basis */
  async onOrderCompletedFromOrders(event: EventPayload<'orders.order.completed'>, env?: Partial<Env>): Promise<void> {
    return this.readModels.onOrderCompleted(event, this.env(env));
  }

  /** orders.item.cancelled: Cancellations (by customer or seller) and cancelled amounts */
  async onItemCancelledFromOrders(event: EventPayload<'orders.item.cancelled'>, env?: Partial<Env>): Promise<void> {
    return this.readModels.onItemCancelled(event, this.env(env));
  }

  /** payments.refund.sent: Refunds sent (refund date and amount); 'approved' refunds are never counted as sent */
  async onRefundSentFromPayments(event: EventPayload<'payments.refund.sent'>, env?: Partial<Env>): Promise<void> {
    return this.readModels.onRefundSent(event, this.env(env));
  }

  /** returns.return.requested: fact_returns with reason */
  async onReturnRequestedFromReturns(event: EventPayload<'returns.return.requested'>, env?: Partial<Env>): Promise<void> {
    return this.readModels.onReturnRequested(event, this.env(env));
  }

  /** returns.return.inspected: Return outcome */
  async onReturnInspectedFromReturns(event: EventPayload<'returns.return.inspected'>, env?: Partial<Env>): Promise<void> {
    return this.readModels.onReturnInspected(event, this.env(env));
  }

  /** inventory.stock.changed: Stockout minutes per product */
  async onStockChangedFromInventory(event: EventPayload<'inventory.stock.changed'>, env?: Partial<Env>): Promise<void> {
    return this.readModels.onStockChanged(event, this.env(env));
  }

  /** cart.item.added: Cart additions per product */
  async onItemAddedFromCart(event: EventPayload<'cart.item.added'>, env?: Partial<Env>): Promise<void> {
    return this.readModels.onCartItemAdded(event, this.env(env));
  }

  /** messaging.message.sent: Response time per seller */
  async onMessageSentFromMessaging(event: EventPayload<'messaging.message.sent'>, env?: Partial<Env>): Promise<void> {
    return this.readModels.onMessageSent(event, this.env(env));
  }

  /** support.case.opened: Case backlog and complaint patterns */
  async onCaseOpenedFromSupport(event: EventPayload<'support.case.opened'>, env?: Partial<Env>): Promise<void> {
    return this.readModels.onCaseOpened(event, this.env(env));
  }

  /** support.case.resolved: Case backlog */
  async onCaseResolvedFromSupport(event: EventPayload<'support.case.resolved'>, env?: Partial<Env>): Promise<void> {
    return this.readModels.onCaseResolved(event, this.env(env));
  }

  /** finance.payout.paid: Completed payouts */
  async onPayoutPaidFromFinance(event: EventPayload<'finance.payout.paid'>, env?: Partial<Env>): Promise<void> {
    return this.readModels.onPayoutPaid(event, this.env(env));
  }

  /** finance.payout.failed: Failed payouts */
  async onPayoutFailedFromFinance(event: EventPayload<'finance.payout.failed'>, env?: Partial<Env>): Promise<void> {
    return this.readModels.onPayoutFailed(event, this.env(env));
  }

  /** finance.hold.placed: Held amounts */
  async onHoldPlacedFromFinance(event: EventPayload<'finance.hold.placed'>, env?: Partial<Env>): Promise<void> {
    return this.readModels.onHoldPlaced(event, this.env(env));
  }

  /** finance.hold.released: Held amounts */
  async onHoldReleasedFromFinance(event: EventPayload<'finance.hold.released'>, env?: Partial<Env>): Promise<void> {
    return this.readModels.onHoldReleased(event, this.env(env));
  }

  /** finance.amount_owed.created: Amounts owed by sellers */
  async onAmountOwedCreatedFromFinance(event: EventPayload<'finance.amount_owed.created'>, env?: Partial<Env>): Promise<void> {
    return this.readModels.onAmountOwedCreated(event, this.env(env));
  }

  /** promotions.coupon.redeemed: Campaign sales, discount cost and funding owner */
  async onCouponRedeemedFromPromotions(event: EventPayload<'promotions.coupon.redeemed'>, env?: Partial<Env>): Promise<void> {
    return this.readModels.onCouponRedeemed(event, this.env(env));
  }

  /** promotions.redemption.reversed: Reverse discount cost on cancellation */
  async onRedemptionReversedFromPromotions(event: EventPayload<'promotions.redemption.reversed'>, env?: Partial<Env>): Promise<void> {
    return this.readModels.onRedemptionReversed(event, this.env(env));
  }

  /** advertising.charge.posted: Ad spending per campaign and seller */
  async onChargePostedFromAdvertising(event: EventPayload<'advertising.charge.posted'>, env?: Partial<Env>): Promise<void> {
    return this.readModels.onChargePosted(event, this.env(env));
  }

  /** advertising.charge.credited: Ad credits */
  async onChargeCreditedFromAdvertising(event: EventPayload<'advertising.charge.credited'>, env?: Partial<Env>): Promise<void> {
    return this.readModels.onChargeCredited(event, this.env(env));
  }

  /** fulfillment-service.fee.charged: Fulfilled by Marketly fees per seller and day (fact_marketplace_finance_daily.service_fees_minor, claimed per chargeId) */
  async onFeeChargedFromFulfillmentService(event: EventPayload<'fulfillment-service.fee.charged'>, env?: Partial<Env>): Promise<void> {
    return this.readModels.onServiceFeeCharged(event, this.env(env));
  }

  /** fulfillment-service.fee.reversed: Subtract reversed Fulfilled by Marketly fees from service_fees_minor on the reversal day */
  async onFeeReversedFromFulfillmentService(event: EventPayload<'fulfillment-service.fee.reversed'>, env?: Partial<Env>): Promise<void> {
    return this.readModels.onServiceFeeReversed(event, this.env(env));
  }

  /* ---------------------------------------------------------------- jobs */

  /** Job reports.run-exports (every 1 min): Run queued export jobs in batches: call the owner module's exportRows(dataset, filters, principal, cursor) until nextCursor is empty (report results come from runReport), drop columns the requester may not see, write the file to media; publish reports.export.ready */
  async runExports(): Promise<void> {
    return this.exports.runQueued();
  }

  /** Job reports.expire-exports (hourly): Expire ready exports after exportLinkHours and delete files */
  async expireExports(): Promise<void> {
    return this.exports.expireDue();
  }

  /** Job reports.pull-daily (daily 02:30 market time): Pull figures that have no event: search.zeroResultStats (unavailable searches), finance fee income per seller and day (finance.marketplaceIncomeByDay), advertising displays/clicks/dismissals and attributed purchases (advertising.dailyPerformance), inventory unit costs for Official Store items */
  async pullDaily(): Promise<void> {
    return this.readModels.pullDaily();
  }

  /** Job reports.pull-finance-recent (every 15 min): today and yesterday into the finance facts, and the item fees changed since the last run */
  async pullFinanceRecent(): Promise<void> {
    return this.readModels.pullFinanceRecent();
  }

  /**
   * Job reports.run-schedules (every 15 min): Phase 2: run due schedules into export files; when a file is ready
   * the export runner publishes reports.scheduled_report.ready (notifications sends the emails)
   */
  async runSchedules(): Promise<void> {
    const now = this.core.now();
    const cfg = await this.core.cfg();
    for (const s of await this.core.repo.dueSchedules(now, 50)) {
      const report = await this.core.repo.getReport(s.report_key);
      const view = s.saved_view_id ? await this.core.repo.getSavedView(s.saved_view_id) : undefined;
      const next = nextRun({ frequency: s.frequency as 'daily', dayOfWeek: s.day_of_week, time: s.time }, now, cfg.timeZone);
      // claim the run first (inbox key of this due time, committed with the next run time) so a run is never sent twice
      const claimed = await this.core.repo.transaction(async (tx) => {
        if (!(await tx.claim(`schedule-run:${s.id}:${s.next_run_at.toISOString()}`))) return false;
        await tx.updateSchedule(s.id, { next_run_at: next });
        return true;
      });
      if (!claimed || !report || !report.active) continue;
      // staff only (decision D2): every recipient is re-checked now; each one gets an export in their own name, so
      // the download link works for them and nobody else (getExport is requester-only)
      const recipients = stringList(s.recipients);
      const { allowed, denied } = await this.defs.recipientsAllowed(recipients, report.permission);
      const format = s.format === 'xlsx' ? 'xlsx' : 'csv';
      const jobs: { staffId: string; exportId: string }[] = [];
      for (const staffId of allowed) {
        const principal = { kind: 'staff' as const, accountId: staffId };
        try {
          const job = await this.exports.request(
            { dataset: REPORT_DATASET, reportKey: report.key, query: (view?.query as ReportQuery | undefined) ?? {}, format },
            { principal, actor: SYSTEM, can: (perm) => this.core.principalCan(principal, perm) },
            'api',
            { scheduleId: s.id },
          );
          jobs.push({ staffId, exportId: job.id });
        } catch (err) {
          this.core.ctx.log.warn({ err, scheduleId: s.id, staffId }, 'reports: scheduled report not queued for a recipient');
        }
      }
      if (!jobs.length && !denied.length) continue;
      // the files are produced now, so the event announces ready files
      const deliveries: { staffId: string; exportId: string }[] = [];
      let expiresAt: Date | null = null;
      for (const j of jobs) {
        await this.exports.runOne(j.exportId);
        const done = await this.core.repo.getJob(j.exportId);
        if (done?.state !== 'ready' || !done.expires_at) {
          this.core.ctx.log.warn({ scheduleId: s.id, exportId: j.exportId, state: done?.state }, 'reports: scheduled export not ready');
          continue;
        }
        deliveries.push(j);
        if (!expiresAt || done.expires_at < expiresAt) expiresAt = done.expires_at;
      }
      if (denied.length) this.core.ctx.log.info({ scheduleId: s.id, skipped: denied }, 'reports: scheduled report recipients without the permission were skipped');
      this.core.ctx.events.publish('reports.scheduled_report.ready', {
        scheduleId: s.id,
        reportKey: report.key,
        reportTitle: report.title,
        format,
        periodLabel: periodLabel((await this.queries.resolve((view?.query as ReportQuery | undefined) ?? {}, { seller: false })).range),
        deliveries,
        skippedStaffIds: denied,
        expiresAt: (expiresAt ?? new Date(now.getTime() + cfg.exportLinkHours * 3_600_000)).toISOString(),
      });
    }
  }

  /** Job reports.check-lag (every 5 min): Mark read models stale when their lag exceeds readModelMaxLagMinutes */
  async checkLag(): Promise<void> {
    return this.readModels.checkLag();
  }

  /** The staff id behind a caller (owner of saved views and schedules) */
  staffIdOf(by: Caller) {
    return staffId(by);
  }
}
