import { useState, type MouseEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import { useSession } from '@/app/session';
import { useApi } from '@marketly/web-shared/api';
import { BRAND } from '@marketly/web-shared/config';
import { AccountLayout } from '@/layouts';
import { formatMoney } from '@marketly/web-shared/lib/format';
import type { ScreenId } from '@marketly/web-shared/routes';
import { href } from '@marketly/web-shared/routes';
import { Alert, Avatar, Badge, Button, Card, EmptyState, Icon, Img, SegmentedControl, StatusBadge, type IconName } from '@marketly/web-shared/ui';
import { ACCOUNT_OVERVIEW, caseHref, fmtDay, fmtMonthYear, fmtWeekday, humanize, orderHref, plural, refundTone, returnHref, returnTone, stateTone, type GImage, type GMoney } from './data/orders';
import { LoadError, SkeletonRows } from './data/order-parts';

// Design: pages/store/account-overview.html. On the phone this is the Account tab: no app bar,
// and the menu below the cards lists the app links (help, selling, policies, settings, sign out).
// Data: the AccountOverview screen query without `me.wallet` (wallet is off at launch, gap G2), so
// the store credit tile is hidden.

interface OverviewData {
  me: {
    id: string;
    displayName: string;
    firstName: string;
    email: string;
    memberSince: string;
    orderCounts: { inProgress: number; delayedPackages: number };
    delayedItems: Array<{ orderId: string; orderRef: string; groupId: string; title: string; sellerName: string; newDispatchBy: string | null; newArrivalFrom: string | null; newArrivalTo: string | null; options: string[]; caseRef: string | null }>;
    returnsOverview: { openReturns: number; openNote: string | null; refundsOnTheWay: GMoney };
    unreadMessages: { conversations: number; messages: number; fromNames: string[] };
    openCases: {
      total: number;
      items: Array<{ id: string; ref: string; subject: string; status: string; statusLabel: string; orderRef: string | null; expectedReply: string; handledBy: { kind: string; name: string | null } | null; nextAction: { label: string; youNeedToAct: boolean } | null; items: Array<{ sellerName: string }> }>;
    };
    openReturns: {
      total: number;
      items: Array<{ id: string; ref: string; status: string; statusLabel: string; sellerName: string; items: Array<{ orderItemId: string; title: string; imageUrl: string | null }>; refund: { status: string; statusLabel: string } | null }>;
    };
  };
  orders: {
    total: number;
    items: Array<{ id: string; ref: string; placedAt: string; status: string; statusLabel: string; packageCount: number; thumbnails: GImage[]; totals: { total: GMoney }; groups: Array<{ id: string; items: Array<{ id: string; state: string }> }> }>;
  };
  unreadNotificationCount: number;
}

type MenuLink = { id: ScreenId; view?: string; icon: IconName; label: string; sub?: string; count?: 'messages' | 'notifications' };

const MENU: Array<{ title: string; links: MenuLink[] }> = [
  {
    title: 'Purchases',
    links: [
      { id: 'account/overview', icon: 'layout-dashboard', label: 'Overview' },
      { id: 'account/orders', icon: 'package', label: 'Orders' },
      { id: 'account/returns', icon: 'undo-2', label: 'Returns and refunds' },
      { id: 'help/cases', icon: 'life-buoy', label: 'Support cases' },
      { id: 'account/messages', icon: 'message-square', label: 'Messages', count: 'messages' },
      { id: 'account/notifications', icon: 'bell', label: 'Notifications', count: 'notifications' },
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

/** "1 delivered", "2 shipped": item counts per state for a recent order. */
function itemBadges(groups: OverviewData['orders']['items'][number]['groups']) {
  const counts = new Map<string, number>();
  for (const g of groups) for (const i of g.items) counts.set(i.state, (counts.get(i.state) ?? 0) + 1);
  return [...counts].map(([state, n]) => ({ state, label: `${n} ${humanize(state).toLowerCase()}` }));
}

export default function Overview() {
  const { gql } = useApi();
  const { customer, signOut } = useSession();
  const navigate = useNavigate();
  const [theme, setTheme] = useState<Theme>(readTheme);
  const q = useQuery({
    queryKey: ['customers', 'overview'],
    queryFn: async () => (await gql<OverviewData>(ACCOUNT_OVERVIEW, { recentOrdersPaging: { page: 1, limit: 3 }, openCasesLimit: 3, openReturnsLimit: 2 }, 'AccountOverview')).data!,
  });
  const d = q.data;
  const me = d?.me;
  const name = me?.displayName ?? customer?.name ?? '';
  const counts = { messages: me?.unreadMessages.messages ?? 0, notifications: d?.unreadNotificationCount ?? 0 };

  const changeTheme = (t: Theme) => {
    setTheme(t);
    if (t === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t;
  };
  const onSignOut = async (e: MouseEvent) => {
    e.preventDefault();
    await signOut();
    navigate(href('auth/sign-in'), { replace: true });
  };

  const tiles: Array<{ id: ScreenId; icon: IconName; n: string; label: string; sub: string }> = me
    ? [
        { id: 'account/orders', icon: 'package', n: String(me.orderCounts.inProgress), label: 'Orders in progress', sub: me.orderCounts.delayedPackages ? `${plural(me.orderCounts.delayedPackages, 'package')} delayed` : 'Nothing delayed' },
        { id: 'account/returns', icon: 'undo-2', n: String(me.returnsOverview.openReturns), label: 'Open returns', sub: me.returnsOverview.openNote ?? 'Nothing to send back' },
        { id: 'account/messages', icon: 'message-square', n: String(me.unreadMessages.messages), label: 'Unread messages', sub: me.unreadMessages.fromNames.length ? me.unreadMessages.fromNames.join(', ') : 'You’re all caught up' },
      ]
    : [];

  return (
    <AccountLayout active="overview">
      <div className="acct-head">
        <div className="row gap-3 nowrap">
          <Avatar name={name || ' '} size="lg" />
          <div className="stack gap-0">
            {me ? (
              <>
                <h1 className="h2">Hi, {me.firstName}</h1>
                <span className="small sub">
                  {me.email} · Member since {fmtMonthYear(me.memberSince)}
                </span>
              </>
            ) : (
              <>
                <h1 className="h2">{customer ? `Hi, ${customer.first}` : 'My account'}</h1>
                <span className="sk sk-line short" aria-hidden="true" />
              </>
            )}
          </div>
        </div>
        <div className="acts no-phone">
          {/* No order picker yet: both open the order list, where each order has Track and Return. */}
          <Button variant="secondary" size="sm" icon="truck" to={href('account/orders')}>
            Track a package
          </Button>
          <Button variant="secondary" size="sm" icon="undo-2" to={href('account/orders')}>
            Start a return
          </Button>
        </div>
      </div>

      {q.isError && <LoadError error={q.error} onRetry={() => void q.refetch()} />}

      <div className="acct-tiles">
        {me
          ? tiles.map((t) => (
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
            ))
          : q.isPending &&
            [0, 1, 2].map((i) => (
              <div key={i} className="acct-tile" aria-hidden="true">
                <span className="sk sk-thumb" />
                <span className="sk sk-line short" />
                <span className="sk sk-line" />
              </div>
            ))}
      </div>

      {me?.delayedItems.map((it) => (
        <Alert key={`${it.orderId}-${it.groupId}-${it.title}`} tone="warning" title={`Your ${it.title} is delayed`}>
          {it.sellerName} now expects to ship it by {it.newDispatchBy ? fmtWeekday(it.newDispatchBy) : 'a later date'}
          {it.newArrivalFrom ? ` (arrives ${fmtWeekday(it.newArrivalFrom)}${it.newArrivalTo && it.newArrivalTo !== it.newArrivalFrom ? `–${fmtWeekday(it.newArrivalTo)}` : ''})` : ''}.{' '}
          <Link to={orderHref(it.orderRef)} className="link-inline">
            See your options
          </Link>
          : wait
          {it.options.includes('CANCEL') ? ', cancel this item for a full refund' : ''}
          {it.caseRef ? (
            <>
              , or follow support case{' '}
              <Link className="mono" to={caseHref(it.caseRef)}>
                {it.caseRef}
              </Link>
            </>
          ) : it.options.includes('CONTACT_SUPPORT') ? (
            <>
              , or{' '}
              <Link to={href('help/contact')} className="link-inline">
                contact support
              </Link>
            </>
          ) : null}
          .
        </Alert>
      ))}

      <Card title="Recent orders" actions={<Link className="small strong" to={href('account/orders')}>All orders</Link>} flush>
        <div>
          {!d && q.isPending && <SkeletonRows rows={3} />}
          {d && d.orders.items.length === 0 && (
            <EmptyState icon="package" title="No orders yet" action={<Button to={href('store/home')}>Start shopping</Button>}>
              Orders you place show up here with their packages and returns.
            </EmptyState>
          )}
          {d?.orders.items.map((o) => (
            <Link key={o.ref} className="acct-row" to={orderHref(o.ref)}>
              <span className="acct-thumbs none">
                {o.thumbnails.slice(0, 3).map((t) => (
                  <Img key={t.id} icon="package" tint="2" className="tiny" src={t.url} alt={t.alt ?? ''} />
                ))}
              </span>
              <span className="stack gap-1 grow">
                <span className="row gap-2 between">
                  <span className="mono small strong">{o.ref}</span>
                  <StatusBadge status={o.statusLabel} tone={stateTone(o.status)} />
                </span>
                <span className="xs muted">
                  Placed {fmtDay(o.placedAt)} · {formatMoney(o.totals.total)} · {plural(o.packageCount, 'package')}
                </span>
                <span className="row gap-1">
                  {itemBadges(o.groups).map((b) => (
                    <Badge key={b.state} tone={stateTone(b.state)}>
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
          {!me && q.isPending && <SkeletonRows rows={1} />}
          {me && me.openCases.items.length === 0 && (
            <div className="acct-row">
              <span className="xs muted">You have no open support cases.</span>
            </div>
          )}
          {me?.openCases.items.map((c) => (
            <Link key={c.id} className="acct-row" to={caseHref(c.ref)}>
              <span className={`acct-ic t-${c.nextAction?.youNeedToAct ? 'danger' : 'warning'}`}>
                <Icon name="life-buoy" className="ic-sm" />
              </span>
              <span className="stack gap-1 grow">
                <span className="row between gap-2">
                  <span className="small strong">{c.subject}</span>
                  <StatusBadge status={c.statusLabel} />
                </span>
                <span className="xs muted">
                  <span className="mono">{c.ref}</span>
                  {c.orderRef && (
                    <>
                      {' '}
                      · Order <span className="mono">{c.orderRef}</span>
                    </>
                  )}
                  {c.items[0] && ` · ${c.items[0].sellerName}`}
                </span>
                <span className="xs sub">
                  {c.handledBy?.name ? `Handled by ${c.handledBy.name}. ` : ''}
                  {c.nextAction?.label ?? c.expectedReply}
                </span>
              </span>
            </Link>
          ))}
        </Card>
        <Card title="Returns and refunds" titleAs="h3" actions={<Link className="small strong" to={href('account/returns')}>All returns</Link>} flush>
          {!me && q.isPending && <SkeletonRows rows={2} />}
          {me && me.openReturns.items.length === 0 && (
            <div className="acct-row">
              <span className="xs muted">You have no open returns.</span>
            </div>
          )}
          {me?.openReturns.items.map((r) => {
            const item = r.items[0];
            return (
              <Link key={r.id} className="acct-row" to={returnHref(r.ref)}>
                <Img icon="package" tint="2" className="tiny" src={item?.imageUrl ?? undefined} alt="" />
                <span className="stack gap-1 grow">
                  <span className="small strong truncate">{item?.title ?? r.ref}</span>
                  <span className="row gap-2 xs muted">
                    Return <Badge tone={returnTone(r.status)}>{r.statusLabel}</Badge> Refund <Badge tone={refundTone(r.refund?.status)}>{r.refund?.statusLabel ?? 'Not started'}</Badge>
                  </span>
                </span>
              </Link>
            );
          })}
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
                  {l.count && counts[l.count] ? <span className="acct-count">{counts[l.count]}</span> : null}
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
            <Link to={href('auth/sign-in')} onClick={onSignOut}>
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
            <Button variant="secondary" block icon="log-out" to={href('auth/sign-in')} onClick={onSignOut}>
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
