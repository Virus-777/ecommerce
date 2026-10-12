import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useSession } from '@/app/session';
import { cx } from '@marketly/web-shared/lib/cx';
import type { ScreenId } from '@marketly/web-shared/routes';
import { href } from '@marketly/web-shared/routes';
import { Avatar, Icon, type IconName } from '@marketly/web-shared/ui';
import { StoreLayout } from './StoreLayout';

export type AccountNavKey =
  | 'overview' | 'orders' | 'returns' | 'cases' | 'messages' | 'notifications' | 'reviews'
  | 'wishlist' | 'coupons' | 'profile' | 'addresses' | 'payment' | 'security';

type NavItem = { grp: string } | { key: AccountNavKey; label: string; icon: IconName; id: ScreenId; count?: number };

export const ACCOUNT_NAV: NavItem[] = [
  { grp: 'Purchases' },
  { key: 'overview', label: 'Overview', icon: 'layout-dashboard', id: 'account/overview' },
  { key: 'orders', label: 'Orders', icon: 'package', id: 'account/orders' },
  { key: 'returns', label: 'Returns and refunds', icon: 'undo-2', id: 'account/returns' },
  { key: 'cases', label: 'Support cases', icon: 'life-buoy', id: 'help/cases' },
  { key: 'messages', label: 'Messages', icon: 'message-square', id: 'account/messages', count: 2 },
  { key: 'notifications', label: 'Notifications', icon: 'bell', id: 'account/notifications', count: 3 },
  { key: 'reviews', label: 'Reviews and feedback', icon: 'star', id: 'account/reviews' },
  { grp: 'Saved' },
  { key: 'wishlist', label: 'Wishlist and alerts', icon: 'heart', id: 'account/wishlist' },
  { key: 'coupons', label: 'Coupons and credit', icon: 'ticket-percent', id: 'account/coupons' },
  { grp: 'Settings' },
  { key: 'profile', label: 'Profile', icon: 'user-round', id: 'account/profile' },
  { key: 'addresses', label: 'Addresses', icon: 'map-pin', id: 'account/addresses' },
  { key: 'payment', label: 'Payment methods', icon: 'credit-card', id: 'account/payment-methods' },
  { key: 'security', label: 'Sign-in and security', icon: 'shield-check', id: 'account/security' },
];

export function AccountNav({ active }: { active?: AccountNavKey }) {
  return (
    <nav className="side-nav" aria-label="Account">
      {ACCOUNT_NAV.map((n) =>
        'grp' in n ? (
          <span className="grp" key={n.grp}>
            {n.grp}
          </span>
        ) : (
          <Link key={n.key} to={href(n.id)} className={cx(active === n.key && 'is-active')} aria-current={active === n.key ? 'page' : undefined}>
            <Icon name={n.icon} />
            <span>{n.label}</span>
            {n.count ? <span className="count">{n.count}</span> : null}
          </Link>
        ),
      )}
    </nav>
  );
}

export interface AccountLayoutProps {
  active?: AccountNavKey;
  /** Phone app-bar title (sub-pages). Omit on the Account tab root. */
  title?: ReactNode;
  /** Phone back target (default: account overview). */
  back?: string;
  appbarActions?: ReactNode;
  actionBar?: ReactNode;
  footer?: boolean;
  children: ReactNode;
}

/** My account: website left menu + content; phone app bar + content inside the Account tab. */
export function AccountLayout({ active, title, back, appbarActions, actionBar, footer, children }: AccountLayoutProps) {
  const { customer } = useSession();
  return (
    <StoreLayout tab="account" appbar={title ? { title, back: back ?? href('account/overview'), actions: appbarActions } : null} footer={footer} actionBar={actionBar}>
      <div className="container page">
        <div className="split aside-left">
          <aside className="only-desktop stack gap-4">
            <div className="row gap-3">
              <Avatar name={customer.name} size="lg" />
              <div className="stack gap-0">
                <span className="strong">{customer.name}</span>
                <span className="xs muted">Member since {customer.since}</span>
              </div>
            </div>
            <AccountNav active={active} />
          </aside>
          <div className="stack gap-5">{children}</div>
        </div>
      </div>
    </StoreLayout>
  );
}
