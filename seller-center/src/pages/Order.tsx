import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { ApiError, call, errorMessage, newIdempotencyKey, useApi } from '@marketly/web-shared/api';
import { SellerLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { useView } from '@marketly/web-shared/lib/hooks';
import { formatMoney, isoInText } from '@marketly/web-shared/lib/format';
import { href } from '@marketly/web-shared/routes';
import { Alert, Badge, Button, Card, Checkbox, Deadline, Dialog, EmptyState, Field, Icon, Img, KeyValue, OptionCard, PageHeader, Select, SummaryRow, Textarea, TextInput, Timeline, Track, announce, type TimelineEvent, type Tone } from '@marketly/web-shared/ui';
import { useSellerSession } from '@/app/session';
import {
  EDIT_REASONS,
  SELLER_CANCEL_REASONS,
  SELLER_ORDER_DETAIL,
  dayKey,
  dayRange,
  deadlineTone,
  dueText,
  lc,
  normTracking,
  openDownload,
  openQty,
  phoneText,
  toShipQty,
  ptDateTime,
  ptInstant,
  ptLong,
  trackingProblem,
  useNow,
  type GroupG,
  type OrderItemG,
  type LabelQuote,
  type LabelResult,
  type SellerCancelReason,
  type SellerOrderDetailResult,
  type SetupCarrierG,
  type ShipmentG,
} from './data/orders';

// Design: pages/seller/seller-order.html (to ship: record shipment form) · view "shipped" = the packages
// recorded, tracking corrections and the delivery track (now follows the data; the view is set after the
// last package is recorded). Data: the SellerOrderDetail screen query (ref → the seller group, items, money,
// ship-to, shipments, cancellations, exceptions, timeline, buyer conversation and the record-shipment setup).
// Writes: POST /api/seller/shipping/shipments, …/labels/quotes, …/labels (Idempotency-Key),
// …/shipments/{id}/hand-over, …/shipments/{id}/correct-tracking (the label file comes with the screen query),
// POST /api/seller/orders/orders/{groupId}/cancel-items (Idempotency-Key), GET …/packing-slip,
// POST /api/seller/messaging/conversations (first message) or …/conversations/{id}/messages.

type View = 'shipped';

// The carriers the setup lists (Other and OnTrac included). Tracking is optional for 'other'.
const NO_CARRIER: SetupCarrierG = { code: '', name: 'No carrier', services: [] };
const GROUP_TONE: Record<string, Tone> = { new: 'brand', preparing: 'info', delayed: 'warning', partly_shipped: 'warning', shipped: 'info', partly_delivered: 'warning', delivered: 'success', partly_cancelled: '', cancelled: '' };
const OPEN_EXCEPTION = new Set(['open', 'in_progress', 'escalated']);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const itemName = (i: { title: string; variantLabel?: string | null }) => `${i.title}${i.variantLabel ? `, ${i.variantLabel}` : ''}`;
const lb = (g: number) => String(Math.round((g / 453.592) * 100) / 100);
const inch = (cm?: number | null) => (cm ? String(Math.round((cm / 2.54) * 10) / 10) : '');
const isNum = (v: string) => /^\d+(\.\d+)?$/.test(v.trim()) && Number(v) > 0;

function PageSkeleton() {
  return (
    <div className="stack gap-5" role="status" aria-label="Loading order">
      <div className="stack gap-2" aria-hidden="true">
        <span className="sk sk-line short" />
        <span className="sk sk-line" />
      </div>
      {[2, 3].map((n, i) => (
        <section key={i} className="card">
          <div className="sk-list pad" aria-hidden="true">
            {Array.from({ length: n }, (_, k) => (
              <div key={k} className="sk-row">
                <span className="sk sk-thumb" />
                <span className="sk-lines">
                  <span className="sk sk-line" />
                  <span className="sk sk-line short" />
                </span>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

export default function Order() {
  const { ref = '' } = useParams();
  const { gql } = useApi();
  const { sellerId } = useSellerSession();
  const screen = useQuery({
    queryKey: ['orders', 'screen', sellerId, ref],
    queryFn: async () => {
      const r = await gql<SellerOrderDetailResult>(SELLER_ORDER_DETAIL, { ref, messagePaging: { limit: 50 } }, 'SellerOrderDetail');
      // A null order with an error on it is a failed read (e.g. a resolver error), not "not found".
      const err = r.errors.find((e) => e.path?.[0] === 'sellerOrder');
      if (!r.data?.sellerOrder && err && err.extensions?.code !== 'NOT_FOUND') throw new ApiError(500, err.extensions?.code ?? 'GRAPHQL_ERROR', err.message);
      return r.data!;
    },
  });
  const order = screen.data?.sellerOrder;
  const group = order?.groups[0];

  if (screen.data && order && group) return <OrderScreen data={screen.data} />;
  return (
    <SellerLayout active="orders">
      {screen.isError ? (
        <>
          <PageHeader crumbs={[{ label: 'Orders', to: href('seller/orders') }, { label: ref }]} title={<>Order <span className="mono">{ref}</span></>} />
          <Alert tone="danger" title="We couldn't load this order">
            {errorMessage(screen.error)}{' '}
            <Button variant="secondary" size="sm" onClick={() => void screen.refetch()}>
              Try again
            </Button>
          </Alert>
        </>
      ) : screen.data ? (
        <section className="card">
          <EmptyState icon="search-x" as="h1" title="Order not found" action={<Button to={href('seller/orders')}>Back to orders</Button>}>
            We couldn't find order <span className="mono">{ref}</span> among your orders. Check the order number, or switch store if it belongs to another one.
          </EmptyState>
        </section>
      ) : (
        <PageSkeleton />
      )}
    </SellerLayout>
  );
}

interface Notice {
  tone: 'success' | 'warning' | 'danger' | 'info';
  title: string;
  body: string;
}

function OrderScreen({ data }: { data: SellerOrderDetailResult }) {
  const order = data.sellerOrder!;
  const g: GroupG = order.groups[0];
  const setup = data.myShippingSetup;
  const { api } = useApi();
  const qc = useQueryClient();
  const { sellerId, can } = useSellerSession();
  const [, setView] = useView<View>();
  const now = useNow(30_000);
  const [notice, setNotice] = useState<Notice | null>(null);

  const refresh = () => qc.invalidateQueries({ queryKey: ['orders'] });
  const tell = (n: Notice) => {
    setNotice(n);
    announce(n.body || n.title);
  };

  const carriers: SetupCarrierG[] = setup?.carriers.length ? setup.carriers : [NO_CARRIER];
  const carrierOf = (code: string) => carriers.find((c) => c.code === code);
  const codeForName = (name?: string | null) => carriers.find((c) => c.name === name)?.code ?? carriers[0].code;

  const items = g.items;
  // Units on a bought label that isn't handed over yet (onLabelQuantity) can't go in another package or be cancelled.
  const toShip = (i: OrderItemG) => toShipQty(i);
  const awaitingHandover = items.some((i) => (i.onLabelQuantity ?? 0) > 0) || g.shipments.some((s) => lc(s.status) === 'label_created');
  const open = items.filter((i) => toShip(i) > 0);
  const remaining = open.reduce((a, i) => a + toShip(i), 0);
  const allCancelled = items.length > 0 && items.every((i) => lc(i.state) === 'cancelled');
  const allShipped = remaining === 0 && !allCancelled && !awaitingHandover;
  const cancelledUnits = items.reduce((a, i) => a + i.cancelledQuantity, 0);
  const units = items.reduce((a, i) => a + i.quantity, 0) - cancelledUnits;
  const products = new Set(items.map((i) => i.title)).size;
  const allowed = new Set(g.allowedActions.map(lc));
  const canShip = can('shipping.seller-shipments.manage');
  const canRecord = canShip && allowed.has('record_shipment') && remaining > 0;
  const canCancel = can('orders.fulfillment.cancel') && allowed.has('cancel_items') && remaining > 0;
  const buyer = order.buyerName;
  const firstName = buyer.split(' ')[0];

  /* ---------------- record shipment */
  const defaultCarrier = carriers.find((c) => c.code === 'ups') ?? carriers[0];
  const [carrierCode, setCarrierCode] = useState(defaultCarrier.code);
  const carrier = carrierOf(carrierCode) ?? NO_CARRIER;
  const [serviceId, setServiceId] = useState(defaultCarrier.services[0]?.id ?? '');
  const [tracking, setTracking] = useState('');
  const [shipDate, setShipDate] = useState(dayKey());
  const [picks, setPicks] = useState<Record<string, { on: boolean; qty: number }>>({});
  const [tried, setTried] = useState(false);
  const [serverTrackErr, setServerTrackErr] = useState('');
  const [formatWarned, setFormatWarned] = useState(false);
  const [itemsErr, setItemsErr] = useState('');

  const pick = (id: string, max: number) => {
    const p = picks[id] ?? { on: true, qty: max };
    return { on: p.on, qty: Math.min(Math.max(1, p.qty), max) };
  };
  const chosen = open.filter((i) => pick(i.id, toShip(i)).on).map((i) => ({ orderItemId: i.id, quantity: pick(i.id, toShip(i)).qty }));
  const chosenUnits = chosen.reduce((a, l) => a + l.quantity, 0);
  const clientTrackErr = trackingProblem(carrier, tracking);
  const errs = tried
    ? {
        tracking: serverTrackErr || clientTrackErr,
        date: !shipDate ? 'Enter the ship date.' : shipDate > dayKey() ? 'The ship date cannot be in the future.' : '',
        items: chosen.length ? itemsErr : 'Choose at least one item for this package.',
      }
    : { tracking: serverTrackErr, date: '', items: itemsErr };
  const formatOnly = tried && !!normTracking(tracking) && (!!clientTrackErr || formatWarned) && !errs.date && !errs.items;

  const changeCarrier = (code: string) => {
    setCarrierCode(code);
    setServiceId(carrierOf(code)?.services[0]?.id ?? '');
    setServerTrackErr('');
    setFormatWarned(false);
  };

  const record = useMutation({
    mutationFn: (ack: boolean) => {
      const svc = carrier.services.find((s) => s.id === serviceId);
      return call(
        api.POST('/api/seller/shipping/shipments', {
          body: {
            groupId: g.id,
            carrierCode,
            carrierServiceId: svc?.id ?? null,
            serviceName: svc?.name ?? null,
            trackingNumber: normTracking(tracking) || null,
            shippedAt: shipDate === dayKey() ? new Date().toISOString() : ptInstant(shipDate, 12),
            items: chosen,
            acknowledgeFormatWarning: ack || null,
          },
        }),
      );
    },
    onSuccess: (s) => {
      const left = remaining - chosenUnits;
      setTried(false);
      setTracking('');
      setPicks({});
      setFormatWarned(false);
      const via = s.serviceName ?? s.carrierName ?? 'your carrier';
      tell(
        left
          ? { tone: 'success', title: 'Package recorded', body: `${chosenUnits} of ${chosenUnits + left} shipped with ${via}. The other ${left} keep${left === 1 ? 's' : ''} the dispatch deadline.` }
          : { tone: 'success', title: 'Marked as shipped', body: `Shipped with ${via}. ${firstName} was sent the tracking number.` },
      );
      if (!left) setView('shipped');
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'TRACKING_FORMAT_INVALID') {
        setServerTrackErr(e.message);
        setFormatWarned(true);
      } else if (e instanceof ApiError && e.code === 'TRACKING_ALREADY_USED') setServerTrackErr(e.message);
      else if (e instanceof ApiError && e.code === 'ITEMS_NOT_SHIPPABLE') setItemsErr(e.message);
      else if (e instanceof ApiError && e.fieldErrors.shippedAt) tell({ tone: 'danger', title: 'Check the ship date', body: e.fieldErrors.shippedAt });
      else tell({ tone: 'danger', title: 'Could not record the shipment', body: errorMessage(e) });
      announce('Check the shipment details');
    },
    onSettled: refresh,
  });
  const markShipped = (ack = false) => {
    setTried(true);
    setServerTrackErr('');
    setItemsErr('');
    if (!chosen.length || !shipDate || shipDate > dayKey() || (!ack && clientTrackErr) || (!normTracking(tracking) && carrierCode !== 'other')) {
      announce('Check the shipment details');
      return;
    }
    record.mutate(ack);
  };

  /* ---------------- buy a label */
  const dp = setup?.defaultPackage;
  const emptyParcel = { weight: dp ? lb(dp.weightGrams) : '', length: inch(dp?.lengthCm), width: inch(dp?.widthCm), height: inch(dp?.heightCm) };
  const [labelOpen, setLabelOpen] = useState(false);
  const [parcel, setParcel] = useState(emptyParcel);
  const [parcelTried, setParcelTried] = useState(false);
  const [quotes, setQuotes] = useState<LabelQuote[] | null>(null);
  const [quoteId, setQuoteId] = useState('');
  const [labelErr, setLabelErr] = useState('');
  const [bought, setBought] = useState<LabelResult | null>(null);
  const labelKey = useRef('');
  const parcelBad = { weight: !isNum(parcel.weight), dims: [parcel.length, parcel.width, parcel.height].some((v) => v.trim() && !isNum(v)) };

  const openLabel = () => {
    setParcel(emptyParcel);
    setParcelTried(false);
    setQuotes(null);
    setQuoteId('');
    setLabelErr('');
    setBought(null);
    labelKey.current = newIdempotencyKey();
    setLabelOpen(true);
  };
  const cm = (v: string) => (v.trim() ? Math.max(1, Math.round(Number(v) * 2.54)) : null);
  const getQuotes = useMutation({
    mutationFn: () =>
      call(
        api.POST('/api/seller/shipping/labels/quotes', {
          body: { groupId: g.id, items: chosen, parcel: { weightGrams: Math.max(1, Math.round(Number(parcel.weight) * 453.592)), lengthCm: cm(parcel.length), widthCm: cm(parcel.width), heightCm: cm(parcel.height) } },
        }),
      ),
    onSuccess: (qs) => {
      setQuotes(qs);
      setQuoteId((qs.find((x) => x.keepsPromise) ?? qs[0])?.id ?? '');
      setLabelErr(qs.length ? '' : 'No label is available for this package. Enter tracking manually.');
    },
    onError: (e) => setLabelErr(errorMessage(e)),
  });
  const buyLabel = useMutation({
    mutationFn: () => call(api.POST('/api/seller/shipping/labels', { params: { header: { 'Idempotency-Key': labelKey.current } }, body: { quoteId, items: chosen } })),
    onSuccess: (res) => {
      setBought(res);
      setLabelErr('');
      labelKey.current = newIdempotencyKey();
      announce(`Label bought: ${res.label.carrierName} ${res.label.trackingNumber}`);
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'QUOTE_EXPIRED') {
        setQuotes(null);
        setQuoteId('');
      }
      if (e instanceof ApiError && e.code === 'LABEL_FAILED') {
        // 422: the carrier refused (change the package or the service); 502: the carrier didn't answer (try again). Nothing was charged.
        // Nothing was bought, so the next attempt is a new purchase. The quotes stay: choose another service, or Back to change the parcel.
        labelKey.current = newIdempotencyKey();
        const carrierMsg = typeof e.details.carrierMessage === 'string' && e.details.carrierMessage ? ` Carrier: ${e.details.carrierMessage}` : '';
        setLabelErr(
          e.details.carrierReached === false || e.status >= 500
            ? `The carrier didn't answer, so no label was bought and nothing was charged. Try again in a few minutes.${carrierMsg}`
            : `${e.message}${carrierMsg}`,
        );
        return;
      }
      setLabelErr(errorMessage(e));
    },
    onSettled: refresh,
  });
  const requestQuotes = () => {
    setParcelTried(true);
    if (!chosen.length) return setLabelErr('Choose at least one item for this package in the Record shipment form.');
    if (parcelBad.weight || parcelBad.dims) return;
    setLabelErr('');
    getQuotes.mutate();
  };

  /* ---------------- packages: label file, hand-over, tracking corrections */
  const printLabel = (s: ShipmentG) => (s.label?.labelUrl ? openDownload(s.label.labelUrl) : tell({ tone: 'info', title: 'No label file', body: 'This package has no label to print.' }));
  const handOver = useMutation({
    mutationFn: (id: string) => call(api.POST('/api/seller/shipping/shipments/{id}/hand-over', { params: { path: { id } }, body: {} })),
    onSuccess: (s) => {
      setLabelOpen(false);
      tell({ tone: 'success', title: 'Handed over to the carrier', body: `${s.packageLabel} is marked as shipped with ${s.serviceName ?? s.carrierName ?? 'the carrier'}. ${firstName} was sent the tracking number.` });
      if (remaining === 0) setView('shipped');
    },
    onError: (e) => tell({ tone: 'danger', title: 'Could not mark the package as handed over', body: errorMessage(e) }),
    onSettled: refresh,
  });

  const [edit, setEdit] = useState<{ s: ShipmentG; carrierCode: string; tracking: string; reason: string; tried: boolean; server: string } | null>(null);
  const editCarrier = edit ? carrierOf(edit.carrierCode) : undefined;
  const unchanged = edit ? normTracking(edit.tracking) === (edit.s.trackingNumber ?? '') && edit.carrierCode === codeForName(edit.s.carrierName) : false;
  const editErr = edit?.tried ? edit.server || trackingProblem(editCarrier, edit.tracking) || (unchanged ? 'Enter the corrected tracking number.' : '') : (edit?.server ?? '');
  const correct = useMutation({
    mutationFn: (e: NonNullable<typeof edit>) => call(api.POST('/api/seller/shipping/shipments/{id}/correct-tracking', { params: { path: { id: e.s.id } }, body: { carrierCode: e.carrierCode, trackingNumber: normTracking(e.tracking), reason: e.reason } })),
    onSuccess: () => {
      setEdit(null);
      announce(`Tracking updated. ${firstName} was sent the corrected number.`);
    },
    onError: (err) => setEdit((x) => (x ? { ...x, server: errorMessage(err) } : x)),
    onSettled: refresh,
  });
  const saveEdit = () => {
    if (!edit) return;
    if (trackingProblem(editCarrier, edit.tracking) || unchanged) return setEdit({ ...edit, tried: true, server: '' });
    correct.mutate(edit);
  };

  /* ---------------- cancel items */
  const [cxItem, setCxItem] = useState('');
  const [cxQty, setCxQty] = useState(1);
  const [cxReason, setCxReason] = useState<SellerCancelReason>('out_of_stock');
  const cxKey = useRef('');
  const cxLine = open.find((i) => i.id === cxItem) ?? open[0];
  const cxMax = cxLine ? toShip(cxLine) : 0;
  const cancel = useMutation({
    mutationFn: (n: number) => {
      cxKey.current ||= newIdempotencyKey();
      return call(
        api.POST('/api/seller/orders/orders/{id}/cancel-items', {
          params: { path: { id: g.id }, header: { 'Idempotency-Key': cxKey.current } },
          body: { items: [{ itemId: cxLine!.id, quantity: n }], reasonCode: cxReason },
        }),
      );
    },
    onSuccess: (res, n) => {
      cxKey.current = '';
      setCxQty(1);
      setCxItem('');
      tell({ tone: 'warning', title: `${plural(n, 'item')} cancelled`, body: `${firstName} was notified and refunded ${formatMoney(res.refundPreview.total)}. This counts toward your cancellation rate.` });
    },
    onError: (e) => tell({ tone: 'danger', title: 'Could not cancel the items', body: errorMessage(e) }),
    onSettled: refresh,
  });
  const resetCxKey = () => (cxKey.current = '');

  /* ---------------- messages */
  const conv = order.conversations[0];
  const messages = conv ? [...conv.messages.items].reverse() : [];
  const stats = useQuery({ queryKey: ['messaging', 'stats', sellerId], queryFn: () => call(api.GET('/api/seller/messaging/response-stats')) });
  const [reply, setReply] = useState('');
  const [replyErr, setReplyErr] = useState('');
  const msgKey = useRef('');
  const canReply = can('messaging.conversations.reply') && (conv ? conv.canSend : true);
  const send = useMutation({
    mutationFn: async (body: string) => {
      msgKey.current ||= newIdempotencyKey();
      const clientMessageId = msgKey.current;
      if (conv) await call(api.POST('/api/seller/messaging/conversations/{id}/messages', { params: { path: { id: conv.id } }, body: { body, clientMessageId } }));
      else await call(api.POST('/api/seller/messaging/conversations', { body: { orderId: order.id, body, clientMessageId } }));
    },
    onSuccess: () => {
      msgKey.current = '';
      setReply('');
      setReplyErr('');
      announce(`Message sent to ${firstName}`);
      void qc.invalidateQueries({ queryKey: ['messaging'] });
    },
    onError: (e) => setReplyErr(errorMessage(e)),
    onSettled: refresh,
  });
  const sendReply = () => {
    if (!reply.trim()) return setReplyErr('Write a message before sending.');
    send.mutate(reply.trim());
  };

  /* ---------------- packing slip */
  const slip = useMutation({
    mutationFn: () => call(api.GET('/api/seller/orders/orders/{id}/packing-slip', { params: { path: { id: g.id }, query: { hidePrices: g.hidePricesOnSlip ?? undefined } } })),
    onSuccess: (doc) => openDownload(doc.url, doc.fileName),
    onError: (e) => tell({ tone: 'danger', title: 'Could not create the packing slip', body: errorMessage(e) }),
  });

  /* ---------------- derived view data */
  const due = g.dispatchDeadline;
  const minsLeft = due ? Math.round((Date.parse(due.dueAt) - now) / 60_000) : 0;
  const abs = Math.abs(minsLeft);
  const shippedTimes = g.shipments.map((s) => s.shippedAt).filter((t): t is string => !!t).sort();
  const lastShippedAt = shippedTimes[shippedTimes.length - 1];
  const late = g.shipments.some((s) => s.dispatchedOnTime === false);
  const pendingBuyerRequests = g.cancellations.filter((c) => lc(c.status) === 'requested' && lc(c.initiatedBy) === 'customer');
  const exceptions = g.deliveryExceptions.filter((e) => OPEN_EXCEPTION.has(lc(e.status)));
  const m = g.money;
  const ship = g.shipTo ?? {};
  const giftNote = [g.giftNote, g.hidePricesOnSlip ? 'Hide prices on packing slip' : ''].filter(Boolean).join(' · ');

  const timeline: TimelineEvent[] = [
    ...((remaining > 0 || awaitingHandover) && due ? [{ t: 'Waiting for shipment', d: `Dispatch by ${dueText(due.dueAt)}`, state: 'current' as const }] : []),
    ...[...g.timeline].reverse().map((e) => ({ t: e.label, d: [ptDateTime(e.at), e.actor?.name].filter(Boolean).join(' · '), state: 'done' as const, body: e.detail ? isoInText(e.detail) : undefined })),
  ];

  return (
    <SellerLayout active="orders">
      <PageHeader
        crumbs={[{ label: 'Orders', to: href('seller/orders') }, { label: order.ref }]}
        title={
          <>
            Order <span className="mono">{order.ref}</span>
          </>
        }
        sub={`Placed ${ptLong(order.placedAt)} · buyer ${buyer} · ${order.paymentAccepted ? 'payment accepted' : 'payment pending'}`}
        actions={
          <>
            <Badge tone={GROUP_TONE[lc(g.status)] ?? ''}>{g.statusLabel}</Badge>
            {allowed.has('print_packing_slip') && (
              <Button variant="secondary" size="sm" icon="printer" onClick={() => slip.mutate()} disabled={slip.isPending}>
                Print packing slip
              </Button>
            )}
          </>
        }
      />
      {allShipped ? (
        <div className={cx('sa-cd', !late && 't-ok')}>
          <Icon name={late ? 'circle-alert' : 'circle-check'} />
          <div className="stack gap-0 grow">
            <span className="strong">{g.dispatchResult ?? (late ? 'Shipped late' : 'Shipped')}</span>
            <span className="xs sub">
              {due ? `Dispatch deadline was ${dueText(due.dueAt)}` : 'Dispatch deadline'}
              {lastShippedAt ? ` · shipped ${ptDateTime(lastShippedAt)}` : ''}
            </span>
          </div>
        </div>
      ) : allCancelled ? (
        <Alert tone="info" title="Order cancelled">
          Every item in this order was cancelled. {firstName} is refunded under the cancellation policy.
        </Alert>
      ) : due ? (
        <div className="sa-cd">
          <Icon name="alarm-clock" />
          <div className="stack gap-0 grow">
            <span className="xs sub strong">Dispatch by {dueText(due.dueAt)}</span>
            <span className="big" role="timer">
              {minsLeft >= 0 ? `${Math.floor(abs / 60)} h ${abs % 60} m left` : `Overdue by ${Math.floor(abs / 60)} h ${abs % 60} m`}
            </span>
          </div>
          {g.deadlineLabel && <Deadline tone={deadlineTone(due, g.deadlineLabel)}>{g.deadlineLabel}</Deadline>}
        </div>
      ) : null}
      {notice && (
        <Alert tone={notice.tone} title={notice.title}>
          {notice.body}
        </Alert>
      )}
      {pendingBuyerRequests.length > 0 && (
        <Alert tone="warning" title={`${firstName} asked to cancel ${pendingBuyerRequests.flatMap((c) => c.items).map(itemName).join(', ')}`}>
          Answer before you ship this item.{' '}
          <Link className="link-inline" to={href('seller/orders', 'cancellation-requests')}>
            Respond in Cancellation requests
          </Link>
        </Alert>
      )}
      {exceptions.map((e) => (
        <Alert key={e.id} tone={e.deadline && lc(e.deadline.state) === 'overdue' ? 'danger' : 'warning'} title={e.situation}>
          {e.requiredResponse}. Next step: {e.nextStep}. {e.deadlineLabel}
        </Alert>
      ))}
      <div className="sa-split">
        <div className="stack gap-5">
          <Card title="Your items in this order" sub={`${plural(products, 'product')} · ${plural(units, 'unit')}${cancelledUnits ? ` · ${cancelledUnits} cancelled` : ''}`}>
            {items.map((i) => {
              const left = openQty(i);
              const partial = i.shippedQuantity > 0 && left > 0;
              return (
                <div className="sa-pkgitem" key={i.id}>
                  <Img icon="package" src={i.image?.url} alt={i.image?.alt ?? ''} className="thumb" />
                  <div className="stack gap-0 grow">
                    <span className="small strong">{i.title}</span>
                    <span className="xs muted">
                      {[i.variantLabel, i.offerTerms?.conditionLabel].filter(Boolean).join(' · ')}
                      {i.offerTerms?.sellerSku && (
                        <>
                          {' · '}
                          <span className="mono">{i.offerTerms.sellerSku}</span>
                        </>
                      )}
                    </span>
                    <span className="xs muted">
                      Qty {i.quantity} × {formatMoney(i.unitPrice)}
                    </span>
                  </div>
                  <div className="stack gap-1 u-items-flex-end">
                    <b className="num">{formatMoney(i.lineSubtotal)}</b>
                    <Badge tone={lc(i.state) === 'cancelled' ? '' : lc(i.state) === 'delivered' ? 'success' : 'info'}>{partial ? `${i.shippedQuantity} shipped · ${left} open` : i.stateLabel}</Badge>
                  </div>
                </div>
              );
            })}
            {order.mixedOrderNote && (
              <div className="panel row gap-2 small">
                <Icon name="info" className="ic-sm" />
                <span>{order.mixedOrderNote}</span>
              </div>
            )}
            {m && (
              <>
                <div className="stack gap-1">
                  <SummaryRow k="Item subtotal" v={formatMoney(m.itemSubtotal)} />
                  {!!m.sellerDiscounts?.amount && <SummaryRow k="Your discounts" v={`−${formatMoney(m.sellerDiscounts)}`} />}
                  <SummaryRow k={m.shippingLabel ?? 'Shipping charged'} v={formatMoney(m.shippingCharged)} />
                  {m.platformFeeEstimate && <SummaryRow k="Platform fee (estimate)" v={`−${formatMoney(m.platformFeeEstimate)}`} />}
                  <div className="divider" />
                  {m.earningsEstimate && <SummaryRow className="total" k="Estimated earnings" v={formatMoney(m.earningsEstimate)} />}
                </div>
                {m.earningsNote && (
                  <p className="xs muted row gap-1 nowrap top">
                    <Icon name="info" className="ic-sm" />
                    <span className="wrap">{m.earningsNote}</span>
                  </p>
                )}
              </>
            )}
          </Card>

          {g.shipments.map((s) => {
            const qty = s.contents.reduce((a, c) => a + c.quantity, 0);
            const labelOnly = lc(s.status) === 'label_created';
            const final = ['delivered', 'cancelled', 'returned_to_sender'].includes(lc(s.status));
            const changes: TimelineEvent[] = [
              ...[...s.corrections].reverse().map((c) => ({
                t: (
                  <>
                    <span className="sr-only">At risk: </span>Tracking corrected
                  </>
                ),
                d: [ptDateTime(c.at), c.by?.name].filter(Boolean).join(' · '),
                state: 'warn' as const,
                body: `From ${c.from} to ${c.to}. Reason: ${c.reason.replace(/\.$/, '').toLowerCase()}.${c.customerNotified ? ' Buyer was sent the corrected number.' : ''}`,
              })),
              s.shippedAt ? { t: 'Shipment recorded', d: [ptDateTime(s.shippedAt), s.recordedBy?.name].filter(Boolean).join(' · '), state: 'done' as const } : { t: 'Label created', d: 'Not handed to the carrier yet', state: 'current' as const },
            ];
            return (
              <Card
                key={s.id}
                title={s.packageLabel}
                titleAs="h3"
                sub={qty >= units ? (units === 2 ? 'Both items shipped' : 'All items shipped') : `${qty} of ${plural(units, 'item')} ${labelOnly ? 'in this package' : 'shipped'}`}
                actions={
                  canShip &&
                  (labelOnly ? (
                    <div className="row gap-2">
                      <Button variant="secondary" size="sm" icon="printer" onClick={() => printLabel(s)}>
                        Print label
                      </Button>
                      <Button size="sm" icon="truck" onClick={() => handOver.mutate(s.id)} disabled={handOver.isPending}>
                        Mark handed over
                      </Button>
                    </div>
                  ) : (
                    !final && (
                      <Button variant="secondary" size="sm" icon="pencil" onClick={() => setEdit({ s, carrierCode: codeForName(s.carrierName), tracking: s.trackingNumber ?? '', reason: EDIT_REASONS[0], tried: false, server: '' })}>
                        Edit tracking
                      </Button>
                    )
                  ))
                }
              >
                <KeyValue
                  pairs={[
                    ['Carrier', s.serviceName ?? s.carrierName ?? '—'],
                    [
                      'Tracking',
                      s.trackingNumber ? (
                        <>
                          <span className="mono">{s.trackingNumber}</span>
                          {s.trackingUrl && (
                            <>
                              {' · '}
                              <a href={s.trackingUrl} target="_blank" rel="noopener noreferrer">
                                Track
                              </a>
                            </>
                          )}
                        </>
                      ) : (
                        'No tracking number'
                      ),
                    ],
                    ['Shipped', s.shippedAt ? ptLong(s.shippedAt) : s.statusLabel],
                    ['Contents', s.contents.map((c) => `${itemName(c)} × ${c.quantity}`).join('; ')],
                    ['Arrival estimate', s.estimateLabel ?? '—'],
                  ]}
                />
                <Track labels={s.steps?.length ? s.steps : ['Shipped', 'In transit', 'Out for delivery', 'Delivered']} done={s.shippedAt ? (s.currentStep ?? 0) + 1 : 0} tone={['delivery_failed', 'lost', 'returning', 'returned_to_sender'].includes(lc(s.status)) ? 'danger' : undefined} />
                {labelOnly && <p className="xs muted">Items in this package can’t be cancelled or shipped in another package until the carrier has it.</p>}
                <div className="stack gap-2">
                  <span className="xs strong">Tracking changes</span>
                  <Timeline events={changes} />
                </div>
              </Card>
            );
          })}

          {canRecord && (
            <Card
              title="Record shipment"
              titleAs="h3"
              sub="Add one package at a time. Items not in this package stay open."
              foot={
                <Button icon="truck" onClick={() => markShipped(false)} disabled={record.isPending}>
                  Mark as shipped
                </Button>
              }
            >
              <div className="grid md2">
                <Field label="Carrier">
                  <Select id="od-carrier" options={carriers.map((c) => ({ value: c.code, label: c.name }))} value={carrierCode} onChange={(e) => changeCarrier(e.target.value)} />
                </Field>
                <Field label="Tracking number" optional={carrierCode === 'other'} hint={carrierCode === 'other' ? 'Optional for other carriers. Add it if your carrier gives one.' : 'We check the format and show it to the buyer.'} error={errs.tracking}>
                  <TextInput
                    id="od-track"
                    value={tracking}
                    placeholder="From your carrier label"
                    error={!!errs.tracking}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(e) => {
                      setTracking(e.target.value);
                      setServerTrackErr('');
                      setFormatWarned(false);
                    }}
                  />
                </Field>
                <Field label="Ship date" error={errs.date}>
                  <TextInput id="od-date" type="date" icon="calendar" value={shipDate} max={dayKey()} error={!!errs.date} onChange={(e) => setShipDate(e.target.value)} />
                </Field>
                <Field label="Shipping service">
                  <Select id="od-svc" options={carrier.services.length ? carrier.services.map((s) => ({ value: s.id, label: s.name })) : ['Other service']} value={serviceId} onChange={(e) => setServiceId(e.target.value)} disabled={!carrier.services.length} />
                </Field>
              </div>
              {formatOnly && (
                <div className="row gap-2 small">
                  <span className="grow muted">Sure the number is right? You can save it anyway; tracking is checked again at the first carrier scan.</span>
                  <Button variant="secondary" size="sm" onClick={() => markShipped(true)} disabled={record.isPending}>
                    Save this number anyway
                  </Button>
                </div>
              )}
              <div className="stack gap-2">
                <span className="label">Items in this package</span>
                {open.map((i, k) => {
                  const max = toShip(i);
                  const p = pick(i.id, max);
                  return (
                    <div className="sa-pkgitem" key={i.id}>
                      <span className="grow">
                        <Checkbox
                          id={`od-pk${k + 1}`}
                          checked={p.on}
                          aria-describedby="od-pk-hint"
                          onChange={(e) => setPicks((ps) => ({ ...ps, [i.id]: { ...p, on: e.target.checked } }))}
                          label={
                            <span className="small">
                              <b>{itemName(i)}</b>
                              <br />
                              <span className="xs muted">
                                {max} {i.shippedQuantity ? 'still to ship' : 'ordered'}
                                {i.offerTerms?.sellerSku ? ` · ${i.offerTerms.sellerSku}` : ''}
                              </span>
                            </span>
                          }
                        />
                      </span>
                      <label className="sr-only" htmlFor={`od-pkq${k + 1}`}>
                        Quantity of {itemName(i)} in this package
                      </label>
                      <select className="select" id={`od-pkq${k + 1}`} value={p.qty} onChange={(e) => setPicks((ps) => ({ ...ps, [i.id]: { ...p, qty: Number(e.target.value) } }))}>
                        {Array.from({ length: max }, (_, n) => max - n).map((n) => (
                          <option key={n} value={n}>
                            {n} of {max}
                          </option>
                        ))}
                      </select>
                    </div>
                  );
                })}
                {errs.items ? (
                  <span className="error-text" id="od-pk-hint">
                    <Icon name="circle-alert" className="ic-sm" />
                    {errs.items}
                  </span>
                ) : (
                  <span className="hint" id="od-pk-hint">
                    Shipping fewer than ordered creates a partial shipment. The rest keeps its dispatch deadline.
                  </span>
                )}
              </div>
              <div className="panel row gap-2 small">
                <Icon name="tag" className="ic-sm" />
                {setup?.labelPurchaseAvailable ? (
                  <span>
                    Buy a {setup.carriers.filter((c) => c.services.some((s) => s.labelSupported)).map((c) => c.name).join(', ').replace(/, ([^,]*)$/, ' or $1')} label here instead ·{' '}
                    <button type="button" className="link-inline btn-bare" onClick={openLabel}>
                      Buy label
                    </button>
                  </span>
                ) : (
                  <span>
                    {setup?.labelUnavailableReason ?? 'Buying labels in Seller Center is off.'} ·{' '}
                    <Link to={href('seller/shipping')} className="link-inline">
                      Shipping settings
                    </Link>
                  </span>
                )}
              </div>
            </Card>
          )}

          {canCancel && cxLine && (
            <Card
              title="Can't fulfill an item?"
              titleAs="h3"
              sub="Cancel only the items you can't ship"
              foot={
                <Button variant="danger-soft" size="sm" onClick={() => cancel.mutate(Math.min(cxQty, cxMax))} disabled={cancel.isPending}>
                  Cancel selected items
                </Button>
              }
            >
              <div className="grid md2">
                <Field label="Item">
                  <Select
                    id="od-cx-item"
                    options={open.map((i) => ({ value: i.id, label: `${itemName(i)} (${toShip(i)})` }))}
                    value={cxLine.id}
                    onChange={(e) => {
                      setCxItem(e.target.value);
                      setCxQty(1);
                      resetCxKey();
                    }}
                  />
                </Field>
                <Field label="Quantity to cancel">
                  <select
                    className="select"
                    id="od-cx-qty"
                    value={Math.min(cxQty, cxMax)}
                    onChange={(e) => {
                      setCxQty(Number(e.target.value));
                      resetCxKey();
                    }}
                  >
                    {Array.from({ length: cxMax }, (_, k) => k + 1).map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <Field label="Reason">
                <Select
                  id="od-cx-reason"
                  options={SELLER_CANCEL_REASONS.map((r) => ({ value: r.value, label: r.label }))}
                  value={cxReason}
                  onChange={(e) => {
                    setCxReason(e.target.value as SellerCancelReason);
                    resetCxKey();
                  }}
                />
              </Field>
              <Alert tone="warning">{firstName} is notified right away and refunded for the cancelled items under the cancellation policy. Seller cancellations count toward your cancellation rate.</Alert>
            </Card>
          )}

          <Card
            title={`Messages with ${buyer}`}
            titleAs="h3"
            sub={`Private to this order · ${conv?.replyLabel ?? `reply within ${stats.data?.targetHours ?? 24} h`}`}
            actions={
              <Link className="small strong" to={href('seller/customers')}>
                Open in Customers
              </Link>
            }
          >
            {conv?.dispatchWarning && <Alert tone="warning">{conv.dispatchWarning}</Alert>}
            {messages.length === 0 && <p className="small muted">No messages yet. Messages here stay private to this order.</p>}
            {messages.map((msg) => (
              <div className={cx('sa-msg', msg.fromMe && 'me')} key={msg.id}>
                <span className="xs muted">
                  {msg.authorLabel} · {ptDateTime(msg.at)}
                </span>
                <p>{msg.hidden ? <i>This message was hidden by Marketly.</i> : msg.body}</p>
              </div>
            ))}
            {canReply ? (
              <>
                <Field label="Reply" error={replyErr}>
                  <Textarea id="od-reply" placeholder={`Write to ${firstName}`} value={reply} onChange={(e) => (setReply(e.target.value), replyErr && setReplyErr(''))} />
                </Field>
                <div className="row end">
                  <Button size="sm" icon="send" onClick={sendReply} disabled={send.isPending}>
                    Send message
                  </Button>
                </div>
              </>
            ) : (
              conv && !conv.canSend && <p className="xs muted">This conversation is closed to new messages.</p>
            )}
            {conv?.rulesNote && <p className="xs muted">{conv.rulesNote}</p>}
          </Card>
        </div>

        <aside className="stack gap-5 sa-sticky">
          <Card title="Ship to" titleAs="h3">
            <div className="stack gap-0 small">
              {ship.name && <span className="strong">{ship.name}</span>}
              {ship.line1 && <span>{[ship.line1, ship.line2].filter(Boolean).join(', ')}</span>}
              <span>
                {[ship.city, [ship.region, ship.postalCode].filter(Boolean).join(' ')].filter(Boolean).join(', ')}
              </span>
              {ship.phone && <span className="muted">Phone for carrier: {phoneText(ship.phone)}</span>}
            </div>
            <div className="divider" />
            <KeyValue
              pairs={[
                ['Method', [g.delivery?.methodName, g.delivery?.carrier].filter(Boolean).join(' · ') || '—'],
                ['Promised arrival', dayRange(g.delivery?.arrivalFrom, g.delivery?.arrivalTo) || '—'],
                ...(giftNote ? [['Gift note', giftNote] as [string, string]] : []),
              ]}
            />
          </Card>
          <Card title="Timeline" titleAs="h3">
            <Timeline events={timeline} />
          </Card>
        </aside>
      </div>

      <Dialog
        open={edit !== null}
        onClose={() => setEdit(null)}
        title="Edit tracking"
        foot={
          <>
            <Button variant="ghost" onClick={() => setEdit(null)}>
              Cancel
            </Button>
            <Button onClick={saveEdit} disabled={correct.isPending}>
              Save tracking
            </Button>
          </>
        }
      >
        {edit && (
          <>
            <p className="small sub">
              {edit.s.packageLabel} · currently <span className="mono">{edit.s.trackingNumber ?? 'no tracking'}</span>. The buyer is sent the corrected number.
            </p>
            <div className="grid md2">
              <Field label="Carrier">
                <Select id="od-ed-carrier" options={carriers.map((c) => ({ value: c.code, label: c.name }))} value={edit.carrierCode} onChange={(e) => setEdit({ ...edit, carrierCode: e.target.value, server: '' })} />
              </Field>
              <Field label="Tracking number" error={editErr}>
                <TextInput id="od-ed-track" value={edit.tracking} error={!!editErr} autoComplete="off" spellCheck={false} onChange={(e) => setEdit({ ...edit, tracking: e.target.value, server: '' })} />
              </Field>
            </div>
            <Field label="Reason">
              <Select id="od-ed-reason" options={EDIT_REASONS} value={edit.reason} onChange={(e) => setEdit({ ...edit, reason: e.target.value })} />
            </Field>
          </>
        )}
      </Dialog>

      <Dialog
        open={labelOpen}
        onClose={() => setLabelOpen(false)}
        title="Buy a shipping label"
        foot={
          bought ? (
            <>
              <Button variant="ghost" onClick={() => setLabelOpen(false)}>
                Close
              </Button>
              <Button variant="secondary" icon="download" onClick={() => openDownload(bought.label.labelUrl)}>
                Download label
              </Button>
              <Button icon="truck" onClick={() => handOver.mutate(bought.shipment.id)} disabled={handOver.isPending}>
                Mark handed over
              </Button>
            </>
          ) : quotes?.length ? (
            <>
              <Button variant="ghost" onClick={() => setQuotes(null)}>
                Back
              </Button>
              <Button icon="tag" onClick={() => buyLabel.mutate()} disabled={!quoteId || buyLabel.isPending}>
                Buy label
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={() => setLabelOpen(false)}>
                Cancel
              </Button>
              <Button onClick={requestQuotes} disabled={getQuotes.isPending}>
                Get label prices
              </Button>
            </>
          )
        }
      >
        <p className="small sub">
          {chosen.length ? `${plural(chosenUnits, 'item')} from the Record shipment form: ${open.filter((i) => chosen.some((l) => l.orderItemId === i.id)).map(itemName).join('; ')}.` : 'Choose the items for this package in the Record shipment form first.'}
        </p>
        {labelErr && <Alert tone="danger">{labelErr}</Alert>}
        {bought ? (
          <Alert tone="success" title="Label bought">
            {bought.label.serviceName} · <span className="mono">{bought.label.trackingNumber}</span>. {formatMoney(bought.label.cost)} is deducted from your earnings and shown on your statement. Print the label, then mark the package as handed over when the carrier has it.
          </Alert>
        ) : quotes?.length ? (
          <div className="stack gap-2" role="radiogroup" aria-label="Label options">
            {quotes.map((x) => (
              <OptionCard
                key={x.id}
                id={`od-q-${x.id}`}
                name="od-quote"
                title={
                  <b>
                    {x.serviceName} · {formatMoney(x.cost)}
                  </b>
                }
                body={`Arrives ${dayRange(x.estimatedArrival.from, x.estimatedArrival.to)} · ${x.keepsPromise ? 'keeps the promised arrival' : 'arrives after the promised date'}`}
                right={x.keepsPromise ? <Badge tone="success">On time</Badge> : <Badge tone="warning">Late</Badge>}
                checked={quoteId === x.id}
                onChange={() => {
                  setQuoteId(x.id);
                  labelKey.current = newIdempotencyKey();
                }}
              />
            ))}
          </div>
        ) : (
          <>
            <Field label="Package weight" error={parcelTried && parcelBad.weight ? 'Enter the weight in pounds, like 1.5.' : ''}>
              <TextInput id="od-lb-weight" inputMode="decimal" suffix="lb" value={parcel.weight} error={parcelTried && parcelBad.weight} onChange={(e) => setParcel({ ...parcel, weight: e.target.value })} />
            </Field>
            <div className="grid md2 gap-3">
              <Field label="Length" optional error={parcelTried && parcelBad.dims ? 'Enter sizes in inches.' : ''}>
                <TextInput id="od-lb-l" inputMode="decimal" suffix="in" value={parcel.length} onChange={(e) => setParcel({ ...parcel, length: e.target.value })} />
              </Field>
              <Field label="Width" optional>
                <TextInput id="od-lb-w" inputMode="decimal" suffix="in" value={parcel.width} onChange={(e) => setParcel({ ...parcel, width: e.target.value })} />
              </Field>
              <Field label="Height" optional>
                <TextInput id="od-lb-h" inputMode="decimal" suffix="in" value={parcel.height} onChange={(e) => setParcel({ ...parcel, height: e.target.value })} />
              </Field>
            </div>
            <span className="xs muted">Prices are marked when the label keeps the arrival date promised to the buyer.</span>
          </>
        )}
      </Dialog>
    </SellerLayout>
  );
}
