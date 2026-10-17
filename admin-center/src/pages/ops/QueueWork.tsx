// Work items, queue lead/backup and routine "mark done" for Ops › My work queues (pages/ops/Queues.tsx).
// No design: built from the workqueues API with the page's existing components and classes.
// API: GET/POST workqueues/items, GET items/{id}, POST items/{id}/claim|start|wait|resume|resolve|dismiss|reopen|
// escalate|assign|notes, POST items/bulk-assign, GET/PATCH workqueues/queues/{key}, POST routine-checks/{id}/complete,
// GET access/members (pickers; needs access.roles.view).
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { errorMessage } from '@marketly/web-shared/api';
import { cx } from '@marketly/web-shared/lib/cx';
import { Alert, Badge, Button, Card, Deadline, Dialog, Drawer, Field, KeyValue, Pager, SegmentedControl, Select, TableWrap, Textarea, TextInput, Timeline, announce } from '@marketly/web-shared/ui';
import { LoadError, SkeletonLines, dateTime, deadlineLabel, deadlineTone } from '@/app/parts';
import { useStaffSession } from '@/app/session';
import { EmptyRow, OpsLegend, SkeletonRows, humanize, staffName } from './data/shared';
import {
  ACTION_DONE,
  DISMISS_REASONS,
  PRIORITIES,
  STATE_FILTERS,
  STATE_LABEL,
  STATE_TONE,
  WAITING_ON,
  allowedActions,
  assigneeOptions,
  isActive,
  itemLinks,
  localIn,
  localToIso,
  subjectText,
  useBulkAssign,
  useCompleteCheck,
  useCreateTask,
  useItemAction,
  useQueueDefinition,
  useQueueList,
  useStaffPeople,
  useUpdateQueuePeople,
  useWorkItem,
  useWorkItems,
  type ItemAction,
  type Priority,
  type Resolution,
  type StateFilter,
  type WaitingOn,
  type WorkItem,
} from './data/work-items';

/** Which items the card lists: the caller's own, or one queue (empty key = every queue the caller may see). */
export interface ItemScope {
  mode: 'mine' | 'queue';
  queueKey: string;
}

const AUTO_CLOSE = 'Most items close by themselves when the work is done on the linked screen (a shipment dispatched, a case answered). Resolve or dismiss by hand only manual tasks, work fixed somewhere else, or false alarms.';

/** Due or closed label for an item row. */
function DueCell({ it }: { it: WorkItem }) {
  if (!isActive(it.state)) return <span className="xs muted nowrap">Closed {it.resolvedAt ? dateTime(it.resolvedAt) : ''}</span>;
  return <Deadline tone={deadlineTone(it.deadline.state)}>{deadlineLabel(it.deadline.dueAt)}</Deadline>;
}

function SourceLink({ it }: { it: WorkItem }) {
  const link = itemLinks(it)[0];
  return link ? (
    <Link className="small nowrap" to={link.to}>
      {link.label}
    </Link>
  ) : (
    <span className="xs muted">{it.kind === 'manual_task' ? 'Manual task' : '—'}</span>
  );
}

/* ================================================================ items card */

export function WorkItemsCard({ scope, onScope, id }: { scope: ItemScope; onScope: (s: ItemScope) => void; id?: string }) {
  const staff = useStaffSession();
  const [state, setState] = useState<StateFilter>('active');
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<string | null>(null);
  const [newTask, setNewTask] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkTo, setBulkTo] = useState('');
  const queues = useQueueList();
  const canWork = staff.can('workqueues.items.work');
  const canBulk = staff.can('workqueues.items.assign-others');
  const people = useStaffPeople(canBulk);
  const bulk = useBulkAssign();

  // A new scope or state starts again at page 1 with nothing selected.
  useEffect(() => {
    setPage(1);
    setSelected(new Set());
  }, [scope.mode, scope.queueKey, state]);

  const list = useWorkItems({ assignee: scope.mode === 'mine' ? 'me' : undefined, queueKey: scope.mode === 'queue' ? scope.queueKey : undefined, state, page });
  const rows = list.data?.items ?? [];
  const totalPages = list.data?.totalPages ?? 1;
  const loading = list.isPending;
  const bulkOn = canBulk && people.available && isActiveFilter(state);
  const cols = bulkOn ? 7 : 6;
  const queueName = queues.data?.find((q) => q.key === scope.queueKey)?.name;
  const empty = scope.mode === 'mine' ? 'Nothing is assigned to you.' : queueName ? `No items in ${queueName} for this filter.` : 'No items for this filter.';

  const toggle = (itemId: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(itemId)) n.delete(itemId);
      else n.add(itemId);
      return n;
    });
  const doBulk = () =>
    bulk.mutate(
      { itemIds: [...selected], assigneeId: bulkTo },
      {
        onSuccess: (r) => {
          announce(`${r.assigned} assigned${r.skipped.length ? `, ${r.skipped.length} skipped (closed or not eligible)` : ''}`);
          setSelected(new Set());
        },
      },
    );

  return (
    <Card
      id={id}
      title="Work items"
      sub={scope.mode === 'mine' ? 'Assigned to me' : (queueName ?? 'All my queues')}
      flush
      actions={
        canWork && (
          <Button size="sm" variant="secondary" icon="plus" onClick={() => setNewTask(true)}>
            New task
          </Button>
        )
      }
    >
      <div className="card-body stack gap-3">
        <p className="xs muted">{AUTO_CLOSE}</p>
        <div className="toolbar">
          <SegmentedControl
            items={[
              { label: 'Assigned to me', value: 'mine' },
              { label: 'By queue', value: 'queue' },
            ]}
            active={scope.mode}
            onChange={(mode) => onScope({ ...scope, mode })}
          />
          {scope.mode === 'queue' && (
            <Select
              id="wi-queue"
              aria-label="Queue"
              value={scope.queueKey}
              onChange={(e) => onScope({ mode: 'queue', queueKey: e.target.value })}
              options={[{ value: '', label: 'All my queues' }, ...(queues.data ?? []).map((q) => ({ value: q.key, label: `${q.name} (${q.open})` }))]}
            />
          )}
          <Select id="wi-state" aria-label="State" value={state} onChange={(e) => setState(e.target.value as StateFilter)} options={STATE_FILTERS} />
        </div>
        {bulkOn && selected.size > 0 && (
          <div className="bulk-bar">
            <span>{selected.size} selected</span>
            <span className="grow" />
            <label className="sr-only" htmlFor="wi-bulk-to">
              Assign to
            </label>
            <select className="select" id="wi-bulk-to" value={bulkTo} onChange={(e) => setBulkTo(e.target.value)}>
              <option value="">Assign to…</option>
              {people.people.map((p) => (
                <option key={p.staffId} value={p.staffId}>
                  {p.name}
                  {p.roleNames.length ? `, ${p.roleNames.join(', ')}` : ''}
                  {p.away ? ' · away' : ''}
                </option>
              ))}
            </select>
            <Button variant="soft" size="sm" icon="user-check" disabled={!bulkTo || bulk.isPending} onClick={doBulk}>
              Assign
            </Button>
          </div>
        )}
        {bulk.error && <Alert tone="danger">{errorMessage(bulk.error)}</Alert>}
      </div>
      {list.error ? (
        <div className="card-body">
          <LoadError error={list.error} onRetry={() => void list.refetch()} />
        </div>
      ) : (
        <>
          <div className="no-phone">
            <TableWrap label="Work items table">
              <table className="table">
                <thead>
                  <tr>
                    {bulkOn && (
                      <th className="col-check">
                        <span className="sr-only">Select</span>
                      </th>
                    )}
                    <th scope="col">What</th>
                    <th scope="col">Source</th>
                    <th scope="col">Due</th>
                    <th scope="col">Owner</th>
                    <th scope="col">State</th>
                    <th className="col-pin" scope="col">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {loading && <SkeletonRows cols={cols} />}
                  {!loading && !rows.length && <EmptyRow cols={cols}>{empty}</EmptyRow>}
                  {rows.map((it) => (
                    <tr key={it.id} className={cx(isActive(it.state) && it.deadline.state === 'overdue' && 'is-flagged', isActive(it.state) && it.deadline.state === 'due_soon' && 'is-warn')}>
                      {bulkOn && (
                        <td className="col-check">
                          <input type="checkbox" aria-label={`Select ${it.ref}`} checked={selected.has(it.id)} onChange={() => toggle(it.id)} />
                        </td>
                      )}
                      <td className="cell-name">
                        <span className="stack gap-0 min-w-0">
                          <button type="button" className="btn-link small ellip ta-left" title={it.title} onClick={() => setOpenId(it.id)}>
                            {it.title}
                          </button>
                          <span className="xs muted ellip">
                            <span className="mono">{it.ref}</span> · {subjectText(it)}
                            {scope.mode === 'mine' || !scope.queueKey ? ` · ${it.queueName}` : ''}
                          </span>
                        </span>
                      </td>
                      <td>
                        <SourceLink it={it} />
                      </td>
                      <td>
                        <DueCell it={it} />
                      </td>
                      <td className="cell-name">
                        <span className={cx('small nowrap ellip', !it.assignee && 'xs t-warning-text strong')}>{it.assignee ? staffName(it.assignee) : 'Unassigned'}</span>
                      </td>
                      <td>
                        <Badge tone={STATE_TONE[it.state]}>{STATE_LABEL[it.state]}</Badge>
                      </td>
                      <td className="col-pin">
                        <Button variant="ghost" size="sm" onClick={() => setOpenId(it.id)}>
                          Open<span className="sr-only"> {it.ref}</span>
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
            <OpsLegend
              items={[
                { tone: 'danger', label: 'Red edge = overdue' },
                { tone: 'warning', label: 'Amber edge = due soon' },
              ]}
            />
          </div>
          <div className="ac-mlist only-phone">
            {loading && <SkeletonLines rows={4} />}
            {!loading && !rows.length && <div className="ac-mi xs sub">{empty}</div>}
            {rows.map((it) => (
              <div key={it.id} className={cx('ac-mi', isActive(it.state) && it.deadline.state === 'overdue' && 'is-flagged')}>
                <div className="row between gap-2 top">
                  <button type="button" className="btn-link small ta-left min-w-0" onClick={() => setOpenId(it.id)}>
                    {it.title}
                  </button>
                  <Badge tone={STATE_TONE[it.state]}>{STATE_LABEL[it.state]}</Badge>
                </div>
                <div className="xs sub">
                  <span className="mono">{it.ref}</span> · {subjectText(it)} · {it.assignee ? staffName(it.assignee) : 'Unassigned'}
                </div>
                <div className="row between gap-2">
                  <DueCell it={it} />
                  <SourceLink it={it} />
                </div>
              </div>
            ))}
          </div>
          {totalPages > 1 && (
            <div className="card-foot">
              <span className="grow" />
              <Pager page={page} total={totalPages} onPage={setPage} only="website" />
            </div>
          )}
          {totalPages > 1 && (
            <div className="card-body only-phone row between">
              <Button variant="ghost" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                Previous
              </Button>
              <span className="xs muted">
                Page {page} of {totalPages}
              </span>
              <Button variant="ghost" size="sm" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>
                Next
              </Button>
            </div>
          )}
        </>
      )}
      <ItemDrawer id={openId} onClose={() => setOpenId(null)} />
      <NewTaskDialog open={newTask} onClose={() => setNewTask(false)} defaultQueue={scope.mode === 'queue' ? scope.queueKey : ''} onCreated={(it) => setOpenId(it.id)} />
    </Card>
  );
}

const isActiveFilter = (s: StateFilter) => s === 'active' || s === 'open' || s === 'assigned' || s === 'in_progress' || s === 'waiting';

/* ================================================================ item drawer */

type FormKey = 'wait' | 'resolve' | 'dismiss' | 'reopen' | 'escalate' | 'assign';
const FORM_TITLE: Record<FormKey, string> = { wait: 'Waiting on someone', resolve: 'Resolve by hand', dismiss: 'Dismiss', reopen: 'Reopen', escalate: 'Escalate now', assign: 'Assign to a person' };
const FORM_SUBMIT: Record<FormKey, string> = { wait: 'Mark waiting', resolve: 'Resolve', dismiss: 'Dismiss', reopen: 'Reopen', escalate: 'Escalate', assign: 'Assign' };

function ItemDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const staff = useStaffSession();
  const q = useWorkItem(id);
  const it = q.data;
  const act = useItemAction(id ?? '');
  const canWork = staff.can('workqueues.items.work');
  const canAssignOthers = staff.can('workqueues.items.assign-others');
  const people = useStaffPeople(!!id && canAssignOthers);
  const [form, setForm] = useState<FormKey | null>(null);
  const [text, setText] = useState('');
  const [reasonPick, setReasonPick] = useState(DISMISS_REASONS[0]);
  const [waitingOn, setWaitingOn] = useState<WaitingOn>('seller');
  const [followUp, setFollowUp] = useState('');
  const [assignee, setAssignee] = useState('');
  const [note, setNote] = useState('');

  // Each item opens with no form and empty fields.
  useEffect(() => {
    setForm(null);
    setNote('');
    act.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const openForm = (f: FormKey) => {
    setForm(f);
    setText('');
    setReasonPick(DISMISS_REASONS[0]);
    setFollowUp('');
    setAssignee('');
    act.reset();
  };

  const run = (a: ItemAction, after?: () => void) =>
    act.mutate(a, {
      onSuccess: () => {
        announce(`${it?.ref ?? 'Item'}: ${ACTION_DONE[a.kind]}`);
        setForm(null);
        after?.();
      },
    });

  const submitForm = () => {
    if (!form) return;
    const t = text.trim();
    if (form === 'wait') run({ kind: 'wait', waitingOn, note: t, followUpAt: localToIso(followUp) });
    else if (form === 'resolve') run({ kind: 'resolve', note: t });
    else if (form === 'dismiss') run({ kind: 'dismiss', reason: reasonPick === 'Other' ? t : t ? `${reasonPick}: ${t}` : reasonPick });
    else if (form === 'assign') run({ kind: 'assign', assigneeId: assignee, nextAction: t || null });
    else run({ kind: form, reason: t });
  };
  // Resolve, wait, reopen and escalate need words; dismiss has its reason from the pick list unless "Other".
  const formReady = form === 'assign' ? !!assignee : form === 'dismiss' ? reasonPick !== 'Other' || !!text.trim() : !!text.trim();

  const can = it ? allowedActions(it, staff.accountId) : null;
  const resolution = (it?.resolution ?? null) as Resolution | null;
  const links = it ? itemLinks(it) : [];
  const options = it ? assigneeOptions(it, people.people) : [];

  const foot: ReactNode =
    !it || !canWork ? (
      <Button variant="ghost" onClick={onClose}>
        Close
      </Button>
    ) : form ? (
      <>
        <Button variant="ghost" onClick={() => setForm(null)}>
          Back
        </Button>
        <Button variant={form === 'dismiss' ? 'danger-soft' : 'primary'} disabled={!formReady || act.isPending} onClick={submitForm}>
          {act.isPending ? 'Saving…' : FORM_SUBMIT[form]}
        </Button>
      </>
    ) : (
      <div className="row gap-2">
        {can?.claim && (
          <Button size="sm" disabled={act.isPending} onClick={() => run({ kind: 'claim' })}>
            Claim
          </Button>
        )}
        {can?.start && (
          <Button size="sm" icon="play" disabled={act.isPending} onClick={() => run({ kind: 'start' })}>
            Start
          </Button>
        )}
        {can?.resume && (
          <Button size="sm" icon="play" disabled={act.isPending} onClick={() => run({ kind: 'resume' })}>
            Resume
          </Button>
        )}
        {can?.wait && (
          <Button size="sm" variant="secondary" icon="hourglass" onClick={() => openForm('wait')}>
            Wait
          </Button>
        )}
        {can?.resolve && (
          <Button size="sm" variant="secondary" icon="check" onClick={() => openForm('resolve')}>
            Resolve
          </Button>
        )}
        {can?.assign && canAssignOthers && (
          <Button size="sm" variant="secondary" icon="user-check" onClick={() => openForm('assign')}>
            Assign
          </Button>
        )}
        {can?.escalate && (
          <Button size="sm" variant="ghost" icon="arrow-up" onClick={() => openForm('escalate')}>
            Escalate
          </Button>
        )}
        {can?.dismiss && (
          <Button size="sm" variant="ghost" icon="x" onClick={() => openForm('dismiss')}>
            Dismiss
          </Button>
        )}
        {can?.reopen && (
          <Button size="sm" variant="secondary" icon="rotate-ccw" onClick={() => openForm('reopen')}>
            Reopen
          </Button>
        )}
      </div>
    );

  return (
    <Drawer open={!!id} onClose={onClose} title={it ? it.title : 'Work item'} foot={foot}>
      {q.isPending && <SkeletonLines rows={6} />}
      {q.error && <LoadError error={q.error} onRetry={() => void q.refetch()} />}
      {it && (
        <div className="stack gap-4">
          <div className="row gap-2">
            <Badge tone={STATE_TONE[it.state]}>{STATE_LABEL[it.state]}</Badge>
            {it.priority !== 'normal' && <Badge tone={it.priority === 'urgent' ? 'danger' : it.priority === 'high' ? 'warning' : ''}>{humanize(it.priority)} priority</Badge>}
            {it.escalationLevel > 0 && <Badge tone="danger">Escalated{it.escalatedTo ? ` to ${staffName(it.escalatedTo)}` : ''}</Badge>}
            <DueCell it={it} />
          </div>
          {it.summary && <p className="small">{it.summary}</p>}
          {act.error && <Alert tone="danger">{errorMessage(act.error)}</Alert>}
          {form ? (
            <section className="stack gap-3" aria-label={FORM_TITLE[form]}>
              <h3 className="h4">{FORM_TITLE[form]}</h3>
              {form === 'wait' && (
                <>
                  <Field label="Waiting on">
                    <Select id="wi-wait-on" value={waitingOn} onChange={(e) => setWaitingOn(e.target.value as WaitingOn)} options={WAITING_ON} />
                  </Field>
                  <Field label="What you're waiting for">
                    <Textarea id="wi-text" rows={3} value={text} onChange={(e) => setText(e.target.value)} />
                  </Field>
                  <Field label="Follow up on" optional hint="Your computer's local time">
                    <TextInput id="wi-follow" type="datetime-local" value={followUp} onChange={(e) => setFollowUp(e.target.value)} />
                  </Field>
                  <p className="xs muted">The deadline keeps running while waiting unless this queue pauses it.</p>
                </>
              )}
              {form === 'resolve' && (
                <Field label="What was done" hint="Kept on the item and in the action history">
                  <Textarea id="wi-text" rows={3} value={text} onChange={(e) => setText(e.target.value)} />
                </Field>
              )}
              {form === 'dismiss' && (
                <>
                  <Field label="Reason">
                    <Select id="wi-dismiss" value={reasonPick} onChange={(e) => setReasonPick(e.target.value)} options={DISMISS_REASONS} />
                  </Field>
                  <Field label={reasonPick === 'Other' ? 'Say why' : 'Details'} optional={reasonPick !== 'Other'}>
                    <Textarea id="wi-text" rows={2} value={text} onChange={(e) => setText(e.target.value)} />
                  </Field>
                  <p className="xs muted">If the source raises the same problem again later, the item comes back.</p>
                </>
              )}
              {(form === 'reopen' || form === 'escalate') && (
                <Field label="Reason" hint={form === 'escalate' ? 'Sends the item to the next step of the queue’s escalation route' : undefined}>
                  <Textarea id="wi-text" rows={3} value={text} onChange={(e) => setText(e.target.value)} />
                </Field>
              )}
              {form === 'assign' && (
                <>
                  <Field label="Assign to" hint={people.available ? 'People with the queue’s role, its lead and its backup' : 'Only the queue’s lead and backup are listed: the full staff list needs access to Staff and permissions'}>
                    <Select id="wi-assignee" value={assignee} onChange={(e) => setAssignee(e.target.value)} options={[{ value: '', label: 'Choose a person' }, ...options]} />
                  </Field>
                  <Field label="Next action" optional>
                    <TextInput id="wi-text" value={text} onChange={(e) => setText(e.target.value)} />
                  </Field>
                </>
              )}
            </section>
          ) : (
            <>
              {isActive(it.state) && it.kind !== 'manual_task' && <p className="xs muted">This item closes by itself when the work is done on its screen. Resolve it by hand only if it was fixed somewhere else.</p>}
              {links.length > 0 && (
                <div className="row gap-2">
                  {links.map((l) => (
                    <Button key={l.label + l.to} to={l.to} size="sm" variant="secondary" iconRight="arrow-right">
                      {l.label}
                    </Button>
                  ))}
                </div>
              )}
              <KeyValue
                pairs={[
                  ['Reference', <span className="mono">{it.ref}</span>],
                  ['Queue', it.queueName],
                  ['Kind', humanize(it.kind)],
                  ['About', subjectText(it)],
                  ...(it.sellerName ? ([['Seller', it.sellerName]] as Array<[ReactNode, ReactNode]>) : []),
                  ['Owner', it.assignee ? staffName(it.assignee) : 'Unassigned'],
                  ['Lead · backup', `${staffName(it.lead)} · ${staffName(it.backup)}`],
                  ['Due', dateTime(it.deadline.dueAt)],
                  ...(it.waitingOn ? ([['Waiting on', humanize(it.waitingOn)]] as Array<[ReactNode, ReactNode]>) : []),
                  ['Opened', dateTime(it.openedAt)],
                  ...(resolution
                    ? ([['Closed', `${resolution.outcome === 'fixed_at_source' ? 'Fixed at the source' : humanize(resolution.outcome)}${resolution.note ? `: ${resolution.note}` : ''}${resolution.by?.name ? ` (${resolution.by.name})` : ''}`]] as Array<[ReactNode, ReactNode]>)
                    : []),
                ]}
              />
              <section className="stack gap-2" aria-label="Notes">
                <h3 className="h4">Notes</h3>
                {!it.notes.length && <p className="xs muted">No notes yet.</p>}
                {it.notes.map((n) => (
                  <div key={n.id} className="stack gap-0">
                    <span className="small">{n.body}</span>
                    <span className="xs muted">
                      {n.author?.name ?? 'Staff'} · {dateTime(n.at)}
                    </span>
                  </div>
                ))}
                {canWork && (
                  <div className="stack gap-2">
                    <Field label="Add a note">
                      <Textarea id="wi-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
                    </Field>
                    <div>
                      <Button size="sm" variant="secondary" disabled={!note.trim() || act.isPending} onClick={() => run({ kind: 'note', body: note.trim() }, () => setNote(''))}>
                        Add note
                      </Button>
                    </div>
                  </div>
                )}
              </section>
              {it.history.length > 0 && (
                <section className="stack gap-2" aria-label="History">
                  <h3 className="h4">History</h3>
                  <Timeline events={[...it.history].reverse().map((h) => ({ t: h.label, d: `${dateTime(h.at)}${h.actor?.name ? ` · ${h.actor.name}` : ''}`, body: h.detail ?? undefined, state: 'done' as const }))} />
                </section>
              )}
            </>
          )}
        </div>
      )}
    </Drawer>
  );
}

/* ================================================================ new task */

function NewTaskDialog({ open, onClose, defaultQueue, onCreated }: { open: boolean; onClose: () => void; defaultQueue: string; onCreated: (it: WorkItem) => void }) {
  const staff = useStaffSession();
  const queues = useQueueList();
  const create = useCreateTask();
  const canAssignOthers = staff.can('workqueues.items.assign-others');
  const people = useStaffPeople(open && canAssignOthers);
  const [queueKey, setQueueKey] = useState('');
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [due, setDue] = useState('');
  const [priority, setPriority] = useState<Priority>('normal');
  const [assignee, setAssignee] = useState('');

  useEffect(() => {
    if (!open) return;
    setQueueKey(defaultQueue || queues.data?.[0]?.key || '');
    setTitle('');
    setSummary('');
    setDue(localIn(24));
    setPriority('normal');
    setAssignee('');
    create.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => {
    if (open && !queueKey && queues.data?.length) setQueueKey(queues.data[0].key);
  }, [open, queueKey, queues.data]);

  // Others can be picked only with assign-others; the API checks they hold the queue's role (or lead/back it up).
  const assigneeChoices = useMemo(() => {
    const me = { value: staff.accountId, label: `Me (${staff.name || 'you'})` };
    const others = canAssignOthers ? people.people.filter((p) => p.staffId !== staff.accountId).map((p) => ({ value: p.staffId, label: `${p.name}${p.roleNames.length ? `, ${p.roleNames.join(', ')}` : ''}` })) : [];
    return [{ value: '', label: 'Leave unassigned' }, me, ...others];
  }, [canAssignOthers, people.people, staff.accountId, staff.name]);

  const ready = !!queueKey && !!title.trim() && !!due;
  const submit = () =>
    create.mutate(
      { queueKey, title: title.trim(), summary: summary.trim() || null, dueAt: localToIso(due)!, priority, assigneeId: assignee || null },
      {
        onSuccess: (it) => {
          announce(`Task ${it.ref} created`);
          onClose();
          onCreated(it);
        },
      },
    );

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New task"
      foot={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!ready || create.isPending} onClick={submit}>
            {create.isPending ? 'Creating…' : 'Create task'}
          </Button>
        </>
      }
    >
      <div className="stack gap-3">
        {create.error && <Alert tone="danger">{errorMessage(create.error)}</Alert>}
        <Field label="Queue">
          <Select id="nt-queue" value={queueKey} onChange={(e) => setQueueKey(e.target.value)} options={(queues.data ?? []).map((q) => ({ value: q.key, label: q.name }))} />
        </Field>
        <Field label="Task">
          <TextInput id="nt-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
        </Field>
        <Field label="Details" optional>
          <Textarea id="nt-summary" rows={3} value={summary} onChange={(e) => setSummary(e.target.value)} />
        </Field>
        <div className="grid md2">
          <Field label="Due" hint="Your computer's local time">
            <TextInput id="nt-due" type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} />
          </Field>
          <Field label="Priority">
            <Select id="nt-priority" value={priority} onChange={(e) => setPriority(e.target.value as Priority)} options={PRIORITIES} />
          </Field>
        </div>
        <Field label="Assign to" optional hint={canAssignOthers && !people.available ? 'The staff list needs access to Staff and permissions' : undefined}>
          <Select id="nt-assignee" value={assignee} onChange={(e) => setAssignee(e.target.value)} options={assigneeChoices} />
        </Field>
      </div>
    </Dialog>
  );
}

/* ================================================================ queue lead and backup */

export function QueuePeopleDialog({ queueKey, onClose }: { queueKey: string | null; onClose: () => void }) {
  const def = useQueueDefinition(queueKey);
  const people = useStaffPeople(!!queueKey);
  const save = useUpdateQueuePeople();
  const q = def.data?.queue;
  const [leadId, setLeadId] = useState('');
  const [backupId, setBackupId] = useState('');
  const [reason, setReason] = useState('');

  // Start from the queue's current people; the seeded placeholders ("Not set") aren't real staff, so start empty.
  useEffect(() => {
    if (!q) return;
    const real = (id?: string | null) => (id && people.people.some((p) => p.staffId === id) ? id : '');
    setLeadId(real(q.lead.staffId));
    setBackupId(real(q.backup.staffId));
    setReason('');
    save.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queueKey, q?.key, people.people.length]);

  // People holding the queue's owner role first: they receive its work.
  const options = useMemo(() => {
    const role = q?.ownerRole ?? '';
    const sorted = [...people.people].sort((a, b) => Number(b.roleKeys.includes(role)) - Number(a.roleKeys.includes(role)) || a.name.localeCompare(b.name));
    return [{ value: '', label: 'Choose a person' }, ...sorted.map((p) => ({ value: p.staffId, label: `${p.name}${p.roleNames.length ? `, ${p.roleNames.join(', ')}` : ''}${p.away ? ' · away' : ''}` }))];
  }, [people.people, q?.ownerRole]);

  const same = !!leadId && leadId === backupId;
  const ready = !!q && !!leadId && !!backupId && !same && !!reason.trim();
  const submit = () =>
    q &&
    save.mutate(
      { queue: q, leadId, backupId, reason: reason.trim() },
      {
        onSuccess: () => {
          announce(`${q.name}: lead and backup saved`);
          onClose();
        },
      },
    );

  return (
    <Dialog
      open={!!queueKey}
      onClose={onClose}
      title={q ? `${q.name}: lead and backup` : 'Lead and backup'}
      foot={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!ready || save.isPending} onClick={submit}>
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      {def.isPending || people.isPending ? (
        <SkeletonLines rows={4} />
      ) : def.error ? (
        <LoadError error={def.error} onRetry={() => void def.refetch()} />
      ) : !people.available ? (
        <Alert tone="info" title="Staff list not available">
          Choosing a lead and backup needs access to Staff and permissions. A Platform Administrator can add it to your roles.
        </Alert>
      ) : (
        q && (
          <div className="stack gap-3">
            {save.error && <Alert tone="danger">{errorMessage(save.error)}</Alert>}
            <p className="xs muted">
              Work in this queue goes to the lead, and to the backup while the lead is away. Owner role: {humanize(q.ownerRole)}. Escalation route: {q.escalationLabel}.
            </p>
            <Field label="Lead">
              <Select id="qp-lead" value={leadId} onChange={(e) => setLeadId(e.target.value)} options={options} />
            </Field>
            <Field label="Backup" error={same ? 'The backup must be a different person from the lead' : undefined}>
              <Select id="qp-backup" value={backupId} onChange={(e) => setBackupId(e.target.value)} options={options} />
            </Field>
            <Field label="Reason" hint="Recorded in the action history">
              <TextInput id="qp-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
          </div>
        )
      )}
    </Dialog>
  );
}

/* ================================================================ routine check */

export interface RoutineCheckLite {
  id: string;
  title: string;
  checkedIn: { done: number; total: number } | null;
}

/** "Mark done" for a routine check, with an optional note (a shared check records this person's check-in). */
export function RoutineDoneDialog({ check, onClose }: { check: RoutineCheckLite | null; onClose: () => void }) {
  const done = useCompleteCheck();
  const [note, setNote] = useState('');
  useEffect(() => {
    setNote('');
    done.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [check?.id]);
  const shared = !!check?.checkedIn;
  const submit = () =>
    check &&
    done.mutate(
      { id: check.id, note },
      {
        onSuccess: () => {
          announce(`${check.title}: ${shared ? 'checked in' : 'done'}`);
          onClose();
        },
      },
    );
  return (
    <Dialog
      open={!!check}
      onClose={onClose}
      title={check?.title ?? 'Routine check'}
      size="sm"
      foot={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button icon="check" disabled={done.isPending} onClick={submit}>
            {done.isPending ? 'Saving…' : shared ? 'Check in' : 'Mark done'}
          </Button>
        </>
      }
    >
      <div className="stack gap-3">
        {done.error && <Alert tone="danger">{errorMessage(done.error)}</Alert>}
        {shared && check?.checkedIn && (
          <p className="small">
            Shared check: {check.checkedIn.done} of {check.checkedIn.total} checked in. It’s done when everyone has.
          </p>
        )}
        <Field label="Note" optional hint="What you found, if anything needs follow-up">
          <Textarea id="rc-note" rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}
