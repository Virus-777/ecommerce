import { useState } from 'react';
import { Link } from 'react-router';
import { P } from '@/data/fixtures';
import { AccountLayout } from '@/layouts';
import { money } from '@/lib/format';
import { useView } from '@/lib/hooks';
import { href } from '@/routes/href';
import { Alert, announce, Badge, Breadcrumbs, Button, Card, CopyButton, Img, SellerLine, StatusBadge, SummaryRow, Timeline, Track, type TimelineEvent } from '@/ui';

// Design: pages/store/account-return.html · views: "" = approved, send it back (QR drop-off);
// "refund-sent" = inspected and refunded; "replacement-on-the-way" = the replacement remedy shipped.

type View = 'refund-sent' | 'replacement-on-the-way';

const ORDER_REF = 'MK-260914-48213';
const RETURN_TRACKING = '1Z84E2W79014433610';
const REPL_TRACKING = '1Z84E2W70392055102';
const ITEM = 36;
const COUPON = 1.35;

/** Drop-off QR code (25×25 modules), as drawn in the design. */
const QR = [
  '#######...#.......#######',
  '#.....#....#..#...#.....#',
  '#.###.#..#......#.#.###.#',
  '#.###.#.#...#.....#.###.#',
  '#.###.#.##.##.##..#.###.#',
  '#.....#.##..####..#.....#',
  '#######.#.##..#...#######',
  '.........................',
  '...#.#..#.####......#....',
  '.#..###..###.#.......#.##',
  '#.#.#....#.########......',
  '#....##....######..###.##',
  '####..#.#.###.#.#........',
  '..###...#####...###.#.##.',
  '..#.#.#..#...#..#.....#.#',
  '###.#...#.#.#.#.....##..#',
  '....#...#.#..#.#.#.....#.',
  '........#..#.##.#.#....#.',
  '#######...#...#..#.......',
  '#.....#.#.###.##.#.#....#',
  '#.###.#.##...#..##..#..#.',
  '#.###.#..#..#.....###..##',
  '#.###.#........#.#.#..###',
  '#.....#..#..##.#.#.#.##.#',
  '#######..#.#.#.#.##.#.###',
];

function QrCode({ label }: { label: string }) {
  return (
    <svg className="acct-qr" viewBox="0 0 25 25" fill="currentColor" role="img" aria-label={label}>
      {QR.flatMap((row, y) => [...row].map((c, x) => (c === '#' ? <rect key={`${x}-${y}`} x={x} y={y} width="1.02" height="1.02" /> : null)))}
    </svg>
  );
}

const RETURN_LABELS = ['Requested', 'Approved', 'Sent back', 'Received', 'Inspected', 'Refunded'];
const REFUND_LABELS = ['Requested', 'Under review', 'Approved', 'Processing', 'Sent'];

const RECEIVED: TimelineEvent[] = [
  { t: 'Received at Marketly Reno warehouse', d: 'Mon, Oct 12, 3:40 PM', state: 'done' },
  { t: 'Dropped off at The UPS Store', d: 'Fri, Oct 9, 11:12 AM · Portland, OR', state: 'done' },
  { t: 'Return approved', d: 'Tue, Sep 22', state: 'done' },
];

function ReturnShipment({ view, as }: { view: View | ''; as: 'h2' | 'h3' }) {
  const events: TimelineEvent[] =
    view === ''
      ? [
          { t: 'Waiting for drop-off', d: 'Drop off by Thu, Oct 15', state: 'current', body: 'The label activates when UPS scans your QR code.' },
          { t: 'Return approved by Marketly Official', d: 'Tue, Sep 22, 9:30 AM', state: 'done' },
          { t: 'Return requested', d: 'Mon, Sep 21, 6:02 PM', state: 'done' },
        ]
      : [
          {
            t: 'Inspected. Damage confirmed',
            d: 'Tue, Oct 13, 10:05 AM · Marketly Reno',
            state: 'done',
            body: view === 'refund-sent' ? 'Chipped cup matches your photos. Approved for a full refund.' : 'Chipped cup matches your photos. Replacement approved.',
          },
          ...RECEIVED,
        ];
  return (
    <Card title="Return shipment" titleAs={as} sub="Separate from the original delivery">
      <div className="row between">
        <span className="stack gap-0">
          <span className="small strong">
            UPS Ground · <span className="mono">{RETURN_TRACKING}</span>
          </span>
          <span className="xs muted">From Portland, OR to Reno, NV</span>
        </span>
        {view === '' ? <Badge>Waiting for drop-off</Badge> : <StatusBadge status="Delivered" />}
      </div>
      <Timeline events={events} />
    </Card>
  );
}

function Questions() {
  return (
    <Card title="Questions about this return?" titleAs="h3">
      <div className="stack gap-2">
        <Button variant="secondary" block icon="message-square" to={href('account/messages')}>
          Message Marketly Official
        </Button>
        <Button variant="ghost" block icon="life-buoy" to={href('help/case')}>
          Open a support case
        </Button>
      </div>
    </Card>
  );
}

export default function Return() {
  const [rawView] = useView<View>();
  const view: View | '' = rawView === 'refund-sent' || rawView === 'replacement-on-the-way' ? rawView : '';
  // Mock: every return URL shows the sample return from the design (the pour-over set).
  const ref = 'RT-260921-0457';
  const [emailed, setEmailed] = useState(false);
  const p = P.pourover;
  const refund = ITEM - COUPON;

  const emailCode = () => {
    setEmailed(true);
    announce('We emailed the drop-off code to jordan.lee@example.com');
  };

  const product = (
    <div className="row gap-3 nowrap top">
      <Link to={href('store/product')} aria-label={p.name}>
        <Img icon={p.icon} tint={p.tint} className="thumb" />
      </Link>
      <div className="stack gap-1 grow">
        <Link className="small strong link-plain" to={href('store/product')}>
          {p.name}
        </Link>
        <span className="xs muted">Cream · Qty 1 · Reason: arrived damaged, one cup chipped</span>
        <SellerLine seller="official" badge />
      </div>
    </div>
  );

  return (
    <AccountLayout active="returns" title="Return details">
      <Breadcrumbs items={[{ label: 'Returns and refunds', to: href('account/returns') }, { label: ref }]} />
      <div className="acct-head">
        <div className="stack gap-1">
          <h1 className="h1 acct-h1">
            Return <span className="mono">{ref}</span>
          </h1>
          <p className="small sub">
            Order{' '}
            <Link className="mono" to={href('account/order')}>
              {ORDER_REF}
            </Link>{' '}
            · requested Mon, Sep 21
          </p>
        </div>
        <div className="acts">
          <Button variant="soft" size="sm" icon="life-buoy" to={href('help/order-problem')}>
            Get help
          </Button>
        </div>
      </div>

      <section className="card pad stack gap-4">
        {product}
        <div className="stack gap-2">
          <span className="row gap-2">
            <span className="acct-k">Return</span>
            {view === '' && <StatusBadge status="Approved" />}
            {view === 'refund-sent' && <Badge tone="success">Refunded</Badge>}
            {view === 'replacement-on-the-way' && (
              <>
                <Badge tone="info">Inspected</Badge>
                <span className="xs muted">Remedy: replacement</span>
              </>
            )}
          </span>
          <Track labels={view === 'replacement-on-the-way' ? [...RETURN_LABELS.slice(0, 5), 'Replaced'] : RETURN_LABELS} done={view === '' ? 2 : 6} />
        </div>
      </section>

      <div className="acct-split">
        <div className="stack gap-4">
          {view === '' && (
            <>
              {emailed ? (
                <Alert tone="success" title="Code sent to jordan.lee@example.com">
                  Show it at any UPS drop-off point by Thu, Oct 15. Your refund starts once we receive and inspect the item.
                </Alert>
              ) : (
                <Alert tone="info" title="Approved means you can send it back">
                  Your refund hasn't been sent yet. It starts once we receive and inspect the item.
                </Alert>
              )}
              <Card title="Send it back by Thu, Oct 15" sub="Prepaid by Marketly. No printer or box label needed.">
                <div className="row gap-5 top">
                  <QrCode label={`Drop-off QR code for ${ref}`} />
                  <div className="stack gap-3 grow minw-220">
                    <ol className="ol small sub stack gap-2">
                      <li>Pack the set in any box with padding. Include all cups and the dripper.</li>
                      <li>Take it to any UPS drop-off point. Nearest: The UPS Store, 1022 SW Morrison St, Portland (0.4 mi).</li>
                      <li>Show this QR code. The staff print the label and give you a receipt.</li>
                    </ol>
                    <div className="row gap-2">
                      <Button variant="secondary" size="sm" icon={emailed ? 'check' : 'mail'} onClick={emailCode} disabled={emailed}>
                        {emailed ? 'Code emailed' : 'Email me the code'}
                      </Button>
                      <Button variant="ghost" size="sm" icon="printer" onClick={() => window.print()}>
                        Print label instead
                      </Button>
                    </div>
                    <span className="xs muted">Ships to Marketly Returns, 1180 Kleppe Ln, Sparks, NV 89431 (Reno warehouse).</span>
                  </div>
                </div>
              </Card>
              <ReturnShipment view={view} as="h3" />
            </>
          )}

          {view === 'refund-sent' && (
            <>
              <Alert tone="success" title={`Refund of ${money(refund)} sent on Wed, Oct 14`}>
                Sent to Visa •••• 4417. Most banks show it within 3–5 business days. If it isn't there by Oct 21, ask your bank about reference <span className="mono">74K2 9310 5521 0846</span>.
              </Alert>
              <ReturnShipment view={view} as="h2" />
            </>
          )}

          {view === 'replacement-on-the-way' && (
            <>
              <Alert tone="success" title="Your replacement has shipped">
                We received and inspected the chipped set, so a new one is on its way. You chose a replacement, so no refund is due. Order{' '}
                <Link className="mono" to={href('account/order')}>
                  {ORDER_REF}
                </Link>{' '}
                stays as it was: same receipt, same total.
              </Alert>
              <Card
                title="Replacement shipment"
                sub="Its own shipment record, separate from your return and from the original delivery"
                foot={
                  <>
                    <span className="xs muted grow">If the replacement arrives damaged, report it from this page. It's covered by a new 30-day return window.</span>
                    <Button variant="ghost" size="sm" to={href('help/order-problem')}>
                      Report a problem
                    </Button>
                  </>
                }
              >
                <div className="row gap-3 nowrap top">
                  <Link to={href('store/product')} aria-label={p.name} className="link-inline">
                    <Img icon={p.icon} tint={p.tint} className="thumb" />
                  </Link>
                  <div className="stack gap-1 grow">
                    <Link className="small strong link-plain" to={href('store/product')}>
                      {p.name}
                    </Link>
                    <span className="xs muted">Cream · Qty 1 · Replacement for return {ref} · No charge</span>
                    <SellerLine seller="official" badge />
                  </div>
                  <StatusBadge status="In transit" />
                </div>
                <div className="grid md3 gap-3">
                  <div className="panel stack gap-1">
                    <span className="acct-k">Estimated delivery</span>
                    <span className="small strong">Fri, Oct 16</span>
                    <span className="xs muted">By 8:00 PM to Portland, OR 97205</span>
                  </div>
                  <div className="panel stack gap-1">
                    <span className="acct-k">Carrier</span>
                    <span className="small strong">UPS Ground</span>
                    <span className="xs muted">From Marketly Reno warehouse</span>
                  </div>
                  <div className="panel stack gap-1">
                    <span className="acct-k">Tracking number</span>
                    <span className="row gap-1 nowrap">
                      <span className="mono small strong">{REPL_TRACKING}</span>
                      <CopyButton text={REPL_TRACKING} label="Copy tracking number" />
                    </span>
                  </div>
                </div>
                <Track labels={['Shipped', 'In transit', 'Out for delivery', 'Delivered']} done={2} />
                <Timeline
                  events={[
                    { t: 'In transit', d: 'Wed, Oct 14, 4:18 AM · Medford, OR', state: 'current' },
                    { t: 'Replacement shipped', d: 'Tue, Oct 13, 2:40 PM · Reno, NV', state: 'done', body: 'New package with its own label. Your return shipment and the original Package 1 keep their own records.' },
                  ]}
                />
              </Card>
              <ReturnShipment view={view} as="h3" />
            </>
          )}
        </div>

        <aside>
          {view === 'replacement-on-the-way' ? (
            <>
              <Card title="Remedy" titleAs="h3">
                <div className="row between">
                  <span className="small sub">You chose</span>
                  <Badge tone="brand" icon="refresh-cw">
                    Replacement
                  </Badge>
                </div>
                <SummaryRow k="Item returned" v={money(ITEM)} />
                <SummaryRow k="Replacement sent" v="Same item, no charge" />
                <SummaryRow k="Return shipping" v="Free" />
                <hr />
                <SummaryRow className="total" k="Refund due" v={money(0)} />
                <span className="xs muted">No refund is due because you're getting the same item again. Nothing changes on your card or on the original order.</span>
              </Card>
              <Card title="Original order" titleAs="h3">
                <div className="row between">
                  <Link className="mono small strong" to={href('account/order')}>
                    {ORDER_REF}
                  </Link>
                  <StatusBadge status="Partly delivered" />
                </div>
                <span className="xs sub">Placed Sep 14 · $513.98 · unchanged. The pour-over set still shows there as delivered in Package 1, with this return linked to it.</span>
              </Card>
            </>
          ) : (
            <Card title="Refund" titleAs="h3">
              <div className="row between">
                <span className="small sub">Refund status</span>
                <StatusBadge status={view === 'refund-sent' ? 'Sent' : 'Requested'} />
              </div>
              <Track labels={REFUND_LABELS} done={view === 'refund-sent' ? 5 : 1} />
              <span className="xs sub">
                {view === 'refund-sent'
                  ? 'Sent means it left Marketly. Your bank posts it next.'
                  : "The refund moves to Under review when the item arrives. Approved still means the money hasn't been sent. Sent means it left Marketly."}
              </span>
              <hr />
              <SummaryRow k="Item" v={money(ITEM)} />
              <SummaryRow k="Coupon share (WELCOME20)" v={`−${money(COUPON)}`} />
              <SummaryRow k="Return shipping" v="Free" />
              <hr />
              <SummaryRow className="total" k={view === 'refund-sent' ? 'Refunded' : 'Expected refund'} v={money(refund)} />
              <SummaryRow k="To" v="Visa •••• 4417" />
            </Card>
          )}
          <Questions />
        </aside>
      </div>
    </AccountLayout>
  );
}
