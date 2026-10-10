import { useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { order, P } from '@/data/fixtures';
import { AccountLayout } from '@/layouts';
import { money } from '@/lib/format';
import { useView } from '@/lib/hooks';
import { href } from '@/routes/href';
import { Alert, Breadcrumbs, Button, Card, CopyButton, Field, Icon, Img, OptionCard, Select, SellerLine, StatusBadge, Timeline, Track, type TimelineEvent } from '@/ui';

// Design: pages/store/account-tracking.html · view "delivery-failed" = the carrier's failed attempt,
// with the "Choose next step" form (redeliver, pick up, send back).

const LABELS = ['Shipped', 'In transit', 'Out for delivery', 'Delivered'];
const TRACKING = '9405 5112 9830 1847 2290 31';

const HISTORY: TimelineEvent[] = [
  { t: 'Departed USPS facility', d: 'Wed, Oct 7, 9:40 PM · Denver, CO', state: 'done' },
  { t: 'Accepted at USPS origin facility', d: 'Tue, Oct 6, 5:05 PM · Austin, TX', state: 'done' },
  { t: 'Shipping label created by Pixel & Port', d: 'Tue, Oct 6, 11:22 AM', state: 'done' },
  { t: 'Order placed', d: 'Mon, Sep 14, 7:42 PM', state: 'done' },
];
const IN_TRANSIT: TimelineEvent[] = [{ t: 'Arrived at USPS regional facility', d: 'Thu, Oct 8, 6:12 AM · Portland, OR', state: 'current', body: 'On schedule. Out for delivery Fri, Oct 9 or Sat, Oct 10.' }, ...HISTORY];
const FAILED: TimelineEvent[] = [
  { t: 'Delivery attempted. Signature required, no one available', d: 'Fri, Oct 9, 2:14 PM · Portland, OR 97205', state: 'danger', body: 'USPS left a notice. The package is at the Portland Main Post Office.' },
  { t: 'Out for delivery', d: 'Fri, Oct 9, 7:58 AM · Portland, OR 97205', state: 'done' },
  ...HISTORY,
];

type Choice = 'redel' | 'pickup' | 'return';
const CHOICES: Array<{ id: Choice; title: string; body: string; cost: ReactNode; confirm: string }> = [
  { id: 'redel', title: 'Schedule redelivery', body: 'USPS tries again on Sat, Oct 10 or Mon, Oct 12. Someone 18+ must sign.', cost: <span className="small strong">Free</span>, confirm: 'Confirm redelivery' },
  { id: 'pickup', title: 'Pick it up at the post office', body: 'Portland Main Post Office, 715 NW Hoyt St. Ready from Sat, Oct 10, 9:00 AM. Bring photo ID.', cost: <span className="small strong">Free</span>, confirm: 'Confirm pickup' },
  {
    id: 'return',
    title: 'Send it back to Pixel & Port',
    body: `You get a refund of ${money(189.98)} when it reaches the seller. If you don't choose by Oct 23, USPS returns it and the seller may deduct return shipping.`,
    cost: (
      <span className="small strong">
        $0.00 now
        <br />
        <span className="xs muted">$8.40 if auto-returned</span>
      </span>
    ),
    confirm: 'Send it back',
  },
];
const DATES = ['Sat, Oct 10', 'Mon, Oct 12'];

export default function Tracking() {
  const [view] = useView<'delivery-failed'>();
  const { ref = order.ref } = useParams();
  const failed = view === 'delivery-failed';
  const [choice, setChoice] = useState<Choice>('redel');
  const [date, setDate] = useState(DATES[0]);
  const [confirmed, setConfirmed] = useState<{ choice: Choice; date: string } | null>(null);
  const pkg = order.groups[1];
  const item = pkg.items[0];
  const p = P[item.p];
  const current = CHOICES.find((c) => c.id === choice)!;

  const confirmedText = confirmed
    ? confirmed.choice === 'redel'
      ? `Redelivery booked for ${confirmed.date}. Someone 18+ must be there to sign.`
      : confirmed.choice === 'pickup'
        ? 'Pick it up at Portland Main Post Office, 715 NW Hoyt St, from Sat, Oct 10, 9:00 AM. Bring photo ID.'
        : `USPS will send it back to Pixel & Port. Your refund of ${money(189.98)} starts when the seller receives it.`
    : '';

  return (
    <AccountLayout active="orders" title="Track package">
      <Breadcrumbs items={[{ label: 'Orders', to: href('account/orders') }, { label: ref, to: href('account/order', '', { ref }) }, { label: 'Package 2 of 3' }]} />
      <div className="acct-head">
        <div className="stack gap-1">
          <h1 className="h1 acct-h1">Track package</h1>
          <p className="small sub">
            Package 2 of 3 · Order{' '}
            <Link className="mono" to={href('account/order', '', { ref })}>
              {ref}
            </Link>
          </p>
        </div>
      </div>
      {failed &&
        (confirmed ? (
          <Alert tone="success" title="Got it. We've passed your choice to USPS and Pixel & Port">
            {confirmedText}
          </Alert>
        ) : (
          <Alert tone="danger" title="Delivery failed. Choose what happens next by Fri, Oct 23">
            USPS couldn't deliver because this package needs a signature. Nothing has been lost. Pick an option below and we'll pass it to USPS and Pixel &amp; Port.
          </Alert>
        ))}
      <div className="acct-split">
        <div className="stack gap-4">
          <section className="card pad stack gap-4">
            <div className="row between top">
              {failed ? (
                <div className="stack gap-1">
                  <span className="eyebrow">Delivery attempt failed</span>
                  <span className="h2">{confirmed ? current.title : 'Waiting for your choice'}</span>
                  <span className="small sub">Held at Portland Main Post Office until Fri, Oct 23</span>
                </div>
              ) : (
                <div className="stack gap-1">
                  <span className="eyebrow">Estimated delivery</span>
                  <span className="h2">Fri, Oct 9 – Sat, Oct 10</span>
                  <span className="small sub">By 8:00 PM · to Jordan Lee, Portland, OR 97205</span>
                </div>
              )}
              <StatusBadge status={failed ? 'Delivery failed' : 'In transit'} />
            </div>
            <Track labels={LABELS} done={failed ? 3 : 2} tone={failed ? 'danger' : undefined} />
            <div className="grid md2 gap-3">
              <div className="panel stack gap-1">
                <span className="acct-k">Carrier</span>
                <span className="small strong">USPS Priority Mail</span>
                <a className="xs" href={`https://tools.usps.com/go/TrackConfirmAction?tLabels=${TRACKING.replace(/\s/g, '')}`} target="_blank" rel="noreferrer">
                  Open on usps.com <Icon name="external-link" className="ic-sm" />
                </a>
              </div>
              <div className="panel stack gap-1">
                <span className="acct-k">Tracking number</span>
                <span className="row gap-1 nowrap">
                  <span className="mono small strong">{TRACKING}</span>
                  <CopyButton text={TRACKING} label="Copy tracking number" />
                </span>
              </div>
            </div>
          </section>

          {failed && !confirmed && (
            <Card
              title="Choose next step"
              sub="Example costs. Final costs follow the carrier and seller terms."
              foot={
                <Button icon="check" onClick={() => setConfirmed({ choice, date })}>
                  {current.confirm}
                </Button>
              }
            >
              <div className="stack gap-2" role="radiogroup" aria-label="Next step">
                {CHOICES.map((c) => (
                  <OptionCard key={c.id} id={`fail-${c.id}`} name="fail" checked={choice === c.id} onChange={() => setChoice(c.id)} title={<span className="strong">{c.title}</span>} body={c.body} right={c.cost} />
                ))}
              </div>
              {choice === 'redel' && (
                <Field label="Date for redelivery">
                  <Select id="fail-date" options={DATES} value={date} onChange={(e) => setDate(e.target.value)} />
                </Field>
              )}
            </Card>
          )}

          <Card title="Tracking history" titleAs={failed ? 'h3' : 'h2'} sub="Times in Pacific Time. Updates come from USPS.">
            <Timeline events={failed ? FAILED : IN_TRANSIT} />
          </Card>
        </div>
        <aside>
          <Card title="In this package" titleAs="h3">
            <div className="row gap-3 nowrap top">
              <Link to={href('store/product')} aria-label={p.name}>
                <Img icon={p.icon} tint={p.tint} className="thumb" />
              </Link>
              <div className="stack gap-1">
                <Link className="small strong link-plain" to={href('store/product')}>
                  {p.name}
                </Link>
                <span className="xs muted">
                  {item.variant} · Qty {item.qty}
                </span>
                <SellerLine seller="pixelport" badge />
              </div>
            </div>
            <span className="xs muted">Ships from Austin, TX. Other items in this order travel in separate packages.</span>
          </Card>
          <Card title="Other packages" titleAs="h3" flush>
            <div className="list pad">
              <Link className="li" to={href('account/order', '', { ref })}>
                <span className="grow small">Package 1 · Marketly Official</span>
                <StatusBadge status="Delivered" />
              </Link>
              <Link className="li" to={href('account/order', '', { ref })}>
                <span className="grow small">Package 3 · Casa Verde Home</span>
                <StatusBadge status="Delayed" />
              </Link>
            </div>
          </Card>
          <Card title="Something wrong?" titleAs="h3">
            <div className="stack gap-2">
              <Button variant="secondary" block icon="package-x" to={href('help/order-problem')}>
                Report missing or damaged
              </Button>
              <Button variant="secondary" block icon="message-square" to={href('account/messages')}>
                Contact Pixel &amp; Port
              </Button>
              <Button variant="ghost" block icon="life-buoy" to={href('help/contact')}>
                Get help from Marketly
              </Button>
            </div>
            <span className="xs muted">If tracking shows delivered but you don't have it, wait until the end of the next day, then report it.</span>
          </Card>
        </aside>
      </div>
    </AccountLayout>
  );
}
