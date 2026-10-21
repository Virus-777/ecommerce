import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { announce, Badge, Button, EmptyState, IconButton, Img, PageHeader, SearchInput, Alert } from '@marketly/web-shared/ui';
import { call, errorMessage, useApi } from '@marketly/web-shared/api';
import { formatMoney } from '@marketly/web-shared/lib/format';
import { useStaffSession } from '@/app/session';
import { LoadError, SkeletonLines, shortDate } from '@/app/parts';
import { DeptPage, plural, type ProductCard } from './data/departments';

// Admin › Departments › Phones (designed in React from the Marketly Departments canvas): the phones of the app's Phone
// tab, picked one by one and kept in order. API: GET/PUT /api/admin/departments/phones; products are found with
// GET /api/admin/catalog/products?q= (the Products page search).

const MAX = 100;
type Pick = { id: string; title: string; brand?: string | null; image?: string | null; price?: string | null; shown: boolean; stock?: ProductCard['availability'] };

const STOCK: Record<ProductCard['availability'], { label: string; tone: 'success' | 'warning' | 'danger' }> = {
  in_stock: { label: 'In stock', tone: 'success' },
  low_stock: { label: 'Low stock', tone: 'warning' },
  out_of_stock: { label: 'Out of stock', tone: 'danger' },
};

export default function DeptPhones() {
  const { api } = useApi();
  const qc = useQueryClient();
  const { can } = useStaffSession();
  const canView = can('departments.view');
  const canEdit = can('departments.phones.manage');
  const [draft, setDraft] = useState<string[] | null>(null);
  // titles of products added in this session, before they are saved and come back as cards
  const [added, setAdded] = useState<Record<string, Pick>>({});
  const [q, setQ] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const picks = useQuery({ queryKey: ['departments', 'phones'], enabled: canView, queryFn: () => call(api.GET('/api/admin/departments/phones')) });
  const term = q.trim();
  const search = useQuery({
    queryKey: ['catalog', 'products', 'phone-search', term],
    enabled: canEdit && term.length >= 2,
    queryFn: () => call(api.GET('/api/admin/catalog/products', { params: { query: { q: term, publication: 'active', limit: 8 } } })),
  });

  const saved = picks.data?.productIds ?? [];
  const ids = draft ?? saved;
  const dirty = draft !== null && (draft.length !== saved.length || draft.some((id, i) => id !== saved[i]));
  const cards = new Map((picks.data?.products ?? []).map((c) => [c.productId, c]));
  const pickOf = (id: string): Pick => {
    const c = cards.get(id);
    if (c) return { id, title: c.title, brand: c.brandName, image: c.image?.url, price: formatMoney(c.price), shown: true, stock: c.availability };
    return added[id] ?? { id, title: 'Product not shown in the store', shown: false };
  };

  const set = (next: string[]) => {
    setDraft(next);
    setNotice('');
  };
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    const next = [...ids];
    [next[i], next[j]] = [next[j], next[i]];
    set(next);
    announce(`${pickOf(ids[i]).title} moved ${dir < 0 ? 'up' : 'down'}`);
  };

  const save = useMutation({
    mutationFn: () => call(api.PUT('/api/admin/departments/phones', { body: { productIds: ids } })),
    onSuccess: (d) => {
      qc.setQueryData(['departments', 'phones'], d);
      setDraft(null);
      setError('');
      const msg = `Phone tab saved: ${plural(d.productIds.length, 'phone')}. The app shows the new order now.`;
      setNotice(msg);
      announce(msg);
    },
    onError: (e) => setError(errorMessage(e)),
  });

  const results = (search.data?.items ?? []).filter((r) => !ids.includes(r.product.id));

  return (
    <DeptPage active="dept-phones" title="Phones" canView={canView}>
      <PageHeader
        crumbs={[{ label: 'Departments' }, { label: 'Phones' }]}
        title="Phones"
        sub={`The Phone tab of the app’s Phones department · ${canEdit ? 'pick the phones one by one and order them' : 'view only: editing needs the Phones permission'}${picks.data?.updatedAt ? ` · saved ${shortDate(picks.data.updatedAt)}` : ''}`}
        actions={
          canEdit && (
            <>
              <Button variant="ghost" size="sm" onClick={() => setDraft(null)} disabled={!dirty || save.isPending}>
                Discard changes
              </Button>
              <Button size="sm" icon="check" onClick={() => save.mutate()} disabled={!dirty || !ids.length || save.isPending}>
                Save
              </Button>
            </>
          )
        }
      />
      {notice && <Alert tone="success" title={notice} />}
      {error && (
        <Alert tone="danger" title="The phones weren’t saved">
          {error}
        </Alert>
      )}
      <Alert tone="info" title="OS install and Post-sale services come later">
        The app shows those two tabs as coming soon until their services are set up.
      </Alert>
      <div className="ab-main">
        <section className="card">
          <div className="card-head">
            <div className="stack gap-0">
              <h2 className="h4">Picked phones</h2>
              <span className="xs muted">
                Shown in this order · {plural(ids.length, 'phone')} of {MAX}
                {dirty ? ' · unsaved changes' : ''}
              </span>
            </div>
          </div>
          {picks.isError ? (
            <div className="card-body">
              <LoadError error={picks.error} onRetry={() => void picks.refetch()} />
            </div>
          ) : picks.isPending ? (
            <div className="card-body">
              <SkeletonLines rows={5} />
            </div>
          ) : ids.length === 0 ? (
            <div className="card-body">
              <EmptyState icon="smartphone" title="No phones picked yet">
                Search the catalog on the right and add the phones the Phone tab should show.
              </EmptyState>
            </div>
          ) : (
            <ul className="list pad">
              {ids.map((id, i) => {
                const p = pickOf(id);
                return (
                  <li key={id}>
                    <span className="xs muted num">{i + 1}</span>
                    <Img icon="smartphone" src={p.image ?? undefined} alt="" className="tiny" />
                    <span className="grow stack gap-0">
                      <span className="small strong truncate">{p.title}</span>
                      <span className="xs muted">
                        {p.shown ? [p.brand, p.price].filter(Boolean).join(' · ') : 'Hidden, suspended or without a live offer: the app leaves it out until it sells again'}
                      </span>
                    </span>
                    {p.stock ? <Badge tone={STOCK[p.stock].tone}>{STOCK[p.stock].label}</Badge> : !p.shown && <Badge tone="warning" icon="eye-off">Not shown</Badge>}
                    {canEdit && (
                      <>
                        <IconButton icon="arrow-up" label={`Move ${p.title} up`} disabled={i === 0} onClick={() => move(i, -1)} />
                        <IconButton icon="arrow-down" label={`Move ${p.title} down`} disabled={i === ids.length - 1} onClick={() => move(i, 1)} />
                        <IconButton icon="x" label={`Remove ${p.title}`} onClick={() => set(ids.filter((x) => x !== id))} />
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {canEdit && (
          <section className="card">
            <div className="card-head">
              <div className="stack gap-0">
                <h2 className="h4">Add phones</h2>
                <span className="xs muted">Active catalog products</span>
              </div>
            </div>
            <div className="card-body stack gap-3">
              <SearchInput id="dp-q" placeholder="Search products by name" value={q} onChange={setQ} label="Search products" />
              {term.length < 2 ? (
                <span className="xs muted">Type at least two letters.</span>
              ) : search.isError ? (
                <LoadError error={search.error} onRetry={() => void search.refetch()} />
              ) : search.isPending ? (
                <SkeletonLines rows={3} />
              ) : results.length === 0 ? (
                <span className="small muted">No products to add for “{term}”.</span>
              ) : (
                <ul className="list">
                  {results.map((r) => (
                    <li key={r.product.id}>
                      <Img icon="package" src={r.product.images?.[0]?.url} alt="" className="tiny" />
                      <span className="grow stack gap-0">
                        <span className="small truncate">{r.product.title}</span>
                        <span className="xs muted">
                          {[r.product.brand?.name, r.bestPrice ? `from ${formatMoney(r.bestPrice)}` : 'No live offer'].filter(Boolean).join(' · ')}
                        </span>
                      </span>
                      <Button
                        variant="secondary"
                        size="sm"
                        icon="plus"
                        disabled={ids.length >= MAX}
                        onClick={() => {
                          setAdded((a) => ({ ...a, [r.product.id]: { id: r.product.id, title: r.product.title, brand: r.product.brand?.name, image: r.product.images?.[0]?.url, price: r.bestPrice ? formatMoney(r.bestPrice) : null, shown: true } }));
                          set([...ids, r.product.id]);
                          announce(`${r.product.title} added`);
                        }}
                      >
                        Add<span className="sr-only"> {r.product.title}</span>
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        )}
      </div>
    </DeptPage>
  );
}
