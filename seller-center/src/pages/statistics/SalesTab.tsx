import { useMemo } from 'react';
import { errorMessage } from '@marketly/web-shared/api';
import { formatMoney, money, num } from '@marketly/web-shared/lib/format';
import { Alert, Badge, BarsChart, Button, Card, ChartFrame, fmtCount, Img, rowsFrom, seriesFromReport, seriesTable, TableWrap, TrendChart } from '@marketly/web-shared/ui';
import { useSellerSession } from '@/app/session';
import { amt, fmtPeriod } from '../data/finance';
import { breakdownsOf, kpiOf, metaOf, REPORT, tableOf, type ProductSalesRow, type ReportQuery } from '../data/reports';
import { compareNote, KpiTile, metaLine, useSellerReport } from '../data/statistics';

// Statistics → Sales (the former Reports page): order trend (gross sales and orders KPIs, orders chart), product
// sales (units and return-rate KPIs, the product table with SKUs, images, live discounts and returns) and returns
// by reason, for the page's period and comparison.

const pct = (n: number) => `${n.toFixed(1)}%`;
const REASON_SERIES = [{ key: 'requests', label: 'Return requests' }];

export function SalesTab({ query }: { query: ReportQuery }) {
  const { storeName } = useSellerSession();
  const trend = useSellerReport(REPORT.trend, query);
  const products = useSellerReport(REPORT.products, query);
  const returns = useSellerReport(REPORT.returns, query);

  const view = useMemo(() => {
    const t = trend.data;
    const ordersChart = seriesFromReport(t, [{ key: 'orders', label: `${storeName || 'Your'} orders` }]);
    const productRows = [...(tableOf<ProductSalesRow>(products.data)?.rows ?? [])].sort((a, b) => b.gross.amount - a.gross.amount);
    const reasons = breakdownsOf(returns.data).find((b) => b.key === 'reason')?.rows ?? [];
    return {
      ordersChart,
      products: productRows,
      reasons,
      reasonRows: rowsFrom(
        reasons.map((r) => r.label),
        { requests: reasons.map((r) => r.requests) },
        reasons.map((r) => r.key ?? r.label),
      ),
      reasonTotal: reasons.reduce((a, r) => a + r.requests, 0),
      orders: kpiOf(t, 'commerce.orders')?.value ?? 0,
      units: kpiOf(products.data, 'commerce.units_sold')?.value ?? 0,
    };
  }, [trend.data, products.data, returns.data, storeName]);

  const meta = metaOf(trend.data);
  const failed = [trend, products, returns].find((q) => q.isError);
  const hasOrders = view.ordersChart.rows.some((r) => Number(r.orders) > 0);
  const hasReasons = view.reasons.some((r) => r.requests > 0);

  return (
    <>
      {trend.data && <p className="small muted">{metaLine(trend.data)}</p>}
      {failed && (
        <Alert tone="danger" title="We couldn’t load your sales figures">
          {errorMessage(failed.error)}{' '}
          <Button variant="ghost" size="sm" onClick={() => [trend, products, returns].forEach((q) => q.isError && void q.refetch())}>
            Try again
          </Button>
        </Alert>
      )}
      <div className="sb-kpis">
        <KpiTile result={trend.data} metricKey="commerce.gross_sales" label="Gross sales" note={compareNote(trend.data)} />
        <KpiTile result={trend.data} metricKey="commerce.orders" label="Orders" value={(k) => num(k.value)} note={null} />
        <KpiTile result={products.data} metricKey="commerce.units_sold" label="Units sold" value={(k) => num(k.value)} note={view.orders ? `${(view.units / view.orders).toFixed(1)} units per order` : null} />
        <KpiTile result={products.data} metricKey="service.return_rate" label="Return rate" />
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
          table={seriesTable(view.reasonRows, REASON_SERIES, fmtCount, { xLabel: 'Reason' })}
        >
          <BarsChart rows={view.reasonRows} series={REASON_SERIES} fmt={fmtCount} horizontal label="Return requests by reason" />
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
    </>
  );
}
