import { useState } from 'react';
import { Link } from 'react-router';
import { SellerLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { href } from '@marketly/web-shared/routes';
import { Alert, Badge, Button, Card, Deadline, EmptyState, Icon, PageHeader, Switch, type IconName } from '@marketly/web-shared/ui';

// Design: pages/seller/seller-notifications.html (no views).

type Cat = 'orders' | 'returns' | 'products' | 'account';
type Group = 'Today' | 'Earlier this week' | 'Older';

interface Note {
  id: string;
  group: Group;
  to: string;
  icon: IconName;
  title: string;
  body: string;
  cat: Cat;
  unread: boolean;
  /** urgent = red edge + danger badge; action = amber edge + warning badge. */
  kind?: 'urgent' | 'action';
  deadline?: { tone: 'ok' | 'warning' | 'danger'; text: string };
  time: string;
  /** Kept back until "Load older notices". */
  archived?: boolean;
}

const CATS: Array<{ key: Cat | 'all'; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'orders', label: 'Orders' },
  { key: 'returns', label: 'Returns & cases' },
  { key: 'products', label: 'Products' },
  { key: 'account', label: 'Account & finance' },
];
const CAT_LABEL: Record<Cat, string> = { orders: 'Orders', returns: 'Returns & cases', products: 'Products', account: 'Account & finance' };
const GROUPS: Group[] = ['Today', 'Earlier this week', 'Older'];

const NOTES: Note[] = [
  { id: 'n1', group: 'Today', to: href('seller/order'), icon: 'alarm-clock', title: 'Dispatch overdue: MK-261007-10433', body: 'Halden Pocket Speaker × 1 for Alex M. was due Oct 8, 12:00 PM. Ship it or tell the buyer the new date. Overdue orders count toward dispatch reliability.', cat: 'orders', unread: true, kind: 'urgent', deadline: { tone: 'danger', text: 'Overdue 3 h' }, time: '3:02 PM' },
  { id: 'n2', group: 'Today', to: href('seller/order'), icon: 'shopping-bag', title: '2 new orders to dispatch today', body: 'MK-261008-12077 (Pocket Speaker × 2) and MK-261008-11902 (Aurora ANC Headphones).', cat: 'orders', unread: true, kind: 'action', deadline: { tone: 'warning', text: 'Dispatch by 5:00 PM' }, time: '9:14 AM' },
  { id: 'n3', group: 'Today', to: href('seller/return', 'inspect-and-refund'), icon: 'package-check', title: 'Return received: RT-260930-0730', body: 'Halden Aurora ANC Headphones arrived at your return address. Record the inspection and refund decision.', cat: 'returns', unread: true, kind: 'action', deadline: { tone: 'ok', text: 'Inspect by Oct 10, 9:05 AM' }, time: '9:05 AM' },
  { id: 'n4', group: 'Today', to: href('seller/returns', 'disputes'), icon: 'scale', title: 'Dispute RT-260927-0622 needs your evidence', body: 'Marketly support is reviewing the customer’s challenge to your $46.00 partial refund. Add photos or test results before the deadline.', cat: 'returns', unread: true, kind: 'action', deadline: { tone: 'warning', text: 'Evidence due Oct 9, 5:00 PM' }, time: '8:30 AM' },
  { id: 'n5', group: 'Earlier this week', to: href('seller/product-new', 'changes-requested'), icon: 'file-pen-line', title: 'Changes requested: Ardent USB Desk Microphone', body: 'Reviewer Omar Haddad asked for a photo without a watermark and the sample rate in the specifications.', cat: 'products', unread: false, kind: 'action', deadline: { tone: 'ok', text: 'Resubmit by Oct 14' }, time: 'Wed, Oct 7' },
  { id: 'n6', group: 'Earlier this week', to: href('seller/return'), icon: 'undo-2', title: 'New return request: RT-261007-0977', body: 'Halden Aurora ANC Headphones · changed mind. Respond by Oct 10, 9:40 AM.', cat: 'returns', unread: false, time: 'Wed, Oct 7' },
  { id: 'n7', group: 'Earlier this week', to: href('seller/finance'), icon: 'lock', title: 'Hold placed on MK-261003-07712', body: '$172.59 held because the carrier shows no delivery scan. Review date Mon, Oct 12. No action needed unless you have proof of delivery.', cat: 'account', unread: false, time: 'Tue, Oct 6' },
  { id: 'n8', group: 'Earlier this week', to: href('seller/performance'), icon: 'gavel', title: 'Appeal window closes Oct 16', body: 'New listings in Cameras are still paused (RS-261002-0019). Upload documents or appeal before the deadline.', cat: 'account', unread: false, kind: 'action', deadline: { tone: 'ok', text: 'Appeal by Oct 16' }, time: 'Tue, Oct 6' },
  { id: 'n9', group: 'Earlier this week', to: href('seller/finance'), icon: 'landmark', title: 'Payout PO-261005-3381 paid: $3,427.95', body: 'Sent Oct 5 to Pacific Coast Credit Union •••• 6620. Arrived Oct 6. Includes a refund-after-payout deduction.', cat: 'account', unread: false, time: 'Mon, Oct 5' },
  { id: 'n10', group: 'Earlier this week', to: href('seller/products'), icon: 'circle-check', title: 'Product approved: Halden Pocket Speaker, Sand', body: 'Your new color variation is live on the shared product page.', cat: 'products', unread: false, time: 'Mon, Oct 5' },
  { id: 'n11', group: 'Older', to: href('seller/setup'), icon: 'badge-check', title: 'Seller application approved', body: 'Northwind Audio is approved to sell on Marketly. Finish store setup and submit your first offers.', cat: 'account', unread: false, time: 'Jul 14, 2026' },
  // Older notices revealed by "Load older notices" (sample).
  { id: 'n12', group: 'Older', to: href('seller/setup'), icon: 'file-check', title: 'Documents received', body: 'Thanks for uploading your business registration. Marketly staff will check it within 2 business days.', cat: 'account', unread: false, time: 'Jul 10, 2026', archived: true },
  { id: 'n13', group: 'Older', to: href('seller/setup'), icon: 'mail-check', title: 'Seller application submitted', body: 'We received the Northwind Audio application. You can track it in the setup guide.', cat: 'account', unread: false, time: 'Jul 8, 2026', archived: true },
];

export default function Notifications() {
  const [notes, setNotes] = useState(NOTES);
  const [cat, setCat] = useState<Cat | 'all'>('all');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [showOlder, setShowOlder] = useState(false);
  const [allRead, setAllRead] = useState(false);

  const loaded = notes.filter((n) => showOlder || !n.archived);
  const unreadN = loaded.filter((n) => n.unread).length;
  const actionN = loaded.filter((n) => n.kind).length;
  const countOf = (k: Cat | 'all') => loaded.filter((n) => k === 'all' || n.cat === k).length;
  const shown = loaded.filter((n) => (cat === 'all' || n.cat === cat) && (!unreadOnly || n.unread));
  const actions = loaded.filter((n) => n.kind);

  const markRead = (id: string) => setNotes((l) => l.map((n) => (n.id === id ? { ...n, unread: false } : n)));
  const markAllRead = () => {
    setNotes((l) => l.map((n) => ({ ...n, unread: false })));
    setAllRead(true);
  };

  return (
    <SellerLayout active="notifications">
      <PageHeader
        title="Notifications"
        sub={`${unreadN} unread · ${actionN} need action. Times in Pacific Time.`}
        actions={
          <Button variant="secondary" size="sm" icon="check-check" onClick={markAllRead} disabled={!unreadN}>
            Mark all as read
          </Button>
        }
      />
      <div className="sb-main">
        <div className="stack gap-3">
          {allRead && !unreadN && <Alert tone="success" title="All notices marked as read" />}
          <div className="row between">
            <div className="hscroll gap-2">
              {CATS.map((c) => (
                <a
                  key={c.key}
                  className={cx('chip', cat === c.key && 'is-active')}
                  href="#"
                  aria-current={cat === c.key ? 'true' : undefined}
                  onClick={(e) => {
                    e.preventDefault();
                    setCat(c.key);
                  }}
                >
                  {c.label} ({countOf(c.key)})
                </a>
              ))}
            </div>
            <Switch id="nt-unread" label="Unread only" checked={unreadOnly} aria-checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} />
          </div>
          <section className="card">
            {shown.length === 0 && (
              <div className="card-body">
                <EmptyState icon="bell" title={unreadOnly ? 'No unread notices' : 'No notices here'}>
                  {unreadOnly ? 'You’re all caught up. Turn off Unread only to see earlier notices.' : 'Notices for this category will appear here.'}
                </EmptyState>
              </div>
            )}
            {GROUPS.map((g) => {
              const items = shown.filter((n) => n.group === g);
              if (!items.length) return null;
              return [
                <div key={g} className="sb-grp">
                  {g}
                </div>,
                ...items.map((n) => (
                  <Link key={n.id} className={cx('sb-note', n.unread && 'is-unread', n.kind && `is-${n.kind}`)} to={n.to} onClick={() => markRead(n.id)}>
                    {n.kind === 'urgent' && <span className="sr-only">Urgent: </span>}
                    {n.kind === 'action' && <span className="sr-only">Needs action: </span>}
                    <span className="ic">
                      <Icon name={n.icon} />
                    </span>
                    <span className="stack gap-1">
                      <span className="row gap-2">
                        {n.unread && (
                          <>
                            <span className="dot" aria-hidden="true" />
                            <span className="sr-only">Unread.</span>
                          </>
                        )}
                        <span className={n.unread ? 'small bold' : 'small strong'}>{n.title}</span>
                      </span>
                      <span className="xs sub">{n.body}</span>
                      <span className="row gap-2">
                        <Badge tone="outline">{CAT_LABEL[n.cat]}</Badge>
                        {n.kind && (
                          <Badge tone={n.kind === 'urgent' ? 'danger' : 'warning'} icon="triangle-alert">
                            Action required
                          </Badge>
                        )}
                        {n.deadline && <Deadline tone={n.deadline.tone}>{n.deadline.text}</Deadline>}
                      </span>
                    </span>
                    <span className="side">
                      <span className="xs muted nowrap">{n.time}</span>
                      <Icon name="chevron-right" className="ic-sm" />
                    </span>
                  </Link>
                )),
              ];
            })}
            <div className="card-foot">
              <span className="xs muted grow">Notices are kept for 12 months.</span>
              {!showOlder && (
                <Button variant="ghost" size="sm" onClick={() => setShowOlder(true)}>
                  Load older notices
                </Button>
              )}
            </div>
          </section>
        </div>
        <div className="stack gap-5">
          <Card title="Needs action" sub="Sorted by deadline">
            <ul className="list">
              {actions.map((n) => (
                <li key={n.id}>
                  <span className="grow stack gap-0">
                    <Link className="small strong" to={n.to} onClick={() => markRead(n.id)}>
                      {n.title}
                    </Link>
                    {n.deadline && <Deadline tone={n.deadline.tone}>{n.deadline.text}</Deadline>}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
          <Card title="Email notifications" titleAs="h3">
            <p className="small sub">Choose which notices each person also gets by email.</p>
            <Link className="small strong" to={href('seller/staff')}>
              <Icon name="settings" className="ic-sm" /> Notification preferences
            </Link>
            <Alert tone="info" title="Essential notices can’t be turned off">
              New orders, dispatch deadlines, return and case deadlines, restrictions, payout results and security alerts always appear here and are always emailed to the owner.
            </Alert>
          </Card>
        </div>
      </div>
    </SellerLayout>
  );
}
