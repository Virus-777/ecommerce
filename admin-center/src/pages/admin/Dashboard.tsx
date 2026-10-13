import { useState } from 'react';
import { Link } from 'react-router';
import { AdminLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { sales14 } from '@marketly/web-shared/data/fixtures';
import type { ScreenId } from '@marketly/web-shared/routes';
import { href } from '@marketly/web-shared/routes';
import { Alert, Avatar, Badge, Button, Card, Deadline, Icon, Legend, LineChart, SegmentedControl, SplitBar, Stat, StatusBadge, TableWrap, announce } from '@marketly/web-shared/ui';

// Design: pages/admin/admin-dashboard.html (single view).

type Range = 'today' | '7d' | '30d';

interface Kpi {
  label: string;
  value: string;
  delta?: string;
  dir?: 'up' | 'down';
  note?: string;
}

const RANGES: Array<{ value: Range; label: string }> = [
  { value: 'today', label: 'Today' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
];

const KPIS: Record<Range, Kpi[]> = {
  today: [
    { label: 'Gross sales', value: '$36.7k', delta: '4.1%', dir: 'up', note: 'vs same day last week' },
    { label: 'Orders', value: '512', delta: '3.0%', dir: 'up', note: 'avg $71.70' },
    { label: 'Marketplace fee income', value: '$1.5k', note: 'on $16.1k seller sales' },
    { label: 'Refunds', value: '$0.8k', delta: '0.2 pts', dir: 'down', note: '2.2% of gross' },
  ],
  '7d': [
    { label: 'Gross sales', value: '$266.6k', delta: '8.2%', dir: 'up', note: 'vs prior 7 days' },
    { label: 'Orders', value: '3,418', delta: '5.6%', dir: 'up', note: 'avg $71.20' },
    { label: 'Marketplace fee income', value: '$10.9k', note: 'on $113.9k seller sales' },
    { label: 'Refunds', value: '$6.1k', delta: '0.4 pts', dir: 'down', note: '2.1% of gross' },
  ],
  '30d': [
    { label: 'Gross sales', value: '$1.08M', delta: '6.4%', dir: 'up', note: 'vs prior 30 days' },
    { label: 'Orders', value: '14,206', delta: '4.9%', dir: 'up', note: 'avg $70.90' },
    { label: 'Marketplace fee income', value: '$44.2k', note: 'on $462.5k seller sales' },
    { label: 'Refunds', value: '$24.8k', delta: '0.3 pts', dir: 'down', note: '2.3% of gross' },
  ],
};

interface DispatchRow {
  ref: string;
  seller: string;
  item: string;
  deadline: string;
  urgent: boolean;
  owner: string;
  action: 'Remind' | 'Escalate' | 'View';
}

const DISPATCH: DispatchRow[] = [
  { ref: 'MK-261007-10433', seller: 'Northwind Audio', item: 'Halden Pocket Speaker', deadline: 'Overdue 3 h', urgent: true, owner: 'Seller', action: 'Remind' },
  { ref: 'MK-260914-48213', seller: 'Casa Verde Home', item: 'Linen Duvet Cover, Queen', deadline: 'Overdue 16 d', urgent: true, owner: 'Grace Kim', action: 'Escalate' },
  { ref: 'MK-261007-10120', seller: 'Marketly Official', item: 'Kestrel 27" Monitor', deadline: 'Due in 1 h', urgent: false, owner: 'Warehouse', action: 'View' },
  { ref: 'MK-261006-09977', seller: 'Gadget Grove', item: 'S2 Robot Vacuum', deadline: 'Overdue 1 d', urgent: true, owner: 'Seller', action: 'Remind' },
];

const ADS = [
  { name: 'Home Week opening ad', meta: 'Full-screen · once per session · ends Oct 19', status: 'Live' },
  { name: 'Halden Aurora banner', meta: 'Home banner · sponsored · $1,240 of $3,000', status: 'Live' },
  { name: 'Free shipping pop-up', meta: 'Pop-up · new visitors · starts Oct 10', status: 'Scheduled' },
];

const PAYOUT_ROWS: Array<{ label: string; n: number; tone?: 'warning' | 'danger' }> = [
  { label: 'Ready to pay', n: 38 },
  { label: 'Held for review', n: 3, tone: 'warning' },
  { label: 'Failed last run', n: 2, tone: 'danger' },
];

interface Queue {
  n: number;
  label: string;
  sub: string;
  tone?: 'danger' | 'warning';
  to: ScreenId;
}

const QUEUES: Queue[] = [
  { n: 9, label: 'Overdue dispatch', sub: 'Order & Shipping', tone: 'danger', to: 'ops/dispatch' },
  { n: 5, label: 'Cases past response target', sub: 'Customer Support', tone: 'danger', to: 'admin/cases' },
  { n: 2, label: 'Failed payouts', sub: 'Finance', tone: 'danger', to: 'admin/payouts' },
  { n: 3, label: 'Payment mismatches', sub: 'Daily finance check', tone: 'warning', to: 'ops/finance-checks' },
  { n: 12, label: 'Low stock, Official Store', sub: 'Inventory', tone: 'warning', to: 'ops/inventory' },
  { n: 23, label: 'Products awaiting review', sub: 'Catalog · oldest 2 days', to: 'admin/product-review' },
  { n: 7, label: 'Seller applications', sub: 'Seller Manager', to: 'admin/seller-application' },
  { n: 4, label: 'Trust and risk reports', sub: 'Counterfeit, fake reviews', to: 'admin/trust' },
  { n: 14, label: 'Returns to decide', sub: 'Returns Manager', to: 'admin/returns' },
];

const TEAM = [
  { name: 'Theo Grant', team: 'Orders & Shipping', role: 'Lead' },
  { name: 'Isabel Cruz', team: 'Customer Support', role: 'Lead' },
  { name: 'Priya Nair', team: 'Finance', role: 'Lead' },
  { name: 'Ana Silva', team: 'Inventory & Warehouse', role: 'Backup for Theo' },
];

const DONE_LABEL: Record<DispatchRow['action'], string> = { Remind: 'Reminded', Escalate: 'Escalated', View: 'View' };

export default function Dashboard() {
  const [range, setRange] = useState<Range>('7d');
  const [done, setDone] = useState<Record<string, boolean>>({});

  const act = (r: DispatchRow) => {
    setDone((d) => ({ ...d, [r.ref]: true }));
    announce(r.action === 'Remind' ? `Reminder sent to ${r.seller} for ${r.ref}` : `${r.ref} escalated to Orders & Shipping`);
  };

  return (
    <AdminLayout active="dashboard">
      <div className="page-head">
        <div className="t">
          <h1 className="h1">Good morning, Riley</h1>
          <p className="sub small">Thursday, Oct 8, 2026 · figures through 9:40 AM PT · gross sales by order placement date</p>
        </div>
        <div className="actions">
          <SegmentedControl items={RANGES} active={range} onChange={setRange} label="Date range" />
          <Button variant="secondary" size="sm" icon="download" onClick={() => announce('Export started. The file downloads when it is ready.')}>
            Export
          </Button>
        </div>
      </div>

      <div className="ad-kpis">
        {KPIS[range].map((k) => (
          <div className="card pad" key={k.label}>
            <Stat label={k.label} value={k.value} delta={k.delta} dir={k.dir} good={k.dir ? true : undefined} note={k.note} />
          </div>
        ))}
      </div>

      <div className="ad-main">
        <div className="stack gap-5">
          <Card
            title="Sales split"
            sub="Last 14 days · USD"
            actions={
              <Link className="small strong" to={href('admin/report', '', { key: 'sales' })}>
                Open report
              </Link>
            }
          >
            <Legend items={['Official Store', 'Marketplace sellers']} />
            <LineChart
              labels={sales14.labels}
              series={[
                { name: 'Official', data: sales14.official },
                { name: 'Sellers', data: sales14.sellers },
              ]}
              height={230}
              fmt={(v) => `$${Math.round(v)}k`}
              label="Daily sales, Official Store vs marketplace sellers"
            />
            <div className="stack gap-2">
              <div className="row between xs sub">
                <span>Official Store 57% · $152.7k</span>
                <span>Sellers 43% · $113.9k</span>
              </div>
              <SplitBar a={57} b={43} />
            </div>
          </Card>

          <Card
            titleAs="h3"
            title="Overdue and at-risk dispatch"
            sub="9 items past their dispatch deadline"
            actions={
              <Button variant="secondary" size="sm" to={href('ops/dispatch')}>
                Open dispatch queue
              </Button>
            }
            flush
          >
            <TableWrap label="Overdue and at-risk dispatch table">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Order</th>
                    <th scope="col">Seller</th>
                    <th scope="col">Item</th>
                    <th scope="col">Deadline</th>
                    <th scope="col">Owner</th>
                    <th className="col-pin" scope="col">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {DISPATCH.map((r) => (
                    <tr key={r.ref} className={r.urgent ? 'is-flagged' : 'is-warn'}>
                      <td className="cell-id">
                        <span className="sr-only">{r.urgent ? 'Urgent: ' : 'At risk: '}</span>
                        <Link className="mono nowrap" to={href('admin/order', '', { ref: r.ref })} title={r.ref}>
                          {r.ref}
                        </Link>
                      </td>
                      <td className="cell-name">
                        <span className="ellip" title={r.seller}>{r.seller}</span>
                      </td>
                      <td className="cell-name">
                        <span className="ellip" title={r.item}>{r.item}</span>
                      </td>
                      <td>
                        <Deadline tone={r.urgent ? 'danger' : 'warning'}>{r.deadline}</Deadline>
                      </td>
                      <td className="cell-name">
                        <span className="ellip" title={r.owner}>{r.owner}</span>
                      </td>
                      <td className="col-pin">
                        {r.action === 'View' ? (
                          <Link className="btn btn-ghost btn-sm" to={href('admin/order', '', { ref: r.ref })}>
                            <span>View</span>
                            <span className="sr-only"> {r.ref}</span>
                          </Link>
                        ) : (
                          <button type="button" className="btn btn-ghost btn-sm" disabled={done[r.ref]} onClick={() => act(r)}>
                            <span>{done[r.ref] ? DONE_LABEL[r.action] : r.action}</span>
                            <span className="sr-only"> {r.ref}</span>
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
            <UrgencyLegend kind="edge" />
          </Card>

          <div className="grid lg2 gap-5">
            <Card
              titleAs="h3"
              title="Advertising today"
              sub="3 live · 2 starting this week"
              actions={
                <Link className="small strong" to={href('admin/ads')}>
                  Manage
                </Link>
              }
              flush
            >
              <ul className="list pad">
                {ADS.map((a) => (
                  <li key={a.name}>
                    <span className="grow stack gap-0">
                      <span className="small strong">{a.name}</span>
                      <span className="xs muted">{a.meta}</span>
                    </span>
                    <StatusBadge status={a.status} />
                  </li>
                ))}
              </ul>
            </Card>
            <Card
              titleAs="h3"
              title="Next payout run"
              sub="Friday, Oct 9 · 10:00 AM PT"
              actions={
                <Link className="small strong" to={href('admin/payouts')}>
                  Review
                </Link>
              }
            >
              <div className="row between base">
                <span className="h2 num">$78,420.55</span>
                <span className="small muted">41 sellers</span>
              </div>
              <ul className="list">
                {PAYOUT_ROWS.map((p) => (
                  <li key={p.label}>
                    <span className="grow small">{p.label}</span>
                    {p.tone ? (
                      <span className="row gap-2">
                        <Badge tone={p.tone}>{p.n}</Badge>
                      </span>
                    ) : (
                      <span className="small strong num">{p.n}</span>
                    )}
                  </li>
                ))}
              </ul>
              <Alert tone="warning" title="Second review needed">
                Runs over $50,000 need approval from a second Finance reviewer.
              </Alert>
            </Card>
          </div>
        </div>

        <div className="stack gap-5">
          <Card titleAs="h3" title="Needs attention" sub="Queues past or near their targets">
            <div className="ad-queues">
              {QUEUES.map((q) => (
                <Link key={q.label} className={cx('queue-tile', q.tone && `t-${q.tone}`)} to={href(q.to)}>
                  <span className="qn">
                    {q.n}
                    {q.tone && <span className="sr-only">{q.tone === 'danger' ? ' (urgent)' : ' (at risk)'}</span>}
                  </span>
                  <span className="stack gap-0 grow">
                    <span className="small strong">{q.label}</span>
                    <span className="xs muted">{q.sub}</span>
                  </span>
                  <Icon name="chevron-right" className="ic-sm" />
                </Link>
              ))}
            </div>
            <UrgencyLegend kind="number" />
          </Card>
          <Card titleAs="h3" title="Team on shift" sub="Leads and backups" flush>
            <ul className="list pad">
              {TEAM.map((t) => (
                <li key={t.name}>
                  <Avatar name={t.name} />
                  <span className="grow stack gap-0">
                    <span className="small strong">{t.name}</span>
                    <span className="xs muted">{t.team}</span>
                  </span>
                  <span className="xs muted">{t.role}</span>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </AdminLayout>
  );
}

/** The design's urgency legend. Local because the shared StatusLegend omits the "Legend:" sr-only prefix. */
function UrgencyLegend({ kind }: { kind: 'edge' | 'number' }) {
  return (
    <p className={`status-legend status-legend--${kind}`}>
      <span className="sr-only">Legend: </span>
      <span className="sl sl-danger">
        <i aria-hidden="true" />
        Red {kind} = urgent: overdue or past target
      </span>
      <span className="sl sl-warning">
        <i aria-hidden="true" />
        Amber {kind} = at risk: due soon or near target
      </span>
    </p>
  );
}
