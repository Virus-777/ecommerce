import { useState } from 'react';
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { call, errorMessage, LiveAlertSettings, useApi } from '@marketly/web-shared/api';
import { AdminLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { formatMoney, isoInText } from '@marketly/web-shared/lib/format';
import { useView } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import { Alert, Avatar, Badge, Button, Card, Checkbox, Deadline, Dialog, EmptyState, Field, Icon, IconButton, KeyValue, Select, Switch, TableWrap, Tabs, Textarea, announce, iconFor } from '@marketly/web-shared/ui';
import { useStaffSession } from '@/app/session';
import { LoadError, SkeletonLines, dateTime, deadlineLabel, deadlineTone, time } from '@/app/parts';
import { isStepUpCancel, reauthField, useStepUp } from './data/step-up';
import { ALL_AREAS, API_VIEW, APPROVAL_STATUS, byDay, needsMe, noticeHref, noticeTone, routeText, type ApprovalRequest, type InboxSummary, type Notice, type Tab } from './data/inbox';

// Design: pages/admin/admin-inbox.html · view "needs-my-action" = the tab filtered to notices that need me.
// "Mentions" links to "#" in the design; here it is a local tab that lists the mentions.
// Data: GET notifications/inbox (view, area, unreadOnly, cursor), GET notifications/inbox/summary, POST inbox/{id}/read,
// POST inbox/read-all, GET/PUT notifications/my-preferences (Notification settings dialog), approval notices open
// the approval request (GET access/approval-requests/{id}, POST …/approve | …/reject; the password again when asked).
// POST inbox/{id}/unread puts a read notice back to unread (the row's toggle).

const LIMIT = 30;

function MentionList({ items }: { items: Notice[] }) {
  if (!items.length) return <p className="small muted card-body">No one has mentioned you.</p>;
  return (
    <ul className="list pad">
      {items.map((m) => {
        const to = noticeHref(m);
        return (
          <li key={m.id}>
            <span className="grow stack gap-0">
              <span className="small">
                <b>{m.title}</b>
                {m.link.ref && (
                  <>
                    {' '}
                    in{' '}
                    {to ? (
                      <Link to={to} className="link-inline">
                        {m.link.ref}
                      </Link>
                    ) : (
                      m.link.ref
                    )}
                  </>
                )}
              </span>
              <span className="xs muted">
                {isoInText(m.body)} · {time(m.createdAt)}
              </span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export default function Inbox() {
  const { api } = useApi();
  const qc = useQueryClient();
  const { name, roles } = useStaffSession();
  const [view, setView] = useView<'needs-my-action'>();
  const [extraTab, setExtraTab] = useState<'' | 'mentions'>('');
  const tab: Tab = extraTab || view;
  const [area, setArea] = useState(ALL_AREAS);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [approvalId, setApprovalId] = useState<string | null>(null);
  const [actionError, setActionError] = useState('');

  const summary = useQuery({ queryKey: ['notifications', 'summary', 'staff'], queryFn: () => call(api.GET('/api/admin/notifications/inbox/summary')) as Promise<InboxSummary> });
  const params = { view: API_VIEW[tab], area: tab === 'mentions' || area === ALL_AREAS ? undefined : area, unreadOnly: tab !== 'mentions' && unreadOnly ? true : undefined };
  const list = useInfiniteQuery({
    queryKey: ['notifications', 'inbox', params],
    queryFn: ({ pageParam }) => call(api.GET('/api/admin/notifications/inbox', { params: { query: { ...params, limit: LIMIT, cursor: pageParam } } })),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
  });
  const mentions = useQuery({
    queryKey: ['notifications', 'inbox', { view: 'mentions', side: true }],
    queryFn: () => call(api.GET('/api/admin/notifications/inbox', { params: { query: { view: 'mentions', limit: 5 } } })),
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['notifications'] });
  };
  const markRead = useMutation({
    mutationFn: (id: string) => call(api.POST('/api/admin/notifications/inbox/{id}/read', { params: { path: { id } } })),
    onSuccess: refresh,
    onError: (e) => setActionError(errorMessage(e)),
  });
  const markUnread = useMutation({
    mutationFn: (id: string) => call(api.POST('/api/admin/notifications/inbox/{id}/unread', { params: { path: { id } } })),
    onSuccess: () => {
      refresh();
      announce('Marked as unread');
    },
    onError: (e) => setActionError(errorMessage(e)),
  });
  const markAll = useMutation({
    mutationFn: () => call(api.POST('/api/admin/notifications/inbox/read-all', { body: {} })),
    onSuccess: () => {
      refresh();
      announce('All notices marked as read');
    },
    onError: (e) => setActionError(errorMessage(e)),
  });

  const notices = list.data?.pages.flatMap((p) => p.items as Notice[]) ?? [];
  const s = summary.data;
  const areas = [ALL_AREAS, ...Object.keys(s?.byArea ?? {}).sort(), ...(area !== ALL_AREAS && !(s?.byArea ?? {})[area] ? [area] : [])];
  const mentionItems = (mentions.data?.items ?? []) as Notice[];
  const unread = s?.unread ?? 0;

  const changeTab = (t: Tab) => {
    if (t === 'mentions') {
      setExtraTab('mentions');
      return;
    }
    setExtraTab('');
    setView(t);
  };

  const groups = byDay(notices);

  return (
    <AdminLayout active="inbox">
      <div className="page-head">
        <div className="t">
          <h1 className="h1">Notifications inbox</h1>
          <p className="sub small">
            {name}
            {roles.length ? ` · ${roles.join(', ')}` : ''}
            {s?.coveringNote ? ` · ${s.coveringNote}` : ''}
          </p>
        </div>
        <div className="actions">
          {/* Desktop alerts and sound for live notices in this browser (toasts always show). */}
          <LiveAlertSettings audience="admin" />
          <Button variant="ghost" size="sm" icon="check-check" onClick={() => markAll.mutate()} disabled={!unread || markAll.isPending}>
            Mark all as read
          </Button>
          <Button variant="secondary" size="sm" icon="settings" onClick={() => setSettingsOpen(true)}>
            Notification settings
          </Button>
        </div>
      </div>

      <div className="ab-main">
        <div className="stack gap-3">
          <Tabs<Tab>
            items={[
              { label: 'All', value: '', count: unread || undefined },
              { label: 'Needs my action', value: 'needs-my-action', count: s?.needsMyAction },
              { label: 'Mentions', value: 'mentions', count: s?.mentions },
            ]}
            active={tab}
            onChange={changeTab}
          />
          {tab !== 'mentions' && (
            <div className="toolbar">
              <Select id="in-area" aria-label="Area" options={areas} value={area} onChange={(e) => setArea(e.target.value)} />
              <Checkbox id="in-unread" label="Unread only" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} />
            </div>
          )}
          {tab === 'needs-my-action' && s && s.needsMyAction > 0 && (
            <Alert tone="brand" title={`${s.needsMyAction} notice${s.needsMyAction === 1 ? ' needs' : 's need'} you`}>
              {s.coveringNote ?? 'They come from your roles, and from roles you cover as backup while a lead is away.'}
            </Alert>
          )}
          {actionError && (
            <Alert tone="danger" title="That didn’t work">
              {actionError}
            </Alert>
          )}
          {list.isError ? (
            <LoadError error={list.error} onRetry={() => void list.refetch()} />
          ) : tab === 'mentions' ? (
            <section className="card" aria-label="Mentions">
              {list.isPending ? <SkeletonLines rows={3} /> : <MentionList items={notices} />}
            </section>
          ) : (
            <section className="card" aria-label="Notices">
              {list.isPending ? (
                <SkeletonLines rows={5} />
              ) : notices.length === 0 ? (
                tab === 'needs-my-action' && area === ALL_AREAS && !unreadOnly ? (
                  <EmptyState icon="circle-check" title="Nothing needs you">
                    Notices that ask you to act show up here.
                  </EmptyState>
                ) : (
                  <EmptyState icon="bell-off" title="No notices match">
                    Change the area or turn off Unread only to see more notices.
                  </EmptyState>
                )
              ) : (
                groups.map((d) => [
                  <div className="ab-day" key={d.key}>
                    {d.label}
                  </div>,
                  ...d.rows.map((n) => {
                    const tone = noticeTone(n.tone);
                    const mine = needsMe(n);
                    const isUnread = !n.readAt;
                    const to = noticeHref(n);
                    const approval = n.link.kind === 'approval' && !n.resolvedAt;
                    const route = routeText(n);
                    const label = n.link.label ?? 'Open';
                    return (
                      <article key={n.id} className={cx('ab-ntc', isUnread && 'is-unread')}>
                        <span className={`ic t-${tone}`}>
                          <Icon name={iconFor(n.icon)} className="ic-sm" />
                        </span>
                        <div className="stack gap-1">
                          <span className="row gap-2">
                            <Badge tone="outline">{n.group}</Badge>
                            {mine && <Badge tone="brand">Needs my action</Badge>}
                            {n.resolvedAt && n.actionRequired && <Badge tone="success">Done</Badge>}
                            {isUnread && <span className="sr-only">Unread.</span>}
                          </span>
                          <span className="small strong">{isoInText(n.title)}</span>
                          <span className="xs sub">{isoInText(n.body)}</span>
                          <span className="meta">
                            {route && (
                              <span>
                                <Icon name="route" className="ic-sm" /> {route}
                              </span>
                            )}
                            {n.deadline?.dueAt && !n.resolvedAt ? (
                              <Deadline tone={deadlineTone(n.deadline.state)}>{deadlineLabel(n.deadline.dueAt)}</Deadline>
                            ) : (
                              <span className="xs muted">{dateTime(n.createdAt)}</span>
                            )}
                          </span>
                        </div>
                        <div className="acts">
                          {approval ? (
                            <Button variant={mine ? 'primary' : 'secondary'} size="sm" onClick={() => setApprovalId(n.link.id)}>
                              {label}
                            </Button>
                          ) : to ? (
                            <Button variant={mine ? 'primary' : 'secondary'} size="sm" to={to} onClick={() => isUnread && markRead.mutate(n.id)}>
                              {label}
                            </Button>
                          ) : null}
                          {isUnread ? (
                            <IconButton icon="check" label="Mark as read" disabled={markRead.isPending && markRead.variables === n.id} onClick={() => markRead.mutate(n.id)} />
                          ) : (
                            <IconButton icon="mail" label="Mark as unread" disabled={markUnread.isPending && markUnread.variables === n.id} onClick={() => markUnread.mutate(n.id)} />
                          )}
                        </div>
                      </article>
                    );
                  }),
                ])
              )}
              {list.hasNextPage && (
                <div className="card-foot">
                  <Button variant="ghost" size="sm" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                    {list.isFetchingNextPage ? 'Loading…' : 'Show older notices'}
                  </Button>
                </div>
              )}
            </section>
          )}
          <p className="ab-note">
            <Icon name="info" className="ic-sm" /> Shown here in the workspace and sent by email according to each person's settings. SMS and push come later.
          </p>
        </div>

        <div className="stack gap-4">
          <Card
            title="Routing today"
            sub="Notices go to roles, not people"
            flush
            foot={
              <>
                <span className="ab-note grow">When a lead is away, the backup gets the same notices and deadlines. The lead sees them on return.</span>
                <Button variant="ghost" size="sm" to={href('admin/staff')}>
                  Edit backups
                </Button>
              </>
            }
          >
            {summary.isError ? (
              <div className="card-body">
                <LoadError error={summary.error} onRetry={() => void summary.refetch()} />
              </div>
            ) : !s ? (
              <SkeletonLines rows={3} />
            ) : (
              <TableWrap label="Routing today table">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Role</th>
                      <th scope="col">Receives now</th>
                      <th scope="col">Lead</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.routingToday.map((r) => (
                      <tr key={r.roleKey}>
                        <td>{r.roleName}</td>
                        <td>
                          <span className="row nowrap gap-2">
                            {r.receivingNow[0] && <Avatar name={r.receivingNow[0]} className="ab-av-sm" />}
                            <span className="ab-cell">
                              <span className="strong">{r.receivingNow.join(', ') || 'No one'}</span>
                              {r.note && <span className="xs muted">{r.note}</span>}
                            </span>
                          </span>
                        </td>
                        <td>{r.leadAway ? <span className="xs t-warning-text strong">{r.lead ?? 'Not set'} · away</span> : (r.lead ?? 'Not set')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            )}
          </Card>
          <Card titleAs="h3" title="Mentions" sub={s ? `${s.mentions} unread` : undefined} flush>
            {mentions.isPending ? <SkeletonLines rows={2} /> : <MentionList items={mentionItems} />}
          </Card>
        </div>
      </div>

      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <ApprovalDialog id={approvalId} onClose={() => setApprovalId(null)} onDecided={refresh} />
    </AdminLayout>
  );
}

/** My email preferences for staff notices (GET/PUT notifications/my-preferences). */
function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { api } = useApi();
  const qc = useQueryClient();
  const { can } = useStaffSession();
  const prefs = useQuery({ queryKey: ['notifications', 'my-preferences'], queryFn: () => call(api.GET('/api/admin/notifications/my-preferences')), enabled: open });
  const [draft, setDraft] = useState<{ emailByArea: Record<string, boolean>; emailForMentions: boolean; dailyDigest: boolean } | null>(null);
  const current = draft ?? (prefs.data ? { emailByArea: prefs.data.emailByArea, emailForMentions: prefs.data.emailForMentions, dailyDigest: prefs.data.dailyDigest } : null);
  const save = useMutation({
    mutationFn: () => call(api.PUT('/api/admin/notifications/my-preferences', { body: current! })),
    onSuccess: (data) => {
      qc.setQueryData(['notifications', 'my-preferences'], data);
      setDraft(null);
      announce('Notification settings saved');
      onClose();
    },
  });
  const close = () => {
    setDraft(null);
    save.reset();
    onClose();
  };
  return (
    <Dialog
      open={open}
      onClose={close}
      title="Notification settings"
      foot={
        <>
          {can('notifications.topics.manage') && (
            <Button variant="ghost" to={href('admin/notifications')}>
              Topics and templates
            </Button>
          )}
          <span className="grow" />
          <Button variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} disabled={!current || !draft || save.isPending}>
            Save
          </Button>
        </>
      }
    >
      {prefs.isError ? (
        <LoadError error={prefs.error} onRetry={() => void prefs.refetch()} />
      ) : !current ? (
        <SkeletonLines rows={4} />
      ) : (
        <div className="stack gap-3">
          <p className="small sub">Every notice shows here in the inbox. Choose which areas also send you an email.</p>
          {save.isError && (
            <Alert tone="danger" title="We couldn’t save your settings">
              {errorMessage(save.error)}
            </Alert>
          )}
          <div className="stack gap-2">
            {Object.keys(current.emailByArea).map((k) => (
              <Switch key={k} id={`pref-${k}`} label={`Email for ${k}`} checked={current.emailByArea[k]} onChange={(e) => setDraft({ ...current, emailByArea: { ...current.emailByArea, [k]: e.target.checked } })} />
            ))}
          </div>
          <Switch id="pref-mentions" label="Email when someone mentions me" checked={current.emailForMentions} onChange={(e) => setDraft({ ...current, emailForMentions: e.target.checked })} />
          <Switch id="pref-digest" label="Daily digest instead of single emails" checked={current.dailyDigest} onChange={(e) => setDraft({ ...current, dailyDigest: e.target.checked })} />
        </div>
      )}
    </Dialog>
  );
}

/** One approval request: what is asked, approvals so far, and approve / reject when I may decide. */
function ApprovalDialog({ id, onClose, onDecided }: { id: string | null; onClose: () => void; onDecided: () => void }) {
  const { api } = useApi();
  const qc = useQueryClient();
  const stepUp = useStepUp();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const req = useQuery({
    queryKey: ['access', 'approval-request', id],
    queryFn: () => call(api.GET('/api/admin/access/approval-requests/{id}', { params: { path: { id: id! } } })) as Promise<ApprovalRequest>,
    enabled: !!id,
  });
  const done = (r: ApprovalRequest, msg: string) => {
    qc.setQueryData(['access', 'approval-request', id], r);
    void qc.invalidateQueries({ queryKey: ['access', 'me'] });
    void qc.invalidateQueries({ queryKey: ['workqueues', 'queues'] });
    void qc.invalidateQueries({ queryKey: ['reports', 'admin-dashboard'] });
    onDecided();
    announce(msg);
    setRejecting(false);
    setErr('');
  };
  const approve = useMutation({
    mutationFn: () => stepUp.run((token) => call(api.POST('/api/admin/access/approval-requests/{id}/approve', { params: { path: { id: id! } }, body: { note: note.trim() || null, ...reauthField(token) } }))),
    onSuccess: (r) => done(r as ApprovalRequest, r.status === 'partially_approved' ? 'First approval recorded. A second reviewer must approve.' : 'Approved'),
    onError: (e) => !isStepUpCancel(e) && setErr(errorMessage(e)),
  });
  const reject = useMutation({
    mutationFn: () => call(api.POST('/api/admin/access/approval-requests/{id}/reject', { params: { path: { id: id! } }, body: { reason: reason.trim() } })),
    onSuccess: (r) => done(r as ApprovalRequest, 'Rejected'),
    onError: (e) => setErr(errorMessage(e)),
  });
  const close = () => {
    setRejecting(false);
    setReason('');
    setNote('');
    setErr('');
    onClose();
  };
  const r = req.data;
  const open = r && (r.status === 'pending' || r.status === 'partially_approved');
  const amount = r?.amount as { amount: number; currency: string } | null | undefined;
  const approvals = (r?.approvals ?? []) as Array<{ step: number; decision: string; by: { name?: string | null }; at: string; note?: string | null }>;
  return (
    <Dialog
      open={!!id}
      onClose={close}
      title={r ? `Approval ${r.ref}` : 'Approval request'}
      foot={
        r && open && r.canDecide ? (
          rejecting ? (
            <>
              <Button variant="secondary" onClick={() => setRejecting(false)}>
                Back
              </Button>
              <Button variant="danger" disabled={reason.trim().length < 3 || reject.isPending} onClick={() => reject.mutate()}>
                Reject
              </Button>
            </>
          ) : (
            <>
              <Button variant="secondary" onClick={() => setRejecting(true)}>
                Reject
              </Button>
              <Button icon="check" disabled={approve.isPending} onClick={() => approve.mutate()}>
                Approve
              </Button>
            </>
          )
        ) : (
          <Button variant="secondary" onClick={close}>
            Close
          </Button>
        )
      }
    >
      {req.isError ? (
        <LoadError error={req.error} onRetry={() => void req.refetch()} />
      ) : !r ? (
        <SkeletonLines rows={4} />
      ) : (
        <div className="stack gap-3">
          <Alert tone={open ? 'warning' : r.status === 'approved' ? 'success' : 'info'} title={APPROVAL_STATUS[r.status]}>
            {r.action.label}
            {r.requiredApprovals > 1 ? ` · ${r.requiredApprovals} approvals needed` : ''}
          </Alert>
          <KeyValue
            pairs={[
              ['Request', r.summary],
              ['Requested by', `${(r.requestedBy as { name?: string | null }).name ?? 'A colleague'} · ${dateTime(r.createdAt)}`],
              ['Reason', r.reason],
              ...(amount ? ([['Amount', formatMoney(amount)]] as Array<[string, string]>) : []),
              ...approvals.map((a) => [`Step ${a.step}`, `${a.decision === 'approved' ? 'Approved' : a.decision} by ${a.by.name ?? 'staff'} · ${dateTime(a.at)}${a.note ? ` · ${a.note}` : ''}`] as [string, string]),
            ]}
          />
          {open && !r.canDecide && <p className="small muted">{r.cannotDecideReason ?? 'You can’t decide this request.'}</p>}
          {err && <Alert tone="danger" title={err} />}
          {open && r.canDecide && (rejecting ? (
            <Field label="Why are you rejecting it?" hint="The requester sees this.">
              <Textarea id="ap-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
          ) : (
            <Field label="Note" optional>
              <Textarea id="ap-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
            </Field>
          ))}
        </div>
      )}
      {stepUp.dialog}
    </Dialog>
  );
}
