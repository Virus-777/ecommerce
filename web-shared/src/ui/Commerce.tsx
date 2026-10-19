import { useState, type CSSProperties, type ReactNode } from 'react';
import { Link } from 'react-router';
import { cx } from '../lib/cx';
import { money, num, percentOff } from '../lib/format';
import { useCountdown } from '../lib/hooks';
import { sellers, type SellerId, type Tint } from '../data/fixtures';
import { href } from '../routes/href';
import { Badge } from './Badge';
import { Icon, type IconName } from './Icon';
import { Img } from './Media';

/** Price with optional was price and "% off". `from` adds the "from" prefix (several offers). */
export function Price({ amount, was, lg, from, noOff, className }: { amount: number; was?: number | null; lg?: boolean; from?: boolean; noOff?: boolean; className?: string }) {
  const off = percentOff(amount, was);
  return (
    <span className={cx('price', lg && 'lg', className)}>
      <span className={cx('now', off > 0 && 'sale')}>
        {from && <span className="from">from</span>}
        {money(amount)}
      </span>
      {off > 0 && was && (
        <>
          <span className="was">{money(was)}</span>
          {!noOff && <span className="off">{off}% off</span>}
        </>
      )}
    </span>
  );
}

/** Compact rating: ★ 4.6 (1,284). */
export function Stars({ rating, count }: { rating: number; count?: number }) {
  return (
    <span className="stars">
      <span className="s" aria-hidden="true">★</span>
      <span className="val">{rating.toFixed(1)}</span>
      <span className="sr-only"> out of 5{count !== undefined ? ', ' : ''}</span>
      {count !== undefined && (
        <span>
          ({num(count)}
          <span className="sr-only"> ratings</span>)
        </span>
      )}
    </span>
  );
}

/** Five-star bar filled to the rating. size: xs | sm | md, or a utility class such as u-fs-16. */
export function Stars5({ rating, size, className }: { rating: number; size?: 'xs' | 'sm' | 'md'; className?: string }) {
  return (
    <span className={cx('stars5', size, className)} style={{ '--r': `${(rating / 5) * 100}%` } as CSSProperties} role="img" aria-label={`${rating} out of 5 stars`}>
      ★★★★★
    </span>
  );
}

/** Official Store / Verified seller badge. */
export function SellerBadge({ seller, compact }: { seller: { official?: boolean; verified?: boolean }; compact?: boolean }) {
  if (seller.official) return <Badge tone="brand" icon="badge-check">{compact ? 'Official' : 'Official Store'}</Badge>;
  if (seller.verified) return <Badge tone="info" icon="shield-check">{compact ? 'Verified' : 'Verified seller'}</Badge>;
  return null;
}

/** "Sold by <seller>" with a link to the storefront (Official Store or seller page). */
export function SellerLine({ seller, badge = false }: { seller: SellerId; badge?: boolean }) {
  const s = sellers[seller];
  const official = 'official' in s && s.official;
  return (
    <span className="seller-line">
      Sold by{' '}
      <Link to={official ? href('store/official') : href('store/seller')}>
        <b>{s.name}</b>
      </Link>
      {badge && <SellerBadge seller={s} compact />}
    </span>
  );
}

/** Delivery/shipping line with a leading icon. */
export function ShipLine({ icon = 'truck', children }: { icon?: IconName; children: ReactNode }) {
  return (
    <span className="ship-line">
      <Icon name={icon} />
      <span>{children}</span>
    </span>
  );
}

/** What a product card needs; fixture products satisfy it, pages can pass their own. */
export interface CardProduct {
  id?: string;
  name: string;
  price: number;
  was?: number | null;
  rating: number;
  reviews: number;
  icon: IconName;
  tint?: Tint | string;
  seller?: SellerId;
  offers?: number;
  delivery: string;
  free?: boolean;
  /** Photo URL (API products); without it the card shows the icon tile. */
  image?: string | null;
  /** Seller shown under the card when the product doesn't use a fixture seller (API data). */
  sellerName?: string;
  sellerTo?: string;
  /** Official Store offer (API data), for the Official badge. */
  official?: boolean;
}

/** Product card (.pcard). Heart toggles the wishlist state locally. */
export function ProductCard({ p, sponsored, compact, showSeller, from, to = href('store/product'), extra, action, noFav }: { p: CardProduct; sponsored?: boolean; compact?: boolean; showSeller?: boolean; from?: boolean; to?: string; extra?: ReactNode; /** A control on the thumbnail, bottom right (e.g. add to cart). */ action?: ReactNode; /** Hide the wishlist heart (the wishlist module is off at launch). */ noFav?: boolean }) {
  const [saved, setSaved] = useState(false);
  const off = percentOff(p.price, p.was);
  const official = p.official ?? (p.seller ? 'official' in sellers[p.seller] : false);
  return (
    <article className="pcard">
      <div className="pcard-media">
        <Link to={to} aria-label={p.name}>
          <Img icon={p.icon} tint={p.tint} src={p.image ?? undefined} alt={p.image ? p.name : undefined} />
        </Link>
        <div className="tags">
          {off > 0 && <Badge tone="deal">−{off}%</Badge>}
          {official && !compact && <Badge tone="brand">Official</Badge>}
          {sponsored && <Badge tone="outline" className="sponsored-badge">Sponsored</Badge>}
        </div>
        {!noFav && <button type="button" className={cx('fav', saved && 'is-active')} aria-label={`Save ${p.name} to wishlist`} aria-pressed={saved} onClick={() => setSaved((v) => !v)}>
          <Icon name="heart" fill={saved ? 'currentColor' : 'none'} />
        </button>}
        {action}
      </div>
      <Link className="name" to={to}>
        {p.name}
      </Link>
      {p.reviews > 0 && <Stars rating={p.rating} count={p.reviews} />}
      <Price amount={p.price} was={p.was} from={from && (p.offers ?? 1) > 1} noOff />
      <div className="meta">
        {p.free ? (
          <span>
            <Icon name="truck" className="ic-sm" /> Free delivery {p.delivery}
          </span>
        ) : (
          <span>Delivery {p.delivery}</span>
        )}
      </div>
      {showSeller && p.seller && (
        <div className="meta">
          <SellerLine seller={p.seller} />
        </div>
      )}
      {showSeller && !p.seller && p.sellerName && (
        <div className="meta">
          <span className="seller-line">
            Sold by {p.sellerTo ? <Link to={p.sellerTo}><b>{p.sellerName}</b></Link> : <b>{p.sellerName}</b>}
          </span>
        </div>
      )}
      {extra}
    </article>
  );
}

/** Quantity stepper (.qty), clamped to [min, max]. Controlled when `value` is given. */
export function QuantityStepper({ value, defaultValue = 1, min = 1, max = 99, onChange, className, label = 'quantity' }: { value?: number; defaultValue?: number; min?: number; max?: number; onChange?: (v: number) => void; className?: string; label?: string }) {
  const [inner, setInner] = useState(defaultValue);
  const v = value ?? inner;
  const set = (n: number) => {
    const c = Math.min(max, Math.max(min, n));
    if (value === undefined) setInner(c);
    onChange?.(c);
  };
  return (
    <span className={cx('qty', className)}>
      <button type="button" aria-label={`Decrease ${label}`} disabled={v <= min} onClick={() => set(v - 1)}>
        <Icon name="minus" className="ic-sm" />
      </button>
      <span aria-live="polite">{v}</span>
      <button type="button" aria-label={`Increase ${label}`} disabled={v >= max} onClick={() => set(v + 1)}>
        <Icon name="plus" className="ic-sm" />
      </button>
    </span>
  );
}

/** Live flash-sale countdown (hh:mm:ss) from a number of seconds. */
export function Countdown({ seconds }: { seconds: number }) {
  const [h, m, s] = useCountdown(seconds);
  return (
    <span className="countdown" role="timer" aria-label={`Ends in ${h} hours ${m} minutes`}>
      <span>{h}</span>:<span>{m}</span>:<span>{s}</span>
    </span>
  );
}

/** Progress meter (.meter). Give it a label: it is announced as a progress bar. */
export function Meter({ pct, tone, label }: { pct: number; tone?: 'success' | 'warning' | 'danger' | 'deal' | 'info'; label: string }) {
  return (
    <div className={cx('meter', tone && `t-${tone}`)} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
      <i style={{ width: `${pct}%` }} />
    </div>
  );
}
