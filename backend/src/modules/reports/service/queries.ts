/**
 * Report queries and dashboards from the read models. Every result states its range, date basis,
 * currency, time zone, tax treatment, freshness and the definition versions it used (plan ch. 19).
 */
import type { MediaRef, Money } from '../../../spec/common.js';
import type { AdminDashboard, KpiValue, MetricDefinition, ReportQuery, ReportResult, Series, SellerDashboard, SellerWorkTile } from '../../../spec/reports.js';
import { OFFICIAL_KEY, metricSeed } from '../domain/catalogue.js';
import {
  addDays,
  bucketOf,
  bucketsOf,
  daysBetween,
  dayLabel,
  deltaOf,
  display,
  displayMoney,
  instantsOf,
  isDay,
  isTimeZone,
  marketDay,
  pct,
  presetRange,
  previousRange,
  type Basis,
  type DayRange,
  type Granularity,
  type Issue,
} from '../domain/rules.js';
import type { ReportRow, SalesAgg, SalesFilter } from '../ports.js';
import { invalid, type ReportsCore, type Settings } from './core.js';
import type { Definitions } from './definitions.js';

export type ReportScope = { kind: 'platform' } | { kind: 'seller'; sellerId: string };
export type Period = 'today' | 'last_7_days' | 'last_14_days' | 'last_30_days';

export interface ResolvedQuery {
  preset: NonNullable<ReportQuery['preset']>;
  range: DayRange;
  compare: DayRange | null;
  basis: Basis;
  soldBy: 'all' | 'official' | 'marketplace';
  sellerId?: string;
  categoryId?: string;
  productId?: string;
  currency: string;
  timeZone: string;
  granularity: Granularity;
  filters: Record<string, unknown>;
}

interface TableColumn {
  key: string;
  label: string;
  unit: string;
  align: 'left' | 'right';
}
interface Table {
  columns: TableColumn[];
  rows: Record<string, unknown>[];
  totals: Record<string, unknown>;
}
interface Callout {
  kind: 'info' | 'warning';
  title: string;
  body: string;
}
interface Part {
  kpis: KpiValue[];
  series: Series[];
  split?: unknown[];
  table?: Table;
  breakdowns?: unknown[];
  callouts: Callout[];
  unavailable: string[];
  models: string[];
}

const BASIS_COLUMN: Record<Basis, SalesFilter['basis']> = { placement: 'placed_at', payment: 'paid_at', shipment: 'shipped_at', completion: 'completed_at' };
const BASIS_LABEL: Record<Basis, string> = { placement: 'order placement date', payment: 'payment date', shipment: 'shipment date', completion: 'completion date' };

const MARKETPLACE_CALLOUT: Callout = {
  kind: 'info',
  title: 'Marketplace sales are not marketplace fee income',
  body: 'Sales by marketplace sellers belong to the sellers. The company earns the commission and fees on them, shown as Marketplace fee income in Marketplace finance.',
};

const col = (key: string, label: string, unit = 'text', align: 'left' | 'right' = unit === 'text' ? 'left' : 'right'): TableColumn => ({ key, label, unit, align });
/** commerce.gross_sales → gross_sales (series and column keys) */
const suffix = (metricKey: string) => metricKey.slice(metricKey.indexOf('.') + 1);
/** Average hours from a sum of minutes over n replies (0 without replies) */
const hoursOf = (minutes: number, n: number) => (n > 0 ? Math.round((minutes / n / 60) * 10) / 10 : 0);

/** The company trading cost reports: the finance cost kinds each one shows (finance.companyCostsByDay) */
const COST_REPORTS: Record<string, { metric: string; kind: string; label: string }[]> = {
  'trading.purchasing': [
    { metric: 'trading.purchasing_booked', kind: 'buying_cost', label: 'Purchasing costs booked' },
    { metric: 'trading.supplier_credits', kind: 'supplier_credit', label: 'Supplier credits' },
  ],
  'trading.discounts_shipping': [
    { metric: 'trading.discounts', kind: 'discount', label: 'Official Store discounts' },
    { metric: 'trading.shipping_expense', kind: 'shipping_expense', label: 'Shipping expense' },
  ],
  'trading.returns_cost': [
    { metric: 'trading.return_losses', kind: 'return_loss', label: 'Return losses' },
    { metric: 'trading.write_offs', kind: 'write_off', label: 'Write-offs' },
    { metric: 'trading.chargeback_losses', kind: 'chargeback_loss', label: 'Chargeback losses' },
  ],
};

export class Queries {
  constructor(
    private readonly core: ReportsCore,
    private readonly defs: Definitions,
  ) {}

  /* ---------------------------------------------------------------- query resolution */

  async resolve(q: ReportQuery | null | undefined, opts: { seller?: boolean; defaultBasis?: Basis } = {}): Promise<ResolvedQuery> {
    const cfg = await this.core.cfg();
    const query = q ?? {};
    const issues: Issue[] = [];
    if (opts.seller && query.sellerId) issues.push({ path: 'sellerId', message: 'Seller reports always cover your own account' });
    if (opts.seller && query.soldBy) issues.push({ path: 'soldBy', message: 'Seller reports always cover your own sales' });
    const preset = query.preset ?? (query.range ? 'custom' : 'last_14_days');
    const today = marketDay(this.core.now(), cfg.timeZone);
    let range: DayRange;
    if (preset === 'custom') {
      if (!query.range) issues.push({ path: 'range', message: 'Choose the first and last day' });
      range = query.range ?? presetRange('last_14_days', today);
    } else range = query.range && query.preset == null ? query.range : presetRange(preset, today);
    if (!isDay(range.from) || !isDay(range.to)) issues.push({ path: 'range', message: 'Dates are YYYY-MM-DD' });
    else if (range.from > range.to) issues.push({ path: 'range.from', message: 'The first day is after the last day' });
    const currency = (query.currency ?? cfg.currency).toUpperCase();
    if (currency !== cfg.currency) issues.push({ path: 'currency', message: `Reports are in ${cfg.currency}; one currency at launch` });
    const timeZone = query.timeZone ?? cfg.timeZone;
    if (!isTimeZone(timeZone)) issues.push({ path: 'timeZone', message: 'Use a time zone name such as America/Los_Angeles' });
    if (issues.length) throw invalid(issues);
    const days = daysBetween(range.from, range.to);
    if (days > cfg.maxRangeDays) throw this.core.ctx.error('RANGE_TOO_LARGE', `A report covers at most ${cfg.maxRangeDays} days; this range has ${days}`, { maxRangeDays: cfg.maxRangeDays, days });
    const filters = query.filters && typeof query.filters === 'object' && !Array.isArray(query.filters) ? (query.filters as Record<string, unknown>) : {};
    return {
      preset,
      range,
      compare: query.compare === 'previous_period' ? previousRange(range) : null,
      basis: opts.seller ? 'placement' : (query.dateBasis ?? opts.defaultBasis ?? cfg.defaultBasis),
      soldBy: opts.seller ? 'marketplace' : (query.soldBy ?? 'all'),
      ...(query.sellerId ? { sellerId: query.sellerId } : {}),
      ...(query.categoryId ? { categoryId: query.categoryId } : {}),
      ...(query.productId ? { productId: query.productId } : {}),
      currency,
      timeZone,
      granularity: query.granularity ?? (days > 92 ? 'month' : days > 31 ? 'week' : 'day'),
      filters,
    };
  }

  /* ---------------------------------------------------------------- running a report */

  async run(report: ReportRow, rq: ResolvedQuery, scope: ReportScope): Promise<ReportResult> {
    const cfg = await this.core.cfg();
    const part = await this.compute(report.key, rq, scope, cfg);
    const metricKeys = Array.isArray(report.metrics) ? (report.metrics as string[]) : [];
    const definitions = await this.defs.inUse(metricKeys);
    const today = marketDay(this.core.now(), cfg.timeZone);
    const callouts = [...part.callouts];
    if (rq.timeZone !== cfg.timeZone) callouts.push({ kind: 'info', title: `Days in ${rq.timeZone}`, body: `Order, refund and return dates use ${rq.timeZone}. Daily figures (fees, service, discovery, campaigns) stay in market time (${cfg.timeZone}).` });
    return {
      meta: {
        reportKey: report.key,
        title: report.title,
        range: rq.range,
        dateBasis: rq.basis,
        dateBasisLabel: `By ${BASIS_LABEL[rq.basis]}`,
        currency: rq.currency,
        timeZone: rq.timeZone,
        taxIncluded: cfg.taxIncluded,
        freshAsOf: await this.freshAsOf(part.models),
        mayStillChange: rq.range.to >= addDays(today, -30),
        definitionsVersion: Object.fromEntries(definitions.map((d) => [d.key, d.version])),
        ...(rq.compare ? { compareRange: rq.compare } : {}),
        granularity: rq.granularity,
        scope: scope.kind,
      },
      kpis: part.kpis,
      series: part.series,
      split: part.split ?? null,
      table: part.table ?? null,
      breakdowns: part.breakdowns ?? null,
      definitions,
      callouts,
      unavailable: [...new Set(part.unavailable)],
    };
  }

  /** Newest event the read models behind a result have taken in (now when none has arrived yet) */
  private async freshAsOf(models: string[]): Promise<string> {
    const rows = await this.core.repo.listCheckpoints(models);
    const times = rows.map((r) => r.last_event_at?.getTime() ?? 0).filter(Boolean);
    return new Date(times.length ? Math.max(...times) : this.core.now().getTime()).toISOString();
  }

  private salesFilter(rq: ResolvedQuery, scope: ReportScope, range: DayRange, over: Partial<SalesFilter> = {}): SalesFilter {
    const { start, end } = instantsOf(range, rq.timeZone);
    const ownerType = scope.kind === 'seller' ? 'seller' : rq.soldBy === 'official' ? 'official' : rq.soldBy === 'marketplace' ? 'seller' : undefined;
    return {
      basis: BASIS_COLUMN[rq.basis],
      start,
      end,
      timeZone: rq.timeZone,
      ...(ownerType ? { ownerType } : {}),
      ...(scope.kind === 'seller' ? { sellerId: scope.sellerId } : rq.sellerId ? { sellerId: rq.sellerId } : {}),
      ...(rq.categoryId ? { categoryId: rq.categoryId } : {}),
      ...(rq.productId ? { productId: rq.productId } : {}),
      ...over,
    };
  }

  private sellerOf(rq: ResolvedQuery, scope: ReportScope): string | undefined {
    return scope.kind === 'seller' ? scope.sellerId : rq.sellerId;
  }

  private async salesTotals(rq: ResolvedQuery, scope: ReportScope, range: DayRange, over: Partial<SalesFilter> = {}): Promise<SalesAgg> {
    return (await this.core.repo.salesAgg(this.salesFilter(rq, scope, range, over), 'none'))[0] ?? emptyAgg();
  }

  private money(amount: number, currency: string): Money {
    return { amount: Math.round(amount), currency };
  }

  kpi(key: string, value: number, currency: string, prev?: number | null, note?: string | null): KpiValue {
    const seed = metricSeed(key);
    const unit = seed?.unit ?? 'count';
    const delta = prev === undefined || prev === null ? null : deltaOf(value, prev, unit, seed?.higherIsBetter ?? true);
    return {
      metricKey: key,
      label: seed?.name ?? key,
      value,
      money: unit === 'money' ? this.money(value, currency) : null,
      display: display(value, unit, currency),
      delta,
      note: note ?? null,
    };
  }

  private series(key: string, label: string, buckets: string[], g: Granularity, values: Map<string, number>): Series {
    return { key, label, points: buckets.map((b) => ({ x: b, y: values.get(b) ?? 0, label: dayLabel(b, g) })) };
  }

  /* ---------------------------------------------------------------- names for tables */

  private async sellerNames(ids: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const real = ids.filter((id) => id && id !== OFFICIAL_KEY);
    if (ids.includes(OFFICIAL_KEY)) out.set(OFFICIAL_KEY, 'Official Store');
    const sellers = this.core.api('sellers');
    if (sellers && real.length) for (const s of (await this.core.soft('sellers.getSellers', () => sellers.getSellers(real))) ?? []) out.set(s.id, s.storeName);
    return out;
  }

  private async productNames(ids: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const catalog = this.core.api('catalog');
    if (!catalog) return out;
    await Promise.all(
      ids.slice(0, 100).map(async (id) => {
        const p = await this.core.soft('catalog.getProduct', () => catalog.getProduct(id));
        if (p) out.set(id, p.title);
      }),
    );
    return out;
  }

  /* ---------------------------------------------------------------- report computers */

  private async compute(key: string, rq: ResolvedQuery, scope: ReportScope, cfg: Settings): Promise<Part> {
    switch (key) {
      case 'commerce.sales':
        return this.salesReport(rq, scope, cfg, true);
      case 'commerce.refunds':
        return this.refundsReport(rq, scope, cfg);
      case 'trading.margin':
        return this.marginReport(rq, cfg);
      case 'marketplace.fees':
        return this.feesReport(rq, scope, cfg);
      case 'discovery.products':
        return this.discoveryReport(rq, cfg);
      case 'discovery.searches':
        return this.searchesReport(rq, cfg);
      case 'service.sellers':
      case 'seller.service_performance':
        return this.serviceReport(rq, scope, cfg, key === 'service.sellers');
      case 'service.returns':
      case 'seller.returns_by_reason':
        return this.returnsReport(rq, scope, cfg);
      case 'customers.buyers':
        return this.buyersReport(rq, cfg);
      case 'marketing.campaigns':
        return this.campaignsReport(rq, cfg);
      case 'seller.product_sales':
        return this.productSalesReport(rq, scope, cfg);
      case 'seller.order_trend':
      case 'commerce.orders':
        return this.salesReport(rq, scope, cfg, false);
      case 'marketplace.discount_funding':
        return this.discountFundingReport(rq, scope, cfg);
      case 'marketplace.owed_to_sellers':
        return this.sellerBalancesReport(rq, scope, cfg);
      case 'marketplace.payouts':
        return this.payoutsReport(rq, scope);
      case 'discovery.stockouts':
        return this.stockoutsReport(rq);
      case 'service.dispatch':
      case 'service.delivery_issues':
      case 'service.cancellations':
      case 'service.cases':
        return this.serviceFocusReport(key, rq, scope);
      case 'ads.performance':
        return this.adsReport(rq);
      case 'trading.purchasing':
      case 'trading.discounts_shipping':
      case 'trading.returns_cost':
        return this.companyCostsReport(key, rq, cfg);
      case 'service.complaints':
        return this.complaintsReport(rq, scope);
      default:
        return { kpis: [], series: [], callouts: [{ kind: 'warning', title: 'No figures yet', body: 'This report has no figures in this version.' }], unavailable: [key], models: [] };
    }
  }

  private gross(a: SalesAgg, cfg: Settings) {
    return a.gross + (cfg.taxIncluded ? a.tax : 0);
  }

  private async salesReport(rq: ResolvedQuery, scope: ReportScope, cfg: Settings, full: boolean): Promise<Part> {
    const c = rq.currency;
    const total = await this.salesTotals(rq, scope, rq.range);
    const prev = rq.compare ? await this.salesTotals(rq, scope, rq.compare) : null;
    const gross = this.gross(total, cfg);
    const net = gross - total.cancelled - total.refunded;
    const aov = total.orders ? Math.round(gross / total.orders) : 0;
    const pGross = prev ? this.gross(prev, cfg) : null;
    const kpis = full
      ? [
          this.kpi('commerce.gross_sales', gross, c, pGross),
          this.kpi('commerce.net_sales', net, c, prev ? pGross! - prev.cancelled - prev.refunded : null, gross ? `${pct(total.cancelled + total.refunded, gross)}% cancelled or refunded so far` : null),
          this.kpi('commerce.orders', total.orders, c, prev?.orders ?? null, `avg ${displayMoney(aov, c)}`),
          this.kpi('commerce.average_order_value', aov, c, prev ? (prev.orders ? Math.round(pGross! / prev.orders) : 0) : null),
          this.kpi('commerce.units_sold', total.units, c, prev?.units ?? null),
        ]
      : [this.kpi('commerce.orders', total.orders, c, prev?.orders ?? null), this.kpi('commerce.gross_sales', gross, c, pGross), this.kpi('commerce.average_order_value', aov, c, prev ? (prev.orders ? Math.round(pGross! / prev.orders) : 0) : null)];
    const byBucket = await this.core.repo.salesAgg(this.salesFilter(rq, scope, rq.range), 'bucket', rq.granularity);
    const buckets = bucketsOf(rq.range, rq.granularity);
    const at = new Map(byBucket.map((b) => [b.key!, b]));
    const series = [
      this.series('gross_sales', 'Gross sales', buckets, rq.granularity, new Map(byBucket.map((b) => [b.key!, this.gross(b, cfg)]))),
      ...(full ? [this.series('net_sales', 'Sales after cancellations and refunds', buckets, rq.granularity, new Map(byBucket.map((b) => [b.key!, this.gross(b, cfg) - b.cancelled - b.refunded])))] : [this.series('orders', 'Orders', buckets, rq.granularity, new Map(byBucket.map((b) => [b.key!, b.orders])))]),
    ];
    let split: unknown[] | undefined;
    if (full && scope.kind === 'platform' && rq.soldBy === 'all') {
      const owners = await this.core.repo.salesAgg(this.salesFilter(rq, scope, rq.range), 'owner_type');
      const official = this.gross(owners.find((o) => o.key === 'official') ?? emptyAgg(), cfg);
      const marketplace = this.gross(owners.find((o) => o.key === 'seller') ?? emptyAgg(), cfg);
      split = [
        { key: 'official', label: 'Official Store', amount: this.money(official, c), sharePct: pct(official, official + marketplace) },
        { key: 'marketplace', label: 'Marketplace sellers', amount: this.money(marketplace, c), sharePct: pct(marketplace, official + marketplace) },
      ];
    }
    const table: Table = {
      columns: [col('period', 'Period'), col('orders', 'Orders', 'count'), col('units', 'Units', 'count'), col('gross', 'Gross sales', 'money'), ...(full ? [col('cancelled', 'Cancelled', 'money'), col('refunded', 'Refunded', 'money'), col('net', 'After cancellations and refunds', 'money')] : [col('averageOrder', 'Average order', 'money')])],
      rows: buckets.map((b) => {
        const a = at.get(b) ?? emptyAgg();
        const g = this.gross(a, cfg);
        return { period: b, label: dayLabel(b, rq.granularity), orders: a.orders, units: a.units, gross: this.money(g, c), ...(full ? { cancelled: this.money(a.cancelled, c), refunded: this.money(a.refunded, c), net: this.money(g - a.cancelled - a.refunded, c) } : { averageOrder: this.money(a.orders ? Math.round(g / a.orders) : 0, c) }) };
      }),
      totals: { orders: total.orders, units: total.units, gross: this.money(gross, c), ...(full ? { cancelled: this.money(total.cancelled, c), refunded: this.money(total.refunded, c), net: this.money(net, c) } : { averageOrder: this.money(aov, c) }) },
    };
    const callouts: Callout[] = [];
    if (full && scope.kind === 'platform') callouts.push(MARKETPLACE_CALLOUT);
    callouts.push({ kind: 'info', title: `By ${BASIS_LABEL[rq.basis]}`, body: `Items count in the day of their ${BASIS_LABEL[rq.basis]}${rq.basis === 'placement' ? '' : '; items without that date yet are not included'}. ${cfg.taxIncluded ? 'Tax is included.' : 'Tax and shipping charges are not included.'}` });
    return { kpis, series, split, table, callouts, unavailable: [], models: ['order_items'] };
  }

  /**
   * Seller product sales (G47b, G48a): per product the SKUs sold (offers.getOffers), the main image
   * (catalog.getProducts), whether a discount is live now (promotions.priceOffers), units returned and the
   * return rate; the return rate KPI compares with the previous period when asked.
   */
  private async productSalesReport(rq: ResolvedQuery, scope: ReportScope, cfg: Settings): Promise<Part> {
    const c = rq.currency;
    const total = await this.salesTotals(rq, scope, rq.range);
    const prev = rq.compare ? await this.salesTotals(rq, scope, rq.compare) : null;
    const rows = (await this.core.repo.salesAgg(this.salesFilter(rq, scope, rq.range), 'product_id')).sort((a, b) => b.gross - a.gross);
    const ids = rows.map((r) => r.key!).slice(0, 100);
    const [info, offers, rate, prevRate, returned] = await Promise.all([
      this.productInfo(ids),
      this.offersByProduct(rq, scope),
      this.returnRate(rq, scope, rq.range),
      rq.compare ? this.returnRate(rq, scope, rq.compare) : Promise.resolve(null),
      this.core.repo.returnsAgg(this.returnsFilter(rq, scope, rq.range), 'product_id'),
    ]);
    const returnedUnits = new Map(returned.map((r) => [r.key, r.units]));
    return {
      kpis: [
        this.kpi('commerce.gross_sales', this.gross(total, cfg), c, prev ? this.gross(prev, cfg) : null),
        this.kpi('commerce.units_sold', total.units, c, prev?.units ?? null),
        this.kpi('commerce.orders', total.orders, c, prev?.orders ?? null),
        this.kpi('service.return_rate', rate.rate, c, prevRate?.rate ?? null, `${rate.returned} of ${rate.sold} units`),
      ],
      series: [],
      table: {
        columns: [col('product', 'Product'), col('sku', 'SKU'), col('units', 'Units', 'count'), col('orders', 'Orders', 'count'), col('gross', 'Item sales', 'money'), col('averagePrice', 'Average price', 'money'), col('returnedUnits', 'Returns', 'count'), col('returnRate', 'Return rate', 'percent'), col('cancelled', 'Cancelled', 'money'), col('refunded', 'Refunded', 'money')],
        rows: rows.map((r) => {
          const p = info.get(r.key!);
          const o = offers.get(r.key!);
          const back = returnedUnits.get(r.key) ?? 0;
          const gross = this.gross(r, cfg);
          return {
            productId: r.key,
            product: p?.title ?? r.key,
            image: p?.image ?? null,
            sku: o?.skus.join(' / ') || null,
            skus: o?.skus ?? [],
            liveDiscount: o?.liveDiscount ?? false,
            units: r.units,
            orders: r.orders,
            gross: this.money(gross, c),
            averagePrice: this.money(r.units ? Math.round(gross / r.units) : 0, c),
            returnedUnits: back,
            returnRate: pct(back, r.units),
            cancelled: this.money(r.cancelled, c),
            refunded: this.money(r.refunded, c),
          };
        }),
        totals: { units: total.units, orders: total.orders, gross: this.money(this.gross(total, cfg), c), averagePrice: this.money(total.units ? Math.round(this.gross(total, cfg) / total.units) : 0, c), returnedUnits: rate.returned, returnRate: rate.rate, cancelled: this.money(total.cancelled, c), refunded: this.money(total.refunded, c) },
      },
      callouts: [
        { kind: 'info', title: 'Item sales before fees, by order date', body: 'Your item sales after customer discounts, before marketplace fees, cancellations and refunds. Shipping and tax are not included.' },
        { kind: 'info', title: 'Return rate', body: 'Units customers asked to return in the range, divided by the units sold in the same range.' },
      ],
      unavailable: [],
      models: ['order_items', 'returns'],
    };
  }

  private returnsFilter(rq: ResolvedQuery, scope: ReportScope, range: DayRange) {
    const sellerId = this.sellerOf(rq, scope);
    return { ...instantsOf(range, rq.timeZone), timeZone: rq.timeZone, ...(sellerId ? { sellerId } : {}), ...(rq.productId ? { productId: rq.productId } : {}) };
  }

  /** G48a: units asked to return in the range ÷ units sold (placed) in the range, in percent */
  private async returnRate(rq: ResolvedQuery, scope: ReportScope, range: DayRange): Promise<{ rate: number; returned: number; sold: number }> {
    const [returned] = await this.core.repo.returnsAgg(this.returnsFilter(rq, scope, range), 'none');
    const sold = (await this.salesTotals(rq, scope, range, { basis: 'placed_at' })).units;
    const units = returned?.units ?? 0;
    return { rate: pct(units, sold), returned: units, sold };
  }

  /** Title and main image per product (catalog.getProducts; empty when catalog is off) */
  private async productInfo(ids: string[]): Promise<Map<string, { title: string; image: MediaRef | null }>> {
    const out = new Map<string, { title: string; image: MediaRef | null }>();
    const catalog = this.core.api('catalog');
    if (!catalog || !ids.length) return out;
    for (const r of (await this.core.soft('catalog.getProducts', () => catalog.getProducts(ids))) ?? []) out.set(r.product.id, { title: r.product.title, image: r.product.images[0] ?? null });
    return out;
  }

  /**
   * Per product, the SKUs of the offers sold in the range (offers.getOffers) and whether one of them has a discount
   * live now (promotions.priceOffers: a markdown or flash price below the regular price, or an automatic discount).
   */
  private async offersByProduct(rq: ResolvedQuery, scope: ReportScope): Promise<Map<string, { skus: string[]; liveDiscount: boolean }>> {
    const out = new Map<string, { skus: string[]; liveDiscount: boolean }>();
    const offerIds = (await this.core.repo.salesAgg(this.salesFilter(rq, scope, rq.range), 'offer_id')).map((r) => r.key!).filter(Boolean).slice(0, 200);
    const offersApi = this.core.api('offers');
    if (!offerIds.length || !offersApi) return out;
    const offers = (await this.core.soft('offers.getOffers', () => offersApi.getOffers(offerIds))) ?? {};
    const promotions = this.core.api('promotions');
    const prices = promotions ? ((await this.core.soft('promotions.priceOffers', () => promotions.priceOffers(offerIds, {}))) ?? []) : [];
    const discounted = new Set(prices.filter((p) => p.price.amount < p.regularPrice.amount || (p.automaticDiscount?.amount ?? 0) > 0).map((p) => p.offerId));
    for (const id of offerIds) {
      const o = offers[id];
      if (!o) continue;
      const entry = out.get(o.productId) ?? { skus: [], liveDiscount: false };
      if (o.sellerSku && !entry.skus.includes(o.sellerSku)) entry.skus.push(o.sellerSku);
      entry.liveDiscount ||= discounted.has(id);
      out.set(o.productId, entry);
    }
    return out;
  }

  private async refundsReport(rq: ResolvedQuery, scope: ReportScope, cfg: Settings): Promise<Part> {
    const c = rq.currency;
    const f = this.salesFilter(rq, scope, rq.range);
    const rf = (range: DayRange) => {
      const { start, end } = instantsOf(range, rq.timeZone);
      return { start, end, timeZone: rq.timeZone, ...(f.ownerType ? { ownerType: f.ownerType } : {}), ...(f.sellerId ? { sellerId: f.sellerId } : {}) };
    };
    const [refunds] = await this.core.repo.refundsAgg(rf(rq.range), 'none');
    const prevRefunds = rq.compare ? (await this.core.repo.refundsAgg(rf(rq.compare), 'none'))[0] : undefined;
    const [cancelled] = await this.core.repo.cancellationsAgg(f, 'none');
    const prevCancelled = rq.compare ? (await this.core.repo.cancellationsAgg(this.salesFilter(rq, scope, rq.compare), 'none'))[0] : undefined;
    const buckets = bucketsOf(rq.range, rq.granularity);
    const refundBuckets = await this.core.repo.refundsAgg(rf(rq.range), 'bucket', rq.granularity);
    const cancelBuckets = await this.core.repo.cancellationsAgg(f, 'bucket', rq.granularity);
    const reasons = await this.core.repo.refundsAgg(rf(rq.range), 'reason');
    const by = await this.core.repo.cancellationsAgg(f, 'cancelled_by');
    const rAt = new Map(refundBuckets.map((b) => [b.key!, b]));
    const cAt = new Map(cancelBuckets.map((b) => [b.key!, b]));
    return {
      kpis: [
        this.kpi('commerce.refunds', refunds?.amount ?? 0, c, rq.compare ? (prevRefunds?.amount ?? 0) : null, `${refunds?.count ?? 0} refunds sent`),
        this.kpi('commerce.cancelled_sales', cancelled?.amount ?? 0, c, rq.compare ? (prevCancelled?.amount ?? 0) : null, `${cancelled?.items ?? 0} items`),
      ],
      series: [
        this.series('refunds', 'Refunds sent', buckets, rq.granularity, new Map(refundBuckets.map((b) => [b.key!, b.amount]))),
        this.series('cancelled_sales', 'Cancelled sales', buckets, rq.granularity, new Map(cancelBuckets.map((b) => [b.key!, b.amount]))),
      ],
      breakdowns: [
        { key: 'refund_reason', label: 'Refunds by reason', rows: reasons.map((r) => ({ key: r.key, label: humanize(r.key ?? 'unspecified'), amount: this.money(r.amount, c), count: r.count, sharePct: pct(r.amount, refunds?.amount ?? 0) })) },
        { key: 'cancelled_by', label: 'Cancellations by who asked', rows: by.map((r) => ({ key: r.key, label: humanize(r.key ?? 'unknown'), amount: this.money(r.amount, c), items: r.items, sharePct: pct(r.amount, cancelled?.amount ?? 0) })) },
      ],
      table: {
        columns: [col('period', 'Period'), col('refunds', 'Refunds sent', 'money'), col('refundCount', 'Refunds', 'count'), col('cancelled', 'Cancelled sales', 'money')],
        rows: buckets.map((b) => ({ period: b, label: dayLabel(b, rq.granularity), refunds: this.money(rAt.get(b)?.amount ?? 0, c), refundCount: rAt.get(b)?.count ?? 0, cancelled: this.money(cAt.get(b)?.amount ?? 0, c) })),
        totals: { refunds: this.money(refunds?.amount ?? 0, c), refundCount: refunds?.count ?? 0, cancelled: this.money(cancelled?.amount ?? 0, c) },
      },
      callouts: [{ kind: 'info', title: 'Refunds count when they are sent', body: "Refunds are dated the day the money was sent. Approved refunds that haven't been sent yet are not included." }],
      unavailable: [],
      models: ['order_items', 'refunds'],
    };
  }

  private async marginReport(rq: ResolvedQuery, cfg: Settings): Promise<Part> {
    const c = rq.currency;
    const scope: ReportScope = { kind: 'platform' };
    const official = { ownerType: 'official' as const };
    const total = await this.salesTotals(rq, scope, rq.range, official);
    const prev = rq.compare ? await this.salesTotals(rq, scope, rq.compare, official) : null;
    const margin = (a: SalesAgg) => a.costedSales - a.cost;
    const buckets = bucketsOf(rq.range, rq.granularity);
    const byBucket = await this.core.repo.salesAgg(this.salesFilter(rq, scope, rq.range, official), 'bucket', rq.granularity);
    const products = (await this.core.repo.salesAgg(this.salesFilter(rq, scope, rq.range, official), 'product_id')).sort((a, b) => b.gross - a.gross);
    const names = await this.productNames(products.map((p) => p.key!));
    const unknownCost = total.gross - total.costedSales;
    const unavailable = this.core.running('inventory') ? [] : ['trading.buying_cost', 'trading.gross_margin', 'trading.gross_margin_pct'];
    return {
      kpis: [
        this.kpi('trading.official_sales', this.gross(total, cfg), c, prev ? this.gross(prev, cfg) : null),
        this.kpi('trading.buying_cost', total.cost, c, prev?.cost ?? null),
        this.kpi('trading.gross_margin', margin(total), c, prev ? margin(prev) : null),
        this.kpi('trading.gross_margin_pct', pct(margin(total), total.costedSales), c, prev ? pct(margin(prev), prev.costedSales) : null),
      ],
      series: [this.series('gross_margin', 'Gross margin', buckets, rq.granularity, new Map(byBucket.map((b) => [b.key!, margin(b)])))],
      table: {
        columns: [col('product', 'Product'), col('units', 'Units', 'count'), col('sales', 'Sales', 'money'), col('cost', 'Buying cost', 'money'), col('margin', 'Gross margin', 'money'), col('marginPct', 'Margin %', 'percent')],
        rows: products.map((p) => ({ productId: p.key, product: names.get(p.key!) ?? p.key, units: p.units, sales: this.money(this.gross(p, cfg), c), cost: this.money(p.cost, c), margin: this.money(margin(p), c), marginPct: pct(margin(p), p.costedSales) })),
        totals: { units: total.units, sales: this.money(this.gross(total, cfg), c), cost: this.money(total.cost, c), margin: this.money(margin(total), c), marginPct: pct(margin(total), total.costedSales) },
      },
      callouts: unknownCost > 0 ? [{ kind: 'warning', title: 'Some costs are not known yet', body: `${displayMoney(unknownCost, c)} of Official Store sales has no buying cost yet; margin covers items with a known cost.` }] : [],
      unavailable,
      models: ['order_items'],
    };
  }

  private async feesReport(rq: ResolvedQuery, scope: ReportScope, cfg: Settings): Promise<Part> {
    const c = rq.currency;
    const sellerId = this.sellerOf(rq, scope);
    const marketplace = { ownerType: 'seller' as const };
    const COLS = ['fee_income_minor', 'held_minor', 'payouts_paid_minor', 'payouts_failed', 'owed_minor', 'ad_charges_minor', 'service_fees_minor'];
    const daily = async (r: DayRange) => (await this.core.repo.dailySums('fact_marketplace_finance_daily', { from: r.from, to: r.to, ...(sellerId ? { sellerId } : {}) }, COLS, 'none'))[0] ?? zeros(COLS);
    const sales = await this.salesTotals(rq, scope, rq.range, marketplace);
    const prevSales = rq.compare ? await this.salesTotals(rq, scope, rq.compare, marketplace) : null;
    const fin = await daily(rq.range);
    const prevFin = rq.compare ? await daily(rq.compare) : null;
    const buckets = bucketsOf(rq.range, rq.granularity);
    const finBuckets = await this.core.repo.dailySums('fact_marketplace_finance_daily', { from: rq.range.from, to: rq.range.to, ...(sellerId ? { sellerId } : {}) }, ['fee_income_minor'], 'bucket', rq.granularity);
    const salesBuckets = await this.core.repo.salesAgg(this.salesFilter(rq, scope, rq.range, marketplace), 'bucket', rq.granularity);
    const finBySeller = await this.core.repo.dailySums('fact_marketplace_finance_daily', { from: rq.range.from, to: rq.range.to, ...(sellerId ? { sellerId } : {}) }, COLS, 'seller_id');
    const salesBySeller = await this.core.repo.salesAgg(this.salesFilter(rq, scope, rq.range, marketplace), 'seller_id');
    const ids = [...new Set([...finBySeller.map((r) => r.key!), ...salesBySeller.map((r) => r.key!)])].filter(Boolean);
    const names = await this.sellerNames(ids);
    // Fulfilled by Marketly fees show while fulfillment-service runs, or when the range holds fees charged while it ran
    const serviceFees = this.core.running('fulfillment-service') || Boolean(fin.service_fees_minor) || Boolean(prevFin?.service_fees_minor);
    const unavailable = [...(this.core.running('finance') ? [] : ['marketplace.fee_income', 'marketplace.held', 'marketplace.payouts_paid', 'marketplace.amounts_owed']), ...(this.core.running('advertising') ? [] : ['marketplace.ad_income']), ...(serviceFees ? [] : ['marketplace.service_fees'])];
    const pulled = await this.core.repo.getCheckpoint('pull:marketplace_finance');
    const callouts: Callout[] = [MARKETPLACE_CALLOUT];
    const through = pulled?.last_event_id?.replace(/^pull:/, '');
    callouts.push({ kind: 'info', title: 'Fee income is updated daily', body: through ? `Fee income from finance is included through ${through}; later days are added overnight.` : 'Fee income from finance is added overnight; recent days may be missing.' });
    return {
      kpis: [
        this.kpi('marketplace.seller_sales', this.gross(sales, cfg), c, prevSales ? this.gross(prevSales, cfg) : null),
        this.kpi('marketplace.fee_income', fin.fee_income_minor!, c, prevFin?.fee_income_minor ?? null, `on ${displayMoney(this.gross(sales, cfg), c)} seller sales`),
        this.kpi('marketplace.discount_funding', sales.platformDiscount, c, prevSales?.platformDiscount ?? null),
        this.kpi('marketplace.held', fin.held_minor!, c, prevFin?.held_minor ?? null),
        this.kpi('marketplace.payouts_paid', fin.payouts_paid_minor!, c, prevFin?.payouts_paid_minor ?? null, fin.payouts_failed ? `${fin.payouts_failed} failed` : null),
        this.kpi('marketplace.amounts_owed', fin.owed_minor!, c, prevFin?.owed_minor ?? null),
        this.kpi('marketplace.ad_income', fin.ad_charges_minor!, c, prevFin?.ad_charges_minor ?? null),
        ...(serviceFees ? [this.kpi('marketplace.service_fees', fin.service_fees_minor!, c, prevFin?.service_fees_minor ?? null, 'Fulfilled by Marketly')] : []),
      ],
      series: [
        this.series('seller_sales', 'Marketplace sales', buckets, rq.granularity, new Map(salesBuckets.map((b) => [b.key!, this.gross(b, cfg)]))),
        this.series('fee_income', 'Marketplace fee income', buckets, rq.granularity, new Map(finBuckets.map((b) => [b.key!, b.fee_income_minor!]))),
      ],
      table: {
        columns: [col('seller', 'Seller'), col('sales', 'Marketplace sales', 'money'), col('feeIncome', 'Fee income', 'money'), col('platformDiscount', 'Platform-funded discounts', 'money'), col('held', 'Holds (net)', 'money'), col('payoutsPaid', 'Payouts paid', 'money'), col('owed', 'Amounts owed', 'money'), col('adCharges', 'Ad charges', 'money'), ...(serviceFees ? [col('serviceFees', 'Service fees', 'money')] : [])],
        rows: ids
          .map((id) => {
            const s = salesBySeller.find((x) => x.key === id) ?? emptyAgg();
            const fr = finBySeller.find((x) => x.key === id) ?? zeros(COLS);
            return { sellerId: id, seller: names.get(id) ?? id, sales: this.money(this.gross(s, cfg), c), feeIncome: this.money(fr.fee_income_minor!, c), platformDiscount: this.money(s.platformDiscount, c), held: this.money(fr.held_minor!, c), payoutsPaid: this.money(fr.payouts_paid_minor!, c), owed: this.money(fr.owed_minor!, c), adCharges: this.money(fr.ad_charges_minor!, c), ...(serviceFees ? { serviceFees: this.money(fr.service_fees_minor!, c) } : {}) };
          })
          .sort((a, b) => b.sales.amount - a.sales.amount),
        totals: { sales: this.money(this.gross(sales, cfg), c), feeIncome: this.money(fin.fee_income_minor!, c), platformDiscount: this.money(sales.platformDiscount, c), held: this.money(fin.held_minor!, c), payoutsPaid: this.money(fin.payouts_paid_minor!, c), owed: this.money(fin.owed_minor!, c), adCharges: this.money(fin.ad_charges_minor!, c), ...(serviceFees ? { serviceFees: this.money(fin.service_fees_minor!, c) } : {}) },
      },
      callouts,
      unavailable,
      models: ['order_items', 'marketplace_finance'],
    };
  }

  private async discoveryReport(rq: ResolvedQuery, _cfg: Settings): Promise<Part> {
    const c = rq.currency;
    const COLS = ['views', 'cart_adds', 'purchases', 'stockout_minutes'];
    const f = (r: DayRange) => ({ from: r.from, to: r.to, ...(rq.productId ? { productId: rq.productId } : {}) });
    const total = (await this.core.repo.dailySums('fact_discovery_daily', f(rq.range), COLS, 'none'))[0] ?? zeros(COLS);
    const prev = rq.compare ? ((await this.core.repo.dailySums('fact_discovery_daily', f(rq.compare), COLS, 'none'))[0] ?? zeros(COLS)) : null;
    const buckets = bucketsOf(rq.range, rq.granularity);
    const byBucket = await this.core.repo.dailySums('fact_discovery_daily', f(rq.range), COLS, 'bucket', rq.granularity);
    const byProduct = (await this.core.repo.dailySums('fact_discovery_daily', f(rq.range), COLS, 'product_id')).sort((a, b) => b.views! - a.views!).slice(0, 200);
    const names = await this.productNames(byProduct.map((p) => p.key!));
    return {
      kpis: [
        this.kpi('discovery.product_views', total.views!, c, prev?.views ?? null),
        this.kpi('discovery.cart_adds', total.cart_adds!, c, prev?.cart_adds ?? null),
        this.kpi('discovery.view_to_order', pct(total.purchases!, total.views!), c, prev ? pct(prev.purchases!, prev.views!) : null, `${total.purchases} units ordered`),
        this.kpi('discovery.stockout_hours', Math.round((total.stockout_minutes! / 60) * 10) / 10, c, prev ? Math.round((prev.stockout_minutes! / 60) * 10) / 10 : null),
      ],
      series: [
        this.series('views', 'Product views', buckets, rq.granularity, new Map(byBucket.map((b) => [b.key!, b.views!]))),
        this.series('cart_adds', 'Cart additions', buckets, rq.granularity, new Map(byBucket.map((b) => [b.key!, b.cart_adds!]))),
      ],
      table: {
        columns: [col('product', 'Product'), col('views', 'Views', 'count'), col('cartAdds', 'Cart additions', 'count'), col('purchases', 'Units ordered', 'count'), col('viewToOrder', 'Per 100 views', 'percent'), col('stockoutHours', 'Out-of-stock hours', 'duration_hours')],
        rows: byProduct.map((p) => ({ productId: p.key, product: names.get(p.key!) ?? p.key, views: p.views, cartAdds: p.cart_adds, purchases: p.purchases, viewToOrder: pct(p.purchases!, p.views!), stockoutHours: Math.round((p.stockout_minutes! / 60) * 10) / 10 })),
        totals: { views: total.views, cartAdds: total.cart_adds, purchases: total.purchases, viewToOrder: pct(total.purchases!, total.views!), stockoutHours: Math.round((total.stockout_minutes! / 60) * 10) / 10 },
      },
      callouts: [{ kind: 'info', title: 'Anonymous counts', body: 'Views are counted without storing who viewed; shoppers who turned off personalisation are not counted.' }],
      unavailable: [],
      models: ['discovery'],
    };
  }

  private async searchesReport(rq: ResolvedQuery, _cfg: Settings): Promise<Part> {
    const c = rq.currency;
    const total = (await this.core.repo.dailySums('fact_search_misses_daily', rq.range, ['count'], 'none'))[0] ?? zeros(['count']);
    const prev = rq.compare ? ((await this.core.repo.dailySums('fact_search_misses_daily', rq.compare, ['count'], 'none'))[0] ?? zeros(['count'])) : null;
    const buckets = bucketsOf(rq.range, rq.granularity);
    const byBucket = await this.core.repo.dailySums('fact_search_misses_daily', rq.range, ['count'], 'bucket', rq.granularity);
    const byQuery = (await this.core.repo.dailySums('fact_search_misses_daily', rq.range, ['count'], 'query_norm')).sort((a, b) => b.count! - a.count!).slice(0, 200);
    return {
      kpis: [this.kpi('discovery.unavailable_searches', total.count!, c, prev?.count ?? null, `${byQuery.length} different searches`)],
      series: [this.series('unavailable_searches', 'Unavailable searches', buckets, rq.granularity, new Map(byBucket.map((b) => [b.key!, b.count!])))],
      table: { columns: [col('query', 'Search'), col('count', 'Searches', 'count')], rows: byQuery.map((q) => ({ query: q.key, count: q.count })), totals: { count: total.count } },
      callouts: [{ kind: 'info', title: 'Updated daily', body: 'Searches without an available result are added overnight from search.' }],
      unavailable: this.core.running('search') ? [] : ['discovery.unavailable_searches'],
      models: ['search_misses'],
    };
  }

  private async serviceReport(rq: ResolvedQuery, scope: ReportScope, _cfg: Settings, staff: boolean): Promise<Part> {
    const c = rq.currency;
    const sellerId = this.sellerOf(rq, scope);
    const COLS = ['dispatched', 'dispatched_on_time', 'overdue', 'valid_tracking', 'seller_cancellations', 'delivery_exceptions', 'messages_received', 'cases_opened'];
    const f = (r: DayRange) => ({ from: r.from, to: r.to, ...(sellerId ? { sellerId } : {}) });
    const total = (await this.core.repo.dailySums('fact_service_daily', f(rq.range), COLS, 'none'))[0] ?? zeros(COLS);
    const prev = rq.compare ? ((await this.core.repo.dailySums('fact_service_daily', f(rq.compare), COLS, 'none'))[0] ?? zeros(COLS)) : null;
    const buckets = bucketsOf(rq.range, rq.granularity);
    const byBucket = await this.core.repo.dailySums('fact_service_daily', f(rq.range), COLS, 'bucket', rq.granularity);
    const onTime = (t: Record<string, number | null>) => pct(t.dispatched_on_time!, t.dispatched!);
    const tracking = (t: Record<string, number | null>) => pct(t.valid_tracking!, t.dispatched!);
    const kpis = [
      this.kpi('service.on_time_dispatch', onTime(total), c, prev ? onTime(prev) : null, `${total.dispatched_on_time} of ${total.dispatched} packages`),
      this.kpi('service.valid_tracking', tracking(total), c, prev ? tracking(prev) : null),
      ...(staff ? [this.kpi('service.overdue_dispatch', total.overdue!, c, prev?.overdue ?? null)] : []),
      this.kpi('service.seller_cancellations', total.seller_cancellations!, c, prev?.seller_cancellations ?? null),
      this.kpi('service.delivery_exceptions', total.delivery_exceptions!, c, prev?.delivery_exceptions ?? null),
      ...(staff
        ? [
            this.kpi('service.cases_opened', total.cases_opened!, c, prev?.cases_opened ?? null),
            this.kpi('service.case_backlog', await this.core.repo.caseBacklog(rq.range.to, sellerId), c, rq.compare ? await this.core.repo.caseBacklog(rq.compare.to, sellerId) : null, `open at the end of ${dayLabel(rq.range.to)}`),
          ]
        : []),
      this.kpi('service.messages_received', total.messages_received!, c, prev?.messages_received ?? null),
    ];
    const part: Part = {
      kpis,
      series: [
        this.series('on_time_dispatch', 'On-time dispatch %', buckets, rq.granularity, new Map(byBucket.map((b) => [b.key!, onTime(b)]))),
        this.series('dispatched', 'Packages dispatched', buckets, rq.granularity, new Map(byBucket.map((b) => [b.key!, b.dispatched!]))),
      ],
      callouts: [],
      unavailable: [],
      models: ['service'],
    };
    // Fulfilled by Marketly: Marketly's own dispatches for sellers' groups, never in the seller rows above (staff only)
    if (staff) {
      const M_COLS = ['dispatched', 'dispatched_on_time', 'overdue', 'delivery_exceptions'];
      const mTotal = (await this.core.repo.dailySums('fact_marketly_fulfillment_daily', f(rq.range), M_COLS, 'none'))[0] ?? zeros(M_COLS);
      const mPrev = rq.compare ? ((await this.core.repo.dailySums('fact_marketly_fulfillment_daily', f(rq.compare), M_COLS, 'none'))[0] ?? zeros(M_COLS)) : null;
      if (this.core.running('fulfillment-service') || mTotal.dispatched || mTotal.overdue) {
        kpis.push(this.kpi('service.marketly_on_time_dispatch', onTime(mTotal), c, mPrev?.dispatched ? onTime(mPrev) : null, `${mTotal.dispatched_on_time} of ${mTotal.dispatched} packages · ${mTotal.overdue} overdue${mTotal.delivery_exceptions ? ` · ${mTotal.delivery_exceptions} delivery issues` : ''}`));
        part.callouts.push({ kind: 'info', title: 'Fulfilled by Marketly is shown apart', body: "Packages Marketly's warehouse ships for sellers count in Fulfilled by Marketly on-time dispatch, never in the sellers' own dispatch or delivery-issue figures." });
        part.models.push('marketly_fulfillment');
      } else part.unavailable.push('service.marketly_on_time_dispatch');
    }
    if (staff) {
      const bySeller = await this.core.repo.dailySums('fact_service_daily', f(rq.range), COLS, 'seller_id');
      const names = await this.sellerNames(bySeller.map((s) => s.key!));
      part.table = {
        columns: [col('seller', 'Seller'), col('dispatched', 'Dispatched', 'count'), col('onTimePct', 'On time', 'percent'), col('trackingPct', 'Valid tracking', 'percent'), col('overdue', 'Overdue', 'count'), col('sellerCancellations', 'Seller cancellations', 'count'), col('deliveryExceptions', 'Delivery issues', 'count'), col('casesOpened', 'Cases opened', 'count'), col('messages', 'Messages', 'count')],
        rows: bySeller.map((s) => ({ sellerId: s.key === OFFICIAL_KEY ? null : s.key, seller: names.get(s.key!) ?? s.key, dispatched: s.dispatched, onTimePct: onTime(s), trackingPct: tracking(s), overdue: s.overdue, sellerCancellations: s.seller_cancellations, deliveryExceptions: s.delivery_exceptions, casesOpened: s.cases_opened, messages: s.messages_received })),
        totals: { dispatched: total.dispatched, onTimePct: onTime(total), trackingPct: tracking(total), overdue: total.overdue, sellerCancellations: total.seller_cancellations, deliveryExceptions: total.delivery_exceptions, casesOpened: total.cases_opened, messages: total.messages_received },
      };
    }
    return part;
  }

  private async returnsReport(rq: ResolvedQuery, scope: ReportScope, _cfg: Settings): Promise<Part> {
    const c = rq.currency;
    const f = (r: DayRange) => this.returnsFilter(rq, scope, r);
    const [total] = await this.core.repo.returnsAgg(f(rq.range), 'none');
    const prev = rq.compare ? (await this.core.repo.returnsAgg(f(rq.compare), 'none'))[0] : undefined;
    const rate = await this.returnRate(rq, scope, rq.range);
    const prevRate = rq.compare ? await this.returnRate(rq, scope, rq.compare) : null;
    const reasons = await this.core.repo.returnsAgg(f(rq.range), 'reason');
    const outcomes = await this.core.repo.returnsAgg(f(rq.range), 'outcome');
    const products = (await this.core.repo.returnsAgg(f(rq.range), 'product_id')).slice(0, 100);
    const names = await this.productNames(products.map((p) => p.key!));
    const requests = total?.requests ?? 0;
    return {
      kpis: [
        this.kpi('service.return_requests', requests, c, rq.compare ? (prev?.requests ?? 0) : null, `${total?.units ?? 0} units`),
        this.kpi('service.return_rate', rate.rate, c, prevRate?.rate ?? null, `${rate.returned} of ${rate.sold} units`),
      ],
      series: [],
      breakdowns: [
        { key: 'reason', label: 'Returns by reason', rows: reasons.map((r) => ({ key: r.key, label: humanize(r.key ?? 'other'), requests: r.requests, units: r.units, sharePct: pct(r.requests, requests) })) },
        { key: 'outcome', label: 'Inspection outcome', rows: outcomes.map((r) => ({ key: r.key, label: humanize(r.key ?? 'not_inspected'), requests: r.requests, sharePct: pct(r.requests, requests) })) },
      ],
      table: {
        columns: [col('product', 'Product'), col('requests', 'Return requests', 'count'), col('units', 'Units', 'count')],
        rows: products.map((p) => ({ productId: p.key, product: names.get(p.key!) ?? p.key, requests: p.requests, units: p.units })),
        totals: { requests, units: total?.units ?? 0 },
      },
      callouts: [],
      unavailable: [],
      models: ['returns'],
    };
  }

  private async buyersReport(rq: ResolvedQuery, _cfg: Settings): Promise<Part> {
    const c = rq.currency;
    const agg = (r: DayRange) => this.core.repo.customersAgg(instantsOf(r, rq.timeZone));
    const now = await agg(rq.range);
    const prev = rq.compare ? await agg(rq.compare) : null;
    const buckets = bucketsOf(rq.range, rq.granularity);
    const byBucket = await this.core.repo.salesAgg(this.salesFilter(rq, { kind: 'platform' }, rq.range, { basis: 'placed_at' }), 'bucket', rq.granularity);
    return {
      kpis: [
        this.kpi('customers.buyers', now.buyers, c, prev?.buyers ?? null),
        this.kpi('customers.new_buyers', now.newBuyers, c, prev?.newBuyers ?? null),
        this.kpi('customers.returning_buyers', now.returning, c, prev?.returning ?? null),
        this.kpi('customers.repeat_rate', pct(now.repeat, now.buyers), c, prev ? pct(prev.repeat, prev.buyers) : null),
      ],
      series: [this.series('buyers', 'Buyers', buckets, rq.granularity, new Map(byBucket.map((b) => [b.key!, b.buyers])))],
      callouts: [{ kind: 'info', title: 'Buyers are counted, not stored', body: 'A buyer is a signed-in customer or a guest email, kept only as a one-way key.' }],
      unavailable: [],
      models: ['customers', 'order_items'],
    };
  }

  private async campaignsReport(rq: ResolvedQuery, _cfg: Settings): Promise<Part> {
    const c = rq.currency;
    const COLS = ['sales_minor', 'discount_cost_minor', 'redemptions', 'displays', 'clicks', 'dismissals', 'spend_minor', 'attributed_purchases'];
    const sums = async (r: DayRange, kind: 'promotion' | 'ad') => (await this.core.repo.dailySums('fact_campaigns_daily', { from: r.from, to: r.to, campaignKind: kind }, COLS, 'none'))[0] ?? zeros(COLS);
    const promo = await sums(rq.range, 'promotion');
    const ads = await sums(rq.range, 'ad');
    const prevPromo = rq.compare ? await sums(rq.compare, 'promotion') : null;
    const prevAds = rq.compare ? await sums(rq.compare, 'ad') : null;
    const byCampaign = (await this.core.repo.dailySums('fact_campaigns_daily', rq.range, COLS, 'campaign')).sort((a, b) => b.discount_cost_minor! + b.spend_minor! - (a.discount_cost_minor! + a.spend_minor!));
    return {
      kpis: [
        this.kpi('marketing.discount_cost', promo.discount_cost_minor!, c, prevPromo?.discount_cost_minor ?? null, promo.sales_minor ? `on ${displayMoney(promo.sales_minor, c)} sales` : null),
        this.kpi('marketing.redemptions', promo.redemptions!, c, prevPromo?.redemptions ?? null),
        this.kpi('ads.spend', ads.spend_minor!, c, prevAds?.spend_minor ?? null),
        this.kpi('ads.displays', ads.displays!, c, prevAds?.displays ?? null),
        this.kpi('ads.clicks', ads.clicks!, c, prevAds?.clicks ?? null, ads.displays ? `${pct(ads.clicks!, ads.displays!)}% of displays` : null),
      ],
      series: [],
      table: {
        columns: [col('kind', 'Kind'), col('campaignId', 'Campaign'), col('sales', 'Sales', 'money'), col('discountCost', 'Discount cost', 'money'), col('redemptions', 'Redemptions', 'count'), col('spend', 'Ad spending', 'money'), col('displays', 'Displays', 'count'), col('clicks', 'Clicks', 'count'), col('attributedPurchases', 'Attributed purchases', 'count')],
        rows: byCampaign.map((r) => {
          const [kind, id] = String(r.key).split(':');
          return { kind, campaignId: id, sales: this.money(r.sales_minor!, c), discountCost: this.money(r.discount_cost_minor!, c), redemptions: r.redemptions, spend: this.money(r.spend_minor!, c), displays: r.displays, clicks: r.clicks, attributedPurchases: r.attributed_purchases };
        }),
        totals: { sales: this.money(promo.sales_minor!, c), discountCost: this.money(promo.discount_cost_minor!, c), redemptions: promo.redemptions, spend: this.money(ads.spend_minor!, c), displays: ads.displays, clicks: ads.clicks, attributedPurchases: ads.attributed_purchases },
      },
      callouts: [{ kind: 'info', title: 'Campaign detail lives with each campaign', body: 'Promotions and advertising show each campaign’s own results; this report sums them across campaigns.' }],
      unavailable: [...(this.core.running('promotions') ? [] : ['marketing.discount_cost', 'marketing.redemptions']), ...(this.core.running('advertising') ? [] : ['ads.spend', 'ads.displays', 'ads.clicks'])],
      models: ['campaigns'],
    };
  }

  /* ---------------------------------------------------------------- G74: more of the design's report library */

  /** Discounts on marketplace seller items: platform-funded and seller-funded, per period and seller (order items) */
  private async discountFundingReport(rq: ResolvedQuery, scope: ReportScope, cfg: Settings): Promise<Part> {
    const c = rq.currency;
    const marketplace = { ownerType: 'seller' as const };
    const total = await this.salesTotals(rq, scope, rq.range, marketplace);
    const prev = rq.compare ? await this.salesTotals(rq, scope, rq.compare, marketplace) : null;
    const buckets = bucketsOf(rq.range, rq.granularity);
    const byBucket = await this.core.repo.salesAgg(this.salesFilter(rq, scope, rq.range, marketplace), 'bucket', rq.granularity);
    const bySeller = (await this.core.repo.salesAgg(this.salesFilter(rq, scope, rq.range, marketplace), 'seller_id')).filter((s) => s.platformDiscount || s.sellerDiscount).sort((a, b) => b.platformDiscount - a.platformDiscount);
    const names = await this.sellerNames(bySeller.map((s) => s.key!));
    return {
      kpis: [
        this.kpi('marketplace.discount_funding', total.platformDiscount, c, prev?.platformDiscount ?? null, `sellers funded ${displayMoney(total.sellerDiscount, c)}`),
        this.kpi('marketplace.seller_sales', this.gross(total, cfg), c, prev ? this.gross(prev, cfg) : null),
      ],
      series: [
        this.series('platform_discount', 'Platform-funded discounts', buckets, rq.granularity, new Map(byBucket.map((b) => [b.key!, b.platformDiscount]))),
        this.series('seller_discount', 'Seller-funded discounts', buckets, rq.granularity, new Map(byBucket.map((b) => [b.key!, b.sellerDiscount]))),
      ],
      table: {
        columns: [col('seller', 'Seller'), col('sales', 'Marketplace sales', 'money'), col('platformDiscount', 'Platform-funded', 'money'), col('sellerDiscount', 'Seller-funded', 'money')],
        rows: bySeller.map((s) => ({ sellerId: s.key, seller: names.get(s.key!) ?? s.key, sales: this.money(this.gross(s, cfg), c), platformDiscount: this.money(s.platformDiscount, c), sellerDiscount: this.money(s.sellerDiscount, c) })),
        totals: { sales: this.money(this.gross(total, cfg), c), platformDiscount: this.money(total.platformDiscount, c), sellerDiscount: this.money(total.sellerDiscount, c) },
      },
      callouts: [{ kind: 'info', title: 'Discounts are on the items they were given on', body: 'Customer discounts count on the day of the item’s date basis, split by who paid for them. Shared campaigns count each side’s share.' }],
      unavailable: [],
      models: ['order_items'],
    };
  }

  /** Seller balances now (finance.sellerBalanceTotals, getSellerBalances) for the sellers active in the range */
  private async sellerBalancesReport(rq: ResolvedQuery, scope: ReportScope, cfg: Settings): Promise<Part> {
    const c = rq.currency;
    const finance = this.core.api('finance');
    if (!finance || !this.core.running('finance')) return { kpis: [], series: [], callouts: [], unavailable: ['marketplace.seller_balances', 'marketplace.amounts_owed'], models: [] };
    const sellerId = this.sellerOf(rq, scope);
    const totals = sellerId ? undefined : await this.core.soft('finance.sellerBalanceTotals', () => finance.sellerBalanceTotals());
    const [fin] = await this.core.repo.dailySums('fact_marketplace_finance_daily', { from: rq.range.from, to: rq.range.to, ...(sellerId ? { sellerId } : {}) }, ['owed_minor'], 'none');
    const active = sellerId
      ? [sellerId]
      : [
          ...new Set([
            ...(await this.core.repo.salesAgg(this.salesFilter(rq, scope, rq.range, { ownerType: 'seller' }), 'seller_id')).map((s) => s.key!),
            ...(await this.core.repo.dailySums('fact_marketplace_finance_daily', { from: rq.range.from, to: rq.range.to }, ['owed_minor'], 'seller_id')).map((s) => s.key!),
          ]),
        ].filter((id) => id && id !== OFFICIAL_KEY).slice(0, 100);
    const names = await this.sellerNames(active);
    const balances = (await Promise.all(active.map(async (id) => ({ id, b: await this.core.soft('finance.getSellerBalances', () => finance.getSellerBalances(id)) })))).filter((x) => x.b);
    const amount = (m: Money | null | undefined) => m?.amount ?? 0;
    const rows = balances
      .map(({ id, b }) => ({ sellerId: id, seller: names.get(id) ?? id, pending: this.money(amount(b!.pending), c), available: this.money(amount(b!.available), c), held: this.money(amount(b!.held), c), total: this.money(amount(b!.pending) + amount(b!.available) + amount(b!.held), c), negative: Boolean(b!.negative), amountOwed: this.money(amount(b!.amountOwed), c) }))
      .sort((a, b) => b.total.amount - a.total.amount);
    const listed = rows.reduce((n, r) => n + r.total.amount, 0);
    return {
      kpis: [
        this.kpi('marketplace.seller_balances', totals ? amount(totals.total) : listed, c, null, totals ? `${displayMoney(amount(totals.held), c)} held · ${totals.negativeCount} negative` : null),
        this.kpi('marketplace.amounts_owed', fin?.owed_minor ?? 0, c, null),
      ],
      series: [],
      table: {
        columns: [col('seller', 'Seller'), col('pending', 'Pending', 'money'), col('available', 'Available', 'money'), col('held', 'Held', 'money'), col('total', 'Owed to the seller', 'money'), col('amountOwed', 'Owed by the seller', 'money')],
        rows,
        totals: { total: this.money(listed, c) },
      },
      callouts: [{ kind: 'info', title: 'Balances are as of now', body: 'Seller balances are read from finance when the report runs; the date range picks which sellers are listed (those with sales or finance activity in it). Amounts owed by sellers are for the range.' }],
      unavailable: [],
      models: ['order_items', 'marketplace_finance'],
    };
  }

  /** Holds and payouts per period and seller (fact_marketplace_finance_daily) */
  private async payoutsReport(rq: ResolvedQuery, scope: ReportScope): Promise<Part> {
    const c = rq.currency;
    const sellerId = this.sellerOf(rq, scope);
    const COLS = ['held_minor', 'payouts_paid_minor', 'payouts_failed'];
    const f = (r: DayRange) => ({ from: r.from, to: r.to, ...(sellerId ? { sellerId } : {}) });
    const total = (await this.core.repo.dailySums('fact_marketplace_finance_daily', f(rq.range), COLS, 'none'))[0] ?? zeros(COLS);
    const prev = rq.compare ? ((await this.core.repo.dailySums('fact_marketplace_finance_daily', f(rq.compare), COLS, 'none'))[0] ?? zeros(COLS)) : null;
    const buckets = bucketsOf(rq.range, rq.granularity);
    const byBucket = await this.core.repo.dailySums('fact_marketplace_finance_daily', f(rq.range), COLS, 'bucket', rq.granularity);
    const bySeller = (await this.core.repo.dailySums('fact_marketplace_finance_daily', f(rq.range), COLS, 'seller_id')).filter((s) => s.held_minor || s.payouts_paid_minor || s.payouts_failed).sort((a, b) => b.payouts_paid_minor! - a.payouts_paid_minor!);
    const names = await this.sellerNames(bySeller.map((s) => s.key!));
    return {
      kpis: [
        this.kpi('marketplace.held', total.held_minor!, c, prev?.held_minor ?? null),
        this.kpi('marketplace.payouts_paid', total.payouts_paid_minor!, c, prev?.payouts_paid_minor ?? null, total.payouts_failed ? `${total.payouts_failed} failed` : null),
      ],
      series: [
        this.series('payouts_paid', 'Payouts paid', buckets, rq.granularity, new Map(byBucket.map((b) => [b.key!, b.payouts_paid_minor!]))),
        this.series('held', 'Holds placed (net)', buckets, rq.granularity, new Map(byBucket.map((b) => [b.key!, b.held_minor!]))),
      ],
      table: {
        columns: [col('seller', 'Seller'), col('held', 'Holds (net)', 'money'), col('payoutsPaid', 'Payouts paid', 'money'), col('payoutsFailed', 'Failed payouts', 'count')],
        rows: bySeller.map((s) => ({ sellerId: s.key, seller: names.get(s.key!) ?? s.key, held: this.money(s.held_minor!, c), payoutsPaid: this.money(s.payouts_paid_minor!, c), payoutsFailed: s.payouts_failed })),
        totals: { held: this.money(total.held_minor!, c), payoutsPaid: this.money(total.payouts_paid_minor!, c), payoutsFailed: total.payouts_failed },
      },
      callouts: [],
      unavailable: this.core.running('finance') ? [] : ['marketplace.held', 'marketplace.payouts_paid'],
      models: ['marketplace_finance'],
    };
  }

  /** Products out of stock in the range, longest first (fact_discovery_daily) */
  private async stockoutsReport(rq: ResolvedQuery): Promise<Part> {
    const c = rq.currency;
    const COLS = ['views', 'stockout_minutes'];
    const f = (r: DayRange) => ({ from: r.from, to: r.to, ...(rq.productId ? { productId: rq.productId } : {}) });
    const hours = (minutes: number) => Math.round((minutes / 60) * 10) / 10;
    const total = (await this.core.repo.dailySums('fact_discovery_daily', f(rq.range), COLS, 'none'))[0] ?? zeros(COLS);
    const prev = rq.compare ? ((await this.core.repo.dailySums('fact_discovery_daily', f(rq.compare), COLS, 'none'))[0] ?? zeros(COLS)) : null;
    const buckets = bucketsOf(rq.range, rq.granularity);
    const byBucket = await this.core.repo.dailySums('fact_discovery_daily', f(rq.range), COLS, 'bucket', rq.granularity);
    const byProduct = (await this.core.repo.dailySums('fact_discovery_daily', f(rq.range), COLS, 'product_id')).filter((p) => p.stockout_minutes! > 0).sort((a, b) => b.stockout_minutes! - a.stockout_minutes!).slice(0, 200);
    const names = await this.productNames(byProduct.map((p) => p.key!));
    return {
      kpis: [this.kpi('discovery.stockout_hours', hours(total.stockout_minutes!), c, prev ? hours(prev.stockout_minutes!) : null, `${byProduct.length} products out of stock`)],
      series: [this.series('stockout_hours', 'Out-of-stock hours', buckets, rq.granularity, new Map(byBucket.map((b) => [b.key!, hours(b.stockout_minutes!)])))],
      table: {
        columns: [col('product', 'Product'), col('stockoutHours', 'Out-of-stock hours', 'duration_hours'), col('views', 'Views', 'count')],
        rows: byProduct.map((p) => ({ productId: p.key, product: names.get(p.key!) ?? p.key, stockoutHours: hours(p.stockout_minutes!), views: p.views })),
        totals: { stockoutHours: hours(total.stockout_minutes!), views: total.views },
      },
      callouts: [{ kind: 'info', title: 'Views include out-of-stock time', body: 'Views are all views of the product in the range, in stock or not.' }],
      unavailable: this.core.running('inventory') ? [] : ['discovery.stockout_hours'],
      models: ['discovery'],
    };
  }

  /** One service area of fact_service_daily per report: dispatch, delivery issues, seller cancellations or cases */
  private async serviceFocusReport(key: string, rq: ResolvedQuery, scope: ReportScope): Promise<Part> {
    const c = rq.currency;
    const sellerId = this.sellerOf(rq, scope);
    const COLS = ['dispatched', 'dispatched_on_time', 'overdue', 'valid_tracking', 'seller_cancellations', 'delivery_exceptions', 'messages_received', 'cases_opened'];
    const f = (r: DayRange) => ({ from: r.from, to: r.to, ...(sellerId ? { sellerId } : {}) });
    const total = (await this.core.repo.dailySums('fact_service_daily', f(rq.range), COLS, 'none'))[0] ?? zeros(COLS);
    const prev = rq.compare ? ((await this.core.repo.dailySums('fact_service_daily', f(rq.compare), COLS, 'none'))[0] ?? zeros(COLS)) : null;
    const buckets = bucketsOf(rq.range, rq.granularity);
    const byBucket = await this.core.repo.dailySums('fact_service_daily', f(rq.range), COLS, 'bucket', rq.granularity);
    const bySeller = await this.core.repo.dailySums('fact_service_daily', f(rq.range), COLS, 'seller_id');
    const names = await this.sellerNames(bySeller.map((s) => s.key!));
    const onTime = (t: Record<string, number | null>) => pct(t.dispatched_on_time!, t.dispatched!);
    const tracking = (t: Record<string, number | null>) => pct(t.valid_tracking!, t.dispatched!);
    const seller = (s: { key: string | null }) => ({ sellerId: s.key === OFFICIAL_KEY ? null : s.key, seller: names.get(s.key!) ?? s.key });
    const by = (field: string) => [...bySeller].sort((a, b) => b[field]! - a[field]!);
    const part = (p: Omit<Part, 'callouts' | 'unavailable' | 'models'> & Partial<Pick<Part, 'callouts' | 'unavailable'>>): Part => ({ callouts: [], unavailable: [], models: ['service'], ...p });
    switch (key) {
      case 'service.dispatch':
        return part({
          kpis: [
            this.kpi('service.on_time_dispatch', onTime(total), c, prev ? onTime(prev) : null, `${total.dispatched_on_time} of ${total.dispatched} packages`),
            this.kpi('service.valid_tracking', tracking(total), c, prev ? tracking(prev) : null),
            this.kpi('service.overdue_dispatch', total.overdue!, c, prev?.overdue ?? null),
          ],
          series: [this.series('on_time_dispatch', 'On-time dispatch %', buckets, rq.granularity, new Map(byBucket.map((b) => [b.key!, onTime(b)])))],
          table: {
            columns: [col('seller', 'Seller'), col('dispatched', 'Dispatched', 'count'), col('onTimePct', 'On time', 'percent'), col('trackingPct', 'Valid tracking', 'percent'), col('overdue', 'Overdue', 'count')],
            rows: by('overdue').map((s) => ({ ...seller(s), dispatched: s.dispatched, onTimePct: onTime(s), trackingPct: tracking(s), overdue: s.overdue })),
            totals: { dispatched: total.dispatched, onTimePct: onTime(total), trackingPct: tracking(total), overdue: total.overdue },
          },
        });
      case 'service.delivery_issues':
        return part({
          kpis: [this.kpi('service.delivery_exceptions', total.delivery_exceptions!, c, prev?.delivery_exceptions ?? null, `${pct(total.delivery_exceptions!, total.dispatched!)}% of ${total.dispatched} packages`)],
          series: [this.series('delivery_exceptions', 'Delivery issues', buckets, rq.granularity, new Map(byBucket.map((b) => [b.key!, b.delivery_exceptions!])))],
          table: {
            columns: [col('seller', 'Seller'), col('deliveryExceptions', 'Delivery issues', 'count'), col('dispatched', 'Dispatched', 'count'), col('issueRate', 'Of dispatched', 'percent')],
            rows: by('delivery_exceptions').map((s) => ({ ...seller(s), deliveryExceptions: s.delivery_exceptions, dispatched: s.dispatched, issueRate: pct(s.delivery_exceptions!, s.dispatched!) })),
            totals: { deliveryExceptions: total.delivery_exceptions, dispatched: total.dispatched, issueRate: pct(total.delivery_exceptions!, total.dispatched!) },
          },
        });
      case 'service.cancellations':
        return part({
          kpis: [this.kpi('service.seller_cancellations', total.seller_cancellations!, c, prev?.seller_cancellations ?? null)],
          series: [this.series('seller_cancellations', 'Seller cancellations', buckets, rq.granularity, new Map(byBucket.map((b) => [b.key!, b.seller_cancellations!])))],
          table: {
            columns: [col('seller', 'Seller'), col('sellerCancellations', 'Seller cancellations', 'count'), col('dispatched', 'Dispatched', 'count')],
            rows: by('seller_cancellations').map((s) => ({ ...seller(s), sellerCancellations: s.seller_cancellations, dispatched: s.dispatched })),
            totals: { sellerCancellations: total.seller_cancellations, dispatched: total.dispatched },
          },
        });
      default: {
        // response times are read from support and messaging when the report runs
        const now = await this.responseFigures(rq.range, sellerId);
        const before = rq.compare ? await this.responseFigures(rq.compare, sellerId) : null;
        const unavailable = [...(now.cases ? [] : ['service.response_time', 'service.first_reply_on_time']), ...(now.messages ? [] : ['service.message_reply_time'])];
        const ids = [...new Set([...bySeller.map((s) => s.key!), ...now.bySeller.keys()])].filter(Boolean);
        const allNames = await this.sellerNames(ids);
        const sums = new Map(bySeller.map((s) => [s.key!, s]));
        return part({
          kpis: [
            this.kpi('service.cases_opened', total.cases_opened!, c, prev?.cases_opened ?? null),
            this.kpi('service.case_backlog', await this.core.repo.caseBacklog(rq.range.to, sellerId), c, rq.compare ? await this.core.repo.caseBacklog(rq.compare.to, sellerId) : null, `open at the end of ${dayLabel(rq.range.to)}`),
            ...(now.cases
              ? [
                  this.kpi('service.response_time', hoursOf(now.cases.minutes, now.cases.replied), c, before?.cases ? hoursOf(before.cases.minutes, before.cases.replied) : null, `${now.cases.replied} of ${now.cases.opened} cases answered`),
                  this.kpi('service.first_reply_on_time', pct(now.cases.onTime, now.cases.opened), c, before?.cases ? pct(before.cases.onTime, before.cases.opened) : null),
                ]
              : []),
            this.kpi('service.messages_received', total.messages_received!, c, prev?.messages_received ?? null),
            ...(now.messages ? [this.kpi('service.message_reply_time', hoursOf(now.messages.minutes, now.messages.replied), c, before?.messages ? hoursOf(before.messages.minutes, before.messages.replied) : null, `${now.messages.replied} of ${now.messages.waiting} messages answered`)] : []),
          ],
          series: [
            this.series('cases_opened', 'Support cases opened', buckets, rq.granularity, new Map(byBucket.map((b) => [b.key!, b.cases_opened!]))),
            this.series('messages_received', 'Customer messages', buckets, rq.granularity, new Map(byBucket.map((b) => [b.key!, b.messages_received!]))),
            ...(now.cases ? [this.series('response_time', 'Average first reply on cases (hours)', buckets, rq.granularity, now.caseHoursByBucket(rq.granularity))] : []),
          ],
          table: {
            columns: [col('seller', 'Seller'), col('casesOpened', 'Cases opened', 'count'), col('firstReplyHours', 'First reply on cases', 'duration_hours'), col('messages', 'Messages', 'count'), col('messageReplyHours', 'Seller reply to messages', 'duration_hours')],
            rows: ids
              .map((id) => {
                const s = sums.get(id);
                const r = now.bySeller.get(id);
                return {
                  sellerId: id === OFFICIAL_KEY ? null : id,
                  seller: allNames.get(id) ?? id,
                  casesOpened: s?.cases_opened ?? 0,
                  firstReplyHours: r?.caseReplied ? hoursOf(r.caseMinutes, r.caseReplied) : null,
                  messages: s?.messages_received ?? 0,
                  messageReplyHours: r?.messageReplied ? hoursOf(r.messageMinutes, r.messageReplied) : null,
                };
              })
              .sort((a, b) => b.casesOpened - a.casesOpened || b.messages - a.messages),
            totals: {
              casesOpened: total.cases_opened,
              firstReplyHours: now.cases ? hoursOf(now.cases.minutes, now.cases.replied) : null,
              messages: total.messages_received,
              messageReplyHours: now.messages ? hoursOf(now.messages.minutes, now.messages.replied) : null,
            },
          },
          callouts: [{ kind: 'info', title: 'How response times are counted', body: 'Reply times are wall-clock hours from the case opening or the customer message to the first reply, for those that were answered; the share within target uses the case targets, which count business hours only.' }],
          unavailable,
        });
      }
    }
  }

  /**
   * First replies on support cases (support.caseStatsByDay) and seller replies to customer messages
   * (messaging.replyStatsByDay) in a range, in total and per seller. null parts when the module is off.
   */
  private async responseFigures(range: DayRange, sellerId?: string) {
    const support = this.core.api('support');
    const messaging = this.core.api('messaging');
    const caseRows = support ? await this.core.soft('support.caseStatsByDay', () => support.caseStatsByDay(range, sellerId)) : undefined;
    const messageRows = messaging ? await this.core.soft('messaging.replyStatsByDay', () => messaging.replyStatsByDay(range, sellerId)) : undefined;
    const bySeller = new Map<string, { caseReplied: number; caseMinutes: number; messageReplied: number; messageMinutes: number }>();
    const of = (id: string | null | undefined) => {
      const key = id ?? OFFICIAL_KEY;
      const v = bySeller.get(key) ?? { caseReplied: 0, caseMinutes: 0, messageReplied: 0, messageMinutes: 0 };
      bySeller.set(key, v);
      return v;
    };
    for (const r of caseRows ?? []) {
      const v = of(r.sellerId);
      v.caseReplied += r.firstReplied;
      v.caseMinutes += r.firstReplyMinutesTotal;
    }
    for (const r of messageRows ?? []) {
      const v = of(r.sellerId);
      v.messageReplied += r.replied;
      v.messageMinutes += r.replyMinutesTotal;
    }
    const add = <T,>(rows: T[], f: (r: T) => number) => rows.reduce((n, r) => n + f(r), 0);
    return {
      cases: caseRows ? { opened: add(caseRows, (r) => r.opened), replied: add(caseRows, (r) => r.firstReplied), minutes: add(caseRows, (r) => r.firstReplyMinutesTotal), onTime: add(caseRows, (r) => r.firstReplyWithinTarget) } : null,
      messages: messageRows ? { waiting: add(messageRows, (r) => r.waiting), replied: add(messageRows, (r) => r.replied), minutes: add(messageRows, (r) => r.replyMinutesTotal) } : null,
      bySeller,
      caseHoursByBucket: (g: Granularity) => {
        const acc = new Map<string, { m: number; n: number }>();
        for (const r of caseRows ?? []) {
          const b = bucketOf(r.date, g);
          const v = acc.get(b) ?? { m: 0, n: 0 };
          v.m += r.firstReplyMinutesTotal;
          v.n += r.firstReplied;
          acc.set(b, v);
        }
        return new Map([...acc].map(([b, v]) => [b, hoursOf(v.m, v.n)]));
      },
    };
  }

  /** Official Store trading costs booked in finance (companyCostsByDay), read when the report runs */
  private async companyCostsReport(key: string, rq: ResolvedQuery, cfg: Settings): Promise<Part> {
    const c = rq.currency;
    const kinds = COST_REPORTS[key]!;
    const finance = this.core.api('finance');
    const load = async (r: DayRange) => (finance ? ((await this.core.soft('finance.companyCostsByDay', () => finance.companyCostsByDay(r))) ?? null) : null);
    const rows = await load(rq.range);
    const prev = rq.compare ? await load(rq.compare) : null;
    const sum = (rs: { kind: string; amount: Money }[], kind: string) => rs.filter((r) => r.kind === kind).reduce((n, r) => n + r.amount.amount, 0);
    const buckets = bucketsOf(rq.range, rq.granularity);
    const perBucket = (kind: string) => {
      const out = new Map<string, number>();
      for (const r of rows ?? []) if (r.kind === kind) out.set(bucketOf(r.date, rq.granularity), (out.get(bucketOf(r.date, rq.granularity)) ?? 0) + r.amount.amount);
      return out;
    };
    const kpis: KpiValue[] = rows ? kinds.map((k) => this.kpi(k.metric, sum(rows, k.kind), c, prev ? sum(prev, k.kind) : null)) : [];
    const series: Series[] = rows ? kinds.map((k) => this.series(suffix(k.metric), k.label, buckets, rq.granularity, perBucket(k.kind))) : [];
    const columns = [col('period', 'Period'), ...kinds.map((k) => col(suffix(k.metric), k.label, 'money'))];
    const extra: Record<string, number>[] = buckets.map(() => ({}));
    const extraTotals: Record<string, number> = {};
    const callouts: Callout[] = [];

    // context from the order items read model: buying cost of the units sold / Official Store sales
    const official = { ownerType: 'official' as const };
    const scope: ReportScope = { kind: 'platform' };
    if (key === 'trading.purchasing' || key === 'trading.discounts_shipping') {
      const metric = key === 'trading.purchasing' ? 'trading.buying_cost' : 'trading.official_sales';
      const value = (a: SalesAgg) => (key === 'trading.purchasing' ? a.cost : this.gross(a, cfg));
      const total = await this.salesTotals(rq, scope, rq.range, official);
      const before = rq.compare ? await this.salesTotals(rq, scope, rq.compare, official) : null;
      const byBucket = new Map((await this.core.repo.salesAgg(this.salesFilter(rq, scope, rq.range, official), 'bucket', rq.granularity)).map((b) => [b.key!, value(b)]));
      kpis.unshift(this.kpi(metric, value(total), c, before ? value(before) : null, key === 'trading.purchasing' ? 'units sold, from the order date' : null));
      series.unshift(this.series(suffix(metric), metricSeed(metric)!.name, buckets, rq.granularity, byBucket));
      columns.splice(1, 0, col(suffix(metric), metricSeed(metric)!.name, 'money'));
      buckets.forEach((b, i) => (extra[i]![suffix(metric)] = byBucket.get(b) ?? 0));
      extraTotals[suffix(metric)] = value(total);
      if (key === 'trading.discounts_shipping' && rows) {
        const spent = sum(rows, 'discount') + sum(rows, 'shipping_expense');
        callouts.push({ kind: 'info', title: 'Share of Official Store sales', body: `Discounts and shipping expense come to ${pct(spent, value(total))}% of Official Store sales in the range.` });
      }
      if (key === 'trading.purchasing') callouts.push({ kind: 'info', title: 'Two views of buying cost', body: 'Buying cost of units sold follows the order date; purchasing costs and supplier credits follow the day finance booked them.' });
    }
    const perKind = new Map(kinds.map((k) => [k.kind, perBucket(k.kind)]));
    return {
      kpis,
      series,
      table: {
        columns,
        rows: buckets.map((b, i) => ({ period: dayLabel(b, rq.granularity), ...Object.fromEntries(Object.entries(extra[i]!).map(([k, v]) => [k, this.money(v, c)])), ...Object.fromEntries(kinds.map((k) => [suffix(k.metric), this.money(perKind.get(k.kind)!.get(b) ?? 0, c)])) })),
        totals: { ...Object.fromEntries(Object.entries(extraTotals).map(([k, v]) => [k, this.money(v, c)])), ...Object.fromEntries(kinds.map((k) => [suffix(k.metric), this.money(rows ? sum(rows, k.kind) : 0, c)])) },
      },
      callouts,
      unavailable: rows ? [] : kinds.map((k) => k.metric),
      models: key === 'trading.returns_cost' ? [] : ['order_items'],
    };
  }

  /** Customer cases by reason and seller (support.caseStatsByDay), read when the report runs */
  private async complaintsReport(rq: ResolvedQuery, scope: ReportScope): Promise<Part> {
    const c = rq.currency;
    const sellerId = this.sellerOf(rq, scope);
    const support = this.core.api('support');
    const load = async (r: DayRange) => (support ? ((await this.core.soft('support.caseStatsByDay', () => support.caseStatsByDay(r, sellerId))) ?? null) : null);
    const all = await load(rq.range);
    if (!all) return { kpis: [], series: [], callouts: [], unavailable: ['service.complaints', 'service.response_time'], models: [] };
    const rows = all.filter((r) => r.audience === 'customer');
    const prev = rq.compare ? ((await load(rq.compare)) ?? []).filter((r) => r.audience === 'customer') : null;
    const opened = (rs: typeof rows) => rs.reduce((n, r) => n + r.opened, 0);
    const replyHours = (rs: typeof rows) => hoursOf(rs.reduce((n, r) => n + r.firstReplyMinutesTotal, 0), rs.reduce((n, r) => n + r.firstReplied, 0));
    const total = opened(rows);

    const byReason = new Map<string, { label: string; count: number; previous: number }>();
    for (const r of rows) {
      const v = byReason.get(r.categoryKey) ?? { label: r.categoryLabel, count: 0, previous: 0 };
      v.count += r.opened;
      byReason.set(r.categoryKey, v);
    }
    for (const r of prev ?? []) {
      const v = byReason.get(r.categoryKey) ?? { label: r.categoryLabel, count: 0, previous: 0 };
      v.previous += r.opened;
      byReason.set(r.categoryKey, v);
    }
    const reasons = [...byReason.entries()].map(([key, v]) => ({ key, ...v })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
    const top = reasons[0];

    const bySeller = new Map<string, { count: number; reasons: Map<string, number> }>();
    for (const r of rows) {
      const key = r.sellerId ?? OFFICIAL_KEY;
      const v = bySeller.get(key) ?? { count: 0, reasons: new Map<string, number>() };
      v.count += r.opened;
      v.reasons.set(r.categoryLabel, (v.reasons.get(r.categoryLabel) ?? 0) + r.opened);
      bySeller.set(key, v);
    }
    const names = await this.sellerNames([...bySeller.keys()]);
    const buckets = bucketsOf(rq.range, rq.granularity);
    const perBucket = new Map<string, number>();
    for (const r of rows) perBucket.set(bucketOf(r.date, rq.granularity), (perBucket.get(bucketOf(r.date, rq.granularity)) ?? 0) + r.opened);
    const growing = prev ? reasons.filter((r) => r.count > r.previous).sort((a, b) => b.count - b.previous - (a.count - a.previous))[0] : undefined;
    return {
      kpis: [
        this.kpi('service.complaints', total, c, prev ? opened(prev) : null, top ? `Most often: ${top.label} (${pct(top.count, total)}%)` : null),
        this.kpi('service.response_time', replyHours(rows), c, prev ? replyHours(prev) : null),
      ],
      series: [this.series('complaints', 'Customer complaints', buckets, rq.granularity, perBucket)],
      breakdowns: [
        {
          key: 'reason',
          label: 'Complaints by reason',
          rows: reasons.map((r) => ({ key: r.key, label: r.label, count: r.count, sharePct: pct(r.count, total), ...(prev ? { previous: r.previous, change: r.count - r.previous } : {}) })),
        },
      ],
      table: {
        columns: [col('seller', 'Seller'), col('complaints', 'Complaints', 'count'), col('share', 'Of all complaints', 'percent'), col('topReason', 'Most common reason')],
        rows: [...bySeller.entries()]
          .map(([id, v]) => ({
            sellerId: id === OFFICIAL_KEY ? null : id,
            seller: id === OFFICIAL_KEY ? 'Official Store or no seller' : (names.get(id) ?? id),
            complaints: v.count,
            share: pct(v.count, total),
            topReason: [...v.reasons.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
          }))
          .sort((a, b) => b.complaints - a.complaints),
        totals: { complaints: total, share: total ? 100 : 0 },
      },
      callouts: growing ? [{ kind: 'warning', title: `${growing.label} is growing`, body: `${growing.count} complaints against ${growing.previous} in the previous period.` }] : [],
      unavailable: [],
      models: [],
    };
  }

  /** Ads per period and campaign (fact_campaigns_daily, kind ad; displays, clicks and dismissals pulled daily from advertising) */
  private async adsReport(rq: ResolvedQuery): Promise<Part> {
    const c = rq.currency;
    const COLS = ['displays', 'clicks', 'dismissals', 'spend_minor', 'attributed_purchases'];
    const f = (r: DayRange) => ({ from: r.from, to: r.to, campaignKind: 'ad' as const });
    const total = (await this.core.repo.dailySums('fact_campaigns_daily', f(rq.range), COLS, 'none'))[0] ?? zeros(COLS);
    const prev = rq.compare ? ((await this.core.repo.dailySums('fact_campaigns_daily', f(rq.compare), COLS, 'none'))[0] ?? zeros(COLS)) : null;
    const buckets = bucketsOf(rq.range, rq.granularity);
    const byBucket = await this.core.repo.dailySums('fact_campaigns_daily', f(rq.range), COLS, 'bucket', rq.granularity);
    const byCampaign = (await this.core.repo.dailySums('fact_campaigns_daily', f(rq.range), COLS, 'campaign')).sort((a, b) => b.displays! - a.displays!);
    return {
      kpis: [
        this.kpi('ads.displays', total.displays!, c, prev?.displays ?? null),
        this.kpi('ads.clicks', total.clicks!, c, prev?.clicks ?? null, total.displays ? `${pct(total.clicks!, total.displays!)}% of displays` : null),
        this.kpi('ads.dismissals', total.dismissals!, c, prev?.dismissals ?? null, total.displays ? `${pct(total.dismissals!, total.displays!)}% of displays` : null),
        this.kpi('ads.spend', total.spend_minor!, c, prev?.spend_minor ?? null),
      ],
      series: [
        this.series('displays', 'Ad displays', buckets, rq.granularity, new Map(byBucket.map((b) => [b.key!, b.displays!]))),
        this.series('clicks', 'Ad clicks', buckets, rq.granularity, new Map(byBucket.map((b) => [b.key!, b.clicks!]))),
      ],
      table: {
        columns: [col('campaignId', 'Campaign'), col('displays', 'Displays', 'count'), col('clicks', 'Clicks', 'count'), col('clickRate', 'Click rate', 'percent'), col('dismissals', 'Dismissals', 'count'), col('spend', 'Ad spending', 'money'), col('attributedPurchases', 'Attributed purchases', 'count')],
        rows: byCampaign.map((r) => ({ campaignId: String(r.key).split(':')[1] ?? r.key, displays: r.displays, clicks: r.clicks, clickRate: pct(r.clicks!, r.displays!), dismissals: r.dismissals, spend: this.money(r.spend_minor!, c), attributedPurchases: r.attributed_purchases })),
        totals: { displays: total.displays, clicks: total.clicks, clickRate: pct(total.clicks!, total.displays!), dismissals: total.dismissals, spend: this.money(total.spend_minor!, c), attributedPurchases: total.attributed_purchases },
      },
      callouts: [{ kind: 'info', title: 'Updated daily', body: 'Displays, clicks and dismissals are added overnight from advertising.' }],
      unavailable: this.core.running('advertising') ? [] : ['ads.displays', 'ads.clicks', 'ads.dismissals', 'ads.spend'],
      models: ['campaigns'],
    };
  }

  /* ---------------------------------------------------------------- dashboards */

  async adminDashboard(period: Period): Promise<AdminDashboardData> {
    const cfg = await this.core.cfg();
    const c = cfg.currency;
    const tz = cfg.timeZone;
    const today = marketDay(this.core.now(), tz);
    const range = presetRange(period, today);
    const compare = previousRange(range);
    const rq: ResolvedQuery = { preset: period, range, compare, basis: 'placement', soldBy: 'all', currency: c, timeZone: tz, granularity: 'day', filters: {} };
    const platform: ReportScope = { kind: 'platform' };
    const [total, prev] = await Promise.all([this.salesTotals(rq, platform, range), this.salesTotals(rq, platform, compare)]);
    const gross = this.gross(total, cfg);
    const pGross = this.gross(prev, cfg);
    const sellerSales = this.gross(await this.salesTotals(rq, platform, range, { ownerType: 'seller' }), cfg);
    const fee = async (r: DayRange) => (await this.core.repo.dailySums('fact_marketplace_finance_daily', r, ['fee_income_minor'], 'none'))[0]?.fee_income_minor ?? 0;
    const refunds = async (r: DayRange) => (await this.core.repo.refundsAgg({ ...instantsOf(r, tz), timeZone: tz }, 'none'))[0]?.amount ?? 0;
    const [feeNow, feePrev, refNow, refPrev] = await Promise.all([fee(range), fee(compare), refunds(range), refunds(compare)]);
    const unavailable: string[] = [];
    if (!this.core.running('finance')) unavailable.push('marketplace.fee_income');
    const aov = total.orders ? Math.round(gross / total.orders) : 0;
    const kpis = [
      { ...this.kpi('commerce.gross_sales', gross, c, pGross), unit: 'money' as const },
      { ...this.kpi('commerce.orders', total.orders, c, prev.orders, `avg ${displayMoney(aov, c)}`), unit: 'count' as const },
      ...(unavailable.includes('marketplace.fee_income') ? [] : [{ ...this.kpi('marketplace.fee_income', feeNow, c, feePrev, `on ${displayMoney(sellerSales, c)} seller sales`), unit: 'money' as const }]),
      { ...this.kpi('commerce.refunds', refNow, c, refPrev, `${pct(refNow, gross)}% of gross`), unit: 'money' as const },
    ];
    // the sales chart always covers the last 14 days, whatever the period
    const chart = presetRange('last_14_days', today);
    const buckets = bucketsOf(chart, 'day');
    const line = async (ownerType: 'official' | 'seller') => {
      const rows = await this.core.repo.salesAgg(this.salesFilter(rq, platform, chart, { ownerType }), 'bucket', 'day');
      return new Map(rows.map((r) => [r.key!, this.gross(r, cfg)]));
    };
    const [officialLine, marketplaceLine] = await Promise.all([line('official'), line('seller')]);
    const official = this.gross(await this.salesTotals(rq, platform, range, { ownerType: 'official' }), cfg);
    const definitions = await this.defs.inUse(['commerce.gross_sales', 'commerce.orders', 'commerce.average_order_value', 'marketplace.fee_income', 'marketplace.seller_sales', 'commerce.refunds']);
    return {
      period,
      range,
      compare,
      asOf: this.core.now().toISOString(),
      dateBasis: 'Gross sales by order placement date',
      currency: c,
      timeZone: tz,
      taxIncluded: cfg.taxIncluded,
      kpis,
      series: [this.series('official', 'Official Store', buckets, 'day', officialLine), this.series('marketplace', 'Marketplace sellers', buckets, 'day', marketplaceLine)],
      split: [
        { key: 'official', label: 'Official Store', amount: this.money(official, c), sharePct: pct(official, official + sellerSales) },
        { key: 'marketplace', label: 'Marketplace sellers', amount: this.money(sellerSales, c), sharePct: pct(sellerSales, official + sellerSales) },
      ],
      definitions,
      unavailable,
    };
  }

  toAdminDashboard(d: AdminDashboardData): AdminDashboard {
    return {
      period: d.period as AdminDashboard['period'],
      range: d.range,
      asOf: d.asOf,
      dateBasis: d.dateBasis,
      kpis: d.kpis.map(({ unit: _unit, ...k }) => k),
      salesSplit: { series: d.series, official: d.split[0]!.amount, marketplace: d.split[1]!.amount, officialSharePct: d.split[0]!.sharePct, compareRange: d.compare, currency: d.currency, timeZone: d.timeZone, taxIncluded: d.taxIncluded },
      definitions: d.definitions,
      unavailable: d.unavailable,
    };
  }

  async sellerDashboard(sellerId: string, period: Period, opts: { canViewFinance?: boolean; canViewServiceFees?: boolean } = {}): Promise<SellerDashboardData> {
    const cfg = await this.core.cfg();
    const c = cfg.currency;
    const tz = cfg.timeZone;
    const now = this.core.now();
    const today = marketDay(now, tz);
    const range = presetRange(period, today);
    const compare = previousRange(range);
    const scope: ReportScope = { kind: 'seller', sellerId };
    const rq: ResolvedQuery = { preset: period, range, compare, basis: 'placement', soldBy: 'marketplace', currency: c, timeZone: tz, granularity: 'day', filters: {} };
    const unavailable: string[] = [];
    const [total, prev, todayAgg] = await Promise.all([this.salesTotals(rq, scope, range), this.salesTotals(rq, scope, compare), this.salesTotals(rq, scope, { from: today, to: today })]);
    const gross = this.gross(total, cfg);
    const chartRange = presetRange('last_14_days', today);
    const buckets = bucketsOf(chartRange, 'day');
    const byDay = await this.core.repo.salesAgg(this.salesFilter(rq, scope, chartRange), 'bucket', 'day');
    const series = [this.series('sales', 'Item sales', buckets, 'day', new Map(byDay.map((b) => [b.key!, this.gross(b, cfg)])))];
    const aov = total.orders ? Math.round(gross / total.orders) : 0;
    const prevGross = this.gross(prev, cfg);
    const sales = {
      range,
      compareRange: compare,
      gross: this.money(gross, c),
      deltaPct: prevGross ? Math.round(((gross - prevGross) / prevGross) * 1000) / 10 : null,
      orders: total.orders,
      averageOrder: this.money(aov, c),
      today: this.money(this.gross(todayAgg, cfg), c),
      todayOrders: todayAgg.orders,
      series,
      basis: 'item sales before fees, by order date',
      kpis: [
        { ...this.kpi('commerce.gross_sales', gross, c, prevGross, 'item sales before fees, by order date'), unit: 'money' as const },
        { ...this.kpi('commerce.orders', total.orders, c, prev.orders), unit: 'count' as const },
        { ...this.kpi('commerce.average_order_value', aov, c, prev.orders ? Math.round(prevGross / prev.orders) : 0), unit: 'money' as const },
        { ...this.kpi('commerce.gross_sales', this.gross(todayAgg, cfg), c, null, `${todayAgg.orders} orders today`), label: 'Today so far', unit: 'money' as const },
      ] as (KpiValue & { unit: MetricDefinition['unit'] })[],
      serviceFees: null as { amount: Money; deltaPct: number | null; label: string; basis: string } | null,
    };

    /* Fulfilled by Marketly: the service-fees line (fees charged less reversals in the range), for members who may view service fees */
    const shownMetrics = ['commerce.gross_sales', 'commerce.orders', 'commerce.average_order_value'];
    if (opts.canViewServiceFees !== false) {
      const fees = async (r: DayRange) => (await this.core.repo.dailySums('fact_marketplace_finance_daily', { ...r, sellerId }, ['service_fees_minor'], 'none'))[0]?.service_fees_minor ?? 0;
      const [feesNow, feesPrev] = await Promise.all([fees(range), fees(compare)]);
      if (this.core.running('fulfillment-service') || feesNow || feesPrev) {
        sales.serviceFees = { amount: this.money(feesNow, c), deltaPct: feesPrev ? Math.round(((feesNow - feesPrev) / feesPrev) * 1000) / 10 : null, label: 'Fulfilled by Marketly fees', basis: 'fees charged less reversals, by charge date' };
        sales.kpis.push({ ...this.kpi('marketplace.service_fees', feesNow, c, feesPrev, 'Fulfilled by Marketly'), unit: 'money' as const });
        shownMetrics.push('marketplace.service_fees');
      }
    }

    /* work for today: orders, inventory, returns, messaging and workqueues counts */
    const workToday: SellerWorkTile[] = [];
    const orders = this.core.api('orders');
    const counts = orders ? await this.core.soft('orders.countSellerOrders', () => orders.countSellerOrders(sellerId)) : undefined;
    let dispatchDeadlines: unknown[] = [];
    if (counts) {
      workToday.push(
        { key: 'overdue_dispatch', count: counts.overdue, sub: counts.overdue ? 'Past the dispatch deadline' : 'Nothing overdue', tone: counts.overdue ? 'danger' : 'neutral', screen: 'seller/orders', screenState: 'overdue' },
        { key: 'dispatch_due_today', count: counts.dueToday, sub: counts.dueToday ? 'Ship by 23:59 today' : 'Nothing due today', tone: counts.dueToday ? 'warning' : 'neutral', screen: 'seller/orders', screenState: 'due_today' },
        { key: 'new_orders', count: counts.new, sub: counts.new ? 'Waiting to be prepared' : 'No new orders', tone: 'neutral', screen: 'seller/orders', screenState: 'new' },
      );
      const page = await this.core.soft('orders.listOrdersForSeller', () => orders!.listOrdersForSeller(sellerId, { tabs: ['new', 'preparing'], sort: 'dispatch_deadline' }, { limit: 5 }));
      dispatchDeadlines = (page?.items ?? [])
        .flatMap(({ order, groups }) =>
          groups.map((g) => ({
            orderId: order.id,
            orderRef: g.ref,
            placedAt: g.placedAt,
            buyerLabel: g.buyerName,
            itemsLabel: itemsLabel(g.items as { title?: string; quantity?: number }[]),
            deadline: g.dispatchDeadline,
            nextAction: nextActionLabel(g.allowedActions),
          })),
        )
        .sort((a, b) => a.deadline.dueAt.localeCompare(b.deadline.dueAt))
        .slice(0, 5);
    } else unavailable.push('orders');

    const inventory = this.core.api('inventory');
    const stock = inventory ? await this.core.soft('inventory.getSellerStockSummary', () => inventory.getSellerStockSummary(sellerId)) : undefined;
    if (stock) {
      const low = stock.lowStockSkus + stock.outOfStockSkus;
      workToday.push({ key: 'low_stock', count: low, sub: stock.outOfStockSkus ? `${stock.outOfStockSkus} out of stock${stock.outOfStockLabels.length ? ` · ${stock.outOfStockLabels.slice(0, 2).join(', ')}` : ''}` : low ? 'Running low' : 'Stock looks fine', tone: stock.outOfStockSkus ? 'danger' : low ? 'warning' : 'neutral', screen: 'seller/inventory', screenState: 'low_stock' });
    } else unavailable.push('inventory');

    const returns = this.core.api('returns');
    const rc = returns ? await this.core.soft('returns.sellerQueueCounts', () => returns.sellerQueueCounts(sellerId)) : undefined;
    if (rc) {
      const open = rc.awaitingResponse + rc.toInspect + rc.disputesNeedingEvidence;
      workToday.push({ key: 'open_returns', count: open, sub: rc.responseOverdue ? `${rc.responseOverdue} response overdue${rc.overdueRef ? ` · ${rc.overdueRef}` : ''}` : rc.awaitingResponse ? `${rc.awaitingResponse} waiting for your answer` : 'Nothing waiting', tone: rc.responseOverdue ? 'danger' : rc.awaitingResponse ? 'warning' : 'neutral', screen: 'seller/returns' });
    } else unavailable.push('returns');

    const messaging = this.core.api('messaging');
    const inbox = messaging ? await this.core.soft('messaging.sellerInboxSummary', () => messaging.sellerInboxSummary(sellerId)) : undefined;
    if (inbox) {
      workToday.push({ key: 'unanswered_messages', count: inbox.awaitingReply, sub: inbox.overdue ? `${inbox.overdue} past the ${inbox.targetHours} h reply target` : inbox.awaitingReply ? `Reply within ${inbox.targetHours} h` : 'All answered', tone: inbox.overdue ? 'danger' : inbox.awaitingReply ? 'warning' : 'neutral', screen: 'seller/messages' });
    } else unavailable.push('messaging');

    const workqueues = this.core.api('workqueues');
    const tasks = workqueues ? await this.core.soft('workqueues.sellerTaskCounts', () => workqueues.sellerTaskCounts(sellerId)) : undefined;
    if (tasks) {
      // seller-visible tasks add to the matching tile (e.g. a staff-raised dispatch follow-up)
      for (const [kind, n] of Object.entries(tasks)) {
        const tile = workToday.find((t) => t.key === kind || (kind.includes('dispatch') && t.key === 'overdue_dispatch') || (kind.includes('return') && t.key === 'open_returns') || (kind.includes('message') && t.key === 'unanswered_messages'));
        if (tile && n > 0 && !counts) tile.count += n;
      }
    } else if (!workqueues) unavailable.push('workqueues');

    /* payouts, performance and announcements */
    let payouts: unknown = null;
    const finance = this.core.api('finance');
    if (finance && opts.canViewFinance !== false) {
      const b = await this.core.soft('finance.getSellerBalances', () => finance.getSellerBalances(sellerId));
      if (b)
        payouts = {
          pending: b.pending,
          available: b.available,
          held: b.held,
          nextPayout: b.nextPayout ? { date: b.nextPayout.scheduledFor, amount: b.nextPayout.estimatedAmount, destinationLabel: b.nextPayout.destination.label } : null,
          isExampleSchedule: false,
        };
      else unavailable.push('payouts');
    } else unavailable.push('payouts');

    let performance: unknown = null;
    const sellers = this.core.api('sellers');
    const perf = sellers ? await this.core.soft('sellers.getPerformance', () => sellers.getPerformance(sellerId)) : undefined;
    if (perf) performance = { overall: perf.overall, period: perf.period, metrics: perf.metrics, warnings: perf.warnings, updatedAt: perf.updatedAt };
    else unavailable.push('performance');

    // content has no seller announcements function in its public API yet
    unavailable.push('announcements');

    return { sellerId, period, date: today, asOf: now.toISOString(), range, compare, currency: c, timeZone: tz, taxIncluded: cfg.taxIncluded, workToday, dispatchDeadlines, sales, payouts, performance, announcements: [], unavailable, definitions: await this.defs.inUse(shownMetrics) };
  }

  toSellerDashboard(d: SellerDashboardData): SellerDashboard {
    const { kpis: _kpis, ...sales } = d.sales;
    return { date: d.date, asOf: d.asOf, workToday: d.workToday, dispatchDeadlines: d.dispatchDeadlines, sales, payouts: d.payouts, performance: d.performance, announcements: d.announcements, unavailable: d.unavailable };
  }

  /** Rows of a report for an export file: its table, or its KPIs when it has none */
  exportRowsOf(result: ReportResult): { columns: { key: string; label: string }[]; rows: Record<string, unknown>[] } {
    const table = result.table as Table | null | undefined;
    if (table?.columns?.length) {
      const rows = [...table.rows];
      if (table.totals && Object.keys(table.totals).length) rows.push({ ...table.totals, [table.columns[0]!.key]: 'Total' });
      return { columns: table.columns.map((c) => ({ key: c.key, label: c.label })), rows };
    }
    return {
      columns: [
        { key: 'metric', label: 'Metric' },
        { key: 'value', label: 'Value' },
        { key: 'display', label: 'Shown as' },
      ],
      rows: result.kpis.map((k) => ({ metric: k.label, value: k.money ? k.money.amount / 100 : k.value, display: k.display })),
    };
  }
}

export interface AdminDashboardData {
  period: Period;
  range: DayRange;
  compare: DayRange;
  asOf: string;
  dateBasis: string;
  currency: string;
  timeZone: string;
  taxIncluded: boolean;
  kpis: (KpiValue & { unit: MetricDefinition['unit'] })[];
  series: Series[];
  split: { key: string; label: string; amount: Money; sharePct: number }[];
  definitions: MetricDefinition[];
  unavailable: string[];
}

export interface SellerDashboardData {
  sellerId: string;
  period: Period;
  date: string;
  asOf: string;
  range: DayRange;
  compare: DayRange;
  currency: string;
  timeZone: string;
  taxIncluded: boolean;
  workToday: SellerWorkTile[];
  dispatchDeadlines: unknown[];
  sales: { kpis: (KpiValue & { unit: MetricDefinition['unit'] })[]; series: Series[]; [k: string]: unknown };
  payouts: unknown;
  performance: unknown;
  announcements: unknown[];
  unavailable: string[];
  definitions: MetricDefinition[];
}

const emptyAgg = (): SalesAgg => ({ key: null, gross: 0, tax: 0, cancelled: 0, refunded: 0, orders: 0, units: 0, costedSales: 0, cost: 0, buyers: 0, platformDiscount: 0, sellerDiscount: 0 });
const zeros = (cols: string[]): Record<string, number> & { key: null } => ({ key: null, ...Object.fromEntries(cols.map((c) => [c, 0])) }) as never;
const humanize = (s: string) => (s.charAt(0).toUpperCase() + s.slice(1)).replace(/_/g, ' ');

function itemsLabel(items: { title?: string; quantity?: number }[]): string {
  const units = items.reduce((n, i) => n + (i.quantity ?? 1), 0);
  const first = items[0]?.title ?? '';
  return `${units} item${units === 1 ? '' : 's'}${first ? ` · ${first}` : ''}`;
}

const ACTIONS: Record<string, string> = { start_preparing: 'Start preparing', record_shipment: 'Add tracking', report_delay: 'Report a delay', respond_cancellation: 'Answer cancellation request', cancel_items: 'Cancel items', print_packing_slip: 'Print packing slip' };
const nextActionLabel = (actions: string[]) => ACTIONS[actions.find((a) => a === 'record_shipment' || a === 'start_preparing' || a === 'respond_cancellation') ?? actions[0] ?? ''] ?? 'Open order';

