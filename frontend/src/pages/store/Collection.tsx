import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { StoreLayout, type StoreNavKey } from '@/layouts';
import NotFound from './NotFound';
import { ApiError, call, useApi, type components } from '@marketly/web-shared/api';
import { useView } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import { Alert, Avatar, Breadcrumbs, Chip, ChipRow, EmptyState, Icon, Pager, StatusBadge, Tabs } from '@marketly/web-shared/ui';
import { useCategoryTree } from '@/api/catalog';
import { ApiProductCard, CardGridSkeleton, ListingPager, LoadError, Pic, SkLines } from '@/api/cards';
import { contentIcon, contentLinkTo } from '@/api/content';
import { tileToCard, toCardProduct, useListing, useProductCards, type ProductTile } from '@/api/search';

// Design: pages/store/store-collection.html (New arrivals) · views: best-sellers, seasonal (Home Week),
// curated-collection. The page comes from GET /api/store/content/pages/{slug} and is laid out by its
// collection kind (new_arrivals, best_sellers, seasonal/campaign, curated/brand/official); rule-based
// collections page through GET /api/store/content/pages/{slug}/products?categoryId&page. When no
// content page is published for /collection/new-arrivals or /collection/best-sellers, the rule-based
// search lists are used instead (search/products?listedWithinDays=30&sort=newest, sort=best_selling).
// ?view=best-sellers keeps opening the best-sellers collection (design links).

type StorePage = components['schemas']['content.StorePage'];
type Block = components['schemas']['content.PageBlock'];

const PER_PAGE = 24;
const dateTime = (iso: string) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles' }) + ' PT';
const day = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Los_Angeles' });
const time = (iso: string) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles' }) + ' PT';
const STOCK: Record<string, string> = { in_stock: 'In stock', low_stock: 'Low stock', out_of_stock: 'Out of stock' };

const productsOf = (p: StorePage) => p.blocks.flatMap((b) => b.products);

function PageCrumbs({ page, title }: { page: StorePage | null; title: string }) {
  const trail = (page?.breadcrumb ?? []).filter((c) => c.url !== '/');
  return (
    <Breadcrumbs
      items={[
        { label: 'Home', to: href('store/home') },
        ...trail.slice(0, -1).map((c) => ({ label: c.label, to: contentLinkTo(c.url) })),
        { label: title },
      ]}
    />
  );
}

export default function Collection() {
  const [view] = useView<'best-sellers' | 'seasonal' | 'curated-collection'>();
  const params = useParams();
  const slug = view === 'best-sellers' ? 'best-sellers' : (params.slug ?? 'new-arrivals');
  const { api } = useApi();
  const page = useQuery({
    queryKey: ['content', 'page', slug],
    queryFn: () => call(api.GET('/api/store/content/pages/{slug}', { params: { path: { slug } } })),
  });
  const missing = page.error instanceof ApiError && page.error.status === 404;
  const p = page.data;
  const kind = p?.collectionKind ?? (missing ? (slug === 'best-sellers' ? 'best_sellers' : slug === 'new-arrivals' ? 'new_arrivals' : null) : null);

  if (missing && !kind) return <NotFound />;

  const nav: StoreNavKey | undefined = kind === 'new_arrivals' ? 'new' : kind === 'best_sellers' ? 'best' : undefined;
  const title = p?.title ?? (kind === 'best_sellers' ? 'Best sellers' : kind === 'new_arrivals' ? 'New arrivals' : 'Collection');

  return (
    <StoreLayout nav={nav} appbar={{ title }}>
      <div className="container page gap-6">
        {page.isPending ? (
          <>
            <h1 className="sr-only">Collection</h1>
            <SkLines n={2} />
            <CardGridSkeleton n={8} />
          </>
        ) : page.isError && !missing ? (
          <>
            <h1 className="sr-only">Collection</h1>
            <LoadError error={page.error} onRetry={() => void page.refetch()} title="We couldn’t load this collection" />
          </>
        ) : missing && kind === 'new_arrivals' ? (
          <RuleNewArrivals />
        ) : missing && kind === 'best_sellers' ? (
          <RuleBestSellers />
        ) : p && kind === 'new_arrivals' ? (
          <NewArrivals page={p} />
        ) : p && kind === 'best_sellers' ? (
          <BestSellers page={p} />
        ) : p && (p.kind === 'campaign' || kind === 'seasonal') ? (
          <Seasonal page={p} />
        ) : p ? (
          <Curated page={p} />
        ) : null}
      </div>
    </StoreLayout>
  );
}

/** More products of a rule-based collection (by category, paged). */
function useMoreProducts(slug: string, categoryId: string, pageNo: number, enabled: boolean) {
  const { api } = useApi();
  return useQuery({
    queryKey: ['content', 'page-products', slug, { categoryId, page: pageNo }],
    queryFn: () => call(api.GET('/api/store/content/pages/{slug}/products', { params: { path: { slug }, query: { categoryId: categoryId || undefined, page: pageNo, limit: PER_PAGE } } })),
    enabled,
  });
}

function TileGrid({ tiles, wide, rank }: { tiles: ProductTile[]; wide?: boolean; rank?: boolean }) {
  const cards = useProductCards(tiles.map((t) => t.productId));
  return (
    <div className={wide ? 'grid-products wide' : 'grid-products'}>
      {tiles.map((t, i) =>
        rank ? (
          <div key={t.productId} className="stack gap-2">
            <span className="shop-rank">
              <span className={(t.rank ?? i + 1) <= 3 ? 'n top' : 'n'}>#{t.rank ?? i + 1}</span>
              <span className="xs muted">{(t.rank ?? i + 1) <= 3 ? 'Top 3 this month' : (t.badge ?? '')}</span>
            </span>
            <ApiProductCard c={tileToCard(t, cards.data?.get(t.productId))} from showSeller />
          </div>
        ) : (
          <ApiProductCard key={t.productId} c={tileToCard(t, cards.data?.get(t.productId))} from showSeller />
        ),
      )}
    </div>
  );
}

/* ---------------- New arrivals ---------------- */

function CategoryChips({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const tree = useCategoryTree();
  const roots = (tree.data ?? []).filter((c) => !c.comingSoon && c.productCount > 0);
  if (!roots.length) return null;
  return (
    <ChipRow>
      <Chip active={!value} onClick={() => onChange('')}>
        All categories
      </Chip>
      {roots.map((c) => (
        <Chip key={c.id} active={value === c.id} onClick={() => onChange(c.id)}>
          {c.name}
        </Chip>
      ))}
    </ChipRow>
  );
}

function NewArrivals({ page }: { page: StorePage }) {
  const [cat, setCat] = useState('');
  const [pageNo, setPageNo] = useState(1);
  // Page 1 of all categories is in the page blocks; the products endpoint gives totals, other pages and categories.
  const filtered = !!cat || pageNo > 1;
  const more = useMoreProducts(page.slug, cat, pageNo, true);
  const tiles = more.data?.items ?? (filtered ? [] : productsOf(page));
  const totalPages = Math.max(1, more.data?.totalPages ?? 1);
  const pick = (v: string) => {
    setCat(v);
    setPageNo(1);
  };
  return (
    <>
      <PageCrumbs page={page} title={page.title} />
      <div className="stack gap-2">
        <h1 className="h1">{page.title}</h1>
        <p className="small sub">{page.intro ?? 'Products first listed on Marketly in the last 30 days, newest first. Updated daily.'}</p>
      </div>
      <CategoryChips value={cat} onChange={pick} />
      {filtered && more.isPending ? (
        <CardGridSkeleton n={8} />
      ) : filtered && more.isError ? (
        <LoadError error={more.error} onRetry={() => void more.refetch()} />
      ) : tiles.length ? (
        // Tiles carry no listing date, so the design's "Added Oct 6" groups can't be built yet.
        <section className="stack gap-3" aria-label={page.title}>
          <TileGrid tiles={tiles} />
        </section>
      ) : (
        <EmptyState icon="package-search" title="No new arrivals in this category yet" as="h2">
          New products show up here the day they are first listed.
        </EmptyState>
      )}
      {totalPages > 1 && (
        <div className="row end">
          <Pager page={pageNo} total={totalPages} onPage={setPageNo} grid only="website" />
        </div>
      )}
    </>
  );
}

function RuleNewArrivals() {
  const [cat, setCat] = useState('');
  const [pageNo, setPageNo] = useState(1);
  const tree = useCategoryTree();
  const slug = (tree.data ?? []).find((c) => c.id === cat)?.slug;
  const listing = useListing({ listedWithinDays: 30, sort: 'newest', ...(slug ? { category: slug } : {}) }, pageNo, { limit: PER_PAGE });
  return (
    <>
      <Breadcrumbs items={[{ label: 'Home', to: href('store/home') }, { label: 'New arrivals' }]} />
      <div className="stack gap-2">
        <h1 className="h1">New arrivals</h1>
        <p className="small sub">Products first listed on Marketly in the last 30 days, newest first. Updated daily.</p>
      </div>
      <CategoryChips
        value={cat}
        onChange={(v) => {
          setCat(v);
          setPageNo(1);
        }}
      />
      {listing.isPending ? (
        <CardGridSkeleton n={8} />
      ) : listing.error ? (
        <LoadError error={listing.error} onRetry={listing.refetch} />
      ) : listing.hits.length ? (
        <div className="grid-products">
          {listing.hits.map((h) => (
            <ApiProductCard key={`${h.position}-${h.product.productId}`} c={toCardProduct(h.product, h)} from showSeller />
          ))}
        </div>
      ) : (
        <EmptyState icon="package-search" title="No new arrivals in this category yet" as="h2">
          New products show up here the day they are first listed.
        </EmptyState>
      )}
      <div className="row end">
        <ListingPager listing={listing} onPage={setPageNo} />
      </div>
    </>
  );
}

/* ---------------- Best sellers ---------------- */

function BestSellers({ page }: { page: StorePage }) {
  const [cat, setCat] = useState('');
  const tree = useCategoryTree();
  const more = useMoreProducts(page.slug, cat, 1, !!cat);
  const tiles = cat ? (more.data?.items ?? []) : productsOf(page);
  const roots = (tree.data ?? []).filter((c) => !c.comingSoon && c.productCount > 0);
  const catName = roots.find((c) => c.id === cat)?.name ?? '';
  return (
    <>
      <PageCrumbs page={page} title={page.title} />
      <div className="stack gap-2">
        <h1 className="h1">{page.title}</h1>
        <p className="small sub">{page.intro ?? 'Ranked by units sold in the last 30 days across all sellers. Updated every hour. Sponsored placements don’t affect rank.'}</p>
      </div>
      {roots.length > 0 && <Tabs items={[{ value: '', label: 'All' }, ...roots.map((c) => ({ value: c.id, label: c.name }))]} active={cat} onChange={setCat} />}
      {cat && more.isPending ? (
        <CardGridSkeleton n={10} wide />
      ) : cat && more.isError ? (
        <LoadError error={more.error} onRetry={() => void more.refetch()} />
      ) : tiles.length > 0 ? (
        <TileGrid tiles={tiles} wide rank />
      ) : (
        <EmptyState icon="package-search" title={catName ? `No ${catName} items in the top list right now` : 'No best sellers yet'} as="h2">
          Ranks update every hour.
        </EmptyState>
      )}
      <p className="xs muted">Last updated {dateTime(page.updatedAt)}</p>
    </>
  );
}

function RuleBestSellers() {
  const listing = useListing({ sort: 'best_selling' }, 1, { limit: PER_PAGE });
  const noHistory = listing.error instanceof ApiError && listing.error.code === 'SORT_NOT_AVAILABLE';
  return (
    <>
      <Breadcrumbs items={[{ label: 'Home', to: href('store/home') }, { label: 'Best sellers' }]} />
      <div className="stack gap-2">
        <h1 className="h1">Best sellers</h1>
        <p className="small sub">Ranked by units sold in the last 30 days across all sellers. Updated every hour. Sponsored placements don’t affect rank.</p>
      </div>
      {listing.isPending ? (
        <CardGridSkeleton n={10} wide />
      ) : noHistory ? (
        <EmptyState icon="package-search" title="Best sellers appear once there is enough sales history" as="h2">
          {(listing.error as ApiError).message}
        </EmptyState>
      ) : listing.error ? (
        <LoadError error={listing.error} onRetry={listing.refetch} />
      ) : (
        <div className="grid-products wide">
          {listing.hits.map((h, i) => (
            <div key={h.product.productId} className="stack gap-2">
              <span className="shop-rank">
                <span className={i < 3 ? 'n top' : 'n'}>#{i + 1}</span>
                <span className="xs muted">{i < 3 ? 'Top 3 this month' : ''}</span>
              </span>
              <ApiProductCard c={toCardProduct(h.product, h)} from showSeller />
            </div>
          ))}
        </div>
      )}
    </>
  );
}

/* ---------------- Seasonal campaign ---------------- */

const sections = (p: StorePage) => p.blocks.filter((b) => (b.type === 'product_section' || b.type === 'product_grid') && b.products.length > 0);

function SectionChips({ blocks, only, setOnly }: { blocks: Block[]; only: string; setOnly: (fn: (o: string) => string) => void }) {
  if (blocks.length < 2) return null;
  return (
    <ChipRow>
      {blocks.map((s) => (
        <Chip key={s.id} icon={s.icon ? contentIcon(s.icon, 'tag') : undefined} active={only === s.id} onClick={() => setOnly((o) => (o === s.id ? '' : s.id))}>
          {s.title ?? 'Products'}
        </Chip>
      ))}
    </ChipRow>
  );
}

function Seasonal({ page }: { page: StorePage }) {
  const [only, setOnly] = useState('');
  const hero = page.blocks.find((b) => b.type === 'hero' || b.type === 'banner')?.banner;
  const blocks = sections(page);
  const terms = page.blocks.filter((b) => b.type === 'terms' && (b.items?.length ?? 0) > 0);
  const daysLeft = page.endsInSeconds != null ? Math.max(0, Math.ceil(page.endsInSeconds / 86400)) : null;
  return (
    <>
      <PageCrumbs page={page} title={page.title} />
      <section className="shop-season" aria-labelledby="hw-h">
        <div className="copy">
          <span className="eyebrow u-c-on-brand u-o-_85">{page.eyebrow ?? hero?.eyebrow ?? 'Seasonal campaign'}</span>
          <h1 className="display d-xl u-c-on-brand" id="hw-h">
            {page.title}
          </h1>
          {(page.intro ?? hero?.body) && (
            <p style={{ opacity: 0.92 }} className="measure-md">
              {page.intro ?? hero?.body}
            </p>
          )}
          <div className="meta">
            {page.period && (
              <span>
                <Icon name="calendar" className="ic-sm" /> {day(page.period.from)} – {day(page.period.to)}
              </span>
            )}
            {daysLeft !== null && (
              <span>
                <Icon name="clock" className="ic-sm" /> {daysLeft <= 1 ? 'Ends today' : `Ends in ${daysLeft} days`}
              </span>
            )}
          </div>
        </div>
        <div className="art" aria-hidden="true">
          {(hero?.images ?? []).slice(0, 4).map((img) => (
            <Pic key={img.id} image={img} />
          ))}
          {!hero?.images.length &&
            blocks
              .flatMap((b) => b.products)
              .slice(0, 4)
              .map((t) => <Pic key={t.productId} image={t.image} />)}
        </div>
      </section>
      <SectionChips blocks={blocks} only={only} setOnly={setOnly} />
      {blocks.map((s) =>
        only && only !== s.id ? null : (
          <section key={s.id} className="stack gap-4" aria-label={s.title ?? 'Products'}>
            <div className="row between base">
              <h2 className="h2">
                <span className="row gap-2">
                  {s.icon && <Icon name={contentIcon(s.icon, 'tag')} />}
                  {s.title}
                </span>
              </h2>
              {s.link && (
                <Link className="small strong" to={contentLinkTo(s.link.url)}>
                  {s.link.label || 'See all'} <Icon name="arrow-right" className="ic-sm" />
                </Link>
              )}
            </div>
            <TileGrid tiles={s.products} />
          </section>
        ),
      )}
      {blocks.length === 0 && (
        <EmptyState icon="package-search" title="Nothing in stock in this campaign right now" as="h2">
          Items come back as sellers restock.
        </EmptyState>
      )}
      {terms.map((t) => (
        <section key={t.id} className="card pad stack gap-2" aria-labelledby={`t-${t.id}`}>
          <h2 className="h4" id={`t-${t.id}`}>
            {t.title ?? `${page.title} terms`}
          </h2>
          <ul className="ul small sub stack gap-1">
            {t.items!.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}

/* ---------------- Curated collection ---------------- */

function Curated({ page }: { page: StorePage }) {
  const [only, setOnly] = useState('');
  const blocks = sections(page);
  const c = page.curator;
  return (
    <>
      <PageCrumbs page={page} title={page.title} />
      <section className="stack gap-3 measure-lg" aria-labelledby="cc-h">
        <span className="eyebrow">{page.eyebrow ?? 'Curated collection'}</span>
        <h1 className="display d-xl" id="cc-h">
          {page.title}
        </h1>
        {page.intro && <p className="lead">{page.intro}</p>}
        {c && (
          <div className="row gap-3">
            <Avatar name={c.name} />
            <span className="stack gap-0">
              <span className="small strong">Curated by {c.name}</span>
              <span className="xs muted">
                Updated {day(c.updatedAt)} · {c.sectionCount} sections · {c.productCount} products
              </span>
            </span>
          </div>
        )}
      </section>
      {page.notes.length > 0 && (
        <Alert tone="info" title={page.notes[0]}>
          {page.notes.slice(1).join(' ')}
        </Alert>
      )}
      <SectionChips blocks={blocks} only={only} setOnly={setOnly} />
      {blocks.map((s) =>
        only && only !== s.id ? null : (
          <CuratedSection key={s.id} s={s} />
        ),
      )}
      {blocks.length === 0 && (
        <EmptyState icon="package-search" title="Nothing in stock in this collection right now" as="h2">
          We replace or remove items that sell out.
        </EmptyState>
      )}
      <p className="xs muted">Prices and stock are live and can change before you check out. You’ll see the final total before paying.</p>
    </>
  );
}

function CuratedSection({ s }: { s: Block }) {
  const cards = useProductCards(s.products.map((t) => t.productId));
  return (
    <section className="stack gap-4" aria-labelledby={`cc-${s.id}`}>
      <div className="stack gap-2">
        <h2 className="h2 row gap-2" id={`cc-${s.id}`}>
          {s.icon && <Icon name={contentIcon(s.icon, 'tag')} />}
          {s.title}
        </h2>
        {(s.editorNote ?? s.body) && (
          <p className="small sub u-maxw-72ch">
            {s.editorNote ? (
              <>
                <b>Editor’s note:</b> {s.editorNote}
              </>
            ) : (
              s.body
            )}
          </p>
        )}
      </div>
      <div className="grid-products">
        {s.products.map((t) => (
          <div key={t.productId} className="stack gap-2">
            <ApiProductCard c={tileToCard(t, cards.data?.get(t.productId))} from showSeller />
            {t.availability && (
              <span className="row gap-2">
                <StatusBadge status={STOCK[t.availability] ?? t.availability} />
                <span className="xs muted">
                  {[t.availableQty != null ? `${t.availableQty} available` : null, t.checkedAt ? `checked ${time(t.checkedAt)}` : null].filter(Boolean).join(' · ')}
                </span>
              </span>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
