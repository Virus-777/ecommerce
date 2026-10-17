import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, call, errorMessage, useApi } from '@marketly/web-shared/api';
import { formatMoney } from '@marketly/web-shared/lib/format';
import { Alert, Button, Field, IconButton, SearchInput, StatusBadge, TableWrap, TextInput, announce } from '@marketly/web-shared/ui';
import { useStaffSession } from '@/app/session';
import { SkeletonLines } from '@/app/parts';
import type { Campaign } from './data/promotions';

// Flash-sale items on admin/promotion-new (review §2a #7, A16). A flash sale covers only the offers listed here, each
// with a deal price, deal stock and a purchase limit; the backend refuses Send to Finance and Schedule until at least
// one is set ("Add flash items first").
// GET /api/admin/promotions/campaigns/{id}/flash-items and PUT …/flash-items {items} (replaces the list; items that
// already sold units are ended rather than deleted). Editing is refused while Finance reviews and after the end.
// Offers are found with GET /api/admin/offers/offers?q= (needs offers.offers.view); without that permission an
// offer can be added by its ID.

const USD = (amount: number) => ({ amount, currency: 'USD' });
const toCents = (s: string) => Math.round(Number(s.replace(/[$,\s]/g, '')) * 100);
const ITEM_STATE: Record<string, string> = { active: 'Active', sold_out: 'Sold out', ended: 'Ended' };

interface Row {
  offerId: string;
  title: string;
  /** Regular price in cents, when known (from the search or the saved item). */
  regular: number | null;
  dealPrice: string;
  dealStock: string;
  purchaseLimit: string;
  claimed: number;
  state?: string;
}

const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s.trim());

export function PromotionFlashItems({ c, percentOff }: { c: Campaign; percentOff: number }) {
  const { api } = useApi();
  const qc = useQueryClient();
  const { can } = useStaffSession();
  const editable = can('promotions.campaigns.manage') && !['in_review', 'ended', 'cancelled'].includes(c.status);
  const canSearch = can('offers.offers.view');

  const items = useQuery({ queryKey: ['promotions', 'flash-items', c.id], queryFn: () => call(api.GET('/api/admin/promotions/campaigns/{id}/flash-items', { params: { path: { id: c.id } } })) });
  const [rows, setRows] = useState<Row[] | null>(null);
  const [q, setQ] = useState('');
  const [byId, setById] = useState('');
  const [tried, setTried] = useState(false);
  const [saved, setSaved] = useState(false);

  // Start from the saved list (and again after each save).
  useEffect(() => {
    if (items.data)
      setRows(
        items.data.map((f) => ({ offerId: f.offerId, title: f.title, regular: f.regularPrice.amount, dealPrice: (f.dealPrice.amount / 100).toFixed(2), dealStock: String(f.dealStock), purchaseLimit: String(f.purchaseLimit), claimed: f.claimed, state: f.state })),
      );
  }, [items.data]);

  const term = q.trim();
  const search = useQuery({
    queryKey: ['offers', 'admin', 'flash-search', term],
    enabled: editable && canSearch && term.length >= 2,
    queryFn: () => call(api.GET('/api/admin/offers/offers', { params: { query: { q: term, status: 'active', limit: 8 } } })),
  });

  const save = useMutation({
    mutationFn: (list: Row[]) =>
      call(
        api.PUT('/api/admin/promotions/campaigns/{id}/flash-items', {
          params: { path: { id: c.id } },
          body: { items: list.map((r) => ({ offerId: r.offerId, dealPrice: USD(toCents(r.dealPrice)), dealStock: Number(r.dealStock), purchaseLimit: Number(r.purchaseLimit) })) },
        }),
      ),
    onSuccess: (out) => {
      qc.setQueryData(['promotions', 'flash-items', c.id], out);
      // The campaign's readiness ("N flash items set") and eligible offers change with the list.
      void qc.invalidateQueries({ queryKey: ['promotions', 'campaign', c.id] });
      void qc.invalidateQueries({ queryKey: ['promotions', 'price-preview', c.id] });
      setSaved(true);
      setTried(false);
      announce('Flash items saved');
    },
  });

  if (items.isPending || rows === null) return items.isError ? <Alert tone="danger" title="We couldn’t load the flash items">{errorMessage(items.error)}</Alert> : <SkeletonLines rows={2} />;

  const suggested = (regular: number | null) => (regular && percentOff > 0 ? ((regular * (100 - percentOff)) / 10000).toFixed(2) : '');
  const add = (r: Omit<Row, 'dealPrice' | 'dealStock' | 'purchaseLimit' | 'claimed'>) => {
    if (rows.some((x) => x.offerId === r.offerId)) return;
    setRows([...rows, { ...r, dealPrice: suggested(r.regular), dealStock: '', purchaseLimit: '1', claimed: 0 }]);
    setSaved(false);
  };
  const update = (i: number, k: 'dealPrice' | 'dealStock' | 'purchaseLimit', v: string) => {
    setRows(rows.map((r, n) => (n === i ? { ...r, [k]: v } : r)));
    setSaved(false);
  };
  const remove = (i: number) => {
    setRows(rows.filter((_, n) => n !== i));
    setSaved(false);
  };
  const rowError = (r: Row): string | undefined => {
    const price = toCents(r.dealPrice);
    if (!(price > 0)) return 'Enter the deal price.';
    if (r.regular != null && price >= r.regular) return 'The deal price must be below the regular price.';
    if (!/^\d+$/.test(r.dealStock) || Number(r.dealStock) < 1) return 'Enter the deal stock (at least 1).';
    if (Number(r.dealStock) < r.claimed) return `Deal stock can’t go below the ${r.claimed} units already claimed.`;
    if (!/^\d+$/.test(r.purchaseLimit) || Number(r.purchaseLimit) < 1) return 'Enter a purchase limit of at least 1.';
    return undefined;
  };
  const submit = () => {
    setTried(true);
    if (rows.some((r) => rowError(r))) return;
    save.mutate(rows);
  };
  // OFFER_NOT_ELIGIBLE / INSUFFICIENT_STOCK name the offers that failed (details.offers).
  const problems = save.error instanceof ApiError && Array.isArray(save.error.details.offers) ? (save.error.details.offers as Array<{ offerId: string; reasons?: string[]; available?: number }>) : [];
  const problemOf = (id: string) => {
    const p = problems.find((x) => x.offerId === id);
    return p ? (p.reasons?.join('; ') ?? (p.available != null ? `Only ${p.available} in stock` : 'Not accepted')) : undefined;
  };
  const results = (search.data?.items ?? []).filter((o) => !rows.some((r) => r.offerId === o.offer.id));

  return (
    <div className="stack gap-3">
      {rows.length ? (
        <TableWrap label="Flash items table">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Offer</th>
                <th scope="col">Deal price</th>
                <th scope="col">Deal stock</th>
                <th scope="col">Per customer</th>
                {editable && (
                  <th className="col-pin" scope="col">
                    <span className="sr-only">Remove</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const err = (tried && rowError(r)) || problemOf(r.offerId);
                return (
                  <tr key={r.offerId}>
                    <td>
                      <span className="ab-cell minw-200">
                        <span className="strong">{r.title}</span>
                        <span className="xs muted">
                          {r.regular != null ? `Regular ${formatMoney(USD(r.regular))}` : 'Regular price shown after saving'}
                          {r.claimed ? ` · ${r.claimed} claimed` : ''}
                        </span>
                        {r.state && r.state !== 'active' && <StatusBadge status={ITEM_STATE[r.state] ?? r.state} />}
                        {err && <span className="xs error-text">{err}</span>}
                      </span>
                    </td>
                    <td>
                      <TextInput id={`fi-${i}-price`} aria-label={`Deal price, ${r.title}`} prefix="$" inputMode="decimal" value={r.dealPrice} readOnly={!editable} onChange={(e) => update(i, 'dealPrice', e.target.value)} placeholder="" />
                    </td>
                    <td>
                      <TextInput id={`fi-${i}-stock`} aria-label={`Deal stock, ${r.title}`} inputMode="numeric" value={r.dealStock} readOnly={!editable} onChange={(e) => update(i, 'dealStock', e.target.value)} placeholder="" />
                    </td>
                    <td>
                      <TextInput id={`fi-${i}-limit`} aria-label={`Purchase limit, ${r.title}`} inputMode="numeric" value={r.purchaseLimit} readOnly={!editable} onChange={(e) => update(i, 'purchaseLimit', e.target.value)} placeholder="" />
                    </td>
                    {editable && (
                      <td className="col-pin">
                        <IconButton icon="x" label={`Remove ${r.title}`} onClick={() => remove(i)} />
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableWrap>
      ) : (
        <span className="xs muted">No flash items yet. A flash sale covers only the offers you add here; Finance can’t review it until at least one is set.</span>
      )}

      {editable && canSearch && (
        <div className="stack gap-2">
          <SearchInput id="fi-q" placeholder="Find an active offer by product, SKU or seller" value={q} onChange={setQ} />
          {term.length >= 2 &&
            (search.isPending ? (
              <SkeletonLines rows={2} />
            ) : search.isError ? (
              <span className="xs error-text">{errorMessage(search.error)}</span>
            ) : results.length ? (
              <ul className="stack gap-1">
                {results.map((o) => (
                  <li key={o.offer.id} className="row gap-2">
                    <span className="ab-cell grow min-w-0">
                      <span className="small">
                        {o.offer.productTitle}
                        {o.offer.variantLabel ? ` · ${o.offer.variantLabel}` : ''}
                      </span>
                      <span className="xs muted">
                        {o.seller.name} · {formatMoney(o.offer.price)} · SKU {o.offer.sellerSku}
                      </span>
                    </span>
                    <Button size="sm" variant="secondary" icon="plus" onClick={() => add({ offerId: o.offer.id, title: `${o.offer.productTitle}${o.offer.variantLabel ? ` · ${o.offer.variantLabel}` : ''}`, regular: o.offer.price.amount })} srLabel={o.offer.productTitle}>
                      Add
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <span className="xs muted">No active offers match.</span>
            ))}
        </div>
      )}
      {editable && !canSearch && (
        <Field label="Add an offer by its ID" hint="Your role can’t search offers. Copy the offer ID from Catalog, or ask someone with offer access.">
          <span className="row gap-2">
            <TextInput id="fi-id" value={byId} onChange={(e) => setById(e.target.value)} placeholder="" />
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                if (!isUuid(byId)) return;
                add({ offerId: byId.trim(), title: `Offer ${byId.trim().slice(0, 8)}`, regular: null });
                setById('');
              }}
            >
              Add
            </Button>
          </span>
        </Field>
      )}

      {save.isError && (
        <Alert tone="danger" title="The flash items weren’t saved">
          {errorMessage(save.error)}
        </Alert>
      )}
      {saved && !save.isError && <span className="xs t-success-text">Flash items saved.</span>}
      {editable && (
        <span className="row gap-2">
          <Button size="sm" onClick={submit} disabled={save.isPending}>
            Save flash items
          </Button>
          <span className="xs muted">Saved separately from the campaign form.</span>
        </span>
      )}
      {!editable && c.status === 'in_review' && <span className="xs muted">Locked while Finance reviews the funding.</span>}
    </div>
  );
}
