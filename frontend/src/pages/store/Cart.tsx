import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { useSession } from '@/app/session';
import { StoreLayout } from '@/layouts';
import { useView } from '@/lib/hooks';
import { money } from '@/lib/format';
import { P, sellers, type Product } from '@/data/fixtures';
import { href } from '@/routes/href';
import { Alert, Badge, Button, Card, EmptyState, Icon, Img, ProductCard, QuantityStepper, SectionHeader, SummaryRow, announce } from '@/ui';
import { CART_LINES, COUPON_WELCOME, PkgHead, groupBySeller, pkgMeta, plural, standardShipping, type CartLine } from './data/purchase';

// Design: pages/store/store-cart.html · view "empty" = no items (also reached by removing the last item).

const SAVED_INITIAL: Product[] = [P.kestrel27, P.bottle];
const RECENT: Product[] = [P.aurora, P.skillet, P.sweater, P.keyboard];
const freshLines = () => CART_LINES.map((l) => ({ ...l }));

const lineFromProduct = (p: Product): CartLine => ({
  id: `s-${p.id}`,
  name: p.name,
  short: p.name,
  icon: p.icon,
  tint: p.tint,
  variant: 'Standard',
  condition: 'New',
  sku: p.sku,
  price: p.price,
  was: p.was,
  qty: 1,
  seller: p.seller,
});

export default function Cart() {
  const [view, setView] = useView<'empty'>();
  const { setCartCount } = useSession();
  const [lines, setLines] = useState<CartLine[]>(() => (view === 'empty' ? [] : freshLines()));
  const [saved, setSaved] = useState<Product[]>(SAVED_INITIAL);
  const [savedThisVisit, setSavedThisVisit] = useState(false);
  const [notify, setNotify] = useState<Record<string, boolean>>({});
  const [coupon, setCoupon] = useState<string | null>(view === 'empty' ? null : COUPON_WELCOME.code);
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState('');

  // The views are linkable: ?view=empty clears the cart; leaving it restores the sample cart.
  useEffect(() => {
    if (view === 'empty') setLines([]);
    else setLines((l) => (l.length ? l : freshLines()));
  }, [view]);

  const available = lines.filter((l) => !l.soldOut);
  const count = available.reduce((s, l) => s + l.qty, 0);
  useEffect(() => setCartCount(count), [count, setCartCount]);

  const groups = groupBySeller(lines);
  const pkgItems = (ls: CartLine[]) => ls.filter((l) => !l.soldOut).reduce((s, l) => s + l.price * l.qty, 0);
  const shipping = groups.map((g) => ({ has: g.lines.some((l) => !l.soldOut), cost: standardShipping(g.seller, pkgItems(g.lines)) }));
  const subtotal = available.reduce((s, l) => s + l.price * l.qty, 0);
  const couponOk = coupon !== null && subtotal >= COUPON_WELCOME.minimum;
  const discount = couponOk ? COUPON_WELCOME.amount : 0;
  const shipTotal = shipping.filter((s) => s.has).reduce((s, x) => s + x.cost, 0);
  const total = subtotal - discount + shipTotal;
  const priceUps = lines.filter((l) => l.priceChange).length;
  const soldOuts = lines.filter((l) => l.soldOut).length;
  const attention = priceUps + soldOuts;

  const removeLine = (l: CartLine) => {
    const next = lines.filter((x) => x.id !== l.id);
    setLines(next);
    if (!next.length) setView('empty', { replace: true });
  };
  const remove = (l: CartLine) => {
    removeLine(l);
    announce(`Removed ${l.name} from your cart`);
  };
  const saveForLater = (l: CartLine) => {
    const p = Object.values(P).find((x) => x.sku === l.sku);
    if (p && !saved.some((s) => s.id === p.id)) setSaved((s) => [p, ...s]);
    setSavedThisVisit(true);
    removeLine(l);
    announce(`Saved ${l.name} for later`);
  };
  const moveToCart = (p: Product) => {
    setSaved((s) => s.filter((x) => x.id !== p.id));
    setLines((ls) => {
      const existing = ls.find((x) => x.sku === p.sku && !x.soldOut);
      return existing ? ls.map((x) => (x === existing ? { ...x, qty: x.qty + 1 } : x)) : [...ls, lineFromProduct(p)];
    });
    if (view === 'empty') setView('', { replace: true });
    announce(`Moved ${p.name} to your cart`);
  };
  const setQty = (id: string, qty: number) => setLines((ls) => ls.map((l) => (l.id === id ? { ...l, qty } : l)));

  const applyCode = (e: FormEvent) => {
    e.preventDefault();
    const c = code.trim().toUpperCase();
    if (!c) return setCodeError('Enter a coupon code.');
    if (c !== COUPON_WELCOME.code) return setCodeError(`${c} isn't a valid coupon code. Check the spelling and try again.`);
    if (coupon) return setCodeError(`${c} is already applied.`);
    setCoupon(c);
    setCode('');
    setCodeError('');
    announce(`${c} applied`);
  };
  const removeCoupon = () => {
    announce(`${coupon} removed`);
    setCoupon(null);
  };

  const savedSection = saved.length > 0 && (
    <section className="stack gap-4">
      <SectionHeader title={`Saved for later (${saved.length})`} />
      <div className="grid-products">
        {saved.map((p) => (
          <div className="stack gap-2" key={p.id}>
            <ProductCard p={p} showSeller />
            <Button variant="secondary" size="sm" block onClick={() => moveToCart(p)}>
              Move to cart
            </Button>
          </div>
        ))}
      </div>
    </section>
  );

  if (!lines.length) {
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
          {savedSection}
          <section className="stack gap-4">
            <SectionHeader title="Recently viewed" link="See all" to={href('store/collection', 'best-sellers')} />
            <div className="grid-products">
              {RECENT.map((p) => (
                <ProductCard key={p.id} p={p} compact />
              ))}
            </div>
          </section>
        </div>
      </StoreLayout>
    );
  }

  const checkout = count ? (
    <Button size="lg" block to={href('store/checkout')} iconRight="arrow-right">
      Check out · {money(total)}
    </Button>
  ) : (
    <Button size="lg" block disabled iconRight="arrow-right">
      Check out
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
            <span className="strong num u-fs-lg">{money(total)}</span>
          </div>
          {count ? (
            <Button to={href('store/checkout')} iconRight="arrow-right">
              Check out
            </Button>
          ) : (
            <Button disabled iconRight="arrow-right">
              Check out
            </Button>
          )}
        </>
      }
    >
      <div className="container page">
        <div className="buy-h1">
          <h1 className="h1 acct-h1">Your cart</h1>
          <span className="sub small">
            {plural(count, 'item')} from {plural(groups.length, 'seller')} · {plural(groups.length, 'package')}
          </span>
        </div>
        {attention > 0 && (
          <Alert tone="warning" title={`${plural(attention, 'item')} ${attention === 1 ? 'needs' : 'need'} your attention`}>
            {[
              priceUps ? `${priceUps === 1 ? 'One price' : `${priceUps} prices`} went up since you added ${priceUps === 1 ? 'it' : 'them'}` : '',
              soldOuts ? `${soldOuts === 1 ? 'one item' : `${soldOuts} items`} sold out` : '',
            ]
              .filter(Boolean)
              .join(' and ')
              .replace(/^./, (c) => c.toUpperCase())}
            . Everything else is ready for checkout.
          </Alert>
        )}
        <div className="split">
          <div className="stack gap-4">
            {groups.map((g, gi) => {
              const meta = pkgMeta(g.seller);
              const ship = shipping[gi];
              return (
                <section key={g.seller} className="card buy-pkg" aria-label={`${sellers[g.seller].name} package`}>
                  <PkgHead seller={g.seller} index={gi + 1} total={groups.length} arrives={meta.options[0].arrives} shipNote={meta.shipNote} />
                  {g.lines.map((l) => (
                    <LineRow
                      key={l.id}
                      l={l}
                      notified={!!notify[l.id]}
                      onNotify={() => setNotify((n) => ({ ...n, [l.id]: !n[l.id] }))}
                      onRemove={() => remove(l)}
                      onSave={() => saveForLater(l)}
                      onQty={(q) => setQty(l.id, q)}
                    />
                  ))}
                  <div className="card-foot between">
                    <span className="xs muted">
                      <Icon name="undo-2" className="ic-sm" /> {meta.returns}
                    </span>
                    <span className="small strong num">Package subtotal {money(pkgItems(g.lines) + (ship.has ? ship.cost : 0))}</span>
                  </div>
                </section>
              );
            })}
            <div className="row gap-2 xs muted">
              <Icon name="info" className="ic-sm" />
              <span>Items stay in your cart for 30 days. Prices and stock are checked again at checkout.</span>
            </div>
            {savedThisVisit && savedSection}
          </div>
          <aside className="sticky-aside stack gap-4">
            <Card title="Order summary">
              <div className="buy-sum">
                <SummaryRow k={`Subtotal (${plural(count, 'item')})`} v={money(subtotal)} />
                {couponOk && <SummaryRow className="discount" k={`Discounts · ${coupon}`} v={`−${money(discount)}`} />}
                {groups.map((g, gi) => (shipping[gi].has ? <SummaryRow key={g.seller} k={`Shipping · ${sellers[g.seller].name}`} v={shipping[gi].cost ? money(shipping[gi].cost) : 'Free'} /> : null))}
                <SummaryRow k="Estimated tax" v={<span className="sub">Calculated after you enter an address</span>} />
                <SummaryRow className="total" k="Total before tax" v={money(total)} />
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
                    aria-describedby={codeError ? 'cart-coupon-err' : coupon ? 'cart-coupon-hint' : undefined}
                  />
                  <Button variant="secondary" type="submit">
                    Apply
                  </Button>
                </div>
                {codeError ? (
                  <span className="error-text" id="cart-coupon-err">
                    <Icon name="circle-alert" className="ic-sm" />
                    {codeError}
                  </span>
                ) : coupon ? (
                  <span className="hint" id="cart-coupon-hint">
                    {couponOk ? (
                      <>
                        <Icon name="circle-check" className="ic-sm" /> {coupon} applied: {money(COUPON_WELCOME.amount)} off your first order.{' '}
                      </>
                    ) : (
                      <>
                        <Icon name="info" className="ic-sm" /> {coupon} needs {money(COUPON_WELCOME.minimum)} of items. Add {money(COUPON_WELCOME.minimum - subtotal)} more to use it.{' '}
                      </>
                    )}
                    <a
                      href="#"
                      className="link-inline"
                      onClick={(e) => {
                        e.preventDefault();
                        removeCoupon();
                      }}
                    >
                      Remove
                    </a>
                  </span>
                ) : null}
              </form>
              {checkout}
              <p className="xs muted">
                You'll see delivery options per package and the final total, including tax, before you place the order.{' '}
                {groups.length > 1 ? `${groups.length} packages arrive separately.` : 'Everything arrives in one package.'}
              </p>
            </Card>
            <div className="card pad stack gap-2">
              <span className="small strong">
                <Icon name="shield-check" className="ic-sm" /> Every item shows who sells it
              </span>
              <span className="xs muted">
                Marketly Official ships its own stock. Northwind Audio and Casa Verde Home are verified sellers that ship their own orders.{' '}
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

interface LineRowProps {
  l: CartLine;
  notified: boolean;
  onNotify: () => void;
  onRemove: () => void;
  onSave: () => void;
  onQty: (q: number) => void;
}

function LineRow({ l, notified, onNotify, onRemove, onSave, onQty }: LineRowProps) {
  const removeBtn = (
    <button type="button" aria-label={`Remove ${l.name} from cart`} onClick={onRemove}>
      <Icon name="trash-2" className="ic-sm" />
      Remove
    </button>
  );
  const sale = l.was !== null && l.was > l.price;
  const head = (
    <>
      <Link to={href('store/product')} aria-label={l.name}>
        <Img icon={l.icon} tint={l.tint} />
      </Link>
    </>
  );
  if (l.soldOut) {
    return (
      <div className="buy-item is-unavail">
        {head}
        <div className="stack gap-1">
          <Link className="buy-name" to={href('store/product')}>
            {l.name}
          </Link>
          <span className="xs sub">
            {l.variant} · Condition: {l.condition}
          </span>
          <span>
            <Badge tone="danger">Out of stock</Badge>
          </span>
          <div className="buy-note t-danger">
            <Icon name="package-x" />
            <div className="stack gap-1">
              <span>
                <b>Out of stock.</b> {sellers[l.seller].name} sold the last one at {l.soldOut.at}. It won't be included at checkout. The rest of your cart is unchanged.
              </span>
              <span className="buy-acts">
                {removeBtn}
                <Link to={href('store/offers')} aria-label={`See other offers (${l.soldOut.offers}): ${l.name}`}>
                  <Icon name="store" className="ic-sm" />
                  See other offers ({l.soldOut.offers})
                </Link>
                <button type="button" aria-label={`${notified ? "We'll email you when it's back" : "Tell me when it's back"}: ${l.name}`} aria-pressed={notified} onClick={onNotify}>
                  <Icon name={notified ? 'bell-ring' : 'bell'} className="ic-sm" />
                  {notified ? "We'll email you when it's back" : "Tell me when it's back"}
                </button>
              </span>
            </div>
          </div>
        </div>
        <div className="buy-item-side">
          <span className="small buy-strike num">{money(l.price)}</span>
        </div>
      </div>
    );
  }
  return (
    <div className="buy-item">
      {head}
      <div className="stack gap-1">
        <Link className="buy-name" to={href('store/product')}>
          {l.name}
        </Link>
        <span className="xs sub">
          {l.variant} · Condition: {l.condition}
        </span>
        <span className="xs muted">SKU {l.sku}</span>
        {l.priceChange && (
          <div className="buy-note">
            <Icon name="triangle-alert" />
            <span>
              <b>Price changed since you added it:</b> was {money(l.priceChange.from)}, now {money(l.price)}. {sellers[l.seller].name} updated this offer on {l.priceChange.on}. Remove it if you no longer want it at this price.
            </span>
          </div>
        )}
        <div className="buy-acts mt-1">
          {removeBtn}
          <button type="button" aria-label={`Save for later: ${l.name}`} onClick={onSave}>
            <Icon name="bookmark" className="ic-sm" />
            Save for later
          </button>
        </div>
      </div>
      <div className="buy-item-side">
        <QuantityStepper className="sm" value={l.qty} min={1} max={99} label={`quantity, ${l.name}`} onChange={onQty} />
        <span className="stack gap-0 u-items-flex-end">
          <span className="price">
            <span className={sale ? 'now sale' : 'now'}>{money(l.price * l.qty)}</span>
            {sale && <span className="was">{money((l.was ?? 0) * l.qty)}</span>}
          </span>
          {l.qty > 1 && <span className="xs muted">{money(l.price)} each</span>}
          {l.priceChange && (
            <span className="xs t-warning-text strong">
              Up {money(l.price - l.priceChange.from)} from {money(l.priceChange.from)}
            </span>
          )}
        </span>
      </div>
    </div>
  );
}
