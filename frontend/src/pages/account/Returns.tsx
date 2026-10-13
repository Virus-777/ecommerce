import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { call, useApi, type components } from '@marketly/web-shared/api';
import { AccountLayout } from '@/layouts';
import { formatMoney } from '@marketly/web-shared/lib/format';
import { href } from '@marketly/web-shared/routes';
import { Badge, Button, Card, Icon, Img, Pager, Stat, Tabs } from '@marketly/web-shared/ui';
import { fmtMonthDay, humanize, plural, refundTone, returnHref, returnTone, thisYear } from './data/orders';
import { LoadError, SkeletonRows } from './data/order-parts';

// Design: pages/store/account-returns.html (one view). Return status tracks the item, refund status the money.
// Data: GET returns/requests?state=open|completed|all (ReturnSummary rows) and GET returns/requests/overview (stats).

type ReturnRow = components['schemas']['returns.ReturnSummary'];
type TabKey = 'open' | 'completed' | 'all';
const LIMIT = 50;

function ReturnRowLink({ r }: { r: ReturnRow }) {
  const more = r.itemCount > 1 ? ` and ${plural(r.itemCount - 1, 'more item')}` : '';
  return (
    <Link className="acct-row" to={returnHref(r.ref)}>
      <Img icon="package" tint="2" className="thumb" src={r.item.imageUrl ?? undefined} alt="" />
      <span className="stack gap-2 grow">
        <span className="row between gap-2">
          <span className="mono small strong">{r.ref}</span>
          <span className="xs muted">
            Opened {fmtMonthDay(r.openedAt)} · Order <span className="mono">{r.orderRef}</span>
          </span>
        </span>
        <span className="stack gap-0">
          <span className="small strong">
            {r.item.title}
            {more}
          </span>
          <span className="xs muted">
            {r.sellerName}
            {r.refundAmount ? ` · Refund ${formatMoney(r.refundAmount)}` : ''}
          </span>
        </span>
        <span className="row gap-4">
          <span className="row gap-2">
            <span className="acct-k">Return</span>
            <Badge tone={returnTone(r.status)}>{r.statusLabel}</Badge>
          </span>
          <span className="row gap-2">
            <span className="acct-k">Refund</span>
            <Badge tone={refundTone(r.refundStatus)}>{r.refundStatus ? humanize(r.refundStatus) : 'Not started'}</Badge>
          </span>
        </span>
        <span className="row gap-2 nowrap xs sub top">
          <Icon name="arrow-right" className="ic-sm" />
          <span>{r.nextStep}</span>
        </span>
      </span>
    </Link>
  );
}

export default function Returns() {
  const { api } = useApi();
  const [tab, setTab] = useState<TabKey>('open');
  const [page, setPage] = useState(1);
  const list = (state: TabKey, p = 1) => ({
    queryKey: ['returns', 'list', state, p],
    queryFn: () => call(api.GET('/api/store/returns/requests', { params: { query: { state, page: p, limit: LIMIT } } })),
  });
  const open = useQuery(list('open'));
  const done = useQuery(list('completed'));
  const all = useQuery({ ...list('all', page), enabled: tab === 'all' });
  const overview = useQuery({ queryKey: ['returns', 'overview'], queryFn: () => call(api.GET('/api/store/returns/requests/overview')) });

  const failed = [open, done, overview].find((x) => x.isError);
  const section = (q: typeof open, empty: string) =>
    q.isPending ? (
      <section className="card">
        <SkeletonRows rows={2} />
      </section>
    ) : q.data && q.data.items.length > 0 ? (
      <section className="card">
        {q.data.items.map((r) => (
          <ReturnRowLink key={r.id} r={r} />
        ))}
      </section>
    ) : q.data ? (
      <section className="card">
        <div className="acct-row">
          <span className="small muted">{empty}</span>
        </div>
      </section>
    ) : null;
  const o = overview.data;

  return (
    <AccountLayout active="returns" title="Returns and refunds">
      <div className="acct-head">
        <div className="stack gap-1">
          <h1 className="h1 acct-h1">Returns and refunds</h1>
          <p className="small sub">Return status tracks the item. Refund status tracks the money. They move separately.</p>
        </div>
        <div className="acts">
          {/* No order picker yet: returns start from an order (Orders → Return items). */}
          <Button size="sm" icon="plus" to={href('account/orders')}>
            Start a return
          </Button>
        </div>
      </div>
      {failed && <LoadError error={failed.error} onRetry={() => void Promise.all([open.refetch(), done.refetch(), overview.refetch()])} />}
      <div className="grid md3 gap-3">
        <div className="card pad">
          <Stat label="Open returns" value={o ? o.openReturns : '–'} note={o?.openNote ?? undefined} />
        </div>
        <div className="card pad">
          <Stat label="Refunds on the way" value={o ? formatMoney(o.refundsOnTheWay) : '–'} note={o?.refundsOnTheWayNote ?? undefined} />
        </div>
        <div className="card pad">
          <Stat label={`Refunded in ${thisYear()}`} value={o ? formatMoney(o.refundedThisYear) : '–'} note={o ? plural(o.completedThisYear, 'completed return') : undefined} />
        </div>
      </div>
      <Tabs<TabKey>
        active={tab}
        onChange={(t) => {
          setTab(t);
          setPage(1);
        }}
        items={[
          { value: 'open', label: 'Open', count: open.data?.total ?? o?.openReturns },
          { value: 'completed', label: 'Completed', count: done.data?.total },
          { value: 'all', label: 'All', count: open.data && done.data ? (open.data.total ?? 0) + (done.data.total ?? 0) : undefined },
        ]}
      />
      {tab === 'all' ? (
        <>
          {all.isError ? <LoadError error={all.error} onRetry={() => void all.refetch()} /> : section(all, "You haven't returned anything yet.")}
          {(all.data?.totalPages ?? 1) > 1 && <Pager page={page} total={all.data!.totalPages!} onPage={setPage} only="website" />}
        </>
      ) : (
        <>
          {tab === 'open' && section(open, 'You have no open returns.')}
          <h2 className="h3">Completed</h2>
          {section(done, 'No completed returns yet.')}
        </>
      )}
      <Card title="How refunds work" titleAs="h3">
        <div className="grid md3 gap-4">
          <div className="stack gap-1">
            <span className="small strong">
              <Icon name="clock" className="ic-sm" /> Timing
            </span>
            <span className="xs sub">We send the refund after the item is received and inspected, usually within 2 business days. Banks take 3–5 business days more.</span>
          </div>
          <div className="stack gap-1">
            <span className="small strong">
              <Icon name="credit-card" className="ic-sm" /> Destination
            </span>
            <span className="xs sub">Refunds go back to the original payment method unless you chose store credit.</span>
          </div>
          <div className="stack gap-1">
            <span className="small strong">
              <Icon name="life-buoy" className="ic-sm" /> If a seller doesn't respond
            </span>
            <span className="xs sub">
              Marketly support steps in when a seller misses a deadline.{' '}
              <Link to={href('help/cases')} className="link-inline">
                See your cases
              </Link>
              .
            </span>
          </div>
        </div>
      </Card>
    </AccountLayout>
  );
}
