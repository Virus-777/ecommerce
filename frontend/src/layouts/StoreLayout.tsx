import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { call, useApi, useAppConfig, useMarket } from '@marketly/web-shared/api';
import { BRAND } from '@marketly/web-shared/config';
import { useSession } from '@/app/session';
import { isExternal, safeContentLinkTo, useNavigation } from '@/api/content';
import { SearchSuggestions } from '@/api/suggestions';
import { cx } from '@marketly/web-shared/lib/cx';
import { useView } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import { Logo } from '@marketly/web-shared/layouts';
import { Icon, IconButton, type IconName } from '@marketly/web-shared/ui';

export type StoreNavKey = 'categories' | 'deals' | 'official' | 'new' | 'best' | 'brands';

/* ---- header category bar and footer links ----
 * Both come from the published navigation (GET /api/store/content/navigation; staff edit it in the Admin
 * Center with PUT /api/admin/content/navigation). The lists below are the fallback while it loads, when
 * the read fails, and when nothing is published. */

interface NavItem {
  key: string;
  /** The tab this link is, when it is one of the store's own browse pages (active highlight, icon). */
  navKey?: StoreNavKey;
  label: string;
  icon?: IconName;
  to: string;
  deal?: boolean;
}

const ALL_CATEGORIES: NavItem = { key: 'categories', navKey: 'categories', label: 'All categories', icon: 'menu', to: href('store/categories') };
const STORE_NAV: NavItem[] = [
  ALL_CATEGORIES,
  { key: 'deals', navKey: 'deals', label: 'Deals', icon: 'tag', to: href('store/deals'), deal: true },
  { key: 'official', navKey: 'official', label: 'Official Store', icon: 'badge-check', to: href('store/official') },
  { key: 'new', navKey: 'new', label: 'New arrivals', to: href('store/collection', '', { slug: 'new-arrivals' }) },
  { key: 'best', navKey: 'best', label: 'Best sellers', to: href('store/collection', '', { slug: 'best-sellers' }) },
  { key: 'brands', navKey: 'brands', label: 'Brands', to: href('store/brands') },
];

/** Store paths that are a category-bar tab, so a published link to them highlights and looks like that tab. */
const NAV_BY_PATH: Record<string, StoreNavKey> = {
  [href('store/categories')]: 'categories',
  [href('store/deals')]: 'deals',
  [href('store/official')]: 'official',
  [href('store/collection', '', { slug: 'new-arrivals' })]: 'new',
  [href('store/collection', '', { slug: 'best-sellers' })]: 'best',
  [href('store/brands')]: 'brands',
};
const NAV_ICON: Partial<Record<StoreNavKey, IconName>> = { categories: 'menu', deals: 'tag', official: 'badge-check' };

const pathOf = (to: string) => to.split(/[?#]/)[0]!;

/** Category bar items: the published header, led by "All categories" (the bar's menu entry in the design)
 * unless the header already links there. */
function useStoreNav(): NavItem[] {
  const navQ = useNavigation();
  const items = (navQ.data?.header ?? []).flatMap((l, i): NavItem[] => {
    const to = safeContentLinkTo(l.url);
    if (!to || !l.label.trim()) return [];
    const navKey = isExternal(to) ? undefined : NAV_BY_PATH[pathOf(to)];
    return [{ key: `${i}:${to}`, navKey, label: l.label, icon: navKey && NAV_ICON[navKey], to, deal: navKey === 'deals' || l.kind === 'deals' }];
  });
  if (!items.length) return STORE_NAV;
  return items.some((n) => n.navKey === 'categories') ? items : [ALL_CATEGORIES, ...items];
}

interface FooterGroup {
  title: string;
  links: Array<{ label: string; to: string }>;
}

const STORE_FOOTER: FooterGroup[] = [
  {
    title: 'Shop',
    links: [
      { label: 'All categories', to: href('store/categories') },
      { label: 'Deals', to: href('store/deals') },
      { label: 'Official Store', to: href('store/official') },
      { label: 'New arrivals', to: href('store/collection', '', { slug: 'new-arrivals' }) },
      { label: 'Brands', to: href('store/brands') },
    ],
  },
  {
    title: 'Help',
    links: [
      { label: 'Help Center', to: href('help/center') },
      { label: 'News', to: href('store/news') },
      { label: 'Track an order', to: href('account/orders') },
      { label: 'Returns and refunds', to: href('account/returns') },
      { label: 'Contact us', to: href('help/contact') },
      { label: 'Guest order lookup', to: href('auth/guest-orders') },
    ],
  },
  {
    title: 'Policies',
    links: [
      { label: 'Shipping', to: href('info/policy', 'shipping') },
      { label: 'Returns', to: href('info/policy') },
      { label: 'Privacy', to: href('info/policy', 'privacy') },
      { label: 'Purchase terms', to: href('info/policy', 'purchase-terms') },
      { label: 'Seller rules', to: href('info/policy', 'seller-rules') },
    ],
  },
  {
    title: 'Sell with us',
    links: [
      { label: `Sell on ${BRAND}`, to: href('sell/landing') },
      { label: 'Seller requirements', to: href('sell/landing') },
      { label: 'Fees', to: href('sell/landing') },
      { label: 'Seller Center', to: href('seller/dashboard') },
      { label: 'About us', to: href('info/about') },
    ],
  },
];

/** Footer link groups: the published footer (unsafe links and empty groups left out), else the list above. */
function useFooterGroups(): FooterGroup[] {
  const navQ = useNavigation();
  const groups = (navQ.data?.footer ?? []).flatMap((g): FooterGroup[] => {
    const links = g.links.flatMap((l) => {
      const to = safeContentLinkTo(l.url);
      return to && l.label.trim() ? [{ label: l.label, to }] : [];
    });
    return links.length ? [{ title: g.title, links }] : [];
  });
  return groups.length ? groups : STORE_FOOTER;
}

/** A store route as a router Link; an absolute URL (http, mailto, tel, another app) as a plain anchor. */
function SiteLink({ to, className, current, children }: { to: string; className?: string; current?: boolean; children: ReactNode }) {
  const aria = current ? ('page' as const) : undefined;
  return isExternal(to) ? (
    <a href={to} className={className} aria-current={aria}>
      {children}
    </a>
  ) : (
    <Link to={to} className={className} aria-current={aria}>
      {children}
    </Link>
  );
}

/** "Deliver to" label: the cart's delivery destination (set from the default address or a ZIP), else the market's
 * default delivery location (app-config market.defaultDeliveryLocation). */
function useDeliverTo(): string {
  const { api } = useApi();
  const { deliveryLocation } = useMarket();
  const cart = useQuery({
    queryKey: ['cart', 'destination'],
    queryFn: () => call(api.GET('/api/store/cart/cart')),
    select: (c) => c.destination,
    staleTime: 60_000,
  });
  const d = cart.data;
  return d?.postalCode ? [d.city, d.postalCode].filter(Boolean).join(' ') : (deliveryLocation?.label ?? '');
}

interface SearchBox {
  value: string;
  setValue: (v: string) => void;
  open: () => void;
  close: () => void;
}

function SearchForm({ id, phone, box }: { id: string; phone?: boolean; box: SearchBox }) {
  const navigate = useNavigate();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    box.close();
    navigate(href('store/search', '', undefined, box.value.trim() ? { q: box.value.trim() } : undefined));
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => e.key === 'Escape' && box.close();
  return (
    <form className={cx('search', phone ? 'only-phone mobile-search' : 'no-phone')} role="search" onSubmit={submit}>
      <label htmlFor={id} className="sr-only">
        Search {BRAND}
      </label>
      <Icon name="search" className="ic-sm" />
      <input
        id={id}
        type="search"
        placeholder={phone ? `Search ${BRAND}` : 'Search products, brands and sellers'}
        value={box.value}
        autoComplete="off"
        onFocus={box.open}
        onKeyDown={onKey}
        onChange={(e) => {
          box.setValue(e.target.value);
          box.open();
        }}
      />
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

function StoreHeader({ nav, box, hideOnPhone }: { nav?: StoreNavKey; box: SearchBox; hideOnPhone?: boolean }) {
  const { signedIn, customer, cartCount, unreadNotifications } = useSession();
  const deliverTo = useDeliverTo();
  const items = useStoreNav();
  // A link to the page being shown wins (a published category link on its category page); otherwise the
  // page's own tab (`nav`), e.g. "All categories" on a subcategory page.
  const { pathname } = useLocation();
  const exact = items.find((n) => !isExternal(n.to) && pathOf(n.to) === pathname);
  const isActive = (n: NavItem) => (exact ? n === exact : !!nav && n.navKey === nav);
  return (
    <header className={cx('store-header', hideOnPhone && 'no-phone')}>
      <div className="container">
        <div className="bar">
          <Logo />
          <button type="button" className="deliver only-desktop btn-ghost btn-bare">
            <span>
              <Icon name="map-pin" className="ic-sm" /> Deliver to
            </span>
            <b>{deliverTo}</b>
          </button>
          <SearchForm id="hdr-q" box={box} />
          <SearchForm id="hdr-mq" phone box={box} />
          {signedIn ? (
            <Link className="acct no-phone" to={href('account/overview')}>
              <span>Hello{customer ? `, ${customer.first}` : ''}</span>
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
          {/* phone: logo mark, search and notifications on one row; the cart is in the tab bar */}
        </div>
      </div>
      <div className="no-phone nav-row">
        <div className="container">
          <nav className="store-nav" aria-label="Shop">
            {items.map((n) => (
              <SiteLink key={n.key} to={n.to} className={cx(isActive(n) && 'is-active', n.deal && 'deal')} current={isActive(n)}>
                {n.icon && <Icon name={n.icon} className="ic-sm" />}
                {n.label}
              </SiteLink>
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

/** Phone app bar: back + title (+ actions). Only rendered on the phone layout (.appbar hides itself from tablet up);
 * no wrapper, so it stays stuck to the top while the page scrolls. */
export function Appbar({ title, back, actions }: AppbarOptions) {
  return (
    <div className="appbar">
      <IconButton icon="arrow-left" label="Back" to={back ?? href('store/home')} />
      <span className="title">{title}</span>
      {actions}
    </div>
  );
}

/** App bar search (phone): a search button that grows into a field to its left, over the title. It opens with a
 * query already set; Escape or the close button clears it and closes; leaving it empty closes it. */
export function AppbarSearch({ id, label, value, onChange, onSubmit }: { id: string; label: string; value: string; onChange: (v: string) => void; onSubmit?: () => void }) {
  const [open, setOpen] = useState(!!value);
  const [focusOnOpen, setFocusOnOpen] = useState(false);
  // own text while typing: `value` (the URL query) arrives a render late and would undo fast keystrokes
  const [text, setText] = useState(value);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (document.activeElement !== input.current) setText(value);
  }, [value]);
  useEffect(() => {
    if (open && focusOnOpen) input.current?.focus();
  }, [open, focusOnOpen]);
  const show = () => {
    setFocusOnOpen(true);
    setOpen(true);
  };
  const close = () => {
    setFocusOnOpen(false);
    setText('');
    onChange('');
    setOpen(false);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    input.current?.blur();
    onSubmit?.();
  };
  return (
    <>
      <IconButton icon="search" label={label} onClick={show} aria-expanded={open} aria-controls={id} />
      <form className={cx('appbar-search', open && 'is-open')} role="search" onSubmit={submit}>
        <Icon name="search" className="ic-sm" />
        <label htmlFor={id} className="sr-only">
          {label}
        </label>
        <input
          ref={input}
          id={id}
          type="search"
          placeholder={label}
          value={text}
          autoComplete="off"
          onChange={(e) => {
            setText(e.target.value);
            onChange(e.target.value);
          }}
          onKeyDown={(e) => e.key === 'Escape' && close()}
          onBlur={() => !text && setOpen(false)}
        />
        <IconButton icon="x" label="Close search" onClick={close} />
      </form>
    </>
  );
}

/** Website footer. The phone layout is the Android app: no footer; its links live in the Account tab.
 * Support line, help email, company and service region come from app-config (support, market.company). */
function StoreFooter() {
  const config = useAppConfig().data;
  const support = config?.support;
  const market = config?.market;
  const company = market?.company;
  const groups = useFooterGroups();
  return (
    <footer className="store-footer no-phone">
      <div className="container">
        <div className="cols">
          <div className="stack gap-3">
            <Logo />
            <p className="small muted measure-sm">One store for our own products and approved independent sellers. Every item shows who sells it, when it arrives and how returns work.</p>
            {support && (
              <div className="stack gap-1 small">
                <span>
                  <Icon name="headset" className="ic-sm" /> Support: {support.phone}
                </span>
                <span className="muted">{support.hoursLabel}</span>
                {company?.helpEmail && (
                  <a className="muted" href={`mailto:${company.helpEmail}`}>
                    {company.helpEmail}
                  </a>
                )}
              </div>
            )}
          </div>
          {groups.map((g, i) => (
            <div key={`${i}:${g.title}`}>
              <h4>{g.title}</h4>
              <ul>
                {g.links.map((l, j) => (
                  <li key={`${j}:${l.to}`}>
                    <SiteLink to={l.to}>{l.label}</SiteLink>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="legal">
          <span>
            © {new Date().getFullYear()} {market?.legalName ?? `${BRAND}, Inc.`}
            {market ? ` Prices in ${market.currency}. Service region: ${market.serviceRegionLabel}.` : ''}
          </span>
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
/** Service strip above the header: the content module's text and link (static design copy until it loads). */
function PromoStrip() {
  const navQ = useNavigation();
  const strip = navQ.data?.serviceStrip;
  if (navQ.isSuccess && !strip) return null;
  const text = strip?.text ?? 'Free delivery on Official Store orders over $35 · 30-day returns on most items';
  const link = strip ? strip.link : { label: 'Delivery details', url: '/policies/shipping' };
  const to = link ? safeContentLinkTo(link.url) : null;
  return (
    <div className="store-promo no-phone">
      {text}
      {link && to && (
        <>
          {' · '}
          <SiteLink to={to} className="link-inline">
            {link.label}
          </SiteLink>
        </>
      )}
    </div>
  );
}

/**
 * Header search state shared by the website and phone fields and the suggestions panel. The panel
 * opens when a field is focused or typed in (and on ?view=suggestions-open), and closes on Escape,
 * on a click on the scrim, on submit and on navigation.
 */
function useSearchBox(q: string | undefined): [SearchBox, boolean] {
  const [view, setView] = useView<'suggestions-open'>();
  const location = useLocation();
  const [value, setValue] = useState(q ?? '');
  const [opened, setOpened] = useState(false);
  useEffect(() => setValue(q ?? ''), [q]);
  useEffect(() => setOpened(false), [location.pathname, location.search]);
  const isOpen = opened || view === 'suggestions-open';
  const box: SearchBox = {
    value,
    setValue,
    open: () => setOpened(true),
    close: () => {
      setOpened(false);
      if (view === 'suggestions-open') setView('', { replace: true });
    },
  };
  return [box, isOpen];
}

export function StoreLayout({ nav, tab, appbar, actionBar, footer = true, tabbar = true, promo = true, q, children }: StoreLayoutProps) {
  const [box, suggOpen] = useSearchBox(q);
  return (
    <div className="store">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      {promo && <PromoStrip />}
      <StoreHeader nav={nav} box={box} hideOnPhone={!!appbar} />
      {appbar && <Appbar {...appbar} />}
      <main className="store-main" id="main" tabIndex={-1}>
        {suggOpen && <SearchSuggestions typed={box.value} onClose={box.close} />}
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
