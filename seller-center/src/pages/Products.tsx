import { useEffect, useState } from 'react';
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import { ApiError, call, errorMessage, useApi } from '@marketly/web-shared/api';
import { SellerLayout } from '@marketly/web-shared/layouts';
import { useIsPhone, useView } from '@marketly/web-shared/lib/hooks';
import { formatMoney } from '@marketly/web-shared/lib/format';
import { href } from '@marketly/web-shared/routes';
import { Alert, Badge, Button, Dialog, EmptyState, Field, Icon, IconButton, Img, LazyLoad, Pager, SearchInput, StatusBadge, StatusLegend, TableWrap, Tabs, TextInput, announce } from '@marketly/web-shared/ui';
import { useSellerSession } from '@/app/session';
import { LoadError, SkeletonRows, openDownload, useDebounced, useInView, useSellerSettings, waitForExport, type StockState } from './data/catalog-parts';
import { CATEGORIES, flattenCategories, rowFromOffer, rowFromProduct, type CategoryNode, type ProductRow } from './data/products';

// Design: pages/seller/seller-products.html · views "rows-selected" (rows ticked, bulk bar) and
// "add-product" (the Add a product dialog). Data: GET offers/offers (+ counts for the tabs), own products
// without an offer from GET catalog/products (page 1), categories from the GraphQL category tree,
// GET settings/current (large price change %).
// Bulk actions: POST offers/price-changes, POST inventory/adjustments/batch (reason bulk_update),
// POST offers/offers/bulk-pause, POST offers/offers/{id}/resume, POST offers/offers/exports.
// Own never-listed products: POST catalog/products/{id}/withdraw, DELETE catalog/products/{id}.

type View = 'rows-selected' | 'add-product';
type Tab = 'all' | 'active' | 'draft' | 'submitted' | 'changes' | 'rejected' | 'hidden';
type OfferQuery = {
  q?: string;
  status?: 'draft' | 'active' | 'paused' | 'out_of_stock' | 'ineligible' | 'removed';
  categoryId?: string;
  stockState?: StockState;
  productReviewState?: 'draft' | 'submitted' | 'changes_requested' | 'approved' | 'rejected';
  productPublication?: 'active' | 'hidden' | 'suspended';
  hiddenOrSuspended?: boolean;
  missingContent?: 'images' | 'identifiers';
};

const LIMIT = 24;

const TAB_QUERY: Record<Tab, OfferQuery> = {
  all: {},
  active: { status: 'active' },
  // The design's Draft tab = offers on product drafts the seller hasn't submitted (count productDraft).
  draft: { productReviewState: 'draft' },
  submitted: { productReviewState: 'submitted' },
  changes: { productReviewState: 'changes_requested' },
  rejected: { productReviewState: 'rejected' },
  hidden: { hiddenOrSuspended: true },
};
/** Own products without an offer are listed on these tabs (their catalog review state). */
const TAB_REVIEW: Partial<Record<Tab, 'draft' | 'submitted' | 'changes_requested' | 'rejected' | undefined>> = { all: undefined, draft: 'draft', submitted: 'submitted', changes: 'changes_requested', rejected: 'rejected' };

const TABS: Array<{ value: Tab; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'draft', label: 'Draft' },
  { value: 'submitted', label: 'Submitted' },
  { value: 'changes', label: 'Changes requested' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'hidden', label: 'Hidden or suspended' },
];

// Publication of the product in the catalog (list filter productPublication); Active also needs a live offer.
// Offers hidden by the seller show under the Hidden or suspended tab.
const PUB_QUERY: Record<string, OfferQuery> = {
  'Any publication': {},
  Active: { productPublication: 'active', status: 'active' },
  Hidden: { productPublication: 'hidden' },
  Suspended: { productPublication: 'suspended' },
  'Not published': { status: 'draft' },
};
const CONTENT_QUERY: Record<string, OfferQuery> = {
  'Any content': {},
  'Missing images': { missingContent: 'images' },
  'Missing identifiers': { missingContent: 'identifiers' },
  'Low stock': { stockState: 'low_stock' },
};

const edge = (r: ProductRow): '' | 'is-warn' | 'is-flagged' => (r.reason ? (r.reason.danger ? 'is-flagged' : 'is-warn') : '');

function StockCell({ r }: { r: ProductRow }) {
  if (r.stock === null) return <span className="num muted">—</span>;
  if (r.stockState === 'out_of_stock' || r.stock === 0)
    return (
      <span className="num t-danger-text strong">
        {r.stock}
        <span className="xs"> · Out</span>
      </span>
    );
  if (r.stockState === 'low_stock')
    return (
      <span className="num t-warning-text strong">
        {r.stock}
        <span className="xs"> · Low</span>
      </span>
    );
  return <span className="num">{r.stock}</span>;
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

type BulkMode = 'price' | 'stock';

export default function Products() {
  const navigate = useNavigate();
  const { api, gql } = useApi();
  const qc = useQueryClient();
  const { sellerId, can } = useSellerSession();
  const isPhone = useIsPhone();
  const [view, setView] = useView<View>();
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [tab, setTab] = useState<Tab>('all');
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const [pub, setPub] = useState('Any publication');
  const [content, setContent] = useState('Any content');
  const [page, setPage] = useState(1);
  const [addChoice, setAddChoice] = useState<'match' | 'new'>('match');
  const [bulk, setBulk] = useState<BulkMode | null>(null);
  const [bulkValue, setBulkValue] = useState('');
  const [bulkTried, setBulkTried] = useState(false);
  const [bulkConfirm, setBulkConfirm] = useState(false);
  const largePct = useSellerSettings().num('offers.largeSellerPriceChangePct');
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger' | 'warning'; text: string } | null>(null);

  const search = useDebounced(q.trim());
  const filter: OfferQuery = { ...TAB_QUERY[tab], ...PUB_QUERY[pub], ...CONTENT_QUERY[content], ...(search ? { q: search } : {}), ...(cat ? { categoryId: cat } : {}) };
  useEffect(() => setPage(1), [search, tab, pub, content, cat]);

  const counts = useQuery({ queryKey: ['offers', 'counts', sellerId], queryFn: () => call(api.GET('/api/seller/offers/offers/counts')) });
  const categories = useQuery({
    queryKey: ['catalog', 'categories', 'seller'],
    queryFn: async () => flattenCategories((await gql<{ categories: CategoryNode[] }>(CATEGORIES)).data?.categories ?? []),
    staleTime: 10 * 60_000,
  });
  const pageQ = useQuery({
    queryKey: ['offers', 'list', sellerId, filter, page],
    queryFn: () => call(api.GET('/api/seller/offers/offers', { params: { query: { ...filter, page, limit: LIMIT } } })),
    enabled: !isPhone,
    placeholderData: keepPreviousData,
  });
  const phoneQ = useInfiniteQuery({
    queryKey: ['offers', 'list', sellerId, 'cursor', filter],
    initialPageParam: '',
    queryFn: ({ pageParam }) => call(api.GET('/api/seller/offers/offers', { params: { query: { ...filter, limit: LIMIT, ...(pageParam ? { cursor: pageParam } : {}) } } })),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: isPhone,
  });
  // Own products that have no offer yet (drafts saved before a variation had a price, approved products whose offers ended).
  const productOnly = tab in TAB_REVIEW && pub === 'Any publication' && content === 'Any content' && !cat;
  const bare = useQuery({
    queryKey: ['catalog', 'products', sellerId, TAB_REVIEW[tab] ?? 'all', search],
    queryFn: () => call(api.GET('/api/seller/catalog/products', { params: { query: { limit: 100, ...(TAB_REVIEW[tab] ? { reviewState: TAB_REVIEW[tab] } : {}), ...(search ? { q: search } : {}) } } })),
    enabled: productOnly && (isPhone || page === 1),
  });

  const active = isPhone ? phoneQ : pageQ;
  const offerRows = (isPhone ? (phoneQ.data?.pages.flatMap((p) => p.items) ?? []) : (pageQ.data?.items ?? [])).map(rowFromOffer);
  const bareRows = productOnly && (isPhone || page === 1) ? (bare.data?.items ?? []).filter((p) => p.offerCount === 0).map(rowFromProduct) : [];
  const visible = [...bareRows, ...offerRows];
  const loaded = isPhone ? !!phoneQ.data : !!pageQ.data;
  const total = pageQ.data?.total ?? offerRows.length;
  const totalPages = pageQ.data?.totalPages ?? 1;
  const more = useInView<HTMLDivElement>(() => void phoneQ.fetchNextPage(), isPhone && phoneQ.hasNextPage && !phoneQ.isFetchingNextPage);

  const c = counts.data;
  const tabCount: Record<Tab, number | undefined> = c
    ? { all: c.all, active: c.active, draft: c.productDraft, submitted: c.productSubmitted, changes: c.productChangesRequested, rejected: c.productRejected, hidden: c.hiddenOrSuspended }
    : { all: undefined, active: undefined, draft: undefined, submitted: undefined, changes: undefined, rejected: undefined, hidden: undefined };

  const selectable = visible.filter((r) => r.offerId);
  const visibleSel = selectable.filter((r) => selected.has(r.key));
  const allOn = selectable.length > 0 && visibleSel.length === selectable.length;
  const someOn = visibleSel.length > 0 && !allOn;
  const selRows = visible.filter((r) => selected.has(r.key) && r.offerId);
  // ?view=rows-selected opened directly: tick the first two offers once they have loaded.
  const firstTwo = selectable.slice(0, 2).map((r) => r.key).join(',');
  useEffect(() => {
    if (view === 'rows-selected' && selected.size === 0 && firstTwo) setSelected(new Set(firstTwo.split(',')));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstTwo]);

  const syncView = (next: Set<string>) => {
    if (view === 'add-product') return;
    setView(next.size ? 'rows-selected' : '', { replace: true });
  };
  const updateSel = (next: Set<string>) => {
    setSelected(next);
    syncView(next);
  };
  const toggle = (key: string) => {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    updateSel(next);
  };
  const toggleAll = () => {
    const next = new Set(selected);
    if (allOn) selectable.forEach((r) => next.delete(r.key));
    else selectable.forEach((r) => next.add(r.key));
    updateSel(next);
  };
  const clear = () => updateSel(new Set());
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['offers'] });
    void qc.invalidateQueries({ queryKey: ['inventory'] });
  };

  const hide = useMutation({
    mutationFn: (offerIds: string[]) => call(api.POST('/api/seller/offers/offers/bulk-pause', { body: { offerIds } })),
    onSuccess: (res) => {
      const results = res.results as Array<{ offerId: string; ok: boolean; error?: { message: string } | null }>;
      const n = results.filter((x) => x.ok).length;
      const failed = results.filter((x) => !x.ok).map((x) => `${selRows.find((r) => r.offerId === x.offerId)?.sku ?? x.offerId}: ${x.error?.message ?? 'not hidden'}`);
      const msg = `${n} offer${n === 1 ? '' : 's'} hidden. Customers no longer see ${n === 1 ? 'it' : 'them'}.`;
      setNotice(failed.length ? { tone: 'warning', text: `${msg} Not hidden: ${failed.join('; ')}` } : { tone: 'success', text: msg });
      announce(msg);
      clear();
      refresh();
    },
    onError: (e) => setNotice({ tone: 'danger', text: errorMessage(e) }),
  });
  const show = useMutation({
    mutationFn: (r: ProductRow) => call(api.POST('/api/seller/offers/offers/{id}/resume', { params: { path: { id: r.offerId! } } })),
    onSuccess: (_, r) => {
      announce(`${r.sku} is visible to customers again`);
      setNotice({ tone: 'success', text: `${r.sku} is visible to customers again.` });
      refresh();
    },
    onError: (e) => setNotice({ tone: 'danger', text: errorMessage(e) }),
  });
  const exporter = useMutation({
    mutationFn: async (offerIds: string[]) => {
      const job = await call(api.POST('/api/seller/offers/offers/exports', { body: { offerIds, format: 'csv' } }));
      return waitForExport(job, (id) => call(api.GET('/api/seller/offers/offers/exports/{id}', { params: { path: { id } } })));
    },
    onSuccess: (job) => {
      openDownload(job.downloadUrl!, job.fileName);
      announce(`Exported ${job.rowCount ?? selRows.length} offers`);
    },
    onError: (e) => setNotice({ tone: 'danger', text: errorMessage(e) }),
  });
  const hideSelected = () => {
    const ids = selRows.filter((r) => r.offerStatus === 'active' || r.offerStatus === 'out_of_stock').map((r) => r.offerId!);
    if (!ids.length) {
      announce('Only active offers can be hidden.');
      setNotice({ tone: 'warning', text: 'Only active offers can be hidden.' });
      return;
    }
    hide.mutate(ids);
  };

  const bulkApply = useMutation({
    mutationFn: async ({ mode, value, confirm }: { mode: BulkMode; value: number; confirm?: boolean }) => {
      const rows = selRows;
      if (mode === 'price') {
        const items = rows.filter((r) => r.price).map((r) => ({ offerId: r.offerId!, price: { amount: Math.max(1, Math.round((r.price!.amount * (100 + value)) / 100)), currency: r.price!.currency } }));
        const res = await call(api.POST('/api/seller/offers/price-changes', { body: { items, ...(confirm ? { confirmLargeChange: true } : {}) } }));
        // Changes over the large-change limit come back unconfirmed per offer: ask, then send them again with the confirmation.
        if (!confirm && res.results.some((x) => x.error?.code === 'LARGE_PRICE_CHANGE_UNCONFIRMED')) throw new ApiError(409, 'LARGE_PRICE_CHANGE_UNCONFIRMED', 'Confirm the large price change.');
        return { ok: res.results.filter((x) => x.ok).length, failed: res.results.filter((x) => !x.ok).map((x) => `${rows.find((r) => r.offerId === x.offerId)?.sku ?? x.offerId}: ${x.error?.message ?? 'not changed'}`) };
      }
      const items = rows.filter((r) => r.stockItemId).map((r) => ({ stockItemId: r.stockItemId!, newAvailable: value, reasonCode: 'bulk_update' as const }));
      const res = await call(api.POST('/api/seller/inventory/adjustments/batch', { body: { items, note: 'Bulk stock update from Products and offers' } }));
      const bySid = new Map(rows.map((r) => [r.stockItemId, r.sku]));
      return { ok: res.results.filter((x) => x.ok).length, failed: res.results.filter((x) => !x.ok).map((x) => `${bySid.get(x.stockItemId) ?? x.stockItemId}: ${x.error?.message ?? 'not changed'}`) };
    },
    onSuccess: ({ ok, failed }, { mode, value }) => {
      const msg = mode === 'price' ? `Price changed by ${value}% on ${ok} offer${ok === 1 ? '' : 's'}` : `Stock set to ${value} on ${ok} offer${ok === 1 ? '' : 's'}`;
      announce(msg);
      setNotice(failed.length ? { tone: 'warning', text: `${msg}. Not changed: ${failed.join('; ')}` } : { tone: 'success', text: `${msg}.` });
      setBulk(null);
      refresh();
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'LARGE_PRICE_CHANGE_UNCONFIRMED') setBulkConfirm(true);
    },
  });

  const openBulk = (m: BulkMode) => {
    setBulk(m);
    setBulkValue('');
    setBulkTried(false);
    setBulkConfirm(false);
    bulkApply.reset();
  };
  const bulkNum = Number(bulkValue);
  const bulkOk = bulk === 'price' ? bulkValue.trim() !== '' && Number.isFinite(bulkNum) && bulkNum !== 0 && bulkNum > -100 : bulkValue.trim() !== '' && Number.isInteger(bulkNum) && bulkNum >= 0;
  const unconfirmed = bulkApply.error instanceof ApiError && bulkApply.error.code === 'LARGE_PRICE_CHANGE_UNCONFIRMED';
  const bulkError = !bulkTried || bulkOk ? (bulkApply.error && !unconfirmed ? errorMessage(bulkApply.error) : '') : bulk === 'price' ? 'Enter a change in percent, like 5 or −5 (more than −100%).' : 'Enter a whole number of 0 or more.';
  // Over the seller large-change limit the change needs an explicit confirmation (the server asks for it too).
  const isLarge = bulk === 'price' && bulkOk && largePct !== undefined && Math.abs(bulkNum) > largePct;
  const applyBulk = () => {
    setBulkTried(true);
    if (!bulkOk || !bulk) return;
    if (isLarge && !bulkConfirm) return setBulkConfirm(true);
    bulkApply.mutate({ mode: bulk, value: bulkNum, confirm: bulk === 'price' && bulkConfirm });
  };

  /* ---------------- own never-listed products: withdraw the submission, delete the draft */
  const [manageRow, setManageRow] = useState<ProductRow | null>(null);
  const manage = useMutation({
    mutationFn: (r: ProductRow) =>
      r.manage === 'withdraw'
        ? call(api.POST('/api/seller/catalog/products/{id}/withdraw', { params: { path: { id: r.productId } }, body: {} }))
        : call(api.DELETE('/api/seller/catalog/products/{id}', { params: { path: { id: r.productId } } })),
    onSuccess: (_, r) => {
      const msg = r.manage === 'withdraw' ? `${r.name} is back to draft. It left the review queue; edit it and submit again when you’re ready.` : `${r.name} was deleted with its draft offers.`;
      setNotice({ tone: 'success', text: msg });
      announce(msg);
      setManageRow(null);
      clear();
      refresh();
      void qc.invalidateQueries({ queryKey: ['catalog'] });
    },
  });
  const canSubmit = can('catalog.products.submit');
  const manageButton = (r: ProductRow, phone?: boolean) =>
    r.manage && canSubmit ? (
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        onClick={() => {
          manage.reset();
          setManageRow(r);
        }}
      >
        <span>{r.manage === 'withdraw' ? 'Withdraw submission' : 'Delete draft'}</span>
        {!phone && <span className="sr-only"> {r.sku || r.name}</span>}
      </button>
    ) : null;

  const rowAction = (r: ProductRow, phone?: boolean) => {
    const a = r.action;
    const sr = phone ? null : <span className="sr-only"> {r.sku || r.name}</span>;
    if (a.kind === 'link' && a.to)
      return (
        <Link className={`btn btn-${a.variant} btn-sm`} to={a.to}>
          <span>{a.label}</span>
          {sr}
        </Link>
      );
    if (a.kind === 'show' && !can('offers.offers.manage')) return null;
    const onClick = a.kind === 'show' ? () => show.mutate(r) : a.help ? () => navigate(href('seller/help', 'contact-seller-support')) : () => navigate(href('seller/store'));
    return (
      <button type="button" className={`btn btn-${a.variant} btn-sm`} onClick={onClick} disabled={a.kind === 'show' && show.isPending}>
        <span>{a.label}</span>
        {sr}
      </button>
    );
  };

  const hasDanger = visible.some((r) => edge(r) === 'is-flagged');
  const hasWarn = visible.some((r) => edge(r) === 'is-warn');
  const filtering = !!search || !!cat || pub !== 'Any publication' || content !== 'Any content';
  const canAdd = can('offers.offers.manage') || can('catalog.products.submit');

  return (
    <SellerLayout active="products">
      <div className="page-head">
        <div className="t">
          <h1 className="h1">Products and offers</h1>
          <p className="sub small">{c ? `${c.all} offer${c.all === 1 ? '' : 's'} across ${c.productCount} product${c.productCount === 1 ? '' : 's'}. ` : ''}Review state and publication are tracked separately.</p>
        </div>
        <div className="actions">
          {can('offers.bulk.update') && (
            <Button variant="secondary" size="sm" icon="upload" to={href('seller/bulk-update')}>
              Bulk update
            </Button>
          )}
          {canAdd && (
            <Button size="sm" icon="plus" onClick={() => setView('add-product')}>
              Add product
            </Button>
          )}
        </div>
      </div>
      {notice && (
        <Alert tone={notice.tone} title={notice.tone === 'danger' ? 'That didn’t work' : undefined}>
          {notice.text}
        </Alert>
      )}
      <Tabs
        items={TABS.map((t) => ({ ...t, count: tabCount[t.value] }))}
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
          <option value="">All categories</option>
          {(categories.data ?? []).map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
        <label className="sr-only" htmlFor="sp-pub">
          Publication
        </label>
        <select className="select" id="sp-pub" value={pub} onChange={(e) => setPub(e.target.value)}>
          {Object.keys(PUB_QUERY).map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
        <label className="sr-only" htmlFor="sp-miss">
          Content
        </label>
        <select className="select" id="sp-miss" value={content} onChange={(e) => setContent(e.target.value)}>
          {Object.keys(CONTENT_QUERY).map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
      </div>
      {selected.size > 0 && (
        <div className="bulk-bar" role="region" aria-label="Bulk actions">
          <span>{selected.size} selected</span>
          <span className="grow" />
          {can('offers.prices.manage') && (
            <Button variant="ghost" size="sm" icon="tag" onClick={() => openBulk('price')}>
              Change price
            </Button>
          )}
          {can('inventory.stock.adjust') && (
            <Button variant="ghost" size="sm" icon="boxes" onClick={() => openBulk('stock')}>
              Update stock
            </Button>
          )}
          {can('offers.offers.manage') && (
            <Button variant="ghost" size="sm" icon="eye-off" onClick={hideSelected} disabled={hide.isPending}>
              Hide offers
            </Button>
          )}
          {can('offers.offers.export') && (
            <Button variant="ghost" size="sm" icon="download" onClick={() => exporter.mutate(selRows.map((r) => r.offerId!))} disabled={exporter.isPending}>
              {exporter.isPending ? 'Exporting…' : 'Export'}
            </Button>
          )}
          <Button variant="ghost" size="sm" icon="x" onClick={clear}>
            Clear
          </Button>
        </div>
      )}
      {active.isError && !loaded ? (
        <LoadError error={active.error} onRetry={() => void active.refetch()} />
      ) : (
        <>
          <section className="card no-phone">
            {!loaded ? (
              <SkeletonRows rows={5} />
            ) : (
              <TableWrap label="Products and offers table">
                <table className="table">
                  <thead>
                    <tr>
                      <th className="col-check">
                        <input
                          type="checkbox"
                          aria-label="Select all"
                          checked={allOn}
                          disabled={!selectable.length}
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
                      <tr key={r.key} className={edge(r)}>
                        <td className="col-check">
                          {edge(r) && <span className="sr-only">{edge(r) === 'is-flagged' ? 'Urgent: ' : 'At risk: '}</span>}
                          <input type="checkbox" aria-label={`Select ${r.sku || r.name}`} checked={selected.has(r.key)} disabled={!r.offerId} onChange={() => toggle(r.key)} />
                        </td>
                        <td>
                          <div className="cell-main minw-280">
                            <Img icon={r.icon} tint={r.tint} src={r.image} className="tiny" />
                            <div className="stack gap-0">
                              <Link className="small strong" to={r.link}>
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
                            {r.sku || '—'}
                          </span>
                        </td>
                        <td className="r">
                          <span className="num">{r.price ? formatMoney(r.price) : '—'}</span>
                        </td>
                        <td className="r">
                          <StockCell r={r} />
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
                            {manageButton(r)}
                            {r.offerId ? <IconButton icon="ellipsis" label={`More actions for ${r.sku}`} onClick={() => navigate(r.link)} /> : null}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            )}
            {loaded && visible.length === 0 && (
              <EmptyState icon="search-x" title={filtering || tab !== 'all' ? 'No offers match these filters' : 'No products or offers yet'}>
                {filtering || tab !== 'all' ? 'Clear the search or choose another tab.' : 'Add a product to start selling: find it in the catalog or create a new one.'}
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
            {loaded && (
              <div className="card-foot between">
                <span className="xs muted">
                  Showing {offerRows.length} of {total} offer{total === 1 ? '' : 's'}
                  {bareRows.length ? ` · ${bareRows.length} product${bareRows.length === 1 ? '' : 's'} without an offer` : ''}
                </span>
                {totalPages > 1 && <Pager page={page} total={totalPages} onPage={setPage} only="website" />}
              </div>
            )}
          </section>
          <ul className="card sa-ocards only-phone">
            {!loaded && (
              <li>
                <SkeletonRows rows={3} />
              </li>
            )}
            {visible.map((r) => (
              <li key={r.key}>
                <div className="row nowrap top gap-3">
                  <Img icon={r.icon} tint={r.tint} src={r.image} className="thumb" />
                  <div className="stack gap-1 grow">
                    <Link className="small strong" to={r.link}>
                      {r.name}
                    </Link>
                    <span className="xs muted">{[r.variant, r.sku, r.condition].filter(Boolean).join(' · ')}</span>
                    <span className="row gap-2">
                      <b className="num small">{r.price ? formatMoney(r.price) : '—'}</b>
                      {r.stock !== null && <span className="xs muted">Stock {r.stock}</span>}
                    </span>
                  </div>
                </div>
                <div className="row gap-2">
                  <StatusBadge status={r.review} />
                  <StatusBadge status={r.publication} />
                </div>
                {r.note && <span className="xs muted">{r.note}</span>}
                <Reason r={r} />
                <div className="row gap-2">
                  {rowAction(r, true)}
                  {manageButton(r, true)}
                </div>
              </li>
            ))}
            {loaded && visible.length === 0 && (
              <li>
                <EmptyState icon="search-x" title="No offers match these filters">
                  Clear the search or choose another tab.
                </EmptyState>
              </li>
            )}
          </ul>
          {isPhone && loaded && <div ref={more}>{phoneQ.hasNextPage ? <LazyLoad /> : <LazyLoad end />}</div>}
        </>
      )}
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
          <input type="radio" name="sp-add" id="sp-add-match" checked={addChoice === 'match'} onChange={() => setAddChoice('match')} disabled={!can('offers.offers.manage')} />
          <span className="stack gap-1 grow">
            <span className="row gap-2">
              <b>Sell a product already in the catalog</b>
              <Badge tone="brand">Recommended</Badge>
            </span>
            <span className="small sub">Search by name, model number or GTIN, then add your price, condition and stock. No product review needed when the product is approved.</span>
          </span>
        </label>
        <label className={addChoice === 'new' ? 'opt-card is-selected' : 'opt-card'} htmlFor="sp-add-new">
          <input type="radio" name="sp-add" id="sp-add-new" checked={addChoice === 'new'} onChange={() => setAddChoice('new')} disabled={!can('catalog.products.submit')} />
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
            <Button onClick={applyBulk} disabled={bulkApply.isPending}>
              {bulkApply.isPending ? 'Applying…' : bulkConfirm ? `Confirm for ${selRows.length} offers` : `Apply to ${selRows.length} offers`}
            </Button>
          </>
        }
      >
        <p className="small sub">{selRows.map((r) => r.sku).join(', ')}</p>
        {bulk === 'price' ? (
          <Field label="Change prices by" hint="Use a negative number to lower prices, like −5." error={bulkError}>
            <TextInput
              id="sp-bulk-v"
              inputMode="decimal"
              suffix="%"
              value={bulkValue}
              error={!!bulkError}
              onChange={(e) => {
                setBulkValue(e.target.value.replace('−', '-'));
                setBulkConfirm(false);
                if (unconfirmed) bulkApply.reset();
              }}
            />
          </Field>
        ) : (
          <Field label="New available quantity" hint="Recorded as a bulk update with your name. Reserved units are not affected." error={bulkError}>
            <TextInput id="sp-bulk-v" type="number" min={0} value={bulkValue} error={!!bulkError} onChange={(e) => setBulkValue(e.target.value)} />
          </Field>
        )}
        {bulk === 'price' && bulkConfirm && (
          <Alert tone="warning" title="That’s a large price change">
            {largePct !== undefined ? `Changes over ${largePct}% need your confirmation.` : 'Some of these changes are over the large-change limit.'} Check the amount, then confirm to change the prices.
          </Alert>
        )}
      </Dialog>

      <Dialog
        open={manageRow !== null}
        onClose={() => setManageRow(null)}
        title={manageRow?.manage === 'withdraw' ? 'Withdraw this submission?' : 'Delete this draft?'}
        size="sm"
        foot={
          <>
            <Button variant="ghost" onClick={() => setManageRow(null)}>
              Cancel
            </Button>
            <Button variant={manageRow?.manage === 'delete' ? 'danger' : 'primary'} onClick={() => manageRow && manage.mutate(manageRow)} disabled={manage.isPending}>
              {manage.isPending ? 'Working…' : manageRow?.manage === 'withdraw' ? 'Withdraw submission' : 'Delete draft'}
            </Button>
          </>
        }
      >
        <p className="small sub">
          {manageRow?.manage === 'withdraw'
            ? `${manageRow.name} leaves the Catalog team’s review queue and goes back to draft. You can edit it and submit it again.`
            : `${manageRow?.name ?? ''} is removed with its variations, draft offers and review history. This can’t be undone.`}
        </p>
        {manage.isError && <Alert tone="danger">{errorMessage(manage.error)}</Alert>}
      </Dialog>
    </SellerLayout>
  );
}
