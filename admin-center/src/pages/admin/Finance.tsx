import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { call, errorMessage, useApi } from '@marketly/web-shared/api';
import { AdminLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { formatMoney, num } from '@marketly/web-shared/lib/format';
import { useView } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import { Alert, Avatar, Button, Card, Deadline, Dialog, Field, Icon, KeyValue, Legend, Meter, PageHeader, SegmentedControl, SplitBar, Stat, StatusBadge, TableWrap, Tabs, Textarea, announce, type IconName } from '@marketly/web-shared/ui';
import { useStaffSession } from '@/app/session';
import { LoadError, SkeletonLines, date, dateTime, deadlineLabel, deadlineTone } from '@/app/parts';
import { exportNote, useDatasetExport } from './data/dataset-export';
import { RefundApprovals, useRefundRequests } from './data/refund-approvals';
import {
  PERIODS, feeRulePairs, pct, periodRange, reconEdge, refundEdge, refundWhy,
  type Dispute, type Edge, type FeeRules, type FinanceOverview, type Money, type Period, type ReconItem, type Refund,
} from './data/finance';

// Design: pages/admin/admin-finance.html · views "disputes-and-chargebacks" and "refunds-failing"
// are the tabs of the Finance queues card. "refunds-to-approve" has no design: the Finance approval queue for refunds
// staff started (GET returns/refunds?status=under_review; approve / send back / revise), in data/refund-approvals.tsx.
// Data: GET /api/admin/finance/overview (KPIs, money flow, discount funding), /finance/fee-rules, the open
// reconciliation items (Unexplained amounts), /payments/disputes and /payments/refunds?failing=true; Export =
// POST reports/exports (dataset finance.admin.overview for the shown range, payment-date basis; polled, then downloaded).

type Tab = 'disputes-and-chargebacks' | 'refunds-failing' | 'refunds-to-approve';

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

const edgeClass = (e: Edge) => cx(e === 'flagged' && 'is-flagged', e === 'warn' && 'is-warn');

function EdgeMark({ edge }: { edge: Edge }) {
  if (edge === 'flagged') return <span className="sr-only">Urgent: </span>;
  if (edge === 'warn') return <span className="sr-only">At risk: </span>;
  return null;
}

function PersonCell({ name, role }: { name: string; role?: string | null }) {
  return (
    <span className="row nowrap gap-2">
      <Avatar name={name} className="ab-av-sm" />
      <span className="ab-cell">
        <span className="strong">{name}</span>
        {role && <span className="xs muted">{role}</span>}
      </span>
    </span>
  );
}

/** Row action button: visible label plus the row reference for screen readers. */
function RowButton({ variant = 'secondary', icon, sr, onClick, disabled, children }: { variant?: 'secondary' | 'ghost'; icon?: IconName; sr?: string; onClick?: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button type="button" className={`btn btn-${variant} btn-sm`} onClick={onClick} disabled={disabled}>
      {icon && <Icon name={icon} />}
      <span>{children}</span>
      {sr && <span className="sr-only"> {sr}</span>}
    </button>
  );
}

const orderLink = (ref: string) => (
  <Link className="mono nowrap" to={href('admin/order', '', { ref })} title={ref}>
    {ref}
  </Link>
);
// Plain text: disputes, refunds and reconciliation items have no admin detail screen to open.
const refLink = (ref: string) => (
  <span className="mono nowrap" title={ref}>
    {ref}
  </span>
);

const disputeEdge = (d: Dispute): Edge => (d.status === 'won' || d.status === 'lost' || d.evidence.submittedAt ? '' : d.evidenceDue?.state === 'overdue' ? 'flagged' : d.evidenceDue?.state === 'due_soon' ? 'warn' : '');
const canSubmitEvidence = (d: Dispute) => (d.status === 'opened' || d.status === 'under_review') && !d.evidence.submittedAt;
const neg = (m: Money) => m.amount < 0;

type Pending = { kind: 'resolve'; row: ReconItem } | { kind: 'evidence'; row: Dispute } | null;

/** A table row spanning every column (loading, empty, error and no-access states). */
function SpanRow({ cols, children }: { cols: number; children: ReactNode }) {
  return (
    <tr>
      <td colSpan={cols} className="muted">
        {children}
      </td>
    </tr>
  );
}

function QueueState({ cols, q, allowed, noAccess, empty }: { cols: number; q: { isPending: boolean; isError: boolean; error: unknown; refetch: () => unknown; data?: { items: unknown[] } }; allowed: boolean; noAccess: string; empty: string }) {
  if (!allowed) return <SpanRow cols={cols}>{noAccess}</SpanRow>;
  if (q.isPending)
    return (
      <SpanRow cols={cols}>
        <SkeletonLines rows={3} />
      </SpanRow>
    );
  if (q.isError)
    return (
      <SpanRow cols={cols}>
        <LoadError error={q.error} onRetry={() => void q.refetch()} />
      </SpanRow>
    );
  if (!q.data?.items.length) return <SpanRow cols={cols}>{empty}</SpanRow>;
  return null;
}

export default function Finance() {
  const { api } = useApi();
  const qc = useQueryClient();
  const { can } = useStaffSession();
  const [view] = useView<Tab>();
  const tab: Tab | '' = view === 'disputes-and-chargebacks' || view === 'refunds-failing' || view === 'refunds-to-approve' ? view : '';
  const [period, setPeriod] = useState<Period>('mtd');
  const [done, setDone] = useState<{ tab: Tab | ''; title: string; body: string } | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [note, setNote] = useState('');
  const [attempted, setAttempted] = useState(false);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);

  const range = periodRange(period);
  const exporter = useDatasetExport('finance.admin.overview');
  const exported = exportNote(exporter.job);
  const canLedger = can('finance.ledger.view');
  const canRecon = can('finance.reconciliation.work');
  const canDisputes = can('payments.disputes.manage');
  const canRefundsView = can('payments.refunds.view');
  const canRefundsManage = can('payments.refunds.manage');
  const canRefundRequests = can('returns.requests.view');

  const overview = useQuery({
    queryKey: ['finance', 'overview', range.from, range.to],
    queryFn: () => call(api.GET('/api/admin/finance/overview', { params: { query: { from: range.from, to: range.to } } })) as Promise<FinanceOverview>,
    enabled: canLedger,
  });
  const fees = useQuery({ queryKey: ['finance', 'fee-rules'], queryFn: () => call(api.GET('/api/admin/finance/fee-rules')) as Promise<FeeRules>, enabled: canLedger });
  const recon = useQuery({
    queryKey: ['finance', 'reconciliation', 'open'],
    queryFn: () => call(api.GET('/api/admin/finance/reconciliation/items', { params: { query: { status: 'open', limit: 100 } } })),
    enabled: canRecon,
  });
  const disputes = useQuery({ queryKey: ['payments', 'disputes'], queryFn: () => call(api.GET('/api/admin/payments/disputes', { params: { query: { limit: 100 } } })), enabled: canDisputes });
  const refunds = useQuery({
    queryKey: ['payments', 'refunds', 'failing'],
    queryFn: () => call(api.GET('/api/admin/payments/refunds', { params: { query: { failing: true, limit: 100 } } })),
    enabled: canRefundsView,
  });

  // Only the tab count here; the tab's own table shares this query (same key).
  const toApprove = useRefundRequests('under_review', 1, canRefundRequests);

  const invalidateWork = () => {
    void qc.invalidateQueries({ queryKey: ['workqueues', 'queues'] });
    void qc.invalidateQueries({ queryKey: ['finance', 'overview'] });
  };

  const resolve = useMutation({
    mutationFn: (v: { row: ReconItem; note: string }) => call(api.POST('/api/admin/finance/reconciliation/items/{id}/explain', { params: { path: { id: v.row.id } }, body: { reasonCode: 'other', note: v.note } })),
    onSuccess: (item, v) => {
      void qc.invalidateQueries({ queryKey: ['finance', 'reconciliation'] });
      invalidateWork();
      setDone({ tab: '', title: `${v.row.reference?.ref ?? v.row.subject} resolved`, body: `Recorded as ${item.status} with your reason. It appears in Action history.` });
      announce('Saved');
      setPending(null);
    },
  });
  const evidence = useMutation({
    mutationFn: (v: { row: Dispute; text: string }) => call(api.POST('/api/admin/payments/disputes/{id}/evidence', { params: { path: { id: v.row.id } }, body: { text: v.text, submit: true } })),
    onSuccess: (d) => {
      void qc.invalidateQueries({ queryKey: ['payments', 'disputes'] });
      invalidateWork();
      setDone({ tab: 'disputes-and-chargebacks', title: `Evidence submitted for ${d.ref}`, body: `${d.statusLabel}. ${d.sellerBalanceEffect}` });
      announce('Saved');
      setPending(null);
    },
  });
  const refundAction = useMutation({
    mutationFn: (r: Refund) =>
      r.outcomeUnknown
        ? call(api.POST('/api/admin/payments/refunds/{id}/check', { params: { path: { id: r.id } } }))
        : call(api.POST('/api/admin/payments/refunds/{id}/request-destination', { params: { path: { id: r.id } }, body: {} })),
    onMutate: () => setRowError(null),
    onSuccess: (x, r) => {
      void qc.invalidateQueries({ queryKey: ['payments', 'refunds'] });
      invalidateWork();
      setDone(
        r.outcomeUnknown
          ? { tab: 'refunds-failing', title: `${x.ref}: ${x.statusLabel}`, body: x.status === 'sent' ? 'The provider confirmed the refund. No retry is needed.' : (x.nextStep ?? 'The provider has not confirmed the refund yet. We check again before any retry.') }
          : { tab: 'refunds-failing', title: `Asked ${x.customerName} for a new refund method`, body: x.nextStep ?? 'The refund stays Failed until the customer adds a method. We retry automatically.' },
      );
    },
    onError: (e, r) => setRowError({ id: r.id, message: errorMessage(e) }),
  });

  const open = (p: Pending) => {
    setPending(p);
    setNote('');
    setAttempted(false);
    resolve.reset();
    evidence.reset();
  };
  const close = () => setPending(null);
  const noteError = attempted && !note.trim() ? (pending?.kind === 'evidence' ? 'Describe the evidence before you submit it.' : 'Enter a reason. Every correction needs a recorded reason.') : undefined;
  const writeError = pending?.kind === 'evidence' ? evidence.error : resolve.error;

  const submit = () => {
    setAttempted(true);
    if (!pending || !note.trim()) return;
    if (pending.kind === 'resolve') resolve.mutate({ row: pending.row, note: note.trim() });
    else evidence.mutate({ row: pending.row, text: note.trim() });
  };

  const reconRows = (recon.data?.items ?? []) as ReconItem[];
  const disputeRows = (disputes.data?.items ?? []) as Dispute[];
  const refundRows = (refunds.data?.items ?? []) as Refund[];
  const openRefunds = refundRows.filter((r) => r.status === 'failed' || r.outcomeUnknown).length;

  const tabs = [
    { label: 'Unexplained amounts', value: '', count: canRecon ? (recon.data?.total ?? reconRows.length) : undefined, to: href('admin/finance') },
    { label: 'Disputes and chargebacks', value: 'disputes-and-chargebacks', count: canDisputes ? (disputes.data?.total ?? disputeRows.length) : undefined, to: href('admin/finance', 'disputes-and-chargebacks') },
    { label: 'Refunds failing', value: 'refunds-failing', count: canRefundsView ? openRefunds : undefined, to: href('admin/finance', 'refunds-failing') },
    { label: 'Refunds to approve', value: 'refunds-to-approve', count: canRefundRequests ? toApprove.data?.total : undefined, to: href('admin/finance', 'refunds-to-approve') },
  ];

  const o = overview.data;
  const kpis: Array<{ icon: IconName; label: string; value: string; note: string }> = o
    ? [
        { icon: 'credit-card', label: 'Collected payments', value: formatMoney(o.collectedPayments), note: `${num(o.collectedCount)} accepted payments` },
        { icon: 'badge-check', label: 'Company product sales', value: formatMoney(o.companySales), note: 'Official Store · company trading' },
        { icon: 'landmark', label: 'Marketplace fee income', value: formatMoney(o.marketplaceFeeIncome), note: `on ${formatMoney(o.sellerSales)} seller sales` },
        { icon: 'wallet', label: 'Owed to sellers', value: formatMoney(o.owedToSellers), note: `Pending ${formatMoney(o.owedPending)} · available ${formatMoney(o.owedAvailable)}` },
        { icon: 'undo-2', label: 'Refunds sent', value: formatMoney(o.refundsSent), note: `${num(o.refundsSentCount)} sent · ${num(o.refundsFailing)} failing` },
        { icon: 'hand-coins', label: 'Holds', value: formatMoney(o.holds), note: `${num(o.holdSellers)} ${o.holdSellers === 1 ? 'seller' : 'sellers'} · each with review date` },
      ]
    : [];

  const flowTotal = o ? o.companySales.amount + o.sellerSales.amount + o.shippingCollected.amount : 0;
  const share = (m: Money) => (flowTotal ? Math.round((m.amount / flowTotal) * 100) : 0);
  const flow = o
    ? [
        { label: 'Company product sales (Official Store)', value: formatMoney(o.companySales), pct: share(o.companySales) },
        { label: 'Seller sales (marketplace)', value: formatMoney(o.sellerSales), pct: share(o.sellerSales) },
        { label: 'Shipping charges collected', value: formatMoney(o.shippingCollected), pct: share(o.shippingCollected) },
      ]
    : [];
  const panels = o
    ? [
        { k: 'From seller sales: fee income', v: formatMoney(o.marketplaceFeeIncome), note: 'Earned by the marketplace' },
        { k: 'From seller sales: seller earnings', v: formatMoney(o.sellerEarnings), note: 'Before refunds and holds' },
        { k: 'Paid out to sellers', v: formatMoney(o.paidOut), note: o.lastRunRef ? `Run ${o.lastRunRef}` : 'No payout run released in this period' },
      ]
    : [];
  const salesBase = o ? o.companySales.amount + o.sellerSales.amount : 0;
  const companyPct = salesBase && o ? Math.round((o.companySales.amount / salesBase) * 100) : 0;

  const rules = fees.data?.active;
  const discounts = o
    ? [
        { label: 'Platform-funded coupons', amount: o.discountFunding.platformCoupons },
        { label: 'Seller-funded markdowns', amount: o.discountFunding.sellerMarkdowns },
        { label: 'Shared campaigns', amount: o.discountFunding.sharedCampaigns },
      ]
    : [];

  return (
    <AdminLayout active="finance">
      <PageHeader
        crumbs={[{ label: 'Admin', to: href('admin/dashboard') }, { label: 'Finance' }]}
        title="Payments and fees"
        sub={`${range.label} · USD · Pacific Time · counted by payment date`}
        actions={
          <>
            <SegmentedControl items={PERIODS} active={period} onChange={setPeriod} />
            {canLedger && (
              <Button variant="secondary" size="sm" icon="download" disabled={exporter.busy} onClick={() => void exporter.run({ from: range.from, to: range.to, basis: 'payment_date' })}>
                {exporter.busy ? 'Exporting…' : 'Export'}
              </Button>
            )}
          </>
        }
      />
      {!canLedger && (
        <Alert tone="info" title="You can’t see finance totals">
          Your role doesn’t include the finance ledger. Ask a Finance Manager if you need access.
        </Alert>
      )}
      {exporter.error ? (
        <Alert tone="danger" title="We couldn’t export the overview">
          {errorMessage(exporter.error)}
        </Alert>
      ) : exported ? (
        <Alert tone={exported.tone} title={exported.tone === 'danger' ? 'The export failed' : exported.tone === 'success' ? 'Finance overview exported' : 'Export started'}>
          {exported.text}
        </Alert>
      ) : null}
      {overview.isError && <LoadError error={overview.error} onRetry={() => void overview.refetch()} />}
      {canLedger && (
        <div className="ab-kpis k6">
          {overview.isPending
            ? Array.from({ length: 6 }, (_, i) => (
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
      )}
      <div className="ab-main">
        <div className="stack gap-5">
          <Card
            title="Finance queues"
            sub="Work these before the Friday payout run"
            flush
            footClassName={tab ? 'start' : 'between'}
            foot={
              tab === 'disputes-and-chargebacks' ? (
                <p className="ab-note">
                  <Icon name="info" className="ic-sm" /> {rules?.treatment.text ?? 'The marketplace fee is kept while a chargeback is open and returned to the seller if we win. Final treatment is in the seller agreement.'}
                </p>
              ) : tab === 'refunds-to-approve' ? (
                <p className="ab-note">
                  <Icon name="info" className="ic-sm" /> Approving hands the refund to payments; the customer sees Sent only when the provider confirms it. Refunds above your limit go on to an approver with a higher limit.
                </p>
              ) : tab === 'refunds-failing' ? (
                <p className="ab-note">
                  <Icon name="info" className="ic-sm" /> A retry first asks the payment provider for the result, so a refund is never sent twice. The customer sees "Failed" with the next step, not "Sent".
                </p>
              ) : (
                <>
                  <p className="ab-note">
                    <Icon name="info" className="ic-sm" /> Every correction needs a recorded reason. Corrections over your approval limit need a second Finance reviewer.
                  </p>
                  <Link className="small strong" to={href('ops/finance-checks')}>
                    Daily finance checks <Icon name="arrow-right" className="ic-sm" />
                  </Link>
                </>
              )
            }
          >
            <div className="u-p-0-sp-4">
              <Tabs items={tabs} active={tab} />
            </div>
            {tab === 'disputes-and-chargebacks' && (
              <div className="card-body u-pb-0">
                <Alert tone="info" title="What a chargeback is">
                  A chargeback happens when a customer disputes a charge with their card issuer or payment provider instead of with us; the provider takes the money back until the dispute is decided.
                </Alert>
              </div>
            )}
            {done && done.tab === tab && (
              <div className="card-body u-pb-0">
                <Alert tone="success" title={done.title}>
                  {done.body}
                </Alert>
              </div>
            )}
            {rowError && tab === 'refunds-failing' && (
              <div className="card-body u-pb-0">
                <Alert tone="danger" title="That didn’t work">
                  {rowError.message}
                </Alert>
              </div>
            )}
            {tab === 'refunds-to-approve' ? (
              <RefundApprovals />
            ) : (
              <TableWrap label="Finance queues table">
                {tab === 'disputes-and-chargebacks' ? (
                  <table className="table">
                    <thead>
                      <tr>
                        <th scope="col">Case</th>
                        <th scope="col">Order and seller</th>
                        <th scope="col">Customer</th>
                        <th scope="col">Reason given</th>
                        <th className="r" scope="col">Amount</th>
                        <th scope="col">Evidence due</th>
                        <th scope="col">Seller balance effect</th>
                        <th scope="col">Status</th>
                        <th className="col-pin" scope="col">
                          <span className="sr-only">Actions</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      <QueueState cols={9} q={disputes} allowed={canDisputes} noAccess="Your role doesn’t work payment disputes." empty="No open disputes or chargebacks." />
                      {disputeRows.map((d) => {
                        const edge = disputeEdge(d);
                        return (
                          <tr key={d.id} className={edgeClass(edge)}>
                            <td>
                              <EdgeMark edge={edge} />
                              {refLink(d.ref)}
                            </td>
                            <td>
                              <span className="ab-cell">
                                <span className="strong">{orderLink(d.orderRef)}</span>
                                <span className="xs muted">{d.sellerName ?? (d.ownerType === 'official' ? 'Marketly Official' : '')}</span>
                              </span>
                            </td>
                            <td>{d.customerName}</td>
                            <td>{d.reason}</td>
                            <td className="r">
                              <span className="num">{formatMoney(d.amount)}</span>
                            </td>
                            <td>
                              {d.evidence.submittedAt ? (
                                <span className="xs muted">Evidence sent {date(d.evidence.submittedAt)}</span>
                              ) : d.decidedAt ? (
                                <span className="xs muted">
                                  {d.statusLabel} {date(d.decidedAt)}
                                </span>
                              ) : d.evidenceDue ? (
                                <Deadline tone={deadlineTone(d.evidenceDue.state)}>{deadlineLabel(d.evidenceDue.dueAt)}</Deadline>
                              ) : (
                                <span className="xs muted">No deadline</span>
                              )}
                            </td>
                            <td>
                              <span className={cx('xs', d.status === 'won' ? 't-success-text strong' : 'muted')}>{d.sellerBalanceEffect}</span>
                            </td>
                            <td>
                              <StatusBadge status={d.statusLabel} />
                            </td>
                            <td className="col-pin">
                              {canSubmitEvidence(d) ? (
                                <RowButton sr={d.ref} onClick={() => open({ kind: 'evidence', row: d })}>
                                  Submit evidence
                                </RowButton>
                              ) : (
                                <Link className="btn btn-ghost btn-sm" to={href('admin/order', '', { ref: d.orderRef })}>
                                  <span>Open</span>
                                  <span className="sr-only"> {d.ref}</span>
                                </Link>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                ) : tab === 'refunds-failing' ? (
                  <table className="table">
                    <thead>
                      <tr>
                        <th scope="col">Refund</th>
                        <th scope="col">Order</th>
                        <th scope="col">Customer</th>
                        <th className="r" scope="col">Amount</th>
                        <th scope="col">Why it failed</th>
                        <th scope="col">Attempts</th>
                        <th scope="col">Status</th>
                        <th className="col-pin" scope="col">
                          Next step
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      <QueueState cols={8} q={refunds} allowed={canRefundsView} noAccess="Your role can’t see refunds." empty="No refunds are failing. Every refund was sent or is on its way." />
                      {refundRows.map((r) => {
                        const edge = refundEdge(r);
                        const why = refundWhy(r);
                        const actionable = r.status === 'failed' || r.outcomeUnknown;
                        return (
                          <tr key={r.id} className={edgeClass(edge)}>
                            <td>
                              <EdgeMark edge={edge} />
                              {refLink(r.ref)}
                            </td>
                            <td>{orderLink(r.orderRef)}</td>
                            <td>{r.customerName}</td>
                            <td className="r">
                              <span className="num">{formatMoney(r.amount)}</span>
                            </td>
                            <td>
                              <span className="ab-cell">
                                <span className="strong">{why.why}</span>
                                <span className="xs muted">
                                  {why.detail}
                                  {r.lastAttemptAt ? ` · ${dateTime(r.lastAttemptAt)}` : ''}
                                </span>
                              </span>
                            </td>
                            <td>
                              {r.attempts} of {r.maxAttempts}
                            </td>
                            <td>
                              <StatusBadge status={r.statusLabel} />
                            </td>
                            <td className="col-pin">
                              {!actionable ? (
                                <span className="xs muted">{r.status === 'sent' ? 'No retry needed' : 'Request sent'}</span>
                              ) : !canRefundsManage ? (
                                <span className="xs muted">Finance handles this</span>
                              ) : r.outcomeUnknown ? (
                                <RowButton icon="refresh-cw" sr={r.ref} disabled={refundAction.isPending} onClick={() => refundAction.mutate(r)}>
                                  Check status
                                </RowButton>
                              ) : (
                                <RowButton disabled={refundAction.isPending} onClick={() => refundAction.mutate(r)}>
                                  Ask customer for a new method
                                </RowButton>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                ) : (
                  <table className="table">
                    <thead>
                      <tr>
                        <th scope="col">Reference</th>
                        <th scope="col">What we found</th>
                        <th className="r" scope="col">Difference</th>
                        <th scope="col">Detected</th>
                        <th scope="col">Owner</th>
                        <th className="col-pin" scope="col">
                          Next step
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      <QueueState cols={6} q={recon} allowed={canRecon} noAccess="Your role doesn’t work finance checks." empty="No unexplained amounts. Every difference has a recorded reason." />
                      {reconRows.map((u) => {
                        const edge = reconEdge(u);
                        const ref = u.reference?.ref ?? u.subject;
                        return (
                          <tr key={u.id} className={edgeClass(edge)}>
                            <td>
                              <EdgeMark edge={edge} />
                              {u.reference?.kind === 'order' && u.reference.ref ? orderLink(u.reference.ref) : refLink(ref)}
                            </td>
                            <td>
                              <span className="ab-cell">
                                <span className="strong">{u.subject}</span>
                                <span className="xs muted">{u.description}</span>
                              </span>
                            </td>
                            <td className="r">{neg(u.difference) ? <span className="t-danger-text strong num">−{formatMoney({ ...u.difference, amount: -u.difference.amount })}</span> : <span className="num strong">{formatMoney(u.difference)}</span>}</td>
                            <td>{dateTime(u.detectedAt)}</td>
                            <td>{u.owner?.name ? <PersonCell name={u.owner.name} role={u.ownerRole} /> : <span className="xs t-warning-text strong">Unassigned</span>}</td>
                            <td className="col-pin">
                              <RowButton sr={ref} onClick={() => open({ kind: 'resolve', row: u })}>
                                Explain with reason
                              </RowButton>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </TableWrap>
            )}
            {tab !== 'refunds-to-approve' && <EdgeLegend items={tab === 'disputes-and-chargebacks' ? ['warning'] : ['danger', 'warning']} />}
          </Card>

          {canLedger && (
            <Card title="Where the money went" sub={`${PERIODS.find((p) => p.value === period)!.label} · one payment can cover several seller groups`} titleAs="h3">
              {overview.isPending ? (
                <SkeletonLines rows={4} />
              ) : o ? (
                <>
                  <div className="ab-flow">
                    {flow.map((f) => (
                      <div key={f.label} className="r">
                        <span>{f.label}</span>
                        <b>{f.value}</b>
                        <Meter pct={f.pct} label={`${f.label} ${f.value}`} />
                      </div>
                    ))}
                  </div>
                  <div className="divider" />
                  <div className="grid md3 gap-3">
                    {panels.map((p) => (
                      <div key={p.k} className="panel stack gap-1">
                        <span className="xs muted">{p.k}</span>
                        <b className="num">{p.v}</b>
                        <span className="xs muted">{p.note}</span>
                      </div>
                    ))}
                  </div>
                  <div className="stack gap-2">
                    <div className="row between xs sub">
                      <span>Official Store {companyPct}%</span>
                      <span>Marketplace sellers {salesBase ? 100 - companyPct : 0}%</span>
                    </div>
                    <SplitBar a={companyPct} b={salesBase ? 100 - companyPct : 0} />
                    <Legend items={['Official Store', 'Marketplace sellers']} />
                  </div>
                </>
              ) : null}
              <p className="ab-note">
                <Icon name="info" className="ic-sm" /> Seller sales are not marketplace income. Only the fee portion is income. Company proceeds stay in company trading reports and are never part of a seller payout.
              </p>
            </Card>
          )}
        </div>
        {canLedger && (
          <div className="stack gap-5">
            <Card
              title="Fee rules"
              sub={rules ? `Effective ${rules.effectiveFrom ? date(rules.effectiveFrom) : 'now'} · seller agreement ${rules.agreementVersion}` : 'Active rule set'}
              titleAs="h3"
              actions={
                can('finance.fees.manage') ? (
                  <Button variant="ghost" size="sm" to={href('admin/settings')}>
                    Edit in settings
                  </Button>
                ) : undefined
              }
            >
              {fees.isPending ? (
                <SkeletonLines rows={4} />
              ) : fees.isError ? (
                <LoadError error={fees.error} onRetry={() => void fees.refetch()} />
              ) : rules ? (
                <>
                  <KeyValue pairs={feeRulePairs(rules)} />
                  <div className="divider" />
                  <span className="small strong">Category rates</span>
                  <TableWrap label="Fee rules table">
                    <table className="table">
                      <thead>
                        <tr>
                          <th scope="col">Category</th>
                          <th className="r col-pin" scope="col">
                            Rate
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {rules.categoryRates.map((c) => (
                          <tr key={c.categoryId}>
                            <td>{c.categoryName}</td>
                            <td className="r col-pin">{pct(c.rateBps)}%</td>
                          </tr>
                        ))}
                        <tr>
                          <td>{rules.categoryRates.length ? 'Every other category' : 'All categories'}</td>
                          <td className="r col-pin">{pct(rules.defaultRateBps)}%</td>
                        </tr>
                      </tbody>
                    </table>
                  </TableWrap>
                  <div className="panel small">
                    <b>Illustration:</b> a $100.00 item sale with a {pct(rules.defaultRateBps)}% fee creates {formatMoney({ amount: rules.defaultRateBps, currency: 'USD' })} of fee income and{' '}
                    {formatMoney({ amount: 10000 - rules.defaultRateBps, currency: 'USD' })} of seller earnings before other adjustments.
                  </div>
                  {fees.data!.upcoming.length > 0 && (
                    <p className="ab-note">
                      <Icon name="info" className="ic-sm" /> {fees.data!.upcoming.length === 1 ? 'A new fee rule version is' : `${fees.data!.upcoming.length} new fee rule versions are`} scheduled
                      {fees.data!.upcoming[0].effectiveFrom ? ` from ${date(fees.data!.upcoming[0].effectiveFrom)}` : ''}.
                    </p>
                  )}
                </>
              ) : null}
            </Card>
            <Card title="Discount funding this period" sub="Recorded separately from sales" titleAs="h3">
              {overview.isPending ? (
                <SkeletonLines rows={3} />
              ) : o ? (
                <div className="ab-sumlist">
                  {discounts.map((d) => (
                    <div key={d.label}>
                      <span>{d.label}</span>
                      <span>{formatMoney(d.amount)}</span>
                    </div>
                  ))}
                  <div>
                    <span>Total discount cost</span>
                    <span>
                      <b>{formatMoney(o.discountFunding.total)}</b>
                    </span>
                  </div>
                </div>
              ) : null}
              <Link className="small strong" to={href('admin/promotions')}>
                Campaign results <Icon name="arrow-right" className="ic-sm" />
              </Link>
            </Card>
          </div>
        )}
      </div>

      <Dialog
        open={pending !== null}
        onClose={close}
        title={pending ? (pending.kind === 'evidence' ? `Submit evidence for ${pending.row.ref}` : `Explain with reason · ${pending.row.reference?.ref ?? pending.row.subject}`) : ''}
        foot={
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={resolve.isPending || evidence.isPending}>
              {pending?.kind === 'evidence' ? 'Submit evidence' : 'Record and resolve'}
            </Button>
          </>
        }
      >
        {pending?.kind === 'resolve' && (
          <p className="small sub">
            {pending.row.subject}. {pending.row.description}
          </p>
        )}
        {pending?.kind === 'evidence' && (
          <p className="small sub">
            {pending.row.customerName} · {pending.row.reason} · {formatMoney(pending.row.amount)} · order {pending.row.orderRef}
          </p>
        )}
        {writeError && (
          <Alert tone="danger" title="That didn’t work">
            {errorMessage(writeError)}
          </Alert>
        )}
        <Field
          label={pending?.kind === 'evidence' ? 'Evidence summary' : 'Reason for the record'}
          hint={pending?.kind === 'evidence' ? 'Tracking, delivery photos and messages you are sending to the provider.' : 'Shown in Action history with your name.'}
          error={noteError}
        >
          <Textarea id="fi-note" value={note} onChange={(e) => setNote(e.target.value)} aria-required="true" />
        </Field>
      </Dialog>
    </AdminLayout>
  );
}
