import { Fragment, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { AccountLayout } from '@/layouts';
import { cx } from '@/lib/cx';
import type { ScreenId } from '@/routes/catalogue';
import { href } from '@/routes/href';
import { announce, Button, Chip, ChipRow, Icon, type IconName } from '@/ui';

// Design: pages/store/account-notifications.html (one view). Chips filter by category; opening an
// item marks it read; "Mark all as read" clears the unread dots.

type Cat = 'orders' | 'returns' | 'cases' | 'account' | 'promotions';

interface Note {
  id: string;
  cat: Cat;
  group: 'Today' | 'This week' | 'promo';
  icon: IconName;
  tone?: 'info' | 'brand' | 'warning' | 'success' | 'deal';
  title: string;
  time: string;
  body: string;
  meta: ReactNode;
  to: ScreenId;
  unread?: boolean;
}

const ref = (label: string, r: string) => (
  <>
    {label} · <span className="mono">{r}</span>
  </>
);

const NOTES: Note[] = [
  { id: 'n1', cat: 'orders', group: 'Today', icon: 'truck', tone: 'info', title: 'Package 2 of 3 is close', time: '6:20 AM', body: 'Your Kestrel SSDs reached the USPS facility in Portland. Arrives Fri, Oct 9 – Sat, Oct 10.', meta: ref('Orders', 'MK-260914-48213'), to: 'account/tracking', unread: true },
  { id: 'n2', cat: 'orders', group: 'Today', icon: 'message-square', tone: 'brand', title: 'Casa Verde Home replied', time: '9:20 AM', body: 'About your duvet cover: "The Sage color restock arrives tomorrow. We\'ll ship Saturday."', meta: ref('Orders', 'MK-260914-48213'), to: 'account/messages', unread: true },
  { id: 'n3', cat: 'cases', group: 'Today', icon: 'life-buoy', tone: 'warning', title: "Case update: we're following up with the seller", time: '8:05 AM', body: 'Isabel from Marketly Support asked Casa Verde to ship by Oct 10. Next update by Fri, Oct 9, 12:00 PM.', meta: ref('Cases', 'CS-261005-3381'), to: 'help/case', unread: true },
  { id: 'n4', cat: 'returns', group: 'This week', icon: 'undo-2', tone: 'info', title: 'Refund is processing', time: 'Wed', body: 'Pixel & Port received your keyboard. Refund of $109.00 is processing to Visa •••• 4417.', meta: ref('Returns & refunds', 'RT-261002-0520'), to: 'account/returns' },
  { id: 'n5', cat: 'returns', group: 'This week', icon: 'clock', tone: 'warning', title: 'Reminder: drop off your return by Oct 15', time: 'Wed', body: 'Pour-over set. Show the QR code at any UPS location.', meta: ref('Returns & refunds', 'RT-260921-0457'), to: 'account/return' },
  { id: 'n6', cat: 'account', group: 'This week', icon: 'shield-check', title: 'New sign-in on Chrome, Windows', time: 'Tue', body: "Portland, OR. If this wasn't you, change your password.", meta: 'Account', to: 'account/security' },
  { id: 'n7', cat: 'orders', group: 'This week', icon: 'circle-check', tone: 'success', title: 'Order accepted, payment accepted', time: 'Tue', body: 'Trailhead Outfitters is preparing your bottle and yoga mat. Ships by Fri, Oct 9.', meta: ref('Orders', 'MK-261006-90127'), to: 'account/order' },
  { id: 'n8', cat: 'orders', group: 'This week', icon: 'triangle-alert', tone: 'warning', title: 'Your duvet cover is delayed', time: 'Mon', body: 'New estimate: arrives Mon, Oct 12. You can wait, cancel for a full refund, or contact support.', meta: ref('Orders', 'MK-260914-48213'), to: 'account/order' },
  { id: 'n9', cat: 'promotions', group: 'promo', icon: 'trending-down', tone: 'deal', title: 'Price drop on a saved item', time: 'Today', body: 'Kestrel 27" 4K Monitor is now $299.00, lowest in 30 days.', meta: 'Promotions · wishlist alert', to: 'account/wishlist' },
  { id: 'n10', cat: 'promotions', group: 'promo', icon: 'tag', tone: 'deal', title: 'Home Week: up to 30% off bedding and cookware', time: 'Tue', body: 'Ends Mon, Oct 19. Includes Official Store and Casa Verde items.', meta: 'Promotions', to: 'store/deals' },
];

const FILTERS: Array<{ value: '' | Cat; label: string; icon?: IconName }> = [
  { value: '', label: 'All' },
  { value: 'orders', label: 'Orders', icon: 'package' },
  { value: 'returns', label: 'Returns & refunds', icon: 'undo-2' },
  { value: 'cases', label: 'Cases', icon: 'life-buoy' },
  { value: 'account', label: 'Account', icon: 'shield-check' },
  { value: 'promotions', label: 'Promotions', icon: 'tag' },
];

export default function Notifications() {
  const [notes, setNotes] = useState(NOTES);
  const [filter, setFilter] = useState<'' | Cat>('');

  const shown = notes.filter((n) => !filter || n.cat === filter);
  const essential = shown.filter((n) => n.group !== 'promo');
  const promo = shown.filter((n) => n.group === 'promo');
  const unread = notes.filter((n) => n.unread).length;

  const markRead = (id: string) => setNotes((ns) => ns.map((n) => (n.id === id ? { ...n, unread: false } : n)));
  const markAll = () => {
    setNotes((ns) => ns.map((n) => ({ ...n, unread: false })));
    announce('All notifications marked as read');
  };

  const row = (n: Note) => (
    <Link key={n.id} className="acct-row" to={href(n.to)} onClick={() => markRead(n.id)}>
      <span className={cx('acct-ic', n.tone && `t-${n.tone}`)}>
        <Icon name={n.icon} className="ic-sm" />
      </span>
      <span className="stack gap-1 grow">
        <span className="row between gap-2 top">
          <span className={cx('small', n.unread && 'bold')}>{n.title}</span>
          <span className="xs muted nowrap">{n.time}</span>
        </span>
        <span className="xs sub">{n.body}</span>
        <span className="xs muted">{n.meta}</span>
      </span>
      {n.unread && (
        <>
          <span className="acct-dot" aria-hidden="true" />
          <span className="sr-only">Unread</span>
        </>
      )}
    </Link>
  );

  return (
    <AccountLayout active="notifications" title="Notifications">
      <div className="acct-head">
        <div className="stack gap-1">
          <h1 className="h1 acct-h1">Notifications</h1>
          <p className="small sub">Updates about your orders, returns, cases and account. We also email the important ones.</p>
        </div>
        <div className="acts">
          <Button variant="ghost" size="sm" icon="check" onClick={markAll} disabled={unread === 0}>
            Mark all as read
          </Button>
          <Button variant="secondary" size="sm" icon="settings" to={href('account/profile')}>
            Notification settings
          </Button>
        </div>
      </div>
      <ChipRow>
        {FILTERS.map((f) => (
          <Chip key={f.value || 'all'} active={filter === f.value} icon={f.icon} onClick={() => setFilter(f.value)}>
            {f.label}
          </Chip>
        ))}
      </ChipRow>
      {essential.length > 0 && (
        <section className="stack gap-3" aria-labelledby="nt-ess">
          <div className="row between">
            <h2 className="h3" id="nt-ess">
              Order and account updates
            </h2>
            <span className="row gap-1 xs muted">
              <Icon name="lock" className="ic-sm" /> Always on
            </span>
          </div>
          {(['Today', 'This week'] as const).map((g) => {
            const list = essential.filter((n) => n.group === g);
            if (!list.length) return null;
            return (
              <Fragment key={g}>
                <h3 className="eyebrow">{g}</h3>
                <div className="card">{list.map(row)}</div>
              </Fragment>
            );
          })}
        </section>
      )}
      {promo.length > 0 && (
        <section className="stack gap-3" aria-labelledby="nt-promo">
          <div className="row between">
            <h2 className="h3" id="nt-promo">
              Promotions and alerts
            </h2>
            <Link className="xs strong" to={href('account/profile')}>
              Turn off promotions
            </Link>
          </div>
          <div className="card">{promo.map(row)}</div>
        </section>
      )}
      {shown.length === 0 && (
        <div className="card">
          <div className="empty">
            <span className="ring">
              <Icon name="bell-off" />
            </span>
            <h2 className="h3">Nothing here yet</h2>
            <p className="small muted measure-md">Notifications in this category will appear here.</p>
          </div>
        </div>
      )}
    </AccountLayout>
  );
}
