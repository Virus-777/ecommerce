import { useState } from 'react';
import { Link } from 'react-router';
import { STAFF } from '@/app/session';
import { sellers } from '@/data/fixtures';
import { AdminLayout } from '@/layouts';
import { cx } from '@/lib/cx';
import { money, num } from '@/lib/format';
import { useView } from '@/lib/hooks';
import { href } from '@/routes/href';
import { Alert, Badge, Button, Chip, Deadline, EmptyState, Field, Icon, LogoTile, PageHeader, Pager, SearchInput, Select, StatusBadge, TableWrap, announce } from '@/ui';
import {
  ADMIN_ORDERS, CHIP_PREFIX, DEFAULT_PAGE, FILTER_LABELS, FILTER_OPTIONS, FLAG_STYLE, NO_FILTERS, OVERDUE_FILTERS, SAVED_FILTERS, TOTAL_LAST_7_DAYS,
  type AdminOrderRow, type Edge, type OrderFilters, type OrderFlag,
} from './data/orders';

// Design: pages/admin/admin-orders.html · view "overdue-dispatch" = the saved filter with the
// late-by/owner columns, the bulk bar (3 selected) and the applied-filter chips.

type View = 'overdue-dispatch';

const FILTER_KEYS: Array<keyof OrderFilters> = ['type', 'seller', 'status', 'payment', 'date', 'flag'];
/** Applied-chip order (design: Status, Flag, then the date range). */
const CHIP_KEYS: Array<keyof OrderFilters> = ['type', 'seller', 'status', 'payment', 'flag', 'date'];
const sameFilters = (a: OrderFilters, b: OrderFilters) => FILTER_KEYS.every((k) => a[k] === b[k]);
const sellerName = (id: AdminOrderRow['sellers'][number]) => sellers[id].name;

function matches(o: AdminOrderRow, f: OrderFilters, q: string) {
  const names = o.sellers.map(sellerName);
  if (f.type === 'Official Store' && !o.sellers.includes('official')) return false;
  if (f.type === 'Marketplace sellers' && !o.sellers.some((s) => s !== 'official')) return false;
  if (f.seller !== NO_FILTERS.seller && !names.includes(f.seller)) return false;
  if (f.status !== NO_FILTERS.status) {
    // "Overdue" also covers partly delivered orders with an overdue package.
    const ok = f.status === 'Overdue' ? o.fulfilment === 'Overdue' || o.flags.includes('Overdue dispatch') : o.fulfilment === f.status;
    if (!ok) return false;
  }
  if (f.payment !== NO_FILTERS.payment && o.payment !== f.payment) return false;
  if (f.date === 'Today' && !o.placed.startsWith('Oct 8,')) return false;
  if (f.flag !== NO_FILTERS.flag && !o.flags.includes(f.flag as OrderFlag)) return false;
  const s = q.trim().toLowerCase();
  if (s && ![o.ref, o.customer, o.city].some((v) => v.toLowerCase().includes(s))) return false;
  return true;
}

const EDGE_SR: Record<Exclude<Edge, ''>, string> = { flagged: 'Urgent: ', warn: 'At risk: ' };
const edgeClass = (e: Edge) => (e === 'flagged' ? 'is-flagged' : e === 'warn' ? 'is-warn' : '');
const EdgeSr = ({ edge }: { edge: Edge }) => (edge ? <span className="sr-only">{EDGE_SR[edge]}</span> : null);

function Flags({ flags }: { flags: OrderFlag[] }) {
  return (
    <span className="aa-flags">
      {flags.map((f) => (
        <Badge key={f} tone={FLAG_STYLE[f].tone} icon={FLAG_STYLE[f].icon}>
          {f}
        </Badge>
      ))}
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
  const [view, setView] = useView<View>();
  const overdue = view === 'overdue-dispatch';
  const [filters, setFilters] = useState<OrderFilters>(overdue ? OVERDUE_FILTERS : NO_FILTERS);
  const [syncedView, setSyncedView] = useState(view);
  const [query, setQuery] = useState('');
  const [showFilters, setShowFilters] = useState(true);
  // The design's overdue view shows the first three rows selected.
  const [selected, setSelected] = useState<Set<string>>(() => new Set(overdue ? ADMIN_ORDERS.filter((o) => matches(o, OVERDUE_FILTERS, '')).slice(0, 3).map((o) => o.ref) : []));
  const [owners, setOwners] = useState<Record<string, string>>({});
  const [reminded, setReminded] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState('');
  const [page, setPage] = useState(1);

  // Entering the saved-filter view (chip, link, back button) applies its filters; leaving it drops them.
  if (syncedView !== view) {
    setSyncedView(view);
    if (overdue) setFilters(OVERDUE_FILTERS);
    else if (syncedView === 'overdue-dispatch' && sameFilters(filters, OVERDUE_FILTERS)) setFilters(NO_FILTERS);
  }

  const unfiltered = sameFilters(filters, NO_FILTERS) && !query.trim();
  const rows = unfiltered ? ADMIN_ORDERS.slice(0, DEFAULT_PAGE) : ADMIN_ORDERS.filter((o) => matches(o, filters, query));
  const allOn = rows.length > 0 && rows.every((o) => selected.has(o.ref));
  const picked = ADMIN_ORDERS.filter((o) => selected.has(o.ref));
  const applied = CHIP_KEYS.filter((k) => filters[k] !== NO_FILTERS[k]);
  const title = overdue ? 'Orders · Overdue dispatch' : 'All orders';

  /** Any manual filter change leaves the saved filter. */
  const changeFilters = (next: OrderFilters) => {
    setFilters(next);
    setPage(1);
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
  const ownerOf = (o: AdminOrderRow) => owners[o.ref] ?? o.owner ?? 'Seller';
  const say = (msg: string) => {
    setNotice(msg);
    announce(msg);
  };
  const plural = (n: number) => `${n} order${n === 1 ? '' : 's'}`;

  const remindSellers = () => {
    setReminded((r) => new Set([...r, ...picked.map((o) => o.ref)]));
    say(`Reminders sent to the sellers of ${plural(picked.length)}.`);
    setSelected(new Set());
  };
  const assignOwner = (owner: string, msg: string) => {
    setOwners((m) => ({ ...m, ...Object.fromEntries(picked.map((o) => [o.ref, owner])) }));
    say(msg);
    setSelected(new Set());
  };
  const remindOne = (ref: string) => {
    setReminded((r) => new Set(r).add(ref));
    say(`Reminder sent to the seller of ${ref}.`);
  };

  return (
    <AdminLayout active="orders">
      <PageHeader
        crumbs={[{ label: 'Commerce' }, { label: 'Orders', to: href('admin/orders') }]}
        title={title}
        sub={overdue ? 'Saved filter · items past their dispatch deadline · sellers and customers already notified' : `Company and marketplace seller orders · ${num(TOTAL_LAST_7_DAYS)} in the last 7 days · times in PT`}
        actions={
          <>
            <span className="aa-tip" tabIndex={0}>
              <Button variant="secondary" size="sm" icon="download" onClick={() => announce('Export started. It is logged in Action history.')}>
                Export CSV
              </Button>
              <span className="aa-tipbox" role="tooltip">
                Exports are logged in Action history with your name. Customer phone numbers are masked unless your role allows them.
              </span>
            </span>
            <Button variant="secondary" size="sm" icon="truck" to={href('ops/dispatch')}>
              Open dispatch queue
            </Button>
          </>
        }
      />
      <div className="stack gap-2">
        <span className="xs strong muted">Saved filters</span>
        <div className="hscroll gap-2">
          {SAVED_FILTERS.map((s) =>
            s.view ? (
              <Chip key={s.label} icon={s.icon} active={overdue} to={href('admin/orders', s.view)}>
                {s.label} · {s.count}
              </Chip>
            ) : (
              <Chip key={s.label} icon={s.icon} active={!overdue && applied.length === 1 && sameFilters(filters, { ...NO_FILTERS, ...s.filters })} onClick={() => changeFilters({ ...NO_FILTERS, ...s.filters })}>
                {s.label} · {s.count}
              </Chip>
            ),
          )}
          <Chip icon="bookmark-plus" onClick={() => announce('Current filters saved')}>
            Save current filters
          </Chip>
        </div>
      </div>
      {overdue && (
        <Alert tone="danger" title="9 orders have items past their dispatch deadline">
          Overdue tasks were created automatically. Each seller got a reminder and each customer got an update with a way to contact support. Escalate to Grace Kim (Seller Manager) when a seller misses a second deadline.
        </Alert>
      )}
      {notice && <Alert tone="success" title={notice} />}
      <section className="card">
        <div className="card-body">
          <div className="toolbar">
            <SearchInput id="aa-o-q" placeholder="Search by order ref, customer, email or tracking number" value={query} onChange={(v) => (setQuery(v), setPage(1))} />
            <Button variant="ghost" size="sm" icon="sliders-horizontal" aria-expanded={showFilters} aria-controls="aa-o-filters" onClick={() => setShowFilters((s) => !s)}>
              More filters
            </Button>
          </div>
          <div className="aa-filters" id="aa-o-filters" hidden={!showFilters}>
            {FILTER_KEYS.map((k) => (
              <Field key={k} label={FILTER_LABELS[k]} className="aa-flt">
                <Select id={`aa-o-${k === 'payment' ? 'pay' : k}`} options={FILTER_OPTIONS[k]} value={filters[k]} onChange={(e) => changeFilters({ ...filters, [k]: e.target.value })} />
              </Field>
            ))}
          </div>
          {applied.length > 0 && (
            <div className="row gap-2">
              <div className="hscroll gap-2">
                {applied.map((k) => (
                  <Chip key={k} removable onClick={() => changeFilters({ ...filters, [k]: NO_FILTERS[k] })}>
                    {CHIP_PREFIX[k]}
                    {filters[k]}
                  </Chip>
                ))}
              </div>
              <Link className="small strong" to={href('admin/orders')} onClick={clearAll}>
                Clear all
              </Link>
            </div>
          )}
        </div>
        {picked.length > 0 && (
          <div className="u-p-0-sp-4-sp-3">
            <div className="bulk-bar">
              <span>{picked.length} selected</span>
              <span className="grow" />
              <Button variant="ghost" icon="bell" onClick={remindSellers}>
                Remind sellers
              </Button>
              <Button variant="ghost" icon="user-plus" onClick={() => assignOwner(STAFF.admin.name, `${plural(picked.length)} assigned to you.`)}>
                Assign owner
              </Button>
              <Button variant="ghost" icon="arrow-up-right" onClick={() => assignOwner('Grace Kim', `${plural(picked.length)} escalated to Grace Kim (Seller Manager).`)}>
                Escalate to Seller Manager
              </Button>
            </div>
          </div>
        )}
        {rows.length === 0 ? (
          <div className="card-body">
            <EmptyState icon="search-x" title="No orders match these filters" action={<Button variant="secondary" size="sm" onClick={clearAll}>Clear all filters</Button>}>
              Try removing a filter, or search by order ref, customer or tracking number.
            </EmptyState>
          </div>
        ) : (
          <>
            <div className="no-phone">
              <TableWrap label={`${title} table`}>
                <table className="table">
                  <thead>
                    <tr>
                      <th className="col-check">
                        <input type="checkbox" aria-label="Select all" checked={allOn} onChange={toggleAll} />
                      </th>
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
                      const names = o.sellers.map(sellerName).join(', ');
                      const n = o.sellers.length;
                      return (
                        <tr key={o.ref} className={edgeClass(o.edge)}>
                          <td className="col-check">
                            <EdgeSr edge={o.edge} />
                            <input type="checkbox" aria-label={`Select ${o.ref}`} checked={selected.has(o.ref)} onChange={() => toggle(o.ref)} />
                          </td>
                          <td className="cell-id">
                            <Link className="mono strong nowrap" to={href('admin/order', '', { ref: o.ref })} title={o.ref}>
                              {o.ref}
                            </Link>
                          </td>
                          <td>
                            <span className="small nowrap">{o.placed}</span>
                          </td>
                          <td className="cell-name">
                            <span className="stack gap-0">
                              <span className="small strong nowrap ellip" title={o.customer}>
                                {o.customer}
                              </span>
                              <span className="xs muted ellip" title={o.city}>
                                {o.city}
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
                          {!overdue && <td className="r">{o.items}</td>}
                          <td className="r">
                            <span className="strong">{money(o.total)}</span>
                          </td>
                          {!overdue && (
                            <td>
                              <StatusBadge status={o.payment} />
                            </td>
                          )}
                          <td>
                            <span className="stack gap-1">
                              <StatusBadge status={o.fulfilment} />
                              <span className="xs muted">{o.fulfilmentNote}</span>
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
                                {reminded.has(o.ref) ? (
                                  <Button variant="ghost" size="sm" icon="check" disabled>
                                    Reminded
                                  </Button>
                                ) : (
                                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => remindOne(o.ref)}>
                                    <Icon name="bell" />
                                    <span>Remind seller</span>
                                    <span className="sr-only"> {o.ref}</span>
                                  </button>
                                )}
                              </td>
                            </>
                          ) : (
                            <td className="col-pin">{o.flags.length ? <Flags flags={o.flags} /> : <span className="sr-only">None</span>}</td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </TableWrap>
              <EdgeLegend edges={rows.map((o) => o.edge)} />
            </div>
            <div className="only-phone card-pad-phone">
              <div className="aa-mlist">
                {rows.map((o) => (
                  <Link key={o.ref} className={cx('aa-mcard', edgeClass(o.edge))} to={href('admin/order', '', { ref: o.ref })}>
                    <EdgeSr edge={o.edge} />
                    <span className="row between">
                      <span className="mono strong">{o.ref}</span>
                      <span className="strong num">{money(o.total)}</span>
                    </span>
                    <span className="xs muted">
                      {o.placed} · {o.customer} · {o.items} item{o.items > 1 ? 's' : ''}
                    </span>
                    <span className="row gap-2">
                      {o.sellers.map((s) => (
                        <span key={s} className="row nowrap gap-1 xs">
                          <LogoTile initials={sellers[s].initials} tint={sellers[s].tint} size="xs" />
                          {sellers[s].name}
                        </span>
                      ))}
                    </span>
                    <span className="row gap-2">
                      <StatusBadge status={o.payment} />
                      <StatusBadge status={o.fulfilment} />
                      {overdue && o.lateBy && <Deadline tone="danger">{o.lateBy}</Deadline>}
                    </span>
                    {o.flags.length > 0 && <Flags flags={o.flags} />}
                  </Link>
                ))}
              </div>
              <EdgeLegend edges={rows.map((o) => o.edge)} />
            </div>
          </>
        )}
        <div className="card-foot between">
          {unfiltered ? (
            <>
              <span className="xs muted">
                Showing 1–{DEFAULT_PAGE} of {num(TOTAL_LAST_7_DAYS)} · Flags update every 5 minutes
              </span>
              <Pager page={page} total={Math.ceil(TOTAL_LAST_7_DAYS / 10)} onPage={setPage} />
            </>
          ) : (
            <span className="xs muted">
              {rows.length ? `Showing 1–${rows.length} of ${rows.length}` : 'No matching orders'} · Flags update every 5 minutes
            </span>
          )}
        </div>
      </section>
    </AdminLayout>
  );
}
