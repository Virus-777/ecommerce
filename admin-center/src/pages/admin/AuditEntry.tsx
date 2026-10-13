import type { ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { AdminLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { href } from '@marketly/web-shared/routes';
import { Avatar, Badge, Button, Card, Chip, ChipRow, CopyButton, EmptyState, Icon, KeyValue, PageHeader, StatusBadge, type IconName, type Tone } from '@marketly/web-shared/ui';
import { findEntry, localLabel, rawRecord, relatedTo, TARGET, utcLabel, type AuditApp, type AuditEntry as Entry, type AuditOutcome, type FieldChange } from './data/audit';
import './AuditEntry.css';

// Action history entry (admin/audit-entry): designed in React after the design export, following
// reports/Best ecommerce site UX patterns.md, "Audit log entry detail". Single view. The record is
// append-only, so the page has no edit or delete; corrections are new entries.
//
// Order (phone, one column): headline → facts → approval → what changed → related events → filter chips.
// From 1180px the facts and approval sit in a right-hand column beside the diff.

const OUTCOME_TONE: Record<AuditOutcome, Tone> = { Succeeded: 'success', 'Pending approval': 'warning', Failed: 'danger' };
const APP_ICON: Record<AuditApp, IconName> = { 'Admin Center': 'shield', 'Operations Center': 'warehouse', 'Seller Center': 'store', API: 'plug' };

const auditHref = (query: Record<string, string>) => href('admin/audit', '', undefined, query);
const entryHref = (id: string) => href('admin/audit-entry', '', { id });

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

function Approval({ e }: { e: Entry }) {
  const steps: Array<{ done: boolean; wait?: boolean; who: ReactNode; sub: string; status: string }> = [
    { done: true, who: `${e.staff} · ${e.role}`, sub: `Made the change ${e.time}`, status: e.outcome === 'Pending approval' ? 'Requested' : 'Completed' },
  ];
  if (e.approver) steps.push({ done: true, who: `${e.approver.name} · ${e.approver.role}`, sub: `Approved ${e.approver.at}`, status: 'Approved' });
  else if (e.approval === 'Pending') steps.push({ done: false, wait: true, who: e.approvalNote.replace('Waiting for ', ''), sub: 'Second reviewer · not yet reviewed', status: 'Pending' });
  return (
    <Card title="Approval" titleAs="h2" sub={e.approval === 'Not required' ? 'No second review needed' : e.approval === 'Pending' ? 'Waiting for a second reviewer' : 'Second review completed'}>
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
      {e.approver ? (
        <KeyValue
          pairs={[
            ['Approved by', `${e.approver.name}, ${e.approver.role}`],
            ['When', e.approver.at],
            ['Limit applied', e.approver.limit],
          ]}
        />
      ) : (
        <KeyValue pairs={[['Limit applied', e.approval === 'Pending' ? `${e.approvalNote}. The change takes effect only after approval.` : `None needed: ${e.approvalNote.toLowerCase()}`]]} />
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
          Entry IDs look like AE-261008-0932: the date and the Pacific time of the action. Check the link, or search the log.
        </EmptyState>
      </Card>
    </AdminLayout>
  );
}

export default function AuditEntry() {
  const { id = '' } = useParams();
  const e = findEntry(id);
  if (!e) return <NotFound id={id} />;

  const target = TARGET[e.target];
  const related = relatedTo(e);
  const raw = JSON.stringify(rawRecord(e), null, 2);

  return (
    <AdminLayout active="audit">
      <PageHeader
        className="ae-head"
        crumbs={[{ label: 'Reports and settings' }, { label: 'Action history', to: href('admin/audit') }, { label: e.id }]}
        eyebrow={`Action history entry · ${e.id}`}
        title={
          <>
            {e.staff} ({e.role}) {e.phrase}
          </>
        }
        sub={
          <span className="ae-meta">
            <code className="ae-code" title="Machine action name">
              {e.code}
            </code>
            <StatusBadge status={e.outcome} tone={OUTCOME_TONE[e.outcome]} />
            <span>{localLabel(e)}</span>
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
          <Card title="What changed" titleAs="h2" sub={`Only the ${e.changes.length} field${e.changes.length === 1 ? '' : 's'} that changed`}>
            <Diff changes={e.changes} />
            <div className="panel small">
              <span className="strong">Reason given: </span>
              {e.reason}
            </div>
            <details className="ae-raw">
              <summary>
                <Icon name="chevron-right" />
                Raw JSON
              </summary>
              <div className="ae-raw-body">
                <pre tabIndex={0} aria-label={`Raw record for ${e.id}`}>
                  <code>{raw}</code>
                </pre>
                <span className="row gap-2">
                  <CopyButton text={raw}>Copy JSON</CopyButton>
                  <span className="xs muted">As returned by the action history API. Token values are never stored, only the token ID.</span>
                </span>
              </div>
            </details>
          </Card>

          <Card title="Related events" titleAs="h2" sub="Same request ID, same target, or the same seller" flush>
            {related.length ? (
              <ul className="ae-rel">
                {related.map(({ entry: r, why }) => (
                  <li key={r.id}>
                    <span className="stack gap-0 min-w-0">
                      <span className="t">
                        <Link to={entryHref(r.id)}>
                          {r.staff} {r.phrase}
                        </Link>
                      </span>
                      <span className="xs muted">
                        {r.day}, {r.time} · <span className="mono">{r.id}</span> · {r.code}
                      </span>
                    </span>
                    <Badge tone={why === 'Same request' ? 'info' : ''}>{why}</Badge>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="card-body">
                <p className="small muted">No other entries share this request, target or seller in the last 180 days.</p>
              </div>
            )}
          </Card>

          <Card title="Filter the log" titleAs="h2" sub="Opens Action history with this filter applied">
            <ChipRow>
              <Chip icon="user-round" to={auditHref({ staff: e.staff })}>
                By this actor: {e.staff}
              </Chip>
              <Chip icon={target.icon} to={auditHref({ q: e.ref })}>
                By this target: {e.ref}
              </Chip>
              <Chip icon="hash" to={auditHref({ q: e.requestId })}>
                By this request: {e.requestId}
              </Chip>
            </ChipRow>
          </Card>

          <p className="ae-lock xs muted">
            <Icon name="lock" />
            <span>Action history is append-only. This entry cannot be edited or deleted; a correction is recorded as a new entry that references {e.id}. Retention: 7 years (example).</span>
          </p>
        </div>

        <div className="ae-side stack gap-5">
          <Card title="Facts" titleAs="h2" className="ae-facts">
            <KeyValue
              pairs={[
                [
                  'Actor',
                  <span className="row gap-2 nowrap">
                    <Avatar name={e.staff} className="ab-av-sm" />
                    <span className="ab-cell">
                      <span className="strong">{e.staff}</span>
                      <span className="xs muted">Role at the time: {e.role}</span>
                    </span>
                  </span>,
                ],
                [
                  'Target',
                  <span className="ab-cell">
                    <span className="row gap-1 nowrap xs muted">
                      <Icon name={target.icon} className="ic-sm" />
                      {target.label}
                    </span>
                    <Link className="mono" to={href(target.to)}>
                      {e.ref}
                    </Link>
                    <span className="xs muted">{e.sub}</span>
                  </span>,
                ],
                ['Owner', e.owner],
                ['Local time', localLabel(e)],
                ['UTC', utcLabel(e)],
                [
                  'App',
                  <Badge icon={APP_ICON[e.origin.app]} tone="outline">
                    {e.origin.app}
                  </Badge>,
                ],
                [
                  'IP address',
                  <span className="ab-cell">
                    <span className="mono">{e.origin.ip}</span>
                    <span className="xs muted">{e.origin.location}</span>
                  </span>,
                ],
                ['Device', e.origin.device],
                ['Request ID', <IdValue value={e.requestId} label="request ID" />],
                [
                  'Token ID',
                  <span className="ab-cell">
                    <IdValue value={e.tokenId} label="token ID" />
                    <span className="xs muted">Every request carries a token; this is its ID, not the token.</span>
                  </span>,
                ],
              ]}
            />
          </Card>
          <Approval e={e} />
        </div>
      </div>
    </AdminLayout>
  );
}
