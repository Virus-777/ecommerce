import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { AdminLayout } from '@/layouts';
import { cx } from '@/lib/cx';
import { href } from '@/routes/href';
import { announce, Avatar, Breadcrumbs, Button, Card, ChipRow, Chip, Icon, KeyValue, Pager, SearchInput, Select, StatusBadge, TableWrap, Timeline, type IconName, type TimelineEvent } from '@/ui';

// Design: pages/admin/admin-audit.html

type Target = 'Orders' | 'Sellers' | 'Products' | 'Payouts' | 'Settings' | 'Staff';
type Approval = 'Approved' | 'Pending' | 'Not required';
type Tag = 'financial' | 'enforcement' | 'settings';

interface Entry {
  id: string;
  day: 'Oct 8' | 'Oct 7' | 'Oct 6';
  time: string;
  staff: string;
  role: string;
  action: string;
  target: Target;
  ref: string;
  sub: string;
  reason: string;
  before: string;
  after: string;
  approval: Approval;
  approvalNote: string;
  tags: Tag[];
  extra?: Array<[string, string]>;
  history?: TimelineEvent[];
}

const TARGET: Record<Target, { label: string; icon: IconName; to?: string }> = {
  Payouts: { label: 'Payout', icon: 'wallet', to: href('admin/payouts') },
  Products: { label: 'Product', icon: 'package', to: href('admin/catalog') },
  Sellers: { label: 'Seller', icon: 'store', to: href('admin/seller') },
  Orders: { label: 'Order', icon: 'shopping-bag', to: href('admin/order') },
  Staff: { label: 'Staff', icon: 'user-cog', to: href('admin/staff') },
  Settings: { label: 'Setting', icon: 'settings', to: href('admin/settings') },
};

const ENTRIES: Entry[] = [
  {
    id: 'e1', day: 'Oct 8', time: '9:32 AM', staff: 'Priya Nair', role: 'Finance Manager', action: 'Released payout hold', target: 'Payouts', ref: 'PO-261009-0418', sub: 'Casa Verde Home', reason: 'Carrier confirmed delivery for disputed order MK-260921-18320', before: 'Held $1,240.00', after: 'Available $1,240.00', approval: 'Approved', approvalNote: 'Morgan Hale, 9:41 AM', tags: ['financial'],
    extra: [['Hold placed', 'Sep 29 · review date Oct 9'], ['Evidence', 'UPS proof of delivery, case CS-260930-1172']],
    history: [
      { t: 'Requested by Priya Nair', d: 'Oct 8, 9:32 AM', state: 'done', body: 'Above $1,000 threshold, second review required' },
      { t: 'Approved by Morgan Hale, Business Owner', d: 'Oct 8, 9:41 AM', state: 'done' },
      { t: 'Included in payout run', d: 'Fri, Oct 9, 10:00 AM PT', state: 'current', body: 'Approved is not paid. Status shows Paid only after the bank confirms.' },
    ],
  },
  { id: 'e2', day: 'Oct 8', time: '9:05 AM', staff: 'Ana Silva', role: 'Inventory Manager', action: 'Stock adjustment', target: 'Products', ref: 'PLR-CI26', sub: 'Pellar Cast Iron Skillet', reason: 'Damaged in receiving, PUR-2610-0039', before: 'Available 79', after: 'Available 77, Damaged 2', approval: 'Not required', approvalNote: 'Under 50 units', tags: [] },
  { id: 'e3', day: 'Oct 8', time: '8:47 AM', staff: 'Grace Kim', role: 'Seller Manager', action: 'Restricted seller', target: 'Sellers', ref: 'Gadget Grove', sub: 'New sales paused', reason: 'Late dispatch 11% over 30 days, target under 4%', before: 'Approved', after: 'Restricted', approval: 'Approved', approvalNote: 'Sven Larsen, 8:52 AM', tags: ['enforcement'] },
  { id: 'e4', day: 'Oct 7', time: '6:12 PM', staff: 'Isabel Cruz', role: 'Customer Support Manager', action: 'Goodwill credit', target: 'Orders', ref: 'MK-261002-55410', sub: 'Jordan Lee', reason: 'Delivery 4 days late, seller Casa Verde Home', before: '$0.00', after: '$15.00 credit', approval: 'Not required', approvalNote: 'Within $50 limit', tags: ['financial'] },
  { id: 'e5', day: 'Oct 7', time: '4:40 PM', staff: 'Omar Haddad', role: 'Catalog Manager', action: 'Suspended offer', target: 'Products', ref: 'BRL-S2', sub: 'Gadget Grove offer', reason: 'Counterfeit report TR-261007-004 under review', before: 'Active', after: 'Suspended', approval: 'Not required', approvalNote: 'Catalog role', tags: ['enforcement'] },
  { id: 'e6', day: 'Oct 7', time: '3:18 PM', staff: 'Priya Nair', role: 'Finance Manager', action: 'Refund without return', target: 'Orders', ref: 'MK-260930-21877', sub: 'Kestrel 27" Monitor', reason: 'Package lost by carrier, claim USPS-CLM-4410', before: 'Requested', after: 'Approved $329.00', approval: 'Pending', approvalNote: 'Waiting for Morgan Hale', tags: ['financial'] },
  { id: 'e7', day: 'Oct 7', time: '11:02 AM', staff: 'Riley Chen', role: 'Platform Administrator', action: 'Assigned role', target: 'Staff', ref: 'Hannah Wu', sub: 'Finance staff', reason: 'New finance staff member, invited', before: 'No role', after: 'Finance staff, view only', approval: 'Not required', approvalNote: 'Access only', tags: [] },
  { id: 'e8', day: 'Oct 7', time: '10:15 AM', staff: 'Riley Chen', role: 'Platform Administrator', action: 'Scheduled setting change', target: 'Settings', ref: 'Returns · Electronics', sub: 'From Nov 1', reason: 'Align with manufacturer return terms', before: '30 days', after: '15 days', approval: 'Approved', approvalNote: 'Morgan Hale, Oct 7', tags: ['settings'] },
  { id: 'e9', day: 'Oct 6', time: '5:55 PM', staff: 'Theo Grant', role: 'Shipping Manager', action: 'Opened carrier claim', target: 'Orders', ref: 'MK-261001-33019', sub: 'UPS-CLM-88412', reason: 'UPS scan shows damage in transit', before: 'No claim', after: 'Claim $116.00', approval: 'Not required', approvalNote: 'Within $1,000 limit', tags: ['financial'] },
  { id: 'e10', day: 'Oct 6', time: '2:31 PM', staff: 'Dana Ortiz', role: 'Official Store Manager', action: 'Price change', target: 'Products', ref: 'HAL-AUR-BLK', sub: 'Official Store offer', reason: 'Home Week markdown, Oct 6–19', before: '$229.00', after: '$189.00 (−17%)', approval: 'Not required', approvalNote: 'Within 30% limit', tags: [] },
];

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

export default function Audit() {
  const [q, setQ] = useState('');
  const [staff, setStaff] = useState(STAFF[0]);
  const [target, setTarget] = useState(TARGETS[0]);
  const [range, setRange] = useState(RANGES[0]);
  const [chips, setChips] = useState<Array<'pending' | Tag>>([]);
  const [selId, setSelId] = useState('e1');
  const [page, setPage] = useState(1);

  const needle = q.trim().toLowerCase();
  const rows = ENTRIES.filter(
    (e) =>
      (!needle || [e.ref, e.sub, e.staff, e.action, e.reason].some((t) => t.toLowerCase().includes(needle))) &&
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
      <a className="mono nowrap" href="#" title={e.ref}>
        {e.ref}
      </a>
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
                          <span className="small nowrap">{label(e)}</span>
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
              <div key={e.id} className={cx('ac-mi', e.approval === 'Pending' && 'is-warn')} onClick={() => setSelId(e.id)}>
                {e.approval === 'Pending' && <span className="sr-only">At risk: </span>}
                <div className="row between gap-2 nowrap top">
                  <span className="small strong min-w-0">{e.action}</span>
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

        <Card title={sel.action} titleAs="h3" sub={`${label(sel)} · selected entry`}>
          <KeyValue
            pairs={[
              ['Staff', `${sel.staff}, ${sel.role}`],
              [
                'Target',
                <>
                  {TARGET[sel.target].label}{' '}
                  {TARGET[sel.target].to ? (
                    <Link className="mono nowrap" to={TARGET[sel.target].to!}>
                      {sel.ref}
                    </Link>
                  ) : (
                    <span className="mono nowrap">{sel.ref}</span>
                  )}{' '}
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
