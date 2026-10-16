import { useEffect, useRef, useState, type ReactNode } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { call, errorMessage, useApi } from '@marketly/web-shared/api';
import { AdminLayout } from '@marketly/web-shared/layouts';
import { useView } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import { Alert, Avatar, Badge, Button, Deadline, Dialog, Field, Icon, LazyLoad, PageHeader, Pager, Radio, SearchInput, Select, Stat, StatusBadge, TableWrap, Tabs, Textarea, type IconName } from '@marketly/web-shared/ui';
import { useStaffSession } from '@/app/session';
import { LoadError, SkeletonLines, deadlineLabel, deadlineTone } from '@/app/parts';
import { useDebounced } from './data/customers';
import { exportNote, useDatasetExport } from './data/dataset-export';
import {
  API_SORT, API_TAB, PRIORITY_LABEL, PRIORITY_TONE, TAB_LABEL, minutesLabel,
  type ApiPriority, type Assignee, type CaseCategory, type CaseRow, type CaseStats, type SortKey, type TabKey,
} from './data/cases';

// Design: pages/admin/admin-cases.html · view "bulk-assign" = Unassigned tab with its rows selected and the bulk bar.
// Data: GET /api/admin/support/cases (tab, q, category, priority, sort, page), /cases/stats (KPIs, tab counts),
// /categories, /assignees. Writes: POST /cases/assign (bulk owner), /cases/priority (bulk priority, optional reason),
// POST /api/admin/reports/exports (dataset support.admin.cases, the current tab and filters; polled, then downloaded).

const LIMIT = 25;

function PriorityBadge({ p }: { p: ApiPriority }) {
  return p === 'high' || p === 'urgent' ? (
    <Badge tone="danger" icon="arrow-up">
      {PRIORITY_LABEL[p]}
    </Badge>
  ) : (
    <Badge tone={PRIORITY_TONE[p]}>{PRIORITY_LABEL[p]}</Badge>
  );
}

function Owner({ name }: { name: string | null | undefined }) {
  if (!name) return <span className="xs t-warning-text strong">Unassigned</span>;
  return (
    <span className="row nowrap gap-2">
      <Avatar name={name} className="ab-av-sm" />
      <span className="ab-cell">
        <span className="strong">{name}</span>
      </span>
    </span>
  );
}

const tone = (c: CaseRow) => (c.nextResponse ? deadlineTone(c.nextResponse.state) : 'ok');
const nextLabel = (c: CaseRow) => (c.nextResponse ? deadlineLabel(c.nextResponse.dueAt) : c.deadlineLabel);

const rowFlag = (c: CaseRow): { cls: string; sr: string } | null =>
  tone(c) === 'danger' ? { cls: 'is-flagged', sr: 'Urgent: ' } : tone(c) === 'warning' ? { cls: 'is-warn', sr: 'At risk: ' } : null;

/** Design legend markup (the shared StatusLegend has no "Legend:" sr-only prefix). */
function EdgeLegend({ items }: { items: Array<{ tone: 'danger' | 'warning'; label: ReactNode }> }) {
  if (!items.length) return null;
  return (
    <p className="status-legend status-legend--edge">
      <span className="sr-only">Legend: </span>
      {items.map((it) => (
        <span key={it.tone} className={`sl sl-${it.tone}`}>
          <i aria-hidden="true" />
          {it.label}
        </span>
      ))}
    </p>
  );
}

const plural = (n: number) => `${n} ${n === 1 ? 'case' : 'cases'}`;
const TEAM: Record<Assignee['team'], string> = { customer_support: '', returns: 'Returns', finance: 'Finance', trust: 'Trust and Risk', seller_management: 'Seller Manager', official_store: 'Official Store' };

export default function Cases() {
  const { api } = useApi();
  const qc = useQueryClient();
  const { can, accountId, name } = useStaffSession();
  const [view] = useView<'bulk-assign'>();
  const [tab, setTab] = useState<TabKey>(view === 'bulk-assign' ? 'unassigned' : 'all');
  const [selected, setSelected] = useState<Map<string, CaseRow>>(new Map());
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const [pri, setPri] = useState('');
  const [sort, setSort] = useState<SortKey>('deadline');
  const [page, setPage] = useState(1);
  const [assignTo, setAssignTo] = useState('');
  const [done, setDone] = useState<{ tone: 'success' | 'danger'; title: string; body: string } | null>(null);
  const [priOpen, setPriOpen] = useState(false);
  const [newPri, setNewPri] = useState<ApiPriority>('high');
  const [priReason, setPriReason] = useState('');
  const preselected = useRef(false);

  const canAssign = can('support.cases.assign');
  const canHandle = can('support.cases.handle');
  const term = useDebounced(q.trim(), 300);

  const stats = useQuery({ queryKey: ['support', 'cases', 'stats'], queryFn: () => call(api.GET('/api/admin/support/cases/stats')) as Promise<CaseStats> });
  const categories = useQuery({ queryKey: ['support', 'categories'], queryFn: () => call(api.GET('/api/admin/support/categories')) as Promise<CaseCategory[]>, staleTime: 10 * 60_000 });
  const assignees = useQuery({ queryKey: ['support', 'assignees'], queryFn: () => call(api.GET('/api/admin/support/assignees')) as Promise<Assignee[]>, enabled: canAssign });
  const list = useQuery({
    queryKey: ['support', 'cases', 'list', tab, term, cat, pri, sort, page],
    queryFn: () =>
      call(
        api.GET('/api/admin/support/cases', {
          params: { query: { tab: API_TAB[tab], q: term || undefined, category: cat || undefined, priority: (pri || undefined) as ApiPriority | undefined, sort: API_SORT[sort], page, limit: LIMIT } },
        }),
      ),
    placeholderData: keepPreviousData,
  });
  const rows = (list.data?.items ?? []) as CaseRow[];
  const totalPages = list.data?.totalPages ?? 1;

  useEffect(() => setPage(1), [term, cat, pri, sort, tab]);

  // The design's bulk-assign view: the Unassigned tab with its rows selected.
  useEffect(() => {
    if (view !== 'bulk-assign' || preselected.current || !list.isSuccess || tab !== 'unassigned') return;
    preselected.current = true;
    setSelected(new Map(rows.filter((c) => !c.owner).map((c) => [c.id, c])));
  }, [view, list.isSuccess, rows, tab]);

  // The assign picker: staff who can own cases; the signed-in staff member when the list doesn't include them.
  const people = assignees.data ?? [];
  const options = people.some((a) => a.staffId === accountId) ? people : [...people, { staffId: accountId, name: `${name || 'Me'} (you)`, team: 'customer_support' as const, role: '', openCases: 0, overdueCases: 0, away: false }];
  useEffect(() => {
    if (!assignTo && options.length) setAssignTo(options[0].staffId);
  }, [assignTo, options]);

  const s = stats.data;
  const counts: Partial<Record<TabKey, number>> = s ? { all: s.open, unassigned: s.unassigned, overdue: s.pastTarget, disputes: s.openDisputes } : {};
  const kpis: Array<{ icon: IconName; label: string; value: string; note: string }> = s
    ? [
        { icon: 'life-buoy', label: 'Open cases', value: String(s.open), note: `${s.openedToday} opened today` },
        { icon: 'alarm-clock', label: 'Past response target', value: String(s.pastTarget), note: s.oldestOverdueMinutes ? `Oldest overdue ${minutesLabel(s.oldestOverdueMinutes)}` : 'None overdue' },
        { icon: 'user-x', label: 'Unassigned', value: String(s.unassigned), note: 'Assign within 1 h' },
        { icon: 'scale', label: 'Open disputes', value: String(s.openDisputes), note: 'Decision target 5 business days' },
      ]
    : [];
  const change = s?.medianFirstReplyChangeMinutes ?? null;

  const ids = [...selected.keys()];
  const n = ids.length;
  const allOn = rows.length > 0 && rows.every((c) => selected.has(c.id));
  const someOn = rows.some((c) => selected.has(c.id));
  const toggle = (c: CaseRow) =>
    setSelected((m) => {
      const next = new Map(m);
      if (next.has(c.id)) next.delete(c.id);
      else next.set(c.id, c);
      return next;
    });
  const toggleAll = () =>
    setSelected((m) => {
      const next = new Map(m);
      rows.forEach((c) => (allOn ? next.delete(c.id) : next.set(c.id, c)));
      return next;
    });
  const clear = () => setSelected(new Map());

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['support', 'cases'] });
    void qc.invalidateQueries({ queryKey: ['support', 'assignees'] });
    void qc.invalidateQueries({ queryKey: ['workqueues', 'queues'] });
  };

  const assign = useMutation({
    mutationFn: (v: { caseIds: string[]; ownerId: string }) => call(api.POST('/api/admin/support/cases/assign', { body: v })),
    onSuccess: (_r, v) => {
      const who = options.find((a) => a.staffId === v.ownerId)?.name ?? 'the new owner';
      setDone({ tone: 'success', title: `${plural(v.caseIds.length)} assigned to ${who}`, body: `${who} gets a notification. Response targets do not change.` });
      clear();
      refresh();
    },
    onError: (e) => setDone({ tone: 'danger', title: 'The cases weren’t assigned', body: errorMessage(e) }),
  });
  const setPriority = useMutation({
    mutationFn: (v: { caseIds: string[]; priority: ApiPriority; reason?: string }) => call(api.POST('/api/admin/support/cases/priority', { body: v })),
    onSuccess: (_r, v) => {
      setDone({ tone: 'success', title: `Priority set to ${PRIORITY_LABEL[v.priority]} on ${plural(v.caseIds.length)}`, body: 'Sort by priority to see the new order.' });
      setPriOpen(false);
      clear();
      refresh();
    },
  });

  // The reason is optional (G68): left out, each case records "Priority changed from the case list".
  const applyPriority = () => setPriority.mutate({ caseIds: ids, priority: newPri, reason: priReason.trim() || undefined });

  const exporter = useDatasetExport('support.admin.cases');
  const exported = exportNote(exporter.job);
  const exportFilters = { tab: API_TAB[tab], q: term || undefined, category: cat || undefined, priority: pri || undefined };

  const legend = [
    ...(rows.some((c) => tone(c) === 'danger') ? [{ tone: 'danger' as const, label: 'Red edge = urgent: overdue or past target' }] : []),
    ...(rows.some((c) => tone(c) === 'warning') ? [{ tone: 'warning' as const, label: 'Amber edge = at risk: due soon or near target' }] : []),
  ];
  const owner = s?.queueOwner;
  const ownerLine = owner ? [owner.lead ? `Owner ${owner.lead}` : null, owner.backup ? `backup ${owner.backup}` : null, `escalation to ${owner.escalation}`].filter(Boolean).join(' · ') : undefined;

  return (
    <AdminLayout active="cases">
      <PageHeader
        crumbs={[{ label: 'Admin', to: href('admin/dashboard') }, { label: 'Customers and service' }]}
        title="Cases and disputes"
        sub={ownerLine ? ownerLine.charAt(0).toUpperCase() + ownerLine.slice(1) : undefined}
        actions={
          <>
            {can('support.cases.view') && (
              <Button variant="secondary" size="sm" icon="download" disabled={exporter.busy} onClick={() => void exporter.run(exportFilters)}>
                {exporter.busy ? 'Exporting…' : 'Export'}
              </Button>
            )}
            {canHandle && (
              <Button size="sm" icon="plus" disabled title="Open a case from the customer or the order">
                New case
              </Button>
            )}
          </>
        }
      />
      {exporter.error ? (
        <Alert tone="danger" title="We couldn’t export the case queue">
          {errorMessage(exporter.error)}
        </Alert>
      ) : exported ? (
        <Alert tone={exported.tone} title={exported.tone === 'danger' ? 'The export failed' : exported.tone === 'success' ? 'Case queue exported' : 'Export started'}>
          {exported.text}
        </Alert>
      ) : null}
      {stats.isError && <LoadError error={stats.error} onRetry={() => void stats.refetch()} />}
      <div className="ab-kpis k5">
        {stats.isPending
          ? Array.from({ length: 5 }, (_, i) => (
              <div className="card pad" key={i}>
                <SkeletonLines rows={1} />
              </div>
            ))
          : kpis.map((k) => (
              <div className="card pad" key={k.label}>
                <Stat icon={k.icon} label={k.label} value={k.value} note={k.note} />
              </div>
            ))}
        {s && (
          <div className="card pad">
            <div className="stat">
              <span className="k">
                <Icon name="clock" className="ic-sm" />
                Median first reply
              </span>
              <span className="v">{minutesLabel(s.medianFirstReplyMinutes)}</span>
              {change != null && change !== 0 && (
                <span className={change < 0 ? 'd up good' : 'd down'}>
                  <span aria-hidden="true">{change < 0 ? '▼ ' : '▲ '}</span>
                  <span className="sr-only">{change < 0 ? 'down ' : 'up '}</span>
                  {minutesLabel(Math.abs(change))} · {change < 0 ? 'faster' : 'slower'} than last week
                </span>
              )}
            </div>
          </div>
        )}
      </div>
      <p className="ab-note">
        <Icon name="info" className="ic-sm" /> {s?.targets ?? 'First reply within 4 business hours, dispute decision within 5 business days'}. Business hours Mon–Sat, 8 AM–8 PM PT.
      </p>
      <div className="stack gap-3">
        <Tabs<TabKey>
          items={(Object.keys(TAB_LABEL) as TabKey[]).map((t) => ({ value: t, label: TAB_LABEL[t], count: counts[t] }))}
          active={tab}
          onChange={(t) => {
            setTab(t);
            setPage(1);
          }}
        />
        {done && (
          <Alert tone={done.tone} title={done.title}>
            {done.body}
          </Alert>
        )}
        <div className="toolbar">
          <SearchInput id="cs-q" placeholder="Search case, order, customer or seller" value={q} onChange={setQ} />
          <Select id="cs-cat" aria-label="Category" value={cat} onChange={(e) => setCat(e.target.value)} options={[{ value: '', label: 'All categories' }, ...(categories.data ?? []).filter((c) => c.active).map((c) => ({ value: c.key, label: c.label }))]} />
          <Select id="cs-pri" aria-label="Priority" value={pri} onChange={(e) => setPri(e.target.value)} options={[{ value: '', label: 'Any priority' }, { value: 'urgent', label: 'Urgent' }, { value: 'high', label: 'High' }, { value: 'medium', label: 'Medium' }, { value: 'low', label: 'Low' }]} />
          <Select
            id="cs-sort"
            aria-label="Sort by"
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            options={[
              { value: 'deadline', label: 'Sort: next deadline' },
              { value: 'newest', label: 'Sort: newest' },
              { value: 'priority', label: 'Sort: priority' },
            ]}
          />
        </div>
        {n > 0 && (
          <div className="bulk-bar">
            <span>{n} selected</span>
            <span className="grow" />
            {canAssign ? (
              <>
                <label className="sr-only" htmlFor="cs-assign">
                  Assign to
                </label>
                <select className="select" id="cs-assign" value={assignTo} onChange={(e) => setAssignTo(e.target.value)}>
                  {options.map((a, i) => (
                    <option key={a.staffId} value={a.staffId}>
                      {`${i === 0 ? 'Assign to… ' : ''}${a.name}${TEAM[a.team] ? `, ${TEAM[a.team]}` : ''} (${a.openCases} open)${a.away ? ' · away' : ''}`}
                    </option>
                  ))}
                </select>
                <Button variant="soft" size="sm" icon="user-check" disabled={!assignTo || assign.isPending} onClick={() => assign.mutate({ caseIds: ids, ownerId: assignTo })}>
                  Assign {plural(n)}
                </Button>
              </>
            ) : (
              <span className="xs muted">Your role can’t assign cases</span>
            )}
            {canHandle && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setPriReason('');
                  setPriority.reset();
                  setPriOpen(true);
                }}
              >
                Set priority
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={clear}>
              Clear
            </Button>
          </div>
        )}
        <div className="card no-phone">
          <TableWrap label="Cases and disputes table">
            <table className="table">
              <thead>
                <tr>
                  <th className="col-check">
                    <input
                      type="checkbox"
                      aria-label="Select all"
                      checked={allOn}
                      ref={(el) => {
                        if (el) el.indeterminate = someOn && !allOn;
                      }}
                      onChange={toggleAll}
                    />
                  </th>
                  <th scope="col">Case</th>
                  <th scope="col">Order</th>
                  <th scope="col">Category</th>
                  <th scope="col">Priority</th>
                  <th scope="col">Customer</th>
                  <th scope="col">Seller</th>
                  <th scope="col">Owner</th>
                  <th scope="col">Status</th>
                  <th className="col-pin" scope="col">
                    Next response
                  </th>
                </tr>
              </thead>
              <tbody>
                {list.isPending && (
                  <tr>
                    <td colSpan={10}>
                      <SkeletonLines rows={5} />
                    </td>
                  </tr>
                )}
                {list.isError && (
                  <tr>
                    <td colSpan={10}>
                      <LoadError error={list.error} onRetry={() => void list.refetch()} />
                    </td>
                  </tr>
                )}
                {rows.map((c) => {
                  const flag = rowFlag(c);
                  return (
                    <tr key={c.id} className={flag?.cls}>
                      <td className="col-check">
                        {flag && <span className="sr-only">{flag.sr}</span>}
                        <input type="checkbox" aria-label={`Select ${c.ref}`} checked={selected.has(c.id)} onChange={() => toggle(c)} />
                      </td>
                      <td>
                        <Link className="mono strong nowrap" to={href('admin/case', '', { ref: c.ref })} title={c.ref}>
                          {c.ref}
                        </Link>
                      </td>
                      <td>
                        {c.orderRef ? (
                          <Link className="mono nowrap" to={href('admin/order', '', { ref: c.orderRef })} title={c.orderRef}>
                            {c.orderRef}
                          </Link>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td>
                        {c.category}
                        {c.kind === 'dispute' ? ' · dispute' : ''}
                        {c.reopened ? ' · reopened' : ''}
                      </td>
                      <td>
                        <PriorityBadge p={c.priority} />
                      </td>
                      <td>{c.customerName ?? '—'}</td>
                      <td>{c.sellerName ?? '—'}</td>
                      <td>
                        <Owner name={c.owner?.name} />
                      </td>
                      <td>
                        <StatusBadge status={c.statusLabel} />
                      </td>
                      <td className="col-pin">
                        <Deadline tone={tone(c)}>{nextLabel(c)}</Deadline>
                      </td>
                    </tr>
                  );
                })}
                {list.isSuccess && !rows.length && (
                  <tr>
                    <td colSpan={10} className="muted">
                      {term || cat || pri ? 'No cases match these filters.' : tab === 'all' ? 'No open cases. The queue is clear.' : `No cases in ${TAB_LABEL[tab]}.`}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </TableWrap>
          <EdgeLegend items={legend} />
          <div className="card-foot">
            <span className="ab-note grow">Cases close only after any promised refund or replacement is complete.</span>
            {totalPages > 1 && <Pager page={page} total={totalPages} onPage={setPage} />}
          </div>
        </div>
        <ul className="ab-mlist only-phone">
          {list.isPending && (
            <li className="card pad">
              <SkeletonLines rows={3} />
            </li>
          )}
          {rows.map((c) => (
            <li className="card pad" key={c.id}>
              <div className="row between">
                <Link className="mono strong" to={href('admin/case', '', { ref: c.ref })}>
                  {c.ref}
                </Link>
                <StatusBadge status={c.statusLabel} />
              </div>
              <span className="small">{c.category}</span>
              <span className="xs muted">
                {c.customerName ?? '—'} · {c.sellerName ?? '—'} · {c.owner?.name ?? 'Unassigned'}
              </span>
              <div className="row between">
                <PriorityBadge p={c.priority} />
                <Deadline tone={tone(c)}>{nextLabel(c)}</Deadline>
              </div>
            </li>
          ))}
        </ul>
        {page < totalPages && <LazyLoad />}
      </div>
      <Dialog
        open={priOpen}
        onClose={() => setPriOpen(false)}
        title="Set priority"
        size="sm"
        foot={
          <>
            <Button variant="secondary" onClick={() => setPriOpen(false)}>
              Cancel
            </Button>
            <Button onClick={applyPriority} disabled={setPriority.isPending}>
              Set priority on {plural(n)}
            </Button>
          </>
        }
      >
        {setPriority.error && (
          <Alert tone="danger" title="That didn’t work">
            {errorMessage(setPriority.error)}
          </Alert>
        )}
        <fieldset className="stack gap-2 fieldset-reset">
          <legend className="label">Priority</legend>
          {(['urgent', 'high', 'medium', 'low'] as ApiPriority[]).map((p) => (
            <Radio key={p} id={`cs-setpri-${p}`} name="cs-setpri" label={PRIORITY_LABEL[p]} checked={newPri === p} onChange={() => setNewPri(p)} />
          ))}
        </fieldset>
        <Field label="Reason (optional)" hint="Recorded on every case. Left empty, the history says the priority was changed from the case list.">
          <Textarea id="cs-setpri-reason" value={priReason} onChange={(e) => setPriReason(e.target.value)} />
        </Field>
      </Dialog>
    </AdminLayout>
  );
}
