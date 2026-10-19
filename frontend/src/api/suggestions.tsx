import { useEffect, useState, type MouseEvent } from 'react';
import { Link } from 'react-router';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { call, useApi } from '@marketly/web-shared/api';
import { cx } from '@marketly/web-shared/lib/cx';
import { formatMoney } from '@marketly/web-shared/lib/format';
import { href } from '@marketly/web-shared/routes';
import { Badge, Icon, IconButton } from '@marketly/web-shared/ui';
import { initialsOf, tintOf } from './catalog';
import { LogoPic, Pic } from './cards';
import { productHref } from './search';

// The search suggestions panel under the header search field (design: store-search--suggestions-open):
// GET /api/store/search/suggestions while typing, GET /api/store/search/recent-searches when the field
// is empty, and removing recent searches (DELETE …/recent-searches[/{id}]).

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

const searchHref = (q: string, extra?: Record<string, string>) => href('store/search', '', undefined, { q, ...extra });

export function SearchSuggestions({ typed, onClose }: { typed: string; onClose: () => void }) {
  const { api } = useApi();
  const qc = useQueryClient();
  const q = useDebounced(typed.trim(), 180);
  const sugg = useQuery({
    queryKey: ['search', 'suggestions', q],
    queryFn: () => call(api.GET('/api/store/search/suggestions', { params: { query: { q, limit: 5 } } })),
    enabled: q.length > 0,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
  const recentQ = useQuery({
    queryKey: ['search', 'recent-searches'],
    queryFn: () => call(api.GET('/api/store/search/recent-searches')),
    enabled: q.length === 0,
  });
  const clearAll = useMutation({
    mutationFn: () => call(api.DELETE('/api/store/search/recent-searches')),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['search'] }),
  });
  const removeOne = useMutation({
    mutationFn: (id: string) => call(api.DELETE('/api/store/search/recent-searches/{id}', { params: { path: { id } } })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['search'] }),
  });

  const data = q ? sugg.data : undefined;
  const recent = (q ? data?.recent : recentQ.data) ?? [];
  const queries = data?.queries ?? [];
  const scoped = (data?.categories ?? []).filter((c) => c.categoryScope);
  const brands = data?.brands ?? [];
  const stores = data?.stores ?? [];
  const products = data?.products ?? [];
  const left = queries.length + scoped.length + brands.length + stores.length;

  const onClear = (e: MouseEvent) => {
    e.preventDefault();
    clearAll.mutate();
  };

  return (
    <div className="shop-sugg-wrap">
      <div className="shop-sugg" role="region" aria-label="Search suggestions">
        <div className="shop-sugg-grid">
          <div>
            <h3>Suggestions</h3>
            {queries.map((s, i) => (
              <Link key={s.text} className={cx('it', i === 0 && 'is-hl')} to={searchHref(s.text)}>
                <Icon name="search" />
                <span>
                  <span className="q">{s.text.slice(0, s.matchedPrefix.length)}</span>
                  <b>{s.text.slice(s.matchedPrefix.length)}</b>
                </span>
              </Link>
            ))}
            {scoped.map((s) =>
              s.categoryScope!.name === s.text ? (
                <Link key={`c-${s.categoryScope!.id}`} className="it" to={href('store/category', '', { slug: s.categoryScope!.slug })}>
                  <Icon name="folder-tree" />
                  <span>
                    <b>{s.categoryScope!.name}</b>
                  </span>
                </Link>
              ) : (
                <Link key={`c-${s.categoryScope!.id}`} className="it" to={searchHref(s.text, { category: s.categoryScope!.slug })}>
                  <Icon name="folder-tree" />
                  <span>
                    <span className="q">{s.text}</span> in <b>{s.categoryScope!.name}</b>
                  </span>
                </Link>
              ),
            )}
            {q && !left && !sugg.isFetching && (
              <Link className="it is-hl" to={searchHref(q)}>
                <Icon name="search" />
                <span>
                  Search for <b>{q}</b>
                </span>
              </Link>
            )}
            {!q && !left && <span className="xs muted" style={{ padding: 'var(--sp-2) var(--sp-3)' }}>Start typing to see suggestions.</span>}
            {brands.length > 0 && (
              <>
                <h3>Brands</h3>
                {brands.map((b) => (
                  <Link key={b.brandId} className="it" to={href('store/brand', '', { slug: b.slug })}>
                    <LogoPic logo={b.logo} initials={initialsOf(b.name)} tint={tintOf(b.name)} size="sm" />
                    <span className="stack gap-0">
                      <span className="strong">{b.name}</span>
                      <span className="xs muted">Brand · {b.productCount} products</span>
                    </span>
                  </Link>
                ))}
              </>
            )}
            {stores.length > 0 && (
              <>
                <h3>Stores</h3>
                {stores.map((s) => (
                  <Link key={s.sellerId} className="it" to={href('store/seller', '', { slug: s.slug })}>
                    <LogoPic logo={s.logo} initials={initialsOf(s.name)} tint={tintOf(s.name)} size="sm" />
                    <span className="stack gap-0 grow">
                      <span className="row gap-2">
                        <span className="strong">{s.name}</span>
                        {s.verified && (
                          <Badge tone="info" icon="shield-check">
                            Verified
                          </Badge>
                        )}
                      </span>
                      <span className="xs muted">{s.summary || `Seller store · ${s.productCount} products`}</span>
                    </span>
                    <span className="small strong t-brand-text nowrap">Visit store</span>
                  </Link>
                ))}
              </>
            )}
          </div>
          <div>
            {recent.length > 0 && (
              <>
                <div className="row between" style={{ paddingRight: 'var(--sp-3)' }}>
                  <h3>Recent searches</h3>
                  <a className="xs strong" href="#" onClick={onClear} aria-disabled={clearAll.isPending || undefined}>
                    Clear all
                  </a>
                </div>
                {recent.map((r) => (
                  <div key={r.id} className="recent">
                    <Link to={searchHref(r.query)}>
                      <Icon name="history" />
                      <span>{r.query}</span>
                    </Link>
                    <IconButton icon="x" label={`Remove “${r.query}” from recent searches`} onClick={() => removeOne.mutate(r.id)} />
                  </div>
                ))}
              </>
            )}
            {products.length > 0 && (
              <>
                <h3>Products</h3>
                {products.map((p) => (
                  <Link key={p.productId} className="it" to={productHref({ id: p.productId, slug: p.slug })}>
                    <Pic image={p.image} className="tiny" />
                    <span className="stack gap-0">
                      <span className="small truncate">{p.title}</span>
                      <span className="xs muted">
                        {formatMoney(p.fromPrice)}
                        {p.sellerName ? ` · ${p.sellerName}` : ''}
                      </span>
                    </span>
                  </Link>
                ))}
              </>
            )}
            <p className="xs muted" style={{ padding: 'var(--sp-2) var(--sp-3)' }}>
              Recent searches are saved to your account (on this device when you're not signed in). Turn them off in{' '}
              <Link to={href('account/profile')} className="link-inline">
                Profile
              </Link>
              .
            </p>
          </div>
        </div>
      </div>
      <div className="shop-sugg-scrim" aria-hidden="true" onClick={onClose} />
    </div>
  );
}
