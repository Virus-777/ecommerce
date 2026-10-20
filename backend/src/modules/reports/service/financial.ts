/**
 * The financial statistics reports (docs/09 §3.3): a seller's Earnings and profit and Profit by product, and the
 * staff's Platform income, Seller balances and payouts and Official Store profit and loss. They read the order
 * facts (fact_order_items: order date) and the finance facts pulled every 15 minutes (fact_marketplace_finance_daily,
 * fact_company_daily, fact_seller_balances_daily: booking date).
 *
 * A seller's unit costs (fact_order_items.buying_cost_minor on seller rows) are private: only the two seller reports
 * read them, always for the caller's own seller. Every staff report here reads company figures only.
 *
 * Waterfall breakdowns (key `waterfall`) list { key, label, amount, step }: `start` and `total` rows hold the signed
 * value; `plus` and `minus` rows hold the amount added or taken away, never negative (a negative effect is a minus).
 */
import type { Money } from '../../../spec/common.js';
import type { KpiValue } from '../../../spec/reports.js';
import { metricSeed } from '../domain/catalogue.js';
import { addDays, bucketsOf, dayLabel, displayMoney, marketDay, pct, type DayRange, type Granularity } from '../domain/rules.js';
import type { SalesAgg } from '../ports.js';
import type { ReportsCore, Settings } from './core.js';
import { BASIS_LABEL, col, emptyAgg, grossMarginOf, humanize, zeros, type Callout, type Part, type Queries, type ReportScope, type ResolvedQuery, type TableColumn } from './queries.js';

type Figures = Record<string, number>;

/** A metric's name from the catalogue (series labels, table columns) */
const nameOf = (key: string) => metricSeed(key)?.name ?? key;
/** seller.item_sales → item_sales: table column keys */
const suffix = (key: string) => key.slice(key.indexOf('.') + 1);
const unitOf = (key: string) => metricSeed(key)?.unit ?? 'money';

/* ---------------------------------------------------------------- seller: Earnings and profit */

/** The series and KPIs of Earnings and profit, in order (the KPI row adds seller.cost_coverage_pct) */
const EARNINGS_KEYS = ['seller.item_sales', 'seller.shipping_charged', 'seller.refunds', 'seller.fees', 'seller.ad_spend', 'seller.service_fees', 'seller.label_charges', 'seller.adjustments', 'seller.net_earnings', 'seller.product_cost', 'seller.profit', 'seller.margin_pct', 'seller.paid_out'];
/** The charge-date columns Earnings and profit reads from fact_marketplace_finance_daily */
const SELLER_FIN_COLS = ['ad_charges_minor', 'service_fees_minor', 'label_charges_minor', 'adjustments_minor', 'chargebacks_minor', 'payouts_paid_minor'];

/**
 * A seller's earnings figures from its order facts (order date) and its finance facts (charge date). Item sales
 * include Marketly-funded discounts (finance pays them to the seller with the sale); refunds are the item value
 * cancelled or refunded on those orders so far; fees are net of fee refunds. Profit is net earnings less the product
 * cost of the sales that have a cost; margin divides it by all item sales (docs/09 §3.3).
 */
function earningsFigures(s: SalesAgg, f: Record<string, number | null>): Figures {
  const n = (k: string) => f[k] ?? 0;
  const itemSales = s.gross + s.platformDiscount;
  const refunds = s.cancelled + s.refunded;
  const adjustments = n('adjustments_minor') - n('chargebacks_minor');
  const netEarnings = itemSales + s.shipping - refunds - s.fee - n('ad_charges_minor') - n('service_fees_minor') - n('label_charges_minor') + adjustments;
  const costedItemSales = s.costedSales + s.costedPlatformDiscount;
  const profit = netEarnings - s.cost;
  return {
    'seller.item_sales': itemSales,
    'seller.shipping_charged': s.shipping,
    'seller.refunds': refunds,
    'seller.fees': s.fee,
    'seller.ad_spend': n('ad_charges_minor'),
    'seller.service_fees': n('service_fees_minor'),
    'seller.label_charges': n('label_charges_minor'),
    'seller.adjustments': adjustments,
    'seller.net_earnings': netEarnings,
    'seller.product_cost': s.cost,
    'seller.profit': profit,
    // profit here keeps the earnings of sales without a cost, so it is divided by all item sales (dividing by the
    // costed sales alone gave margins over 100 %); the coverage KPI says how much of it has a cost
    'seller.margin_pct': costedItemSales > 0 ? pct(profit, itemSales) : 0,
    'seller.paid_out': n('payouts_paid_minor'),
    'seller.cost_coverage_pct': pct(costedItemSales, itemSales),
    costedItemSales,
  };
}

/* ---------------------------------------------------------------- staff: Platform income */

const PLATFORM_KEYS = ['platform.fee_income_gross', 'platform.fee_refunds', 'platform.fee_income_net', 'platform.ad_income', 'platform.service_fees', 'platform.label_income', 'platform.discount_funding', 'platform.costs', 'platform.net_income', 'platform.official_net_margin', 'platform.company_result'];
const PLATFORM_FIN_COLS = ['fee_gross_minor', 'fee_refunds_minor', 'ad_charges_minor', 'service_fees_minor', 'label_charges_minor'];

type CompanyRow = { source: string; kind: string; amount: number };
const sumOf = (rows: CompanyRow[], source: string, kind?: string) => rows.filter((r) => r.source === source && (!kind || r.kind === kind)).reduce((n, r) => n + r.amount, 0);

/**
 * The Official Store profit and loss of a period, from two sources:
 * - sales, cost of goods sold and gross margin from the order facts (order date), exactly as the Official Store
 *   margin report (trading.margin) counts them: item value after customer discounts (tax added when prices include
 *   it), the unit cost at sale × quantity, and the margin of the rows that have a cost. Like trading.margin,
 *   cancellations and refunds on those orders are not taken off sales or cost here.
 * - the other lines from finance's trading entries (fact_company_daily, source trading; booking day).
 *
 * finance books `buying_cost` when stock is received from a supplier: that is stock bought, not the cost of what was
 * sold, so it shows as trading.stock_bought and is not taken off the margin. finance's `discount` lines are shown but
 * not taken off either, because the sales above are already after customer discounts. finance's `cost_of_goods` lines
 * (the cost it books with each Official Store sale, for GET /api/admin/finance/trading) are ignored here on purpose:
 * the cost of goods sold comes from the order facts above, and taking finance's too would count it twice.
 * `sales` is the shown Official Store sales figure (Queries.gross: tax included when prices include it).
 */
function tradingFigures(sales: number, s: SalesAgg, rows: CompanyRow[]): Figures {
  const t = (kind: string) => sumOf(rows, 'trading', kind);
  const gross = grossMarginOf(s);
  const net = gross - t('shipping_expense') - t('return') - t('write_off') - t('chargeback_loss') + t('supplier_credit');
  return {
    'trading.official_sales': sales,
    'trading.buying_cost': s.cost,
    'trading.gross_margin': gross,
    'trading.discounts': t('discount'),
    'trading.shipping_expense': t('shipping_expense'),
    'trading.returns_cost': t('return'),
    'trading.write_offs': t('write_off'),
    'trading.chargeback_losses': t('chargeback_loss'),
    'trading.supplier_credits': t('supplier_credit'),
    'trading.net_margin': net,
    // over the sales that have a cost, like Gross margin %: the margin leaves the others out
    'trading.net_margin_pct': pct(net, s.costedSales),
    'trading.stock_bought': t('buying_cost'),
    // the part of sales the margin leaves out: sales without a unit cost (and tax when prices include it)
    notInMargin: sales - s.cost - gross,
    salesWithoutCost: s.gross - s.costedSales,
    salesWithoutCostPct: pct(s.gross - s.costedSales, s.gross),
  };
}

/** The marketplace income statement of a period from the finance facts (booking date), plus the Official Store net margin (tradingFigures) */
function platformFigures(fin: Record<string, number | null>, company: CompanyRow[], official: number): Figures {
  const n = (k: string) => fin[k] ?? 0;
  const feeNet = n('fee_gross_minor') - n('fee_refunds_minor');
  const discountFunding = -sumOf(company, 'discount_funding', 'platform');
  const costs = sumOf(company, 'platform_cost');
  const netIncome = feeNet + n('ad_charges_minor') + n('service_fees_minor') + n('label_charges_minor') + discountFunding - costs;
  return {
    'platform.fee_income_gross': n('fee_gross_minor'),
    'platform.fee_refunds': n('fee_refunds_minor'),
    'platform.fee_income_net': feeNet,
    'platform.ad_income': n('ad_charges_minor'),
    'platform.service_fees': n('service_fees_minor'),
    'platform.label_income': n('label_charges_minor'),
    'platform.discount_funding': discountFunding,
    'platform.costs': costs,
    'platform.net_income': netIncome,
    'platform.official_net_margin': official,
    'platform.company_result': netIncome + official,
  };
}

const TRADING_KEYS = ['trading.official_sales', 'trading.buying_cost', 'trading.gross_margin', 'trading.discounts', 'trading.shipping_expense', 'trading.returns_cost', 'trading.write_offs', 'trading.chargeback_losses', 'trading.net_margin', 'trading.net_margin_pct'];
/** The P&L lines read from finance's trading entries (booking day): unavailable while finance is off */
const TRADING_BOOKED_KEYS = ['trading.discounts', 'trading.shipping_expense', 'trading.returns_cost', 'trading.write_offs', 'trading.chargeback_losses', 'trading.supplier_credits', 'trading.stock_bought', 'trading.net_margin', 'trading.net_margin_pct'];

/* ---------------------------------------------------------------- staff: Seller balances and payouts */

const SELLER_MONEY_BALANCES = ['sellers.owed', 'sellers.held', 'sellers.negative', 'sellers.negative_count'];
const SELLER_MONEY_FLOWS = ['sellers.payouts_paid', 'sellers.payouts_failed'];

export class FinancialReports {
  constructor(
    private readonly core: ReportsCore,
    private readonly q: Queries,
  ) {}

  /* ---------------------------------------------------------------- shared pieces */

  private kpis(keys: string[], now: Figures, prev: Figures | null, currency: string, notes: Record<string, string | null> = {}): KpiValue[] {
    return keys.map((k) => this.q.kpi(k, now[k] ?? 0, currency, prev ? (prev[k] ?? 0) : null, notes[k] ?? null));
  }

  /** One series per key over the buckets of the range */
  private seriesOf(keys: string[], buckets: string[], g: Granularity, byBucket: Map<string, Figures>) {
    return keys.map((k) => this.q.series(k, nameOf(k), buckets, g, new Map(buckets.map((b) => [b, byBucket.get(b)?.[k] ?? 0]))));
  }

  /** One row per period with every key as a column (column key: the metric key after the dot), and the totals (money as Money, other units as numbers) */
  private periodTable(keys: string[], buckets: string[], g: Granularity, byBucket: Map<string, Figures>, total: Figures, currency: string) {
    const cell = (k: string, v: number) => (unitOf(k) === 'money' ? this.q.money(v, currency) : v);
    const columns: TableColumn[] = [col('period', 'Period'), ...keys.map((k) => col(suffix(k), nameOf(k), unitOf(k)))];
    return {
      columns,
      rows: buckets.map((b) => ({ period: b, label: dayLabel(b, g), ...Object.fromEntries(keys.map((k) => [suffix(k), cell(k, byBucket.get(b)?.[k] ?? 0)])) })),
      totals: Object.fromEntries(keys.map((k) => [suffix(k), cell(k, total[k] ?? 0)])),
    };
  }

  /** A waterfall row: start and total rows signed; plus and minus rows the amount added or taken away */
  private step(key: string, label: string, value: number, currency: string, kind?: 'start' | 'total') {
    if (kind) return { key, label, amount: this.q.money(value, currency), step: kind };
    return { key, label, amount: this.q.money(Math.abs(value), currency), step: value < 0 ? 'minus' : 'plus' };
  }

  /** When the finance facts were last pulled (meta.freshAsOf of the reports built on them) */
  private async financePulledAt(): Promise<string | undefined> {
    return (await this.core.repo.getCheckpoint('pull:finance_recent'))?.last_event_at?.toISOString();
  }

  /* ---------------------------------------------------------------- seller.earnings */

  async sellerEarnings(rq: ResolvedQuery, scope: ReportScope): Promise<Part> {
    if (scope.kind !== 'seller') throw new Error('seller.earnings runs for a seller');
    const c = rq.currency;
    const sellerId = scope.sellerId;
    const totals = async (range: DayRange) => {
      const [sales] = await this.core.repo.salesAgg(this.q.salesFilter(rq, scope, range), 'none');
      const [fin] = await this.core.repo.dailySums('fact_marketplace_finance_daily', { from: range.from, to: range.to, sellerId }, SELLER_FIN_COLS, 'none');
      return earningsFigures(sales ?? emptyAgg(), fin ?? zeros(SELLER_FIN_COLS));
    };
    const [now, prev, salesBuckets, finBuckets] = await Promise.all([
      totals(rq.range),
      rq.compare ? totals(rq.compare) : null,
      this.core.repo.salesAgg(this.q.salesFilter(rq, scope, rq.range), 'bucket', rq.granularity),
      this.core.repo.dailySums('fact_marketplace_finance_daily', { from: rq.range.from, to: rq.range.to, sellerId }, SELLER_FIN_COLS, 'bucket', rq.granularity),
    ]);
    const buckets = bucketsOf(rq.range, rq.granularity);
    const salesAt = new Map(salesBuckets.map((b) => [b.key!, b]));
    const finAt = new Map(finBuckets.map((b) => [b.key!, b]));
    const byBucket = new Map(buckets.map((b) => [b, earningsFigures(salesAt.get(b) ?? emptyAgg(), finAt.get(b) ?? zeros(SELLER_FIN_COLS))]));
    const withoutCost = now['seller.item_sales']! - now.costedItemSales!;
    const callouts: Callout[] = [
      { kind: 'info', title: 'Two dates', body: 'Item sales, shipping, refunds, fees and product cost follow the order date: the orders of the period, with the refunds on them so far. Ad spend, service fees, labels, adjustments and payouts follow the day they were charged or paid.' },
    ];
    if (withoutCost > 0) callouts.push({ kind: 'warning', title: 'Some sales have no unit cost', body: `${displayMoney(withoutCost, c)} of item sales has no unit cost on its offer. Profit takes off the cost of the sales that have one; set unit costs on your offers to complete it.` });
    const waterfall = [
      this.step('seller.item_sales', nameOf('seller.item_sales'), now['seller.item_sales']!, c, 'start'),
      this.step('seller.shipping_charged', nameOf('seller.shipping_charged'), now['seller.shipping_charged']!, c),
      this.step('seller.refunds', nameOf('seller.refunds'), -now['seller.refunds']!, c),
      this.step('seller.fees', nameOf('seller.fees'), -now['seller.fees']!, c),
      this.step('seller.ad_spend', nameOf('seller.ad_spend'), -now['seller.ad_spend']!, c),
      this.step('seller.service_fees', nameOf('seller.service_fees'), -now['seller.service_fees']!, c),
      this.step('seller.label_charges', nameOf('seller.label_charges'), -now['seller.label_charges']!, c),
      this.step('seller.adjustments', nameOf('seller.adjustments'), now['seller.adjustments']!, c),
      this.step('seller.net_earnings', nameOf('seller.net_earnings'), now['seller.net_earnings']!, c, 'total'),
      this.step('seller.product_cost', nameOf('seller.product_cost'), -now['seller.product_cost']!, c),
      this.step('seller.profit', nameOf('seller.profit'), now['seller.profit']!, c, 'total'),
    ];
    const feeKeys = ['seller.fees', 'seller.ad_spend', 'seller.service_fees', 'seller.label_charges'];
    const feeTotal = feeKeys.reduce((n, k) => n + Math.max(0, now[k]!), 0);
    return {
      kpis: this.kpis([...EARNINGS_KEYS, 'seller.cost_coverage_pct'], now, prev, c, { 'seller.margin_pct': now.costedItemSales ? null : 'No unit costs set for the sales of this period', 'seller.adjustments': 'Credits, debits and payment disputes lost' }),
      series: this.seriesOf(EARNINGS_KEYS, buckets, rq.granularity, byBucket),
      breakdowns: [
        { key: 'waterfall', label: 'From item sales to profit', rows: waterfall },
        { key: 'fees_by_type', label: 'Fees and charges by type', rows: feeKeys.map((k) => ({ key: k, label: nameOf(k), amount: this.q.money(now[k]!, c), sharePct: pct(Math.max(0, now[k]!), feeTotal) })) },
      ],
      table: this.periodTable(EARNINGS_KEYS, buckets, rq.granularity, byBucket, now, c),
      callouts,
      unavailable: this.core.running('finance') ? [] : ['seller.fees', 'seller.label_charges', 'seller.adjustments', 'seller.paid_out'],
      models: ['order_items', 'marketplace_finance'],
    };
  }

  /* ---------------------------------------------------------------- seller.profit_by_product */

  async profitByProduct(rq: ResolvedQuery, scope: ReportScope): Promise<Part> {
    if (scope.kind !== 'seller') throw new Error('seller.profit_by_product runs for a seller');
    const c = rq.currency;
    const offers = await this.core.repo.offerProfitAgg(this.q.salesFilter(rq, scope, rq.range));
    const names = await this.q.productNames(offers.map((o) => o.productId));
    const unitCosts = await this.currentUnitCosts(offers.map((o) => o.offerId));
    const rows = offers.map((o) => {
      // profit over the sales with a cost: their item sales less their refunds, fees and cost
      const profit = o.costedRows ? o.costedItemSales - o.costedRefunds - o.costedFee - o.cost : null;
      return {
        productId: o.productId,
        product: names.get(o.productId) ?? o.productId,
        offerId: o.offerId,
        units: o.units,
        itemSales: this.q.money(o.itemSales, c),
        refunds: this.q.money(o.refunds, c),
        fees: this.q.money(o.fee, c),
        productCost: this.q.money(o.cost, c),
        profit: profit === null ? null : this.q.money(profit, c),
        marginPct: profit === null ? null : pct(profit, o.costedItemSales),
        costSet: o.costedRows === o.rows,
        unitCost: unitCosts.get(o.offerId) ?? null,
      };
    });
    const costed = offers.filter((o) => o.costedRows > 0);
    const profit = costed.reduce((n, o) => n + o.costedItemSales - o.costedRefunds - o.costedFee - o.cost, 0);
    const costedSales = costed.reduce((n, o) => n + o.costedItemSales, 0);
    const missing = offers.filter((o) => o.costedRows < o.rows);
    const salesWithoutCost = offers.reduce((n, o) => n + o.itemSales - o.costedItemSales, 0);
    const ranked = rows.filter((r) => r.profit !== null).sort((a, b) => b.profit!.amount - a.profit!.amount);
    const rank = (list: typeof rows) => list.map((r) => ({ key: r.offerId, label: r.product, productId: r.productId, amount: r.profit!, marginPct: r.marginPct }));
    const callouts: Callout[] = [{ kind: 'info', title: 'Profit per product', body: 'Item sales less refunds, marketplace fees and your product cost, for the sales that have a unit cost, by order date. Shipping, ad spend, service fees and labels are in Earnings and profit.' }];
    if (missing.length) callouts.push({ kind: 'warning', title: 'Products without a cost', body: `${missing.length} ${missing.length === 1 ? 'product has' : 'products have'} sales without a unit cost. Set unit costs on those offers (one by one or with a bulk update) to see their profit.` });
    const total = {
      'seller.profit': profit,
      'seller.margin_pct': pct(profit, costedSales),
      'seller.products_without_cost': missing.length,
      'seller.sales_without_cost': salesWithoutCost,
    };
    return {
      kpis: this.kpis(['seller.profit', 'seller.margin_pct', 'seller.products_without_cost', 'seller.sales_without_cost'], total, null, c),
      series: [],
      breakdowns: [
        { key: 'top_profit', label: 'Most profit', rows: rank(ranked.slice(0, 10)) },
        { key: 'lowest_profit', label: 'Least profit', rows: rank(ranked.slice(-10).reverse()) },
      ],
      table: {
        columns: [col('product', 'Product'), col('units', 'Units', 'count'), col('itemSales', 'Item sales', 'money'), col('refunds', 'Refunds', 'money'), col('fees', 'Fees', 'money'), col('productCost', 'Product cost', 'money'), col('profit', 'Profit', 'money'), col('marginPct', 'Margin', 'percent'), col('costSet', 'Cost set', 'bool'), col('unitCost', 'Unit cost now', 'money')],
        rows,
        totals: {
          units: offers.reduce((n, o) => n + o.units, 0),
          itemSales: this.q.money(offers.reduce((n, o) => n + o.itemSales, 0), c),
          refunds: this.q.money(offers.reduce((n, o) => n + o.refunds, 0), c),
          fees: this.q.money(offers.reduce((n, o) => n + o.fee, 0), c),
          productCost: this.q.money(offers.reduce((n, o) => n + o.cost, 0), c),
          profit: this.q.money(profit, c),
          marginPct: pct(profit, costedSales),
        },
      },
      callouts,
      unavailable: [],
      models: ['order_items'],
    };
  }

  /** The unit cost in effect now on each of the seller's offers (offers.unitCostsAt; empty while offers cannot answer) */
  private async currentUnitCosts(offerIds: string[]): Promise<Map<string, Money>> {
    const out = new Map<string, Money>();
    const offers = this.core.api('offers');
    if (!offers || !offerIds.length) return out;
    const at = this.core.now().toISOString();
    const costs = await this.core.soft('offers.unitCostsAt', () => offers.unitCostsAt(offerIds.map((offerId) => ({ offerId, at }))));
    offerIds.forEach((id, n) => {
      const cost = costs?.[n];
      if (cost) out.set(id, cost);
    });
    return out;
  }

  /* ---------------------------------------------------------------- finance.platform_income */

  async platformIncome(rq: ResolvedQuery): Promise<Part> {
    const c = rq.currency;
    const repo = this.core.repo;
    const cfg = await this.core.cfg();
    const totals = async (range: DayRange) => {
      const [[fin], company, [sales]] = await Promise.all([repo.dailySums('fact_marketplace_finance_daily', range, PLATFORM_FIN_COLS, 'none'), repo.companySums(range.from, range.to, 'none'), this.officialSales(rq, range, 'none')]);
      const s = sales ?? emptyAgg();
      const official = tradingFigures(this.q.gross(s, cfg), s, company);
      return { figures: platformFigures(fin ?? zeros(PLATFORM_FIN_COLS), company, official['trading.net_margin']!), company };
    };
    const platform = { kind: 'platform' } as const;
    const [now, prev, finBuckets, companyBuckets, byCategory, bySeller] = await Promise.all([
      totals(rq.range),
      rq.compare ? totals(rq.compare) : null,
      repo.dailySums('fact_marketplace_finance_daily', rq.range, PLATFORM_FIN_COLS, 'bucket', rq.granularity),
      repo.companySums(rq.range.from, rq.range.to, 'bucket', rq.granularity),
      // fees on the orders of the period: the only per-category figure (order date)
      repo.salesAgg(this.q.salesFilter(rq, platform, rq.range, { ownerType: 'seller', basis: 'placed_at' }), 'category_id'),
      repo.dailySums('fact_marketplace_finance_daily', rq.range, ['fee_gross_minor', 'fee_refunds_minor'], 'seller_id'),
    ]);
    const f = now.figures;
    const buckets = bucketsOf(rq.range, rq.granularity);
    const finAt = new Map(finBuckets.map((b) => [b.key!, b]));
    const official = await this.tradingByBucket(rq, cfg, companyBuckets);
    const byBucket = new Map(buckets.map((b) => [b, platformFigures(finAt.get(b) ?? zeros(PLATFORM_FIN_COLS), companyBuckets.filter((r) => r.key === b), official.get(b)!['trading.net_margin']!)]));
    // costs by kind
    const costKinds = now.company.filter((r) => r.source === 'platform_cost' && r.amount !== 0).sort((a, b) => b.amount - a.amount);
    // fee income by category (order date): category names from catalog
    const categories = byCategory.filter((r) => r.fee !== 0).sort((a, b) => b.fee - a.fee);
    const catalog = this.core.api('catalog');
    const ids = categories.map((r) => r.key).filter((k): k is string => Boolean(k));
    const paths = catalog && ids.length ? ((await this.core.soft('catalog.getCategoryPaths', () => catalog.getCategoryPaths(ids))) ?? {}) : {};
    const categoryFees = categories.reduce((n, r) => n + r.fee, 0);
    // top sellers by fee income (booking date)
    const sellers = bySeller.map((r) => ({ id: r.key!, fee: r.fee_gross_minor! - r.fee_refunds_minor! })).filter((r) => r.id && r.fee !== 0).sort((a, b) => b.fee - a.fee).slice(0, 10);
    const names = await this.q.sellerNames(sellers.map((s) => s.id));
    const waterfall = [
      this.step('platform.fee_income_gross', nameOf('platform.fee_income_gross'), f['platform.fee_income_gross']!, c, 'start'),
      this.step('platform.fee_refunds', nameOf('platform.fee_refunds'), -f['platform.fee_refunds']!, c),
      this.step('platform.ad_income', nameOf('platform.ad_income'), f['platform.ad_income']!, c),
      this.step('platform.service_fees', nameOf('platform.service_fees'), f['platform.service_fees']!, c),
      this.step('platform.label_income', nameOf('platform.label_income'), f['platform.label_income']!, c),
      this.step('platform.discount_funding', nameOf('platform.discount_funding'), f['platform.discount_funding']!, c),
      this.step('platform.costs', nameOf('platform.costs'), -f['platform.costs']!, c),
      this.step('platform.net_income', nameOf('platform.net_income'), f['platform.net_income']!, c, 'total'),
      this.step('platform.official_net_margin', nameOf('platform.official_net_margin'), f['platform.official_net_margin']!, c),
      this.step('platform.company_result', nameOf('platform.company_result'), f['platform.company_result']!, c, 'total'),
    ];
    const costTotal = costKinds.reduce((n, r) => n + Math.max(0, r.amount), 0);
    const sellerTotal = sellers.reduce((n, s) => n + Math.max(0, s.fee), 0);
    return {
      kpis: this.kpis(PLATFORM_KEYS, f, prev?.figures ?? null, c),
      series: this.seriesOf(PLATFORM_KEYS, buckets, rq.granularity, byBucket),
      breakdowns: [
        { key: 'waterfall', label: 'From fee income to the company result', rows: waterfall },
        { key: 'costs_by_kind', label: 'Platform costs by kind', rows: costKinds.map((r) => ({ key: r.kind, label: humanize(r.kind), amount: this.q.money(r.amount, c), sharePct: pct(Math.max(0, r.amount), costTotal) })) },
        { key: 'fee_income_by_category', label: 'Fee income by category (order date)', rows: categories.map((r) => ({ key: r.key, label: r.key ? (paths[r.key]?.names.join(' › ') ?? 'Category') : 'No category', amount: this.q.money(r.fee, c), sharePct: pct(Math.max(0, r.fee), categoryFees) })) },
        { key: 'fee_income_by_seller', label: 'Top sellers by fee income', rows: sellers.map((s) => ({ key: s.id, label: names.get(s.id) ?? s.id, amount: this.q.money(s.fee, c), sharePct: pct(Math.max(0, s.fee), sellerTotal) })) },
      ],
      table: this.periodTable(PLATFORM_KEYS, buckets, rq.granularity, byBucket, f, c),
      callouts: [
        { kind: 'info', title: 'By booking day', body: `Marketplace figures count on the day finance booked them, so fee income shows the same day. Two exceptions: fee income by category follows the order date (the fees on the orders of the period, net of fee refunds so far), and the Official Store net margin takes its sales and cost of goods sold by ${BASIS_LABEL[rq.basis]}, as Official Store profit and loss does. Stock bought from suppliers is not taken off it.` },
        { kind: 'info', title: 'Not included yet', body: 'Tax collected and store credit owed to customers are not part of this statement.' },
      ],
      unavailable: this.core.running('finance') ? [] : PLATFORM_KEYS,
      models: ['marketplace_finance', 'company_finance', 'order_items'],
      freshAsOf: await this.financePulledAt(),
    };
  }

  /* ---------------------------------------------------------------- finance.seller_money */

  async sellerMoney(rq: ResolvedQuery): Promise<Part> {
    const c = rq.currency;
    const repo = this.core.repo;
    const sellerId = rq.sellerId;
    const today = marketDay(this.core.now(), (await this.core.cfg()).timeZone);
    const lastDay = (range: DayRange) => (range.to < today ? range.to : today);
    const flows = async (range: DayRange) => (await repo.dailySums('fact_marketplace_finance_daily', { ...range, ...(sellerId ? { sellerId } : {}) }, ['payouts_paid_minor', 'payouts_failed'], 'none'))[0] ?? zeros(['payouts_paid_minor', 'payouts_failed']);
    const balancesOf = async (days: string[]) => new Map((await repo.balanceTotals(days, sellerId)).map((r) => [r.day, r]));
    const figures = (b: { owed: number; held: number; negative: number; negativeCount: number } | undefined, fl: Record<string, number | null>): Figures => ({
      'sellers.owed': b?.owed ?? 0,
      'sellers.held': b?.held ?? 0,
      'sellers.negative': b?.negative ?? 0,
      'sellers.negative_count': b?.negativeCount ?? 0,
      'sellers.payouts_paid': fl.payouts_paid_minor ?? 0,
      'sellers.payouts_failed': fl.payouts_failed ?? 0,
    });
    // balances are end-of-day values: each bucket shows its last day (in the range, not after today)
    const buckets = bucketsOf(rq.range, rq.granularity);
    const ends = buckets.map((_bucket, i) => {
      const end = i < buckets.length - 1 ? addDays(buckets[i + 1]!, -1) : rq.range.to;
      return end < today ? end : today;
    });
    const [balances, prevBalances, nowFlows, prevFlows, flowBuckets] = await Promise.all([
      balancesOf([...new Set([...ends, lastDay(rq.range)])]),
      rq.compare ? balancesOf([lastDay(rq.compare)]) : null,
      flows(rq.range),
      rq.compare ? flows(rq.compare) : null,
      repo.dailySums('fact_marketplace_finance_daily', { ...rq.range, ...(sellerId ? { sellerId } : {}) }, ['payouts_paid_minor', 'payouts_failed'], 'bucket', rq.granularity),
    ]);
    const flowsAt = new Map(flowBuckets.map((b) => [b.key!, b]));
    const byBucket = new Map(buckets.map((b, i) => [b, figures(ends[i]! >= b ? balances.get(ends[i]!) : undefined, flowsAt.get(b) ?? {})]));
    const now = figures(balances.get(lastDay(rq.range)), nowFlows);
    const prev = rq.compare && prevBalances && prevFlows ? figures(prevBalances.get(lastDay(rq.compare)), prevFlows) : null;
    // top 20 sellers by fee income in the range, with their item sales, payouts and balances today
    const finBySeller = (await repo.dailySums('fact_marketplace_finance_daily', { ...rq.range, ...(sellerId ? { sellerId } : {}) }, ['fee_gross_minor', 'fee_refunds_minor', 'payouts_paid_minor'], 'seller_id'))
      .map((r) => ({ id: r.key!, fee: r.fee_gross_minor! - r.fee_refunds_minor!, paid: r.payouts_paid_minor! }))
      .filter((r) => r.id)
      .sort((a, b) => b.fee - a.fee || b.paid - a.paid)
      .slice(0, 20);
    const ids = finBySeller.map((r) => r.id);
    const [sales, todays, names] = await Promise.all([
      repo.salesAgg(this.q.salesFilter(rq, { kind: 'platform' }, rq.range, { ownerType: 'seller', basis: 'placed_at', ...(sellerId ? { sellerId } : {}) }), 'seller_id'),
      repo.sellerBalancesOn(today, ids),
      this.q.sellerNames(ids),
    ]);
    const salesOf = new Map(sales.map((s) => [s.key, s.gross]));
    const todayOf = new Map(todays.map((b) => [b.seller_id, b]));
    const keys = [...SELLER_MONEY_BALANCES, ...SELLER_MONEY_FLOWS];
    return {
      kpis: this.kpis(keys, now, prev, c, { 'sellers.owed': `end of ${dayLabel(lastDay(rq.range))}`, 'sellers.held': `end of ${dayLabel(lastDay(rq.range))}` }),
      series: this.seriesOf(keys, buckets, rq.granularity, byBucket),
      table: {
        columns: [col('seller', 'Seller'), col('itemSales', 'Item sales', 'money'), col('feeIncome', 'Fee income', 'money'), col('payoutsPaid', 'Payouts paid', 'money'), col('balanceToday', 'Balance today', 'money'), col('heldToday', 'Held today', 'money')],
        rows: finBySeller.map((r) => {
          const b = todayOf.get(r.id);
          return { sellerId: r.id, seller: names.get(r.id) ?? r.id, itemSales: this.q.money(salesOf.get(r.id) ?? 0, c), feeIncome: this.q.money(r.fee, c), payoutsPaid: this.q.money(r.paid, c), balanceToday: this.q.money(b ? b.pending_minor + b.available_minor + b.held_minor : 0, c), heldToday: this.q.money(b?.held_minor ?? 0, c) };
        }),
        totals: { feeIncome: this.q.money(finBySeller.reduce((n, r) => n + r.fee, 0), c), payoutsPaid: this.q.money(finBySeller.reduce((n, r) => n + r.paid, 0), c) },
      },
      callouts: [
        { kind: 'info', title: 'End-of-day balances', body: 'Owed, held and negative balances are the sellers’ balances at the end of each day (for a week or month, its last day), rebuilt from the finance ledger; today’s are as of the last pull, every 15 minutes. Payouts are summed over the period.' },
      ],
      unavailable: this.core.running('finance') ? [] : keys,
      models: ['seller_balances', 'marketplace_finance', 'order_items'],
      freshAsOf: await this.financePulledAt(),
    };
  }

  /* ---------------------------------------------------------------- trading.pnl */

  /** Official Store order facts of a range, filtered the way trading.margin filters them (owner official, the query's date basis) */
  private officialSales(rq: ResolvedQuery, range: DayRange, group: 'none' | 'bucket') {
    return this.core.repo.salesAgg(this.q.salesFilter(rq, { kind: 'platform' }, range, { ownerType: 'official' }), group, rq.granularity);
  }

  /** The Official Store P&L of the whole range (order facts and the trading lines finance booked) */
  private async tradingTotals(rq: ResolvedQuery, range: DayRange, cfg: Settings): Promise<Figures> {
    const [[sales], company] = await Promise.all([this.officialSales(rq, range, 'none'), this.core.repo.companySums(range.from, range.to, 'none')]);
    const s = sales ?? emptyAgg();
    return tradingFigures(this.q.gross(s, cfg), s, company);
  }

  /** The Official Store P&L per bucket of the range; `company` holds the range's fact_company_daily rows by bucket */
  private async tradingByBucket(rq: ResolvedQuery, cfg: Settings, company: (CompanyRow & { key: string | null })[]): Promise<Map<string, Figures>> {
    const salesAt = new Map((await this.officialSales(rq, rq.range, 'bucket')).map((b) => [b.key!, b]));
    return new Map(
      bucketsOf(rq.range, rq.granularity).map((b) => {
        const s = salesAt.get(b) ?? emptyAgg();
        return [b, tradingFigures(this.q.gross(s, cfg), s, company.filter((r) => r.key === b))];
      }),
    );
  }

  async tradingPnl(rq: ResolvedQuery): Promise<Part> {
    const c = rq.currency;
    const cfg = await this.core.cfg();
    const [now, prev, company] = await Promise.all([this.tradingTotals(rq, rq.range, cfg), rq.compare ? this.tradingTotals(rq, rq.compare, cfg) : null, this.core.repo.companySums(rq.range.from, rq.range.to, 'bucket', rq.granularity)]);
    const buckets = bucketsOf(rq.range, rq.granularity);
    const byBucket = await this.tradingByBucket(rq, cfg, company);
    const notInMargin = now.notInMargin!;
    const waterfall = [
      this.step('trading.official_sales', nameOf('trading.official_sales'), now['trading.official_sales']!, c, 'start'),
      // sales the margin leaves out, so the steps add up to the gross margin
      ...(notInMargin ? [this.step('trading.not_in_margin', cfg.taxIncluded ? 'Tax and sales without a unit cost' : 'Sales without a unit cost', -notInMargin, c)] : []),
      this.step('trading.buying_cost', nameOf('trading.buying_cost'), -now['trading.buying_cost']!, c),
      this.step('trading.gross_margin', nameOf('trading.gross_margin'), now['trading.gross_margin']!, c, 'total'),
      // discounts are not a step: Official Store sales are already after them
      this.step('trading.shipping_expense', nameOf('trading.shipping_expense'), -now['trading.shipping_expense']!, c),
      this.step('trading.returns_cost', nameOf('trading.returns_cost'), -now['trading.returns_cost']!, c),
      this.step('trading.write_offs', nameOf('trading.write_offs'), -now['trading.write_offs']!, c),
      this.step('trading.chargeback_losses', nameOf('trading.chargeback_losses'), -now['trading.chargeback_losses']!, c),
      this.step('trading.supplier_credits', nameOf('trading.supplier_credits'), now['trading.supplier_credits']!, c),
      this.step('trading.net_margin', nameOf('trading.net_margin'), now['trading.net_margin']!, c, 'total'),
    ];
    const keys = [...TRADING_KEYS, 'trading.stock_bought'];
    const basis = BASIS_LABEL[rq.basis];
    const callouts: Callout[] = [
      { kind: 'info', title: 'Two dates', body: `Official Store sales, cost of goods sold and gross margin follow the ${basis}, the same figures as the Official Store margin report: sales after customer discounts, cost at the unit cost when sold. Cancellations and refunds are not taken off them here. Shipping expense, returns cost, write-offs, chargeback losses, supplier credits, discounts and stock bought count on the day finance booked them. Supplier credits are added to net margin.` },
      { kind: 'info', title: 'Stock bought is not a cost of sales', body: `Stock bought (${displayMoney(now['trading.stock_bought']!, c)} in this period) is what goods received from suppliers cost. It is shown on its own and not taken off the margin; the cost of the units sold is. Discounts are shown for reference only: sales are already after them.` },
    ];
    const withoutCost = now.salesWithoutCost!;
    if (withoutCost > 0) callouts.push({ kind: 'warning', title: 'Some sales have no unit cost', body: `${displayMoney(withoutCost, c)} (${now.salesWithoutCostPct}%) of Official Store sales has no unit cost yet. Its cost is not guessed: those sales are left out of cost of goods sold and of gross and net margin.` });
    return {
      kpis: this.kpis(keys, now, prev, c, { 'trading.discounts': 'Already taken off sales', 'trading.stock_bought': 'Not taken off the margin' }),
      series: this.seriesOf(keys, buckets, rq.granularity, byBucket),
      breakdowns: [{ key: 'waterfall', label: 'From sales to net margin', rows: waterfall }],
      // the table also shows supplier credits, which net margin adds back, and stock bought
      table: this.periodTable([...TRADING_KEYS.slice(0, -2), 'trading.supplier_credits', ...TRADING_KEYS.slice(-2), 'trading.stock_bought'], buckets, rq.granularity, byBucket, now, c),
      callouts,
      unavailable: [...(this.core.running('finance') ? [] : TRADING_BOOKED_KEYS), ...(this.core.running('inventory') ? [] : ['trading.buying_cost', 'trading.gross_margin', 'trading.net_margin', 'trading.net_margin_pct'])],
      models: ['order_items', 'company_finance'],
      freshAsOf: await this.financePulledAt(),
    };
  }
}
