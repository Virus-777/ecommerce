import { useState } from 'react';
import { Link } from 'react-router';
import { useSession } from '@/app/session';
import { BRAND } from '@/config';
import { P } from '@/data/fixtures';
import { AccountLayout } from '@/layouts';
import { money } from '@/lib/format';
import type { ScreenId } from '@/routes/catalogue';
import { href } from '@/routes/href';
import { Alert, Avatar, Badge, Button, Card, Icon, Img, SegmentedControl, StatusBadge, type IconName, type Tone } from '@/ui';
import { ORDER_SUMMARIES } from './data/orders';

// Design: pages/store/account-overview.html. On the phone this is the Account tab: no app bar,
// and the menu below the cards lists the app links (help, selling, policies, settings, sign out).

const TILES: Array<{ id: ScreenId; icon: IconName; n: string; label: string; sub: string }> = [
  { id: 'account/orders', icon: 'package', n: '2', label: 'Orders in progress', sub: '1 package delayed' },
  { id: 'account/returns', icon: 'undo-2', n: '3', label: 'Open returns', sub: '1 needs drop-off' },
  { id: 'account/messages', icon: 'message-square', n: '2', label: 'Unread messages', sub: 'Casa Verde, Support' },
  { id: 'account/coupons', icon: 'wallet', n: money(15), label: 'Store credit', sub: 'Use it at checkout' },
];

const RETURNS: Array<{ p: string; ret: string; retTone: Tone; refund: string }> = [
  { p: 'speaker', ret: 'Requested', retTone: 'info', refund: 'Requested' },
  { p: 'pourover', ret: 'Approved', retTone: 'success', refund: 'Requested' },
];

type MenuLink = { id: ScreenId; view?: string; icon: IconName; label: string; sub?: string; count?: number };

const MENU: Array<{ title: string; links: MenuLink[] }> = [
  {
    title: 'Purchases',
    links: [
      { id: 'account/overview', icon: 'layout-dashboard', label: 'Overview' },
      { id: 'account/orders', icon: 'package', label: 'Orders' },
      { id: 'account/returns', icon: 'undo-2', label: 'Returns and refunds' },
      { id: 'help/cases', icon: 'life-buoy', label: 'Support cases' },
      { id: 'account/messages', icon: 'message-square', label: 'Messages', count: 2 },
      { id: 'account/notifications', icon: 'bell', label: 'Notifications', count: 3 },
      { id: 'account/reviews', icon: 'star', label: 'Reviews and feedback' },
    ],
  },
  {
    title: 'Saved',
    links: [
      { id: 'account/wishlist', icon: 'heart', label: 'Wishlist and alerts' },
      { id: 'account/coupons', icon: 'ticket-percent', label: 'Coupons and credit' },
    ],
  },
  {
    title: 'Settings',
    links: [
      { id: 'account/profile', icon: 'user-round', label: 'Profile' },
      { id: 'account/addresses', icon: 'map-pin', label: 'Addresses' },
      { id: 'account/payment-methods', icon: 'credit-card', label: 'Payment methods' },
      { id: 'account/security', icon: 'shield-check', label: 'Sign-in and security' },
    ],
  },
];

/** App-only sections (phone = the Android app's Account tab). */
const APP_MENU: Array<{ title: string; links: MenuLink[] }> = [
  {
    title: 'Help and support',
    links: [
      { id: 'help/center', icon: 'circle-help', label: 'Help Center' },
      { id: 'help/contact', icon: 'headset', label: 'Contact us', sub: 'Mon–Sat, 8 AM–8 PM PT' },
    ],
  },
  {
    title: 'Selling',
    links: [
      { id: 'sell/landing', icon: 'store', label: `Sell on ${BRAND}`, sub: 'Requirements, fees and how to apply' },
      { id: 'seller/dashboard', icon: 'layout-dashboard', label: 'Seller Center', sub: 'For approved sellers' },
    ],
  },
  {
    title: 'About and policies',
    links: [
      { id: 'info/about', icon: 'info', label: `About ${BRAND}` },
      { id: 'info/policy', view: 'shipping', icon: 'truck', label: 'Shipping policy' },
      { id: 'info/policy', icon: 'undo-2', label: 'Returns policy' },
      { id: 'info/policy', view: 'privacy', icon: 'shield', label: 'Privacy' },
      { id: 'info/policy', view: 'purchase-terms', icon: 'file-text', label: 'Purchase terms' },
      { id: 'info/policy', view: 'seller-rules', icon: 'scale', label: 'Seller rules' },
    ],
  },
];

type Theme = 'system' | 'light' | 'dark';

function readTheme(): Theme {
  const t = document.documentElement.dataset.theme;
  return t === 'light' || t === 'dark' ? t : 'system';
}

export default function Overview() {
  const { customer, setSignedIn } = useSession();
  const [theme, setTheme] = useState<Theme>(readTheme);
  const recent = ORDER_SUMMARIES.slice(0, 3);

  const changeTheme = (t: Theme) => {
    setTheme(t);
    if (t === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t;
  };
  const signOut = () => setSignedIn(false);

  return (
    <AccountLayout active="overview">
      <div className="acct-head">
        <div className="row gap-3 nowrap">
          <Avatar name={customer.name} size="lg" />
          <div className="stack gap-0">
            <h1 className="h2">Hi, {customer.first}</h1>
            <span className="small sub">
              {customer.email} · Member since {customer.since}
            </span>
          </div>
        </div>
        <div className="acts no-phone">
          <Button variant="secondary" size="sm" icon="truck" to={href('account/tracking')}>
            Track a package
          </Button>
          <Button variant="secondary" size="sm" icon="undo-2" to={href('account/return-new')}>
            Start a return
          </Button>
        </div>
      </div>

      <div className="acct-tiles">
        {TILES.map((t) => (
          <Link key={t.id} className="acct-tile" to={href(t.id)}>
            <span className="ic">
              <Icon name={t.icon} className="ic-sm" />
            </span>
            <span className="n">{t.n}</span>
            <span className="stack gap-0">
              <span className="small strong">{t.label}</span>
              <span className="xs muted">{t.sub}</span>
            </span>
          </Link>
        ))}
      </div>

      <Alert tone="warning" title="Your duvet cover is delayed">
        Casa Verde Home now expects to ship it by Sat, Oct 10 (arrives Mon, Oct 12).{' '}
        <Link to={href('account/order')} className="link-inline">
          See your options
        </Link>
        : wait, cancel this item for a full refund, or follow support case{' '}
        <Link className="mono" to={href('help/case')}>
          CS-261005-3381
        </Link>
        .
      </Alert>

      <Card title="Recent orders" actions={<Link className="small strong" to={href('account/orders')}>All orders</Link>} flush>
        <div>
          {recent.map((o) => (
            <Link key={o.ref} className="acct-row" to={href('account/order', '', { ref: o.ref })}>
              <span className="acct-thumbs none">
                {o.items.slice(0, 3).map((id) => (
                  <Img key={id} icon={P[id].icon} tint={P[id].tint} className="tiny" />
                ))}
              </span>
              <span className="stack gap-1 grow">
                <span className="row gap-2 between">
                  <span className="mono small strong">{o.ref}</span>
                  <StatusBadge status={o.status} />
                </span>
                <span className="xs muted">
                  Placed {o.placed} · {money(o.total)} · {o.packages.length} package{o.packages.length > 1 ? 's' : ''}
                </span>
                <span className="row gap-1">
                  {o.itemBadges.map((b) => (
                    <Badge key={b.label} tone={b.tone}>
                      {b.label}
                    </Badge>
                  ))}
                </span>
              </span>
            </Link>
          ))}
        </div>
      </Card>

      <div className="grid lg2">
        <Card title="Open support cases" titleAs="h3" actions={<Link className="small strong" to={href('help/cases')}>All cases</Link>} flush>
          <Link className="acct-row" to={href('help/case')}>
            <span className="acct-ic t-warning">
              <Icon name="life-buoy" className="ic-sm" />
            </span>
            <span className="stack gap-1 grow">
              <span className="row between gap-2">
                <span className="small strong">Duvet cover hasn't shipped</span>
                <StatusBadge status="Waiting on seller" />
              </span>
              <span className="xs muted">
                <span className="mono">CS-261005-3381</span> · Order <span className="mono">MK-260914-48213</span> · Casa Verde Home
              </span>
              <span className="xs sub">Handled by Isabel C., Marketly Support. Next update by Fri, Oct 9, 12:00 PM PT.</span>
            </span>
          </Link>
        </Card>
        <Card title="Returns and refunds" titleAs="h3" actions={<Link className="small strong" to={href('account/returns')}>All returns</Link>} flush>
          {RETURNS.map((r) => (
            <Link key={r.p} className="acct-row" to={href('account/return')}>
              <Img icon={P[r.p].icon} tint={P[r.p].tint} className="tiny" />
              <span className="stack gap-1 grow">
                <span className="small strong truncate">{P[r.p].name}</span>
                <span className="row gap-2 xs muted">
                  Return <Badge tone={r.retTone}>{r.ret}</Badge> Refund <Badge tone="info">{r.refund}</Badge>
                </span>
              </span>
            </Link>
          ))}
        </Card>
      </div>

      <nav className="acct-menu stack gap-4 no-desktop" aria-label="Account menu">
        {MENU.map((g) => (
          <div key={g.title} className="stack gap-2">
            <h2 className="eyebrow">{g.title}</h2>
            <div className="menu-list">
              {g.links.map((l) => (
                <Link key={l.id} to={href(l.id)}>
                  <Icon name={l.icon} />
                  <span>{l.label}</span>
                  {l.count ? <span className="acct-count">{l.count}</span> : null}
                  <Icon name="chevron-right" className="ic-sm" />
                </Link>
              ))}
            </div>
          </div>
        ))}
        <div className="stack gap-2 no-phone">
          <h2 className="eyebrow">Help</h2>
          <div className="menu-list">
            <Link to={href('help/center')}>
              <Icon name="circle-help" />
              <span>Help Center</span>
              <Icon name="chevron-right" className="ic-sm" />
            </Link>
            <Link to={href('auth/sign-in')} onClick={signOut}>
              <Icon name="log-out" />
              <span>Sign out</span>
              <Icon name="chevron-right" className="ic-sm" />
            </Link>
          </div>
        </div>
        <div className="stack gap-4 only-phone">
          {APP_MENU.map((g) => (
            <div key={g.title} className="stack gap-2">
              <h2 className="eyebrow">{g.title}</h2>
              <div className="menu-list">
                {g.links.map((l) => (
                  <Link key={l.label} to={href(l.id, l.view)}>
                    <Icon name={l.icon} />
                    {l.sub ? (
                      <span className="stack gap-0 grow">
                        <span>{l.label}</span>
                        <span className="xs muted">{l.sub}</span>
                      </span>
                    ) : (
                      <span className="grow">{l.label}</span>
                    )}
                    <Icon name="chevron-right" className="ic-sm" />
                  </Link>
                ))}
              </div>
            </div>
          ))}
          <div className="stack gap-2">
            <h2 className="eyebrow">App settings</h2>
            <div className="menu-list">
              <div className="acct-mrow">
                <Icon name="sun-moon" />
                <span className="grow">Appearance</span>
                <SegmentedControl<Theme>
                  label="Appearance"
                  active={theme}
                  onChange={changeTheme}
                  items={[
                    { value: 'system', label: 'System' },
                    { value: 'light', label: 'Light' },
                    { value: 'dark', label: 'Dark' },
                  ]}
                />
              </div>
              <div className="acct-mrow u-c-text-3" aria-disabled="true">
                <Icon name="bell-ring" />
                <span className="stack gap-0 grow">
                  <span>Push notifications</span>
                  <span className="xs muted">Order updates on this device · Coming in a later release</span>
                </span>
                <Badge tone="outline">Later</Badge>
              </div>
            </div>
          </div>
          <div className="stack gap-3 acct-signout">
            <Button variant="secondary" block icon="log-out" to={href('auth/sign-in')} onClick={signOut}>
              Sign out
            </Button>
            <p className="xs muted center">
              {BRAND} for Android · version 1.0.0 (prototype)
              <br />© 2026 {BRAND}, Inc.
            </p>
          </div>
        </div>
      </nav>
    </AccountLayout>
  );
}
