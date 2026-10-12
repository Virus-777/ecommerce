import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { STAFF } from '@marketly/web-shared/data/staff';
import { sellers } from '@marketly/web-shared/data/fixtures';
import { AdminLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { money } from '@marketly/web-shared/lib/format';
import { useView } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import { Alert, Badge, Button, Deadline, Drawer, EmptyState, Field, Img, KeyValue, PageHeader, Pager, SearchInput, Select, StatusBadge, SummaryRow, TableWrap, Tabs, Textarea, Timeline, announce, type TimelineEvent } from '@marketly/web-shared/ui';
import {
  DUE_BY_FILTER, EXCEPTION_REASONS, inTab, KPIS, NO_RETURN_FILTERS, RETURN_FILTERS, RETURN_TABS, RETURNS, STAFF_TITLE,
  type ReturnEdge, type ReturnFilters, type ReturnFlag, type ReturnRow, type ReturnTab,
} from './data/returns';

// Design: pages/admin/admin-returns.html · view "exception-review" = the refund-without-return
// drawer for RT-261006-0193 (?rt=<ref> picks another return).

type View = 'exception-review';

const DEFAULT_RT = 'RT-261006-0193';
const SENT_REFUNDS = ['Requested', 'Approved', 'Processing', 'Sent'];

function matches(r: ReturnRow, f: ReturnFilters, q: string) {
  const sellerName = sellers[r.seller].name;
  if (f.type === 'Official Store' && r.seller !== 'official') return false;
  if (f.type === 'Marketplace sellers' && r.seller === 'official') return false;
  if (f.seller !== NO_RETURN_FILTERS.seller && sellerName !== f.seller) return false;
  if (f.reason !== NO_RETURN_FILTERS.reason && r.reason !== f.reason) return false;
  if (f.owner !== NO_RETURN_FILTERS.owner && (f.owner === 'Seller' ? r.owner !== sellerName : r.owner !== f.owner)) return false;
  if (f.refund !== NO_RETURN_FILTERS.refund && r.refund !== f.refund) return false;
  if (f.deadline !== NO_RETURN_FILTERS.deadline && r.due !== DUE_BY_FILTER[f.deadline]) return false;
  const s = q.trim().toLowerCase();
  if (s && ![r.ref, r.order, r.customer].some((v) => v.toLowerCase().includes(s))) return false;
  return true;
}

const edgeClass = (e: ReturnEdge) => (e === 'flagged' ? 'is-flagged' : e === 'warn' ? 'is-warn' : '');
const EdgeSr = ({ edge }: { edge: ReturnEdge }) => (edge ? <span className="sr-only">{edge === 'flagged' ? 'Urgent: ' : 'At risk: '}</span> : null);
const Refund = ({ status }: { status: string }) => (status === 'Not started' ? <span className="xs muted">Not started</span> : <StatusBadge status={status} />);
const FlagBadge = ({ flag }: { flag: ReturnFlag }) => (
  <span className="aa-flags">
    <Badge tone={flag.tone} icon={flag.icon}>
      {flag.label}
    </Badge>
  </span>
);

function EdgeLegend({ edges }: { edges: ReturnEdge[] }) {
  if (!edges.some(Boolean)) return null;
  return (
    <p className="status-legend status-legend--edge">
      <span className="sr-only">Legend: </span>
      {edges.includes('flagged') && (
        <span className="sl sl-danger">
          <i aria-hidden="true" />
          Red edge = urgent: overdue or past target
        </span>
      )}
      {edges.includes('warn') && (
        <span className="sl sl-warning">
          <i aria-hidden="true" />
          Amber edge = at risk: due soon or near target
        </span>
      )}
    </p>
  );
}

export default function Returns() {
  const [view] = useView<View>();
  const [params, setParams] = useSearchParams();
  const [rows, setRows] = useState(RETURNS);
  const [tab, setTab] = useState<ReturnTab>('all');
  const [filters, setFilters] = useState<ReturnFilters>(NO_RETURN_FILTERS);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [notice, setNotice] = useState('');

  const rtRef = params.get('rt') ?? DEFAULT_RT;
  const current = view === 'exception-review' ? rows.find((r) => r.ref === rtRef) : undefined;

  // Drawer form, reset when another return is opened.
  const [formFor, setFormFor] = useState('');
  const [excReason, setExcReason] = useState(EXCEPTION_REASONS[0]);
  const [details, setDetails] = useState('');
  const [attempted, setAttempted] = useState(false);
  if (current && formFor !== current.ref) {
    setFormFor(current.ref);
    setExcReason(EXCEPTION_REASONS[0]);
    setDetails(current.details ?? '');
    setAttempted(false);
  }

  const visible = rows.filter((r) => inTab(r, tab) && matches(r, filters, query));
  const drawerLink = (ref: string) => href('admin/returns', 'exception-review', undefined, { rt: ref });
  const close = () =>
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        p.delete('view');
        p.delete('rt');
        return p;
      },
      { preventScrollReset: true },
    );
  const update = (ref: string, patch: Partial<ReturnRow>) => setRows((rs) => rs.map((r) => (r.ref === ref ? { ...r, ...patch } : r)));
  const say = (msg: string) => {
    setNotice(msg);
    announce(msg);
  };

  const detailsError = attempted && !details.trim() ? 'Enter the details for the record. Finance reads them before approving.' : '';
  const canSend = !!current && !SENT_REFUNDS.includes(current.refund);

  const sendToFinance = () => {
    if (!current) return;
    setAttempted(true);
    if (!details.trim()) return;
    update(current.ref, {
      refund: 'Requested',
      edge: '',
      deadline: { tone: 'warning', text: 'Finance by Oct 9' },
      due: 'soon',
      details: details.trim(),
      flag: { label: 'Refund without return sent to Finance', tone: 'info', icon: 'file-check', note: `Sent by ${STAFF.admin.name}: ${excReason.toLowerCase()}.` },
    });
    say(`${current.ref} sent to Finance. Priya Nair approves refunds up to $2,000.00; the customer sees "Refund requested" until the money is sent.`);
    close();
  };
  const requestPhotos = () => {
    if (!current) return;
    update(current.ref, { deadline: { tone: 'warning', text: 'Customer photos by Oct 11' }, due: '' });
    say(`Asked ${current.customer} for more photos on ${current.ref}. The decision deadline moves to Oct 11.`);
    close();
  };

  const timeline: TimelineEvent[] = current
    ? current.refund === 'Requested' && current.flag?.label.endsWith('sent to Finance')
      ? [
          { t: 'Remedy proposed', d: `Just now · ${STAFF.admin.name}`, state: 'done' },
          { t: 'Finance approval', d: 'Waiting · Priya Nair · target Oct 9', state: 'current' },
          { t: 'Refund sent to card', d: 'After approval · 3–5 business days to arrive', state: '' },
        ]
      : [
          current.proposed ? { t: 'Remedy proposed', d: `${current.proposed} · ${current.owner}`, state: 'done' } : { t: 'Remedy proposed', d: `Now · ${STAFF.admin.name}`, state: 'current' },
          { t: 'Finance approval', d: current.proposed ? 'Waiting · Priya Nair · target Oct 9' : 'After you send it · Priya Nair', state: current.proposed ? 'current' : '' },
          { t: 'Refund sent to card', d: 'After approval · 3–5 business days to arrive', state: '' },
        ]
    : [];

  return (
    <AdminLayout active="returns">
      <PageHeader
        crumbs={[{ label: 'Commerce' }, { label: 'Returns and refunds' }]}
        title="Returns and refunds"
        sub="Queue owner: Lena Park, Returns Manager · backup Theo Grant · escalation Isabel Cruz (Customer Support)"
        actions={
          <>
            <Button variant="secondary" size="sm" icon="download" onClick={() => announce('Export started. It is logged in Action history.')}>
              Export CSV
            </Button>
            <Button variant="secondary" size="sm" icon="settings" to={href('admin/settings')}>
              Return policy settings
            </Button>
          </>
        }
      />
      <div className="aa-kpis c5">
        {KPIS.map((k) => (
          <div key={k.k} className="card pad">
            <div className="stat">
              <span className="k">{k.k}</span>
              <span className="v">{k.danger ? <span className="t-danger-text">{k.v}</span> : k.v}</span>
              <span className="d">{k.d}</span>
            </div>
          </div>
        ))}
      </div>
      {notice && <Alert tone="success" title={notice} />}
      <section className="card">
        <Tabs items={RETURN_TABS} active={tab} onChange={(t) => (setTab(t), setPage(1))} label="Return queues" />
        <div className="card-body">
          <div className="toolbar">
            <SearchInput id="aa-rt-q" placeholder="Search RT ref, order ref or customer" value={query} onChange={(v) => (setQuery(v), setPage(1))} />
          </div>
          <div className="aa-filters">
            {RETURN_FILTERS.map((f) => (
              <Field key={f.key} label={f.label} className="aa-flt">
                <Select id={f.id} options={f.options} value={filters[f.key]} onChange={(e) => (setFilters({ ...filters, [f.key]: e.target.value }), setPage(1))} />
              </Field>
            ))}
          </div>
        </div>
        {visible.length === 0 ? (
          <div className="card-body">
            <EmptyState
              icon="search-x"
              title="No returns match"
              action={
                <Button variant="secondary" size="sm" onClick={() => (setFilters(NO_RETURN_FILTERS), setQuery(''), setTab('all'))}>
                  Clear filters
                </Button>
              }
            >
              Try another queue or remove a filter.
            </EmptyState>
          </div>
        ) : (
          <>
            <div className="no-phone">
              <TableWrap label="Returns and refunds table">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Return</th>
                      <th scope="col">Order</th>
                      <th scope="col">Seller</th>
                      <th scope="col">Reason</th>
                      <th className="r" scope="col">Amount</th>
                      <th scope="col">Owner</th>
                      <th scope="col">Deadline</th>
                      <th scope="col">Return</th>
                      <th scope="col">Refund</th>
                      <th className="col-pin" scope="col">Flags</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((r) => (
                      <tr key={r.ref} className={edgeClass(r.edge)}>
                        <td>
                          <EdgeSr edge={r.edge} />
                          <Link className="mono strong nowrap" to={drawerLink(r.ref)} title={r.ref} preventScrollReset>
                            {r.ref}
                          </Link>
                        </td>
                        <td>
                          <Link className="mono strong nowrap" to={href('admin/order', '', { ref: r.order })} title={r.order}>
                            {r.order}
                          </Link>
                        </td>
                        <td>
                          <span className="stack gap-0">
                            <span className="small strong nowrap">{sellers[r.seller].name}</span>
                            <span className="xs muted nowrap">{r.item}</span>
                          </span>
                        </td>
                        <td>
                          <span className="small">{r.reason}</span>
                        </td>
                        <td className="r">
                          <span className="strong">{money(r.amount)}</span>
                        </td>
                        <td>
                          <span className="small nowrap">{r.owner}</span>
                        </td>
                        <td>
                          <Deadline tone={r.deadline.tone}>{r.deadline.text}</Deadline>
                        </td>
                        <td>
                          <StatusBadge status={r.status} />
                        </td>
                        <td>
                          <Refund status={r.refund} />
                        </td>
                        <td className="col-pin">
                          {r.flag ? (
                            <span className="stack gap-1">
                              <FlagBadge flag={r.flag} />
                              {r.flag.note && <span className="xs sub measure-sm">{r.flag.note}</span>}
                            </span>
                          ) : (
                            <span className="xs muted">None</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
              <EdgeLegend edges={visible.map((r) => r.edge)} />
            </div>
            <div className="only-phone card-pad-phone">
              <div className="aa-mlist">
                {visible.map((r) => (
                  <Link key={r.ref} className={cx('aa-mcard', edgeClass(r.edge))} to={drawerLink(r.ref)} preventScrollReset>
                    <EdgeSr edge={r.edge} />
                    <span className="row between">
                      <span className="mono strong">{r.ref}</span>
                      <span className="strong num">{money(r.amount)}</span>
                    </span>
                    <span className="xs muted">
                      {r.item} · {sellers[r.seller].name} · {r.reason}
                    </span>
                    <span className="row gap-2">
                      <span className="xs muted">Return</span>
                      <StatusBadge status={r.status} />
                      <span className="xs muted">Refund</span>
                      <Refund status={r.refund} />
                    </span>
                    <span className="row between">
                      <Deadline tone={r.deadline.tone}>{r.deadline.text}</Deadline>
                      <span className="xs muted">{r.owner}</span>
                    </span>
                    {r.flag && <FlagBadge flag={r.flag} />}
                    {r.flag?.note && <span className="xs sub">{r.flag.note}</span>}
                  </Link>
                ))}
              </div>
              <EdgeLegend edges={visible.map((r) => r.edge)} />
            </div>
          </>
        )}
        <div className="card-foot between">
          <span className="xs muted">Refund "Approved" means approved for sending, not that money has reached the customer.</span>
          <Pager page={page} total={2} onPage={setPage} />
        </div>
      </section>

      <Drawer
        open={!!current}
        onClose={close}
        title={current ? `${current.ref} · refund without return` : ''}
        foot={
          canSend ? (
            <>
              <Button variant="ghost" onClick={requestPhotos}>
                Request more photos
              </Button>
              <Button icon="send" onClick={sendToFinance}>
                Send to Finance
              </Button>
            </>
          ) : (
            <Button variant="ghost" onClick={close}>
              Close
            </Button>
          )
        }
      >
        {current && (
          <>
            <div className="row gap-3">
              <Img icon={current.icon} tint={current.tint} className="thumb" />
              <div className="stack gap-0">
                <span className="strong">{current.itemFull}</span>
                <span className="xs muted">
                  {current.variant} · Qty 1 · Sold by {sellers[current.seller].name} ·{' '}
                  <Link className="mono strong nowrap" to={href('admin/order', '', { ref: current.order })}>
                    {current.order}
                  </Link>
                </span>
              </div>
            </div>
            <KeyValue
              pairs={[
                ['Customer', current.customer],
                ['Reason', current.reason],
                ...(current.delivered ? [['Delivered', current.delivered] as [string, string]] : []),
                ...(current.window ? [['Return window', current.window] as [string, string]] : []),
                [
                  'Paid for item',
                  <>
                    {money(current.amount)}
                    {current.couponShare ? (
                      <>
                        {' '}
                        <span className="xs muted">after {money(current.couponShare)} coupon share</span>
                      </>
                    ) : null}
                  </>,
                ],
                ['Owner', STAFF_TITLE[current.owner] ?? current.owner],
              ]}
            />
            {current.photos ? (
              <div className="stack gap-2">
                <span className="label">Customer evidence</span>
                <div className="grid c2 gap-2" style={{ gridTemplateColumns: 'repeat(3,minmax(0,1fr))' }}>
                  {Array.from({ length: current.photos }, (_, i) => (
                    <Img key={i} icon="image" tint={current.tint} className="r43" />
                  ))}
                </div>
                {current.quote && <p className="small sub">"{current.quote}"</p>}
              </div>
            ) : null}
            <Alert tone="warning" title="Exception to the standard return journey">
              Refund without return is a controlled exception. The reason is recorded and Finance approves the money. The item is written off in stock, not restocked.
            </Alert>
            {!canSend && (
              <Alert tone="info" title={`Refund ${current.refund.toLowerCase()}`}>
                This refund is already with Finance or sent, so a second request is blocked.
              </Alert>
            )}
            <Field label="Recorded reason">
              <Select id="aa-rt-exc" options={EXCEPTION_REASONS} value={excReason} disabled={!canSend} onChange={(e) => setExcReason(e.target.value)} />
            </Field>
            <Field label="Details" hint={detailsError ? undefined : 'Required. Visible to Finance and in Action history.'} error={detailsError}>
              <Textarea id="aa-rt-exc-d" placeholder="" value={details} disabled={!canSend} onChange={(e) => setDetails(e.target.value)} />
            </Field>
            <div className="well stack gap-2">
              <SummaryRow k="Refund amount" v={money(current.amount)} />
              <SummaryRow k="Refund to" v={current.customer === 'Jordan Lee' ? 'Visa •••• 4417' : 'Original payment'} />
              <SummaryRow k="Stock outcome" v="Written off · recorded by Ana Silva" />
              <SummaryRow k="Approval" v="Finance · Priya Nair (limit $2,000)" />
            </div>
            <Timeline events={timeline} />
          </>
        )}
      </Drawer>
    </AdminLayout>
  );
}
