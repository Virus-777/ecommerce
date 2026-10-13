import { Link, Navigate, useSearchParams } from 'react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { StoreLayout } from '@/layouts';
import { useSession } from '@/app/session';
import { ApiError, call, errorMessage, useApi } from '@marketly/web-shared/api';
import { dollars, formatMoney, num } from '@marketly/web-shared/lib/format';
import { useView } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import { Alert, Badge, Breadcrumbs, Button, EmptyState, Icon, Price, SellerBadge, ShipLine, Stars } from '@marketly/web-shared/ui';
import { categoryArt, findCategory, useCategoryTree } from '@/api/catalog';
import { ApiProductCard, CardGridSkeleton, LoadError, Pic, SkLines } from '@/api/cards';
import { productHref, readQuery, toCardProduct, useFacets } from '@/api/search';

// Design: pages/store/store-search-empty.html (no results) · view "product-unavailable" = an unavailable
// product variant with other sellers' offers.
// No results: GET /api/store/search/facets with the search parameters in the URL → emptyGuidance
// (removable filters with result counts, clear all, nearby categories, tips, popular products).
// Unavailable (?view=product-unavailable&id=<productId>[&variantId=<id>]): GET /api/store/catalog/products/{id},
// GET /api/store/offers/products/{id}/purchase-box (unavailable reason, restock date, other offers,
// variants), GET /api/store/reviews/products/{id}/rating-summary, GET /api/store/search/products/{id}/similar;
// "Choose this offer" adds it to the cart. Back-in-stock email has no endpoint (gap G5): not shown.

const searchQs = (qs: string) => `${href('store/search')}?${qs}`;

function NoResults() {
  const [params] = useSearchParams();
  const query = readQuery(params);
  const q = query.q ?? '';
  const facets = useFacets(query);
  const ctx = facets.data;
  const g = ctx?.emptyGuidance;
  const filters = g?.removableFilters ?? [];
  const nearby = g?.nearbyCategories ?? [];
  const top = nearby[0];

  if (ctx && ctx.total > 0 && !facets.isPlaceholderData) {
    const p = new URLSearchParams(params);
    p.delete('view');
    return <Navigate to={searchQs(p.toString())} replace />;
  }

  return (
    <StoreLayout tab="home" q={q}>
      <div className="container page gap-6">
        <div className="stack gap-2">
          <h1 className="h2">{q ? `No results for “${q}”` : 'No results'}</h1>
          {filters.length > 0 && (
            <p className="small sub">
              with {filters.length} filter{filters.length === 1 ? '' : 's'} applied
            </p>
          )}
        </div>
        {facets.isError && <LoadError error={facets.error} onRetry={() => void facets.refetch()} title="We couldn’t load search suggestions" />}
        {facets.isPending ? (
          <div className="card pad stack gap-4" aria-busy="true">
            <SkLines n={3} />
          </div>
        ) : (
          <div className="card pad stack gap-4">
            <div className="empty">
              <span className="ring">
                <Icon name="search-x" />
              </span>
              <h2 className="h3">{g?.title ?? (filters.length ? 'Nothing matches all your filters' : 'Nothing matches your search')}</h2>
              <p className="small muted measure-md">{g?.message ?? 'Check the spelling or try fewer words. You can also browse a category below.'}</p>
            </div>
            {filters.length > 0 && (
              <div className="row gap-2 u-justify-center">
                {filters.map((f) => (
                  <Link key={`${f.filter.key}:${f.filter.value}`} className="chip" to={searchQs(f.filter.removeQuery)}>
                    <Icon name="x" className="ic-sm" />
                    Remove {f.filter.label} <span className="muted">({num(f.resultCount)} results)</span>
                  </Link>
                ))}
              </div>
            )}
            <div className="row gap-3 u-justify-center">
              {filters.length > 0 && ctx ? (
                <Button variant="secondary" to={searchQs(ctx.clearAllQuery)}>
                  Clear all filters{g?.clearAllCount != null ? ` (${num(g.clearAllCount)} results)` : ''}
                </Button>
              ) : (
                <Button variant="secondary" to={href('store/categories')}>
                  Browse all categories
                </Button>
              )}
              {top && (
                <Button variant="ghost" to={href('store/category', '', { slug: top.slug })}>
                  Search all {top.name}
                </Button>
              )}
            </div>
          </div>
        )}
        {nearby.length > 0 && (
          <section className="stack gap-3" aria-labelledby="nr-cats">
            <h2 className="h3" id="nr-cats">
              Nearby categories
            </h2>
            <div className="hscroll gap-2">
              {nearby
                .filter((c) => !c.comingSoon)
                .map((c) => (
                  <Link key={c.id} className="chip" to={href('store/category', '', { slug: c.slug })}>
                    <Icon name={categoryArt(c.slug).icon} />
                    {c.name}
                  </Link>
                ))}
            </div>
          </section>
        )}
        {(g?.tips.length ?? 0) > 0 && (
          <section className="stack gap-3" aria-labelledby="nr-tips">
            <h2 className="h3" id="nr-tips">
              Search tips
            </h2>
            <ul className="ul small sub stack gap-1">
              {g!.tips.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          </section>
        )}
        {(g?.popular.length ?? 0) > 0 && (
          <section className="stack gap-4" aria-labelledby="nr-pop">
            <div className="row between base">
              <h2 className="h2">
                <span id="nr-pop">{top ? `Popular in ${top.name}` : 'Popular right now'}</span>
              </h2>
              {top && (
                <Link className="small strong" to={href('store/category', '', { slug: top.slug })}>
                  See all <Icon name="arrow-right" className="ic-sm" />
                </Link>
              )}
            </div>
            <div className="grid-products wide">
              {g!.popular.map((p) => (
                <ApiProductCard key={p.productId} c={toCardProduct(p)} showSeller from />
              ))}
            </div>
          </section>
        )}
      </div>
    </StoreLayout>
  );
}

function ChooseOffer({ offerId }: { offerId: string }) {
  const { api } = useApi();
  const { refreshCart } = useSession();
  const add = useMutation({
    mutationFn: () => call(api.POST('/api/store/cart/cart/items', { body: { offerId, quantity: 1, source: 'offers_list' } })),
    onSuccess: () => refreshCart(),
  });
  if (add.isSuccess) {
    return (
      <span className="row gap-2 small">
        <Badge tone="success" icon="check">
          {add.data.message || 'Added to cart'}
        </Badge>
        <Link to={href('store/cart')} className="link-inline">
          View cart
        </Link>
      </span>
    );
  }
  return (
    <span className="stack gap-1 items-start">
      <Button variant="secondary" size="sm" onClick={() => add.mutate()} disabled={add.isPending}>
        {add.isPending ? 'Adding…' : 'Choose this offer'}
      </Button>
      {add.isError && <span className="xs t-danger-text">{errorMessage(add.error)}</span>}
    </span>
  );
}

const restockLabel = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

function Unavailable() {
  const [params] = useSearchParams();
  const id = params.get('id') ?? '';
  const variantId = params.get('variantId') ?? undefined;
  const { api } = useApi();
  const tree = useCategoryTree();
  const product = useQuery({
    queryKey: ['catalog', 'product', id],
    queryFn: () => call(api.GET('/api/store/catalog/products/{id}', { params: { path: { id } } })),
    enabled: !!id,
  });
  const box = useQuery({
    queryKey: ['offers', 'purchase-box', id, variantId ?? null],
    queryFn: () => call(api.GET('/api/store/offers/products/{productId}/purchase-box', { params: { path: { productId: id }, query: { variantId } } })),
    enabled: !!id,
  });
  const rating = useQuery({
    queryKey: ['reviews', 'rating-summary', id],
    queryFn: () => call(api.GET('/api/store/reviews/products/{productId}/rating-summary', { params: { path: { productId: id } } })),
    enabled: !!id,
  });
  const similar = useQuery({
    queryKey: ['search', 'similar', id],
    queryFn: () => call(api.GET('/api/store/search/products/{productId}/similar', { params: { path: { productId: id }, query: { limit: 5 } } })),
    enabled: !!id,
  });

  const p = product.data;
  const b = box.data;
  const cat = p?.categoryId ? findCategory(tree.data, { id: p.categoryId }) : undefined;
  const parent = cat?.parentId ? findCategory(tree.data, { id: cat.parentId }) : undefined;
  const variant = b?.variants.find((v) => v.variantId === b.variantId);
  const title = p ? (variant?.label ? `${p.title}, ${variant.label}` : p.title) : 'Product';
  const image = p?.variants.find((v) => v.id === b?.variantId)?.images[0] ?? p?.images[0];
  const un = b?.unavailable;
  const alternatives = un?.alternatives ?? [];
  const notFound = !id || (product.error instanceof ApiError && product.error.status === 404);

  return (
    <StoreLayout appbar={{ title: 'Product', back: cat ? href('store/category', '', { slug: cat.slug }) : href('store/home') }}>
      <div className="container page gap-6">
        <Breadcrumbs
          items={[
            { label: 'Home', to: href('store/home') },
            ...(parent ? [{ label: parent.name, to: href('store/category', '', { slug: parent.slug }) }] : []),
            ...(cat ? [{ label: cat.name, to: href('store/category', '', { slug: cat.slug }) }] : []),
            { label: p?.title ?? 'Product' },
          ]}
        />
        {notFound ? (
          <EmptyState icon="package-search" title="We can’t find that product" as="h1" action={<Button variant="secondary" to={href('store/home')}>Go to home page</Button>}>
            The link may be out of date, or the product is no longer sold here.
          </EmptyState>
        ) : product.isError || box.isError ? (
          <>
            <h1 className="sr-only">Product</h1>
            <LoadError
              error={product.error ?? box.error}
              onRetry={() => {
                void product.refetch();
                void box.refetch();
              }}
              title="We couldn’t load this product"
            />
          </>
        ) : (
          <div className="shop-pdp" style={{ gridTemplateColumns: 'minmax(0,1fr)' }}>
            <div className="split">
              <div className="grid md2 gap-6 u-items-start">
                <div className="pcard-media">
                  {p ? <Pic image={image} icon="package" tint="5" /> : <span className="sk sk-img" />}
                  {un && (
                    <span style={{ position: 'absolute', top: '12px', left: '12px' }}>
                      <Badge tone="danger">{un.reason === 'out_of_stock' ? 'Out of stock' : 'Unavailable'}</Badge>
                    </span>
                  )}
                </div>
                <div className="stack gap-3">
                  {!p || !b ? (
                    <>
                      <h1 className="sr-only">Product</h1>
                      <SkLines n={4} />
                    </>
                  ) : (
                    <>
                      {p.brand && (
                        <Link className="small strong" to={href('store/brand', '', { slug: p.brand.slug })}>
                          {p.brand.name}
                        </Link>
                      )}
                      <h1 className="h2">{title}</h1>
                      {rating.data?.hasReviews && rating.data.average != null && <Stars rating={rating.data.average} count={rating.data.ratingCount} />}
                      {un ? (
                        <Alert tone="warning" title={un.title}>
                          {un.message}
                          {un.expectedRestockDate ? ` Expected back around ${restockLabel(un.expectedRestockDate)}. Dates from suppliers can change.` : ''}
                        </Alert>
                      ) : (
                        <Alert tone="success" title="This product is available">
                          <Link to={productHref({ id: p.id, slug: p.slug })} className="link-inline">
                            Go to the product page
                          </Link>
                        </Alert>
                      )}
                      {b.variants.length > 1 && (
                        <div className="stack gap-2">
                          <span className="small strong">{variant?.label ? `Option: ${variant.label}` : 'Options'}</span>
                          <div className="row gap-2">
                            <div className="hscroll gap-2">
                              {b.variants.map((v) =>
                                v.variantId === b.variantId ? (
                                  <a key={v.variantId} className="chip is-active" href="#" aria-current="true">
                                    {v.label} · {v.summary}
                                  </a>
                                ) : (
                                  <Link
                                    key={v.variantId}
                                    className="chip"
                                    to={v.inStock ? productHref({ id: p.id, slug: p.slug }) : href('store/search-empty', 'product-unavailable', undefined, { id: p.id, variantId: v.variantId })}
                                  >
                                    {v.label} · {v.summary}
                                  </Link>
                                ),
                              )}
                            </div>
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
              {alternatives.length > 0 && p && (
                <section className="card" aria-labelledby="pu-alt">
                  <div className="card-head">
                    <div className="stack gap-0">
                      <h2 className="h4" id="pu-alt">
                        Available from other sellers
                      </h2>
                      <span className="xs muted">Same product and option. Seller, condition and terms differ.</span>
                    </div>
                  </div>
                  <ul className="list pad">
                    {alternatives.map((o) => (
                      <li key={o.offerId} className="items-start">
                        <div className="stack gap-2 grow">
                          <div className="row between">
                            <span className="row gap-2">
                              <b className="small">{o.seller.name}</b>
                              <SellerBadge seller={o.seller} compact />
                            </span>
                            <Badge tone="outline">{o.conditionLabel}</Badge>
                          </div>
                          <div className="row gap-2 base">
                            <Price amount={dollars(o.price)} />
                            <span className="xs muted">{o.delivery.free || !o.delivery.shippingCost ? 'Free shipping' : `+ ${formatMoney(o.delivery.shippingCost)} shipping`}</span>
                          </div>
                          <ShipLine>
                            {o.delivery.label} · {o.returns.summary}
                          </ShipLine>
                          {o.conditionNotes && (
                            <span className="shop-note">
                              <Icon name="info" />
                              {o.conditionNotes}
                            </span>
                          )}
                          <ChooseOffer offerId={o.offerId} />
                        </div>
                      </li>
                    ))}
                  </ul>
                  <div className="card-foot">
                    <Link className="small strong" to={href('store/offers', '', { slug: p.slug || 'product', id: p.id })}>
                      Compare all offers <Icon name="arrow-right" className="ic-sm" />
                    </Link>
                  </div>
                </section>
              )}
            </div>
          </div>
        )}
        {!notFound && (similar.isPending || (similar.data?.length ?? 0) > 0) && (
          <section className="stack gap-4" aria-labelledby="pu-sim">
            <div className="row between base">
              <h2 className="h2">
                <span id="pu-sim">{cat ? `Similar ${cat.name.toLowerCase()} in stock` : 'Similar products in stock'}</span>
              </h2>
              {cat && (
                <Link className="small strong" to={href('store/category', '', { slug: cat.slug })}>
                  See all <Icon name="arrow-right" className="ic-sm" />
                </Link>
              )}
            </div>
            {similar.isPending ? (
              <CardGridSkeleton n={5} wide />
            ) : (
              <div className="grid-products wide">
                {similar.data!.map((c) => (
                  <ApiProductCard key={c.productId} c={toCardProduct(c)} showSeller from />
                ))}
              </div>
            )}
          </section>
        )}
      </div>
    </StoreLayout>
  );
}

export default function SearchEmpty() {
  const [view] = useView<'product-unavailable'>();
  const [params] = useSearchParams();
  return view === 'product-unavailable' ? <Unavailable key={`${params.get('id')}:${params.get('variantId')}`} /> : <NoResults key={params.get('q') ?? ''} />;
}
