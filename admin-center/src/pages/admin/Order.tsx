import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { call, errorMessage, newIdempotencyKey, useApi } from '@marketly/web-shared/api';
import { AdminLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { formatMoney, initials, isoInText, tileTint } from '@marketly/web-shared/lib/format';
import { useView } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import {
  Alert, Avatar, Badge, Button, Card, Checkbox, Deadline, Dialog, EmptyState, Field, Icon, Img, KeyValue, LogoTile, PageHeader, Select, StatusBadge, SummaryRow, TableWrap, Textarea, TextInput, announce,
  type TimelineEvent,
} from '@marketly/web-shared/ui';
import { useStaffSession } from '@/app/session';
import { LoadError, dateTime, deadlineTone, monthYear } from '@/app/parts';
import {
  ADMIN_ORDER, CANCELLABLE, CANCEL_REASONS, FUNDED_BY, REFUND_REASONS, defaultFunding, parseMinor, sum, toInput, toTimeline, usd, withinLimit,
  type Amt, type MyLimit, type OrderAdmin, type OrderGroup, type OrderItem, type SellerLabel,
} from './data/order';
import { isStepUpCancel, reauthField, useStepUp } from './data/step-up';

// Design: pages/admin/admin-order.html · view "issue-refund" = the refund dialog. Submitting sends one refund request
// per seller group (POST returns/refunds); within the staff member's refund limit it is approved at once (above the
// step-up threshold only after the password again: 403 STEP_UP_REQUIRED, retried with reauthToken), above the limit or
// without refund authority it stays under review with an access approval request and the page shows "sent for approval".
// Data: GraphQL AdminOrder(ref) (partial data allowed; `history` is the order timeline), GET access/me (my limits) and,
// only for holders of access.roles.view, access/approval-actions (the approver names); POST orders/orders/{id}/cancel-items,
// …/notes, POST messaging/conversations.

type View = 'issue-refund';
type Mode = 'refund' | 'cancel';

interface RefundForm {
  selected: Record<string, boolean>;
  amounts: Record<string, string>;
  reason: string;
  funding: string;
  note: string;
  notify: boolean;
}

const EMPTY_FORM: RefundForm = { selected: {}, amounts: {}, reason: '', funding: '', note: '', notify: true };
const money = (m?: Amt | null) => m?.formatted ?? formatMoney(m ?? { amount: 0, currency: 'USD' });

/** Timeline with the design's "At risk:" note on warning events (shared Timeline lacks it). */
function History({ events }: { events: TimelineEvent[] }) {
  return (
    <ol className="timeline">
      {events.map((e, i) => (
        <li key={i} className={cx('ev', e.state && `is-${e.state}`)}>
          {e.state === 'warn' && <span className="sr-only">At risk: </span>}
          <span className="dot" aria-hidden="true" />
          <div className="stack gap-1">
            <span className="t">{e.t}</span>
            {e.d && <span className="d">{typeof e.d === 'string' ? isoInText(e.d) : e.d}</span>}
            {e.body && <div className="small sub">{typeof e.body === 'string' ? isoInText(e.body) : e.body}</div>}
          </div>
        </li>
      ))}
    </ol>
  );
}

function SellerCell({ s }: { s: SellerLabel }) {
  return (
    <span className="row nowrap gap-2">
      <LogoTile initials={initials(s.name)} tint={tileTint(s.name)} size="sm" />
      <span className="stack gap-0">
        <span className="small strong nowrap">{s.name}</span>
        <span className="xs muted nowrap">{s.official ? 'Official Store' : 'Marketplace seller'}</span>
      </span>
    </span>
  );
}

const alertTone = (t: string) => (t.toLowerCase() === 'danger' ? 'danger' : t.toLowerCase() === 'warning' ? 'warning' : t.toLowerCase() === 'success' ? 'success' : 'info');

export default function Order() {
  const { ref = '' } = useParams();
  const { api, gql } = useApi();
  const qc = useQueryClient();
  const { accountId, can } = useStaffSession();
  const [view, setView] = useView<View>();
  const [mode, setMode] = useState<Mode>('refund');
  const [form, setForm] = useState<RefundForm>(EMPTY_FORM);
  const [attempted, setAttempted] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [notice, setNotice] = useState<{ tone: 'success' | 'warning'; title: string; body: string } | null>(null);
  const [draftNote, setDraftNote] = useState('');
  const [noteError, setNoteError] = useState('');
  const [contact, setContact] = useState<OrderGroup | null>(null);
  const keys = useRef<Record<string, string>>({});

  const q = useQuery({
    queryKey: ['orders', 'admin-order', ref],
    queryFn: async () => (await gql<{ orderAdmin: OrderAdmin | null }>(ADMIN_ORDER, { ref, historyPaging: { limit: 50 } }, 'AdminOrder')).data?.orderAdmin ?? null,
    enabled: !!ref,
  });
  const o = q.data ?? null;
  const me = useQuery({ queryKey: ['access', 'me', accountId], queryFn: () => call(api.GET('/api/admin/access/me')) });
  // approval-actions needs access.roles.view, which most refund staff don't have: ask only when it will answer, and treat
  // a refusal as "no names" (the route text falls back to my own limit's approvers).
  const actions = useQuery({
    queryKey: ['access', 'approval-actions'],
    queryFn: () => call(api.GET('/api/admin/access/approval-actions')),
    staleTime: 10 * 60_000,
    retry: false,
    enabled: view === 'issue-refund' && can('access.roles.view'),
  });
  const stepUp = useStepUp();

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['orders'] });
    void qc.invalidateQueries({ queryKey: ['returns'] });
    void qc.invalidateQueries({ queryKey: ['workqueues', 'queues'] });
  };

  // ----- Derived order data -----
  const groups = o?.groups ?? [];
  const items: Array<OrderItem & { group: OrderGroup }> = groups.flatMap((g) => g.items.map((it) => ({ ...it, group: g })));
  const itemById = new Map(items.map((it) => [it.id, it]));
  const refundRows = o?.refundable?.items ?? [];
  const refundRequests = o?.refundRequests ?? [];
  const pendingReq = refundRequests.filter((r) => r.status === 'requested' || r.status === 'under_review');
  const pending = sum(pendingReq.map((r) => r.breakdown?.total ?? usd(0)));
  const requestFor = (itemId: string) => pendingReq.find((r) => r.orderItemIds.includes(itemId));
  const canRefund = !!o?.allowedActions.includes('ISSUE_REFUND') && can('returns.exceptions.propose');
  const canCancel = !!o?.allowedActions.includes('CANCEL_ITEMS') && can('orders.orders.cancel');
  const canNote = can('orders.orders.manage');
  const canContact = !!o?.allowedActions.includes('CONTACT_SELLER') && can('messaging.conversations.participate');
  const cancellable = items.filter((it) => CANCELLABLE.has(it.state));
  const firstCase = o?.cases[0];

  // ----- Refund / cancel dialog -----
  const open = view === 'issue-refund';
  const rows = mode === 'cancel' ? cancellable.map((it) => ({ id: it.id, it, cap: it.paidAmount, blocked: null as string | null })) : refundRows.map((r) => ({ id: r.orderItemId, it: itemById.get(r.orderItemId), cap: r.remaining, blocked: r.blockedReason ?? (r.remaining.amount <= 0 ? 'Nothing left to refund for this item.' : requestFor(r.orderItemId) ? 'A refund for this item is already waiting for Finance.' : null) }));
  const chosen = rows.filter((r) => !r.blocked && form.selected[r.id]);
  const amountError = (r: (typeof rows)[number]) => {
    if (mode === 'cancel') return '';
    const v = parseMinor(form.amounts[r.id]);
    if (Number.isNaN(v) || v <= 0) return 'Enter an amount, like 34.65.';
    if (v > r.cap.amount) return `Enter ${money(r.cap)} or less. That's all that is still refundable for this item.`;
    return '';
  };
  const errors = {
    items: chosen.length === 0 ? (mode === 'cancel' ? 'Choose at least one item to cancel.' : 'Choose at least one item to refund.') : '',
    amounts: Object.fromEntries(chosen.map((r) => [r.id, amountError(r)])) as Record<string, string>,
    reason: !form.reason ? (mode === 'cancel' ? 'Choose a reason for this cancellation.' : 'Choose a reason for this refund.') : '',
    note: form.note.trim() ? '' : 'Add a note for the record. Finance reads it before approving.',
  };
  const nErrors = (errors.items ? 1 : 0) + Object.values(errors.amounts).filter(Boolean).length + (errors.reason ? 1 : 0) + (errors.note ? 1 : 0);
  const shown = attempted ? errors : { items: '', amounts: {} as Record<string, string>, reason: '', note: '' };
  const valid = chosen.filter((r) => !amountError(r));
  const refundTotal = mode === 'cancel' ? sum(valid.map((r) => r.cap)) : usd(valid.reduce((a, r) => a + parseMinor(form.amounts[r.id]), 0));
  const officialOnly = valid.length > 0 && valid.every((r) => r.it?.group.seller.official);

  // Effect per seller: the refunded share of the item price comes off earnings and fee; the platform-funded discount share goes back to its budget.
  const effect = Object.values(
    valid.reduce<Record<string, { seller: SellerLabel; refund: number; gross: number; fee: number; coupon: number }>>((acc, r) => {
      const it = r.it;
      if (!it) return acc;
      const amt = mode === 'cancel' ? r.cap.amount : parseMinor(form.amounts[r.id]);
      const paid = it.paidAmount.amount || 1;
      const ratio = amt / paid;
      const mbs = o?.moneyBySeller.find((m) => m.groupId === it.group.id);
      const feeRate = mbs?.marketplaceFee && mbs.items.amount ? mbs.marketplaceFee.amount / mbs.items.amount : 0;
      const row = (acc[it.group.id] ??= { seller: it.group.seller, refund: 0, gross: 0, fee: 0, coupon: 0 });
      row.refund += amt;
      row.gross += it.lineSubtotal.amount * ratio;
      row.fee += it.lineSubtotal.amount * ratio * feeRate;
      row.coupon += Math.max(0, it.lineSubtotal.amount - it.paidAmount.amount) * ratio;
      return acc;
    }, {}),
  );

  const refundLimits = ((me.data?.limits ?? []) as unknown as MyLimit[]).filter((l) => l.action.key === 'returns.refunds.approve');
  const refundAction = (actions.data as Array<{ key: string; approvers: string }> | undefined)?.find((a) => a.key === 'returns.refunds.approve');
  const approverNames = refundAction?.approvers ?? refundLimits[0]?.action.approvers ?? null;
  const inLimit = withinLimit(refundLimits, refundTotal.amount);

  const openDialog = (m: Mode, preselect?: string[]) => {
    const sel = Object.fromEntries((preselect ?? []).map((id) => [id, true]));
    const amounts = Object.fromEntries(refundRows.filter((r) => sel[r.orderItemId]).map((r) => [r.orderItemId, toInput(r.remaining.amount)]));
    setMode(m);
    setForm({ ...EMPTY_FORM, selected: sel, amounts, reason: m === 'cancel' ? 'overdue_dispatch' : '' });
    keys.current = {};
    setAttempted(false);
    setSubmitError('');
    setView('issue-refund');
  };
  const close = () => setView('');
  const setField = <K extends keyof RefundForm>(k: K, v: RefundForm[K]) => setForm((f) => ({ ...f, [k]: v }));
  const toggleItem = (id: string) => setForm((f) => ({ ...f, selected: { ...f.selected, [id]: !f.selected[id] } }));
  const setAmount = (id: string, v: string) => setForm((f) => ({ ...f, amounts: { ...f.amounts, [id]: v }, selected: v.trim() ? { ...f.selected, [id]: true } : f.selected }));
  const keyFor = (k: string) => (keys.current[k] ??= newIdempotencyKey());

  const submitRefund = useMutation({
    mutationFn: async () => {
      const byGroup = new Map<string, typeof valid>();
      for (const r of valid) if (r.it) byGroup.set(r.it.group.id, [...(byGroup.get(r.it.group.id) ?? []), r]);
      const results = [];
      for (const [gid, rs] of byGroup) {
        const official = rs[0].it!.group.seller.official;
        const body = {
          orderId: o!.id,
          items: rs.map((r) => ({ orderItemId: r.id, quantity: r.it!.quantity, amount: usd(parseMinor(form.amounts[r.id]), r.cap.currency) })),
          reasonCode: form.reason as 'other',
          reason: form.note.trim(),
          fundedBy: (form.funding || defaultFunding(official, form.reason)) as 'seller',
          destination: 'original_method' as const,
          note: form.note.trim(),
        };
        // Within my limit and above the step-up threshold the API asks for the password (403 STEP_UP_REQUIRED): the
        // retry carries reauthToken under the same Idempotency-Key (a refused try releases the key on the server).
        const res = await stepUp.run((token) =>
          call(api.POST('/api/admin/returns/refunds', { body: { ...body, ...reauthField(token) }, params: { header: { 'Idempotency-Key': keyFor(gid) } } })),
        );
        results.push(res);
      }
      return results;
    },
    onSuccess: (results) => {
      // The returned status decides the message: approved/processing/sent = within my limit and sent to payments;
      // requested/under_review = waiting for an approver (above my limit, or I have no refund authority).
      const waiting = results.filter((r) => r.status === 'requested' || r.status === 'under_review');
      const sent = results.filter((r) => !waiting.includes(r));
      const sentTotal = sum(sent.map((r) => r.breakdown?.total ?? usd(0)));
      const waitingTotal = sum(waiting.map((r) => r.breakdown?.total ?? usd(0)));
      const approval = waiting.find((r) => r.approval)?.approval;
      const approvers = approval?.approvers?.length ? approval.approvers.join(' or ') : approverNames;
      const title =
        waiting.length && sent.length
          ? `Refund of ${money(sentTotal)} approved and sent; ${money(waitingTotal)} sent for approval`
          : waiting.length
            ? `Refund of ${money(waitingTotal)} sent for approval`
            : `Refund of ${money(sentTotal)} approved and sent`;
      const sentText = sent.length ? `The money goes to ${o?.payment?.methodLabel ?? 'the original payment method'}; card refunds usually arrive 3–5 business days after we send them.` : '';
      const waitingText = waiting.length
        ? `${approval?.reason ? `${approval.reason}.` : 'It is above your refund limit.'} ${approvers ? `${approvers} approves it` : 'An approver with a higher refund limit approves it'} in Finance › Refunds to approve or their Inbox. The customer sees "Refund requested" until it is sent; approval is not money arrived.`
        : '';
      const body = [waitingText, sentText].filter(Boolean).join(' ');
      setNotice({ tone: waiting.length ? 'warning' : 'success', title, body });
      announce(title);
      refresh();
      close();
    },
    onError: (e) => {
      // Closing the password prompt leaves the dialog as it was, without an error. Refresh anyway: with several sellers
      // an earlier group's refund may already exist (its items then show as waiting, and a resubmit replays its key).
      if (isStepUpCancel(e)) refresh();
      else setSubmitError(errorMessage(e));
    },
  });

  const submitCancel = useMutation({
    mutationFn: () =>
      call(
        api.POST('/api/admin/orders/orders/{id}/cancel-items', {
          params: { path: { id: o!.id }, header: { 'Idempotency-Key': keyFor('cancel') } },
          body: { items: valid.map((r) => ({ itemId: r.id, quantity: r.it!.quantity })), reasonCode: form.reason as 'other', reason: form.note.trim(), notifyCustomer: form.notify },
        }),
      ),
    onSuccess: () => {
      const title = `${valid.length} item${valid.length === 1 ? '' : 's'} cancelled`;
      setNotice({ tone: 'success', title, body: 'The refund for the cancelled items follows the cancellation policy and shows under Cancellations and refunds.' });
      announce(title);
      refresh();
      close();
    },
    onError: (e) => setSubmitError(errorMessage(e)),
  });

  const submit = () => {
    setAttempted(true);
    if (nErrors) return;
    setSubmitError('');
    if (mode === 'cancel') submitCancel.mutate();
    else submitRefund.mutate();
  };
  const busy = submitRefund.isPending || submitCancel.isPending;

  // ----- Notes -----
  const addNote = useMutation({
    mutationFn: () => call(api.POST('/api/admin/orders/orders/{id}/notes', { params: { path: { id: o!.id } }, body: { text: draftNote.trim() } })),
    onSuccess: () => {
      setDraftNote('');
      setNoteError('');
      announce('Note saved');
      void qc.invalidateQueries({ queryKey: ['orders', 'admin-order', ref] });
    },
    onError: (e) => setNoteError(errorMessage(e)),
  });
  const saveNote = () => {
    if (!draftNote.trim()) {
      setNoteError('Write a note before saving.');
      return;
    }
    addNote.mutate();
  };

  // ----- Loading / not found -----
  if (q.isPending || q.isError || !o) {
    return (
      <AdminLayout active="orders">
        <PageHeader crumbs={[{ label: 'Commerce' }, { label: 'Orders', to: href('admin/orders') }, { label: ref }]} title={<>Order <span className="mono">{ref}</span></>} />
        {q.isPending ? (
          <div className="aa-split">
            <div className="stack gap-5">
              <div className="sk sk-card" style={{ height: 240 }} aria-hidden="true" />
              <div className="sk sk-card" style={{ height: 180 }} aria-hidden="true" />
            </div>
            <div className="stack gap-5">
              <div className="sk sk-card" style={{ height: 200 }} aria-hidden="true" />
            </div>
          </div>
        ) : q.isError ? (
          <LoadError error={q.error} onRetry={() => void q.refetch()} />
        ) : (
          <EmptyState icon="search-x" title="We couldn’t find this order" as="h2" action={<Button variant="secondary" size="sm" to={href('admin/orders')}>Back to orders</Button>}>
            No order has the reference {ref}. Check the reference and try again.
          </EmptyState>
        )}
      </AdminLayout>
    );
  }

  const t = o.totals;
  const pay = o.payment;
  const events = toTimeline(o.history ?? [], (iso) => dateTime(iso));
  const fundingTotals = o.moneyBySeller;

  return (
    <AdminLayout active="orders">
      <PageHeader
        crumbs={[{ label: 'Commerce' }, { label: 'Orders', to: href('admin/orders') }, { label: o.ref }]}
        title={
          <>
            Order <span className="mono">{o.ref}</span>
          </>
        }
        sub={
          <>
            Placed {dateTime(o.placedAt)} PT · {o.sellerCount} seller{o.sellerCount === 1 ? '' : 's'} · {o.packageCount} package{o.packageCount === 1 ? '' : 's'} · <StatusBadge status={o.statusLabel} /> {pay && <StatusBadge status={pay.stateLabel} />}
          </>
        }
        actions={
          <>
            {canCancel && (
              <Button variant="secondary" size="sm" icon="circle-x" onClick={() => openDialog('cancel')} disabled={!cancellable.length}>
                Cancel items
              </Button>
            )}
            {canRefund && (
              <Button variant="secondary" size="sm" icon="undo-2" onClick={() => openDialog('refund')}>
                Issue refund
              </Button>
            )}
            {canContact && groups.some((g) => !g.seller.official && g.seller.id) && (
              <Button variant="secondary" size="sm" icon="message-square" onClick={() => setContact(groups.find((g) => !g.seller.official && g.seller.id) ?? null)}>
                Contact seller
              </Button>
            )}
            <Button size="sm" icon="life-buoy" to={firstCase ? href('admin/case', '', { ref: firstCase.ref }) : href('admin/cases')}>
              {firstCase ? 'Open case' : 'Cases'}
            </Button>
          </>
        }
      />
      {!canRefund && !canCancel && (o.allowedActions.includes('ISSUE_REFUND') || o.allowedActions.includes('CANCEL_ITEMS')) && (
        <p className="xs muted">Refunds and cancellations need the Returns or Order Manager role. Ask a colleague who has it.</p>
      )}
      {notice && (
        <Alert tone={notice.tone} title={notice.title}>
          {notice.body}
        </Alert>
      )}
      {o.alerts.map((a, i) => (
        <Alert key={i} tone={alertTone(a.tone)} title={a.title}>
          {a.message}
        </Alert>
      ))}
      <div className="aa-split">
        <div className="stack gap-5">
          {groups.map((g, gi) => {
            const s = g.seller;
            const ship = g.shipments[0];
            const unshipped = !g.shipments.length;
            const groupCancellable = g.items.filter((it) => CANCELLABLE.has(it.state)).map((it) => it.id);
            return (
              <Card
                key={g.id}
                titleAs={gi === 0 ? 'h2' : 'h3'}
                title={
                  <span className="row gap-2">
                    <LogoTile initials={initials(s.name)} tint={tileTint(s.name)} size="sm" />
                    <span>{!s.official && s.slug && can('sellers.accounts.view') ? <Link to={href('admin/seller', '', { slug: s.slug })}>{s.name}</Link> : s.name}</span>
                    {s.official ? (
                      <Badge tone="brand" icon="badge-check">
                        Official
                      </Badge>
                    ) : s.verified ? (
                      <Badge tone="info" icon="shield-check">
                        Verified
                      </Badge>
                    ) : null}
                  </span>
                }
                sub={`${g.packageLabel} · ${g.fulfilledBy === 'SELLER' ? 'Seller ships' : 'Shipped by Marketly warehouse'} · ${g.shipsFrom}${g.totals ? ` · items ${money(g.totals.items)}` : ''}`}
                actions={<StatusBadge status={g.statusLabel} />}
                foot={
                  ship?.trackingUrl ? (
                    <Button variant="ghost" size="sm" icon="history" href={ship.trackingUrl}>
                      Shipment history
                    </Button>
                  ) : unshipped && (canContact || (canCancel && groupCancellable.length)) ? (
                    <>
                      {canContact && !s.official && s.id && (
                        <Button variant="secondary" size="sm" icon="message-square" onClick={() => setContact(g)}>
                          Contact seller
                        </Button>
                      )}
                      {canCancel && groupCancellable.length > 0 && (
                        <Button variant="danger-soft" size="sm" icon="circle-x" onClick={() => openDialog('cancel', groupCancellable)}>
                          Cancel item
                        </Button>
                      )}
                    </>
                  ) : undefined
                }
              >
                {g.alert && (
                  <Alert tone={alertTone(g.alert.tone)} title={g.alert.title}>
                    {g.alert.message}
                  </Alert>
                )}
                {g.items.map((it) => {
                  const req = requestFor(it.id);
                  const as = it.afterSales;
                  return (
                    <div key={it.id} className="aa-item">
                      <Img icon="package" src={it.image?.url} alt={it.image?.alt ?? ''} />
                      <div className="stack gap-1">
                        <span className="small strong">{it.title}</span>
                        <span className="xs muted">
                          {it.variantLabel}
                          {it.offerTerms?.sellerSku && (
                            <>
                              {' '}
                              · SKU <span className="mono">{it.offerTerms.sellerSku}</span>
                            </>
                          )}{' '}
                          · Qty {it.quantity} · {money(it.unitPrice)} each
                        </span>
                        <div className="aa-item-r">
                          <span className="row gap-2">
                            <StatusBadge status={it.stateLabel} />
                            {req ? (
                              <>
                                <span className="xs muted">Refund</span>
                                <StatusBadge status="Requested" />
                              </>
                            ) : (
                              as?.refundStatus &&
                              as.refundStatus !== 'NONE' && (
                                <>
                                  <span className="xs muted">Refund</span>
                                  <StatusBadge status={as.refundStatus.charAt(0) + as.refundStatus.slice(1).toLowerCase().replace(/_/g, ' ')} />
                                </>
                              )
                            )}
                          </span>
                          <span className="small num">
                            <span className="muted xs">Paid after discounts </span>
                            <b>{money(it.paidAmount)}</b>
                          </span>
                        </div>
                        <span className="xs sub">{req ? `Refund of ${money(req.breakdown?.total)} requested · waiting for Finance approval` : it.stateNote}</span>
                      </div>
                    </div>
                  );
                })}
                <div className="aa-ship">
                  <Icon name="truck" className="ic-sm" />
                  <span className="strong">{ship ? (ship.serviceName ?? ship.carrierName) : 'No shipment yet'}</span>
                  {ship?.trackingNumber ? <span className="mono">{ship.trackingNumber}</span> : <span className="muted">No tracking number</span>}
                  <span className="muted">{ship ? (ship.deliveredAt ? `Delivered ${dateTime(ship.deliveredAt)}` : ship.estimateLabel) : g.estimateLabel}</span>
                  <span className="grow" />
                  {g.deadlineLabel && <Deadline tone={g.dispatchResult || g.status === 'CANCELLED' ? 'ok' : deadlineTone(g.dispatchDeadline?.state)}>{g.deadlineLabel}</Deadline>}
                </div>
              </Card>
            );
          })}

          <Card titleAs="h3" title="Cancellations and refunds" sub={pending.amount ? `Tracked per item · ${money(pending)} waiting for Finance approval` : t?.refundedSoFar.amount ? `Tracked per item · ${money(t.refundedSoFar)} refunded` : 'Tracked per item · nothing refunded yet'} flush>
            {o.afterSales.length === 0 ? (
              <div className="card-body">
                <p className="small muted">No cancellations, returns or refunds on this order.</p>
              </div>
            ) : (
              <TableWrap label="Cancellations and refunds table">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Item</th>
                      <th scope="col">Seller</th>
                      <th scope="col">Request</th>
                      <th className="r" scope="col">Amount</th>
                      <th scope="col">Status</th>
                      <th className="col-pin" scope="col">Owner</th>
                    </tr>
                  </thead>
                  <tbody>
                    {o.afterSales.map((a, i) => {
                      const it = itemById.get(a.itemId);
                      const req = requestFor(a.itemId);
                      const ret = o.returns.find((r) => r.items.some((x) => x.orderItemId === a.itemId));
                      const edge = !req && ret?.nextDeadline ? deadlineTone(ret.nextDeadline.state) : 'ok';
                      return (
                        <tr key={`${a.itemId}-${i}`} className={edge === 'danger' ? 'is-flagged' : edge === 'warning' ? 'is-warn' : ''}>
                          <td>
                            {edge !== 'ok' && <span className="sr-only">{edge === 'danger' ? 'Urgent: ' : 'At risk: '}</span>}
                            <span className="row nowrap gap-2">
                              <Img icon="package" src={it?.image?.url} alt="" className="tiny" />
                              <span className="small">{a.title}</span>
                            </span>
                          </td>
                          <td>{a.sellerName}</td>
                          <td>
                            {req ? (
                              <>
                                Refund requested
                                <br />
                                <span className="xs muted">Waiting for Finance{req.approvalRequest ? ` · ${req.approvalRequest.ref}` : ''}</span>
                              </>
                            ) : ret ? (
                              <>
                                Return{' '}
                                <Link className="mono nowrap" to={href('admin/returns')} title={ret.ref}>
                                  {ret.ref}
                                </Link>
                              </>
                            ) : (
                              a.request
                            )}
                          </td>
                          <td className="r">{req ? money(req.breakdown?.total) : a.amount ? money(a.amount) : <span className="muted">—</span>}</td>
                          <td>
                            <span className="stack gap-1">
                              {it && <StatusBadge status={it.stateLabel} />}
                              {req ? <StatusBadge status="Refund requested" tone="info" /> : <span className="xs muted">{a.status}</span>}
                            </span>
                          </td>
                          <td className="col-pin">{a.owner ?? <span className="muted">—</span>}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </TableWrap>
            )}
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
          </Card>

          <Card titleAs="h3" title="Coupon funding and money by seller" sub={t && t.discounts.length ? `${t.discounts.map((d) => d.code ?? d.label).join(', ')} · −${money(t.discountTotal)} · allocated by item value` : 'No discounts on this order'} flush>
            <TableWrap label="Coupon funding and money by seller table">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Seller group</th>
                    <th className="r" scope="col">Items</th>
                    <th className="r" scope="col">Platform-funded</th>
                    <th className="r" scope="col">Seller-funded</th>
                    <th className="r" scope="col">Customer paid</th>
                    <th className="r" scope="col">Marketplace fee</th>
                    <th className="r col-pin" scope="col">Seller earnings</th>
                  </tr>
                </thead>
                <tbody>
                  {fundingTotals.map((f) => (
                    <tr key={f.groupId}>
                      <td>
                        <SellerCell s={f.seller} />
                      </td>
                      <td className="r">{money(f.items)}</td>
                      <td className="r">{money(f.platformFunded)}</td>
                      <td className="r">{money(f.sellerFunded)}</td>
                      <td className="r">{money(f.customerPaid)}</td>
                      <td className="r">{f.companySale || !f.marketplaceFee ? <span className="muted">—</span> : money(f.marketplaceFee)}</td>
                      <td className="r col-pin">{f.companySale || !f.sellerEarnings ? <span className="xs muted">Company sales</span> : money(f.sellerEarnings)}</td>
                    </tr>
                  ))}
                  <tr>
                    <td>
                      <span className="strong">Order</span>
                    </td>
                    {[
                      sum(fundingTotals.map((f) => f.items)),
                      sum(fundingTotals.map((f) => f.platformFunded)),
                      sum(fundingTotals.map((f) => f.sellerFunded)),
                      sum(fundingTotals.map((f) => f.customerPaid)),
                      sum(fundingTotals.map((f) => (f.companySale ? usd(0) : (f.marketplaceFee ?? usd(0))))),
                    ].map((v, i) => (
                      <td key={i} className="r">
                        <span className="strong">{money(v)}</span>
                      </td>
                    ))}
                    <td className="r col-pin">
                      <span className="strong">{money(sum(fundingTotals.map((f) => (f.companySale ? usd(0) : (f.sellerEarnings ?? usd(0))))))}</span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </TableWrap>
            <div className="card-body u-pt-0">
              <span className="xs muted">{o.couponFundingNote ?? 'Seller-funded markdowns are already in the item price. Marketplace fees are charged on item price after seller-funded discounts, excluding shipping. Final fees are in the seller agreement.'}</span>
            </div>
          </Card>

          <Card
            titleAs="h3"
            title="Action history"
            sub="Every change with staff name and reason"
            actions={
              can('audit.entries.view') ? (
                <Link className="small strong" to={href('admin/audit')}>
                  Full log
                </Link>
              ) : undefined
            }
          >
            {events.length ? <History events={events} /> : <p className="small muted">No history yet.</p>}
          </Card>
        </div>

        <div className="stack gap-5">
          <Card
            titleAs="h3"
            title="Customer"
            actions={
              o.customer?.customerId ? (
                <Link className="small strong" to={href('admin/customers', 'customer-detail', undefined, { id: o.customer.customerId })}>
                  Profile
                </Link>
              ) : undefined
            }
          >
            {o.customer ? (
              <>
                <div className="row gap-3">
                  <Avatar name={o.customer.name} />
                  <div className="stack gap-0">
                    <span className="strong">{o.customer.name}</span>
                    <span className="xs muted">
                      {o.customer.guest ? 'Guest checkout' : [o.customer.customerSince && `Customer since ${monthYear(o.customer.customerSince)}`, o.customer.orderCount != null && `${o.customer.orderCount} orders`].filter(Boolean).join(' · ')}
                    </span>
                  </div>
                </div>
                <KeyValue
                  pairs={[
                    ['Email', o.customer.email ?? '—'],
                    ['Phone', o.customer.phone ?? '—'],
                    ['Ship to', o.deliveryAddress ? `${o.deliveryAddress.line1}${o.deliveryAddress.line2 ? `, ${o.deliveryAddress.line2}` : ''}, ${o.deliveryAddress.city}, ${o.deliveryAddress.region} ${o.deliveryAddress.postalCode}` : '—'],
                    [
                      'Open cases',
                      o.cases.length ? (
                        <span key="c" className="stack gap-0">
                          {o.cases.map((c) => (
                            <Link key={c.id} to={href('admin/case', '', { ref: c.ref })} className="mono">
                              {c.ref}
                            </Link>
                          ))}
                        </span>
                      ) : (
                        'None'
                      ),
                    ],
                  ]}
                />
              </>
            ) : (
              <p className="small muted">Customer details are not available.</p>
            )}
          </Card>

          <Card titleAs="h3" title="Payment" actions={pay ? <StatusBadge status={pay.stateLabel} /> : undefined}>
            {pay && (
              <KeyValue
                pairs={[
                  ['Method', pay.methodLabel ?? '—'],
                  ['Authorized', pay.authorizedAt ? dateTime(pay.authorizedAt) : '—'],
                  ['Captured', pay.capturedAt ? dateTime(pay.capturedAt) : '—'],
                  ['Processor ref', <span key="r" className="mono">{pay.providerRef ?? '—'}</span>],
                ]}
              />
            )}
            {t && (
              <div className="stack gap-2">
                <SummaryRow k="Items" v={money(t.items)} />
                {t.discounts.map((d, i) => (
                  <SummaryRow key={i} k={d.code ? `Coupon ${d.code}` : d.label} v={`−${money(d.amount)}`} className="discount" />
                ))}
                <SummaryRow k={t.shippingLabel ?? 'Shipping'} v={t.shippingTotal.amount ? money(t.shippingTotal) : 'Free'} />
                <SummaryRow k={t.taxLabel ?? 'Sales tax'} v={money(t.tax)} />
                <SummaryRow k="Captured" v={money(pay?.capturedAmount ?? t.total)} className="total" />
                {pending.amount > 0 && <SummaryRow k="Refund requested" v={money(pending)} />}
                <SummaryRow k="Refunded" v={money(t.refundedSoFar)} />
              </div>
            )}
          </Card>

          <Card titleAs="h3" title="Internal notes" sub="Staff only · never shown to customer or sellers">
            {o.notes.length === 0 && <p className="small muted">No notes yet.</p>}
            {o.notes.map((n) => (
              <div key={n.id} className="aa-note">
                <span className="row between xs">
                  <b>{n.author?.name ?? 'Staff'}</b>
                  <span className="muted">{dateTime(n.at)}</span>
                </span>
                <span>{isoInText(n.text)}</span>
              </div>
            ))}
            {canNote ? (
              <>
                <Field label="Add a note" error={noteError}>
                  <Textarea id="aa-od-note" placeholder="Write a note for the team" value={draftNote} onChange={(e) => (setDraftNote(e.target.value), noteError && setNoteError(''))} />
                </Field>
                <Button variant="secondary" size="sm" onClick={saveNote} disabled={addNote.isPending}>
                  Save note
                </Button>
              </>
            ) : (
              <span className="xs muted">Adding notes needs the order management permission.</span>
            )}
          </Card>
        </div>
      </div>

      <Dialog
        open={open && (mode === 'cancel' ? canCancel : canRefund)}
        onClose={close}
        size="lg"
        title={`${mode === 'cancel' ? 'Cancel items' : 'Issue refund'} · ${o.ref}`}
        foot={
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            {mode === 'cancel' ? (
              <Button variant="danger" icon="circle-x" onClick={submit} disabled={busy}>
                Cancel {valid.length || ''} item{valid.length === 1 ? '' : 's'}
              </Button>
            ) : (
              <Button icon="send" onClick={submit} disabled={busy}>
                {inLimit ? `Refund ${money(refundTotal)}` : `Send ${money(refundTotal)} to Finance for approval`}
              </Button>
            )}
          </>
        }
      >
        <div className="row between small">
          <span className="sub">
            Customer paid {money(o.refundable?.captured ?? t?.total)} · refunded so far {money(o.refundable?.refunded)}
            {pending.amount > 0 && ` · ${money(pending)} waiting for Finance`}
          </span>
          <span className="strong">Remaining refundable {money(o.refundable?.remaining)}</span>
        </div>
        {submitError && (
          <Alert tone="danger" title="That didn’t work">
            {submitError}
          </Alert>
        )}
        {attempted && nErrors > 0 && (
          <Alert tone="danger" title={`Check ${nErrors} field${nErrors > 1 ? 's' : ''}`}>
            {errors.items || (mode === 'cancel' ? 'Fix the highlighted fields to cancel these items.' : 'Fix the highlighted fields to send this refund.')}
          </Alert>
        )}
        <div className="stack gap-2">
          <span className="label">{mode === 'cancel' ? 'Items not shipped yet' : 'Items and amounts'}</span>
          {rows.length === 0 && <span className="xs muted">{mode === 'cancel' ? 'Every item has shipped or is already cancelled.' : 'Nothing on this order can be refunded.'}</span>}
          {rows.map((r) => {
            const it = r.it;
            const disabled = !!r.blocked;
            const on = !disabled && !!form.selected[r.id];
            return (
              <div key={r.id} className={cx('aa-rf', on && 'is-selected', disabled && 'is-disabled')}>
                <div className="row nowrap top gap-3">
                  <input type="checkbox" id={`aa-rf-${r.id}`} aria-label={`${mode === 'cancel' ? 'Cancel' : 'Refund'} ${it?.title ?? ''}`} className="check-input" checked={on} disabled={disabled} onChange={() => toggleItem(r.id)} />
                  <Img icon="package" src={it?.image?.url} alt="" className="tiny" />
                  <label className="stack gap-0" htmlFor={`aa-rf-${r.id}`}>
                    <span className="small strong">{it?.title}</span>
                    <span className="xs muted">
                      {it?.group.seller.name} · {it?.variantLabel} · {it && <StatusBadge status={it.stateLabel} />}
                    </span>
                    {r.blocked ? <span className="xs t-warning-text strong">{r.blocked}</span> : <span className="xs sub">{it?.stateNote ?? (mode === 'cancel' ? 'Not shipped · cancelling also refunds it under the cancellation policy' : '')}</span>}
                  </label>
                </div>
                {mode === 'cancel' ? (
                  <span className="xs muted">Qty {it?.quantity} · paid {money(r.cap)}</span>
                ) : disabled ? (
                  <span className="xs muted">Refundable remaining {money(r.cap)}</span>
                ) : (
                  <Field
                    label={
                      <>
                        Amount <span className="xs muted">· up to {money(r.cap)}</span>
                      </>
                    }
                    error={on ? shown.amounts[r.id] : undefined}
                  >
                    <TextInput id={`aa-rf-amt-${r.id}`} prefix="$" inputMode="decimal" value={form.amounts[r.id] ?? ''} error={on && !!shown.amounts[r.id]} onChange={(e) => setAmount(r.id, e.target.value)} />
                  </Field>
                )}
              </div>
            );
          })}
          {shown.items && (
            <span className="error-text">
              <Icon name="circle-alert" className="ic-sm" />
              {shown.items}
            </span>
          )}
        </div>
        {mode === 'refund' && (
          <Alert tone="info" title="Over-refund check">
            Amounts are capped at what is still refundable per item, after discounts and earlier refunds. Items of different sellers are sent as one refund request per seller.
          </Alert>
        )}
        <div className="grid md2 gap-3">
          <Field label="Reason" hint={shown.reason ? undefined : 'Each item keeps its own reason in the record.'} error={shown.reason}>
            <Select id="aa-rf-reason" options={mode === 'cancel' ? CANCEL_REASONS : REFUND_REASONS} value={form.reason} onChange={(e) => setField('reason', e.target.value)} />
          </Field>
          {mode === 'refund' ? (
            <Field label="Refund to" hint="Card refunds usually arrive 3–5 business days after we send them.">
              <Select id="aa-rf-dest" options={[{ value: 'original_method', label: `Original payment${pay?.methodLabel ? ` · ${pay.methodLabel}` : ''}` }]} value="original_method" onChange={() => undefined} />
            </Field>
          ) : (
            <Field label="Customer">
              <Checkbox id="aa-rf-notify" label="Tell the customer" checked={form.notify} onChange={(e) => setField('notify', e.target.checked)} />
            </Field>
          )}
          {mode === 'refund' && !officialOnly && (
            <Field label="Paid by" hint="Who carries the refund. Official Store items are always paid by the Official Store.">
              <Select id="aa-rf-fund" options={FUNDED_BY.filter((f) => f.value !== 'official_store')} value={form.funding || defaultFunding(false, form.reason)} onChange={(e) => setField('funding', e.target.value)} />
            </Field>
          )}
        </div>
        <Field label="Note for the record" hint="Required. Shown in Action history and to Finance." error={shown.note}>
          <Textarea id="aa-rf-note" placeholder="" value={form.note} onChange={(e) => setField('note', e.target.value)} />
        </Field>
        <div className="stack gap-2">
          <span className="label">Effect on seller earnings and fees</span>
          <TableWrap label={`${mode === 'cancel' ? 'Cancel items' : 'Issue refund'} · ${o.ref} table`}>
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Seller</th>
                  <th className="r" scope="col">Refund</th>
                  <th className="r" scope="col">Seller earnings</th>
                  <th className="r" scope="col">Marketplace fee</th>
                  <th className="r col-pin" scope="col">Coupon (platform-funded)</th>
                </tr>
              </thead>
              <tbody>
                {effect.length === 0 ? (
                  <tr>
                    <td colSpan={5}>
                      <span className="xs muted">Choose items and amounts to see the effect.</span>
                    </td>
                  </tr>
                ) : (
                  effect.map((e) => (
                    <tr key={e.seller.id ?? e.seller.name}>
                      <td>
                        <SellerCell s={e.seller} />
                      </td>
                      <td className="r">{money(usd(e.refund))}</td>
                      <td className="r">{e.seller.official ? <span className="xs muted">Company sales −{money(usd(e.gross))}</span> : `−${money(usd(e.gross - e.fee))}`}</td>
                      <td className="r">{e.seller.official ? <span className="muted">Not charged</span> : `−${money(usd(e.fee))} reversed`}</td>
                      <td className="r col-pin">{money(usd(e.coupon))}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </TableWrap>
          <span className="xs muted">Estimate from this order's fees. The final amounts are booked when the refund is sent. Platform-funded discount shares go back to their budget and are never charged to sellers.</span>
        </div>
        {mode === 'refund' && (
          <div className="well stack gap-2">
            <div className="row between">
              <span className="strong">Refund total</span>
              <span className="h3 num">{money(refundTotal)}</span>
            </div>
            <SummaryRow k="Approval route" v={inLimit ? 'Within your limit · approved when you send it' : (approverNames ?? 'Finance approval')} />
            <SummaryRow k="Your refund authority" v={refundLimits.length ? refundLimits.map((l) => `${l.summary} · ${l.role.name}`).join('; ') : `None${me.data?.roles?.[0] ? ` · ${me.data.roles[0].name} role` : ''}`} />
            <span className="xs muted">The customer sees "Refund requested" until Finance sends it; approval is not money arrived.</span>
          </div>
        )}
      </Dialog>

      {stepUp.dialog}
      <ContactDialog group={contact} orderId={o.id} orderRef={o.ref} onClose={() => setContact(null)} />
    </AdminLayout>
  );
}

/** Contact seller: a staff conversation about this order (POST messaging/conversations). */
function ContactDialog({ group, orderId, orderRef, onClose }: { group: OrderGroup | null; orderId: string; orderRef: string; onClose: () => void }) {
  const { api } = useApi();
  const [body, setBody] = useState('');
  const [err, setErr] = useState('');
  const send = useMutation({
    mutationFn: () =>
      call(
        api.POST('/api/admin/messaging/conversations', {
          body: { sellerId: group!.seller.id, orderId, orderItemIds: group!.items.map((i) => i.id), subject: `Order ${orderRef}`, body: body.trim() },
        }),
      ),
    onSuccess: () => {
      announce(`Message sent to ${group?.seller.name}`);
      setBody('');
      onClose();
    },
    onError: (e) => setErr(errorMessage(e)),
  });
  return (
    <Dialog
      open={!!group}
      onClose={onClose}
      title={`Message ${group?.seller.name ?? 'the seller'}`}
      foot={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button icon="send" disabled={body.trim().length < 2 || send.isPending} onClick={() => send.mutate()}>
            Send
          </Button>
        </>
      }
    >
      {err && <Alert tone="danger" title={err} />}
      <Field label="Message" hint={`About order ${orderRef}. The seller replies in their Seller Center messages.`}>
        <Textarea id="aa-contact" rows={4} value={body} onChange={(e) => setBody(e.target.value)} />
      </Field>
    </Dialog>
  );
}
