import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { STAFF } from '../data/staff';
import { cx } from '../lib/cx';
import type { ScreenId } from '../routes/catalogue';
import { href } from '../routes/href';
import { Avatar, Badge, Count, Icon, IconButton, LogoMark, LogoTile, type IconName } from '../ui';
import { Logo } from './Logo';

export type BoArea = 'seller' | 'admin' | 'ops';

interface NavLinkItem {
  key: string;
  label: string;
  icon: IconName;
  id: ScreenId;
  count?: number;
  /** Urgent count: red pill + screen-reader note. */
  hot?: boolean;
  countSr?: string;
  countTitle?: string;
}
type NavEntry = NavLinkItem | { grp: string; items: NavLinkItem[] };

export const SELLER_NAV: NavEntry[] = [
  { key: 'setup', label: 'Setup guide', icon: 'list-checks', id: 'seller/setup' },
  { key: 'dashboard', label: 'Dashboard', icon: 'layout-dashboard', id: 'seller/dashboard' },
  { key: 'products', label: 'Products and offers', icon: 'package', id: 'seller/products' },
  { key: 'inventory', label: 'Inventory', icon: 'boxes', id: 'seller/inventory', count: 3 },
  { key: 'orders', label: 'Orders', icon: 'shopping-bag', id: 'seller/orders', count: 4, hot: true, countSr: '(1 overdue, 3 new)', countTitle: '1 overdue + 3 new' },
  { key: 'shipping', label: 'Shipping', icon: 'truck', id: 'seller/shipping' },
  { key: 'returns', label: 'Returns and cases', icon: 'undo-2', id: 'seller/returns', count: 2 },
  { key: 'finance', label: 'Finance', icon: 'wallet', id: 'seller/finance' },
  { key: 'marketing', label: 'Marketing and ads', icon: 'megaphone', id: 'seller/marketing' },
  { key: 'customers', label: 'Customers', icon: 'message-square', id: 'seller/customers', count: 5 },
  { key: 'reports', label: 'Statistics', icon: 'chart-column', id: 'seller/reports' },
  { key: 'performance', label: 'Account health', icon: 'gauge', id: 'seller/performance' },
  { key: 'store', label: 'Store and settings', icon: 'store', id: 'seller/store' },
  { key: 'notifications', label: 'Notifications', icon: 'bell', id: 'seller/notifications', count: 4 },
  { key: 'help', label: 'Help and support', icon: 'life-buoy', id: 'seller/help' },
];

export const ADMIN_NAV: NavEntry[] = [
  { key: 'dashboard', label: 'Dashboard', icon: 'layout-dashboard', id: 'admin/dashboard' },
  { key: 'inbox', label: 'Notifications', icon: 'bell', id: 'admin/inbox', count: 9, hot: true },
  { grp: 'Commerce', items: [
    { key: 'orders', label: 'Orders', icon: 'shopping-bag', id: 'admin/orders' },
    { key: 'returns', label: 'Returns and refunds', icon: 'undo-2', id: 'admin/returns', count: 14 },
    { key: 'shipping', label: 'Shipping', icon: 'truck', id: 'admin/shipping' },
  ] },
  { grp: 'Catalog', items: [
    { key: 'catalog', label: 'Products', icon: 'package', id: 'admin/catalog' },
    { key: 'review', label: 'Review queue', icon: 'list-checks', id: 'admin/product-review', count: 23 },
    { key: 'categories', label: 'Categories and brands', icon: 'folder-tree', id: 'admin/categories' },
    { key: 'reviews', label: 'Reviews and Q&A', icon: 'star', id: 'admin/reviews', count: 6 },
  ] },
  { grp: 'Official store', items: [
    { key: 'official', label: 'Offers and trading', icon: 'badge-check', id: 'admin/official' },
    { key: 'purchasing', label: 'Suppliers and purchasing', icon: 'factory', id: 'admin/purchasing' },
  ] },
  { grp: 'Sellers', items: [
    { key: 'sellers', label: 'Sellers', icon: 'store', id: 'admin/sellers' },
    { key: 'applications', label: 'Applications', icon: 'file-check', id: 'admin/seller-application', count: 7 },
  ] },
  { grp: 'Finance', items: [
    { key: 'finance', label: 'Payments and fees', icon: 'landmark', id: 'admin/finance' },
    { key: 'finance-statistics', label: 'Financial statistics', icon: 'chart-line', id: 'admin/finance-statistics' },
    { key: 'payouts', label: 'Payouts', icon: 'wallet', id: 'admin/payouts', count: 2, hot: true },
  ] },
  { grp: 'Customers and service', items: [
    { key: 'customers', label: 'Customers', icon: 'users', id: 'admin/customers' },
    { key: 'cases', label: 'Cases and disputes', icon: 'life-buoy', id: 'admin/cases', count: 31 },
    { key: 'trust', label: 'Trust and risk', icon: 'shield-alert', id: 'admin/trust', count: 4, hot: true },
  ] },
  { grp: 'Marketing and content', items: [
    { key: 'promotions', label: 'Promotions and coupons', icon: 'ticket-percent', id: 'admin/promotions' },
    { key: 'content', label: 'Homepage and pages', icon: 'layout-template', id: 'admin/content' },
    { key: 'news', label: 'News', icon: 'newspaper', id: 'admin/news' },
    { key: 'help-content', label: 'Help and policies', icon: 'book-open', id: 'admin/help-content' },
    { key: 'ads', label: 'Advertisements', icon: 'megaphone', id: 'admin/ads' },
    { key: 'ad-assets', label: 'Ad creative library', icon: 'images', id: 'admin/ad-assets' },
  ] },
  { grp: 'Departments', items: [
    { key: 'dept-phones', label: 'Phones', icon: 'smartphone', id: 'admin/departments-phones' },
    { key: 'dept-blogs', label: 'Blogs', icon: 'newspaper', id: 'admin/departments-blogs' },
    { key: 'dept-companies', label: 'Companies', icon: 'building-2', id: 'admin/departments-companies' },
    { key: 'dept-play', label: 'Play center', icon: 'gamepad-2', id: 'admin/departments-play' },
  ] },
  { grp: 'Reports and settings', items: [
    { key: 'reports', label: 'Reports', icon: 'chart-column', id: 'admin/reports' },
    { key: 'staff', label: 'Staff and roles', icon: 'user-cog', id: 'admin/staff' },
    { key: 'settings', label: 'Settings', icon: 'settings', id: 'admin/settings' },
    { key: 'notifications', label: 'Notification templates', icon: 'bell-ring', id: 'admin/notifications' },
    { key: 'audit', label: 'Action history', icon: 'history', id: 'admin/audit' },
    { key: 'backups', label: 'Backups', icon: 'hard-drive', id: 'admin/backups' },
  ] },
];

export const OPS_NAV: NavEntry[] = [
  { key: 'queues', label: 'My work queues', icon: 'inbox', id: 'ops/queues', count: 18, hot: true },
  { grp: 'Inventory and warehouse', items: [
    { key: 'inventory', label: 'Stock', icon: 'boxes', id: 'ops/inventory' },
    { key: 'receiving', label: 'Receiving', icon: 'package-open', id: 'ops/receiving', count: 3 },
    { key: 'pick-pack', label: 'Pick and pack', icon: 'scan-barcode', id: 'ops/pick-pack', count: 27 },
  ] },
  { grp: 'Shipping', items: [{ key: 'dispatch', label: 'Dispatch and exceptions', icon: 'truck', id: 'ops/dispatch', count: 9, hot: true }] },
  { grp: 'Returns', items: [{ key: 'return-inspection', label: 'Return inspection', icon: 'search-check', id: 'ops/return-inspection', count: 5 }] },
  { grp: 'Finance', items: [{ key: 'finance-checks', label: 'Daily finance checks', icon: 'scale', id: 'ops/finance-checks', count: 3 }] },
];

/** Link to the other back office at the bottom of the sidebar. */
const SWITCH: Partial<Record<BoArea, { grp: string; item: NavLinkItem }>> = {
  admin: { grp: 'Operations Center', item: { key: 'ops', label: 'Work queues', icon: 'clipboard-list', id: 'ops/queues', count: 18, hot: true } },
  ops: { grp: 'Admin Center', item: { key: 'admin', label: 'Back to Admin Center', icon: 'arrow-left', id: 'admin/dashboard' } },
};

/** A nav count supplied by the app (overrides the design's sample count for that nav key). */
export interface NavCount {
  n: number;
  /** Urgent: red pill with a screen-reader note. */
  hot?: boolean;
  sr?: string;
  title?: string;
}

/**
 * Who is signed in and what needs attention, supplied by each back-office app (Seller Center, Admin Center).
 * Without a provider the layout shows the design's sample identity and counts.
 */
export interface BackOfficeIdentity {
  user: { name: string; role: string };
  /** Seller Center: the store this session acts for. */
  store?: { name: string; initials: string; statusLabel: string; statusTone: 'success' | 'warning' | 'danger' | 'info' | 'muted' };
  /** Unread notifications for the bell. */
  notifications?: number;
  /** Counts per nav key; keys not listed show no count. */
  counts?: Partial<Record<string, NavCount>>;
  /** Opens the store switcher (several stores) — Seller Center. */
  onSwitchStore?: () => void;
  onSignOut?: () => void;
}

const IdentityContext = createContext<BackOfficeIdentity | null>(null);
export const BackOfficeIdentityProvider = IdentityContext.Provider;

function useNavCount(n: NavLinkItem): NavCount | null {
  const id = useContext(IdentityContext);
  if (id?.counts) return id.counts[n.key] ?? null;
  return n.count ? { n: n.count, hot: n.hot, sr: n.hot ? (n.countSr ?? 'urgent') : undefined, title: n.countTitle } : null;
}

const AREA_LABEL: Record<BoArea, string> = { seller: 'Seller Center', admin: 'Admin Center', ops: 'Operations' };
/** Each area's home: the sidebar logo links there (not to the store). */
const AREA_HOME: Record<BoArea, ScreenId> = { seller: 'seller/dashboard', admin: 'admin/dashboard', ops: 'ops/queues' };
const NAV: Record<BoArea, NavEntry[]> = { seller: SELLER_NAV, admin: ADMIN_NAV, ops: OPS_NAV };

function NavItemLink({ n, active, onNavigate }: { n: NavLinkItem; active?: string; onNavigate?: () => void }) {
  const on = n.key === active;
  const c = useNavCount(n);
  return (
    <Link to={href(n.id)} className={cx(on && 'is-active')} aria-current={on ? 'page' : undefined} onClick={onNavigate}>
      <Icon name={n.icon} />
      <span>{n.label}</span>
      {c && c.n > 0 ? <Count n={c.n} tone={c.hot ? 'danger' : undefined} sr={c.hot ? (c.sr ?? 'urgent') : c.sr} title={c.title} /> : null}
    </Link>
  );
}

function NavGroup({ grp, items, active, area, onNavigate }: { grp: string; items: NavLinkItem[]; active?: string; area: BoArea; onNavigate?: () => void }) {
  const hasActive = items.some((i) => i.key === active);
  const [open, setOpen] = useState(area === 'ops' || hasActive);
  return (
    <details className="nav-grp" open={open} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary className="grp">
        <span>{grp}</span>
        <Icon name="chevron-down" className="nav-chev" />
      </summary>
      <div className="nav-grp-links">
        {items.map((n) => (
          <NavItemLink key={n.key} n={n} active={active} onNavigate={onNavigate} />
        ))}
      </div>
    </details>
  );
}

function Sidebar({ area, active, sheet, onClose }: { area: BoArea; active?: string; sheet?: boolean; onClose?: () => void }) {
  const label = AREA_LABEL[area];
  const identity = useContext(IdentityContext);
  const user = identity?.user ?? STAFF[area];
  const sw = SWITCH[area];
  const navRef = useRef<HTMLElement>(null);
  // Bring the active item into view inside the sidebar's own scroller (AD-01).
  useEffect(() => {
    const nav = navRef.current;
    const a = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !a || nav.scrollHeight <= nav.clientHeight) return;
    const top = a.offsetTop - nav.offsetTop;
    if (top + a.offsetHeight > nav.clientHeight) nav.scrollTop = Math.max(0, top - nav.clientHeight / 3);
  }, []);
  return (
    <aside className={cx('bo-side', sheet && 'is-sheet')} id={sheet ? undefined : 'bo-side'}>
      <div className="brand">
        <Logo area={label} home={AREA_HOME[area]} />
        {sheet && <IconButton icon="x" label="Close menu" className="nav-sheet-close" onClick={onClose} />}
      </div>
      <nav aria-label={label} ref={navRef}>
        {NAV[area].map((n) =>
          'grp' in n ? <NavGroup key={n.grp} grp={n.grp} items={n.items} active={active} area={area} onNavigate={onClose} /> : <NavItemLink key={n.key} n={n} active={active} onNavigate={onClose} />,
        )}
      </nav>
      {sw && (
        <nav className="bo-switch" aria-label={`Switch to ${sw.grp}`}>
          <span className="grp">{sw.grp}</span>
          <NavItemLink n={sw.item} onNavigate={onClose} />
        </nav>
      )}
      <div className="me">
        <Avatar name={user.name} />
        <div className="stack gap-0 grow min-w-0">
          <span className="strong truncate">{user.name}</span>
          <span className="xs muted truncate">{user.role}</span>
        </div>
        {identity?.onSignOut && <IconButton icon="log-out" label="Sign out" size="sm" onClick={identity.onSignOut} />}
      </div>
    </aside>
  );
}

/** Phone/tablet menu: the sidebar in a native modal <dialog class="nav-sheet">. */
function NavSheet({ area, active, open, onClose }: { area: BoArea; active?: string; open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      d.querySelector<HTMLElement>('[aria-current="page"]')?.focus();
    } else if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className="nav-sheet" aria-label="Menu" onClose={onClose} onClick={(e) => e.target === e.currentTarget && onClose()}>
      {open && <Sidebar area={area} active={active} sheet onClose={onClose} />}
    </dialog>
  );
}

export interface BackOfficeLayoutProps {
  area: BoArea;
  /** Key of the active nav item (e.g. 'orders'). */
  active?: string;
  children: ReactNode;
}

/** Shared chrome for Seller Center, Admin Center and Operations: sidebar, top bar, phone section chips. */
export function BackOfficeLayout({ area, active, children }: BackOfficeLayoutProps) {
  const [menu, setMenu] = useState(false);
  const identity = useContext(IdentityContext);
  const user = identity?.user ?? STAFF[area];
  const store = identity?.store ?? { name: STAFF.seller.store, initials: STAFF.seller.storeInitials, statusLabel: 'Approved · selling', statusTone: 'success' as const };
  const unread = identity ? (identity.notifications ?? 0) : area === 'seller' ? 4 : 9;
  const flat = NAV[area].flatMap((n) => ('grp' in n ? n.items : [n]));
  const mobile = SWITCH[area] ? [...flat, SWITCH[area]!.item] : flat;

  // "/" focuses the back-office search.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key !== '/' || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable) return;
      const q = document.getElementById('bo-q');
      if (q && q.offsetParent !== null) {
        e.preventDefault();
        q.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="bo">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <Sidebar area={area} active={active} />
      <div className="bo-main">
        <header className="bo-top">
          <div className="bar">
            <span className="no-desktop">
              <IconButton icon="menu" label="Open menu" aria-expanded={menu} aria-haspopup="dialog" onClick={() => setMenu(true)} />
            </span>
            <span className="no-desktop only-phone">
              <LogoMark className="logo-mark sm" />
            </span>
            {area === 'seller' ? (
              <button type="button" className="row gap-2 nowrap btn-bare tight" onClick={identity?.onSwitchStore}>
                <span className="sr-only">Switch store: </span>
                <LogoTile initials={store.initials} tint="2" size="sm" />
                <span className="sr-only only-phone">{store.name}</span>
                <span className="stack gap-0 no-phone">
                  <span className="small strong">{store.name}</span>
                  <span className={store.statusTone === 'muted' ? 'xs muted' : `xs t-${store.statusTone}-text`}>● {store.statusLabel}</span>
                </span>
                {identity?.onSwitchStore && <Icon name="chevrons-up-down" className="ic-sm" />}
              </button>
            ) : (
              <span className="row gap-2 nowrap small strong no-phone">
                <Badge tone={area === 'ops' ? 'info' : 'solid'}>{area === 'ops' ? 'Operations' : 'Admin'}</Badge>
                <span className="muted">US · USD · PT</span>
              </span>
            )}
            <label className="search no-phone" htmlFor="bo-q">
              <Icon name="search" className="ic-sm" />
              <input id="bo-q" type="search" placeholder={area === 'seller' ? 'Search orders, products, SKUs' : 'Search orders, sellers, products, customers'} />
              <span className="kbd">/</span>
            </label>
            <span className="grow" />
            <span className="only-phone">
              <IconButton icon="search" label="Search" />
            </span>
            <IconButton icon="circle-help" label="Help" to={href(area === 'seller' ? 'seller/help' : 'help/center')} />
            <IconButton icon="bell" label={unread ? `Notifications, ${unread} unread` : 'Notifications'} count={unread || undefined} to={href(area === 'seller' ? 'seller/notifications' : 'admin/inbox')} />
            <span className="no-phone">
              <Avatar name={user.name} />
            </span>
          </div>
          <nav className="bo-mnav" aria-label="Sections">
            {mobile.map((n) => (
              <Link key={n.key} to={href(n.id)} className={cx(n.key === active && 'is-active')} aria-current={n.key === active ? 'page' : undefined}>
                <Icon name={n.icon} />
                {n.label}
              </Link>
            ))}
          </nav>
        </header>
        <main className="bo-content" id="main" tabIndex={-1}>
          {children}
        </main>
      </div>
      <NavSheet area={area} active={active} open={menu} onClose={() => setMenu(false)} />
    </div>
  );
}

export const SellerLayout = (p: Omit<BackOfficeLayoutProps, 'area'>) => <BackOfficeLayout area="seller" {...p} />;
export const AdminLayout = (p: Omit<BackOfficeLayoutProps, 'area'>) => <BackOfficeLayout area="admin" {...p} />;
export const OpsLayout = (p: Omit<BackOfficeLayoutProps, 'area'>) => <BackOfficeLayout area="ops" {...p} />;
