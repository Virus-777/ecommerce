import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { useSession } from '@/app/session';
import { CheckoutLayout } from '@/layouts';
import { useView } from '@marketly/web-shared/lib/hooks';
import { money } from '@marketly/web-shared/lib/format';
import { sellers } from '@marketly/web-shared/data/fixtures';
import { href } from '@marketly/web-shared/routes';
import { Alert, Badge, Button, Card, Icon, KeyValue, OptionCard, SummaryRow, Timeline, announce } from '@marketly/web-shared/ui';
import { BuyMini, CARD, ORDER_LINES, ORDER_REF, ORDER_TOTAL, groupBySeller, pkgMeta, plural } from './data/purchase';

// Design: pages/store/store-payment-result.html (payment failed) · view "checking-payment" =
// the bank hasn't answered yet (also reached by retrying with a digital wallet).

type Retry = 'visa' | 'new' | 'wallet';

const GROUPS = groupBySeller(ORDER_LINES);
const N_ITEMS = ORDER_LINES.reduce((s, l) => s + l.qty, 0);
/** When the order was received; "last checked" counts on from here. */
const CHECK_BASE = new Date(2026, 9, 8, 14, 41);
const CHECK_EVERY_MS = 30_000;

const fmtChecked = (d: Date) =>
  `${d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}, ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} PT`;

function OrderAside({ extra }: { extra?: ReactNode }) {
  return (
    <aside className="stack gap-4">
      <Card title="Your order" titleAs="h3" sub={`${plural(N_ITEMS, 'item')} · ${plural(GROUPS.length, 'package')}`}>
        {GROUPS.flatMap((g) =>
          g.lines.map((l) => (
            <BuyMini key={l.id} icon={l.icon} tint={l.tint} name={l.name} sub={`${sellers[g.seller].name} · ${pkgMeta(g.seller).options[0].arrives}`} amount={money(l.price * l.qty)} strong={false} />
          )),
        )}
        <hr />
        <SummaryRow className="total" k="Total" v={money(ORDER_TOTAL)} />
      </Card>
      {extra}
    </aside>
  );
}

export default function PaymentResult() {
  const [view, setView] = useView<'checking-payment'>();
  return view === 'checking-payment' ? <Checking /> : <Failed onWallet={() => setView('checking-payment')} />;
}

function Failed({ onWallet }: { onWallet: () => void }) {
  const navigate = useNavigate();
  const [retry, setRetry] = useState<Retry>('visa');
  const label = retry === 'visa' ? `Pay ${money(ORDER_TOTAL)} with ${CARD}` : retry === 'new' ? 'Enter new card details' : `Pay ${money(ORDER_TOTAL)} with digital wallet`;
  const go = () => {
    if (retry === 'visa') navigate(href('store/confirmation'));
    else if (retry === 'new') navigate(href('store/checkout'));
    else onWallet();
  };
  return (
    <CheckoutLayout>
      <div className="container page">
        <div className="split">
          <div className="stack gap-5">
            <div className="row top gap-4 nowrap">
              <span className="buy-result-icon t-danger">
                <Icon name="credit-card" />
              </span>
              <div className="stack gap-2">
                <h1 className="h1">Your payment didn't go through</h1>
                <p className="sub">Your bank declined {CARD}. Nothing was charged and no order was created.</p>
              </div>
            </div>
            <Alert tone="danger" title="Reason from your bank: card declined (code 05)">
              Banks use this code for several reasons, such as a spending limit or a security check. Your bank can tell you more. Try again, or use a different payment method.
            </Alert>
            <Card title="Try again">
              <div className="buy-opts">
                <OptionCard id="pr-visa" name="pr-pay" checked={retry === 'visa'} onChange={() => setRetry('visa')} title={<span className="small strong">{CARD}</span>} body="Same card. Use this if you just approved the payment in your banking app." right={<Icon name="credit-card" />} />
                <OptionCard id="pr-new" name="pr-pay" checked={retry === 'new'} onChange={() => setRetry('new')} title={<span className="small strong">New debit or credit card</span>} body="Visa, Mastercard, American Express, Discover" right={<Icon name="plus" />} />
                <OptionCard id="pr-wallet" name="pr-pay" checked={retry === 'wallet'} onChange={() => setRetry('wallet')} title={<span className="small strong">Digital wallet</span>} body="Confirm on this device" right={<Icon name="smartphone" />} />
              </div>
              <div className="row gap-2">
                <Button onClick={go}>{label}</Button>
                <Button variant="secondary" to={href('store/checkout')}>
                  Back to checkout
                </Button>
              </div>
            </Card>
            <div className="buy-note t-info">
              <Icon name="info" />
              <span>Your cart, delivery choices and WELCOME20 coupon are saved. Prices and stock are held until 3:15 PM PT, and we'll show you any changes before you pay.</span>
            </div>
          </div>
          <OrderAside />
        </div>
      </div>
    </CheckoutLayout>
  );
}

function Checking() {
  const { customer } = useSession();
  const [checks, setChecks] = useState(0);
  const [busy, setBusy] = useState(false);
  const checked = new Date(CHECK_BASE.getTime() + checks * CHECK_EVERY_MS);

  // The page checks again on its own every 30 seconds.
  useEffect(() => {
    const t = setInterval(() => setChecks((n) => n + 1), CHECK_EVERY_MS);
    return () => clearInterval(t);
  }, []);

  const checkNow = () => {
    setBusy(true);
    setTimeout(() => {
      setChecks((n) => n + 1);
      setBusy(false);
      announce('Checked again. Your bank is still confirming the payment.');
    }, 800);
  };

  return (
    <CheckoutLayout>
      <div className="container page">
        <div className="split">
          <div className="stack gap-5">
            <div className="row top gap-4 nowrap">
              <span className="buy-result-icon t-warning">
                <Icon name="hourglass" />
              </span>
              <div className="stack gap-2">
                <h1 className="h1">We're confirming your payment</h1>
                <p className="sub">We're confirming your payment with your bank. Don't pay again. This usually takes a few minutes.</p>
              </div>
            </div>
            <div className="card pad stack gap-3">
              <KeyValue
                pairs={[
                  ['Order reference', <span className="buy-ref">{ORDER_REF}</span>],
                  [
                    'Payment',
                    <>
                      <Badge tone="warning">Pending</Badge>{' '}
                      <span className="xs muted">
                        {CARD} · {money(ORDER_TOTAL)}
                      </span>
                    </>,
                  ],
                  ['Last checked', <span aria-live="polite">{fmtChecked(checked)}</span>],
                ]}
              />
              <div className="row gap-2 xs muted">
                <Icon name="refresh-cw" className="ic-sm" />
                <span>This page checks again automatically every 30 seconds. You can close it; we'll email {customer.email} with the result.</span>
              </div>
              <div className="row gap-2">
                <Button to={href('account/order')} iconRight="arrow-right">
                  View order status
                </Button>
                <Button variant="secondary" icon="refresh-cw" onClick={checkNow} disabled={busy}>
                  {busy ? 'Checking…' : 'Check now'}
                </Button>
              </div>
            </div>
            <Alert tone="warning" title="Please don't place this order again">
              Your bank may show a temporary hold for {money(ORDER_TOTAL)}. Placing the order again could create a second hold. Your order reference stays the same whatever happens.
            </Alert>
            <section className="card pad stack gap-3">
              <h2 className="h3">What happens next</h2>
              <Timeline
                events={[
                  { t: 'Order received', d: 'Thu, Oct 8, 2:39 PM PT', state: 'done', body: 'Your items are reserved while we check the payment.' },
                  { t: 'Bank confirms the payment', d: 'Usually within minutes, at most 24 hours', state: 'current', body: 'If accepted, the order is confirmed and you get a confirmation email. Sellers start preparing your packages.' },
                  { t: 'If the bank declines', body: 'The order is cancelled, nothing is charged and any hold is released by your bank within 3–5 business days. Your cart is restored so you can pay another way.' },
                ]}
              />
            </section>
          </div>
          <OrderAside
            extra={
              <div className="card pad stack gap-2">
                <span className="small strong">Questions about this payment?</span>
                <span className="xs muted">Call 1-800-555-0136, Mon–Sat 8 AM–8 PM PT. Have {ORDER_REF} ready.</span>
              </div>
            }
          />
        </div>
      </div>
    </CheckoutLayout>
  );
}

