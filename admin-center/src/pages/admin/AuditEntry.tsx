import type { ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ApiError, call, useApi } from '@marketly/web-shared/api';
import { AdminLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { href } from '@marketly/web-shared/routes';
import { Alert, Avatar, Badge, Button, Card, Chip, ChipRow, CopyButton, EmptyState, Icon, KeyValue, PageHeader, StatusBadge, type IconName, type Tone } from '@marketly/web-shared/ui';
import { LoadError, SkeletonLines, TZ, dateTime, longDate, screenHref, time } from '@/app/parts';
import { useStaffSession } from '@/app/session';
import { actorLabel, APPROVAL_LABEL, fieldChanges, isPending, rolesLabel, targetHref, targetMeta, useStaffNames, type AuditEntry as Entry, type FieldChange } from './data/audit';
import './AuditEntry.css';

// Action history entry (admin/audit-entry): designed in React after the design export, following
// reports/Best ecommerce site UX patterns.md, "Audit log entry detail". Single view. The record is
// append-only, so the page has no edit or delete; corrections are new entries.
// Data: GET /api/admin/audit/entries/{id}; related events from GET /api/admin/audit/targets/{type}/{id}.
//
// Order (phone, one column): headline → facts → approval → what changed → related events → filter chips.
// From 1180px the facts and approval sit in a right-hand column beside the diff.

type Outcome = 'Succeeded' | 'Pending approval' | 'Rejected';
const OUTCOME_TONE: Record<Outcome, Tone> = { Succeeded: 'success', 'Pending approval': 'warning', Rejected: 'danger' };
const outcomeOf = (e: Entry): Outcome => (isPending(e) ? 'Pending approval' : ['rejected', 'cancelled', 'expired'].includes(e.approval.state) ? 'Rejected' : 'Succeeded');
const APP_OF: Record<string, { label: string; icon: IconName }> = {
  staff: { label: 'Admin Center', icon: 'shield' },
  seller: { label: 'Seller Center', icon: 'store' },
  customer: { label: 'Customer Store', icon: 'shopping-bag' },
  system: { label: 'System job', icon: 'settings' },
  provider: { label: 'Provider webhook', icon: 'plug' },
};

const auditHref = (query: Record<string, string>) => href('admin/audit', '', undefined, query);
const entryHref = (id: string) => href('admin/audit-entry', '', { id });
const localLabel = (iso: string) => `${longDate(iso)}, ${time(iso)} ${new Date(iso).toLocaleString('en-US', { timeZone: TZ, timeZoneName: 'short' }).split(' ').pop()}`;
const utcLabel = (iso: string) => `${new Date(iso).toISOString().replace('T', ' ').slice(0, 19)} UTC`;

function IdValue({ value, label }: { value: string; label: string }) {
  return (
    <span className="ae-id">
      <span className="mono">{value}</span>
      <CopyButton text={value} label={`Copy ${label}`} />
    </span>
  );
}

function Diff({ changes }: { changes: FieldChange[] }) {
  const unset = <span className="unset">not set</span>;
  return (
    <ul className="ae-diff ab-diff">
      {changes.map((c) => (
        <li key={c.field}>
          <span className="f">
            <span className="small strong">{c.label}</span>
            <span className="xs muted mono">{c.field}</span>
          </span>
          <span className="vals">
            <span className="sr-only">Before: </span>
            {c.before === null ? unset : <del>{c.before}</del>}
            <Icon name="arrow-right" />
            <span className="sr-only">After: </span>
            {c.after === null ? unset : <ins>{c.after}</ins>}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Approval({ e, who }: { e: Entry; who: string }) {
  const a = e.approval;
  const steps: Array<{ done: boolean; wait?: boolean; who: ReactNode; sub: string; status: string }> = [
    { done: true, who: `${who} · ${rolesLabel(e)}`, sub: `Made the change ${time(e.at)}`, status: isPending(e) ? 'Requested' : 'Completed' },
  ];
  for (const s of a.steps) {
    if (/request/i.test(s.label) && s.at === e.at) continue;
    steps.push({ done: true, who: s.actor?.name ? `${s.label} · ${s.actor.name}` : s.label, sub: `${dateTime(s.at)}${s.detail ? ` · ${s.detail}` : ''}`, status: APPROVAL_LABEL[a.state] === 'Pending' ? 'Done' : APPROVAL_LABEL[a.state] });
  }
  if (isPending(e)) steps.push({ done: false, wait: true, who: a.note?.replace('Waiting for ', '') ?? (a.approvers.join(', ') || 'Second reviewer'), sub: 'Second reviewer · not yet reviewed', status: 'Pending' });
  return (
    <Card title="Approval" titleAs="h2" sub={a.state === 'not_required' ? 'No second review needed' : isPending(e) ? 'Waiting for a second reviewer' : `Second review ${APPROVAL_LABEL[a.state].toLowerCase()}`}>
      <ul className="ab-approvals">
        {steps.map((s, i) => (
          <li key={i}>
            <span className={cx('n', s.done && 'is-done', s.wait && 'is-wait')}>
              <Icon name={s.done ? 'check' : 'hourglass'} className="ic-sm" />
            </span>
            <span className="ab-cell">
              <span className="strong">{s.who}</span>
              <span className="xs muted">{s.sub}</span>
            </span>
            <StatusBadge status={s.status} />
          </li>
        ))}
      </ul>
      {a.state === 'not_required' ? (
        <KeyValue pairs={[['Limit applied', a.note ? `None needed: ${a.note}` : 'None needed']]} />
      ) : (
        <KeyValue
          pairs={[
            ['Approvers', a.approvers.join(', ') || '—'],
            ['Decided', a.decidedAt ? dateTime(a.decidedAt) : 'Not yet'],
            ...(a.note ? ([['Note', a.note]] as Array<[ReactNode, ReactNode]>) : []),
          ]}
        />
      )}
    </Card>
  );
}

function NotFound({ id }: { id: string }) {
  return (
    <AdminLayout active="audit">
      <PageHeader crumbs={[{ label: 'Reports and settings' }, { label: 'Action history', to: href('admin/audit') }, { label: id }]} title="Entry not found" />
      <Card pad>
        <EmptyState
          icon="search-x"
          title={`No action history entry has the ID ${id}`}
          as="h2"
          action={
            <span className="row gap-2 wrap">
              <Button variant="secondary" to={auditHref({ q: id })} icon="search">
                Search the log
              </Button>
              <Button to={href('admin/audit')} icon="history">
                Go to Action history
              </Button>
            </span>
          }
        >
          Entry IDs are the long codes at the end of an entry’s link in Action history. Check the link, or search the log.
        </EmptyState>
      </Card>
    </AdminLayout>
  );
}

export default function AuditEntry() {
  const { id = '' } = useParams();
  const { api } = useApi();
  const me = useStaffSession();
  const canView = me.can('audit.entries.view');
  const names = useStaffNames(canView && me.can('access.roles.view'));
  const entryQ = useQuery({
    queryKey: ['audit', 'entry', id],
    queryFn: () => call(api.GET('/api/admin/audit/entries/{id}', { params: { path: { id } } })) as Promise<Entry>,
    enabled: canView && !!id,
    retry: (n, e) => !(e instanceof ApiError && (e.status === 404 || e.status === 400)) && n < 2,
  });
  const e = entryQ.data;
  const relatedQ = useQuery({
    queryKey: ['audit', 'target', e?.target.type, e?.target.id],
    queryFn: () => call(api.GET('/api/admin/audit/targets/{type}/{id}', { params: { path: { type: e!.target.type, id: e!.target.id }, query: { limit: 10 } } })),
    enabled: !!e,
  });
  const retentionQ = useQuery({ queryKey: ['audit', 'retention'], queryFn: () => call(api.GET('/api/admin/audit/retention')), enabled: canView, staleTime: 10 * 60_000 });

  if (!canView) {
    return (
      <AdminLayout active="audit">
        <PageHeader crumbs={[{ label: 'Reports and settings' }, { label: 'Action history', to: href('admin/audit') }, { label: id }]} title="Action history entry" />
        <Alert tone="info" title="You don’t have access to Action history">
          Reading the action history needs the “View entries” permission.
        </Alert>
      </AdminLayout>
    );
  }
  if (entryQ.error instanceof ApiError && (entryQ.error.status === 404 || entryQ.error.status === 400)) return <NotFound id={id} />;
  if (entryQ.isError) {
    return (
      <AdminLayout active="audit">
        <PageHeader crumbs={[{ label: 'Reports and settings' }, { label: 'Action history', to: href('admin/audit') }, { label: id }]} title="Action history entry" />
        <LoadError error={entryQ.error} onRetry={() => void entryQ.refetch()} />
      </AdminLayout>
    );
  }
  if (!e) {
    return (
      <AdminLayout active="audit">
        <PageHeader className="ae-head" crumbs={[{ label: 'Reports and settings' }, { label: 'Action history', to: href('admin/audit') }, { label: id }]} eyebrow={`Action history entry · ${id}`} title={<span className="sk sk-line" />} />
        <div className="ae-split">
          <Card title="What changed" titleAs="h2">
            <SkeletonLines rows={4} />
          </Card>
          <Card title="Facts" titleAs="h2" className="ae-facts">
            <SkeletonLines rows={5} />
          </Card>
        </div>
      </AdminLayout>
    );
  }

  const who = actorLabel(e.actor, names);
  const meta = targetMeta(e.target.type);
  const targetTo = targetHref(e.target, screenHref);
  const ref = e.target.ref ?? e.target.id;
  const changes = fieldChanges(e);
  const related = ((relatedQ.data?.items ?? []) as Entry[]).filter((r) => r.id !== e.id);
  const raw = JSON.stringify(e, null, 2);
  const outcome = outcomeOf(e);
  const app = APP_OF[e.actor.kind] ?? { label: 'API', icon: 'plug' as IconName };

  return (
    <AdminLayout active="audit">
      <PageHeader
        className="ae-head"
        crumbs={[{ label: 'Reports and settings' }, { label: 'Action history', to: href('admin/audit') }, { label: `#${e.seq}` }]}
        eyebrow={`Action history entry · #${e.seq}`}
        title={
          <>
            {who} ({rolesLabel(e)}): {e.actionLabel.toLowerCase()}
          </>
        }
        sub={
          <span className="ae-meta">
            <code className="ae-code" title="Machine action name">
              {e.action}
            </code>
            <StatusBadge status={outcome} tone={OUTCOME_TONE[outcome]} />
            <span>{localLabel(e.at)}</span>
          </span>
        }
        actions={
          <>
            <CopyButton text={typeof window === 'undefined' ? entryHref(e.id) : window.location.href} icon="link">
              Copy link
            </CopyButton>
            <Button variant="secondary" size="sm" icon="arrow-left" to={href('admin/audit')}>
              Action history
            </Button>
          </>
        }
      />

      <div className="ae-split">
        <div className="stack gap-5">
          <Card title="What changed" titleAs="h2" sub={changes.length ? `Only the ${changes.length} field${changes.length === 1 ? '' : 's'} that changed` : 'No field values were recorded for this action'}>
            {changes.length > 0 && <Diff changes={changes} />}
            <div className="panel small">
              <span className="strong">Reason given: </span>
              {e.reason ?? 'No reason recorded'}
            </div>
            {e.evidence.length > 0 && (
              <div className="small">
                <span className="strong">Evidence: </span>
                {e.evidence.join(' · ')}
              </div>
            )}
            <details className="ae-raw">
              <summary>
                <Icon name="chevron-right" />
                Raw JSON
              </summary>
              <div className="ae-raw-body">
                <pre tabIndex={0} aria-label={`Raw record for entry ${e.seq}`}>
                  <code>{raw}</code>
                </pre>
                <span className="row gap-2">
                  <CopyButton text={raw}>Copy JSON</CopyButton>
                  <span className="xs muted">As returned by the action history API. Secrets are redacted before they are stored.</span>
                </span>
              </div>
            </details>
          </Card>

          <Card title="Related events" titleAs="h2" sub="Same target" flush>
            {relatedQ.isPending ? (
              <div className="card-body">
                <SkeletonLines rows={3} />
              </div>
            ) : related.length ? (
              <ul className="ae-rel">
                {related.map((r) => (
                  <li key={r.id}>
                    <span className="stack gap-0 min-w-0">
                      <span className="t">
                        <Link to={entryHref(r.id)}>
                          {actorLabel(r.actor, names)}: {r.actionLabel.toLowerCase()}
                        </Link>
                      </span>
                      <span className="xs muted">
                        {dateTime(r.at)} · <span className="mono">#{r.seq}</span> · {r.action}
                      </span>
                    </span>
                    <Badge tone={r.requestId && r.requestId === e.requestId ? 'info' : ''}>{r.requestId && r.requestId === e.requestId ? 'Same request' : 'Same target'}</Badge>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="card-body">
                <p className="small muted">No other entries for this target.</p>
              </div>
            )}
          </Card>

          <Card title="Filter the log" titleAs="h2" sub="Opens Action history with this filter applied">
            <ChipRow>
              {e.actor.id && (
                <Chip icon="user-round" to={auditHref({ staff: e.actor.id })}>
                  By this actor: {who}
                </Chip>
              )}
              <Chip icon={meta.icon} to={auditHref({ q: ref })}>
                By this target: {ref}
              </Chip>
              {e.requestId && (
                <Chip icon="hash" to={auditHref({ q: e.requestId })}>
                  By this request: {e.requestId}
                </Chip>
              )}
            </ChipRow>
          </Card>

          <p className="ae-lock xs muted">
            <Icon name="lock" />
            <span>
              Action history is append-only. This entry cannot be edited or deleted; a correction is recorded as a new entry that references it.
              {retentionQ.data ? ` Retention: ${retentionQ.data.retainYears} years.` : ''}
            </span>
          </p>
        </div>

        <div className="ae-side stack gap-5">
          <Card title="Facts" titleAs="h2" className="ae-facts">
            <KeyValue
              pairs={[
                [
                  'Actor',
                  <span className="row gap-2 nowrap">
                    <Avatar name={who} className="ab-av-sm" />
                    <span className="ab-cell">
                      <span className="strong">{who}</span>
                      <span className="xs muted">Role at the time: {rolesLabel(e)}</span>
                    </span>
                  </span>,
                ],
                [
                  'Target',
                  <span className="ab-cell">
                    <span className="row gap-1 nowrap xs muted">
                      <Icon name={meta.icon} className="ic-sm" />
                      {meta.label}
                    </span>
                    {targetTo ? (
                      <Link className="mono" to={targetTo}>
                        {ref}
                      </Link>
                    ) : (
                      <span className="mono">{ref}</span>
                    )}
                    {e.target.label && <span className="xs muted">{e.target.label}</span>}
                  </span>,
                ],
                ['Module', e.module],
                ['Local time', localLabel(e.at)],
                ['UTC', utcLabel(e.at)],
                [
                  'App',
                  <Badge icon={app.icon} tone="outline">
                    {app.label}
                  </Badge>,
                ],
                ['IP address', e.ip ? <span className="mono">{e.ip}</span> : <span className="muted">Not recorded</span>],
                ...(e.requestId ? ([['Request ID', <IdValue value={e.requestId} label="request ID" />]] as Array<[ReactNode, ReactNode]>) : []),
                ['Entry ID', <IdValue value={e.id} label="entry ID" />],
                ['Seller can see it', e.visibleToSeller ? 'Yes, in the seller’s own history' : 'No'],
              ]}
            />
          </Card>
          <Approval e={e} who={who} />
        </div>
      </div>
    </AdminLayout>
  );
}
