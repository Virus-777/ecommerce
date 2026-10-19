// Admin › Finance › "Refunds to approve": the Finance approval queue for refunds staff started (return inspection
// remedies, refund-without-return, order-page exception refunds, case decisions). No design exists for this view; it
// reuses the Finance queues table, row buttons and dialogs.
// Data: GET /api/admin/returns/refunds?awaitingApproval=true (requested or under review, seller refunds left out) and
// ?status=declined (newest first, paged; returns.requests.view). Each row says whether the caller may approve it (canApprove).
// Writes: POST …/refunds/{id}/approve (Idempotency-Key; the password again above the step-up threshold, sent as
// reauthToken; above the approver's own limit the refund stays under review with `approval` naming who approves),
// …/decline { reason } (returns.refunds.approve) and …/revise RemedyInput (declined refunds only; returns.requests.manage).
// Approvers may also reach the same refunds through Inbox (access approval requests); both routes end in the same state.
import { useRef, useState, type ReactNode } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { ApiError, call, errorMessage, newIdempotencyKey, useApi, type components } from '@marketly/web-shared/api';
import { formatMoney } from '@marketly/web-shared/lib/format';
import { href } from '@marketly/web-shared/routes';
import { Alert, Button, Dialog, Field, Icon, KeyValue, Pager, SegmentedControl, StatusBadge, TableWrap, Textarea, TextInput, announce } from '@marketly/web-shared/ui';
import { useStaffSession } from '@/app/session';
import { LoadError, SkeletonLines, dateTime } from '@/app/parts';
import { FUNDED_BY, REFUND_REASONS, parseMinor, toInput } from './order';
import { isStepUpCancel, reauthField, useStepUp } from './step-up';

export type RefundRequest = components['schemas']['returns.RefundRequest'];
type Money = components['schemas']['Money'];

/** The two lists of the view: refunds waiting for a Finance decision, and the ones sent back for changes. */
export type ApprovalFilter = 'under_review' | 'declined';
const FILTERS: Array<{ value: ApprovalFilter; label: string }> = [
  { value: 'under_review', label: 'Waiting for approval' },
  { value: 'declined', label: 'Sent back' },
];
const LIMIT = 25;

const SOURCE_LABEL: Record<RefundRequest['source'], string> = {
  return: 'Return inspection',
  case: 'Case decision',
  exception: 'Order page refund',
  seller: 'Seller refund',
};
const REMEDY_LABEL: Record<string, string> = { full_refund: 'Full refund', partial_refund: 'Partial refund', store_credit: 'Store credit' };
const reasonLabel = (code?: string | null) => (code ? (REFUND_REASONS.find((r) => r.value === code)?.label ?? REMEDY_LABEL[code] ?? code.replace(/_/g, ' ')) : '');
const fundedLabel = (f: RefundRequest['fundedBy']) => FUNDED_BY.find((x) => x.value === f)?.label ?? f;
const SENT = new Set<RefundRequest['status']>(['approved', 'processing', 'sent']);

/** The refunds in one list; Finance shows the "Waiting for approval" total on its tab. */
export function useRefundRequests(status: ApprovalFilter, page: number, enabled: boolean) {
  const { api } = useApi();
  return useQuery({
    queryKey: ['returns', 'refund-requests', status, page],
    queryFn: () => call(api.GET('/api/admin/returns/refunds', { params: { query: status === 'under_review' ? { awaitingApproval: true, page, limit: LIMIT } : { status, page, limit: LIMIT } } })),
    enabled,
    placeholderData: keepPreviousData,
  });
}

/**
 * The backend's refusal, with what to do next. A refund above the caller's limit normally comes back still under
 * review (not as an error); these are the cases where the caller may not decide it at all.
 */
function refusal(e: unknown): string {
  const msg = errorMessage(e);
  if (!(e instanceof ApiError)) return msg;
  if (e.code === 'FORBIDDEN' || e.code === 'NOT_ELIGIBLE_APPROVER') return `${msg} This refund needs someone whose refund limit covers the amount, such as a Finance Manager or the Business Owner. It stays waiting for them.`;
  if (e.code === 'SELF_APPROVAL_NOT_ALLOWED') return `${msg} A different approver decides it.`;
  if (e.code === 'APPROVAL_REQUIRED') return `${msg} Try again in a moment; the refund stays waiting.`;
  return msg;
}

/** Row action button: visible label plus the row reference for screen readers (as on the other Finance queues). */
function RowButton({ variant = 'secondary', sr, onClick, disabled, children }: { variant?: 'secondary' | 'ghost'; sr: string; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button type="button" className={`btn btn-${variant} btn-sm`} onClick={onClick} disabled={disabled}>
      <span>{children}</span>
      <span className="sr-only"> {sr}</span>
    </button>
  );
}

function SpanRow({ cols, children }: { cols: number; children: ReactNode }) {
  return (
    <tr>
      <td colSpan={cols} className="muted">
        {children}
      </td>
    </tr>
  );
}

type Pending = { kind: 'approve' | 'decline' | 'revise'; row: RefundRequest } | null;

/** The table, filter and dialogs of the "Refunds to approve" tab. Rendered inside the Finance queues card. */
export function RefundApprovals() {
  const { api } = useApi();
  const qc = useQueryClient();
  const { can } = useStaffSession();
  const stepUp = useStepUp();
  const canView = can('returns.requests.view');
  const canApprove = can('returns.refunds.approve');
  const canRevise = can('returns.requests.manage');

  const [filter, setFilter] = useState<ApprovalFilter>('under_review');
  const [page, setPage] = useState(1);
  const [pending, setPending] = useState<Pending>(null);
  const [note, setNote] = useState('');
  const [amount, setAmount] = useState('');
  const [attempted, setAttempted] = useState(false);
  const [dialogError, setDialogError] = useState('');
  const [done, setDone] = useState<{ tone: 'success' | 'info'; title: string; body: string } | null>(null);
  // One key per opened approval: a retry after the password prompt or a lost answer replays, never approves twice.
  // (The server releases the key when a try fails, so the confirmed retry can reuse it.)
  const approveKey = useRef('');

  const list = useRefundRequests(filter, page, canView);
  const rows = (list.data?.items ?? []) as RefundRequest[];
  const totalPages = list.data?.totalPages ?? 1;

  const refreshAll = () => {
    void qc.invalidateQueries({ queryKey: ['returns'] });
    void qc.invalidateQueries({ queryKey: ['orders'] });
    void qc.invalidateQueries({ queryKey: ['payments', 'refunds'] });
    void qc.invalidateQueries({ queryKey: ['finance', 'overview'] });
    void qc.invalidateQueries({ queryKey: ['workqueues', 'queues'] });
    // Inbox approval requests for the same refund are decided or withdrawn by these calls.
    void qc.invalidateQueries({ queryKey: ['access'] });
    void qc.invalidateQueries({ queryKey: ['notifications'] });
  };
  const finish = (n: NonNullable<typeof done>) => {
    refreshAll();
    setDone(n);
    announce(n.title);
    setPending(null);
  };

  const approve = useMutation({
    mutationFn: (v: { row: RefundRequest; note: string }) =>
      stepUp.run((token) =>
        call(
          api.POST('/api/admin/returns/refunds/{id}/approve', {
            params: { path: { id: v.row.id }, header: { 'Idempotency-Key': approveKey.current } },
            body: { note: v.note || null, ...reauthField(token) },
          }),
        ),
      ),
    onSuccess: (r) => {
      const total = formatMoney(r.breakdown.total);
      if (SENT.has(r.status))
        finish({ tone: 'success', title: `Refund ${r.ref} approved and sent`, body: `${total} goes to ${r.breakdown.destination}. Approved is not money arrived: the customer sees Sent when the payment provider confirms it.` });
      else {
        // Above the approver's own limit (or a second reviewer is needed): the refund stays under review and access
        // routes it on; `approval` names who decides next.
        const who = r.approval?.approvers?.length ? r.approval.approvers.join(' or ') : 'an approver with a higher refund limit';
        finish({ tone: 'info', title: `Refund ${r.ref} needs another approval`, body: `${r.approval?.reason ?? `Waiting for ${who}`}. ${total} is above what you can approve alone, so ${who} approves it before it is sent. It is in their Inbox.` });
      }
    },
    onError: (e) => {
      if (!isStepUpCancel(e)) setDialogError(refusal(e));
    },
  });
  const decline = useMutation({
    mutationFn: (v: { row: RefundRequest; reason: string }) => call(api.POST('/api/admin/returns/refunds/{id}/decline', { params: { path: { id: v.row.id } }, body: { reason: v.reason } })),
    onSuccess: (r) => finish({ tone: 'success', title: `Refund ${r.ref} sent back`, body: 'It is under Sent back with your reason. The Returns team can change it and send it again; nothing was paid.' }),
    onError: (e) => setDialogError(refusal(e)),
  });
  const revise = useMutation({
    mutationFn: (v: { row: RefundRequest; amount: number; explanation: string }) => {
      const b = v.row.breakdown;
      // The refund before deductions; asking for less is a partial refund with the difference explained.
      const full = b.itemAmount.amount - b.discountShare.amount + b.shippingRefund.amount - b.returnShippingDeduction.amount;
      const cur = b.total.currency;
      const body: components['schemas']['returns.RemedyInput'] =
        v.amount >= full
          ? { kind: 'full_refund', explanation: v.explanation }
          : {
              kind: 'partial_refund',
              amount: { amount: v.amount, currency: cur },
              deductions: [{ label: 'Changed in Finance review', reason: v.explanation, amount: { amount: full - v.amount, currency: cur } }],
              explanation: v.explanation,
            };
      return call(api.POST('/api/admin/returns/refunds/{id}/revise', { params: { path: { id: v.row.id } }, body }));
    },
    onSuccess: (r) => {
      setFilter('under_review');
      setPage(1);
      finish({ tone: 'success', title: `Refund ${r.ref} revised`, body: `It is back under Waiting for approval at ${formatMoney(r.breakdown.total)}.` });
    },
    onError: (e) => setDialogError(refusal(e)),
  });
  const busy = approve.isPending || decline.isPending || revise.isPending || stepUp.waiting;

  const open = (kind: NonNullable<Pending>['kind'], row: RefundRequest) => {
    setPending({ kind, row });
    setNote('');
    setAmount(toInput(row.breakdown.total.amount));
    setAttempted(false);
    setDialogError('');
    approveKey.current = newIdempotencyKey();
  };
  const close = () => {
    if (!busy) setPending(null);
  };

  const max: Money | null = pending?.row.breakdown.maxRefundable ?? null;
  const asked = parseMinor(amount);
  const noteError = attempted && pending?.kind !== 'approve' && !note.trim() ? (pending?.kind === 'decline' ? 'Say why the refund is sent back.' : 'Explain the change. Finance reads it before approving.') : undefined;
  const amountError =
    attempted && pending?.kind === 'revise' ? (Number.isNaN(asked) || asked <= 0 ? 'Enter an amount, like 34.65.' : max && asked > max.amount ? `Enter ${formatMoney(max)} or less. That's all that can still be refunded.` : undefined) : undefined;

  const submit = () => {
    setAttempted(true);
    if (!pending) return;
    setDialogError('');
    if (pending.kind === 'approve') return approve.mutate({ row: pending.row, note: note.trim() });
    if (!note.trim()) return;
    if (pending.kind === 'decline') return decline.mutate({ row: pending.row, reason: note.trim() });
    if (Number.isNaN(asked) || asked <= 0 || (max && asked > max.amount)) return;
    revise.mutate({ row: pending.row, amount: asked, explanation: note.trim() });
  };

  const changeFilter = (f: ApprovalFilter) => {
    setFilter(f);
    setPage(1);
    setDone(null);
  };

  const r = pending?.row;
  const pairs: Array<[ReactNode, ReactNode]> = r
    ? [
        ['Refund to customer', <b key="t">{formatMoney(r.breakdown.total)}</b>],
        ['Refund to', r.breakdown.destination],
        ['Paid by', `${fundedLabel(r.fundedBy)}${r.fundedBy === 'shared' && r.sellerShare && r.platformShare ? ` · seller ${formatMoney(r.sellerShare)}, Marketly ${formatMoney(r.platformShare)}` : ''}`],
        ...(r.earningsImpact ? ([['Seller earnings change', formatMoney(r.earningsImpact.sellerEarningsChange)]] as Array<[ReactNode, ReactNode]>) : []),
        ['Order', `${r.orderRef} · ${r.sellerName}`],
        ['Reason', r.reason || reasonLabel(r.reasonCode) || SOURCE_LABEL[r.source]],
        ['Requested by', `${r.proposedBy.name ?? 'Staff member'} · ${dateTime(r.createdAt)}`],
      ]
    : [];

  return (
    <>
      <div className="card-body u-pb-0 stack gap-3">
        <SegmentedControl items={FILTERS} active={filter} onChange={changeFilter} label="Which refunds" />
        {done && (
          <Alert tone={done.tone} title={done.title}>
            {done.body}
          </Alert>
        )}
      </div>
      <TableWrap label="Refunds to approve table">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Refund</th>
              <th scope="col">Order and return</th>
              <th scope="col">Customer</th>
              <th className="r" scope="col">
                Amount
              </th>
              <th scope="col">Reason</th>
              <th scope="col">Requested</th>
              <th className="col-pin" scope="col">
                Next step
              </th>
            </tr>
          </thead>
          <tbody>
            {!canView ? (
              <SpanRow cols={7}>Your role can’t see refund requests.</SpanRow>
            ) : list.isPending ? (
              <SpanRow cols={7}>
                <SkeletonLines rows={3} />
              </SpanRow>
            ) : list.isError ? (
              <SpanRow cols={7}>
                <LoadError error={list.error} onRetry={() => void list.refetch()} />
              </SpanRow>
            ) : !rows.length ? (
              <SpanRow cols={7}>{filter === 'under_review' ? 'No refunds are waiting for approval.' : 'No refunds are sent back.'}</SpanRow>
            ) : null}
            {canView &&
              rows.map((x) => (
                <tr key={x.id}>
                  <td>
                    <span className="ab-cell">
                      <span className="mono nowrap strong">{x.ref}</span>
                      <span className="xs muted">{SOURCE_LABEL[x.source]}</span>
                    </span>
                  </td>
                  <td>
                    <span className="ab-cell">
                      <Link className="mono nowrap strong" to={href('admin/order', '', { ref: x.orderRef })}>
                        {x.orderRef}
                      </Link>
                      {x.returnRef ? (
                        <Link className="xs mono nowrap" to={href('admin/returns', 'exception-review', undefined, { rt: x.returnRef })}>
                          {x.returnRef}
                        </Link>
                      ) : (
                        <span className="xs muted">{x.sellerName}</span>
                      )}
                    </span>
                  </td>
                  <td>{x.customerName}</td>
                  <td className="r">
                    <span className="num">{formatMoney(x.breakdown.total)}</span>
                  </td>
                  <td>
                    <span className="ab-cell">
                      <span>{x.reason || reasonLabel(x.reasonCode) || '—'}</span>
                      {x.status === 'declined' && x.declineReason ? (
                        <span className="xs t-warning-text">Sent back: {x.declineReason}</span>
                      ) : x.approval?.required ? (
                        <span className="xs muted">{x.approval.reason ?? `Waiting for ${x.approval.approvers.join(' or ')}`}</span>
                      ) : null}
                    </span>
                  </td>
                  <td>
                    <span className="ab-cell">
                      <span>{x.proposedBy.name ?? 'Staff member'}</span>
                      <span className="xs muted nowrap">{dateTime(x.createdAt)}</span>
                    </span>
                  </td>
                  <td className="col-pin">
                    {x.status === 'under_review' || x.status === 'requested' ? (
                      // canApprove: the approve permission, a limit that covers the amount, and not the person who asked
                      canApprove && x.canApprove !== false ? (
                        <span className="row nowrap gap-2">
                          <RowButton sr={x.ref} disabled={busy} onClick={() => open('approve', x)}>
                            Approve
                          </RowButton>
                          <RowButton variant="ghost" sr={x.ref} disabled={busy} onClick={() => open('decline', x)}>
                            Send back
                          </RowButton>
                        </span>
                      ) : (
                        <span className="xs muted">{canApprove ? 'Someone with a higher refund limit approves this' : 'Finance approves this'}</span>
                      )
                    ) : x.status === 'declined' ? (
                      canRevise ? (
                        <RowButton sr={x.ref} disabled={busy} onClick={() => open('revise', x)}>
                          Revise
                        </RowButton>
                      ) : (
                        <span className="xs muted">The Returns team revises this</span>
                      )
                    ) : (
                      <StatusBadge status={x.status.replace(/_/g, ' ')} />
                    )}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </TableWrap>
      {canView && totalPages > 1 && (
        <div className="card-body">
          <Pager page={page} total={totalPages} onPage={setPage} />
        </div>
      )}

      <Dialog
        open={pending !== null}
        onClose={close}
        title={r ? (pending!.kind === 'approve' ? `Approve refund ${r.ref}` : pending!.kind === 'decline' ? `Send back refund ${r.ref}` : `Revise refund ${r.ref}`) : ''}
        foot={
          <>
            <Button variant="ghost" onClick={close} disabled={busy}>
              Cancel
            </Button>
            <Button icon={pending?.kind === 'approve' ? 'check' : undefined} variant={pending?.kind === 'decline' ? 'danger-soft' : undefined} onClick={submit} disabled={busy}>
              {pending?.kind === 'approve' ? 'Approve and send' : pending?.kind === 'decline' ? 'Send back' : 'Resubmit for approval'}
            </Button>
          </>
        }
      >
        {r && (
          <>
            <p className="small sub">
              {r.customerName} · {SOURCE_LABEL[r.source]}
            </p>
            <KeyValue pairs={pairs} />
            {pending!.kind === 'approve' && r.approval?.required && (
              <Alert tone="info" title="Approval in progress">
                {r.approval.reason ?? `Waiting for ${r.approval.approvers.join(' or ')}`}. Your approval counts if your refund limit covers the amount.
              </Alert>
            )}
            {pending!.kind === 'revise' && r.declineReason && (
              <Alert tone="warning" title="Why it was sent back">
                {r.declineReason}
              </Alert>
            )}
          </>
        )}
        {dialogError && (
          <Alert tone="danger" title="That didn’t work">
            {dialogError}
          </Alert>
        )}
        {pending?.kind === 'revise' && (
          <Field label="New refund amount" hint={max ? `Up to ${formatMoney(max)} can still be refunded for these items.` : undefined} error={amountError}>
            <TextInput id="fi-rf-amount" prefix="$" inputMode="decimal" value={amount} error={!!amountError} onChange={(e) => setAmount(e.target.value)} aria-required="true" />
          </Field>
        )}
        {pending && (
          <Field
            label={pending.kind === 'approve' ? 'Note for the record' : pending.kind === 'decline' ? 'Why it is sent back' : 'What changed and why'}
            optional={pending.kind === 'approve'}
            hint={pending.kind === 'approve' ? 'Shown in Action history with your name.' : pending.kind === 'decline' ? 'The Returns team reads it before revising the refund.' : 'Shown to the customer as the reason for a smaller refund, and to Finance.'}
            error={noteError}
          >
            <Textarea id="fi-rf-note" value={note} onChange={(e) => setNote(e.target.value)} aria-required={pending.kind !== 'approve'} />
          </Field>
        )}
        {pending?.kind === 'approve' && (
          <p className="ab-note">
            <Icon name="info" className="ic-sm" /> Above the password threshold you confirm with your password. Above your refund limit the refund goes on to an approver with a higher limit instead of being sent.
          </p>
        )}
      </Dialog>
      {stepUp.dialog}
    </>
  );
}
