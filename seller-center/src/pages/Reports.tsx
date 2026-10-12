import { useMemo, useState, type CSSProperties } from 'react';
import { Link } from 'react-router';
import { SellerLayout } from '@marketly/web-shared/layouts';
import { money, num } from '@marketly/web-shared/lib/format';
import { href } from '@marketly/web-shared/routes';
import { announce, BarChart, Button, Card, Img, Legend, LineChart, Meter, PageHeader, SegmentedControl, Stat, StatusBadge, TableWrap, TextInput } from '@marketly/web-shared/ui';
import { REPORTS, RETURN_REASONS, SERVICE, type Period } from './data/reports';

// Design: pages/seller/seller-reports.html (no views). The 7/30/90-day segment switches every
// figure, both charts and the product table; the 30-day period is the design's sample.

const PERIODS: Array<{ label: string; value: Period }> = [
  { label: '7 days', value: '7d' },
  { label: '30 days', value: '30d' },
  { label: '90 days', value: '90d' },
];

const dayLabel = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const pct = (n: number) => `${n.toFixed(1)}%`;

export default function Reports() {
  const [period, setPeriod] = useState<Period>('30d');
  const [range, setRange] = useState(REPORTS['30d'].range);
  const r = REPORTS[period];

  const choose = (p: Period) => {
    setPeriod(p);
    setRange(REPORTS[p].range);
  };

  const view = useMemo(() => {
    const labels = r.orders.map((_, i) => {
      const d = new Date(r.start);
      d.setDate(d.getDate() + i);
      return dayLabel(d);
    });
    const products = [...r.products].sort((a, b) => b.gross - a.gross);
    const orders = r.orders.reduce((a, b) => a + b, 0);
    const units = products.reduce((a, p) => a + p.units, 0);
    const gross = products.reduce((a, p) => a + p.gross, 0);
    const returns = products.reduce((a, p) => a + p.returns, 0);
    const reasons = r.returnsByReason.reduce((a, b) => a + b, 0);
    return { labels, products, orders, units, gross, returns, reasons };
  }, [r]);

  const d = r.deltas;

  return (
    <SellerLayout active="reports">
      <PageHeader
        title="Seller reports"
        sub="Figures by order date, Pacific Time. Refreshed Oct 8, 9:40 AM."
        actions={
          <>
            <SegmentedControl items={PERIODS} active={period} onChange={choose} label="Report period" />
            <label className="sr-only" htmlFor="rp-range">
              Date range
            </label>
            <TextInput id="rp-range" icon="calendar" value={range} placeholder="" onChange={(e) => setRange(e.target.value)} />
            <Button variant="secondary" size="sm" icon="download" onClick={() => announce(`Exporting ${r.label} report as CSV`)}>
              Export CSV
            </Button>
          </>
        }
      />
      <div className="sb-kpis">
        <div className="card pad">
          <Stat label="Gross sales" value={money(view.gross)} delta={d?.gross.value} dir={d?.gross.dir} good={d?.gross.good} note={r.compare} />
        </div>
        <div className="card pad">
          <Stat label="Orders" value={num(view.orders)} delta={d?.orders.value} dir={d?.orders.dir} good={d?.orders.good} />
        </div>
        <div className="card pad">
          <Stat label="Units sold" value={num(view.units)} note={`${(view.units / view.orders).toFixed(1)} units per order`} />
        </div>
        <div className="card pad">
          <Stat label="Return rate" value={pct((view.returns / view.units) * 100)} delta={d?.returnRate.value} dir={d?.returnRate.dir} good={d?.returnRate.good} note="returns ÷ units" />
        </div>
      </div>
      <div className="grid lg2 gap-5">
        <Card title="Orders per day" sub={`${num(view.orders)} orders · ${r.chartRange}`}>
          <Legend items={['Northwind Audio orders']} />
          <LineChart labels={view.labels} series={[{ name: 'Orders', data: r.orders }]} area label={`Orders per day, ${r.chartRange.replace(' – ', ' to ')}`} />
        </Card>
        <Card titleAs="h3" title="Returns by reason" sub={`${view.reasons} returns in the period`}>
          <BarChart labels={RETURN_REASONS} data={r.returnsByReason} height={220} label="Returns by reason" />
          <span className="xs muted">{r.note}</span>
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
              {view.products.map((p) => (
                <tr key={p.sku}>
                  <td>
                    <div className="cell-main minw-240">
                      <Img icon={p.icon} tint="2" className="tiny" />
                      <span className="stack gap-0">
                        <span className="small strong">{p.name}</span>
                        {p.liveDiscount && (
                          <span>
                            <span className="badge t-deal-soft">Live discount</span>
                          </span>
                        )}
                      </span>
                    </div>
                  </td>
                  <td>
                    <span className="mono nowrap" title={p.sku}>
                      {p.sku}
                    </span>
                  </td>
                  <td className="r">
                    <span className="num">{num(p.units)}</span>
                  </td>
                  <td className="r">
                    <span className="num strong">{money(p.gross)}</span>
                  </td>
                  <td className="r">
                    <span className="num">{money(p.units ? p.gross / p.units : 0)}</span>
                  </td>
                  <td className="r">
                    <span className="num">{p.returns}</span>
                  </td>
                  <td className="r">
                    <span className="num">{pct(p.units ? (p.returns / p.units) * 100 : 0)}</span>
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
        sub="Against Marketly service targets, last 30 days"
        actions={
          <Link className="small strong" to={href('seller/performance')}>
            Account health
          </Link>
        }
      >
        <div className="grid md2" style={{ '--gap': '0 var(--sp-6)' } as CSSProperties}>
          {SERVICE.map((m) => {
            const status = m.meets ? 'Meets target' : 'Below target';
            const tone = m.meets ? 'success' : 'warning';
            return (
              <div key={m.name} className="sb-metric">
                <div className="stack gap-0">
                  <span className="small strong">{m.name}</span>
                  <span className="xs muted">Target: {m.target}</span>
                </div>
                <div className="row gap-2 nowrap">
                  <span className="h3 num">{m.value}</span>
                  <StatusBadge status={status} tone={tone} />
                </div>
                <div className="bar">
                  <Meter pct={m.pct} tone={tone} label={`${m.value} ${status}`} />
                  {m.near && <span className="xs strong meter-note t-warning-text">Near target</span>}
                </div>
                <span className="xs muted span-all">{m.how}</span>
              </div>
            );
          })}
        </div>
      </Card>
    </SellerLayout>
  );
}
