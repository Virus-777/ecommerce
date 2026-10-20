// Blocks the purchase-flow screens share (cart, checkout, review changes, payment result, confirmation),
// rendered from the cart/checkout API types: packages per seller, compact lines, checkout steps.
import { Fragment, type ReactNode } from 'react';
import { Link } from 'react-router';
import { cx } from '@marketly/web-shared/lib/cx';
import { formatMoney } from '@marketly/web-shared/lib/format';
import { useScrollRegion } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import type { components } from '@marketly/web-shared/api';
import { Badge, Icon, Img, LogoTile, SellerBadge, Stars } from '@marketly/web-shared/ui';

type S = components['schemas'];
export type MediaRef = S['MediaRef'];
export type SellerLabel = S['cart.SellerLabel'];
export type SearchCard = S['search.ProductCard'];

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const CONDITION: Record<string, string> = {
  new: 'New',
  used_like_new: 'Used – like new',
  used_good: 'Used – good',
  used_acceptable: 'Used – acceptable',
  refurbished: 'Refurbished',
};
/** Cart conditions are enum values; checkout and confirmation already send the label. */
export const conditionLabel = (c: string) => CONDITION[c] ?? c;

const TINTS = ['1', '2', '3', '4', '5', '6'];
/** A stable tile tint for a seller name (the API sends no brand colour). */
export const tintFor = (name: string) => TINTS[[...name].reduce((s, ch) => s + ch.charCodeAt(0), 0) % TINTS.length];
const initialsOf = (name: string) =>
  name
    .replace(/^Marketly /, '')
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

/** Product photo in an image tile (.imgph), with a neutral icon when the line has no image. */
export function ItemImg({ image, className }: { image?: MediaRef | null; className?: string }) {
  return <Img icon="package" src={image?.url} alt={image?.alt ?? ''} className={className} />;
}

/** Product page link (the slug is cosmetic; routes carry the id). */
export const productHref = (productId: string, slug?: string | null) => href('store/product', '', { slug: slug || 'item', id: productId });

/** Package header (.buy-pkg-head): seller tile, name + badge, "Package i of N · Ships from", arrival and shipping. */
export function PkgHead({ seller, label, shipsFrom, arrives, shipNote }: { seller: SellerLabel; label: string; shipsFrom: string; arrives?: string | null; shipNote?: ReactNode }) {
  return (
    <div className="buy-pkg-head">
      <div className="row gap-2">
        <LogoTile initials={initialsOf(seller.name)} tint={tintFor(seller.name)} />
        <div className="stack gap-0">
          <span className="row gap-2">
            <span className="strong">{seller.name}</span>
            <SellerBadge seller={seller} compact />
          </span>
          <span className="xs muted">
            {label} · Ships from {shipsFrom}
          </span>
        </div>
      </div>
      <div className="buy-pkg-meta">
        {arrives && (
          <span>
            <Icon name="calendar-check" />
            {arrives}
          </span>
        )}
        {shipNote && (
          <span>
            <Icon name="truck" />
            {shipNote}
          </span>
        )}
      </div>
    </div>
  );
}

/** Compact line (.buy-mini): thumbnail, name, sub line and amount. */
export function BuyMini({ image, name, sub, amount, strong = true, clamp = true }: { image?: MediaRef | null; name: string; sub: ReactNode; amount: string; strong?: boolean; clamp?: boolean }) {
  return (
    <div className="buy-mini">
      <ItemImg image={image} />
      <div className="stack gap-0 grow">
        <span className={cx('small', strong && 'strong', clamp && 'clamp-2')}>{name}</span>
        <span className="xs muted">{sub}</span>
      </div>
      <span className={cx('small', strong && 'strong', 'num')}>{amount}</span>
    </div>
  );
}

/** Product card (.pcard) from a search card (recently viewed on the empty cart). No wishlist heart (wishlist is off). */
export function ApiProductCard({ p }: { p: SearchCard }) {
  const to = productHref(p.productId, p.slug);
  return (
    <article className="pcard">
      <div className="pcard-media">
        <Link to={to} aria-label={p.title}>
          <ItemImg image={p.image} />
        </Link>
        <div className="tags">{p.discountPct ? <Badge tone="deal">−{p.discountPct}%</Badge> : null}</div>
      </div>
      <Link className="name" to={to}>
        {p.title}
      </Link>
      {p.rating != null && <Stars rating={p.rating} count={p.ratingCount} />}
      <span className="price">
        <span className={cx('now', p.wasPrice && 'sale')}>
          {p.priceIsFrom && <span className="from">from</span>}
          {formatMoney(p.price)}
        </span>
        {p.wasPrice && <span className="was">{formatMoney(p.wasPrice)}</span>}
      </span>
      {p.deliveryCue && (
        <div className="meta">
          <span>
            {p.freeDelivery && <Icon name="truck" className="ic-sm" />} {p.deliveryCue}
          </span>
        </div>
      )}
    </article>
  );
}

const CHECKOUT_STEPS = ['Account', 'Address', 'Delivery', 'Payment', 'Review'];

/** Checkout progress (.steps) with the design's "Step n of 5" screen-reader text on the current step. */
export function CheckoutSteps({ current }: { current: number }) {
  const ref = useScrollRegion<HTMLOListElement>();
  return (
    <ol className="steps" aria-label="Progress" ref={ref} data-scroll-region="">
      {CHECKOUT_STEPS.map((s, i) => (
        <Fragment key={s}>
          {i > 0 && <li className="bar" aria-hidden="true" />}
          <li className={cx('step', i < current && 'is-done', i === current && 'is-current')} aria-current={i === current ? 'step' : undefined}>
            {i < current && <span className="sr-only">Completed: </span>}
            <span className="n">{i < current ? <Icon name="check" className="ic-sm" /> : i + 1}</span>
            {i === current && <span className="sr-only">Step {i + 1} of {CHECKOUT_STEPS.length}: </span>}
            {s}
          </li>
        </Fragment>
      ))}
    </ol>
  );
}

/** Checkout section number (.buy-sec-n): a check once the section is complete. */
export function SecN({ n, done }: { n: number; done?: boolean }) {
  return <span className={cx('buy-sec-n', done && 'is-done')}>{done ? <Icon name="check" className="ic-sm" /> : n}</span>;
}

/** Skeleton rows for a loading card (.sk-list of .sk-row). */
export function SkRows({ n = 3 }: { n?: number }) {
  return (
    <div className="sk-list" aria-hidden="true">
      {Array.from({ length: n }, (_, i) => (
        <div className="sk-row" key={i}>
          <span className="sk sk-thumb" />
          <span className="sk-lines">
            <span className="sk sk-line" />
            <span className="sk sk-line short" />
          </span>
        </div>
      ))}
    </div>
  );
}

/** Loading frame for the purchase pages: skeleton cards and a summary card, so the layout doesn't jump. */
export function PurchaseSkeleton({ label, cards = 2 }: { label: string; cards?: number }) {
  return (
    <div className="split" aria-busy="true">
      <div className="stack gap-4">
        <span className="sr-only">Loading {label}</span>
        {Array.from({ length: cards }, (_, i) => (
          <div className="card pad" key={i}>
            <SkRows n={2} />
          </div>
        ))}
      </div>
      <aside className="stack gap-4">
        <div className="card pad stack gap-2" aria-hidden="true">
          <span className="sk sk-line" />
          <span className="sk sk-line" />
          <span className="sk sk-line short" />
        </div>
      </aside>
    </div>
  );
}
