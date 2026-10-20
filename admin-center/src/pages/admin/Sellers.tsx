import { useEffect, useMemo, useState } from 'react';
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { call, errorMessage, useApi } from '@marketly/web-shared/api';
import { AdminLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { useIsPhone } from '@marketly/web-shared/lib/hooks';
import { formatMoney } from '@marketly/web-shared/lib/format';
import { href } from '@marketly/web-shared/routes';
import { Alert, Badge, Button, CopyButton, Dialog, EmptyState, Field, Icon, LogoTile, Meter, Pager, SearchInput, Select, Stat, StatusBadge, TableWrap, Tabs, TextInput, announce } from '@marketly/web-shared/ui';
import { useStaffSession } from '@/app/session';
import { LoadError, date } from '@/app/parts';
import { SELLER_STATUS, feedbackLabel, initialsOf, signedMoney, statusLabel, tintOf, useDebounced, useInView, type ApplicationRow, type SellerRow } from './data/seller';
import { AppealsQueue, LaunchReviewQueue } from './data/seller-queues';

// Design: pages/admin/admin-sellers.html (single view). Status tabs link to "#" in the design;
// here they filter the list, in sync with the Status filter.
// ?filter=appeals | launch_reviews (no design; the work queues sellers.appeals and sellers.launch_reviews link here)
// swaps the list for the appeals or launch review queue (data/seller-queues).
// Data: GET /api/admin/sellers/sellers (q, status, verified, onTimeBelow, categoryId, balance; page on the website,
// cursor on the phone), …/sellers/stats (header, KPIs, tab counts), …/applications (open applications: the
// Applications button and links for sellers still in review), …/performance-targets (dispatch target),
// GET /api/admin/catalog/categories (main category filter). Writes: POST …/seller-invitations, POST …/sellers/exports.

type ApiStatus = 'applied' | 'information_required' | 'under_review' | 'approved' | 'restricted' | 'suspended' | 'closed';
const STATUSES = Object.keys(SELLER_STATUS) as ApiStatus[];
const TAB_ORDER: ApiStatus[] = ['approved', 'applied', 'information_required', 'under_review', 'restricted', 'suspended', 'closed'];
const OPEN_APP = new Set(['submitted', 'under_review', 'information_required']);

const VER_OPTS = ['Any', 'Verified seller', 'Not verified'];
const PERF_OPTS = ['Any', 'Below 95% target', 'Below 90%'];
const BAL_OPTS = [
  { value: '', label: 'Any balance' },
  { value: 'has_held', label: 'Has held amounts' },
  { value: 'negative', label: 'Negative balance' },
];
const LIMIT = 24;
const QUEUES = ['appeals', 'launch_reviews'] as const;
type Queue = '' | (typeof QUEUES)[number];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface Category {
  id: string;
  name: string;
  parentId?: string | null;
}
interface Target {
  metric: string;
  threshold: number;
}

export default function Sellers() {
  const { api } = useApi();
  const { can } = useStaffSession();
  const isPhone = useIsPhone();
  const [params, setParams] = useSearchParams();
  const queue = QUEUES.find((x) => x === params.get('filter')) ?? '';
  const setQueue = (v: Queue) =>
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        if (v) p.set('filter', v);
        else p.delete('filter');
        return p;
      },
      { preventScrollReset: true },
    );
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<'' | ApiStatus>('');
  const [ver, setVer] = useState(VER_OPTS[0]);
  const [perf, setPerf] = useState(PERF_OPTS[0]);
  const [cat, setCat] = useState('');
  const [bal, setBal] = useState('');
  const [page, setPage] = useState(1);
  const [invite, setInvite] = useState(false);
  const [email, setEmail] = useState('');
  const [business, setBusiness] = useState('');
  const [inviteTried, setInviteTried] = useState(false);
  // The invitation just sent: its code comes back once (no email from the offline server), shown until Done
  const [invited, setInvited] = useState<{ email: string; businessName: string; expiresAt: string; code: string } | null>(null);
  const [showCode, setShowCode] = useState(false);
  const [exported, setExported] = useState('');

  const term = useDebounced(q.trim());
  const targets = useQuery({ queryKey: ['sellers', 'performance-targets'], queryFn: () => call(api.GET('/api/admin/sellers/performance-targets')) as Promise<Target[]>, staleTime: 300_000 });
  const TARGET = targets.data?.find((t) => t.metric === 'dispatch_reliability')?.threshold ?? 95;
  const perfLabel = (o: string) => (o === PERF_OPTS[1] ? `Below ${TARGET}% target` : o);

  const query = useMemo(
    () => ({
      q: term || undefined,
      status: status || undefined,
      verified: ver === VER_OPTS[0] ? undefined : ver === VER_OPTS[1],
      onTimeBelow: perf === PERF_OPTS[0] ? undefined : perf === 'Below 90%' ? 90 : TARGET,
      categoryId: cat || undefined,
      balance: (bal || undefined) as 'has_held' | 'negative' | undefined,
    }),
    [term, status, ver, perf, cat, bal, TARGET],
  );
  useEffect(() => setPage(1), [query]);

  const stats = useQuery({ queryKey: ['sellers', 'stats'], queryFn: () => call(api.GET('/api/admin/sellers/sellers/stats')) });
  const listQ = useQuery({
    queryKey: ['sellers', 'list', query, page],
    queryFn: () => call(api.GET('/api/admin/sellers/sellers', { params: { query: { ...query, page, limit: LIMIT } } })),
    enabled: !isPhone,
    placeholderData: keepPreviousData,
  });
  const phoneQ = useInfiniteQuery({
    queryKey: ['sellers', 'list', 'phone', query],
    queryFn: ({ pageParam }) => call(api.GET('/api/admin/sellers/sellers', { params: { query: { ...query, cursor: pageParam || undefined, limit: LIMIT } } })),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: isPhone,
  });
  const active = isPhone ? phoneQ : listQ;
  const loaded = isPhone ? !!phoneQ.data : !!listQ.data;
  const rows: SellerRow[] = isPhone ? (phoneQ.data?.pages.flatMap((p) => p.items) ?? []) : (listQ.data?.items ?? []);
  const totalPages = (listQ.data as { totalPages?: number } | undefined)?.totalPages ?? 1;
  const more = useInView<HTMLDivElement>(() => void phoneQ.fetchNextPage(), isPhone && phoneQ.hasNextPage && !phoneQ.isFetchingNextPage);

  const categories = useQuery({ queryKey: ['catalog', 'categories', 'admin'], queryFn: () => call(api.GET('/api/admin/catalog/categories')) as Promise<Category[]>, staleTime: 300_000, enabled: can('catalog.view') });
  const catOpts = [{ value: '', label: 'Any category' }, ...(categories.data ?? []).filter((c) => !c.parentId).map((c) => ({ value: c.id, label: c.name }))];

  // Open applications: the Applications button and links for sellers whose account is still in review.
  const canApps = can('sellers.applications.view');
  const apps = useQuery({
    queryKey: ['sellers', 'applications', 'list', 'all'],
    queryFn: () => call(api.GET('/api/admin/sellers/applications', { params: { query: { limit: 100 } } })),
    enabled: canApps,
  });
  const openApps: ApplicationRow[] = (apps.data?.items ?? []).filter((a) => OPEN_APP.has(a.state));
  const appByStore = new Map((apps.data?.items ?? []).map((a) => [a.storeName.toLowerCase(), a.ref]));
  const appsWaiting = stats.data?.applicationsWaiting ?? openApps.length;

  const sellerTo = (r: SellerRow) => {
    const appRef = ['applied', 'information_required', 'under_review'].includes(r.status) ? appByStore.get(r.storeName.toLowerCase()) : undefined;
    return appRef ? href('admin/seller-application', '', { ref: appRef }) : href('admin/seller', '', { slug: r.slug });
  };
  const rowEdge = (r: SellerRow) => (r.status === 'suspended' ? 'flagged' : r.onTimeDispatchPct != null && r.onTimeDispatchPct < TARGET && r.status !== 'closed' ? 'warn' : '');

  const filtered = !!(q.trim() || status || ver !== VER_OPTS[0] || perf !== PERF_OPTS[0] || cat || bal);
  const clear = () => {
    setQ('');
    setStatus('');
    setVer(VER_OPTS[0]);
    setPerf(PERF_OPTS[0]);
    setCat('');
    setBal('');
  };

  const byStatus = stats.data?.byStatus ?? {};
  const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
  const tabs: Array<{ value: '' | ApiStatus; label: string; count?: number }> = [
    { value: '', label: 'All', count: stats.data ? total : undefined },
    ...TAB_ORDER.map((s) => ({ value: s, label: SELLER_STATUS[s]!, count: stats.data ? (byStatus[s] ?? 0) : undefined })),
  ];
  const balances = stats.data?.balances ?? null;
  // Open launch reviews: the work queue count (same query and cache as the sidebar counts in app/session).
  const queues = useQuery({ queryKey: ['workqueues', 'queues'], queryFn: () => call(api.GET('/api/admin/workqueues/queues')) as Promise<Array<{ key: string; open: number }>>, retry: false });
  const launchCount = queues.data?.find((x) => x.key === 'sellers.launch_reviews')?.open;

  const sendInvite = useMutation({
    mutationFn: () => call(api.POST('/api/admin/sellers/seller-invitations', { body: { email: email.trim(), businessName: business.trim() } })),
    onSuccess: ({ invitation: inv, code }) => {
      setInvited({ email: inv.email, businessName: inv.businessName, expiresAt: inv.expiresAt, code });
      setShowCode(true);
      setInvite(false);
      setEmail('');
      setBusiness('');
      setInviteTried(false);
      announce(`Invitation sent to ${inv.email}`);
    },
  });
  const emailError = inviteTried && !EMAIL_RE.test(email.trim()) ? 'Enter an email address, like owner@store.com.' : undefined;
  const businessError = inviteTried && !business.trim() ? 'Enter the business name.' : undefined;
  const submitInvite = () => {
    setInviteTried(true);
    if (!EMAIL_RE.test(email.trim()) || !business.trim()) return;
    sendInvite.mutate();
  };

  const exportList = useMutation({
    mutationFn: () => call(api.POST('/api/admin/sellers/sellers/exports', { body: { filters: query, format: 'csv' } })),
    onSuccess: () => {
      setExported('Your seller list export has started. You will find it under Reports when it is ready.');
      announce('Export started');
    },
  });

  const legend = (
    <p className="status-legend status-legend--edge">
      <span className="sr-only">Legend: </span>
      <span className="sl sl-danger">
        <i aria-hidden="true" />
        Red edge = urgent: overdue or past target
      </span>
      <span className="sl sl-warning">
        <i aria-hidden="true" />
        Amber edge = at risk: due soon or near target
      </span>
    </p>
  );
  const empty = filtered ? (
    <EmptyState icon="search-x" title="No sellers match" action={<Button variant="secondary" size="sm" onClick={clear}>Clear filters</Button>}>
      Try another name or remove a filter.
    </EmptyState>
  ) : (
    <EmptyState icon="store" title="No sellers yet">
      Invited businesses appear here once they apply.
    </EmptyState>
  );
  const skeleton = (
    <div className="sk-list" aria-hidden="true">
      {Array.from({ length: 5 }, (_, i) => (
        <div key={i} className="sk-row">
          <span className="sk sk-line" />
          <span className="sk sk-line short" />
        </div>
      ))}
    </div>
  );
  const kpi = (v: string | number | undefined) => (stats.isLoading ? <span className="sk sk-line short" /> : (v ?? '—'));

  const onTime = (r: SellerRow) => (r.onTimeDispatchPct != null && r.status !== 'closed' ? r.onTimeDispatchPct : undefined);

  return (
    <AdminLayout active="sellers">
      <div className="page-head">
        <div className="t">
          <nav className="crumbs" aria-label="Breadcrumb">
            <span>Sellers</span>
          </nav>
          <h1 className="h1">Sellers</h1>
          <p className="sub small">{stats.data ? `${total} seller account${total === 1 ? '' : 's'}` : 'Seller accounts'} · owner Seller Manager · Official Store is managed under Official store</p>
        </div>
        <div className="actions">
          {can('sellers.accounts.export') && (
            <Button variant="secondary" size="sm" icon="download" disabled={exportList.isPending} onClick={() => exportList.mutate()}>
              Export
            </Button>
          )}
          {canApps && (
            <Button variant="secondary" size="sm" icon="file-check" to={openApps[0] ? href('admin/seller-application', '', { ref: openApps[0].ref }) : href('admin/seller-application')}>
              {`Applications · ${appsWaiting}`}
            </Button>
          )}
          {can('sellers.invitations.manage') && (
            <Button size="sm" icon="send" onClick={() => setInvite(true)}>
              Invite seller
            </Button>
          )}
        </div>
      </div>

      {invited && (
        <Alert tone="success" title="Invitation sent">
          {invited.email} can now start a seller application with the invitation code. The code works until {date(invited.expiresAt)}.
        </Alert>
      )}
      {exported && (
        <Alert tone="success" title="Export started">
          {exported}
        </Alert>
      )}
      {exportList.isError && (
        <Alert tone="danger" title="We couldn’t start the export">
          {errorMessage(exportList.error)}
        </Alert>
      )}
      {stats.isError && <LoadError error={stats.error} onRetry={() => void stats.refetch()} title="We couldn’t load the seller counts" />}

      <div className="aa-kpis">
        <div className="card pad">
          <Stat label="Selling now" value={kpi(stats.data?.sellingNow)} note={stats.data ? `${stats.data.addedThisMonth} added this month` : ' '} />
        </div>
        <div className="card pad">
          <Stat label="Below dispatch target" value={stats.data?.belowDispatchTarget ? <span className="t-warning-text">{stats.data.belowDispatchTarget}</span> : kpi(stats.data?.belowDispatchTarget)} note={`Target ${TARGET}% on time`} />
        </div>
        <div className="card pad">
          <Stat
            label="Restricted or suspended"
            value={kpi(stats.data?.restrictedOrSuspended)}
            note={stats.data ? `${stats.data.appealsUnderReview} appeal${stats.data.appealsUnderReview === 1 ? '' : 's'} under review` : ' '}
          />
        </div>
        <div className="card pad">
          <Stat
            label="Seller balances"
            value={stats.isLoading ? kpi(undefined) : balances?.total ? formatMoney(balances.total) : '—'}
            note={
              balances?.total
                ? `${formatMoney(balances.held)} held · ${balances.negativeCount} negative`
                : stats.data
                  ? 'Balance totals not available'
                  : ' '
            }
          />
        </div>
      </div>

      <Tabs<Queue>
        items={[
          { value: '', label: 'Sellers' },
          { value: 'appeals', label: 'Appeals', count: stats.data?.appealsUnderReview },
          { value: 'launch_reviews', label: 'Launch reviews', count: launchCount },
        ]}
        active={queue}
        onChange={setQueue}
        label="Seller work"
      />
      {queue ? (
        <section className="card">{queue === 'appeals' ? <AppealsQueue /> : <LaunchReviewQueue />}</section>
      ) : (
        <section className="card">
          <Tabs<'' | ApiStatus> items={tabs} active={status} onChange={setStatus} label="Seller status" />
          <div className="card-body">
            <div className="toolbar">
              <SearchInput id="aa-sl-q" placeholder="Search seller name, legal name or contact email" value={q} onChange={setQ} />
            </div>
            <div className="aa-filters c5">
              <Field label="Status" className="aa-flt">
                <Select
                  id="aa-sl-st"
                  options={[{ value: '', label: 'Any status' }, ...STATUSES.map((s) => ({ value: s, label: SELLER_STATUS[s]! }))]}
                  value={status}
                  onChange={(e) => setStatus(e.target.value as '' | ApiStatus)}
                />
              </Field>
              <Field label="Verification" className="aa-flt">
                <Select id="aa-sl-ver" options={VER_OPTS} value={ver} onChange={(e) => setVer(e.target.value)} />
              </Field>
              <Field label="On-time dispatch" className="aa-flt">
                <Select id="aa-sl-perf" options={PERF_OPTS.map((o) => ({ value: o, label: perfLabel(o) }))} value={perf} onChange={(e) => setPerf(e.target.value)} />
              </Field>
              <Field label="Main category" className="aa-flt">
                <Select id="aa-sl-cat" options={catOpts} value={cat} onChange={(e) => setCat(e.target.value)} />
              </Field>
              <Field label="Balance" className="aa-flt">
                <Select id="aa-sl-bal" options={BAL_OPTS} value={bal} onChange={(e) => setBal(e.target.value)} />
              </Field>
            </div>
          </div>

          {active.isError && !loaded ? (
            <div className="card-body">
              <LoadError error={active.error} onRetry={() => void active.refetch()} title="We couldn’t load the sellers" />
            </div>
          ) : (
            <>
              <div className="no-phone">
                {!loaded ? (
                  skeleton
                ) : rows.length ? (
                  <>
                    <TableWrap label="Sellers table">
                      <table className="table">
                        <thead>
                          <tr>
                            <th scope="col">Seller</th>
                            <th scope="col">Status</th>
                            <th scope="col">Verified</th>
                            <th scope="col">Rating</th>
                            <th scope="col">On-time dispatch</th>
                            <th className="r" scope="col">Open cases</th>
                            <th className="r" scope="col">Balance</th>
                            <th scope="col">Restrictions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((r) => {
                            const edge = rowEdge(r);
                            const pct = onTime(r);
                            const below = pct !== undefined && pct < TARGET;
                            const rating = feedbackLabel(r.feedback);
                            const negative = r.negativeBalance || (r.balance?.amount ?? 0) < 0;
                            return (
                              <tr key={r.id} className={cx(edge && `is-${edge}`)}>
                                <td>
                                  {edge && <span className="sr-only">{edge === 'flagged' ? 'Urgent: ' : 'At risk: '}</span>}
                                  <Link className="row nowrap gap-2 link-inherit" to={sellerTo(r)}>
                                    <LogoTile initials={initialsOf(r.storeName)} tint={tintOf(r.id)} size="sm" />
                                    <span className="stack gap-0">
                                      <span className="small strong">{r.storeName}</span>
                                      <span className="xs muted">{r.location ?? r.ref}</span>
                                    </span>
                                  </Link>
                                </td>
                                <td>
                                  <StatusBadge status={statusLabel(r.status)} />
                                </td>
                                <td>
                                  {r.verified ? (
                                    <Badge tone="info" icon="shield-check">
                                      Verified
                                    </Badge>
                                  ) : (
                                    <span className="xs muted">Not verified</span>
                                  )}
                                </td>
                                <td>{rating ? <span className="small num">{rating}</span> : <span className="muted">—</span>}</td>
                                <td>
                                  {pct !== undefined ? (
                                    <span className="stack gap-1 minw-90">
                                      <span className={cx('strong num', below && 't-danger-text')}>{pct.toFixed(1)}%</span>
                                      <Meter pct={pct} tone={below ? 'danger' : 'success'} label={`On-time dispatch: ${r.storeName}`} />
                                      {below && <span className="xs strong meter-note t-danger-text">Below target</span>}
                                    </span>
                                  ) : (
                                    <span className="muted">—</span>
                                  )}
                                </td>
                                <td className="r">{r.openCases ? <span className={cx('strong', r.openCases >= 3 && 't-warning-text')}>{r.openCases}</span> : 0}</td>
                                <td className="r">
                                  <span className="stack gap-0">
                                    <span className={cx('strong', negative && 't-danger-text')}>{signedMoney(r.balance)}</span>
                                    {r.held?.amount ? <span className="xs t-warning-text strong">{formatMoney(r.held)} held</span> : null}
                                    {negative && <Badge tone="danger">Negative</Badge>}
                                  </span>
                                </td>
                                <td>
                                  {r.restrictionSummary ? (
                                    <span className="small u-maxw-28ch u-d-inline-block">{r.restrictionSummary}</span>
                                  ) : r.warningNote ? (
                                    <span className="xs t-warning-text strong">{r.warningNote}</span>
                                  ) : (
                                    <span className="xs muted">None</span>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </TableWrap>
                    {legend}
                  </>
                ) : (
                  empty
                )}
              </div>

              <div className="only-phone card-pad-phone">
                {!loaded ? (
                  skeleton
                ) : rows.length ? (
                  <>
                    <div className="aa-mlist">
                      {rows.map((r) => {
                        const edge = rowEdge(r);
                        const pct = onTime(r);
                        return (
                          <Link key={r.id} className={cx('aa-mcard', edge && `is-${edge}`)} to={sellerTo(r)}>
                            {edge && <span className="sr-only">{edge === 'flagged' ? 'Urgent: ' : 'At risk: '}</span>}
                            <span className="row nowrap gap-3">
                              <LogoTile initials={initialsOf(r.storeName)} tint={tintOf(r.id)} size="sm" />
                              <span className="stack gap-0 grow">
                                <span className="small strong">{r.storeName}</span>
                                <span className="xs muted">{r.location ?? r.ref}</span>
                              </span>
                              <StatusBadge status={statusLabel(r.status)} />
                            </span>
                            <span className="row gap-3 xs">
                              <span>
                                On time <b>{pct !== undefined ? `${pct.toFixed(1)}%` : '—'}</b>
                              </span>
                              <span>
                                Cases <b>{r.openCases}</b>
                              </span>
                              <span>
                                Balance <b>{signedMoney(r.balance)}</b>
                              </span>
                              {r.verified && (
                                <Badge tone="info" icon="shield-check">
                                  Verified
                                </Badge>
                              )}
                            </span>
                            {r.restrictionSummary && <span className="xs sub">{r.restrictionSummary}</span>}
                          </Link>
                        );
                      })}
                    </div>
                    <div ref={more} />
                    {legend}
                  </>
                ) : (
                  empty
                )}
              </div>
            </>
          )}

          <div className="card-foot between">
            <span className="xs muted">Balance is what we owe the seller after fees and refunds. It is not paid until a payout is sent.</span>
            {isPhone ? loaded && rows.length > 0 && <Pager only="phone" end={!phoneQ.hasNextPage} /> : totalPages > 1 && <Pager page={page} total={totalPages} onPage={setPage} only="website" />}
          </div>
        </section>
      )}

      <Dialog
        open={invite}
        onClose={() => setInvite(false)}
        title="Invite seller"
        size="sm"
        foot={
          <>
            <Button variant="ghost" onClick={() => setInvite(false)}>
              Cancel
            </Button>
            <Button icon="send" onClick={submitInvite} disabled={sendInvite.isPending}>
              Send invitation
            </Button>
          </>
        }
      >
        <p className="small sub">You get an invitation code to give the business; they enter it when they apply. They still go through verification and review.</p>
        {sendInvite.isError && (
          <Alert tone="danger" title="We couldn’t send the invitation">
            {errorMessage(sendInvite.error)}
          </Alert>
        )}
        <Field label="Contact email" error={emailError}>
          <TextInput id="aa-sl-invite" type="email" icon="mail" value={email} error={!!emailError} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Business name" error={businessError}>
          <TextInput id="aa-sl-invite-biz" value={business} error={!!businessError} onChange={(e) => setBusiness(e.target.value)} />
        </Field>
        <span className="xs muted">
          <Icon name="info" className="ic-sm" /> The code works for the invitation lifetime set in Settings (7 days unless changed).
        </span>
      </Dialog>

      <Dialog
        open={showCode && !!invited}
        onClose={() => setShowCode(false)}
        title={invited ? `${invited.businessName} is invited` : 'Invitation sent'}
        size="sm"
        dismissable={false}
        foot={
          <>
            {invited && <CopyButton text={invited.code}>Copy code</CopyButton>}
            <Button onClick={() => setShowCode(false)}>Done</Button>
          </>
        }
      >
        {invited && (
          <>
            <span className="small">
              Give {invited.businessName} ({invited.email}) this invitation code; they enter it when they apply to sell. No email is sent from this server. The code works until {date(invited.expiresAt)}.
            </span>
            <Field label="Invitation code">
              <span className="row gap-2 nowrap">
                <TextInput id="aa-sl-invite-code" className="mono" readOnly value={invited.code} onFocus={(e) => e.currentTarget.select()} />
                <CopyButton text={invited.code} label="Copy the invitation code" />
              </span>
            </Field>
            <Alert tone="warning" title="The code is shown only once">
              Copy it before you close this window. If it is lost, revoke the invitation and send a new one.
            </Alert>
          </>
        )}
      </Dialog>
    </AdminLayout>
  );
}
