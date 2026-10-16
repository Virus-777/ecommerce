import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { call, errorMessage, newIdempotencyKey, useApi } from '@marketly/web-shared/api';
import { OpsLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { formatMoney, type MoneyValue } from '@marketly/web-shared/lib/format';
import { href } from '@marketly/web-shared/routes';
import { Alert, Button, Card, Deadline, Field, Icon, Meter, PageHeader, Select, Stat, StatusBadge, TableWrap, Textarea, TextInput, announce } from '@marketly/web-shared/ui';
import { LoadError, SkeletonLines, dayKey, deadlineLabel, deadlineTone, time, weekdayDate } from '@/app/parts';
import { useStaffSession } from '@/app/session';
import { ExportButton, ExportNotice } from '@/pages/admin/data/export-button';
import { useDatasetExport } from '@/pages/admin/data/report-export';
import { EDGE_URGENT, EmptyRow, OpsLegend, SkeletonRows, humanize } from './data/shared';

// Design: pages/ops/ops-finance-checks.html (single view): the settlement checks for the previous market day.
// API: GET finance/reconciliation/days/{date} (checklist, totals, failed payouts), GET finance/reconciliation/items
// (payments vs orders, seller amounts, provider deposit, unexplained amounts), POST reconciliation/items/{id}/correct
// (idempotent; pending_approval above the correction limit), POST reconciliation/days/{date}/complete,
// GET payments/disputes (chargebacks), GET access/me (the correction limit).

const LEGEND = [{ tone: 'danger' as const, label: EDGE_URGENT }];

type Check = 'payments_vs_orders' | 'seller_amounts' | 'provider_deposit' | 'store_credit' | 'unexplained_amount';
type ItemStatus = 'open' | 'explained' | 'correction_pending' | 'corrected' | 'matched';
interface ReconItem {
  id: string;
  date: string;
  check: Check;
  reference: { kind: string; id: string; ref?: string | null } | null;
  subject: string;
  description: string;
  expected: MoneyValue;
  actual: MoneyValue;
  difference: MoneyValue;
  ageDays: number;
  status: ItemStatus;
  note: string | null;
  owner: { name?: string | null } | null;
  correction: { status: 'pending_approval' | 'applied' | 'rejected'; approval?: { approverLabel?: string | null } | null } | null;
}
interface Payout {
  id: string;
  ref: string;
  sellerName: string;
  amount: MoneyValue;
  failedAt: string | null;
  failureReason: string | null;
  status: string;
  nextStep: string | null;
}
interface ReconDay {
  date: string;
  status: 'open' | 'completed';
  owner: { name?: string | null };
  backup: { name?: string | null } | null;
  due: { dueAt: string; state: string };
  checklist: Array<{ key: string; label: string; state: 'done' | 'in_progress' | 'late' | 'todo'; note: string | null; doneAt: string | null }>;
  openMismatches: number;
  netDifference: MoneyValue;
  chargebacksOpen: number;
  chargebacksAtRisk: MoneyValue;
  failedPayouts: Payout[];
  unexplained: MoneyValue;
  completedBy: { name?: string | null } | null;
  completedAt: string | null;
}
interface Dispute {
  id: string;
  ref: string;
  orderRef: string;
  ownerType: 'official' | 'seller' | null;
  sellerName: string | null;
  reason: string;
  amount: MoneyValue;
  evidenceDue: { dueAt: string; state: string } | null;
  status: 'opened' | 'under_review' | 'won' | 'lost';
  statusLabel: string;
}
interface AccessMe {
  limits?: Array<{ action: { key: string }; value: { authority?: string; limitMoney?: MoneyValue | null } | null }>;
}

const CORRECTIONS = [
  { value: 'refund_duplicate_capture', label: 'Refund duplicate capture to customer' },
  { value: 'adjust_order_total', label: 'Adjust order total' },
  { value: 'seller_adjustment', label: 'Seller balance adjustment' },
  { value: 'fee_correction', label: 'Fee correction' },
  { value: 'write_off', label: 'Write off difference' },
  { value: 'other', label: 'Other' },
];
const REASONS = [
  { value: '', label: 'Choose a reason' },
  { value: 'duplicate_capture', label: 'Duplicate capture by payment provider' },
  { value: 'coupon_after_authorization', label: 'Coupon applied after authorization' },
  { value: 'fee_calculation_error', label: 'Fee calculation error' },
  { value: 'shipping_counted_twice', label: 'Shipping counted twice' },
  { value: 'refund_deducted_twice', label: 'Refund deducted twice' },
  { value: 'provider_fee', label: 'Provider fee' },
  { value: 'timing', label: 'Timing difference' },
  { value: 'other', label: 'Other, explained in note' },
];
const STATUS_LABEL: Record<ItemStatus, string> = { open: 'Mismatch', explained: 'Explained', correction_pending: 'In review', corrected: 'Corrected', matched: 'Matched' };

interface Draft {
  itemId: string;
  type: string;
  amount: string;
  reason: string;
  note: string;
}

/** Signed difference: +$270.00 / −$8.00 / $0.00 (muted). */
function Diff({ m }: { m: MoneyValue }) {
  if (!m.amount) return <span className="muted">{formatMoney({ ...m, amount: 0 })}</span>;
  return m.amount > 0 ? <span className="ac-diff-pos">+{formatMoney(m)}</span> : <span className="ac-diff-neg">−{formatMoney({ ...m, amount: -m.amount })}</span>;
}

const open = (r: ReconItem) => r.status === 'open';
const sum = (ms: MoneyValue[]): MoneyValue => ({ amount: ms.reduce((a, m) => a + m.amount, 0), currency: ms[0]?.currency ?? 'USD' });
const refLabel = (r: ReconItem) => r.reference?.ref ?? r.subject;
const orderHref = (r: ReconItem) => (r.reference?.kind === 'order' && r.reference.ref ? href('admin/order', '', { ref: r.reference.ref }) : undefined);

export default function FinanceChecks() {
  const { api } = useApi();
  const qc = useQueryClient();
  const staff = useStaffSession();
  const canWork = staff.can('finance.reconciliation.work');
  const canDisputes = staff.can('payments.disputes.manage');
  // The day being checked: the previous market day's settlement.
  const date = useMemo(() => dayKey(new Date(Date.now() - 86_400_000)), []);
  const checksExport = useDatasetExport('finance.admin.checks');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [tried, setTried] = useState(false);
  const [notice, setNotice] = useState('');
  const formRef = useRef<HTMLElement>(null);
  const correctKey = useRef(newIdempotencyKey());

  const day = useQuery({ queryKey: ['finance', 'recon-day', date], queryFn: () => call(api.GET('/api/admin/finance/reconciliation/days/{date}', { params: { path: { date } } })) as Promise<ReconDay>, enabled: canWork });
  const items = useQuery({ queryKey: ['finance', 'recon-items'], queryFn: () => call(api.GET('/api/admin/finance/reconciliation/items', { params: { query: { limit: 100 } } })) as Promise<{ items: ReconItem[] }>, enabled: canWork });
  const disputes = useQuery({ queryKey: ['payments', 'disputes', 'open'], queryFn: () => call(api.GET('/api/admin/payments/disputes', { params: { query: { limit: 50 } } })) as Promise<{ items: Dispute[] }>, enabled: canDisputes });
  const access = useQuery({ queryKey: ['access', 'me', staff.accountId], queryFn: () => call(api.GET('/api/admin/access/me')) });

  const limit = useMemo(() => {
    const l = ((access.data as AccessMe | undefined)?.limits ?? []).find((x) => x.action.key === 'finance.reconciliation.correct' && x.value?.authority !== 'not_permitted');
    return l?.value?.limitMoney ?? null;
  }, [access.data]);

  // Open differences from any day, plus everything found for the day being checked.
  const all = (items.data?.items ?? []).filter((r) => r.status === 'open' || r.status === 'correction_pending' || r.date === date);
  const payments = all.filter((r) => r.check === 'payments_vs_orders');
  const sellers = all.filter((r) => r.check === 'seller_amounts');
  const unexplained = all.filter((r) => r.check === 'unexplained_amount' || r.check === 'provider_deposit' || r.check === 'store_credit');
  const chargebacks = (disputes.data?.items ?? []).filter((d) => d.status === 'opened' || d.status === 'under_review');
  const d = day.data;
  const failed = d?.failedPayouts ?? [];
  const checklist = d?.checklist ?? [];
  const doneN = checklist.filter((c) => c.state === 'done').length;
  const allDone = checklist.length > 0 && doneN === checklist.length;
  const firstOpen = checklist.find((c) => c.state === 'todo')?.key;

  const target = draft ? all.find((r) => r.id === draft.itemId && open(r)) : undefined;
  const amountMinor = draft ? Math.round(Number(draft.amount.replace(/[$,]/g, '')) * 100) : 0;
  const needsReview = !!limit && amountMinor > limit.amount;
  const errors = {
    amount: !(amountMinor > 0) ? 'Enter the correction amount.' : target && amountMinor > Math.abs(target.difference.amount) ? `The difference on this item is ${formatMoney({ ...target.difference, amount: Math.abs(target.difference.amount) })}.` : '',
    reason: !draft?.reason ? 'Choose a reason. Every correction is recorded with its reason.' : '',
    note: !draft?.note.trim() ? 'Explain the correction in the note.' : '',
  };
  const shown = tried ? errors : { amount: '', reason: '', note: '' };

  const pick = (r: ReconItem) => {
    const diff = r.difference.amount;
    setDraft({ itemId: r.id, type: r.check === 'seller_amounts' ? 'seller_adjustment' : diff > 0 ? 'refund_duplicate_capture' : 'adjust_order_total', amount: (Math.abs(diff) / 100).toFixed(2), reason: '', note: '' });
    setTried(false);
    correct.reset();
    correctKey.current = newIdempotencyKey();
    formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    formRef.current?.querySelector<HTMLElement>('select')?.focus({ preventScroll: true });
  };

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['finance'] });
    void qc.invalidateQueries({ queryKey: ['workqueues', 'queues'] });
  };
  const correct = useMutation({
    mutationFn: () =>
      call(
        api.POST('/api/admin/finance/reconciliation/items/{id}/correct', {
          params: { path: { id: draft!.itemId }, header: { 'Idempotency-Key': correctKey.current } },
          body: { type: draft!.type, amount: { amount: amountMinor, currency: target?.difference.currency ?? 'USD' }, reasonCode: draft!.reason, note: draft!.note.trim() },
        } as never),
      ) as Promise<ReconItem>,
    onSuccess: (r) => {
      const pending = r.status === 'correction_pending' || r.correction?.status === 'pending_approval';
      setNotice(pending ? `Correction for ${refLabel(r)} sent to ${r.correction?.approval?.approverLabel ?? 'a second Finance reviewer'} for second review.` : `Correction recorded for ${refLabel(r)}.`);
      announce(pending ? 'Correction sent for second review' : 'Correction recorded');
      setDraft(null);
      refresh();
    },
  });
  const complete = useMutation({
    mutationFn: () => call(api.POST('/api/admin/finance/reconciliation/days/{date}/complete', { params: { path: { date } }, body: {} })),
    onSuccess: () => {
      announce('Day check completed');
      refresh();
      void qc.invalidateQueries({ queryKey: ['notifications', 'summary', 'staff'] });
    },
  });

  const submit = () => {
    if (!target) return;
    setTried(true);
    if (Object.values(errors).some(Boolean)) return;
    correct.mutate();
  };

  const sub = d ? `Assigned to ${d.owner.name ?? 'Finance'}${d.backup?.name ? ` · backup ${d.backup.name}` : ''} · checking ${weekdayDate(d.date)} settlement · due ${time(d.due.dueAt)} PT` : `Checking ${weekdayDate(date)} settlement`;

  if (!canWork) {
    return (
      <OpsLayout active="finance-checks">
        <PageHeader title="Daily finance checks" sub={`Checking ${weekdayDate(date)} settlement`} />
        <Alert tone="info" title="Finance access needed">
          The daily finance checks are worked by Finance staff with reconciliation access.
        </Alert>
      </OpsLayout>
    );
  }

  const paymentsTable = (rows: ReconItem[], label: string) => (
    <>
      <div className="no-phone">
        <TableWrap label={label}>
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Order</th>
                <th scope="col">Method</th>
                <th className="r" scope="col">Collected</th>
                <th className="r" scope="col">Order total</th>
                <th className="r" scope="col">Difference</th>
                <th scope="col">Age</th>
                <th scope="col">Status</th>
                <th scope="col">Note</th>
                <th className="col-pin" scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.isPending && <SkeletonRows cols={9} rows={3} />}
              {!items.isPending && !rows.length && <EmptyRow cols={9}>Every payment matches its order.</EmptyRow>}
              {rows.map((p) => {
                const to = orderHref(p);
                return (
                  <tr key={p.id} className={cx(open(p) && 'is-flagged')}>
                    <td>
                      {open(p) && <span className="sr-only">Urgent: </span>}
                      {to ? (
                        <Link className="mono nowrap" to={to} title={refLabel(p)}>
                          {refLabel(p)}
                        </Link>
                      ) : (
                        <span className="mono nowrap">{refLabel(p)}</span>
                      )}
                    </td>
                    <td>
                      <span className="small nowrap">{p.subject}</span>
                    </td>
                    <td className="r">{formatMoney(p.actual)}</td>
                    <td className="r">{formatMoney(p.expected)}</td>
                    <td className="r">
                      <Diff m={p.difference} />
                    </td>
                    <td>{p.ageDays} d</td>
                    <td>
                      <StatusBadge status={STATUS_LABEL[p.status]} />
                    </td>
                    <td>
                      <span className="xs sub">{p.note ?? p.description}</span>
                    </td>
                    <td className="col-pin">
                      {open(p) && (
                        <button type="button" className="btn btn-ghost btn-sm" aria-pressed={draft?.itemId === p.id} onClick={() => pick(p)}>
                          <span>Record correction</span>
                          <span className="sr-only"> {refLabel(p)}</span>
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableWrap>
        {rows.some(open) && <OpsLegend items={LEGEND} />}
      </div>
      <div className="ac-mlist only-phone">
        {items.isPending && <SkeletonLines rows={2} />}
        {rows.map((p) => (
          <div key={p.id} className={cx('ac-mi', open(p) && 'is-flagged')}>
            {open(p) && <span className="sr-only">Urgent: </span>}
            <div className="row between gap-2 nowrap top">
              <span className="small strong min-w-0">
                {open(p) ? (
                  <a className="mono nowrap" href="#" onClick={(e) => (e.preventDefault(), pick(p))}>
                    {refLabel(p)}
                  </a>
                ) : (
                  <span className="mono nowrap">{refLabel(p)}</span>
                )}
              </span>
              <StatusBadge status={STATUS_LABEL[p.status]} />
            </div>
            <div className="xs sub">
              Collected {formatMoney(p.actual)} · order {formatMoney(p.expected)} · <Diff m={p.difference} />
            </div>
            <div className="xs sub">
              {p.subject} · {p.ageDays} d · {p.note ?? p.description}
            </div>
          </div>
        ))}
      </div>
      {rows.some(open) && <OpsLegend className="only-phone" items={LEGEND} />}
    </>
  );

  return (
    <OpsLayout active="finance-checks">
      <PageHeader
        title="Daily finance checks"
        sub={sub}
        actions={
          <>
            {staff.can('reports.exports.create') && staff.can('finance.reconciliation.work') && <ExportButton exp={checksExport} filters={{ date }} />}
            <Button size="sm" icon="circle-check" disabled={!allDone || d?.status === 'completed' || complete.isPending} onClick={() => complete.mutate()}>
              {d?.status === 'completed' ? 'Day check completed' : 'Complete day check'}
            </Button>
          </>
        }
      />
      {d?.status === 'completed' && <Alert tone="success" title={`Day check for ${weekdayDate(d.date)} completed${d.completedAt ? ` at ${time(d.completedAt)}` : ''}${d.completedBy?.name ? ` by ${d.completedBy.name}` : ''}. The summary went to the Business Owner.`} />}
      <ExportNotice exp={checksExport} />
      {complete.error && <Alert tone="danger">{errorMessage(complete.error)}</Alert>}
      {day.error && <LoadError error={day.error} onRetry={() => void day.refetch()} />}
      <div className="ac-main">
        <div className="stack gap-5">
          <div className="ac-kpis">
            <div className="card pad">{d ? <Stat label="Open mismatches" value={String(d.openMismatches)} note={`${formatMoney(d.netDifference)} net difference`} /> : <span className="sk sk-line" />}</div>
            <div className="card pad">{d ? <Stat label="Chargebacks and disputes" value={String(d.chargebacksOpen)} note={`${formatMoney(d.chargebacksAtRisk)} at risk`} /> : <span className="sk sk-line" />}</div>
            <div className="card pad">{d ? <Stat label="Failed payouts" value={String(failed.length)} note={formatMoney(sum(failed.map((p) => p.amount)))} /> : <span className="sk sk-line" />}</div>
            <div className="card pad">{d ? <Stat label="Unexplained" value={formatMoney(d.unexplained)} note={unexplained[0]?.description ?? 'Nothing unexplained'} /> : <span className="sk sk-line" />}</div>
          </div>
          {notice && <Alert tone="success" title={notice} />}
          {items.error && <LoadError error={items.error} onRetry={() => void items.refetch()} />}
          <Card title="Payments vs orders" sub="Collected by the payment provider vs order totals" flush>
            {paymentsTable(payments, 'Payments vs orders table')}
          </Card>
          <Card title="Seller amounts" titleAs="h3" sub="Statement amounts vs ledger" flush>
            <div className="no-phone">
              <TableWrap label="Seller amounts table">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Seller</th>
                      <th scope="col">Statement</th>
                      <th className="r" scope="col">Expected</th>
                      <th className="r" scope="col">Recorded</th>
                      <th className="r" scope="col">Difference</th>
                      <th scope="col">Age</th>
                      <th scope="col">Status</th>
                      <th className="col-pin" scope="col">
                        Note
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.isPending && <SkeletonRows cols={8} rows={2} />}
                    {!items.isPending && !sellers.length && <EmptyRow cols={8}>Seller amounts match their statements.</EmptyRow>}
                    {sellers.map((s) => (
                      <tr key={s.id} className={cx(open(s) && 'is-flagged')}>
                        <td>
                          {open(s) && <span className="sr-only">Urgent: </span>}
                          <span className="small strong">{s.subject}</span>
                        </td>
                        <td>
                          <span className="mono small nowrap" title={s.reference?.ref ?? ''}>
                            {s.reference?.ref ?? '—'}
                          </span>
                        </td>
                        <td className="r">{formatMoney(s.expected)}</td>
                        <td className="r">{formatMoney(s.actual)}</td>
                        <td className="r">
                          <Diff m={s.difference} />
                        </td>
                        <td>{s.ageDays} d</td>
                        <td>
                          <StatusBadge status={STATUS_LABEL[s.status]} />
                        </td>
                        <td className="col-pin">
                          {open(s) ? (
                            <button type="button" className="btn btn-ghost btn-sm" aria-pressed={draft?.itemId === s.id} onClick={() => pick(s)}>
                              <span>Record correction</span>
                              <span className="sr-only"> {s.subject}</span>
                            </button>
                          ) : (
                            <span className="xs sub">{s.note ?? s.description}</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
              {sellers.some(open) && <OpsLegend items={LEGEND} />}
            </div>
            <div className="ac-mlist only-phone">
              {sellers.map((s) => (
                <div key={s.id} className={cx('ac-mi', open(s) && 'is-flagged')}>
                  {open(s) && <span className="sr-only">Urgent: </span>}
                  <div className="row between gap-2 nowrap top">
                    <span className="small strong min-w-0">{s.subject}</span>
                    <StatusBadge status={STATUS_LABEL[s.status]} />
                  </div>
                  <div className="xs sub">
                    <span className="mono">{s.reference?.ref ?? '—'}</span> · expected {formatMoney(s.expected)} · recorded {formatMoney(s.actual)}
                  </div>
                  <div className="xs sub">
                    <Diff m={s.difference} /> · {s.ageDays} d · {s.note ?? s.description}
                  </div>
                </div>
              ))}
            </div>
            {sellers.some(open) && <OpsLegend className="only-phone" items={LEGEND} />}
          </Card>
          <Card title="Chargebacks and payment disputes" titleAs="h3" sub="A customer disputed the charge with their card provider" flush>
            {!canDisputes ? (
              <div className="card-body">
                <p className="small muted">Disputes are handled by staff with payment dispute access. {d ? `${d.chargebacksOpen} open, ${formatMoney(d.chargebacksAtRisk)} at risk.` : ''}</p>
              </div>
            ) : disputes.error ? (
              <div className="card-body">
                <LoadError error={disputes.error} onRetry={() => void disputes.refetch()} />
              </div>
            ) : (
              <>
                <div className="no-phone">
                  <TableWrap label="Chargebacks and payment disputes table">
                    <table className="table">
                      <thead>
                        <tr>
                          <th scope="col">Case</th>
                          <th scope="col">Order</th>
                          <th scope="col">Seller</th>
                          <th className="r" scope="col">Amount</th>
                          <th scope="col">Reason</th>
                          <th scope="col">Response due</th>
                          <th className="col-pin" scope="col">
                            Status
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {disputes.isPending && <SkeletonRows cols={7} rows={2} />}
                        {!disputes.isPending && !chargebacks.length && <EmptyRow cols={7}>No open chargebacks or disputes.</EmptyRow>}
                        {chargebacks.map((c) => (
                          <tr key={c.id}>
                            <td>
                              <Link className="mono small nowrap" to={href('admin/finance', 'disputes-and-chargebacks')} title={c.ref}>
                                {c.ref}
                              </Link>
                            </td>
                            <td>
                              <Link className="mono nowrap" to={href('admin/order', '', { ref: c.orderRef })} title={c.orderRef}>
                                {c.orderRef}
                              </Link>
                            </td>
                            <td>
                              <span className="small">{c.ownerType === 'official' ? 'Marketly Official' : (c.sellerName ?? '—')}</span>
                            </td>
                            <td className="r">{formatMoney(c.amount)}</td>
                            <td>
                              <span className="small">{c.reason}</span>
                            </td>
                            <td>{c.evidenceDue ? <Deadline tone={deadlineTone(c.evidenceDue.state)}>{deadlineLabel(c.evidenceDue.dueAt)}</Deadline> : <span className="muted">—</span>}</td>
                            <td className="col-pin">
                              <StatusBadge status={c.statusLabel} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </TableWrap>
                </div>
                <div className="ac-mlist only-phone">
                  {chargebacks.map((c) => (
                    <div key={c.id} className="ac-mi">
                      <div className="row between gap-2 nowrap top">
                        <span className="small strong min-w-0">
                          <span className="mono">{c.ref}</span>
                        </span>
                        <StatusBadge status={c.statusLabel} />
                      </div>
                      <div className="xs sub">
                        {c.ownerType === 'official' ? 'Marketly Official' : (c.sellerName ?? '—')} · {formatMoney(c.amount)} · {c.reason}
                      </div>
                      {c.evidenceDue && <div className="xs sub">Response due {deadlineLabel(c.evidenceDue.dueAt)}</div>}
                    </div>
                  ))}
                </div>
              </>
            )}
          </Card>
          <Card
            title="Failed payouts"
            titleAs="h3"
            flush
            footClassName="start"
            foot={<span className="xs muted">Funds stay in the seller's Available balance until a new payout succeeds. New bank details need verification and a 72-hour review.</span>}
          >
            <div className="no-phone">
              <TableWrap label="Failed payouts table">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Payout</th>
                      <th scope="col">Seller</th>
                      <th className="r" scope="col">Amount</th>
                      <th scope="col">Failure</th>
                      <th scope="col">Age</th>
                      <th scope="col">Status</th>
                      <th className="col-pin" scope="col">
                        Next step
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {day.isPending && <SkeletonRows cols={7} rows={2} />}
                    {!day.isPending && !failed.length && <EmptyRow cols={7}>No failed payouts to follow up.</EmptyRow>}
                    {failed.map((p) => (
                      <tr key={p.id} className="is-flagged">
                        <td>
                          <span className="sr-only">Urgent: </span>
                          <Link className="mono nowrap" to={href('admin/payouts')} title={p.ref}>
                            {p.ref}
                          </Link>
                        </td>
                        <td>
                          <span className="small strong">{p.sellerName}</span>
                        </td>
                        <td className="r">{formatMoney(p.amount)}</td>
                        <td>
                          <span className="small">{p.failureReason ?? '—'}</span>
                        </td>
                        <td>{p.failedAt ? `${Math.max(0, Math.round((Date.now() - new Date(p.failedAt).getTime()) / 86_400_000))} d` : '—'}</td>
                        <td>
                          <StatusBadge status={humanize(p.status)} />
                        </td>
                        <td className="col-pin">
                          <span className="small">{p.nextStep ?? '—'}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
              {failed.length > 0 && <OpsLegend items={LEGEND} />}
            </div>
            <div className="ac-mlist only-phone">
              {failed.map((p) => (
                <div key={p.id} className="ac-mi is-flagged">
                  <span className="sr-only">Urgent: </span>
                  <div className="row between gap-2 nowrap top">
                    <span className="small strong min-w-0">
                      <span className="mono">{p.ref}</span>
                    </span>
                    <StatusBadge status={humanize(p.status)} />
                  </div>
                  <div className="xs sub">
                    {p.sellerName} · {formatMoney(p.amount)}
                  </div>
                  <div className="xs sub">{p.failureReason ?? '—'}</div>
                  <div className="xs sub">Next: {p.nextStep ?? '—'}</div>
                </div>
              ))}
            </div>
            {failed.length > 0 && <OpsLegend className="only-phone" items={LEGEND} />}
          </Card>
          <Card title="Unexplained amounts" titleAs="h3" flush>
            <div className="no-phone">
              <TableWrap label="Unexplained amounts table">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Item</th>
                      <th className="r" scope="col">Expected</th>
                      <th className="r" scope="col">Received</th>
                      <th className="r" scope="col">Difference</th>
                      <th scope="col">Age</th>
                      <th scope="col">Status</th>
                      <th className="col-pin" scope="col">
                        Owner
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.isPending && <SkeletonRows cols={7} rows={1} />}
                    {!items.isPending && !unexplained.length && <EmptyRow cols={7}>Nothing unexplained.</EmptyRow>}
                    {unexplained.map((u) => (
                      <tr key={u.id} className={cx(open(u) && 'is-flagged')}>
                        <td>
                          {open(u) && <span className="sr-only">Urgent: </span>}
                          {u.description}
                        </td>
                        <td className="r">{formatMoney(u.expected)}</td>
                        <td className="r">{formatMoney(u.actual)}</td>
                        <td className="r">
                          <Diff m={u.difference} />
                        </td>
                        <td>{u.ageDays} d</td>
                        <td>
                          <StatusBadge status={STATUS_LABEL[u.status]} />
                        </td>
                        <td className="col-pin">{u.owner?.name ?? 'Unassigned'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
              {unexplained.some(open) && <OpsLegend items={LEGEND} />}
            </div>
            <div className="ac-mlist only-phone">
              {unexplained.map((u) => (
                <div key={u.id} className={cx('ac-mi', open(u) && 'is-flagged')}>
                  {open(u) && <span className="sr-only">Urgent: </span>}
                  <div className="row between gap-2 nowrap top">
                    <span className="small strong min-w-0">{u.description}</span>
                    <StatusBadge status={STATUS_LABEL[u.status]} />
                  </div>
                  <div className="xs sub">
                    Expected {formatMoney(u.expected)} · received {formatMoney(u.actual)} · <Diff m={u.difference} />
                  </div>
                </div>
              ))}
            </div>
            {unexplained.some(open) && <OpsLegend className="only-phone" items={LEGEND} />}
          </Card>
        </div>
        <div className="stack gap-5">
          <Card title="Today's checklist" titleAs="h3" sub={d ? `${doneN} of ${checklist.length} done` : 'Loading…'}>
            {day.isPending ? (
              <SkeletonLines rows={6} />
            ) : (
              <>
                <Meter pct={checklist.length ? Math.round((doneN / checklist.length) * 100) : 0} label="Today's checklist" />
                <ul>
                  {checklist.map((c) => {
                    const state = c.state === 'done' ? 'is-done' : c.state === 'late' ? 'is-late' : c.state === 'in_progress' || c.key === firstOpen ? 'is-now' : '';
                    return (
                      <li key={c.key} className={cx('ac-ck', state)}>
                        <span className="ic" aria-hidden="true">
                          {c.state === 'done' ? <Icon name="check" /> : c.state === 'late' ? <Icon name="alarm-clock" /> : null}
                        </span>
                        <span className="stack gap-0 grow">
                          <span className="small strong">{c.label}</span>
                          <span className="xs muted">{c.state === 'done' ? (c.doneAt ? `Done ${time(c.doneAt)}${c.note ? ` · ${c.note}` : ''}` : (c.note ?? 'Done')) : (c.note ?? (c.state === 'late' ? 'Overdue' : 'Not done yet'))}</span>
                        </span>
                        <span className="sr-only">{c.state === 'done' ? 'Done' : c.state === 'late' ? 'Overdue' : 'Not done'}</span>
                      </li>
                    );
                  })}
                </ul>
                {!allDone && <span className="xs muted">Each check is done when its differences are matched, explained or corrected. Complete day check unlocks when every check is done.</span>}
              </>
            )}
          </Card>
          <section className="card" ref={formRef}>
            <div className="card-head">
              <div className="stack gap-0">
                <h3 className="h4">Record correction</h3>
                <span className="xs muted">
                  {target
                    ? `${refLabel(target)} · ${target.check === 'seller_amounts' ? 'recorded' : 'collected'} ${formatMoney({ ...target.difference, amount: Math.abs(target.difference.amount) })} ${target.difference.amount > 0 ? 'more' : 'less'} than expected`
                    : payments.some(open) || sellers.some(open)
                      ? 'Choose Record correction on a mismatch'
                      : 'No open payment mismatches'}
                </span>
              </div>
            </div>
            {target && draft ? (
              <>
                <div className="card-body">
                  {correct.error && <Alert tone="danger">{errorMessage(correct.error)}</Alert>}
                  <Field label="Correction">
                    <Select id="fc-type" options={CORRECTIONS} value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value })} />
                  </Field>
                  <Field label="Amount" error={shown.amount || undefined}>
                    <TextInput id="fc-amt" prefix="$" value={draft.amount} error={!!shown.amount} inputMode="decimal" onChange={(e) => setDraft({ ...draft, amount: e.target.value })} />
                  </Field>
                  <Field label="Reason (required)" error={shown.reason || undefined}>
                    <Select id="fc-reason" options={REASONS} value={draft.reason} className={cx(shown.reason && 'is-error')} onChange={(e) => setDraft({ ...draft, reason: e.target.value })} />
                  </Field>
                  <Field label="Note" error={shown.note || undefined}>
                    <Textarea id="fc-note" value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} />
                  </Field>
                  {needsReview && (
                    <Alert tone="warning" title="Second reviewer required">
                      Corrections over {formatMoney(limit)} need a second Finance reviewer.
                    </Alert>
                  )}
                  {limit && (
                    <span className="xs muted row gap-1 nowrap wrap">
                      <Icon name="info" className="ic-sm" />
                      <span>Your correction limit is {formatMoney(limit)}, set by the Business Owner.</span>
                    </span>
                  )}
                </div>
                <div className="card-foot">
                  <Button size="sm" icon={needsReview ? 'send' : 'check'} onClick={submit} disabled={correct.isPending}>
                    {needsReview ? 'Send for second review' : 'Record correction'}
                  </Button>
                </div>
              </>
            ) : (
              <div className="card-body">
                <p className="small muted">{payments.some(open) || sellers.some(open) ? 'Pick a mismatch in the tables to record its correction.' : 'Every payment matches its order.'}</p>
              </div>
            )}
          </section>
        </div>
      </div>
    </OpsLayout>
  );
}
