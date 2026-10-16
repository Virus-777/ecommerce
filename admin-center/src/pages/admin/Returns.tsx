import { useRef, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { ApiError, call, errorMessage, newIdempotencyKey, useApi } from '@marketly/web-shared/api';
import { AdminLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { formatMoney } from '@marketly/web-shared/lib/format';
import { useView } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import { Alert, Badge, Button, Deadline, Drawer, EmptyState, Field, Img, KeyValue, PageHeader, Pager, SearchInput, Select, StatusBadge, SummaryRow, TableWrap, Tabs, Textarea, Timeline, announce, type TimelineEvent } from '@marketly/web-shared/ui';
import { useStaffSession } from '@/app/session';
import { LoadError, SkeletonLines, date, dateTime, deadlineTone } from '@/app/parts';
import {
  API_TAB, EXCEPTION_REASONS, NO_RETURN_FILTERS, REASONS, REFUND_LABEL, SENT_REFUNDS, STATIC_OPTIONS, TAB_COUNT_KEY, TAB_LABELS, flagStyle, rowEdge,
  type ReturnCase, type ReturnEdge, type ReturnFilters, type ReturnRow, type ReturnTab, type RowFlag,
} from './data/returns';

// Design: pages/admin/admin-returns.html · view "exception-review" = the refund-without-return drawer
// (?rt=<ref> picks the return; without it the drawer opens on the first exception in the queue).
// Data: GET returns/requests (tab, filters, page), GET returns/requests/stats (KPIs, tab counts, queue owner),
// GET returns/requests/{ref} (drawer; the RT- ref is accepted as the id), POST …/approve-without-return
// (sends the refund to Finance; the response says whether it waits for approval), POST …/request-info,
// POST reports/exports (dataset returns.admin.requests).

type View = 'exception-review';

const LIMIT = 25;

const edgeClass = (e: ReturnEdge) => (e === 'flagged' ? 'is-flagged' : e === 'warn' ? 'is-warn' : '');
const EdgeSr = ({ edge }: { edge: ReturnEdge }) => (edge ? <span className="sr-only">{edge === 'flagged' ? 'Urgent: ' : 'At risk: '}</span> : null);
const Refund = ({ status }: { status?: string | null }) => (!status ? <span className="xs muted">Not started</span> : <StatusBadge status={REFUND_LABEL[status] ?? status} />);
const FlagBadge = ({ flag }: { flag: RowFlag }) => {
  const st = flagStyle(flag);
  return (
    <span className="aa-flags">
      <Badge tone={st.tone} icon={st.icon}>
        {flag.label}
      </Badge>
    </span>
  );
};
const ownerName = (r: ReturnRow) => (r.owner as { name?: string | null } | null | undefined)?.name ?? (r.seller.ownerType === 'seller' ? r.seller.name : 'Unassigned');
const itemName = (r: ReturnRow) => r.item.title;

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
  const { api } = useApi();
  const qc = useQueryClient();
  const { accountId, can } = useStaffSession();
  const [view] = useView<View>();
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState<ReturnTab>('all');
  const [filters, setFilters] = useState<ReturnFilters>(NO_RETURN_FILTERS);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  const listQuery = {
    tab: API_TAB[tab],
    q: query.trim() || undefined,
    sellerType: filters.type || undefined,
    sellerId: filters.seller || undefined,
    reason: filters.reason || undefined,
    ownerId: filters.owner || undefined,
    refundStatus: filters.refund || undefined,
    deadline: filters.deadline || undefined,
  };
  const list = useQuery({
    queryKey: ['returns', 'admin-queue', listQuery, page],
    queryFn: () => call(api.GET('/api/admin/returns/requests', { params: { query: { ...listQuery, page, limit: LIMIT } } })),
    placeholderData: keepPreviousData,
  });
  const stats = useQuery({ queryKey: ['returns', 'admin-stats'], queryFn: () => call(api.GET('/api/admin/returns/requests/stats')) });
  const sellersQ = useQuery({
    queryKey: ['sellers', 'admin-list', 'filter'],
    queryFn: () => call(api.GET('/api/admin/sellers/sellers', { params: { query: { limit: 100, status: 'approved' } } })),
    enabled: can('sellers.accounts.view'),
    staleTime: 5 * 60_000,
  });

  // ----- Drawer: resolve the return the URL names -----
  const open = view === 'exception-review';
  const rtParam = params.get('rt');
  const firstException = useQuery({
    queryKey: ['returns', 'admin-queue', { tab: 'exceptions', first: true }],
    queryFn: () => call(api.GET('/api/admin/returns/requests', { params: { query: { tab: 'exceptions', page: 1, limit: 1 } } })),
    enabled: open && !rtParam,
  });
  const rtRef = rtParam ?? firstException.data?.items[0]?.ref ?? null;
  // The detail route takes the RT- ref as the id.
  const detail = useQuery({
    queryKey: ['returns', 'admin-case', rtRef],
    queryFn: () => call(api.GET('/api/admin/returns/requests/{id}', { params: { path: { id: rtRef! } } })) as Promise<ReturnCase>,
    enabled: open && !!rtRef,
    retry: (n, e) => !(e instanceof ApiError && e.status === 404) && n < 2,
  });
  const current = open ? detail.data : undefined;
  const notFound = detail.error instanceof ApiError && detail.error.status === 404;

  // Drawer form, reset when another return is opened.
  const [formFor, setFormFor] = useState('');
  const [excReason, setExcReason] = useState<(typeof EXCEPTION_REASONS)[number]['value']>(EXCEPTION_REASONS[0].value);
  const [details, setDetails] = useState('');
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [drawerError, setDrawerError] = useState('');
  const idem = useRef<string>('');
  if (current && formFor !== current.detail.ref) {
    setFormFor(current.detail.ref);
    setExcReason((current.exception?.reasonCode as typeof excReason) ?? EXCEPTION_REASONS[0].value);
    setDetails(current.exception?.details ?? '');
    setQuestion('');
    setAsking(false);
    setAttempted(false);
    setDrawerError('');
    idem.current = newIdempotencyKey();
  }

  const rows: ReturnRow[] = list.data?.items ?? [];
  const totalPages = list.data?.totalPages ?? 1;
  const s = stats.data;
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
  const say = (msg: string) => {
    setNotice(msg);
    setError('');
    announce(msg);
  };
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['returns'] });
    void qc.invalidateQueries({ queryKey: ['workqueues', 'queues'] });
    void qc.invalidateQueries({ queryKey: ['notifications', 'summary', 'staff'] });
  };
  const changeFilter = (k: keyof ReturnFilters, v: string) => {
    setFilters({ ...filters, [k]: v });
    setPage(1);
  };

  const refundStatus = current?.refundRequest?.status ?? null;
  const mayPropose = can('returns.exceptions.propose');
  const canSend = !!current && mayPropose && !current.exception && !(refundStatus && SENT_REFUNDS.has(refundStatus));
  const canAsk = !!current && can('returns.requests.manage') && (current.allowedActions ?? current.detail.allowedActions ?? []).includes('request-info');
  const detailsError = attempted && !details.trim() ? 'Enter the details for the record. Finance reads them before approving.' : '';

  const sendToFinance = useMutation({
    mutationFn: () =>
      call(
        api.POST('/api/admin/returns/requests/{id}/approve-without-return', {
          params: { path: { id: current!.detail.id }, header: { 'Idempotency-Key': idem.current } },
          body: { reasonCode: excReason, details: details.trim(), remedy: { kind: 'full_refund' } },
        }),
      ) as Promise<ReturnCase>,
    onSuccess: (res) => {
      const rr = res?.refundRequest;
      const waiting = !rr || rr.status === 'requested' || rr.status === 'under_review';
      const approvers = Array.isArray(rr?.approval?.approvers) ? rr.approval.approvers.join(' or ') : rr?.approval?.approvers;
      say(
        waiting
          ? `${current!.detail.ref} sent to Finance for approval.${rr?.approval?.reason ? ` ${rr.approval.reason}.` : ''}${approvers ? ` Approver: ${approvers}.` : ''} The customer sees "Refund requested" until the money is sent.`
          : `${current!.detail.ref}: refund without return approved and handed to payments.`,
      );
      refresh();
      close();
    },
    onError: (e) => setDrawerError(errorMessage(e)),
  });
  const requestInfo = useMutation({
    mutationFn: () => call(api.POST('/api/admin/returns/requests/{id}/request-info', { params: { path: { id: current!.detail.id } }, body: { question: question.trim() } })),
    onSuccess: () => {
      say(`Asked ${current?.customer?.displayName ?? 'the customer'} for more information on ${current?.detail.ref}.`);
      refresh();
      close();
    },
    onError: (e) => setDrawerError(errorMessage(e)),
  });
  const exportCsv = useMutation({
    mutationFn: () => call(api.POST('/api/admin/reports/exports', { body: { dataset: 'returns.admin.requests', filters: listQuery, format: 'csv' } })),
    onSuccess: () => announce('Export started. It is logged in Action history.'),
    onError: (e) => setError(errorMessage(e)),
  });

  const onSend = () => {
    setAttempted(true);
    if (!details.trim()) return;
    setDrawerError('');
    sendToFinance.mutate();
  };
  const onAsk = () => {
    if (!asking) {
      setAsking(true);
      return;
    }
    if (question.trim().length < 5) {
      setDrawerError('Write what you need from the customer.');
      return;
    }
    setDrawerError('');
    requestInfo.mutate();
  };

  const rr = current?.refundRequest;
  const exc = current?.exception;
  const timeline: TimelineEvent[] = current
    ? [
        exc
          ? { t: 'Remedy proposed', d: `${exc.proposedAt ? dateTime(exc.proposedAt) : ''}${exc.proposedBy?.name ? ` · ${exc.proposedBy.name}` : ''}`, state: 'done' }
          : { t: 'Remedy proposed', d: 'Now · you', state: 'current' },
        {
          t: 'Finance approval',
          d: rr ? `${REFUND_LABEL[rr.status] ?? rr.status}${exc?.approvedBy?.name ? ` · ${exc.approvedBy.name}` : ''}` : 'After you send it',
          state: rr && (rr.status === 'requested' || rr.status === 'under_review') ? 'current' : rr && SENT_REFUNDS.has(rr.status) ? 'done' : rr?.status === 'declined' ? 'warn' : '',
        },
        { t: `Refund sent to ${current.payment?.methodLabel ?? 'the original payment'}`, d: rr?.status === 'sent' ? 'Sent · 3–5 business days to arrive' : 'After approval · 3–5 business days to arrive', state: rr?.status === 'sent' ? 'done' : '' },
      ]
    : [];
  const photos = [...(current?.detail.media ?? []), ...(current?.evidence ?? [])].filter((m) => m.url);
  const it = current?.detail.items[0];
  const kpis = s
    ? [
        { k: 'Open returns', v: String(s.open), d: `${s.openOfficial} company · ${s.openSellers} sellers` },
        { k: 'Past deadline', v: String(s.pastDeadline), d: `${s.sellerRepliesOverdue} seller repl${s.sellerRepliesOverdue === 1 ? 'y' : 'ies'} overdue`, danger: s.pastDeadline > 0 },
        { k: 'Awaiting inspection', v: String(s.awaitingInspection), d: 'Official Store and Fulfilled by Marketly' },
        { k: 'Refunds pending', v: formatMoney(s.refundsPending), d: `${s.refundsPendingCount} refund${s.refundsPendingCount === 1 ? '' : 's'} · not yet sent` },
        { k: 'Exceptions', v: String(s.exceptions), d: 'Refund without return' },
      ]
    : [];
  const qo = s?.queueOwner;
  const sellerOpts = [{ value: '', label: 'Any seller' }, ...(sellersQ.data?.items ?? []).map((x) => ({ value: x.id, label: x.storeName }))];
  const filterDefs: Array<{ key: keyof ReturnFilters; id: string; label: string; options: Array<{ value: string; label: string }> }> = [
    { key: 'type', id: 'aa-rt-type', label: 'Seller type', options: STATIC_OPTIONS.type },
    ...(sellersQ.data ? [{ key: 'seller' as const, id: 'aa-rt-seller', label: 'Seller', options: sellerOpts }] : []),
    { key: 'reason', id: 'aa-rt-reason', label: 'Reason', options: [{ value: '', label: 'Any reason' }, ...REASONS] },
    { key: 'owner', id: 'aa-rt-owner', label: 'Owner', options: [{ value: '', label: 'Any owner' }, { value: accountId, label: 'Me' }] },
    { key: 'refund', id: 'aa-rt-refund', label: 'Refund status', options: STATIC_OPTIONS.refund },
    { key: 'deadline', id: 'aa-rt-dl', label: 'Deadline', options: STATIC_OPTIONS.deadline },
  ];
  const tabs = TAB_LABELS.map((t) => {
    const key = TAB_COUNT_KEY[t.value];
    const n = key && s ? (s.tabCounts as Record<string, number>)[key] : undefined;
    return { ...t, count: n };
  });

  return (
    <AdminLayout active="returns">
      <PageHeader
        crumbs={[{ label: 'Commerce' }, { label: 'Returns and refunds' }]}
        title="Returns and refunds"
        sub={qo ? `Queue owner: ${qo.lead ?? 'not set'} · backup ${qo.backup ?? 'not set'} · escalation ${qo.escalation ?? 'not set'}` : 'Returns and refunds across the Official Store and marketplace sellers'}
        actions={
          <>
            {can('reports.exports.create') && (
              <Button variant="secondary" size="sm" icon="download" disabled={exportCsv.isPending} onClick={() => exportCsv.mutate()}>
                Export CSV
              </Button>
            )}
            <Button variant="secondary" size="sm" icon="settings" to={href('admin/settings')}>
              Return policy settings
            </Button>
          </>
        }
      />
      <div className="aa-kpis c5">
        {s
          ? kpis.map((k) => (
              <div key={k.k} className="card pad">
                <div className="stat">
                  <span className="k">{k.k}</span>
                  <span className="v">{k.danger ? <span className="t-danger-text">{k.v}</span> : k.v}</span>
                  <span className="d">{k.d}</span>
                </div>
              </div>
            ))
          : Array.from({ length: 5 }, (_, i) => (
              <div key={i} className="card pad" aria-hidden="true">
                <span className="sk sk-line short" />
                <span className="sk sk-line" />
              </div>
            ))}
      </div>
      {stats.isError && <LoadError error={stats.error} onRetry={() => void stats.refetch()} title="We couldn’t load the queue figures" />}
      {notice && <Alert tone="success" title={notice} />}
      {error && (
        <Alert tone="danger" title="That didn’t work">
          {error}
        </Alert>
      )}
      <section className="card">
        <Tabs items={tabs} active={tab} onChange={(t) => (setTab(t), setPage(1))} label="Return queues" />
        <div className="card-body">
          <div className="toolbar">
            <SearchInput id="aa-rt-q" placeholder="Search RT ref, order ref or customer" value={query} onChange={(v) => (setQuery(v), setPage(1))} />
          </div>
          <div className="aa-filters">
            {filterDefs.map((f) => (
              <Field key={f.key} label={f.label} className="aa-flt">
                <Select id={f.id} options={f.options} value={filters[f.key]} onChange={(e) => changeFilter(f.key, e.target.value)} />
              </Field>
            ))}
          </div>
        </div>
        {list.isError ? (
          <div className="card-body">
            <LoadError error={list.error} onRetry={() => void list.refetch()} />
          </div>
        ) : list.isPending ? (
          <SkeletonLines rows={6} />
        ) : rows.length === 0 ? (
          <div className="card-body">
            <EmptyState
              icon="search-x"
              title="No returns match"
              action={
                <Button variant="secondary" size="sm" onClick={() => (setFilters(NO_RETURN_FILTERS), setQuery(''), setTab('all'), setPage(1))}>
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
                    {rows.map((r) => {
                      const edge = rowEdge(r);
                      const flags = (r.flags ?? []) as RowFlag[];
                      return (
                        <tr key={r.ref} className={edgeClass(edge)}>
                          <td>
                            <EdgeSr edge={edge} />
                            <Link className="mono strong nowrap" to={drawerLink(r.ref)} title={r.ref} preventScrollReset>
                              {r.ref}
                            </Link>
                          </td>
                          <td>
                            <Link className="mono strong nowrap" to={href('admin/order', '', { ref: r.orderRef })} title={r.orderRef}>
                              {r.orderRef}
                            </Link>
                          </td>
                          <td>
                            <span className="stack gap-0">
                              <span className="small strong nowrap">{r.seller.name}</span>
                              <span className="xs muted nowrap">{itemName(r)}</span>
                            </span>
                          </td>
                          <td>
                            <span className="small">{r.reason}</span>
                          </td>
                          <td className="r">
                            <span className="strong">{formatMoney(r.amount)}</span>
                          </td>
                          <td>
                            <span className="small nowrap">{ownerName(r)}</span>
                          </td>
                          <td>{r.deadline ? <Deadline tone={deadlineTone(r.deadline.state)}>{r.deadlineLabel}</Deadline> : <span className="xs muted">{r.deadlineLabel}</span>}</td>
                          <td>
                            <StatusBadge status={r.status} />
                          </td>
                          <td>
                            <Refund status={r.refundStatus} />
                          </td>
                          <td className="col-pin">
                            {flags.length ? (
                              <span className="stack gap-1">
                                {flags.map((f, i) => (
                                  <FlagBadge key={i} flag={f} />
                                ))}
                                {r.exceptionNote && <span className="xs sub measure-sm">{r.exceptionNote}</span>}
                              </span>
                            ) : (
                              <span className="xs muted">None</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </TableWrap>
              <EdgeLegend edges={rows.map(rowEdge)} />
            </div>
            <div className="only-phone card-pad-phone">
              <div className="aa-mlist">
                {rows.map((r) => {
                  const edge = rowEdge(r);
                  const flags = (r.flags ?? []) as RowFlag[];
                  return (
                    <Link key={r.ref} className={cx('aa-mcard', edgeClass(edge))} to={drawerLink(r.ref)} preventScrollReset>
                      <EdgeSr edge={edge} />
                      <span className="row between">
                        <span className="mono strong">{r.ref}</span>
                        <span className="strong num">{formatMoney(r.amount)}</span>
                      </span>
                      <span className="xs muted">
                        {itemName(r)} · {r.seller.name} · {r.reason}
                      </span>
                      <span className="row gap-2">
                        <span className="xs muted">Return</span>
                        <StatusBadge status={r.status} />
                        <span className="xs muted">Refund</span>
                        <Refund status={r.refundStatus} />
                      </span>
                      <span className="row between">
                        {r.deadline ? <Deadline tone={deadlineTone(r.deadline.state)}>{r.deadlineLabel}</Deadline> : <span className="xs muted">{r.deadlineLabel}</span>}
                        <span className="xs muted">{ownerName(r)}</span>
                      </span>
                      {flags[0] && <FlagBadge flag={flags[0]} />}
                      {r.exceptionNote && <span className="xs sub">{r.exceptionNote}</span>}
                    </Link>
                  );
                })}
              </div>
              <EdgeLegend edges={rows.map(rowEdge)} />
            </div>
          </>
        )}
        <div className="card-foot between">
          <span className="xs muted">Refund "Approved" means approved for sending, not that money has reached the customer.</span>
          {totalPages > 1 && <Pager page={page} total={totalPages} onPage={setPage} />}
        </div>
      </section>

      <Drawer
        open={open}
        onClose={close}
        title={current ? `${current.detail.ref} · refund without return` : (rtRef ?? 'Return')}
        foot={
          canSend || canAsk ? (
            <>
              {canAsk && (
                <Button variant="ghost" onClick={onAsk} disabled={requestInfo.isPending}>
                  {asking ? 'Send question' : 'Request more photos'}
                </Button>
              )}
              {canSend && (
                <Button icon="send" onClick={onSend} disabled={sendToFinance.isPending}>
                  Send to Finance
                </Button>
              )}
            </>
          ) : (
            <Button variant="ghost" onClick={close}>
              Close
            </Button>
          )
        }
      >
        {!current ? (
          detail.isError && !notFound ? (
            <LoadError error={detail.error} onRetry={() => void detail.refetch()} />
          ) : notFound || (firstException.isSuccess && !firstException.data.items.length && !rtParam) ? (
            <EmptyState icon="search-x" title="Return not found">
              {rtRef ? `No return has the reference ${rtRef}.` : 'There are no exceptions in the queue.'}
            </EmptyState>
          ) : (
            <SkeletonLines rows={6} />
          )
        ) : (
          <>
            <div className="row gap-3">
              <Img icon="package" src={it?.imageUrl ?? undefined} alt="" className="thumb" />
              <div className="stack gap-0">
                <span className="strong">{it?.title}</span>
                <span className="xs muted">
                  {it?.options ? Object.values(it.options).join(' · ') : ''} · Qty {it?.quantity ?? 1} · Sold by {current.detail.seller.name} ·{' '}
                  <Link className="mono strong nowrap" to={href('admin/order', '', { ref: current.detail.orderRef })}>
                    {current.detail.orderRef}
                  </Link>
                </span>
              </div>
            </div>
            <KeyValue
              pairs={[
                ['Customer', current.customer?.displayName ?? '—'],
                ['Reason', current.detail.reason],
                ['Requested', date(current.detail.requestedAt)],
                ...(current.policyApplied?.windowDays ? [['Return window', `${current.policyApplied.windowDays} days`] as [string, string]] : []),
                [
                  'Paid for item',
                  <>
                    {formatMoney(current.payment?.maxRefundable)}
                    {current.payment?.discountShare?.amount ? (
                      <>
                        {' '}
                        <span className="xs muted">after {formatMoney(current.payment.discountShare)} discount share</span>
                      </>
                    ) : null}
                  </>,
                ],
                ['Owner', current.owner?.name ?? (current.detail.seller.ownerType === 'seller' ? current.detail.seller.name : 'Unassigned')],
              ]}
            />
            {(photos.length > 0 || current.detail.details) && (
              <div className="stack gap-2">
                <span className="label">Customer evidence</span>
                {photos.length > 0 && (
                  <div className="grid c2 gap-2" style={{ gridTemplateColumns: 'repeat(3,minmax(0,1fr))' }}>
                    {photos.map((p, i) => (
                      <Img key={i} icon="image" src={p.url ?? undefined} alt={p.alt ?? ''} className="r43" />
                    ))}
                  </div>
                )}
                {current.detail.details && <p className="small sub">"{current.detail.details}"</p>}
              </div>
            )}
            <Alert tone="warning" title="Exception to the standard return journey">
              Refund without return is a controlled exception. The reason is recorded and Finance approves the money. The item is written off in stock, not restocked.
            </Alert>
            {!canSend && (exc || (refundStatus && SENT_REFUNDS.has(refundStatus))) && (
              <Alert tone="info" title={`Refund ${(REFUND_LABEL[refundStatus ?? ''] ?? 'requested').toLowerCase()}`}>
                This refund is already with Finance or sent, so a second request is blocked.
              </Alert>
            )}
            {!mayPropose && !exc && <p className="xs muted">Proposing a refund without return needs the Returns Manager role.</p>}
            {drawerError && <Alert tone="danger" title={drawerError} />}
            <Field label="Recorded reason">
              <Select id="aa-rt-exc" options={EXCEPTION_REASONS} value={excReason} disabled={!canSend} onChange={(e) => setExcReason(e.target.value as typeof excReason)} />
            </Field>
            <Field label="Details" hint={detailsError ? undefined : 'Required. Visible to Finance and in Action history.'} error={detailsError}>
              <Textarea id="aa-rt-exc-d" placeholder="" value={details} disabled={!canSend} onChange={(e) => setDetails(e.target.value)} />
            </Field>
            {asking && (
              <Field label="Question for the customer" hint="The decision deadline moves while the customer answers.">
                <Textarea id="aa-rt-ask" value={question} onChange={(e) => setQuestion(e.target.value)} />
              </Field>
            )}
            <div className="well stack gap-2">
              <SummaryRow k="Refund amount" v={formatMoney(current.payment?.maxRefundable)} />
              <SummaryRow k="Refund to" v={current.payment?.methodLabel ?? 'Original payment'} />
              <SummaryRow k="Stock outcome" v="Written off" />
              <SummaryRow k="Approval" v={rr?.approval?.reason ?? 'Finance, within the approver’s refund limit'} />
            </div>
            <Timeline events={timeline} />
          </>
        )}
      </Drawer>
    </AdminLayout>
  );
}
