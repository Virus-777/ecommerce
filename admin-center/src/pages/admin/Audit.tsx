import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { AdminLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { href } from '@marketly/web-shared/routes';
import { announce, Avatar, Breadcrumbs, Button, Card, ChipRow, Chip, Icon, KeyValue, Pager, SearchInput, Select, StatusBadge, TableWrap, Timeline, type IconName, type TimelineEvent } from '@marketly/web-shared/ui';
import { ENTRIES, TARGET, type AuditEntry as Entry, type AuditTag as Tag } from './data/audit';

// Design: pages/admin/admin-audit.html. Entries live in ./data/audit (shared with admin/audit-entry).
// ?q= and ?staff= preset the filters: the entry page's "Filter the log by…" chips link here.

const STAFF = ['All staff', 'Morgan Hale', 'Riley Chen', 'Dana Ortiz', 'Ken Watanabe', 'Ana Silva', 'Theo Grant', 'Lena Park', 'Omar Haddad', 'Grace Kim', 'Isabel Cruz', 'Priya Nair', 'Jamie Brooks', 'Noor Aziz', 'Sven Larsen', 'Mei Lin'];
const TARGETS = ['All targets', 'Orders', 'Sellers', 'Products', 'Payouts', 'Settings', 'Staff'];
const RANGES = ['Last 7 days', 'Today', 'Last 30 days', 'Custom range'];
const CHIPS: Array<{ key: 'pending' | Tag; label: string; icon: IconName }> = [
  { key: 'pending', label: 'Second review pending', icon: 'user-check' },
  { key: 'financial', label: 'Financial actions', icon: 'landmark' },
  { key: 'enforcement', label: 'Seller enforcement', icon: 'store' },
  { key: 'settings', label: 'Settings changes', icon: 'settings' },
];

const Change = ({ e }: { e: Entry }) => (
  <span className="ac-ba">
    <span className="b">{e.before}</span>
    <Icon name="arrow-right" />
    <span className="a">{e.after}</span>
  </span>
);

function historyFor(e: Entry): TimelineEvent[] {
  if (e.history) return e.history;
  const at = `${e.day}, ${e.time}`;
  const first: TimelineEvent = { t: `Requested by ${e.staff}`, d: at, state: 'done' };
  if (e.approval === 'Approved') return [first, { t: `Approved by ${e.approvalNote.split(',')[0]}`, d: e.approvalNote.split(', ')[1] ?? e.day, state: 'done' }];
  if (e.approval === 'Pending') return [{ ...first, body: 'Second review required' }, { t: e.approvalNote, d: 'Not yet reviewed', state: 'current' }];
  return [{ t: `Recorded by ${e.staff}`, d: at, state: 'done', body: `No second review: ${e.approvalNote.toLowerCase()}` }];
}

const label = (e: Entry) => `${e.day}, ${e.time}`;
const entryHref = (e: Entry) => href('admin/audit-entry', '', { id: e.id });

export default function Audit() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [q, setQ] = useState(params.get('q') ?? '');
  const [staff, setStaff] = useState(STAFF.includes(params.get('staff') ?? '') ? params.get('staff')! : STAFF[0]);
  const [target, setTarget] = useState(TARGETS[0]);
  const [range, setRange] = useState(RANGES[0]);
  const [chips, setChips] = useState<Array<'pending' | Tag>>([]);
  const [selId, setSelId] = useState(ENTRIES[0].id);
  const [page, setPage] = useState(1);

  const needle = q.trim().toLowerCase();
  const rows = ENTRIES.filter(
    (e) =>
      (!needle || [e.id, e.ref, e.sub, e.staff, e.action, e.reason, e.requestId, e.code, ...e.changes.map((c) => c.after ?? '')].some((t) => t.toLowerCase().includes(needle))) &&
      (staff === STAFF[0] || e.staff === staff) &&
      (target === TARGETS[0] || e.target === target) &&
      (range !== 'Today' || e.day === 'Oct 8') &&
      chips.every((c) => (c === 'pending' ? e.approval === 'Pending' : e.tags.includes(c))),
  );
  const sel = ENTRIES.find((e) => e.id === selId) ?? ENTRIES[0];
  const toggleChip = (k: 'pending' | Tag) => setChips((cs) => (cs.includes(k) ? cs.filter((c) => c !== k) : [...cs, k]));

  const exportCsv = () => {
    const head = ['Time', 'Staff', 'Role', 'Action', 'Target', 'Reference', 'Reason', 'Before', 'After', 'Approval', 'Approval note'];
    const lines = rows.map((e) => [label(e), e.staff, e.role, e.action, TARGET[e.target].label, e.ref, e.reason, e.before, e.after, e.approval, e.approvalNote]);
    const csv = [head, ...lines].map((l) => l.map((c) => `"${c.replace(/"/g, '""')}"`).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'action-history.csv';
    a.click();
    URL.revokeObjectURL(url);
    announce(`Exported ${rows.length} actions as CSV`);
  };

  const targetCell = (e: Entry): ReactNode => (
    <span className="stack gap-0">
      <span className="row gap-1 nowrap xs muted">
        <Icon name={TARGET[e.target].icon} className="ic-sm" />
        {TARGET[e.target].label}
      </span>
      <Link className="mono nowrap" to={href(TARGET[e.target].to)} title={e.ref}>
        {e.ref}
      </Link>
      <span className="xs muted">{e.sub}</span>
    </span>
  );

  return (
    <AdminLayout active="audit">
      <div className="page-head">
        <div className="t">
          <Breadcrumbs items={[{ label: 'Reports and settings' }, { label: 'Action history' }]} />
          <h1 className="h1">Action history</h1>
          <p className="sub small">Every material change with its reason and approvals. Records cannot be edited or deleted.</p>
        </div>
        <div className="actions">
          <Button variant="secondary" size="sm" icon="download" onClick={exportCsv}>
            Export CSV
          </Button>
        </div>
      </div>

      <div className="toolbar">
        <SearchInput id="au-q" placeholder="Search by order, seller, SKU, payout or staff" value={q} onChange={setQ} />
        <label className="sr-only" htmlFor="au-staff">
          Staff
        </label>
        <Select id="au-staff" options={STAFF} value={staff} onChange={(e) => setStaff(e.target.value)} />
        <label className="sr-only" htmlFor="au-target">
          Target
        </label>
        <Select id="au-target" options={TARGETS} value={target} onChange={(e) => setTarget(e.target.value)} />
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
                {rows.length === ENTRIES.length && range !== 'Today' ? `214 actions in the ${range.toLowerCase()} · showing ${rows.length}` : `${rows.length} matching action${rows.length === 1 ? '' : 's'}`}
              </span>
            </div>
          </div>
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
                  {rows.map((e) => {
                    const warn = e.approval === 'Pending';
                    return (
                      <tr key={e.id} className={cx(warn && 'is-warn', e.id === selId && 'is-selected')} aria-selected={e.id === selId}>
                        <td>
                          {warn && <span className="sr-only">At risk: </span>}
                          <Link className="small nowrap" to={entryHref(e)} title={`Open full entry ${e.id}`}>
                            {label(e)}
                          </Link>
                        </td>
                        <td>
                          <span className="ac-who">
                            <Avatar name={e.staff} className="ac-av" />
                            <span className="stack gap-0">
                              <span className="small strong nowrap">{e.staff}</span>
                              <span className="xs muted nowrap">{e.role}</span>
                            </span>
                          </span>
                        </td>
                        <td>
                          <button type="button" className="btn-bare tight small strong" onClick={() => setSelId(e.id)}>
                            {e.action}
                          </button>
                        </td>
                        <td>{targetCell(e)}</td>
                        <td>
                          <span className="small minw-200 cell-text">{e.reason}</span>
                        </td>
                        <td>
                          <Change e={e} />
                        </td>
                        <td className="col-pin">
                          <span className="stack gap-1 items-start">
                            <StatusBadge status={e.approval} />
                            <span className="xs muted nowrap">{e.approvalNote}</span>
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                  {rows.length === 0 && (
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
            {rows.map((e) => (
              <div key={e.id} className={cx('ac-mi', e.approval === 'Pending' && 'is-warn')} onClick={() => navigate(entryHref(e))}>
                {e.approval === 'Pending' && <span className="sr-only">At risk: </span>}
                <div className="row between gap-2 nowrap top">
                  <Link className="small strong min-w-0" to={entryHref(e)} onClick={(ev) => ev.stopPropagation()}>
                    {e.action}
                  </Link>
                  <StatusBadge status={e.approval} />
                </div>
                <div className="xs sub">
                  {label(e)} · {e.staff}, {e.role}
                </div>
                <div className="xs sub">
                  {TARGET[e.target].label} <span className="mono">{e.ref}</span> · {e.reason}
                </div>
                <div className="xs sub">
                  <Change e={e} />
                </div>
              </div>
            ))}
          </div>
          <p className="status-legend status-legend--edge only-phone">
            <span className="sr-only">Legend: </span>
            <span className="sl sl-warning">
              <i aria-hidden="true" />
              Amber edge = at risk: due soon or near target
            </span>
          </p>
          <div className="card-foot between">
            <span className="xs muted">Retention: 7 years (example)</span>
            <Pager page={page} total={22} onPage={setPage} />
          </div>
        </section>

        <Card
          title={sel.action}
          titleAs="h3"
          sub={`${label(sel)} · selected entry`}
          actions={
            <Button variant="secondary" size="sm" iconRight="arrow-right" to={entryHref(sel)}>
              Open full entry
            </Button>
          }
        >
          <KeyValue
            pairs={[
              ['Staff', `${sel.staff}, ${sel.role}`],
              [
                'Target',
                <>
                  {TARGET[sel.target].label}{' '}
                  <Link className="mono nowrap" to={href(TARGET[sel.target].to)}>
                    {sel.ref}
                  </Link>{' '}
                  · {sel.sub}
                </>,
              ],
              ['Change', <Change e={sel} />],
              ['Reason', sel.reason],
              ...(sel.extra ?? []),
            ]}
          />
          <div className="divider" />
          <span className="small strong">Approval history</span>
          <Timeline events={historyFor(sel)} />
        </Card>
      </div>
    </AdminLayout>
  );
}
