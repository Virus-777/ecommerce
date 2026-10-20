import { useMutation, useQuery } from '@tanstack/react-query';
import { useMemo, type CSSProperties } from 'react';
import { Link } from 'react-router';
import { call, errorMessage, useApi } from '@marketly/web-shared/api';
import { SellerLayout } from '@marketly/web-shared/layouts';
import { formatMoney, money, num } from '@marketly/web-shared/lib/format';
import { href } from '@marketly/web-shared/routes';
import {
  Alert, announce, Badge, BarsChart, Button, Card, ChartFrame, fmtCount, Img, Meter, PageHeader, PeriodControl, rowsFrom, seriesFromReport, seriesTable, Stat, StatusBadge, TableWrap, TrendChart, usePeriod,
} from '@marketly/web-shared/ui';
import { useSellerSession } from '@/app/session';
import { amt, download, fmtPeriod, fmtTime, waitForExport } from './data/finance';
import { breakdownsOf, kpiOf, meterPct, metaOf, REPORT, SERVICE_KEYS, statDelta, tableOf, zoneLabel, type ProductSalesRow, type ReportQuery } from './data/reports';

// Design: pages/seller/seller-reports.html (no views). The period control (URL ?preset=&from=&to=&grain=&compare=)
// runs the seller reports for that period (POST reports/reports/{key}/query, with the chosen comparison): order trend
// (gross sales and orders KPIs, orders chart), product sales (units and return-rate KPIs, product table
// with SKUs, images, live discounts and returns per product) and returns by reason (reasons chart). Service performance is the account-health
// summary (GET sellers/performance, last 30 days). Export CSV runs an async report export
// (POST reports/exports → poll GET reports/exports/{id} → download link).

const pct = (n: number) => `${n.toFixed(1)}%`;

export default function Reports() {
  const { api } = useApi();
  const { sellerId, storeName, can } = useSellerSession();
  const canView = can('reports.seller.view');
  const canExport = can('reports.seller.export');
  const period = usePeriod();
  // the new presets and comparisons (docs/09 §3.3) are not in the generated types until the backend lands
  const query = period.query as ReportQuery;

  const run = (key: string) => call(api.POST('/api/seller/reports/reports/{key}/query', { params: { path: { key } }, body: query }));
  const trend = useQuery({ queryKey: ['reports', REPORT.trend, sellerId, query], queryFn: () => run(REPORT.trend), enabled: canView, placeholderData: (prev) => prev });
  const products = useQuery({ queryKey: ['reports', REPORT.products, sellerId, query], queryFn: () => run(REPORT.products), enabled: canView, placeholderData: (prev) => prev });
  const returns = useQuery({ queryKey: ['reports', REPORT.returns, sellerId, query], queryFn: () => run(REPORT.returns), enabled: canView, placeholderData: (prev) => prev });
  const performance = useQuery({ queryKey: ['sellers', 'performance', sellerId], queryFn: () => call(api.GET('/api/seller/sellers/performance')) });

  const exportCsv = useMutation({
    mutationFn: async () => {
      const job = await call(api.POST('/api/seller/reports/exports', { body: { reportKey: REPORT.products, query, format: 'csv' } }));
      announce(`Exporting the report for ${period.label} as CSV`);
      const ready = await waitForExport(() => call(api.GET('/api/seller/reports/exports/{id}', { params: { path: { id: job.id } } })), job);
      download(ready.downloadUrl!);
      return ready;
    },
    onSuccess: (j) => announce(`Report export ${j.ref} is ready`),
  });

  const view = useMemo(() => {
    const t = trend.data;
    const meta = metaOf(t);
    const ordersChart = seriesFromReport(t, [{ key: 'orders', label: `${storeName || 'Your'} orders` }]);
    const productRows = [...(tableOf<ProductSalesRow>(products.data)?.rows ?? [])].sort((a, b) => b.gross.amount - a.gross.amount);
    const reasons = breakdownsOf(returns.data).find((b) => b.key === 'reason')?.rows ?? [];
    const ordersKpi = kpiOf(t, 'commerce.orders');
    const unitsKpi = kpiOf(products.data, 'commerce.units_sold');
    return {
      meta,
      ordersChart,
      products: productRows,
      reasons,
      reasonRows: rowsFrom(
        reasons.map((r) => r.label),
        { requests: reasons.map((r) => r.requests) },
        reasons.map((r) => r.key ?? r.label),
      ),
      reasonTotal: reasons.reduce((a, r) => a + r.requests, 0),
      orders: ordersKpi?.value ?? 0,
      units: unitsKpi?.value ?? 0,
    };
  }, [trend.data, products.data, returns.data, storeName]);

  const gross = kpiOf(trend.data, 'commerce.gross_sales');
  const orders = kpiOf(trend.data, 'commerce.orders');
  const units = kpiOf(products.data, 'commerce.units_sold');
  const returnRate = kpiOf(products.data, 'service.return_rate');
  const compare = view.meta?.compareRange ? `vs ${fmtPeriod(view.meta.compareRange)}` : undefined;
  const meta = view.meta;
  const failed = [trend, products, returns].find((q) => q.isError);
  const service = SERVICE_KEYS.map((k) => performance.data?.metrics.find((m) => m.key === k)).filter((m) => !!m);
  const hasOrders = view.ordersChart.rows.some((r) => Number(r.orders) > 0);
  const hasReasons = view.reasons.some((r) => r.requests > 0);
  const reasonSeries = [{ key: 'requests', label: 'Return requests' }];

  const sk = (
    <div className="stack gap-2">
      <span className="sk sk-line short" />
      <span className="sk h-30" />
    </div>
  );

  if (!canView) {
    return (
      <SellerLayout active="reports">
        <PageHeader title="Seller reports" sub="Sales, returns and service figures for your store." />
        <Alert tone="info" title="Reports aren’t part of your access">
          Ask the store owner to give you the Seller reports permission.
        </Alert>
      </SellerLayout>
    );
  }

  return (
    <SellerLayout active="reports">
      <PageHeader
        title="Seller reports"
        sub={meta ? `Figures ${(meta.dateBasisLabel ?? 'by order date').replace(/^By/, 'by')}, ${zoneLabel(meta.timeZone)}.${meta.freshAsOf ? ` Refreshed ${fmtTime(meta.freshAsOf)}.` : ''}` : 'Figures by order date, Pacific Time.'}
        actions={
          <>
            <PeriodControl period={period} idPrefix="rp" />
            {canExport && (
              <Button variant="secondary" size="sm" icon="download" onClick={() => exportCsv.mutate()} disabled={exportCsv.isPending}>
                {exportCsv.isPending ? 'Preparing CSV…' : 'Export CSV'}
              </Button>
            )}
          </>
        }
      />
      {exportCsv.isError && (
        <Alert tone="danger" title="The export didn’t finish">
          {errorMessage(exportCsv.error)}
        </Alert>
      )}
      {failed && (
        <Alert tone="danger" title="We couldn’t load your reports">
          {errorMessage(failed.error)}{' '}
          <Button variant="ghost" size="sm" onClick={() => [trend, products, returns].forEach((q) => q.isError && void q.refetch())}>
            Try again
          </Button>
        </Alert>
      )}
      <div className="sb-kpis">
        <div className="card pad">{trend.data ? <Stat label="Gross sales" value={gross?.display ?? money(amt(gross?.money))} {...statDelta(gross)} note={statDelta(gross).delta ? compare : undefined} /> : sk}</div>
        <div className="card pad">{trend.data ? <Stat label="Orders" value={num(orders?.value ?? 0)} {...statDelta(orders)} /> : sk}</div>
        <div className="card pad">{products.data ? <Stat label="Units sold" value={num(units?.value ?? 0)} note={view.orders ? `${(view.units / view.orders).toFixed(1)} units per order` : undefined} {...statDelta(units)} /> : sk}</div>
        <div className="card pad">{products.data ? <Stat label="Return rate" value={returnRate?.display ?? pct(returnRate?.value ?? 0)} {...statDelta(returnRate)} note={returnRate?.note ?? undefined} /> : sk}</div>
      </div>
      <div className="grid lg2 gap-5">
        <ChartFrame
          titleAs="h2"
          title={`Orders per ${meta?.granularity ?? 'day'}`}
          sub={meta ? `${num(view.orders)} orders · ${fmtPeriod(meta.range)}` : undefined}
          loading={!trend.data}
          refreshing={trend.isPlaceholderData}
          empty={hasOrders ? false : 'No orders in this period.'}
          table={seriesTable(view.ordersChart.rows, view.ordersChart.series, fmtCount, { compareLabel: view.ordersChart.compareLabel })}
        >
          <TrendChart
            rows={view.ordersChart.rows}
            series={view.ordersChart.series}
            fmt={fmtCount}
            area
            compareLabel={view.ordersChart.compareLabel}
            label={`Orders per ${meta?.granularity ?? 'day'}, ${fmtPeriod(meta?.range).replace(' – ', ' to ')}`}
          />
        </ChartFrame>
        <ChartFrame
          title="Returns by reason"
          sub={returns.data ? `${view.reasonTotal} return${view.reasonTotal === 1 ? '' : 's'} in the period · by the reason customers gave` : undefined}
          loading={!returns.data}
          refreshing={returns.isPlaceholderData}
          empty={hasReasons ? false : 'No return requests in this period.'}
          table={seriesTable(view.reasonRows, reasonSeries, fmtCount, { xLabel: 'Reason' })}
        >
          <BarsChart rows={view.reasonRows} series={reasonSeries} fmt={fmtCount} horizontal label="Return requests by reason" />
        </ChartFrame>
      </div>
      <Card flush titleAs="h3" title="Product sales" sub="Sorted by gross sales">
        <TableWrap label="Product sales table">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Product</th>
                <th scope="col">SKU</th>
                <th className="r" scope="col">
                  Units
                </th>
                <th className="r" scope="col">
                  Gross sales
                </th>
                <th className="r" scope="col">
                  Avg price
                </th>
                <th className="r" scope="col">
                  Returns
                </th>
                <th className="r" scope="col">
                  Return rate
                </th>
              </tr>
            </thead>
            <tbody>
              {!products.data &&
                [0, 1, 2].map((i) => (
                  <tr key={i}>
                    <td colSpan={7}>
                      <span className="sk sk-line" />
                    </td>
                  </tr>
                ))}
              {products.data && view.products.length === 0 && (
                <tr>
                  <td colSpan={7}>
                    <span className="small muted">No sales in this period.</span>
                  </td>
                </tr>
              )}
              {view.products.map((r) => (
                <tr key={r.productId}>
                  <td>
                    <div className="cell-main minw-240">
                      <Img icon="package" tint="2" className="tiny" src={r.image?.thumbUrl ?? r.image?.url ?? undefined} alt="" />
                      <span className="stack gap-0">
                        <span className="small strong">{r.product}</span>
                        {r.liveDiscount && (
                          <span>
                            <Badge tone="deal-soft">Live discount</Badge>
                          </span>
                        )}
                      </span>
                    </div>
                  </td>
                  <td>
                    {r.sku && (
                      <span className="mono nowrap" title={r.skus?.join(', ') ?? r.sku}>
                        {r.sku}
                      </span>
                    )}
                  </td>
                  <td className="r">
                    <span className="num">{num(r.units)}</span>
                  </td>
                  <td className="r">
                    <span className="num strong">{formatMoney(r.gross)}</span>
                  </td>
                  <td className="r">
                    <span className="num">{r.averagePrice ? formatMoney(r.averagePrice) : money(r.units ? amt(r.gross) / r.units : 0)}</span>
                  </td>
                  <td className="r">
                    <span className="num">{num(r.returnedUnits)}</span>
                  </td>
                  <td className="r">
                    <span className="num">{pct(r.returnRate)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      </Card>
      <Card
        titleAs="h3"
        title="Service performance"
        sub={performance.data ? `Against Marketly service targets, ${fmtPeriod(performance.data.period)}` : 'Against Marketly service targets, last 30 days'}
        actions={
          <Link className="small strong" to={href('seller/performance')}>
            Account health
          </Link>
        }
      >
        {performance.isError ? (
          <Alert tone="danger" title="We couldn’t load your service figures">
            {errorMessage(performance.error)}{' '}
            <Button variant="ghost" size="sm" onClick={() => void performance.refetch()}>
              Try again
            </Button>
          </Alert>
        ) : !performance.data ? (
          sk
        ) : (
          <div className="grid md2" style={{ '--gap': '0 var(--sp-6)' } as CSSProperties}>
            {service.map((m) => {
              const meets = m.status === 'meets' || m.status === 'watch';
              const status = meets ? 'Meets target' : 'Below target';
              const tone = meets ? 'success' : 'warning';
              return (
                <div key={m.key} className="sb-metric">
                  <div className="stack gap-0">
                    <span className="small strong">{m.label}</span>
                    <span className="xs muted">Target: {m.target.display}</span>
                  </div>
                  <div className="row gap-2 nowrap">
                    <span className="h3 num">{m.display}</span>
                    <StatusBadge status={status} tone={tone} />
                  </div>
                  <div className="bar">
                    <Meter pct={meterPct(m)} tone={tone} label={`${m.display} ${status}`} />
                    {m.status === 'watch' && <span className="xs strong meter-note t-warning-text">Near target</span>}
                  </div>
                  <span className="xs muted span-all">
                    {[m.definition, m.detail].map((t) => t.replace(/\.$/, '')).join('. ')}.
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </SellerLayout>
  );
}
