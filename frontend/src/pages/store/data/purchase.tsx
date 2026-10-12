// Purchase-flow sample data (cart, checkout, payment result, confirmation) and the small
// blocks those screens share. Shapes follow the cart/checkout API: lines grouped by seller
// into packages, each package with its own delivery options and return terms.
import { Fragment } from 'react';
import { cx } from '@marketly/web-shared/lib/cx';
import { useScrollRegion } from '@marketly/web-shared/lib/hooks';
import { sellers, type SellerId, type Tint } from '@marketly/web-shared/data/fixtures';
import { Icon, Img, LogoTile, SellerBadge, type IconName } from '@marketly/web-shared/ui';

export interface CartLine {
  id: string;
  name: string;
  /** Name without the brand, used in compact package summaries. */
  short: string;
  icon: IconName;
  tint: Tint;
  variant: string;
  condition: string;
  sku: string;
  price: number;
  was: number | null;
  qty: number;
  seller: SellerId;
  /** The seller changed the price after the item was added. */
  priceChange?: { from: number; on: string };
  /** Sold out since it was added; excluded from checkout. */
  soldOut?: { at: string; offers: string };
}

export interface ShipOption {
  arrives: string;
  price: number;
  desc: string;
}

export interface PackageMeta {
  from: string;
  shipNote: string;
  returns: string;
  support: string;
  options: ShipOption[];
  /** Standard shipping is free once the package's items reach this amount. */
  freeOver?: number;
  /** Standard shipping below `freeOver`. */
  under?: number;
}

export const CART_LINES: CartLine[] = [
  { id: 'l1', name: 'Halden Aurora ANC Wireless Headphones', short: 'Aurora ANC Wireless Headphones', icon: 'headphones', tint: '2', variant: 'Midnight black', condition: 'New', sku: 'HAL-AUR-BLK', price: 189, was: 229, qty: 1, seller: 'official' },
  { id: 'l2', name: 'Mosswood Ceramic Pour-over Coffee Set', short: 'Ceramic Pour-over Coffee Set', icon: 'coffee', tint: '3', variant: 'Cream', condition: 'New', sku: 'MSW-PO-CRM', price: 36, was: null, qty: 1, seller: 'official' },
  { id: 'l3', name: 'Brightline Smart LED Desk Lamp with Wireless Charger', short: 'Smart LED Desk Lamp', icon: 'lamp-desk', tint: '5', variant: 'White', condition: 'New', sku: 'BRL-LAMP-W', price: 42, was: null, qty: 1, seller: 'official', soldOut: { at: '1:12 PM', offers: '2 from $39.50' } },
  { id: 'l4', name: 'Halden Pocket Bluetooth Speaker, 2-pack', short: 'Pocket Bluetooth Speaker', icon: 'speaker', tint: '2', variant: 'Teal', condition: 'New', sku: 'HAL-PKT-TEAL', price: 99.99, was: null, qty: 1, seller: 'northwind', priceChange: { from: 94.99, on: 'Oct 8' } },
  { id: 'l5', name: 'Mosswood Washed Linen Duvet Cover, Queen', short: 'Washed Linen Duvet Cover', icon: 'bed-double', tint: '1', variant: 'Queen · Sage', condition: 'New', sku: 'MSW-LIN-Q-SAGE', price: 119, was: 149, qty: 1, seller: 'casaverde' },
];

/** Lines that go to checkout (sold-out lines are left in the cart). */
export const ORDER_LINES = CART_LINES.filter((l) => !l.soldOut);

export const PACKAGES: Partial<Record<SellerId, PackageMeta>> = {
  official: {
    from: 'Reno, NV warehouse',
    shipNote: 'Free shipping · Free over $35',
    returns: '30-day free returns. We pay return shipping.',
    support: '12 hours',
    freeOver: 35,
    under: 5.99,
    options: [
      { arrives: 'Wed, Oct 14', price: 0, desc: 'Standard · Ships today from Reno, NV · UPS Ground' },
      { arrives: 'Fri, Oct 9', price: 9.99, desc: 'Express · Order within 2 h 18 min · UPS 2nd Day Air' },
    ],
  },
  northwind: {
    from: 'Portland, OR',
    shipNote: '$5.99 shipping',
    returns: '30-day returns. Buyer pays return shipping for change of mind.',
    support: '1 business day',
    options: [
      { arrives: 'Thu, Oct 15', price: 5.99, desc: 'Standard · Ships in 1 business day · USPS Ground Advantage' },
      { arrives: 'Mon, Oct 12', price: 12.99, desc: 'Priority · Ships in 1 business day · USPS Priority Mail' },
    ],
  },
  casaverde: {
    from: 'Sacramento, CA',
    shipNote: 'Free shipping',
    returns: '30-day returns. Bedding must be unopened for change-of-mind returns.',
    support: '1 business day',
    options: [{ arrives: 'Mon, Oct 19 – Tue, Oct 20', price: 0, desc: 'Standard · Ships in 2 business days · FedEx Ground' }],
  },
  pixelport: {
    from: 'Austin, TX',
    shipNote: 'Free shipping',
    returns: '30-day returns. Buyer pays return shipping for change of mind.',
    support: '1 business day',
    options: [{ arrives: 'Fri, Oct 16', price: 0, desc: 'Standard · Ships in 1 business day · UPS Ground' }],
  },
  trailhead: {
    from: 'Boulder, CO',
    shipNote: '$4.99 shipping',
    returns: '30-day returns. Buyer pays return shipping for change of mind.',
    support: '1 business day',
    options: [{ arrives: 'Thu, Oct 15', price: 4.99, desc: 'Standard · Ships in 2 business days · USPS Ground Advantage' }],
  },
};

export const pkgMeta = (s: SellerId): PackageMeta =>
  PACKAGES[s] ?? { from: sellers[s].location, shipNote: 'Free shipping', returns: '30-day returns.', support: '1 business day', options: [{ arrives: 'Fri, Oct 16', price: 0, desc: 'Standard' }] };

/** Standard shipping for a package with `items` worth of goods. */
export function standardShipping(s: SellerId, items: number): number {
  const m = pkgMeta(s);
  if (m.freeOver !== undefined) return items >= m.freeOver ? 0 : (m.under ?? 0);
  return m.options[0].price;
}

/** Group lines by seller, in first-seen order (one package per seller). */
export function groupBySeller<L extends { seller: SellerId }>(lines: L[]): Array<{ seller: SellerId; lines: L[] }> {
  const out: Array<{ seller: SellerId; lines: L[] }> = [];
  for (const l of lines) {
    const g = out.find((x) => x.seller === l.seller);
    if (g) g.lines.push(l);
    else out.push({ seller: l.seller, lines: [l] });
  }
  return out;
}

export const COUPON_WELCOME = { code: 'WELCOME20', amount: 20, minimum: 100 };
export const ORDER_REF = 'MK-261008-52190';
export const CARD = 'Visa •••• 4417';

/** Totals of the sample order as placed (4 items, WELCOME20, standard delivery). */
export const ORDER_ITEMS = ORDER_LINES.reduce((s, l) => s + l.price * l.qty, 0);
export const ORDER_SHIPPING = groupBySeller(ORDER_LINES).reduce((s, g) => s + standardShipping(g.seller, g.lines.reduce((a, l) => a + l.price * l.qty, 0)), 0);
export const ORDER_TOTAL = ORDER_ITEMS - COUPON_WELCOME.amount + ORDER_SHIPPING;

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/* ---------------- Shared blocks ---------------- */

/** Package header (.buy-pkg-head): seller tile, name + badge, package n of N, arrival and shipping. */
export function PkgHead({ seller, index, total, arrives, shipNote }: { seller: SellerId; index: number; total: number; arrives: string; shipNote: string }) {
  const s = sellers[seller];
  return (
    <div className="buy-pkg-head">
      <div className="row gap-2">
        <LogoTile initials={s.initials} tint={s.tint} />
        <div className="stack gap-0">
          <span className="row gap-2">
            <span className="strong">{s.name}</span>
            <SellerBadge seller={s} compact />
          </span>
          <span className="xs muted">
            Package {index} of {total} · Ships from {pkgMeta(seller).from}
          </span>
        </div>
      </div>
      <div className="buy-pkg-meta">
        <span>
          <Icon name="calendar-check" />
          Arrives {arrives}
        </span>
        <span>
          <Icon name="truck" />
          {shipNote}
        </span>
      </div>
    </div>
  );
}

/** Compact line (.buy-mini): thumbnail, name, sub line and amount. */
export function BuyMini({ icon, tint, name, sub, amount, strong = true, clamp = true }: { icon: IconName; tint: Tint | string; name: string; sub: string; amount: string; strong?: boolean; clamp?: boolean }) {
  return (
    <div className="buy-mini">
      <Img icon={icon} tint={tint} />
      <div className="stack gap-0 grow">
        <span className={cx('small', strong && 'strong', clamp && 'clamp-2')}>{name}</span>
        <span className="xs muted">{sub}</span>
      </div>
      <span className={cx('small', strong && 'strong', 'num')}>{amount}</span>
    </div>
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
