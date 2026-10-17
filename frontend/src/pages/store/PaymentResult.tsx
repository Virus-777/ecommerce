import { useEffect, useState, type ReactNode } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useSession } from '@/app/session';
import { CheckoutLayout } from '@/layouts';
import { formatMoney } from '@marketly/web-shared/lib/format';
import { href } from '@marketly/web-shared/routes';
import { ApiError, call, errorMessage, useApi } from '@marketly/web-shared/api';
import { Alert, Badge, Button, Card, Field, Icon, KeyValue, OptionCard, Select, SummaryRow, Timeline, announce } from '@marketly/web-shared/ui';
import { BuyMini, PurchaseSkeleton, plural } from './data/purchase';
import {
  DECLINE_LABEL,
  DEV_3DS_FAIL,
  DEV_3DS_OK,
  DEV_CARDS,
  brandName,
  checkoutHref,
  checkoutKey,
  confirmationHref,
  dateTimePT,
  intentKey,
  nextHref,
  returnUrl,
  savedCardTitle,
  timePT,
  useAppConfig,
  useCheckoutSession,
  useDevSettle,
  useIdempotencyKey,
  usePaymentIntent,
  type CheckoutView,
  type MethodSelection,
  type PaymentStatusView,
  type PlaceOrderResult,
} from './data/checkout-api';

// Design: pages/store/store-payment-result.html (payment failed) · view "checking-payment" (bank still answering).
// The view follows the real payment: URL /checkout/payment?session=<checkout id>&intent=<payment intent id>
// (intent defaults to the session's last payment). Data: GET /api/store/payments/intents/{id} (PaymentStatusView,
// re-read every nextCheckInSeconds while pending), GET …/checkout/sessions/{id} (order aside, hold time, methods);
// Check now: POST …/intents/{id}/check; retry: POST …/sessions/{id}/retry-payment + Idempotency-Key; a bank check
// (requires_action, dev token tok_3ds) is finished with POST …/sessions/{id}/complete-action + Idempotency-Key.
// Development only: tok_pending keeps the payment being checked; "Settle (dev)" answers it with
// POST /api/dev/payments/intents/{id}/settle (shown only in a dev build).

export default function PaymentResult() {
  const [params] = useSearchParams();
  const id = params.get('session');
  const session = useCheckoutSession(id);
  const intentId = params.get('intent') ?? session.data?.lastPayment?.intentId ?? null;
  const intent = usePaymentIntent(intentId);

  if (!id) return <Navigate to={href('store/cart')} replace />;
  if (session.data && !intentId) return <Navigate to={checkoutHref(id)} replace />;
  const err = session.error ?? intent.error;
  if (err) {
    const gone = err instanceof ApiError && (err.status === 404 || err.status === 410);
    return (
      <Shell>
        <Alert tone={gone ? 'warning' : 'danger'} title={gone ? 'We couldn’t find this payment' : 'We couldn’t load your payment'}>
          {errorMessage(err)}{' '}
          {gone ? (
            <Link to={href('store/cart')} className="link-inline">
              Back to cart
            </Link>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                void session.refetch();
                void intent.refetch();
              }}
            >
              Try again
            </Button>
          )}
        </Alert>
      </Shell>
    );
  }
  const c = session.data;
  const p = intent.data;
  if (!c || !p) {
    return (
      <Shell>
        <PurchaseSkeleton label="your payment" />
      </Shell>
    );
  }
  if (p.state === 'accepted') return <Accepted id={id} />;
  if (p.state === 'pending') return <Checking c={c} p={p} />;
  if (p.state === 'requires_action') return <BankCheck key={p.intentId} c={c} p={p} />;
  return <Failed key={p.intentId} c={c} p={p} />;
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <CheckoutLayout>
      <div className="container page">{children}</div>
    </CheckoutLayout>
  );
}

function Accepted({ id }: { id: string }) {
  const { refreshCart } = useSession();
  useEffect(() => refreshCart(), [refreshCart]);
  return <Navigate to={confirmationHref(id)} replace />;
}

/** Follows a PlaceOrderResult from a retry or a bank check to the next screen. */
function useFollow(id: string) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { refreshCart } = useSession();
  return (r: PlaceOrderResult) => {
    qc.setQueryData(checkoutKey(id), r.checkout);
    if (r.payment) qc.setQueryData(intentKey(r.payment.intentId), r.payment);
    if (r.outcome === 'accepted' || r.outcome === 'payment_pending') refreshCart();
    navigate(nextHref(r, id), { replace: true });
  };
}

function OrderAside({ c, extra }: { c: CheckoutView; extra?: ReactNode }) {
  return (
    <aside className="stack gap-4">
      <Card title="Your order" titleAs="h3" sub={`${plural(c.totals.itemCount, 'item')} · ${plural(c.packages.length, 'package')}`}>
        {c.packages.flatMap((pkg) => {
          const arrives = pkg.options.find((o) => o.id === pkg.selectedOptionId)?.arrivalLabel;
          return pkg.lines.map((l) => <BuyMini key={l.id} image={l.image} name={l.title} sub={[pkg.seller.name, arrives].filter(Boolean).join(' · ')} amount={formatMoney(l.lineTotal)} strong={false} />);
        })}
        <hr />
        <SummaryRow className="total" k="Total" v={formatMoney(c.totals.total)} />
      </Card>
      {extra}
    </aside>
  );
}

type Retry = `saved:${string}` | 'new';

function Failed({ c, p }: { c: CheckoutView; p: PaymentStatusView }) {
  const id = c.id;
  const { api } = useApi();
  const qc = useQueryClient();
  const follow = useFollow(id);
  const idem = useIdempotencyKey();
  const opts = c.payment.options;
  const lastSaved = c.payment.selected?.kind === 'saved_card' ? c.payment.selected.savedMethodId : null;
  const usable = opts.savedMethods.filter((m) => !m.expired);
  const [retry, setRetry] = useState<Retry>(() => (lastSaved && usable.some((m) => m.id === lastSaved) ? `saved:${lastSaved}` : usable[0] ? `saved:${usable[0].id}` : 'new'));
  const [devCard, setDevCard] = useState('tok_visa');
  const total = formatMoney(c.totals.total);
  const saved = retry.startsWith('saved:') ? usable.find((m) => `saved:${m.id}` === retry) : undefined;

  const method = (): MethodSelection =>
    retry === 'new' ? { kind: 'new_card', providerToken: devCard } : { kind: 'saved_card', savedMethodId: retry.slice('saved:'.length) };
  const pay = useMutation({
    mutationFn: () => {
      const m = method();
      const key = idem(`${p.intentId}:${c.quoteVersion}:${c.totals.total.amount}:${JSON.stringify(m)}`);
      return call(
        api.POST('/api/store/checkout/sessions/{id}/retry-payment', {
          params: { path: { id }, header: { 'Idempotency-Key': key } },
          body: { method: m, quoteVersion: c.quoteVersion, expectedTotal: c.totals.total, returnUrl: returnUrl(id) },
        }),
      );
    },
    onSuccess: follow,
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'QUOTE_OUTDATED') void qc.invalidateQueries({ queryKey: checkoutKey(id) });
    },
  });
  const label = saved ? `Pay ${total} with ${savedCardTitle(saved)}` : `Pay ${total} with the test card`;
  const d = p.decline;
  const codes = c.coupons.filter((x) => x.status === 'applied').map((x) => x.code);
  const canRetry = p.retryAllowed && c.status === 'payment_failed';
  const startOver = pay.error instanceof ApiError && ['PAYMENT_ATTEMPTS_EXCEEDED', 'RETRY_WINDOW_EXPIRED', 'SESSION_EXPIRED'].includes(pay.error.code);

  return (
    <Shell>
      <div className="split">
        <div className="stack gap-5">
          <div className="row top gap-4 nowrap">
            <span className="buy-result-icon t-danger">
              <Icon name="credit-card" />
            </span>
            <div className="stack gap-2">
              <h1 className="h1">Your payment didn't go through</h1>
              <p className="sub">
                {d?.message ?? p.message}
                {p.orderId ? '' : ' No order was created.'}
              </p>
            </div>
          </div>
          <Alert tone="danger" title={d ? `Reason from your bank: ${DECLINE_LABEL[d.category] ?? d.category} (code ${d.code})` : p.title}>
            {d?.advice ?? 'Try again, or use a different payment method.'}
          </Alert>
          {canRetry && !startOver ? (
            <Card title="Try again">
              <div className="buy-opts">
                {usable.map((m) => (
                  <OptionCard
                    key={m.id}
                    id={`pr-${m.id}`}
                    name="pr-pay"
                    checked={retry === `saved:${m.id}`}
                    onChange={() => setRetry(`saved:${m.id}`)}
                    title={<span className="small strong">{savedCardTitle(m)}</span>}
                    body={m.id === lastSaved ? 'Same card. Use this if you just approved the payment in your banking app.' : `${m.label} · Saved card`}
                    right={<Icon name="credit-card" />}
                  />
                ))}
                <OptionCard id="pr-new" name="pr-pay" checked={retry === 'new'} onChange={() => setRetry('new')} title={<span className="small strong">New debit or credit card</span>} body={opts.acceptedBrands.map(brandName).join(', ')} right={<Icon name="plus" />} />
                {retry === 'new' && (
                  <div className="well stack gap-3">
                    <Field label="Test card" hint="Development only: Marketly never receives card numbers. The payment provider's secure card fields replace this in production.">
                      <Select id="pr-card-test" options={DEV_CARDS} value={devCard} onChange={(e) => setDevCard(e.target.value)} />
                    </Field>
                  </div>
                )}
              </div>
              {pay.isError && (
                <span className="error-text">
                  <Icon name="circle-alert" className="ic-sm" />
                  {errorMessage(pay.error)}
                </span>
              )}
              <div className="row gap-2">
                <Button onClick={() => pay.mutate()} disabled={pay.isPending}>
                  {pay.isPending ? 'Paying…' : label}
                </Button>
                <Button variant="secondary" to={checkoutHref(id)}>
                  Back to checkout
                </Button>
              </div>
            </Card>
          ) : (
            <Alert tone="warning" title="Start again from your cart">
              {startOver ? errorMessage(pay.error) : 'This checkout can’t take another payment.'} Nothing was charged.{' '}
              <Link to={href('store/cart')} className="link-inline">
                Back to cart
              </Link>
            </Alert>
          )}
          {canRetry && (
            <div className="buy-note t-info">
              <Icon name="info" />
              <span>
                Your cart, delivery choices{codes.length ? ` and ${codes.join(', ')} ${codes.length === 1 ? 'coupon' : 'coupons'}` : ''} are saved.
                {c.holdUntil ? ` Prices and stock are held until ${timePT(c.holdUntil)}, and we'll show you any changes before you pay.` : " We'll show you any changes before you pay."}
              </span>
            </div>
          )}
        </div>
        <OrderAside c={c} />
      </div>
    </Shell>
  );
}

function Checking({ c, p }: { c: CheckoutView; p: PaymentStatusView }) {
  const { api } = useApi();
  const qc = useQueryClient();
  const { customer } = useSession();
  const support = useAppConfig().data?.support;
  const devSettle = useDevSettle();
  const settle = useMutation({
    mutationFn: (outcome: 'authorized' | 'declined') => devSettle(p.intentId, outcome),
    onSuccess: (v) => {
      qc.setQueryData(intentKey(p.intentId), v);
      void qc.invalidateQueries({ queryKey: checkoutKey(c.id) });
    },
  });
  const check = useMutation({
    mutationFn: () => call(api.POST('/api/store/payments/intents/{id}/check', { params: { path: { id: p.intentId } } })),
    onSuccess: (v) => {
      qc.setQueryData(intentKey(p.intentId), v);
      if (v.state === 'pending') announce('Checked again. Your bank is still confirming the payment.');
    },
  });
  const email = c.account?.email ?? customer?.email;
  const every = p.nextCheckInSeconds ?? 30;
  const amount = formatMoney(p.amount);

  return (
    <Shell>
      <div className="split">
        <div className="stack gap-5">
          <div className="row top gap-4 nowrap">
            <span className="buy-result-icon t-warning">
              <Icon name="hourglass" />
            </span>
            <div className="stack gap-2">
              <h1 className="h1">We're confirming your payment</h1>
              <p className="sub">{p.message} This usually takes a few minutes.</p>
            </div>
          </div>
          <div className="card pad stack gap-3">
            <KeyValue
              pairs={[
                ...(p.orderRef ? ([['Order reference', <span className="buy-ref">{p.orderRef}</span>]] as Array<[ReactNode, ReactNode]>) : []),
                [
                  'Payment',
                  <>
                    <Badge tone="warning">Pending</Badge>{' '}
                    <span className="xs muted">
                      {p.methodLabel} · {amount}
                    </span>
                  </>,
                ],
                ['Last checked', <span aria-live="polite">{p.lastCheckedAt ? dateTimePT(p.lastCheckedAt) : 'Not checked yet'}</span>],
              ]}
            />
            <div className="row gap-2 xs muted">
              <Icon name="refresh-cw" className="ic-sm" />
              <span>
                This page checks again automatically every {every} seconds. You can close it{email ? `; we'll email ${email} with the result` : ''}.
              </span>
            </div>
            {check.isError && (
              <span className="error-text">
                <Icon name="circle-alert" className="ic-sm" />
                {errorMessage(check.error)}
              </span>
            )}
            <div className="row gap-2">
              {p.orderRef && (
                <Button to={href('account/order', '', { ref: p.orderRef })} iconRight="arrow-right">
                  View order status
                </Button>
              )}
              <Button variant="secondary" icon="refresh-cw" onClick={() => check.mutate()} disabled={check.isPending}>
                {check.isPending ? 'Checking…' : 'Check now'}
              </Button>
            </div>
            {import.meta.env.DEV && (
              <div className="row gap-2 xs muted">
                <span>Settle (dev):</span>
                <Button variant="ghost" size="sm" onClick={() => settle.mutate('authorized')} disabled={settle.isPending}>
                  Approve
                </Button>
                <Button variant="ghost" size="sm" onClick={() => settle.mutate('declined')} disabled={settle.isPending}>
                  Decline
                </Button>
                {settle.isError && <span className="t-danger-text">{errorMessage(settle.error)}</span>}
              </div>
            )}
          </div>
          <Alert tone="warning" title="Please don't place this order again">
            {p.holdNote ?? `Your bank may show a temporary hold for ${amount}. Placing the order again could create a second hold.`} Your order reference stays the same whatever happens.
          </Alert>
          <section className="card pad stack gap-3">
            <h2 className="h3">What happens next</h2>
            <Timeline
              events={[
                { t: 'Order received', d: p.placedAt ? dateTimePT(p.placedAt) : undefined, state: 'done', body: 'Your items are reserved while we check the payment.' },
                { t: 'Bank confirms the payment', d: 'Usually within minutes, at most 24 hours', state: 'current', body: 'If accepted, the order is confirmed and you get a confirmation email. Sellers start preparing your packages.' },
                { t: 'If the bank declines', body: 'The order is cancelled, nothing is charged and any hold is released by your bank within 3–5 business days. Your cart is restored so you can pay another way.' },
              ]}
            />
          </section>
        </div>
        <OrderAside
          c={c}
          extra={
            <div className="card pad stack gap-2">
              <span className="small strong">Questions about this payment?</span>
              <span className="xs muted">
                {support ? `Call ${support.phone}, ${support.hoursLabel}.` : 'Contact support from the Help Center.'}
                {p.orderRef && ` Have ${p.orderRef} ready.`}
              </span>
            </div>
          }
        />
      </div>
    </Shell>
  );
}

/** requires_action: the bank asks for a security check (3-D Secure). In development the result is chosen here. */
function BankCheck({ c, p }: { c: CheckoutView; p: PaymentStatusView }) {
  const id = c.id;
  const { api } = useApi();
  const follow = useFollow(id);
  const idem = useIdempotencyKey();
  const complete = useMutation({
    mutationFn: (resultToken: string) =>
      call(api.POST('/api/store/checkout/sessions/{id}/complete-action', { params: { path: { id }, header: { 'Idempotency-Key': idem(`${p.intentId}:${resultToken}`) } }, body: { resultToken } })),
    onSuccess: follow,
  });
  return (
    <Shell>
      <div className="split">
        <div className="stack gap-5">
          <div className="row top gap-4 nowrap">
            <span className="buy-result-icon t-warning">
              <Icon name="shield-check" />
            </span>
            <div className="stack gap-2">
              <h1 className="h1">{p.title}</h1>
              <p className="sub">{p.message}</p>
            </div>
          </div>
          <div className="card pad stack gap-3">
            <KeyValue
              pairs={[
                [
                  'Payment',
                  <>
                    <Badge tone="warning">Waiting for your bank</Badge>{' '}
                    <span className="xs muted">
                      {p.methodLabel} · {formatMoney(p.amount)}
                    </span>
                  </>,
                ],
              ]}
            />
            <Alert tone="info" title="Development: test bank check">
              The development card processor has no bank page. Choose how the security check ends; in production the bank's own page opens here.
            </Alert>
            {complete.isError && (
              <span className="error-text">
                <Icon name="circle-alert" className="ic-sm" />
                {errorMessage(complete.error)}
              </span>
            )}
            <div className="row gap-2">
              <Button onClick={() => complete.mutate(DEV_3DS_OK)} disabled={complete.isPending}>
                Approve the security check
              </Button>
              <Button variant="secondary" onClick={() => complete.mutate(DEV_3DS_FAIL)} disabled={complete.isPending}>
                Fail the security check
              </Button>
            </div>
          </div>
        </div>
        <OrderAside c={c} />
      </div>
    </Shell>
  );
}
