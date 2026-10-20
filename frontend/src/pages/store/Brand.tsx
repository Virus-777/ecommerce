import { Link, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { StoreLayout } from '@/layouts';
import NotFound from './NotFound';
import { ApiError, call, useApi } from '@marketly/web-shared/api';
import { num } from '@marketly/web-shared/lib/format';
import { href } from '@marketly/web-shared/routes';
import { Breadcrumbs, Chip, ChipRow, EmptyState, Icon, sameOriginFile } from '@marketly/web-shared/ui';
import { initialsOf, tintOf, useBrand } from '@/api/catalog';
import { ApiProductCard, CardGridSkeleton, ListingPager, LoadError, LogoPic, Pic, SkLines } from '@/api/cards';
import { SortSelect, useListingParams } from '@/api/listing';
import { readPage, readQuery, shownRange, toCardProduct, useFacets, useListing, useSearchClick } from '@/api/search';

// Design: pages/store/store-brand.html. Data: GET /api/store/catalog/brands/{slug} (header),
// GET /api/store/content/collections?brandId&collectionKind=brand (collection cards),
// GET /api/store/search/facets?brand={slug} (category chips with counts, tagline) and
// GET /api/store/search/products?brand={slug}&category&sort (grid; page on the website, cursor on the phone).

const PER_PAGE = 24;

/** "Headphones, earbuds and speakers" from the brand's category facet. */
const tagline = (labels: string[]) => {
  const l = labels.slice(0, 3).map((x, i) => (i ? x.toLowerCase() : x));
  return l.length > 1 ? `${l.slice(0, -1).join(', ')} and ${l[l.length - 1]}` : (l[0] ?? '');
};

export default function Brand() {
  const { slug = '' } = useParams();
  const { api } = useApi();
  const lp = useListingParams();
  const brand = useBrand(slug);
  const found = brand.isSuccess;
  const b = brand.data;

  const collections = useQuery({
    queryKey: ['content', 'collections', { brandId: b?.id, collectionKind: 'brand' }],
    queryFn: () => call(api.GET('/api/store/content/collections', { params: { query: { brandId: b!.id, collectionKind: 'brand', limit: 12 } } })),
    enabled: !!b,
  });
  const base = useFacets({ brand: [slug] }, { enabled: found });
  const query = readQuery(lp.params, { brand: [slug] });
  const facets = useFacets(query, { enabled: found });
  const listing = useListing(query, readPage(lp.params), { limit: PER_PAGE, enabled: found });
  const onOpen = useSearchClick(facets.data?.searchId);

  if (brand.error instanceof ApiError && brand.error.status === 404) return <NotFound />;

  const cats = base.data?.facets.find((f) => f.kind === 'category')?.values ?? [];
  const chip = lp.params.get('category') ?? '';
  const total = facets.data?.total ?? listing.total ?? 0;
  const shown = shownRange(listing.page, PER_PAGE, listing.hits.length, total);
  const pick = (v: string) =>
    lp.update((q) => {
      if (v) q.set('category', v);
      else q.delete('category');
    });
  const error = brand.error ?? facets.error ?? listing.error;
  const name = b?.name ?? '';

  return (
    <StoreLayout nav="brands" appbar={{ title: name || 'Brand' }}>
      <div className="container page gap-6">
        <Breadcrumbs items={[{ label: 'Home', to: href('store/home') }, { label: 'Brands' }, { label: name || 'Brand' }]} />
        {error ? (
          <LoadError
            error={error}
            onRetry={() => {
              void brand.refetch();
              void facets.refetch();
              listing.refetch();
            }}
            title="We couldn’t load this brand"
          />
        ) : null}
        <section className="shop-hero" aria-labelledby="br-h">
          <div className="ban tint-2" aria-hidden="true">
            {b?.banner ? (
              <img src={sameOriginFile(b.banner.url)} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} onError={(e) => (e.currentTarget.style.display = 'none')} />
            ) : (
              <>
                <Icon name="tag" />
                <Icon name="package" />
              </>
            )}
          </div>
          <div className="id">
            <LogoPic logo={b?.logo} initials={initialsOf(name || '?')} tint={tintOf(name)} className="lg" />
            <div className="stack gap-1 grow">
              {b ? (
                <>
                  <h1 className="display d-lg" id="br-h">
                    {name}
                  </h1>
                  <span className="small sub">
                    Brand collection · {num(b.productCount)} products{cats.length ? ` · ${tagline(cats.map((c) => c.label))}` : ''}
                  </span>
                </>
              ) : (
                <>
                  <h1 className="display d-lg sr-only" id="br-h">
                    Brand
                  </h1>
                  <SkLines n={2} />
                </>
              )}
            </div>
          </div>
          <div className="stack gap-2 u-p-0-sp-5-sp-5">
            <p className="sub u-maxw-72ch">
              {b?.description ? `${b.description} ` : ''}Products here come from the Official Store and from approved sellers. Each card names the seller, and the product page compares all offers.
            </p>
          </div>
        </section>

        {(collections.data?.items.length ?? 0) > 0 && (
          <section className="stack gap-3" aria-labelledby="br-col">
            <h2 className="h3" id="br-col">
              Collections
            </h2>
            <div className="shop-collections">
              {collections.data!.items.map((c) => (
                <Link key={c.id} className="shop-coll" to={href('store/collection', '', { slug: c.slug })}>
                  <Pic image={c.image} icon="layout-grid" tint={tintOf(c.title)} />
                  <span className="stack gap-1">
                    <span className="strong">{c.title}</span>
                    <span className="xs muted">{c.productCount} products</span>
                  </span>
                </Link>
              ))}
            </div>
          </section>
        )}

        <section className="stack gap-4" aria-labelledby="br-all">
          <h2 className="h3" id="br-all">
            All {name} products
          </h2>
          {cats.length > 1 && (
            <ChipRow>
              <Chip active={!chip} onClick={() => pick('')}>
                All ({num(base.data?.total ?? 0)})
              </Chip>
              {cats.map((c) => (
                <Chip key={c.value} active={chip === c.value} onClick={() => pick(c.value)}>
                  {c.label} ({num(c.count)})
                </Chip>
              ))}
            </ChipRow>
          )}
          <div className="shop-toolbar">
            <span className="small sub" aria-live="polite">
              {total ? `Showing ${shown.from}–${shown.to} of ${num(total)}` : ''}
            </span>
            <span className="shop-sort">
              <label className="small sub nowrap" htmlFor="br-sort">
                Sort by
              </label>
              <SortSelect id="br-sort" ctx={facets.data} lp={lp} />
            </span>
          </div>
          {listing.isPending || brand.isPending ? (
            <CardGridSkeleton n={8} />
          ) : listing.hits.length ? (
            <div className="grid-products" aria-busy={listing.isFetching || undefined}>
              {listing.hits.map((h) => (
                <ApiProductCard key={`${h.kind}-${h.position}-${h.product.productId}`} c={toCardProduct(h.product, h)} from showSeller onOpen={onOpen} />
              ))}
            </div>
          ) : !error ? (
            <EmptyState icon="package-search" title={`No ${name} products in stock right now`}>
              New offers show up here as soon as sellers list them.
            </EmptyState>
          ) : null}
          <div className="row end">
            <ListingPager listing={listing} onPage={lp.setPage} />
          </div>
        </section>
      </div>
    </StoreLayout>
  );
}
