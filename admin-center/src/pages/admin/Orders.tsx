import { useState } from 'react';
import { keepPreviousData, useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { call, errorMessage, useApi } from '@marketly/web-shared/api';
import { AdminLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { formatMoney, initials, num, tileTint } from '@marketly/web-shared/lib/format';
import { useView } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import { Alert, Badge, Button, Chip, Deadline, EmptyState, Field, Icon, LogoTile, PageHeader, Pager, SearchInput, Select, StatusBadge, TableWrap, announce } from '@marketly/web-shared/ui';
import { useStaffSession } from '@/app/session';
import { LoadError, SkeletonLines, dateTime } from '@/app/parts';
import {
  CHIP_PREFIX, FILTER_LABELS, FILTER_OPTIONS, NO_FILTERS, OVERDUE_FILTERS, PAYMENT_LABEL, QUICK_FILTERS, flagStyle, optLabel, orderQuery, rowEdge, rowFlags, rowSellers,
  type AdminOrderRow, type Edge, type OrderFilters, type OrderFlag,
} from './data/orders';

// Design: pages/admin/admin-orders.html · view "overdue-dispatch" = the saved filter with the
// late-by/owner columns, the bulk bar and the applied-filter chips.
// Data: GET orders/orders (filters, q, page), GET orders/saved-filters (+ POST to save), GET sellers/sellers (seller filter),
// rows' openExceptionIds (open delivery exceptions behind the overdue rows), POST shipping/exceptions/{id}/notify-seller
// (Remind), POST shipping/exceptions/bulk (bulk remind, assign, escalate), POST orders/exports (Export CSV).

type View = 'overdue-dispatch';

const LIMIT = 25;
const FILTER_KEYS: Array<keyof OrderFilters> = ['type', 'seller', 'status', 'payment', 'date', 'flag'];
/** Applied-chip order (design: Status, Flag, then the date range). */
const CHIP_KEYS: Array<keyof OrderFilters> = ['type', 'seller', 'status', 'payment', 'flag', 'date'];
const sameFilters = (a: OrderFilters, b: OrderFilters) => FILTER_KEYS.every((k) => a[k] === b[k]);

const EDGE_SR: Record<Exclude<Edge, ''>, string> = { flagged: 'Urgent: ', warn: 'At risk: ' };
const edgeClass = (e: Edge) => (e === 'flagged' ? 'is-flagged' : e === 'warn' ? 'is-warn' : '');
const EdgeSr = ({ edge }: { edge: Edge }) => (edge ? <span className="sr-only">{EDGE_SR[edge]}</span> : null);

function Flags({ flags }: { flags: OrderFlag[] }) {
  return (
    <span className="aa-flags">
      {flags.map((f) => {
        const st = flagStyle(f);
        return (
          <Badge key={f.kind} tone={st.tone} icon={st.icon}>
            {f.label}
          </Badge>
        );
      })}
    </span>
  );
}

/** Colour-edge legend with the design's "Legend:" prefix for screen readers. */
function EdgeLegend({ edges }: { edges: Edge[] }) {
  const has = (e: Edge) => edges.includes(e);
  if (!has('flagged') && !has('warn')) return null;
  return (
    <p className="status-legend status-legend--edge">
      <span className="sr-only">Legend: </span>
      {has('flagged') && (
        <span className="sl sl-danger">
          <i aria-hidden="true" />
          Red edge = urgent: overdue or past target
        </span>
      )}
      {has('warn') && (
        <span className="sl sl-warning">
          <i aria-hidden="true" />
          Amber edge = at risk: due soon or near target
        </span>
      )}
    </p>
  );
}

export default function Orders() {
  const { api } = useApi();
  const qc = useQueryClient();
  const { accountId, can } = useStaffSession();
  const [view, setView] = useView<View>();
  const overdue = view === 'overdue-dispatch';
  const [filters, setFilters] = useState<OrderFilters>(overdue ? OVERDUE_FILTERS : NO_FILTERS);
  const [syncedView, setSyncedView] = useState(view);
  const [query, setQuery] = useState('');
  const [showFilters, setShowFilters] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [reminded, setReminded] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [page, setPage] = useState(1);

  // Entering the saved-filter view (chip, link, back button) applies its filters; leaving it drops them.
  if (syncedView !== view) {
    setSyncedView(view);
    setPage(1);
    setSelected(new Set());
    if (overdue) setFilters(OVERDUE_FILTERS);
    else if (syncedView === 'overdue-dispatch' && sameFilters(filters, OVERDUE_FILTERS)) setFilters(NO_FILTERS);
  }

  const listQuery = orderQuery(filters, query);
  const list = useQuery({
    queryKey: ['orders', 'admin-list', listQuery, page],
    queryFn: () => call(api.GET('/api/admin/orders/orders', { params: { query: { ...listQuery, page, limit: LIMIT } } })),
    placeholderData: keepPreviousData,
  });
  const sellersQ = useQuery({
    queryKey: ['sellers', 'admin-list', 'filter'],
    queryFn: () => call(api.GET('/api/admin/sellers/sellers', { params: { query: { limit: 100, status: 'approved' } } })),
    enabled: can('sellers.accounts.view'),
    staleTime: 5 * 60_000,
  });
  const saved = useQuery({ queryKey: ['orders', 'saved-filters'], queryFn: () => call(api.GET('/api/admin/orders/saved-filters')) });
  const quickCounts = useQueries({
    queries: QUICK_FILTERS.map((s) => {
      const q = orderQuery({ ...NO_FILTERS, ...s.filters }, '');
      return { queryKey: ['orders', 'admin-list', q, 'count'], queryFn: () => call(api.GET('/api/admin/orders/orders', { params: { query: { ...q, page: 1, limit: 1 } } })), staleTime: 60_000 };
    }),
  });
  const canManageExceptions = can('shipping.exceptions.manage');

  const rows: AdminOrderRow[] = list.data?.items ?? [];
  const total = list.data?.total ?? rows.length;
  const totalPages = list.data?.totalPages ?? 1;
  const allOn = rows.length > 0 && rows.every((o) => selected.has(o.ref));
  const picked = rows.filter((o) => selected.has(o.ref));
  const applied = CHIP_KEYS.filter((k) => filters[k] !== NO_FILTERS[k]);
  const title = overdue ? 'Orders · Overdue dispatch' : 'All orders';
  const sellerOpts = [{ value: '', label: 'Any seller' }, ...(sellersQ.data?.items ?? []).map((s) => ({ value: s.id, label: s.storeName }))];
  const filterOpts = (k: keyof OrderFilters) => (k === 'seller' ? sellerOpts : FILTER_OPTIONS[k]);
  const chipValue = (k: keyof OrderFilters) => optLabel(filterOpts(k), filters[k]);
  /** Open delivery exceptions on the rows (oldest due first). */
  const excIds = (refs: AdminOrderRow[]) => refs.flatMap((o) => o.openExceptionIds ?? []);

  /** Any manual filter change leaves the saved filter. */
  const changeFilters = (next: OrderFilters) => {
    setFilters(next);
    setPage(1);
    setSelected(new Set());
    if (overdue && !sameFilters(next, OVERDUE_FILTERS)) setView('');
  };
  const clearAll = () => {
    setFilters(NO_FILTERS);
    setQuery('');
    setPage(1);
  };
  const toggle = (ref: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(ref)) n.delete(ref);
      else n.add(ref);
      return n;
    });
  const toggleAll = () => setSelected(allOn ? new Set() : new Set(rows.map((o) => o.ref)));
  const say = (msg: string) => {
    setNotice(msg);
    setError('');
    announce(msg);
  };
  const plural = (n: number) => `${n} order${n === 1 ? '' : 's'}`;

  const bulk = useMutation({
    mutationFn: async (a: { action: 'notify_seller' | 'assign' | 'escalate'; orders: AdminOrderRow[]; msg: string }) => {
      const ids = excIds(a.orders);
      if (!ids.length) throw new Error('none');
      if (a.action === 'notify_seller' && a.orders.length === 1) {
        // One order: remind about its oldest open exception.
        await call(api.POST('/api/admin/shipping/exceptions/{id}/notify-seller', { params: { path: { id: ids[0]! } }, body: {} }));
        return { ...a, r: { failed: [] as unknown[] } };
      }
      const body =
        a.action === 'assign'
          ? { ids, action: a.action, ownerStaffId: accountId }
          : a.action === 'escalate'
            ? { ids, action: a.action, to: 'seller_manager' as const, reason: 'Seller missed the dispatch deadline' }
            : { ids, action: a.action };
      const r = await call(api.POST('/api/admin/shipping/exceptions/bulk', { body }));
      return { ...a, r };
    },
    onSuccess: ({ action, orders, msg, r }) => {
      if (action === 'notify_seller') setReminded((s) => new Set([...s, ...orders.map((o) => o.ref)]));
      say(r.failed.length ? `${msg} ${r.failed.length} could not be updated.` : msg);
      setSelected(new Set());
      void qc.invalidateQueries({ queryKey: ['orders', 'admin-list'] });
      void qc.invalidateQueries({ queryKey: ['shipping', 'exceptions'] });
      void qc.invalidateQueries({ queryKey: ['workqueues'] });
    },
    onError: (e) => setError(e instanceof Error && e.message === 'none' ? 'These orders have no open dispatch exception to act on.' : errorMessage(e)),
  });

  const exportCsv = useMutation({
    mutationFn: () => call(api.POST('/api/admin/orders/exports', { body: { filters: listQuery, format: 'csv' } })),
    onSuccess: () => announce('Export started. It is logged in Action history.'),
    onError: (e) => setError(errorMessage(e)),
  });
  const saveFilter = useMutation({
    mutationFn: () => {
      const name = applied.map((k) => `${CHIP_PREFIX[k]}${chipValue(k)}`).join(', ') || 'Last 7 days';
      return call(api.POST('/api/admin/orders/saved-filters', { body: { name: query.trim() ? `${name} · “${query.trim()}”` : name, query: { filters, q: query.trim() } } }));
    },
    onSuccess: () => {
      announce('Current filters saved');
      void qc.invalidateQueries({ queryKey: ['orders', 'saved-filters'] });
    },
    onError: (e) => setError(errorMessage(e)),
  });

  const remindOne = (o: AdminOrderRow) => bulk.mutate({ action: 'notify_seller', orders: [o], msg: `Reminder sent to the seller of ${o.ref}.` });
  const ownerOf = (o: AdminOrderRow) => o.owner ?? 'Seller';
  const overdueCount = quickCounts[0]?.data?.total;

  return (
    <AdminLayout active="orders">
      <PageHeader
        crumbs={[{ label: 'Commerce' }, { label: 'Orders', to: href('admin/orders') }]}
        title={title}
        sub={
          overdue
            ? 'Saved filter · items past their dispatch deadline · sellers and customers already notified'
            : `Company and marketplace seller orders${list.data && sameFilters(filters, NO_FILTERS) && !query.trim() ? ` · ${num(total)} in the last 7 days` : ''} · times in PT`
        }
        actions={
          <>
            {can('orders.orders.export') && (
              <span className="aa-tip" tabIndex={0}>
                <Button variant="secondary" size="sm" icon="download" disabled={exportCsv.isPending} onClick={() => exportCsv.mutate()}>
                  Export CSV
                </Button>
                <span className="aa-tipbox" role="tooltip">
                  Exports are logged in Action history with your name. Customer phone numbers are masked unless your role allows them.
                </span>
              </span>
            )}
            <Button variant="secondary" size="sm" icon="truck" to={href('ops/dispatch')}>
              Open dispatch queue
            </Button>
          </>
        }
      />
      <div className="stack gap-2">
        <span className="xs strong muted">Saved filters</span>
        <div className="hscroll gap-2">
          {QUICK_FILTERS.map((s, i) => {
            const n = quickCounts[i]?.data?.total;
            const label = n === undefined ? s.label : `${s.label} · ${n}`;
            return s.view ? (
              <Chip key={s.label} icon={s.icon} active={overdue} to={href('admin/orders', s.view)}>
                {label}
              </Chip>
            ) : (
              <Chip key={s.label} icon={s.icon} active={!overdue && sameFilters(filters, { ...NO_FILTERS, ...s.filters })} onClick={() => changeFilters({ ...NO_FILTERS, ...s.filters })}>
                {label}
              </Chip>
            );
          })}
          {(saved.data ?? []).map((s) => {
            const sq = (s.query ?? {}) as { filters?: Partial<OrderFilters>; q?: string };
            const next = { ...NO_FILTERS, ...(sq.filters ?? {}) };
            return (
              <Chip key={s.id} icon="bookmark" active={!overdue && sameFilters(filters, next) && query.trim() === (sq.q ?? '')} onClick={() => (changeFilters(next), setQuery(sq.q ?? ''))}>
                {s.name} · {s.count ?? 0}
              </Chip>
            );
          })}
          <Chip icon="bookmark-plus" onClick={() => saveFilter.mutate()}>
            Save current filters
          </Chip>
        </div>
      </div>
      {overdue && overdueCount !== undefined && overdueCount > 0 && (
        <Alert tone="danger" title={`${plural(overdueCount)} ${overdueCount === 1 ? 'has' : 'have'} items past their dispatch deadline`}>
          Overdue tasks were created automatically. Each seller got a reminder and each customer got an update with a way to contact support. Escalate to the Seller Manager when a seller misses a second deadline.
        </Alert>
      )}
      {notice && <Alert tone="success" title={notice} />}
      {error && (
        <Alert tone="danger" title="That didn’t work">
          {error}
        </Alert>
      )}
      <section className="card">
        <div className="card-body">
          <div className="toolbar">
            <SearchInput id="aa-o-q" placeholder="Search by order ref, customer, email or tracking number" value={query} onChange={(v) => (setQuery(v), setPage(1))} />
            <Button variant="ghost" size="sm" icon="sliders-horizontal" aria-expanded={showFilters} aria-controls="aa-o-filters" onClick={() => setShowFilters((s) => !s)}>
              More filters
            </Button>
          </div>
          <div className="aa-filters" id="aa-o-filters" hidden={!showFilters}>
            {FILTER_KEYS.filter((k) => k !== 'seller' || sellersQ.data).map((k) => (
              <Field key={k} label={FILTER_LABELS[k]} className="aa-flt">
                <Select id={`aa-o-${k === 'payment' ? 'pay' : k}`} options={filterOpts(k)} value={filters[k]} onChange={(e) => changeFilters({ ...filters, [k]: e.target.value })} />
              </Field>
            ))}
          </div>
          {applied.length > 0 && (
            <div className="row gap-2">
              <div className="hscroll gap-2">
                {applied.map((k) => (
                  <Chip key={k} removable onClick={() => changeFilters({ ...filters, [k]: NO_FILTERS[k] })}>
                    {CHIP_PREFIX[k]}
                    {chipValue(k)}
                  </Chip>
                ))}
              </div>
              <Link className="small strong" to={href('admin/orders')} onClick={clearAll}>
                Clear all
              </Link>
            </div>
          )}
        </div>
        {overdue && picked.length > 0 && canManageExceptions && (
          <div className="u-p-0-sp-4-sp-3">
            <div className="bulk-bar">
              <span>{picked.length} selected</span>
              <span className="grow" />
              <Button variant="ghost" icon="bell" disabled={bulk.isPending} onClick={() => bulk.mutate({ action: 'notify_seller', orders: picked, msg: `Reminders sent to the sellers of ${plural(picked.length)}.` })}>
                Remind sellers
              </Button>
              <Button variant="ghost" icon="user-plus" disabled={bulk.isPending} onClick={() => bulk.mutate({ action: 'assign', orders: picked, msg: `${plural(picked.length)} assigned to you.` })}>
                Assign owner
              </Button>
              <Button variant="ghost" icon="arrow-up-right" disabled={bulk.isPending} onClick={() => bulk.mutate({ action: 'escalate', orders: picked, msg: `${plural(picked.length)} escalated to the Seller Manager.` })}>
                Escalate to Seller Manager
              </Button>
            </div>
          </div>
        )}
        {list.isError ? (
          <div className="card-body">
            <LoadError error={list.error} onRetry={() => void list.refetch()} />
          </div>
        ) : list.isPending ? (
          <SkeletonLines rows={8} />
        ) : rows.length === 0 ? (
          <div className="card-body">
            {overdue ? (
              <EmptyState icon="package-check" title="No overdue dispatch">
                Every order is within its dispatch deadline.
              </EmptyState>
            ) : (
              <EmptyState icon="search-x" title="No orders match these filters" action={<Button variant="secondary" size="sm" onClick={clearAll}>Clear all filters</Button>}>
                Try removing a filter, or search by order ref, customer or tracking number.
              </EmptyState>
            )}
          </div>
        ) : (
          <>
            <div className="no-phone">
              <TableWrap label={`${title} table`}>
                <table className="table">
                  <thead>
                    <tr>
                      {overdue && canManageExceptions && (
                        <th className="col-check">
                          <input type="checkbox" aria-label="Select all" checked={allOn} onChange={toggleAll} />
                        </th>
                      )}
                      <th scope="col">Order</th>
                      <th scope="col">Placed</th>
                      <th scope="col">Customer</th>
                      <th scope="col">Sellers</th>
                      {!overdue && <th className="r" scope="col">Items</th>}
                      <th className="r" scope="col">Total</th>
                      {!overdue && <th scope="col">Payment</th>}
                      <th scope="col">Fulfilment</th>
                      {overdue ? (
                        <>
                          <th scope="col">Late by</th>
                          <th scope="col">Owner</th>
                          <th className="col-pin" scope="col">
                            <span className="sr-only">Actions</span>
                          </th>
                        </>
                      ) : (
                        <th className="col-pin" scope="col">Flags</th>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((o) => {
                      const ss = rowSellers(o);
                      const names = ss.map((s) => s.name).join(', ');
                      const n = ss.length;
                      const edge = rowEdge(o);
                      const flags = rowFlags(o);
                      const hasExc = (o.openExceptionIds ?? []).length > 0;
                      return (
                        <tr key={o.ref} className={edgeClass(edge)}>
                          {overdue && canManageExceptions && (
                            <td className="col-check">
                              <EdgeSr edge={edge} />
                              <input type="checkbox" aria-label={`Select ${o.ref}`} checked={selected.has(o.ref)} onChange={() => toggle(o.ref)} />
                            </td>
                          )}
                          <td className="cell-id">
                            {!(overdue && canManageExceptions) && <EdgeSr edge={edge} />}
                            <Link className="mono strong nowrap" to={href('admin/order', '', { ref: o.ref })} title={o.ref}>
                              {o.ref}
                            </Link>
                          </td>
                          <td>
                            <span className="small nowrap">{dateTime(o.placedAt)}</span>
                          </td>
                          <td className="cell-name">
                            <span className="stack gap-0">
                              <span className="small strong nowrap ellip" title={o.customerName}>
                                {o.customerName}
                                {o.guest ? ' (guest)' : ''}
                              </span>
                              <span className="xs muted ellip" title={o.customerCity}>
                                {o.customerCity}
                              </span>
                            </span>
                          </td>
                          <td className="cell-name">
                            <span className="stack gap-0">
                              <span className="small strong ellip" title={`${n} seller${n > 1 ? 's' : ''}`}>
                                {n} seller{n > 1 ? 's' : ''}
                              </span>
                              <span className="xs muted ellip" title={names}>
                                {names}
                              </span>
                            </span>
                          </td>
                          {!overdue && <td className="r">{o.itemCount}</td>}
                          <td className="r">
                            <span className="strong">{formatMoney(o.total)}</span>
                          </td>
                          {!overdue && (
                            <td>
                              <StatusBadge status={PAYMENT_LABEL[o.paymentState]} />
                            </td>
                          )}
                          <td>
                            <span className="stack gap-1">
                              <StatusBadge status={o.fulfillmentStatus} />
                              <span className="xs muted">{o.fulfillmentNote}</span>
                            </span>
                          </td>
                          {overdue ? (
                            <>
                              <td>{o.lateBy && <Deadline tone="danger">{o.lateBy}</Deadline>}</td>
                              <td className="cell-name">
                                <span className="small nowrap ellip" title={ownerOf(o)}>
                                  {ownerOf(o)}
                                </span>
                              </td>
                              <td className="col-pin">
                                {!canManageExceptions || !hasExc ? null : reminded.has(o.ref) ? (
                                  <Button variant="ghost" size="sm" icon="check" disabled>
                                    Reminded
                                  </Button>
                                ) : (
                                  <button type="button" className="btn btn-ghost btn-sm" disabled={bulk.isPending} onClick={() => remindOne(o)}>
                                    <Icon name="bell" />
                                    <span>Remind seller</span>
                                    <span className="sr-only"> {o.ref}</span>
                                  </button>
                                )}
                              </td>
                            </>
                          ) : (
                            <td className="col-pin">{flags.length ? <Flags flags={flags} /> : <span className="sr-only">None</span>}</td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </TableWrap>
              <EdgeLegend edges={rows.map(rowEdge)} />
            </div>
            <div className="only-phone card-pad-phone">
              <div className="aa-mlist">
                {rows.map((o) => {
                  const edge = rowEdge(o);
                  const flags = rowFlags(o);
                  return (
                    <Link key={o.ref} className={cx('aa-mcard', edgeClass(edge))} to={href('admin/order', '', { ref: o.ref })}>
                      <EdgeSr edge={edge} />
                      <span className="row between">
                        <span className="mono strong">{o.ref}</span>
                        <span className="strong num">{formatMoney(o.total)}</span>
                      </span>
                      <span className="xs muted">
                        {dateTime(o.placedAt)} · {o.customerName} · {o.itemCount} item{o.itemCount > 1 ? 's' : ''}
                      </span>
                      <span className="row gap-2">
                        {rowSellers(o).map((s) => (
                          <span key={s.id ?? s.name} className="row nowrap gap-1 xs">
                            <LogoTile initials={initials(s.name)} tint={tileTint(s.name)} size="xs" />
                            {s.name}
                          </span>
                        ))}
                      </span>
                      <span className="row gap-2">
                        <StatusBadge status={PAYMENT_LABEL[o.paymentState]} />
                        <StatusBadge status={o.fulfillmentStatus} />
                        {overdue && o.lateBy && <Deadline tone="danger">{o.lateBy}</Deadline>}
                      </span>
                      {flags.length > 0 && <Flags flags={flags} />}
                    </Link>
                  );
                })}
              </div>
              <EdgeLegend edges={rows.map(rowEdge)} />
            </div>
          </>
        )}
        <div className="card-foot between">
          <span className="xs muted">
            {rows.length ? `Showing ${(page - 1) * LIMIT + 1}–${(page - 1) * LIMIT + rows.length} of ${num(total)}` : 'No matching orders'} · Flags update every 5 minutes
          </span>
          {totalPages > 1 && <Pager page={page} total={totalPages} onPage={setPage} />}
        </div>
      </section>
    </AdminLayout>
  );
}
