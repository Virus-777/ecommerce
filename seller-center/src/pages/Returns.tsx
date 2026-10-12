import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { SellerLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { money } from '@marketly/web-shared/lib/format';
import { useView } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import { Badge, Button, Card, Deadline, Icon, KeyValue, PageHeader, SearchInput, Select, StatusBadge, TableWrap, Tabs, announce } from '@marketly/web-shared/ui';
import { RETURN_PERIODS, RETURN_REASONS, RETURN_ROWS, type ReturnRow, type ReturnTab } from './data/returns';

// Design: pages/seller/seller-returns.html · views: received-to-inspect, disputes, closed (the list tabs).

const TABS: Array<{ value: ReturnTab; label: string }> = [
  { value: '', label: 'Return requests' },
  { value: 'received-to-inspect', label: 'Received, to inspect' },
  { value: 'disputes', label: 'Disputes' },
  { value: 'closed', label: 'Closed' },
];

const INTRO: Record<ReturnTab, string> = {
  '': 'Approve, reject with a reason or request information before the respond-by time. If you miss it, Marketly support may decide the return.',
  'received-to-inspect': 'Record the item condition and your refund decision within 2 days of receipt (example target).',
  disputes: 'Marketly support reviews purchase terms, shipment evidence, photos and messages, then records a decision. Each decision has an appeal deadline.',
  closed: 'Returns closed in the last 30 days. Refunds show the amount actually sent to the customer.',
};
const DUE_HEAD: Record<ReturnTab, string> = { '': 'Respond by', 'received-to-inspect': 'Inspect by', disputes: 'Next deadline', closed: 'Outcome' };

const rowLink = (r: ReturnRow) => (r.tab === 'received-to-inspect' ? href('seller/return', 'inspect-and-refund') : href('seller/return'));
const edgeSr = (r: ReturnRow) => (r.edge === 'flagged' ? 'Urgent: ' : r.edge === 'warn' ? 'At risk: ' : '');
const edgeClass = (r: ReturnRow) => (r.edge === 'flagged' ? 'is-flagged' : r.edge === 'warn' ? 'is-warn' : '');

function Due({ r, nowrap }: { r: ReturnRow; nowrap?: boolean }) {
  return r.due.tone ? <Deadline tone={r.due.tone}>{r.due.text}</Deadline> : <span className={cx('xs sub', nowrap && 'nowrap')}>{r.due.text}</span>;
}

function SupportBadge({ tone }: { tone: 'danger' | 'info' }) {
  return (
    <Badge tone={tone} icon="shield">
      Marketly support involved
    </Badge>
  );
}

/** Queue tile with the design's screen-reader urgency note for both tones ((urgent) / (at risk)). */
function Tile({ n, label, sub, tone, to }: { n: number; label: string; sub: ReactNode; tone?: 'danger' | 'warning'; to: string }) {
  return (
    <Link className={cx('queue-tile', tone && `t-${tone}`)} to={to}>
      <span className="qn">
        {n}
        {tone && <span className="sr-only">{tone === 'danger' ? ' (urgent)' : ' (at risk)'}</span>}
      </span>
      <span className="stack gap-0 grow">
        <span className="small strong">{label}</span>
        <span className="xs muted">{sub}</span>
      </span>
      <Icon name="chevron-right" className="ic-sm" />
    </Link>
  );
}

function EdgeLegend({ danger, warning }: { danger: boolean; warning: boolean }) {
  if (!danger && !warning) return null;
  return (
    <p className="status-legend status-legend--edge">
      <span className="sr-only">Legend: </span>
      {danger && (
        <span className="sl sl-danger">
          <i aria-hidden="true" />
          Red edge = urgent: overdue or past target
        </span>
      )}
      {warning && (
        <span className="sl sl-warning">
          <i aria-hidden="true" />
          Amber edge = at risk: due soon or near target
        </span>
      )}
    </p>
  );
}

export default function Returns() {
  const [view, setView] = useView<Exclude<ReturnTab, ''>>();
  const tab = (TABS.some((t) => t.value === view) ? view : '') as ReturnTab;
  const [q, setQ] = useState('');
  const [reason, setReason] = useState(RETURN_REASONS[0]);
  const [period, setPeriod] = useState(RETURN_PERIODS[0]);

  const inTab = RETURN_ROWS.filter((r) => r.tab === tab);
  const needle = q.trim().toLowerCase();
  const rows = inTab.filter((r) => (reason === RETURN_REASONS[0] || r.reason === reason) && (!needle || [r.ref, r.order, r.sku, r.item].some((v) => v.toLowerCase().includes(needle))));
  const count = (t: ReturnTab) => RETURN_ROWS.filter((r) => r.tab === t).length;
  const hasDanger = rows.some((r) => r.edge === 'flagged');
  const hasWarn = rows.some((r) => r.edge === 'warn');
  const closed = tab === 'closed';
  const dueFirst = tab === '';

  const exportCsv = () => announce(`Exported ${rows.length} ${closed ? 'closed returns' : 'cases'} to CSV`);

  return (
    <SellerLayout active="returns">
      <PageHeader
        title="Returns and cases"
        sub="All times Pacific. Customers see your response target on their return page."
        actions={
          <>
            <Button variant="secondary" size="sm" icon="download" onClick={exportCsv}>
              Export
            </Button>
            <Button variant="secondary" size="sm" icon="file-text" to={href('seller/store')}>
              Return policy
            </Button>
          </>
        }
      />
      <div className="sb-kpis">
        <Tile n={1} tone="danger" label="Response overdue" sub="RT-261004-0871 · Marketly may step in" to={href('seller/returns')} />
        <Tile n={2} tone="warning" label="Waiting for your response" sub="Next due Oct 9, 4:00 PM" to={href('seller/returns')} />
        <Tile n={count('received-to-inspect')} label="Received, to inspect" sub="Oldest received Oct 7" to={href('seller/returns', 'received-to-inspect')} />
        <Tile n={1} tone="danger" label="Dispute needs evidence" sub="Due Oct 9, 5:00 PM" to={href('seller/returns', 'disputes')} />
      </div>
      <p className="status-legend status-legend--number">
        <span className="sr-only">Legend: </span>
        <span className="sl sl-danger">
          <i aria-hidden="true" />
          Red number = urgent: overdue or past target
        </span>
        <span className="sl sl-warning">
          <i aria-hidden="true" />
          Amber number = at risk: due soon or near target
        </span>
      </p>
      <div className="sb-main">
        <section className="card">
          <div className="u-p-0-sp-2">
            <Tabs items={TABS.map((t) => ({ ...t, count: count(t.value) }))} active={tab} onChange={(v) => setView(v as Exclude<ReturnTab, ''>)} />
          </div>
          <div className="stack gap-3 u-p-sp-4">
            <div className="toolbar">
              <SearchInput id="rt-q" placeholder="Search return, order or SKU" value={q} onChange={setQ} />
              <label className="sr-only" htmlFor="rt-reason">
                Reason
              </label>
              <Select id="rt-reason" options={RETURN_REASONS} value={reason} onChange={(e) => setReason(e.target.value)} />
              <label className="sr-only" htmlFor="rt-period">
                Period
              </label>
              <Select id="rt-period" options={RETURN_PERIODS} value={period} onChange={(e) => setPeriod(e.target.value)} />
            </div>
            <p className="xs sub">{closed ? INTRO.closed.replace('in the last 30 days', period === 'This year' ? 'this year' : `in the ${period.toLowerCase()}`) : INTRO[tab]}</p>
          </div>
          <div className="no-phone">
            <TableWrap label="Returns and cases table">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Return</th>
                    {dueFirst && <th scope="col">{DUE_HEAD[tab]}</th>}
                    <th scope="col">Item</th>
                    <th scope="col">Reason</th>
                    <th className="r" scope="col">
                      {closed ? 'Refunded' : 'Amount'}
                    </th>
                    <th scope="col">Requested</th>
                    {!dueFirst && <th scope="col">{DUE_HEAD[tab]}</th>}
                    <th className="col-pin" scope="col">
                      Status
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.ref} className={edgeClass(r)}>
                      <td>
                        {r.edge && <span className="sr-only">{edgeSr(r)}</span>}
                        <div className="stack gap-0">
                          <Link className="mono nowrap" to={rowLink(r)} title={r.ref}>
                            {r.ref}
                          </Link>
                          {r.support && (
                            <span className="row gap-1 mt-1">
                              <SupportBadge tone={r.support} />
                            </span>
                          )}
                          <span className="xs muted mono nowrap">{r.order}</span>
                        </div>
                      </td>
                      {dueFirst && (
                        <td>
                          <Due r={r} />
                        </td>
                      )}
                      <td>
                        <div className="stack gap-0 minw-200">
                          <span className="small strong">{r.item}</span>
                          <span className="xs muted mono nowrap" title={r.sku}>
                            {r.sku}
                          </span>
                        </div>
                      </td>
                      <td>
                        <div className="stack gap-0 minw-160">
                          <span className="small">{r.reason}</span>
                          <span className="xs muted">{r.detail}</span>
                        </div>
                      </td>
                      <td className="r">
                        <span className="num">{money(r.amount)}</span>
                      </td>
                      <td>
                        <span className="xs sub nowrap">{r.requested}</span>
                      </td>
                      {!dueFirst && (
                        <td>
                          <Due r={r} />
                        </td>
                      )}
                      <td className="col-pin">
                        <StatusBadge status={r.status} />
                      </td>
                    </tr>
                  ))}
                  {!rows.length && (
                    <tr>
                      <td colSpan={7}>
                        <span className="small sub">No cases match these filters.</span>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </TableWrap>
            <EdgeLegend danger={hasDanger} warning={hasWarn} />
          </div>
          <div className="only-phone bt">
            <div className="sb-mlist">
              {rows.map((r) => (
                <Link key={r.ref} to={rowLink(r)} className={edgeClass(r)}>
                  {r.edge && <span className="sr-only">{edgeSr(r)}</span>}
                  <span className="row between">
                    <span className="mono small strong">{r.ref}</span>
                    <StatusBadge status={r.status} />
                  </span>
                  <span className="small strong">{r.item}</span>
                  <span className="xs sub">
                    {r.reason} · {r.detail}
                  </span>
                  <span className="row between">
                    <span className="num small strong">{money(r.phoneAmount ?? r.amount)}</span>
                    <Due r={r} />
                  </span>
                  {r.support && (
                    <span>
                      <SupportBadge tone={r.support} />
                    </span>
                  )}
                </Link>
              ))}
            </div>
            <EdgeLegend danger={hasDanger} warning={hasWarn} />
          </div>
          <div className="card-foot">
            <span className="xs muted grow">
              {rows.length} of {inTab.length} {closed ? 'closed returns' : 'cases'}
            </span>
          </div>
        </section>
        <div className="stack gap-5">
          <Card
            title="Return address"
            sub="Printed on prepaid labels and shown to customers"
            actions={
              <Link className="small strong" to={href('seller/store')}>
                <Icon name="pencil" className="ic-sm" /> Edit
              </Link>
            }
          >
            <div className="row top gap-3">
              <Icon name="map-pin" />
              <div className="stack gap-0 small">
                <span className="strong">Northwind Audio Returns</span>
                <span>1820 SE Water Ave, Unit 4</span>
                <span>Portland, OR 97214</span>
                <span className="muted">Receiving hours Mon–Fri, 9 AM–5 PM PT</span>
              </div>
            </div>
            <p className="xs muted">A new address applies to new return requests. Returns already on their way keep the address on their label.</p>
          </Card>
          <Card title="Your return terms" titleAs="h3" sub="Within the platform baseline">
            <KeyValue
              pairs={[
                ['Return window', '30 days after delivery'],
                ['Change of mind', 'Customer pays return shipping'],
                ['Defective, damaged, wrong item', 'You pay return shipping'],
                ['Response target', 'Within 2 business days (example)'],
                ['Refund target', 'Within 2 days of receipt (example)'],
              ]}
            />
            <p className="xs muted">Customers see these terms before they buy. Orders keep the terms accepted at purchase.</p>
          </Card>
        </div>
      </div>
    </SellerLayout>
  );
}
