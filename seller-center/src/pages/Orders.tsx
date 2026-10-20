import { LoadError as SellerLoadError } from '@/pages/data/home';
import { useEffect, useRef, useState } from 'react';
import { keepPreviousData, useInfiniteQuery, useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { call, errorMessage, newIdempotencyKey, useApi } from '@marketly/web-shared/api';
import { SellerLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { useIsPhone, useView } from '@marketly/web-shared/lib/hooks';
import { formatMoney } from '@marketly/web-shared/lib/format';
import { Alert, Button, Deadline, EmptyState, Img, LazyLoad, Pager, SearchInput, StatusBadge, StatusLegend, TableWrap, Tabs, announce } from '@marketly/web-shared/ui';
import { useSellerSession } from '@/app/session';
import {
  BUYER_CANCEL_REASON,
  addDays,
  dayKey,
  deadlineTone,
  dueText,
  nextAction,
  openDownload,
  orderLink,
  ptDateTime,
  useDebounced,
  useInView,
  waitForExport,
  type CancellationRequest,
  type OrderDetailRest,
  type OrderRow,
} from './data/orders';

// Design: pages/seller/seller-orders.html (New tab) · views "preparing", "shipped", "completed",
// "cancellation-requests" are the other tabs.
// Data: GET /api/seller/orders/orders (tab, q, placedFrom/To, sort; pages on the website, cursor on the phone),
// …/orders/counts (tab counts, shared with the sidebar), POST …/bulk-start-preparing, …/packing-slips,
// …/exports (+ GET …/exports/{id}; selected rows export by groupIds); cancellation requests: GET …/orders/{id} per listed task, then
// POST …/cancellation-requests/{requestId}/accept (Idempotency-Key) or …/decline.

type View = 'preparing' | 'shipped' | 'completed' | 'cancellation-requests';
type Tab = '' | View;
type ApiTab = 'new' | 'preparing' | 'shipped' | 'completed' | 'cancellation_requests';

const API_TAB: Record<Tab, ApiTab> = { '': 'new', preparing: 'preparing', shipped: 'shipped', completed: 'completed', 'cancellation-requests': 'cancellation_requests' };
const RANGES = ['Last 7 days', 'Today', 'Last 30 days', 'Any date', 'Custom range'] as const;
type Range = (typeof RANGES)[number];
const SORTS = [
  { value: 'dispatch_deadline', label: 'Dispatch deadline, soonest' },
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
] as const;
type Sort = (typeof SORTS)[number]['value'];
const LIMIT = 24;

function rangeDates(range: Range, from: string, to: string): { placedFrom?: string; placedTo?: string } {
  const today = dayKey();
  if (range === 'Today') return { placedFrom: today, placedTo: today };
  if (range === 'Last 7 days') return { placedFrom: addDays(today, -6) };
  if (range === 'Last 30 days') return { placedFrom: addDays(today, -29) };
  if (range === 'Custom range') return { placedFrom: from || undefined, placedTo: to || undefined };
  return {};
}

const edge = (r: OrderRow) => {
  const t = deadlineTone(r.dispatchDeadline, r.deadlineLabel);
  return t === 'danger' ? 'is-flagged' : t === 'warning' ? 'is-warn' : '';
};
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

function SkeletonRows({ rows = 3 }: { rows?: number }) {
  return (
    <div className="sk-list pad" role="status" aria-label="Loading orders">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="sk-row" aria-hidden="true">
          <span className="sk-lines">
            <span className="sk sk-line" />
            <span className="sk sk-line short" />
          </span>
        </div>
      ))}
    </div>
  );
}

function LoadError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return <SellerLoadError error={error} onRetry={onRetry} title="We couldn’t load your orders" />;
}

interface Done {
  tone: 'success' | 'info' | 'danger';
  title: string;
  body: string;
}

export default function Orders() {
  const { api } = useApi();
  const qc = useQueryClient();
  const { sellerId, can } = useSellerSession();
  const isPhone = useIsPhone();
  const [view, setView] = useView<View>();
  const tab: Tab = view;
  const [done, setDone] = useState<Done | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [q, setQ] = useState('');
  const [range, setRange] = useState<Range>('Last 7 days');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [sort, setSort] = useState<Sort>('dispatch_deadline');
  const [page, setPage] = useState(1);
  const search = useDebounced(q.trim());
  const filter = { tab: API_TAB[tab], q: search || undefined, sort, ...rangeDates(range, from, to) };

  useEffect(() => setPage(1), [search, range, from, to, sort, tab]);

  const changeTab = (t: Tab) => {
    setSelected(new Set());
    setDone(null);
    setView(t);
  };

  const counts = useQuery({ queryKey: ['orders', 'counts', sellerId], queryFn: () => call(api.GET('/api/seller/orders/orders/counts')), refetchInterval: 60_000 });
  const list = (paging: { page?: number; cursor?: string }) => call(api.GET('/api/seller/orders/orders', { params: { query: { ...filter, ...paging, limit: LIMIT } } }));
  const pageQ = useQuery({ queryKey: ['orders', 'list', sellerId, filter, page], queryFn: () => list({ page }), enabled: !isPhone, placeholderData: keepPreviousData });
  const phoneQ = useInfiniteQuery({
    queryKey: ['orders', 'list', sellerId, 'cursor', filter],
    initialPageParam: '',
    queryFn: ({ pageParam }) => list(pageParam ? { cursor: pageParam } : {}),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: isPhone,
  });
  const active = isPhone ? phoneQ : pageQ;
  const loaded = isPhone ? !!phoneQ.data : !!pageQ.data;
  const rows: OrderRow[] = isPhone ? (phoneQ.data?.pages.flatMap((p) => p.items) ?? []) : (pageQ.data?.items ?? []);
  const total = pageQ.data?.total ?? rows.length;
  const totalPages = pageQ.data?.totalPages ?? 1;
  const more = useInView<HTMLDivElement>(() => void phoneQ.fetchNextPage(), isPhone && phoneQ.hasNextPage && !phoneQ.isFetchingNextPage);

  // Cancellation requests: the tab lists the tasks; each task's detail carries its pending requests.
  const isCancelTab = tab === 'cancellation-requests';
  const details = useQueries({
    queries: (isCancelTab ? rows : []).map((r) => ({
      queryKey: ['orders', 'detail', sellerId, r.id],
      queryFn: () => call(api.GET('/api/seller/orders/orders/{id}', { params: { path: { id: r.id } } })),
    })),
  });
  const requests: Array<{ row: OrderRow; detail: OrderDetailRest; req: CancellationRequest }> = isCancelTab
    ? rows.flatMap((row, i) => {
        const d = details[i]?.data;
        return d ? d.cancellationRequests.filter((c) => c.status === 'requested' && c.initiatedBy === 'customer').map((req) => ({ row, detail: d, req })) : [];
      })
    : [];
  const detailsLoading = isCancelTab && details.some((d) => d.isPending);

  const refresh = () => qc.invalidateQueries({ queryKey: ['orders'] });
  const show = (d: Done) => {
    setDone(d);
    announce(d.body || d.title);
  };

  const sel = rows.filter((r) => selected.has(r.id));
  const allOn = rows.length > 0 && sel.length === rows.length;
  const someOn = sel.length > 0 && !allOn;
  const overdue = tab === 'preparing' ? rows.filter((r) => deadlineTone(r.dispatchDeadline, r.deadlineLabel) === 'danger') : [];
  const newRows = tab === '' ? rows.filter((r) => r.status === 'new') : [];

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const toggleAll = () => setSelected(allOn ? new Set() : new Set(rows.map((r) => r.id)));

  const prepare = useMutation({
    mutationFn: (ids: string[]) => call(api.POST('/api/seller/orders/orders/bulk-start-preparing', { body: { orderIds: ids } })),
    onSuccess: (res) => {
      setSelected(new Set());
      const failed = res.failed.length ? ` ${plural(res.failed.length, 'order')} could not be updated: ${res.failed.map((f) => f.message).join(' ')}` : '';
      show({
        tone: res.updated ? 'success' : 'danger',
        title: res.updated ? 'Marked as preparing' : 'Nothing was updated',
        body: `${res.updated ? `${plural(res.updated, 'order')} marked as preparing. Buyers are told their order is being packed.` : ''}${failed}`.trim(),
      });
    },
    onError: (e) => show({ tone: 'danger', title: 'Could not mark as preparing', body: errorMessage(e) }),
    onSettled: refresh,
  });
  const markPreparing = (ids: string[]) => ids.length && prepare.mutate(ids);

  const slips = useMutation({
    mutationFn: async (ids?: string[]) => {
      let orderIds = ids;
      if (!orderIds) {
        const open = await call(api.GET('/api/seller/orders/orders', { params: { query: { tabs: 'new,preparing', limit: 100 } } }));
        orderIds = open.items.filter((r) => r.fulfilledBy === 'seller').map((r) => r.id);
      }
      if (!orderIds.length) throw new Error('none');
      return { n: orderIds.length, doc: await call(api.POST('/api/seller/orders/packing-slips', { body: { orderIds } })) };
    },
    onSuccess: ({ n, doc }) => {
      openDownload(doc.url, doc.fileName);
      announce(`${plural(n, 'packing slip')} ready to print`);
    },
    onError: (e) =>
      e instanceof Error && e.message === 'none'
        ? show({ tone: 'info', title: 'No packing slips to print', body: 'There are no new or preparing orders.' })
        : show({ tone: 'danger', title: 'Could not create packing slips', body: errorMessage(e) }),
  });

  // The whole list (current filters) or the selected rows (filters.groupIds, up to 500) as a server export.
  const exportAll = useMutation({
    mutationFn: async (groupIds?: string[]) => {
      const first = await call(api.POST('/api/seller/orders/exports', { body: { filters: groupIds ? { groupIds } : filter, format: 'csv' } }));
      show({ tone: 'info', title: `Preparing export ${first.ref}`, body: 'Your file downloads when it is ready. You can keep working.' });
      return waitForExport(() => call(api.GET('/api/seller/orders/exports/{id}', { params: { path: { id: first.id } } })), first);
    },
    onSuccess: (job) => {
      if (job.state === 'ready' && job.downloadUrl) {
        openDownload(job.downloadUrl, job.fileName);
        show({ tone: 'success', title: `Export ${job.ref} is ready`, body: `${plural(job.rowCount ?? 0, 'order')} exported.` });
      } else show({ tone: job.state === 'failed' ? 'danger' : 'info', title: job.state === 'failed' ? 'Export failed' : `Export ${job.ref} is still running`, body: job.state === 'failed' ? 'Try again in a moment.' : 'Try the export again in a few minutes.' });
    },
    onError: (e) => show({ tone: 'danger', title: 'Could not export orders', body: errorMessage(e) }),
  });

  const keys = useRef<Record<string, string>>({});
  const respond = useMutation({
    mutationFn: async ({ row, req, accept }: { row: OrderRow; req: CancellationRequest; accept: boolean }) => {
      const path = { id: row.id, requestId: req.id };
      if (accept) {
        const key = (keys.current[req.id] ??= newIdempotencyKey());
        return call(api.POST('/api/seller/orders/orders/{id}/cancellation-requests/{requestId}/accept', { params: { path, header: { 'Idempotency-Key': key } } }));
      }
      return call(api.POST('/api/seller/orders/orders/{id}/cancellation-requests/{requestId}/decline', { params: { path }, body: { reason: 'already_shipped' } }));
    },
    onSuccess: (res, { row, req, accept }) => {
      delete keys.current[req.id];
      const items = req.items.map((i) => `${i.title}${i.variantLabel ? `, ${i.variantLabel}` : ''} × ${i.quantity}`).join(', ');
      show(
        accept
          ? { tone: 'success', title: 'Item cancelled and refunded', body: `${items} was cancelled on ${row.ref}. ${row.buyerName} is refunded ${formatMoney(res.refundPreview.total)}. This doesn't count against your cancellation rate.` }
          : { tone: 'info', title: 'Cancellation declined', body: `${row.buyerName} was told the item has shipped and can return it after delivery.` },
      );
    },
    onError: (e, { accept }) => show({ tone: 'danger', title: accept ? 'Could not cancel the item' : 'Could not decline the request', body: errorMessage(e) }),
    onSettled: refresh,
  });

  const c = counts.data;
  const tones = rows.map((r) => deadlineTone(r.dispatchDeadline, r.deadlineLabel));
  const hasDanger = tones.includes('danger');
  const hasWarn = tones.includes('warning');
  const pinAction = tab === 'shipped';
  const filtering = !!search || range === 'Today' || range === 'Custom range';
  const canManage = can('orders.fulfillment.manage');
  const canCancel = can('orders.fulfillment.cancel');

  return (
    <SellerLayout active="orders">
      <div className="page-head">
        <div className="t">
          <h1 className="h1">Orders</h1>
          <p className="sub small">Only your items are shown. Dispatch deadlines are in Pacific Time.</p>
        </div>
        <div className="actions">
          <Button variant="secondary" size="sm" icon="printer" onClick={() => slips.mutate(undefined)} disabled={slips.isPending}>
            Packing slips
          </Button>
          {can('orders.fulfillment.export') && (
            <Button variant="secondary" size="sm" icon="download" onClick={() => exportAll.mutate(undefined)} disabled={exportAll.isPending}>
              Export
            </Button>
          )}
        </div>
      </div>
      <Tabs<Tab>
        items={[
          { value: '', label: 'New', count: c?.new },
          { value: 'preparing', label: 'Preparing', count: c?.preparing },
          { value: 'shipped', label: 'Shipped', count: c?.shipped },
          { value: 'completed', label: 'Completed', count: c?.completed },
          { value: 'cancellation-requests', label: 'Cancellation requests', count: c?.cancellationRequests },
        ]}
        active={tab}
        onChange={changeTab}
      />
      <div className="toolbar">
        <SearchInput id="so-q" placeholder="Order number, buyer or SKU" value={q} onChange={setQ} />
        <label className="sr-only" htmlFor="so-date">
          Date placed
        </label>
        <select className="select" id="so-date" value={range} onChange={(e) => setRange(e.target.value as Range)}>
          {RANGES.map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
        {range === 'Custom range' && (
          <>
            <label className="sr-only" htmlFor="so-from">
              Placed from
            </label>
            <input className="input" type="date" id="so-from" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
            <label className="sr-only" htmlFor="so-to">
              Placed to
            </label>
            <input className="input" type="date" id="so-to" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
          </>
        )}
        <label className="sr-only" htmlFor="so-sort">
          Sort
        </label>
        <select className="select" id="so-sort" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
          {SORTS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      {done && (
        <Alert tone={done.tone} title={done.title}>
          {done.body}
        </Alert>
      )}
      {tab === '' && newRows.length > 0 && (
        <div className="row gap-2">
          <span className="small sub grow">
            {plural(newRows.length, 'new order')} waiting. Mark them as preparing to tell buyers their order is being packed.
          </span>
          <Button variant="secondary" size="sm" icon="printer" onClick={() => slips.mutate(newRows.map((r) => r.id))} disabled={slips.isPending}>
            Print {plural(newRows.length, 'packing slip')}
          </Button>
          {canManage && (
            <Button variant="secondary" size="sm" icon="package" onClick={() => markPreparing(newRows.map((r) => r.id))} disabled={prepare.isPending}>
              Mark all as preparing
            </Button>
          )}
        </div>
      )}
      {overdue.length > 0 && (
        <Alert tone="danger" title={`${overdue.length} order${overdue.length > 1 ? 's are' : ' is'} past ${overdue.length > 1 ? 'their' : 'its'} dispatch deadline`}>
          {overdue.map((r) => `${r.ref} (${r.deadlineLabel.toLowerCase()})`).join(', ')}. Ship today and record tracking, or cancel the item if you can't fulfill it. The buyer has been told it is running late and can contact support.
        </Alert>
      )}
      {active.isError && !loaded ? (
        <LoadError error={active.error} onRetry={() => void active.refetch()} />
      ) : isCancelTab ? (
        <>
          <Alert tone="info" title="Respond before you ship">
            If you accept, the buyer is refunded for the cancelled items and the request does not count against your cancellation rate. If the item has already shipped, decline and the buyer can return it instead.
          </Alert>
          {!loaded || detailsLoading ? (
            <section className="card">
              <SkeletonRows rows={2} />
            </section>
          ) : requests.length === 0 ? (
            <section className="card">
              <div className="card-body">
                <EmptyState icon="circle-check" title="No cancellation requests">
                  When a buyer asks to cancel before you ship, the request shows here.
                </EmptyState>
              </div>
            </section>
          ) : (
            requests.map(({ row, detail, req }) => {
              const first = req.items[0];
              const img = detail.items.find((i) => i.itemId === first?.itemId)?.image;
              const shipped = req.items.some((i) => i.shipped);
              const busy = respond.isPending && respond.variables?.req.id === req.id;
              return (
                <section className="card" key={req.id}>
                  <div className="card-body stack gap-3">
                    <div className="row between">
                      <div className="stack gap-0">
                        <Link className="mono strong" to={orderLink(row.ref)}>
                          {row.ref}
                        </Link>
                        <span className="xs muted">
                          Placed {ptDateTime(row.placedAt)} · {row.buyerName}
                        </span>
                      </div>
                      <StatusBadge status="Cancellation requested" />
                    </div>
                    <div className="row gap-3 nowrap">
                      <Img icon="package" src={img?.url} alt={img?.alt ?? ''} className="tiny" />
                      <span className="grow stack gap-0">
                        <span className="small strong">{req.items.map((i) => `${i.title}${i.variantLabel ? `, ${i.variantLabel}` : ''} × ${i.quantity}`).join(' + ')}</span>
                        <span className="xs muted">
                          {formatMoney(req.refundPreview.total)} · {shipped ? 'shipped' : 'not shipped'}
                        </span>
                      </span>
                    </div>
                    <div className="panel small">
                      <b>Buyer's reason:</b> {BUYER_CANCEL_REASON[req.reasonCode] ?? req.reasonCode}
                      {req.reason ? ` "${req.reason}"` : ''}
                    </div>
                    <div className="row between">
                      {req.respondBy ? <Deadline tone={deadlineTone(req.respondBy) === 'ok' ? 'warning' : deadlineTone(req.respondBy)}>Respond by {dueText(req.respondBy.dueAt)}</Deadline> : <span />}
                      {canCancel && (
                        <div className="row gap-2">
                          <Button variant="secondary" size="sm" onClick={() => respond.mutate({ row, req, accept: false })} disabled={busy}>
                            Decline, already shipped
                          </Button>
                          <Button size="sm" onClick={() => respond.mutate({ row, req, accept: true })} disabled={busy}>
                            Cancel item and refund
                          </Button>
                        </div>
                      )}
                    </div>
                  </div>
                </section>
              );
            })
          )}
        </>
      ) : (
        <>
          {sel.length > 0 && (
            <div className="bulk-bar" role="region" aria-label="Bulk actions">
              <span>{sel.length} selected</span>
              <span className="grow" />
              {tab === '' && canManage && (
                <Button variant="ghost" size="sm" icon="package" onClick={() => markPreparing(sel.map((r) => r.id))} disabled={prepare.isPending}>
                  Mark as preparing
                </Button>
              )}
              {(tab === '' || tab === 'preparing') && (
                <Button variant="ghost" size="sm" icon="printer" onClick={() => slips.mutate(sel.map((r) => r.id))} disabled={slips.isPending}>
                  Print packing slips
                </Button>
              )}
              {can('orders.fulfillment.export') && (
                <Button variant="ghost" size="sm" icon="download" onClick={() => exportAll.mutate(sel.slice(0, 500).map((r) => r.id))} disabled={exportAll.isPending}>
                  Export
                </Button>
              )}
              <Button variant="ghost" size="sm" icon="x" onClick={() => setSelected(new Set())}>
                Clear
              </Button>
            </div>
          )}
          <section className="card no-phone">
            <TableWrap label="Orders table">
              <table className="table">
                <thead>
                  <tr>
                    <th className="col-check">
                      <input
                        type="checkbox"
                        aria-label="Select all"
                        checked={allOn}
                        ref={(el) => {
                          if (el) el.indeterminate = someOn;
                        }}
                        onChange={toggleAll}
                      />
                    </th>
                    <th scope="col">Order</th>
                    <th scope="col">Placed</th>
                    <th scope="col">Buyer</th>
                    <th scope="col">Items</th>
                    <th className="r" scope="col">
                      Total
                    </th>
                    <th scope="col">Status</th>
                    <th scope="col">Dispatch deadline</th>
                    <th className={cx(pinAction && 'col-pin')} scope="col">
                      Next action
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const a = nextAction(r);
                    const e = edge(r);
                    return (
                      <tr key={r.id} className={e}>
                        <td className="col-check">
                          {e && <span className="sr-only">{e === 'is-flagged' ? 'Urgent: ' : 'At risk: '}</span>}
                          <input type="checkbox" aria-label={`Select ${r.ref}`} checked={selected.has(r.id)} onChange={() => toggle(r.id)} />
                        </td>
                        <td>
                          <Link className="mono small strong nowrap" to={orderLink(r.ref)} title={r.ref}>
                            {r.ref}
                          </Link>
                        </td>
                        <td>
                          <span className="small nowrap">{ptDateTime(r.placedAt)}</span>
                        </td>
                        <td>{r.buyerName}</td>
                        <td>
                          <span className="small">{r.itemsSummary}</span>
                          {r.note && <div className="xs t-info-text strong">{r.note}</div>}
                        </td>
                        <td className="r">
                          <span className="num">{formatMoney(r.total)}</span>
                        </td>
                        <td>
                          <StatusBadge status={r.statusLabel} />
                        </td>
                        <td>
                          <Deadline tone={deadlineTone(r.dispatchDeadline, r.deadlineLabel)}>{r.deadlineLabel}</Deadline>
                        </td>
                        <td className={cx(pinAction && 'col-pin')}>
                          <Link className={cx('btn btn-sm', a.primary ? 'btn-primary' : 'btn-secondary')} to={a.to}>
                            <span>{a.label}</span>
                            <span className="sr-only"> {r.ref}</span>
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableWrap>
            {!loaded && <SkeletonRows />}
            {loaded && rows.length === 0 && (
              <EmptyState icon="inbox" title="No orders here">
                {filtering ? 'Try another search or date range.' : 'Orders move to the next tab as you prepare and ship them.'}
              </EmptyState>
            )}
            {(hasDanger || hasWarn) && (
              <StatusLegend
                items={[
                  ...(hasDanger ? [{ tone: 'danger' as const, label: 'Red edge = urgent: overdue or past target' }] : []),
                  ...(hasWarn ? [{ tone: 'warning' as const, label: 'Amber edge = at risk: due soon or near target' }] : []),
                ]}
              />
            )}
            <div className="card-foot between">
              <span className="xs muted">{loaded ? (total ? `Showing ${(page - 1) * LIMIT + 1}–${(page - 1) * LIMIT + rows.length} of ${total}` : 'Showing 0 of 0') : ''}</span>
              {totalPages > 1 && <Pager page={page} total={totalPages} onPage={setPage} only="website" />}
            </div>
          </section>
          <ul className="card sa-ocards only-phone">
            {rows.map((r) => {
              const a = nextAction(r);
              return (
                <li key={r.id}>
                  <div className="row between">
                    <Link className="mono small strong" to={orderLink(r.ref)}>
                      {r.ref}
                    </Link>
                    <StatusBadge status={r.statusLabel} />
                  </div>
                  <span className="small">{r.itemsSummary}</span>
                  <div className="row between xs muted">
                    <span>
                      {r.buyerName} · {ptDateTime(r.placedAt)}
                    </span>
                    <b className="num u-c-text">{formatMoney(r.total)}</b>
                  </div>
                  <div className="row between">
                    <Deadline tone={deadlineTone(r.dispatchDeadline, r.deadlineLabel)}>{r.deadlineLabel}</Deadline>
                    <Link className={cx('btn btn-sm', a.primary ? 'btn-primary' : 'btn-secondary')} to={a.to}>
                      <span>{a.label}</span>
                    </Link>
                  </div>
                </li>
              );
            })}
            {isPhone && !loaded && (
              <li>
                <SkeletonRows rows={2} />
              </li>
            )}
            {isPhone && loaded && rows.length === 0 && (
              <li>
                <EmptyState icon="inbox" title="No orders here">
                  {filtering ? 'Try another search or date range.' : 'Orders move to the next tab as you prepare and ship them.'}
                </EmptyState>
              </li>
            )}
          </ul>
          <div ref={more} className="only-phone">
            <LazyLoad end={!phoneQ.hasNextPage} />
          </div>
        </>
      )}
    </SellerLayout>
  );
}
