import { useRef, useState } from 'react';
import { Link } from 'react-router';
import { OpsLayout } from '@/layouts';
import { cx } from '@/lib/cx';
import { href } from '@/routes/href';
import { Alert, Badge, Button, Card, Icon, Meter, PageHeader, SegmentedControl, Stat, TableWrap, announce } from '@/ui';
import { OpsLegend } from './data/shared';

// Design: pages/ops/ops-queues.html (single view).

interface QueueRow {
  name: string;
  to: string;
  mine: boolean;
  lead: string;
  backup: string;
  escalation: string;
  open: number;
  overdue: number;
  oldest: string;
}

const QUEUES: QueueRow[] = [
  { name: 'Overdue dispatch', to: href('ops/dispatch'), mine: true, lead: 'Theo Grant', backup: 'Ana Silva', escalation: 'Seller Manager (sellers), Business Owner after 48 h', open: 9, overdue: 6, oldest: 'MK-260914-48213 · 16 d' },
  { name: 'Missing tracking', to: href('ops/dispatch', 'missing-tracking'), mine: true, lead: 'Theo Grant', backup: 'Ana Silva', escalation: 'Seller Manager', open: 4, overdue: 2, oldest: 'MK-261005-07711 · 3 d' },
  { name: 'Lost, damaged or failed delivery', to: href('ops/dispatch', 'lost-or-damaged'), mine: true, lead: 'Theo Grant', backup: 'Isabel Cruz', escalation: 'Finance for claims over $1,000', open: 5, overdue: 1, oldest: 'MK-260929-30126 · 9 d' },
  { name: 'Seller cannot fulfill', to: href('ops/dispatch', 'seller-cannot-fulfill'), mine: true, lead: 'Theo Grant', backup: 'Isabel Cruz', escalation: 'Seller Manager', open: 3, overdue: 0, oldest: 'MK-261007-10512 · 18 h' },
  { name: 'Pick and pack, Official Store', to: href('ops/pick-pack'), mine: false, lead: 'Ana Silva', backup: 'Theo Grant', escalation: 'Warehouse Manager → Order Manager', open: 27, overdue: 0, oldest: 'MK-261008-12544 · 3 h' },
  { name: 'Receiving', to: href('ops/receiving'), mine: false, lead: 'Ana Silva', backup: 'Ken Watanabe', escalation: 'Purchasing Manager', open: 3, overdue: 0, oldest: 'PUR-2610-0042 · today' },
  { name: 'Return inspection', to: href('ops/return-inspection'), mine: false, lead: 'Lena Park', backup: 'Ana Silva', escalation: 'Customer Support Manager', open: 5, overdue: 1, oldest: 'RT-261004-0197 · 2 d' },
  { name: 'Daily finance checks', to: href('ops/finance-checks'), mine: false, lead: 'Priya Nair', backup: 'Morgan Hale', escalation: 'Business Owner', open: 6, overdue: 1, oldest: 'Deposit Oct 7 · 1 d' },
  { name: 'Customer cases waiting', to: href('admin/cases'), mine: false, lead: 'Isabel Cruz', backup: 'Theo Grant', escalation: 'Customer Support Manager', open: 31, overdue: 5, oldest: 'CS-260929-1044 · 9 d' },
];

const DAY_END: Array<{ title: string; note: string; to: string }> = [
  { title: 'Unresolved commitments', note: '7 orders past dispatch deadline still open. 2 customers not yet notified.', to: href('ops/dispatch') },
  { title: 'Failed payouts', note: 'PO-261002-0311 Trailhead Outfitters and PO-261002-0316 Gadget Grove · owner Priya Nair', to: href('ops/finance-checks') },
  { title: 'Upcoming campaigns', note: 'Free shipping pop-up starts Sat, Oct 10 · Home Week ends Mon, Oct 19 · owner Jamie Brooks', to: href('admin/ads') },
  { title: 'Next-day shipping', note: 'Fri, Oct 9: 188 Official Store orders forecast · UPS pickup 4:00 PM · 2 SKUs short for open orders', to: href('ops/inventory') },
];

type RoutineState = 'done' | 'now' | 'late' | '';
const ROUTINE: Array<{ title: string; note: string; state: RoutineState }> = [
  { title: 'Review dispatch and delivery', note: 'Order and Shipping · Theo Grant · done 8:40 AM', state: 'done' },
  { title: 'Review shortages and physical work', note: 'Inventory and Warehouse · Ana Silva · done 9:10 AM', state: 'done' },
  { title: 'Review waiting cases', note: 'Seller, Catalog, Returns, Support managers · 3 of 4 checked in', state: 'now' },
  { title: 'Check payments and payouts', note: 'Finance · Priya Nair · was due 10:00 AM', state: 'late' },
  { title: 'Check live campaigns and schedules', note: 'Advertising · Jamie Brooks · due 11:00 AM', state: '' },
];

const SAVED: Array<{ label: string; to: string; n: number }> = [
  { label: 'Overdue over 24 h, marketplace sellers', to: href('ops/dispatch'), n: 6 },
  { label: 'Missing tracking, Official Store', to: href('ops/dispatch', 'missing-tracking'), n: 1 },
  { label: 'Lost or damaged, no claim opened', to: href('ops/dispatch', 'lost-or-damaged'), n: 2 },
  { label: 'Due before 2 PM cutoff (shared)', to: href('ops/pick-pack'), n: 41 },
  { label: 'Failed delivery, customer cost applies (shared)', to: href('ops/dispatch', 'delivery-failed'), n: 1 },
];

export default function Queues() {
  const [scope, setScope] = useState<'mine' | 'all'>('all');
  const [sent, setSent] = useState(false);
  const [saved, setSaved] = useState(SAVED);
  const dayEndRef = useRef<HTMLElement>(null);

  const rows = scope === 'mine' ? QUEUES.filter((q) => q.mine) : QUEUES;
  const routineDone = ROUTINE.filter((r) => r.state === 'done').length;

  const startReview = () => {
    const el = dayEndRef.current;
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    el?.querySelector<HTMLElement>('.card-body a')?.focus({ preventScroll: true });
  };
  const sendSummary = () => {
    setSent(true);
    announce('Day-end summary sent to managers');
  };
  const saveFilter = () => {
    const label = scope === 'mine' ? 'My queues' : 'All queues';
    if (saved.some((s) => s.label === label)) return;
    setSaved((s) => [...s, { label, to: href('ops/queues'), n: rows.reduce((a, r) => a + r.open, 0) }]);
    announce(`Saved filter: ${label}`);
  };

  return (
    <OpsLayout active="queues">
      <PageHeader
        title="My work queues"
        sub="Theo Grant · Order Manager and Shipping Manager · Thursday, Oct 8, 2026 · 10:05 AM PT"
        actions={
          <>
            <Button variant="secondary" size="sm" icon="download">
              Export
            </Button>
            <Button size="sm" icon="clipboard-check" onClick={startReview}>
              Start day-end review
            </Button>
          </>
        }
      />
      <div className="ac-kpis">
        <div className="card pad">
          <Stat label="Assigned to me" value="21" note="4 queues where I lead" />
        </div>
        <div className="card pad">
          {/* Design: a rise in overdue items is bad, so the arrow points up with the "down bad" colour. */}
          <div className="stat">
            <span className="k">Overdue</span>
            <span className="v">9</span>
            <span className="d down bad">
              <span aria-hidden="true">▲ </span>
              <span className="sr-only">up </span>3 more than yesterday
            </span>
          </div>
        </div>
        <div className="card pad">
          <Stat label="Oldest open item" value="16 days" note="MK-260914-48213" />
        </div>
        <div className="card pad">
          <Stat label="Ship today, Official Store" value="214" note="UPS pickup 4:00 PM" />
        </div>
      </div>
      <div className="ac-main">
        <div className="stack gap-5">
          <Card
            title="Work queues"
            sub="Lead, backup and escalation route for every queue"
            flush
            actions={
              <SegmentedControl
                items={[
                  { label: 'Mine', value: 'mine' },
                  { label: 'All queues', value: 'all' },
                ]}
                active={scope}
                onChange={setScope}
              />
            }
          >
            <div className="no-phone">
              <TableWrap label="Work queues table">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Queue</th>
                      <th scope="col">Lead</th>
                      <th scope="col">Backup</th>
                      <th scope="col">Escalation route</th>
                      <th className="r" scope="col">
                        Open
                      </th>
                      <th className="r" scope="col">
                        Overdue
                      </th>
                      <th scope="col">Oldest item</th>
                      <th className="col-pin" scope="col">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((q) => (
                      <tr key={q.name} className={cx(q.overdue > 0 && 'is-flagged')}>
                        <td className="cell-name">
                          {q.overdue > 0 && <span className="sr-only">Urgent: </span>}
                          <span className="row gap-2 nowrap">
                            <Link className="small strong ellip" to={q.to} title={q.name}>
                              {q.name}
                            </Link>
                            {q.mine && <Badge tone="brand">Mine</Badge>}
                          </span>
                        </td>
                        <td className="cell-name">
                          <span className="small nowrap ellip" title={q.lead}>
                            {q.lead}
                          </span>
                        </td>
                        <td className="cell-name">
                          <span className="small nowrap ellip" title={q.backup}>
                            {q.backup}
                          </span>
                        </td>
                        <td className="cell-name">
                          <span className="xs sub ellip" title={q.escalation}>
                            {q.escalation}
                          </span>
                        </td>
                        <td className="r">
                          <b>{q.open}</b>
                        </td>
                        <td className="r">
                          {q.overdue > 0 ? (
                            <span className="ac-out">
                              {q.overdue}
                              <span className="sr-only"> overdue</span>
                            </span>
                          ) : (
                            <span className="muted">0</span>
                          )}
                        </td>
                        <td className="cell-id">
                          <span className="xs mono nowrap" title={q.oldest}>
                            {q.oldest}
                          </span>
                        </td>
                        <td className="col-pin">
                          <Link className="btn btn-ghost btn-sm" to={q.to}>
                            <span>Open</span>
                            <span className="sr-only"> {q.oldest}</span>
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
              <OpsLegend items={[{ tone: 'danger', label: 'Red edge = urgent: overdue or past target' }]} />
            </div>
            <div className="ac-mlist only-phone">
              {rows.map((q) => (
                <div key={q.name} className={cx('ac-mi', q.overdue > 0 && 'is-flagged')}>
                  {q.overdue > 0 && <span className="sr-only">Urgent: </span>}
                  <div className="row between gap-2 nowrap top">
                    <span className="small strong min-w-0">
                      <Link to={q.to}>{q.name}</Link>
                    </span>
                    <span className="row gap-1 nowrap">
                      <Badge>{q.open} open</Badge>
                      {q.overdue > 0 && <Badge tone="danger">{q.overdue} overdue</Badge>}
                    </span>
                  </div>
                  <div className="xs sub">
                    Lead {q.lead} · backup {q.backup}
                  </div>
                  <div className="xs sub">Escalates to {q.escalation}</div>
                  <div className="xs sub">
                    Oldest: <span className="mono">{q.oldest}</span>
                  </div>
                </div>
              ))}
            </div>
            <OpsLegend className="only-phone" items={[{ tone: 'danger', label: 'Red edge = urgent: overdue or past target' }]} />
          </Card>
          <section className="card" ref={dayEndRef}>
            <div className="card-head">
              <div className="stack gap-0">
                <h3 className="h4">Day-end review</h3>
                <span className="xs muted">Due 5:30 PM PT · shared with all queue leads</span>
              </div>
              <div className="row gap-2">
                <Button variant="secondary" size="sm" icon={sent ? 'check' : 'send'} onClick={sendSummary} disabled={sent}>
                  {sent ? 'Summary sent' : 'Send summary to managers'}
                </Button>
              </div>
            </div>
            <div className="card-body">
              <ul>
                {DAY_END.map((c) => (
                  <li key={c.title} className="ac-ck">
                    <span className="ic" aria-hidden="true" />
                    <span className="stack gap-0 grow">
                      <span className="small strong">{c.title}</span>
                      <span className="xs muted">{c.note}</span>
                    </span>
                    <Link className="small strong nowrap" to={c.to}>
                      Review
                    </Link>
                    <span className="sr-only">Not done</span>
                  </li>
                ))}
              </ul>
            </div>
          </section>
        </div>
        <div className="stack gap-5">
          <Card title="Today's routine" titleAs="h3" sub={`${routineDone} of ${ROUTINE.length} reviews done`}>
            <Meter pct={Math.round((routineDone / ROUTINE.length) * 100)} label="Today's routine" />
            <ul>
              {ROUTINE.map((r) => (
                <li key={r.title} className={cx('ac-ck', r.state && `is-${r.state}`)}>
                  <span className="ic" aria-hidden="true">
                    {r.state === 'done' && <Icon name="check" />}
                    {r.state === 'late' && <Icon name="alarm-clock" />}
                  </span>
                  <span className="stack gap-0 grow">
                    <span className="small strong">{r.title}</span>
                    <span className="xs muted">{r.note}</span>
                  </span>
                  <span className="sr-only">{r.state === 'done' ? 'Done' : r.state === 'late' ? 'Overdue' : 'Not done'}</span>
                </li>
              ))}
            </ul>
          </Card>
          <Card
            title="Saved filters"
            titleAs="h3"
            sub="Your filters, plus 2 shared by Ana Silva"
            foot={
              <Button variant="ghost" size="sm" icon="plus" onClick={saveFilter}>
                Save current filter
              </Button>
            }
          >
            <ul className="list">
              {saved.map((s) => (
                <li key={s.label}>
                  <Icon name="bookmark" className="ic-sm" />
                  <Link className="small grow" to={s.to}>
                    {s.label}
                  </Link>
                  <Badge>{s.n}</Badge>
                </li>
              ))}
            </ul>
          </Card>
          <Alert tone="info" title="Escalation reminder">
            Seller shipping problems go to Grace Kim, Seller Manager, when performance action is needed. Exports are limited to your areas: orders and shipping.
          </Alert>
        </div>
      </div>
    </OpsLayout>
  );
}
