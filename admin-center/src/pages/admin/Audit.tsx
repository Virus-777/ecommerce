import { dayKey, fromZonedInput } from '@marketly/web-shared/lib/dates';
import { useEffect, useState, type ReactNode, useCallback } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { call, errorMessage, useApi } from '@marketly/web-shared/api';
import { AdminLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { href } from '@marketly/web-shared/routes';
import { Alert, announce, Avatar, Breadcrumbs, Button, Card, ChipRow, Chip, Icon, KeyValue, Pager, SearchInput, Select, StatusBadge, TableWrap, Timeline, type IconName } from '@marketly/web-shared/ui';
import { LoadError, SkeletonLines, dateTime, screenHref } from '@/app/parts';
import { useStaffSession } from '@/app/session';
import {
  actorLabel, APPROVAL_LABEL, approvalSteps, isPending, rolesLabel, TARGET_FILTERS, targetHref, targetMeta, useStaffOptions,
  type AuditCategory, type AuditEntry as Entry,
} from './data/audit';
import { useExportJob } from './data/report-export';
import type { ExportJob } from './data/reports';

// Design: pages/admin/admin-audit.html. Entries from GET /api/admin/audit/entries (filters on the server).
// ?q=, ?staff=<account id>, ?category= and ?target= preset the filters: the entry page's "Filter the log by…" chips link here.

type ChipKey = 'pending' | 'financial' | 'seller_enforcement' | 'settings';
const RANGES = ['Last 7 days', 'Today', 'Last 30 days', 'All time'];
const CHIPS: Array<{ key: ChipKey; label: string; icon: IconName }> = [
  { key: 'pending', label: 'Second review pending', icon: 'user-check' },
  { key: 'financial', label: 'Financial actions', icon: 'landmark' },
  { key: 'seller_enforcement', label: 'Seller enforcement', icon: 'store' },
  { key: 'settings', label: 'Settings changes', icon: 'settings' },
];
const PAGE_SIZE = 25;

const Change = ({ e }: { e: Entry }) =>
  e.change.before || e.change.after ? (
    <span className="ac-ba">
      <span className="b">{e.change.before ?? '—'}</span>
      <Icon name="arrow-right" />
      <span className="a">{e.change.after ?? '—'}</span>
    </span>
  ) : (
    <span className="xs muted">See entry</span>
  );

function rangeFrom(range: string): string | undefined {
  const now = Date.now();
  if (range === 'Today') {
    return fromZonedInput(`${dayKey(new Date())}T00:00`) ?? undefined;
  }
  if (range === 'Last 7 days') return new Date(now - 7 * 86_400_000).toISOString();
  if (range === 'Last 30 days') return new Date(now - 30 * 86_400_000).toISOString();
  return undefined;
}

const entryHref = (e: Entry) => href('admin/audit-entry', '', { id: e.id });

export default function Audit() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { api } = useApi();
  const me = useStaffSession();
  const canView = me.can('audit.entries.view');
  const canExport = me.can('audit.entries.export');

  const [q, setQ] = useState(params.get('q') ?? '');
  const [debounced, setDebounced] = useState(q);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);
  const [staff, setStaff] = useState(params.get('staff') ?? '');
  const names = useStaffOptions(canView && me.can('access.roles.view'));
  const [target, setTarget] = useState(TARGET_FILTERS.find((t) => t.type === params.get('target'))?.label ?? TARGET_FILTERS[0].label);
  const [range, setRange] = useState(params.get('q') || params.get('staff') ? 'All time' : RANGES[0]);
  const initialCat = params.get('category');
  const [chips, setChips] = useState<ChipKey[]>(CHIPS.some((c) => c.key === initialCat) ? [initialCat as ChipKey] : []);
  const [selId, setSelId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; title: string; text: string } | null>(null);

  const category = chips.find((c) => c !== 'pending') as AuditCategory | undefined;
  const filters = {
    q: debounced || undefined,
    actorId: staff || undefined,
    targetType: TARGET_FILTERS.find((t) => t.label === target)?.type,
    category,
    approvalState: chips.includes('pending') ? ('pending' as const) : undefined,
    from: rangeFrom(range),
  };
  useEffect(() => setPage(1), [debounced, staff, target, range, chips]);

  const listQ = useQuery({
    queryKey: ['audit', 'entries', filters, page],
    queryFn: () => call(api.GET('/api/admin/audit/entries', { params: { query: { ...filters, page, limit: PAGE_SIZE } } })),
    enabled: canView,
    placeholderData: keepPreviousData,
  });
  const retentionQ = useQuery({ queryKey: ['audit', 'retention'], queryFn: () => call(api.GET('/api/admin/audit/retention')), enabled: canView, staleTime: 10 * 60_000 });

  const rows = (listQ.data?.items ?? []) as Entry[];
  const total = listQ.data?.total ?? rows.length;
  const totalPages = listQ.data?.totalPages ?? 1;
  const sel = rows.find((e) => e.id === selId) ?? rows[0];

  const toggleChip = (k: ChipKey) =>
    setChips((cs) => (cs.includes(k) ? cs.filter((c) => c !== k) : k === 'pending' ? [...cs, k] : [...cs.filter((c) => c === 'pending'), k]));

  const getExport = useCallback((id: string) => call(api.GET('/api/admin/audit/exports/{id}', { params: { path: { id } } })) as Promise<ExportJob>, [api]);
  const exp = useExportJob(getExport);
  const startExport = async () => {
    setNotice(null);
    const job = await exp.run(
      () =>
        call(
          api.POST('/api/admin/audit/exports', {
            body: { filters: Object.fromEntries(Object.entries(filters).filter(([, v]) => v !== undefined)), format: 'csv', reason: 'Exported from Action history with the filters shown' },
          }),
        ) as Promise<ExportJob>,
    );
    if (!job) return;
    if (job.state === 'ready') {
      setNotice({ tone: 'success', title: `Export ${job.ref} is ready`, text: `${job.rowCount ?? 0} actions exported as CSV. The export is recorded in Action history.` });
      announce(`Export ${job.ref} is ready`);
    } else if (job.state === 'failed' || job.state === 'expired') {
      setNotice({ tone: 'danger', title: `Export ${job.ref} ${job.state === 'failed' ? 'failed' : 'expired'}`, text: job.error ?? 'Try again, or narrow the filters.' });
    } else {
      setNotice({ tone: 'success', title: `Export ${job.ref} started`, text: 'The file is still being prepared. Check again in a minute; the export is recorded in Action history.' });
    }
  };

  const staffOptions = [{ value: '', label: 'All staff' }, ...[...names].map(([id, name]) => ({ value: id, label: name }))];
  if (staff && !names.has(staff)) staffOptions.push({ value: staff, label: 'Selected staff member' });

  const targetCell = (e: Entry): ReactNode => {
    const m = targetMeta(e.target.type);
    const to = targetHref(e.target, screenHref);
    const ref = e.target.ref ?? e.target.id.slice(0, 8);
    return (
      <span className="stack gap-0">
        <span className="row gap-1 nowrap xs muted">
          <Icon name={m.icon} className="ic-sm" />
          {m.label}
        </span>
        {to ? (
          <Link className="mono nowrap" to={to} title={ref}>
            {ref}
          </Link>
        ) : (
          <span className="mono nowrap">{ref}</span>
        )}
        {e.target.label && <span className="xs muted">{e.target.label}</span>}
      </span>
    );
  };

  if (!canView) {
    return (
      <AdminLayout active="audit">
        <div className="page-head">
          <div className="t">
            <Breadcrumbs items={[{ label: 'Reports and settings' }, { label: 'Action history' }]} />
            <h1 className="h1">Action history</h1>
          </div>
        </div>
        <Alert tone="info" title="You don’t have access to Action history">
          Reading the action history needs the “View entries” permission.
        </Alert>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout active="audit">
      <div className="page-head">
        <div className="t">
          <Breadcrumbs items={[{ label: 'Reports and settings' }, { label: 'Action history' }]} />
          <h1 className="h1">Action history</h1>
          <p className="sub small">Every material change with its reason and approvals. Records cannot be edited or deleted.</p>
        </div>
        <div className="actions">
          {canExport ? (
            <Button variant="secondary" size="sm" icon="download" onClick={() => void startExport()} disabled={exp.busy} aria-busy={exp.busy || undefined}>
              {exp.busy ? 'Preparing export…' : 'Export CSV'}
            </Button>
          ) : (
            <Button variant="secondary" size="sm" icon="download" disabled title="Exporting needs the “Export entries” permission">
              Export CSV
            </Button>
          )}
        </div>
      </div>
      {!!exp.error && (
        <Alert tone="danger" title="The export wasn’t started">
          {errorMessage(exp.error)}
        </Alert>
      )}
      {notice && (
        <Alert tone={notice.tone} title={notice.title}>
          {notice.text}{' '}
          {exp.job && (exp.job.state === 'ready' || exp.job.state === 'queued' || exp.job.state === 'running') && (
            <Button variant="link" size="sm" onClick={() => void exp.redownload(exp.job!.id).then(() => undefined)}>
              {exp.job.state === 'ready' ? 'Download again' : 'Check again'}
            </Button>
          )}
        </Alert>
      )}

      <div className="toolbar">
        <SearchInput id="au-q" placeholder="Search by order, seller, SKU, payout or staff" value={q} onChange={setQ} />
        <label className="sr-only" htmlFor="au-staff">
          Staff
        </label>
        <Select id="au-staff" options={staffOptions} value={staff} onChange={(e) => setStaff(e.target.value)} />
        <label className="sr-only" htmlFor="au-target">
          Target
        </label>
        <Select id="au-target" options={TARGET_FILTERS.map((t) => t.label)} value={target} onChange={(e) => setTarget(e.target.value)} />
        <label className="sr-only" htmlFor="au-range">
          Date range
        </label>
        <Select id="au-range" options={RANGES} value={range} onChange={(e) => setRange(e.target.value)} />
      </div>
      <ChipRow>
        {CHIPS.map((c) => (
          <Chip key={c.key} icon={c.icon} active={chips.includes(c.key)} onClick={() => toggleChip(c.key)}>
            {c.label}
          </Chip>
        ))}
      </ChipRow>

      <div className="ac-main">
        <section className="card">
          <div className="card-head">
            <div className="stack gap-0">
              <h2 className="h4">Actions</h2>
              <span className="xs muted">
                {listQ.isPending ? 'Loading…' : `${total.toLocaleString('en-US')} action${total === 1 ? '' : 's'}${range === 'All time' ? '' : ` in the ${range.toLowerCase()}`} · showing ${rows.length}`}
              </span>
            </div>
          </div>
          {listQ.isError ? (
            <div className="card-body">
              <LoadError error={listQ.error} onRetry={() => void listQ.refetch()} />
            </div>
          ) : (
            <>
              <div className="no-phone">
                <TableWrap label="Actions table">
                  <table className="table">
                    <thead>
                      <tr>
                        <th scope="col">Time</th>
                        <th scope="col">Staff and role</th>
                        <th scope="col">Action</th>
                        <th scope="col">Target</th>
                        <th scope="col">Reason</th>
                        <th scope="col">Before → after</th>
                        <th className="col-pin" scope="col">
                          Approval
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {listQ.isPending &&
                        Array.from({ length: 5 }, (_, i) => (
                          <tr key={i} aria-hidden="true">
                            {Array.from({ length: 7 }, (_, j) => (
                              <td key={j}>
                                <span className="sk sk-line" />
                              </td>
                            ))}
                          </tr>
                        ))}
                      {rows.map((e) => {
                        const warn = isPending(e);
                        const who = actorLabel(e.actor);
                        return (
                          <tr key={e.id} className={cx(warn && 'is-warn', e.id === sel?.id && 'is-selected')} aria-selected={e.id === sel?.id}>
                            <td>
                              {warn && <span className="sr-only">At risk: </span>}
                              <Link className="small nowrap" to={entryHref(e)} title={`Open full entry ${e.id}`}>
                                {dateTime(e.at)}
                              </Link>
                            </td>
                            <td>
                              <span className="ac-who">
                                <Avatar name={who} className="ac-av" />
                                <span className="stack gap-0">
                                  <span className="small strong nowrap">{who}</span>
                                  <span className="xs muted nowrap">{rolesLabel(e)}</span>
                                </span>
                              </span>
                            </td>
                            <td>
                              <button type="button" className="btn-bare tight small strong" onClick={() => setSelId(e.id)}>
                                {e.actionLabel}
                              </button>
                            </td>
                            <td>{targetCell(e)}</td>
                            <td>
                              <span className="small minw-200 cell-text">{e.reason ?? '—'}</span>
                            </td>
                            <td>
                              <Change e={e} />
                            </td>
                            <td className="col-pin">
                              <span className="stack gap-1 items-start">
                                <StatusBadge status={APPROVAL_LABEL[e.approval.state]} />
                                {e.approval.note && <span className="xs muted nowrap">{e.approval.note}</span>}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                      {listQ.isSuccess && rows.length === 0 && (
                        <tr>
                          <td colSpan={7} className="muted">
                            No actions match these filters.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </TableWrap>
                <p className="status-legend status-legend--edge">
                  <span className="sr-only">Legend: </span>
                  <span className="sl sl-warning">
                    <i aria-hidden="true" />
                    Amber edge = at risk: due soon or near target
                  </span>
                </p>
              </div>
              <div className="ac-mlist only-phone">
                {listQ.isPending && <SkeletonLines rows={4} />}
                {rows.map((e) => (
                  <div key={e.id} className={cx('ac-mi', isPending(e) && 'is-warn')} onClick={() => navigate(entryHref(e))}>
                    {isPending(e) && <span className="sr-only">At risk: </span>}
                    <div className="row between gap-2 nowrap top">
                      <Link className="small strong min-w-0" to={entryHref(e)} onClick={(ev) => ev.stopPropagation()}>
                        {e.actionLabel}
                      </Link>
                      <StatusBadge status={APPROVAL_LABEL[e.approval.state]} />
                    </div>
                    <div className="xs sub">
                      {dateTime(e.at)} · {actorLabel(e.actor)}, {rolesLabel(e)}
                    </div>
                    <div className="xs sub">
                      {targetMeta(e.target.type).label} <span className="mono">{e.target.ref ?? e.target.id.slice(0, 8)}</span>
                      {e.reason ? ` · ${e.reason}` : ''}
                    </div>
                    <div className="xs sub">
                      <Change e={e} />
                    </div>
                  </div>
                ))}
                {listQ.isSuccess && rows.length === 0 && <div className="ac-mi small muted">No actions match these filters.</div>}
              </div>
              <p className="status-legend status-legend--edge only-phone">
                <span className="sr-only">Legend: </span>
                <span className="sl sl-warning">
                  <i aria-hidden="true" />
                  Amber edge = at risk: due soon or near target
                </span>
              </p>
            </>
          )}
          <div className="card-foot between">
            <span className="xs muted">{retentionQ.data ? `Retention: ${retentionQ.data.retainYears} years` : 'Retention: …'}</span>
            {totalPages > 1 && <Pager page={page} total={totalPages} onPage={setPage} only="website" />}
          </div>
        </section>

        {sel ? (
          <Card
            title={sel.actionLabel}
            titleAs="h3"
            sub={`${dateTime(sel.at)} · selected entry`}
            actions={
              <Button variant="secondary" size="sm" iconRight="arrow-right" to={entryHref(sel)}>
                Open full entry
              </Button>
            }
          >
            <KeyValue
              pairs={[
                ['Staff', `${actorLabel(sel.actor)}, ${rolesLabel(sel)}`],
                ['Target', targetCell(sel)],
                ['Change', <Change e={sel} />],
                ['Reason', sel.reason ?? 'No reason recorded'],
                ...(sel.requestId ? ([['Request ID', <span className="mono">{sel.requestId}</span>]] as Array<[ReactNode, ReactNode]>) : []),
              ]}
            />
            <div className="divider" />
            <span className="small strong">Approval history</span>
            <Timeline events={approvalSteps(sel, dateTime)} />
          </Card>
        ) : (
          <Card title="Selected entry" titleAs="h3">
            {listQ.isPending ? <SkeletonLines rows={4} /> : <span className="small muted">Choose an action to see its details.</span>}
          </Card>
        )}
      </div>
    </AdminLayout>
  );
}
