import { useState } from 'react';
import { Link } from 'react-router';
import { AdminLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { useView } from '@marketly/web-shared/lib/hooks';
import type { ScreenId } from '@marketly/web-shared/routes';
import { href } from '@marketly/web-shared/routes';
import { Alert, Avatar, Badge, Button, Card, Checkbox, Deadline, EmptyState, Icon, IconButton, Select, TableWrap, Tabs, announce, type IconName } from '@marketly/web-shared/ui';

// Design: pages/admin/admin-inbox.html · view "needs-my-action" = tab filtered to the 3 notices routed to Riley.
// "Mentions" links to "#" in the design; here it is a local tab that lists the mentions.

type Tab = '' | 'needs-my-action' | 'mentions';

interface Notice {
  id: string;
  day: 'today' | 'week';
  icon: IconName;
  tone: 'danger' | 'warning' | 'info';
  area: string;
  needsMe?: boolean;
  unread: boolean;
  title: string;
  body: string;
  route: string;
  due: string;
  dueTone: 'ok' | 'warning' | 'danger';
  action: string;
  primary?: boolean;
  to: string;
}

const NOTICES: Notice[] = [
  { id: 'n1', day: 'today', icon: 'file-check', tone: 'warning', area: 'Sellers', needsMe: true, unread: true, title: '3 seller applications are past the 2-day review target', body: 'Oldest: Lumen & Loom Ceramics, waiting 3 days for a decision.', route: 'Routed to Seller Manager · Riley Chen (backup, Grace Kim away Oct 8–9)', due: 'Today 5:00 PM', dueTone: 'warning', action: 'Open applications', primary: true, to: href('admin/seller-application') },
  { id: 'n2', day: 'today', icon: 'user-cog', tone: 'info', area: 'Staff and roles', needsMe: true, unread: true, title: 'Access request: Owen Price needs the payout second-reviewer role', body: 'Requested by Priya Nair for the Oct 9 run. Access does not set financial limits; Business Owner Morgan Hale sets those.', route: 'Routed to Platform Administrator · Riley Chen', due: 'Oct 9, 9:00 AM', dueTone: 'warning', action: 'Review request', primary: true, to: href('admin/staff') },
  { id: 'n3', day: 'today', icon: 'life-buoy', tone: 'danger', area: 'Customer service', needsMe: true, unread: true, title: 'CS-104921 lost package is high priority and unassigned for over 1 hour', body: 'Escalation route: unassigned high-priority cases go to the on-duty administrator after 1 hour.', route: 'Routed to Customer Support Manager · Isabel Cruz → on-duty admin Riley Chen', due: 'Overdue 1 h', dueTone: 'danger', action: 'Open cases', primary: true, to: href('admin/cases') },
  { id: 'n4', day: 'today', icon: 'truck', tone: 'danger', area: 'Shipping', unread: true, title: '9 items are past their dispatch deadline', body: '4 seller orders and 5 Official Store items. Oldest: Casa Verde Home, 16 days.', route: 'Routed to Shipping Manager · Theo Grant (lead)', due: 'Overdue', dueTone: 'danger', action: 'Open dispatch queue', to: href('ops/dispatch') },
  { id: 'n5', day: 'today', icon: 'boxes', tone: 'warning', area: 'Inventory', unread: true, title: '12 Official Store SKUs are below reorder point', body: '2 will run out tomorrow at current sales: BRL-LAMP-W and KST-27UHD.', route: 'Routed to Inventory Manager · Ana Silva (lead)', due: 'Today 3:00 PM', dueTone: 'warning', action: 'Open stock', to: href('ops/inventory') },
  { id: 'n6', day: 'today', icon: 'wallet', tone: 'warning', area: 'Finance', unread: false, title: 'Payout run of $78,420.55 needs a second Finance reviewer', body: 'First approval by Priya Nair at 8:52 AM. Release is Fri, Oct 9, 10:00 AM PT.', route: 'Routed to Finance Manager · Priya Nair (lead), Owen Price', due: 'Oct 9, 9:30 AM', dueTone: 'warning', action: 'Open payout run', to: href('admin/payouts') },
  { id: 'n7', day: 'today', icon: 'circle-alert', tone: 'danger', area: 'Finance', unread: false, title: '2 payouts from the Oct 2 run failed', body: 'Rowan Leather Co. account closed. Moss & Mill name mismatch, corrected by seller.', route: 'Routed to Finance Manager · Priya Nair (lead)', due: 'Before Oct 9 run', dueTone: 'ok', action: 'Open payouts', to: href('admin/payouts') },
  { id: 'n8', day: 'today', icon: 'scale', tone: 'danger', area: 'Finance', unread: false, title: 'Unusual financial activity: settlement for Oct 7 is $12.40 short', body: 'Also flagged: 6 new-account orders to one Reno address (TR-3402).', route: 'Routed to Finance Manager · Priya Nair · Trust and Risk · Sven Larsen', due: 'Today 12:00 PM', dueTone: 'warning', action: 'Open finance checks', to: href('ops/finance-checks') },
  { id: 'n9', day: 'today', icon: 'arrow-up-right', tone: 'danger', area: 'Customer service', unread: false, title: 'CS-104915 escalated: damaged item return disputed by seller', body: 'Customer has waited 4 hours past the response target.', route: 'Routed to Returns Manager · Lena Park (lead)', due: 'Overdue 4 h', dueTone: 'danger', action: 'Open case', to: href('admin/cases') },
  { id: 'n10', day: 'week', icon: 'megaphone', tone: 'info', area: 'Advertisements', unread: false, title: 'Fall Home Sale opening ad is waiting for Content approval', body: 'Advertising approved. Start date Oct 16.', route: 'Routed to Content Manager · Noor Aziz (lead)', due: 'Oct 12', dueTone: 'ok', action: 'Open campaign', to: href('admin/ad-campaign', 'approval') },
  { id: 'n11', day: 'week', icon: 'shield-alert', tone: 'danger', area: 'Trust and risk', unread: false, title: 'Counterfeit report TR-3391 escalated, seller restricted', body: 'Gadget Grove listings in Home & Kitchen stopped. Open orders and returns continue.', route: 'Routed to Trust and Risk Manager · Sven Larsen (lead)', due: 'Appeal by Oct 14', dueTone: 'ok', action: 'Open report', to: href('admin/trust-report', '', { ref: 'TR-3391' }) },
  { id: 'n12', day: 'week', icon: 'boxes', tone: 'warning', area: 'Inventory', unread: false, title: 'Receiving discrepancy on PUR-260930-0112: 24 units short', body: 'Supplier Halden Audio Supply. Stock was not added for missing units.', route: 'Routed to Purchasing Manager · Ken Watanabe (lead)', due: 'Resolved Oct 7', dueTone: 'ok', action: 'Open stock', to: href('ops/inventory') },
];

const DAYS: Array<{ key: Notice['day']; label: string }> = [
  { key: 'today', label: 'Today · Thu, Oct 8' },
  { key: 'week', label: 'Earlier this week' },
];

const AREAS = ['All areas', 'Shipping', 'Inventory', 'Finance', 'Customer service', 'Sellers', 'Advertisements', 'Trust and risk', 'Staff and roles'];

interface Mention {
  id: string;
  who: string;
  ref: string;
  to: ScreenId;
  quote: string;
  time: string;
}

const MENTIONS: Mention[] = [
  { id: 'm1', who: 'Isabel Cruz', ref: 'CS-104882', to: 'admin/case', quote: '"Riley, can you confirm the appeal deadline text in the decision notice?"', time: '9:12 AM' },
  { id: 'm2', who: 'Priya Nair', ref: 'PO-RUN-261009', to: 'admin/payouts', quote: '"Owen needs the second-reviewer role before 9:30 AM tomorrow."', time: '8:55 AM' },
];

const ROUTING = [
  { role: 'Seller Manager', name: 'Riley Chen', note: 'Backup until Oct 9', lead: 'Grace Kim · away', away: true },
  { role: 'Shipping Manager', name: 'Theo Grant', lead: 'Theo Grant' },
  { role: 'Inventory Manager', name: 'Ana Silva', lead: 'Ana Silva' },
  { role: 'Finance Manager', name: 'Priya Nair', lead: 'Priya Nair' },
  { role: 'Customer Support', name: 'Isabel Cruz', lead: 'Isabel Cruz' },
];

function MentionList({ items }: { items: Mention[] }) {
  return (
    <ul className="list pad">
      {items.map((m) => (
        <li key={m.id}>
          <span className="grow stack gap-0">
            <span className="small">
              <b>{m.who}</b> in{' '}
              <Link to={href(m.to)} className="link-inline">
                {m.ref}
              </Link>
            </span>
            <span className="xs muted">
              {m.quote} · {m.time}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

export default function Inbox() {
  const [view, setView] = useView<'needs-my-action'>();
  const [extraTab, setExtraTab] = useState<'' | 'mentions'>('');
  const tab: Tab = extraTab || view;
  const [notices, setNotices] = useState(NOTICES);
  const [area, setArea] = useState(AREAS[0]);
  const [unreadOnly, setUnreadOnly] = useState(false);

  const needsMe = notices.filter((n) => n.needsMe);
  const shown = notices.filter((n) => (tab !== 'needs-my-action' || n.needsMe) && (area === AREAS[0] || n.area === area) && (!unreadOnly || n.unread));

  const changeTab = (t: Tab) => {
    if (t === 'mentions') {
      setExtraTab('mentions');
      return;
    }
    setExtraTab('');
    setView(t);
  };
  const toggleRead = (id: string) => {
    setNotices((l) => l.map((n) => (n.id === id ? { ...n, unread: !n.unread } : n)));
  };
  const markAll = () => {
    setNotices((l) => l.map((n) => ({ ...n, unread: false })));
    announce('All notices marked as read');
  };

  return (
    <AdminLayout active="inbox">
      <div className="page-head">
        <div className="t">
          <h1 className="h1">Notifications inbox</h1>
          <p className="sub small">Riley Chen · Platform Administrator · backup Seller Manager on Oct 8–9</p>
        </div>
        <div className="actions">
          <Button variant="ghost" size="sm" icon="check-check" onClick={markAll} disabled={!notices.some((n) => n.unread)}>
            Mark all as read
          </Button>
          <Button variant="secondary" size="sm" icon="settings" to={href('admin/notifications')}>
            Notification settings
          </Button>
        </div>
      </div>

      <div className="ab-main">
        <div className="stack gap-3">
          <Tabs<Tab>
            items={[
              { label: 'All', value: '', count: notices.length },
              { label: 'Needs my action', value: 'needs-my-action', count: needsMe.length },
              { label: 'Mentions', value: 'mentions', count: MENTIONS.length },
            ]}
            active={tab}
            onChange={changeTab}
          />
          {tab !== 'mentions' && (
            <div className="toolbar">
              <Select id="in-area" aria-label="Area" options={AREAS} value={area} onChange={(e) => setArea(e.target.value)} />
              <Checkbox id="in-unread" label="Unread only" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} />
            </div>
          )}
          {tab === 'needs-my-action' && (
            <Alert tone="brand" title={`${needsMe.length} notices need you today`}>
              Two come from your own role. One reaches you as backup Seller Manager while Grace Kim is away.
            </Alert>
          )}
          {tab === 'mentions' ? (
            <section className="card" aria-label="Mentions">
              <MentionList items={MENTIONS} />
            </section>
          ) : (
            <section className="card" aria-label="Notices">
              {shown.length === 0 && (
                <EmptyState icon="bell-off" title="No notices match">
                  Change the area or turn off Unread only to see more notices.
                </EmptyState>
              )}
              {DAYS.map((d) => {
                const rows = shown.filter((n) => n.day === d.key);
                if (!rows.length) return null;
                return [
                  <div className="ab-day" key={d.key}>
                    {d.label}
                  </div>,
                  ...rows.map((n) => (
                    <article key={n.id} className={cx('ab-ntc', n.unread && 'is-unread')}>
                      <span className={`ic t-${n.tone}`}>
                        <Icon name={n.icon} className="ic-sm" />
                      </span>
                      <div className="stack gap-1">
                        <span className="row gap-2">
                          <Badge tone="outline">{n.area}</Badge>
                          {n.needsMe && <Badge tone="brand">Needs my action</Badge>}
                          {n.unread && <span className="sr-only">Unread.</span>}
                        </span>
                        <span className="small strong">{n.title}</span>
                        <span className="xs sub">{n.body}</span>
                        <span className="meta">
                          <span>
                            <Icon name="route" className="ic-sm" /> {n.route}
                          </span>
                          <Deadline tone={n.dueTone}>{n.due}</Deadline>
                        </span>
                      </div>
                      <div className="acts">
                        <Button variant={n.primary ? 'primary' : 'secondary'} size="sm" to={n.to}>
                          {n.action}
                        </Button>
                        <IconButton icon={n.unread ? 'check' : 'mail'} label={n.unread ? 'Mark as read' : 'Mark as unread'} onClick={() => toggleRead(n.id)} />
                      </div>
                    </article>
                  )),
                ];
              })}
            </section>
          )}
          <p className="ab-note">
            <Icon name="info" className="ic-sm" /> Shown here in the workspace and sent by email according to each person's settings. SMS and push come later.
          </p>
        </div>

        <div className="stack gap-4">
          <Card
            title="Routing today"
            sub="Notices go to roles, not people"
            flush
            foot={
              <>
                <span className="ab-note grow">When a lead is away, the backup gets the same notices and deadlines. The lead sees them on return.</span>
                <Button variant="ghost" size="sm" to={href('admin/staff')}>
                  Edit backups
                </Button>
              </>
            }
          >
            <TableWrap label="Routing today table">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Role</th>
                    <th scope="col">Receives now</th>
                    <th scope="col">Lead</th>
                  </tr>
                </thead>
                <tbody>
                  {ROUTING.map((r) => (
                    <tr key={r.role}>
                      <td>{r.role}</td>
                      <td>
                        <span className="row nowrap gap-2">
                          <Avatar name={r.name} className="ab-av-sm" />
                          <span className="ab-cell">
                            <span className="strong">{r.name}</span>
                            {r.note && <span className="xs muted">{r.note}</span>}
                          </span>
                        </span>
                      </td>
                      <td>{r.away ? <span className="xs t-warning-text strong">{r.lead}</span> : r.lead}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          </Card>
          <Card titleAs="h3" title="Mentions" sub={`${MENTIONS.length} unread`} flush>
            <MentionList items={MENTIONS} />
          </Card>
        </div>
      </div>
    </AdminLayout>
  );
}
