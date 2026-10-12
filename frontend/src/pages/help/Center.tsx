import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useSession } from '@/app/session';
import type { Tint } from '@marketly/web-shared/data/fixtures';
import { StoreLayout } from '@/layouts';
import { href } from '@marketly/web-shared/routes';
import { Button, Icon, Img, StatusBadge, type IconName } from '@marketly/web-shared/ui';

// Design: pages/store/help-center.html

interface Topic {
  icon: IconName;
  name: string;
  sub: string;
}

const TOPICS: Topic[] = [
  { icon: 'shopping-bag', name: 'Shopping', sub: 'Offers, sellers, product questions' },
  { icon: 'truck', name: 'Delivery', sub: 'Estimates, tracking, late packages' },
  { icon: 'credit-card', name: 'Payment', sub: 'Methods, failed or pending payments' },
  { icon: 'circle-x', name: 'Cancellations', sub: 'Cancel items before they ship' },
  { icon: 'undo-2', name: 'Returns', sub: 'Windows, labels, who pays shipping' },
  { icon: 'banknote', name: 'Refunds', sub: 'Refund timing and status' },
  { icon: 'user-round', name: 'Account', sub: 'Sign-in, security, addresses' },
  { icon: 'store', name: 'Marketplace sellers', sub: 'Buying from outside sellers' },
];

const ARTICLES = [
  'Returning an item bought from a marketplace seller',
  'My package is late. What can I do?',
  'Why did my order arrive in several packages?',
  'My payment is pending. Was I charged?',
  'How long do refunds take to reach my card?',
  'What do Official Store and Verified seller mean?',
];

interface RecentOrder {
  ref: string;
  meta: string;
  status: string;
  thumbs: Array<{ icon: IconName; tint: Tint }>;
}

const RECENT: RecentOrder[] = [
  { ref: 'MK-261006-90127', meta: 'Oct 6, 2026 · 2 items · 1 seller', status: 'Preparing', thumbs: [{ icon: 'cup-soda', tint: '6' }, { icon: 'activity', tint: '1' }] },
  { ref: 'MK-260914-48213', meta: 'Sep 14, 2026 · 4 items · 3 sellers', status: 'Partly delivered', thumbs: [{ icon: 'headphones', tint: '2' }, { icon: 'coffee', tint: '3' }, { icon: 'hard-drive', tint: '6' }] },
  { ref: 'MK-260830-11764', meta: 'Aug 30, 2026 · 1 item · 1 seller', status: 'Delivered', thumbs: [{ icon: 'cooking-pot', tint: '3' }] },
];

export default function Center() {
  const { customer } = useSession();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [chat, setChat] = useState(false);
  const query = q.trim().toLowerCase();
  const articles = query ? ARTICLES.filter((a) => a.toLowerCase().includes(query)) : ARTICLES;

  return (
    <StoreLayout tab="account" appbar={{ title: 'Help', back: href('store/home') }}>
      <div className="container page">
        <section className="buy-help-hero">
          <h1 className="display d-lg">How can we help, {customer.first}?</h1>
          <label className="search-in" htmlFor="hc-q">
            <Icon name="search" className="ic-sm" />
            <input
              id="hc-q"
              type="search"
              placeholder='Search help, for example "return shipping"'
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && query && articles.length) navigate(href('help/article'));
              }}
            />
          </label>
          <div className="row gap-2 xs u-justify-center">
            <span className="muted">Popular:</span>
            <Link to={href('help/article')} className="link-inline">
              Return a seller item
            </Link>
            <a href="#" className="link-inline" onClick={(e) => (e.preventDefault(), setQ('package'))}>
              Where is my package?
            </a>
            <a href="#" className="link-inline" onClick={(e) => (e.preventDefault(), setQ('refund'))}>
              Refund timing
            </a>
          </div>
        </section>
        <div className="split">
          <div className="stack gap-6">
            <section className="stack gap-3">
              <h2 className="h2">Browse by topic</h2>
              <div className="buy-topics">
                {TOPICS.map((t) => (
                  <Link key={t.name} className="buy-topic" to={href('help/article')}>
                    <Icon name={t.icon} />
                    <span className="strong small">{t.name}</span>
                    <span className="xs muted">{t.sub}</span>
                  </Link>
                ))}
              </div>
            </section>
            <section className="stack gap-3" aria-live="polite">
              <h2 className="h2">{query ? `Articles matching “${q.trim()}”` : 'Popular articles'}</h2>
              {articles.length ? (
                <ul className="card list pad">
                  {articles.map((a) => (
                    <li key={a}>
                      <Link className="row gap-3 grow link-plain" to={href('help/article')}>
                        <Icon name="file-text" className="ic-sm" />
                        <span className="small grow">{a}</span>
                        <Icon name="chevron-right" className="ic-sm" />
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="card pad small sub">No articles match that search. Try other words, or contact us below.</div>
              )}
            </section>
            <section className="stack gap-3">
              <h2 className="h2">Contact us</h2>
              <div className="buy-contact">
                <div className="card pad stack gap-2">
                  <Icon name="message-circle" />
                  <span className="strong">Chat with us</span>
                  <span className="xs muted">{chat ? 'Connecting you to an agent. Keep this page open.' : 'Mon–Sat, 8 AM–8 PM PT · Typical wait 2 minutes'}</span>
                  <Button variant="secondary" size="sm" onClick={() => setChat(true)} disabled={chat}>
                    {chat ? 'Chat requested' : 'Start chat'}
                  </Button>
                </div>
                <div className="card pad stack gap-2">
                  <Icon name="phone" />
                  <span className="strong">Call 1-800-555-0136</span>
                  <span className="xs muted">Mon–Sat, 8 AM–8 PM PT · Closed Sundays and US holidays</span>
                  <Button variant="secondary" size="sm" to={href('help/contact')}>
                    Request a call back
                  </Button>
                </div>
                <div className="card pad stack gap-2">
                  <Icon name="mail" />
                  <span className="strong">Send a message</span>
                  <span className="xs muted">Any time · We reply within 1 business day</span>
                  <Button variant="secondary" size="sm" to={href('help/contact')}>
                    Write to us
                  </Button>
                </div>
              </div>
              <p className="xs muted">For items from marketplace sellers, the seller answers first. If they haven't replied within 2 business days, Marketly support steps in.</p>
            </section>
          </div>
          <aside className="stack gap-4">
            <section className="card">
              <div className="card-head">
                <div className="stack gap-0">
                  <h3 className="h4">Get help with a recent order</h3>
                  <span className="xs muted">Pick the order. The items are filled in for you.</span>
                </div>
              </div>
              <div>
                {RECENT.map((o) => (
                  <Link key={o.ref} className="buy-order-pick" to={href('help/order-problem', '', undefined, { order: o.ref })}>
                    <span className="buy-thumbs">
                      {o.thumbs.map((t, i) => (
                        <Img key={i} icon={t.icon} tint={t.tint} />
                      ))}
                    </span>
                    <span className="stack gap-0 grow">
                      <span className="small strong mono">{o.ref}</span>
                      <span className="xs muted">{o.meta}</span>
                    </span>
                    <StatusBadge status={o.status} />
                  </Link>
                ))}
              </div>
              <div className="card-foot">
                <Link className="small strong" to={href('account/orders')}>
                  See all orders
                </Link>
              </div>
            </section>
            <div className="card pad stack gap-2">
              <span className="row gap-2">
                <span className="strong small">Your support cases</span>
                <span className="badge t-info">3 open</span>
              </span>
              <span className="xs muted">CS-104882 is waiting on Casa Verde Home. Reply expected by Fri, Oct 9.</span>
              <Link className="small strong" to={href('help/cases')}>
                View cases
              </Link>
            </div>
            <div className="card pad stack gap-2">
              <span className="strong small">Not signed in?</span>
              <span className="xs muted">Guests can look up an order with the reference and email.</span>
              <Link className="small strong" to={href('auth/guest-orders')}>
                Guest order lookup
              </Link>
            </div>
          </aside>
        </div>
      </div>
    </StoreLayout>
  );
}
