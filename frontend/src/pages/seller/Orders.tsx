import { useState } from 'react';
import { Link } from 'react-router';
import { SellerLayout } from '@/layouts';
import { cx } from '@/lib/cx';
import { useView } from '@/lib/hooks';
import { money } from '@/lib/format';
import { href } from '@/routes/href';
import { Alert, Button, Deadline, EmptyState, Img, LazyLoad, Pager, SearchInput, StatusBadge, StatusLegend, TableWrap, Tabs, announce } from '@/ui';
import { CANCEL_REQUESTS, COMPLETED_TOTAL, ORDER_ROWS, type SellerOrderRow } from './data/orders';

// Design: pages/seller/seller-orders.html (New tab) · views "preparing", "shipped", "completed",
// "cancellation-requests" are the other tabs.

type View = 'preparing' | 'shipped' | 'completed' | 'cancellation-requests';
type Tab = '' | View;

const IN_TAB: Record<Exclude<Tab, 'cancellation-requests'>, (r: SellerOrderRow) => boolean> = {
  '': (r) => r.status === 'New',
  preparing: (r) => r.status === 'Preparing',
  shipped: (r) => r.status === 'Shipped' || r.status === 'In transit' || r.status === 'Out for delivery',
  completed: (r) => r.status === 'Completed' || r.status === 'Partly refunded',
};

const TONE_RANK = { danger: 0, warning: 1, ok: 2 } as const;
const TODAY = 7 * 1440; // Oct 8, 00:00 PT in the rows' minute scale

const orderLink = (ref: string, view = '') => href('seller/order', view, { ref });

function nextAction(r: SellerOrderRow): { label: string; primary: boolean; to: string } {
  if (r.status === 'New') return { label: 'Prepare', primary: true, to: orderLink(r.ref) };
  if (r.status === 'Preparing') return { label: r.action ?? 'Record shipment', primary: r.dueTone === 'danger', to: orderLink(r.ref) };
  if (IN_TAB.shipped(r)) return { label: 'View tracking', primary: false, to: orderLink(r.ref, 'shipped') };
  return { label: 'View', primary: false, to: orderLink(r.ref) };
}

const edge = (r: SellerOrderRow) => (r.dueTone === 'danger' ? 'is-flagged' : r.dueTone === 'warning' ? 'is-warn' : '');

function downloadCsv(name: string, rows: SellerOrderRow[]) {
  const csv = [['order', 'placed', 'buyer', 'items', 'total', 'status', 'dispatch'], ...rows.map((r) => [r.ref, r.placed, r.buyer, r.items, r.total.toFixed(2), r.status, r.due])]
    .map((l) => l.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(','))
    .join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export default function Orders() {
  const [view, setView] = useView<View>();
  const tab: Tab = view;
  const [rows, setRows] = useState(ORDER_ROWS);
  const [requests, setRequests] = useState(CANCEL_REQUESTS);
  const [done, setDone] = useState<{ tone: 'success' | 'info'; title: string; body: string } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [q, setQ] = useState('');
  const [range, setRange] = useState('Last 7 days');
  const [sort, setSort] = useState('Dispatch deadline, soonest');
  const [page, setPage] = useState(1);

  const changeTab = (t: Tab) => {
    setSelected(new Set());
    setDone(null);
    setPage(1);
    setView(t);
  };

  const count = (t: Exclude<Tab, 'cancellation-requests'>) => rows.filter(IN_TAB[t]).length;
  const completedTotal = COMPLETED_TOTAL - ORDER_ROWS.filter(IN_TAB.completed).length + count('completed');

  const needle = q.trim().toLowerCase();
  const list =
    tab === 'cancellation-requests'
      ? []
      : rows
          .filter((r) => IN_TAB[tab](r) && (!needle || `${r.ref} ${r.buyer} ${r.items}`.toLowerCase().includes(needle)) && (range !== 'Today' || r.at >= TODAY))
          .sort((a, b) => (sort === 'Newest first' ? b.at - a.at : sort === 'Oldest first' ? a.at - b.at : tab === '' || tab === 'preparing' ? TONE_RANK[a.dueTone] - TONE_RANK[b.dueTone] : 0));
  const sel = list.filter((r) => selected.has(r.ref));
  const allOn = list.length > 0 && sel.length === list.length;
  const someOn = sel.length > 0 && !allOn;
  const overdue = tab === 'preparing' ? list.filter((r) => r.dueTone === 'danger') : [];
  const newRows = rows.filter(IN_TAB['']);

  const toggle = (ref: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(ref)) n.delete(ref);
      else n.add(ref);
      return n;
    });
  const toggleAll = () => setSelected(allOn ? new Set() : new Set(list.map((r) => r.ref)));

  const markPreparing = (refs: string[]) => {
    if (!refs.length) return;
    setRows((rs) => rs.map((r) => (refs.includes(r.ref) && r.status === 'New' ? { ...r, status: 'Preparing' } : r)));
    setSelected(new Set());
    const msg = `${refs.length} order${refs.length > 1 ? 's' : ''} marked as preparing. Buyers are told their order is being packed.`;
    setDone({ tone: 'success', title: 'Marked as preparing', body: msg });
    announce(msg);
  };
  const slips = (n: number) => announce(`${n} packing slip${n === 1 ? '' : 's'} sent to print`);
  const exportRows = (rs: SellerOrderRow[]) => {
    downloadCsv(`northwind-orders-${tab || 'new'}.csv`, rs);
    announce(`Exported ${rs.length} orders`);
  };
  const respond = (ref: string, accept: boolean) => {
    const req = requests.find((r) => r.ref === ref)!;
    setRequests((rs) => rs.filter((r) => r.ref !== ref));
    const body = accept
      ? `${req.item} was cancelled on ${ref}. ${req.buyer} is refunded ${money(req.amount)}. This doesn't count against your cancellation rate.`
      : `${req.buyer} was told the item has shipped and can return it after delivery.`;
    setDone({ tone: accept ? 'success' : 'info', title: accept ? 'Item cancelled and refunded' : 'Cancellation declined', body });
    announce(body);
  };

  const hasDanger = list.some((r) => r.dueTone === 'danger');
  const hasWarn = list.some((r) => r.dueTone === 'warning');
  const isCompleted = tab === 'completed';
  const pinAction = tab === 'shipped';

  return (
    <SellerLayout active="orders">
      <div className="page-head">
        <div className="t">
          <h1 className="h1">Orders</h1>
          <p className="sub small">Only your items are shown. Dispatch deadlines are in Pacific Time.</p>
        </div>
        <div className="actions">
          <Button variant="secondary" size="sm" icon="printer" onClick={() => slips(count('') + count('preparing'))}>
            Packing slips
          </Button>
          <Button variant="secondary" size="sm" icon="download" onClick={() => exportRows(list)}>
            Export
          </Button>
        </div>
      </div>
      <Tabs<Tab>
        items={[
          { value: '', label: 'New', count: count('') },
          { value: 'preparing', label: 'Preparing', count: count('preparing') },
          { value: 'shipped', label: 'Shipped', count: count('shipped') },
          { value: 'completed', label: 'Completed', count: completedTotal },
          { value: 'cancellation-requests', label: 'Cancellation requests', count: requests.length },
        ]}
        active={tab}
        onChange={changeTab}
      />
      <div className="toolbar">
        <SearchInput id="so-q" placeholder="Order number, buyer or SKU" value={q} onChange={setQ} />
        <label className="sr-only" htmlFor="so-date">
          Date placed
        </label>
        <select className="select" id="so-date" value={range} onChange={(e) => setRange(e.target.value)}>
          {['Last 7 days', 'Today', 'Last 30 days', 'Custom range'].map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
        <label className="sr-only" htmlFor="so-sort">
          Sort
        </label>
        <select className="select" id="so-sort" value={sort} onChange={(e) => setSort(e.target.value)}>
          {['Dispatch deadline, soonest', 'Newest first', 'Oldest first'].map((o) => (
            <option key={o}>{o}</option>
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
            {newRows.length} new order{newRows.length === 1 ? '' : 's'} waiting. Mark them as preparing to tell buyers their order is being packed.
          </span>
          <Button variant="secondary" size="sm" icon="printer" onClick={() => slips(newRows.length)}>
            Print {newRows.length} packing slip{newRows.length === 1 ? '' : 's'}
          </Button>
          <Button variant="secondary" size="sm" icon="package" onClick={() => markPreparing(newRows.map((r) => r.ref))}>
            Mark all as preparing
          </Button>
        </div>
      )}
      {overdue.length > 0 && (
        <Alert tone="danger" title={`${overdue.length} order${overdue.length > 1 ? 's are' : ' is'} past ${overdue.length > 1 ? 'their' : 'its'} dispatch deadline`}>
          {overdue.map((r) => r.ref).join(', ')} was due 3 hours ago. Ship it today and record tracking, or cancel the item if you can't fulfill it. The buyer has been told it is running late and can contact support.
        </Alert>
      )}
      {tab === 'cancellation-requests' ? (
        <>
          <Alert tone="info" title="Respond before you ship">
            If you accept, the buyer is refunded for the cancelled items and the request does not count against your cancellation rate. If the item has already shipped, decline and the buyer can return it instead.
          </Alert>
          {requests.length === 0 && (
            <section className="card">
              <div className="card-body">
                <EmptyState icon="circle-check" title="No cancellation requests">
                  When a buyer asks to cancel before you ship, the request shows here.
                </EmptyState>
              </div>
            </section>
          )}
          {requests.map((c) => (
            <section className="card" key={c.ref}>
              <div className="card-body stack gap-3">
                <div className="row between">
                  <div className="stack gap-0">
                    <Link className="mono strong" to={orderLink(c.ref)}>
                      {c.ref}
                    </Link>
                    <span className="xs muted">
                      Placed {c.placed} · {c.buyer}
                    </span>
                  </div>
                  <StatusBadge status="Cancellation requested" />
                </div>
                <div className="row gap-3 nowrap">
                  <Img icon={c.icon} tint={c.tint} className="tiny" />
                  <span className="grow stack gap-0">
                    <span className="small strong">{c.item}</span>
                    <span className="xs muted">
                      {money(c.amount)} · {c.shipped ? 'shipped' : 'not shipped'}
                    </span>
                  </span>
                </div>
                <div className="panel small">
                  <b>Buyer's reason:</b> {c.reason} "{c.quote}"
                </div>
                <div className="row between">
                  <Deadline tone="warning">{c.due}</Deadline>
                  <div className="row gap-2">
                    <Button variant="secondary" size="sm" onClick={() => respond(c.ref, false)}>
                      Decline, already shipped
                    </Button>
                    <Button size="sm" onClick={() => respond(c.ref, true)}>
                      Cancel item and refund
                    </Button>
                  </div>
                </div>
              </div>
            </section>
          ))}
        </>
      ) : (
        <>
          {sel.length > 0 && (
            <div className="bulk-bar" role="region" aria-label="Bulk actions">
              <span>{sel.length} selected</span>
              <span className="grow" />
              {tab === '' && (
                <Button variant="ghost" size="sm" icon="package" onClick={() => markPreparing(sel.map((r) => r.ref))}>
                  Mark as preparing
                </Button>
              )}
              {(tab === '' || tab === 'preparing') && (
                <Button variant="ghost" size="sm" icon="printer" onClick={() => slips(sel.length)}>
                  Print packing slips
                </Button>
              )}
              <Button variant="ghost" size="sm" icon="download" onClick={() => exportRows(sel)}>
                Export
              </Button>
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
                  {list.map((r) => {
                    const a = nextAction(r);
                    return (
                      <tr key={r.ref} className={edge(r)}>
                        <td className="col-check">
                          {edge(r) && <span className="sr-only">{edge(r) === 'is-flagged' ? 'Urgent: ' : 'At risk: '}</span>}
                          <input type="checkbox" aria-label={`Select ${r.ref}`} checked={selected.has(r.ref)} onChange={() => toggle(r.ref)} />
                        </td>
                        <td>
                          <Link className="mono small strong nowrap" to={orderLink(r.ref)} title={r.ref}>
                            {r.ref}
                          </Link>
                        </td>
                        <td>
                          <span className="small nowrap">{r.placed}</span>
                        </td>
                        <td>{r.buyer}</td>
                        <td>
                          <span className="small">{r.items}</span>
                          {r.partial && <div className="xs t-info-text strong">{r.partial}</div>}
                        </td>
                        <td className="r">
                          <span className="num">{money(r.total)}</span>
                        </td>
                        <td>
                          <StatusBadge status={r.status} />
                        </td>
                        <td>
                          <Deadline tone={r.dueTone}>{r.due}</Deadline>
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
            {list.length === 0 && (
              <EmptyState icon="inbox" title="No orders here">
                {needle || range === 'Today' ? 'Try another search or date range.' : 'Orders move to the next tab as you prepare and ship them.'}
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
              <span className="xs muted">
                Showing {list.length} of {isCompleted ? completedTotal : list.length}
              </span>
              {isCompleted && <Pager page={page} total={42} onPage={setPage} />}
            </div>
          </section>
          <ul className="card sa-ocards only-phone">
            {list.map((r) => {
              const a = nextAction(r);
              return (
                <li key={r.ref}>
                  <div className="row between">
                    <Link className="mono small strong" to={orderLink(r.ref)}>
                      {r.ref}
                    </Link>
                    <StatusBadge status={r.status} />
                  </div>
                  <span className="small">{r.items}</span>
                  <div className="row between xs muted">
                    <span>
                      {r.buyer} · {r.placed}
                    </span>
                    <b className="num u-c-text">{money(r.total)}</b>
                  </div>
                  <div className="row between">
                    <Deadline tone={r.dueTone}>{r.due}</Deadline>
                    <Link className={cx('btn btn-sm', a.primary ? 'btn-primary' : 'btn-secondary')} to={a.to}>
                      <span>{a.label}</span>
                    </Link>
                  </div>
                </li>
              );
            })}
          </ul>
          <LazyLoad end={!isCompleted} />
        </>
      )}
    </SellerLayout>
  );
}
