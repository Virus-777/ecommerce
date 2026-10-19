import { Link, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { StoreLayout } from '@/layouts';
import NotFound from './NotFound';
import { ApiError, call, useApi } from '@marketly/web-shared/api';
import { num } from '@marketly/web-shared/lib/format';
import { useView } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import { Breadcrumbs, Button, Dialog, EmptyState, Icon, IconButton } from '@marketly/web-shared/ui';
import { adsFor, BannerAd, useAdDecision } from '@/api/ads';
import { findCategory, useCategoryTree } from '@/api/catalog';
import { ApiProductCard, CardGridSkeleton, ListingPager, LoadError, SkLines } from '@/api/cards';
import { ActiveFilters, Count, FacetFilters, SortRadios, SortSelect, useListingParams } from '@/api/listing';
import { readPage, readQuery, shownRange, toCardProduct, useFacets, useListing, useSearchClick, type SearchContext } from '@/api/search';
import { RankingPolicyLink } from './data/ranking';

// Design: pages/store/store-category.html · view "filters-phone-sheet" = the phone filters & sort sheet.
// Data: GET /api/store/catalog/categories/{slug} (header, 404), GET /api/store/search/facets and
// GET /api/store/search/products with category={slug} plus the filters and sort in the URL (REST search
// parameters), page on the website and cursor on the phone. The banner ad comes from
// POST /api/store/advertising/decisions (placement category_banner; nothing shows when no ad is live).
// REST rather than the CategoryPage screen query: the query has no sponsored hits (they stay on REST),
// selects images without thumbUrl and has no stock state or offer count on the cards.

const PER_PAGE = 24;

/** Category group of the filters: back to the parent, this category and its subcategories. */
function CategoryTree({ ctx, name, total }: { ctx: SearchContext | undefined; name: string; total: number | null }) {
  const crumbs = ctx?.category?.breadcrumb ?? [];
  const parent = crumbs.length > 1 ? crumbs[crumbs.length - 2] : null;
  return (
    <>
      <Link className="small" to={parent ? href('store/category', '', { slug: parent.slug }) : href('store/categories')}>
        <Icon name="chevron-left" className="ic-sm" /> {parent ? parent.name : 'All categories'}
      </Link>
      <span className="small strong">
        {name} {total !== null && <Count n={total} />}
      </span>
      <div className="stack gap-1 u-pl-sp-3">
        {(ctx?.category?.subcategories ?? [])
          .filter((s) => s.count > 0 && !s.comingSoon)
          .map((s) => (
            <Link key={s.id} className="small" to={href('store/category', '', { slug: s.slug })}>
              {s.name} <Count n={s.count} />
            </Link>
          ))}
      </div>
    </>
  );
}

/** `slug` overrides the route's :slug, for pages that show a category under their own URL (ads/popup). */
export default function Category({ slug: fixedSlug }: { slug?: string } = {}) {
  const [view, setView] = useView<'filters-phone-sheet'>();
  const params = useParams();
  const slug = fixedSlug ?? params.slug ?? '';
  const { api } = useApi();
  const sheetOpen = view === 'filters-phone-sheet';
  const lp = useListingParams(['category']);
  const query = readQuery(lp.params, { category: slug });
  const page = readPage(lp.params);

  const cat = useQuery({
    queryKey: ['catalog', 'category', slug],
    queryFn: () => call(api.GET('/api/store/catalog/categories/{slug}', { params: { path: { slug } } })),
  });
  const tree = useCategoryTree();
  const found = cat.isSuccess;
  const facets = useFacets(query, { enabled: found });
  const listing = useListing(query, page, { limit: PER_PAGE, enabled: found });
  const onOpen = useSearchClick(facets.data?.searchId);
  const categoryId = cat.data?.category.id;
  const ads = useAdDecision('category', ['category_banner'], { categoryId }, { enabled: !!categoryId });
  const banner = adsFor(ads.data, 'category_banner')[0];

  if (cat.error instanceof ApiError && cat.error.status === 404) return <NotFound />;

  const ctx = facets.data;
  const name = cat.data?.category.name ?? '';
  const crumbs = ctx?.category?.breadcrumb ?? cat.data?.breadcrumb ?? [];
  const total = ctx?.total ?? listing.total;
  const shown = shownRange(listing.page, PER_PAGE, listing.hits.length, total ?? 0);

  // Chips: this category's subcategories, or a leaf's siblings, after an "All …" chip for the parent level.
  const node = findCategory(tree.data, { slug });
  const parentNode = node?.parentId ? findCategory(tree.data, { id: node.parentId }) : undefined;
  const level = node && (node.children ?? []).length > 0 ? node : parentNode;
  const chips = level ? [{ slug: level.slug, label: `All ${level.name.toLowerCase()}` }, ...(level.children ?? []).filter((c) => !c.comingSoon).map((c) => ({ slug: c.slug, label: c.name }))] : [];

  const category = <CategoryTree ctx={ctx} name={name} total={total} />;
  const filtersBody = (p: string) => (ctx ? <FacetFilters p={p} facets={ctx.facets} lp={lp} category={category} /> : <SkLines n={6} />);
  const error = cat.error ?? facets.error ?? listing.error;
  const retry = () => {
    void cat.refetch();
    void facets.refetch();
    listing.refetch();
  };

  return (
    <StoreLayout tab="categories" appbar={{ title: name || 'Category', back: href('store/categories'), actions: <IconButton icon="search" label="Search" to={href('store/search')} /> }}>
      <div className="container page gap-5">
        <div className="stack gap-2">
          <Breadcrumbs
            items={[
              { label: 'Home', to: href('store/home') },
              ...crumbs.slice(0, -1).map((c) => ({ label: c.name, to: href('store/category', '', { slug: c.slug }) })),
              ...(name ? [{ label: name }] : []),
            ]}
          />
          {cat.isPending ? (
            <>
              <h1 className="h1 acct-h1 sr-only">Category</h1>
              <SkLines n={2} />
            </>
          ) : (
            <>
              <h1 className="h1 acct-h1">{name || 'Category'}</h1>
              {ctx && <p className="small muted">{ctx.totalLabel}</p>}
            </>
          )}
        </div>
        {chips.length > 1 && (
          <div className="hscroll gap-2">
            {chips.map((c) => (
              <Link key={c.slug} className={c.slug === slug ? 'chip is-active' : 'chip'} to={href('store/category', '', { slug: c.slug })} aria-current={c.slug === slug ? 'true' : undefined}>
                {c.label}
              </Link>
            ))}
          </div>
        )}
        {banner && <BannerAd ad={banner} />}
        {error && !(error instanceof ApiError && error.status === 404) ? <LoadError error={error} onRetry={retry} title="We couldn’t load this category" /> : null}
        <ActiveFilters ctx={ctx} lp={lp} hide={['category']} />
        <div className="shop-listing">
          <aside className="only-desktop" aria-labelledby="cf-h">
            <h2 className="h4" id="cf-h">
              Filters
            </h2>
            {filtersBody('cf')}
          </aside>
          <div className="stack gap-4">
            <div className="shop-toolbar">
              <div className="row gap-2">
                <Button variant="secondary" size="sm" icon="sliders-horizontal" className="no-desktop" onClick={() => setView('filters-phone-sheet')} aria-haspopup="dialog">
                  {lp.filterCount ? `Filters (${lp.filterCount})` : 'Filters'}
                </Button>
                {total !== null && (
                  <span className={sheetOpen ? 'small sub' : 'small sub no-phone'}>
                    {total ? `Showing ${shown.from}–${shown.to} of ${num(total)}` : 'No results'}
                  </span>
                )}
              </div>
              <span className="shop-sort">
                <label className="small sub nowrap" htmlFor="cat-sort">
                  Sort by
                </label>
                <SortSelect id="cat-sort" ctx={ctx} lp={lp} />
              </span>
            </div>
            <p className="shop-from">
              <Icon name="info" />
              <span>{ctx?.fromPriceNote ?? 'A “from” price is the lowest eligible offer for that product, from one named seller. The product page shows that seller, the shipping cost and delivery date before you add it to your cart.'}</span>
            </p>
            {listing.isPending ? (
              <CardGridSkeleton n={8} />
            ) : listing.hits.length ? (
              <div className="grid-products" aria-busy={listing.isFetching || undefined}>
                {listing.hits.map((h) => (
                  <ApiProductCard key={`${h.kind}-${h.position}-${h.product.productId}`} c={toCardProduct(h.product, h)} showSeller from onOpen={onOpen} />
                ))}
              </div>
            ) : !error ? (
              <EmptyState
                icon="search-x"
                title={`No ${name.toLowerCase() || 'products'} match these filters`}
                action={
                  lp.filterCount > 0 ? (
                    <Button variant="secondary" onClick={lp.clearFilters}>
                      Clear all filters
                    </Button>
                  ) : undefined
                }
              >
                {lp.filterCount > 0 ? 'Try removing a filter or widening the price range.' : 'Nothing is in stock here right now. Check back soon.'}
              </EmptyState>
            ) : null}
            <div className="row between">
              <span className="xs muted">
                Sponsored items are paid placements and are labeled.{' '}
                <RankingPolicyLink className="link-inline" />
              </span>
              <ListingPager listing={listing} onPage={lp.setPage} />
            </div>
          </div>
        </div>
      </div>

      <Dialog
        open={sheetOpen}
        onClose={() => setView('')}
        title="Filters and sort"
        foot={
          <>
            <Button variant="ghost" onClick={lp.clearFilters}>
              Clear all
            </Button>
            <Button className="grow" onClick={() => setView('')}>
              Show {num(total ?? 0)} results
            </Button>
          </>
        }
      >
        <SortRadios p="cs" ctx={ctx} lp={lp} />
        {filtersBody('cs')}
      </Dialog>
    </StoreLayout>
  );
}
