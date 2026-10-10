import { useState } from 'react';
import { Link } from 'react-router';
import { AdminLayout } from '@/layouts';
import { cx } from '@/lib/cx';
import { money, num } from '@/lib/format';
import { useView } from '@/lib/hooks';
import { href } from '@/routes/href';
import { Alert, Avatar, Badge, Button, Drawer, Field, KeyValue, LazyLoad, PageHeader, Pager, SearchInput, Select, StatusBadge, TableWrap, Textarea, announce, type Tone } from '@/ui';
import {
  ACCOUNT_ACTIONS, ACTION_REASONS, ACTION_STATUS, CUSTOMER_DETAIL, CUSTOMERS, TOTAL_CUSTOMERS,
  type AccountAction, type CustomerDetail, type CustomerRow, type Verification,
} from './data/customers';

// Design: pages/admin/admin-customers.html · view "customer-detail" = the customer drawer
// (the open customer's row is marked at risk while the drawer is open, as in the design).

type View = 'customer-detail';
type ChipKey = 'all' | 'cases' | 'abuse' | 'new' | 'guest';

const CHIPS: Array<{ key: ChipKey; label: string; match: (c: CustomerRow) => boolean }> = [
  { key: 'all', label: 'All', match: () => true },
  { key: 'cases', label: 'Open cases', match: (c) => c.openCases > 0 },
  { key: 'abuse', label: 'Abuse reports', match: (c) => c.tags.includes('abuse') },
  { key: 'new', label: 'New this week', match: (c) => c.tags.includes('new') },
  { key: 'guest', label: 'Guest buyers', match: (c) => c.tags.includes('guest') },
];

const ALL_STATUSES = 'All account statuses';
const ANY_VERIFICATION = 'Any verification';
const STATUS_OPTIONS = [ALL_STATUSES, 'Active', 'Restricted', 'Under review', 'Suspended', 'Closed'];
const VERIFICATION_OPTIONS = [ANY_VERIFICATION, 'Email and phone', 'Email only', 'Not verified'];
const VERIFIED_TONE: Record<Verification, Tone> = { 'Email and phone': 'success', 'Email only': 'outline', 'Not verified': 'warning' };

/** First batch of the phone list; the app lazy-loads the rest. */
const PHONE_BATCH = 5;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Detail record for a customer; customers without a full sample record get a summary from their row. */
function detailFor(c: CustomerRow): CustomerDetail {
  return (
    CUSTOMER_DETAIL[c.id] ?? {
      phone: 'Not on file',
      address: 'Not on file',
      signIn: 'Password',
      marketing: 'Essential updates only',
      orders: [],
      messages: 'No order conversations',
      notes: [],
      abuse: c.tags.includes('abuse') ? '1 report filed against this customer.' : 'None filed by or against this customer.',
    }
  );
}

export default function Customers() {
  const [view, setView] = useView<View>();
  const [customers, setCustomers] = useState(CUSTOMERS);
  const [openId, setOpenId] = useState(CUSTOMERS[0].id);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState(ALL_STATUSES);
  const [verification, setVerification] = useState(ANY_VERIFICATION);
  const [chip, setChip] = useState<ChipKey>('all');
  const [page, setPage] = useState(1);
  const [action, setAction] = useState<AccountAction | ''>('');
  const [reason, setReason] = useState('');
  const [details, setDetails] = useState('');
  const [notice, setNotice] = useState<{ title: string; body: string } | null>(null);

  const drawerOpen = view === 'customer-detail';
  const current = customers.find((c) => c.id === openId) ?? customers[0];
  const detail = detailFor(current);
  const canApply = action !== '' && reason !== '' && details.trim() !== '';

  const needle = q.trim().toLowerCase();
  const chipMatch = CHIPS.find((c) => c.key === chip)!.match;
  const rows = customers.filter(
    (c) =>
      (!needle || `${c.name} ${c.email} ${c.id}`.toLowerCase().includes(needle)) &&
      (status === ALL_STATUSES || c.status === status) &&
      (verification === ANY_VERIFICATION || c.verified === verification) &&
      chipMatch(c),
  );

  const openCustomer = (id: string) => {
    if (id !== openId) {
      setAction('');
      setReason('');
      setDetails('');
    }
    setOpenId(id);
  };
  const close = () => setView('');
  const apply = () => {
    if (!canApply || !action) return;
    const next = ACTION_STATUS[action];
    if (next) setCustomers((l) => l.map((c) => (c.id === current.id ? { ...c, status: next } : c)));
    setNotice({ title: `${action}: recorded for ${current.name}`, body: `Reason: ${reason}. ${next ? `Account status is now ${next}. ` : ''}The action and your details are in Action history.` });
    announce(`${action} recorded`);
    setAction('');
    setReason('');
    setDetails('');
    close();
  };

  const detailLink = href('admin/customers', 'customer-detail');
  const atRisk = (c: CustomerRow) => drawerOpen && c.id === current.id;

  return (
    <AdminLayout active="customers">
      <PageHeader
        crumbs={[{ label: 'Admin', to: href('admin/dashboard') }, { label: 'Customers and service' }]}
        title="Customers"
        sub={`${num(TOTAL_CUSTOMERS)} accounts · 1,212 guest buyers with order lookup · account actions need a recorded reason`}
        actions={
          <Button variant="secondary" size="sm" icon="download">
            Export
          </Button>
        }
      />
      {notice && (
        <Alert tone="success" title={notice.title}>
          {notice.body}
        </Alert>
      )}
      <div className="toolbar">
        <SearchInput id="cu-q" placeholder="Search by name, email, phone or order number" value={q} onChange={setQ} />
        <Select id="cu-status" aria-label="Account status" options={STATUS_OPTIONS} value={status} onChange={(e) => setStatus(e.target.value)} />
        <Select id="cu-ver" aria-label="Verification" options={VERIFICATION_OPTIONS} value={verification} onChange={(e) => setVerification(e.target.value)} />
        <Button variant="secondary" size="sm" icon="filter">
          More filters
        </Button>
      </div>
      <div className="hscroll gap-2">
        {CHIPS.map((c) => (
          <a
            key={c.key}
            className={cx('chip', chip === c.key && 'is-active')}
            href="#"
            aria-current={chip === c.key ? 'true' : undefined}
            onClick={(e) => {
              e.preventDefault();
              setChip(c.key);
            }}
          >
            {c.label}
          </a>
        ))}
      </div>
      <div className="card no-phone">
        <TableWrap label="Customers table">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Customer</th>
                <th scope="col">Location</th>
                <th className="r" scope="col">Orders</th>
                <th className="r" scope="col">Spend</th>
                <th className="r" scope="col">Open cases</th>
                <th scope="col">Account status</th>
                <th scope="col">Verified</th>
                <th scope="col">Joined</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={9} className="muted">
                    No customers match these filters.
                  </td>
                </tr>
              )}
              {rows.map((c) => (
                <tr key={c.id} className={cx(atRisk(c) && 'is-warn')}>
                  <td>
                    {atRisk(c) && <span className="sr-only">At risk: </span>}
                    <span className="row nowrap gap-3">
                      <Avatar name={c.name} />
                      <span className="ab-cell">
                        <span className="strong">
                          <Link to={detailLink} preventScrollReset onClick={() => openCustomer(c.id)}>
                            {c.name}
                          </Link>
                        </span>
                        <span className="xs muted">{c.email}</span>
                      </span>
                    </span>
                  </td>
                  <td>{c.location}</td>
                  <td className="r">{c.orders}</td>
                  <td className="r">
                    <span className="num">{money(c.spend)}</span>
                  </td>
                  <td className="r">
                    {c.openCases > 0 ? (
                      <Link className="strong" to={href('admin/cases')}>
                        {c.openCases}
                      </Link>
                    ) : (
                      <span className="muted">0</span>
                    )}
                  </td>
                  <td>
                    <StatusBadge status={c.status} />
                  </td>
                  <td>
                    <Badge tone={VERIFIED_TONE[c.verified]}>{c.verified}</Badge>
                  </td>
                  <td>{c.joined}</td>
                  <td>
                    <Link className="btn btn-ghost btn-sm" to={detailLink} preventScrollReset onClick={() => openCustomer(c.id)}>
                      <span>Open</span>
                      <span className="sr-only"> {c.name}</span>
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
        {drawerOpen && (
          <p className="status-legend status-legend--edge">
            <span className="sr-only">Legend: </span>
            <span className="sl sl-warning">
              <i aria-hidden="true" />
              Amber edge = at risk: due soon or near target
            </span>
          </p>
        )}
        <div className="card-foot">
          <span className="ab-note grow">
            Showing {rows.length} of {num(TOTAL_CUSTOMERS)}
          </span>
          <Pager page={page} total={2301} onPage={setPage} />
        </div>
      </div>
      <ul className="ab-mlist only-phone">
        {rows.slice(0, PHONE_BATCH).map((c) => (
          <li key={c.id} className="card pad">
            <Link className="row between link-inherit" to={detailLink} preventScrollReset onClick={() => openCustomer(c.id)}>
              <span className="row gap-3">
                <Avatar name={c.name} />
                <span className="ab-cell">
                  <span className="strong">{c.name}</span>
                  <span className="xs muted">{c.location}</span>
                </span>
              </span>
              <StatusBadge status={c.status} />
            </Link>
            <span className="row between xs sub">
              <span>
                {plural(c.orders, 'order')} · {money(c.spend)}
              </span>
              <span>{plural(c.openCases, 'open case')}</span>
            </span>
          </li>
        ))}
      </ul>
      <LazyLoad />

      <Drawer
        open={drawerOpen}
        onClose={close}
        title={current.name}
        foot={
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button disabled={!canApply} onClick={apply}>
              Apply action
            </Button>
          </>
        }
      >
        <div className="row gap-3">
          <Avatar name={current.name} size="lg" />
          <div className="stack gap-1">
            <span className="row gap-2">
              <b>{current.name}</b>
              <StatusBadge status={current.status} />
            </span>
            <span className="xs muted">
              Customer since {current.joined} · ID {current.id}
            </span>
          </div>
        </div>
        <KeyValue
          pairs={[
            ['Email', <>{current.email} {current.verified !== 'Not verified' && <Badge tone="info">Verified</Badge>}</>],
            ['Phone', <>{detail.phone} {current.verified === 'Email and phone' && <Badge tone="info">Verified</Badge>}</>],
            ['Default address', detail.address],
            ['Sign-in', detail.signIn],
            ['Marketing', detail.marketing],
          ]}
        />
        <div className="row between">
          <span className="small strong">
            Orders ({current.orders}) · {money(current.spend)} spent
          </span>
          <Link className="xs strong" to={href('admin/orders')}>
            All orders
          </Link>
        </div>
        {detail.orders.length > 0 && (
          <ul className="list">
            {detail.orders.map((o) => (
              <li key={o.ref}>
                <span className="grow stack gap-0">
                  <Link className="mono small" to={href('admin/order')}>
                    {o.ref}
                  </Link>
                  <span className="xs muted">
                    {o.date} · {plural(o.sellers, 'seller')}
                  </span>
                </span>
                <span className="small num">{money(o.total)}</span>
                <StatusBadge status={o.status} />
              </li>
            ))}
          </ul>
        )}
        {detail.openCase && (
          <div className="stack gap-2">
            <span className="small strong">Open case</span>
            <Link className="panel row between link-inherit" to={href('admin/case')}>
              <span className="stack gap-0">
                <span className="mono small">{detail.openCase.ref}</span>
                <span className="xs muted">{detail.openCase.summary}</span>
              </span>
              <StatusBadge status={detail.openCase.status} />
            </Link>
          </div>
        )}
        <div className="stack gap-2">
          <span className="small strong">Messages</span>
          <span className="small sub">{detail.messages}</span>
        </div>
        {detail.notes.length > 0 && (
          <div className="stack gap-2">
            <span className="small strong">Internal notes</span>
            {detail.notes.map((n) => (
              <div key={n.who + n.date} className="ab-msg is-note">
                <span className="who">
                  <b>{n.who}</b> · {n.date}
                </span>
                <p>{n.text}</p>
              </div>
            ))}
          </div>
        )}
        <div className="stack gap-2">
          <span className="small strong">Abuse reports</span>
          <span className="small sub">{detail.abuse}</span>
        </div>
        <div className="divider" />
        <span className="h4">Account action</span>
        <Field label="Action">
          <Select id="cu-act" options={[{ value: '', label: 'Choose an action' }, ...ACCOUNT_ACTIONS.map((a) => ({ value: a, label: a }))]} value={action} onChange={(e) => setAction(e.target.value as AccountAction | '')} />
        </Field>
        <Field label="Reason">
          <Select id="cu-reason" options={[{ value: '', label: 'Select a reason' }, ...ACTION_REASONS.map((r) => ({ value: r, label: r }))]} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <Field label="Details for the record">
          <Textarea id="cu-detail" placeholder="What happened and what evidence you checked" value={details} onChange={(e) => setDetails(e.target.value)} />
        </Field>
        <Alert tone="info" title="What stays available">
          Restricting or closing an account stops new orders. Existing orders, returns, refunds and cases stay open and reachable by the customer and our teams.
        </Alert>
      </Drawer>
    </AdminLayout>
  );
}
