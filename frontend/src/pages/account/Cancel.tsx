import { useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams, useSearchParams } from 'react-router';
import { ApiError, call, errorMessage, newIdempotencyKey, useApi } from '@marketly/web-shared/api';
import { AccountLayout } from '@/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { formatMoney } from '@marketly/web-shared/lib/format';
import { useView } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import { Alert, Breadcrumbs, Button, Card, Field, Img, Select, StatusBadge, SummaryRow, Textarea, Timeline, type TimelineEvent } from '@marketly/web-shared/ui';
import { fmtDateTime, humanize, orderHref, productHref, refundTone, returnHref, stateTone, useOrderDetail, type Cancellation, type OrderDetail, type OrderGroup } from './data/orders';
import { DetailSkeleton, LoadError, NotFoundCard, SellerLineApi, SkeletonRows } from './data/order-parts';

// Design: pages/store/account-cancel.html · view "cancellation-requested" = after "Request cancellation"
// (shows the order's open cancellation requests from OrderDetail). Data: OrderDetail (ref → id, items,
// cancellations), GET orders/orders/{id}/cancellation-options (eligibility, alternatives, refund per
// line), POST …/cancellation-preview (refund preview), POST …/cancellations with an Idempotency-Key.

type ReasonCode = 'changed_mind' | 'ordered_by_mistake' | 'found_better_price' | 'delivery_too_slow' | 'other';
const REASONS: Array<{ value: ReasonCode | ''; label: string }> = [
  { value: '', label: 'Choose a reason' },
  { value: 'delivery_too_slow', label: "It's taking too long to arrive" },
  { value: 'ordered_by_mistake', label: 'I ordered by mistake' },
  { value: 'found_better_price', label: 'I found a better price' },
  { value: 'changed_mind', label: 'I no longer need it' },
  { value: 'other', label: 'Other' },
];


/** Specific copy for the cancellation error codes (orders.md). */
function cancelError(e: unknown) {
  if (e instanceof ApiError) {
    if (e.code === 'CANCELLATION_NOT_ALLOWED') return 'One of these items can no longer be cancelled. It may have shipped. Reload the page to see what you can cancel now.';
    if (e.code === 'QUANTITY_EXCEEDS_REMAINING') return 'Some of these items were already cancelled. Reload the page to see what is left.';
    if (e.code === 'CANCELLATION_ALREADY_REQUESTED') return 'You already asked to cancel one of these items. The seller is looking at it.';
  }
  return errorMessage(e);
}

export default function Cancel() {
  const { ref = '' } = useParams();
  const q = useOrderDetail(ref);
  const order = q.data;
  const crumbs = <Breadcrumbs items={[{ label: 'Orders', to: href('account/orders') }, { label: ref, to: orderHref(ref) }, { label: 'Cancel items' }]} />;

  if (q.isPending || q.isError || !order) {
    return (
      <AccountLayout active="orders" title="Cancel items">
        {crumbs}
        {q.isPending ? (
          <DetailSkeleton cards={2} />
        ) : q.isError ? (
          <LoadError error={q.error} onRetry={() => void q.refetch()} />
        ) : (
          <NotFoundCard title={`We couldn't find order ${ref}`}>Check the order number in your confirmation email.</NotFoundCard>
        )}
      </AccountLayout>
    );
  }
  return <CancelForm order={order} crumbs={crumbs} />;
}

function CancelForm({ order, crumbs }: { order: OrderDetail; crumbs: ReactNode }) {
  const { api } = useApi();
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const [view, setView] = useView<'cancellation-requested'>();
  const [requestedIds, setRequestedIds] = useState<string[] | null>(null);
  const opts = useQuery({
    queryKey: ['orders', 'cancellation-options', order.id],
    queryFn: () => call(api.GET('/api/store/orders/orders/{id}/cancellation-options', { params: { path: { id: order.id } } })),
    enabled: view !== 'cancellation-requested',
  });
  const items = opts.data?.items ?? [];
  const eligible = items.filter((i) => i.eligible && i.maxQuantity > 0);
  const [picked, setPicked] = useState<string[] | null>(null);
  const preselect = params.get('item');
  const selected = picked ?? (preselect ? [preselect] : eligible[0] ? [eligible[0].itemId] : []);
  const chosen = eligible.filter((i) => selected.includes(i.itemId));
  const lines = chosen.map((i) => ({ itemId: i.itemId, quantity: i.maxQuantity }));
  const [reason, setReason] = useState<ReasonCode | ''>('');
  const [note, setNote] = useState('');
  const [attempted, setAttempted] = useState(false);
  const attemptRef = useRef<{ body: string; key: string } | null>(null);

  const preview = useQuery({
    queryKey: ['orders', 'cancellation-preview', order.id, lines],
    queryFn: () => call(api.POST('/api/store/orders/orders/{id}/cancellation-preview', { params: { path: { id: order.id } }, body: { items: lines } })),
    enabled: lines.length > 0 && view !== 'cancellation-requested',
    placeholderData: (prev) => (lines.length ? prev : undefined),
  });

  const submit = useMutation({
    mutationFn: () => {
      const body = { items: lines, reasonCode: reason as ReasonCode, note: note.trim() || null };
      const text = JSON.stringify(body);
      // One key per user action, reused on retries of the same request (API.md rule 6).
      if (!attemptRef.current || attemptRef.current.body !== text) attemptRef.current = { body: text, key: newIdempotencyKey() };
      return call(api.POST('/api/store/orders/orders/{id}/cancellations', { params: { path: { id: order.id }, header: { 'Idempotency-Key': attemptRef.current.key } }, body }));
    },
    onSuccess: async (res) => {
      setRequestedIds(res.requests.map((r) => r.id));
      await qc.invalidateQueries({ queryKey: ['orders'] });
      void qc.invalidateQueries({ queryKey: ['customers', 'overview'] });
      setView('cancellation-requested');
      window.scrollTo({ top: 0 });
    },
  });

  const errors = {
    items: attempted && chosen.length === 0 ? 'Choose at least one item to cancel.' : undefined,
    reason: attempted && !reason ? 'Choose a reason.' : undefined,
  };
  const toggle = (id: string) => setPicked(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  const onSubmit = () => {
    setAttempted(true);
    if (chosen.length === 0 || !reason || submit.isPending) return;
    submit.mutate();
  };

  if (view === 'cancellation-requested') return <Requested order={order} crumbs={crumbs} ids={requestedIds} />;

  const orderItems = order.groups.flatMap((g) => g.items);
  const refundTotal = preview.data?.total;
  const sellerNames = [...new Set(chosen.map((i) => i.sellerName))];

  return (
    <AccountLayout
      active="orders"
      title="Cancel items"
      actionBar={
        <>
          <span className="stack gap-0 grow">
            <span className="xs muted">Refund estimate</span>
            <span className="strong num">{refundTotal ? formatMoney(refundTotal) : formatMoney({ amount: 0, currency: 'USD' })}</span>
          </span>
          <Button onClick={onSubmit} disabled={submit.isPending}>
            Request cancellation
          </Button>
        </>
      }
    >
      {crumbs}
      <div className="acct-head">
        <div className="stack gap-1">
          <h1 className="h1 acct-h1">Cancel items</h1>
          <p className="small sub">
            Order <span className="mono">{order.ref}</span> · choose only the items you want to cancel. Other items continue as normal.
          </p>
        </div>
      </div>
      {submit.isError ? (
        <Alert tone="danger" title="We couldn't send your request">
          {cancelError(submit.error)}
        </Alert>
      ) : errors.items ? (
        <Alert tone="danger" title="Choose at least one item to cancel">
          Tick the items you want to cancel. Items that have already shipped can be returned after delivery instead.
        </Alert>
      ) : (
        <Alert tone="info" title="Cancellation cutoff: before the seller ships">
          {opts.data?.cutoffRule ?? 'You can cancel an item until its seller marks it shipped.'} After that, you can refuse delivery or return it once it arrives.
        </Alert>
      )}
      {opts.isError && <LoadError error={opts.error} onRetry={() => void opts.refetch()} />}
      <div className="acct-split">
        <div className="stack gap-4">
          <section className="card" aria-label="Items in this order">
            {opts.isPending && <SkeletonRows rows={3} />}
            {items.map((l) => {
              const oi = orderItems.find((i) => i.id === l.itemId);
              const ok = l.eligible && l.maxQuantity > 0;
              return (
                <div key={l.itemId} className={cx('acct-check', !ok && 'is-off')}>
                  <input type="checkbox" id={`cx-${l.itemId}`} aria-label={`Cancel ${l.title}`} checked={ok && selected.includes(l.itemId)} disabled={!ok} onChange={() => toggle(l.itemId)} />
                  <Img icon="package" tint="2" className="thumb" src={l.image?.url ?? oi?.image?.url} alt="" />
                  <div className="stack gap-1">
                    <label htmlFor={`cx-${l.itemId}`} className="small strong">
                      {l.title}
                    </label>
                    <span className="xs muted">
                      {l.variantLabel ? `${l.variantLabel} · ` : ''}Qty {l.quantity} · {l.sellerName}
                    </span>
                    <span className="row gap-2">
                      <StatusBadge status={oi?.stateLabel ?? humanize(l.state)} tone={stateTone(l.state)} />
                      <span className={ok ? 'xs t-success-text strong' : 'xs sub'}>{l.reason}</span>
                    </span>
                    <Alternative alt={l.alternative ?? null} orderRef={order.ref} itemId={l.itemId} shipmentId={oi?.shipmentId ?? null} returnRef={oi?.afterSales?.returnRef ?? null} />
                  </div>
                  <div className="side stack gap-0">
                    {ok ? (
                      <>
                        <span className="small strong num">{oi ? formatMoney(oi.lineSubtotal) : ''}</span>
                        {l.refundEstimate && <span className="xs muted">Refund {formatMoney(l.refundEstimate)}</span>}
                      </>
                    ) : (
                      <span className="xs muted">Not eligible</span>
                    )}
                  </div>
                </div>
              );
            })}
          </section>
          <Card title="Reason">
            <Field label="Why are you cancelling?" error={errors.reason}>
              <Select id="cx-reason" options={REASONS} value={reason} onChange={(e) => setReason(e.target.value as ReasonCode | '')} className={cx(errors.reason && 'is-error')} />
            </Field>
            <Field label="Anything to add for the seller" optional>
              <Textarea id="cx-note" placeholder="For example: I need it before Oct 10." value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
            </Field>
          </Card>
        </div>
        <aside>
          <Card title="Refund preview" titleAs="h3">
            {preview.data ? (
              <>
                {preview.data.lines.map((l) => (
                  <SummaryRow key={l.itemId} k={`${l.title}, Qty ${l.quantity}`} v={formatMoney(l.itemAmount)} />
                ))}
                {preview.data.discountShare.amount > 0 && <SummaryRow k="Discount share" v={`−${formatMoney(preview.data.discountShare)}`} />}
                <SummaryRow k="Shipping refund" v={formatMoney(preview.data.shippingRefund)} />
                {preview.data.taxRefund.amount > 0 && <SummaryRow k="Tax refund" v={formatMoney(preview.data.taxRefund)} />}
                <hr />
                <SummaryRow className="total" k="Estimated refund" v={formatMoney(preview.data.total)} />
                <SummaryRow k="Refund to" v={preview.data.destination} />
                <span className="xs muted">
                  {preview.data.discountShare.amount > 0 ? 'Order discounts are split across items by price, so the share for these items is deducted. ' : ''}
                  {preview.data.timingNote}
                </span>
              </>
            ) : preview.isError ? (
              <span className="xs t-danger-text">{errorMessage(preview.error)}</span>
            ) : lines.length ? (
              <div className="sk-lines" aria-hidden="true">
                <span className="sk sk-line" />
                <span className="sk sk-line short" />
              </div>
            ) : (
              <span className="xs muted">Choose the items to cancel to see your refund.</span>
            )}
          </Card>
          <div className="only-desktop stack gap-2">
            <Button block onClick={onSubmit} disabled={submit.isPending}>
              {submit.isPending ? 'Sending request…' : 'Request cancellation'}
            </Button>
            <Button variant="ghost" block to={orderHref(order.ref)}>
              Keep my order
            </Button>
          </div>
          {sellerNames.length > 0 && <span className="xs muted">{sellerNames.join(' and ')} confirm{sellerNames.length === 1 ? 's' : ''} the cancellation. If they don't reply in time, Marketly cancels the item for you.</span>}
        </aside>
      </div>
    </AccountLayout>
  );
}

function Alternative({ alt, orderRef, itemId, shipmentId, returnRef }: { alt: string | null; orderRef: string; itemId: string; shipmentId: string | null; returnRef: string | null }) {
  if (alt === 'return')
    return (
      <Link className="xs strong" to={href('account/return-new', '', { ref: orderRef }, { item: itemId })}>
        Return item
      </Link>
    );
  if (alt === 'view_return' && returnRef)
    return (
      <Link className="xs strong" to={returnHref(returnRef)}>
        View return
      </Link>
    );
  if (alt === 'track' || alt === 'refuse_delivery')
    return (
      <Link className="xs strong" to={href('account/tracking', '', { ref: orderRef }, shipmentId ? { shipment: shipmentId } : undefined)}>
        Track package
      </Link>
    );
  return null;
}

/** The "cancellation-requested" view: the requests just sent, or the order's open ones. */
function Requested({ order, crumbs, ids }: { order: OrderDetail; crumbs: ReactNode; ids: string[] | null }) {
  const all: Array<{ c: Cancellation; g: OrderGroup }> = order.groups.flatMap((g) => g.cancellations.map((c) => ({ c, g })));
  const mine = all.filter((x) => x.c.initiatedBy.toUpperCase() === 'CUSTOMER');
  const latest = mine.reduce<string>((m, x) => (x.c.createdAt > m ? x.c.createdAt : m), '');
  const shown = ids ? all.filter((x) => ids.includes(x.c.id)) : mine.filter((x) => x.c.status.toUpperCase() === 'REQUESTED').length ? mine.filter((x) => x.c.status.toUpperCase() === 'REQUESTED') : mine.filter((x) => x.c.createdAt === latest);
  const orderItems = order.groups.flatMap((g) => g.items);

  if (!shown.length) {
    return (
      <AccountLayout active="orders" title="Cancellation requested">
        {crumbs}
        <NotFoundCard title="No cancellation request on this order" back={orderHref(order.ref)} backLabel="Back to order">
          You haven't asked to cancel anything in order {order.ref}. You can cancel items that haven't shipped from the order page.
        </NotFoundCard>
      </AccountLayout>
    );
  }

  const first = shown[0]!.c;
  const sellers = [...new Set(shown.map((x) => x.g.seller.name))];
  const status = first.status.toUpperCase();
  const preview = shown.map((x) => x.c.refundPreview);
  const sum = (pick: (p: Cancellation['refundPreview']) => { amount: number; currency: string }) => ({ amount: preview.reduce((s, p) => s + pick(p).amount, 0), currency: pick(preview[0]!).currency });
  const lines = shown.flatMap((x) => x.c.items);
  const timeline: TimelineEvent[] = first.timeline.map((t) => ({ t: t.label, d: fmtDateTime(t.at), state: 'done', body: t.detail ?? undefined }));
  if (status === 'REQUESTED') {
    timeline.push(
      { t: `${sellers.join(' and ')} confirm${sellers.length === 1 ? 's' : ''}`, d: first.respondBy ? `By ${fmtDateTime(first.respondBy.dueAt)} PT` : undefined, state: 'current', body: "The item hasn't shipped, so the seller should confirm. If they don't reply in time, Marketly cancels it for you." },
      { t: 'Refund is processed', d: 'Within 1 business day of confirmation', body: 'Refund status changes to Processing.' },
      { t: `Refund sent to ${first.refundPreview.destination}`, d: 'Status changes to Sent', body: "Your bank usually shows it within 3–5 business days after it's sent." },
    );
  }

  return (
    <AccountLayout active="orders" title="Cancellation requested">
      {crumbs}
      <div className="acct-head">
        <div className="stack gap-1">
          <h1 className="h1 acct-h1">Cancellation requested</h1>
          <p className="small sub">
            Order <span className="mono">{order.ref}</span> · requested {fmtDateTime(first.createdAt)} PT
          </p>
        </div>
      </div>
      {status === 'DECLINED' ? (
        <Alert tone="danger" title={`${sellers.join(' and ')} couldn't cancel this`}>
          {first.declineReason ?? 'The item had already shipped.'} You can refuse the delivery or return it once it arrives.
        </Alert>
      ) : status === 'ACCEPTED' ? (
        <Alert tone="success" title="Cancelled">
          {sellers.join(' and ')} cancelled the item{lines.length > 1 ? 's' : ''}. Your other items are not affected.
        </Alert>
      ) : (
        <Alert tone="success" title={`We sent your request to ${sellers.join(' and ')}`}>
          Your other items are not affected.
        </Alert>
      )}
      <div className="acct-split">
        <div className="stack gap-4">
          <Card title={lines.length > 1 ? 'Items being cancelled' : 'Item being cancelled'}>
            {shown.flatMap(({ c, g }) =>
              c.items.map((l) => {
                const oi = orderItems.find((i) => i.id === l.itemId);
                const to = oi ? productHref(oi.productId, oi.title, oi.productSlug) : null;
                return (
                  <div key={`${c.id}-${l.itemId}`} className="row gap-3 nowrap top">
                    {to ? (
                      <Link to={to} aria-label={l.title} className="link-inline">
                        <Img icon="package" tint="2" className="thumb" src={oi?.image?.url} alt="" />
                      </Link>
                    ) : (
                      <Img icon="package" tint="2" className="thumb" />
                    )}
                    <div className="stack gap-1 grow">
                      {to ? (
                        <Link className="small strong link-plain" to={to}>
                          {l.title}
                        </Link>
                      ) : (
                        <span className="small strong">{l.title}</span>
                      )}
                      <span className="xs muted">
                        {l.variantLabel ? `${l.variantLabel} · ` : ''}Qty {l.quantity}
                      </span>
                      <SellerLineApi seller={g.seller} />
                    </div>
                    <StatusBadge status={c.status.toUpperCase() === 'REQUESTED' ? 'Cancellation requested' : humanize(c.status)} tone={c.status.toUpperCase() === 'REQUESTED' ? 'warning' : c.status.toUpperCase() === 'DECLINED' ? 'danger' : ''} />
                  </div>
                );
              }),
            )}
          </Card>
          <Card title="What happens next" titleAs="h3">
            <Timeline events={timeline} />
          </Card>
        </div>
        <aside>
          <Card title="Refund" titleAs="h3">
            <div className="row between">
              <span className="small sub">Refund status</span>
              <StatusBadge status={humanize(first.refundStatus)} tone={refundTone(first.refundStatus)} />
            </div>
            {preview.flatMap((p) => p.lines).map((l) => (
              <SummaryRow key={l.itemId} k={l.title} v={formatMoney(l.refund)} />
            ))}
            <SummaryRow k="Shipping" v={formatMoney(sum((p) => p.shippingRefund))} />
            <hr />
            <SummaryRow className="total" k="Refund amount" v={formatMoney(sum((p) => p.total))} />
            <SummaryRow k="Goes to" v={first.refundPreview.destination} />
            <span className="xs muted">{first.refundPreview.statusNote} We'll notify you at each step.</span>
          </Card>
          <div className="stack gap-2">
            <Button block to={orderHref(order.ref)}>
              Back to order
            </Button>
            <Button variant="secondary" block icon="message-square" to={href('account/messages', '', undefined, { order: order.ref })}>
              Message {sellers[0]}
            </Button>
          </div>
          <span className="xs muted">If the seller ships before confirming, you can refuse the delivery or return it free of charge.</span>
        </aside>
      </div>
    </AccountLayout>
  );
}
