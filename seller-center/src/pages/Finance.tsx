import { LoadError as SellerLoadError } from '@/pages/data/home';
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Link } from 'react-router';
import { ApiError, call, errorMessage, newIdempotencyKey, useApi, useSessionState } from '@marketly/web-shared/api';
import { SellerLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { formatMoney, money } from '@marketly/web-shared/lib/format';
import { useIsPhone } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import { Alert, announce, Badge, Button, Card, Dialog, EmptyState, Field, Icon, KeyValue, PageHeader, Pager, SegmentedControl, Select, Stat, StatusBadge, SummaryRow, TableWrap, TextInput, type IconName } from '@marketly/web-shared/ui';
import { useSellerSession } from '@/app/session';
import { MoneyInOut } from './statistics/MoneyInOut';
import { amt, download, fmtDay, fmtPeriod, fmtTime, isoDaysAgo, LEDGER_ICON, PAYOUT_STATUS, refHref, signed, signedMoney, waitForExport, type Balances, type Destination, type TxFilter } from './data/finance';

// Design: pages/seller/seller-finance.html (no views). Balances, holds and the next payout come from
// GET finance/balances; the ledger (segment = API `type`, numbered pages) from GET finance/ledger; payout
// results from GET finance/payouts. "Change payout account" (owner only) re-authenticates with the
// password (step-up: reauth, purpose payout-account; dev-key tokens in development may send the fixed proof
// dev-reauth.payout-account instead) and calls POST sellers/payout-account/change; the
// new account is verified with two test deposits (POST finance/payout-destination/confirm-deposits) and
// reviewed by Marketly Finance. The SellerFinanceOverview screen query fails on the running server
// (Money.formatted, BACKEND-REQUESTS G13), so the screen reads REST. "Money in and out" charts net earnings and
// payouts for a period (report seller.earnings, docs/09 §4.2) when the member may also run seller reports.

const FILTERS: Array<{ label: string; value: TxFilter }> = [
  { label: 'All', value: 'all' },
  { label: 'Sales', value: 'sales' },
  { label: 'Fees', value: 'fees' },
  { label: 'Refunds', value: 'refunds' },
  { label: 'Payouts', value: 'payouts' },
];

const ACCOUNT_TYPES = [
  { value: 'business_checking', label: 'Business checking' },
  { value: 'business_savings', label: 'Business savings' },
  { value: 'personal_checking', label: 'Personal checking' },
] as const;
type AccountType = (typeof ACCOUNT_TYPES)[number]['value'];

const LEDGER_LIMIT = 15;
const PAYOUT_LIMIT = 10;

interface AccountForm {
  holder: string;
  type: AccountType;
  routing: string;
  account: string;
  confirm: string;
  password: string;
}
type FormErrors = Partial<Record<keyof AccountForm, string>>;

/** Dev-key seller tokens (development only) may confirm with the fixed proof instead of a password (G50). */
const DEV_REAUTH = 'dev-reauth.payout-account';

function validate(f: AccountForm, devReauth = false) {
  const e: FormErrors = {};
  if (!f.holder.trim()) e.holder = 'Enter the account holder name. It must match your business name.';
  if (!/^\d{9}$/.test(f.routing.trim())) e.routing = 'Enter the 9-digit routing number.';
  if (!/^\d{4,17}$/.test(f.account.trim())) e.account = 'Enter an account number of 4 to 17 digits.';
  else if (f.confirm.trim() !== f.account.trim()) e.confirm = "Account numbers don't match.";
  if (!f.password && !devReauth) e.password = 'Enter your password to confirm it’s you.';
  return e;
}

const DEST_BADGE: Record<Destination['status'], { label: string; tone: 'info' | 'warning' | 'danger'; icon: IconName }> = {
  verified: { label: 'Verified', tone: 'info', icon: 'shield-check' },
  verification_pending: { label: 'Waiting for test deposits', tone: 'warning', icon: 'clock' },
  change_under_review: { label: 'Change in review', tone: 'warning', icon: 'clock' },
  missing: { label: 'Not added', tone: 'danger', icon: 'circle-alert' },
  rejected: { label: 'Rejected', tone: 'danger', icon: 'circle-alert' },
};

interface BalanceCard {
  key: 'proceeds' | 'pending' | 'available' | 'held';
  label: string;
  icon: IconName;
  className?: string;
  amount: (b: Balances) => number;
  why: (b: Balances) => string;
}
const BALANCES: BalanceCard[] = [
  { key: 'proceeds', label: 'Sales proceeds', icon: 'shopping-bag', amount: (b) => amt(b.salesProceeds), why: (b) => `Accepted sales this period (${fmtPeriod(b.salesPeriod)}), including shipping you charged. Before fees, refunds and holds.` },
  { key: 'pending', label: 'Pending earnings', icon: 'hourglass', amount: (b) => amt(b.pending), why: (b) => `After fees, waiting for delivery plus the ${b.settlementRules.availableAfterDeliveryDays}-day hold. Moves to available on its own.` },
  { key: 'available', label: 'Available earnings', icon: 'wallet', className: 'is-avail', amount: (b) => amt(b.available), why: () => 'Eligible for your next payout. Fees, refunds and holds already taken off.' },
  { key: 'held', label: 'Held amounts', icon: 'lock', className: 'is-held', amount: (b) => amt(b.held), why: () => 'Temporarily withheld. Not lost: released or adjusted after review.' },
];

function LoadError({ title, error, retry }: { title: string; error: unknown; retry: () => void }) {
  return <SellerLoadError error={error} onRetry={retry} title={title} />;
}

const skeletonRows = (n: number, cols: number) =>
  Array.from({ length: n }, (_, i) => (
    <tr key={i}>
      <td colSpan={cols}>
        <span className="sk sk-line" />
      </td>
    </tr>
  ));

export default function Finance() {
  const { api } = useApi();
  const qc = useQueryClient();
  const { sellerId, isOwner, can } = useSellerSession();
  const canView = can('finance.balances.view');
  const canChange = isOwner && can('sellers.payout-account.manage');
  const claims = useSessionState().claims;
  const devReauth = import.meta.env.DEV && claims?.dev !== undefined;
  const isPhone = useIsPhone();

  const [filter, setFilter] = useState<TxFilter>('all');
  const [page, setPage] = useState(1);
  const [payoutPage, setPayoutPage] = useState(1);
  const [dialog, setDialog] = useState(false);
  const [form, setForm] = useState<AccountForm>({ holder: '', type: 'business_checking', routing: '', account: '', confirm: '', password: '' });
  const [attempted, setAttempted] = useState(false);
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [deposits, setDeposits] = useState(['', '']);
  const idemKey = useRef(newIdempotencyKey());

  const balances = useQuery({ queryKey: ['finance', 'balances', sellerId], queryFn: () => call(api.GET('/api/seller/finance/balances')), enabled: canView });
  // Website: numbered pages; phone app: cursor with "Load more" (API.md rule 9).
  const ledger = useQuery({
    queryKey: ['finance', 'ledger', sellerId, filter, page],
    queryFn: () => call(api.GET('/api/seller/finance/ledger', { params: { query: { type: filter, page, limit: LEDGER_LIMIT } } })),
    placeholderData: keepPreviousData,
    enabled: canView && !isPhone,
  });
  const ledgerPhone = useInfiniteQuery({
    queryKey: ['finance', 'ledger', sellerId, filter, 'cursor'],
    queryFn: ({ pageParam }) => call(api.GET('/api/seller/finance/ledger', { params: { query: { type: filter, limit: LEDGER_LIMIT, ...(pageParam ? { cursor: pageParam } : {}) } } })),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor || undefined,
    enabled: canView && isPhone,
  });
  const payouts = useQuery({
    queryKey: ['finance', 'payouts', sellerId, payoutPage],
    queryFn: () => call(api.GET('/api/seller/finance/payouts', { params: { query: { page: payoutPage, limit: PAYOUT_LIMIT } } })),
    placeholderData: keepPreviousData,
    enabled: canView,
  });
  const statements = useQuery({
    queryKey: ['finance', 'statements', sellerId, 'latest'],
    queryFn: () => call(api.GET('/api/seller/finance/statements', { params: { query: { page: 1, limit: 1 } } })),
    enabled: canView,
  });
  const payoutAccount = useQuery({ queryKey: ['sellers', 'payout-account', sellerId], queryFn: () => call(api.GET('/api/seller/sellers/payout-account')), enabled: canChange });

  const b = balances.data;
  const dest = b?.destination;
  const pendingChange = dest?.pendingChange ?? null;
  const changeOpen = !!pendingChange || dest?.status === 'change_under_review' || dest?.status === 'verification_pending';
  const latestStatement = statements.data?.items[0];

  const exportLedger = useMutation({
    mutationFn: async () => {
      const job = await call(api.POST('/api/seller/finance/ledger/exports', { body: { from: isoDaysAgo(90), to: isoDaysAgo(0), format: 'csv' } }));
      announce('Ledger export started. The CSV downloads when it is ready.');
      const ready = await waitForExport(() => call(api.GET('/api/seller/finance/ledger/exports/{id}', { params: { path: { id: job.id } } })), job);
      download(ready.downloadUrl!);
      return ready;
    },
    onSuccess: (j) => announce(`Ledger export ${j.ref} is ready`),
  });

  const change = useMutation({
    mutationFn: async (f: AccountForm) => {
      const reauthToken =
        devReauth && !f.password ? DEV_REAUTH : (await call(api.POST('/api/seller/identity/reauth', { body: { purpose: 'payout-account', password: f.password } }))).reauthToken;
      return call(
        api.POST('/api/seller/sellers/payout-account/change', {
          body: { details: { accountHolderName: f.holder.trim(), accountType: f.type, routingNumber: f.routing.trim(), accountNumber: f.account.trim(), confirmAccountNumber: f.confirm.trim() }, reauthToken },
          params: { header: { 'Idempotency-Key': idemKey.current } },
        }),
      );
    },
    onSuccess: (r) => {
      setSubmitted(r.pendingChange.label);
      setDialog(false);
      announce('Payout account change submitted for review');
      void qc.invalidateQueries({ queryKey: ['finance'] });
      void qc.invalidateQueries({ queryKey: ['sellers'] });
    },
  });

  const confirmDeposits = useMutation({
    mutationFn: (cents: number[]) => call(api.POST('/api/seller/finance/payout-destination/confirm-deposits', { body: { amounts: cents.map((amount) => ({ amount, currency: 'USD' })) } })),
    onSuccess: () => {
      setDeposits(['', '']);
      announce('Test deposits confirmed');
      void qc.invalidateQueries({ queryKey: ['finance'] });
      void qc.invalidateQueries({ queryKey: ['sellers'] });
    },
  });

  // Server errors on the change: a refused password → the password field; field validation → the fields.
  const serverErrors: FormErrors = {};
  if (change.error instanceof ApiError) {
    const e = change.error;
    if (e.code === 'INVALID_CREDENTIALS' || e.code === 'CURRENT_PASSWORD_WRONG') serverErrors.password = 'The password is incorrect.';
    else if (e.code === 'STEP_UP_REQUIRED') serverErrors.password = 'Confirm it’s you again with your password.';
    const fe = e.fieldErrors;
    if (fe['details.accountHolderName']) serverErrors.holder = fe['details.accountHolderName'];
    if (fe['details.routingNumber']) serverErrors.routing = fe['details.routingNumber'];
    if (fe['details.accountNumber']) serverErrors.account = fe['details.accountNumber'];
    if (fe['details.confirmAccountNumber']) serverErrors.confirm = fe['details.confirmAccountNumber'];
  }
  const errors: FormErrors = { ...(attempted ? validate(form, devReauth) : {}), ...serverErrors };
  const set = <K extends keyof AccountForm>(k: K, v: AccountForm[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    if (change.isError) change.reset();
  };

  const openDialog = () => {
    setForm({ holder: payoutAccount.data?.current?.accountHolderName ?? '', type: 'business_checking', routing: '', account: '', confirm: '', password: '' });
    setAttempted(false);
    change.reset();
    idemKey.current = newIdempotencyKey();
    setDialog(true);
  };
  const submit = () => {
    setAttempted(true);
    if (Object.keys(validate(form, devReauth)).length) return;
    change.mutate(form);
  };

  const depositCents = deposits.map((d) => Math.round(Number(d.replace(/[$\s]/g, '')) * 100));
  const depositsValid = deposits.every((d) => /^\$?\s*\d*\.?\d{1,2}$/.test(d.trim())) && depositCents.every((c) => c > 0 && c < 100);

  const filterLabel = FILTERS.find((f) => f.value === filter)!.label.toLowerCase();
  const ledgerQ = isPhone ? ledgerPhone : ledger;
  const ledgerLoaded = isPhone ? !!ledgerPhone.data : !!ledger.data;
  const rows = (isPhone ? ledgerPhone.data?.pages.flatMap((p) => p.items) : ledger.data?.items) ?? [];
  const total = (isPhone ? undefined : ledger.data?.total) ?? rows.length;
  const ledgerPages = ledger.data?.totalPages ?? 0;
  const payoutPages = payouts.data?.totalPages ?? 0;

  if (!canView) {
    return (
      <SellerLayout active="finance">
        <PageHeader title="Finance" sub="Balances, payouts and statements." />
        <Alert tone="info" title="Finance is visible to the store owner">
          Ask the store owner for access to balances, payouts and statements.
        </Alert>
      </SellerLayout>
    );
  }

  return (
    <SellerLayout active="finance">
      <PageHeader
        title="Finance"
        sub={b ? `Balances as of ${fmtTime(b.asOf, { weekday: true, year: true })} PT. ${b.settlementRules.text}` : 'Balances, payouts and statements.'}
        actions={
          <>
            <Button variant="secondary" size="sm" icon="file-text" to={latestStatement ? href('seller/statement', undefined, { ref: latestStatement.ref }) : undefined} disabled={!latestStatement}>
              Statements
            </Button>
            <Button variant="secondary" size="sm" icon="download" onClick={() => exportLedger.mutate()} disabled={exportLedger.isPending}>
              {exportLedger.isPending ? 'Preparing export…' : 'Export ledger'}
            </Button>
          </>
        }
      />
      {exportLedger.isError && (
        <Alert tone="danger" title="The ledger export didn’t finish">
          {errorMessage(exportLedger.error)}
        </Alert>
      )}
      {balances.isError && <LoadError title="We couldn’t load your balances" error={balances.error} retry={() => void balances.refetch()} />}
      <div className="sb-kpis">
        {BALANCES.map((c) =>
          !b ? (
            <div key={c.key} className={cx('card pad sb-bal', c.className)}>
              <span className="sk sk-line short" />
              <span className="sk h-30" />
              <span className="sk sk-line" />
            </div>
          ) : (
            <div key={c.key} className={cx('card pad sb-bal', c.className)}>
              <Stat label={c.label} icon={c.icon} value={c.key === 'available' && b.negative ? <span className="sb-neg">{signed(b.available, false)}</span> : money(c.amount(b))} />
              <span className="why">{c.why(b)}</span>
              {c.key === 'held' &&
                b.holds
                  .filter((h) => h.status === 'active')
                  .map((h) => {
                    const to = refHref(h.reference);
                    return (
                      <div key={h.id} className="panel stack gap-1">
                        <span className="xs strong">
                          {h.reference?.ref &&
                            (to ? (
                              <Link className="mono" to={to}>
                                {h.reference.ref}
                              </Link>
                            ) : (
                              <span className="mono">{h.reference.ref}</span>
                            ))}
                          {h.reference?.ref ? ' · ' : ''}
                          {formatMoney(h.amount)}
                        </span>
                        <span className="xs sub">Reason: {h.reason}</span>
                        <span className="xs sub">Review date: {fmtDay(h.reviewDate)}</span>
                      </div>
                    );
                  })}
            </div>
          ),
        )}
      </div>
      {can('reports.seller.view') && <MoneyInOut />}
      <div className="sb-main">
        <div className="stack gap-5">
          <Card
            flush
            title="Transactions"
            sub={
              ledgerLoaded
                ? filter === 'all'
                  ? `Latest ${rows.length} of ${total} · balance after = pending + available + held`
                  : `${total} ${filterLabel} · balance after = pending + available + held`
                : 'Balance after = pending + available + held'
            }
            actions={
              <SegmentedControl
                items={FILTERS}
                active={filter}
                onChange={(v) => {
                  setFilter(v);
                  setPage(1);
                }}
                label="Transaction type"
              />
            }
            foot={
              <>
                <span className="xs muted grow">Ad charges are billed separately from sales commission.</span>
                {!isPhone && ledgerPages > 1 && <Pager page={page} total={ledgerPages} onPage={setPage} only="website" />}
                {isPhone && ledgerPhone.hasNextPage && (
                  <Button variant="secondary" size="sm" block onClick={() => void ledgerPhone.fetchNextPage()} disabled={ledgerPhone.isFetchingNextPage}>
                    {ledgerPhone.isFetchingNextPage ? 'Loading…' : 'Load more'}
                  </Button>
                )}
              </>
            }
          >
            {ledgerQ.isError ? (
              <div className="pad">
                <LoadError title="We couldn’t load your transactions" error={ledgerQ.error} retry={() => void ledgerQ.refetch()} />
              </div>
            ) : ledgerLoaded && rows.length === 0 ? (
              <EmptyState icon="receipt" title={filter === 'all' ? 'No transactions yet' : `No ${filterLabel} yet`}>
                Sales, fees, refunds and payouts appear here as they happen.
              </EmptyState>
            ) : (
              <TableWrap label="Transactions table">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Date</th>
                      <th scope="col">Type</th>
                      <th scope="col">Reference</th>
                      <th scope="col">Details</th>
                      <th className="r" scope="col">
                        Amount
                      </th>
                      <th className="r col-pin" scope="col">
                        Balance after
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {!ledgerLoaded
                      ? skeletonRows(6, 6)
                      : rows.map((t) => {
                          const to = refHref(t.reference, t.statementRef);
                          const ref = t.reference.ref ?? '';
                          return (
                            <tr key={t.id}>
                              <td>
                                <span className="xs sub nowrap">{fmtTime(t.at)}</span>
                              </td>
                              <td>
                                <span className="row gap-2 nowrap small">
                                  <Icon name={LEDGER_ICON[t.type] ?? 'receipt'} className="ic-sm" />
                                  {t.typeLabel}
                                </span>
                              </td>
                              <td>
                                {to ? (
                                  <Link className="mono nowrap" to={to} title={ref}>
                                    {ref}
                                  </Link>
                                ) : (
                                  <span className="mono nowrap" title={ref}>
                                    {ref}
                                  </span>
                                )}
                              </td>
                              <td>
                                <span className="small minw-220 inline-block">
                                  {t.description}
                                  {t.recordedBy?.name ? ` · ${t.recordedBy.name}` : ''}
                                </span>
                              </td>
                              <td className="r">
                                <span className={cx('num', t.amount.amount < 0 && 'sb-neg')}>{signed(t.amount)}</span>
                              </td>
                              <td className="r col-pin">
                                <span className="num small">{formatMoney(t.balanceAfter)}</span>
                              </td>
                            </tr>
                          );
                        })}
                  </tbody>
                </table>
              </TableWrap>
            )}
          </Card>

          <Card
            flush
            titleAs="h3"
            title="Payouts"
            sub="Pending → Processing → Paid, or Failed with the reason"
            foot={
              <>
                <span className="xs muted grow">Processing means the bank transfer has been sent and is not yet confirmed. A failed payout stays in your balance until it is paid to a verified account.</span>
                {payoutPages > 1 && <Pager page={payoutPage} total={payoutPages} onPage={setPayoutPage} only="website" />}
              </>
            }
          >
            {payouts.isError ? (
              <div className="pad">
                <LoadError title="We couldn’t load your payouts" error={payouts.error} retry={() => void payouts.refetch()} />
              </div>
            ) : payouts.data && payouts.data.items.length === 0 ? (
              <EmptyState icon="landmark" title="No payouts yet">
                {b?.nextPayout ? `Your next payout is scheduled for ${fmtDay(b.nextPayout.scheduledFor)}.` : 'Payouts appear here once your earnings become available and a payout is sent.'}
              </EmptyState>
            ) : (
              <>
                <TableWrap label="Payouts table">
                  <table className="table">
                    <thead>
                      <tr>
                        <th scope="col">Payout</th>
                        <th scope="col">Requested</th>
                        <th scope="col">Arrived</th>
                        <th className="r" scope="col">
                          Amount
                        </th>
                        <th scope="col">Status</th>
                        <th className="col-pin" scope="col">
                          Result
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {!payouts.data
                        ? skeletonRows(3, 6)
                        : payouts.data.items.map((p) => {
                            const failed = p.status === 'failed';
                            const result =
                              p.resultNote ||
                              (failed ? [p.failureReason, p.failureCode && `(${p.failureCode})`, p.nextStep].filter(Boolean).join(' ') : '') ||
                              (p.retryOfRef ? `Retry of ${p.retryOfRef}` : '') ||
                              (p.statementPeriod ? `Statement ${fmtPeriod(p.statementPeriod)}` : '');
                            return (
                              <tr key={p.id} className={cx(failed && 'is-flagged')}>
                                <td>
                                  {failed && <span className="sr-only">Urgent: </span>}
                                  {p.statementRef ? (
                                    <Link className="mono nowrap" to={href('seller/statement', undefined, { ref: p.statementRef })} title={p.ref}>
                                      {p.ref}
                                    </Link>
                                  ) : (
                                    <span className="mono nowrap" title={p.ref}>
                                      {p.ref}
                                    </span>
                                  )}
                                </td>
                                <td>
                                  <span className="small nowrap">{fmtDay(p.requestedOn, { weekday: true })}</span>
                                </td>
                                <td>
                                  <span className="small nowrap">{p.arrivedOn ? fmtDay(p.arrivedOn, {}) : p.status === 'pending' || p.status === 'processing' ? 'Estimated' : '—'}</span>
                                </td>
                                <td className="r">
                                  <span className="num strong">{formatMoney(p.amount)}</span>
                                </td>
                                <td>
                                  <StatusBadge status={PAYOUT_STATUS[p.status]} />
                                </td>
                                <td className="col-pin">
                                  <span className="xs sub minw-200 inline-block">{result}</span>
                                </td>
                              </tr>
                            );
                          })}
                    </tbody>
                  </table>
                </TableWrap>
                <p className="status-legend status-legend--edge">
                  <span className="sr-only">Legend: </span>
                  <span className="sl sl-danger">
                    <i aria-hidden="true" />
                    Red edge = urgent: overdue or past target
                  </span>
                </p>
              </>
            )}
          </Card>
        </div>

        <div className="stack gap-5">
          <Card
            titleAs="h3"
            title="Next payout"
            sub={b?.settlementRules.schedule}
            foot={
              canChange ? (
                <Button variant="secondary" size="sm" icon="landmark" onClick={openDialog} disabled={!b || changeOpen || !!submitted}>
                  {changeOpen || submitted ? 'Account change in review' : 'Change payout account'}
                </Button>
              ) : undefined
            }
          >
            {!b ? (
              <div className="stack gap-2">
                <span className="sk h-30" />
                <span className="sk sk-line" />
                <span className="sk sk-line short" />
              </div>
            ) : (
              <>
                {b.nextPayout ? (
                  <div className="row between base">
                    <span className="h2 num">{formatMoney(b.nextPayout.estimatedAmount)}</span>
                    <StatusBadge status="Pending" />
                  </div>
                ) : (
                  <span className="small sub">No payout is scheduled right now.</span>
                )}
                <KeyValue
                  pairs={[
                    ...(b.nextPayout
                      ? ([
                          ['Date', fmtDay(b.nextPayout.scheduledFor)],
                          ['Cutoff', `${fmtTime(b.nextPayout.cutoffAt, { weekday: true })} PT`],
                        ] as Array<[string, string]>)
                      : []),
                    [
                      'Destination',
                      <>
                        {dest?.label || 'Not added'}{' '}
                        {dest && (
                          <Badge tone={DEST_BADGE[dest.status].tone} icon={DEST_BADGE[dest.status].icon}>
                            {DEST_BADGE[dest.status].label}
                          </Badge>
                        )}
                      </>,
                    ],
                    ...(b.nextPayout ? ([['Arrives', b.nextPayout.arrivesNote]] as Array<[string, string]>) : []),
                    ...(pendingChange
                      ? ([['Requested change', `${pendingChange.label} · in review since ${fmtDay(pendingChange.requestedAt, { weekday: false })}`]] as Array<[string, string]>)
                      : submitted
                        ? ([['Requested change', `${submitted} · in review`]] as Array<[string, string]>)
                        : []),
                  ]}
                />
                {b.nextPayout && <span className="xs muted">Estimate. {b.nextPayout.note}</span>}
              </>
            )}
          </Card>

          {canChange && dest?.depositsSentAt && (
            <Card titleAs="h3" title="Confirm the test deposits" sub={`Sent ${fmtTime(dest.depositsSentAt)} to ${pendingChange?.label ?? dest.label}`}>
              <p className="small sub">
                Enter the two small amounts we sent. They usually arrive in 1–2 business days.{dest.depositAttemptsLeft != null ? ` ${dest.depositAttemptsLeft} tries left.` : ''}
              </p>
              <div className="grid md2 gap-3">
                {deposits.map((d, i) => (
                  <Field key={i} label={`Deposit ${i + 1}`}>
                    <TextInput
                      id={`po-dep-${i}`}
                      inputMode="decimal"
                      prefix="$"
                      placeholder="0.00"
                      value={d}
                      onChange={(e) => {
                        setDeposits((l) => l.map((x, k) => (k === i ? e.target.value : x)));
                        confirmDeposits.reset();
                      }}
                    />
                  </Field>
                ))}
              </div>
              {confirmDeposits.isError && (
                <Alert tone="danger" title="Those amounts didn’t match">
                  {errorMessage(confirmDeposits.error)}
                </Alert>
              )}
              <div>
                <Button size="sm" onClick={() => confirmDeposits.mutate(depositCents)} disabled={!depositsValid || confirmDeposits.isPending}>
                  {confirmDeposits.isPending ? 'Checking…' : 'Confirm deposits'}
                </Button>
              </div>
            </Card>
          )}

          {submitted ? (
            <Alert tone="success" title="Payout account change submitted">
              We send two test deposits to {submitted}. Marketly Finance reviews the change. Payouts continue to the current account until the review is done, and you get an email about every change.
            </Alert>
          ) : (
            <Alert tone="info" title="Changing the payout account">
              Only the store owner can change it. We verify the new account with a test deposit and Marketly Finance reviews the change. Payouts continue to the current account until the review is done, and you get an email about every change.
            </Alert>
          )}

          {b && (
            <Card titleAs="h3" title="When your balance goes negative" sub={b.negative ? 'Your balance is negative now' : undefined}>
              <p className="small sub">A refund approved after a payout can't come out of money already sent. {b.settlementRules.refundAfterPayout}.</p>
              {b.negative && (
                <div className="sb-recon">
                  <SummaryRow k={`Available on ${fmtTime(b.asOf)}`} v={<span className="sb-neg">{signed(b.available, false)}</span>} />
                  {b.amountOwed && <SummaryRow k={`Amount owed${b.owedDueBy ? `, due ${fmtDay(b.owedDueBy, { weekday: false })}` : ''}`} v={<span className="sb-neg">{signedMoney(-amt(b.amountOwed), false)}</span>} />}
                  <SummaryRow
                    className="total"
                    k="Balance"
                    v={
                      <span className="row gap-2">
                        <b className="sb-neg">{signed(b.available, false)}</b>
                        <StatusBadge status="Negative" />
                      </span>
                    }
                  />
                </div>
              )}
              <p className="xs muted">New earnings cover a negative balance first. Refunds after payout are listed on the statement with the original payout reference.</p>
            </Card>
          )}
        </div>
      </div>

      <Dialog
        open={dialog}
        onClose={() => setDialog(false)}
        title="Change payout account"
        foot={
          <>
            <Button variant="ghost" onClick={() => setDialog(false)}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={change.isPending}>
              {change.isPending ? 'Submitting…' : 'Submit for review'}
            </Button>
          </>
        }
      >
        {Object.keys(errors).length > 0 && <Alert tone="danger" title="Check the highlighted fields">The new account can't be submitted until every field is valid.</Alert>}
        {change.isError && !Object.keys(serverErrors).length && (
          <Alert tone="danger" title="The change wasn’t submitted">
            {errorMessage(change.error)}
          </Alert>
        )}
        <p className="small sub">Payouts continue to {dest?.label || 'the current account'} until the new account is verified and reviewed.</p>
        <Field label="Account holder" hint="Must match the business name on your seller account." error={errors.holder}>
          <TextInput id="po-holder" value={form.holder} error={!!errors.holder} onChange={(e) => set('holder', e.target.value)} />
        </Field>
        <Field label="Account type">
          <Select id="po-type" options={ACCOUNT_TYPES.map((t) => ({ value: t.value, label: t.label }))} value={form.type} onChange={(e) => set('type', e.target.value as AccountType)} />
        </Field>
        <div className="grid md2 gap-3">
          <Field label="Routing number" error={errors.routing}>
            <TextInput id="po-routing" inputMode="numeric" value={form.routing} error={!!errors.routing} onChange={(e) => set('routing', e.target.value)} />
          </Field>
          <Field label="Account number" error={errors.account}>
            <TextInput id="po-account" inputMode="numeric" value={form.account} error={!!errors.account} onChange={(e) => set('account', e.target.value)} />
          </Field>
        </div>
        <Field label="Confirm account number" error={errors.confirm}>
          <TextInput id="po-confirm" inputMode="numeric" value={form.confirm} error={!!errors.confirm} onChange={(e) => set('confirm', e.target.value)} />
        </Field>
        <Field label="Your password" hint={devReauth ? 'Development sign-in: leave empty to confirm with the development proof.' : 'We ask again before changing where your money goes.'} error={errors.password}>
          <TextInput id="po-password" type="password" autoComplete="current-password" value={form.password} error={!!errors.password} onChange={(e) => set('password', e.target.value)} />
        </Field>
        <span className="xs muted">We verify the account with a test deposit. You get an email about every change.</span>
      </Dialog>
    </SellerLayout>
  );
}
