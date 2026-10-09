/**
 * Read models: the finance overview, marketplace income (fees and ads, never seller sales), company
 * trading of the Official Store with its targets, the admin seller list and seller account, ledger
 * exports through reports and the export rows of finance's datasets.
 */
import type { Principal } from '../../../kernel/auth/index.js';
import { AppError } from '../../../kernel/errors/index.js';
import { isUuid, newId } from '../../../kernel/lib/ids.js';
import type { PageRequest } from '../../../kernel/lib/pagination.js';
import { pageOf } from '../../../kernel/lib/pagination.js';
import type * as common from '../../../spec/common.js';
import type * as identity from '../../../spec/identity.js';
import type { DailySellerIncome, FinanceOverview, MarketplaceIncome, SellerFinanceDetail, SellerFinanceRow, TradingSummary, TradingTarget, TradingTargetInput } from '../../../spec/finance.js';
import type * as reports from '../../../spec/reports.js';
import { addDays, dayStart, daysBetween, daysInMonth, encodeActor, isDate, isPeriod, marketDate, TYPE_LABELS, type EntryType } from '../domain/rules.js';
import { toTarget } from '../mappers.js';
import type { TargetRec, TradingRec, Where } from '../ports.js';
import { invalid, notFound, Part, type By } from './core.js';
import { PLATFORM_KINDS } from './ledger.js';

const DATASETS = ['finance.admin.ledger', 'finance.admin.payout_run', 'finance.admin.checks', 'finance.seller.ledger'] as const;
const round2 = (n: number) => Math.round(n * 100) / 100;
const pctOf = (part: number, whole: number) => (whole ? round2((part / whole) * 100) : 0);

export class ReportsPart extends Part {
  range(from: string, to: string) {
    if (!isDate(from) || !isDate(to) || to < from) throw invalid([{ path: 'to', message: 'A date range: from on or before to' }]);
    const tz = this.core.tz();
    return { from: dayStart(from, tz), to: dayStart(addDays(to, 1), tz), days: daysBetween(from, to) + 1 };
  }

  async tradingRows(from: Date, to: Date): Promise<TradingRec[]> {
    return (await this.repo.find('trading_entries', { at: { op: '>=', value: from } })).filter((r) => r.at < to);
  }

  /* ---------------------------------------------------------------- overview and marketplace income */

  async overview(q: { from: string; to: string; basis?: string | null }): Promise<FinanceOverview> {
    const r = this.range(q.from, q.to);
    const sums = await this.repo.typeSums(r.from, r.to, Object.keys(TYPE_LABELS));
    const get = (t: EntryType) => sums.get(t) ?? 0;
    const trading = await this.tradingRows(r.from, r.to);
    const official = trading.filter((t) => !t.ref_kind || !PLATFORM_KINDS.includes(t.ref_kind));
    const sum = (rows: TradingRec[], kind: string, refKind?: string) => rows.filter((t) => t.kind === kind && (!refKind || t.ref_kind === refKind)).reduce((s, t) => s + t.amount, 0);
    const captures = await this.repo.find('recon_items', { ref_kind: 'capture', detected_at: { op: '>=', value: r.from } });
    const inRange = captures.filter((c) => c.detected_at < r.to);
    const accounts = await this.repo.find('seller_accounts', {});
    const refunds = (await this.repo.find('refund_allocations', { applied_at: { op: '>=', value: r.from } })).filter((a) => a.applied_at! < r.to);
    const paid = (await this.repo.find('payouts', { status: 'paid', paid_at: { op: '>=', value: r.from } })).filter((p) => p.paid_at! < r.to);
    const lastRun = await this.repo.findOne('payout_runs', { status: ['releasing', 'completed'] }, { orderBy: [['released_at', 'desc']] });
    const coupons = trading.filter((t) => t.ref_kind === 'coupon_redemption' || t.ref_kind === 'coupon_seller_part');
    const byRedemption = new Map<string, { platform: number; seller: number }>();
    for (const c of coupons) {
      const v = byRedemption.get(c.ref_id ?? c.id) ?? { platform: 0, seller: 0 };
      if (c.ref_kind === 'coupon_redemption') v.platform += c.amount;
      else v.seller += c.amount;
      byRedemption.set(c.ref_id ?? c.id, v);
    }
    let platformCoupons = 0;
    let shared = 0;
    for (const v of byRedemption.values()) {
      if (v.platform > 0 && v.seller > 0) shared += v.platform + v.seller;
      else platformCoupons += v.platform;
    }
    const sellerMarkdowns = -get('seller_discount');
    const recon = await this.repo.find('recon_items', { status: ['open', 'correction_pending'] });
    const failed = await this.repo.find('payouts', { status: 'failed' });
    const retried = failed.length ? new Set((await this.repo.find('payouts', { retry_of: failed.map((f) => f.id) })).map((p) => p.retry_of)) : new Set<string | null>();
    const held = accounts.reduce((s, a) => s + Math.max(0, a.held), 0);
    return {
      range: { from: q.from, to: q.to },
      basis: `counted by ${q.basis === 'order_date' ? 'order date' : 'payment date'}, ${this.core.currency()}, ${this.core.tz()}`,
      collectedPayments: this.money(inRange.reduce((s, c) => s + c.actual, 0)),
      collectedCount: inRange.length,
      companySales: this.money(sum(official, 'sale')),
      sellerSales: this.money(get('sale') + get('cancellation')),
      shippingCollected: this.money(get('shipping_charge') - sum(official, 'shipping_expense', 'order_item')),
      marketplaceFeeIncome: this.money(-(get('marketplace_fee') + get('fee_refund'))),
      sellerEarnings: this.money(get('sale') + get('shipping_charge') + get('seller_discount') + get('marketplace_fee') + get('cancellation') + get('fee_refund')),
      owedToSellers: this.money(accounts.reduce((s, a) => s + Math.max(0, a.pending + a.available + a.held), 0)),
      owedPending: this.money(accounts.reduce((s, a) => s + a.pending, 0)),
      owedAvailable: this.money(accounts.reduce((s, a) => s + Math.max(0, a.available), 0)),
      refundsSent: this.money(refunds.reduce((s, a) => s + a.seller_share + a.platform_share, 0)),
      refundsSentCount: refunds.length,
      refundsFailing: 0,
      holds: this.money(held),
      holdSellers: accounts.filter((a) => a.held > 0).length,
      paidOut: this.money(paid.reduce((s, p) => s + p.amount, 0)),
      lastRunRef: lastRun?.ref ?? null,
      discountFunding: { platformCoupons: this.money(platformCoupons), sellerMarkdowns: this.money(sellerMarkdowns), sharedCampaigns: this.money(shared), total: this.money(platformCoupons + sellerMarkdowns + shared) },
      queueCounts: { unexplained: recon.filter((i) => i.check === 'unexplained_amount').length, mismatches: recon.filter((i) => i.check !== 'unexplained_amount').length, failedPayouts: failed.filter((f) => !retried.has(f.id)).length },
    };
  }

  async marketplaceIncome(q: { from: string; to: string }): Promise<MarketplaceIncome> {
    const r = this.range(q.from, q.to);
    const sums = await this.repo.typeSums(r.from, r.to, ['sale', 'cancellation', 'marketplace_fee', 'fee_refund', 'ad_charge']);
    const get = (t: string) => sums.get(t) ?? 0;
    const trading = await this.tradingRows(r.from, r.to);
    const accounts = await this.repo.find('seller_accounts', {});
    const paid = (await this.repo.find('payouts', { status: 'paid', paid_at: { op: '>=', value: r.from } })).filter((p) => p.paid_at! < r.to);
    const feeIncome = -get('marketplace_fee');
    const feeRefunds = get('fee_refund');
    return {
      range: { from: q.from, to: q.to },
      sellerSales: this.money(get('sale') + get('cancellation')),
      feeIncome: this.money(feeIncome),
      feeRefunds: this.money(feeRefunds),
      netFeeIncome: this.money(feeIncome - feeRefunds),
      adIncome: this.money(-get('ad_charge')),
      platformDiscountCost: this.money(trading.filter((t) => t.ref_kind === 'coupon_redemption').reduce((s, t) => s + t.amount, 0)),
      owedToSellers: this.money(accounts.reduce((s, a) => s + Math.max(0, a.pending + a.available + a.held), 0)),
      holds: this.money(accounts.reduce((s, a) => s + Math.max(0, a.held), 0)),
      payoutsCompleted: this.money(paid.reduce((s, p) => s + p.amount, 0)),
    };
  }

  async incomeByDay(range: common.DateRange, sellerId?: string): Promise<DailySellerIncome[]> {
    const r = this.range(range.from, range.to);
    const rows = await this.repo.dailyTypeSums(r.from, r.to, this.core.tz(), ['marketplace_fee', 'fee_refund', 'ad_charge'], sellerId);
    const out = new Map<string, DailySellerIncome>();
    for (const row of rows) {
      const key = `${row.day}|${row.sellerId}`;
      const v = out.get(key) ?? { date: row.day, sellerId: row.sellerId, feeIncome: this.money(0), feeRefunds: this.money(0), netFeeIncome: this.money(0), adIncome: this.money(0) };
      if (row.type === 'marketplace_fee') v.feeIncome = this.money(-row.amount);
      if (row.type === 'fee_refund') v.feeRefunds = this.money(row.amount);
      if (row.type === 'ad_charge') v.adIncome = this.money(-row.amount);
      v.netFeeIncome = this.money(v.feeIncome.amount - v.feeRefunds.amount);
      out.set(key, v);
    }
    return [...out.values()];
  }

  /* ---------------------------------------------------------------- company trading */

  async trading(q: { from: string; to: string }): Promise<TradingSummary> {
    const r = this.range(q.from, q.to);
    const tz = this.core.tz();
    const company = (rows: TradingRec[]) => rows.filter((t) => !t.ref_kind || !PLATFORM_KINDS.includes(t.ref_kind));
    const rows = company(await this.tradingRows(r.from, r.to));
    const totals = (list: TradingRec[]) => {
      const s = (k: string) => list.filter((t) => t.kind === k).reduce((x, t) => x + t.amount, 0);
      const sales = s('sale');
      const buying = s('buying_cost');
      const gross = sales - buying;
      const net = gross - s('discount') - s('shipping_expense') - s('return') - s('write_off') - s('chargeback_loss') + s('supplier_credit');
      return { sales, buying, gross, discounts: s('discount'), shipping: s('shipping_expense'), returns: s('return'), writeOffs: s('write_off'), chargebacks: s('chargeback_loss'), net };
    };
    const t = totals(rows);
    const priorFrom = addDays(q.from, -r.days);
    const prior = totals(company(await this.tradingRows(dayStart(priorFrom, tz), r.from)));
    const daily = new Map<string, { sales: number; margin: number }>();
    for (let d = q.from; d <= q.to; d = addDays(d, 1)) daily.set(d, { sales: 0, margin: 0 });
    for (const row of rows) {
      const d = daily.get(marketDate(row.at, tz));
      if (!d) continue;
      if (row.kind === 'sale') {
        d.sales += row.amount;
        d.margin += row.amount;
      } else if (row.kind === 'buying_cost') d.margin -= row.amount;
    }
    // targets prorated by days of each month in the range (whole store)
    let target = 0;
    let marginWeighted = 0;
    let marginWeight = 0;
    let anyTarget = false;
    const targets = new Map((await this.repo.find('trading_targets', { category_id: null })).map((x) => [x.period, x]));
    for (let d = q.from; d <= q.to; d = addDays(d, 1)) {
      const period = d.slice(0, 7);
      const tr = targets.get(period);
      if (!tr) continue;
      anyTarget = true;
      const part = tr.sales_target / daysInMonth(period);
      target += part;
      if (tr.margin_target_bps !== null) {
        marginWeighted += (tr.margin_target_bps / 100) * part;
        marginWeight += part;
      }
    }
    const grossPct = pctOf(t.gross, t.sales);
    const marginTarget = marginWeight ? round2(marginWeighted / marginWeight) : null;
    return {
      range: { from: q.from, to: q.to },
      costBasis: 'weighted average buying cost at receipt',
      productSales: this.money(t.sales),
      buyingCost: this.money(t.buying),
      grossMargin: this.money(t.gross),
      grossMarginPct: grossPct,
      discounts: this.money(t.discounts),
      shippingExpense: this.money(t.shipping),
      returnsCost: this.money(t.returns),
      writeOffs: this.money(t.writeOffs),
      chargebackLosses: this.money(t.chargebacks),
      netMargin: this.money(t.net),
      returnsPctOfSales: pctOf(t.returns, t.sales),
      returnsPctChangePts: prior.sales ? round2(pctOf(t.returns, t.sales) - pctOf(prior.returns, prior.sales)) : null,
      target: anyTarget ? { salesTarget: this.money(Math.round(target)), salesAttainmentPct: pctOf(t.sales, Math.round(target)), marginTargetPct: marginTarget, marginVsTargetPts: marginTarget === null ? null : round2(grossPct - marginTarget) } : null,
      salesChangePct: prior.sales ? round2(((t.sales - prior.sales) / prior.sales) * 100) : null,
      daily: [...daily.entries()].map(([date, v]) => ({ date, sales: this.money(v.sales), margin: this.money(v.margin) })),
    };
  }

  async listTargets(f: { from?: string | null; to?: string | null; categoryId?: string | null }, page: PageRequest): Promise<common.Page<TradingTarget>> {
    if ((f.from && !isPeriod(f.from)) || (f.to && !isPeriod(f.to))) throw invalid([{ path: f.from && !isPeriod(f.from) ? 'from' : 'to', message: 'A month as YYYY-MM' }]);
    const where: Where<TargetRec> = {};
    if (f.categoryId) where.category_id = f.categoryId;
    let rows = await this.repo.find('trading_targets', where, { orderBy: [['period', 'desc']] });
    rows = rows.filter((r) => (!f.from || r.period >= f.from) && (!f.to || r.period <= f.to));
    return pageOf(rows.map(toTarget), page);
  }

  async setTarget(period: string, input: TradingTargetInput, by: By): Promise<TradingTarget> {
    const issues: { path: string; message: string }[] = [];
    if (!isPeriod(period)) issues.push({ path: 'period', message: 'A month as YYYY-MM' });
    if (!Number.isSafeInteger(input.salesTarget.amount) || input.salesTarget.amount < 0) issues.push({ path: 'salesTarget', message: 'Whole minor units, zero or more' });
    if (input.marginTargetPct !== undefined && input.marginTargetPct !== null && (input.marginTargetPct < -100 || input.marginTargetPct > 100)) issues.push({ path: 'marginTargetPct', message: 'A percentage' });
    if (input.categoryId && !isUuid(input.categoryId)) issues.push({ path: 'categoryId', message: 'A category id' });
    if (issues.length) throw invalid(issues, 'The target is not valid');
    const categoryId = input.categoryId ?? null;
    const before = await this.repo.findOne('trading_targets', { period, category_id: categoryId });
    const row: TargetRec = { id: before?.id ?? newId(), period, category_id: categoryId, sales_target: input.salesTarget.amount, currency: input.salesTarget.currency || this.core.currency(), margin_target_bps: input.marginTargetPct === undefined || input.marginTargetPct === null ? null : Math.round(input.marginTargetPct * 100), note: input.note ?? null, set_by: encodeActor(by.actor)!, set_at: this.now() };
    if (before) await this.repo.update('trading_targets', before.id, row);
    else await this.repo.insert('trading_targets', row);
    await this.core.audit({ action: 'finance.trading_target.set', actionLabel: 'Set an Official Store sales target', category: 'financial', target: { type: 'trading_target', id: row.id, ref: period, label: categoryId ? `Category target ${period}` : `Official Store target ${period}`, screen: 'admin/official' }, before: before ? { salesTarget: before.sales_target, marginTargetBps: before.margin_target_bps } : null, after: { salesTarget: row.sales_target, marginTargetBps: row.margin_target_bps }, reason: input.note ?? null }, by);
    return toTarget(row);
  }

  /* ---------------------------------------------------------------- sellers (admin) */

  async sellerRows(f: { q?: string | null; filter?: string | null }, page: PageRequest): Promise<common.Page<SellerFinanceRow>> {
    let accounts = await this.repo.find('seller_accounts', {}, { orderBy: [['updated_at', 'desc']] });
    if (f.q?.trim()) {
      const found = await this.core.optionalDep(() => this.ctx.use('sellers').searchSellers({ search: f.q!.trim() }, { limit: 100 }));
      const ids = new Set((found?.items ?? []).map((s) => s.id));
      accounts = accounts.filter((a) => ids.has(a.seller_id) || a.seller_id === f.q!.trim());
    }
    const owed = await this.repo.find('amounts_owed', { status: 'open' });
    const dests = await this.core.destinationStatuses(accounts.map((a) => a.seller_id));
    if (f.filter === 'negative') accounts = accounts.filter((a) => a.available < 0);
    else if (f.filter === 'held') accounts = accounts.filter((a) => a.held > 0);
    else if (f.filter === 'owed') accounts = accounts.filter((a) => owed.some((o) => o.seller_id === a.seller_id));
    else if (f.filter === 'destination_issue') accounts = accounts.filter((a) => dests.get(a.seller_id)!.status !== 'verified');
    const paged = pageOf(accounts, page);
    const names = await this.core.sellerInfo(paged.items.map((a) => a.seller_id));
    const minimum = await this.core.num('minimumPayout', 2500);
    const items: SellerFinanceRow[] = [];
    for (const a of paged.items) {
      const last = await this.repo.findOne('payouts', { seller_id: a.seller_id }, { orderBy: [['requested_on', 'desc']] });
      const o = owed.filter((x) => x.seller_id === a.seller_id).reduce((s, x) => s + x.remaining, 0);
      items.push({ sellerId: a.seller_id, sellerName: names.get(a.seller_id)?.name ?? 'Seller', pending: this.money(a.pending), available: this.money(a.available), held: this.money(a.held), negative: a.available < 0, owed: o ? this.money(o) : null, nextPayout: a.available >= minimum ? this.money(a.available) : null, destination: dests.get(a.seller_id)!, lastPayoutStatus: last?.status ?? null });
    }
    return { ...paged, items };
  }

  async sellerDetail(sellerId: string): Promise<SellerFinanceDetail> {
    const balances = await this.parts.ledger.balances(sellerId);
    const payouts = await this.repo.find('payouts', { seller_id: sellerId }, { orderBy: [['requested_on', 'desc']], limit: 5 });
    const holds = await this.repo.find('holds', { seller_id: sellerId, status: 'active' }, { orderBy: [['review_date', 'asc']] });
    const owed = await this.repo.find('amounts_owed', { seller_id: sellerId, status: 'open' });
    const adjustments = await this.repo.find('adjustments', { seller_id: sellerId }, { orderBy: [['created_at', 'desc']], limit: 10 });
    const acct = await this.repo.findOne('seller_accounts', { seller_id: sellerId });
    const rule = await this.core.ruleAt(this.now(), acct?.fee_override_set_id);
    const name = balances.holds[0]?.sellerName ?? (await this.core.sellerName(sellerId));
    const { toOwed } = await import('../mappers.js');
    return {
      balances,
      recentPayouts: await this.parts.payouts.payoutViews(payouts),
      openHolds: await this.parts.holds.holdViews(holds),
      owed: owed.map((o) => toOwed(o, name)),
      recentAdjustments: await this.parts.holds.adjustmentViews(adjustments),
      feeRuleVersion: rule.version,
    };
  }

  /* ---------------------------------------------------------------- exports */

  async registerDatasets() {
    const api = this.ctx.tryUse('reports');
    if (!api) return;
    const columns = [
      { key: 'date', label: 'Date' },
      { key: 'type', label: 'Entry type' },
      { key: 'reference', label: 'Order or payout reference' },
      { key: 'description', label: 'Description' },
      { key: 'amount', label: 'Amount' },
      { key: 'balanceAfter', label: 'Balance after' },
    ];
    const sets: reports.ExportDataset[] = [
      { key: 'finance.seller.ledger', owner: 'finance', title: 'Ledger', permission: 'finance.balances.view', columns, audience: 'seller', screens: ['seller/finance'], available: true, phase: 1 },
      { key: 'finance.admin.ledger', owner: 'finance', title: 'Seller ledger', permission: 'finance.ledger.view', columns: [{ key: 'seller', label: 'Seller' }, ...columns], audience: 'staff', screens: ['admin/seller', 'admin/finance'], available: true, phase: 1 },
      { key: 'finance.admin.payout_run', owner: 'finance', title: 'Payout run', permission: 'finance.ledger.view', columns: [{ key: 'payout', label: 'Payout' }, { key: 'seller', label: 'Seller' }, { key: 'amount', label: 'Amount' }, { key: 'status', label: 'Status' }, { key: 'failure', label: 'Failure' }], audience: 'staff', screens: ['admin/payouts'], available: true, phase: 1 },
      { key: 'finance.admin.checks', owner: 'finance', title: 'Finance checks', permission: 'finance.reconciliation.work', columns: [{ key: 'date', label: 'Date' }, { key: 'check', label: 'Check' }, { key: 'subject', label: 'Subject' }, { key: 'expected', label: 'Expected' }, { key: 'actual', label: 'Actual' }, { key: 'difference', label: 'Difference' }, { key: 'status', label: 'Status' }], audience: 'staff', screens: ['ops/finance-checks'], available: true, phase: 1 },
    ];
    for (const s of sets) {
      try {
        await api.registerDataset(s);
      } catch (err) {
        this.ctx.log.debug({ err, dataset: s.key }, 'finance: export dataset not registered');
      }
    }
  }

  async exportLedger(sellerId: string, body: { from: string; to: string; format?: 'csv' | 'xlsx' | null }, principal: Principal, by: By): Promise<reports.ExportJob> {
    if (!isDate(body.from) || !isDate(body.to) || body.to < body.from) throw invalid([{ path: 'to', message: 'A date range: from on or before to' }]);
    const api = this.ctx.tryUse('reports');
    if (!api) throw new AppError('NOT_IMPLEMENTED', 'Exports need the reports module', { reason: 'module_off' });
    const job = await api.requestExport({ dataset: 'finance.seller.ledger', filters: { from: body.from, to: body.to }, format: body.format ?? 'csv', principal: principal as identity.Principal, sellerId });
    await this.core.audit({ action: 'finance.ledger.export', actionLabel: 'Exported the seller ledger', category: 'financial', target: { type: 'seller', id: sellerId, sellerId, screen: 'seller/finance' }, after: { from: body.from, to: body.to, jobId: job.id } }, by);
    return job;
  }

  async getLedgerExport(sellerId: string, id: string, principal: Principal): Promise<reports.ExportJob> {
    const api = this.ctx.tryUse('reports');
    if (!api) throw notFound('Export');
    const job = await api.getExport(id, principal as identity.Principal);
    if (!job || job.dataset !== 'finance.seller.ledger' || (job.sellerId && job.sellerId !== sellerId)) throw notFound('Export');
    return job;
  }

  async exportRows(dataset: string, filters: unknown, principal: identity.Principal, cursor?: string): Promise<{ rows: unknown[]; nextCursor?: string }> {
    if (!(DATASETS as readonly string[]).includes(dataset)) throw new AppError('NOT_FOUND', `Unknown dataset ${dataset}`);
    const f = (filters ?? {}) as { from?: string; to?: string; sellerId?: string; runId?: string; date?: string };
    const offset = cursor ? Number(cursor) || 0 : 0;
    const limit = 500;
    const tz = this.core.tz();
    const money = (n: number) => (n / 100).toFixed(2);
    if (dataset === 'finance.seller.ledger' || dataset === 'finance.admin.ledger') {
      let sellerId = f.sellerId;
      if (dataset === 'finance.seller.ledger') {
        if (principal.kind !== 'seller' || !principal.sellerId) throw new AppError('FORBIDDEN', 'Seller ledger exports are for the seller');
        sellerId = principal.sellerId;
      } else if (principal.kind !== 'staff') throw new AppError('FORBIDDEN', 'Staff only');
      const where: Where<import('../ports.js').EntryRec> = {};
      if (sellerId) where.seller_id = sellerId;
      if (f.from && isDate(f.from)) where.at = { op: '>=', value: dayStart(f.from, tz) };
      let rows = await this.repo.find('ledger_entries', where, { orderBy: [['at', 'asc'], ['id', 'asc']], offset, limit: limit + 1 });
      if (f.to && isDate(f.to)) rows = rows.filter((r) => r.at < dayStart(addDays(f.to!, 1), tz));
      const names = dataset === 'finance.admin.ledger' ? await this.core.sellerInfo(rows.map((r) => r.seller_id)) : new Map();
      const out = rows.slice(0, limit).map((r) => ({ ...(dataset === 'finance.admin.ledger' ? { seller: names.get(r.seller_id)?.name ?? r.seller_id } : {}), date: marketDate(r.at, tz), type: TYPE_LABELS[r.type as EntryType] ?? r.type, reference: r.ref_label ?? r.ref_id, description: r.description, amount: money(r.amount), balanceAfter: money(r.balance_after) }));
      return { rows: out, ...(rows.length > limit ? { nextCursor: String(offset + limit) } : {}) };
    }
    if (principal.kind !== 'staff') throw new AppError('FORBIDDEN', 'Staff only');
    if (dataset === 'finance.admin.payout_run') {
      const rows = await this.repo.find('payouts', f.runId ? { run_id: f.runId } : {}, { orderBy: [['requested_on', 'desc'], ['id', 'asc']], offset, limit: limit + 1 });
      const names = await this.core.sellerInfo(rows.map((r) => r.seller_id));
      return { rows: rows.slice(0, limit).map((r) => ({ payout: r.ref, seller: names.get(r.seller_id)?.name ?? r.seller_id, amount: money(r.amount), status: r.status, failure: r.failure_reason ?? '' })), ...(rows.length > limit ? { nextCursor: String(offset + limit) } : {}) };
    }
    const rows = await this.repo.find('recon_items', f.date && isDate(f.date) ? { date: f.date } : {}, { orderBy: [['detected_at', 'desc'], ['id', 'asc']], offset, limit: limit + 1 });
    return { rows: rows.slice(0, limit).map((r) => ({ date: r.date, check: r.check, subject: r.subject, expected: money(r.expected), actual: money(r.actual), difference: money(r.difference), status: r.status })), ...(rows.length > limit ? { nextCursor: String(offset + limit) } : {}) };
  }
}
