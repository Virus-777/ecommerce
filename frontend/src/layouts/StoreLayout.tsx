import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { BRAND } from '@marketly/web-shared/config';
import { useSession } from '@/app/session';
import { cx } from '@marketly/web-shared/lib/cx';
import { href } from '@marketly/web-shared/routes';
import { Logo } from '@marketly/web-shared/layouts';
import { Icon, IconButton, type IconName } from '@marketly/web-shared/ui';

export type StoreNavKey = 'categories' | 'deals' | 'official' | 'new' | 'best' | 'brands';
const STORE_NAV: Array<{ key: StoreNavKey; label: string; icon?: IconName; to: string; deal?: boolean }> = [
  { key: 'categories', label: 'All categories', icon: 'menu', to: href('store/categories') },
  { key: 'deals', label: 'Deals', icon: 'tag', to: href('store/deals'), deal: true },
  { key: 'official', label: 'Official Store', icon: 'badge-check', to: href('store/official') },
  { key: 'new', label: 'New arrivals', to: href('store/collection') },
  { key: 'best', label: 'Best sellers', to: href('store/collection', 'best-sellers') },
  { key: 'brands', label: 'Brands', to: href('store/brand') },
];

function SearchForm({ id, phone, q }: { id: string; phone?: boolean; q?: string }) {
  const navigate = useNavigate();
  const [value, setValue] = useState(q ?? '');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    navigate(href('store/search', '', undefined, value.trim() ? { q: value.trim() } : undefined));
  };
  return (
    <form className={cx('search', phone ? 'only-phone mobile-search' : 'no-phone')} role="search" onSubmit={submit}>
      <label htmlFor={id} className="sr-only">
        Search {BRAND}
      </label>
      <Icon name="search" className="ic-sm" />
      <input id={id} type="search" placeholder={phone ? `Search ${BRAND}` : 'Search products, brands and sellers'} value={value} onChange={(e) => setValue(e.target.value)} />
      {phone ? (
        <IconButton icon="scan-line" label="Scan a barcode" />
      ) : (
        <button type="submit" className="go" aria-label="Search">
          <Icon name="arrow-right" />
        </button>
      )}
    </form>
  );
}

function StoreHeader({ nav, q, hideOnPhone }: { nav?: StoreNavKey; q?: string; hideOnPhone?: boolean }) {
  const { signedIn, customer, cartCount, unreadNotifications } = useSession();
  return (
    <header className={cx('store-header', hideOnPhone && 'no-phone')}>
      <div className="container">
        <div className="bar">
          <Logo />
          <button type="button" className="deliver only-desktop btn-ghost btn-bare">
            <span>
              <Icon name="map-pin" className="ic-sm" /> Deliver to
            </span>
            <b>Portland 97205</b>
          </button>
          <SearchForm id="hdr-q" q={q} />
          <span className="grow only-phone" />
          {signedIn ? (
            <Link className="acct no-phone" to={href('account/overview')}>
              <span>Hello, {customer.first}</span>
              <b>Account</b>
            </Link>
          ) : (
            <Link className="acct no-phone" to={href('auth/sign-in')}>
              <span>Hello</span>
              <b>Sign in</b>
            </Link>
          )}
          <Link className="acct only-desktop" to={href('account/orders')}>
            <span>Returns</span>
            <b>&amp; Orders</b>
          </Link>
          <IconButton icon="bell" label={signedIn ? `Notifications, ${unreadNotifications} unread` : 'Notifications'} to={href('account/notifications')} count={signedIn ? unreadNotifications : 0} />
          <Link className="cart-btn no-phone" to={href('store/cart')}>
            <Icon name="shopping-cart" />
            <span>Cart</span>
            <span className="n">{cartCount}</span>
          </Link>
          <span className="only-phone">
            <IconButton icon="shopping-cart" label={`Cart, ${cartCount} items`} to={href('store/cart')} count={cartCount} />
          </span>
        </div>
        <SearchForm id="hdr-mq" phone q={q} />
      </div>
      <div className="no-phone nav-row">
        <div className="container">
          <nav className="store-nav" aria-label="Shop">
            {STORE_NAV.map((n) => (
              <Link key={n.key} to={n.to} className={cx(nav === n.key && 'is-active', n.deal && 'deal')} aria-current={nav === n.key ? 'page' : undefined}>
                {n.icon && <Icon name={n.icon} className="ic-sm" />}
                {n.label}
              </Link>
            ))}
            <span className="spacer" />
            <Link to={href('sell/landing')}>
              <Icon name="store" className="ic-sm" />
              Sell on {BRAND}
            </Link>
            <Link to={href('help/center')}>
              <Icon name="life-buoy" className="ic-sm" />
              Help
            </Link>
          </nav>
        </div>
      </div>
    </header>
  );
}

export interface AppbarOptions {
  title: ReactNode;
  /** Back target (default: the store home). */
  back?: string;
  actions?: ReactNode;
}

/** Phone app bar: back + title (+ actions). Only rendered on the phone layout. */
export function Appbar({ title, back, actions }: AppbarOptions) {
  return (
    <div className="only-phone">
      <div className="appbar">
        <IconButton icon="arrow-left" label="Back" to={back ?? href('store/home')} />
        <span className="title">{title}</span>
        {actions}
      </div>
    </div>
  );
}

/** Website footer. The phone layout is the Android app: no footer; its links live in the Account tab. */
function StoreFooter() {
  return (
    <footer className="store-footer no-phone">
      <div className="container">
        <div className="cols">
          <div className="stack gap-3">
            <Logo />
            <p className="small muted measure-sm">One store for our own products and approved independent sellers. Every item shows who sells it, when it arrives and how returns work.</p>
            <div className="stack gap-1 small">
              <span>
                <Icon name="headset" className="ic-sm" /> Support: 1-800-555-0136
              </span>
              <span className="muted">Mon–Sat, 8 AM–8 PM PT</span>
            </div>
          </div>
          <div>
            <h4>Shop</h4>
            <ul>
              <li><Link to={href('store/categories')}>All categories</Link></li>
              <li><Link to={href('store/deals')}>Deals</Link></li>
              <li><Link to={href('store/official')}>Official Store</Link></li>
              <li><Link to={href('store/collection')}>New arrivals</Link></li>
              <li><Link to={href('store/brand')}>Brands</Link></li>
            </ul>
          </div>
          <div>
            <h4>Help</h4>
            <ul>
              <li><Link to={href('help/center')}>Help Center</Link></li>
              <li><Link to={href('account/orders')}>Track an order</Link></li>
              <li><Link to={href('account/returns')}>Returns and refunds</Link></li>
              <li><Link to={href('help/contact')}>Contact us</Link></li>
              <li><Link to={href('auth/guest-orders')}>Guest order lookup</Link></li>
            </ul>
          </div>
          <div>
            <h4>Policies</h4>
            <ul>
              <li><Link to={href('info/policy', 'shipping')}>Shipping</Link></li>
              <li><Link to={href('info/policy')}>Returns</Link></li>
              <li><Link to={href('info/policy', 'privacy')}>Privacy</Link></li>
              <li><Link to={href('info/policy', 'purchase-terms')}>Purchase terms</Link></li>
              <li><Link to={href('info/policy', 'seller-rules')}>Seller rules</Link></li>
            </ul>
          </div>
          <div>
            <h4>Sell with us</h4>
            <ul>
              <li><Link to={href('sell/landing')}>Sell on {BRAND}</Link></li>
              <li><Link to={href('sell/landing')}>Seller requirements</Link></li>
              <li><Link to={href('sell/landing')}>Fees</Link></li>
              <li><Link to={href('seller/dashboard')}>Seller Center</Link></li>
              <li><Link to={href('info/about')}>About us</Link></li>
            </ul>
          </div>
        </div>
        <div className="legal">
          <span>© 2026 {BRAND}, Inc. Prices in USD. Service region: United States.</span>
          <span>Policies show their effective date. Orders keep the terms accepted at purchase.</span>
        </div>
      </div>
    </footer>
  );
}

export type StoreTab = 'home' | 'categories' | 'deals' | 'cart' | 'account';

/** Phone (Android app) bottom tab bar. */
function Tabbar({ active }: { active?: StoreTab }) {
  const { cartCount } = useSession();
  const tabs: Array<{ key: StoreTab; label: string; icon: IconName; to: string; count?: number }> = [
    { key: 'home', label: 'Home', icon: 'house', to: href('store/home') },
    { key: 'categories', label: 'Categories', icon: 'layout-grid', to: href('store/categories') },
    { key: 'deals', label: 'Deals', icon: 'tag', to: href('store/deals') },
    { key: 'cart', label: 'Cart', icon: 'shopping-cart', to: href('store/cart'), count: cartCount },
    { key: 'account', label: 'Account', icon: 'user-round', to: href('account/overview') },
  ];
  return (
    <nav className="tabbar" aria-label="App">
      {tabs.map((t) => (
        <Link key={t.key} to={t.to} className={cx(active === t.key && 'is-active')} aria-current={active === t.key ? 'page' : undefined}>
          <Icon name={t.icon} />
          {t.count ? (
            <span className="dot-count">
              {t.count}
              <span className="sr-only"> items in</span>
            </span>
          ) : null}
          <span>{t.label}</span>
        </Link>
      ))}
    </nav>
  );
}

export interface StoreLayoutProps {
  /** Active item in the website category bar. */
  nav?: StoreNavKey;
  /** Active tab in the phone tab bar. */
  tab?: StoreTab;
  /** Sub-page on the phone: app bar with back + title replaces the store header there. */
  appbar?: AppbarOptions | null;
  /** Sticky phone action bar (Add to cart, Checkout); replaces the tab bar. */
  actionBar?: ReactNode;
  footer?: boolean;
  tabbar?: boolean;
  promo?: boolean;
  /** Current search query shown in the header search field. */
  q?: string;
  children: ReactNode;
}

/** Customer Store chrome: promo strip, header, category bar, footer (website); app bar, tab bar, action bar (phone). */
export function StoreLayout({ nav, tab, appbar, actionBar, footer = true, tabbar = true, promo = true, q, children }: StoreLayoutProps) {
  return (
    <div className="store">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      {promo && (
        <div className="store-promo no-phone">
          Free delivery on Official Store orders over $35 · 30-day returns on most items ·{' '}
          <Link to={href('info/policy', 'shipping')} className="link-inline">
            Delivery details
          </Link>
        </div>
      )}
      <StoreHeader nav={nav} q={q} hideOnPhone={!!appbar} />
      {appbar && <Appbar {...appbar} />}
      <main className="store-main" id="main" tabIndex={-1}>
        {children}
      </main>
      {footer && <StoreFooter />}
      {actionBar && <div className="action-bar">{actionBar}</div>}
      {tabbar && !actionBar && <Tabbar active={tab} />}
    </div>
  );
}

/** Minimal chrome during checkout. */
export function CheckoutLayout({ children }: { children: ReactNode }) {
  return (
    <div className="store">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="checkout-header">
        <div className="container">
          <div className="bar">
            <Logo />
            <span className="row gap-2 small sub">
              <Icon name="lock" className="ic-sm" />
              <span className="no-phone">Secure checkout</span>
            </span>
            <Link className="small strong" to={href('help/center')}>
              Help
            </Link>
          </div>
        </div>
      </header>
      <main className="store-main" id="main" tabIndex={-1}>
        {children}
      </main>
    </div>
  );
}
