import type { MouseEvent } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { StoreLayout } from '@/layouts';
import { call, useApi } from '@marketly/web-shared/api';
import { num } from '@marketly/web-shared/lib/format';
import { href } from '@marketly/web-shared/routes';
import { Badge, EmptyState, Icon, type IconName } from '@marketly/web-shared/ui';
import { categoryArt, findCategory, tintOf, useCategoryTree } from '@/api/catalog';
import { ApiProductCard, CardGridSkeleton, ListingPager, LoadError, Pic } from '@/api/cards';
import { SortSelect, useListingParams } from '@/api/listing';
import { readPage, readQuery, toCardProduct, useFacets, useListing, useSearchClick } from '@/api/search';

// Design: pages/store/store-official.html. The Official Store is not a seller record, so there is no
// profile endpoint (gap G8): the hero and the promises are static copy. Data: featured collections
// GET /api/store/content/collections?collectionKind=official; categories and total from
// GET /api/store/search/facets?seller=official (+ the category tree for images); the grid from
// GET /api/store/search/products?seller=official&sort (page on the website, cursor on the phone).

const PER_PAGE = 24;

const PROMISES: Array<{ icon: IconName; title: string; sub: string }> = [
  { icon: 'truck', title: 'Free delivery over $35', sub: 'On Official Store items. $5.99 below that.' },
  { icon: 'undo-2', title: '30-day free returns', sub: 'Prepaid label or drop-off at any UPS store.' },
  { icon: 'shield-check', title: '2-year warranty on electronics', sub: 'We handle the claim with the brand.' },
  { icon: 'warehouse', title: 'Ships from Reno, NV', sub: 'Same or next business day dispatch.' },
];

export default function Official() {
  const { api } = useApi();
  const lp = useListingParams();
  const tree = useCategoryTree();
  const collections = useQuery({
    queryKey: ['content', 'collections', { collectionKind: 'official' }],
    queryFn: () => call(api.GET('/api/store/content/collections', { params: { query: { collectionKind: 'official', limit: 12 } } })),
  });
  const query = readQuery(lp.params, { seller: ['official'] });
  const base = useFacets({ seller: ['official'] });
  const facets = useFacets(query);
  const listing = useListing(query, readPage(lp.params), { limit: PER_PAGE });
  const onOpen = useSearchClick(facets.data?.searchId);
  const cats = base.data?.facets.find((f) => f.kind === 'category')?.values ?? [];
  const total = facets.data?.total ?? listing.total;
  const error = facets.error ?? listing.error;

  const toAll = (e: MouseEvent) => {
    e.preventDefault();
    document.getElementById('of-all')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <StoreLayout nav="official" appbar={{ title: 'Official Store' }}>
      <div className="container page gap-7">
        <section className="shop-off-hero" aria-labelledby="of-h">
          <div className="stack gap-3">
            <span className="row gap-2">
              <Badge tone="solid" icon="badge-check">
                Official Store
              </Badge>
            </span>
            <h1 className="display d-xl u-c-on-brand" id="of-h">
              Sold and shipped by Marketly
            </h1>
            <p style={{ maxWidth: '44ch' }} className="u-o-_9">
              Our own stock, bought from brands and their authorized distributors, packed in our Reno, NV warehouse. We handle delivery, returns and warranty claims ourselves.
            </p>
            <div className="row gap-2">
              <a className="btn btn-lg u-bg-on-brand u-c-brand-text-i" href="#of-all" onClick={toAll}>
                Shop all Official Store items
              </a>
            </div>
          </div>
          <div className="art" aria-hidden="true">
            <Pic icon="headphones" tint="2" />
            <Pic icon="cooking-pot" tint="3" />
            <Pic icon="shirt" tint="4" />
          </div>
        </section>

        <section className="shop-promises" aria-label="Official Store promises">
          {PROMISES.map((p) => (
            <div key={p.title}>
              <Icon name={p.icon} />
              <span className="stack gap-1">
                <span className="small strong">{p.title}</span>
                <span className="xs muted">{p.sub}</span>
              </span>
            </div>
          ))}
        </section>

        {(collections.data?.items.length ?? 0) > 0 && (
          <section className="stack gap-3" aria-labelledby="of-col">
            <h2 className="h2" id="of-col">
              Featured collections
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

        {cats.length > 0 && (
          <section className="stack gap-4" aria-labelledby="of-cat">
            <h2 className="h2" id="of-cat">
              Shop the Official Store by category
            </h2>
            <div className="shop-shortcuts">
              {cats.map((c) => {
                const art = categoryArt(c.value);
                return (
                  <Link key={c.value} to={`${href('store/category', '', { slug: c.value })}?seller=official`}>
                    <Pic image={findCategory(tree.data, { slug: c.value })?.image} icon={art.icon} tint={art.tint} />
                    <span>{c.label}</span>
                  </Link>
                );
              })}
            </div>
          </section>
        )}

        <section className="stack gap-4" id="of-all" aria-labelledby="of-grid">
          <h2 className="h2" id="of-grid">
            All Official Store items
          </h2>
          {error ? (
            <LoadError
              error={error}
              onRetry={() => {
                void facets.refetch();
                listing.refetch();
              }}
              title="We couldn’t load the Official Store items"
            />
          ) : null}
          <div className="shop-toolbar">
            <span className="small sub">{total !== null ? `${num(total)} items · ` : ''}prices shown are Official Store offers. Other sellers may list the same product.</span>
            <span className="shop-sort">
              <label className="small sub nowrap" htmlFor="of-sort">
                Sort by
              </label>
              <SortSelect id="of-sort" ctx={facets.data} lp={lp} />
            </span>
          </div>
          {listing.isPending ? (
            <CardGridSkeleton n={10} wide />
          ) : listing.hits.length ? (
            <div className="grid-products wide" aria-busy={listing.isFetching || undefined}>
              {listing.hits.map((h) => (
                <ApiProductCard key={`${h.kind}-${h.position}-${h.product.productId}`} c={toCardProduct(h.product, h)} from onOpen={onOpen} />
              ))}
            </div>
          ) : !error ? (
            <EmptyState icon="package-search" title="No Official Store items in stock right now">
              Check back soon: new stock arrives at our Reno warehouse every weekday.
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
