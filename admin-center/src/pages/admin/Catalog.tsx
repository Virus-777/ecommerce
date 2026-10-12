import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { AdminLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { money, num } from '@marketly/web-shared/lib/format';
import { useView } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import { Alert, Button, Dialog, EmptyState, Field, Icon, Img, Meter, PageHeader, Pager, StatusBadge, StatusLegend, SearchInput, Tabs, TableWrap, Textarea } from '@marketly/web-shared/ui';
import {
  BRAND_OPTIONS, BULK_PRESELECTED, CATALOG_ROWS, CATALOG_TABS, CATEGORY_OPTIONS, MISSING_OPTIONS, PUBLICATION_OPTIONS, REVIEW_OPTIONS, SELLER_OPTIONS,
  type CatalogRow, type CatalogTab, type MissingContent,
} from './data/catalog';

// Design: pages/admin/admin-catalog.html · view "bulk-selection" = rows selected, bulk bar shown.

type Filters = { cat: string; brand: string; seller: string; review: string; missing: string; pub: string };
const NO_FILTERS: Filters = { cat: '', brand: '', seller: '', review: '', missing: '', pub: '' };

const FILTERS: Array<{ key: keyof Filters; id: string; label: string; any: string; options: string[] }> = [
  { key: 'cat', id: 'aa-c-cat', label: 'Category', any: 'All categories', options: CATEGORY_OPTIONS },
  { key: 'brand', id: 'aa-c-brand', label: 'Brand', any: 'All brands', options: BRAND_OPTIONS },
  { key: 'seller', id: 'aa-c-seller', label: 'Seller', any: 'Any seller', options: SELLER_OPTIONS },
  { key: 'review', id: 'aa-c-review', label: 'Approval state', any: 'Any state', options: REVIEW_OPTIONS },
  { key: 'missing', id: 'aa-c-miss', label: 'Missing content', any: 'Any', options: MISSING_OPTIONS },
  { key: 'pub', id: 'aa-c-pub', label: 'Publication', any: 'Any', options: PUBLICATION_OPTIONS },
];

const TAB_TEST: Record<CatalogTab, (r: CatalogRow) => boolean> = {
  all: () => true,
  active: (r) => r.pub === 'Active',
  hidden: (r) => r.pub === 'Hidden',
  suspended: (r) => r.pub === 'Suspended',
  missing: (r) => r.missing.length > 0,
  duplicates: (r) => !!r.duplicate,
};

const EDGE_SR = { flagged: 'Urgent: ', warn: 'At risk: ' } as const;
const EDGE_LEGEND = {
  flagged: { tone: 'danger' as const, label: 'Red edge = urgent: overdue or past target' },
  warn: { tone: 'warning' as const, label: 'Amber edge = at risk: due soon or near target' },
};

/** Content score bands: below 70 is below target, 70–84 near target. */
function scoreBand(score: number) {
  if (score < 70) return { tone: 'danger' as const, note: 'Below target' };
  if (score < 85) return { tone: 'warning' as const, note: 'Near target' };
  return { tone: 'success' as const, note: '' };
}

const rowKey = (r: CatalogRow) => r.sku ?? r.name;
const rowLink = (r: CatalogRow) => (r.submission ? href('admin/product-review') : href('store/product'));
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function EdgeLegend({ rows }: { rows: CatalogRow[] }) {
  const items = (['flagged', 'warn'] as const).filter((e) => rows.some((r) => r.edge === e)).map((e) => EDGE_LEGEND[e]);
  return items.length ? <StatusLegend items={items} /> : null;
}

export default function Catalog() {
  const [view, setView] = useView<'bulk-selection'>();
  const [rows, setRows] = useState(CATALOG_ROWS);
  const [tab, setTab] = useState<CatalogTab>('all');
  const [q, setQ] = useState('');
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(view === 'bulk-selection' ? BULK_PRESELECTED : []));
  const [tipOpen, setTipOpen] = useState(view === 'bulk-selection');
  const [page, setPage] = useState(1);
  const [notice, setNotice] = useState('');
  const [changesOpen, setChangesOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [reasonTried, setReasonTried] = useState(false);

  // Keep the selection and ?view=bulk-selection in step (links, back button).
  useEffect(() => {
    if (view === 'bulk-selection' && selected.size === 0) setSelected(new Set(BULK_PRESELECTED));
    if (view === '' && selected.size > 0) setSelected(new Set());
  }, [view]);

  const select = (next: Set<string>) => {
    setSelected(next);
    const want = next.size > 0 ? 'bulk-selection' : '';
    if (want !== view) setView(want, { replace: true });
    if (next.size === 0) setTipOpen(false);
  };

  const visible = useMemo(() => {
    const term = q.trim().toLowerCase();
    return rows.filter(
      (r) =>
        TAB_TEST[tab](r) &&
        (!term || [r.name, r.brand, r.sku ?? ''].some((s) => s.toLowerCase().includes(term))) &&
        (!filters.cat || r.cat === filters.cat) &&
        (!filters.brand || r.brand === filters.brand) &&
        (!filters.seller || r.sellers.includes(filters.seller)) &&
        (!filters.review || r.review === filters.review) &&
        (!filters.missing || r.missing.includes(filters.missing as MissingContent)) &&
        (!filters.pub || r.pub === filters.pub),
    );
  }, [rows, tab, q, filters]);

  const allOn = visible.length > 0 && visible.every((r) => selected.has(r.id));
  const someOn = !allOn && visible.some((r) => selected.has(r.id));
  const toggleAll = () => {
    const next = new Set(selected);
    visible.forEach((r) => (allOn ? next.delete(r.id) : next.add(r.id)));
    select(next);
  };
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    select(next);
  };

  const update = (patch: Partial<CatalogRow>) => setRows((list) => list.map((r) => (selected.has(r.id) ? { ...r, ...patch } : r)));
  const hide = () => {
    const n = selected.size;
    update({ pub: 'Hidden' });
    select(new Set());
    setNotice(`${plural(n, 'product')} hidden. Customers can't find ${n === 1 ? 'it' : 'them'} in search or categories until shown again.`);
  };
  const reasonError = reasonTried && !reason.trim() ? 'Enter what the sellers need to change.' : '';
  const openChanges = () => {
    setReason('');
    setReasonTried(false);
    setChangesOpen(true);
  };
  const sendChanges = () => {
    setReasonTried(true);
    if (!reason.trim()) return;
    const n = selected.size;
    update({ review: 'Changes requested' });
    select(new Set());
    setChangesOpen(false);
    setNotice(`Change request sent for ${plural(n, 'product')}. Sellers see your note and resubmit for review.`);
  };

  const setFilter = (k: keyof Filters, v: string) => {
    setFilters((f) => ({ ...f, [k]: v }));
    setPage(1);
  };

  return (
    <AdminLayout active="catalog">
      <PageHeader
        crumbs={[{ label: 'Catalog' }, { label: 'Products' }]}
        title="Products"
        sub="8,335 shared products · 11,920 offers · owner Omar Haddad, Catalog Manager"
        actions={
          <>
            <Button variant="secondary" size="sm" icon="download">
              Export
            </Button>
            <Button variant="secondary" size="sm" icon="list-checks" to={href('admin/product-review')}>
              Review queue · 23
            </Button>
            <Button size="sm" icon="plus">
              Add product
            </Button>
          </>
        }
      />
      {notice && <Alert tone="success" title={notice} />}
      <section className="card">
        <Tabs
          items={CATALOG_TABS.map((t) => ({ ...t }))}
          active={tab}
          onChange={(t) => {
            setTab(t);
            setPage(1);
          }}
          label="Product status"
        />
        <div className="card-body">
          <div className="toolbar">
            <SearchInput id="aa-c-q" placeholder="Search by name, brand, SKU, UPC or model number" value={q} onChange={setQ} label="Search products" />
          </div>
          <div className="aa-filters">
            {FILTERS.map((f) => (
              <div key={f.key} className="field aa-flt">
                <label className="label" htmlFor={f.id}>
                  {f.label}
                </label>
                <select className="select" id={f.id} value={filters[f.key]} onChange={(e) => setFilter(f.key, e.target.value)}>
                  <option value="">{f.any}</option>
                  {f.options.map((o) => (
                    <option key={o}>{o}</option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        </div>
        {selected.size > 0 ? (
          <div className="u-p-0-sp-4-sp-3">
            <div className="bulk-bar">
              <span>{selected.size} selected</span>
              <span className="grow" />
              <Button variant="ghost" icon="eye-off" onClick={hide}>
                Hide
              </Button>
              <Button variant="ghost" icon="message-square-warning" onClick={openChanges}>
                Request changes
              </Button>
              <span className={cx('aa-tip', tipOpen && 'is-open')} tabIndex={0} onMouseLeave={() => setTipOpen(false)} onBlur={() => setTipOpen(false)}>
                <Button variant="ghost" icon="lock" disabled>
                  Bulk price and stock update
                </Button>
                <span className="aa-tipbox" role="tooltip">
                  Needs the Catalog bulk edit permission. Ask Omar Haddad (Catalog Manager) or request access in Staff and roles.
                </span>
              </span>
              <span className="aa-tip" tabIndex={0}>
                <Button variant="ghost" icon="lock" disabled>
                  Suspend
                </Button>
                <span className="aa-tipbox" role="tooltip">
                  Only the Catalog Manager can suspend products. Suspending needs a recorded reason and explains the effect on open orders.
                </span>
              </span>
              <Button variant="ghost" onClick={() => select(new Set())}>
                Clear
              </Button>
            </div>
          </div>
        ) : (
          <div className="xs muted u-p-0-sp-4-sp-3">
            <Icon name="info" className="ic-sm" /> Select products to hide, request changes or update in bulk. Bulk price, stock and suspension need extra permissions.
          </div>
        )}
        <div className="no-phone">
          <TableWrap label="Products table">
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
                  <th scope="col">Product</th>
                  <th scope="col">Brand</th>
                  <th scope="col">Category</th>
                  <th className="r" scope="col">
                    Offers
                  </th>
                  <th className="r" scope="col">
                    Best price
                  </th>
                  <th scope="col">Review state</th>
                  <th scope="col">Publication</th>
                  <th className="col-pin" scope="col">
                    Content score
                  </th>
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => {
                  const band = scoreBand(r.score);
                  return (
                    <tr key={r.id} className={cx(r.edge && `is-${r.edge}`)}>
                      <td className="col-check">
                        {r.edge && <span className="sr-only">{EDGE_SR[r.edge]}</span>}
                        <input type="checkbox" aria-label={`Select ${rowKey(r)}`} checked={selected.has(r.id)} onChange={() => toggle(r.id)} />
                      </td>
                      <td>
                        <span className="cell-main">
                          <Img icon={r.icon} tint={r.tint} className="tiny" />
                          <span className="stack gap-0">
                            <Link className="small strong clamp-2" to={rowLink(r)}>
                              {r.name}
                            </Link>
                            <span className="xs muted">
                              {r.sku ? (
                                <>
                                  <span className="mono nowrap" title={r.sku}>
                                    {r.sku}
                                  </span>
                                  {r.note && ` · ${r.note}`}
                                </>
                              ) : (
                                'New submission'
                              )}
                            </span>
                          </span>
                        </span>
                      </td>
                      <td>{r.brand}</td>
                      <td>
                        <span className="small nowrap">
                          {r.cat} › {r.sub}
                        </span>
                      </td>
                      <td className="r">{num(r.offers)}</td>
                      <td className="r">{money(r.price)}</td>
                      <td>
                        <StatusBadge status={r.review} />
                      </td>
                      <td>
                        <StatusBadge status={r.pub} />
                      </td>
                      <td className="col-pin">
                        <span className="stack gap-1 minw-110">
                          <span className="row between xs">
                            <span className="strong num">{r.score}</span>
                            <span className="muted">/ 100</span>
                          </span>
                          <Meter pct={r.score} tone={band.tone} label={`Content score: ${rowKey(r)}`} />
                          {band.note && <span className={`xs strong meter-note t-${band.tone}-text`}>{band.note}</span>}
                          {r.issue && <span className="xs t-warning-text strong">{r.issue}</span>}
                        </span>
                      </td>
                    </tr>
                  );
                })}
                {visible.length === 0 && (
                  <tr>
                    <td colSpan={9}>
                      <EmptyState icon="search-x" title="No products match these filters">
                        Try another tab, clear a filter or search by SKU or UPC.
                      </EmptyState>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </TableWrap>
          <EdgeLegend rows={visible} />
        </div>
        <div className="only-phone card-pad-phone">
          <div className="aa-mlist">
            {visible.slice(0, 10).map((r) => (
              <Link key={r.id} className={cx('aa-mcard', r.edge && `is-${r.edge}`)} to={rowLink(r)}>
                {r.edge && <span className="sr-only">{EDGE_SR[r.edge]}</span>}
                <span className="row nowrap top gap-3">
                  <Img icon={r.icon} tint={r.tint} className="tiny" />
                  <span className="stack gap-1 grow">
                    <span className="small strong clamp-2">{r.name}</span>
                    <span className="xs muted">
                      {r.brand} · {r.cat} › {r.sub} · {plural(r.offers, 'offer')} · from {money(r.price)}
                    </span>
                  </span>
                </span>
                <span className="row gap-2">
                  <StatusBadge status={r.review} />
                  <StatusBadge status={r.pub} />
                  <span className="xs muted">Content {r.score}/100</span>
                </span>
                {r.issue && <span className="xs t-warning-text strong">{r.issue}</span>}
              </Link>
            ))}
            {visible.length === 0 && (
              <EmptyState icon="search-x" title="No products match these filters">
                Try another tab or clear a filter.
              </EmptyState>
            )}
          </div>
          <EdgeLegend rows={visible.slice(0, 10)} />
        </div>
        <div className="card-foot between">
          <span className="xs muted">Hiding or suspending a product does not remove other sellers' valid offers from past orders. Purchase snapshots keep the terms accepted at purchase.</span>
          <Pager page={page} total={417} onPage={setPage} />
        </div>
      </section>

      <Dialog
        open={changesOpen}
        onClose={() => setChangesOpen(false)}
        title={`Request changes on ${plural(selected.size, 'product')}`}
        foot={
          <>
            <Button variant="ghost" onClick={() => setChangesOpen(false)}>
              Cancel
            </Button>
            <Button icon="send" onClick={sendChanges}>
              Send change request
            </Button>
          </>
        }
      >
        <p className="small sub">Each seller with an offer on these products gets your note. Products stay on sale while the sellers update them.</p>
        <Field label="What needs to change" hint="Required. Shown to the sellers." error={reasonError}>
          <Textarea id="aa-c-bulk-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </Dialog>
    </AdminLayout>
  );
}
