import { Fragment, useState } from 'react';
import { useNavigate } from 'react-router';
import { CheckoutLayout } from '@/layouts';
import { money } from '@marketly/web-shared/lib/format';
import type { Tint } from '@marketly/web-shared/data/fixtures';
import { href } from '@marketly/web-shared/routes';
import { Alert, Badge, Button, Card, Dialog, Icon, Img, OptionCard, SummaryRow, type IconName } from '@marketly/web-shared/ui';
import { BuyMini, CheckoutSteps, SecN } from './data/purchase';

// Design: pages/store/store-checkout-review-changes.html: the checkout re-check found changes
// before charging; the shopper picks what to do with each one and the new total updates live.

interface Choice {
  id: string;
  label: string;
  /** Change to the previous total if picked. */
  delta: number;
  /** Row in the "what changed" summary (omitted when the choice changes nothing). */
  row?: string;
  sub?: string;
  /** Alternative offer shown under the choice. */
  alt?: { seller: string; official?: boolean; line: string; note?: string };
}

interface Change {
  key: string;
  icon: IconName;
  tint: Tint;
  kind: string;
  name: string;
  /** Background order line. */
  line: { name: string; sub: string; amount: number };
  delta: { from?: string; to?: string; text?: string; note: string };
  explain?: string;
  choices: Choice[];
}

const PREVIOUS_TOTAL = 370.38;

const CHANGES: Change[] = [
  {
    key: 'ssd',
    icon: 'hard-drive',
    tint: '6',
    kind: 'Price went up',
    name: 'Kestrel 1 TB Portable SSD, USB 3.2',
    line: { name: 'Kestrel 1 TB Portable SSD, USB 3.2', sub: 'Pixel & Port · Qty 1', amount: 94.99 },
    delta: { from: '$94.99', to: '$99.99 each', note: '· Pixel & Port · Qty 1' },
    choices: [
      { id: 'a', label: 'Accept the new price, $99.99', delta: 5, row: 'Price change · SSD' },
      { id: 'r', label: 'Remove this item', delta: -94.99, row: 'SSD removed' },
      { id: 'o', label: 'Choose another offer', delta: 2.5, row: 'Other offer · SSD', alt: { seller: 'Marketly Official', official: true, line: 'New · $97.49 · Free shipping · Arrives Thu, Oct 15 · 30-day free returns', note: 'Different seller. Only switched if you pick this.' } },
    ],
  },
  {
    key: 'spk',
    icon: 'speaker',
    tint: '2',
    kind: 'Less stock available',
    name: 'Halden Pocket Bluetooth Speaker',
    line: { name: 'Halden Pocket Bluetooth Speaker', sub: 'Northwind Audio · Qty 2', amount: 118 },
    delta: { text: 'Qty 2', to: '1 available', note: '· Northwind Audio' },
    choices: [
      { id: 'a', label: 'Buy the 1 available from Northwind Audio', sub: 'Your total goes down by $59.00.', delta: -59, row: 'One fewer speaker' },
      { id: 'r', label: 'Remove this item', delta: -118, row: 'Speakers removed' },
      { id: 'o', label: 'Choose another offer for both', delta: 8.99, row: 'Other offer · speakers', alt: { seller: 'Pixel & Port', line: 'New · $61.00 each · 6 in stock · $4.99 shipping · Arrives Fri, Oct 16 · 30-day returns' } },
    ],
  },
  {
    key: 'duv',
    icon: 'bed-double',
    tint: '1',
    kind: 'Delivery date moved',
    name: 'Mosswood Washed Linen Duvet Cover, Queen',
    line: { name: 'Mosswood Washed Linen Duvet Cover, Queen', sub: 'Casa Verde Home · Qty 1', amount: 119 },
    delta: { from: 'Mon, Oct 19', to: 'Wed, Oct 21 – Thu, Oct 22', note: '· Casa Verde Home' },
    explain: 'Casa Verde Home now ships in 4 business days because of a restock.',
    choices: [
      { id: 'a', label: 'Keep it with the new date', delta: 0 },
      { id: 'r', label: 'Remove this item', delta: -119, row: 'Duvet cover removed' },
    ],
  },
  {
    key: 'po',
    icon: 'coffee',
    tint: '3',
    kind: 'Coupon no longer covers this item',
    name: 'Mosswood Ceramic Pour-over Coffee Set',
    line: { name: 'Mosswood Ceramic Pour-over Coffee Set', sub: 'Marketly Official · Qty 1', amount: 36 },
    delta: { text: 'HOMEWEEK10 ended at 12:00 PM PT', note: '· Pour-over set loses −$3.60' },
    explain: 'Your other items keep their discounts. WELCOME20 still applies.',
    choices: [
      { id: 'a', label: 'Keep it at full price, $36.00', delta: 3.6, row: 'HOMEWEEK10 removed' },
      { id: 'r', label: 'Remove this item', delta: -32.4, row: 'Pour-over set removed' },
    ],
  },
];

const signed = (n: number) => `${n < 0 ? '−' : '+'}${money(Math.abs(n))}`;

export default function CheckoutReviewChanges() {
  const navigate = useNavigate();
  const [picked, setPicked] = useState<Record<string, string>>(() => Object.fromEntries(CHANGES.map((c) => [c.key, 'a'])));
  const chosen = CHANGES.map((c) => c.choices.find((x) => x.id === picked[c.key]) ?? c.choices[0]);
  const newTotal = Math.round((PREVIOUS_TOTAL + chosen.reduce((s, x) => s + x.delta, 0)) * 100) / 100;
  const keptAny = chosen.some((x) => x.id !== 'r');

  return (
    <CheckoutLayout>
      <div className="container page">
        <div className="stack gap-3">
          <h1 className="h1">Checkout</h1>
          <CheckoutSteps current={4} />
        </div>
        <div className="split">
          <div className="stack gap-4">
            <section className="card">
              <div className="card-head">
                <div className="row gap-3 nowrap">
                  <SecN n={6} />
                  <h2 className="h4">Review your order</h2>
                </div>
              </div>
              <div className="card-body">
                {CHANGES.map((c, i) => (
                  <Fragment key={c.key}>
                    {i > 0 && <hr />}
                    <BuyMini icon={c.icon} tint={c.tint} name={c.line.name} sub={c.line.sub} amount={money(c.line.amount)} clamp={false} />
                  </Fragment>
                ))}
              </div>
            </section>
          </div>
          <aside>
            <Card title="Order total" titleAs="h3">
              <SummaryRow className="total" k="Total" v={money(PREVIOUS_TOTAL)} />
              <Button size="lg" block disabled>
                Place order · {money(PREVIOUS_TOTAL)}
              </Button>
            </Card>
          </aside>
        </div>
      </div>

      <Dialog
        open
        size="lg"
        onClose={() => navigate(href('store/checkout'))}
        title="Some details changed before you placed your order"
        foot={
          <>
            <Button variant="secondary" to={href('store/cart')}>
              Back to cart
            </Button>
            {keptAny ? (
              <Button to={href('store/checkout')}>Accept changes and continue · {money(newTotal)}</Button>
            ) : (
              <Button to={href('store/cart')}>Remove all and go back to cart</Button>
            )}
          </>
        }
      >
        <p className="small sub">We checked your order again before charging you. Nothing has been charged yet. Choose what to do with each change.</p>
        {CHANGES.map((c) => (
          <div className="buy-change" key={c.key}>
            <div className="buy-change-head">
              <Img icon={c.icon} tint={c.tint} />
              <div className="stack gap-1 grow">
                <span className="xs strong t-warning-text">{c.kind}</span>
                <span className="small strong">{c.name}</span>
                <span className="buy-delta">
                  {c.delta.from && <span className="buy-strike">{c.delta.from}</span>}
                  {c.delta.text && !c.delta.to && (
                    <>
                      {c.delta.text} <span className="xs muted">{c.delta.note}</span>
                    </>
                  )}
                  {c.delta.text && c.delta.to && <span>{c.delta.text}</span>}
                  {c.delta.to && (
                    <>
                      <Icon name="arrow-right" className="ic-sm" />
                      <span>{c.delta.to}</span>
                      <span className="xs muted">{c.delta.note}</span>
                    </>
                  )}
                </span>
              </div>
            </div>
            {c.explain && <span className="xs muted">{c.explain}</span>}
            <div className="buy-opts">
              {c.choices.map((x) => (
                <OptionCard
                  key={x.id}
                  id={`rc-${c.key}-${x.id}`}
                  name={`rc-${c.key}`}
                  checked={picked[c.key] === x.id}
                  onChange={() => setPicked((p) => ({ ...p, [c.key]: x.id }))}
                  title={
                    <>
                      <span className="small strong">{x.label}</span>
                      {(x.sub || x.alt) && (
                        <span className="small sub">
                          {x.sub}
                          {x.alt && (
                            <span className="buy-alt stack gap-1 mt-1-5 u-d-flex">
                              <span className="row gap-2">
                                <b>{x.alt.seller}</b>
                                {x.alt.official ? (
                                  <Badge tone="brand" icon="badge-check">
                                    Official
                                  </Badge>
                                ) : (
                                  <Badge tone="info" icon="shield-check">
                                    Verified
                                  </Badge>
                                )}
                              </span>
                              <span>{x.alt.line}</span>
                              {x.alt.note && <span className="xs muted">{x.alt.note}</span>}
                            </span>
                          )}
                        </span>
                      )}
                    </>
                  }
                />
              ))}
            </div>
          </div>
        ))}
        <Alert tone="info" title="If you remove an item, the rest of your order can still go through">
          You'll only be charged for the items you keep. We'll show the revised packages and total on the review step before you place the order.
        </Alert>
        <div className="panel buy-sum">
          <SummaryRow k="Previous total" v={<span className="buy-strike">{money(PREVIOUS_TOTAL)}</span>} />
          {chosen.map((x, i) => (x.row && x.delta ? <SummaryRow key={CHANGES[i].key} k={x.row} v={signed(x.delta)} /> : null))}
          <SummaryRow className="total" k="New total" v={money(newTotal)} />
        </div>
      </Dialog>
    </CheckoutLayout>
  );
}
