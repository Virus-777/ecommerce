import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { SellerLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { money } from '@marketly/web-shared/lib/format';
import { href } from '@marketly/web-shared/routes';
import { sales14 } from '@marketly/web-shared/data/fixtures';
import { Badge, Button, Card, Deadline, Icon, Legend, LineChart, Meter, Stat, StatusLegend, TableWrap, type IconName } from '@marketly/web-shared/ui';

// Design: pages/seller/seller-dashboard.html (no views).

interface Queue {
  n: number;
  label: string;
  sub: string;
  tone?: 'danger' | 'warning';
  to: string;
}

const QUEUES: Queue[] = [
  { n: 1, label: 'Overdue dispatch', sub: 'MK-261007-10433 · 3 h past deadline', tone: 'danger', to: href('seller/orders', 'preparing') },
  { n: 4, label: 'Dispatch due today by 5:00 PM', sub: '2 new · 2 preparing', tone: 'warning', to: href('seller/orders') },
  { n: 3, label: 'New orders', sub: 'Placed since yesterday 5:00 PM', to: href('seller/orders') },
  { n: 3, label: 'Low or out of stock', sub: '2 low · 1 out of stock (Aurora, Silver)', tone: 'warning', to: href('seller/inventory') },
  { n: 2, label: 'Open returns', sub: '1 needs your decision by Oct 9', to: href('seller/returns') },
  { n: 5, label: 'Unanswered messages', sub: 'Reply within 24 h · oldest waiting 19 h', tone: 'warning', to: href('seller/customers') },
];

interface DeadlineRow {
  ref: string;
  placed: string;
  buyer: string;
  items: string;
  due: string;
  tone: 'danger' | 'warning';
  action: string;
}

const DEADLINES: DeadlineRow[] = [
  { ref: 'MK-261007-10433', placed: 'Oct 7, 6:48 PM', buyer: 'Alex M.', items: 'Halden Pocket Speaker × 1', due: 'Overdue 3 h', tone: 'danger', action: 'Record shipment' },
  { ref: 'MK-261008-12077', placed: 'Oct 8, 9:14 AM', buyer: 'Sam R.', items: 'Halden Pocket Bluetooth Speaker × 2', due: 'Due today 5:00 PM', tone: 'warning', action: 'Prepare' },
  { ref: 'MK-261008-11902', placed: 'Oct 8, 8:02 AM', buyer: 'Priya K.', items: 'Halden Aurora ANC Headphones', due: 'Due today 5:00 PM', tone: 'warning', action: 'Prepare' },
];

/** Daily item sales for the last 14 days (USD), on the sales14 date axis. */
const SALES = [1180, 1342, 1610, 1795, 1204, 1166, 1388, 1452, 1590, 2064, 2236, 1478, 1512, 1688];
const kfmt = (v: number) => `$${(v / 1000).toFixed(1)}k`;

const PERF = [
  { label: 'On-time dispatch', badge: 'Meets target', tone: 'success' as const, value: <><b className="num u-c-text">96.4%</b> of 214 orders</>, target: 'Target 95% or higher', pct: 96, aria: '96.4%' },
  { label: 'Cancellation rate', badge: 'Meets target', tone: 'success' as const, value: <><b className="num u-c-text">0.9%</b> seller-cancelled</>, target: 'Target below 2.5%', pct: 36, aria: '0.9%' },
  { label: 'Message response time', badge: 'Watch', tone: 'warning' as const, value: <>Median <b className="num u-c-text">14 h</b> · 2 over 24 h</>, target: 'Target within 24 h', pct: 58, aria: '14 h', note: 'Near target' },
];

const NEWS: Array<{ icon: IconName; title: string; tag?: string; body: string; foot: ReactNode; strong?: boolean }> = [
  {
    icon: 'file-text',
    title: 'Return policy update',
    tag: 'Policy',
    body: 'Electronics return windows stay at 30 days. Restocking fees for opened headphones are no longer allowed.',
    foot: (
      <>
        Effective Nov 1, 2026 ·{' '}
        <a href="#" className="link-inline">
          Read the change
        </a>
      </>
    ),
    strong: true,
  },
  { icon: 'calendar-days', title: 'Holiday dispatch cutoffs', body: 'Add your closures in Shipping by Nov 15 so arrival estimates stay accurate.', foot: 'Posted Oct 5' },
];

/** Work-queue tile; the shared QueueTile only announces "(urgent)", the design also marks amber tiles "(at risk)". */
function Tile({ q }: { q: Queue }) {
  return (
    <Link className={cx('queue-tile', q.tone && `t-${q.tone}`)} to={q.to}>
      <span className="qn">
        {q.n}
        {q.tone && <span className="sr-only"> ({q.tone === 'danger' ? 'urgent' : 'at risk'})</span>}
      </span>
      <span className="stack gap-0 grow">
        <span className="small strong">{q.label}</span>
        <span className="xs muted">{q.sub}</span>
      </span>
      <Icon name="chevron-right" className="ic-sm" />
    </Link>
  );
}

export default function Dashboard() {
  const total = SALES.reduce((a, b) => a + b, 0);
  const today = SALES[SALES.length - 1];
  return (
    <SellerLayout active="dashboard">
      <div className="page-head">
        <div className="t">
          <h1 className="h1">Today at Northwind Audio</h1>
          <p className="sub small">Thursday, Oct 8, 2026 · updated 10:05 AM PT</p>
        </div>
        <div className="actions">
          <Button variant="secondary" size="sm" icon="plus" to={href('seller/catalog-match')}>
            Add product
          </Button>
          <Button size="sm" to={href('seller/orders')}>
            Go to orders
          </Button>
        </div>
      </div>
      <section className="stack gap-3" aria-labelledby="sa-work">
        <h2 className="h3" id="sa-work">
          Work for today
        </h2>
        <div className="sa-tiles">
          {QUEUES.map((q) => (
            <Tile key={q.label} q={q} />
          ))}
        </div>
        <StatusLegend
          kind="number"
          items={[
            { tone: 'danger', label: 'Red number = urgent: overdue or past target' },
            { tone: 'warning', label: 'Amber number = at risk: due soon or near target' },
          ]}
        />
      </section>
      <div className="sa-split">
        <div className="stack gap-5">
          <Card
            title="Dispatch deadlines"
            titleAs="h3"
            sub="Open orders, most urgent first"
            actions={
              <Link className="small strong" to={href('seller/orders')}>
                All orders
              </Link>
            }
            flush
          >
            <TableWrap label="Dispatch deadlines table">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Order</th>
                    <th scope="col">Buyer</th>
                    <th scope="col">Items</th>
                    <th scope="col">Deadline</th>
                    <th scope="col">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {DEADLINES.map((r) => (
                    <tr key={r.ref} className={r.tone === 'danger' ? 'is-flagged' : 'is-warn'}>
                      <td>
                        <span className="sr-only">{r.tone === 'danger' ? 'Urgent: ' : 'At risk: '}</span>
                        <Link className="mono small nowrap" to={href('seller/order', '', { ref: r.ref })} title={r.ref}>
                          {r.ref}
                        </Link>
                        <div className="xs muted">{r.placed}</div>
                      </td>
                      <td>{r.buyer}</td>
                      <td>
                        <span className="small">{r.items}</span>
                      </td>
                      <td>
                        <Deadline tone={r.tone}>{r.due}</Deadline>
                      </td>
                      <td>
                        <Link className={cx('btn btn-sm', r.tone === 'danger' ? 'btn-primary' : 'btn-secondary')} to={href('seller/order', '', { ref: r.ref })}>
                          <span>{r.action}</span>
                          <span className="sr-only"> {r.ref}</span>
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
            <StatusLegend
              items={[
                { tone: 'danger', label: 'Red edge = urgent: overdue or past target' },
                { tone: 'warning', label: 'Amber edge = at risk: due soon or near target' },
              ]}
            />
          </Card>
          <Card
            title="Sales"
            titleAs="h3"
            sub="Last 14 days · item sales before fees, by order date"
            actions={
              <Link className="small strong" to={href('seller/reports')}>
                Open report
              </Link>
            }
          >
            <div className="row gap-6">
              <Stat label="14-day sales" value={kfmt(total)} delta="12.4%" dir="up" good note="vs prior 14 days" />
              <Stat label="Orders" value="214" note={`avg ${money(total / 214)}`} />
              <Stat label="Today so far" value={money(today)} note="9 orders" />
            </div>
            <Legend items={['Northwind Audio sales']} />
            <LineChart labels={sales14.labels} series={[{ name: 'Sales', data: SALES }]} fmt={kfmt} area label="Daily sales for Northwind Audio, last 14 days" />
          </Card>
        </div>
        <div className="stack gap-5">
          <Card
            title="Payouts"
            titleAs="h3"
            sub="Approved sales are not paid out until they become available"
            actions={
              <Link className="small strong" to={href('seller/finance')}>
                Finance
              </Link>
            }
          >
            <div className="grid c2 gap-3">
              <div className="stack gap-1">
                <span className="xs muted strong">Pending</span>
                <span className="sa-money">$2,418.60</span>
                <span className="xs muted">Waiting for delivery and hold</span>
              </div>
              <div className="stack gap-1">
                <span className="xs muted strong">Available</span>
                <span className="sa-money">$1,306.25</span>
                <span className="xs muted">Included in next payout</span>
              </div>
            </div>
            <div className="panel row between">
              <span className="small">
                Next payout · <b>Tue, Oct 13</b>
              </span>
              <span className="small strong num">$1,306.25</span>
            </div>
            <span className="xs muted">To Northwind Audio checking ending 6620 · Held: $0.00</span>
            <p className="xs muted row gap-1 nowrap top">
              <Icon name="info" className="ic-sm" />
              <span className="wrap">Example schedule: weekly on Tuesdays; earnings become available 7 days after delivery. Your seller agreement sets the final terms.</span>
            </p>
          </Card>
          <Card
            title="Performance"
            titleAs="h3"
            sub="Last 30 days, compared with service targets"
            actions={
              <Link className="small strong" to={href('seller/performance')}>
                Account health
              </Link>
            }
          >
            <ul className="sa-perf">
              {PERF.map((p) => (
                <li key={p.label}>
                  <div className="row between">
                    <span className="small strong">{p.label}</span>
                    <Badge tone={p.tone}>{p.badge}</Badge>
                  </div>
                  <div className="row between xs muted">
                    <span>{p.value}</span>
                    <span>{p.target}</span>
                  </div>
                  <Meter pct={p.pct} tone={p.tone} label={p.aria} />
                  {p.note && <span className={`xs strong meter-note t-${p.tone}-text`}>{p.note}</span>}
                </li>
              ))}
            </ul>
          </Card>
          <Card title="Announcements" titleAs="h3" flush>
            <ul className="list pad">
              {NEWS.map((n) => (
                <li key={n.title} className="items-start">
                  <Icon name={n.icon} />
                  <span className="grow stack gap-1">
                    {n.tag ? (
                      <span className="row gap-2">
                        <span className="small strong">{n.title}</span>
                        <Badge tone="info">{n.tag}</Badge>
                      </span>
                    ) : (
                      <span className="small strong">{n.title}</span>
                    )}
                    <span className="xs sub">{n.body}</span>
                    <span className={n.strong ? 'xs strong' : 'xs muted'}>{n.foot}</span>
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </SellerLayout>
  );
}
