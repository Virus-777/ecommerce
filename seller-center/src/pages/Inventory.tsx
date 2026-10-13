import { useEffect, useState } from 'react';
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { call, errorMessage, useApi, type components } from '@marketly/web-shared/api';
import { SellerLayout } from '@marketly/web-shared/layouts';
import { useIsPhone, useView } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import { Alert, Button, Dialog, EmptyState, Field, Icon, Img, LazyLoad, Pager, SearchInput, Select, StatusBadge, StatusLegend, TableWrap, Textarea, TextInput, announce } from '@marketly/web-shared/ui';
import { useSellerSession } from '@/app/session';
import { ADJUST_REASONS, LoadError, STOCK_LABEL, SkeletonRows, fmtFull, fmtWhen, iconFor, openDownload, useDebounced, useInView, waitForExport, type AdjustReason, type StockState } from './data/catalog-parts';
import { CATEGORIES, flattenCategories, offerHref, type CategoryNode } from './data/products';

// Design: pages/seller/seller-inventory.html · view "adjust-stock" = the Adjust stock dialog. Inline quantity
// edits ask for a reason before saving. Data: GET inventory/summary (KPIs), GET inventory/stock-items (q, state,
// category; pages on the website, cursor on the phone), GET inventory/movements (recent adjustments).
// Writes: POST inventory/stock-items/{id}/adjustments, POST inventory/adjustments/batch,
// POST inventory/stock-items/exports (+ GET …/exports/{id}).

type View = 'adjust-stock';
type StockRow = components['schemas']['inventory.SellerStockRow'];
type Movement = components['schemas']['inventory.Movement'];

const LIMIT = 24;
const STATUS_FILTER: Record<string, StockState | undefined> = { 'All statuses': undefined, 'In stock': 'in_stock', 'Low stock': 'low_stock', 'Out of stock': 'out_of_stock' };
/** Movements the seller or staff made (not checkout holds, order allocations or dispatches). */
const SYSTEM_REFS = new Set(['order', 'reservation']);

interface AdjustDraft {
  /** One stock item (Adjust button) or the inline edits being saved. */
  ids: string[];
  mode: 'one' | 'edits';
  qty: string;
  reason: AdjustReason;
  note: string;
}

/** Signed change to Available and the before → after quantities of a movement. */
function availableChange(m: Movement): { d: number; from: number; to: number } | null {
  const d = m.toGroup === 'available' ? m.quantity : m.fromGroup === 'available' ? -m.quantity : 0;
  if (!d) return null;
  return { d, from: m.after.available - d, to: m.after.available };
}

export default function Inventory() {
  const { api, gql } = useApi();
  const qc = useQueryClient();
  const { sellerId, can, memberName } = useSellerSession();
  const isPhone = useIsPhone();
  const [view, setView] = useView<View>();
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [q, setQ] = useState('');
  const [st, setSt] = useState('All statuses');
  const [cat, setCat] = useState('');
  const [page, setPage] = useState(1);
  const [done, setDone] = useState('');
  const [draft, setDraft] = useState<AdjustDraft>({ ids: [], mode: 'one', qty: '', reason: 'received_stock', note: '' });
  const [tried, setTried] = useState(false);
  /** Rows the dialog acts on, kept when the list refetches. */
  const [known, setKnown] = useState<Record<string, StockRow>>({});

  const search = useDebounced(q.trim());
  const filter = { ...(search ? { q: search } : {}), ...(STATUS_FILTER[st] ? { state: STATUS_FILTER[st] } : {}), ...(cat ? { categoryId: cat } : {}) };
  useEffect(() => setPage(1), [search, st, cat]);

  const summary = useQuery({ queryKey: ['inventory', 'summary', sellerId], queryFn: () => call(api.GET('/api/seller/inventory/summary')) });
  const categories = useQuery({
    queryKey: ['catalog', 'categories', 'seller'],
    queryFn: async () => flattenCategories((await gql<{ categories: CategoryNode[] }>(CATEGORIES)).data?.categories ?? []),
    staleTime: 10 * 60_000,
  });
  const pageQ = useQuery({
    queryKey: ['inventory', 'stock-items', sellerId, filter, page],
    queryFn: () => call(api.GET('/api/seller/inventory/stock-items', { params: { query: { ...filter, page, limit: LIMIT } } })),
    enabled: !isPhone,
    placeholderData: keepPreviousData,
  });
  const phoneQ = useInfiniteQuery({
    queryKey: ['inventory', 'stock-items', sellerId, 'cursor', filter],
    initialPageParam: '',
    queryFn: ({ pageParam }) => call(api.GET('/api/seller/inventory/stock-items', { params: { query: { ...filter, limit: LIMIT, ...(pageParam ? { cursor: pageParam } : {}) } } })),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: isPhone,
  });
  const movements = useQuery({
    queryKey: ['inventory', 'movements', sellerId],
    queryFn: () => call(api.GET('/api/seller/inventory/movements', { params: { query: { limit: 50 } } })),
  });

  const active = isPhone ? phoneQ : pageQ;
  const rows: StockRow[] = isPhone ? (phoneQ.data?.pages.flatMap((p) => p.items) ?? []) : (pageQ.data?.items ?? []);
  const loaded = isPhone ? !!phoneQ.data : !!pageQ.data;
  const total = pageQ.data?.total ?? rows.length;
  const totalPages = pageQ.data?.totalPages ?? 1;
  const more = useInView<HTMLDivElement>(() => void phoneQ.fetchNextPage(), isPhone && phoneQ.hasNextPage && !phoneQ.isFetchingNextPage);
  useEffect(() => {
    if (rows.length) setKnown((k) => ({ ...k, ...Object.fromEntries(rows.map((r) => [r.stockItemId, r])) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageQ.data, phoneQ.data]);

  const history = (movements.data?.items ?? []).filter((m) => !SYSTEM_REFS.has(m.reference?.kind ?? '') && availableChange(m)).slice(0, 10);
  const canAdjust = can('inventory.stock.adjust');

  // Inline edits that differ from the saved quantity.
  const changed = Object.entries(edits).filter(([id, v]) => {
    const r = known[id];
    return r && v.trim() !== '' && Number(v) !== r.available;
  });
  const invalidEdit = changed.some(([, v]) => !Number.isInteger(Number(v)) || Number(v) < 0);

  const single = draft.mode === 'one' ? known[draft.ids[0]] : undefined;
  const qtyN = Number(draft.qty);
  const qtyErr = !single || !tried ? '' : draft.qty.trim() === '' || !Number.isInteger(qtyN) || qtyN < 0 ? 'Enter a whole number of 0 or more.' : qtyN === single.available ? 'Enter a different quantity to record an adjustment.' : '';
  const diff = single && draft.qty.trim() !== '' && Number.isInteger(qtyN) ? qtyN - single.available : 0;

  const openAdjust = (r: StockRow) => {
    setDraft({ ids: [r.stockItemId], mode: 'one', qty: edits[r.stockItemId] ?? String(r.available), reason: 'received_stock', note: '' });
    setTried(false);
    adjust.reset();
    setView('adjust-stock');
  };
  // ?view=adjust-stock opened directly: the dialog opens for the first low or out-of-stock item.
  useEffect(() => {
    if (view !== 'adjust-stock' || draft.ids.length || !rows.length) return;
    const r = rows.find((x) => x.state !== 'in_stock' && !x.fulfilledByMarketly) ?? rows.find((x) => !x.fulfilledByMarketly);
    if (r) setDraft({ ids: [r.stockItemId], mode: 'one', qty: String(r.available), reason: 'received_stock', note: '' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, rows.length]);
  const openSaveEdits = () => {
    if (invalidEdit) return;
    setDraft({ ids: changed.map(([id]) => id), mode: 'edits', qty: '', reason: 'count_correction', note: '' });
    setTried(false);
    adjust.reset();
    setView('adjust-stock');
  };
  const close = () => {
    setView('');
    setDraft((d) => ({ ...d, ids: [] }));
  };

  const adjust = useMutation({
    mutationFn: async (d: AdjustDraft) => {
      const note = d.note.trim() || null;
      if (d.mode === 'one') {
        const r = known[d.ids[0]];
        await call(api.POST('/api/seller/inventory/stock-items/{id}/adjustments', { params: { path: { id: r.stockItemId } }, body: { newAvailable: Number(d.qty), reasonCode: d.reason, note } }));
        return { ok: [{ sku: r.sku, from: r.available, to: Number(d.qty) }], failed: [] as string[] };
      }
      const items = d.ids.map((id) => ({ stockItemId: id, newAvailable: Number(edits[id]), reasonCode: d.reason }));
      const res = await call(api.POST('/api/seller/inventory/adjustments/batch', { body: { items, note } }));
      return {
        ok: res.results.filter((x) => x.ok).map((x) => ({ sku: known[x.stockItemId]?.sku ?? '', from: known[x.stockItemId]?.available ?? 0, to: Number(edits[x.stockItemId]) })),
        failed: res.results.filter((x) => !x.ok).map((x) => `${known[x.stockItemId]?.sku ?? x.stockItemId}: ${x.error?.message ?? 'not saved'}`),
        okIds: res.results.filter((x) => x.ok).map((x) => x.stockItemId),
      };
    },
    onSuccess: (res, d) => {
      const savedIds = d.mode === 'one' ? d.ids : (res as { okIds?: string[] }).okIds ?? [];
      setEdits((e) => {
        const next = { ...e };
        savedIds.forEach((id) => delete next[id]);
        return next;
      });
      const msg = res.ok.length === 1 ? `Stock for ${res.ok[0].sku} changed from ${res.ok[0].from} to ${res.ok[0].to}.` : `${res.ok.length} quantities saved.`;
      setDone(res.failed.length ? `${msg} Not saved: ${res.failed.join('; ')}.` : msg);
      announce(msg);
      void qc.invalidateQueries({ queryKey: ['inventory'] });
      void qc.invalidateQueries({ queryKey: ['offers'] });
      close();
    },
  });

  const save = () => {
    setTried(true);
    if (single && (draft.qty.trim() === '' || !Number.isInteger(qtyN) || qtyN < 0 || qtyN === single.available)) return;
    if (!single && !changed.length) return;
    adjust.mutate(draft);
  };

  const exporter = useMutation({
    mutationFn: async () => {
      const job = await call(api.POST('/api/seller/inventory/stock-items/exports', { body: { filters: filter, format: 'csv' } }));
      return waitForExport(job, (id) => call(api.GET('/api/seller/inventory/stock-items/exports/{id}', { params: { path: { id } } })));
    },
    onSuccess: (job) => {
      openDownload(job.downloadUrl!, job.fileName);
      announce('Inventory exported');
    },
  });

  const s = summary.data;
  const hasDanger = rows.some((r) => r.state === 'out_of_stock');
  const hasWarn = rows.some((r) => r.state === 'low_stock');
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

  return (
    <SellerLayout active="inventory">
      <div className="page-head">
        <div className="t">
          <h1 className="h1">Inventory</h1>
          <p className="sub small">Quantities for your approved offers. Customers cannot buy more than the available quantity.</p>
        </div>
        <div className="actions">
          {can('inventory.stock.export') && (
            <Button variant="secondary" size="sm" icon="download" onClick={() => exporter.mutate()} disabled={exporter.isPending}>
              {exporter.isPending ? 'Exporting…' : 'Export'}
            </Button>
          )}
          {can('offers.bulk.update') && (
            <Button size="sm" icon="upload" to={href('seller/bulk-update')}>
              Bulk update
            </Button>
          )}
        </div>
      </div>
      {done && (
        <Alert tone="success" title="Stock updated">
          {done} The change is recorded in Recent adjustments.
        </Alert>
      )}
      {exporter.isError && (
        <Alert tone="danger" title="The export didn’t finish">
          {errorMessage(exporter.error)}
        </Alert>
      )}
      <div className="sa-kpis">
        <div className="card pad">
          <div className="stat">
            <span className="k">
              <Icon name="package-check" className="ic-sm" />
              In stock
            </span>
            <span className="v">{s ? `${s.inStockSkus} SKUs` : <span className="sk sk-line short" />}</span>
            <span className="d">{s ? `${s.inStockUnits} units available` : ''}</span>
          </div>
        </div>
        <div className="card pad">
          <div className="stat">
            <span className="k">
              <Icon name="triangle-alert" className="ic-sm" />
              Low stock
            </span>
            <span className="v">{s ? plural(s.lowStockSkus, 'SKU') : <span className="sk sk-line short" />}</span>
            <span className="d">At or below threshold</span>
          </div>
        </div>
        <div className="card pad">
          <div className="stat">
            <span className="k">
              <Icon name="package-x" className="ic-sm" />
              Out of stock
            </span>
            <span className="v">{s ? plural(s.outOfStockSkus, 'SKU') : <span className="sk sk-line short" />}</span>
            <span className="d">{s?.outOfStockLabels.length ? s.outOfStockLabels.join(', ') : 'Customers can’t buy until restocked'}</span>
          </div>
        </div>
        <div className="card pad">
          <div className="stat">
            <span className="k">
              <Icon name="lock" className="ic-sm" />
              Reserved for open orders
            </span>
            <span className="v">{s ? `${s.reservedUnits} units` : <span className="sk sk-line short" />}</span>
            <span className="d">Released only if an order is cancelled</span>
          </div>
        </div>
      </div>
      <div className="toolbar">
        <SearchInput id="inv-search" placeholder="Search product or SKU" value={q} onChange={setQ} />
        <label className="sr-only" htmlFor="inv-st">
          Stock status
        </label>
        <select className="select" id="inv-st" value={st} onChange={(e) => setSt(e.target.value)}>
          {Object.keys(STATUS_FILTER).map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
        <label className="sr-only" htmlFor="inv-cat">
          Category
        </label>
        <select className="select" id="inv-cat" value={cat} onChange={(e) => setCat(e.target.value)}>
          <option value="">All categories</option>
          {(categories.data ?? []).map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
        <span className="grow" />
        {can('offers.bulk.update') && (
          <Link className="small strong" to={href('seller/bulk-update')}>
            <Icon name="file-spreadsheet" className="ic-sm" /> Update many SKUs with a file
          </Link>
        )}
      </div>
      {active.isError && !loaded ? (
        <LoadError error={active.error} onRetry={() => void active.refetch()} />
      ) : (
        <section className="card">
          {!loaded ? (
            <SkeletonRows rows={5} />
          ) : (
            <TableWrap label="Inventory table">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Product / SKU</th>
                    <th className="r" scope="col">
                      Available
                    </th>
                    <th className="r" scope="col">
                      Reserved
                    </th>
                    <th className="r" scope="col">
                      Low-stock at
                    </th>
                    <th scope="col">Status</th>
                    <th scope="col">Last updated</th>
                    <th scope="col">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => {
                    const status = STOCK_LABEL[r.state];
                    const edge = r.state === 'out_of_stock' ? 'is-flagged' : r.state === 'low_stock' ? 'is-warn' : '';
                    const v = edits[r.stockItemId] ?? String(r.available);
                    const bad = v.trim() !== '' && (!Number.isInteger(Number(v)) || Number(v) < 0);
                    const readOnly = r.fulfilledByMarketly || !canAdjust;
                    return (
                      <tr key={r.stockItemId} className={edge}>
                        <td>
                          {edge && <span className="sr-only">{edge === 'is-flagged' ? 'Urgent: ' : 'At risk: '}</span>}
                          <div className="cell-main">
                            <Img icon={iconFor(r.productTitle)} tint="2" src={r.image?.url ?? undefined} className="tiny" />
                            <div className="stack gap-0">
                              {r.offerId ? (
                                <Link className="small strong" to={offerHref(r.offerId)}>
                                  {r.productTitle}
                                </Link>
                              ) : (
                                <span className="small strong">{r.productTitle}</span>
                              )}
                              <span className="xs muted">
                                <span className="mono nowrap" title={r.sku}>
                                  {r.sku}
                                </span>{' '}
                                · {r.variantLabel}
                              </span>
                              {r.fulfilledByMarketly && (
                                <span className="xs muted">
                                  At Marketly{r.ownLocationAvailable != null ? ` · ${r.ownLocationAvailable} at your location (not on sale)` : ''}
                                </span>
                              )}
                            </div>
                          </div>
                        </td>
                        <td className="r">
                          <label className="sr-only" htmlFor={`inv-q${i}`}>
                            Available for {r.sku}
                          </label>
                          <input
                            className={bad ? 'input sa-num is-error' : 'input sa-num'}
                            id={`inv-q${i}`}
                            type="number"
                            min={0}
                            value={v}
                            disabled={readOnly}
                            title={r.fulfilledByMarketly ? 'Marketly holds and sells this stock. Change it through the fulfillment service.' : undefined}
                            aria-invalid={bad || undefined}
                            onChange={(e) => setEdits((x) => ({ ...x, [r.stockItemId]: e.target.value }))}
                          />
                        </td>
                        <td className="r">
                          <span className="num">{r.reserved}</span>
                        </td>
                        <td className="r">
                          <span className="num">{r.lowStockThreshold ?? '—'}</span>
                        </td>
                        <td>
                          <StatusBadge status={status} />
                        </td>
                        <td>
                          <span className="xs sub">{r.lastChange ?? fmtWhen(r.updatedAt)}</span>
                        </td>
                        <td>
                          {!readOnly && (
                            <button type="button" className="btn btn-ghost btn-sm" onClick={() => openAdjust(r)}>
                              <span>Adjust</span>
                              <span className="sr-only"> {r.sku}</span>
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableWrap>
          )}
          {loaded && rows.length === 0 && (
            <EmptyState icon="search-x" title={search || cat || st !== 'All statuses' ? 'No SKUs match these filters' : 'No stock yet'}>
              {search || cat || st !== 'All statuses' ? undefined : 'Stock items are created with your offers. Add a product to start selling.'}
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
          {isPhone && loaded && <div ref={more}>{phoneQ.hasNextPage ? <LazyLoad /> : <LazyLoad end />}</div>}
          <div className="card-foot between">
            <span className="xs muted">
              {invalidEdit ? <span className="t-danger-text">Quantities must be whole numbers of 0 or more.</span> : canAdjust ? 'Changing a quantity asks you for a reason before it saves.' : 'Your role can view stock but not change it.'}
              {!isPhone && loaded && total > rows.length ? ` · ${rows.length} of ${total} SKUs` : ''}
            </span>
            {!isPhone && totalPages > 1 && <Pager page={page} total={totalPages} onPage={setPage} only="website" />}
            {canAdjust && (
              <Button size="sm" disabled={!changed.length || invalidEdit} onClick={openSaveEdits}>
                Save {changed.length} change{changed.length === 1 ? '' : 's'}
              </Button>
            )}
          </div>
        </section>
      )}
      <section className="card">
        <div className="card-head">
          <div className="stack gap-0">
            <h2 className="h4">Recent adjustments</h2>
            <span className="xs muted">Every change keeps its reason, person and time</span>
          </div>
        </div>
        {movements.isError ? (
          <div className="card-body">
            <LoadError error={movements.error} onRetry={() => void movements.refetch()} />
          </div>
        ) : !movements.data ? (
          <SkeletonRows rows={3} thumb={false} />
        ) : history.length === 0 ? (
          <EmptyState icon="history" title="No adjustments yet">
            Quantity changes you make here, bulk updates and stock received show up in this list.
          </EmptyState>
        ) : (
          <TableWrap label="Recent adjustments table">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">SKU</th>
                  <th scope="col">Change</th>
                  <th scope="col">Reason</th>
                  <th scope="col">By</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h) => {
                  const c = availableChange(h)!;
                  return (
                    <tr key={h.id}>
                      <td>{fmtWhen(h.at)}</td>
                      <td>
                        <span className="mono xs nowrap" title={h.sku}>
                          {h.sku}
                        </span>
                      </td>
                      <td>
                        <span className={c.d > 0 ? 'num t-success-text strong' : 'num t-danger-text strong'}>{c.d > 0 ? `+${c.d}` : `−${-c.d}`}</span>{' '}
                        <span className="xs muted">
                          {c.from} → {c.to}
                        </span>
                      </td>
                      <td>{[h.reasonLabel, h.note].filter(Boolean).join(' · ')}</td>
                      <td>{h.actor.name ?? (h.actor.kind === 'system' ? 'Marketly' : h.actor.kind === 'seller' ? 'Your team' : 'Marketly staff')}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableWrap>
        )}
      </section>

      <Dialog
        open={view === 'adjust-stock' && draft.ids.length > 0}
        onClose={close}
        title={single ? 'Adjust stock' : 'Save stock changes'}
        foot={
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button onClick={save} disabled={adjust.isPending || !canAdjust}>
              {adjust.isPending ? 'Saving…' : single ? 'Save adjustment' : `Save ${changed.length} change${changed.length === 1 ? '' : 's'}`}
            </Button>
          </>
        }
      >
        {adjust.isError && (
          <Alert tone="danger" title="The change wasn’t saved">
            {errorMessage(adjust.error)}
          </Alert>
        )}
        {single ? (
          <>
            <div className="row gap-3 nowrap">
              <Img icon={iconFor(single.productTitle)} tint="2" src={single.image?.url ?? undefined} className="thumb" />
              <div className="stack gap-0">
                <span className="strong">
                  {single.productTitle}, {single.variantLabel}
                </span>
                <span className="xs muted mono">{single.sku}</span>
              </div>
            </div>
            <div className="grid c2 gap-3">
              <div className="panel stack gap-0">
                <span className="xs muted">Available now</span>
                <span className="h3 num">{single.available}</span>
              </div>
              <div className="panel stack gap-0">
                <span className="xs muted">Reserved for orders</span>
                <span className="h3 num">{single.reserved}</span>
              </div>
            </div>
            <div className="grid md2">
              <Field label="New available quantity" hint={`Change: ${diff > 0 ? '+' : diff < 0 ? '−' : ''}${Math.abs(diff)} units`} error={qtyErr}>
                <TextInput id="adj-qty" type="number" min={0} value={draft.qty} error={!!qtyErr} onChange={(e) => setDraft((d) => ({ ...d, qty: e.target.value }))} />
              </Field>
              <Field label="Reason">
                <Select id="adj-reason" options={ADJUST_REASONS} value={draft.reason} onChange={(e) => setDraft((d) => ({ ...d, reason: e.target.value as AdjustReason }))} />
              </Field>
            </div>
          </>
        ) : (
          <>
            <ul className="list">
              {changed.map(([id, v]) => {
                const r = known[id];
                return (
                  <li key={id}>
                    <span className="grow stack gap-0">
                      <span className="small strong">
                        {r.productTitle}, {r.variantLabel}
                      </span>
                      <span className="xs muted mono">{r.sku}</span>
                    </span>
                    <span className="num small">
                      {r.available} → <b>{v}</b>
                    </span>
                  </li>
                );
              })}
            </ul>
            <Field label="Reason">
              <Select id="adj-reason" options={ADJUST_REASONS} value={draft.reason} onChange={(e) => setDraft((d) => ({ ...d, reason: e.target.value as AdjustReason }))} />
            </Field>
          </>
        )}
        <Field label="Note" optional hint="Helps your team and our support staff understand the change later.">
          <Textarea id="adj-note" value={draft.note} onChange={(e) => setDraft((d) => ({ ...d, note: e.target.value }))} />
        </Field>
        <div className="panel row gap-2 small">
          <Icon name="history" className="ic-sm" />
          <span>
            Recorded as <b>{memberName || 'you'}</b> · {fmtFull(new Date().toISOString())}, with the reason and note above. Reserved units are not affected.
          </span>
        </div>
      </Dialog>
    </SellerLayout>
  );
}
