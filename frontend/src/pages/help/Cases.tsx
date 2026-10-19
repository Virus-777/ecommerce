import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { call, useApi } from '@marketly/web-shared/api';
import { AccountLayout } from '@/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { useIsPhone } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import { Alert, Button, EmptyState, Icon, Img, LazyLoad, Pager, StatusBadge, TableWrap, Tabs } from '@marketly/web-shared/ui';
import { LoadError, SkRows } from './data/states';

// Design: pages/store/help-cases.html · Open / Closed / All tabs.
// Data: GET /api/store/support/cases?state=open|closed|all — website pages (page + Pager), phone app
// lazy loading (cursor). Tab counts come from the `total` of two one-row reads (no counts endpoint).
// The "needs your reply" alert is the first open case whose next action is the customer's.

type Filter = 'open' | 'closed' | 'all';
const LIMIT = 20;

const HANDLER_KIND: Record<string, string> = { seller: 'Seller', official_store: 'Official Store', marketplace_support: 'Marketly' };

export default function Cases() {
  const { api } = useApi();
  const isPhone = useIsPhone();
  const [filter, setFilter] = useState<Filter>('all');
  const [page, setPage] = useState(1);

  const list = (state: Filter, p: number, limit = LIMIT) => call(api.GET('/api/store/support/cases', { params: { query: { state, page: p, limit } } }));
  const openQ = useQuery({ queryKey: ['support', 'cases', { state: 'open', page: 1, limit: 50 }], queryFn: () => list('open', 1, 50) });
  const closedQ = useQuery({ queryKey: ['support', 'cases', { state: 'closed', page: 1, limit: 1 }], queryFn: () => list('closed', 1, 1) });
  const pageQ = useQuery({
    queryKey: ['support', 'cases', { state: filter, page, limit: LIMIT }],
    queryFn: () => list(filter, page),
    enabled: !isPhone,
    placeholderData: keepPreviousData,
  });
  const feed = useInfiniteQuery({
    queryKey: ['support', 'cases', 'feed', filter],
    queryFn: ({ pageParam }) => call(api.GET('/api/store/support/cases', { params: { query: { state: filter, limit: LIMIT, ...(pageParam ? { cursor: pageParam } : {}) } } })),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: isPhone,
  });

  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !isPhone || !feed.hasNextPage) return;
    const io = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting && !feed.isFetchingNextPage) void feed.fetchNextPage();
    });
    io.observe(el);
    return () => io.disconnect();
  }, [isPhone, feed]);

  const nOpen = openQ.data?.total ?? openQ.data?.items.length ?? 0;
  const nClosed = closedQ.data?.total ?? closedQ.data?.items.length ?? 0;
  const rows = isPhone ? (feed.data?.pages.flatMap((p) => p.items) ?? []) : (pageQ.data?.items ?? []);
  const active = isPhone ? feed : pageQ;
  const totalPages = pageQ.data?.totalPages ?? 1;
  const needsReply = openQ.data?.items.find((c) => c.nextAction.youNeedToAct);
  const caseTo = (ref: string) => href('help/case', '', { ref });
  const atRisk = (c: (typeof rows)[number]) => c.open && (c.nextAction.due?.state === 'due_soon' || c.nextAction.due?.state === 'overdue');
  const changeFilter = (f: Filter) => {
    setFilter(f);
    setPage(1);
  };

  return (
    <AccountLayout active="cases" title="Support cases">
      <div className="row between">
        <div className="stack gap-1">
          <h1 className="h1">Support cases</h1>
          <p className="small sub">{openQ.isSuccess ? `${nOpen} open · ` : ''}Replies from sellers and Marketly support appear here and by email.</p>
        </div>
        <Button icon="plus" to={href('help/center')}>
          Get help with an order
        </Button>
      </div>
      {needsReply && (
        <Alert tone="warning" title={`${needsReply.ref} needs your reply`}>
          {needsReply.nextAction.label}.{' '}
          <Link to={caseTo(needsReply.ref)} className="link-inline">
            Reply now
          </Link>
        </Alert>
      )}
      <Tabs<Filter>
        label="Case status"
        active={filter}
        onChange={changeFilter}
        items={[
          { label: 'Open', value: 'open', count: openQ.isSuccess ? nOpen : undefined },
          { label: 'Closed', value: 'closed', count: closedQ.isSuccess ? nClosed : undefined },
          { label: 'All', value: 'all', count: openQ.isSuccess && closedQ.isSuccess ? nOpen + nClosed : undefined },
        ]}
      />
      {active.isError ? (
        <LoadError error={active.error} retry={() => void active.refetch()} title="We couldn’t load your cases" />
      ) : active.isPending ? (
        <div className="card">
          <SkRows n={4} />
        </div>
      ) : rows.length === 0 ? (
        <div className="card pad">
          <EmptyState icon="life-buoy" title={filter === 'closed' ? 'No closed cases' : filter === 'open' ? 'No open cases' : 'No support cases yet'} action={<Button variant="secondary" to={href('help/center')}>Visit the Help Center</Button>}>
            When you contact us or report a problem with an order, the case and every reply appear here.
          </EmptyState>
        </div>
      ) : (
        <>
          <div className="card no-phone">
            <TableWrap label="Support cases table">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Case</th>
                    <th scope="col">Subject</th>
                    <th scope="col">Order</th>
                    <th scope="col">Status</th>
                    <th scope="col">Handled by</th>
                    <th scope="col">Next action</th>
                    <th className="col-pin" scope="col">
                      Expected reply
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((c) => (
                    <tr key={c.id} className={cx(atRisk(c) && 'is-warn')}>
                      <td>
                        {atRisk(c) && <span className="sr-only">At risk: </span>}
                        <Link className="mono strong nowrap" to={caseTo(c.ref)} title={c.ref}>
                          {c.ref}
                        </Link>
                      </td>
                      <td>
                        <span className="cell-main">
                          <Img icon="life-buoy" src={c.imageUrl ?? undefined} className="tiny" />
                          <span className="small">{c.subject}</span>
                        </span>
                      </td>
                      <td>
                        {c.orderRef ? (
                          <Link className="mono xs nowrap" to={href('account/order', '', { ref: c.orderRef })} title={c.orderRef}>
                            {c.orderRef}
                          </Link>
                        ) : (
                          <span className="xs muted">–</span>
                        )}
                      </td>
                      <td>
                        <StatusBadge status={c.statusLabel} />
                      </td>
                      <td>
                        <span className="stack gap-0">
                          <span className="small">{c.handledBy.name}</span>
                          <span className="xs muted">{HANDLER_KIND[c.handledBy.kind] ?? c.handledBy.team ?? ''}</span>
                        </span>
                      </td>
                      <td>
                        <span className={cx('small', c.nextAction.youNeedToAct && 'strong')}>{c.nextAction.label}</span>
                      </td>
                      <td className="col-pin">
                        <span className="xs">{c.expectedReply}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
            {rows.some(atRisk) && (
              <p className="status-legend status-legend--edge">
                <span className="sr-only">Legend: </span>
                <span className="sl sl-warning">
                  <i aria-hidden="true" />
                  Amber edge = at risk: due soon or near target
                </span>
              </p>
            )}
          </div>
          {!isPhone && totalPages > 1 && <Pager page={page} total={totalPages} onPage={setPage} only="website" />}
          <div className="stack gap-3 only-phone">
            {rows.map((c) => (
              <Link key={c.id} className="card pad stack gap-2 link-plain" to={caseTo(c.ref)}>
                <div className="row between">
                  <span className="mono strong small">{c.ref}</span>
                  <StatusBadge status={c.statusLabel} />
                </div>
                <div className="row gap-3 nowrap">
                  <Img icon="life-buoy" src={c.imageUrl ?? undefined} className="tiny" />
                  <span className="small strong">{c.subject}</span>
                </div>
                <span className="xs muted">
                  {c.orderRef && (
                    <>
                      Order <span className="mono">{c.orderRef}</span> ·{' '}
                    </>
                  )}
                  {c.handledBy.name} ({HANDLER_KIND[c.handledBy.kind] ?? c.handledBy.team ?? ''})
                </span>
                <span className={cx('xs', c.nextAction.youNeedToAct && 'strong t-warning-text')}>
                  <Icon name="arrow-right" className="ic-sm" /> {c.nextAction.label}
                </span>
                <span className="xs muted">
                  <Icon name="clock" className="ic-sm" /> {c.expectedReply}
                </span>
              </Link>
            ))}
            {isPhone && (
              <div ref={sentinel}>
                <LazyLoad end={!feed.hasNextPage} />
              </div>
            )}
          </div>
        </>
      )}
      <p className="xs muted">Closed cases can be reopened within 30 days if the promised remedy didn't happen. Decisions can be appealed within 14 days.</p>
    </AccountLayout>
  );
}
