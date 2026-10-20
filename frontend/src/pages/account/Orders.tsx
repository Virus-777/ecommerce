import { useDebounced } from '@marketly/web-shared/lib/hooks';
import { useEffect, useState } from 'react';
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { useSession } from '@/app/session';
import { call, errorMessage, useApi } from '@marketly/web-shared/api';
import { AccountLayout } from '@/layouts';
import { formatMoney } from '@marketly/web-shared/lib/format';
import { useIsPhone, useView } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import { Button, EmptyState, Icon, Img, LazyLoad, Pager, SearchInput, StatusBadge, Tabs } from '@marketly/web-shared/ui';
import { fmtDay, ORDER_LIST, orderHref, plural, shortPackageLabel, stateTone, thisYear, useBuyAgain, type OrderListItem, type OrderListResult, type OrderRange, type OrderTab } from './data/orders';
import { LoadError, SkeletonRows, useInView } from './data/order-parts';

// Design: pages/store/account-orders.html · view "no-matches" = a search + date range with no results
// (the view pre-fills that search; the result comes from the API). Data: the OrderList screen query
// (orders + tab counts for the date range and search); website pages by number, the phone app loads more on scroll.

const LIMIT = 10;
const RANGES: Array<{ value: OrderRange; label: string }> = [
  { value: 'LAST_3_MONTHS', label: 'Last 3 months' },
  { value: 'LAST_30_DAYS', label: 'Last 30 days' },
  { value: 'LAST_6_MONTHS', label: 'Last 6 months' },
  { value: 'THIS_YEAR', label: thisYear() },
  { value: 'ALL', label: 'All time' },
];
const DEFAULT_RANGE: OrderRange = 'LAST_3_MONTHS';

export default function Orders() {
  const { api, gql } = useApi();
  const { customer } = useSession();
  const isPhone = useIsPhone();
  const [view, setView] = useView<'no-matches'>();
  const [q, setQ] = useState(view === 'no-matches' ? 'standing desk' : '');
  const [range, setRange] = useState<OrderRange>(view === 'no-matches' ? 'LAST_30_DAYS' : DEFAULT_RANGE);
  const [tab, setTab] = useState<OrderTab>('ALL');
  const [page, setPage] = useState(1);
  const search = useDebounced(q.trim());
  const filter = { q: search || undefined, range, tab };

  useEffect(() => setPage(1), [search, range, tab]);

  const run = async (paging: { page?: number; cursor?: string; limit: number }) =>
    (await gql<OrderListResult>(ORDER_LIST, { filter, paging, countsRange: range, countsQuery: search || undefined }, 'OrderList')).data!;
  const pageQ = useQuery({
    queryKey: ['orders', 'list', { ...filter, page }],
    queryFn: () => run({ page, limit: LIMIT }),
    enabled: !isPhone,
    placeholderData: keepPreviousData,
  });
  const phoneQ = useInfiniteQuery({
    queryKey: ['orders', 'list', 'cursor', filter],
    initialPageParam: '',
    queryFn: ({ pageParam }) => run(pageParam ? { cursor: pageParam, limit: LIMIT } : { limit: LIMIT }),
    getNextPageParam: (last) => last.orders.nextCursor ?? undefined,
    enabled: isPhone,
  });
  const allTime = useQuery({
    queryKey: ['orders', 'counts', 'all'],
    queryFn: () => call(api.GET('/api/store/orders/orders/counts', { params: { query: { range: 'all' } } })),
  });

  const active = isPhone ? phoneQ : pageQ;
  const first = isPhone ? phoneQ.data?.pages[0] : pageQ.data;
  const orders: OrderListItem[] = isPhone ? (phoneQ.data?.pages.flatMap((p) => p.orders.items) ?? []) : (pageQ.data?.orders.items ?? []);
  const counts = first?.me?.orderCounts;
  const total = pageQ.data?.orders.total ?? orders.length;
  const totalPages = pageQ.data?.orders.totalPages ?? 1;
  const more = useInView<HTMLDivElement>(() => void phoneQ.fetchNextPage(), isPhone && phoneQ.hasNextPage && !phoneQ.isFetchingNextPage);

  const filtering = search !== '' || range !== DEFAULT_RANGE;
  const rangeLabel = RANGES.find((r) => r.value === range)!.label;
  const clear = () => {
    setQ('');
    setRange(DEFAULT_RANGE);
    setTab('ALL');
    if (view) setView('');
  };

  return (
    <AccountLayout active="orders" title="Orders">
      <div className="acct-head">
        <div className="stack gap-1">
          <h1 className="h1 acct-h1">Orders</h1>
          <p className="small sub">
            {allTime.data ? `${plural(allTime.data.all, 'order')}${customer ? ` since ${customer.since}` : ''}. ` : ''}Each order can have several sellers and packages.
          </p>
        </div>
      </div>
      <div className="toolbar">
        <SearchInput id="ord-q" placeholder="Search by order number or product" value={q} onChange={setQ} />
        <label className="sr-only" htmlFor="ord-range">
          Date range
        </label>
        <select className="select" id="ord-range" value={range} onChange={(e) => setRange(e.target.value as OrderRange)}>
          {RANGES.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
      </div>
      <Tabs<OrderTab>
        active={tab}
        onChange={setTab}
        items={[
          { value: 'ALL', label: 'All', count: counts?.all },
          { value: 'IN_PROGRESS', label: 'In progress', count: counts?.inProgress },
          { value: 'DELIVERED', label: 'Delivered', count: counts?.delivered },
          { value: 'RETURNS', label: 'Returns', count: counts?.returns },
          { value: 'CANCELLED', label: 'Cancelled', count: counts?.cancelled },
        ]}
      />
      {active.isError && !first ? (
        <LoadError error={active.error} onRetry={() => void active.refetch()} />
      ) : !first ? (
        <div className="card" role="status" aria-label="Loading orders">
          <SkeletonRows rows={3} />
        </div>
      ) : orders.length === 0 ? (
        <div className="card">
          <EmptyState
            icon="search-x"
            as="h2"
            title={search ? `No orders match "${search}"` : 'No orders here yet'}
            action={
              <div className="row gap-2 u-justify-center">
                {filtering || tab !== 'ALL' ? <Button onClick={clear}>Clear filters</Button> : <Button to={href('store/home')}>Start shopping</Button>}
                <Button variant="secondary" to={href('auth/guest-orders')}>
                  Look up a guest order
                </Button>
              </div>
            }
          >
            {search
              ? `Nothing in ${range === 'ALL' ? 'your orders' : range === 'THIS_YEAR' ? rangeLabel : `the ${rangeLabel.toLowerCase()}`} matches that search. Try the order number from your confirmation email, or widen the date range.`
              : `You have no orders here for ${range === 'ALL' ? 'any date' : range === 'THIS_YEAR' ? rangeLabel : `the ${rangeLabel.toLowerCase()}`}. Try another tab or a wider date range.`}
          </EmptyState>
        </div>
      ) : (
        <>
          <div className="stack gap-4">
            {orders.map((o) => (
              <OrderCard key={o.id} o={o} />
            ))}
          </div>
          {isPhone ? (
            <div ref={more}>{phoneQ.hasNextPage ? <LazyLoad /> : <LazyLoad end />}</div>
          ) : (
            <div className="row between">
              <span className="small muted">
                {total ? `Showing ${(page - 1) * LIMIT + 1}–${(page - 1) * LIMIT + orders.length} of ${plural(total, 'order')}` : ''}
              </span>
              {totalPages > 1 && <Pager page={page} total={totalPages} onPage={setPage} only="website" />}
            </div>
          )}
        </>
      )}
    </AccountLayout>
  );
}

function OrderCard({ o }: { o: OrderListItem }) {
  const to = orderHref(o.ref);
  const buyAgain = useBuyAgain();
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
          {fmtDay(o.placedAt)}
        </div>
        <div>
          <span className="acct-k">Total</span>
          <span className="num strong">{formatMoney(o.totals.total)}</span>
        </div>
        <div>
          <span className="acct-k">Sellers</span>
          {plural(o.sellerCount, 'seller')} · {plural(o.packageCount, 'package')}
        </div>
        <div className="st">
          <StatusBadge status={o.statusLabel} tone={stateTone(o.status)} />
        </div>
      </div>
      <div className="card-body">
        <div className="row top between gap-4">
          <div className="stack gap-2 grow minw-240">
            {o.groups.map((g) => (
              <div key={g.id} className="acct-pkg">
                <Icon name="package" className="ic-sm" />
                <span className="strong">{shortPackageLabel(g.packageLabel)}</span>
                <span className="muted">{g.seller.name}</span>
                <StatusBadge status={g.statusLabel} tone={stateTone(g.status)} />
                {g.estimateLabel && <span className="xs sub">{g.estimateLabel}</span>}
              </div>
            ))}
          </div>
          {/* Thumbnails carry no product id in the order list, so they open the order. */}
          <div className="acct-thumbs">
            {/* Two lines can share a photo (a replacement line, the same product twice): key by position too. */}
            {o.thumbnails.map((t, i) => (
              <Link key={`${t.id}:${i}`} to={to} aria-label={t.alt ?? o.ref}>
                <Img icon="package" tint="2" className="thumb" src={t.url} alt="" />
              </Link>
            ))}
          </div>
        </div>
        {o.note && <span className="xs sub">{o.note}</span>}
        {buyAgain.isError && <span className="xs t-danger-text">{errorMessage(buyAgain.error)}</span>}
      </div>
      <div className="card-foot start">
        <Button size="sm" to={to}>
          View order
        </Button>
        {o.actions.includes('CANCEL') && (
          <Button variant="secondary" size="sm" to={href('account/cancel', '', { ref: o.ref })}>
            Cancel items
          </Button>
        )}
        {o.actions.includes('TRACK') && (
          <Button variant="secondary" size="sm" icon="truck" to={href('account/tracking', '', { ref: o.ref })}>
            Track package
          </Button>
        )}
        {o.actions.includes('RETURN') && (
          <Button variant="secondary" size="sm" icon="undo-2" to={href('account/return-new', '', { ref: o.ref })}>
            Return items
          </Button>
        )}
        {o.actions.includes('REVIEW') && (
          <Button variant="secondary" size="sm" icon="star" to={href('account/reviews')}>
            Write a review
          </Button>
        )}
        {o.actions.includes('BUY_AGAIN') && (
          <Button variant="ghost" size="sm" icon="rotate-ccw" onClick={() => buyAgain.mutate(o.ref)} disabled={buyAgain.isPending}>
            {buyAgain.isPending ? 'Adding to cart…' : 'Buy again'}
          </Button>
        )}
      </div>
    </article>
  );
}
