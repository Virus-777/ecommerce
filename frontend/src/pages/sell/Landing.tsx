import { useState } from 'react';
import { Link } from 'react-router';
import { StoreLayout } from '@/layouts';
import { money } from '@marketly/web-shared/lib/format';
import { href } from '@marketly/web-shared/routes';
import { Badge, Button, Field, Icon, Select, SummaryRow, TableWrap, TextInput, Timeline, type IconName, type TimelineEvent } from '@marketly/web-shared/ui';

// Design: pages/store/sell-landing.html · the "How a sale works out" card is a live fee calculator
// (its default, the 10% example on a $100 item, is the design's state).

const CATEGORIES: Array<{ icon: IconName; name: string }> = [
  { icon: 'headphones', name: 'Electronics' },
  { icon: 'monitor', name: 'Computers' },
  { icon: 'cooking-pot', name: 'Home & Kitchen' },
  { icon: 'shirt', name: 'Fashion' },
  { icon: 'tent', name: 'Sports & Outdoors' },
  { icon: 'sparkles', name: 'Beauty' },
  { icon: 'puzzle', name: 'Toys & Games' },
  { icon: 'paw-print', name: 'Pet Supplies' },
];

const REQUIREMENTS: Array<{ icon: IconName; title: string; body: string }> = [
  { icon: 'building-2', title: 'A US business or sole proprietor', body: 'With an EIN or SSN for tax reporting.' },
  { icon: 'landmark', title: 'A US bank account', body: "In the business or owner's name, for payouts." },
  { icon: 'map-pin', title: 'A US return address', body: 'Street address that can receive returns.' },
  { icon: 'truck', title: 'Ship with tracking', body: 'Within your stated dispatch time, at most 3 business days.' },
  { icon: 'message-square', title: 'Answer customers', body: 'Within 1 business day, Monday to Friday.' },
];

const FEES: Array<{ category: string; rate: number }> = [
  { category: 'Electronics', rate: 8 },
  { category: 'Computers', rate: 7 },
  { category: 'Home & Kitchen', rate: 12 },
  { category: 'Fashion', rate: 15 },
  { category: 'Sports & Outdoors', rate: 12 },
  { category: 'Beauty', rate: 15 },
];
const EXAMPLE = 'example';

const PAYOUT: TimelineEvent[] = [
  { t: 'Customer receives the order', state: 'done', body: 'Earnings show as Pending in Seller Center.' },
  { t: '7-day hold after delivery', state: 'done', body: 'Covers early returns and delivery problems.' },
  { t: 'Earnings become Available', state: 'done' },
  { t: 'Weekly payout every Tuesday', state: 'current', body: 'Sent to your verified bank account; arrives in 1–2 business days.' },
];

const SERVICE: Array<[string, string]> = [
  ['Dispatch on time', 'At least 95% of orders shipped by the dispatch deadline'],
  ['Tracking', 'Valid tracking on at least 95% of packages'],
  ['Customer messages', 'Reply within 1 business day'],
  ['Return requests', 'Answer within 2 business days'],
  ['Seller cancellations', 'Below 2.5% of orders'],
];

const STEPS: Array<[string, string]> = [
  ['Create your seller account', 'Contact, business and store details.'],
  ['Verify your business', 'Identity, tax details, payout account and return address.'],
  ['Accept the agreement', 'Seller agreement, product rules, fee schedule and service standards.'],
  ['We review your application', 'Usually 3–5 business days. We may ask for more information.'],
  ['Set up your store', 'Shipping coverage, store profile and your first products or offers.'],
  ['Go live', 'We check launch readiness. Only approved products and offers are published.'],
];

const FAQ: Array<[string, string]> = [
  ['Do I need my own product listings?', 'No. If the product is already in our catalog, you add an offer to it: your price, condition, stock and dispatch time. New products need catalog approval first.'],
  ['Can I sell the same product as the Official Store?', 'Yes. Customers compare all offers on the product page. The main offer is chosen by a published rule based on eligibility, availability, delivery and total price.'],
  ['What does Verified seller mean?', "We checked your business registration, owner identity, payout account and return address. It doesn't certify each product."],
  ['What happens if I miss targets?', 'We contact you first. Repeated issues can lead to a restriction with a stated reason, the affected activity and an appeal route. Existing orders continue.'],
  ['Who handles returns?', "You do, using your return address and our return baseline. We step in if a customer needs help and you haven't replied in time."],
];

export default function Landing() {
  const [price, setPrice] = useState('100.00');
  const [cat, setCat] = useState(EXAMPLE);
  const rate = cat === EXAMPLE ? 10 : (FEES.find((f) => f.category === cat)?.rate ?? 10);
  const amount = Number(price.replace(/[$,]/g, ''));
  const valid = price.trim() !== '' && Number.isFinite(amount) && amount >= 0;
  const commission = valid ? Math.round(amount * rate) / 100 : 0;

  return (
    <StoreLayout appbar={{ title: 'Sell on Marketly', back: href('store/home') }}>
      <div className="container page gap-8">
        <section className="buy-sell-hero">
          <div className="stack gap-4">
            <span className="eyebrow u-c-text-inverse u-o-_7">Sell on Marketly</span>
            <h1 className="display d-xl">Reach shoppers in one store, next to our own products</h1>
            <p className="h-sub">List your offers on our shared catalog, ship your own orders and get paid weekly. We review every seller so customers trust who they buy from.</p>
            <div className="row gap-2">
              <Button size="lg" iconRight="arrow-right" to={href('sell/apply')}>
                Start your application
              </Button>
              <a
                className="btn btn-lg btn-ghost u-c-text-inverse"
                href="#sell-fees"
                onClick={(e) => {
                  e.preventDefault();
                  document.getElementById('sell-fees')?.scrollIntoView({ behavior: 'smooth' });
                }}
              >
                <span>See fees</span>
              </a>
            </div>
            <span className="xs u-o-_7">
              Takes about 20 minutes. Save a draft anytime. Already applied?{' '}
              <Link to={href('sell/status')} className="link-inline u-c-text-inverse">
                Check your status
              </Link>
            </span>
          </div>
          <div className="buy-sell-stats">
            <div>
              <span className="xs u-o-_75">Launch categories</span>
              <b>{CATEGORIES.length}</b>
            </div>
            <div>
              <span className="xs u-o-_75">Example commission</span>
              <b>7–15%</b>
            </div>
            <div>
              <span className="xs u-o-_75">Example payouts</span>
              <b>Weekly</b>
            </div>
            <div>
              <span className="xs u-o-_75">Monthly fee at launch</span>
              <b>$0</b>
            </div>
          </div>
        </section>
        <div className="grid lg2 gap-6">
          <section className="stack gap-3">
            <h2 className="h2">What you can sell</h2>
            <div className="grid m2 gap-2">
              {CATEGORIES.map((c) => (
                <div key={c.name} className="row gap-2 nowrap panel">
                  <Icon name={c.icon} className="ic-sm" />
                  <span className="small">{c.name}</span>
                </div>
              ))}
            </div>
            <p className="xs muted">New, used and refurbished physical goods in these categories. Not at launch: digital goods, subscriptions, gift cards, perishable food, weapons, recalled or restricted items.</p>
          </section>
          <section className="stack gap-3">
            <h2 className="h2">Seller requirements</h2>
            <ul className="stack gap-3">
              {REQUIREMENTS.map((r) => (
                <li key={r.title} className="buy-feature">
                  <Icon name={r.icon} />
                  <span className="stack gap-0">
                    <span className="small strong">{r.title}</span>
                    <span className="xs muted">{r.body}</span>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        </div>
        <section className="stack gap-4" id="sell-fees">
          <h2 className="h2">Fees</h2>
          <div className="split">
            <div className="card">
              <TableWrap label="Fees table">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Category</th>
                      <th className="r" scope="col">
                        Commission (example)
                      </th>
                      <th scope="col">Charged on</th>
                    </tr>
                  </thead>
                  <tbody>
                    {FEES.map((f) => (
                      <tr key={f.category}>
                        <td>{f.category}</td>
                        <td className="r">
                          <span className="strong">{f.rate}%</span>
                        </td>
                        <td>Item price after your discounts</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            </div>
            <div className="card pad stack gap-3">
              <span className="small strong">How a sale works out</span>
              <div className="grid m2 gap-2">
                <Field label="Item price" error={valid ? undefined : 'Enter a price, like 100.00.'}>
                  <TextInput id="fee-price" prefix="$" inputMode="decimal" ctl="sm" value={price} error={!valid} onChange={(e) => setPrice(e.target.value)} />
                </Field>
                <Field label="Category">
                  <Select id="fee-cat" ctl="sm" options={[{ value: EXAMPLE, label: 'Example (10%)' }, ...FEES.map((f) => ({ value: f.category, label: `${f.category} (${f.rate}%)` }))]} value={cat} onChange={(e) => setCat(e.target.value)} />
                </Field>
              </div>
              <div className="buy-sum" aria-live="polite">
                <SummaryRow k="Item sold" v={money(valid ? amount : 0)} />
                <SummaryRow k={`Commission at ${rate}%${cat === EXAMPLE ? ' (example)' : ''}`} v={`−${money(commission)}`} />
                <SummaryRow className="total" k="Your earnings" v={money(valid ? amount - commission : 0)} />
              </div>
              <span className="xs muted">Shipping you charge isn't commissioned. Discounts funded by Marketly don't reduce your earnings. No listing or monthly fees at launch.</span>
            </div>
          </div>
          <p className="xs muted">Example rates. Final fees are in the seller agreement and fee schedule you accept when you apply.</p>
        </section>
        <div className="grid lg2 gap-6">
          <section className="card pad stack gap-3">
            <h2 className="h3">When you get paid</h2>
            <Timeline events={PAYOUT} />
            <p className="xs muted">Example schedule. Final payout timing is in the seller agreement. Holds always show a reason and review date.</p>
          </section>
          <section className="card pad stack gap-3">
            <h2 className="h3">Who ships</h2>
            <div className="buy-feature">
              <Icon name="package" />
              <span className="stack gap-1">
                <span className="row gap-2">
                  <span className="small strong">You ship your own orders</span>
                  <Badge tone="success">At launch</Badge>
                </span>
                <span className="xs muted">Set your shipping rates, coverage and dispatch time. Pack, ship and add tracking in Seller Center by the dispatch deadline.</span>
              </span>
            </div>
            <div className="buy-feature">
              <Icon name="warehouse" />
              <span className="stack gap-1">
                <span className="row gap-2">
                  <span className="small strong">Marketly fulfillment</span>
                  <Badge>Later</Badge>
                </span>
                <span className="xs muted">Store stock in our warehouse and we ship for you. You stay the named seller and own the stock.</span>
              </span>
            </div>
          </section>
        </div>
        <section className="stack gap-4">
          <h2 className="h2">Service expectations</h2>
          <div className="card">
            <TableWrap label="Service expectations table">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Measure</th>
                    <th scope="col">Target</th>
                  </tr>
                </thead>
                <tbody>
                  {SERVICE.map(([m, t]) => (
                    <tr key={m}>
                      <td>{m}</td>
                      <td>{t}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          </div>
          <p className="xs muted">Example targets. Final targets are in the service standards. You see your results in Seller Center under Account health.</p>
        </section>
        <section className="stack gap-4">
          <h2 className="h2">How to join</h2>
          <ol className="buy-steps-list grid md2 lg3">
            {STEPS.map(([t, d]) => (
              <li key={t}>
                <span className="stack gap-1">
                  <span className="small strong">{t}</span>
                  <span className="xs muted">{d}</span>
                </span>
              </li>
            ))}
          </ol>
        </section>
        <section className="split">
          <div className="stack gap-3">
            <h2 className="h2">Questions sellers ask</h2>
            <div className="card pad buy-faq">
              {FAQ.map(([q, a], i) => (
                <details key={q} open={i === 0}>
                  <summary>
                    {q}
                    <Icon name="chevron-down" className="ic-sm" />
                  </summary>
                  <p>{a}</p>
                </details>
              ))}
            </div>
          </div>
          <aside className="card pad stack gap-3" style={{ alignSelf: 'start' }}>
            <h2 className="h3">Ready to apply?</h2>
            <p className="small sub">Have your business registration, tax ID, bank details and return address ready.</p>
            <Button block to={href('sell/apply')}>
              Start your application
            </Button>
            <span className="xs muted">Questions first? Email sellers@marketly.example or call 1-800-555-0177, Mon–Fri 8 AM–5 PM PT.</span>
          </aside>
        </section>
      </div>
    </StoreLayout>
  );
}
