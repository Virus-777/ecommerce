import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { StoreLayout } from '@/layouts';
import { num } from '@marketly/web-shared/lib/format';
import { href } from '@marketly/web-shared/routes';
import { Breadcrumbs, Button, EmptyState, Select, TextInput } from '@marketly/web-shared/ui';
import { initialsOf, tintOf } from '@/api/catalog';
import { LoadError, LogoPic, SkLines } from '@/api/cards';
import { useAllBrands, type BrandSort } from './data/brands';

// All brands (/brands): the header and footer "Brands" links. No design of its own: the store's listing
// language (toolbar with search and sort, card grid, "Show more"). Data: GET /api/store/catalog/brands
// (?q, ?sort=name|popular, cursor batches). Each brand opens its brand page (/brand/:slug).
// The search text and sort live in the URL, so Back from a brand page returns to the same list.

const SORTS: Array<{ value: BrandSort; label: string }> = [
  { value: 'name', label: 'A to Z' },
  { value: 'popular', label: 'Most products' },
];

export default function Brands() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const sort: BrandSort = params.get('sort') === 'popular' ? 'popular' : 'name';
  // own text while typing; it becomes ?q= after 300 ms so each keystroke doesn't start a request
  const [text, setText] = useState(q);
  useEffect(() => {
    const t = setTimeout(() => {
      if (text.trim() === q) return;
      setParams(
        (p) => {
          if (text.trim()) p.set('q', text.trim());
          else p.delete('q');
          return p;
        },
        { replace: true },
      );
    }, 300);
    return () => clearTimeout(t);
  }, [text, q, setParams]);
  const setSort = (s: string) =>
    setParams(
      (p) => {
        if (s === 'popular') p.set('sort', s);
        else p.delete('sort');
        return p;
      },
      { replace: true },
    );

  const brands = useAllBrands(q, sort);
  const items = brands.data?.pages.flatMap((p) => p.items) ?? [];
  const total = brands.data?.pages[0]?.total;

  return (
    <StoreLayout nav="brands" appbar={{ title: 'Brands' }}>
      <div className="container page gap-6">
        <div className="stack gap-2">
          <Breadcrumbs className="no-phone" items={[{ label: 'Home', to: href('store/home') }, { label: 'Brands' }]} />
          <h1 className="h1 acct-h1">Brands</h1>
          <p className="sub no-phone">Every brand sold by the Official Store and approved sellers. Open a brand to see its products.</p>
        </div>
        <div className="shop-toolbar">
          <div className="grow" style={{ minWidth: 0, maxWidth: 420 }}>
            <label htmlFor="br-q" className="sr-only">
              Search brands
            </label>
            <TextInput id="br-q" type="search" icon="search" placeholder="Search brands" value={text} autoComplete="off" onChange={(e) => setText(e.target.value)} />
          </div>
          <span className="shop-sort">
            <label className="small sub nowrap" htmlFor="br-sort">
              Sort by
            </label>
            <Select id="br-sort" ctl="sm" options={SORTS} value={sort} onChange={(e) => setSort(e.target.value)} />
          </span>
        </div>
        {brands.isError && <LoadError error={brands.error} onRetry={() => void brands.refetch()} title="We couldn’t load the brands" />}
        {brands.isPending ? (
          <div className="grid-products" aria-busy="true" aria-label="Loading brands">
            {Array.from({ length: 8 }, (_, i) => (
              <div key={i} className="card pad row gap-3" aria-hidden="true">
                <span className="logo-tile" />
                <SkLines n={2} className="grow" />
              </div>
            ))}
          </div>
        ) : items.length ? (
          <>
            {total != null && (
              <span className="small sub">
                {num(total)} brand{total === 1 ? '' : 's'}
                {q ? ` matching “${q}”` : ''}
              </span>
            )}
            <ul className="grid-products" aria-busy={brands.isFetching || undefined}>
              {items.map((b) => (
                <li key={b.id}>
                  <Link className="card pad row gap-3 nowrap link-plain" to={href('store/brand', '', { slug: b.slug })}>
                    <LogoPic logo={b.logo} initials={initialsOf(b.name)} tint={tintOf(b.name)} />
                    <span className="stack gap-0" style={{ minWidth: 0 }}>
                      <span className="small strong truncate">{b.name}</span>
                      <span className="xs muted">{b.productCount ? `${num(b.productCount)} item${b.productCount === 1 ? '' : 's'}` : 'No items in stock'}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
            {brands.hasNextPage && (
              <div className="row" style={{ justifyContent: 'center' }}>
                <Button variant="secondary" onClick={() => void brands.fetchNextPage()} disabled={brands.isFetchingNextPage}>
                  {brands.isFetchingNextPage ? 'Loading…' : 'Show more brands'}
                </Button>
              </div>
            )}
          </>
        ) : !brands.isError ? (
          <EmptyState
            icon="search-x"
            title={q ? `No brands match “${q}”` : 'No brands yet'}
            action={
              q ? (
                <Button variant="secondary" onClick={() => setText('')}>
                  Clear search
                </Button>
              ) : undefined
            }
          >
            {q ? 'Check the spelling or try part of the name.' : 'Brands appear here once their products are on sale.'}
          </EmptyState>
        ) : null}
      </div>
    </StoreLayout>
  );
}
