import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import { StoreLayout } from '@/layouts';
import { ApiError, call, errorMessage, useApi } from '@marketly/web-shared/api';
// web-shared exports no ./api/graphql/* subpath yet: import the screen query text by path.
import ORDER_DETAIL from '../../../../web-shared/src/api/graphql/store/OrderDetail.graphql?raw';
import { useView } from '@marketly/web-shared/lib/hooks';
import { initials, tileTint } from '@marketly/web-shared/lib/format';
import { href } from '@marketly/web-shared/routes';
import { Alert, Button, Field, Icon, Img, LogoTile, SellerBadge, StatusBadge, SummaryRow, TextInput, announce } from '@marketly/web-shared/ui';
import { AuthShell, DevOutboxHint, EMAIL_RE, authError, useHashToken } from './data/parts';

// Design: pages/store/auth-guest-orders.html · view "found" = the order after a successful lookup (?view=found&ref=MK-…).
//   Lookup: POST /api/store/customers/guest-orders/lookup {orderRef, email} grants the order to this visitor session.
//   Emailed link: ${STORE_URL}/orders/open#token=… (routes/email-links.tsx keeps the fragment) →
//                 POST /api/public/identity/order-links/redeem {token} grants it the same way.
//   Found: the OrderDetail screen query (order(ref) answers for a session holding a grant; null otherwise).

const REF_RE = /^MK-\d{6}-\d{5}$/;

/** What the lookup knows that the order query doesn't (kept in router state). */
interface FoundState {
  email?: string;
  canCreateAccount?: boolean;
}

export default function GuestOrders() {
  const [view] = useView<'found'>();
  const [params] = useSearchParams();
  const ref = params.get('ref');
  return view === 'found' && ref ? <Found orderRef={ref} /> : <Lookup />;
}

function Lookup() {
  const { api } = useApi();
  const navigate = useNavigate();
  const token = useHashToken();
  const [ref, setRef] = useState('');
  const [email, setEmail] = useState('');
  const [errors, setErrors] = useState<{ ref?: string; email?: string }>({});
  const [notFound, setNotFound] = useState(false);
  const [signInRequired, setSignInRequired] = useState(false);
  const [linksSent, setLinksSent] = useState(false);

  const showFound = (orderRef: string, state: FoundState) => navigate(href('auth/guest-orders', 'found', undefined, { ref: orderRef }), { state });

  const lookup = useMutation({
    mutationFn: (body: { orderRef: string; email: string }) => call(api.POST('/api/store/customers/guest-orders/lookup', { body })),
    onSuccess: (r, body) => {
      announce(`Found order ${r.orderRef}`);
      showFound(r.orderRef, { email: body.email, canCreateAccount: r.canCreateAccount });
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'GUEST_ORDER_NOT_FOUND') setNotFound(true);
      // A registered customer's order opens only in their account (G29e); the answer never confirms the email.
      if (e instanceof ApiError && e.code === 'GUEST_ORDER_SIGN_IN_REQUIRED') setSignInRequired(true);
    },
  });

  // Emailed order link: redeem the token; the answer names the order (orderRef). Links issued before the
  // reference was recorded have none: those read the order once. A signed-in customer gets no guest access
  // (guestSession null): the order opens in their account.
  const redeem = useMutation({
    mutationFn: async (t: string) => {
      const r = await call(api.POST('/api/public/identity/order-links/redeem', { body: { token: t } }));
      const ref = r.orderRef ?? (await call(api.GET('/api/store/orders/orders/{id}', { params: { path: { id: r.orderId } } }))).ref;
      return { ref, emailMasked: r.emailMasked, inAccount: !r.guestSession };
    },
    onSuccess: (r) => (r.inAccount ? navigate(href('account/order', '', { ref: r.ref }), { replace: true }) : showFound(r.ref, { email: r.emailMasked })),
  });
  const redeemed = useRef(false);
  useEffect(() => {
    if (token && !redeemed.current) {
      redeemed.current = true;
      redeem.mutate(token);
    }
  }, [token, redeem]);

  const links = useMutation({
    mutationFn: (to: string) => call(api.POST('/api/store/customers/guest-orders/links', { body: { email: to } })),
    onSuccess: (_r, to) => {
      setLinksSent(true);
      announce(`If there are orders for ${to}, we've emailed links to them.`);
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const r = ref.trim().toUpperCase();
    const next: typeof errors = {};
    if (!REF_RE.test(r)) next.ref = 'Enter the reference as it appears in your email, like MK-261002-66018.';
    if (!EMAIL_RE.test(email.trim())) next.email = 'Enter the email you used at checkout.';
    setErrors(next);
    setNotFound(false);
    setSignInRequired(false);
    if (next.ref || next.email || lookup.isPending) return;
    lookup.mutate({ orderRef: r, email: email.trim() });
  };

  const lookupError = lookup.error && !(lookup.error instanceof ApiError && ['GUEST_ORDER_NOT_FOUND', 'GUEST_ORDER_SIGN_IN_REQUIRED'].includes(lookup.error.code)) ? authError(lookup.error) : null;

  return (
    <AuthShell title="Guest order lookup" onSubmit={submit}>
      <span className="buy-result-icon t-info">
        <Icon name="package-search" />
      </span>
      <div className="stack gap-1">
        <h1 className="h2">Find your guest order</h1>
        <p className="small sub">Bought without an account? Look up your order to track packages, start a return or get help.</p>
      </div>
      {redeem.isPending && (
        <Alert tone="info" title="Opening your order">
          Checking the link from your email…
        </Alert>
      )}
      {redeem.isError && (
        <Alert tone="danger" title="We couldn't open that link">
          {authError(redeem.error)}
        </Alert>
      )}
      {notFound && (
        <Alert tone="danger" title="We couldn't find that order">
          Check the reference and use the same email you entered at checkout. Orders placed in the last few minutes can take a moment to appear.
        </Alert>
      )}
      {signInRequired && (
        <Alert tone="info" title="Sign in to see this order">
          This order belongs to a Marketly account. Sign in to that account to track it, return items or get help.{' '}
          <Link to={href('auth/sign-in', '', undefined, { next: href('account/order', '', { ref: ref.trim().toUpperCase() }) })} className="link-inline">
            Sign in
          </Link>
        </Alert>
      )}
      {lookupError && <Alert tone="danger" title="We couldn't look up that order">{lookupError}</Alert>}
      <Field label="Order reference" hint="It's in your confirmation email, starting with MK-." error={errors.ref}>
        <TextInput id="go-ref" value={ref} error={!!errors.ref} placeholder="MK-YYMMDD-NNNNN" autoCapitalize="characters" onChange={(e) => setRef(e.target.value)} />
      </Field>
      <Field label="Email used at checkout" error={errors.email}>
        <TextInput
          id="go-email"
          type="email"
          value={email}
          error={!!errors.email}
          autoComplete="email"
          onChange={(e) => {
            setEmail(e.target.value);
            setLinksSent(false);
          }}
        />
      </Field>
      <Button type="submit" size="lg" block disabled={lookup.isPending || redeem.isPending}>
        {lookup.isPending ? 'Finding order…' : 'Find order'}
      </Button>
      <p className="xs muted">
        We can also email you a fresh link to every order placed with this email.{' '}
        {linksSent ? (
          <span className="strong">Sent. Check your inbox.</span>
        ) : (
          <a
            href="#"
            className="link-inline"
            onClick={(e) => {
              e.preventDefault();
              if (!EMAIL_RE.test(email.trim())) {
                setErrors((x) => ({ ...x, email: 'Enter the email you used at checkout.' }));
                return;
              }
              if (!links.isPending) links.mutate(email.trim());
            }}
          >
            {links.isPending ? 'Sending…' : 'Email me my order links'}
          </a>
        )}
      </p>
      {links.isError && (
        <span className="error-text" role="alert">
          <Icon name="circle-alert" className="ic-sm" />
          {authError(links.error)}
        </span>
      )}
      {linksSent && <DevOutboxHint what="email with your order links" />}
      <p className="small center">
        Have an account?{' '}
        <Link className="strong link-inline" to={href('auth/sign-in')}>
          Sign in
        </Link>{' '}
        to see all your orders.
      </p>
    </AuthShell>
  );
}

// ---- Found: OrderDetail screen query (the fields this screen shows) ----

interface Money {
  amount: number;
  currency: string;
  formatted: string;
}
interface OrderItem {
  id: string;
  title: string;
  variantLabel: string | null;
  quantity: number;
  stateLabel: string;
  image: { url: string; alt: string | null } | null;
  lineSubtotal: Money;
  offerTerms: { conditionLabel: string | null } | null;
}
interface Shipment {
  id: string;
  carrierName: string | null;
  serviceName: string | null;
  trackingNumber: string | null;
}
interface OrderGroup {
  id: string;
  statusLabel: string;
  estimateLabel: string | null;
  seller: { id: string | null; name: string; official: boolean; verified: boolean };
  delivery: { methodName: string; free: boolean; price: Money } | null;
  items: OrderItem[];
  shipments: Shipment[];
}
interface GuestOrder {
  id: string;
  ref: string;
  placedAt: string;
  statusLabel: string;
  deliveryAddress: { name: string; line1: string; line2: string | null; city: string; region: string; postalCode: string } | null;
  progress: { payment: { label: string; methodLabel: string | null } };
  totals: {
    itemCount: number;
    items: Money;
    discounts: Array<{ code: string | null; label: string; amount: Money }>;
    tax: Money;
    total: Money;
  };
  groups: OrderGroup[];
  payment: { stateLabel: string; methodLabel: string | null } | null;
}

const placedOn = (iso: string) => new Date(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
const addressLine = (a: NonNullable<GuestOrder['deliveryAddress']>) => [a.name, a.line1, a.line2, a.city, `${a.region} ${a.postalCode}`].filter(Boolean).join(', ');
const TINTS = ['5', '2', '3', '4', '6', '1'] as const;

function FoundFrame({ children }: { children: ReactNode }) {
  return (
    <StoreLayout tab="account" appbar={{ title: 'Your order', back: href('auth/guest-orders') }}>
      <div className="container page">
        <div className="buy-narrow stack gap-5">{children}</div>
      </div>
    </StoreLayout>
  );
}

function BackLink() {
  return (
    <Link className="small strong no-phone" to={href('auth/guest-orders')}>
      <Icon name="arrow-left" className="ic-sm" /> Look up another order
    </Link>
  );
}

function Found({ orderRef }: { orderRef: string }) {
  const { gql } = useApi();
  const st = (useLocation().state ?? null) as FoundState | null;
  const q = useQuery({
    queryKey: ['orders', 'detail', orderRef],
    queryFn: async () => (await gql<{ order: GuestOrder | null }>(ORDER_DETAIL, { ref: orderRef }, 'OrderDetail')).data?.order ?? null,
  });

  if (q.isPending)
    return (
      <FoundFrame>
        <div className="stack gap-2">
          <BackLink />
          <h1 className="h1">
            Order <span className="buy-ref">{orderRef}</span>
          </h1>
          <span className="sk sk-line" aria-hidden="true" />
        </div>
        <div className="sk sk-card" aria-hidden="true" />
        <div className="sk sk-card" aria-hidden="true" />
      </FoundFrame>
    );

  if (q.isError)
    return (
      <FoundFrame>
        <div className="stack gap-2">
          <BackLink />
          <h1 className="h1">
            Order <span className="buy-ref">{orderRef}</span>
          </h1>
        </div>
        <Alert tone="danger" title="We couldn't load this order">
          {errorMessage(q.error)}
        </Alert>
        <div>
          <Button variant="secondary" onClick={() => void q.refetch()}>
            Try again
          </Button>
        </div>
      </FoundFrame>
    );

  const o = q.data;
  if (!o)
    return (
      <FoundFrame>
        <div className="stack gap-2">
          <BackLink />
          <h1 className="h1">
            Order <span className="buy-ref">{orderRef}</span>
          </h1>
        </div>
        <Alert tone="danger" title="We can't show this order here">
          Look it up again with the email you used at checkout, or open the link from your order email on this device.
        </Alert>
        <div>
          <Button variant="secondary" to={href('auth/guest-orders')}>
            Look up an order
          </Button>
        </div>
      </FoundFrame>
    );

  const paymentMethod = o.payment?.methodLabel ?? o.progress.payment.methodLabel;
  // Paid shipping first, as on the design's receipt.
  const shipRows = [...o.groups].sort((a, b) => (b.delivery?.price.amount ?? 0) - (a.delivery?.price.amount ?? 0));
  const email = st?.email;

  return (
    <FoundFrame>
      <div className="stack gap-2">
        <BackLink />
        <h1 className="h1">
          Order <span className="buy-ref">{o.ref}</span>
        </h1>
        <p className="small sub">
          Placed {placedOn(o.placedAt)} as a guest{email ? ` · ${email}` : ''}
        </p>
      </div>
      <div className="card pad">
        <div className="grid md3 gap-4">
          <div className="stack gap-1">
            <span className="xs muted">Order status</span>
            <StatusBadge status={o.statusLabel} />
          </div>
          <div className="stack gap-1">
            <span className="xs muted">Payment{paymentMethod ? ` · ${paymentMethod}` : ''}</span>
            <span className="row gap-2">
              <span className="strong num">{o.totals.total.formatted}</span>
              <StatusBadge status={o.payment?.stateLabel ?? o.progress.payment.label} />
            </span>
          </div>
          <div className="stack gap-1">
            <span className="xs muted">Delivering to</span>
            <span className="small">{o.deliveryAddress ? addressLine(o.deliveryAddress) : '—'}</span>
          </div>
        </div>
      </div>
      {o.groups.map((g, i) => {
        const shipment = g.shipments[0];
        const how = shipment ? [shipment.serviceName ?? shipment.carrierName, shipment.trackingNumber].filter(Boolean).join(' · ') : `${g.delivery?.methodName ?? 'Standard'} · Not shipped yet`;
        return (
          <section className="card buy-pkg" key={g.id}>
            <div className="buy-pkg-head">
              <div className="row gap-2">
                <LogoTile initials={g.seller.official ? 'M' : initials(g.seller.name)} tint={g.seller.official ? 'brand' : tileTint(g.seller.name)} />
                <div className="stack gap-0">
                  <span className="row gap-2">
                    <span className="strong">{g.seller.name}</span>
                    <SellerBadge seller={g.seller} compact />
                  </span>
                  <span className="xs muted">
                    Package {i + 1} of {o.groups.length} · {how}
                  </span>
                </div>
              </div>
              <span className="row gap-2">
                <StatusBadge status={g.statusLabel} />
                {g.estimateLabel && <span className="xs strong">{g.estimateLabel}</span>}
              </span>
            </div>
            {g.items.map((it, k) => (
              <div className="buy-item" key={it.id}>
                <span>
                  <Img icon="package" tint={TINTS[(i + k + 1) % TINTS.length]} src={it.image?.url} alt={it.image?.alt ?? ''} />
                </span>
                <div className="stack gap-1">
                  <span className="buy-name">{it.title}</span>
                  <span className="xs sub">{[it.variantLabel, it.offerTerms?.conditionLabel, `Qty ${it.quantity}`].filter(Boolean).join(' · ')}</span>
                  <span>
                    <StatusBadge status={it.stateLabel} />
                  </span>
                </div>
                <div className="buy-item-side">
                  <span className="small strong num">{it.lineSubtotal.formatted}</span>
                </div>
              </div>
            ))}
            <div className="card-foot">
              {shipment && (
                <Button variant="secondary" size="sm" icon="truck" to={href('account/tracking', undefined, { ref: o.ref })}>
                  Track package
                </Button>
              )}
              <Button variant="ghost" size="sm" icon="life-buoy" to={href('help/order-problem')}>
                Get help
              </Button>
            </div>
          </section>
        );
      })}
      <div className="card pad buy-sum">
        <SummaryRow k={`Items (${o.totals.itemCount})`} v={o.totals.items.formatted} />
        {o.totals.discounts.map((d) => (
          <SummaryRow key={d.code ?? d.label} k={d.label} v={`−${d.amount.formatted}`} />
        ))}
        {shipRows.map((g) => (
          <SummaryRow key={g.id} k={`Shipping · ${g.seller.name}`} v={!g.delivery || g.delivery.free || g.delivery.price.amount === 0 ? 'Free' : g.delivery.price.formatted} />
        ))}
        <SummaryRow k="Tax" v={o.totals.tax.formatted} />
        <SummaryRow className="total" k="Total charged" v={o.totals.total.formatted} />
      </div>
      {st?.canCreateAccount && (
        <div className="panel row gap-3">
          <Icon name="user-plus" />
          <span className="small grow">Create an account{email ? ` with ${email}` : ''} to keep this order and future orders in one place.</span>
          <Link className="btn btn-secondary btn-sm" to={href('auth/register')} state={email && !email.includes('•') ? { email } : undefined}>
            <span>Create account</span>
          </Link>
        </div>
      )}
    </FoundFrame>
  );
}
