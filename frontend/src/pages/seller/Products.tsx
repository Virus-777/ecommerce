import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { SellerLayout } from '@/layouts';
import { useView } from '@/lib/hooks';
import { money } from '@/lib/format';
import { href } from '@/routes/href';
import { Badge, Button, Dialog, EmptyState, Field, Icon, IconButton, Img, LazyLoad, Pager, SearchInput, StatusBadge, StatusLegend, TableWrap, Tabs, TextInput, announce } from '@/ui';
import { LOW_STOCK, PRODUCT_CATEGORIES, PRODUCT_ROWS, PRODUCT_TAB_TOTALS, PRODUCT_TOTAL, type ProductRow } from './data/products';

// Design: pages/seller/seller-products.html · views "rows-selected" (2 rows ticked, bulk bar) and
// "add-product" (the Add a product dialog).

type View = 'rows-selected' | 'add-product';
type Tab = 'all' | 'active' | 'draft' | 'submitted' | 'changes' | 'rejected' | 'hidden';

const TAB_FILTER: Record<Tab, (r: ProductRow) => boolean> = {
  all: () => true,
  active: (r) => r.publication === 'Active',
  draft: (r) => r.review === 'Draft',
  submitted: (r) => r.review === 'Submitted',
  changes: (r) => r.review === 'Changes requested',
  rejected: (r) => r.review === 'Rejected',
  hidden: (r) => r.publication === 'Hidden' || r.publication === 'Suspended',
};

const TABS: Array<{ value: Tab; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'draft', label: 'Draft' },
  { value: 'submitted', label: 'Submitted' },
  { value: 'changes', label: 'Changes requested' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'hidden', label: 'Hidden or suspended' },
];

const CONTENT_FILTER: Record<string, (r: ProductRow) => boolean> = {
  'Missing images': (r) => !!r.missing?.includes('images'),
  'Missing identifiers': (r) => !!r.missing?.includes('identifiers'),
  'Low stock': (r) => r.stock > 0 && r.stock <= LOW_STOCK,
};

const edge = (r: ProductRow): '' | 'is-warn' | 'is-flagged' => (r.reason ? (r.reason.danger ? 'is-flagged' : 'is-warn') : '');

function StockCell({ n }: { n: number }) {
  if (n === 0)
    return (
      <span className="num t-danger-text strong">
        0<span className="xs"> · Out</span>
      </span>
    );
  if (n <= LOW_STOCK)
    return (
      <span className="num t-warning-text strong">
        {n}
        <span className="xs"> · Low</span>
      </span>
    );
  return <span className="num">{n}</span>;
}

function Reason({ r }: { r: ProductRow }) {
  if (!r.reason) return null;
  return (
    <div className={r.reason.danger ? 'sa-reason t-danger' : 'sa-reason'}>
      <Icon name={r.reason.danger ? 'circle-alert' : 'message-square-warning'} />
      <span>{r.reason.text}</span>
    </div>
  );
}

function downloadCsv(name: string, rows: string[][]) {
  const csv = rows.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

type BulkMode = 'price' | 'stock';

export default function Products() {
  const navigate = useNavigate();
  const [view, setView] = useView<View>();
  const [rows, setRows] = useState(PRODUCT_ROWS);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(view === 'rows-selected' ? PRODUCT_ROWS.slice(0, 2).map((r) => r.sku) : []));
  const [tab, setTab] = useState<Tab>('all');
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('All categories');
  const [pub, setPub] = useState('Any publication');
  const [content, setContent] = useState('Any content');
  const [page, setPage] = useState(1);
  const [addChoice, setAddChoice] = useState<'match' | 'new'>('match');
  const [bulk, setBulk] = useState<BulkMode | null>(null);
  const [bulkValue, setBulkValue] = useState('');
  const [bulkTried, setBulkTried] = useState(false);

  const needle = q.trim().toLowerCase();
  const visible = rows.filter(
    (r) =>
      TAB_FILTER[tab](r) &&
      (!needle || `${r.name} ${r.variant} ${r.sku}`.toLowerCase().includes(needle)) &&
      (cat === 'All categories' || r.category === cat) &&
      (pub === 'Any publication' || r.publication === pub) &&
      (content === 'Any content' || CONTENT_FILTER[content](r)),
  );
  const visibleSel = visible.filter((r) => selected.has(r.sku));
  const allOn = visible.length > 0 && visibleSel.length === visible.length;
  const someOn = visibleSel.length > 0 && !allOn;
  const selRows = rows.filter((r) => selected.has(r.sku));

  const syncView = (next: Set<string>) => {
    if (view === 'add-product') return;
    setView(next.size ? 'rows-selected' : '', { replace: true });
  };
  const updateSel = (next: Set<string>) => {
    setSelected(next);
    syncView(next);
  };
  const toggle = (sku: string) => {
    const next = new Set(selected);
    if (next.has(sku)) next.delete(sku);
    else next.add(sku);
    updateSel(next);
  };
  const toggleAll = () => {
    const next = new Set(selected);
    if (allOn) visible.forEach((r) => next.delete(r.sku));
    else visible.forEach((r) => next.add(r.sku));
    updateSel(next);
  };
  const clear = () => updateSel(new Set());

  const setPublication = (skus: string[], p: 'Active' | 'Hidden') => {
    setRows((list) =>
      list.map((r) => {
        if (!skus.includes(r.sku)) return r;
        if (p === 'Hidden' && r.publication !== 'Active') return r;
        return p === 'Hidden'
          ? { ...r, publication: 'Hidden', note: 'Hidden by you on Oct 8', action: { label: 'Show offer', kind: 'show', variant: 'ghost' } }
          : { ...r, publication: 'Active', note: undefined, action: { label: 'Edit offer', kind: 'link', variant: 'ghost', to: { id: 'seller/offer' } } };
      }),
    );
  };
  const hideSelected = () => {
    const n = selRows.filter((r) => r.publication === 'Active').length;
    setPublication([...selected], 'Hidden');
    announce(n ? `${n} offer${n > 1 ? 's' : ''} hidden. Customers no longer see ${n > 1 ? 'them' : 'it'}.` : 'Only active offers can be hidden.');
    clear();
  };
  const exportSelected = () => {
    downloadCsv('northwind-offers.csv', [['seller_sku', 'product', 'variation', 'price', 'quantity', 'condition', 'review', 'publication'], ...selRows.map((r) => [r.sku, r.name, r.variant, r.price.toFixed(2), String(r.stock), r.condition, r.review, r.publication])]);
    announce(`Exported ${selRows.length} offers`);
  };

  const openBulk = (m: BulkMode) => {
    setBulk(m);
    setBulkValue('');
    setBulkTried(false);
  };
  const bulkNum = Number(bulkValue);
  const bulkError = !bulkTried
    ? ''
    : bulk === 'price'
      ? bulkValue.trim() === '' || !Number.isFinite(bulkNum) || bulkNum === 0 || Math.abs(bulkNum) > 50
        ? 'Enter a change between −50% and 50%. Larger changes need the bulk update file.'
        : ''
      : bulkValue.trim() === '' || !Number.isInteger(bulkNum) || bulkNum < 0
        ? 'Enter a whole number of 0 or more.'
        : '';
  const applyBulk = () => {
    setBulkTried(true);
    const ok = bulk === 'price' ? bulkValue.trim() !== '' && Number.isFinite(bulkNum) && bulkNum !== 0 && Math.abs(bulkNum) <= 50 : bulkValue.trim() !== '' && Number.isInteger(bulkNum) && bulkNum >= 0;
    if (!ok) return;
    setRows((list) => list.map((r) => (selected.has(r.sku) ? (bulk === 'price' ? { ...r, price: Math.round(r.price * (1 + bulkNum / 100) * 100) / 100 } : { ...r, stock: bulkNum }) : r)));
    announce(bulk === 'price' ? `Price changed by ${bulkNum}% on ${selected.size} offers` : `Stock set to ${bulkNum} on ${selected.size} offers`);
    setBulk(null);
  };

  const rowAction = (r: ProductRow, phone?: boolean) => {
    const a = r.action;
    const sr = phone ? null : <span className="sr-only"> {r.sku}</span>;
    if (a.kind === 'link' && a.to)
      return (
        <Link className={`btn btn-${a.variant} btn-sm`} to={href(a.to.id, a.to.view)}>
          <span>{a.label}</span>
          {sr}
        </Link>
      );
    const onClick = a.kind === 'show' ? () => (setPublication([r.sku], 'Active'), announce(`${r.sku} is visible to customers again`)) : r.publication === 'Suspended' ? () => navigate(href('seller/help', 'contact-seller-support')) : () => navigate(href('seller/store'));
    return (
      <button type="button" className={`btn btn-${a.variant} btn-sm`} onClick={onClick}>
        <span>{a.label}</span>
        {sr}
      </button>
    );
  };

  const hasDanger = visible.some((r) => edge(r) === 'is-flagged');
  const hasWarn = visible.some((r) => edge(r) === 'is-warn');

  return (
    <SellerLayout active="products">
      <div className="page-head">
        <div className="t">
          <h1 className="h1">Products and offers</h1>
          <p className="sub small">{PRODUCT_TOTAL} offers across 11 products. Review state and publication are tracked separately.</p>
        </div>
        <div className="actions">
          <Button variant="secondary" size="sm" icon="upload" to={href('seller/bulk-update')}>
            Bulk update
          </Button>
          <Button size="sm" icon="plus" onClick={() => setView('add-product')}>
            Add product
          </Button>
        </div>
      </div>
      <Tabs
        items={TABS.map((t) => ({ ...t, count: PRODUCT_TAB_TOTALS[t.value] }))}
        active={tab}
        onChange={(t) => {
          setTab(t);
          setPage(1);
        }}
      />
      <div className="toolbar">
        <SearchInput id="sp-q" placeholder="Search name, seller SKU, GTIN or model" value={q} onChange={setQ} />
        <label className="sr-only" htmlFor="sp-cat">
          Category
        </label>
        <select className="select" id="sp-cat" value={cat} onChange={(e) => setCat(e.target.value)}>
          {['All categories', ...PRODUCT_CATEGORIES].map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
        <label className="sr-only" htmlFor="sp-pub">
          Publication
        </label>
        <select className="select" id="sp-pub" value={pub} onChange={(e) => setPub(e.target.value)}>
          {['Any publication', 'Active', 'Hidden', 'Suspended', 'Not published'].map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
        <label className="sr-only" htmlFor="sp-miss">
          Content
        </label>
        <select className="select" id="sp-miss" value={content} onChange={(e) => setContent(e.target.value)}>
          {['Any content', ...Object.keys(CONTENT_FILTER)].map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
      </div>
      {selected.size > 0 && (
        <div className="bulk-bar" role="region" aria-label="Bulk actions">
          <span>{selected.size} selected</span>
          <span className="grow" />
          <Button variant="ghost" size="sm" icon="tag" onClick={() => openBulk('price')}>
            Change price
          </Button>
          <Button variant="ghost" size="sm" icon="boxes" onClick={() => openBulk('stock')}>
            Update stock
          </Button>
          <Button variant="ghost" size="sm" icon="eye-off" onClick={hideSelected}>
            Hide offers
          </Button>
          <Button variant="ghost" size="sm" icon="download" onClick={exportSelected}>
            Export
          </Button>
          <Button variant="ghost" size="sm" icon="x" onClick={clear}>
            Clear
          </Button>
        </div>
      )}
      <section className="card no-phone">
        <TableWrap label="Products and offers table">
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
                <th scope="col">Seller SKU</th>
                <th className="r" scope="col">
                  Price
                </th>
                <th className="r" scope="col">
                  Stock
                </th>
                <th scope="col">Condition</th>
                <th scope="col">Review</th>
                <th scope="col">Publication</th>
                <th className="col-pin" scope="col">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <tr key={r.sku} className={edge(r)}>
                  <td className="col-check">
                    {edge(r) && <span className="sr-only">{edge(r) === 'is-flagged' ? 'Urgent: ' : 'At risk: '}</span>}
                    <input type="checkbox" aria-label={`Select ${r.sku}`} checked={selected.has(r.sku)} onChange={() => toggle(r.sku)} />
                  </td>
                  <td>
                    <div className="cell-main minw-280">
                      <Img icon={r.icon} tint={r.tint} className="tiny" />
                      <div className="stack gap-0">
                        <Link className="small strong" to={href(r.link.id, r.link.view)}>
                          {r.name}
                        </Link>
                        <span className="xs muted">{r.variant}</span>
                        {r.note && <span className="xs muted">{r.note}</span>}
                        <Reason r={r} />
                      </div>
                    </div>
                  </td>
                  <td>
                    <span className="mono xs nowrap" title={r.sku}>
                      {r.sku}
                    </span>
                  </td>
                  <td className="r">
                    <span className="num">{money(r.price)}</span>
                  </td>
                  <td className="r">
                    <StockCell n={r.stock} />
                  </td>
                  <td>
                    <span className="small">{r.condition}</span>
                  </td>
                  <td>
                    <StatusBadge status={r.review} />
                  </td>
                  <td>
                    <StatusBadge status={r.publication} />
                  </td>
                  <td className="col-pin">
                    <div className="row gap-1 nowrap">
                      {rowAction(r)}
                      <IconButton icon="ellipsis" label={`More actions for ${r.sku}`} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
        {visible.length === 0 && (
          <EmptyState icon="search-x" title="No offers match these filters">
            Clear the search or choose another tab.
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
            Showing {visible.length} of {PRODUCT_TOTAL} offers
          </span>
          <Pager page={page} total={3} onPage={setPage} />
        </div>
      </section>
      <ul className="card sa-ocards only-phone">
        {visible.map((r) => (
          <li key={r.sku}>
            <div className="row nowrap top gap-3">
              <Img icon={r.icon} tint={r.tint} className="thumb" />
              <div className="stack gap-1 grow">
                <Link className="small strong" to={href(r.link.id, r.link.view)}>
                  {r.name}
                </Link>
                <span className="xs muted">
                  {r.variant} · {r.sku} · {r.condition}
                </span>
                <span className="row gap-2">
                  <b className="num small">{money(r.price)}</b>
                  <span className="xs muted">Stock {r.stock}</span>
                </span>
              </div>
            </div>
            <div className="row gap-2">
              <StatusBadge status={r.review} />
              <StatusBadge status={r.publication} />
            </div>
            {r.note && <span className="xs muted">{r.note}</span>}
            <Reason r={r} />
            <div className="row gap-2">{rowAction(r, true)}</div>
          </li>
        ))}
      </ul>
      <LazyLoad />
      <p className="xs muted row gap-1 nowrap top">
        <Icon name="info" className="ic-sm" />
        <span className="wrap">An approved product can still show no offer to customers when stock is 0 or the offer is hidden. A restriction on one seller does not remove other sellers' offers.</span>
      </p>

      <Dialog
        open={view === 'add-product'}
        onClose={() => setView(selected.size ? 'rows-selected' : '')}
        title="Add a product"
        foot={
          <>
            <Button variant="ghost" onClick={() => setView(selected.size ? 'rows-selected' : '')}>
              Cancel
            </Button>
            <Button to={addChoice === 'match' ? href('seller/catalog-match') : href('seller/product-new')}>Continue</Button>
          </>
        }
      >
        <p className="small sub">Most products are already in the catalog. Adding your offer to an existing product keeps one page for customers and is faster to approve.</p>
        <label className={addChoice === 'match' ? 'opt-card is-selected' : 'opt-card'} htmlFor="sp-add-match">
          <input type="radio" name="sp-add" id="sp-add-match" checked={addChoice === 'match'} onChange={() => setAddChoice('match')} />
          <span className="stack gap-1 grow">
            <span className="row gap-2">
              <b>Sell a product already in the catalog</b>
              <Badge tone="brand">Recommended</Badge>
            </span>
            <span className="small sub">Search by name, model number or GTIN, then add your price, condition and stock. No product review needed when the product is approved.</span>
          </span>
        </label>
        <label className={addChoice === 'new' ? 'opt-card is-selected' : 'opt-card'} htmlFor="sp-add-new">
          <input type="radio" name="sp-add" id="sp-add-new" checked={addChoice === 'new'} onChange={() => setAddChoice('new')} />
          <span className="stack gap-1 grow">
            <b>Create a new product</b>
            <span className="small sub">For items not in the catalog. You add category, specifications, variations, images and identifiers. The Catalog team reviews it before it can be published, usually within 2 business days.</span>
          </span>
        </label>
      </Dialog>

      <Dialog
        open={bulk !== null}
        onClose={() => setBulk(null)}
        title={bulk === 'price' ? 'Change price' : 'Update stock'}
        size="sm"
        foot={
          <>
            <Button variant="ghost" onClick={() => setBulk(null)}>
              Cancel
            </Button>
            <Button onClick={applyBulk}>Apply to {selected.size} offers</Button>
          </>
        }
      >
        <p className="small sub">
          {selRows.map((r) => r.sku).join(', ')}
        </p>
        {bulk === 'price' ? (
          <Field label="Change prices by" hint="Use a negative number to lower prices, like −5." error={bulkError}>
            <TextInput id="sp-bulk-v" inputMode="decimal" suffix="%" value={bulkValue} error={!!bulkError} onChange={(e) => setBulkValue(e.target.value.replace('−', '-'))} />
          </Field>
        ) : (
          <Field label="New available quantity" hint="Recorded with the reason &quot;Bulk update&quot; and your name." error={bulkError}>
            <TextInput id="sp-bulk-v" type="number" min={0} value={bulkValue} error={!!bulkError} onChange={(e) => setBulkValue(e.target.value)} />
          </Field>
        )}
      </Dialog>
    </SellerLayout>
  );
}
