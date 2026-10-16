import { useEffect, useRef, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { call, errorMessage, newIdempotencyKey, useApi } from '@marketly/web-shared/api';
import { AdminLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { formatMoney, num } from '@marketly/web-shared/lib/format';
import { useView } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import { Alert, Avatar, Button, Card, Checkbox, Dialog, Field, Icon, PageHeader, Pager, SearchInput, Stat, StatusBadge, TableWrap, Textarea, announce, type IconName } from '@marketly/web-shared/ui';
import { useStaffSession } from '@/app/session';
import { LoadError, SkeletonLines, date, dateTime, longDate, shortDate, time } from '@/app/parts';
import { sentForApproval } from './data/finance';
import { isStepUpCancel, reauthField, useStepUp } from './data/step-up';
import {
  CHECK_TONE, OPEN_RUN, PAYOUT_STATUS, RUN_CHECK_TONE, RUN_STATUS, STATUS_MEANING, approvalSteps, destState,
  type ApprovalStep, type DestState, type DestinationReview, type Payout, type PayoutRun, type RunPayoutRow,
} from './data/payouts';

// Design: pages/admin/admin-payouts.html · view "approve-run" = the approval dialog.
// Data: GET /api/admin/finance/payout-runs (the newest open run, or ?run=<ref>), …/{id}/payouts (sellers),
// /finance/payouts?status=failed, /finance/destination-reviews. Writes: submit, approve (Idempotency-Key,
// the password again above the approver's limit), send-back, payouts/{id}/retry, destination-reviews approve/reject
// (always the password again: reauthToken, purpose payout-destination), access approval-requests/{id}/remind. (AdminPayoutRun GraphQL fails on Money.formatted, G37.)

type View = 'approve-run';
type CheckTone = 'ok' | 'info' | 'warn';
const LIMIT = 25;

const LEGEND_TEXT = { danger: 'Red edge = urgent: overdue or past target', warning: 'Amber edge = at risk: due soon or near target' } as const;

/** Status legend with the design's sr-only "Legend: " prefix (the shared StatusLegend omits it). */
function EdgeLegend({ items }: { items: Array<keyof typeof LEGEND_TEXT> }) {
  return (
    <p className="status-legend status-legend--edge">
      <span className="sr-only">Legend: </span>
      {items.map((t) => (
        <span key={t} className={`sl sl-${t}`}>
          <i aria-hidden="true" />
          {LEGEND_TEXT[t]}
        </span>
      ))}
    </p>
  );
}

const CHECK_ICON = { ok: 'circle-check', info: 'info', warn: 'triangle-alert' } as const;
const CHECK_SR: Partial<Record<CheckTone, string>> = { ok: 'Passed: ', warn: 'Warning: ' };

/** .ab-checks list (passed / info / warning lines). */
function Checks({ items }: { items: Array<{ tone: CheckTone; text: string; sub?: string | null }> }) {
  return (
    <ul className="ab-checks">
      {items.map((c) => (
        <li key={c.text} className={`t-${c.tone}`}>
          {CHECK_SR[c.tone] && <span className="sr-only">{CHECK_SR[c.tone]}</span>}
          <Icon name={CHECK_ICON[c.tone]} className="ic-sm" />
          <span className="stack gap-0">
            <span>{c.text}</span>
            {c.sub && <span className="xs muted">{c.sub}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

const DEST: Record<DestState, { cls: string; icon: 'shield-check' | 'triangle-alert' | 'clock'; text: string }> = {
  verified: { cls: 't-success-text', icon: 'shield-check', text: 'Verified' },
  review: { cls: 't-warning-text', icon: 'triangle-alert', text: 'Change under review' },
  pending: { cls: 't-warning-text', icon: 'clock', text: 'Verification pending' },
  missing: { cls: 't-danger-text', icon: 'triangle-alert', text: 'No verified account' },
};

const isAtRisk = (s: RunPayoutRow) => s.status === 'on_hold' || destState(s.destination.status) !== 'verified';

const APPROVAL_BADGE: Record<ApprovalStep['state'], { label: string; tone: 'success' | 'warning' }> = {
  approved: { label: 'Approved', tone: 'success' },
  pending: { label: 'Pending', tone: 'warning' },
  'sent-back': { label: 'Changes requested', tone: 'warning' },
};

/** .ab-approvals list; `dialog` switches to the dialog's wording. */
function Approvals({ steps, dialog }: { steps: ApprovalStep[]; dialog?: boolean }) {
  return (
    <ul className="ab-approvals">
      {steps.map((s, i) => {
        const done = s.state === 'approved';
        const title = dialog ? s.who : done || !s.pendingTitle ? `${s.who} · ${s.role}` : s.pendingTitle;
        return (
          <li key={s.key}>
            <span className={cx('n', done ? 'is-done' : 'is-wait')}>{done ? <Icon name="check" className="ic-sm" /> : i + 1}</span>
            <span className="ab-cell">
              <span className="strong">{title}</span>
              <span className="xs muted">{dialog ? s.dialogMeta : s.meta}</span>
            </span>
            <StatusBadge status={APPROVAL_BADGE[s.state].label} tone={APPROVAL_BADGE[s.state].tone} />
          </li>
        );
      })}
    </ul>
  );
}

const releaseLabel = (iso: string) => `${shortDate(iso)}, ${time(iso)} PT`;

type DestDecision = { review: DestinationReview; approve: boolean } | null;

export default function Payouts() {
  const { api } = useApi();
  const qc = useQueryClient();
  const { can, name, roles } = useStaffSession();
  const [view, setView] = useView<View>();
  const [params] = useSearchParams();
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [reminded, setReminded] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'success' | 'info' | 'danger'; title: string; body: string } | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<{ confirm?: string; note?: string }>({});
  const stepUp = useStepUp();
  const approveKey = useRef(newIdempotencyKey());
  const retryKeys = useRef<Record<string, string>>({});
  const [dest, setDest] = useState<DestDecision>(null);
  const [destReason, setDestReason] = useState('');
  const [destCallback, setDestCallback] = useState(false);
  const [destErrors, setDestErrors] = useState<{ reason?: string }>({});

  const canPrepare = can('finance.payouts.prepare');
  const canApproveRole = can('finance.payouts.approve');
  const canReviewDest = can('finance.destinations.review');

  const runs = useQuery({ queryKey: ['finance', 'payout-runs'], queryFn: () => call(api.GET('/api/admin/finance/payout-runs', { params: { query: { limit: 20 } } })) });
  const wanted = params.get('run');
  const runList = (runs.data?.items ?? []) as PayoutRun[];
  const listed = (wanted ? runList.find((r) => r.ref === wanted) : undefined) ?? runList.find((r) => OPEN_RUN.has(r.status)) ?? runList[0];
  const runId = listed?.id;

  const runQ = useQuery({
    queryKey: ['finance', 'payout-run', runId],
    queryFn: () => call(api.GET('/api/admin/finance/payout-runs/{id}', { params: { path: { id: runId! } } })) as Promise<PayoutRun>,
    enabled: !!runId,
    placeholderData: listed,
  });
  const run = runQ.data;
  const sellers = useQuery({
    queryKey: ['finance', 'payout-run', runId, 'payouts', q.trim(), page],
    queryFn: () => call(api.GET('/api/admin/finance/payout-runs/{id}/payouts', { params: { path: { id: runId! }, query: { q: q.trim() || undefined, page, limit: LIMIT } } })),
    enabled: !!runId,
    placeholderData: keepPreviousData,
  });
  const failed = useQuery({ queryKey: ['finance', 'payouts', 'failed'], queryFn: () => call(api.GET('/api/admin/finance/payouts', { params: { query: { status: 'failed', limit: 50 } } })) });
  const reviews = useQuery({
    queryKey: ['finance', 'destination-reviews'],
    queryFn: () => call(api.GET('/api/admin/finance/destination-reviews', { params: { query: { limit: 20 } } })),
    enabled: canReviewDest,
    retry: false,
  });

  useEffect(() => setPage(1), [q]);

  const refreshRun = () => {
    void qc.invalidateQueries({ queryKey: ['finance', 'payout-run', runId] });
    void qc.invalidateQueries({ queryKey: ['finance', 'payout-runs'] });
    void qc.invalidateQueries({ queryKey: ['workqueues', 'queues'] });
  };

  const openApproval = () => {
    setConfirm(false);
    setNote('');
    setErrors({});
    approveKey.current = newIdempotencyKey();
    approve.reset();
    sendBack.reset();
  };
  const close = () => setView('');

  const approve = useMutation({
    mutationFn: (v: { note: string }) =>
      stepUp.run(
        (token) =>
          call(
            api.POST('/api/admin/finance/payout-runs/{id}/approve', {
              // The confirmed retry is a new request: a new key, so the refused first try isn't replayed.
              params: { path: { id: runId! }, header: { 'Idempotency-Key': token ? newIdempotencyKey() : approveKey.current } },
              body: { confirmedReview: true, note: v.note || null, ...reauthField(token) },
            }),
          ) as Promise<PayoutRun>,
      ),
    onSuccess: (r) => {
      refreshRun();
      void qc.invalidateQueries({ queryKey: ['access', 'me'] });
      if (r.status === 'approved' || r.status === 'releasing')
        setNotice({ tone: 'success', title: `Payout run ${r.ref} approved`, body: `Release is scheduled for ${releaseLabel(r.scheduledRelease)}. Each payout moves to Processing at release and shows Paid when the bank confirms.` });
      else
        setNotice({ tone: 'info', title: 'Your approval is recorded; sent for a second approval', body: r.approval?.reason ?? 'A second, different Finance reviewer approves before the run is released.' });
      announce('Payout run approval recorded');
      close();
    },
    onError: (e) => {
      if (sentForApproval(e)) {
        refreshRun();
        setNotice({ tone: 'info', title: 'Sent for approval', body: 'This run is above your payout limit. It was sent to a Finance reviewer with a higher limit.' });
        close();
      }
    },
  });
  const sendBack = useMutation({
    mutationFn: (reason: string) => call(api.POST('/api/admin/finance/payout-runs/{id}/send-back', { params: { path: { id: runId! } }, body: { reason } })) as Promise<PayoutRun>,
    onSuccess: (r, reason) => {
      refreshRun();
      setNotice({ tone: 'info', title: `Run ${r.ref} sent back`, body: `Your comment: "${reason}". The run is not released until every approval is recorded.` });
      announce('Run sent back');
      close();
    },
  });
  const submitRun = useMutation({
    mutationFn: () => call(api.POST('/api/admin/finance/payout-runs/{id}/submit', { params: { path: { id: runId! } } })) as Promise<PayoutRun>,
    onSuccess: (r) => {
      refreshRun();
      setNotice({ tone: 'success', title: `Run ${r.ref} submitted for approval`, body: r.approval?.reason ?? 'Finance reviewers are notified.' });
    },
    onError: (e) => setNotice({ tone: 'danger', title: 'The run wasn’t submitted', body: errorMessage(e) }),
  });
  const remind = useMutation({
    mutationFn: (id: string) => call(api.POST('/api/admin/access/approval-requests/{id}/remind', { params: { path: { id } }, body: {} })),
    onSuccess: () => {
      setReminded(true);
      announce('Reminder sent');
    },
    onError: (e) => setNotice({ tone: 'danger', title: 'The reminder wasn’t sent', body: errorMessage(e) }),
  });
  const retry = useMutation({
    mutationFn: (p: Payout) => {
      const key = (retryKeys.current[p.id] ??= newIdempotencyKey());
      return call(api.POST('/api/admin/finance/payouts/{id}/retry', { params: { path: { id: p.id }, header: { 'Idempotency-Key': key } }, body: { now: false, reason: `Retry in run ${run?.ref ?? ''}`.trim() } })) as Promise<Payout>;
    },
    onSuccess: (x, p) => {
      void qc.invalidateQueries({ queryKey: ['finance', 'payouts'] });
      refreshRun();
      setNotice({ tone: 'success', title: `${p.ref} added to this run`, body: `${formatMoney(x.amount)} to ${x.sellerName} is paid at release.` });
    },
    onError: (e, p) => setNotice({ tone: 'danger', title: `${p.ref} wasn’t retried`, body: errorMessage(e) }),
  });
  const decide = useMutation({
    mutationFn: (v: { review: DestinationReview; approve: boolean; reason: string; callback: boolean }) =>
      stepUp.run((token) => {
        const opts = { params: { path: { id: v.review.id } } };
        return v.approve
          ? call(api.POST('/api/admin/finance/destination-reviews/{id}/approve', { ...opts, body: { reason: v.reason, callbackConfirmed: v.callback, ...reauthField(token) } }))
          : call(api.POST('/api/admin/finance/destination-reviews/{id}/reject', { ...opts, body: { reason: v.reason, ...reauthField(token) } }));
      }),
    onSuccess: (r, v) => {
      void qc.invalidateQueries({ queryKey: ['finance', 'destination-reviews'] });
      refreshRun();
      announce(v.approve ? 'Destination change approved' : 'Destination change rejected');
      setNotice({ tone: 'success', title: `${r.sellerName}: destination change ${r.status === 'verified' ? 'approved' : r.status === 'rejected' ? 'rejected' : 'recorded'}`, body: r.status === 'verified' ? `Payouts go to ${r.toLabel}${r.pauseUntil ? ` from ${dateTime(r.pauseUntil)}` : ''}.` : `Payouts stay on ${r.fromLabel ?? 'the current account'}.` });
      setDest(null);
    },
    onError: (e) => {
      if (sentForApproval(e)) {
        setNotice({ tone: 'info', title: 'Sent for approval', body: 'This change needs a second reviewer. It was sent for approval.' });
        setDest(null);
      }
    },
  });

  const doApprove = () => {
    const errs: typeof errors = {};
    if (!confirm) errs.confirm = 'Confirm that you reviewed the held, failed and changed-destination payouts.';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    approve.mutate({ note: note.trim() });
  };
  const doSendBack = () => {
    if (!note.trim()) {
      setErrors({ note: 'Add a comment so the preparer knows what to change.' });
      return;
    }
    sendBack.mutate(note.trim());
  };
  const openDest = (review: DestinationReview, approveIt: boolean) => {
    setDest({ review, approve: approveIt });
    setDestReason('');
    setDestCallback(review.checks.some((c) => /callback/i.test(c.label) && c.result === 'passed'));
    setDestErrors({});
    decide.reset();
  };
  const doDecide = () => {
    if (!dest) return;
    const errs: typeof destErrors = {};
    if (!destReason.trim()) errs.reason = 'Enter the reason for the record.';
    setDestErrors(errs);
    if (Object.keys(errs).length) return;
    decide.mutate({ review: dest.review, approve: dest.approve, reason: destReason.trim(), callback: destCallback });
  };

  const steps = run ? approvalSteps(run) : [];
  const waiting = run?.status === 'pending_approval';
  const firstDone = steps.some((s) => s.state === 'approved');
  const sellerRows = (sellers.data?.items ?? []) as RunPayoutRow[];
  const failedRows = (failed.data?.items ?? []) as Payout[];
  const reviewRows = (reviews.data?.items ?? []) as DestinationReview[];
  const totalPages = sellers.data?.totalPages ?? 1;
  const approvalRequestId = run?.approval?.approvalRequestId ?? null;

  const kpis: Array<{ icon: IconName; label: string; value: string; note: string }> = run
    ? [
        { icon: 'wallet', label: 'Run total', value: formatMoney(run.total), note: run.status === 'approved' ? 'Approved · release scheduled' : RUN_STATUS[run.status] },
        { icon: 'store', label: 'Sellers', value: num(run.sellerCount), note: run.rule },
        { icon: 'circle-check', label: 'Ready', value: num(run.readyCount), note: `${formatMoney(run.payingNow)}${run.retriesIncluded ? ` · incl. ${run.retriesIncluded} ${run.retriesIncluded === 1 ? 'retry' : 'retries'}` : ''}` },
        { icon: 'hand-coins', label: 'Held', value: num(run.heldCount), note: `${formatMoney(run.held)} · each with review date` },
        { icon: 'circle-alert', label: 'Failed last run', value: num(run.failedLastRun), note: `${formatMoney(run.failedLastRunAmount)} · retry or fix` },
      ]
    : [];

  const loading = runs.isPending || (!!runId && runQ.isPending && !run);

  return (
    <AdminLayout active="payouts">
      <PageHeader
        crumbs={[{ label: 'Finance', to: href('admin/finance') }, { label: 'Payouts' }]}
        title={run ? `Payout run ${run.ref}` : 'Payout run'}
        sub={run ? `${longDate(run.scheduledRelease)} · release ${time(run.scheduledRelease)} PT · ${run.rule}` : undefined}
        actions={
          <>
            <Button variant="secondary" size="sm" icon="file-text" disabled title="Run statements open from the seller’s finance page">
              Statements
            </Button>
            <Button variant="secondary" size="sm" icon="download" disabled title="Exporting a run isn’t available yet">
              Export run
            </Button>
          </>
        }
      />
      {notice && (
        <Alert tone={notice.tone} title={notice.title}>
          {notice.body}
        </Alert>
      )}
      {runs.isError && <LoadError error={runs.error} onRetry={() => void runs.refetch()} />}
      {runQ.isError && <LoadError error={runQ.error} onRetry={() => void runQ.refetch()} />}
      {!loading && !runs.isError && !run && (
        <Alert tone="info" title="No payout run yet">
          The schedule creates the weekly run. It appears here with its sellers, holds and approvals.
        </Alert>
      )}
      <div className="ab-kpis k5">
        {loading
          ? Array.from({ length: 5 }, (_, i) => (
              <div key={i} className="card pad">
                <SkeletonLines rows={1} />
              </div>
            ))
          : kpis.map((k) => (
              <div key={k.label} className="card pad">
                <Stat icon={k.icon} label={k.label} value={k.value} note={k.note} />
              </div>
            ))}
      </div>
      <p className="ab-note">
        <Icon name="info" className="ic-sm" /> Example schedule: weekly, after delivery plus a 7-day hold. Final payout timing is set in the seller agreement.
      </p>
      <div className="ab-main wide">
        <div className="stack gap-5">
          <Card
            title="Sellers in this run"
            sub={`Showing ${sellerRows.length} of ${num(sellers.data?.total ?? run?.sellerCount ?? 0)} · held and changed rows first`}
            flush
            actions={
              <span className="no-phone">
                <SearchInput id="po-q" placeholder="Search seller" value={q} onChange={setQ} />
              </span>
            }
            foot={
              <>
                <span className="ab-note grow">Held amounts stay in the seller balance as Held and appear on the seller statement with the same reason and review date.</span>
                {totalPages > 1 && <Pager page={page} total={totalPages} onPage={setPage} />}
              </>
            }
          >
            <TableWrap label="Sellers in this run table">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Seller</th>
                    <th className="r" scope="col">Available</th>
                    <th scope="col">Holds (reason · review date)</th>
                    <th className="r" scope="col">Negative balance</th>
                    <th scope="col">Destination</th>
                    <th className="r" scope="col">Payout</th>
                    <th className="col-pin" scope="col">
                      Status
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {(loading || (sellers.isPending && !!runId)) && (
                    <tr>
                      <td colSpan={7}>
                        <SkeletonLines rows={4} />
                      </td>
                    </tr>
                  )}
                  {sellers.isError && (
                    <tr>
                      <td colSpan={7}>
                        <LoadError error={sellers.error} onRetry={() => void sellers.refetch()} />
                      </td>
                    </tr>
                  )}
                  {sellers.isSuccess && sellerRows.length === 0 && (
                    <tr>
                      <td colSpan={7} className="muted">
                        {q.trim() ? `No seller in this run matches "${q}".` : 'No seller has earnings ready for this run yet.'}
                      </td>
                    </tr>
                  )}
                  {sellerRows.map((s) => {
                    const warn = isAtRisk(s);
                    const d = DEST[destState(s.destination.status)];
                    const hold = s.holds[0];
                    const held = s.holds.reduce((n, h) => n + h.amount.amount - h.releasedAmount.amount, 0);
                    return (
                      <tr key={s.payoutId} className={cx(warn && 'is-warn')}>
                        <td>
                          {warn && <span className="sr-only">At risk: </span>}
                          <Link className="strong" to={href('admin/seller', '', { slug: s.sellerId })}>
                            {s.sellerName}
                          </Link>
                        </td>
                        <td className="r">
                          <span className="num">{formatMoney(s.available)}</span>
                        </td>
                        <td>
                          {hold ? (
                            <span className="ab-cell">
                              <span className="strong">
                                <span className="t-warning-text num">{formatMoney({ amount: held, currency: hold.amount.currency })}</span> · {hold.reason}
                                {s.holds.length > 1 ? ` + ${s.holds.length - 1} more` : ''}
                              </span>
                              <span className="xs muted">Review by {shortDate(hold.reviewDate)}</span>
                            </span>
                          ) : (
                            <span className="muted">None</span>
                          )}
                        </td>
                        <td className="r">
                          {s.negativeBalance && s.negativeBalance.amount ? (
                            <span className="ab-cell">
                              <span className="strong">
                                <span className="t-danger-text strong num">−{formatMoney({ ...s.negativeBalance, amount: Math.abs(s.negativeBalance.amount) })}</span>
                              </span>
                              <span className="xs muted">Offset in this run</span>
                            </span>
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                        <td>
                          <span className="ab-cell">
                            <span className="strong">{s.destination.label}</span>
                            <span className="xs muted">
                              <span className={d.cls}>
                                <Icon name={d.icon} className="ic-sm" /> {d.text}
                              </span>
                            </span>
                          </span>
                        </td>
                        <td className="r">
                          <span className="num strong">{formatMoney(s.payout)}</span>
                        </td>
                        <td className="col-pin">
                          <StatusBadge status={PAYOUT_STATUS[s.status]} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableWrap>
            <EdgeLegend items={['warning']} />
          </Card>

          <Card title="Failed payouts" sub="Returned by the bank · the seller sees the same reason" titleAs="h3" flush>
            <TableWrap label="Failed payouts table">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Payout</th>
                    <th scope="col">Seller</th>
                    <th className="r" scope="col">Amount</th>
                    <th scope="col">Reason from the bank</th>
                    <th scope="col">Fix</th>
                    <th scope="col">Status</th>
                    <th className="col-pin" scope="col">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {failed.isPending && (
                    <tr>
                      <td colSpan={7}>
                        <SkeletonLines rows={2} />
                      </td>
                    </tr>
                  )}
                  {failed.isError && (
                    <tr>
                      <td colSpan={7}>
                        <LoadError error={failed.error} onRetry={() => void failed.refetch()} />
                      </td>
                    </tr>
                  )}
                  {failed.isSuccess && failedRows.length === 0 && (
                    <tr>
                      <td colSpan={7} className="muted">
                        No failed payouts. Every payout reached the bank.
                      </td>
                    </tr>
                  )}
                  {failedRows.map((f) => {
                    const fixed = f.destination.status === 'verified' && !!f.retriedBy === false && f.status === 'failed';
                    const canRetry = fixed && canApproveRole;
                    const retried = !!f.retriedBy;
                    const edge = retried ? '' : fixed ? 'warn' : 'flagged';
                    return (
                      <tr key={f.id} className={cx(edge === 'flagged' && 'is-flagged', edge === 'warn' && 'is-warn')}>
                        <td>
                          {edge === 'flagged' && <span className="sr-only">Urgent: </span>}
                          {edge === 'warn' && <span className="sr-only">At risk: </span>}
                          <span className="mono nowrap" title={f.ref}>
                            {f.ref}
                          </span>
                        </td>
                        <td>{f.sellerName}</td>
                        <td className="r">
                          <span className="num">{formatMoney(f.amount)}</span>
                        </td>
                        <td>
                          {f.failureReason ?? 'Returned by the bank'}
                          {f.failureCode ? ` (bank code ${f.failureCode})` : ''}
                        </td>
                        <td>{fixed ? <span className="t-success-text">Destination verified {f.destination.verifiedAt ? shortDate(f.destination.verifiedAt) : ''}</span> : (f.nextStep ?? 'Seller must add and verify a new account')}</td>
                        <td>
                          <StatusBadge status={retried ? 'Pending' : 'Failed'} />
                        </td>
                        <td className="col-pin">
                          {retried ? (
                            <span className="xs muted">Added to a run</span>
                          ) : (
                            <button type="button" className="btn btn-secondary btn-sm" disabled={!canRetry || retry.isPending} onClick={() => retry.mutate(f)} title={fixed && !canApproveRole ? 'Only Finance reviewers with payout authority retry payouts' : undefined}>
                              {canRetry && <Icon name="refresh-cw" />}
                              <span>{canRetry ? 'Retry in this run' : 'Retry'}</span>
                              <span className="sr-only"> {f.ref}</span>
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableWrap>
            <EdgeLegend items={['danger', 'warning']} />
          </Card>

          <Card title="Destination changes" sub="Changes need verification and a recorded review before money goes to the new account" titleAs="h3" flush>
            <ul className="list pad">
              {!canReviewDest && (
                <li>
                  <span className="xs muted">Your role doesn’t review payout destination changes.</span>
                </li>
              )}
              {canReviewDest && reviews.isPending && (
                <li>
                  <SkeletonLines rows={2} />
                </li>
              )}
              {reviews.isError && (
                <li>
                  <LoadError error={reviews.error} onRetry={() => void reviews.refetch()} />
                </li>
              )}
              {reviews.isSuccess && reviewRows.length === 0 && (
                <li>
                  <span className="xs muted">No destination changes to review.</span>
                </li>
              )}
              {reviewRows.map((c) =>
                c.status === 'under_review' ? (
                  <li key={c.id} className="row top">
                    <span className="grow stack gap-2">
                      <span className="row gap-2">
                        <b className="small">{c.sellerName}</b>
                        <StatusBadge status="Under review" />
                      </span>
                      <span className="small">
                        {c.fromLabel ?? 'No account'} <Icon name="arrow-right" className="ic-sm" /> {c.toLabel} · requested {shortDate(c.requestedAt)}
                        {c.requestedBy.name ? ` by ${c.requestedBy.name}` : ''}
                      </span>
                      <Checks items={c.checks.map((x) => ({ tone: CHECK_TONE[x.result], text: x.label }))} />
                      <span className="xs muted">{c.fromLabel ? `This run pays the verified account ${c.fromLabel} until the change is approved.` : 'No payout is sent until the change is approved.'}</span>
                    </span>
                    <span className="row gap-2">
                      <Button variant="ghost" size="sm" onClick={() => openDest(c, false)}>
                        Reject
                      </Button>
                      <Button variant="secondary" size="sm" onClick={() => openDest(c, true)}>
                        Approve change
                      </Button>
                    </span>
                  </li>
                ) : (
                  <li key={c.id}>
                    <span className="grow stack gap-0">
                      <span className="small">
                        <b>{c.sellerName}</b> · {c.fromLabel ?? 'No account'} <Icon name="arrow-right" className="ic-sm" /> {c.toLabel}
                      </span>
                      <span className="xs muted">
                        {c.status === 'verified' ? 'Approved' : 'Rejected'}
                        {c.decidedAt ? ` ${date(c.decidedAt)}` : ''}
                        {c.decidedBy?.name ? ` by ${c.decidedBy.name}` : ''}
                        {c.reason ? ` · reason: ${c.reason}` : ''}
                      </span>
                    </span>
                    <StatusBadge status={c.status === 'verified' ? 'Approved' : 'Rejected'} />
                  </li>
                ),
              )}
            </ul>
          </Card>
        </div>
        <div className="stack gap-5 ab-sticky">
          <Card
            title="Approval"
            sub={run?.approval?.reason ?? 'Runs above the approver’s payout limit need a second Finance reviewer'}
            titleAs="h3"
            foot={
              !run ? undefined : run.status === 'draft' ? (
                canPrepare ? (
                  <Button size="sm" disabled={submitRun.isPending} onClick={() => submitRun.mutate()}>
                    Submit for approval
                  </Button>
                ) : (
                  <span className="xs muted">Waiting for Finance to submit the run</span>
                )
              ) : waiting ? (
                <>
                  {approvalRequestId && (
                    <Button variant="secondary" size="sm" icon="bell" disabled={reminded || remind.isPending} onClick={() => remind.mutate(approvalRequestId)}>
                      {reminded ? 'Reminder sent' : 'Remind reviewers'}
                    </Button>
                  )}
                  {run.viewerCanApprove && (
                    <Button size="sm" to={href('admin/payouts', 'approve-run', undefined, wanted ? { run: wanted } : undefined)} onClick={openApproval}>
                      Open approval
                    </Button>
                  )}
                </>
              ) : (
                <span className="xs muted">{run.status === 'approved' ? `Release scheduled ${releaseLabel(run.scheduledRelease)}` : RUN_STATUS[run.status]}</span>
              )
            }
          >
            {loading ? (
              <SkeletonLines rows={3} />
            ) : run ? (
              <>
                <Approvals steps={steps} />
                {!run.viewerCanApprove && (
                  <Alert tone="info" title="You can view this run">
                    {name}
                    {roles[0] ? `, ${roles[0]}` : ''}: {canApproveRole ? 'you already approved this run, or it isn’t waiting for your approval.' : 'your role has no payout authority.'}
                  </Alert>
                )}
                <div className="ab-sumlist">
                  <div>
                    <span>Paying now</span>
                    <span>{formatMoney(run.payingNow)}</span>
                  </div>
                  <div>
                    <span>Held, not paid</span>
                    <span>{formatMoney(run.held)}</span>
                  </div>
                  <div>
                    <span>Negative balances offset</span>
                    <span>{formatMoney(run.negativeOffset)}</span>
                  </div>
                  <div>
                    <span>Release</span>
                    <span>{releaseLabel(run.scheduledRelease)}</span>
                  </div>
                </div>
              </>
            ) : null}
          </Card>
          <Card title="Payout status meaning" titleAs="h3">
            <div className="stack gap-2 small">
              {STATUS_MEANING.map((s) => (
                <span key={s.status} className="row gap-2">
                  <StatusBadge status={s.status} />
                  <span className="sub">{s.text}</span>
                </span>
              ))}
            </div>
          </Card>
        </div>
      </div>

      <Dialog
        open={view === 'approve-run' && !!run}
        onClose={close}
        title={`Approve payout run ${run?.ref ?? ''}`}
        size="lg"
        foot={
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button variant="secondary" onClick={doSendBack} disabled={sendBack.isPending || !run?.viewerCanApprove}>
              Send back with comment
            </Button>
            <Button icon="check" onClick={doApprove} disabled={approve.isPending || !run?.viewerCanApprove}>
              Approve and schedule release
            </Button>
          </>
        }
      >
        {run && (
          <>
            <div className="row gap-2 small sub">
              <Avatar name={name || ' '} className="ab-av-sm" />
              <span>
                Approving as <b>{name}</b>
                {roles[0] ? `, ${roles[0]}` : ''}
                {firstDone ? ' · second reviewer' : ''}
              </span>
            </div>
            {!run.viewerCanApprove && (
              <Alert tone="info" title="You can’t approve this run">
                {canApproveRole ? 'It isn’t waiting for your approval, or you already approved it.' : 'Your role has no payout authority.'}
              </Alert>
            )}
            {(approve.error || sendBack.error) && !isStepUpCancel(approve.error) && !sentForApproval(approve.error) && (
              <Alert tone="danger" title="That didn’t work">
                {errorMessage(approve.error ?? sendBack.error)}
              </Alert>
            )}
            <div className="grid md2 gap-4">
              <div className="well stack gap-2">
                <div className="ab-sumlist">
                  <div>
                    <span>Run total</span>
                    <span>{formatMoney(run.total)}</span>
                  </div>
                  <div>
                    <span>Paying now · {run.readyCount} sellers</span>
                    <span>{formatMoney(run.payingNow)}</span>
                  </div>
                  <div>
                    <span>Held · {run.heldCount} sellers</span>
                    <span>{formatMoney(run.held)}</span>
                  </div>
                  <div>
                    <span>Retries included</span>
                    <span>
                      {run.retriesIncluded} · {formatMoney(run.retriesAmount)}
                    </span>
                  </div>
                  <div>
                    <span>Release</span>
                    <span>{releaseLabel(run.scheduledRelease)}</span>
                  </div>
                </div>
              </div>
              <Approvals steps={steps} dialog />
            </div>
            <Checks items={run.checks.map((c) => ({ tone: RUN_CHECK_TONE[c.level], text: c.title, sub: c.detail }))} />
            <Checkbox
              id="po-confirm"
              label="I reviewed the held, failed and changed-destination payouts in this run"
              checked={confirm}
              aria-invalid={errors.confirm ? true : undefined}
              aria-describedby={errors.confirm ? 'po-confirm-err' : undefined}
              onChange={(e) => {
                setConfirm(e.target.checked);
                setErrors((x) => ({ ...x, confirm: undefined }));
              }}
            />
            {errors.confirm && (
              <span className="error-text" id="po-confirm-err">
                <Icon name="circle-alert" className="ic-sm" />
                {errors.confirm}
              </span>
            )}
            <Field label="Approval note" optional error={errors.note}>
              <Textarea
                id="po-note"
                placeholder=""
                value={note}
                onChange={(e) => {
                  setNote(e.target.value);
                  setErrors((x) => ({ ...x, note: undefined }));
                }}
              />
            </Field>
            <Alert tone="info" title="Approved is not paid">
              At release each payout moves to Processing. It shows Paid only when the bank confirms the deposit. Sellers see the same status.
            </Alert>
          </>
        )}
      </Dialog>

      <Dialog
        open={dest !== null}
        onClose={() => setDest(null)}
        title={dest ? `${dest.approve ? 'Approve' : 'Reject'} destination change · ${dest.review.sellerName}` : ''}
        foot={
          <>
            <Button variant="ghost" onClick={() => setDest(null)}>
              Cancel
            </Button>
            <Button onClick={doDecide} disabled={decide.isPending}>
              {dest?.approve ? 'Approve change' : 'Reject change'}
            </Button>
          </>
        }
      >
        {dest && (
          <>
            <p className="small sub">
              {dest.review.fromLabel ?? 'No account'} → {dest.review.toLabel}
            </p>
            {decide.error && !isStepUpCancel(decide.error) && !sentForApproval(decide.error) && (
              <Alert tone="danger" title="That didn’t work">
                {errorMessage(decide.error)}
              </Alert>
            )}
            <Field label="Reason for the record" error={destErrors.reason}>
              <Textarea id="po-dest-reason" value={destReason} onChange={(e) => setDestReason(e.target.value)} aria-required="true" />
            </Field>
            {dest.approve && <Checkbox id="po-dest-callback" label="Callback to the registered phone confirmed" checked={destCallback} onChange={(e) => setDestCallback(e.target.checked)} />}
          </>
        )}
      </Dialog>
      {stepUp.dialog}
    </AdminLayout>
  );
}
