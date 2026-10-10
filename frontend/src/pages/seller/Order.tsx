import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { SellerLayout } from '@/layouts';
import { cx } from '@/lib/cx';
import { useCountdown, useView } from '@/lib/hooks';
import { money } from '@/lib/format';
import { href } from '@/routes/href';
import { Alert, Badge, Button, Card, Checkbox, Deadline, Dialog, Field, Icon, Img, KeyValue, PageHeader, Select, SummaryRow, Textarea, TextInput, Timeline, Track, announce, type TimelineEvent, type Tone } from '@/ui';

// Design: pages/seller/seller-order.html (to ship: record shipment form) · view "shipped" = the
// package recorded with UPS, a tracking correction and the delivery track. "Mark as shipped"
// validates carrier + tracking and moves the order to the shipped view; "Edit tracking" opens a dialog.

type View = 'shipped';
type Carrier = 'UPS' | 'USPS' | 'FedEx' | 'OnTrac' | 'Other';

const CARRIERS: Carrier[] = ['UPS', 'USPS', 'FedEx', 'OnTrac', 'Other'];
const SERVICES: Record<Carrier, string[]> = {
  UPS: ['UPS Ground', 'UPS 2nd Day Air'],
  USPS: ['USPS Ground Advantage', 'USPS Priority Mail'],
  FedEx: ['FedEx Ground', 'FedEx 2Day'],
  OnTrac: ['OnTrac Ground'],
  Other: ['Other service'],
};
const ARRIVAL: Record<string, string> = {
  'UPS 2nd Day Air': 'Sat, Oct 10',
  'USPS Priority Mail': 'Sat, Oct 10 – Mon, Oct 12',
  'FedEx 2Day': 'Sat, Oct 10',
};
const TRACKING: Record<Carrier, { re: RegExp; msg: string }> = {
  UPS: { re: /^1Z[0-9A-Z]{16}$/, msg: 'UPS tracking numbers start with 1Z and have 18 characters.' },
  USPS: { re: /^\d{20,22}$/, msg: 'USPS tracking numbers have 20 to 22 digits.' },
  FedEx: { re: /^(\d{12}|\d{15})$/, msg: 'FedEx tracking numbers have 12 or 15 digits.' },
  OnTrac: { re: /^[CD]\d{14}$/, msg: 'OnTrac tracking numbers start with C or D, then 14 digits.' },
  Other: { re: /^[0-9A-Z]{6,}$/, msg: 'Enter at least 6 letters or digits.' },
};
const normTracking = (s: string) => s.replace(/[\s-]/g, '').toUpperCase();
function trackingError(carrier: Carrier, raw: string) {
  const t = normTracking(raw);
  if (!t) return 'Enter the tracking number from your carrier label.';
  return TRACKING[carrier].re.test(t) ? '' : TRACKING[carrier].msg;
}

const ITEM = { name: 'Halden Pocket Bluetooth Speaker', variant: 'Teal', sku: 'NWA-PKT-TEAL', price: 59, ordered: 2 };
const FEE_RATE = 0.1;
const CANCEL_REASONS = ["Out of stock", 'Damaged in storage', 'Pricing error', "Can't ship to this address", 'Other'];
const EDIT_REASONS = ['Typo in the number', 'Carrier relabelled the package', 'Wrong carrier selected', 'Other'];

interface Pkg {
  carrier: Carrier;
  service: string;
  tracking: string;
  shipped: string;
  shippedShort: string;
  qty: number;
  changes: TimelineEvent[];
}
interface Msg {
  who: string;
  at: string;
  text: string;
  me?: boolean;
}

const SAMPLE_PKG: Pkg = {
  carrier: 'UPS',
  service: 'UPS Ground',
  tracking: '1Z7W4E910344712085',
  shipped: 'Oct 8, 2026, 2:32 PM PT',
  shippedShort: 'Oct 8, 2:32 PM',
  qty: 2,
  changes: [
    { t: <><span className="sr-only">At risk: </span>Tracking corrected</>, d: 'Oct 8, 2:40 PM · Avery Stone', state: 'warn', body: 'From 1Z7W4E910344712058 to 1Z7W4E910344712085. Reason: typo in last digits. Buyer was sent the corrected number.' },
    { t: 'Shipment recorded', d: 'Oct 8, 2:32 PM · Avery Stone', state: 'done' },
  ],
};

const MESSAGES: Msg[] = [
  { who: 'Sam R.', at: 'Oct 8, 9:20 AM', text: 'Hi, these are gifts. Could you leave the receipt out of the box?' },
  { who: 'You', at: 'Oct 8, 9:41 AM', text: 'Sure, the packing slip will show no prices. They ship today.', me: true },
];

/** The mock session clock (the design is set on Oct 8, 2026, around 10 AM PT). */
const nowTime = () => '10:14 AM';

function Countdown() {
  // 6 h 55 m to the 5:00 PM PT dispatch deadline at the design's 10:05 AM.
  const [h, m] = useCountdown(6 * 3600 + 55 * 60);
  return (
    <span className="big" role="timer">
      {Number(h)} h {Number(m)} m left
    </span>
  );
}

export default function Order() {
  const { ref = 'MK-261008-12077' } = useParams();
  const [view, setView] = useView<View>();
  const [packages, setPackages] = useState<Pkg[]>(() => (view === 'shipped' ? [SAMPLE_PKG] : []));
  const [ordered, setOrdered] = useState(ITEM.ordered);
  const [cancelled, setCancelled] = useState(0);
  const [log, setLog] = useState<TimelineEvent[]>([]);
  const [notice, setNotice] = useState<{ tone: 'success' | 'warning'; title: string; body: string } | null>(null);

  // Record shipment form
  const [carrier, setCarrier] = useState<Carrier>('UPS');
  const [service, setService] = useState(SERVICES.UPS[0]);
  const [tracking, setTracking] = useState('1Z 7W4 E91 03 4471 2085');
  const [shipDate, setShipDate] = useState('Oct 8, 2026');
  const [include, setInclude] = useState(true);
  const [pkQty, setPkQty] = useState(ITEM.ordered);
  const [tried, setTried] = useState(false);

  // Cancel form
  const [cxQty, setCxQty] = useState(1);
  const [cxReason, setCxReason] = useState(CANCEL_REASONS[0]);

  // Messages
  const [messages, setMessages] = useState(MESSAGES);
  const [reply, setReply] = useState('');
  const [replyErr, setReplyErr] = useState('');

  // Edit tracking dialog
  const [edit, setEdit] = useState<{ i: number; carrier: Carrier; tracking: string; reason: string; tried: boolean } | null>(null);

  const shippedQty = packages.reduce((a, p) => a + p.qty, 0);
  const remaining = ordered - shippedQty;
  const allShipped = ordered > 0 && remaining === 0;
  const allCancelled = ordered === 0;
  const status: { label: string; tone: Tone } = allCancelled
    ? { label: 'Cancelled', tone: '' }
    : allShipped
      ? { label: 'Shipped', tone: 'info' }
      : shippedQty > 0
        ? { label: 'Partly shipped', tone: 'warning' }
        : { label: 'New', tone: 'brand' };
  const itemBadge = allCancelled ? 'Cancelled' : allShipped ? 'Shipped' : shippedQty > 0 ? `${shippedQty} shipped · ${remaining} open` : 'Confirmed';
  const subtotal = ordered * ITEM.price;
  const fee = Math.round(subtotal * FEE_RATE * 100) / 100;
  const qtyInPkg = Math.min(pkQty, remaining);

  const errs = tried
    ? {
        tracking: trackingError(carrier, tracking),
        date: shipDate.trim() ? '' : 'Enter the ship date.',
        items: include ? '' : 'Choose at least one item for this package.',
      }
    : { tracking: '', date: '', items: '' };

  const changeCarrier = (c: Carrier) => {
    setCarrier(c);
    setService(SERVICES[c][0]);
  };

  const markShipped = () => {
    setTried(true);
    if (trackingError(carrier, tracking) || !shipDate.trim() || !include || remaining <= 0) {
      announce('Check the shipment details');
      return;
    }
    const t = nowTime();
    const pkg: Pkg = {
      carrier,
      service,
      tracking: normTracking(tracking),
      shipped: `${shipDate}, ${t} PT`,
      shippedShort: `${shipDate.replace(/, \d{4}$/, '')}, ${t}`,
      qty: qtyInPkg,
      changes: [{ t: 'Shipment recorded', d: `${shipDate.replace(/, \d{4}$/, '')}, ${t} · Avery Stone`, state: 'done' }],
    };
    setPackages((ps) => [...ps, pkg]);
    setTried(false);
    setTracking('');
    const left = remaining - qtyInPkg;
    setPkQty(left);
    setNotice(left ? { tone: 'success', title: 'Package recorded', body: `${qtyInPkg} of ${ordered} shipped with ${service}. The other ${left} keep${left === 1 ? 's' : ''} today's dispatch deadline.` } : null);
    announce(`Marked as shipped with ${service}. Sam was sent the tracking number.`);
    if (!left) setView('shipped');
  };

  const cancelItems = () => {
    const n = Math.min(cxQty, remaining);
    if (n <= 0) return;
    setOrdered((o) => o - n);
    setCancelled((c) => c + n);
    setPkQty(remaining - n);
    setCxQty(1);
    setLog((l) => [{ t: `${n} item${n > 1 ? 's' : ''} cancelled by you`, d: `Oct 8, ${nowTime()} · ${cxReason}`, state: 'done' }, ...l]);
    const body = `Sam was notified and refunded ${money(n * ITEM.price)}. This counts toward your cancellation rate.`;
    setNotice({ tone: 'warning', title: `${n} item${n > 1 ? 's' : ''} cancelled`, body });
    announce(body);
  };

  const send = () => {
    if (!reply.trim()) {
      setReplyErr('Write a message before sending.');
      return;
    }
    setMessages((m) => [...m, { who: 'You', at: `Oct 8, ${nowTime()}`, text: reply.trim(), me: true }]);
    setReply('');
    setReplyErr('');
    announce('Message sent to Sam');
  };

  const editErr = edit?.tried ? trackingError(edit.carrier, edit.tracking) || (normTracking(edit.tracking) === packages[edit.i]?.tracking && edit.carrier === packages[edit.i]?.carrier ? 'Enter the corrected tracking number.' : '') : '';
  const saveEdit = () => {
    if (!edit) return;
    const p = packages[edit.i];
    const err = trackingError(edit.carrier, edit.tracking) || (normTracking(edit.tracking) === p.tracking && edit.carrier === p.carrier ? 'x' : '');
    if (err) {
      setEdit({ ...edit, tried: true });
      return;
    }
    const next = normTracking(edit.tracking);
    const at = `Oct 8, ${nowTime()}`;
    const ev: TimelineEvent = { t: <><span className="sr-only">At risk: </span>Tracking corrected</>, d: `${at} · Avery Stone`, state: 'warn', body: `From ${p.tracking} to ${next}. Reason: ${edit.reason.toLowerCase()}. Buyer was sent the corrected number.` };
    setPackages((ps) => ps.map((x, j) => (j === edit.i ? { ...x, carrier: edit.carrier, service: edit.carrier === x.carrier ? x.service : SERVICES[edit.carrier][0], tracking: next, changes: [ev, ...x.changes] } : x)));
    setEdit(null);
    announce('Tracking updated. Sam was sent the corrected number.');
  };

  // Aside timeline: newest first.
  const shipEvents: TimelineEvent[] = [...packages].reverse().flatMap((p) => [
    ...p.changes.filter((c) => c.state === 'warn').map((c) => ({ t: c.t, d: c.d, state: c.state })),
    { t: `Shipped with ${p.service}`, d: `${p.shippedShort} · buyer notified`, state: 'done' as const },
  ]);
  const timeline: TimelineEvent[] = [
    ...(remaining > 0 ? [{ t: 'Waiting for shipment', d: 'Dispatch by Oct 8, 5:00 PM PT', state: 'current' as const }] : []),
    ...log,
    ...shipEvents,
    { t: 'Message from buyer answered', d: 'Oct 8, 9:41 AM', state: 'done' },
    { t: 'Fulfillment task created', d: 'Oct 8, 9:14 AM · deadline 5:00 PM', state: 'done' },
    { t: 'Payment accepted, items reserved', d: 'Oct 8, 9:14 AM', state: 'done' },
    { t: 'Order placed', d: 'Oct 8, 9:14 AM', state: 'done' },
  ];

  const lastShip = packages[packages.length - 1];

  return (
    <SellerLayout active="orders">
      <PageHeader
        crumbs={[{ label: 'Orders', to: href('seller/orders') }, { label: ref }]}
        title={
          <>
            Order <span className="mono">{ref}</span>
          </>
        }
        sub="Placed Oct 8, 2026, 9:14 AM PT · buyer Sam R. · payment accepted"
        actions={
          <>
            <Badge tone={status.tone}>{status.label}</Badge>
            <Button variant="secondary" size="sm" icon="printer" onClick={() => window.print()}>
              Print packing slip
            </Button>
          </>
        }
      />
      {allShipped && lastShip ? (
        <div className="sa-cd t-ok">
          <Icon name="circle-check" />
          <div className="stack gap-0 grow">
            <span className="strong">Shipped on time</span>
            <span className="xs sub">Dispatch deadline was today 5:00 PM PT · shipped {lastShip.shippedShort.replace(/^Oct 8, /, '')}</span>
          </div>
        </div>
      ) : allCancelled ? (
        <Alert tone="info" title="Order cancelled">
          Every item in this order was cancelled. Sam has been refunded.
        </Alert>
      ) : (
        <div className="sa-cd">
          <Icon name="alarm-clock" />
          <div className="stack gap-0 grow">
            <span className="xs sub strong">Dispatch by today, Oct 8, 5:00 PM PT</span>
            <Countdown />
          </div>
          <Deadline tone="warning">Due today 5:00 PM</Deadline>
        </div>
      )}
      {notice && (
        <Alert tone={notice.tone} title={notice.title}>
          {notice.body}
        </Alert>
      )}
      <div className="sa-split">
        <div className="stack gap-5">
          <Card title="Your items in this order" sub={`1 product · ${ordered} unit${ordered === 1 ? '' : 's'}${cancelled ? ` · ${cancelled} cancelled` : ''}`}>
            <div className="sa-pkgitem">
              <Img icon="speaker" tint="2" className="thumb" />
              <div className="stack gap-0 grow">
                <span className="small strong">{ITEM.name}</span>
                <span className="xs muted">
                  {ITEM.variant} · New · <span className="mono">{ITEM.sku}</span>
                </span>
                <span className="xs muted">
                  Qty {ordered} × {money(ITEM.price)}
                </span>
              </div>
              <div className="stack gap-1 u-items-flex-end">
                <b className="num">{money(subtotal)}</b>
                <Badge tone={allCancelled ? '' : 'info'}>{itemBadge}</Badge>
              </div>
            </div>
            <div className="panel row gap-2 small">
              <Icon name="info" className="ic-sm" />
              <span>The customer's order also has items from other sellers. You only see and handle your own items.</span>
            </div>
            <div className="stack gap-1">
              <SummaryRow k="Item subtotal" v={money(subtotal)} />
              <SummaryRow k="Shipping charged (Standard, free over $49)" v={money(0)} />
              <SummaryRow k="Platform fee (example 10%)" v={`−${money(fee)}`} />
              <div className="divider" />
              <SummaryRow className="total" k="Estimated earnings" v={money(subtotal - fee)} />
            </div>
            <p className="xs muted row gap-1 nowrap top">
              <Icon name="info" className="ic-sm" />
              <span className="wrap">Example fee rate. Earnings stay pending until delivery and the hold period end.</span>
            </p>
          </Card>

          {packages.map((p, i) => (
            <Card
              key={i}
              title={`Package ${i + 1} of ${packages.length}`}
              titleAs="h3"
              sub={p.qty === ITEM.ordered ? 'Both items shipped' : `${p.qty} of ${ITEM.ordered} items shipped`}
              actions={
                <Button variant="secondary" size="sm" icon="pencil" onClick={() => setEdit({ i, carrier: p.carrier, tracking: p.tracking, reason: EDIT_REASONS[0], tried: false })}>
                  Edit tracking
                </Button>
              }
            >
              <KeyValue
                pairs={[
                  ['Carrier', p.service],
                  [
                    'Tracking',
                    <>
                      <span className="mono">{p.tracking}</span> · <a href="#">Track</a>
                    </>,
                  ],
                  ['Shipped', p.shipped],
                  ['Contents', `${ITEM.name}, ${ITEM.variant} × ${p.qty}`],
                  ['Arrival estimate', ARRIVAL[p.service] ?? 'Mon, Oct 12 – Tue, Oct 13'],
                ]}
              />
              <Track labels={['Shipped', 'In transit', 'Out for delivery', 'Delivered']} done={1} />
              <div className="stack gap-2">
                <span className="xs strong">Tracking changes</span>
                <Timeline events={p.changes} />
              </div>
            </Card>
          ))}

          {remaining > 0 && (
            <>
              <Card
                title="Record shipment"
                titleAs="h3"
                sub="Add one package at a time. Items not in this package stay open."
                foot={
                  <Button icon="truck" onClick={markShipped}>
                    Mark as shipped
                  </Button>
                }
              >
                <div className="grid md2">
                  <Field label="Carrier">
                    <Select id="od-carrier" options={CARRIERS} value={carrier} onChange={(e) => changeCarrier(e.target.value as Carrier)} />
                  </Field>
                  <Field label="Tracking number" hint="We check the format and show it to the buyer." error={errs.tracking}>
                    <TextInput id="od-track" value={tracking} placeholder="From your carrier label" error={!!errs.tracking} autoComplete="off" spellCheck={false} onChange={(e) => setTracking(e.target.value)} />
                  </Field>
                  <Field label="Ship date" error={errs.date}>
                    <TextInput id="od-date" icon="calendar" value={shipDate} error={!!errs.date} onChange={(e) => setShipDate(e.target.value)} />
                  </Field>
                  <Field label="Shipping service">
                    <Select id="od-svc" options={SERVICES[carrier]} value={service} onChange={(e) => setService(e.target.value)} />
                  </Field>
                </div>
                <div className="stack gap-2">
                  <span className="label">Items in this package</span>
                  <div className="sa-pkgitem">
                    <span className="grow">
                      <Checkbox
                        id="od-pk1"
                        checked={include}
                        aria-describedby="od-pk1-hint"
                        onChange={(e) => setInclude(e.target.checked)}
                        label={
                          <span className="small">
                            <b>
                              {ITEM.name}, {ITEM.variant}
                            </b>
                            <br />
                            <span className="xs muted">
                              {remaining} {shippedQty ? 'still to ship' : 'ordered'} · {ITEM.sku}
                            </span>
                          </span>
                        }
                      />
                    </span>
                    <label className="sr-only" htmlFor="od-pkq">
                      Quantity in this package
                    </label>
                    <select className="select" id="od-pkq" value={qtyInPkg} onChange={(e) => setPkQty(Number(e.target.value))}>
                      {Array.from({ length: remaining }, (_, k) => remaining - k).map((n) => (
                        <option key={n} value={n}>
                          {n} of {remaining}
                        </option>
                      ))}
                    </select>
                  </div>
                  {errs.items ? (
                    <span className="error-text" id="od-pk1-hint">
                      <Icon name="circle-alert" className="ic-sm" />
                      {errs.items}
                    </span>
                  ) : (
                    <span className="hint" id="od-pk1-hint">
                      Shipping fewer than ordered creates a partial shipment. The rest keeps its dispatch deadline.
                    </span>
                  )}
                </div>
                <div className="panel row gap-2 small">
                  <Icon name="tag" className="ic-sm" />
                  <span>
                    Buy a UPS or USPS label here instead ·{' '}
                    <Link to={href('seller/shipping')} className="link-inline">
                      Buy label
                    </Link>
                  </span>
                </div>
              </Card>

              <Card
                title="Can't fulfill an item?"
                titleAs="h3"
                sub="Cancel only the items you can't ship"
                foot={
                  <Button variant="danger-soft" size="sm" onClick={cancelItems}>
                    Cancel selected items
                  </Button>
                }
              >
                <div className="grid md2">
                  <Field label="Item">
                    <Select id="od-cx-item" options={[`${ITEM.name}, ${ITEM.variant} (${remaining})`]} />
                  </Field>
                  <Field label="Quantity to cancel">
                    <select className="select" id="od-cx-qty" value={Math.min(cxQty, remaining)} onChange={(e) => setCxQty(Number(e.target.value))}>
                      {Array.from({ length: remaining }, (_, k) => k + 1).map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
                <Field label="Reason">
                  <Select id="od-cx-reason" options={CANCEL_REASONS} value={cxReason} onChange={(e) => setCxReason(e.target.value)} />
                </Field>
                <Alert tone="warning">Sam is notified right away and refunded for the cancelled items under the cancellation policy. Seller cancellations count toward your cancellation rate.</Alert>
              </Card>
            </>
          )}

          <Card
            title="Messages with Sam R."
            titleAs="h3"
            sub="Private to this order · reply within 24 h"
            actions={
              <Link className="small strong" to={href('seller/customers')}>
                Open in Customers
              </Link>
            }
          >
            {messages.map((m, i) => (
              <div className={cx('sa-msg', m.me && 'me')} key={i}>
                <span className="xs muted">
                  {m.who} · {m.at}
                </span>
                <p>{m.text}</p>
              </div>
            ))}
            <Field label="Reply" error={replyErr}>
              <Textarea id="od-reply" placeholder="Write to Sam" value={reply} onChange={(e) => (setReply(e.target.value), replyErr && setReplyErr(''))} />
            </Field>
            <div className="row end">
              <Button size="sm" icon="send" onClick={send}>
                Send message
              </Button>
            </div>
          </Card>
        </div>

        <aside className="stack gap-5 sa-sticky">
          <Card title="Ship to" titleAs="h3">
            <div className="stack gap-0 small">
              <span className="strong">Sam Rivera</span>
              <span>418 W Bannock St</span>
              <span>Boise, ID 83702</span>
              <span className="muted">Phone for carrier: (208) 555-0117</span>
            </div>
            <div className="divider" />
            <KeyValue
              pairs={[
                ['Method', 'Standard · UPS Ground or USPS'],
                ['Promised arrival', 'Mon, Oct 12 – Wed, Oct 14'],
                ['Gift note', 'Hide prices on packing slip'],
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
            <Button onClick={saveEdit}>Save tracking</Button>
          </>
        }
      >
        {edit && (
          <>
            <p className="small sub">
              Package {edit.i + 1} · currently <span className="mono">{packages[edit.i]?.tracking}</span>. The buyer is sent the corrected number.
            </p>
            <div className="grid md2">
              <Field label="Carrier">
                <Select id="od-ed-carrier" options={CARRIERS} value={edit.carrier} onChange={(e) => setEdit({ ...edit, carrier: e.target.value as Carrier })} />
              </Field>
              <Field label="Tracking number" error={editErr}>
                <TextInput id="od-ed-track" value={edit.tracking} error={!!editErr} autoComplete="off" spellCheck={false} onChange={(e) => setEdit({ ...edit, tracking: e.target.value })} />
              </Field>
            </div>
            <Field label="Reason">
              <Select id="od-ed-reason" options={EDIT_REASONS} value={edit.reason} onChange={(e) => setEdit({ ...edit, reason: e.target.value })} />
            </Field>
          </>
        )}
      </Dialog>
    </SellerLayout>
  );
}
