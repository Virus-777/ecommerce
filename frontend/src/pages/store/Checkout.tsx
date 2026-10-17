import { Fragment, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from '@/app/session';
import { CheckoutLayout } from '@/layouts';
import { formatMoney } from '@marketly/web-shared/lib/format';
import { href } from '@marketly/web-shared/routes';
import { ApiError, call, errorMessage, useApi, type Api } from '@marketly/web-shared/api';
import { Alert, Avatar, Badge, Button, Card, Checkbox, Dialog, Field, Icon, OptionCard, Select, SellerBadge, SummaryRow, TextInput, announce } from '@marketly/web-shared/ui';
import { BuyMini, CheckoutSteps, PurchaseSkeleton, SecN, plural } from './data/purchase';
import {
  DEV_CARDS,
  US_STATES,
  brandName,
  checkoutHref,
  checkoutKey,
  expiry,
  nextHref,
  orderWithin,
  paymentHref,
  returnUrl,
  routeForStatus,
  savedCardTitle,
  timePT,
  useAppConfig,
  useCheckoutSession,
  useIdempotencyKey,
  type Address,
  type CheckoutView,
  type CouponResult,
  type MethodSelection,
  type PlaceOrderResult,
  type SavedAddress,
} from './data/checkout-api';

// Design: pages/store/store-checkout.html. The checkout session id travels in the URL: /checkout?session=<id>
// (without it, a session is started from the cart and the URL is replaced). Data: GET/PUT/POST
// /api/store/checkout/sessions/{id}/… (CheckoutView), saved addresses (customers), app-config (support).
//   view "guest-checkout"  = signed out: follows the session (visitor token = guest)
//   view "coupon-rejected" = follows the real coupon result (POST …/coupons → status rejected + reason)
// Place order: Idempotency-Key per attempt → confirmation, payment result (failed / pending / bank check) or
// review changes, as PlaceOrderResult.next says. New cards use development provider tokens (gap G9).

export default function Checkout() {
  const [params] = useSearchParams();
  const session = params.get('session');
  return session ? <CheckoutPage key={session} id={session} /> : <StartFromCart />;
}

/** /checkout without a session: start one from the cart and put its id in the URL. */
function StartFromCart() {
  const { api } = useApi();
  const navigate = useNavigate();
  const started = useRef(false);
  const start = useMutation({
    mutationFn: () => call(api.POST('/api/store/checkout/sessions', { body: { source: 'cart' } })),
    onSuccess: (s) => navigate(checkoutHref(s.id), { replace: true }),
  });
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    start.mutate();
  }, [start]);
  return (
    <CheckoutShell>
      {start.isError ? (
        <Alert tone="warning" title={start.error instanceof ApiError && (start.error.code === 'CART_EMPTY' || start.error.code === 'NOTHING_TO_CHECK_OUT') ? 'Nothing to check out yet' : "We couldn't start checkout"}>
          {errorMessage(start.error)}{' '}
          <Link to={href('store/cart')} className="link-inline">
            Back to cart
          </Link>
        </Alert>
      ) : (
        <PurchaseSkeleton label="checkout" cards={3} />
      )}
    </CheckoutShell>
  );
}

function CheckoutShell({ children, current = 0 }: { children: ReactNode; current?: number }) {
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
        {children}
      </div>
    </CheckoutLayout>
  );
}

function CheckoutPage({ id }: { id: string }) {
  const q = useCheckoutSession(id);
  if (q.data) {
    const to = routeForStatus(q.data);
    // A failed payment can still be edited here (Place order then retries the payment).
    if (to && q.data.status !== 'payment_failed') return <Navigate to={to} replace />;
    return <CheckoutForm c={q.data} />;
  }
  if (q.isError) {
    const e = q.error;
    const gone = e instanceof ApiError && (e.code === 'SESSION_EXPIRED' || e.code === 'RETRY_WINDOW_EXPIRED' || e.status === 404 || e.status === 410);
    return (
      <CheckoutShell>
        {gone ? (
          <Alert tone="warning" title={e instanceof ApiError && e.status === 404 ? "We couldn't find this checkout" : 'This checkout has expired'}>
            {e instanceof ApiError && e.status === 404 ? 'It may have been started in another browser or session.' : errorMessage(e)} Nothing was charged.{' '}
            <Link to={href('store/cart')} className="link-inline">
              Start again from your cart
            </Link>
          </Alert>
        ) : (
          <Alert tone="danger" title="We couldn't load your checkout">
            {errorMessage(e)}{' '}
            <Button variant="secondary" size="sm" onClick={() => void q.refetch()}>
              Try again
            </Button>
          </Alert>
        )}
      </CheckoutShell>
    );
  }
  return (
    <CheckoutShell>
      <PurchaseSkeleton label="checkout" cards={4} />
    </CheckoutShell>
  );
}

/* ---------------- Address form ---------------- */

interface Addr {
  name: string;
  phone: string;
  line1: string;
  line2: string;
  city: string;
  region: string;
  zip: string;
}
type Errors = Partial<Record<string, string>>;

const EMPTY_ADDR: Addr = { name: '', phone: '', line1: '', line2: '', city: '', region: 'OR', zip: '' };
const digits = (s: string) => s.replace(/\D/g, '');
const fromApi = (a: Address): Addr => ({ name: a.name, phone: a.phone ?? '', line1: a.line1, line2: a.line2 ?? '', city: a.city, region: a.region, zip: a.postalCode });
const toApi = (a: Addr): Address => ({
  name: a.name.trim(),
  line1: a.line1.trim(),
  line2: a.line2.trim() || null,
  city: a.city.trim(),
  region: a.region,
  postalCode: a.zip.trim(),
  country: 'US',
  phone: a.phone.trim() || null,
});
const sameAddr = (a: Addr, b: Address | undefined | null) => !!b && JSON.stringify(toApi(a)) === JSON.stringify({ ...b, line2: b.line2 || null, phone: b.phone || null });

function addressErrors(a: Addr, prefix: string): Errors {
  const e: Errors = {};
  if (!a.name.trim()) e[`${prefix}name`] = 'Enter the name for delivery.';
  if (digits(a.phone).length < 10) e[`${prefix}phone`] = 'Enter a 10-digit phone number.';
  if (!a.line1.trim()) e[`${prefix}line1`] = 'Enter a street address.';
  if (!a.city.trim()) e[`${prefix}city`] = 'Enter a city.';
  if (!/^\d{5}$/.test(a.zip.trim())) e[`${prefix}zip`] = 'Enter a 5-digit ZIP code, like 97205.';
  return e;
}

/** ADDRESS_INVALID / VALIDATION_FAILED issues (`address.postalCode`) → form field errors. */
function serverAddressErrors(e: unknown, prefix: string): Errors | null {
  if (!(e instanceof ApiError) || (e.code !== 'ADDRESS_INVALID' && e.code !== 'VALIDATION_FAILED')) return null;
  const issues = (e.details.issues as Array<{ path?: string; field?: string; message: string }> | undefined) ?? [];
  const out: Errors = {};
  for (const i of issues) {
    const f = String(i.path ?? i.field ?? '').replace(/^(body\.)?(address\.)?/, '');
    const key = f === 'postalCode' ? 'zip' : f;
    if (['name', 'phone', 'line1', 'line2', 'city', 'region', 'zip'].includes(key)) out[`${prefix}${key}`] = i.message;
  }
  return Object.keys(out).length ? out : { [`${prefix}line1`]: e.message };
}

const addressLines = (a: Address) => (
  <>
    {a.name}
    <br />
    {a.line1}
    {a.line2 && `, ${a.line2}`}
    <br />
    {a.city}, {a.region} {a.postalCode}
    {a.phone && (
      <>
        <br />
        {a.phone}
      </>
    )}
  </>
);

/* ---------------- Payment choice ---------------- */

type Pay = `saved:${string}` | 'new';

function initialPay(c: CheckoutView): Pay {
  const sel = c.payment.selected;
  const saved = c.payment.options.savedMethods.filter((m) => !m.expired);
  if (sel?.kind === 'saved_card' && sel.savedMethodId) return `saved:${sel.savedMethodId}`;
  if (sel?.kind === 'new_card') return 'new';
  const def = saved.find((m) => m.isDefault) ?? saved[0];
  return def ? `saved:${def.id}` : 'new';
}

/* ---------------- The checkout ---------------- */

const STEP_INDEX = { account: 0, address: 1, delivery: 2, payment: 3 } as const;

function CheckoutForm({ c }: { c: CheckoutView }) {
  const id = c.id;
  const { api } = useApi();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { signedIn, customer, refreshCart } = useSession();
  const config = useAppConfig().data;
  const guest = !signedIn;
  const idem = useIdempotencyKey();

  const addressesQ = useQuery({
    queryKey: ['customers', 'addresses'],
    queryFn: () => call(api.GET('/api/store/customers/addresses')),
    enabled: signedIn,
  });
  const addresses: SavedAddress[] = addressesQ.data ?? [];

  const [contact, setContact] = useState({ email: c.account?.email ?? '', phone: c.account?.phone ?? '', account: c.account?.createAccountAfter ?? false });
  const [ga, setGa] = useState<Addr>(() => (c.address ? fromApi(c.address.address) : { ...EMPTY_ADDR }));
  const [gaServer, setGaServer] = useState<Errors>({});
  const [pay, setPay] = useState<Pay>(() => initialPay(c));
  const [devCard, setDevCard] = useState(DEV_CARDS[0].value);
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState('');
  const [rejected, setRejected] = useState<CouponResult | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'danger' | 'info' | 'warning'; title: string; body?: string } | null>(null);
  const [draft, setDraft] = useState<Addr | null>(null);
  const [draftTried, setDraftTried] = useState(false);
  const [draftServer, setDraftServer] = useState<Errors>({});

  const save = (v: CheckoutView) => qc.setQueryData(checkoutKey(id), v);
  const options = c.payment.options;

  /* ---------- writes ---------- */
  const putContact = (a: Api) =>
    call(a.PUT('/api/store/checkout/sessions/{id}/contact', { params: { path: { id } }, body: { email: contact.email.trim(), phone: contact.phone.trim() || null, createAccountAfter: contact.account } }));
  const contactM = useMutation({ mutationFn: () => putContact(api), onSuccess: save });

  const addressM = useMutation({
    mutationFn: (body: { addressId?: string; address?: Address; saveToAddressBook?: boolean }) => call(api.PUT('/api/store/checkout/sessions/{id}/address', { params: { path: { id } }, body })),
    onSuccess: (v) => {
      save(v);
      setGaServer({});
    },
  });
  const deliveryM = useMutation({
    mutationFn: (s: { packageKey: string; optionId: string }) => call(api.PUT('/api/store/checkout/sessions/{id}/delivery', { params: { path: { id } }, body: { selections: [s] } })),
    onSuccess: save,
    onError: (e) => setNotice({ tone: 'danger', title: "We couldn't change the delivery option", body: errorMessage(e) }),
  });
  const couponM = useMutation({
    mutationFn: (cd: string) => call(api.POST('/api/store/checkout/sessions/{id}/coupons', { params: { path: { id } }, body: { code: cd } })),
    onSuccess: ({ result, checkout }) => {
      save(checkout);
      if (result.status === 'applied') {
        setCode('');
        setCodeError('');
        setRejected(null);
        announce(`${result.code} applied`);
      } else if (result.status === 'needs_sign_in') {
        setRejected(null);
        setCodeError(result.reason ?? `${result.code} is an account coupon. Sign in to use it.`);
      } else {
        setRejected(result);
        setCodeError(`${result.code} can't be used on this order.`);
      }
    },
    onError: (e) => setCodeError(errorMessage(e)),
  });
  const couponRemoveM = useMutation({
    mutationFn: (cd: string) => call(api.DELETE('/api/store/checkout/sessions/{id}/coupons/{code}', { params: { path: { id, code: cd } } })),
    onSuccess: (v, cd) => {
      save(v);
      announce(`${cd} removed`);
    },
    onError: (e) => setCodeError(errorMessage(e)),
  });
  const creditM = useMutation({
    mutationFn: (use: boolean) => call(api.PUT('/api/store/checkout/sessions/{id}/credit', { params: { path: { id } }, body: { use } })),
    onSuccess: save,
    onError: (e) => setNotice({ tone: 'danger', title: "We couldn't apply your credit", body: errorMessage(e) }),
  });

  const method = (p: Pay = pay, card = devCard): MethodSelection =>
    p === 'new' ? { kind: 'new_card', providerToken: card } : { kind: 'saved_card', savedMethodId: p.slice('saved:'.length) };
  const putMethod = (m: MethodSelection) => call(api.PUT('/api/store/checkout/sessions/{id}/payment-method', { params: { path: { id } }, body: m }));
  const payM = useMutation({
    mutationFn: putMethod,
    onSuccess: save,
    onError: (e) => setNotice({ tone: 'danger', title: "We couldn't use this payment method", body: errorMessage(e) }),
  });
  const choosePay = (p: Pay, card = devCard) => {
    setPay(p);
    // A failed payment keeps its method until the retry; otherwise record the choice so the step shows done.
    if (c.status !== 'payment_failed') payM.mutate(method(p, card));
  };

  // Signed-in customers start with their default address.
  const autoAddr = useRef(false);
  useEffect(() => {
    if (autoAddr.current || guest || c.address || !addresses.length) return;
    autoAddr.current = true;
    const def = addresses.find((a) => a.isDefault) ?? addresses[0];
    addressM.mutate({ addressId: def.id });
  }, [guest, c.address, addresses, addressM]);

  // Record the preselected payment method so the Payment step counts as done (tokens are sent again at Place order).
  const autoPay = useRef(false);
  useEffect(() => {
    if (autoPay.current || c.payment.selected || c.status !== 'open' || addressM.isPending || (!guest && !c.address)) return;
    autoPay.current = true;
    payM.mutate(method());
  });

  /* ---------- validation ---------- */
  const errors: Errors = {};
  if (guest) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email.trim())) errors.email = 'Enter an email address, like name@example.com.';
    if (digits(contact.phone).length < 10) errors.gphone = 'Enter a 10-digit phone number.';
    Object.assign(errors, addressErrors(ga, 'a-'));
  }
  const shown: Errors = { ...(attempted ? errors : {}), ...gaServer };
  const nErrors = Object.keys(attempted ? errors : {}).length;

  const contactDirty = guest && (contact.email.trim() !== (c.account?.email ?? '') || contact.phone.trim() !== (c.account?.phone ?? '') || contact.account !== (c.account?.createAccountAfter ?? false));
  const addressDirty = guest && !sameAddr(ga, c.address?.address);

  /** Guest contact and address are saved as soon as they're complete (on leaving a field). */
  const saveContact = () => {
    if (contactDirty && !errors.email && !errors.gphone && !contactM.isPending) contactM.mutate();
  };
  const saveGuestAddress = () => {
    if (!addressDirty || Object.keys(addressErrors(ga, 'a-')).length || addressM.isPending) return;
    addressM.mutate({ address: toApi(ga) }, { onError: (e) => setGaServer(serverAddressErrors(e, 'a-') ?? { 'a-line1': errorMessage(e) }) });
  };

  /* ---------- Place order ---------- */
  const place = useMutation({
    mutationFn: async (): Promise<PlaceOrderResult | null> => {
      const shownTotal = c.totals.total.amount;
      let cur = c;
      if (contactDirty) cur = await putContact(api);
      if (addressDirty) {
        cur = await call(api.PUT('/api/store/checkout/sessions/{id}/address', { params: { path: { id } }, body: { address: toApi(ga) } }));
        save(cur);
      }
      const retry = cur.status === 'payment_failed';
      const m = method();
      if (!retry) cur = await putMethod(m);
      save(cur);
      if (!retry && !cur.readyToPlace) {
        setNotice({ tone: 'warning', title: 'Before you place your order', body: cur.blockers.join(' ') });
        return null;
      }
      if (cur.totals.total.amount !== shownTotal) {
        setNotice({ tone: 'info', title: 'Your total changed', body: `With your delivery address and options the total is now ${formatMoney(cur.totals.total)}. Check it, then place your order.` });
        return null;
      }
      const key = idem(`${retry ? 'retry' : 'place'}:${cur.quoteVersion}:${cur.totals.total.amount}:${JSON.stringify(m)}`);
      const header = { 'Idempotency-Key': key };
      return retry
        ? call(api.POST('/api/store/checkout/sessions/{id}/retry-payment', { params: { path: { id }, header }, body: { method: m, quoteVersion: cur.quoteVersion, expectedTotal: cur.totals.total, returnUrl: returnUrl(id) } }))
        : call(api.POST('/api/store/checkout/sessions/{id}/place', { params: { path: { id }, header }, body: { quoteVersion: cur.quoteVersion, expectedTotal: cur.totals.total, acceptTerms: true, channel: 'web', returnUrl: returnUrl(id) } }));
    },
    onSuccess: (r) => {
      if (!r) return;
      save(r.checkout);
      if (r.outcome === 'accepted' || r.outcome === 'payment_pending') refreshCart();
      navigate(nextHref(r, id));
    },
    onError: (e) => {
      const addr = serverAddressErrors(e, 'a-');
      if (addr && guest) {
        setGaServer(addr);
        setNotice({ tone: 'danger', title: 'Check your delivery address', body: errorMessage(e) });
        return;
      }
      if (e instanceof ApiError && (e.code === 'QUOTE_OUTDATED' || e.code === 'CONFLICT')) {
        void qc.invalidateQueries({ queryKey: checkoutKey(id) });
        setNotice({ tone: 'info', title: 'Your total changed', body: errorMessage(e) });
        return;
      }
      // Expired, or already placed (e.g. a retry after a lost response): re-read the session, which routes to the right page.
      if (e instanceof ApiError && ['SESSION_EXPIRED', 'RETRY_WINDOW_EXPIRED', 'ILLEGAL_TRANSITION'].includes(e.code)) void qc.invalidateQueries({ queryKey: checkoutKey(id) });
      setNotice({ tone: 'danger', title: "Your order wasn't placed", body: errorMessage(e) });
    },
  });

  const placeOrder = () => {
    setAttempted(true);
    setNotice(null);
    const n = Object.keys(errors).length;
    if (n) {
      announce(`Check ${plural(n, 'field')} before placing your order`);
      return;
    }
    place.mutate();
  };

  const applyCode = (e: FormEvent) => {
    e.preventDefault();
    const cd = code.trim().toUpperCase();
    setRejected(null);
    if (!cd) return setCodeError('Enter a coupon code.');
    if (c.coupons.some((x) => x.code === cd && x.status === 'applied')) return setCodeError(`${cd} is already applied.`);
    setCodeError('');
    couponM.mutate(cd);
  };

  const draftErrors: Errors = draft && draftTried ? { ...addressErrors(draft, ''), ...draftServer } : {};
  const saveDraft = () => {
    if (!draft) return;
    setDraftTried(true);
    setDraftServer({});
    if (Object.keys(addressErrors(draft, '')).length) return;
    addressM.mutate(
      { address: toApi(draft), saveToAddressBook: false },
      { onSuccess: () => setDraft(null), onError: (e) => setDraftServer(serverAddressErrors(e, '') ?? { line1: errorMessage(e) }) },
    );
  };

  /* ---------- derived ---------- */
  const stepStatus = (k: string) => c.steps.find((s) => s.key === k)?.status;
  const firstTodo = (Object.keys(STEP_INDEX) as Array<keyof typeof STEP_INDEX>).find((k) => stepStatus(k) !== 'done');
  const current = firstTodo ? STEP_INDEX[firstTodo] : 4;
  const t = c.totals;
  const applied = c.coupons.filter((x) => x.status === 'applied');
  const storedRejected = c.coupons.filter((x) => x.status === 'rejected' && x.code !== rejected?.code);
  const nPackages = c.packages.length;
  const selectedAddrId = addressM.isPending && addressM.variables?.addressId ? addressM.variables.addressId : c.address?.addressId;
  const oneOff = !guest && c.address && !c.address.addressId ? c.address : null;
  const support = config?.support;
  const guestBlocked = guest && config?.checkout.guestCheckoutEnabled === false;
  const name = c.account?.name ?? customer?.name ?? '';
  const email = c.account?.email ?? customer?.email ?? '';
  const busy = place.isPending;

  const addrField = (a: Addr, set: (a: Addr) => void, prefix: string, errs: Errors, idp: string, onBlur?: () => void) => (
    <>
      <div className="grid md2">
        <Field label="Full name" error={errs[`${prefix}name`]}>
          <TextInput id={`${idp}name`} value={a.name} error={!!errs[`${prefix}name`]} autoComplete="name" onChange={(e) => set({ ...a, name: e.target.value })} onBlur={onBlur} />
        </Field>
        <Field label="Phone" error={errs[`${prefix}phone`]}>
          <TextInput id={`${idp}phone`} type="tel" value={a.phone} error={!!errs[`${prefix}phone`]} autoComplete="tel" onChange={(e) => set({ ...a, phone: e.target.value })} onBlur={onBlur} />
        </Field>
      </div>
      <Field label="Street address" error={errs[`${prefix}line1`]}>
        <TextInput id={`${idp}line1`} value={a.line1} error={!!errs[`${prefix}line1`]} autoComplete="address-line1" onChange={(e) => set({ ...a, line1: e.target.value })} onBlur={onBlur} />
      </Field>
      <Field label="Apartment, suite, floor" optional>
        <TextInput id={`${idp}line2`} value={a.line2} autoComplete="address-line2" onChange={(e) => set({ ...a, line2: e.target.value })} onBlur={onBlur} />
      </Field>
      <div className="grid md3">
        <Field label="City" error={errs[`${prefix}city`]}>
          <TextInput id={`${idp}city`} value={a.city} error={!!errs[`${prefix}city`]} autoComplete="address-level2" onChange={(e) => set({ ...a, city: e.target.value })} onBlur={onBlur} />
        </Field>
        <Field label="State" error={errs[`${prefix}region`]}>
          <Select id={`${idp}state`} options={US_STATES} value={a.region} autoComplete="address-level1" onChange={(e) => set({ ...a, region: e.target.value })} onBlur={onBlur} />
        </Field>
        <Field label="ZIP code" error={errs[`${prefix}zip`]}>
          <TextInput id={`${idp}zip`} value={a.zip} error={!!errs[`${prefix}zip`]} inputMode="numeric" autoComplete="postal-code" onChange={(e) => set({ ...a, zip: e.target.value })} onBlur={onBlur} />
        </Field>
      </div>
    </>
  );

  return (
    <CheckoutShell current={current}>
      {c.status === 'payment_failed' && c.lastPayment && (
        <Alert tone="danger" title={c.lastPayment.title}>
          {c.lastPayment.decline?.message ?? c.lastPayment.message}
          {c.holdUntil && ` Prices and stock are held until ${timePT(c.holdUntil)}.`} Placing the order again retries the payment.{' '}
          <Link to={paymentHref(id, c.lastPayment.intentId)} className="link-inline">
            Payment details
          </Link>
        </Alert>
      )}
      {guestBlocked && (
        <Alert tone="warning" title="Sign in to check out">
          Guest checkout is turned off right now.{' '}
          <Link to={href('auth/sign-in')} className="link-inline">
            Sign in or create an account
          </Link>{' '}
          to place your order.
        </Alert>
      )}
      <div className="split">
        <div className="stack gap-4">
          {/* 1. Account / contact */}
          <section className="card">
            <div className="card-head">
              <div className="row gap-3 nowrap">
                <SecN n={1} done={stepStatus('account') === 'done'} />
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
                    <Field label="Email" hint={c.account?.note ?? "We'll email a link to view and manage this order."} error={shown.email}>
                      <TextInput id="co-g-email" type="email" value={contact.email} error={!!shown.email} autoComplete="email" onChange={(e) => setContact({ ...contact, email: e.target.value })} onBlur={saveContact} />
                    </Field>
                    <Field label="Mobile phone" hint="Only for delivery updates about this order." error={shown.gphone}>
                      <TextInput id="co-g-phone" type="tel" value={contact.phone} error={!!shown.gphone} autoComplete="tel" onChange={(e) => setContact({ ...contact, phone: e.target.value })} onBlur={saveContact} />
                    </Field>
                  </div>
                  {(config?.checkout.offerAccountAfterGuestPurchase ?? true) && (
                    <Checkbox id="co-g-acct" label="Create an account after checkout so I can track all my orders in one place" checked={contact.account} onChange={(e) => setContact({ ...contact, account: e.target.checked })} onBlur={saveContact} />
                  )}
                  {contactM.isError && (
                    <span className="error-text">
                      <Icon name="circle-alert" className="ic-sm" />
                      {errorMessage(contactM.error)}
                    </span>
                  )}
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
                  <Avatar name={name || 'Customer'} />
                  <div className="stack gap-0 grow">
                    <span className="small strong">Signed in as {name}</span>
                    <span className="xs muted">{email} · Order updates go here</span>
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
                <SecN n={2} done={stepStatus('address') === 'done'} />
                <h2 className="h4">Delivery address</h2>
              </div>
            </div>
            <div className="card-body">
              {guest ? (
                addrField(ga, setGa, 'a-', shown, 'co-a-', saveGuestAddress)
              ) : (
                <>
                  {addressesQ.isError && (
                    <Alert tone="danger" title="We couldn't load your saved addresses">
                      {errorMessage(addressesQ.error)}{' '}
                      <Button variant="secondary" size="sm" onClick={() => void addressesQ.refetch()}>
                        Try again
                      </Button>
                    </Alert>
                  )}
                  <div className="buy-opts c2">
                    {addresses.map((a) => (
                      <OptionCard
                        key={a.id}
                        id={`co-addr-${a.id}`}
                        name="co-addr"
                        checked={selectedAddrId === a.id}
                        disabled={addressM.isPending}
                        onChange={() => addressM.mutate({ addressId: a.id })}
                        title={
                          <span className="row gap-2">
                            <span className="strong small">{a.label ?? 'Address'}</span>
                            {a.isDefault && <Badge>Default</Badge>}
                          </span>
                        }
                        body={addressLines(a.address)}
                      />
                    ))}
                    {oneOff && (
                      <OptionCard
                        id="co-addr-new"
                        name="co-addr"
                        checked={!selectedAddrId}
                        title={<span className="strong small">New address</span>}
                        body={addressLines(oneOff.address)}
                      />
                    )}
                  </div>
                  {addressesQ.isSuccess && !addresses.length && !oneOff && <p className="xs muted">You have no saved addresses yet. Add one for this order.</p>}
                  <div className="row between">
                    <Button
                      variant="ghost"
                      size="sm"
                      icon="plus"
                      onClick={() => {
                        setDraft({ ...EMPTY_ADDR, name: customer?.name ?? '', phone: customer?.phone ?? '' });
                        setDraftTried(false);
                        setDraftServer({});
                      }}
                    >
                      Add a new address
                    </Button>
                    <span className="xs muted">Changing an address here doesn't update your saved addresses.</span>
                  </div>
                </>
              )}
              {addressM.isError && !guest && !draft && (
                <span className="error-text">
                  <Icon name="circle-alert" className="ic-sm" />
                  {errorMessage(addressM.error)}
                </span>
              )}
              {c.address && (
                <div className={c.address.allShippable ? 'buy-note t-success' : 'buy-note t-warning'}>
                  <Icon name={c.address.allShippable ? 'circle-check' : 'triangle-alert'} />
                  <span>
                    <b>{c.address.message}</b> {c.address.allShippable ? (guest ? "We checked each seller's delivery area." : c.address.locationNote) : null}
                    {c.address.lines
                      .filter((l) => !l.shippable)
                      .map((l) => (
                        <Fragment key={l.lineId}>
                          <br />
                          {l.title} ({l.sellerName}): {l.message ?? "doesn't ship here"}
                        </Fragment>
                      ))}
                  </span>
                </div>
              )}
            </div>
          </section>

          {/* 3. Delivery options */}
          <section className="card">
            <div className="card-head">
              <div className="row gap-3 nowrap">
                <SecN n={3} done={stepStatus('delivery') === 'done'} />
                <h2 className="h4">Delivery options for each package</h2>
              </div>
            </div>
            <div className="card-body">
              <p className="xs muted">{c.packagesNote}</p>
              {c.packages.map((pkg, gi) => {
                const selected = deliveryM.isPending && deliveryM.variables?.packageKey === pkg.key ? deliveryM.variables.optionId : pkg.selectedOptionId;
                return (
                  <Fragment key={pkg.key}>
                    {gi > 0 && <hr />}
                    <div className="stack gap-2">
                      <div className="row between">
                        <span className="row gap-2">
                          <span className="small strong">
                            {pkg.label}: {pkg.seller.name}
                          </span>
                          <SellerBadge seller={pkg.seller} compact />
                        </span>
                        <span className="xs muted">{pkg.lines.map((l) => l.title).join(' · ')}</span>
                      </div>
                      {pkg.options.length ? (
                        <div className="buy-opts c2">
                          {pkg.options.map((o) => (
                            <OptionCard
                              key={o.id}
                              id={`co-ship-${gi}-${o.methodCode}`}
                              name={`co-ship-${gi}`}
                              checked={selected === o.id}
                              disabled={deliveryM.isPending}
                              onChange={() => deliveryM.mutate({ packageKey: pkg.key, optionId: o.id })}
                              title={
                                <span className="row between">
                                  <span className="strong small">{o.arrivalLabel}</span>
                                  <span className="small strong num">{o.free || o.price.amount === 0 ? 'Free' : formatMoney(o.price)}</span>
                                </span>
                              }
                              body={[o.methodName, (!o.isDefault && orderWithin(o.cutoffAt)) || o.dispatchLabel, o.carrierService].filter(Boolean).join(' · ')}
                            />
                          ))}
                        </div>
                      ) : (
                        <span className="xs muted">{c.address ? "This package can't be delivered to this address." : 'Delivery options and dates appear once you enter a delivery address.'}</span>
                      )}
                    </div>
                  </Fragment>
                );
              })}
            </div>
          </section>

          {/* 4. Coupons (store credit is phase 3: shown only when the API returns it) */}
          <section className="card">
            <div className="card-head">
              <div className="row gap-3 nowrap">
                <SecN n={4} done={stepStatus('coupons') === 'done' && !rejected} />
                <h2 className="h4">{c.credit ? 'Coupons and credit' : 'Coupons'}</h2>
              </div>
            </div>
            <div className="card-body">
              <form className="field" onSubmit={applyCode} noValidate>
                <label className="label" htmlFor="co-coupon">
                  {applied.length && !codeError ? 'Add another code' : 'Coupon code'}
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
                  <Button variant="secondary" type="submit" disabled={couponM.isPending}>
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
                    Some coupons are for Marketly accounts only. To use them,{' '}
                    <Link to={href('auth/sign-in')} className="link-inline">
                      sign in
                    </Link>
                    .
                  </span>
                ) : null}
              </form>
              {[...(rejected ? [rejected] : []), ...storedRejected].map((r) => (
                <Alert key={r.code} tone="danger" title={`Why ${r.code} was rejected`}>
                  {r.reason ?? "It doesn't apply to the items in this order."} {r.otherDiscountsNote ?? (applied.length ? 'Your other discount is unchanged.' : '')}
                </Alert>
              ))}
              {applied.map((cp) => (
                <div className="panel stack gap-2" key={cp.code}>
                  <div className="row between">
                    <span className="row gap-2">
                      <span className="badge t-deal-soft">
                        <Icon name="ticket-percent" />
                        {cp.code}
                      </span>
                      <span className="small strong">Applied{cp.amount ? ` · −${formatMoney(cp.amount)}` : ''}</span>
                    </span>
                    <a
                      className="small"
                      href="#"
                      onClick={(e) => {
                        e.preventDefault();
                        couponRemoveM.mutate(cp.code);
                      }}
                    >
                      Remove
                    </a>
                  </div>
                  {(() => {
                    const sub = [cp.label, cp.fundingNote].filter(Boolean).join('. ');
                    return sub ? <span className="xs sub">{sub}</span> : null;
                  })()}
                  {(cp.coverage.length > 0 || cp.notCovered.length > 0) && (
                    <span className="xs">
                      {cp.coverage.length > 0 && (
                        <>
                          <b>Covers:</b> {cp.coverage.map((x) => `${x.title} (−${formatMoney(x.amount)})`).join(', ')}.{' '}
                        </>
                      )}
                      {cp.notCovered.length > 0 && (
                        <>
                          <b>Not covered:</b> {cp.notCovered.map((x) => `${x.title}, ${x.reason.charAt(0).toLowerCase()}${x.reason.slice(1)}`).join('; ')}.
                        </>
                      )}
                    </span>
                  )}
                </div>
              ))}
              {c.credit && !guest && (
                <Checkbox
                  id="co-credit"
                  checked={creditM.isPending ? !!creditM.variables : c.credit.use}
                  disabled={creditM.isPending}
                  onChange={(e) => creditM.mutate(e.target.checked)}
                  label={
                    <>
                      Use my Marketly credit: <b>{formatMoney(c.credit.available)} available</b> ({c.credit.sourceNote})
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
                <SecN n={5} done={stepStatus('payment') === 'done'} />
                <h2 className="h4">Payment method</h2>
              </div>
            </div>
            <div className="card-body">
              <div className="buy-opts">
                {options.savedMethods.map((m) => (
                  <OptionCard
                    key={m.id}
                    id={`co-pay-${m.id}`}
                    name="co-pay"
                    checked={pay === `saved:${m.id}`}
                    disabled={m.expired}
                    onChange={() => choosePay(`saved:${m.id}`)}
                    title={
                      <span className="row gap-2">
                        <span className="small strong">{savedCardTitle(m)}</span>
                        <Badge>Saved</Badge>
                        {m.expired && <Badge tone="danger">Expired</Badge>}
                      </span>
                    }
                    body={[m.label, `Expires ${expiry(m)}`, m.billingSummary && `Billing address ${m.billingSummary}`].filter(Boolean).join(' · ')}
                    right={<Icon name="credit-card" />}
                  />
                ))}
                <OptionCard
                  id="co-pay-new"
                  name="co-pay"
                  checked={pay === 'new'}
                  onChange={() => choosePay('new')}
                  title={<span className="small strong">New debit or credit card</span>}
                  body={options.acceptedBrands.map(brandName).join(', ')}
                  right={<Icon name="plus" />}
                />
                {pay === 'new' && (
                  <div className="well stack gap-3">
                    <Field
                      label="Test card"
                      hint="Development only: Marketly never receives card numbers. In production the payment provider's secure card fields go here; for now, pick a test card."
                    >
                      <Select
                        id="co-card-test"
                        options={DEV_CARDS}
                        value={devCard}
                        onChange={(e) => {
                          setDevCard(e.target.value);
                          choosePay('new', e.target.value);
                        }}
                      />
                    </Field>
                  </div>
                )}
              </div>
              <span className="xs muted">
                <Icon name="lock" className="ic-sm" /> {c.payment.chargeNote}
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
              {c.packages.map((pkg, gi) => {
                const opt = pkg.options.find((o) => o.id === pkg.selectedOptionId);
                const byPrefix = 'Sold and shipped by ';
                return (
                  <Fragment key={pkg.key}>
                    {gi > 0 && <hr />}
                    <div className="stack gap-3">
                      <div className="row between">
                        <span className="row gap-2">
                          <span className="small strong">{pkg.label}</span>
                          <span className="xs sub">
                            {pkg.soldAndShippedBy.startsWith(byPrefix) ? (
                              <>
                                {byPrefix}
                                <b>{pkg.soldAndShippedBy.slice(byPrefix.length)}</b>
                              </>
                            ) : (
                              pkg.soldAndShippedBy
                            )}
                          </span>
                          <SellerBadge seller={pkg.seller} compact />
                        </span>
                        {opt && (
                          <span className="xs strong">
                            <Icon name="calendar-check" className="ic-sm" /> {opt.arrivalLabel}
                          </span>
                        )}
                      </div>
                      {pkg.lines.map((l) => (
                        <BuyMini
                          key={l.id}
                          image={l.image}
                          name={l.title}
                          sub={[l.variantLabel, l.condition, `Qty ${l.quantity}`, l.status !== 'included' ? (l.note ?? 'Not included') : null].filter(Boolean).join(' · ')}
                          amount={formatMoney(l.lineTotal)}
                        />
                      ))}
                      <span className="xs muted">
                        <Icon name="undo-2" className="ic-sm" /> Return terms: {pkg.returnTerms} · {pkg.sellerSupport}
                      </span>
                    </div>
                  </Fragment>
                );
              })}
              {c.excludedLines.length > 0 && (
                <Alert tone="warning" title={`${plural(c.excludedLines.length, 'item')} from your cart ${c.excludedLines.length === 1 ? "isn't" : "aren't"} in this order`}>
                  {c.excludedLines.map((l) => `${l.title}${l.note ? ` (${l.note})` : ''}`).join(', ')}. {c.excludedLines.length === 1 ? 'It stays' : 'They stay'} in your cart.
                </Alert>
              )}
            </div>
          </section>
        </div>

        <aside className="sticky-aside stack gap-4">
          <Card title="Order total" titleAs="h3">
            <div className="buy-sum">
              <SummaryRow k={`Items (${t.itemCount})`} v={formatMoney(t.items)} />
              {t.discounts.map((d, i) => (
                <SummaryRow key={`${d.code ?? d.label}-${i}`} className="discount" k={d.label} v={`−${formatMoney(d.amount)}`} />
              ))}
              {t.creditApplied.amount > 0 && <SummaryRow className="discount" k="Marketly credit" v={`−${formatMoney(t.creditApplied)}`} />}
              {t.shippingByPackage.length > 0 && t.shippingByPackage.every((s) => s.pending) ? (
                <SummaryRow k="Shipping" v={<span className="sub">Calculated at the next step</span>} />
              ) : (
                t.shippingByPackage.map((s) => (
                  <SummaryRow key={s.packageKey} k={`Shipping · ${s.sellerName}`} v={s.pending ? <span className="sub">Calculated at the next step</span> : s.free || s.amount.amount === 0 ? 'Free' : formatMoney(s.amount)} />
                ))
              )}
              {t.tax.length ? t.tax.map((x) => <SummaryRow key={x.jurisdiction} k={x.label} v={formatMoney(x.amount)} />) : <SummaryRow k="Tax" v={<span className="sub">{t.taxNote ?? formatMoney(t.taxTotal)}</span>} />}
              <SummaryRow className="total" k="Total" v={formatMoney(t.total)} />
            </div>
            {nErrors > 0 && (
              <Alert tone="danger" title={`Check ${plural(nErrors, 'field')}`}>
                Fix the highlighted fields to place your order.
              </Alert>
            )}
            {notice && (
              <Alert tone={notice.tone} title={notice.title}>
                {notice.body}
              </Alert>
            )}
            <Button size="lg" block onClick={placeOrder} disabled={busy || guestBlocked}>
              {busy ? 'Placing your order…' : `Place order · ${formatMoney(t.total)}`}
            </Button>
            <p className="xs muted">
              <Icon name="shield-check" className="ic-sm" /> {c.doubleSubmitNote}
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
              {support && `Call ${support.phone}, ${support.hoursLabel}, or `}
              <Link to={href('help/center')} className="link-inline">
                {support ? 'visit the Help Center' : 'Visit the Help Center'}
              </Link>
              .
            </span>
          </div>
        </aside>
      </div>
      <div className="action-bar no-desktop">
        <div className="stack gap-0 grow">
          <span className="xs muted">Total · {plural(nPackages, 'package')}</span>
          <span className="strong num u-fs-lg">{formatMoney(t.total)}</span>
        </div>
        <Button onClick={placeOrder} disabled={busy || guestBlocked}>
          Place order
        </Button>
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
            <Button onClick={saveDraft} disabled={addressM.isPending}>
              Use this address
            </Button>
          </>
        }
      >
        {draft && addrField(draft, setDraft, '', draftErrors, 'co-new-')}
        <span className="xs muted">Used for this order only. Your saved addresses don't change.</span>
      </Dialog>
    </CheckoutShell>
  );
}
