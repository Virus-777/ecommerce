/**
 * Report queries and dashboards from the read models. Every result states its range, date basis,
 * currency, time zone, tax treatment, freshness and the definition versions it used (plan ch. 19).
 */
import type { Money } from '../../../spec/common.js';
import type { AdminDashboard, KpiValue, MetricDefinition, ReportQuery, ReportResult, Series, SellerDashboard, SellerWorkTile } from '../../../spec/reports.js';
import { OFFICIAL_KEY, metricSeed } from '../domain/catalogue.js';
import {
  addDays,
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
        return this.salesReport(rq, scope, cfg, false);
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

  private async productSalesReport(rq: ResolvedQuery, scope: ReportScope, cfg: Settings): Promise<Part> {
    const c = rq.currency;
    const total = await this.salesTotals(rq, scope, rq.range);
    const prev = rq.compare ? await this.salesTotals(rq, scope, rq.compare) : null;
    const rows = (await this.core.repo.salesAgg(this.salesFilter(rq, scope, rq.range), 'product_id')).sort((a, b) => b.gross - a.gross);
    const names = await this.productNames(rows.map((r) => r.key!).slice(0, 100));
    return {
      kpis: [this.kpi('commerce.gross_sales', this.gross(total, cfg), c, prev ? this.gross(prev, cfg) : null), this.kpi('commerce.units_sold', total.units, c, prev?.units ?? null), this.kpi('commerce.orders', total.orders, c, prev?.orders ?? null)],
      series: [],
      table: {
        columns: [col('product', 'Product'), col('units', 'Units', 'count'), col('orders', 'Orders', 'count'), col('gross', 'Item sales', 'money'), col('cancelled', 'Cancelled', 'money'), col('refunded', 'Refunded', 'money')],
        rows: rows.map((r) => ({ productId: r.key, product: names.get(r.key!) ?? r.key, units: r.units, orders: r.orders, gross: this.money(this.gross(r, cfg), c), cancelled: this.money(r.cancelled, c), refunded: this.money(r.refunded, c) })),
        totals: { units: total.units, orders: total.orders, gross: this.money(this.gross(total, cfg), c), cancelled: this.money(total.cancelled, c), refunded: this.money(total.refunded, c) },
      },
      callouts: [{ kind: 'info', title: 'Item sales before fees, by order date', body: 'Your item sales after customer discounts, before marketplace fees, cancellations and refunds. Shipping and tax are not included.' }],
      unavailable: [],
      models: ['order_items'],
    };
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
    const COLS = ['fee_income_minor', 'held_minor', 'payouts_paid_minor', 'payouts_failed', 'owed_minor', 'ad_charges_minor'];
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
    const unavailable = [...(this.core.running('finance') ? [] : ['marketplace.fee_income', 'marketplace.held', 'marketplace.payouts_paid', 'marketplace.amounts_owed']), ...(this.core.running('advertising') ? [] : ['marketplace.ad_income'])];
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
      ],
      series: [
        this.series('seller_sales', 'Marketplace sales', buckets, rq.granularity, new Map(salesBuckets.map((b) => [b.key!, this.gross(b, cfg)]))),
        this.series('fee_income', 'Marketplace fee income', buckets, rq.granularity, new Map(finBuckets.map((b) => [b.key!, b.fee_income_minor!]))),
      ],
      table: {
        columns: [col('seller', 'Seller'), col('sales', 'Marketplace sales', 'money'), col('feeIncome', 'Fee income', 'money'), col('platformDiscount', 'Platform-funded discounts', 'money'), col('held', 'Holds (net)', 'money'), col('payoutsPaid', 'Payouts paid', 'money'), col('owed', 'Amounts owed', 'money'), col('adCharges', 'Ad charges', 'money')],
        rows: ids
          .map((id) => {
            const s = salesBySeller.find((x) => x.key === id) ?? emptyAgg();
            const fr = finBySeller.find((x) => x.key === id) ?? zeros(COLS);
            return { sellerId: id, seller: names.get(id) ?? id, sales: this.money(this.gross(s, cfg), c), feeIncome: this.money(fr.fee_income_minor!, c), platformDiscount: this.money(s.platformDiscount, c), held: this.money(fr.held_minor!, c), payoutsPaid: this.money(fr.payouts_paid_minor!, c), owed: this.money(fr.owed_minor!, c), adCharges: this.money(fr.ad_charges_minor!, c) };
          })
          .sort((a, b) => b.sales.amount - a.sales.amount),
        totals: { sales: this.money(this.gross(sales, cfg), c), feeIncome: this.money(fin.fee_income_minor!, c), platformDiscount: this.money(sales.platformDiscount, c), held: this.money(fin.held_minor!, c), payoutsPaid: this.money(fin.payouts_paid_minor!, c), owed: this.money(fin.owed_minor!, c), adCharges: this.money(fin.ad_charges_minor!, c) },
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
    const sellerId = this.sellerOf(rq, scope);
    const f = (r: DayRange) => ({ ...instantsOf(r, rq.timeZone), timeZone: rq.timeZone, ...(sellerId ? { sellerId } : {}), ...(rq.productId ? { productId: rq.productId } : {}) });
    const [total] = await this.core.repo.returnsAgg(f(rq.range), 'none');
    const prev = rq.compare ? (await this.core.repo.returnsAgg(f(rq.compare), 'none'))[0] : undefined;
    const reasons = await this.core.repo.returnsAgg(f(rq.range), 'reason');
    const outcomes = await this.core.repo.returnsAgg(f(rq.range), 'outcome');
    const products = (await this.core.repo.returnsAgg(f(rq.range), 'product_id')).slice(0, 100);
    const names = await this.productNames(products.map((p) => p.key!));
    const requests = total?.requests ?? 0;
    return {
      kpis: [this.kpi('service.return_requests', requests, c, rq.compare ? (prev?.requests ?? 0) : null, `${total?.units ?? 0} units`)],
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

  async sellerDashboard(sellerId: string, period: Period, opts: { canViewFinance?: boolean } = {}): Promise<SellerDashboardData> {
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
      ],
    };

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

    return { sellerId, period, date: today, asOf: now.toISOString(), range, compare, currency: c, timeZone: tz, taxIncluded: cfg.taxIncluded, workToday, dispatchDeadlines, sales, payouts, performance, announcements: [], unavailable, definitions: await this.defs.inUse(['commerce.gross_sales', 'commerce.orders', 'commerce.average_order_value']) };
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

