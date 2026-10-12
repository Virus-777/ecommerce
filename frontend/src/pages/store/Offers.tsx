import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useSession } from '@/app/session';
import { P, sellers, type SellerId } from '@marketly/web-shared/data/fixtures';
import { StoreLayout } from '@/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { money, num } from '@marketly/web-shared/lib/format';
import { useView } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import { Badge, Breadcrumbs, Chip, Icon, Img, Stars, TableWrap, announce } from '@marketly/web-shared/ui';
import { offerRows, total, type ConditionGroup, type OfferRow } from './data/offers';

// Design: pages/store/store-offers.html (sorted by total cost)
//   view "fastest-delivery" = the same offers sorted by earliest arrival

type View = 'fastest-delivery';
type CondFilter = 'all' | ConditionGroup;

const product = P.aurora;
const CONDITIONS: ConditionGroup[] = ['New', 'Used', 'Refurbished'];
const SORTS: Array<{ view: View | ''; label: string }> = [
  { view: '', label: 'Total cost' },
  { view: 'fastest-delivery', label: 'Fastest delivery' },
];

const sellerHref = (id: SellerId) => ('official' in sellers[id] ? href('store/official') : href('store/seller'));

const byTotal = (a: OfferRow, b: OfferRow) => total(a) - total(b) || a.arrives.localeCompare(b.arrives);
const byDelivery = (a: OfferRow, b: OfferRow) => a.arrives.localeCompare(b.arrives) || total(a) - total(b);

export default function Offers() {
  const [view] = useView<View>();
  const { cartCount, setCartCount } = useSession();
  const [cond, setCond] = useState<CondFilter>('all');
  const [added, setAdded] = useState<SellerId | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const rows = offerRows.filter((o) => cond === 'all' || o.group === cond).sort(view === 'fastest-delivery' ? byDelivery : byTotal);
  const count = (g: ConditionGroup) => offerRows.filter((o) => o.group === g).length;

  const addToCart = (o: OfferRow) => {
    setCartCount(cartCount + 1);
    setAdded(o.seller);
    announce(`Added ${product.name} from ${sellers[o.seller].name} to your cart, ${money(total(o))}`);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setAdded(null), 2500);
  };
  const addLabel = (o: OfferRow) => (added === o.seller ? 'Added to cart' : 'Add to cart');

  return (
    <StoreLayout nav="categories" appbar={{ title: `All offers (${offerRows.length})`, back: href('store/product') }}>
      <div className="container page gap-5">
        <Breadcrumbs
          items={[
            { label: 'Home', to: href('store/home') },
            { label: 'Headphones', to: href('store/category') },
            { label: 'Halden Aurora', to: href('store/product') },
            { label: 'All offers' },
          ]}
        />
        <div className="card pad shop-mini">
          <Img icon={product.icon} tint={product.tint} />
          <div className="stack gap-1 grow">
            <h1 className="h3">{product.name}</h1>
            <span className="row gap-2 small sub">
              Color: <b>Midnight black</b>{' '}
              <Link to={href('store/product')} className="link-inline">
                Change
              </Link>
            </span>
            <Stars rating={product.rating} count={product.reviews} />
          </div>
        </div>
        <div className="shop-toolbar">
          <div className="hscroll gap-2">
            <Chip active={cond === 'all'} onClick={() => setCond('all')}>
              All conditions ({offerRows.length})
            </Chip>
            {CONDITIONS.map((g) => (
              <Chip key={g} active={cond === g} onClick={() => setCond(g)}>
                {g} ({count(g)})
              </Chip>
            ))}
          </div>
          <span className="row gap-2">
            <span className="small sub">Sort by</span>
            <div className="seg" role="group">
              {SORTS.map((s) => {
                const on = s.view === view;
                return (
                  <Link key={s.label} to={href('store/offers', s.view)} className={cx(on && 'is-active')} aria-current={on ? 'page' : undefined} preventScrollReset replace>
                    {s.label}
                  </Link>
                );
              })}
            </div>
          </span>
        </div>
        <p className="small sub">{rows.length} offers delivering to Portland 97205. Totals include shipping; sales tax is added at checkout.</p>

        {/* Phone and tablet: offer cards */}
        <div className="stack gap-3 no-desktop">
          {rows.map((o) => (
            <article key={o.seller} className={cx('card pad shop-offer', o.main && 'is-featured')}>
              <div className="row between top">
                <SellerCell o={o} />
                {o.main && <FeaturedBadge />}
              </div>
              {o.ineligible && <Ineligible text={o.ineligible} />}
              <div className="ogrid">
                <div>
                  <span className="k">Cost</span>
                  <CostCell o={o} />
                </div>
                <div>
                  <span className="k">Condition</span>
                  <ConditionCell o={o} />
                </div>
                <div>
                  <span className="k">Delivery</span>
                  <DeliveryCell o={o} />
                </div>
                <div>
                  <span className="k">Seller quality</span>
                  <QualityCell o={o} />
                </div>
                <div className="span-all">
                  <span className="k">Returns and warranty</span>
                  <ReturnsCell o={o} />
                </div>
              </div>
              <button type="button" className={cx('btn btn-block', o.main ? 'btn-primary' : 'btn-secondary')} onClick={() => addToCart(o)}>
                <span>{addLabel(o)}</span>
              </button>
            </article>
          ))}
        </div>

        {/* Desktop: comparison table */}
        <div className="card only-desktop shop-otable">
          <TableWrap label={`${product.name} table`}>
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Seller</th>
                  <th scope="col">Total cost</th>
                  <th scope="col">Condition</th>
                  <th scope="col">Delivery to 97205</th>
                  <th scope="col">Seller quality</th>
                  <th scope="col">Returns and warranty</th>
                  <th className="r" scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((o) => (
                  <tr key={o.seller} className={cx(o.main && 'is-featured')}>
                    <td>
                      <SellerCell o={o} />
                      {o.main && (
                        <div className="mt-1-5">
                          <FeaturedBadge />
                        </div>
                      )}
                      {o.ineligible && (
                        <div className="mt-1-5 maxw-200">
                          <Ineligible text={o.ineligible} />
                        </div>
                      )}
                    </td>
                    <td>
                      <CostCell o={o} />
                    </td>
                    <td>
                      <div className="maxw-220">
                        <ConditionCell o={o} />
                      </div>
                    </td>
                    <td>
                      <DeliveryCell o={o} />
                    </td>
                    <td>
                      <QualityCell o={o} />
                    </td>
                    <td>
                      <div className="maxw-200">
                        <ReturnsCell o={o} />
                      </div>
                    </td>
                    <td className="r">
                      <button type="button" className={cx('btn btn-sm', o.main ? 'btn-primary' : 'btn-secondary')} onClick={() => addToCart(o)}>
                        <span>{addLabel(o)}</span>
                        <span className="sr-only"> {sellers[o.seller].name}</span>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        </div>

        <section className="card pad stack gap-3" aria-labelledby="of-rule">
          <h2 className="h4 row gap-2" id="of-rule">
            <Icon name="award" /> How we choose the featured offer
          </h2>
          <ol className="ol small sub stack gap-1">
            <li>
              <b>Eligible:</b> the seller is in good standing, with no open restriction and delivery performance that meets our standard.
            </li>
            <li>
              <b>Available:</b> in stock and ships to your address.
            </li>
            <li>
              <b>Delivery:</b> faster and more reliable arrival ranks higher.
            </li>
            <li>
              <b>Total price:</b> item price plus shipping, after any discount you qualify for.
            </li>
          </ol>
          <p className="xs muted">
            Advertising does not affect the featured offer. Used and refurbished offers compete only when you filter for that condition. Example rule; the published version is in{' '}
            <Link to={href('info/policy', 'seller-rules')} className="link-inline">
              Seller rules
            </Link>
            . Once an item is in your cart, its seller never changes without your choice.
          </p>
        </section>
      </div>
    </StoreLayout>
  );
}

function SellerCell({ o }: { o: OfferRow }) {
  const s = sellers[o.seller];
  return (
    <div className="stack gap-1">
      <Link to={sellerHref(o.seller)} className="link-inline">
        <b>{s.name}</b>
      </Link>
      <span className="row gap-1">
        {'official' in s && s.official ? (
          <Badge tone="brand" icon="badge-check">
            Official
          </Badge>
        ) : s.verified ? (
          <Badge tone="info" icon="shield-check">
            Verified
          </Badge>
        ) : (
          <Badge tone="outline">Not verified</Badge>
        )}
      </span>
    </div>
  );
}

function FeaturedBadge() {
  return (
    <Badge tone="brand" icon="award">
      Featured offer
    </Badge>
  );
}

function Ineligible({ text }: { text: string }) {
  return (
    <span className="shop-note warn">
      <Icon name="triangle-alert" />
      {text}
    </span>
  );
}

function CostCell({ o }: { o: OfferRow }) {
  return (
    <div className="stack gap-0 num">
      <span className="strong">{money(total(o))}</span>
      <span className="xs muted">
        {money(o.price)} + {o.ship ? `${money(o.ship)} shipping` : 'free shipping'}
      </span>
    </div>
  );
}

function ConditionCell({ o }: { o: OfferRow }) {
  return (
    <div className="stack gap-1">
      <Badge tone="outline">{o.condition}</Badge>
      {o.note && <span className="xs sub">{o.note}</span>}
      {o.kit && (
        <span className={cx('shop-note', o.kit.warn && 'warn')}>
          <Icon name={o.kit.icon} />
          {o.kit.text}
        </span>
      )}
    </div>
  );
}

function DeliveryCell({ o }: { o: OfferRow }) {
  return (
    <div className="stack gap-0">
      <span className="small strong">{o.window}</span>
      <span className="xs muted">
        {o.dispatch} · {o.carrier}
      </span>
    </div>
  );
}

function QualityCell({ o }: { o: OfferRow }) {
  const s = sellers[o.seller];
  return (
    <div className="stack gap-0">
      <span className="small">{s.positive}% positive</span>
      <span className="xs muted">
        {num(s.ratings)} ratings · {o.onTime}% on-time dispatch
      </span>
    </div>
  );
}

function ReturnsCell({ o }: { o: OfferRow }) {
  return (
    <div className="stack gap-0">
      <span className="small">{o.returns}</span>
      <span className="xs muted">{o.warranty}</span>
    </div>
  );
}
