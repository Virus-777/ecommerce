import { useEffect, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { call, errorMessage, useApi } from '@marketly/web-shared/api';
import { AdminLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { formatMoney, num } from '@marketly/web-shared/lib/format';
import { useView } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import { Alert, Avatar, Badge, Button, Drawer, Field, KeyValue, LazyLoad, PageHeader, Pager, SearchInput, Select, StatusBadge, TableWrap, Textarea, announce } from '@marketly/web-shared/ui';
import { useStaffSession } from '@/app/session';
import { LoadError, SkeletonLines, date, dateTime, dayKey, monthYear, shortDate } from '@/app/parts';
import { sentForApproval } from './data/finance';
import {
  ACCOUNT_ACTIONS, ACTION_REASONS, DATA_REQUEST_LABEL, STATUS_LABEL, VERIFICATION_LABEL, VERIFIED_TONE, useDebounced,
  type AccountAction, type AccountStatus, type CustomerDetail, type CustomerRow, type GuestBuyer, type ReasonCode, type Verification,
} from './data/customers';

// Design: pages/admin/admin-customers.html · view "customer-detail" = the customer drawer
// (the open customer's row is marked at risk while the drawer is open, as in the design).
// Data: GET /api/admin/customers/customers (q, status, verification, open cases, abuse reports, joined this week;
// page), /guest-buyers (Guest buyers chip), /customers/{id} (drawer). Writes: POST /customers/{id}/actions
// (recorded reason; closing with open obligations goes for approval), /restrictions/{id}/lift,
// /data-requests/{id}/retry. (AdminCustomer GraphQL fails: Customer.walletAdmin isn't in the schema.)

type View = 'customer-detail';
type ChipKey = 'all' | 'cases' | 'abuse' | 'new' | 'guest';
const LIMIT = 25;

const CHIPS: Array<{ key: ChipKey; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'cases', label: 'Open cases' },
  { key: 'abuse', label: 'Abuse reports' },
  { key: 'new', label: 'New this week' },
  { key: 'guest', label: 'Guest buyers' },
];

const STATUS_OPTIONS = [{ value: '', label: 'All account statuses' }, ...(Object.keys(STATUS_LABEL) as AccountStatus[]).map((s) => ({ value: s, label: STATUS_LABEL[s] }))];
const VERIFICATION_OPTIONS = [{ value: '', label: 'Any verification' }, ...(Object.keys(VERIFICATION_LABEL) as Verification[]).map((s) => ({ value: s, label: VERIFICATION_LABEL[s] }))];

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The detail's sign-in block (typed `unknown` in the API, G20). */
interface SignIn {
  method?: string;
  twoStepEnabled?: boolean;
  lastSignInAt?: string | null;
}

function signInText(s: SignIn | undefined): string {
  if (!s) return 'Not on file';
  return [s.method, s.twoStepEnabled ? 'two-step code on' : null, s.lastSignInAt ? `last ${dateTime(s.lastSignInAt)}` : null].filter(Boolean).join(' · ') || 'Not on file';
}

function marketingText(d: CustomerDetail): string {
  const m = d.marketing;
  const on = [m.emailPromotions && 'Email', m.smsPromotions && 'SMS', m.pushPromotions && 'Push'].filter(Boolean) as string[];
  return on.length ? `${on.join(', ')} offers on · essential updates always on` : 'Essential updates only';
}

function addressText(d: CustomerDetail): string {
  const a = d.defaultAddress?.address;
  if (!a) return 'Not on file';
  return [a.line1, a.line2, a.city, `${a.region ?? ''} ${a.postalCode ?? ''}`.trim()].filter(Boolean).join(', ');
}

/** A guest buyer shown in the customer table's shape. */
interface Row {
  id: string;
  guest: boolean;
  name: string;
  email: string;
  location: string;
  orders: number;
  spend: CustomerRow['totalSpend'];
  openCases: number;
  status: string;
  verified?: Verification;
  joined: string;
  lastOrderRef?: string | null;
}

const fromCustomer = (c: CustomerRow): Row => ({
  id: c.id,
  guest: false,
  name: c.name,
  email: c.email,
  location: c.location ?? '—',
  orders: c.orderCount,
  spend: c.totalSpend,
  openCases: c.openCases,
  status: STATUS_LABEL[c.accountStatus],
  verified: c.verification,
  joined: monthYear(c.joinedAt),
});
const fromGuest = (g: GuestBuyer): Row => ({
  id: g.id,
  guest: true,
  name: g.name ?? g.email,
  email: g.email,
  location: '—',
  orders: g.orderCount,
  spend: g.totalSpend,
  openCases: g.openCases ?? 0,
  status: 'Guest',
  joined: shortDate(g.firstOrderAt),
  lastOrderRef: g.lastOrderRef,
});

export default function Customers() {
  const { api } = useApi();
  const qc = useQueryClient();
  const { can } = useStaffSession();
  const [view, setView] = useView<View>();
  const [params] = useSearchParams();
  // ?customer=<id> (links from a case) opens that customer's drawer.
  const [openId, setOpenId] = useState<string | null>(() => params.get('customer'));
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [verification, setVerification] = useState('');
  const [chip, setChip] = useState<ChipKey>('all');
  const [page, setPage] = useState(1);
  const [action, setAction] = useState<AccountAction | ''>('');
  const [reason, setReason] = useState<ReasonCode | ''>('');
  const [details, setDetails] = useState('');
  const [notice, setNotice] = useState<{ tone: 'success' | 'info'; title: string; body: string } | null>(null);

  const term = useDebounced(q.trim(), 300);
  const canAct = can('customers.accounts.act');
  const canSecurity = can('customers.accounts.security') || canAct;
  const canDataRequests = can('customers.data-requests.manage');
  const guestView = chip === 'guest';

  useEffect(() => setPage(1), [term, status, verification, chip]);

  const weekAgo = dayKey(new Date(Date.now() - 7 * 86_400_000));
  const customers = useQuery({
    queryKey: ['customers', 'list', term, status, verification, chip, page],
    queryFn: () =>
      call(
        api.GET('/api/admin/customers/customers', {
          params: {
            query: {
              q: term || undefined,
              status: (status || undefined) as AccountStatus | undefined,
              verification: (verification || undefined) as Verification | undefined,
              hasOpenCases: chip === 'cases' ? true : undefined,
              hasAbuseReports: chip === 'abuse' ? true : undefined,
              joinedFrom: chip === 'new' ? weekAgo : undefined,
              page,
              limit: LIMIT,
            },
          },
        }),
      ),
    enabled: !guestView,
    placeholderData: keepPreviousData,
  });
  const guests = useQuery({
    queryKey: ['customers', 'guests', guestView ? term : '', guestView ? page : 1],
    queryFn: () => call(api.GET('/api/admin/customers/guest-buyers', { params: { query: { q: (guestView && term) || undefined, page: guestView ? page : 1, limit: guestView ? LIMIT : 1 } } })),
    placeholderData: keepPreviousData,
  });
  const totals = useQuery({ queryKey: ['customers', 'list', 'total'], queryFn: () => call(api.GET('/api/admin/customers/customers', { params: { query: { page: 1, limit: 1 } } })) });

  const listQ = guestView ? guests : customers;
  const rows: Row[] = guestView ? ((guests.data?.items ?? []) as GuestBuyer[]).map(fromGuest) : ((customers.data?.items ?? []) as CustomerRow[]).map(fromCustomer);
  const totalPages = listQ.data?.totalPages ?? 1;
  const total = listQ.data?.total ?? rows.length;
  const accountTotal = totals.data?.total ?? 0;
  const guestTotal = guests.data?.total;

  const drawerOpen = view === 'customer-detail';
  const firstAccount = rows.find((r) => !r.guest)?.id ?? null;
  const currentId = openId ?? (drawerOpen ? firstAccount : null);
  const detail = useQuery({
    queryKey: ['customers', 'detail', currentId],
    queryFn: () => call(api.GET('/api/admin/customers/customers/{id}', { params: { path: { id: currentId! } } })) as Promise<CustomerDetail>,
    enabled: drawerOpen && !!currentId,
  });
  const d = detail.data;
  const p = d?.profile;
  const name = p ? p.displayName || `${p.firstName ?? ''} ${p.lastName ?? ''}`.trim() : (rows.find((r) => r.id === currentId)?.name ?? '');
  const statusText = p ? STATUS_LABEL[p.accountStatus as AccountStatus] : '';

  const resetForm = () => {
    setAction('');
    setReason('');
    setDetails('');
    apply.reset();
  };
  const openCustomer = (id: string) => {
    if (id !== currentId) resetForm();
    setOpenId(id);
  };
  const close = () => setView('');

  const refresh = (id: string) => {
    void qc.invalidateQueries({ queryKey: ['customers', 'detail', id] });
    void qc.invalidateQueries({ queryKey: ['customers', 'list'] });
  };

  const apply = useMutation({
    mutationFn: (v: { id: string; action: AccountAction; reasonCode: ReasonCode; details: string }) =>
      call(api.POST('/api/admin/customers/customers/{id}/actions', { params: { path: { id: v.id } }, body: { action: v.action, reasonCode: v.reasonCode, details: v.details } })),
    onSuccess: (r, v) => {
      refresh(v.id);
      const label = ACCOUNT_ACTIONS.find((a) => a.value === v.action)?.label ?? v.action;
      const reasonLabel = ACTION_REASONS.find((x) => x.value === v.reasonCode)?.label ?? v.reasonCode;
      setNotice({ tone: 'success', title: `${label}: recorded for ${name}`, body: `Reason: ${reasonLabel}. Account status is ${STATUS_LABEL[r.accountStatus]}. ${r.effects.join(' ')} The action and your details are in Action history.`.replace(/\s+/g, ' ') });
      announce(`${label} recorded`);
      resetForm();
      close();
    },
    onError: (e, v) => {
      if (sentForApproval(e)) {
        refresh(v.id);
        setNotice({ tone: 'info', title: `Sent for approval: ${ACCOUNT_ACTIONS.find((a) => a.value === v.action)?.label ?? v.action}`, body: `${name} still has open orders, returns or cases, so a second reviewer approves this before it applies.` });
        resetForm();
        close();
      }
    },
  });
  const lift = useMutation({
    mutationFn: (v: { id: string; restrictionId: string; reason: string }) => call(api.POST('/api/admin/customers/customers/{id}/restrictions/{restrictionId}/lift', { params: { path: { id: v.id, restrictionId: v.restrictionId } }, body: { reason: v.reason } })),
    onSuccess: (_r, v) => {
      refresh(v.id);
      announce('Restriction lifted');
    },
  });
  const retryExport = useMutation({
    mutationFn: (id: string) => call(api.POST('/api/admin/customers/data-requests/{id}/retry', { params: { path: { id } } })),
    onSuccess: () => currentId && refresh(currentId),
  });

  const chosen = ACCOUNT_ACTIONS.find((a) => a.value === action);
  const actionAllowed = chosen ? (chosen.security ? canSecurity : canAct) : false;
  const canApply = action !== '' && reason !== '' && details.trim() !== '' && actionAllowed && !!currentId;
  const doApply = () => {
    if (!canApply || !action || !reason || !currentId) return;
    apply.mutate({ id: currentId, action, reasonCode: reason, details: details.trim() });
  };

  const detailLink = href('admin/customers', 'customer-detail');
  const atRisk = (r: Row) => drawerOpen && r.id === currentId;
  const activeRestrictions = (d?.restrictions ?? []).filter((r) => r.state === 'active');

  return (
    <AdminLayout active="customers">
      <PageHeader
        crumbs={[{ label: 'Admin', to: href('admin/dashboard') }, { label: 'Customers and service' }]}
        title="Customers"
        sub={`${num(accountTotal)} accounts${guestTotal != null ? ` · ${num(guestTotal)} guest buyers with order lookup` : ''} · account actions need a recorded reason`}
        actions={
          can('customers.accounts.export') ? (
            <Button variant="secondary" size="sm" icon="download" disabled title="The customer export opens from the Reports screen">
              Export
            </Button>
          ) : undefined
        }
      />
      {notice && (
        <Alert tone={notice.tone} title={notice.title}>
          {notice.body}
        </Alert>
      )}
      <div className="toolbar">
        <SearchInput id="cu-q" placeholder={guestView ? 'Search guest buyers by name or email' : 'Search by name, email, phone or order number'} value={q} onChange={setQ} />
        {!guestView && (
          <>
            <Select id="cu-status" aria-label="Account status" options={STATUS_OPTIONS} value={status} onChange={(e) => setStatus(e.target.value)} />
            <Select id="cu-ver" aria-label="Verification" options={VERIFICATION_OPTIONS} value={verification} onChange={(e) => setVerification(e.target.value)} />
          </>
        )}
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
                <th scope="col">{guestView ? 'First order' : 'Joined'}</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {listQ.isPending && (
                <tr>
                  <td colSpan={9}>
                    <SkeletonLines rows={5} />
                  </td>
                </tr>
              )}
              {listQ.isError && (
                <tr>
                  <td colSpan={9}>
                    <LoadError error={listQ.error} onRetry={() => void listQ.refetch()} />
                  </td>
                </tr>
              )}
              {listQ.isSuccess && rows.length === 0 && (
                <tr>
                  <td colSpan={9} className="muted">
                    {guestView ? 'No guest buyers match this search.' : 'No customers match these filters.'}
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
                          {c.guest ? (
                            c.name
                          ) : (
                            <Link to={detailLink} preventScrollReset onClick={() => openCustomer(c.id)}>
                              {c.name}
                            </Link>
                          )}
                        </span>
                        <span className="xs muted">{c.email}</span>
                      </span>
                    </span>
                  </td>
                  <td>{c.location}</td>
                  <td className="r">{c.orders}</td>
                  <td className="r">
                    <span className="num">{formatMoney(c.spend)}</span>
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
                  <td>{c.verified ? <Badge tone={VERIFIED_TONE[c.verified]}>{VERIFICATION_LABEL[c.verified]}</Badge> : <span className="muted">—</span>}</td>
                  <td>{c.joined}</td>
                  <td>
                    {c.guest ? (
                      c.lastOrderRef ? (
                        <Link className="btn btn-ghost btn-sm" to={href('admin/order', '', { ref: c.lastOrderRef })}>
                          <span>Last order</span>
                          <span className="sr-only"> {c.name}</span>
                        </Link>
                      ) : null
                    ) : (
                      <Link className="btn btn-ghost btn-sm" to={detailLink} preventScrollReset onClick={() => openCustomer(c.id)}>
                        <span>Open</span>
                        <span className="sr-only"> {c.name}</span>
                      </Link>
                    )}
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
            Showing {rows.length} of {num(total)}
          </span>
          {totalPages > 1 && <Pager page={page} total={totalPages} onPage={setPage} />}
        </div>
      </div>
      <ul className="ab-mlist only-phone">
        {rows.map((c) => (
          <li key={c.id} className="card pad">
            <Link className="row between link-inherit" to={c.guest ? (c.lastOrderRef ? href('admin/order', '', { ref: c.lastOrderRef }) : detailLink) : detailLink} preventScrollReset onClick={() => !c.guest && openCustomer(c.id)}>
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
                {plural(c.orders, 'order')} · {formatMoney(c.spend)}
              </span>
              <span>{plural(c.openCases, 'open case')}</span>
            </span>
          </li>
        ))}
      </ul>
      {page < totalPages && <LazyLoad />}

      <Drawer
        open={drawerOpen}
        onClose={close}
        title={name || 'Customer'}
        foot={
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button disabled={!canApply || apply.isPending} onClick={doApply}>
              Apply action
            </Button>
          </>
        }
      >
        {!currentId && !listQ.isPending && <p className="small sub">Choose a customer from the list.</p>}
        {detail.isPending && currentId && <SkeletonLines rows={6} />}
        {detail.isError && <LoadError error={detail.error} onRetry={() => void detail.refetch()} />}
        {d && p && (
          <>
            <div className="row gap-3">
              <Avatar name={name} size="lg" />
              <div className="stack gap-1">
                <span className="row gap-2">
                  <b>{name}</b>
                  <StatusBadge status={statusText} />
                </span>
                <span className="xs muted">
                  Customer since {monthYear(p.memberSince)} · ID {p.ref}
                </span>
              </div>
            </div>
            <KeyValue
              pairs={[
                ['Email', <>{p.email} {p.emailVerified && <Badge tone="info">Verified</Badge>}</>],
                ['Phone', <>{p.phone ?? 'Not on file'} {p.phone && p.phoneVerified && <Badge tone="info">Verified</Badge>}</>],
                ['Default address', addressText(d)],
                ['Sign-in', signInText(d.signIn as SignIn | undefined)],
                ['Marketing', marketingText(d)],
              ]}
            />
            <div className="row between">
              <span className="small strong">
                Orders ({d.orders.count}) · {formatMoney(d.orders.totalSpend)} spent
              </span>
              <Link className="xs strong" to={href('admin/orders')}>
                All orders
              </Link>
            </div>
            {d.orders.recent.length > 0 && (
              <ul className="list">
                {d.orders.recent.map((o) => (
                  <li key={o.ref}>
                    <span className="grow stack gap-0">
                      <Link className="mono small" to={href('admin/order', '', { ref: o.ref })}>
                        {o.ref}
                      </Link>
                      <span className="xs muted">
                        {date(o.placedAt)} · {plural(o.packageCount, 'package')}
                      </span>
                    </span>
                    <span className="small num">{formatMoney(o.total)}</span>
                    <StatusBadge status={o.statusLabel} />
                  </li>
                ))}
              </ul>
            )}
            {d.openCases.length > 0 && (
              <div className="stack gap-2">
                <span className="small strong">{d.openCases.length === 1 ? 'Open case' : `Open cases (${d.openCases.length})`}</span>
                {d.openCases.map((c) => (
                  <Link key={c.caseId} className="panel row between link-inherit" to={href('admin/case', '', { ref: c.ref })}>
                    <span className="stack gap-0">
                      <span className="mono small">{c.ref}</span>
                      <span className="xs muted">
                        {c.subject}
                        {c.sellerName ? ` · ${c.sellerName}` : ''}
                      </span>
                    </span>
                    <StatusBadge status={c.statusLabel} />
                  </Link>
                ))}
              </div>
            )}
            <div className="stack gap-2">
              <span className="small strong">Messages</span>
              <span className="small sub">
                {d.messages.conversationCount
                  ? `${plural(d.messages.conversationCount, 'order conversation')}${d.messages.lastMessageAt ? ` · last message ${shortDate(d.messages.lastMessageAt)}${d.messages.lastCounterparty ? ` to ${d.messages.lastCounterparty}` : ''}` : ''}`
                  : 'No order conversations'}
              </span>
            </div>
            {d.notes.length > 0 && (
              <div className="stack gap-2">
                <span className="small strong">Internal notes</span>
                {d.notes.map((n) => (
                  <div key={n.id} className="ab-msg is-note">
                    <span className="who">
                      <b>{n.author.name ?? 'Staff'}</b> · {shortDate(n.createdAt)}
                    </span>
                    <p>{n.body}</p>
                  </div>
                ))}
              </div>
            )}
            <div className="stack gap-2">
              <span className="small strong">Abuse reports</span>
              <span className="small sub">
                {d.abuseReports.filedBy || d.abuseReports.against
                  ? [d.abuseReports.against ? `${plural(d.abuseReports.against, 'report')} filed against this customer` : null, d.abuseReports.filedBy ? `${plural(d.abuseReports.filedBy, 'report')} filed by this customer` : null].filter(Boolean).join(' · ') + '.'
                  : 'None filed by or against this customer.'}
              </span>
            </div>
            {activeRestrictions.length > 0 && (
              <div className="stack gap-2">
                <span className="small strong">Restrictions</span>
                <ul className="list">
                  {activeRestrictions.map((r) => (
                    <li key={r.id}>
                      <span className="grow stack gap-0">
                        <span className="small">
                          {r.scope === 'account' ? 'Account' : `${r.scope.charAt(0).toUpperCase()}${r.scope.slice(1)}`} restricted · {r.reason}
                        </span>
                        <span className="xs muted">
                          Since {date(r.startsAt)}
                          {r.endsAt ? ` · until ${date(r.endsAt)}` : ' · until lifted'}
                          {r.setBy.name ? ` · by ${r.setBy.name}` : ''}
                        </span>
                      </span>
                      {canAct && (
                        <Button variant="ghost" size="sm" disabled={lift.isPending || !details.trim()} title={details.trim() ? undefined : 'Write the reason in Details for the record first'} onClick={() => lift.mutate({ id: p.id, restrictionId: r.id, reason: details.trim() })}>
                          Lift
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
                {lift.error && <span className="xs t-danger-text">{errorMessage(lift.error)}</span>}
              </div>
            )}
            {d.dataRequests.length > 0 && (
              <div className="stack gap-2">
                <span className="small strong">Data requests</span>
                <ul className="list">
                  {d.dataRequests.map((r) => (
                    <li key={r.id}>
                      <span className="grow stack gap-0">
                        <span className="small">{r.kind === 'export' ? 'Data export' : 'Account closure'}</span>
                        <span className="xs muted">
                          Requested {date(r.requestedAt)}
                          {r.dueBy && !r.completedAt && !r.cancelledAt ? ` · due ${date(r.dueBy)}` : ''}
                        </span>
                      </span>
                      <StatusBadge status={DATA_REQUEST_LABEL[r.state] ?? r.state} />
                      {r.kind === 'export' && r.state === 'failed' && canDataRequests && (
                        <Button variant="ghost" size="sm" disabled={retryExport.isPending} onClick={() => retryExport.mutate(r.id)}>
                          Retry
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
                {retryExport.error && <span className="xs t-danger-text">{errorMessage(retryExport.error)}</span>}
              </div>
            )}
            {d.unavailable.length > 0 && <p className="xs muted">Not available right now: {d.unavailable.join(', ')}.</p>}
            <div className="divider" />
            <span className="h4">Account action</span>
            {!canAct && !canSecurity ? (
              <p className="small sub">Your role can view customers but not change their accounts.</p>
            ) : (
              <>
                {apply.error && !sentForApproval(apply.error) && (
                  <Alert tone="danger" title="That didn’t work">
                    {errorMessage(apply.error)}
                  </Alert>
                )}
                <Field label="Action">
                  <Select
                    id="cu-act"
                    options={[{ value: '', label: 'Choose an action' }, ...ACCOUNT_ACTIONS.filter((a) => (a.security ? canSecurity : canAct)).map((a) => ({ value: a.value, label: a.label }))]}
                    value={action}
                    onChange={(e) => setAction(e.target.value as AccountAction | '')}
                  />
                </Field>
                <Field label="Reason">
                  <Select id="cu-reason" options={[{ value: '', label: 'Select a reason' }, ...ACTION_REASONS]} value={reason} onChange={(e) => setReason(e.target.value as ReasonCode | '')} />
                </Field>
                <Field label="Details for the record">
                  <Textarea id="cu-detail" placeholder="What happened and what evidence you checked" value={details} onChange={(e) => setDetails(e.target.value)} />
                </Field>
              </>
            )}
            <Alert tone="info" title="What stays available">
              Restricting or closing an account stops new orders. Existing orders, returns, refunds and cases stay open and reachable by the customer and our teams.
            </Alert>
          </>
        )}
      </Drawer>
    </AdminLayout>
  );
}
