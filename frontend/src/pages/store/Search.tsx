import { useState } from 'react';
import { Link, Navigate } from 'react-router';
import { StoreLayout } from '@/layouts';
import { num } from '@marketly/web-shared/lib/format';
import { href } from '@marketly/web-shared/routes';
import { Badge, Button, Dialog, EmptyState, Icon } from '@marketly/web-shared/ui';
import { initialsOf, tintOf } from '@/api/catalog';
import { ApiProductCard, CardGridSkeleton, ListingPager, LoadError, LogoPic, SkLines } from '@/api/cards';
import { ActiveFilters, FacetFilters, SortRadios, SortSelect, useListingParams } from '@/api/listing';
import { readPage, readQuery, toCardProduct, useFacets, useListing, useSearchClick } from '@/api/search';

// Design: pages/store/store-search.html · view "suggestions-open" = the search suggestions panel, which
// the store layout opens when the header search field is focused or typed in. Data: the URL holds the
// REST search parameters (q, filters, sort, page); GET /api/store/search/facets (total, correction,
// applied filters, facets, sorts, store match) and GET /api/store/search/products (page on the website,
// cursor on the phone). Zero results go to store/search-empty with the same parameters.

const PER_PAGE = 24;

export default function Search() {
  const lp = useListingParams();
  const query = readQuery(lp.params);
  const page = readPage(lp.params);
  const q = query.q ?? '';
  const [sheet, setSheet] = useState(false);

  const facets = useFacets(query);
  const listing = useListing(query, page, { limit: PER_PAGE });
  const onOpen = useSearchClick(facets.data?.searchId);
  const ctx = facets.data;

  // No results for this query and filters: the no-results page shows the server's guidance.
  if (ctx && ctx.total === 0 && !facets.isPlaceholderData) {
    const p = new URLSearchParams(lp.params);
    p.delete('page');
    p.delete('view');
    return <Navigate to={`${href('store/search-empty')}?${p.toString()}`} replace />;
  }

  const total = ctx?.total ?? listing.total;
  const topRow = listing.hits.filter((h) => h.kind === 'sponsored' && h.slot === 'top_row');
  const results = listing.hits.filter((h) => !(h.kind === 'sponsored' && h.slot === 'top_row'));
  const store = ctx?.storeMatch;
  const error = facets.error ?? listing.error;
  const filterPanel = (p: string) => (ctx ? <FacetFilters p={p} facets={ctx.facets} lp={lp} /> : <SkLines n={6} />);
  const exactHref = (text: string) => href('store/search', '', undefined, { q: text, exact: 'true' });

  return (
    <StoreLayout tab="home" q={q}>
      <div className="container page gap-5">
        <div className="stack gap-2">
          <h1 className="h2">{q ? `Results for “${q}”` : 'All products'}</h1>
          {ctx?.query.correctionApplied && ctx.query.correctedTo && (
            <p className="small sub">
              Showing results for <b>{ctx.query.correctedTo}</b>.{' '}
              {ctx.query.searchInsteadFor && (
                <Link to={exactHref(ctx.query.searchInsteadFor)} className="link-inline">
                  Search instead for “{ctx.query.searchInsteadFor}”
                </Link>
              )}
            </p>
          )}
        </div>
        <ActiveFilters ctx={ctx} lp={lp} />
        {error ? (
          <LoadError
            error={error}
            onRetry={() => {
              void facets.refetch();
              listing.refetch();
            }}
            title="We couldn’t load the results"
          />
        ) : null}
        {store && (
          <section className="card pad row between gap-4" aria-labelledby="sr-store">
            <div className="row gap-3 nowrap min-w-0">
              <LogoPic logo={store.logo} initials={initialsOf(store.name)} tint={tintOf(store.name)} />
              <div className="stack gap-1">
                <span className="eyebrow">Store match</span>
                <span className="row gap-2">
                  <h2 className="h4" id="sr-store">
                    Store: {store.name}
                  </h2>
                  {store.official ? (
                    <Badge tone="brand" icon="badge-check">
                      Official Store
                    </Badge>
                  ) : (
                    store.verified && (
                      <Badge tone="info" icon="shield-check">
                        Verified
                      </Badge>
                    )
                  )}
                </span>
                <span className="xs muted">
                  {[store.positivePct != null ? `${Math.round(store.positivePct)}% positive (${num(store.ratingCount ?? 0)} ratings)` : null, `${num(store.productCount)} products`, store.location].filter(Boolean).join(' · ')}
                </span>
              </div>
            </div>
            <div className="stack gap-1 items-start">
              <Button variant="secondary" size="sm" to={store.official ? href('store/official') : href('store/seller', '', { slug: store.slug })} iconRight="arrow-right">
                Visit store
              </Button>
              <span className="xs muted">{store.note ?? 'Stores are listed here, not mixed into product results.'}</span>
            </div>
          </section>
        )}
        {topRow.length > 0 && (
          <section className="stack gap-3" aria-labelledby="sr-sp">
            <div className="row between base">
              <h2 className="h4" id="sr-sp">
                Sponsored products
              </h2>
              <Link className="xs" to={href('help/article')}>
                Why these ads?
              </Link>
            </div>
            <div className="grid-products">
              {topRow.map((h) => (
                <ApiProductCard key={`sp-${h.position}-${h.product.productId}`} c={toCardProduct(h.product, h)} showSeller from onOpen={onOpen} />
              ))}
            </div>
          </section>
        )}
        <div className="shop-listing">
          <aside className="only-desktop" aria-labelledby="sf-h">
            <h2 className="h4" id="sf-h">
              Filters
            </h2>
            {filterPanel('sf')}
          </aside>
          <div className="stack gap-4">
            <div className="shop-toolbar">
              <div className="row gap-2">
                <Button variant="secondary" size="sm" icon="sliders-horizontal" className="no-desktop" onClick={() => setSheet(true)} aria-haspopup="dialog">
                  {lp.filterCount ? `Filters (${lp.filterCount})` : 'Filters'}
                </Button>
                {total !== null && (
                  <span className="small sub">
                    {num(total)} result{total === 1 ? '' : 's'}
                  </span>
                )}
              </div>
              <span className="shop-sort">
                <label className="small sub nowrap" htmlFor="sr-sort">
                  Sort by
                </label>
                <SortSelect id="sr-sort" ctx={ctx} lp={lp} />
              </span>
            </div>
            <p className="shop-from">
              <Icon name="info" />
              <span>{ctx?.fromPriceNote ?? 'A “from” price is the lowest eligible offer for that product, from one named seller. The product page shows that seller, the shipping cost and delivery date before you add it to your cart.'}</span>
            </p>
            {listing.isPending ? (
              <CardGridSkeleton n={8} />
            ) : results.length ? (
              <div className="grid-products" aria-busy={listing.isFetching || undefined}>
                {results.map((h) => (
                  <ApiProductCard key={`${h.kind}-${h.position}-${h.product.productId}`} c={toCardProduct(h.product, h)} showSeller from onOpen={onOpen} />
                ))}
              </div>
            ) : !error ? (
              <EmptyState
                icon="search-x"
                title="Nothing matches all your filters"
                action={
                  <Button variant="secondary" onClick={lp.clearFilters}>
                    Clear all filters
                  </Button>
                }
              >
                Try removing a filter. Your search still has results without them.
              </EmptyState>
            ) : null}
            <div className="row between">
              <span className="xs muted">Results match product names, brands and descriptions. Sponsored items are labeled.</span>
              <ListingPager listing={listing} onPage={lp.setPage} />
            </div>
          </div>
        </div>
      </div>

      <Dialog
        open={sheet}
        onClose={() => setSheet(false)}
        title="Filters and sort"
        foot={
          <>
            <Button variant="ghost" onClick={lp.clearFilters}>
              Clear all
            </Button>
            <Button className="grow" onClick={() => setSheet(false)}>
              Show {num(total ?? 0)} results
            </Button>
          </>
        }
      >
        <SortRadios p="ss" ctx={ctx} lp={lp} />
        {filterPanel('ss')}
      </Dialog>
    </StoreLayout>
  );
}
