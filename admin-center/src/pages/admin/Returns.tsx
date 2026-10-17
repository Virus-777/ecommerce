import { useRef, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { ApiError, call, errorMessage, newIdempotencyKey, useApi } from '@marketly/web-shared/api';
import { AdminLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { formatMoney } from '@marketly/web-shared/lib/format';
import { useView } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import { Alert, Badge, Button, Checkbox, Deadline, Drawer, EmptyState, Field, Img, KeyValue, PageHeader, Pager, SearchInput, Select, StatusBadge, SummaryRow, TableWrap, Tabs, TextInput, Textarea, Timeline, announce, type TimelineEvent } from '@marketly/web-shared/ui';
import { useStaffSession } from '@/app/session';
import { LoadError, SkeletonLines, date, dateTime, deadlineTone } from '@/app/parts';
import {
  API_TAB, EXCEPTION_REASONS, NO_RETURN_FILTERS, REASONS, REFUND_LABEL, SENT_REFUNDS, STATIC_OPTIONS, TAB_COUNT_KEY, TAB_LABELS, flagStyle, rowEdge,
  type ReturnCase, type ReturnEdge, type ReturnFilters, type ReturnRow, type ReturnTab, type RowFlag,
} from './data/returns';
import {
  ACTION_ORDER, CANCELLABLE_REPLACEMENT, DECISION_ACTIONS, DONE, INSPECTION_ACTIONS, LABEL_METHODS, REJECT_REASONS, TAKE_OVER_REASONS, refundOutcome,
  type DecisionAction, type LabelMethod, type RejectCode, type TakeOverReason,
} from './data/return-decisions';
import { useStaffOptions } from './data/audit';
import { isStepUpCancel, reauthField, useStepUp } from './data/step-up';

// Design: pages/admin/admin-returns.html · view "exception-review" = the return drawer
// (?rt=<ref> picks the return; without it the drawer opens on the first exception in the queue).
// Data: GET returns/requests (tab, filters, page), GET returns/requests/stats (KPIs, tab counts, queue owner),
// GET returns/requests/{ref} (drawer; the RT- ref is accepted as the id), POST reports/exports (dataset
// returns.admin.requests). The drawer offers the decisions the return's allowedActions name (data/return-decisions.ts):
// POST …/approve, /reject, /request-info, /take-over, /overturn, /assign, /receive, /approve-without-return
// (refund without return: may ask for the password again; the refund usually waits "Under review" for Finance),
// POST returns/replacements/{id}/cancel. Inspection and the remedy stay on Ops › Return inspection.

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

  // Drawer form, reset when another return is opened. `action` is the decision form shown (null: the list of
  // decisions this return offers); `text` is that form's note, explanation, reason or question.
  const [formFor, setFormFor] = useState('');
  const [action, setAction] = useState<DecisionAction | null>(null);
  const [excReason, setExcReason] = useState<(typeof EXCEPTION_REASONS)[number]['value']>(EXCEPTION_REASONS[0].value);
  const [details, setDetails] = useState('');
  const [text, setText] = useState('');
  const [labelMethod, setLabelMethod] = useState<LabelMethod>('prepaid_qr');
  const [rejectCode, setRejectCode] = useState<RejectCode>('outside_window');
  const [takeOverReason, setTakeOverReason] = useState<TakeOverReason>('seller_no_response');
  const [withoutReturn, setWithoutReturn] = useState(false);
  const [ownerId, setOwnerId] = useState('');
  const [tracking, setTracking] = useState('');
  const [attempted, setAttempted] = useState(false);
  const [drawerError, setDrawerError] = useState('');
  const [drawerNotice, setDrawerNotice] = useState('');
  const idem = useRef<string>('');
  const pick = (a: DecisionAction | null) => {
    setAction(a);
    setText('');
    setWithoutReturn(false);
    setOwnerId('');
    setTracking('');
    setAttempted(false);
    setDrawerError('');
    if (a) setDrawerNotice('');
  };
  if (current && formFor !== current.detail.ref) {
    setFormFor(current.detail.ref);
    setExcReason((current.exception?.reasonCode as typeof excReason) ?? EXCEPTION_REASONS[0].value);
    setDetails(current.exception?.details ?? '');
    pick(null);
    setDrawerNotice('');
    idem.current = newIdempotencyKey();
  }
  const stepUp = useStepUp();
  // Other staff for Assign; listing them needs access.roles.view, without it only "Me" is offered.
  const mayListStaff = can('access.roles.view');
  const staff = useStaffOptions(open && action === 'assign' && mayListStaff);

  const rows: ReturnRow[] = list.data?.items ?? [];
  const totalPages = list.data?.totalPages ?? 1;
  const s = stats.data;
  const drawerLink = (ref: string) => href('admin/returns', 'exception-review', undefined, { rt: ref });
  const close = () => {
    pick(null);
    setDrawerNotice('');
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        p.delete('view');
        p.delete('rt');
        return p;
      },
      { preventScrollReset: true },
    );
  };
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
  // What this return offers now comes from the API (allowedActions), filtered by the permissions of the person.
  const allowed = current ? (current.allowedActions ?? current.detail.allowedActions ?? []) : [];
  const replacement = current?.detail.replacement ?? null;
  const offers = (a: DecisionAction) => {
    const m = DECISION_ACTIONS[a];
    if (!current || !can(m.permission)) return false;
    if (a === 'cancel-replacement') return !!replacement && CANCELLABLE_REPLACEMENT.has(replacement.status);
    // A refund already with Finance or sent blocks a second request even if the return still allows it.
    if (a === 'exception') return allowed.includes('approve-without-return') && !current.exception && !(refundStatus && SENT_REFUNDS.has(refundStatus));
    return allowed.includes(m.allowed!);
  };
  const available = ACTION_ORDER.filter(offers);
  const atInspection = allowed.some((a) => INSPECTION_ACTIONS.includes(a)) && can('returns.inspections.view');
  const detailsError = attempted && !details.trim() ? 'Enter the details for the record. Finance reads them before approving.' : '';
  const TEXT_REQUIRED: Partial<Record<DecisionAction, string>> = {
    reject: 'Explain the decision. The customer sees it.',
    'request-info': 'Write what you need from the customer.',
    'take-over': 'Say why Marketly takes over.',
    overturn: 'Say why the rejection is overturned. The customer sees it.',
    'cancel-replacement': 'Say why the replacement is cancelled.',
  };
  const textMissing = !!action && !!TEXT_REQUIRED[action] && text.trim().length < (action === 'request-info' ? 5 : 1);
  const textError = attempted && textMissing ? TEXT_REQUIRED[action!]! : '';
  // After a decision the drawer stays open on the updated return, so the next step (e.g. approve after taking over) is at hand.
  const done = (msg: string) => {
    say(msg);
    setDrawerNotice(msg);
    pick(null);
    refresh();
  };

  const sendToFinance = useMutation({
    mutationFn: () =>
      // Staff refunds can need the password again (403 STEP_UP_REQUIRED): useStepUp asks and retries with reauthToken.
      stepUp.run(
        (token) =>
          call(
            api.POST('/api/admin/returns/requests/{id}/approve-without-return', {
              params: { path: { id: current!.detail.id }, header: { 'Idempotency-Key': token ? newIdempotencyKey() : idem.current } },
              body: { reasonCode: excReason, details: details.trim(), remedy: { kind: 'full_refund' }, ...reauthField(token) },
            }),
          ) as Promise<ReturnCase>,
      ),
    // The message follows the refund the API answered with: staff refunds usually wait "Under review" for Finance.
    onSuccess: (res) => done(refundOutcome(current!.detail.ref, res?.refundRequest)),
    onError: (e) => {
      if (!isStepUpCancel(e)) setDrawerError(errorMessage(e));
    },
  });
  const decide = useMutation({
    // The answer (the updated return, or the cancelled replacement) is not read: the drawer refetches the return.
    mutationFn: (a: Exclude<DecisionAction, 'exception'>): Promise<unknown> => {
      const params = { path: { id: current!.detail.id } };
      const note = text.trim();
      switch (a) {
        case 'approve':
          return call(api.POST('/api/admin/returns/requests/{id}/approve', { params, body: { labelMethod, reason: note || null } }));
        case 'reject':
          return call(api.POST('/api/admin/returns/requests/{id}/reject', { params, body: { reasonCode: rejectCode, explanation: note } }));
        case 'request-info':
          return call(api.POST('/api/admin/returns/requests/{id}/request-info', { params, body: { question: note } }));
        case 'take-over':
          // No ownerId: the person taking over becomes the owner (Assign changes it).
          return call(api.POST('/api/admin/returns/requests/{id}/take-over', { params, body: { reason: takeOverReason, note } }));
        case 'overturn':
          return call(api.POST('/api/admin/returns/requests/{id}/overturn', { params, body: { withoutReturn, reason: note, labelMethod: withoutReturn ? null : labelMethod } }));
        case 'assign':
          return call(api.POST('/api/admin/returns/requests/{id}/assign', { params, body: { ownerId: ownerId || accountId, note: note || null } }));
        case 'receive':
          return call(api.POST('/api/admin/returns/requests/{id}/receive', { params, body: { trackingNumber: tracking.trim() || null, note: note || null } }));
        case 'cancel-replacement':
          return call(api.POST('/api/admin/returns/replacements/{id}/cancel', { params: { path: { id: replacement!.id } }, body: { reason: note } }));
      }
    },
    onSuccess: (_r, a) => done(DONE[a](current!.detail.ref)),
    onError: (e) => setDrawerError(errorMessage(e)),
  });
  const busy = decide.isPending || sendToFinance.isPending;
  const exportCsv = useMutation({
    mutationFn: () => call(api.POST('/api/admin/reports/exports', { body: { dataset: 'returns.admin.requests', filters: listQuery, format: 'csv' } })),
    onSuccess: () => announce('Export started. It is logged in Action history.'),
    onError: (e) => setError(errorMessage(e)),
  });

  const onSubmit = () => {
    if (!action) return;
    setAttempted(true);
    setDrawerError('');
    if (action === 'exception') {
      if (details.trim()) sendToFinance.mutate();
      return;
    }
    if (textMissing) return;
    decide.mutate(action);
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
  const meta = action ? DECISION_ACTIONS[action] : null;
  const staffOpts = [{ value: '', label: 'Me' }, ...[...staff].filter(([id]) => id !== accountId).map(([id, n]) => ({ value: id, label: n }))];
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
        title={current ? `${current.detail.ref} · ${meta ? meta.label.toLowerCase() : (current.statusLabel ?? current.detail.statusLabel)}` : (rtRef ?? 'Return')}
        foot={
          current && meta ? (
            <>
              <Button variant="ghost" onClick={() => pick(null)} disabled={busy}>
                Back
              </Button>
              <Button variant={meta.variant} icon={meta.icon} onClick={onSubmit} disabled={busy}>
                {meta.confirm}
              </Button>
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
                ['Status', <StatusBadge status={current.statusLabel ?? current.detail.statusLabel} />],
                ...(replacement ? [[replacement.kind === 'exchange' ? 'Exchange' : 'Replacement', `${replacement.title ?? 'Item'} · ${replacement.status}`] as [string, string]] : []),
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
            {drawerNotice && <Alert tone="success" title={drawerNotice} />}
            {drawerError && <Alert tone="danger" title={drawerError} />}

            {/* ----- No form open: what this return offers now ----- */}
            {!action && (
              <>
                {(exc || (refundStatus && SENT_REFUNDS.has(refundStatus))) && (
                  <Alert tone="info" title={`Refund ${(REFUND_LABEL[refundStatus ?? ''] ?? 'requested').toLowerCase()}`}>
                    {refundStatus === 'requested' || refundStatus === 'under_review' ? 'The refund waits for Finance approval, so a second request is blocked.' : 'This refund is already approved or sent, so a second request is blocked.'}
                  </Alert>
                )}
                <div className="stack gap-2">
                  <span className="label">Decide</span>
                  {available.length ? (
                    <div className="row gap-2">
                      {available.map((a) => (
                        <Button key={a} variant="secondary" size="sm" icon={DECISION_ACTIONS[a].icon} onClick={() => pick(a)}>
                          {DECISION_ACTIONS[a].label}
                        </Button>
                      ))}
                    </div>
                  ) : (
                    <p className="xs muted">{allowed.length ? 'Your role can’t take the decisions this return is waiting for.' : 'Nothing to decide on this return now.'}</p>
                  )}
                  {atInspection && (
                    <p className="xs muted">
                      Inspection and the remedy are recorded on <Link to={href('ops/return-inspection')}>Return inspection</Link>.
                    </p>
                  )}
                  {!mayPropose && allowed.includes('approve-without-return') && !exc && <p className="xs muted">Proposing a refund without return needs the Returns Manager role.</p>}
                </div>
                {/* The refund-without-return track, once one was proposed */}
                {exc && <Timeline events={timeline} />}
              </>
            )}

            {/* ----- Refund without return (controlled exception) ----- */}
            {action === 'exception' && (
              <>
                <Alert tone="warning" title="Exception to the standard return journey">
                  Refund without return is a controlled exception. The reason is recorded and Finance approves the money. The item is written off in stock, not restocked.
                </Alert>
                <Field label="Recorded reason">
                  <Select id="aa-rt-exc" options={EXCEPTION_REASONS} value={excReason} onChange={(e) => setExcReason(e.target.value as typeof excReason)} />
                </Field>
                <Field label="Details" hint={detailsError ? undefined : 'Required. Visible to Finance and in Action history.'} error={detailsError}>
                  <Textarea id="aa-rt-exc-d" placeholder="" value={details} onChange={(e) => setDetails(e.target.value)} />
                </Field>
                <div className="well stack gap-2">
                  <SummaryRow k="Refund amount" v={formatMoney(current.payment?.maxRefundable)} />
                  <SummaryRow k="Refund to" v={current.payment?.methodLabel ?? 'Original payment'} />
                  <SummaryRow k="Stock outcome" v="Written off" />
                  <SummaryRow k="Approval" v={rr?.approval?.reason ?? 'Finance, within the approver’s refund limit'} />
                </div>
                <Timeline events={timeline} />
              </>
            )}

            {/* ----- The other decisions ----- */}
            {(action === 'approve' || (action === 'overturn' && !withoutReturn)) && (
              <Field label="Return label" hint="Customers never pay return shipping for damaged, wrong or defective items.">
                <Select id="aa-rt-label" options={LABEL_METHODS} value={labelMethod} onChange={(e) => setLabelMethod(e.target.value as LabelMethod)} />
              </Field>
            )}
            {action === 'reject' && (
              <Field label="Reason">
                <Select id="aa-rt-rej" options={REJECT_REASONS} value={rejectCode} onChange={(e) => setRejectCode(e.target.value as RejectCode)} />
              </Field>
            )}
            {action === 'take-over' && (
              <>
                <p className="small sub">Marketly handles this return from now on instead of {current.detail.seller.name}. You become its owner; the seller sees the change.</p>
                <Field label="Why">
                  <Select id="aa-rt-to" options={TAKE_OVER_REASONS} value={takeOverReason} onChange={(e) => setTakeOverReason(e.target.value as TakeOverReason)} />
                </Field>
              </>
            )}
            {action === 'overturn' && (
              <Checkbox id="aa-rt-ovr-nr" label="Approve without asking for the item back" checked={withoutReturn} onChange={(e) => setWithoutReturn(e.target.checked)} />
            )}
            {action === 'assign' && (
              <Field label="Owner" hint={mayListStaff ? undefined : 'Picking another staff member needs the permission to view staff.'}>
                <Select id="aa-rt-owner-to" options={staffOpts} value={ownerId} onChange={(e) => setOwnerId(e.target.value)} />
              </Field>
            )}
            {action === 'receive' && (
              <>
                <p className="small sub">Records that the parcel arrived at the seller’s return address today. It can be inspected next.</p>
                <Field label="Tracking number" optional>
                  <TextInput id="aa-rt-trk" value={tracking} onChange={(e) => setTracking(e.target.value)} />
                </Field>
              </>
            )}
            {action === 'cancel-replacement' && replacement && (
              <p className="small sub">
                Cancels the {replacement.kind === 'exchange' ? 'exchange' : 'replacement'} ({replacement.title ?? 'item'}, {replacement.status}) before it ships and releases the reserved stock. The return then waits for a refund instead.
              </p>
            )}
            {action && action !== 'exception' && (
              <Field
                label={
                  action === 'reject' ? 'Explanation for the customer' : action === 'request-info' ? 'Question for the customer' : action === 'take-over' ? 'Note' : action === 'overturn' ? 'Reason shown to the customer' : action === 'cancel-replacement' ? 'Reason' : 'Note'
                }
                optional={!TEXT_REQUIRED[action]}
                hint={textError ? undefined : action === 'request-info' ? 'The decision deadline moves while the customer answers.' : action === 'approve' ? 'Visible to the seller.' : 'Recorded in Action history.'}
                error={textError || undefined}
              >
                <Textarea id="aa-rt-text" value={text} onChange={(e) => setText(e.target.value)} />
              </Field>
            )}
          </>
        )}
      </Drawer>
      {stepUp.dialog}
    </AdminLayout>
  );
}
