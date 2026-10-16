import { useMutation, useQuery } from '@tanstack/react-query';
import { useMemo, useState, type CSSProperties } from 'react';
import { Link } from 'react-router';
import { call, errorMessage, useApi } from '@marketly/web-shared/api';
import { SellerLayout } from '@marketly/web-shared/layouts';
import { formatMoney, money, num } from '@marketly/web-shared/lib/format';
import { href } from '@marketly/web-shared/routes';
import { Alert, announce, Badge, BarChart, Button, Card, Img, Legend, LineChart, Meter, PageHeader, SegmentedControl, Stat, StatusBadge, TableWrap, TextInput } from '@marketly/web-shared/ui';
import { useSellerSession } from '@/app/session';
import { amt, download, fmtPeriod, fmtTime, waitForExport } from './data/finance';
import { breakdownsOf, kpiOf, meterPct, metaOf, PERIODS, REPORT, SERVICE_KEYS, statDelta, tableOf, zoneLabel, type Period, type ProductSalesRow } from './data/reports';

// Design: pages/seller/seller-reports.html (no views). The 7/30/90-day segment runs the seller reports
// for that preset (POST reports/reports/{key}/query, compared with the previous period): order trend
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
  const [period, setPeriod] = useState<Period>('30d');
  const p = PERIODS.find((x) => x.value === period)!;

  const run = (key: string) =>
    call(api.POST('/api/seller/reports/reports/{key}/query', { params: { path: { key } }, body: { preset: p.preset, compare: 'previous_period' } }));
  const trend = useQuery({ queryKey: ['reports', REPORT.trend, sellerId, period], queryFn: () => run(REPORT.trend), enabled: canView });
  const products = useQuery({ queryKey: ['reports', REPORT.products, sellerId, period], queryFn: () => run(REPORT.products), enabled: canView });
  const returns = useQuery({ queryKey: ['reports', REPORT.returns, sellerId, period], queryFn: () => run(REPORT.returns), enabled: canView });
  const performance = useQuery({ queryKey: ['sellers', 'performance', sellerId], queryFn: () => call(api.GET('/api/seller/sellers/performance')) });

  const exportCsv = useMutation({
    mutationFn: async () => {
      const job = await call(api.POST('/api/seller/reports/exports', { body: { reportKey: REPORT.products, query: { preset: p.preset }, format: 'csv' } }));
      announce(`Exporting ${p.label} report as CSV`);
      const ready = await waitForExport(() => call(api.GET('/api/seller/reports/exports/{id}', { params: { path: { id: job.id } } })), job);
      download(ready.downloadUrl!);
      return ready;
    },
    onSuccess: (j) => announce(`Report export ${j.ref} is ready`),
  });

  const view = useMemo(() => {
    const t = trend.data;
    const meta = metaOf(t);
    const ordersSeries = t?.series.find((s) => s.key === 'orders');
    const points = (ordersSeries?.points ?? []) as Array<{ x: string; y: number; label?: string }>;
    const productRows = [...(tableOf<ProductSalesRow>(products.data)?.rows ?? [])].sort((a, b) => b.gross.amount - a.gross.amount);
    const reasons = breakdownsOf(returns.data).find((b) => b.key === 'reason')?.rows ?? [];
    const ordersKpi = kpiOf(t, 'commerce.orders');
    const unitsKpi = kpiOf(products.data, 'commerce.units_sold');
    return {
      meta,
      labels: points.map((pt) => pt.label ?? pt.x),
      orderPoints: points.map((pt) => pt.y),
      products: productRows,
      reasons,
      reasonTotal: reasons.reduce((a, r) => a + r.requests, 0),
      orders: ordersKpi?.value ?? 0,
      units: unitsKpi?.value ?? 0,
    };
  }, [trend.data, products.data, returns.data]);

  const gross = kpiOf(trend.data, 'commerce.gross_sales');
  const orders = kpiOf(trend.data, 'commerce.orders');
  const units = kpiOf(products.data, 'commerce.units_sold');
  const returnRate = kpiOf(products.data, 'service.return_rate');
  const compare = view.meta?.compareRange ? `vs prior ${p.label}` : undefined;
  const meta = view.meta;
  const failed = [trend, products, returns].find((q) => q.isError);
  const service = SERVICE_KEYS.map((k) => performance.data?.metrics.find((m) => m.key === k)).filter((m) => !!m);
  const hasOrders = view.orderPoints.some((v) => v > 0);
  const hasReasons = view.reasons.some((r) => r.requests > 0);

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
            <SegmentedControl items={PERIODS.map(({ label, value }) => ({ label, value }))} active={period} onChange={setPeriod} label="Report period" />
            <label className="sr-only" htmlFor="rp-range">
              Date range
            </label>
            <TextInput id="rp-range" icon="calendar" value={meta ? fmtPeriod(meta.range, true) : ''} placeholder="" readOnly />
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
        <Card title={`Orders per ${meta?.granularity ?? 'day'}`} sub={meta ? `${num(view.orders)} orders · ${fmtPeriod(meta.range)}` : undefined}>
          <Legend items={[`${storeName || 'Your'} orders`]} />
          {!trend.data ? (
            <span className="sk h-46" />
          ) : hasOrders && view.orderPoints.length > 1 ? (
            <LineChart labels={view.labels} series={[{ name: 'Orders', data: view.orderPoints }]} area label={`Orders per ${meta?.granularity ?? 'day'}, ${fmtPeriod(meta?.range).replace(' – ', ' to ')}`} />
          ) : (
            <p className="small muted">No orders in this period.</p>
          )}
        </Card>
        <Card titleAs="h3" title="Returns by reason" sub={returns.data ? `${view.reasonTotal} return${view.reasonTotal === 1 ? '' : 's'} in the period` : undefined}>
          {!returns.data ? (
            <span className="sk h-46" />
          ) : hasReasons ? (
            <BarChart labels={view.reasons.map((r) => r.label)} data={view.reasons.map((r) => r.requests)} height={220} label="Returns by reason" />
          ) : (
            <p className="small muted">No return requests in this period.</p>
          )}
          {hasReasons && <span className="xs muted">Return requests on your items by the reason customers gave.</span>}
        </Card>
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
