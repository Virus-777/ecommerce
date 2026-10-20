/**
 * Read models: the finance overview, marketplace income (fees and ads, never seller sales), company
 * trading of the Official Store with its targets, the admin seller list and seller account, ledger
 * exports through reports and the export rows of finance's datasets.
 */
import { isIsoDate } from '../../../kernel/lib/dates.js';
import type { Principal } from '../../../kernel/auth/index.js';
import { AppError } from '../../../kernel/errors/index.js';
import { isUuid, newId } from '../../../kernel/lib/ids.js';
import type { PageRequest } from '../../../kernel/lib/pagination.js';
import { pageOf } from '../../../kernel/lib/pagination.js';
import type * as common from '../../../spec/common.js';
import type * as identity from '../../../spec/identity.js';
import type { DailyCompanyCost, DailySellerIncome, FinanceOverview, MarketplaceIncome, SellerFinanceDetail, SellerFinanceRow, TradingSummary, TradingTarget, TradingTargetInput } from '../../../spec/finance.js';
import type * as reports from '../../../spec/reports.js';
import { addDays, dayStart, daysBetween, daysInMonth, encodeActor, isPeriod, marketDate, TYPE_LABELS, type EntryType } from '../domain/rules.js';
import { toOwed, toTarget } from '../mappers.js';
import type { FundingRec, TargetRec, TradingRec } from '../ports.js';
import type { Where } from '../../../kernel/mongo/index.js';
import { invalid, notFound, Part, type By } from './core.js';

/**
 * The finance overview export (G72). reports must list the key in its export dataset registry (ExportDatasetKey and
 * the exportDatasets setting): until then registering it is refused and the dataset is not offered.
 */
const OVERVIEW_DATASET = 'finance.admin.overview';
const DATASETS = ['finance.admin.ledger', 'finance.admin.payout_run', 'finance.admin.checks', 'finance.seller.ledger', OVERVIEW_DATASET] as const;
const round2 = (n: number) => Math.round(n * 100) / 100;
const pctOf = (part: number, whole: number) => (whole ? round2((part / whole) * 100) : 0);

export class ReportsPart extends Part {
  range(from: string, to: string) {
    if (!isIsoDate(from) || !isIsoDate(to) || to < from) throw invalid([{ path: 'to', message: 'A date range: from on or before to' }]);
    const tz = this.core.tz();
    return { from: dayStart(from, tz), to: dayStart(addDays(to, 1), tz), days: daysBetween(from, to) + 1 };
  }

  async tradingRows(from: Date, to: Date): Promise<TradingRec[]> {
    return this.repo.findInRange('trading_entries', 'at', from, to);
  }

  /** Coupon discount funding rows (platform and seller parts, reversals negative) in a range */
  async fundingRows(from: Date, to: Date): Promise<FundingRec[]> {
    return this.repo.findInRange('discount_funding', 'at', from, to);
  }

  /* ---------------------------------------------------------------- overview and marketplace income */

  async overview(q: { from: string; to: string; basis?: string | null }): Promise<FinanceOverview> {
    const r = this.range(q.from, q.to);
    const sums = await this.repo.typeSums(r.from, r.to, Object.keys(TYPE_LABELS));
    const get = (t: EntryType) => sums.get(t) ?? 0;
    const official = await this.tradingRows(r.from, r.to); // trading_entries is Official Store trading only
    const sum = (rows: TradingRec[], kind: string, refKind?: string) => rows.filter((t) => t.kind === kind && (!refKind || t.ref_kind === refKind)).reduce((s, t) => s + t.amount, 0);
    const inRange = await this.repo.findInRange('captures', 'captured_at', r.from, r.to);
    const accounts = await this.repo.accountTotals();
    const refunds = await this.repo.findInRange('refund_allocations', 'applied_at', r.from, r.to);
    const paid = await this.repo.findInRange('payouts', 'paid_at', r.from, r.to, { status: 'paid' });
    const lastRun = await this.repo.findOne('payout_runs', { status: ['releasing', 'completed'] }, { orderBy: [['released_at', 'desc']] });
    const byRedemption = new Map<string, { platform: number; seller: number }>();
    for (const c of await this.fundingRows(r.from, r.to)) {
      const v = byRedemption.get(c.redemption_id) ?? { platform: 0, seller: 0 };
      if (c.funded_by === 'platform') v.platform += c.amount;
      else v.seller += c.amount;
      byRedemption.set(c.redemption_id, v);
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
    return {
      range: { from: q.from, to: q.to },
      basis: `counted by ${q.basis === 'order_date' ? 'order date' : 'payment date'}, ${this.core.currency()}, ${this.core.tz()}`,
      collectedPayments: this.money(inRange.reduce((s, c) => s + c.card_amount, 0)),
      collectedCount: inRange.length,
      companySales: this.money(sum(official, 'sale')),
      sellerSales: this.money(get('sale') + get('cancellation')),
      shippingCollected: this.money(get('shipping_charge') - sum(official, 'shipping_expense', 'order_item')),
      marketplaceFeeIncome: this.money(-(get('marketplace_fee') + get('fee_refund'))),
      sellerEarnings: this.money(get('sale') + get('shipping_charge') + get('seller_discount') + get('marketplace_fee') + get('cancellation') + get('fee_refund')),
      owedToSellers: this.money(accounts.owed),
      owedPending: this.money(accounts.pending),
      owedAvailable: this.money(accounts.positiveAvailable),
      refundsSent: this.money(refunds.reduce((s, a) => s + a.seller_share + a.platform_share, 0)),
      refundsSentCount: refunds.length,
      // refunds payments could not send (payments.refund.failed marks their funding split), not sent since
      refundsFailing: (await this.repo.find('refund_allocations', { applied_at: null })).filter((a) => (a.breakdown as { failure?: unknown } | null)?.failure).length,
      holds: this.money(accounts.positiveHeld),
      holdSellers: accounts.heldSellers,
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
    const platformFunding = (await this.fundingRows(r.from, r.to)).filter((f) => f.funded_by === 'platform');
    const accounts = await this.repo.accountTotals();
    const paid = await this.repo.findInRange('payouts', 'paid_at', r.from, r.to, { status: 'paid' });
    const feeIncome = -get('marketplace_fee');
    const feeRefunds = get('fee_refund');
    return {
      range: { from: q.from, to: q.to },
      sellerSales: this.money(get('sale') + get('cancellation')),
      feeIncome: this.money(feeIncome),
      feeRefunds: this.money(feeRefunds),
      netFeeIncome: this.money(feeIncome - feeRefunds),
      adIncome: this.money(-get('ad_charge') - (await this.adCredits(r.from, r.to)).reduce((s, e) => s + e.amount, 0)),
      platformDiscountCost: this.money(platformFunding.reduce((s, f) => s + f.amount, 0)),
      owedToSellers: this.money(accounts.owed),
      holds: this.money(accounts.positiveHeld),
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
      if (row.type === 'ad_charge') v.adIncome = this.money(v.adIncome.amount - row.amount);
      v.netFeeIncome = this.money(v.feeIncome.amount - v.feeRefunds.amount);
      out.set(key, v);
    }
    // ad charges credited back reduce that day's ad income
    for (const e of await this.adCredits(r.from, r.to, sellerId)) {
      const day = marketDate(e.at, this.core.tz());
      const key = `${day}|${e.seller_id}`;
      const v = out.get(key) ?? { date: day, sellerId: e.seller_id, feeIncome: this.money(0), feeRefunds: this.money(0), netFeeIncome: this.money(0), adIncome: this.money(0) };
      v.adIncome = this.money(v.adIncome.amount - e.amount);
      out.set(key, v);
    }
    return [...out.values()];
  }

  /**
   * Official Store trading costs per market day and kind (reports: Purchasing cost, Discounts and shipping expense,
   * Returns cost). trading_entries keeps return losses as kind 'return'; the API calls them return_loss. The cost of
   * goods sold (cost_of_goods) is no booked cost: reports takes it from its own order facts.
   */
  async companyCostsByDay(range: common.DateRange): Promise<DailyCompanyCost[]> {
    const r = this.range(range.from, range.to);
    const tz = this.core.tz();
    const out = new Map<string, DailyCompanyCost>();
    for (const row of await this.tradingRows(r.from, r.to)) {
      if (row.kind === 'sale' || row.kind === 'cost_of_goods') continue;
      const kind = (row.kind === 'return' ? 'return_loss' : row.kind) as DailyCompanyCost['kind'];
      const date = marketDate(row.at, tz);
      const key = `${date}|${kind}|${row.currency}`;
      const v = out.get(key) ?? { date, kind, amount: { amount: 0, currency: row.currency }, entries: 0 };
      v.amount = { amount: v.amount.amount + row.amount, currency: row.currency };
      v.entries += 1;
      out.set(key, v);
    }
    return [...out.values()].sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind));
  }

  /* ---------------------------------------------------------------- daily totals for the reports finance facts (docs/09 §3.2) */

  /** Seller ledger entries summed per seller, market day and entry type, amounts signed as in the ledger */
  async ledgerDailyTotals(q: { from: string; to: string; sellerId?: string }): Promise<{ sellerId: string; day: string; type: string; amount: common.Money; count: number }[]> {
    const r = this.range(q.from, q.to);
    if (q.sellerId && !isUuid(q.sellerId)) return [];
    const rows = await this.repo.dailyTypeSums(r.from, r.to, this.core.tz(), Object.keys(TYPE_LABELS), q.sellerId);
    return rows.map((x) => ({ sellerId: x.sellerId, day: x.day, type: x.type, amount: this.money(x.amount), count: x.count }));
  }

  /**
   * Company money per market day: Official Store trading by kind (as stored in trading_entries), platform costs by
   * kind, and coupon discount funding by funder on marketplace seller items only (funding on Official Store items
   * is part of the trading discount already, so counting it here too would count it twice in the company result).
   */
  async companyDailyTotals(q: { from: string; to: string }): Promise<{ day: string; source: 'trading' | 'platform_cost' | 'discount_funding'; kind: string; amount: common.Money }[]> {
    const r = this.range(q.from, q.to);
    const tz = this.core.tz();
    const [trading, costs, funding] = await Promise.all([
      this.repo.dailyKindSums('trading_entries', 'kind', r.from, r.to, tz),
      this.repo.dailyKindSums('platform_costs', 'kind', r.from, r.to, tz),
      this.repo.dailyKindSums('discount_funding', 'funded_by', r.from, r.to, tz, { marketplaceOnly: true }),
    ]);
    const of = (source: 'trading' | 'platform_cost' | 'discount_funding') => (x: { day: string; kind: string; amount: number }) => ({ day: x.day, source, kind: x.kind, amount: this.money(x.amount) });
    return [...trading.map(of('trading')), ...costs.map(of('platform_cost')), ...funding.map(of('discount_funding'))];
  }

  /** Fee charges changed at or after `since`, keyset-paged by (changed_at, id); the cursor is "<changed_at ISO>|<id>" */
  async itemFeesChangedSince(q: { since: string; after?: string; limit: number }): Promise<{ orderItemId: string; sellerId: string; fee: common.Money; refundedFee: common.Money; changedAt: string; cursor: string }[]> {
    const since = new Date(q.since);
    if (Number.isNaN(since.getTime())) throw invalid([{ path: 'since', message: 'A date and time' }]);
    let after: { at: Date; id: string } | undefined;
    if (q.after) {
      const [at, id] = q.after.split('|');
      const d = new Date(at ?? '');
      if (!id || Number.isNaN(d.getTime())) throw invalid([{ path: 'after', message: 'A cursor from an earlier page' }]);
      after = { at: d, id };
    }
    const limit = Math.min(1000, Math.max(1, Math.floor(q.limit) || 1));
    const rows = await this.repo.feeChargesChangedSince(since, after, limit);
    return rows.map((c) => {
      const changedAt = (c.changed_at ?? c.created_at).toISOString();
      return { orderItemId: c.order_item_id, sellerId: c.seller_id, fee: this.money(c.fee), refundedFee: this.money(c.refunded_fee), changedAt, cursor: `${changedAt}|${c.id}` };
    });
  }

  /**
   * End-of-day balances per seller and market day (today: as of now), rebuilt from today's balances walking back
   * one day at a time: a day's ledger entries come off the bucket they were posted to, and the lots that left
   * pending that day (moveLot moves their net from pending to available without a ledger entry) go back to pending.
   * held and the total are exact; the pending/available split is exact for lots that left pending after
   * left_pending_at was kept (2026-10-21), and uses available_at for older ones. Days after today are left out;
   * sellers with nothing in any bucket that day too. owed is a negative available balance as a positive amount.
   */
  async sellerBalancesByDay(q: { from: string; to: string }): Promise<{ day: string; sellerId: string; pending: common.Money; available: common.Money; held: common.Money; owed: common.Money }[]> {
    this.range(q.from, q.to);
    const tz = this.core.tz();
    const today = this.core.today();
    const to = q.to > today ? today : q.to;
    if (q.from > to) return [];
    const after = dayStart(addDays(q.from, 1), tz); // what happened after the end of the first day
    const [accounts, entries, moved] = await Promise.all([this.repo.find('seller_accounts', {}), this.repo.bucketSumsSince(after, tz, Object.keys(TYPE_LABELS)), this.repo.lotsLeftPendingSince(after, tz)]);
    const changes = new Map<string, { pending: number; available: number; held: number; moved: number }>(); // "<seller>|<day>"
    const changeOf = (sellerId: string, day: string) => {
      const key = `${sellerId}|${day}`;
      let v = changes.get(key);
      if (!v) changes.set(key, (v = { pending: 0, available: 0, held: 0, moved: 0 }));
      return v;
    };
    for (const e of entries) {
      const v = changeOf(e.sellerId, e.day);
      if (e.bucket === 'pending') v.pending += e.amount;
      else if (e.bucket === 'held') v.held += e.amount;
      else v.available += e.amount;
    }
    for (const m of moved) changeOf(m.sellerId, m.day).moved += m.amount;
    const out: { day: string; sellerId: string; pending: common.Money; available: common.Money; held: common.Money; owed: common.Money }[] = [];
    for (const a of accounts) {
      let { pending, available, held } = a;
      for (let day = today; day >= q.from; day = addDays(day, -1)) {
        if (day <= to && (pending || available || held)) out.push({ day, sellerId: a.seller_id, pending: this.money(pending), available: this.money(available), held: this.money(held), owed: this.money(Math.max(0, -available)) });
        // the end of the day before: undo this day's entries and moves
        const v = changes.get(`${a.seller_id}|${day}`);
        if (!v) continue;
        pending += v.moved - v.pending;
        available -= v.moved + v.available;
        held -= v.held;
      }
    }
    return out.sort((x, y) => x.day.localeCompare(y.day) || x.sellerId.localeCompare(y.sellerId));
  }

  /** Credits of ad charges (charge_credit on an ad campaign) in a range */
  async adCredits(from: Date, to: Date, sellerId?: string) {
    return this.repo.findInRange('ledger_entries', 'at', from, to, { type: 'charge_credit', ref_kind: 'ad_campaign', ...(sellerId ? { seller_id: sellerId } : {}) });
  }

  /* ---------------------------------------------------------------- company trading */

  /**
   * The Official Store trading of a range, by booking day. The margin takes off the cost of goods sold (cost_of_goods,
   * booked with each sale and reversed with cancellations), never buying_cost: purchasing books that when goods are
   * received from a supplier, so it is stock bought (stockBought) and a goods receipt leaves the margin alone.
   * A sale is costed when a cost_of_goods row sits beside it (same ref_kind, ref_id and order_item_id); the others
   * are uncostedSales and count in the margin with no cost. A placeholder still waiting for its cost (ref_kind
   * cost_pending) pairs with nothing, so its sale shows as uncosted until LedgerPart.fillPendingCosts fills it.
   */
  async trading(q: { from: string; to: string }): Promise<TradingSummary> {
    const r = this.range(q.from, q.to);
    const tz = this.core.tz();
    const rows = await this.tradingRows(r.from, r.to); // Official Store trading only (marketplace facts have their own tables)
    const totals = (list: TradingRec[]) => {
      const s = (k: string) => list.filter((t) => t.kind === k).reduce((x, t) => x + t.amount, 0);
      const pair = (t: TradingRec) => `${t.ref_kind}|${t.ref_id}|${t.order_item_id}`;
      const costed = new Set(list.filter((t) => t.kind === 'cost_of_goods').map(pair));
      const uncosted = list.filter((t) => t.kind === 'sale' && !costed.has(pair(t))).reduce((x, t) => x + t.amount, 0);
      const sales = s('sale');
      const cogs = s('cost_of_goods');
      const gross = sales - cogs;
      const net = gross - s('discount') - s('shipping_expense') - s('return') - s('write_off') - s('chargeback_loss') + s('supplier_credit');
      return { sales, cogs, uncosted, stockBought: s('buying_cost'), gross, discounts: s('discount'), shipping: s('shipping_expense'), returns: s('return'), writeOffs: s('write_off'), chargebacks: s('chargeback_loss'), net };
    };
    const t = totals(rows);
    const priorFrom = addDays(q.from, -r.days);
    const prior = totals(await this.tradingRows(dayStart(priorFrom, tz), r.from));
    const daily = new Map<string, { sales: number; margin: number }>();
    for (let d = q.from; d <= q.to; d = addDays(d, 1)) daily.set(d, { sales: 0, margin: 0 });
    for (const row of rows) {
      const d = daily.get(marketDate(row.at, tz));
      if (!d) continue;
      if (row.kind === 'sale') {
        d.sales += row.amount;
        d.margin += row.amount;
      } else if (row.kind === 'cost_of_goods') d.margin -= row.amount;
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
      costBasis: 'weighted average buying cost when the order was accepted',
      productSales: this.money(t.sales),
      costOfGoodsSold: this.money(t.cogs),
      uncostedSales: this.money(t.uncosted),
      stockBought: this.money(t.stockBought),
      buyingCost: this.money(t.cogs), // deprecated: the old name of costOfGoodsSold
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

  /**
   * The admin seller list: filtered, sorted (most recently changed first) and paged in the database
   * (repo.sellerAccountsPage); only the page's rows are then looked up (names, amounts owed, destinations, last payout).
   * The search asks sellers for matching sellers first (its search, at most 100) and lists their accounts.
   */
  async sellerRows(f: { q?: string | null; filter?: string | null }, page: PageRequest): Promise<common.Page<SellerFinanceRow>> {
    const q = f.q?.trim();
    let sellerIds: string[] | undefined;
    if (q) {
      const found = await this.core.optionalDep(() => this.ctx.use('sellers').searchSellers({ search: q }, { limit: 100 }));
      sellerIds = [...(found?.items ?? []).map((s) => s.id), q]; // q itself may be a seller id
    }
    const paged = await this.repo.sellerAccountsPage({ sellerIds, filter: f.filter }, page);
    const ids = paged.items.map((a) => a.seller_id);
    const [names, minimum, last, dests, owed] = await Promise.all([
      this.core.sellerInfo(ids),
      this.core.num('minimumPayout', 2500),
      this.repo.lastPayouts(ids),
      this.core.destinationStatuses(ids),
      ids.length ? this.repo.find('amounts_owed', { status: 'open', seller_id: ids }) : [],
    ]);
    const owedBySeller = new Map<string, number>();
    for (const o of owed) owedBySeller.set(o.seller_id, (owedBySeller.get(o.seller_id) ?? 0) + o.remaining);
    const items = paged.items.map((a): SellerFinanceRow => {
      const o = owedBySeller.get(a.seller_id) ?? 0;
      return { sellerId: a.seller_id, sellerName: names.get(a.seller_id)?.name ?? 'Seller', pending: this.money(a.pending), available: this.money(a.available), held: this.money(a.held), negative: a.available < 0, owed: o ? this.money(o) : null, nextPayout: a.available >= minimum ? this.money(a.available) : null, destination: dests.get(a.seller_id)!, lastPayoutStatus: last.get(a.seller_id)?.status ?? null };
    });
    return { ...paged, items };
  }

  async sellerDetail(sellerId: string): Promise<SellerFinanceDetail> {
    const [balances, payouts, holds, owed, adjustments, acct] = await Promise.all([
      this.parts.ledger.balances(sellerId),
      this.repo.find('payouts', { seller_id: sellerId }, { orderBy: [['requested_on', 'desc']], limit: 5 }),
      this.repo.find('holds', { seller_id: sellerId, status: 'active' }, { orderBy: [['review_date', 'asc']] }),
      this.repo.find('amounts_owed', { seller_id: sellerId, status: 'open' }),
      this.repo.find('adjustments', { seller_id: sellerId }, { orderBy: [['created_at', 'desc']], limit: 10 }),
      this.repo.findOne('seller_accounts', { seller_id: sellerId }),
    ]);
    const rule = await this.core.ruleAt(this.now(), acct?.fee_override_set_id);
    const name = balances.holds[0]?.sellerName ?? (await this.core.sellerName(sellerId));
    const approvals = await this.core.approvalInfos(owed.map((o) => o.approval_request_id));
    return {
      balances,
      recentPayouts: await this.parts.payouts.payoutViews(payouts),
      openHolds: await this.parts.holds.holdViews(holds),
      owed: owed.map((o) => toOwed(o, name, approvals)),
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
      { key: OVERVIEW_DATASET as reports.ExportDataset['key'], owner: 'finance', title: 'Finance overview', permission: 'finance.ledger.view', columns: [{ key: 'figure', label: 'Figure' }, { key: 'value', label: 'Amount' }, { key: 'count', label: 'Count' }], audience: 'staff', screens: ['admin/finance'], available: true, phase: 1 },
      { key: 'finance.admin.checks', owner: 'finance', title: 'Finance checks', permission: 'finance.reconciliation.work', columns: [{ key: 'date', label: 'Date' }, { key: 'check', label: 'Check' }, { key: 'subject', label: 'Subject' }, { key: 'expected', label: 'Expected' }, { key: 'actual', label: 'Actual' }, { key: 'credit', label: 'Store credit' }, { key: 'difference', label: 'Difference' }, { key: 'status', label: 'Status' }], audience: 'staff', screens: ['ops/finance-checks'], available: true, phase: 1 },
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
    if (!isIsoDate(body.from) || !isIsoDate(body.to) || body.to < body.from) throw invalid([{ path: 'to', message: 'A date range: from on or before to' }]);
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
      // keyset cursor: the (at, id) of the last row written ("<iso>|<id>")
      const [afterAt, afterId] = cursor?.split('|') ?? [];
      const rows = await this.repo.ledgerBatch({
        sellerId,
        from: f.from && isIsoDate(f.from) ? dayStart(f.from, tz) : undefined,
        to: f.to && isIsoDate(f.to) ? dayStart(addDays(f.to, 1), tz) : undefined,
        after: afterAt && afterId ? { at: new Date(afterAt), id: afterId } : undefined,
        limit: limit + 1,
      });
      const batch = rows.slice(0, limit);
      const names = dataset === 'finance.admin.ledger' ? await this.core.sellerInfo(batch.map((r) => r.seller_id)) : new Map();
      const out = batch.map((r) => ({ ...(dataset === 'finance.admin.ledger' ? { seller: names.get(r.seller_id)?.name ?? r.seller_id } : {}), date: marketDate(r.at, tz), type: TYPE_LABELS[r.type as EntryType] ?? r.type, reference: r.ref_label ?? r.ref_id, description: r.description, amount: money(r.amount), balanceAfter: money(r.balance_after) }));
      const last = batch.at(-1);
      return { rows: out, ...(rows.length > limit && last ? { nextCursor: `${last.at.toISOString()}|${last.id}` } : {}) };
    }
    if (principal.kind !== 'staff') throw new AppError('FORBIDDEN', 'Staff only');
    if (dataset === 'finance.admin.payout_run') {
      const rows = await this.repo.find('payouts', f.runId ? { run_id: f.runId } : {}, { orderBy: [['requested_on', 'desc'], ['id', 'asc']], offset, limit: limit + 1 });
      const names = await this.core.sellerInfo(rows.map((r) => r.seller_id));
      return { rows: rows.slice(0, limit).map((r) => ({ payout: r.ref, seller: names.get(r.seller_id)?.name ?? r.seller_id, amount: money(r.amount), status: r.status, failure: r.failure_reason ?? '' })), ...(rows.length > limit ? { nextCursor: String(offset + limit) } : {}) };
    }
    if (dataset === OVERVIEW_DATASET) return { rows: await this.overviewRows(f as { from?: string; to?: string; basis?: string }) };
    const rows = await this.repo.find('recon_items', f.date && isIsoDate(f.date) ? { date: f.date } : {}, { orderBy: [['detected_at', 'desc'], ['id', 'asc']], offset, limit: limit + 1 });
    return { rows: rows.slice(0, limit).map((r) => ({ date: r.date, check: r.check, subject: r.subject, expected: money(r.expected), actual: money(r.actual), credit: money(r.credit), difference: money(r.difference), status: r.status })), ...(rows.length > limit ? { nextCursor: String(offset + limit) } : {}) };
  }

  /** G72: the finance overview of a range as one row per figure (the range defaults to the last 30 market days) */
  async overviewRows(f: { from?: string; to?: string; basis?: string }): Promise<{ figure: string; value: string; count: string }[]> {
    const to = f.to && isIsoDate(f.to) ? f.to : this.core.today();
    const from = f.from && isIsoDate(f.from) ? f.from : addDays(to, -29);
    const o = await this.overview({ from, to, basis: f.basis === 'order_date' ? 'order_date' : 'payment_date' });
    const amount = (m: common.Money) => (m.amount / 100).toFixed(2);
    const row = (figure: string, value: common.Money | null, count?: number | null) => ({ figure, value: value ? amount(value) : '', count: count === undefined || count === null ? '' : String(count) });
    return [
      row(`Range ${from} to ${to} (${o.basis})`, null),
      row('Collected payments', o.collectedPayments, o.collectedCount),
      row('Official Store sales', o.companySales),
      row('Seller sales', o.sellerSales),
      row('Shipping collected', o.shippingCollected),
      row('Marketplace fee income', o.marketplaceFeeIncome),
      row('Seller earnings', o.sellerEarnings),
      row('Owed to sellers', o.owedToSellers),
      row('Owed to sellers, pending', o.owedPending),
      row('Owed to sellers, available', o.owedAvailable),
      row('Refunds sent', o.refundsSent, o.refundsSentCount),
      row('Refunds failing', null, o.refundsFailing),
      row('Held', o.holds, o.holdSellers),
      row(`Paid out${o.lastRunRef ? ` (last run ${o.lastRunRef})` : ''}`, o.paidOut),
      row('Discounts: platform coupons', o.discountFunding.platformCoupons),
      row('Discounts: seller markdowns', o.discountFunding.sellerMarkdowns),
      row('Discounts: shared campaigns', o.discountFunding.sharedCampaigns),
      row('Discounts: total', o.discountFunding.total),
      row('Checks: unexplained amounts', null, o.queueCounts.unexplained),
      row('Checks: mismatches', null, o.queueCounts.mismatches),
      row('Failed payouts', null, o.queueCounts.failedPayouts),
    ];
  }
}
