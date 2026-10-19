import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useDeferredValue, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { call, errorMessage, useApi } from '@marketly/web-shared/api';
import { AdminLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { formatMoney, num } from '@marketly/web-shared/lib/format';
import { useView } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import { Alert, Button, Dialog, EmptyState, Field, Icon, Img, Meter, PageHeader, Pager, StatusBadge, StatusLegend, SearchInput, Tabs, TableWrap, Textarea } from '@marketly/web-shared/ui';
import { useStaffSession } from '@/app/session';
import { LoadError, SkeletonLines } from '@/app/parts';
import { CATALOG_TABS, flattenCategories, inReview, PUBLICATION_LABEL, REVIEW_LABEL, rowEdge, TAB_QUERY, type CatalogTab, type CategoryNode, type ProductAdmin, type PublicationKey, type ReviewStateKey } from './data/catalog';

// Design: pages/admin/admin-catalog.html · view "bulk-selection" = rows selected, bulk bar shown.
// API: GET /api/admin/catalog/products (+ /stats, /categories, /brands, sellers list for filters);
// Reads need catalog.view. Bulk Hide/Suspend → POST /products/{id}/publication per product (Hide sends no reason: the
// server records its default text, G68); Request changes → POST /products/{id}/request-changes;
// Export → POST /products/exports.

type Filters = { cat: string; brand: string; seller: string; review: string; missing: string; pub: string };
const NO_FILTERS: Filters = { cat: '', brand: '', seller: '', review: '', missing: '', pub: '' };
type Opt = { value: string; label: string };

const EDGE_SR = { flagged: 'Urgent: ', warn: 'At risk: ' } as const;
const EDGE_LEGEND = {
  flagged: { tone: 'danger' as const, label: 'Red edge = urgent: suspended or rejected' },
  warn: { tone: 'warning' as const, label: 'Amber edge = at risk: duplicate suspected, changes requested or content below target' },
};
const PAGE_SIZE = 20;

/** Content score bands: below 70 is below target, 70–84 near target. */
function scoreBand(score: number) {
  if (score < 70) return { tone: 'danger' as const, note: 'Below target' };
  if (score < 85) return { tone: 'warning' as const, note: 'Near target' };
  return { tone: 'success' as const, note: '' };
}

const rowKey = (r: ProductAdmin) => r.product.ref ?? r.product.title;
const rowLink = (r: ProductAdmin) => (inReview(r) ? href('admin/product-review', '', undefined, { id: r.product.id }) : href('store/product', '', { slug: r.product.slug, id: r.product.id }));
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const catLabel = (r: ProductAdmin) => (r.product.categoryPath ?? []).join(' › ') || 'No category';

function EdgeLegend({ rows }: { rows: ProductAdmin[] }) {
  const items = (['flagged', 'warn'] as const).filter((e) => rows.some((r) => rowEdge(r) === e)).map((e) => EDGE_LEGEND[e]);
  return items.length ? <StatusLegend items={items} /> : null;
}

type BulkMode = 'changes' | 'suspend';

export default function Catalog() {
  const { api } = useApi();
  const qc = useQueryClient();
  const { can } = useStaffSession();
  const [view, setView] = useView<'bulk-selection'>();
  const [tab, setTab] = useState<CatalogTab>('all');
  const [q, setQ] = useState('');
  const term = useDeferredValue(q.trim());
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [selected, setSelected] = useState<Map<string, ProductAdmin>>(() => new Map());
  const [tipOpen, setTipOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [notice, setNotice] = useState<{ tone: 'success' | 'warning'; text: string } | null>(null);
  const [bulk, setBulk] = useState<BulkMode | null>(null);
  const [reason, setReason] = useState('');
  const [reasonTried, setReasonTried] = useState(false);
  const [actionError, setActionError] = useState('');

  const canPublish = can('catalog.products.publish');
  const canReview = can('catalog.products.review');
  const canExport = can('catalog.products.export');
  const canView = can('catalog.view');

  const stats = useQuery({ queryKey: ['catalog', 'products', 'stats'], queryFn: () => call(api.GET('/api/admin/catalog/products/stats')), enabled: canView });
  const cats = useQuery({ queryKey: ['catalog', 'categories', 'admin'], queryFn: () => call(api.GET('/api/admin/catalog/categories')), enabled: canView });
  const brands = useQuery({ queryKey: ['catalog', 'brands', 'options'], queryFn: () => call(api.GET('/api/admin/catalog/brands', { params: { query: { limit: 100 } } })), enabled: canView });
  const sellers = useQuery({ queryKey: ['sellers', 'options'], queryFn: () => call(api.GET('/api/admin/sellers/sellers', { params: { query: { limit: 100 } } })), enabled: can('sellers.accounts.view') });

  const query = {
    ...TAB_QUERY[tab],
    q: term || undefined,
    categoryId: filters.cat || undefined,
    brandId: filters.brand || undefined,
    sellerId: filters.seller || undefined,
    reviewState: filters.review || undefined,
    ...(filters.missing ? { missingContent: true } : {}),
    ...(filters.pub ? { publication: filters.pub as PublicationKey } : {}),
  };
  const list = useQuery({
    queryKey: ['catalog', 'products', 'list', query, page],
    queryFn: () => call(api.GET('/api/admin/catalog/products', { params: { query: { ...query, page, limit: PAGE_SIZE } } })),
    placeholderData: keepPreviousData,
    enabled: canView,
  });
  const visible = list.data?.items ?? [];
  const totalPages = Math.max(1, (list.data as { totalPages?: number } | undefined)?.totalPages ?? 1);

  const FILTERS: Array<{ key: keyof Filters; id: string; label: string; any: string; options: Opt[] }> = [
    { key: 'cat', id: 'aa-c-cat', label: 'Category', any: 'All categories', options: flattenCategories((cats.data ?? []) as CategoryNode[]).map((c) => ({ value: c.id, label: c.label })) },
    { key: 'brand', id: 'aa-c-brand', label: 'Brand', any: 'All brands', options: (brands.data?.items ?? []).map((b) => ({ value: b.brand.id, label: b.brand.name })) },
    { key: 'seller', id: 'aa-c-seller', label: 'Seller', any: 'Any seller', options: (sellers.data?.items ?? []).map((s) => ({ value: s.id, label: s.storeName })) },
    { key: 'review', id: 'aa-c-review', label: 'Approval state', any: 'Any state', options: (Object.keys(REVIEW_LABEL) as ReviewStateKey[]).map((k) => ({ value: k, label: REVIEW_LABEL[k] })) },
    { key: 'missing', id: 'aa-c-miss', label: 'Missing content', any: 'Any', options: [{ value: 'yes', label: 'Missing content' }] },
    { key: 'pub', id: 'aa-c-pub', label: 'Publication', any: 'Any', options: (Object.keys(PUBLICATION_LABEL) as PublicationKey[]).map((k) => ({ value: k, label: PUBLICATION_LABEL[k] })) },
  ];

  // Keep the selection and ?view=bulk-selection in step (back button, links).
  useEffect(() => {
    if (view === '' && selected.size > 0) setSelected(new Map());
    if (view === 'bulk-selection') setTipOpen(true);
  }, [view]);

  const select = (next: Map<string, ProductAdmin>) => {
    setSelected(next);
    const want = next.size > 0 ? 'bulk-selection' : '';
    if (want !== view) setView(want, { replace: true });
    if (next.size === 0) setTipOpen(false);
  };

  const allOn = visible.length > 0 && visible.every((r) => selected.has(r.product.id));
  const someOn = !allOn && visible.some((r) => selected.has(r.product.id));
  const toggleAll = () => {
    const next = new Map(selected);
    visible.forEach((r) => (allOn ? next.delete(r.product.id) : next.set(r.product.id, r)));
    select(next);
  };
  const toggle = (r: ProductAdmin) => {
    const next = new Map(selected);
    if (next.has(r.product.id)) next.delete(r.product.id);
    else next.set(r.product.id, r);
    select(next);
  };

  /** Runs one request per selected product and reports how many went through. */
  const runBulk = useMutation({
    mutationFn: async ({ mode, text }: { mode: BulkMode | 'hide'; text: string }) => {
      const rows = [...selected.values()];
      const results = await Promise.allSettled(
        rows.map((r) => {
          const id = r.product.id;
          if (mode === 'changes') return call(api.POST('/api/admin/catalog/products/{id}/request-changes', { params: { path: { id } }, body: { reason: text, fields: {} } }));
          return call(api.POST('/api/admin/catalog/products/{id}/publication', { params: { path: { id } }, body: { publication: mode === 'hide' ? 'hidden' : 'suspended', reason: text || undefined } }));
        }),
      );
      const failed = results.flatMap((res, i) => (res.status === 'rejected' ? [{ row: rows[i], error: res.reason }] : []));
      return { mode, done: rows.length - failed.length, failed };
    },
    onSuccess: ({ mode, done, failed }) => {
      void qc.invalidateQueries({ queryKey: ['catalog', 'products'] });
      void qc.invalidateQueries({ queryKey: ['workqueues', 'queues'] });
      const what =
        mode === 'hide'
          ? `${plural(done, 'product')} hidden. Customers can't find ${done === 1 ? 'it' : 'them'} in search or categories until shown again.`
          : mode === 'suspend'
            ? `${plural(done, 'product')} suspended. Their offers stop showing; open orders continue.`
            : `Change request sent for ${plural(done, 'product')}. Sellers see your note and resubmit for review.`;
      const fail = failed.length ? ` ${plural(failed.length, 'product')} not changed: ${failed.map((f) => `${rowKey(f.row)} (${errorMessage(f.error)})`).join('; ')}` : '';
      setNotice({ tone: failed.length ? 'warning' : 'success', text: (done ? what : '') + fail });
      select(new Map());
      setBulk(null);
    },
    onError: (e) => setActionError(errorMessage(e)),
  });

  const exportList = useMutation({
    mutationFn: () => call(api.POST('/api/admin/catalog/products/exports', { body: { filters: query, format: 'csv' } })),
    onSuccess: () => setNotice({ tone: 'success', text: 'Export started. The file appears in Reports › Exports when it is ready.' }),
    onError: (e) => setNotice({ tone: 'warning', text: errorMessage(e) }),
  });

  const reasonError = reasonTried && !reason.trim() ? (bulk === 'suspend' ? 'Enter the reason for suspending.' : 'Enter what the sellers need to change.') : '';
  const openBulk = (mode: BulkMode) => {
    setReason('');
    setReasonTried(false);
    setActionError('');
    setBulk(mode);
  };
  const sendBulk = () => {
    setReasonTried(true);
    if (!reason.trim() || !bulk) return;
    runBulk.mutate({ mode: bulk, text: reason.trim() });
  };
  const hide = () => runBulk.mutate({ mode: 'hide', text: '' });

  const setFilter = (k: keyof Filters, v: string) => {
    setFilters((f) => ({ ...f, [k]: v }));
    setPage(1);
  };

  const s = stats.data;
  const loading = canView && list.isPending;

  return (
    <AdminLayout active="catalog">
      <PageHeader
        crumbs={[{ label: 'Catalog' }, { label: 'Products' }]}
        title="Products"
        sub={s ? `${num(s.all)} shared products · ${num(s.offers)} offers` : canView ? 'Loading…' : undefined}
        actions={
          <>
            {canExport && (
              <Button variant="secondary" size="sm" icon="download" onClick={() => exportList.mutate()} disabled={exportList.isPending}>
                Export
              </Button>
            )}
            <Button variant="secondary" size="sm" icon="list-checks" to={href('admin/product-review')}>
              {s ? `Review queue · ${num(s.inReview)}` : 'Review queue'}
            </Button>
            {can('catalog.products.manage-official') && (
              <Button size="sm" icon="plus" to={href('admin/official')}>
                Add product
              </Button>
            )}
          </>
        }
      />
      {notice && <Alert tone={notice.tone} title={notice.text} />}
      <section className="card">
        <Tabs
          items={CATALOG_TABS.map((t) => ({ value: t.value, label: t.label, count: s ? num(s[t.stat]) : undefined }))}
          active={tab}
          onChange={(t) => {
            setTab(t);
            setPage(1);
          }}
          label="Product status"
        />
        <div className="card-body">
          <div className="toolbar">
            <SearchInput
              id="aa-c-q"
              placeholder="Search by name, brand, SKU, UPC or model number"
              value={q}
              onChange={(v) => {
                setQ(v);
                setPage(1);
              }}
              label="Search products"
            />
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
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
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
              {canPublish ? (
                <Button variant="ghost" icon="eye-off" onClick={hide} disabled={runBulk.isPending}>
                  Hide
                </Button>
              ) : (
                <span className="aa-tip" tabIndex={0}>
                  <Button variant="ghost" icon="lock" disabled>
                    Hide
                  </Button>
                  <span className="aa-tipbox" role="tooltip">
                    Needs the Catalog publish permission.
                  </span>
                </span>
              )}
              {canReview ? (
                <Button variant="ghost" icon="message-square-warning" onClick={() => openBulk('changes')} disabled={runBulk.isPending}>
                  Request changes
                </Button>
              ) : (
                <span className="aa-tip" tabIndex={0}>
                  <Button variant="ghost" icon="lock" disabled>
                    Request changes
                  </Button>
                  <span className="aa-tipbox" role="tooltip">
                    Needs the Catalog review permission.
                  </span>
                </span>
              )}
              <span className={cx('aa-tip', tipOpen && 'is-open')} tabIndex={0} onMouseLeave={() => setTipOpen(false)} onBlur={() => setTipOpen(false)}>
                <Button variant="ghost" icon="lock" disabled>
                  Bulk price and stock update
                </Button>
                <span className="aa-tipbox" role="tooltip">
                  {can('catalog.products.bulk-edit')
                    ? 'Prices and stock belong to each offer: sellers update their own, and Official Store prices change in Official Store › Price file.'
                    : 'Needs the Catalog bulk edit permission. Ask a Catalog Manager or request access in Staff and roles.'}
                </span>
              </span>
              {canPublish ? (
                <Button variant="ghost" icon="ban" onClick={() => openBulk('suspend')} disabled={runBulk.isPending}>
                  Suspend
                </Button>
              ) : (
                <span className="aa-tip" tabIndex={0}>
                  <Button variant="ghost" icon="lock" disabled>
                    Suspend
                  </Button>
                  <span className="aa-tipbox" role="tooltip">
                    Only staff with the Catalog publish permission can suspend products. Suspending needs a recorded reason and explains the effect on open orders.
                  </span>
                </span>
              )}
              <Button variant="ghost" onClick={() => select(new Map())}>
                Clear
              </Button>
            </div>
          </div>
        ) : (
          <div className="xs muted u-p-0-sp-4-sp-3">
            <Icon name="info" className="ic-sm" /> Select products to hide, request changes or update in bulk. Bulk price, stock and suspension need extra permissions.
          </div>
        )}
        {!canView && (
          <div className="card-body">
            <p className="small muted">Your role doesn’t include viewing the catalog.</p>
          </div>
        )}
        {list.isError && (
          <div className="card-body">
            <LoadError error={list.error} onRetry={() => void list.refetch()} />
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
                {loading && (
                  <tr>
                    <td colSpan={9}>
                      <SkeletonLines rows={6} />
                    </td>
                  </tr>
                )}
                {visible.map((r) => {
                  const band = scoreBand(r.contentScore);
                  const edge = rowEdge(r);
                  const p = r.product;
                  return (
                    <tr key={p.id} className={cx(edge && `is-${edge}`)}>
                      <td className="col-check">
                        {edge && <span className="sr-only">{EDGE_SR[edge]}</span>}
                        <input type="checkbox" aria-label={`Select ${rowKey(r)}`} checked={selected.has(p.id)} onChange={() => toggle(r)} />
                      </td>
                      <td>
                        <span className="cell-main">
                          <Img icon="package" src={p.images?.[0]?.url} className="tiny" />
                          <span className="stack gap-0">
                            <Link className="small strong clamp-2" to={rowLink(r)}>
                              {p.title}
                            </Link>
                            <span className="xs muted">
                              {r.reviewState === 'approved' ? (
                                <>
                                  <span className="mono nowrap" title={p.ref ?? ''}>
                                    {p.ref}
                                  </span>
                                  {r.offerNote && ` · ${r.offerNote}`}
                                </>
                              ) : (
                                <>
                                  {r.submission?.ref ?? 'New submission'}
                                  {r.owner === 'official' && ' · Official Store'}
                                </>
                              )}
                            </span>
                          </span>
                        </span>
                      </td>
                      <td>{p.brand?.name ?? r.requestedBrand?.name ?? '—'}</td>
                      <td>
                        <span className="small nowrap">{catLabel(r)}</span>
                      </td>
                      <td className="r">{num(r.offerCount)}</td>
                      <td className="r">{r.bestPrice ? formatMoney(r.bestPrice) : '—'}</td>
                      <td>
                        <StatusBadge status={REVIEW_LABEL[r.reviewState]} />
                      </td>
                      <td>
                        <StatusBadge status={PUBLICATION_LABEL[r.publication]} />
                      </td>
                      <td className="col-pin">
                        <span className="stack gap-1 minw-110">
                          <span className="row between xs">
                            <span className="strong num">{r.contentScore}</span>
                            <span className="muted">/ 100</span>
                          </span>
                          <Meter pct={r.contentScore} tone={band.tone} label={`Content score: ${rowKey(r)}`} />
                          {band.note && <span className={`xs strong meter-note t-${band.tone}-text`}>{band.note}</span>}
                          {r.missing[0] && <span className="xs t-warning-text strong">{r.missing.length > 1 ? `${r.missing[0]} +${r.missing.length - 1}` : r.missing[0]}</span>}
                        </span>
                      </td>
                    </tr>
                  );
                })}
                {canView && !loading && !list.isError && visible.length === 0 && (
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
            {loading && <SkeletonLines rows={4} />}
            {visible.slice(0, 10).map((r) => {
              const edge = rowEdge(r);
              return (
                <Link key={r.product.id} className={cx('aa-mcard', edge && `is-${edge}`)} to={rowLink(r)}>
                  {edge && <span className="sr-only">{EDGE_SR[edge]}</span>}
                  <span className="row nowrap top gap-3">
                    <Img icon="package" src={r.product.images?.[0]?.url} className="tiny" />
                    <span className="stack gap-1 grow">
                      <span className="small strong clamp-2">{r.product.title}</span>
                      <span className="xs muted">
                        {r.product.brand?.name ?? '—'} · {catLabel(r)} · {plural(r.offerCount, 'offer')}
                        {r.bestPrice ? ` · from ${formatMoney(r.bestPrice)}` : ''}
                      </span>
                    </span>
                  </span>
                  <span className="row gap-2">
                    <StatusBadge status={REVIEW_LABEL[r.reviewState]} />
                    <StatusBadge status={PUBLICATION_LABEL[r.publication]} />
                    <span className="xs muted">Content {r.contentScore}/100</span>
                  </span>
                  {r.missing[0] && <span className="xs t-warning-text strong">{r.missing[0]}</span>}
                </Link>
              );
            })}
            {canView && !loading && !list.isError && visible.length === 0 && (
              <EmptyState icon="search-x" title="No products match these filters">
                Try another tab or clear a filter.
              </EmptyState>
            )}
          </div>
          <EdgeLegend rows={visible.slice(0, 10)} />
        </div>
        <div className="card-foot between">
          <span className="xs muted">Hiding or suspending a product does not remove other sellers' valid offers from past orders. Purchase snapshots keep the terms accepted at purchase.</span>
          <Pager page={page} total={totalPages} onPage={setPage} />
        </div>
      </section>

      <Dialog
        open={bulk !== null}
        onClose={() => setBulk(null)}
        title={bulk === 'suspend' ? `Suspend ${plural(selected.size, 'product')}` : `Request changes on ${plural(selected.size, 'product')}`}
        foot={
          <>
            <Button variant="ghost" onClick={() => setBulk(null)}>
              Cancel
            </Button>
            <Button icon={bulk === 'suspend' ? 'ban' : 'send'} onClick={sendBulk} disabled={runBulk.isPending}>
              {bulk === 'suspend' ? 'Suspend products' : 'Send change request'}
            </Button>
          </>
        }
      >
        {actionError && <Alert tone="danger" title={actionError} />}
        {bulk === 'suspend' ? (
          <p className="small sub">Offers on these products stop showing until a Catalog Manager activates them again. Open orders, returns and cases continue with their purchase snapshots.</p>
        ) : (
          <p className="small sub">The submitter of each product in review gets your note. Products that are not waiting for review are left unchanged and listed after sending.</p>
        )}
        <Field label={bulk === 'suspend' ? 'Reason' : 'What needs to change'} hint={bulk === 'suspend' ? 'Required. Recorded in the product history.' : 'Required. Shown to the sellers.'} error={reasonError}>
          <Textarea id="aa-c-bulk-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </Dialog>
    </AdminLayout>
  );
}
