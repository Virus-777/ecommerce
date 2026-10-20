import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { call, useApi } from '@marketly/web-shared/api';
import { formatMoney, type MoneyValue } from '@marketly/web-shared/lib/format';
import { href } from '@marketly/web-shared/routes';
import {
  BarsChart, Button, Card, ChartFrame, chartColor, fmtCount, fmtMoney, fmtMoneyCompact, fmtPercent, fmtPercentCompact, rowsFrom, SegmentedControl, seriesTable, Stat, TableWrap, TrendChart, type ChartRow,
} from '@marketly/web-shared/ui';
import { useSellerSession } from '@/app/session';
import { dayKey, LoadError, SkeletonLines } from './home';
import { breakdownsOf, kpiOf, REPORT, statDelta, tableOf, type Kpi, type ProductSalesRow, type ReportQuery, type ReportResult } from './reports';

// Dashboard "Sales by period" (designed in React; no design file): the seller's sales, orders, units, average
// order, returns and dispatch for the last 30 days, 12 weeks, 12 months or 4 quarters, each compared with the
// period before, with charts and a table per day / week / month / quarter, top products and returns by reason.
// Data: seller reports (POST /api/seller/reports/reports/{key}/query) — order trend, product sales, returns by
// reason, service performance; with finance.balances.view also seller.earnings (net earnings and profit tiles,
// docs/09 §4.2). The API buckets by day, week or month; quarters are summed from months here.

export type Grain = 'day' | 'week' | 'month' | 'quarter';

const GRAINS: Array<{ label: string; value: Grain }> = [
  { label: 'Day', value: 'day' },
  { label: 'Week', value: 'week' },
  { label: 'Month', value: 'month' },
  { label: 'Quarter', value: 'quarter' },
];

interface TrendRow {
  period: string;
  label: string;
  orders: number;
  units: number;
  gross: MoneyValue;
  averageOrder: MoneyValue;
}

interface Point {
  x: string;
  y: number;
  label: string;
}

interface Series {
  key: string;
  label: string;
  points: Point[];
}

/* ----- date ranges (Pacific calendar days as YYYY-MM-DD) ----- */

const parse = (d: string) => new Date(`${d}T12:00:00Z`);
const fmt = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: string, n: number) => {
  const x = parse(d);
  x.setUTCDate(x.getUTCDate() + n);
  return fmt(x);
};
const addMonths = (d: string, n: number) => {
  const x = parse(d);
  x.setUTCDate(1);
  x.setUTCMonth(x.getUTCMonth() + n);
  return fmt(x);
};
const monday = (d: string) => addDays(d, -((parse(d).getUTCDay() + 6) % 7));
const quarterStart = (d: string) => {
  const x = parse(d);
  return `${x.getUTCFullYear()}-${String(Math.floor(x.getUTCMonth() / 3) * 3 + 1).padStart(2, '0')}-01`;
};
const quarterKey = (d: string) => {
  const x = parse(d);
  return { key: `${x.getUTCFullYear()}-Q${Math.floor(x.getUTCMonth() / 3) + 1}`, label: `Q${Math.floor(x.getUTCMonth() / 3) + 1} ${x.getUTCFullYear()}` };
};

/** The query for a grain: the range, the API bucket (quarters use months) and how the page names it. */
function rangeFor(grain: Grain, today: string): { query: ReportQuery; bucket: 'day' | 'week' | 'month'; title: string; unit: string } {
  switch (grain) {
    case 'day':
      return { query: { preset: 'last_30_days', granularity: 'day' }, bucket: 'day', title: 'Last 30 days', unit: 'Day' };
    case 'week':
      return { query: { preset: 'custom', range: { from: addDays(monday(today), -7 * 11), to: today }, granularity: 'week' }, bucket: 'week', title: 'Last 12 weeks', unit: 'Week' };
    case 'month':
      return { query: { preset: 'custom', range: { from: addMonths(today, -11), to: today }, granularity: 'month' }, bucket: 'month', title: 'Last 12 months', unit: 'Month' };
    case 'quarter':
      return { query: { preset: 'custom', range: { from: addMonths(quarterStart(today), -9), to: today }, granularity: 'month' }, bucket: 'month', title: 'Last 4 quarters', unit: 'Quarter' };
  }
}

/** Month rows summed into quarter rows (the API has no quarter bucket). */
function toQuarters(rows: TrendRow[]): TrendRow[] {
  const out = new Map<string, TrendRow>();
  for (const r of rows) {
    const q = quarterKey(r.period);
    const cur = out.get(q.key) ?? { period: q.key, label: q.label, orders: 0, units: 0, gross: { amount: 0, currency: r.gross.currency }, averageOrder: { amount: 0, currency: r.gross.currency } };
    cur.orders += r.orders;
    cur.units += r.units;
    cur.gross = { amount: cur.gross.amount + r.gross.amount, currency: cur.gross.currency };
    cur.averageOrder = { amount: cur.orders ? Math.round(cur.gross.amount / cur.orders) : 0, currency: cur.gross.currency };
    out.set(q.key, cur);
  }
  return [...out.values()];
}

/** On-time dispatch per quarter: monthly rates weighted by packages dispatched. */
function quarterRates(rate: Point[], volume: Point[]): Point[] {
  const out = new Map<string, { label: string; w: number; n: number }>();
  rate.forEach((p, i) => {
    const q = quarterKey(p.x);
    const n = volume[i]?.y ?? 0;
    const cur = out.get(q.key) ?? { label: q.label, w: 0, n: 0 };
    cur.w += p.y * n;
    cur.n += n;
    out.set(q.key, cur);
  });
  return [...out.entries()].map(([x, v]) => ({ x, y: v.n ? v.w / v.n : 0, label: v.label }));
}

const money = (cents: number) => formatMoney({ amount: cents, currency: 'USD' });
const num = (n: number) => n.toLocaleString('en-US');

function KpiCard({ k, label, value, note, loading }: { k?: Kpi; label: string; value?: string; note?: string; loading: boolean }) {
  return <div className="card pad">{loading ? <span className="sk sk-line" aria-hidden="true" /> : <Stat label={label} value={value ?? k?.display ?? '—'} {...statDelta(k)} note={note} />}</div>;
}

/**
 * Two parts sharing the period switch (URL ?period=) and the report queries: 'summary' (heading, switch, key
 * figures, charts) sits in the dashboard's main column; 'details' (table by period, top products, returns,
 * dispatch) runs full width below it. `today`: today's sales so far, shown under the heading.
 */
export function PeriodPerformance({ part = 'summary', today: todaySales }: { part?: 'summary' | 'details'; today?: { gross: MoneyValue; orders: number } }) {
  const { api } = useApi();
  const { sellerId, can } = useSellerSession();
  const [params, setParams] = useSearchParams();
  const grain = (GRAINS.find((g) => g.value === params.get('period'))?.value ?? 'day') as Grain;
  const setGrain = (g: Grain) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        if (g === 'day') n.delete('period');
        else n.set('period', g);
        return n;
      },
      { replace: true, preventScrollReset: true },
    );

  const [allRows, setAllRows] = useState(false);
  const today = dayKey(new Date());
  const r = rangeFor(grain, today);
  const canView = can('reports.seller.view');
  // earnings and profit are money figures: only for members who may see balances
  const canMoney = canView && can('finance.balances.view');
  const useReport = (key: string, extra: Partial<ReportQuery> = {}, enabled = canView) =>
    useQuery({
      queryKey: ['reports', 'seller', sellerId, key, grain, today],
      queryFn: () => call(api.POST('/api/seller/reports/reports/{key}/query', { params: { path: { key } }, body: { ...r.query, compare: 'previous_period', ...extra } })) as Promise<ReportResult>,
      enabled,
      staleTime: 5 * 60_000,
    });
  const trend = useReport(REPORT.trend);
  const products = useReport(REPORT.products, { granularity: undefined });
  const returns = useReport(REPORT.returns, { granularity: undefined });
  const service = useReport('seller.service_performance', { granularity: r.bucket === 'day' ? 'week' : r.bucket });
  const earnings = useReport('seller.earnings', { granularity: undefined }, canMoney);

  if (!canView) {
    if (part === 'details') return null;
    return (
      <section className="stack gap-3" aria-labelledby="sa-period">
        <h2 className="h3" id="sa-period">
          Sales
        </h2>
        <p className="small sub">Your role doesn’t include store reports. The store owner can give you the reports permission in Staff and permissions.</p>
      </section>
    );
  }

  const monthRows = tableOf<TrendRow>(trend.data)?.rows ?? [];
  const rows = grain === 'quarter' ? toQuarters(monthRows) : monthRows;
  const totals = rows.reduce((t, x) => ({ orders: t.orders + x.orders, units: t.units + x.units, gross: t.gross + x.gross.amount }), { orders: 0, units: 0, gross: 0 });
  const hasSales = totals.orders > 0;

  const gross = kpiOf(trend.data, 'commerce.gross_sales');
  const orders = kpiOf(trend.data, 'commerce.orders');
  const aov = kpiOf(trend.data, 'commerce.average_order_value');
  const units = kpiOf(products.data, 'commerce.units_sold');
  const returnReqs = kpiOf(returns.data, 'service.return_requests');
  const returnRate = kpiOf(products.data, 'service.return_rate');
  const onTime = kpiOf(service.data, 'service.on_time_dispatch');
  const net = kpiOf(earnings.data, 'seller.net_earnings');
  const profit = kpiOf(earnings.data, 'seller.profit');
  const coverage = kpiOf(earnings.data, 'seller.cost_coverage_pct');
  // the figures exist only once the backend has the report; a failed earnings query leaves the sales tiles alone
  const earningsLoading = earnings.isPending && !earnings.isError;

  const serviceSeries = (service.data?.series ?? []) as Series[];
  const ratePts = serviceSeries.find((s) => s.key === 'on_time_dispatch')?.points ?? [];
  const volPts = serviceSeries.find((s) => s.key === 'dispatched')?.points ?? [];
  const dispatch = grain === 'quarter' ? quarterRates(ratePts, volPts) : ratePts.map((p, i) => ({ ...p, y: volPts[i]?.y ? p.y : 0 }));
  const shipped = grain === 'quarter' ? toQuartersVolume(volPts) : volPts.map((p) => p.y);

  const productRows = (tableOf<ProductSalesRow>(products.data)?.rows ?? []).slice().sort((a, b) => b.gross.amount - a.gross.amount).slice(0, 5);
  const reasons = breakdownsOf(returns.data).find((b) => b.key === 'reason')?.rows ?? [];
  const failed = [trend, products, returns, service].find((q) => q.isError);
  // chart rows: gross (cents) and orders per period, reasons as a ranking, the dispatch rate per period
  const salesRows: ChartRow[] = rows.map((x) => ({ x: x.period, label: x.label, gross: x.gross.amount, orders: x.orders }));
  const reasonRows = rowsFrom(reasons.map((x) => x.label), { requests: reasons.map((x) => x.requests) });
  const dispatchRows = rowsFrom(dispatch.map((p) => p.label), { onTime: dispatch.map((p) => Math.round(p.y * 10) / 10) }, dispatch.map((p) => p.x));
  const SALES = [{ key: 'gross', label: 'Gross sales' }];
  const ORDERS = [{ key: 'orders', label: 'Orders' }];
  const REASONS = [{ key: 'requests', label: 'Return requests', color: chartColor(1) }];
  const ON_TIME = [{ key: 'onTime', label: 'Dispatched on time' }];
  const compareNote = 'vs the period before';

  if (part === 'details') {
    return (
      <div className="grid lg2 gap-5" aria-label="Sales details">
        <div className="stack gap-5">
          <Card flush title={`By ${r.unit.toLowerCase()}`} titleAs="h3" sub="Newest first">
            {trend.isPending ? (
              <div className="pad">
                <SkeletonLines rows={4} />
              </div>
            ) : rows.length === 0 ? (
              <div className="card-body">
                <p className="small sub">No figures for this period yet.</p>
              </div>
            ) : (
              <TableWrap label={`Sales by ${r.unit.toLowerCase()}`}>
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">{r.unit}</th>
                      <th scope="col" className="r">
                        Orders
                      </th>
                      <th scope="col" className="r">
                        Units
                      </th>
                      <th scope="col" className="r">
                        Gross sales
                      </th>
                      <th scope="col" className="r">
                        Average order
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows
                      .slice()
                      .reverse()
                      .slice(0, allRows ? undefined : 10)
                      .map((x) => (
                        <tr key={x.period} className={x.orders ? undefined : 'muted'}>
                          <td className="nowrap">{grain === 'week' ? `Week of ${x.label}` : x.label}</td>
                          <td className="r num">{num(x.orders)}</td>
                          <td className="r num">{num(x.units)}</td>
                          <td className="r num">{formatMoney(x.gross)}</td>
                          <td className="r num">{x.orders ? formatMoney(x.averageOrder) : '—'}</td>
                        </tr>
                      ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <th scope="row">Total</th>
                      <td className="r num strong">{num(totals.orders)}</td>
                      <td className="r num strong">{num(totals.units)}</td>
                      <td className="r num strong">{money(totals.gross)}</td>
                      <td className="r num strong">{totals.orders ? money(Math.round(totals.gross / totals.orders)) : '—'}</td>
                    </tr>
                  </tfoot>
                </table>
              </TableWrap>
            )}
            {rows.length > 10 && (
              <div className="card-foot">
                <Button variant="ghost" size="sm" onClick={() => setAllRows(!allRows)}>
                  {allRows ? 'Show the newest 10' : `Show all ${rows.length}`}
                </Button>
              </div>
            )}
          </Card>
          <ChartFrame
            title="Returns by reason"
            sub={returns.data ? `${num(returnReqs?.value ?? 0)} return request${returnReqs?.value === 1 ? '' : 's'} · ${r.title.toLowerCase()}` : undefined}
            loading={returns.isPending}
            height={180}
            empty={reasons.length === 0 ? 'No returns in this period.' : false}
            table={seriesTable(reasonRows, REASONS, fmtCount, { xLabel: 'Reason' })}
          >
            <BarsChart rows={reasonRows} series={REASONS} fmt={fmtCount} horizontal label="Return requests by reason" />
          </ChartFrame>
        </div>
        <div className="stack gap-5">
          <Card
            flush
            title="Top products"
            titleAs="h3"
            sub={`${r.title} · by gross sales`}
            actions={
              <Link className="small strong" to={href('seller/products')}>
                Products
              </Link>
            }
          >
            {products.isPending ? (
              <div className="pad">
                <SkeletonLines rows={4} />
              </div>
            ) : productRows.length === 0 ? (
              <div className="card-body">
                <p className="small sub">No product sales in this period yet.</p>
              </div>
            ) : (
              <TableWrap label="Top products">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Product</th>
                      <th scope="col" className="r">
                        Units
                      </th>
                      <th scope="col" className="r">
                        Orders
                      </th>
                      <th scope="col" className="r">
                        Item sales
                      </th>
                      <th scope="col" className="r">
                        Refunded
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {productRows.map((p) => (
                      <tr key={p.productId}>
                        <td>
                          <span className="small strong">{p.product}</span>
                        </td>
                        <td className="r num">{num(p.units)}</td>
                        <td className="r num">{num(p.orders)}</td>
                        <td className="r num">{formatMoney(p.gross)}</td>
                        <td className="r num">{p.refunded.amount ? formatMoney(p.refunded) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            )}
          </Card>
          <ChartFrame
            title="Dispatch on time"
            sub={`Packages dispatched by the deadline, per ${grain === 'day' ? 'week' : r.unit.toLowerCase()}`}
            actions={
              <Link className="small strong" to={href('seller/performance')}>
                Account health
              </Link>
            }
            loading={service.isPending}
            height={180}
            empty={!shipped.some((n) => n > 0) ? 'No packages dispatched in this period yet.' : false}
            table={seriesTable(dispatchRows, ON_TIME, fmtPercent, { xLabel: grain === 'day' ? 'Week' : r.unit })}
          >
            <TrendChart rows={dispatchRows} series={ON_TIME} fmt={fmtPercent} axisFmt={fmtPercentCompact} height={180} label="On-time dispatch rate" />
          </ChartFrame>
        </div>
      </div>
    );
  }

  return (
    <section className="stack gap-4 u-mt-sp-4" aria-labelledby="sa-period">
      <div className="row between wrap gap-3">
        <div className="stack gap-0">
          <h2 className="h3" id="sa-period">
            Sales
          </h2>
          <p className="xs muted">
            {todaySales && `Today so far ${formatMoney(todaySales.gross)} · ${todaySales.orders} order${todaySales.orders === 1 ? '' : 's'} · `}
            {r.title} · by {r.unit.toLowerCase()} · item sales before fees, Pacific Time
          </p>
        </div>
        <div className="row gap-3">
          <SegmentedControl items={GRAINS} active={grain} onChange={setGrain} label="Group sales by" />
          <Link className="small strong" to={href('seller/reports')}>
            Statistics
          </Link>
        </div>
      </div>
      {failed && <LoadError error={failed.error} onRetry={() => [trend, products, returns, service].forEach((q) => q.isError && void q.refetch())} title="We couldn’t load your sales figures" />}
      <div className={`grid m2 ${canMoney ? 'md4' : 'md3'} gap-3`}>
        <KpiCard k={gross} label="Gross sales" loading={trend.isPending} note={statDelta(gross).delta ? compareNote : undefined} />
        <KpiCard k={orders} label="Orders" loading={trend.isPending} />
        <KpiCard k={aov} label="Average order" loading={trend.isPending} />
        <KpiCard k={units} label="Units sold" loading={products.isPending} note={totals.orders ? `${(totals.units / totals.orders).toFixed(1)} per order` : undefined} />
        <KpiCard k={returnRate} label="Return rate" loading={products.isPending} note={returnRate?.note ?? undefined} />
        <KpiCard k={onTime} label="On-time dispatch" loading={service.isPending} />
        {canMoney && (
          <>
            <KpiCard k={net} label="Net earnings" loading={earningsLoading} note={earnings.isError ? 'Not available yet' : 'after fees, refunds and charges'} />
            <KpiCard k={profit} label="Profit" loading={earningsLoading} note={earnings.isError ? 'Not available yet' : coverage ? `costs set for ${coverage.display} of sales` : undefined} />
          </>
        )}
      </div>
      <div className="grid lg2 gap-5">
        <ChartFrame
          title={`Gross sales per ${r.unit.toLowerCase()}`}
          sub={trend.data ? `${money(totals.gross)} · ${r.title.toLowerCase()}` : undefined}
          loading={trend.isPending}
          height={220}
          empty={hasSales ? false : 'No sales in this period yet.'}
          table={seriesTable(salesRows, SALES, fmtMoney, { xLabel: r.unit })}
        >
          <TrendChart rows={salesRows} series={SALES} fmt={fmtMoney} axisFmt={fmtMoneyCompact} area height={220} label={`Gross sales per ${r.unit.toLowerCase()}, ${r.title.toLowerCase()}`} />
        </ChartFrame>
        <ChartFrame
          title={`Orders per ${r.unit.toLowerCase()}`}
          sub={trend.data ? `${num(totals.orders)} order${totals.orders === 1 ? '' : 's'} · ${num(totals.units)} unit${totals.units === 1 ? '' : 's'}` : undefined}
          loading={trend.isPending}
          height={220}
          empty={hasSales ? false : 'No orders in this period yet.'}
          table={seriesTable(salesRows, ORDERS, fmtCount, { xLabel: r.unit })}
        >
          <BarsChart rows={salesRows} series={ORDERS} fmt={fmtCount} height={220} label={`Orders per ${r.unit.toLowerCase()}, ${r.title.toLowerCase()}`} />
        </ChartFrame>
      </div>
    </section>
  );
}

/** Packages dispatched summed per quarter (same order as quarterRates). */
function toQuartersVolume(volume: Point[]): number[] {
  const out = new Map<string, number>();
  for (const p of volume) {
    const q = quarterKey(p.x).key;
    out.set(q, (out.get(q) ?? 0) + p.y);
  }
  return [...out.values()];
}
