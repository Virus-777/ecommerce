import { useState, type CSSProperties } from 'react';
import { AdminLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { money, num } from '@marketly/web-shared/lib/format';
import { Alert, announce, Breadcrumbs, Button, Field, Icon, Legend, LineChart, Select, SplitBar, Stat, SummaryRow, TableWrap, type IconName } from '@marketly/web-shared/ui';

// Design: pages/admin/admin-reports.html (report library + Commerce: sales).

interface LibGroup { name: string; icon: IconName; owner: string; reports: string[] }
const LIBRARY: LibGroup[] = [
  { name: 'Commerce', icon: 'shopping-bag', owner: 'Mei Lin, Reports Analyst', reports: ['Sales', 'Orders and average order value', 'Cancellations and refunds'] },
  { name: 'Company trading', icon: 'badge-check', owner: 'Dana Ortiz, Official Store Manager', reports: ['Product sales and margin', 'Purchasing cost', 'Discounts and shipping expense', 'Returns cost'] },
  { name: 'Marketplace finance', icon: 'landmark', owner: 'Priya Nair, Finance Manager', reports: ['Seller sales and earned fees', 'Discount funding', 'Amounts owed to sellers', 'Holds and completed payouts'] },
  { name: 'Products and discovery', icon: 'package', owner: 'Omar Haddad, Catalog Manager', reports: ['Views, cart additions, purchases', 'Searches with no available result', 'Stockouts', 'Product return reasons'] },
  { name: 'Service and sellers', icon: 'store', owner: 'Grace Kim, Seller Manager', reports: ['On-time dispatch', 'Delivery issues', 'Seller cancellations', 'Response time and case backlog', 'Complaint patterns'] },
  { name: 'Customers, marketing and ads', icon: 'megaphone', owner: 'Jamie Brooks, Marketing and Advertising', reports: ['Returning buyers and repeat purchases', 'Campaign results', 'Ad displays, clicks, dismissals and spend'] },
];

interface Day { date: string; label: string; official: number; sellers: number; cancellations: number; refunds: number; orders: number }
// Oldest first.
const DAYS: Day[] = [
  { date: 'Sep 25, 2026', label: 'Sep 25', official: 18200, sellers: 11400, cancellations: 473.6, refunds: 621.6, orders: 416 },
  { date: 'Sep 26, 2026', label: 'Sep 26', official: 19100, sellers: 12000, cancellations: 590.9, refunds: 559.8, orders: 437 },
  { date: 'Sep 27, 2026', label: 'Sep 27', official: 22400, sellers: 14800, cancellations: 520.8, refunds: 892.8, orders: 522 },
  { date: 'Sep 28, 2026', label: 'Sep 28', official: 24800, sellers: 16200, cancellations: 902, refunds: 820, orders: 576 },
  { date: 'Sep 29, 2026', label: 'Sep 29', official: 17600, sellers: 12100, cancellations: 504.9, refunds: 653.4, orders: 417 },
  { date: 'Sep 30, 2026', label: 'Sep 30', official: 16900, sellers: 12600, cancellations: 442.5, refunds: 560.5, orders: 414 },
  { date: 'Oct 1, 2026', label: 'Oct 1', official: 18400, sellers: 13000, cancellations: 565.2, refunds: 816.4, orders: 441 },
  { date: 'Oct 2, 2026', label: 'Oct 2', official: 20200, sellers: 14400, cancellations: 692, refunds: 726.6, orders: 486 },
  { date: 'Oct 3, 2026', label: 'Oct 3', official: 21000, sellers: 15100, cancellations: 577.6, refunds: 613.7, orders: 507 },
  { date: 'Oct 4, 2026', label: 'Oct 4', official: 25600, sellers: 18900, cancellations: 845.5, refunds: 890, orders: 625 },
  { date: 'Oct 5, 2026', label: 'Oct 5', official: 27100, sellers: 20300, cancellations: 1090.2, refunds: 1185, orders: 666 },
  { date: 'Oct 6, 2026', label: 'Oct 6', official: 19400, sellers: 14200, cancellations: 571.2, refunds: 739.2, orders: 472 },
  { date: 'Oct 7, 2026', label: 'Oct 7', official: 18800, sellers: 14900, cancellations: 505.5, refunds: 471.8, orders: 473 },
  { date: 'Oct 8, 2026', label: 'Oct 8', official: 20600, sellers: 16100, cancellations: 440.4, refunds: 220.2, orders: 515 },
];

const RANGES = [
  { value: '14', label: 'Sep 25 – Oct 8, 2026 (14 days)', days: 14, text: 'Sep 25 – Oct 8, 2026' },
  { value: '1', label: 'Today', days: 1, text: 'Oct 8, 2026' },
  { value: '7', label: 'Last 7 days', days: 7, text: 'Oct 2 – Oct 8, 2026' },
  { value: '30', label: 'Last 30 days', days: 14, text: 'Sep 25 – Oct 8, 2026' },
  { value: 'custom', label: 'Custom range', days: 14, text: 'Sep 25 – Oct 8, 2026' },
];
const BASES = [
  { value: 'placed', label: 'Order placement date' },
  { value: 'paid', label: 'Payment date' },
  { value: 'shipped', label: 'Shipment date' },
  { value: 'completed', label: 'Completion date' },
];
const SOLD_BY = [
  { value: 'all', label: 'Official Store and sellers' },
  { value: 'official', label: 'Official Store only' },
  { value: 'sellers', label: 'Marketplace sellers only' },
];

const k = (n: number) => `$${(n / 1000).toFixed(1)}k`;
const neg = (n: number) => `−${money(n)}`;

export default function Reports() {
  const [range, setRange] = useState('14');
  const [basis, setBasis] = useState('placed');
  const [soldBy, setSoldBy] = useState('all');
  const [notice, setNotice] = useState('');

  const r = RANGES.find((x) => x.value === range) ?? RANGES[0];
  const rows = DAYS.slice(-r.days);
  const inc = { official: soldBy !== 'sellers', sellers: soldBy !== 'official' };
  const gross = (d: Day) => (inc.official ? d.official : 0) + (inc.sellers ? d.sellers : 0);
  // Cancellations, refunds and orders are split by share of gross when one side is filtered out.
  const share = (d: Day) => gross(d) / (d.official + d.sellers);
  const canc = (d: Day) => d.cancellations * share(d);
  const refs = (d: Day) => d.refunds * share(d);
  const ords = (d: Day) => Math.round(d.orders * share(d));
  const sum = (f: (d: Day) => number) => rows.reduce((a, d) => a + f(d), 0);

  const tOfficial = sum((d) => d.official);
  const tSellers = sum((d) => d.sellers);
  const tGross = sum(gross);
  const tCanc = sum(canc);
  const tRefs = sum(refs);
  const tAfter = tGross - tCanc - tRefs;
  const tOrders = sum(ords);
  const isDefault = r.value === '14' && soldBy === 'all';
  const offPct = Math.round((tOfficial / (tOfficial + tSellers)) * 100);
  const basisWord = { placed: 'placed', paid: 'paid', shipped: 'shipped', completed: 'completed' }[basis] ?? 'placed';

  const series = [
    ...(inc.official ? [{ name: 'Official Store', data: rows.map((d) => d.official / 1000) }] : []),
    ...(inc.sellers ? [{ name: 'Marketplace sellers', data: rows.map((d) => d.sellers / 1000) }] : []),
  ];

  const exportCsv = () => {
    const head = ['Date', 'Official Store', 'Marketplace sellers', 'Gross sales', 'Cancellations', 'Refunds', 'After cancellations and refunds', 'Orders'];
    const lines = [...rows].reverse().map((d) => [d.date, inc.official ? d.official : 0, inc.sellers ? d.sellers : 0, gross(d), -canc(d).toFixed(2), -refs(d).toFixed(2), (gross(d) - canc(d) - refs(d)).toFixed(2), ords(d)]);
    const csv = [head, ...lines].map((l) => l.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'commerce-sales.csv';
    a.click();
    URL.revokeObjectURL(url);
    announce('Commerce sales exported as CSV');
  };
  const flash = (msg: string) => {
    setNotice(msg);
    announce(msg);
  };

  return (
    <AdminLayout active="reports">
      <div className="page-head">
        <div className="t">
          <Breadcrumbs items={[{ label: 'Reports and settings' }, { label: 'Reports' }]} />
          <h1 className="h1">Reports</h1>
          <p className="sub small">Definitions are maintained by Mei Lin, Reports Analyst. Exports follow your permissions.</p>
        </div>
        <div className="actions">
          <Button variant="secondary" size="sm" icon="calendar-clock" onClick={() => flash('Commerce: sales will be emailed to you every Monday at 8:00 AM PT')}>
            Schedule email
          </Button>
          <Button variant="secondary" size="sm" icon="download" onClick={exportCsv}>
            Export CSV
          </Button>
        </div>
      </div>

      {notice && <Alert tone="success" title={notice} />}

      <div className="ac-lib">
        <section className="card" aria-label="Report library">
          <div className="card-head">
            <div className="stack gap-0">
              <h2 className="h4">Report library</h2>
              <span className="xs muted">23 launch reports · 6 areas</span>
            </div>
          </div>
          {LIBRARY.map((g) => (
            <div className="ac-libgrp" key={g.name}>
              <div className="row between gap-2 nowrap">
                <span className="row gap-2 nowrap small strong">
                  <Icon name={g.icon} className="ic-sm" />
                  {g.name}
                </span>
              </div>
              <span className="xs muted u-mb-sp-1">Owner: {g.owner}</span>
              {g.reports.map((rep) => {
                const on = g.name === 'Commerce' && rep === 'Sales';
                return (
                  <a key={rep} className={cx('ac-rl', on && 'is-active')} href="#" aria-current={on ? 'page' : undefined}>
                    <Icon name={on ? 'chart-line' : 'file-chart-column'} className="ic-sm" />
                    <span>{rep}</span>
                  </a>
                );
              })}
            </div>
          ))}
        </section>

        <div className="stack gap-5">
          <section className="card">
            <div className="card-head">
              <div className="stack gap-1">
                <span className="eyebrow">Commerce · Owner Mei Lin</span>
                <h2 className="h3">Commerce: sales</h2>
                <span className="xs muted">Completed and gross sales, split between the Official Store and marketplace sellers</span>
              </div>
              <div className="row gap-2">
                <Button variant="ghost" size="sm" icon="bookmark" onClick={() => flash('View saved to your reports')}>
                  Save view
                </Button>
                <Button variant="secondary" size="sm" icon="download" onClick={exportCsv}>
                  Export
                </Button>
              </div>
            </div>
            <div className="card-body" style={{ gap: 'var(--sp-4)' } as CSSProperties}>
              <div className="ac-filters">
                <Field label="Date range">
                  <Select id="rp-range" options={RANGES} value={range} onChange={(e) => setRange(e.target.value)} />
                </Field>
                <Field label="Date basis">
                  <Select id="rp-basis" options={BASES} value={basis} onChange={(e) => setBasis(e.target.value)} />
                </Field>
                <Field label="Sold by">
                  <Select id="rp-seller" options={SOLD_BY} value={soldBy} onChange={(e) => setSoldBy(e.target.value)} />
                </Field>
                <Field label="Currency" hint="One currency at launch">
                  <Select id="rp-cur" options={['USD (US dollar)']} />
                </Field>
                <Field label="Time zone" hint="Days run 12:00 AM to 11:59 PM PT">
                  <Select id="rp-tz" options={['Pacific Time (PT)']} />
                </Field>
              </div>
              <div className="panel xs sub row gap-2">
                <Icon name="info" className="ic-sm" />
                <span>
                  Showing orders <b>{basisWord}</b> {r.text}, Pacific Time, in USD. Tax excluded. Figures through Oct 8, 9:40 AM PT; refunds for recent days can still change.
                </span>
              </div>
              <div className="ac-kpis">
                <div className="panel">
                  <Stat label="Gross sales" value={k(tGross)} {...(isDefault ? { delta: '8.2% · vs prior 14 days', dir: 'up' as const, good: true } : {})} />
                </div>
                <div className="panel">
                  <Stat label="Sales after cancellations and refunds" value={k(tAfter)} note={`${((tAfter / tGross) * 100).toFixed(1)}% of gross`} />
                </div>
                <div className="panel">
                  <Stat label="Orders" value={num(tOrders)} {...(isDefault ? { delta: '5.6%', dir: 'up' as const, good: true } : {})} />
                </div>
                <div className="panel">
                  <Stat label="Average order value" value={money(tGross / tOrders)} note="gross sales ÷ orders" />
                </div>
              </div>
              <div className="stack gap-2">
                <div className="row between">
                  <Legend items={series.map((s) => s.name)} />
                  <span className="xs muted">Daily gross sales, USD</span>
                </div>
                {rows.length > 1 ? (
                  <LineChart labels={rows.map((d) => d.label)} series={series} height={240} fmt={(v) => `$${Math.round(v)}k`} label={`Daily gross sales, ${series.map((s) => s.name).join(' vs ')}, ${rows[0].label} to ${rows[rows.length - 1].label}`} />
                ) : (
                  <p className="small muted">One day selected: see the table below.</p>
                )}
                {soldBy === 'all' && (
                  <>
                    <div className="row between xs sub">
                      <span>
                        Official Store {k(tOfficial)} · {offPct}%
                      </span>
                      <span>
                        Marketplace sellers {k(tSellers)} · {100 - offPct}%
                      </span>
                    </div>
                    <SplitBar a={offPct} b={100 - offPct} />
                  </>
                )}
              </div>
            </div>
            <TableWrap label="Commerce: sales table">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Date ({basisWord})</th>
                    {inc.official && (
                      <th className="r" scope="col">
                        Official Store
                      </th>
                    )}
                    {inc.sellers && (
                      <th className="r" scope="col">
                        Marketplace sellers
                      </th>
                    )}
                    <th className="r" scope="col">
                      Gross sales
                    </th>
                    <th className="r" scope="col">
                      Cancellations
                    </th>
                    <th className="r" scope="col">
                      Refunds
                    </th>
                    <th className="r" scope="col">
                      After cancellations and refunds
                    </th>
                    <th className="r col-pin" scope="col">
                      Orders
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {[...rows].reverse().map((d) => (
                    <tr key={d.date}>
                      <td>{d.date}</td>
                      {inc.official && <td className="r">{money(d.official)}</td>}
                      {inc.sellers && <td className="r">{money(d.sellers)}</td>}
                      <td className="r">
                        <b>{money(gross(d))}</b>
                      </td>
                      <td className="r">{neg(canc(d))}</td>
                      <td className="r">{neg(refs(d))}</td>
                      <td className="r">{money(gross(d) - canc(d) - refs(d))}</td>
                      <td className="r col-pin">{num(ords(d))}</td>
                    </tr>
                  ))}
                  <tr className="ac-total">
                    <td>{rows.length}-day total</td>
                    {inc.official && <td className="r">{money(tOfficial)}</td>}
                    {inc.sellers && <td className="r">{money(tSellers)}</td>}
                    <td className="r">{money(tGross)}</td>
                    <td className="r">{neg(tCanc)}</td>
                    <td className="r">{neg(tRefs)}</td>
                    <td className="r">{money(tAfter)}</td>
                    <td className="r col-pin">{num(tOrders)}</td>
                  </tr>
                </tbody>
              </table>
            </TableWrap>
          </section>

          <section className="card">
            <div className="card-head">
              <div className="stack gap-0">
                <h2 className="h4">Definitions used in this report</h2>
                <span className="xs muted">Maintained by Mei Lin, Reports Analyst · version 3, reviewed Oct 1, 2026</span>
              </div>
              <Button variant="ghost" size="sm" icon="pencil" onClick={() => flash('Suggestion sent to Mei Lin, Reports Analyst')}>
                Suggest a change
              </Button>
            </div>
            <div className="card-body">
              <div className="grid lg2 gap-5">
                <dl className="ac-defs">
                  <dt>Gross sales</dt>
                  <dd>Item prices plus shipping charged to customers, after customer discounts, before cancellations and refunds. Tax is excluded. Includes Official Store and marketplace seller sales.</dd>
                  <dt>Sales after cancellations and refunds</dt>
                  <dd>Gross sales minus cancelled items and refunds sent, counted on the selected date basis. This is the figure to compare against targets.</dd>
                  <dt>Orders</dt>
                  <dd>Accepted checkouts. One checkout with items from three sellers counts as one order with three seller groups.</dd>
                  <dt>Date basis</dt>
                  <dd>Placement counts an order on the day it was placed. Payment, shipment and completion dates move the same order to a later day, so totals differ by basis.</dd>
                </dl>
                <div className="stack gap-3">
                  <Alert tone="info" title="Marketplace sales are not marketplace fee income">
                    Marketplace sellers sold {money(tSellers)} in this period. The company earned {money(tSellers * 0.094)} in marketplace fees on those sales. Fee income appears in Marketplace finance reports, not here.
                  </Alert>
                  <div className="well stack gap-2">
                    <span className="small strong">How the two figures relate</span>
                    <SummaryRow k="Marketplace sales (customer paid)" v={money(tSellers)} />
                    <SummaryRow k="Marketplace fee income (company)" v={money(tSellers * 0.094)} />
                    <SummaryRow k="Seller earnings before adjustments" v={money(tSellers * 0.906)} />
                    <span className="xs muted row gap-1 nowrap wrap">
                      <Icon name="info" className="ic-sm" />
                      <span>Effective fee rate 9.4% for the period. Category rates are set in Settings.</span>
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>
    </AdminLayout>
  );
}
