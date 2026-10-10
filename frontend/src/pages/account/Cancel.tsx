import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { order, P, sellers, type SellerId } from '@/data/fixtures';
import { AccountLayout } from '@/layouts';
import { cx } from '@/lib/cx';
import { money } from '@/lib/format';
import { useView } from '@/lib/hooks';
import { href } from '@/routes/href';
import { Alert, Breadcrumbs, Button, Card, Field, Img, Select, SellerLine, StatusBadge, SummaryRow, Textarea, Timeline } from '@/ui';

// Design: pages/store/account-cancel.html · view "cancellation-requested" = after "Request cancellation".
// Only items the seller hasn't shipped can be cancelled; the coupon is split across items by price.

interface Line {
  p: string;
  variant: string;
  qty: number;
  price: number;
  seller: SellerId;
  state: string;
  eligible: boolean;
  note: ReactNode;
  link?: { label: string; to: string };
}

const LINES: Line[] = [
  { p: 'duvet', variant: 'Queen · Sage', qty: 1, price: 119, seller: 'casaverde', state: 'Delayed', eligible: true, note: <span className="xs t-success-text strong">Not shipped yet. Free to cancel.</span> },
  { p: 'ssd1tb', variant: 'Space gray', qty: 2, price: 94.99, seller: 'pixelport', state: 'In transit', eligible: false, note: <span className="xs sub">Already shipped. You can return it after delivery.</span>, link: { label: 'Track package', to: href('account/tracking') } },
  { p: 'aurora', variant: 'Midnight black', qty: 1, price: 189, seller: 'official', state: 'Delivered', eligible: false, note: <span className="xs sub">Delivered Sep 17. Return it instead, by Oct 17.</span>, link: { label: 'Return item', to: href('account/return-new') } },
  { p: 'pourover', variant: 'Cream', qty: 1, price: 36, seller: 'official', state: 'Return requested', eligible: false, note: <span className="xs sub">Return RT-260921-0457 is already open.</span>, link: { label: 'View return', to: href('account/return') } },
];

const REASONS = ['Choose a reason', "It's taking too long to arrive", 'I ordered by mistake', 'I found a better price', 'I no longer need it', 'Other'];
const SHORT: Record<string, string> = { duvet: 'Duvet cover' };

const couponShare = (l: Line) => Math.round(((order.discount * l.price * l.qty) / order.subtotal) * 100) / 100;

export default function Cancel() {
  const [view, setView] = useView<'cancellation-requested'>();
  const [selected, setSelected] = useState<string[]>(['duvet']);
  const [reason, setReason] = useState(REASONS[1]);
  const [note, setNote] = useState('');
  const [attempted, setAttempted] = useState(false);

  const chosen = LINES.filter((l) => selected.includes(l.p));
  const items = chosen.reduce((s, l) => s + l.price * l.qty, 0);
  const share = chosen.reduce((s, l) => s + couponShare(l), 0);
  const refund = items - share;
  const errors = {
    items: attempted && chosen.length === 0 ? 'Choose at least one item to cancel.' : undefined,
    reason: attempted && reason === REASONS[0] ? 'Choose a reason.' : undefined,
  };
  const toggle = (p: string) => setSelected((s) => (s.includes(p) ? s.filter((x) => x !== p) : [...s, p]));
  const submit = () => {
    setAttempted(true);
    if (chosen.length === 0 || reason === REASONS[0]) return;
    setView('cancellation-requested');
    window.scrollTo({ top: 0 });
  };
  const crumbs = <Breadcrumbs items={[{ label: 'Orders', to: href('account/orders') }, { label: order.ref, to: href('account/order') }, { label: 'Cancel items' }]} />;

  if (view === 'cancellation-requested') {
    const lines = chosen.length ? chosen : [LINES[0]];
    const amount = lines.reduce((s, l) => s + l.price * l.qty - couponShare(l), 0);
    const seller = sellers[lines[0].seller].name;
    return (
      <AccountLayout active="orders" title="Cancellation requested">
        {crumbs}
        <div className="acct-head">
          <div className="stack gap-1">
            <h1 className="h1 acct-h1">Cancellation requested</h1>
            <p className="small sub">
              Order <span className="mono">{order.ref}</span> · requested Thu, Oct 8, 2:31 PM PT
            </p>
          </div>
        </div>
        <Alert tone="success" title={`We sent your request to ${seller}`}>
          Your other items are not affected. Package 2 is still on its way and your return for the pour-over set continues as before.
        </Alert>
        <div className="acct-split">
          <div className="stack gap-4">
            <Card title={lines.length > 1 ? 'Items being cancelled' : 'Item being cancelled'}>
              {lines.map((l) => {
                const p = P[l.p];
                return (
                  <div key={l.p} className="row gap-3 nowrap top">
                    <Link to={href('store/product')} aria-label={p.name} className="link-inline">
                      <Img icon={p.icon} tint={p.tint} className="thumb" />
                    </Link>
                    <div className="stack gap-1 grow">
                      <Link className="small strong link-plain" to={href('store/product')}>
                        {p.name}
                      </Link>
                      <span className="xs muted">
                        {l.variant} · Qty {l.qty}
                      </span>
                      <SellerLine seller={l.seller} badge />
                    </div>
                    <StatusBadge status="Cancellation requested" />
                  </div>
                );
              })}
            </Card>
            <Card title="What happens next" titleAs="h3">
              <Timeline
                events={[
                  { t: 'You requested the cancellation', d: 'Thu, Oct 8, 2:31 PM', state: 'done' },
                  { t: `${seller} confirms`, d: 'By Fri, Oct 9, 5:00 PM PT', state: 'current', body: "The item hasn't shipped, so the seller should confirm. If they don't reply in time, Marketly cancels it for you." },
                  { t: 'Refund is processed', d: 'Within 1 business day of confirmation', body: 'Refund status changes to Processing.' },
                  { t: `Refund sent to ${order.payment}`, d: 'Status changes to Sent', body: "Your bank usually shows it within 3–5 business days after it's sent." },
                ]}
              />
            </Card>
          </div>
          <aside>
            <Card title="Refund" titleAs="h3">
              <div className="row between">
                <span className="small sub">Refund status</span>
                <StatusBadge status="Requested" />
              </div>
              {lines.map((l) => (
                <SummaryRow key={l.p} k={SHORT[l.p] ?? P[l.p].name} v={money(l.price * l.qty)} />
              ))}
              <SummaryRow k={`Coupon share (${order.coupon})`} v={`−${money(lines.reduce((s, l) => s + couponShare(l), 0))}`} />
              <SummaryRow k="Shipping" v={money(0)} />
              <hr />
              <SummaryRow className="total" k="Refund amount" v={money(amount)} />
              <SummaryRow k="Goes to" v={order.payment} />
              <span className="xs muted">Requested means no money has moved yet. We'll notify you at each step.</span>
            </Card>
            <div className="stack gap-2">
              <Button block to={href('account/order')}>
                Back to order
              </Button>
              <Button variant="secondary" block icon="message-square" to={href('account/messages')}>
                Message {seller}
              </Button>
            </div>
            <span className="xs muted">If the seller ships before confirming, you can refuse the delivery or return it free of charge.</span>
          </aside>
        </div>
      </AccountLayout>
    );
  }

  return (
    <AccountLayout
      active="orders"
      title="Cancel items"
      actionBar={
        <>
          <span className="stack gap-0 grow">
            <span className="xs muted">Refund estimate</span>
            <span className="strong num">{money(refund)}</span>
          </span>
          <Button onClick={submit}>Request cancellation</Button>
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
      {errors.items ? (
        <Alert tone="danger" title="Choose at least one item to cancel">
          Tick the items you want to cancel. Items that have already shipped can be returned after delivery instead.
        </Alert>
      ) : (
        <Alert tone="info" title="Cancellation cutoff: before the seller ships">
          You can cancel an item until its seller marks it shipped. After that, you can refuse delivery or return it once it arrives.
        </Alert>
      )}
      <div className="acct-split">
        <div className="stack gap-4">
          <section className="card" aria-label="Items in this order">
            {LINES.map((l) => {
              const p = P[l.p];
              const s = sellers[l.seller];
              return (
                <div key={l.p} className={cx('acct-check', !l.eligible && 'is-off')}>
                  <input type="checkbox" id={`cx-${l.p}`} aria-label={`Cancel ${p.name}`} checked={selected.includes(l.p)} disabled={!l.eligible} onChange={() => toggle(l.p)} />
                  <Img icon={p.icon} tint={p.tint} className="thumb" />
                  <div className="stack gap-1">
                    <label htmlFor={`cx-${l.p}`} className="small strong">
                      {p.name}
                    </label>
                    <span className="xs muted">
                      {l.variant} · Qty {l.qty} · {s.name}
                    </span>
                    <span className="row gap-2">
                      <StatusBadge status={l.state} />
                      {l.note}
                    </span>
                    {l.link && (
                      <Link className="xs strong" to={l.link.to}>
                        {l.link.label}
                      </Link>
                    )}
                  </div>
                  <div className="side stack gap-0">
                    {l.eligible ? (
                      <>
                        <span className="small strong num">{money(l.price * l.qty)}</span>
                        <span className="xs muted">Refund {money(l.price * l.qty - couponShare(l))}</span>
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
              <Select id="cx-reason" options={REASONS} value={reason} onChange={(e) => setReason(e.target.value)} className={cx(errors.reason && 'is-error')} />
            </Field>
            <Field label="Anything to add for the seller" optional>
              <Textarea id="cx-note" placeholder="For example: I need it before Oct 10." value={note} onChange={(e) => setNote(e.target.value)} />
            </Field>
          </Card>
        </div>
        <aside>
          <Card title="Refund preview" titleAs="h3">
            {chosen.map((l) => (
              <SummaryRow key={l.p} k={`${SHORT[l.p] ?? P[l.p].name}, Qty ${l.qty}`} v={money(l.price * l.qty)} />
            ))}
            <SummaryRow k={`Coupon share (${order.coupon})`} v={`−${money(share)}`} />
            <SummaryRow k="Shipping refund" v={money(0)} />
            <hr />
            <SummaryRow className="total" k="Estimated refund" v={money(refund)} />
            <SummaryRow k="Refund to" v={order.payment} />
            <span className="xs muted">Your {money(order.discount)} coupon is split across items by price, so the share for this item is deducted. Banks usually post refunds 3–5 business days after we send them.</span>
          </Card>
          <div className="only-desktop stack gap-2">
            <Button block onClick={submit}>
              Request cancellation
            </Button>
            <Button variant="ghost" block to={href('account/order')}>
              Keep my order
            </Button>
          </div>
          <span className="xs muted">Casa Verde Home has 1 business day to confirm. If they don't reply in time, Marketly cancels the item for you.</span>
        </aside>
      </div>
    </AccountLayout>
  );
}
