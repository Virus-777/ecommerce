import { useState } from 'react';
import { Link } from 'react-router';
import { P } from '@/data/fixtures';
import { AccountLayout } from '@/layouts';
import { money } from '@/lib/format';
import { useView } from '@/lib/hooks';
import { href } from '@/routes/href';
import { Button, EmptyState, Icon, Img, Pager, SearchInput, StatusBadge, Tabs } from '@/ui';
import { ORDER_COUNTS, ORDER_SUMMARIES, type OrderSummary, type OrderTab } from './data/orders';

// Design: pages/store/account-orders.html · view "no-matches" = a search + date range with no results.

const RANGES = ['Last 3 months', 'Last 30 days', 'Last 6 months', '2026', 'All time'] as const;
type Range = (typeof RANGES)[number];
const TODAY = new Date('2026-10-10');

function inRange(o: OrderSummary, r: Range) {
  const d = new Date(o.placedOn);
  const daysAgo = (TODAY.getTime() - d.getTime()) / 86_400_000;
  if (r === 'Last 30 days') return daysAgo <= 30;
  if (r === 'Last 3 months') return daysAgo <= 92;
  if (r === 'Last 6 months') return daysAgo <= 183;
  if (r === '2026') return d.getFullYear() === 2026;
  return true;
}

function matches(o: OrderSummary, q: string) {
  const s = q.trim().toLowerCase();
  if (!s) return true;
  return o.ref.toLowerCase().includes(s) || o.items.some((id) => P[id].name.toLowerCase().includes(s)) || o.packages.some((p) => p.seller.toLowerCase().includes(s));
}

export default function Orders() {
  const [view, setView] = useView<'no-matches'>();
  const [q, setQ] = useState(view === 'no-matches' ? 'standing desk' : '');
  const [range, setRange] = useState<Range>(view === 'no-matches' ? 'Last 30 days' : 'Last 3 months');
  const [tab, setTab] = useState<'all' | OrderTab>('all');
  const [page, setPage] = useState(1);

  const filtered = ORDER_SUMMARIES.filter((o) => matches(o, q) && inRange(o, range));
  const shown = tab === 'all' ? filtered : filtered.filter((o) => o.tabs.includes(tab));
  const filtering = q.trim() !== '' || range !== 'Last 3 months';
  const clear = () => {
    setQ('');
    setRange('Last 3 months');
    setTab('all');
    if (view) setView('');
  };

  return (
    <AccountLayout active="orders" title="Orders">
      <div className="acct-head">
        <div className="stack gap-1">
          <h1 className="h1 acct-h1">Orders</h1>
          <p className="small sub">23 orders since Aug 2026. Each order can have several sellers and packages.</p>
        </div>
      </div>
      <div className="toolbar">
        <SearchInput id="ord-q" placeholder="Search by order number or product" value={q} onChange={setQ} />
        <label className="sr-only" htmlFor="ord-range">
          Date range
        </label>
        <select className="select" id="ord-range" value={range} onChange={(e) => setRange(e.target.value as Range)}>
          {RANGES.map((r) => (
            <option key={r}>{r}</option>
          ))}
        </select>
      </div>
      <Tabs
        active={tab}
        onChange={setTab}
        items={[
          { value: 'all', label: 'All', count: filtering ? filtered.length : ORDER_COUNTS.all },
          { value: 'in-progress', label: 'In progress', count: ORDER_COUNTS['in-progress'] },
          { value: 'delivered', label: 'Delivered', count: ORDER_COUNTS.delivered },
          { value: 'returns', label: 'Returns', count: ORDER_COUNTS.returns },
          { value: 'cancelled', label: 'Cancelled', count: ORDER_COUNTS.cancelled },
        ]}
      />
      {shown.length === 0 ? (
        <div className="card">
          <EmptyState
            icon="search-x"
            as="h2"
            title={q.trim() ? `No orders match "${q.trim()}"` : 'No orders here yet'}
            action={
              <div className="row gap-2 u-justify-center">
                <Button onClick={clear}>Clear filters</Button>
                <Button variant="secondary" to={href('auth/guest-orders')}>
                  Look up a guest order
                </Button>
              </div>
            }
          >
            Nothing in {range === 'All time' ? 'your orders' : range === '2026' ? '2026' : `the ${range.toLowerCase()}`} matches that search. Try the order number from your confirmation email, or widen the date range.
          </EmptyState>
        </div>
      ) : (
        <>
          <div className="stack gap-4">
            {shown.map((o) => (
              <OrderCard key={o.ref} o={o} />
            ))}
          </div>
          <div className="row between">
            <span className="small muted">{filtering || tab !== 'all' ? `Showing ${shown.length} of ${shown.length} orders` : 'Showing 1–5 of 23 orders'}</span>
            <Pager page={page} total={5} onPage={setPage} />
          </div>
        </>
      )}
    </AccountLayout>
  );
}

function OrderCard({ o }: { o: OrderSummary }) {
  const to = href('account/order', '', { ref: o.ref });
  return (
    <article className="card">
      <div className="acct-ohead">
        <div>
          <span className="acct-k">Order</span>
          <Link className="mono strong" to={to}>
            {o.ref}
          </Link>
        </div>
        <div>
          <span className="acct-k">Placed</span>
          {o.placed}
        </div>
        <div>
          <span className="acct-k">Total</span>
          <span className="num strong">{money(o.total)}</span>
        </div>
        <div>
          <span className="acct-k">Sellers</span>
          {o.sellers} seller{o.sellers > 1 ? 's' : ''} · {o.packages.length} package{o.packages.length > 1 ? 's' : ''}
        </div>
        <div className="st">
          <StatusBadge status={o.status} />
        </div>
      </div>
      <div className="card-body">
        <div className="row top between gap-4">
          <div className="stack gap-2 grow minw-240">
            {o.packages.map((p) => (
              <div key={p.label} className="acct-pkg">
                <Icon name="package" className="ic-sm" />
                <span className="strong">{p.label}</span>
                <span className="muted">{p.seller}</span>
                <StatusBadge status={p.status} />
                <span className="xs sub">{p.note}</span>
              </div>
            ))}
          </div>
          <div className="acct-thumbs">
            {o.items.map((id) => (
              <Link key={id} to={href('store/product')} aria-label={P[id].name}>
                <Img icon={P[id].icon} tint={P[id].tint} className="thumb" />
              </Link>
            ))}
          </div>
        </div>
        {o.note && <span className="xs sub">{o.note}</span>}
      </div>
      <div className="card-foot start">
        <Button size="sm" to={to}>
          View order
        </Button>
        {o.actions.includes('cancel') && (
          <Button variant="secondary" size="sm" to={href('account/cancel', '', { ref: o.ref })}>
            Cancel items
          </Button>
        )}
        {o.actions.includes('track') && (
          <Button variant="secondary" size="sm" icon="truck" to={href('account/tracking', '', { ref: o.ref })}>
            Track package
          </Button>
        )}
        {o.actions.includes('return') && (
          <Button variant="secondary" size="sm" icon="undo-2" to={href('account/return-new', '', { ref: o.ref })}>
            Return items
          </Button>
        )}
        {o.actions.includes('review') && (
          <Button variant="secondary" size="sm" icon="star" to={href('account/review')}>
            Write a review
          </Button>
        )}
        {o.actions.includes('buy-again') && (
          <Button variant="ghost" size="sm" icon="rotate-ccw" to={href('store/product')}>
            Buy again
          </Button>
        )}
      </div>
    </article>
  );
}
