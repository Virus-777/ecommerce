import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from '@/app/session';
import { StoreLayout } from '@/layouts';
import { formatMoney } from '@marketly/web-shared/lib/format';
import { href } from '@marketly/web-shared/routes';
import { ApiError, call, errorMessage, useApi } from '@marketly/web-shared/api';
import { Alert, Badge, Button, Card, EmptyState, Icon, QuantityStepper, SectionHeader, SummaryRow, announce } from '@marketly/web-shared/ui';
import { ApiProductCard, ItemImg, PkgHead, PurchaseSkeleton, conditionLabel, plural, productHref } from './data/purchase';
import { checkoutHref, type CartItem, type CartNotice, type CartView } from './data/checkout-api';

// Design: pages/store/store-cart.html · view "empty" = no items. Data: GET /api/store/cart/cart (CartView),
// writes on /api/store/cart/cart/…; the empty cart shows recently viewed (customers + search cards).
// Save for later and "Tell me when it's back" are phase 3 (501 / wishlist off): hidden.

const CART_KEY = ['cart', 'view'] as const;

/** Bold the lead-in of a notice sentence ("Price changed since you added it: …"). */
function boldLead(msg: string): ReactNode {
  const i = msg.indexOf(': ');
  if (i <= 0 || i > 60) return msg;
  return (
    <>
      <b>{msg.slice(0, i + 1)}</b> {msg.slice(i + 2)}
    </>
  );
}

const UNAVAILABLE_BADGE: Partial<Record<CartNotice['kind'], string>> = {
  out_of_stock: 'Out of stock',
  offer_ended: 'No longer sold',
  seller_unavailable: 'Seller unavailable',
  product_unavailable: 'Unavailable',
  not_shippable: "Doesn't ship to you",
};

const ACCEPT_LABEL: Partial<Record<CartNotice['kind'], string>> = {
  price_increased: 'Keep it at the new price',
  terms_changed: 'Accept the new terms',
  coupon_no_longer_applies: 'Keep it without the coupon',
  delivery_estimate_changed: 'Keep the new delivery date',
};

export default function Cart() {
  const { api } = useApi();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { refreshCart } = useSession();
  const cartQ = useQuery({ queryKey: CART_KEY, queryFn: () => call(api.GET('/api/store/cart/cart')) });
  const cart = cartQ.data;
  const empty = !!cart && cart.packages.length === 0;

  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState('');
  const [lineError, setLineError] = useState<Record<string, string>>({});
  const [draftQty, setDraftQty] = useState<Record<string, number>>({});
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  useEffect(() => () => Object.values(timers.current).forEach(clearTimeout), []);

  const setCart = (c: CartView) => {
    qc.setQueryData(CART_KEY, c);
    refreshCart();
  };
  const lineFail = (id: string, e: unknown) => {
    let msg = errorMessage(e);
    if (e instanceof ApiError && e.code === 'QUANTITY_LIMIT_EXCEEDED' && typeof e.details.max === 'number') msg = `${e.message} You can buy up to ${e.details.max}.`;
    setLineError((m) => ({ ...m, [id]: msg }));
  };
  const clearLineError = (id: string) => setLineError(({ [id]: _, ...rest }) => rest);

  const qty = useMutation({
    mutationFn: ({ id, quantity }: { id: string; quantity: number }) => call(api.PATCH('/api/store/cart/cart/items/{id}', { params: { path: { id } }, body: { quantity } })),
    onSuccess: (c, v) => {
      setCart(c);
      clearLineError(v.id);
    },
    onError: (e, v) => lineFail(v.id, e),
    onSettled: (_d, _e, v) => setDraftQty(({ [v.id]: _, ...rest }) => rest),
  });
  const remove = useMutation({
    mutationFn: (l: CartItem) => call(api.DELETE('/api/store/cart/cart/items/{id}', { params: { path: { id: l.id } } })),
    onSuccess: (c, l) => {
      setCart(c);
      announce(`Removed ${l.title} from your cart`);
    },
    onError: (e, l) => lineFail(l.id, e),
  });
  const accept = useMutation({
    mutationFn: ({ l, notices }: { l: CartItem; notices: CartNotice[] }) => call(api.POST('/api/store/cart/cart/items/{id}/accept', { params: { path: { id: l.id } }, body: { noticeIds: notices.map((n) => n.id) } })),
    onSuccess: (c, { l }) => {
      setCart(c);
      clearLineError(l.id);
      announce(`${l.title} is ready for checkout`);
    },
    onError: (e, { l }) => lineFail(l.id, e),
  });
  const applyCoupon = useMutation({
    mutationFn: (c: string) => call(api.POST('/api/store/cart/cart/coupons', { body: { code: c } })),
    onSuccess: ({ cart: c, result }) => {
      setCart(c);
      if (result.status === 'applied') {
        setCode('');
        setCodeError('');
        announce(`${result.code} applied`);
      } else if (result.status === 'needs_sign_in') {
        setCodeError(result.reason ?? `${result.code} is an account coupon. Sign in to use it.`);
      } else {
        setCodeError(result.reason ?? `${result.code} can't be used on this order.`);
      }
    },
    onError: (e) => setCodeError(errorMessage(e)),
  });
  const removeCoupon = useMutation({
    mutationFn: (c: string) => call(api.DELETE('/api/store/cart/cart/coupons/{code}', { params: { path: { code: c } } })),
    onSuccess: (c, removed) => {
      setCart(c);
      announce(`${removed} removed`);
    },
    onError: (e) => setCodeError(errorMessage(e)),
  });
  const startCheckout = useMutation({
    mutationFn: () => call(api.POST('/api/store/checkout/sessions', { body: { source: 'cart' } })),
    onSuccess: (s) => navigate(checkoutHref(s.id)),
  });

  /** Quantity steps are sent once the shopper stops clicking (one PATCH per burst). */
  const setQty = (l: CartItem, q: number) => {
    setDraftQty((d) => ({ ...d, [l.id]: q }));
    clearTimeout(timers.current[l.id]);
    timers.current[l.id] = setTimeout(() => {
      if (q === l.quantity) setDraftQty(({ [l.id]: _, ...rest }) => rest);
      else qty.mutate({ id: l.id, quantity: q });
    }, 400);
  };

  const applyCode = (e: FormEvent) => {
    e.preventDefault();
    const c = code.trim().toUpperCase();
    if (!c) return setCodeError('Enter a coupon code.');
    if (cart?.coupons.some((x) => x.code === c && x.status === 'applied')) return setCodeError(`${c} is already applied.`);
    setCodeError('');
    applyCoupon.mutate(c);
  };

  if (!cart) {
    return (
      <StoreLayout tab="cart" appbar={{ title: 'Cart' }}>
        <div className="container page">
          <div className="buy-h1">
            <h1 className="h1 acct-h1">Your cart</h1>
          </div>
          {cartQ.isError ? (
            <Alert tone="danger" title="We couldn't load your cart">
              {errorMessage(cartQ.error)}{' '}
              <Button variant="secondary" size="sm" onClick={() => void cartQ.refetch()}>
                Try again
              </Button>
            </Alert>
          ) : (
            <PurchaseSkeleton label="your cart" />
          )}
        </div>
      </StoreLayout>
    );
  }

  if (empty) {
    return (
      <StoreLayout tab="cart" appbar={{ title: 'Cart' }}>
        <div className="container page">
          <h1 className="h1 acct-h1">Your cart</h1>
          <div className="card">
            <EmptyState
              icon="shopping-cart"
              title="Your cart is empty"
              as="h2"
              action={
                <div className="row gap-2 u-justify-center">
                  <Button to={href('store/home')}>Continue shopping</Button>
                  <Button variant="secondary" to={href('store/deals')}>
                    See today's deals
                  </Button>
                </div>
              }
            >
              Items you add from the Official Store and from marketplace sellers show up here, grouped by the package they ship in.
            </EmptyState>
          </div>
          <RecentlyViewed />
        </div>
      </StoreLayout>
    );
  }

  const t = cart.totals;
  const count = cart.itemCount;
  const ready = cart.checkoutReady;
  const officialPkg = cart.packages.some((p) => p.seller.official);
  const verified = [...new Set(cart.packages.filter((p) => !p.seller.official && p.seller.verified).map((p) => p.seller.name))];
  const checkoutBtn = (size?: 'lg') => (
    <Button size={size} block={size === 'lg'} disabled={!ready || startCheckout.isPending} onClick={() => startCheckout.mutate()} iconRight="arrow-right">
      {size === 'lg' && ready ? `Check out · ${formatMoney(t.total)}` : 'Check out'}
    </Button>
  );

  return (
    <StoreLayout
      tab="cart"
      appbar={{ title: `Cart (${count})` }}
      actionBar={
        <>
          <div className="stack gap-0 grow">
            <span className="xs muted">Total before tax</span>
            <span className="strong num u-fs-lg">{formatMoney(t.total)}</span>
          </div>
          {checkoutBtn()}
        </>
      }
    >
      <div className="container page">
        <div className="buy-h1">
          <h1 className="h1 acct-h1">Your cart</h1>
          <span className="sub small">
            {plural(count, 'item')} from {plural(cart.sellerCount, 'seller')} · {plural(cart.packageCount, 'package')}
          </span>
        </div>
        {cart.attention && (
          <Alert tone="warning" title={cart.attention.title}>
            {cart.attention.message}
          </Alert>
        )}
        <div className="split">
          <div className="stack gap-4">
            {cart.packages.map((pkg) => {
              const d = pkg.delivery;
              const shipNote = pkg.notShippable
                ? "Doesn't ship to your location"
                : d
                  ? [d.free || d.shipping.amount === 0 ? 'Free shipping' : `${formatMoney(d.shipping)} shipping`, d.freeShippingNote].filter(Boolean).join(' · ')
                  : null;
              return (
                <section key={pkg.key} className="card buy-pkg" aria-label={`${pkg.seller.name} package`}>
                  <PkgHead seller={pkg.seller} label={pkg.label} shipsFrom={pkg.shipsFrom} arrives={d?.arrivalLabel} shipNote={shipNote} />
                  {pkg.items.map((l) => (
                    <LineRow
                      key={l.id}
                      l={l}
                      qty={draftQty[l.id] ?? l.quantity}
                      error={lineError[l.id]}
                      busy={(remove.isPending && remove.variables?.id === l.id) || (accept.isPending && accept.variables?.l.id === l.id)}
                      onRemove={() => remove.mutate(l)}
                      onAccept={(notices) => accept.mutate({ l, notices })}
                      onQty={(q) => setQty(l, q)}
                    />
                  ))}
                  <div className="card-foot between">
                    <span className="xs muted">
                      <Icon name="undo-2" className="ic-sm" /> {pkg.returnTerms}
                    </span>
                    <span className="small strong num">Package subtotal {formatMoney(pkg.subtotal)}</span>
                  </div>
                </section>
              );
            })}
            <div className="row gap-2 xs muted">
              <Icon name="info" className="ic-sm" />
              <span>{cart.retentionNote}</span>
            </div>
          </div>
          <aside className="sticky-aside stack gap-4">
            <Card title="Order summary">
              <div className="buy-sum">
                <SummaryRow k={`Subtotal (${plural(t.itemCount, 'item')})`} v={formatMoney(t.itemsSubtotal)} />
                {t.discounts.map((d, i) => (
                  <SummaryRow key={`${d.code ?? d.label}-${i}`} className="discount" k={`Discounts · ${d.label}`} v={`−${formatMoney(d.amount)}`} />
                ))}
                {t.shippingByPackage.map((s) => (
                  <SummaryRow key={s.packageKey} k={`Shipping · ${s.sellerName}`} v={s.free || s.amount.amount === 0 ? 'Free' : formatMoney(s.amount)} />
                ))}
                <SummaryRow k="Estimated tax" v={<span className="sub">{t.taxNote}</span>} />
                <SummaryRow className="total" k="Total before tax" v={formatMoney(t.total)} />
              </div>
              <form className="field" onSubmit={applyCode} noValidate>
                <label className="label" htmlFor="cart-coupon">
                  Coupon code
                </label>
                <div className="row nowrap gap-2">
                  <input
                    className={codeError ? 'input is-error' : 'input'}
                    id="cart-coupon"
                    placeholder="Enter code"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    aria-invalid={codeError ? true : undefined}
                    aria-describedby={codeError ? 'cart-coupon-err' : cart.coupons.length ? 'cart-coupon-hint' : undefined}
                  />
                  <Button variant="secondary" type="submit" disabled={applyCoupon.isPending}>
                    Apply
                  </Button>
                </div>
                {codeError ? (
                  <span className="error-text" id="cart-coupon-err">
                    <Icon name="circle-alert" className="ic-sm" />
                    {codeError}
                  </span>
                ) : cart.coupons.length ? (
                  <span className="hint" id="cart-coupon-hint">
                    {cart.coupons.map((c) => (
                      <span key={c.code} className="u-d-flex">
                        {c.status === 'applied' ? (
                          <>
                            <Icon name="circle-check" className="ic-sm" /> {c.code} applied{c.amount ? `: ${formatMoney(c.amount)} off` : ''}.{' '}
                          </>
                        ) : (
                          <>
                            <Icon name="info" className="ic-sm" /> {c.reason ?? `${c.code} doesn't apply to this cart.`}{' '}
                          </>
                        )}
                        <a
                          href="#"
                          className="link-inline"
                          onClick={(e) => {
                            e.preventDefault();
                            removeCoupon.mutate(c.code);
                          }}
                        >
                          Remove
                        </a>
                      </span>
                    ))}
                  </span>
                ) : null}
              </form>
              {checkoutBtn('lg')}
              {startCheckout.isError && (
                <span className="error-text">
                  <Icon name="circle-alert" className="ic-sm" />
                  {errorMessage(startCheckout.error)}
                </span>
              )}
              {!ready && cart.checkoutBlockers.length > 0 && <span className="xs t-warning-text">{cart.checkoutBlockers.join(' ')}</span>}
              <p className="xs muted">
                You'll see delivery options per package and the final total, including tax, before you place the order.{' '}
                {cart.packageCount > 1 ? `${cart.packageCount} packages arrive separately.` : 'Everything arrives in one package.'}
              </p>
            </Card>
            <div className="card pad stack gap-2">
              <span className="small strong">
                <Icon name="shield-check" className="ic-sm" /> Every item shows who sells it
              </span>
              <span className="xs muted">
                {officialPkg && 'Marketly Official ships its own stock. '}
                {verified.length > 0 && `${verified.join(' and ')} ${verified.length === 1 ? 'is a verified seller that ships its' : 'are verified sellers that ship their'} own orders. `}
                <Link to={href('info/about')} className="link-inline">
                  What the labels mean
                </Link>
              </span>
            </div>
          </aside>
        </div>
      </div>
    </StoreLayout>
  );
}

/** Recently viewed products for the empty cart (customers recently-viewed → search cards). Hidden when there are none. */
function RecentlyViewed() {
  const { api } = useApi();
  const recent = useQuery({ queryKey: ['customers', 'recently-viewed'], queryFn: () => call(api.GET('/api/store/customers/recently-viewed')) });
  const ids = (recent.data ?? []).filter((r) => r.available).slice(0, 4).map((r) => r.productId);
  const cards = useQuery({
    queryKey: ['search', 'cards', ids],
    queryFn: () => call(api.GET('/api/store/search/cards', { params: { query: { ids } } })),
    enabled: ids.length > 0,
  });
  if (!cards.data?.length) return null;
  return (
    <section className="stack gap-4">
      <SectionHeader title="Recently viewed" />
      <div className="grid-products">
        {cards.data.map((p) => (
          <ApiProductCard key={p.productId} p={p} />
        ))}
      </div>
    </section>
  );
}

interface LineRowProps {
  l: CartItem;
  qty: number;
  error?: string;
  busy: boolean;
  onRemove: () => void;
  onAccept: (notices: CartNotice[]) => void;
  onQty: (q: number) => void;
}

function LineRow({ l, qty, error, busy, onRemove, onAccept, onQty }: LineRowProps) {
  const to = productHref(l.productId, l.productSlug);
  const blocking = l.notices.find((n) => n.severity === 'blocking');
  const unavailable = l.state === 'unavailable' || !!blocking;
  const priceUp = l.notices.find((n) => n.kind === 'price_increased');
  const toAccept = l.notices.filter((n) => n.actions.includes('accept'));
  const alt = l.notices.find((n) => n.alternatives && n.alternatives.count > 0)?.alternatives;
  const reduce = l.notices.find((n) => n.actions.includes('reduce_quantity') && n.availableQuantity);
  const unit = l.unitPrice.amount;
  const was = l.compareAtPrice && l.compareAtPrice.amount > unit ? l.compareAtPrice : null;

  const removeBtn = (
    <button type="button" aria-label={`Remove ${l.title} from cart`} onClick={onRemove} disabled={busy}>
      <Icon name="trash-2" className="ic-sm" />
      Remove
    </button>
  );
  const offersLink = alt && (
    <Link to={href('store/offers', '', { slug: (alt.productId === l.productId ? l.productSlug : null) || 'item', id: alt.productId })} aria-label={`See other offers (${alt.count}${alt.lowestPrice ? ` from ${formatMoney(alt.lowestPrice)}` : ''}): ${l.title}`}>
      <Icon name="store" className="ic-sm" />
      See other offers ({alt.count}
      {alt.lowestPrice ? ` from ${formatMoney(alt.lowestPrice)}` : ''})
    </Link>
  );
  const head = (
    <Link to={to} aria-label={l.title}>
      <ItemImg image={l.image} />
    </Link>
  );
  const sub = (
    <span className="xs sub">
      {l.variantLabel} · Condition: {conditionLabel(l.condition)}
    </span>
  );
  const errorLine = error && (
    <span className="error-text">
      <Icon name="circle-alert" className="ic-sm" />
      {error}
    </span>
  );

  if (unavailable) {
    const n = blocking ?? l.notices[0];
    return (
      <div className="buy-item is-unavail">
        {head}
        <div className="stack gap-1">
          <Link className="buy-name" to={to}>
            {l.title}
          </Link>
          {sub}
          <span>
            <Badge tone="danger">{(n && UNAVAILABLE_BADGE[n.kind]) ?? 'Unavailable'}</Badge>
          </span>
          <div className="buy-note t-danger">
            <Icon name="package-x" />
            <div className="stack gap-1">
              <span>{n ? n.message : "It can't be checked out right now."} The rest of your cart is unchanged.</span>
              <span className="buy-acts">
                {removeBtn}
                {offersLink}
              </span>
            </div>
          </div>
          {errorLine}
        </div>
        <div className="buy-item-side">
          <span className="small buy-strike num">{formatMoney(l.unitPrice)}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="buy-item">
      {head}
      <div className="stack gap-1">
        <Link className="buy-name" to={to}>
          {l.title}
        </Link>
        {sub}
        {l.sku && <span className="xs muted">SKU {l.sku}</span>}
        {l.notices.map((n) => (
          <div className="buy-note" key={n.id}>
            <Icon name={n.severity === 'info' ? 'info' : 'triangle-alert'} />
            <span>{boldLead(n.message)}</span>
          </div>
        ))}
        <div className="buy-acts mt-1">
          {removeBtn}
          {toAccept.length > 0 && (
            <button type="button" aria-label={`${ACCEPT_LABEL[toAccept[0].kind] ?? 'Accept the change'}: ${l.title}`} onClick={() => onAccept(toAccept)} disabled={busy}>
              <Icon name="check" className="ic-sm" />
              {ACCEPT_LABEL[toAccept[0].kind] ?? 'Accept the change'}
            </button>
          )}
          {reduce && (
            <button type="button" aria-label={`Change quantity to ${reduce.availableQuantity}: ${l.title}`} onClick={() => onQty(reduce.availableQuantity!)}>
              <Icon name="minus" className="ic-sm" />
              Buy the {reduce.availableQuantity} available
            </button>
          )}
          {offersLink}
        </div>
        {errorLine}
      </div>
      <div className="buy-item-side">
        <QuantityStepper className="sm" value={qty} min={1} max={Math.max(l.maxQuantity, 1)} label={`quantity, ${l.title}`} onChange={onQty} />
        <span className="stack gap-0 u-items-flex-end">
          <span className="price">
            <span className={was ? 'now sale' : 'now'}>{formatMoney({ amount: unit * qty, currency: l.unitPrice.currency })}</span>
            {was && <span className="was">{formatMoney({ amount: was.amount * qty, currency: was.currency })}</span>}
          </span>
          {qty > 1 && <span className="xs muted">{formatMoney(l.unitPrice)} each</span>}
          {priceUp?.previousPrice && priceUp.currentPrice && (
            <span className="xs t-warning-text strong">
              Up {formatMoney({ amount: priceUp.currentPrice.amount - priceUp.previousPrice.amount, currency: priceUp.currentPrice.currency })} from {formatMoney(priceUp.previousPrice)}
            </span>
          )}
        </span>
      </div>
    </div>
  );
}
