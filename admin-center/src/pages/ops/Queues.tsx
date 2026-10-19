import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Link } from 'react-router';
import { call, errorMessage, useApi, ApiError } from '@marketly/web-shared/api';
import { isoInText } from '@marketly/web-shared/lib/format';
import { OpsLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { href } from '@marketly/web-shared/routes';
import { Alert, Badge, Button, Card, Field, Icon, IconButton, Meter, PageHeader, SegmentedControl, Stat, TableWrap, Textarea, announce } from '@marketly/web-shared/ui';
import { LoadError, SkeletonLines, longDate, screenHref, time } from '@/app/parts';
import { useStaffSession } from '@/app/session';
import { EmptyRow, OpsLegend, SkeletonRows, humanize, staffName, type StaffRef } from './data/shared';
import { QueuePeopleDialog, RoutineDoneDialog, WorkItemsCard, type ItemScope } from './QueueWork';

// Design: pages/ops/ops-queues.html (single view).
// API: GET workqueues/me (stats, queues, reminders and today's day-end review; all=true lists every queue for
// callers with workqueues.items.view-all), GET workqueues/routines/today (the whole team's routine: /me only
// carries the checks the caller owns), POST workqueues/day-end-reviews, GET/POST workqueues/saved-filters,
// GET warehouse/summary (ship today), POST workqueues/items/exports.
// Added without a design (QueueWork.tsx): the work items list and drawer (claim, start, wait, resolve, dismiss…),
// New task, queue lead/backup edit (PATCH workqueues/queues/{key}) and routine "Mark done"
// (POST workqueues/routine-checks/{id}/complete).

interface Oldest {
  ref?: string | null;
  subjectRef?: string | null;
  ageLabel?: string | null;
}
interface QueueRow {
  key: string;
  name: string;
  lead: StaffRef;
  backup: StaffRef;
  escalationLabel: string;
  open: number;
  overdue: number;
  oldest: Oldest | null;
  mine: boolean;
  screen: string;
  screenFilter: string | null;
}
interface RoutineCheck {
  id: string;
  title: string;
  areaLabel: string;
  owner: StaffRef;
  dueAt: string;
  state: 'not_done' | 'in_progress' | 'done' | 'late';
  doneAt: string | null;
  doneBy: StaffRef | null;
  checkedIn: { done: number; total: number } | null;
}
interface RoutineDay {
  date: string;
  checks: RoutineCheck[];
  done: number;
  total: number;
}
interface DayEndItem {
  key: string;
  title: string;
  summary: string;
  owner: StaffRef | null;
  link: { screen?: string; state?: string | null } | null;
  checked: boolean;
}
interface DayEndReview {
  id: string;
  dueAt: string;
  state: 'open' | 'completed' | 'missed';
  sharedWithRoles: string[];
  items: DayEndItem[];
  completedAt: string | null;
}
interface SavedFilter {
  id: string;
  name: string;
  owner: StaffRef;
  shared: boolean;
  target: 'work_items' | 'screen';
  screen: string | null;
  screenState: string | null;
  count: number | null;
}
interface MyQueues {
  me: { staffId: string; name: string; roles: string[] };
  stats: { assignedToMe: number; queuesILead: number; overdue: number; overdueChangeVsYesterday: number; oldestOpen: Oldest | null };
  queues: QueueRow[];
  dayEnd: DayEndReview | null;
  reminders: string[];
}
interface WarehouseSummary {
  shipToday: number;
  nextCarrierPickupAt: string | null;
}

/** Thrown when day-end items need a note before the summary can go out (the note fields appear inline). */
const NEEDS_NOTE = new Error('Add a note for the items with overdue work');

const queueLink = (q: { screen?: string | null; screenFilter?: string | null }) => screenHref(q.screen, q.screenFilter) ?? href('ops/queues');

export default function Queues() {
  const { api } = useApi();
  const qc = useQueryClient();
  const staff = useStaffSession();
  const [scope, setScope] = useState<'mine' | 'all'>('all');
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [needNote, setNeedNote] = useState<string[]>([]);
  const [exported, setExported] = useState(false);
  const dayEndRef = useRef<HTMLElement>(null);
  const [itemScope, setItemScope] = useState<ItemScope>({ mode: 'mine', queueKey: '' });
  const [editQueue, setEditQueue] = useState<string | null>(null);
  const [doneCheck, setDoneCheck] = useState<RoutineCheck | null>(null);

  // Stats and rows follow the tab: all=true widens both to every queue (the server keeps the caller's own when they lack view-all).
  const me = useQuery({
    queryKey: ['workqueues', 'me', scope],
    queryFn: () => call(api.GET('/api/admin/workqueues/me', { params: { query: scope === 'all' ? { all: true } : {} } } as never)) as Promise<MyQueues>,
    placeholderData: (prev) => prev,
  });
  const routine = useQuery({ queryKey: ['workqueues', 'routine'], queryFn: () => call(api.GET('/api/admin/workqueues/routines/today')) as Promise<RoutineDay> });
  const saved = useQuery({ queryKey: ['workqueues', 'saved-filters'], queryFn: () => call(api.GET('/api/admin/workqueues/saved-filters')) as Promise<SavedFilter[]> });
  const wh = useQuery({ queryKey: ['warehouse', 'summary'], queryFn: () => call(api.GET('/api/admin/warehouse/summary', { params: { query: {} } })) as Promise<WarehouseSummary>, enabled: staff.can('warehouse.view'), retry: false });

  const rows = me.isPlaceholderData ? [] : (me.data?.queues ?? []);
  const rowsLoading = me.isPending || me.isPlaceholderData;
  const rowsError = me.error;
  const checks = routine.data?.checks ?? [];
  const routineDone = routine.data?.done ?? 0;
  const routineTotal = routine.data?.total ?? 0;
  const review = me.data?.dayEnd ?? null;
  const filters = saved.data ?? [];
  const sharedBy = [...new Set(filters.filter((f) => f.shared && f.owner?.staffId !== staff.accountId).map((f) => staffName(f.owner)))];
  const stats = me.data?.stats;
  const canRunDayEnd = staff.can('workqueues.day-end.run');
  const canWork = staff.can('workqueues.items.work');
  const canManageQueues = staff.can('workqueues.queues.manage');

  /** Show a queue's items (or mine) in the Work items card and bring it into view. */
  const showItems = (s: ItemScope) => {
    setItemScope(s);
    document.getElementById('work-items')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const exportItems = useMutation({
    mutationFn: () => call(api.POST('/api/admin/workqueues/items/exports', { body: { filters: scope === 'mine' ? { mine: true } : {}, format: 'csv' } as never })),
    onSuccess: () => {
      setExported(true);
      announce('Export started. You’ll get a notice when the file is ready.');
    },
  });

  const sendSummary = useMutation({
    mutationFn: async () => {
      if (!review) return;
      const missing: string[] = [];
      for (const item of review.items.filter((i) => !i.checked)) {
        try {
          await call(api.POST('/api/admin/workqueues/day-end-reviews/{id}/items/{itemKey}/check', { params: { path: { id: review.id, itemKey: item.key } }, body: notes[item.key]?.trim() ? { note: notes[item.key].trim() } : {} }));
        } catch (e) {
          if (e instanceof ApiError && e.code === 'NOTE_REQUIRED') missing.push(item.key);
          else throw e;
        }
      }
      setNeedNote(missing);
      if (missing.length) throw NEEDS_NOTE;
      await call(api.POST('/api/admin/workqueues/day-end-reviews/{id}/complete', { params: { path: { id: review.id } }, body: {} }));
    },
    onSuccess: () => announce('Day-end summary sent to managers'),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['workqueues'] });
      void qc.invalidateQueries({ queryKey: ['notifications', 'summary', 'staff'] });
    },
  });

  const saveFilter = useMutation({
    mutationFn: () =>
      call(
        api.POST('/api/admin/workqueues/saved-filters', {
          body: { name: scope === 'mine' ? 'My queues' : 'All queues', target: 'screen', screen: 'ops/queues', screenState: scope, filters: { scope } } as never,
        }),
      ),
    onSuccess: () => {
      announce(`Saved filter: ${scope === 'mine' ? 'My queues' : 'All queues'}`);
      void qc.invalidateQueries({ queryKey: ['workqueues', 'saved-filters'] });
    },
  });

  const startReview = () => {
    const el = dayEndRef.current;
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    el?.querySelector<HTMLElement>('.card-body a')?.focus({ preventScroll: true });
  };

  const now = new Date().toISOString();
  const sub = [staff.name || me.data?.me.name, staff.roles.join(' and '), longDate(now), `${time(now)} PT`].filter(Boolean).join(' · ');
  const change = stats?.overdueChangeVsYesterday ?? 0;
  const sendError = sendSummary.error && sendSummary.error !== NEEDS_NOTE ? sendSummary.error : null;

  return (
    <OpsLayout active="queues">
      <PageHeader
        title="My work queues"
        sub={sub}
        actions={
          <>
            {staff.can('workqueues.items.export') && (
              <Button variant="secondary" size="sm" icon={exported ? 'check' : 'download'} onClick={() => exportItems.mutate()} disabled={exportItems.isPending || exported}>
                {exported ? 'Export started' : 'Export'}
              </Button>
            )}
            <Button size="sm" icon="clipboard-check" onClick={startReview}>
              Start day-end review
            </Button>
          </>
        }
      />
      {exportItems.error && <Alert tone="danger">{errorMessage(exportItems.error)}</Alert>}
      {me.error ? (
        <LoadError error={me.error} onRetry={() => void me.refetch()} />
      ) : (
        <div className="ac-kpis">
          <div className="card pad">
            {stats ? (
              <>
                <Stat label="Assigned to me" value={String(stats.assignedToMe)} note={`${stats.queuesILead} ${stats.queuesILead === 1 ? 'queue' : 'queues'} where I lead`} />
                <Button variant="link" size="sm" onClick={() => showItems({ mode: 'mine', queueKey: '' })}>
                  Show my items
                </Button>
              </>
            ) : (
              <span className="sk sk-line" />
            )}
          </div>
          <div className="card pad">
            {/* Design: a rise in overdue items is bad, so the arrow points up with the "down bad" colour. */}
            {stats ? (
              <div className="stat">
                <span className="k">Overdue</span>
                <span className="v">{stats.overdue}</span>
                {change !== 0 ? (
                  <span className={cx('d', change > 0 ? 'down bad' : 'up good')}>
                    <span aria-hidden="true">{change > 0 ? '▲ ' : '▼ '}</span>
                    <span className="sr-only">{change > 0 ? 'up ' : 'down '}</span>
                    {Math.abs(change)} {change > 0 ? 'more' : 'fewer'} than yesterday
                  </span>
                ) : (
                  <span className="d">Same as yesterday</span>
                )}
              </div>
            ) : (
              <span className="sk sk-line" />
            )}
          </div>
          <div className="card pad">
            {stats ? <Stat label="Oldest open item" value={stats.oldestOpen?.ageLabel?.split(' · ').pop() ?? 'None'} note={stats.oldestOpen ? (stats.oldestOpen.subjectRef ?? stats.oldestOpen.ref ?? '') : 'Nothing open'} /> : <span className="sk sk-line" />}
          </div>
          <div className="card pad">
            {wh.data ? (
              <Stat label="Ship today, Official Store" value={String(wh.data.shipToday)} note={wh.data.nextCarrierPickupAt ? `Carrier pickup ${time(wh.data.nextCarrierPickupAt)}` : 'No pickup booked'} />
            ) : wh.isPending && staff.can('warehouse.view') ? (
              <span className="sk sk-line" />
            ) : (
              <Stat label="Ship today, Official Store" value="—" note={staff.can('warehouse.view') ? 'Not available' : 'Warehouse access needed'} />
            )}
          </div>
        </div>
      )}
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
            {rowsError ? (
              <div className="card-body">
                <LoadError error={rowsError} onRetry={() => void me.refetch()} />
              </div>
            ) : (
              <>
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
                        {rowsLoading && <SkeletonRows cols={8} />}
                        {!rowsLoading && !rows.length && <EmptyRow cols={8}>{scope === 'mine' ? 'You don’t lead or back up any queue yet.' : 'No work queues are set up.'}</EmptyRow>}
                        {rows.map((q) => {
                          const to = queueLink(q);
                          const oldest = q.oldest?.ageLabel ?? '—';
                          return (
                            <tr key={q.key} className={cx(q.overdue > 0 && 'is-flagged')}>
                              <td className="cell-name">
                                {q.overdue > 0 && <span className="sr-only">Urgent: </span>}
                                <span className="row gap-2 nowrap">
                                  <Link className="small strong ellip" to={to} title={q.name}>
                                    {q.name}
                                  </Link>
                                  {q.mine && <Badge tone="brand">Mine</Badge>}
                                </span>
                              </td>
                              <td className="cell-name">
                                <span className="small nowrap ellip" title={staffName(q.lead)}>
                                  {staffName(q.lead)}
                                </span>
                              </td>
                              <td className="cell-name">
                                <span className="small nowrap ellip" title={staffName(q.backup)}>
                                  {staffName(q.backup)}
                                </span>
                              </td>
                              <td className="cell-name">
                                <span className="xs sub ellip" title={q.escalationLabel}>
                                  {q.escalationLabel}
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
                                <span className="xs mono nowrap" title={oldest}>
                                  {oldest}
                                </span>
                              </td>
                              <td className="col-pin">
                                <span className="row gap-1 nowrap">
                                  <Button variant="ghost" size="sm" onClick={() => showItems({ mode: 'queue', queueKey: q.key })}>
                                    Items<span className="sr-only"> in {q.name}</span>
                                  </Button>
                                  <Link className="btn btn-ghost btn-sm" to={to}>
                                    <span>Open</span>
                                    <span className="sr-only"> {q.name}</span>
                                  </Link>
                                  {canManageQueues && <IconButton icon="pencil" size="sm" label={`Change lead and backup of ${q.name}`} onClick={() => setEditQueue(q.key)} />}
                                </span>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </TableWrap>
                  <OpsLegend items={[{ tone: 'danger', label: 'Red edge = urgent: overdue or past target' }]} />
                </div>
                <div className="ac-mlist only-phone">
                  {rowsLoading && <SkeletonLines rows={4} />}
                  {!rowsLoading && !rows.length && <div className="ac-mi xs sub">{scope === 'mine' ? 'You don’t lead or back up any queue yet.' : 'No work queues are set up.'}</div>}
                  {rows.map((q) => (
                    <div key={q.key} className={cx('ac-mi', q.overdue > 0 && 'is-flagged')}>
                      {q.overdue > 0 && <span className="sr-only">Urgent: </span>}
                      <div className="row between gap-2 nowrap top">
                        <span className="small strong min-w-0">
                          <Link to={queueLink(q)}>{q.name}</Link>
                        </span>
                        <span className="row gap-1 nowrap">
                          <Badge>{q.open} open</Badge>
                          {q.overdue > 0 && <Badge tone="danger">{q.overdue} overdue</Badge>}
                        </span>
                      </div>
                      <div className="xs sub">
                        Lead {staffName(q.lead)} · backup {staffName(q.backup)}
                      </div>
                      <div className="xs sub">Escalates to {q.escalationLabel}</div>
                      <div className="xs sub">
                        Oldest: <span className="mono">{q.oldest?.ageLabel ?? '—'}</span>
                      </div>
                      <div className="row gap-2">
                        <Button variant="ghost" size="sm" onClick={() => showItems({ mode: 'queue', queueKey: q.key })}>
                          Items<span className="sr-only"> in {q.name}</span>
                        </Button>
                        {canManageQueues && (
                          <Button variant="ghost" size="sm" icon="pencil" onClick={() => setEditQueue(q.key)}>
                            Lead and backup<span className="sr-only"> of {q.name}</span>
                          </Button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
                <OpsLegend className="only-phone" items={[{ tone: 'danger', label: 'Red edge = urgent: overdue or past target' }]} />
              </>
            )}
          </Card>
          <WorkItemsCard id="work-items" scope={itemScope} onScope={setItemScope} />
          <section className="card" ref={dayEndRef}>
            <div className="card-head">
              <div className="stack gap-0">
                <h3 className="h4">Day-end review</h3>
                <span className="xs muted">
                  {review ? `Due ${time(review.dueAt)} PT · shared with ${review.sharedWithRoles.length ? review.sharedWithRoles.map(humanize).join(', ').toLowerCase() : 'all queue leads'}` : 'Built each afternoon from open work'}
                </span>
              </div>
              {review && (
                <div className="row gap-2">
                  {canRunDayEnd ? (
                    <Button variant="secondary" size="sm" icon={review.state === 'completed' ? 'check' : 'send'} onClick={() => sendSummary.mutate()} disabled={review.state !== 'open' || sendSummary.isPending}>
                      {review.state === 'completed' ? 'Summary sent' : review.state === 'missed' ? 'Review missed' : sendSummary.isPending ? 'Sending…' : 'Send summary to managers'}
                    </Button>
                  ) : (
                    <span className="xs muted">Queue leads send the summary</span>
                  )}
                </div>
              )}
            </div>
            <div className="card-body">
              {me.error ? (
                <LoadError error={me.error} onRetry={() => void me.refetch()} />
              ) : me.isPending ? (
                <SkeletonLines rows={4} />
              ) : !review ? (
                <p className="small muted">Today’s day-end review isn’t ready yet. It’s prepared at 3:00 PM PT.</p>
              ) : (
                <>
                  {sendError && <Alert tone="danger">{errorMessage(sendError)}</Alert>}
                  {needNote.length > 0 && <Alert tone="warning">Some items still have overdue work. Add a note with the plan, then send the summary again.</Alert>}
                  <ul>
                    {review.items.map((c) => {
                      const to = screenHref(c.link?.screen, c.link?.state ?? undefined) ?? href('ops/queues');
                      return (
                        <li key={c.key} className={cx('ac-ck', c.checked && 'is-done')}>
                          <span className="ic" aria-hidden="true">
                            {c.checked && <Icon name="check" />}
                          </span>
                          <span className="stack gap-0 grow">
                            <span className="small strong">{c.title}</span>
                            <span className="xs muted">
                              {isoInText(c.summary)}
                              {c.owner && staffName(c.owner, '') ? ` · owner ${staffName(c.owner)}` : ''}
                            </span>
                            {needNote.includes(c.key) && (
                              <Field label={`Plan for ${c.title.toLowerCase()}`}>
                                <Textarea id={`note-${c.key}`} rows={2} value={notes[c.key] ?? ''} onChange={(e) => setNotes((n) => ({ ...n, [c.key]: e.target.value }))} />
                              </Field>
                            )}
                          </span>
                          <Link className="small strong nowrap" to={to}>
                            Review
                          </Link>
                          <span className="sr-only">{c.checked ? 'Done' : 'Not done'}</span>
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}
            </div>
          </section>
        </div>
        <div className="stack gap-5">
          <Card title="Today's routine" titleAs="h3" sub={routine.data ? `${routineDone} of ${routineTotal} reviews done` : 'Loading…'}>
            {routine.error ? (
              <LoadError error={routine.error} onRetry={() => void routine.refetch()} />
            ) : routine.isPending ? (
              <SkeletonLines rows={5} />
            ) : !checks.length ? (
              <p className="small muted">No routine checks are scheduled today.</p>
            ) : (
              <>
                <Meter pct={routineTotal ? Math.round((routineDone / routineTotal) * 100) : 0} label="Today's routine" />
                <ul>
                  {checks.map((r) => {
                    const state = r.state === 'done' ? 'done' : r.state === 'late' ? 'late' : r.state === 'in_progress' ? 'now' : '';
                    const owner = staffName(r.doneBy ?? r.owner, '');
                    const when =
                      r.state === 'done' && r.doneAt
                        ? `done ${time(r.doneAt)}`
                        : r.checkedIn
                          ? `${r.checkedIn.done} of ${r.checkedIn.total} checked in`
                          : r.state === 'late'
                            ? `was due ${time(r.dueAt)}`
                            : `due ${time(r.dueAt)}`;
                    return (
                      <li key={r.id} className={cx('ac-ck', state && `is-${state}`)}>
                        <span className="ic" aria-hidden="true">
                          {state === 'done' && <Icon name="check" />}
                          {state === 'late' && <Icon name="alarm-clock" />}
                        </span>
                        <span className="stack gap-0 grow">
                          <span className="small strong">{r.title}</span>
                          <span className="xs muted">{[r.areaLabel, owner && owner !== 'Not set' ? owner : '', when].filter(Boolean).join(' · ')}</span>
                        </span>
                        <span className="sr-only">{state === 'done' ? 'Done' : state === 'late' ? 'Overdue' : 'Not done'}</span>
                        {canWork && r.state !== 'done' && (
                          <Button variant="ghost" size="sm" className="nowrap" onClick={() => setDoneCheck(r)}>
                            {r.checkedIn ? 'Check in' : 'Mark done'}
                            <span className="sr-only">: {r.title}</span>
                          </Button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </Card>
          <Card
            title="Saved filters"
            titleAs="h3"
            sub={sharedBy.length ? `Your filters, plus ${filters.filter((f) => f.shared && f.owner?.staffId !== staff.accountId).length} shared by ${sharedBy.join(', ')}` : 'Your filters'}
            foot={
              <>
                <Button variant="ghost" size="sm" icon="plus" onClick={() => saveFilter.mutate()} disabled={saveFilter.isPending || filters.some((f) => f.screen === 'ops/queues' && f.screenState === scope)}>
                  Save current filter
                </Button>
                {saveFilter.error && <span className="xs t-danger">{errorMessage(saveFilter.error)}</span>}
              </>
            }
          >
            {saved.error ? (
              <LoadError error={saved.error} onRetry={() => void saved.refetch()} />
            ) : saved.isPending ? (
              <SkeletonLines rows={3} />
            ) : !filters.length ? (
              <p className="small muted">No saved filters yet. Save the view you use most to come back to it.</p>
            ) : (
              <ul className="list">
                {filters.map((s) => (
                  <li key={s.id}>
                    <Icon name="bookmark" className="ic-sm" />
                    <Link className="small grow" to={s.target === 'screen' ? (screenHref(s.screen, s.screenState) ?? href('ops/queues')) : href('ops/queues')}>
                      {s.name}
                      {s.shared && s.owner?.staffId !== staff.accountId ? ' (shared)' : ''}
                    </Link>
                    {s.count != null && <Badge>{s.count}</Badge>}
                  </li>
                ))}
              </ul>
            )}
          </Card>
          {!!me.data?.reminders.length && (
            <Alert tone="info" title="Escalation reminder">
              {me.data.reminders.join(' ')}
            </Alert>
          )}
        </div>
      </div>
      <QueuePeopleDialog queueKey={editQueue} onClose={() => setEditQueue(null)} />
      <RoutineDoneDialog check={doneCheck} onClose={() => setDoneCheck(null)} />
    </OpsLayout>
  );
}
