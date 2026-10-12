import { Fragment, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { useSession } from '@/app/session';
import { CheckoutLayout } from '@/layouts';
import { useView } from '@marketly/web-shared/lib/hooks';
import { money } from '@marketly/web-shared/lib/format';
import { sellers, type SellerId } from '@marketly/web-shared/data/fixtures';
import { href } from '@marketly/web-shared/routes';
import { Alert, Avatar, Badge, Button, Card, Checkbox, Dialog, Field, Icon, OptionCard, Select, SellerBadge, SummaryRow, TextInput, announce } from '@marketly/web-shared/ui';
import { BuyMini, CARD, CheckoutSteps, COUPON_WELCOME, ORDER_ITEMS, ORDER_LINES, SecN, groupBySeller, pkgMeta, plural, standardShipping } from './data/purchase';

// Design: pages/store/store-checkout.html
//   view "guest-checkout"  = signed out: contact + address + card forms (also shown when the session is signed out)
//   view "coupon-rejected" = AUTUMN15 rejected (also reached by applying AUTUMN15)
// Place order: saved card -> confirmation; digital wallet -> payment result "checking payment";
// a new card numbered 4000 0000 0000 0002 (the usual decline test number) -> payment result "failed".

type View = 'guest-checkout' | 'coupon-rejected';
type Pay = 'visa' | 'new' | 'wallet';

interface Addr {
  id: string;
  label: string;
  name: string;
  line1: string;
  line2: string;
  city: string;
  state: string;
  zip: string;
  phone: string;
  isDefault?: boolean;
}

const SAVED_ADDRESSES: Addr[] = [
  { id: 'a1', label: 'Home', name: 'Jordan Lee', line1: '2140 Alder St', line2: 'Apt 5', city: 'Portland', state: 'Oregon', zip: '97205', phone: '(503) 555-0148', isDefault: true },
  { id: 'a2', label: 'Work', name: 'Jordan Lee', line1: '815 SW 2nd Ave', line2: 'Floor 4', city: 'Portland', state: 'Oregon', zip: '97204', phone: '(503) 555-0199' },
];
const STATES = ['Oregon', 'Washington', 'California', 'Idaho'];
const STATE_CODE: Record<string, string> = { Oregon: 'OR', Washington: 'WA', California: 'CA', Idaho: 'ID' };
/** Sales tax on items, by delivery state (Oregon has none). */
const TAX_RATE: Record<string, number> = { Oregon: 0, Washington: 0.065, California: 0.0725, Idaho: 0.06 };
const CREDIT = 12.5;
const DECLINE_TEST_CARD = '4000000000000002';
const GROUPS = groupBySeller(ORDER_LINES);
const EMPTY_ADDR: Addr = { id: '', label: 'New address', name: 'Jordan Lee', line1: '', line2: '', city: '', state: 'Oregon', zip: '', phone: '' };

const digits = (s: string) => s.replace(/\D/g, '');
const luhn = (n: string) => {
  let sum = 0;
  for (let i = 0; i < n.length; i++) {
    let d = Number(n[n.length - 1 - i]);
    if (i % 2) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return sum % 10 === 0;
};

type Errors = Partial<Record<string, string>>;

function addressErrors(a: Addr, prefix: string): Errors {
  const e: Errors = {};
  if (!a.name.trim()) e[`${prefix}name`] = 'Enter the name for delivery.';
  if (digits(a.phone).length < 10) e[`${prefix}phone`] = 'Enter a 10-digit phone number.';
  if (!a.line1.trim()) e[`${prefix}line1`] = 'Enter a street address.';
  if (!a.city.trim()) e[`${prefix}city`] = 'Enter a city.';
  if (!/^\d{5}$/.test(a.zip.trim())) e[`${prefix}zip`] = 'Enter a 5-digit ZIP code, like 97205.';
  return e;
}

/** Re-mount when the view or the session changes, so each design state starts from its own data. */
export default function Checkout() {
  const [view] = useView<View>();
  const { signedIn } = useSession();
  return <CheckoutPage key={`${view}-${signedIn}`} />;
}

function CheckoutPage() {
  const navigate = useNavigate();
  const [view] = useView<View>();
  const { signedIn, customer } = useSession();
  const guest = view === 'guest-checkout' || !signedIn;
  const rejectedView = view === 'coupon-rejected' && !guest;

  const [addresses, setAddresses] = useState<Addr[]>(SAVED_ADDRESSES);
  const [addrId, setAddrId] = useState('a1');
  const [ship, setShip] = useState<Partial<Record<SellerId, number>>>({});
  const [coupon, setCoupon] = useState<string | null>(guest ? null : COUPON_WELCOME.code);
  const [code, setCode] = useState(rejectedView ? 'AUTUMN15' : '');
  const [codeError, setCodeError] = useState(rejectedView ? "AUTUMN15 can't be used on this order." : '');
  const [rejected, setRejected] = useState(rejectedView ? 'AUTUMN15' : '');
  const [credit, setCredit] = useState(false);
  const [pay, setPay] = useState<Pay>(guest ? 'new' : 'visa');
  const [contact, setContact] = useState({ email: customer.email, phone: customer.phone, account: false });
  const [ga, setGa] = useState<Addr>({ ...SAVED_ADDRESSES[0], id: 'guest', label: '' });
  const [card, setCard] = useState({ name: customer.name, number: '', exp: '', cvc: '', sameBilling: true });
  const [attempted, setAttempted] = useState(false);
  const [draft, setDraft] = useState<Addr | null>(null);
  const [draftTried, setDraftTried] = useState(false);

  const address = guest ? ga : (addresses.find((a) => a.id === addrId) ?? addresses[0]);

  /* ---------- totals ---------- */
  const shipping = GROUPS.map((g) => {
    const opts = pkgMeta(g.seller).options;
    const i = ship[g.seller] ?? 0;
    const items = g.lines.reduce((s, l) => s + l.price * l.qty, 0);
    return { seller: g.seller, i, opt: opts[i], cost: i === 0 ? standardShipping(g.seller, items) : opts[i].price };
  });
  const discount = coupon ? COUPON_WELCOME.amount : 0;
  const creditUsed = credit && !guest ? CREDIT : 0;
  const shipTotal = shipping.reduce((s, x) => s + x.cost, 0);
  const rate = TAX_RATE[address.state] ?? 0;
  const tax = Math.round((ORDER_ITEMS - discount) * rate * 100) / 100;
  const total = ORDER_ITEMS - discount - creditUsed + shipTotal + tax;
  const nItems = ORDER_LINES.reduce((s, l) => s + l.qty, 0);

  /* ---------- validation ---------- */
  const errors: Errors = {};
  if (guest) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email.trim())) errors.email = 'Enter an email address, like name@example.com.';
    if (digits(contact.phone).length < 10) errors.gphone = 'Enter a 10-digit phone number.';
    Object.assign(errors, addressErrors(ga, 'a-'));
  }
  if (pay === 'new') {
    const n = digits(card.number);
    if (!card.name.trim()) errors.cardName = 'Enter the name on the card.';
    if (n.length < 13 || n.length > 19 || !luhn(n)) errors.cardNumber = 'Enter a valid card number.';
    const m = card.exp.match(/^\s*(0[1-9]|1[0-2])\s*\/\s*(\d{2})\s*$/);
    if (!m || Number(m[2]) * 12 + Number(m[1]) < 26 * 12 + 10) errors.cardExp = 'Enter an expiry date that has not passed, like 09 / 29.';
    if (!/^\d{3,4}$/.test(card.cvc.trim())) errors.cardCvc = 'Enter the 3 or 4 digit security code.';
  }
  const shown: Errors = attempted ? errors : {};
  const nErrors = Object.keys(shown).length;

  /* ---------- actions ---------- */
  const applyCode = (e: FormEvent) => {
    e.preventDefault();
    const c = code.trim().toUpperCase();
    setRejected('');
    if (!c) return setCodeError('Enter a coupon code.');
    if (c === 'AUTUMN15') {
      setRejected(c);
      return setCodeError(`${c} can't be used on this order.`);
    }
    if (c === COUPON_WELCOME.code) {
      if (guest) return setCodeError(`${c} is an account coupon. Sign in to use it.`);
      if (coupon) return setCodeError(`${c} is already applied.`);
      setCoupon(c);
      setCode('');
      setCodeError('');
      announce(`${c} applied`);
      return;
    }
    setCodeError(`${c} isn't a valid coupon code. Check the spelling and try again.`);
  };

  const placeOrder = () => {
    setAttempted(true);
    const n = Object.keys(errors).length;
    if (n) {
      announce(`Check ${plural(n, 'field')} before placing your order`);
      return;
    }
    if (pay === 'wallet') navigate(href('store/payment-result', 'checking-payment'));
    else if (pay === 'new' && digits(card.number) === DECLINE_TEST_CARD) navigate(href('store/payment-result'));
    else navigate(href('store/confirmation'));
  };

  const draftErrors = draft && draftTried ? addressErrors(draft, '') : {};
  const saveDraft = () => {
    if (!draft) return;
    setDraftTried(true);
    if (Object.keys(addressErrors(draft, '')).length) return;
    const id = `n${addresses.length + 1}`;
    setAddresses((l) => [...l, { ...draft, id }]);
    setAddrId(id);
    setDraft(null);
  };

  /* ---------- design state ---------- */
  const current = guest ? 1 : rejected ? 3 : 4;
  const couponDone = !guest && !rejected;
  const payDone = !guest;

  const addressLines = (a: Addr) => (
    <>
      {a.name}
      <br />
      {a.line1}
      {a.line2 && `, ${a.line2}`}
      <br />
      {a.city}, {STATE_CODE[a.state] ?? a.state} {a.zip}
      <br />
      {a.phone}
    </>
  );

  const addrField = (a: Addr, set: (a: Addr) => void, prefix: string, errs: Errors, idp: string) => (
    <>
      <div className="grid md2">
        <Field label="Full name" error={errs[`${prefix}name`]}>
          <TextInput id={`${idp}name`} value={a.name} error={!!errs[`${prefix}name`]} autoComplete="name" onChange={(e) => set({ ...a, name: e.target.value })} />
        </Field>
        <Field label="Phone" error={errs[`${prefix}phone`]}>
          <TextInput id={`${idp}phone`} type="tel" value={a.phone} error={!!errs[`${prefix}phone`]} autoComplete="tel" onChange={(e) => set({ ...a, phone: e.target.value })} />
        </Field>
      </div>
      <Field label="Street address" error={errs[`${prefix}line1`]}>
        <TextInput id={`${idp}line1`} value={a.line1} error={!!errs[`${prefix}line1`]} autoComplete="address-line1" onChange={(e) => set({ ...a, line1: e.target.value })} />
      </Field>
      <Field label="Apartment, suite, floor" optional>
        <TextInput id={`${idp}line2`} value={a.line2} autoComplete="address-line2" onChange={(e) => set({ ...a, line2: e.target.value })} />
      </Field>
      <div className="grid md3">
        <Field label="City" error={errs[`${prefix}city`]}>
          <TextInput id={`${idp}city`} value={a.city} error={!!errs[`${prefix}city`]} autoComplete="address-level2" onChange={(e) => set({ ...a, city: e.target.value })} />
        </Field>
        <Field label="State">
          <Select id={`${idp}state`} options={STATES} value={a.state} onChange={(e) => set({ ...a, state: e.target.value })} />
        </Field>
        <Field label="ZIP code" error={errs[`${prefix}zip`]}>
          <TextInput id={`${idp}zip`} value={a.zip} error={!!errs[`${prefix}zip`]} inputMode="numeric" autoComplete="postal-code" onChange={(e) => set({ ...a, zip: e.target.value })} />
        </Field>
      </div>
    </>
  );

  return (
    <CheckoutLayout>
      <div className="container page gap-5">
        <div className="stack gap-3">
          <Link className="small strong" to={href('store/cart')}>
            <Icon name="arrow-left" className="ic-sm" /> Back to cart
          </Link>
          <h1 className="h1">Checkout</h1>
          <CheckoutSteps current={current} />
        </div>
        <div className="split">
          <div className="stack gap-4">
            {/* 1. Account / contact */}
            <section className="card">
              <div className="card-head">
                <div className="row gap-3 nowrap">
                  <SecN n={1} done />
                  <h2 className="h4">{guest ? 'Contact details' : 'Account'}</h2>
                </div>
              </div>
              <div className="card-body">
                {guest ? (
                  <>
                    <div className="row between">
                      <span className="small sub">Checking out as a guest.</span>
                      <Link className="small strong" to={href('auth/sign-in')}>
                        Sign in instead
                      </Link>
                    </div>
                    <div className="grid md2">
                      <Field label="Email" hint="We'll email a link to view and manage this order." error={shown.email}>
                        <TextInput id="co-g-email" type="email" value={contact.email} error={!!shown.email} autoComplete="email" onChange={(e) => setContact({ ...contact, email: e.target.value })} />
                      </Field>
                      <Field label="Mobile phone" hint="Only for delivery updates about this order." error={shown.gphone}>
                        <TextInput id="co-g-phone" type="tel" value={contact.phone} error={!!shown.gphone} autoComplete="tel" onChange={(e) => setContact({ ...contact, phone: e.target.value })} />
                      </Field>
                    </div>
                    <Checkbox id="co-g-acct" label="Create an account after checkout so I can track all my orders in one place" checked={contact.account} onChange={(e) => setContact({ ...contact, account: e.target.checked })} />
                    <Alert tone="info" title="You can still manage this order without an account">
                      Use the link in your confirmation email, or look it up anytime with your order reference and email under{' '}
                      <Link to={href('auth/guest-orders')} className="link-inline">
                        Guest order lookup
                      </Link>
                      .
                    </Alert>
                  </>
                ) : (
                  <div className="row gap-3">
                    <Avatar name={customer.name} />
                    <div className="stack gap-0 grow">
                      <span className="small strong">Signed in as {customer.name}</span>
                      <span className="xs muted">{customer.email} · Order updates go here</span>
                    </div>
                    <Link className="small strong" to={href('auth/sign-in')}>
                      Switch account
                    </Link>
                  </div>
                )}
              </div>
            </section>

            {/* 2. Address */}
            <section className="card">
              <div className="card-head">
                <div className="row gap-3 nowrap">
                  <SecN n={2} done />
                  <h2 className="h4">Delivery address</h2>
                </div>
              </div>
              <div className="card-body">
                {guest ? (
                  addrField(ga, setGa, 'a-', shown, 'co-a-')
                ) : (
                  <>
                    <div className="buy-opts c2">
                      {addresses.map((a) => (
                        <OptionCard
                          key={a.id}
                          id={`co-addr-${a.id}`}
                          name="co-addr"
                          checked={addrId === a.id}
                          onChange={() => setAddrId(a.id)}
                          title={
                            <span className="row gap-2">
                              <span className="strong small">{a.label}</span>
                              {a.isDefault && <Badge>Default</Badge>}
                            </span>
                          }
                          body={addressLines(a)}
                        />
                      ))}
                    </div>
                    <div className="row between">
                      <Button
                        variant="ghost"
                        size="sm"
                        icon="plus"
                        onClick={() => {
                          setDraft({ ...EMPTY_ADDR });
                          setDraftTried(false);
                        }}
                      >
                        Add a new address
                      </Button>
                      <span className="xs muted">Changing an address here doesn't update your saved addresses.</span>
                    </div>
                  </>
                )}
                <div className="buy-note t-success">
                  <Icon name="circle-check" />
                  <span>
                    <b>All {plural(nItems, 'item')} can ship to this address.</b>{' '}
                    {guest ? "We checked each seller's delivery area." : `Delivery dates below are for ${address.city}, ${STATE_CODE[address.state] ?? address.state} ${address.zip}.`}
                  </span>
                </div>
              </div>
            </section>

            {/* 3. Delivery options */}
            <section className="card">
              <div className="card-head">
                <div className="row gap-3 nowrap">
                  <SecN n={3} done />
                  <h2 className="h4">Delivery options for each package</h2>
                </div>
              </div>
              <div className="card-body">
                <p className="xs muted">Your items ship in {plural(GROUPS.length, 'package')} from different places, so each has its own options and arrival date.</p>
                {GROUPS.map((g, gi) => {
                  const opts = pkgMeta(g.seller).options;
                  return (
                    <Fragment key={g.seller}>
                      {gi > 0 && <hr />}
                      <div className="stack gap-2">
                        <div className="row between">
                          <span className="row gap-2">
                            <span className="small strong">
                              Package {gi + 1} of {GROUPS.length}: {sellers[g.seller].name}
                            </span>
                            <SellerBadge seller={sellers[g.seller]} compact />
                          </span>
                          <span className="xs muted">{g.lines.map((l) => l.short).join(' · ')}</span>
                        </div>
                        <div className="buy-opts c2">
                          {opts.map((o, i) => {
                            const cost = i === 0 ? shipping[gi].cost : o.price;
                            return (
                              <OptionCard
                                key={i}
                                id={`co-ship-${g.seller}-${i}`}
                                name={`co-ship-${g.seller}`}
                                checked={shipping[gi].i === i}
                                onChange={() => setShip((s) => ({ ...s, [g.seller]: i }))}
                                title={
                                  <span className="row between">
                                    <span className="strong small">Arrives {o.arrives}</span>
                                    <span className="small strong num">{cost ? money(cost) : 'Free'}</span>
                                  </span>
                                }
                                body={o.desc}
                              />
                            );
                          })}
                        </div>
                      </div>
                    </Fragment>
                  );
                })}
              </div>
            </section>

            {/* 4. Coupons */}
            <section className="card">
              <div className="card-head">
                <div className="row gap-3 nowrap">
                  <SecN n={4} done={couponDone} />
                  <h2 className="h4">Coupons and credit</h2>
                </div>
              </div>
              <div className="card-body">
                <form className="field" onSubmit={applyCode} noValidate>
                  <label className="label" htmlFor="co-coupon">
                    {coupon && !rejected && !codeError ? 'Add another code' : 'Coupon code'}
                  </label>
                  <div className="row nowrap gap-2">
                    <input
                      className={codeError ? 'input is-error' : 'input'}
                      id="co-coupon"
                      placeholder="Enter code"
                      value={code}
                      onChange={(e) => setCode(e.target.value)}
                      aria-invalid={codeError ? true : undefined}
                      aria-describedby={codeError ? 'co-coupon-err' : guest ? 'co-coupon-hint' : undefined}
                    />
                    <Button variant="secondary" type="submit">
                      Apply
                    </Button>
                  </div>
                  {codeError ? (
                    <span className="error-text" id="co-coupon-err">
                      <Icon name="circle-alert" className="ic-sm" />
                      {codeError}
                    </span>
                  ) : guest ? (
                    <span className="hint" id="co-coupon-hint">
                      Account coupons such as WELCOME20 and store credit need you to{' '}
                      <Link to={href('auth/sign-in')} className="link-inline">
                        sign in
                      </Link>
                      .
                    </span>
                  ) : null}
                </form>
                {rejected === 'AUTUMN15' && (
                  <Alert tone="danger" title="Why AUTUMN15 was rejected">
                    Applies only to Home &amp; Kitchen items from the Official Store. None in your cart qualify. The Pour-over set is Home &amp; Kitchen but is excluded as a new arrival. {coupon ? 'Your other discount is unchanged.' : ''}
                  </Alert>
                )}
                {!guest && coupon && (
                  <div className="panel stack gap-2">
                    <div className="row between">
                      <span className="row gap-2">
                        <span className="badge t-deal-soft">
                          <Icon name="ticket-percent" />
                          {coupon}
                        </span>
                        <span className="small strong">Applied · −{money(discount)}</span>
                      </span>
                      <a
                        className="small"
                        href="#"
                        onClick={(e) => {
                          e.preventDefault();
                          setCoupon(null);
                          announce(`${coupon} removed`);
                        }}
                      >
                        Remove
                      </a>
                    </div>
                    <span className="xs sub">$20 off your first order over $100. Funded by Marketly, so sellers receive their full price.</span>
                    <span className="xs">
                      <b>Covers:</b> Aurora headphones (−$11.63), Pour-over set (−$2.22), Pocket speaker 2-pack (−$6.15). <b>Not covered:</b> Linen duvet cover, already on a seller markdown.
                    </span>
                  </div>
                )}
                {!guest && (
                  <Checkbox
                    id="co-credit"
                    checked={credit}
                    onChange={(e) => setCredit(e.target.checked)}
                    label={
                      <>
                        Use my Marketly credit: <b>{money(CREDIT)} available</b> (from a refund on Aug 18)
                      </>
                    }
                  />
                )}
              </div>
            </section>

            {/* 5. Payment */}
            <section className="card">
              <div className="card-head">
                <div className="row gap-3 nowrap">
                  <SecN n={5} done={payDone} />
                  <h2 className="h4">Payment method</h2>
                </div>
              </div>
              <div className="card-body">
                <div className="buy-opts">
                  {!guest && (
                    <OptionCard
                      id="co-pay-visa"
                      name="co-pay"
                      checked={pay === 'visa'}
                      onChange={() => setPay('visa')}
                      title={
                        <span className="row gap-2">
                          <span className="small strong">{CARD}</span>
                          <Badge>Saved</Badge>
                        </span>
                      }
                      body="Jordan Lee · Expires 09/29 · Billing address same as Home"
                      right={<Icon name="credit-card" />}
                    />
                  )}
                  <OptionCard
                    id="co-pay-new"
                    name="co-pay"
                    checked={pay === 'new'}
                    onChange={() => setPay('new')}
                    title={<span className="small strong">New debit or credit card</span>}
                    body="Visa, Mastercard, American Express, Discover"
                    right={<Icon name="plus" />}
                  />
                  {pay === 'new' && (
                    <div className="well stack gap-3">
                      <Field label="Name on card" error={shown.cardName}>
                        <TextInput id="co-card-name" value={card.name} error={!!shown.cardName} autoComplete="cc-name" onChange={(e) => setCard({ ...card, name: e.target.value })} />
                      </Field>
                      <Field label="Card number" error={shown.cardNumber}>
                        <TextInput
                          id="co-card-n"
                          icon="credit-card"
                          value={card.number}
                          error={!!shown.cardNumber}
                          inputMode="numeric"
                          autoComplete="cc-number"
                          placeholder="1234 5678 9012 3456"
                          onChange={(e) => setCard({ ...card, number: e.target.value })}
                        />
                      </Field>
                      <div className="grid c2">
                        <Field label="Expiry" error={shown.cardExp}>
                          <TextInput id="co-card-exp" value={card.exp} error={!!shown.cardExp} autoComplete="cc-exp" placeholder="MM / YY" onChange={(e) => setCard({ ...card, exp: e.target.value })} />
                        </Field>
                        <Field label="Security code" error={shown.cardCvc}>
                          <TextInput id="co-card-cvc" value={card.cvc} error={!!shown.cardCvc} inputMode="numeric" autoComplete="cc-csc" placeholder="3 or 4 digits" onChange={(e) => setCard({ ...card, cvc: e.target.value })} />
                        </Field>
                      </div>
                      <Checkbox id="co-card-bill" label="Billing address is the same as the delivery address" checked={card.sameBilling} onChange={(e) => setCard({ ...card, sameBilling: e.target.checked })} />
                    </div>
                  )}
                  <OptionCard
                    id="co-pay-wallet"
                    name="co-pay"
                    checked={pay === 'wallet'}
                    onChange={() => setPay('wallet')}
                    title={<span className="small strong">Digital wallet</span>}
                    body="Pay with the wallet saved on this device. You confirm on the next screen."
                    right={<Icon name="smartphone" />}
                  />
                </div>
                <span className="xs muted">
                  <Icon name="lock" className="ic-sm" /> Your card is charged once, when the order is accepted. Each seller is paid by Marketly after delivery.
                </span>
              </div>
            </section>

            {/* 6. Review */}
            <section className="card">
              <div className="card-head">
                <div className="row gap-3 nowrap">
                  <SecN n={6} />
                  <h2 className="h4">Review your order</h2>
                </div>
              </div>
              <div className="card-body">
                {GROUPS.map((g, gi) => {
                  const meta = pkgMeta(g.seller);
                  return (
                    <Fragment key={g.seller}>
                      {gi > 0 && <hr />}
                      <div className="stack gap-3">
                        <div className="row between">
                          <span className="row gap-2">
                            <span className="small strong">
                              Package {gi + 1} of {GROUPS.length}
                            </span>
                            <span className="xs sub">
                              Sold and shipped by <b>{sellers[g.seller].name}</b>
                            </span>
                            <SellerBadge seller={sellers[g.seller]} compact />
                          </span>
                          <span className="xs strong">
                            <Icon name="calendar-check" className="ic-sm" /> Arrives {shipping[gi].opt.arrives}
                          </span>
                        </div>
                        {g.lines.map((l) => (
                          <BuyMini key={l.id} icon={l.icon} tint={l.tint} name={l.name} sub={`${l.variant} · ${l.condition} · Qty ${l.qty}`} amount={money(l.price * l.qty)} />
                        ))}
                        <span className="xs muted">
                          <Icon name="undo-2" className="ic-sm" /> Return terms: {meta.returns} · Seller support replies within {meta.support}
                        </span>
                      </div>
                    </Fragment>
                  );
                })}
              </div>
            </section>
          </div>

          <aside className="sticky-aside stack gap-4">
            <Card title="Order total" titleAs="h3">
              <div className="buy-sum">
                <SummaryRow k={`Items (${nItems})`} v={money(ORDER_ITEMS)} />
                {coupon && <SummaryRow className="discount" k={coupon} v={`−${money(discount)}`} />}
                {creditUsed > 0 && <SummaryRow className="discount" k="Marketly credit" v={`−${money(creditUsed)}`} />}
                {shipping.map((s) => (
                  <SummaryRow key={s.seller} k={`Shipping · ${sellers[s.seller].name}`} v={s.cost ? money(s.cost) : 'Free'} />
                ))}
                <SummaryRow k={rate ? `Tax (${address.state})` : 'Tax (Oregon has no sales tax)'} v={money(tax)} />
                <SummaryRow className="total" k="Total" v={money(total)} />
              </div>
              {nErrors > 0 && (
                <Alert tone="danger" title={`Check ${plural(nErrors, 'field')}`}>
                  Fix the highlighted fields to place your order.
                </Alert>
              )}
              <Button size="lg" block onClick={placeOrder}>
                Place order · {money(total)}
              </Button>
              <p className="xs muted">
                <Icon name="shield-check" className="ic-sm" /> Tapping twice or refreshing won't create two orders or charge you twice.
              </p>
              <p className="xs muted">
                By placing your order you agree to the{' '}
                <Link to={href('info/policy', 'purchase-terms')} className="link-inline">
                  Purchase terms
                </Link>{' '}
                and the return terms shown for each package.
              </p>
            </Card>
            <div className="card pad stack gap-2">
              <span className="small strong">Need help?</span>
              <span className="xs muted">
                Call 1-800-555-0136, Mon–Sat 8 AM–8 PM PT, or{' '}
                <Link to={href('help/center')} className="link-inline">
                  visit the Help Center
                </Link>
                .
              </span>
            </div>
          </aside>
        </div>
      </div>
      <div className="action-bar no-desktop">
        <div className="stack gap-0 grow">
          <span className="xs muted">Total · {plural(GROUPS.length, 'package')}</span>
          <span className="strong num u-fs-lg">{money(total)}</span>
        </div>
        <Button onClick={placeOrder}>Place order</Button>
      </div>

      <Dialog
        open={draft !== null}
        onClose={() => setDraft(null)}
        title="Add a delivery address"
        foot={
          <>
            <Button variant="ghost" onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <Button onClick={saveDraft}>Use this address</Button>
          </>
        }
      >
        {draft && addrField(draft, setDraft, '', draftErrors, 'co-new-')}
        <span className="xs muted">Used for this order only. Your saved addresses don't change.</span>
      </Dialog>
    </CheckoutLayout>
  );
}
