import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useSearchParams } from 'react-router';
import { cx } from '@marketly/web-shared/lib/cx';
import { shortDate, date as longishDate } from '@marketly/web-shared/lib/dates';
import { href } from '@marketly/web-shared/routes';
import { Alert, Button, Card, Icon, iconFor, Img, LogoMark, PageHeader, RichText, Select, SegmentedControl, type ContentLink, type IconName } from '@marketly/web-shared/ui';
import { AdminLayout } from '@marketly/web-shared/layouts';
import { useStaffSession } from '@/app/session';
import {
  cardOf, categoryArt, categoryPath, decodeEntities, deptLabel, type DeptKey, discountLabel, initials, num, percentOffBps, plural, price, productPath, PREVIEW_DEPARTMENTS, PREVIEW_SCREENS, resetStoreSession, routeOf, tabOf, tileOf, tileTint, useCards, useStore,
  type AdDecision, type Brand, type CategoryDetail, type Category, type CatalogProduct, type CouponCard, type DealProduct, type DealsPage, type FlashItem, type FlashSaleBlock, type HomeSection, type Homepage, type MediaRef, type NewsCard, type OfferView, type PageBlock, type ProductCard, type ProductTile, type PurchaseBox, type RatingSummary, type Route, type SearchContext, type SearchHit, type StorePage, type Page as ApiPage,
} from './data/appPreview';
import { DepartmentScreen } from './AppPreviewDepartments';
import { AppPage, AppsListPage, BlogAuthorPage, BlogPostPage, CompanyPage, FoodItemPage, FoodListPage, GamePage, MachinePage, PhonePage, ProviderPage, RestaurantPage, ServicePage } from './AppPreviewSubPages';
import { AdSlot, Countdown, ErrorBox, Loading, NavCtx, PCard, PriceLine, SectionHead, StateBox, Tap, TapLink, useAds, useNav, useScreenTitle, type Nav } from './AppPreviewUi';
import './AppPreview.css';

/**
 * Admin › Marketing and content › App preview — the Android customer app's screens, drawn here with the live
 * content customers get, so a Content Manager can check a homepage layout, a department rail, a campaign page or a
 * news post on the phone without installing the app.
 *
 * What it draws is the app, not the website: the same screens, sections, cards, app bar and bottom tab bar as
 * Android app's own code (the `app/` module: HomeFragment, CategoriesFragment, CategoryFragment, ProductFragment,
 * DealsFragment, NewsFragment, against android-customer-app/screens/*.md), from the same calls it makes. The content,
 * prices, stock, deals, departments, news and ads are real; what the app does for a signed-in shopper is not:
 * nothing is added to a cart, no order, review or sign-in is possible, "Recently viewed" is empty (a preview is a
 * fresh guest) and ad displays and clicks are never reported, so nothing here is billed to an advertiser. Tapping
 * one of those actions says so in the app's own snackbar.
 *
 * The ten department pages (AppPreviewDepartments.tsx) are here too — they exist only in the app, so this is the
 * only place outside a phone where the Departments rail's destinations can be checked. The screens still outside
 * the preview (cart, account, a department's own sub-pages, help…) answer with a short card that names the path
 * the link opens, so the links of a homepage section or a department tile can still be checked.
 */

// ---------------------------------------------------------------- Home (feature/home/HomeFragment.kt)

/** Most products a home grid draws (10 rows of 2), as in the app. */
const MAX_GRID_PRODUCTS = 20;

function HomeScreen() {
  const home = useStore<Homepage>(['home'], '/api/store/content/home?device=app');
  const sections = home.data?.sections ?? [];
  const ids = sections.flatMap((s) => (s.products ?? []).map((p) => p.productId).concat((s.deals ?? []).flatMap((d) => d.items.map((i) => i.productId))));
  const cards = useCards(ids);
  const ads = useAds('home', sections.filter((s) => s.kind === 'ad_position').map((s) => s.adPlacementKey ?? ''));

  if (home.isPending) return <Loading />;
  if (home.isError) return <ErrorBox title="We couldn’t load the home page" error={home.error} onRetry={() => void home.refetch()} />;

  return (
    <div className="ap-page">
      {sections.map((s) => (
        <HomeSectionView key={s.id} s={s} cards={cards} ads={ads.data} />
      ))}
    </div>
  );
}

function HomeSectionView({ s, cards, ads }: { s: HomeSection; cards: Record<string, ProductCard>; ads: AdDecision | undefined }) {
  const products = s.products ?? [];
  switch (s.kind) {
    case 'campaign_banner':
      return s.banner ? (
        <div className="ap-section">
          <Banner b={s.banner} />
        </div>
      ) : null;

    case 'departments':
      return (s.departments ?? []).length ? (
        <div className="ap-section">
          <div className="ap-tiles">
            {(s.departments ?? []).map((d) => (
              <Tap key={d.id} className="ap-tile" to={d.link?.url}>
                <Img icon={iconFor(d.icon, 'layout-grid')} tint={String(d.tint ?? 1)} src={d.image?.url ?? undefined} alt="" />
                <span>{decodeEntities(d.label || d.title)}</span>
              </Tap>
            ))}
          </div>
        </div>
      ) : null;

    case 'category_shortcuts':
      return (s.categories ?? []).length ? (
        <div className="ap-section">
          <SectionHead title={s.heading ?? 'Shop by category'} link={s.link?.label ?? 'All categories'} to={s.link?.url ?? '/categories'} />
          <div className="ap-tiles">
            {(s.categories ?? []).map((c) => {
              const art = categoryArt(c.slug);
              return (
                <Tap key={c.categoryId} className="ap-tile" to={c.slug ? categoryPath(c.slug) : null}>
                  <Img icon={art.icon} tint={art.tint} src={c.image?.url ?? undefined} alt="" />
                  <span>{c.name}</span>
                </Tap>
              );
            })}
          </div>
        </div>
      ) : null;

    case 'deals':
      return <HomeDeals s={s} cards={cards} />;

    case 'official_highlights':
      return products.length ? (
        <div className="ap-section">
          <div className="ap-gutter">
            <h2 className="ap-h2">{decodeEntities(s.heading ?? 'Sold and shipped by Marketly')}</h2>
            {s.subheading && <p className="ap-sm ap-sub" style={{ margin: '6px 0 0' }}>{decodeEntities(s.subheading)}</p>}
          </div>
          <div className="ap-gutter ap-grid" style={{ marginTop: 16 }}>
            {products.slice(0, 4).map((t, i) => (
              <PCard key={`${t.productId}-${i}`} m={tileOf(t, cards[t.productId])} compact />
            ))}
          </div>
          <div className="ap-gutter" style={{ marginTop: 16 }}>
            <TapLink to="/official" label="Visit the Official Store" />
          </div>
        </div>
      ) : null;

    case 'featured_products':
    case 'popular_products':
    case 'collection_teaser':
      return products.length ? (
        <div className="ap-section">
          <SectionHead title={s.heading ?? 'Featured for you'} link={s.link?.label} to={s.link?.url} />
          <div className="ap-gutter ap-grid">
            {products.slice(0, MAX_GRID_PRODUCTS).map((t, i) => (
              <PCard key={`${t.productId}-${i}`} m={tileOf(t, cards[t.productId])} showSeller />
            ))}
          </div>
        </div>
      ) : null;

    case 'new_arrivals':
      return products.length ? (
        <div className="ap-section">
          <SectionHead title={s.heading ?? 'New arrivals'} link={s.link?.label ?? 'See all'} to={s.link?.url ?? '/collection/new-arrivals'} />
          <div className="ap-rail">
            {products.map((t, i) => (
              <div key={`${t.productId}-${i}`} style={{ width: 150 }}>
                <PCard m={tileOf(t, cards[t.productId])} compact />
              </div>
            ))}
          </div>
        </div>
      ) : null;

    case 'featured_sellers':
      return (s.sellers ?? []).length ? (
        <div className="ap-section">
          <SectionHead title={s.heading ?? 'Featured sellers'} link="How sellers are checked" to="/policies/seller-rules" />
          <div className="ap-gutter ap-stack">
            {(s.sellers ?? []).map((seller) => (
              <Tap key={seller.sellerId} className="ap-row-card" to={seller.sellerSlug ? `/shop/${seller.sellerSlug}` : null}>
                <span className="ap-logo">
                  {seller.logo?.url ? <img src={seller.logo.url} alt="" /> : initials(seller.name)}
                </span>
                <span style={{ minWidth: 0, flex: 1 }}>
                  <span className="ap-h4" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    {decodeEntities(seller.name)}
                    {seller.verified && <Icon name="badge-check" style={{ width: 15, height: 15, color: 'var(--brand)' }} />}
                  </span>
                  <span className="ap-xs ap-muted" style={{ display: 'block', marginTop: 2 }}>
                    {[seller.location, seller.dispatchLabel?.split(' · ')[0]].filter(Boolean).join(' · ')}
                  </span>
                </span>
                {seller.positivePct != null && <span className="ap-badge success">{Math.round(seller.positivePct)}% positive</span>}
              </Tap>
            ))}
          </div>
        </div>
      ) : null;

    case 'brand_collections':
      return (s.brands ?? []).length ? (
        <div className="ap-section">
          <SectionHead title={s.heading ?? 'Brand collections'} link={s.link?.label} to={s.link?.url} />
          <div className="ap-rail">
            {(s.brands ?? []).map((b) => (
              <Tap key={b.brandId} className="ap-brand-card" to={(b.slug ?? b.pageSlug) ? `/brand/${b.slug ?? b.pageSlug}` : null}>
                <span className="ap-logo">{b.logo?.url ? <img src={b.logo.url} alt="" /> : initials(b.name)}</span>
                <span className="ap-h4" style={{ display: 'block' }}>{decodeEntities(b.name)}</span>
                <span className="ap-xs ap-muted">{num(b.productCount ?? 0)} products</span>
              </Tap>
            ))}
          </div>
        </div>
      ) : null;

    case 'promise_strip':
      return (s.promiseItems ?? []).length ? (
        <div className="ap-section ap-gutter">
          <div className="ap-promise">
            {(s.promiseItems ?? []).slice(0, 4).map((p) => (
              <div key={p.title} className="ap-promise-item">
                <Icon name={iconFor(p.icon, 'circle-check')} />
                <div className="ap-h4">{decodeEntities(p.title)}</div>
                <div className="ap-xs ap-muted" style={{ marginTop: 4 }}>{decodeEntities(p.body)}</div>
              </div>
            ))}
          </div>
        </div>
      ) : null;

    case 'news':
      return (s.news ?? []).length ? (
        <div className="ap-section">
          <SectionHead title={s.heading ?? 'Latest news'} link={s.link?.label ?? 'All news'} to={s.link?.url ?? '/news'} />
          <div className="ap-rail">
            {(s.news ?? []).slice(0, 3).map((n) => (
              <NewsRailCard key={n.id} n={n} />
            ))}
          </div>
        </div>
      ) : null;

    case 'ad_position':
      return s.adPlacementKey && s.adPlacementKey !== 'opening_fullscreen' ? <AdSlot decision={ads} slotKey={s.adPlacementKey} /> : null;

    // recently_viewed is empty for the preview's guest session; unknown future kinds are skipped, as in the app.
    default:
      return null;
  }
}

function Banner({ b }: { b: NonNullable<HomeSection['banner']> }) {
  const { go } = useNav();
  return (
    <div className={cx('ap-banner', b.theme === 'light' && 'light', b.theme === 'dark' && 'dark')}>
      {b.eyebrow && <div className="ap-eyebrow">{decodeEntities(b.eyebrow)}</div>}
      <h2>{decodeEntities(b.headline)}</h2>
      {b.body && <p>{decodeEntities(b.body)}</p>}
      <div className="ap-banner-cta">
        {b.primaryCta?.label && (
          <button type="button" className="ap-btn sm" onClick={() => go(b.primaryCta?.url ?? '/')}>
            {b.primaryCta.label}
          </button>
        )}
        {b.secondaryCta?.label && (
          <button type="button" className="ap-btn sm secondary" onClick={() => go(b.secondaryCta?.url ?? '/')}>
            {b.secondaryCta.label}
          </button>
        )}
      </div>
    </div>
  );
}

/** Home's flash-deal row: the live flash sale's items, else the section's deal products. */
function HomeDeals({ s, cards }: { s: HomeSection; cards: Record<string, ProductCard> }) {
  const sale = (s.deals ?? []).find((d) => d.state === 'live') ?? (s.deals ?? [])[0];
  const items = sale?.items?.length
    ? sale.items.map((i) => ({
        key: i.id,
        productId: i.productId,
        slug: cards[i.productId]?.slug ?? null,
        title: i.title,
        image: i.image ?? cards[i.productId]?.image ?? null,
        now: i.dealPrice,
        was: i.regularPrice,
        off: percentOffBps(i.percentOffBps),
        limit: i.purchaseLimit,
        claimedPct: i.claimedPct ?? 0,
        soldOut: i.state === 'sold_out',
      }))
    : (s.products ?? []).map((t) => {
        const c = cards[t.productId];
        return {
          key: t.productId,
          productId: t.productId,
          slug: t.slug ?? c?.slug ?? null,
          title: t.title,
          image: t.image ?? c?.image ?? null,
          now: t.price,
          was: t.wasPrice,
          off: t.badge ?? discountLabel(t.price, t.wasPrice, c?.discountPct),
          limit: null as number | null,
          claimedPct: null as number | null,
          soldOut: t.availability === 'out_of_stock',
        };
      });
  if (!items.length) return null;

  return (
    <div className="ap-section">
      <div className="ap-deals-head ap-gutter">
        <h2>{decodeEntities(s.heading ?? 'Flash deals')}</h2>
        {sale?.state === 'live' && <Countdown seconds={sale.secondsLeft} />}
        <span style={{ flex: 1 }} />
        <TapLink to={s.link?.url ?? '/deals'} label={s.link?.label ?? 'See all deals'} />
      </div>
      <div className="ap-rail">
        {items.map((d, i) => (
          <Tap key={`${d.key}-${i}`} className="ap-deal" to={productPath(d.slug, d.productId)} label={d.title}>
            <div className="ap-pcard-art">
              <Img icon="package" tint={tileTint(d.productId)} src={d.image?.thumbUrl ?? d.image?.url ?? undefined} alt="" />
              <div className="ap-pcard-tags">
                {d.off && <span className="ap-badge deal">{d.off}</span>}
                {d.limit ? <span className="ap-badge outline">Limit {d.limit}</span> : null}
                {d.soldOut && <span className="ap-badge">Deal sold out</span>}
              </div>
            </div>
            <PriceLine now={d.now} was={d.was} className="deal" />
            <div className="ap-pcard-title ap-clamp2">{decodeEntities(d.title)}</div>
            {d.claimedPct != null && !d.soldOut && (
              <>
                <div className="ap-meter">
                  <i style={{ width: `${Math.min(100, d.claimedPct)}%` }} />
                </div>
                <div className="ap-pcard-line">{d.claimedPct}% claimed</div>
              </>
            )}
            {d.soldOut && <div className="ap-pcard-line ap-strong">Deal sold out</div>}
          </Tap>
        ))}
      </div>
    </div>
  );
}

function NewsRailCard({ n }: { n: NewsCard }) {
  return (
    <Tap className="ap-news-rail-card" to={`/news/${n.slug}`} label={n.title}>
      <Img icon={iconFor(n.category.icon, 'newspaper')} tint={tileTint(n.category.slug || n.category.name)} src={n.cover?.url ?? undefined} alt="" />
      <div className="ap-xs ap-muted">{[n.category.name, n.publishedAt && shortDate(n.publishedAt)].filter(Boolean).join(' · ')}</div>
      <div className="ap-h4 ap-clamp2" style={{ marginTop: 2 }}>{decodeEntities(n.title)}</div>
    </Tap>
  );
}

// ---------------------------------------------------------------- Categories (feature/browse/CategoriesFragment.kt)

function CategoriesScreen() {
  const tree = useStore<Category[]>(['categories'], '/api/store/catalog/categories');
  const [selected, setSelected] = useState<string | null>(null);
  const list = tree.data ?? [];
  const current = list.find((c) => c.id === selected && !c.comingSoon) ?? list.find((c) => !c.comingSoon);

  if (tree.isPending) return <Loading />;
  if (tree.isError) return <ErrorBox title="We couldn’t load the categories" error={tree.error} onRetry={() => void tree.refetch()} />;
  if (!current) return <StateBox icon="layout-grid" title="No categories yet" action="Retry" onAction={() => void tree.refetch()} />;

  return (
    <div className="ap-cats">
      <div className="ap-cats-rail">
        {list.map((c) => {
          const art = categoryArt(c.slug);
          const on = c.id === current.id;
          return (
            <button key={c.id} type="button" className={cx('ap-rail-item', on && 'on')} disabled={c.comingSoon} style={c.comingSoon ? { opacity: 0.6 } : undefined} onClick={() => setSelected(c.id)}>
              {c.image ? <Img icon={art.icon} tint={art.tint} src={c.image.url ?? undefined} alt="" /> : <Icon name={art.icon} />}
              <span>{c.name}</span>
              {c.comingSoon && <span className="ap-badge">Soon</span>}
            </button>
          );
        })}
      </div>
      <CategoryPane c={current} />
    </div>
  );
}

/** `browse_pct_off`: the Categories pane's deal shows "21% off", not the card's "−21%". */
const pctOff = (p?: { amount: number } | null, was?: { amount: number } | null, pct?: number | null): number | null =>
  pct && pct > 0 ? pct : p && was && was.amount > p.amount ? Math.trunc(((was.amount - p.amount) * 100) / was.amount) || null : null;

function CategoryPane({ c }: { c: Category }) {
  const { go } = useNav();
  const brands = useStore<ApiPage<Brand>>(['brands', c.slug], `/api/store/catalog/brands?categorySlug=${encodeURIComponent(c.slug)}&sort=popular&limit=3`);
  const deal = useStore<ApiPage<SearchHit>>(['category-deal', c.slug], `/api/store/search/products?category=${encodeURIComponent(c.slug)}&onSale=true&limit=1`);
  const d = deal.data?.items?.[0]?.product;
  const parentArt = categoryArt(c.slug);

  return (
    <div className="ap-cats-pane">
      <h1 className="ap-h2">{c.name}</h1>
      <button type="button" className="ap-link" style={{ marginTop: 4 }} onClick={() => go(categoryPath(c.slug))}>
        Shop all ({num(c.productCount ?? 0)})
      </button>

      <div className="ap-subs" style={{ marginTop: 16 }}>
        {(c.children ?? []).map((sub) => {
          const art = categoryArt(sub.slug, c.slug);
          return (
            <Tap key={sub.id} className="ap-subtile" to={sub.comingSoon ? null : categoryPath(sub.slug)}>
              <Img icon={art.icon} tint={sub.comingSoon ? 'surface-3' : parentArt.tint} src={sub.comingSoon ? undefined : (sub.image?.url ?? undefined)} alt="" />
              <span className="ap-subtile-name">{sub.name}</span>
              <span className="ap-xs ap-muted" style={{ display: 'block' }}>{sub.comingSoon ? 'Coming soon' : plural(sub.productCount ?? 0, 'item')}</span>
            </Tap>
          );
        })}
      </div>

      {!!brands.data?.items?.length && (
        <>
          <h2 className="ap-h3" style={{ marginTop: 24 }}>Popular brands</h2>
          <div className="ap-subs" style={{ marginTop: 12 }}>
            {brands.data.items.slice(0, 3).map((b) => (
              <Tap key={b.id} className="ap-subtile" to={`/brand/${b.slug}`}>
                <span className="ap-logo" style={{ width: 56, height: 56, margin: '0 auto 6px' }}>
                  {b.logo?.url ? <img src={b.logo.url} alt="" /> : initials(b.name)}
                </span>
                <span className="ap-subtile-name">{decodeEntities(b.name)}</span>
              </Tap>
            ))}
          </div>
        </>
      )}

      {d && (
        <>
          <h2 className="ap-h3" style={{ marginTop: 24 }}>{c.name} deals</h2>
          <Tap className="ap-row-card" to={productPath(d.slug, d.productId)} label={d.title}>
            <span style={{ flex: 'none', width: 64 }}>
              <Img icon="package" tint={tileTint(d.productId)} src={d.image?.thumbUrl ?? d.image?.url ?? undefined} alt="" />
            </span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span className="ap-sm ap-strong ap-clamp2" style={{ display: 'block' }}>{decodeEntities(d.title ?? '')}</span>
              <PriceLine now={d.price} was={d.wasPrice} />
            </span>
            {pctOff(d.price, d.wasPrice, d.discountPct) != null && <span className="ap-badge deal">{pctOff(d.price, d.wasPrice, d.discountPct)}% off</span>}
          </Tap>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Category listing (feature/browse/CategoryFragment.kt)

const DEFAULT_SORTS = [
  { key: 'recommended', label: 'Recommended' },
  { key: 'price_asc', label: 'Price: low to high' },
  { key: 'price_desc', label: 'Price: high to low' },
  { key: 'newest', label: 'Newest' },
  { key: 'rating', label: 'Customer rating' },
];

function CategoryScreen({ slug }: { slug: string }) {
  const [sort, setSort] = useState('recommended');
  const { note } = useNav();
  const head = useStore<CategoryDetail>(['category', slug], `/api/store/catalog/categories/${encodeURIComponent(slug)}`);
  const tree = useStore<Category[]>(['categories'], '/api/store/catalog/categories');
  const query = `category=${encodeURIComponent(slug)}&sort=${sort}`;
  const ctx = useStore<SearchContext>(['facets', slug, sort], `/api/store/search/facets?${query}`);
  const hits = useStore<ApiPage<SearchHit>>(['listing', slug, sort], `/api/store/search/products?${query}&limit=24`);
  const ads = useAds('category', ['category_banner'], head.data ? { categoryId: head.data.category.id } : undefined);

  const chips = useMemo(() => {
    const list = tree.data ?? [];
    const find = (nodes: Category[]): [Category | null, Category | null] => {
      for (const n of nodes) {
        if (n.slug === slug) return [n, null];
        const hit = (n.children ?? []).find((k) => k.slug === slug);
        if (hit) return [hit, n];
      }
      return [null, null];
    };
    const [node, parent] = find(list);
    const level = node && (node.children ?? []).length ? node : parent;
    if (!level) return [];
    const all = [{ slug: level.slug, label: `All ${level.name.toLowerCase()}` }];
    const out = all.concat((level.children ?? []).filter((k) => !k.comingSoon).map((k) => ({ slug: k.slug, label: k.name })));
    return out.length >= 2 ? out : [];
  }, [tree.data, slug]);

  useScreenTitle(head.data?.category.name);
  if (head.isPending) return <Loading />;
  if (head.isError) return <ErrorBox title="We couldn’t load this category" error={head.error} onRetry={() => void head.refetch()} />;

  const cards = (hits.data?.items ?? []).map((h) => cardOf(h.product));

  return (
    <div className="ap-page">
      <div className="ap-gutter" style={{ paddingTop: 20 }}>
        <span className="ap-sm ap-sub">{ctx.data?.totalLabel ?? ''}</span>
      </div>
      {chips.length > 0 && (
        <div className="ap-chips" style={{ marginTop: 16 }}>
          {chips.map((c) => (
            <Tap key={c.slug} className={cx('ap-chip', c.slug === slug && 'on')} to={c.slug === slug ? null : categoryPath(c.slug)}>
              {c.label}
            </Tap>
          ))}
        </div>
      )}
      <AdSlot decision={ads.data} slotKey="category_banner" />
      <div className="ap-controls">
        <button type="button" className="ap-btn secondary sm" onClick={() => note('Filters are off in the preview.')}>
          <Icon name="sliders-horizontal" />
          Filters
        </button>
        <span style={{ flex: 1 }} />
        <span className="ap-sm ap-muted">Sort by</span>
        <label className="ap-sortbox">
          <select value={sort} onChange={(e) => setSort(e.target.value)} style={{ font: 'inherit', color: 'inherit', background: 'none', border: 0, outline: 'none' }} aria-label="Sort by">
            {(ctx.data?.sorts?.filter((s) => s.available !== false) ?? DEFAULT_SORTS).map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {hits.isPending ? (
        <Loading />
      ) : hits.isError ? (
        <ErrorBox title="We couldn’t load this category" error={hits.error} onRetry={() => void hits.refetch()} />
      ) : cards.length === 0 ? (
        <StateBox icon="search-x" title={`No ${head.data.category.name.toLowerCase()} match these filters`} text="Nothing is in stock here right now. Check back soon." />
      ) : (
        <div className="ap-gutter ap-grid" style={{ marginTop: 16 }}>
          {cards.map((m, i) => (
            <PCard key={`${m.productId}-${m.variantId ?? ''}-${i}`} m={m} showSeller />
          ))}
        </div>
      )}
      {ctx.data?.fromPriceNote && (
        <div className="ap-gutter ap-xs ap-muted" style={{ marginTop: 16 }}>
          {ctx.data.fromPriceNote}
        </div>
      )}
      <div className="ap-gutter ap-xs ap-muted" style={{ marginTop: 16 }}>
        {ctx.data?.rankingNote ?? 'Sponsored items are paid placements and are labeled.'}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Product (feature/product/ProductFragment.kt)

function ProductScreen({ id }: { id: string }) {
  const [at, setAt] = useState(0);
  const [variant, setVariant] = useState<string | null>(null);
  const p = useStore<CatalogProduct>(['product', id], `/api/store/catalog/products/${encodeURIComponent(id)}`);
  const box = useStore<PurchaseBox>(['box', id, variant ?? ''], `/api/store/offers/products/${encodeURIComponent(id)}/purchase-box${variant ? `?variantId=${encodeURIComponent(variant)}` : ''}`);
  const rating = useStore<RatingSummary>(['rating', id], `/api/store/reviews/products/${encodeURIComponent(id)}/rating-summary`);
  const similar = useStore<ProductCard[]>(['similar', id], `/api/store/search/products/${encodeURIComponent(id)}/similar?limit=4`);

  useScreenTitle(p.data?.title);
  if (p.isPending) return <Loading />;
  if (p.isError) return <ErrorBox title="We couldn’t load this product" error={p.error} onRetry={() => void p.refetch()} />;

  const product = p.data;
  const currentVariant = box.data?.variantId ?? variant;
  const images: MediaRef[] = (product.variants ?? []).find((v) => v.id === currentVariant)?.images?.length
    ? (product.variants ?? []).find((v) => v.id === currentVariant)!.images!
    : (product.images ?? []);
  const shown = images[Math.min(at, Math.max(0, images.length - 1))];
  const offer = box.data?.selected;
  const specs = Object.entries(product.specs ?? {});

  return (
    <div className="ap-page ap-page-flush">
      <div className="ap-gallery">
        <Img icon="package" tint={tileTint(product.id)} src={shown?.detailUrl ?? shown?.url ?? undefined} alt={shown?.alt ?? ''} />
        {images.length > 0 && (
          <span className="ap-gallery-count">
            {Math.min(at, images.length - 1) + 1} / {images.length}
          </span>
        )}
      </div>
      {images.length > 1 && (
        <div className="ap-thumbs">
          {images.map((m, i) => (
            <Img key={m.id ?? i} icon="package" tint={tileTint(product.id)} className={cx(i === at && 'on')} src={m.thumbUrl ?? m.url ?? undefined} alt="" />
          ))}
        </div>
      )}
      {images.length > 1 && (
        <div className="ap-gutter ap-xs ap-muted" style={{ marginTop: 8 }}>
          <button type="button" className="ap-link" onClick={() => setAt((n) => (n + 1) % images.length)}>
            Next photo
          </button>
        </div>
      )}

      <div className="ap-gutter" style={{ marginTop: 16 }}>
        {product.brand?.slug && <TapLink to={`/brand/${product.brand.slug}`} label={`Visit the ${product.brand.name} brand page`} />}
        <h1 className="ap-h1" style={{ marginTop: 6 }}>{decodeEntities(product.title)}</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
          {product.isNewListing && <span className="ap-badge info">New listing</span>}
          <span className="ap-sm ap-sub">
            {rating.data?.hasReviews && rating.data.average != null ? `★ ${rating.data.average.toFixed(1)} (${num(rating.data.ratingCount ?? 0)})` : 'No reviews yet'}
          </span>
          <span className="ap-sm ap-muted">·</span>
          <span className="ap-sm ap-sub">{plural(rating.data?.answeredQuestions ?? 0, 'answered question')}</span>
        </div>
        {product.listedAt && <div className="ap-sm ap-muted" style={{ marginTop: 6 }}>Listed on Marketly {longishDate(product.listedAt)}</div>}
      </div>

      {!!box.data?.variants?.length && (
        <div className="ap-section">
          <div className="ap-gutter ap-h4" style={{ marginBottom: 10 }}>
            {Object.keys(box.data.variants[0].options ?? {}).join(' / ') || 'Options'}
          </div>
          <div className="ap-variants">
            {box.data.variants.map((v) => (
              <button key={v.variantId} type="button" className={cx('ap-variant', v.variantId === currentVariant && 'on')} onClick={() => (setVariant(v.variantId), setAt(0))}>
                <Img icon="package" tint={tileTint(v.variantId)} src={(product.variants ?? []).find((x) => x.id === v.variantId)?.images?.[0]?.thumbUrl ?? undefined} alt="" />
                <span className="ap-sm ap-strong" style={{ display: 'block' }}>{v.label || Object.values(v.options ?? {}).join(' · ')}</span>
                <span className="ap-xs ap-muted">{[v.lowestPrice ? price(v.lowestPrice) : null, v.inStock === false ? 'Out of stock' : 'In stock'].filter(Boolean).join(' · ')}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="ap-section">
        {box.isPending ? (
          <div className="ap-gutter">
            <div className="ap-skel" style={{ height: 120 }} />
          </div>
        ) : box.isError ? (
          <ErrorBox title="The offer couldn’t be loaded" error={box.error} onRetry={() => void box.refetch()} />
        ) : offer ? (
          <div className="ap-box">
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <PriceLine now={offer.price} was={offer.compareAt?.amount} />
              {offer.discountPct ? <span className="ap-badge deal">−{offer.discountPct}%</span> : null}
            </div>
            {offer.promotion?.label && <div className="ap-sm" style={{ color: 'var(--deal-text)', marginTop: 4 }}>{offer.promotion.label}</div>}
            <dl style={{ margin: '12px 0 0' }}>
              <div className="ap-kv">
                <dt>Delivery</dt>
                <dd>{offer.delivery?.label ?? '—'}{box.data?.deliverTo?.label ? ` · to ${box.data.deliverTo.label}` : ''}</dd>
              </div>
              <div className="ap-kv">
                <dt>Sold by</dt>
                <dd>{decodeEntities(offer.seller?.name ?? '')}{offer.seller?.official ? ' (Official Store)' : ''}</dd>
              </div>
              <div className="ap-kv">
                <dt>Availability</dt>
                <dd>{offer.availability?.label ?? (offer.availability?.state === 'out_of_stock' ? 'Out of stock' : 'In stock')}</dd>
              </div>
              {offer.returns?.summary && (
                <div className="ap-kv">
                  <dt>Returns</dt>
                  <dd>{offer.returns.summary}</dd>
                </div>
              )}
              {offer.warranty?.summary && (
                <div className="ap-kv">
                  <dt>Warranty</dt>
                  <dd>{offer.warranty.summary}</dd>
                </div>
              )}
            </dl>
            {!!box.data?.otherOffers?.count && (
              <div style={{ marginTop: 10 }}>
                <TapLink to={`/p/${product.slug}/${product.id}/offers`} label={box.data.otherOffers.label ?? `${box.data.otherOffers.count} more offers`} />
              </div>
            )}
          </div>
        ) : (
          <div className="ap-box">
            <div className="ap-h4">{box.data?.unavailable?.title ?? 'Currently unavailable'}</div>
            <div className="ap-sm ap-sub" style={{ marginTop: 4 }}>{box.data?.unavailable?.message ?? 'No seller offers this item right now.'}</div>
          </div>
        )}
      </div>

      {!!product.keyFeatures?.length && (
        <div className="ap-section ap-gutter">
          <h2 className="ap-h3">Key features</h2>
          <ul className="ap-bullets" style={{ marginTop: 8 }}>
            {product.keyFeatures.map((f) => (
              <li key={f}>{decodeEntities(f)}</li>
            ))}
          </ul>
        </div>
      )}

      {product.description && (
        <div className="ap-section ap-gutter">
          <h2 className="ap-h3">About this item</h2>
          <p className="ap-sm ap-sub" style={{ marginTop: 8 }}>{decodeEntities(product.description)}</p>
        </div>
      )}

      {!!product.includedItems?.length && (
        <div className="ap-section ap-gutter">
          <h2 className="ap-h3">In the box</h2>
          <ul className="ap-bullets" style={{ marginTop: 8 }}>
            {product.includedItems.map((i) => (
              <li key={i}>{decodeEntities(i)}</li>
            ))}
          </ul>
        </div>
      )}

      {specs.length > 0 && (
        <div className="ap-section ap-gutter">
          <h2 className="ap-h3">Specifications</h2>
          <dl style={{ margin: '8px 0 0' }}>
            {specs.map(([k, v]) => (
              <div key={k} className="ap-kv">
                <dt>{k}</dt>
                <dd>{String(v)}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      {!!similar.data?.length && (
        <div className="ap-section">
          <SectionHead title="Similar products" />
          <div className="ap-gutter ap-grid">
            {similar.data.slice(0, 4).map((c, i) => (
              <PCard key={`${c.productId}-${i}`} m={cardOf(c)} showSeller />
            ))}
          </div>
        </div>
      )}
      <ProductActionBar offer={offer} />
    </div>
  );
}

/** The product page's sticky bar: price and delivery, Add to cart, Buy now (it follows the chosen variant). */
function ProductActionBar({ offer }: { offer?: OfferView | null }) {
  const { note } = useNav();
  if (!offer) return null;
  return (
    <div className="ap-actionbar ap-actionbar-sticky">
      <div className="ap-actionbar-price">
        <PriceLine now={offer.price} was={offer.compareAt?.amount} />
        <div className="ap-xs ap-muted">{offer.delivery?.label ?? ''}</div>
      </div>
      <button type="button" className="ap-btn" onClick={() => note('Adding to the cart is off in the preview.')}>
        Add to cart
      </button>
      <button type="button" className="ap-btn secondary" onClick={() => note('Buying is off in the preview.')}>
        Buy now
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- Deals (feature/browse/DealsFragment.kt)

const DEAL_TABS = ['all', 'flash', 'clearance', 'coupons', 'events'] as const;
const DEAL_TAB_LABEL: Record<string, string> = { all: 'All deals', flash: 'Flash sales', clearance: 'Clearance', coupons: 'Coupons', events: 'Upcoming events' };

function DealsScreen() {
  const [tab, setTab] = useState<string>('all');
  const deals = useStore<DealsPage>(['deals', tab], `/api/store/promotions/deals?tab=${tab}`);
  const campaigns = useStore<ApiPage<{ id: string; slug: string; title: string; eyebrow?: string | null; image?: MediaRef | null; endsAt?: string | null }>>(['campaign-pages'], '/api/store/content/campaign-pages?limit=20');
  const page = deals.data;
  const ids = [...(page?.flashSales ?? []).flatMap((f) => f.items.map((i) => i.productId)), ...(page?.clearance ?? []).map((c) => c.productId)];
  const cards = useCards(ids);
  const show = (key: string) => tab === 'all' || tab === key;

  return (
    <div className="ap-page">
      <div className="ap-gutter" style={{ paddingTop: 20 }}>
        <h1 className="ap-h1">Deals</h1>
        <p className="ap-sm ap-sub" style={{ margin: '8px 0 0' }}>
          Every deal names the seller whose offer it applies to. A deal price is valid only for that offer, until the end time or until deal stock runs out.
        </p>
      </div>

      {!!campaigns.data?.items?.length && (
        <div className="ap-section">
          <SectionHead title="Campaigns" />
          <div className="ap-rail">
            {campaigns.data.items.map((c) => (
              <Tap key={c.id} className="ap-news-rail-card" to={`/pages/${c.slug}`} label={c.title}>
                <Img icon="megaphone" tint={tileTint(c.slug)} src={c.image?.url ?? undefined} alt="" />
                {c.eyebrow && <div className="ap-xs ap-muted">{decodeEntities(c.eyebrow)}</div>}
                <div className="ap-h4 ap-clamp2">{decodeEntities(c.title)}</div>
                {c.endsAt && <div className="ap-xs ap-muted" style={{ marginTop: 2 }}>Ends {shortDate(c.endsAt)}</div>}
              </Tap>
            ))}
          </div>
        </div>
      )}

      <div className="ap-tabs" style={{ marginTop: 20 }} role="tablist" aria-label="Deal types">
        {DEAL_TABS.map((k) => {
          const t = page?.tabs?.find((x) => x.key === k);
          return (
            <button key={k} type="button" role="tab" aria-selected={tab === k} className={cx('ap-tab-item', tab === k && 'on')} onClick={() => setTab(k)}>
              {t?.label ?? DEAL_TAB_LABEL[k]}
              {t?.count != null && <span className="ap-muted">{num(t.count)}</span>}
            </button>
          );
        })}
      </div>

      {deals.isPending ? (
        <Loading />
      ) : deals.isError ? (
        <ErrorBox title="We couldn’t load the deals" error={deals.error} onRetry={() => void deals.refetch()} />
      ) : !page ? null : (
        <DealsSections page={page} cards={cards} show={show} tab={tab} onTab={setTab} />
      )}
    </div>
  );
}

function DealsSections({ page, cards, show, tab, onTab }: { page: DealsPage; cards: Record<string, ProductCard>; show: (k: string) => boolean; tab: string; onTab: (k: string) => void }) {
  const flash = show('flash') ? page.flashSales.filter((f) => f.items.length) : [];
  const coupons = show('coupons') ? page.coupons : [];
  const clearance = show('clearance') ? page.clearance : [];
  const events = show('events') ? page.upcomingEvents : [];
  const nothing = !flash.length && !coupons.length && !clearance.length && !events.length;

  if (nothing) return <StateBox icon="tag" title="No deals here right now" text="New flash sales, coupons and clearance prices show up here as soon as they start." />;

  return (
    <>
      {flash.map((f) => (
        <FlashPanel key={f.campaignId} f={f} cards={cards} />
      ))}

      {!!coupons.length && (
        <div className="ap-section">
          <SectionHead
            title="Coupons"
            link={tab === 'all' && (page.tabs.find((t) => t.key === 'coupons')?.count ?? 0) > coupons.length ? `See all ${num(page.tabs.find((t) => t.key === 'coupons')?.count ?? 0)}` : undefined}
            onLink={() => onTab('coupons')}
          />
          <div className="ap-gutter ap-stack">
            {coupons.map((c) => (
              <Coupon key={c.campaignId} c={c} />
            ))}
          </div>
          {!!page.rules?.length && tab !== 'coupons' && (
            <div className="ap-gutter ap-xs ap-muted" style={{ marginTop: 10 }}>
              {page.rules.slice(0, 2).join(' ')}
            </div>
          )}
        </div>
      )}

      {!!clearance.length && (
        <div className="ap-section">
          <SectionHead
            title="Clearance"
            link={tab === 'all' && (page.tabs.find((t) => t.key === 'clearance')?.count ?? 0) > clearance.length ? `See all ${num(page.tabs.find((t) => t.key === 'clearance')?.count ?? 0)}` : undefined}
            onLink={() => onTab('clearance')}
          />
          <div className="ap-gutter ap-xs ap-muted" style={{ marginBottom: 12, marginTop: -4 }}>
            Clearance prices last while the listed seller’s current stock lasts. Normal return terms apply.
          </div>
          <div className="ap-gutter ap-grid">
            {clearance.map((d, i) => (
              <ClearanceCard key={`${d.offerId ?? d.productId}-${i}`} d={d} card={cards[d.productId]} />
            ))}
          </div>
        </div>
      )}

      {!!events.length && (
        <div className="ap-section">
          <SectionHead title="Upcoming events" />
          <div className="ap-gutter ap-stack">
            {events.map((e) => (
              <div key={e.campaignId} className="ap-row-card">
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span className="ap-h4" style={{ display: 'block' }}>{decodeEntities(e.name)}</span>
                  <span className="ap-xs ap-muted">{e.period?.display ?? ''}</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

function FlashPanel({ f, cards }: { f: FlashSaleBlock; cards: Record<string, ProductCard> }) {
  return (
    <div className="ap-section">
      <div className="ap-deals-head ap-gutter">
        <h2>{decodeEntities(f.name || 'Flash sale')}</h2>
        {(f.state === 'live' || f.state === 'upcoming') && (
          <>
            <span className="ap-xs ap-muted">{f.state === 'upcoming' ? 'Starts in' : 'Ends in'}</span>
            <Countdown seconds={f.secondsLeft} />
          </>
        )}
      </div>
      {f.period?.display && <div className="ap-gutter ap-xs ap-muted" style={{ marginTop: -6, marginBottom: 12 }}>{f.period.display}</div>}
      <div className="ap-gutter ap-grid">
        {f.items.map((d) => (
          <FlashCard key={d.id} d={d} card={cards[d.productId]} />
        ))}
      </div>
    </div>
  );
}

function FlashCard({ d, card }: { d: FlashItem; card?: ProductCard }) {
  const soldOut = d.state === 'sold_out';
  const claimed = soldOut ? 100 : (d.claimedPct ?? 0);
  return (
    <Tap className="ap-pcard" to={productPath(card?.slug ?? null, d.productId)} label={d.title}>
      <div className="ap-pcard-art">
        <Img icon="package" tint={tileTint(d.productId)} src={(d.image ?? card?.image)?.thumbUrl ?? (d.image ?? card?.image)?.url ?? undefined} alt="" />
        <div className="ap-pcard-tags">
          {!soldOut && percentOffBps(d.percentOffBps) && <span className="ap-badge deal">{percentOffBps(d.percentOffBps)}</span>}
          {soldOut && <span className="ap-badge">Deal sold out</span>}
        </div>
      </div>
      <div className="ap-pcard-title ap-clamp2">{decodeEntities(d.title)}</div>
      {soldOut ? (
        <div className="ap-price ap-muted" style={{ textDecoration: 'line-through' }}>{price(d.dealPrice)}</div>
      ) : (
        <PriceLine now={d.dealPrice} was={d.regularPrice} className="deal" />
      )}
      <div className="ap-pcard-line">
        {decodeEntities(d.sellerName ?? '')}
        {d.purchaseLimit ? ` · Limit ${d.purchaseLimit} per customer` : ''}
      </div>
      <div className="ap-meter">
        <i style={{ width: `${Math.min(100, claimed)}%` }} />
      </div>
      <div className="ap-pcard-line">{claimed}% claimed</div>
    </Tap>
  );
}

function ClearanceCard({ d, card }: { d: DealProduct; card?: ProductCard }) {
  const m = cardOf({
    productId: d.productId,
    slug: card?.slug,
    title: d.title,
    image: d.image ?? card?.image,
    price: d.price,
    wasPrice: d.wasPrice,
    offerId: d.offerId,
    sellerName: d.sellerName,
    sellerSlug: d.sellerSlug,
    deliveryCue: card?.deliveryCue,
    freeDelivery: card?.freeDelivery,
    official: card?.official,
    availability: card?.availability,
    rating: card?.rating,
    ratingCount: card?.ratingCount,
  });
  return (
    <div>
      <PCard m={m} showSeller />
      {d.stockLeft != null && <div className="ap-pcard-line">{num(d.stockLeft)} left at this price</div>}
    </div>
  );
}

function Coupon({ c }: { c: CouponCard }) {
  const { note } = useNav();
  const used = c.state === 'used' || c.state === 'expired';
  return (
    <div className="ap-coupon">
      <div className="ap-coupon-stub">
        <span className="ap-coupon-amount">{c.amountLabel}</span>
        <span className="ap-coupon-unit">{c.unitLabel}</span>
      </div>
      <div className="ap-coupon-body">
        <div className="ap-sm ap-strong">{decodeEntities(c.title)}</div>
        {c.conditions && <div className="ap-xs ap-muted" style={{ marginTop: 4 }}>{decodeEntities(c.conditions)}</div>}
        <div className="ap-xs ap-muted" style={{ marginTop: 4 }}>
          {[c.expiresAt && `Expires ${longishDate(c.expiresAt)}`, c.fundedBy && `Funded by ${c.fundedBy}`].filter(Boolean).join(' · ')}
        </div>
        <div className="ap-coupon-actions">
          {c.state === 'clipped' ? (
            <>
              <span className="ap-badge success">
                <Icon name="check" /> Clipped
              </span>
              <span className="ap-xs ap-muted">Applies automatically at checkout</span>
            </>
          ) : used ? (
            <span className="ap-badge">{c.state === 'used' ? 'Used' : 'Expired'}</span>
          ) : (
            <>
              <button type="button" className="ap-btn soft sm" onClick={() => note('Clipping a coupon needs a signed-in shopper; it is off in the preview.')}>
                <Icon name="scissors" />
                Clip coupon
              </button>
              <span className="ap-xs ap-muted">{c.autoApply ? 'Applies automatically at checkout' : c.code ? `Enter code ${c.code} at checkout` : ''}</span>
            </>
          )}
          <button type="button" className="ap-link" onClick={() => note('The eligible items list is off in the preview.')}>
            Eligible items
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- News (feature/news/NewsFragment.kt)

function NewsScreen() {
  const [category, setCategory] = useState<string | null>(null);
  const list = useStore<ApiPage<NewsCard>>(['news', category ?? ''], `/api/store/content/news?limit=20${category ? `&category=${encodeURIComponent(category)}` : ''}`);
  const cats = useStore<Array<{ id: string; slug: string; name: string; icon?: string | null }>>(['news-categories'], '/api/store/content/news/categories');

  const items = list.data?.items ?? [];
  const pinned = items.filter((n) => n.pinned);
  const rest = items.filter((n) => !n.pinned);

  return (
    <div className="ap-page">
      <div className="ap-chips" style={{ paddingTop: 16 }}>
        <button type="button" className={cx('ap-chip', !category && 'on')} onClick={() => setCategory(null)}>
          All
        </button>
        {(cats.data ?? []).map((c) => (
          <button key={c.id} type="button" className={cx('ap-chip', category === c.slug && 'on')} onClick={() => setCategory(c.slug)}>
            <Icon name={iconFor(c.icon, 'newspaper')} />
            {c.name}
          </button>
        ))}
      </div>

      {list.isPending ? (
        <Loading rows={2} />
      ) : list.isError ? (
        <ErrorBox title="We couldn’t load the news" error={list.error} onRetry={() => void list.refetch()} />
      ) : items.length === 0 ? (
        <StateBox icon="newspaper" title={category ? `No news in ${cats.data?.find((c) => c.slug === category)?.name ?? category}` : 'No news yet'} text={category ? null : 'Updates from Marketly show up here.'} action={category ? 'Show all news' : undefined} onAction={() => setCategory(null)} />
      ) : (
        <div className="ap-gutter" style={{ marginTop: 16 }}>
          {pinned.map((n) => (
            <Tap key={n.id} className="ap-news-pinned" to={`/news/${n.slug}`} label={n.title}>
              <Img icon={iconFor(n.category.icon, 'newspaper')} tint={tileTint(n.category.slug)} src={n.cover?.url ?? undefined} alt="" />
              <div className="ap-xs ap-muted">
                <span className="ap-badge brand" style={{ marginRight: 6 }}>Pinned</span>
                {[n.category.name, n.publishedAt && shortDate(n.publishedAt)].filter(Boolean).join(' · ')}
              </div>
              <div className="ap-h3" style={{ marginTop: 4 }}>{decodeEntities(n.title)}</div>
              {n.summary && <div className="ap-sm ap-sub ap-clamp2" style={{ marginTop: 4 }}>{decodeEntities(n.summary)}</div>}
            </Tap>
          ))}
          {rest.map((n) => (
            <Tap key={n.id} className="ap-news-card" to={`/news/${n.slug}`} label={n.title}>
              <Img icon={iconFor(n.category.icon, 'newspaper')} tint={tileTint(n.category.slug)} src={n.cover?.url ?? undefined} alt="" />
              <span style={{ minWidth: 0 }}>
                <span className="ap-xs ap-muted" style={{ display: 'block' }}>{[n.category.name, n.publishedAt && shortDate(n.publishedAt)].filter(Boolean).join(' · ')}</span>
                <span className="ap-sm ap-strong ap-clamp2" style={{ display: 'block', marginTop: 2 }}>{decodeEntities(n.title)}</span>
                {n.summary && <span className="ap-xs ap-muted ap-clamp2" style={{ display: 'block', marginTop: 2 }}>{decodeEntities(n.summary)}</span>}
              </span>
            </Tap>
          ))}
          <div className="ap-xs ap-muted" style={{ textAlign: 'center', padding: '20px 0' }}>That’s all the news.</div>
        </div>
      )}
    </div>
  );
}

interface NewsPost extends NewsCard {
  body?: string;
  updatedAt?: string | null;
  archived?: boolean;
  related?: NewsCard[];
}

function NewsPostScreen({ slug }: { slug: string }) {
  const post = useStore<NewsPost>(['news-post', slug], `/api/store/content/news/${encodeURIComponent(slug)}`);
  const { go } = useNav();
  const Link: ContentLink = ({ url, className, children }) =>
    /^https?:/i.test(url) ? (
      <span className={className}>{children}</span>
    ) : (
      <button type="button" className={cx(className, 'ap-link')} onClick={() => go(url)}>
        {children}
      </button>
    );

  if (post.isPending) return <Loading rows={2} />;
  if (post.isError) return <ErrorBox title="We couldn’t load this news" error={post.error} onRetry={() => void post.refetch()} />;
  const n = post.data;

  return (
    <div className="ap-page">
      <div style={{ padding: 16 }}>
        <Img icon={iconFor(n.category.icon, 'newspaper')} tint={tileTint(n.category.slug)} className="wide" src={n.cover?.url ?? undefined} alt={n.cover?.alt ?? ''} />
      </div>
      <div className="ap-gutter">
        <div className="ap-xs ap-muted">{[n.category.name, n.publishedAt && longishDate(n.publishedAt)].filter(Boolean).join(' · ')}</div>
        <h1 className="ap-h1" style={{ marginTop: 6 }}>{decodeEntities(n.title)}</h1>
        {n.summary && <p className="ap-sm ap-sub">{decodeEntities(n.summary)}</p>}
        <RichText html={n.body} link={Link} proseClassName="ap-prose" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Campaign page / collection (CollectionFragment.kt)

function PageScreen({ slug }: { slug: string }) {
  const page = useStore<StorePage>(['page', slug], `/api/store/content/pages/${encodeURIComponent(slug)}`);
  const blocks: PageBlock[] = page.data?.blocks ?? [];
  const ids = blocks.flatMap((b) => (b.products ?? []).map((p) => p.productId));
  const cards = useCards(ids);

  useScreenTitle(page.data?.title);
  if (page.isPending) return <Loading />;
  if (page.isError) return <ErrorBox title="We couldn’t load this page" error={page.error} onRetry={() => void page.refetch()} />;
  const p = page.data;

  return (
    <div className="ap-page">
      {p.eyebrow && <div className="ap-gutter ap-eyebrow ap-muted" style={{ paddingTop: 20 }}>{decodeEntities(p.eyebrow)}</div>}
      <div className="ap-gutter" style={{ paddingTop: p.eyebrow ? 6 : 20 }}>
        <h1 className="ap-h1">{decodeEntities(p.title)}</h1>
        {p.intro && <p className="ap-sm ap-sub" style={{ marginTop: 8 }}>{decodeEntities(p.intro)}</p>}
        {p.endsInSeconds != null && p.endsInSeconds > 0 && (
          <div style={{ marginTop: 10 }}>
            <span className="ap-xs ap-muted" style={{ marginRight: 6 }}>Ends in</span>
            <Countdown seconds={p.endsInSeconds} />
          </div>
        )}
      </div>

      {blocks.map((b) =>
        b.type === 'hero' ? (
          b.banner ? (
            <div key={b.id} className="ap-section">
              <Banner b={b.banner} />
            </div>
          ) : null
        ) : (b.products ?? []).length ? (
          <div key={b.id} className="ap-section">
            <SectionHead title={b.title ?? 'Products'} link={b.link?.label} to={b.link?.url} />
            {b.body && <div className="ap-gutter ap-sm ap-sub" style={{ marginTop: -6, marginBottom: 12 }}>{decodeEntities(b.body)}</div>}
            <div className="ap-gutter ap-grid">
              {(b.products ?? []).map((t: ProductTile, i) => (
                <PCard key={`${t.productId}-${i}`} m={tileOf(t, cards[t.productId])} showSeller />
              ))}
            </div>
          </div>
        ) : b.body ? (
          <div key={b.id} className="ap-section ap-gutter">
            {b.title && <h2 className="ap-h3">{decodeEntities(b.title)}</h2>}
            <p className="ap-sm ap-sub" style={{ marginTop: 6 }}>{decodeEntities(b.body)}</p>
          </div>
        ) : null,
      )}

      {!!p.notes?.length && (
        <div className="ap-section ap-gutter ap-xs ap-muted">
          {p.notes.map((t) => (
            <p key={t} style={{ margin: '0 0 6px' }}>
              {t}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- screens outside the preview

function ElsewhereScreen({ path }: { path: string }) {
  return (
    <div className="ap-page">
      <div className="ap-section ap-gutter">
        <div className="ap-box" style={{ margin: 0 }}>
          <div className="ap-h3">This screen isn’t in the preview</div>
          <p className="ap-sm ap-sub" style={{ marginTop: 6 }}>
            The link works: in the app it opens <b>{path}</b>. The preview draws the shopping and content screens, the ten department pages and the pages their cards open; what is left needs a signed-in shopper.
          </p>
          <p className="ap-xs ap-muted" style={{ marginTop: 10 }}>
            Screens that need a signed-in shopper (cart, account, orders) can’t be shown: the preview browses as a guest.
          </p>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- the phone

const TABS: Array<{ key: 'home' | 'categories' | 'deals' | 'cart' | 'account'; label: string; icon: IconName; path: string }> = [
  { key: 'home', label: 'Home', icon: 'house', path: '/' },
  { key: 'categories', label: 'Categories', icon: 'layout-grid', path: '/categories' },
  { key: 'deals', label: 'Deals', icon: 'tag', path: '/deals' },
  { key: 'cart', label: 'Cart', icon: 'shopping-cart', path: '/cart' },
  { key: 'account', label: 'Account', icon: 'user-round', path: '/account' },
];

/** The title the app's sub bar shows for a screen (`setupSubBar`). */
function titleOf(route: Route): string {
  switch (route.kind) {
    case 'category':
      return 'Category';
    case 'product':
      return 'Product';
    case 'news':
    case 'news-post':
      return 'News';
    case 'page':
      return 'Campaign';
    case 'department':
      return deptLabel(route.dept);
    case 'dept-phone':
      return 'Phone';
    case 'dept-service':
      return route.area === 'welfare' ? 'Service' : route.area === 'os_install' ? 'OS install' : 'Post-sale service';
    case 'dept-machine':
      return 'Order a machine';
    case 'dept-app':
      return 'App';
    case 'dept-apps':
      return 'Apps';
    case 'dept-provider':
      return 'Place';
    case 'dept-restaurant':
      return 'Restaurant';
    case 'dept-food-item':
      return 'Dish';
    case 'dept-food-list':
      return route.what === 'restaurants' ? 'Food services' : 'Foods';
    case 'dept-post':
      return 'Blogs';
    case 'dept-author':
      return 'Author';
    case 'dept-company':
      return 'Company';
    case 'dept-game':
      return 'Game';
    default:
      return 'Marketly';
  }
}

/** The sub-pages whose app bar carries Share (the app's `R.menu.*_share`). */
const SHARE_SCREENS = new Set<Route['kind']>(['dept-phone', 'dept-service', 'dept-provider', 'dept-restaurant', 'dept-post', 'dept-company', 'dept-app']);

/** What each department's own app bar carries (its fragment's toolbar menu). */
const DEPARTMENT_ACTIONS: Record<DeptKey, Array<{ icon: IconName; label: string; to?: string; note?: string }>> = {
  phones: [
    { icon: 'search', label: 'Search', note: 'Search is off in the preview.' },
    { icon: 'shopping-cart', label: 'Cart', to: '/cart' },
  ],
  farm: [{ icon: 'search', label: 'Search', note: 'Search is off in the preview.' }],
  software: [{ icon: 'search', label: 'Search apps', note: 'Search is off in the preview.' }],
  welfare: [],
  food: [
    { icon: 'search', label: 'Search food', note: 'Search is off in the preview.' },
    { icon: 'shopping-bag', label: 'Basket', note: 'The basket needs a signed-in shopper.' },
  ],
  booking: [{ icon: 'calendar-check', label: 'My bookings', note: 'My bookings needs a signed-in shopper.' }],
  blogs: [{ icon: 'search', label: 'Search posts', note: 'Search is off in the preview.' }],
  companies: [{ icon: 'search', label: 'Search companies', note: 'Search is off in the preview.' }],
  play: [{ icon: 'search', label: 'Search games', note: 'Search is off in the preview.' }],
  rewards: [{ icon: 'info', label: 'How rewards work', note: 'Points are collected on a signed-in customer’s account.' }],
};

function Phone({ path, theme, canBack, onBack, onGo }: { path: string; theme: 'light' | 'dark'; canBack: boolean; onBack: () => void; onGo: (p: string) => void }) {
  const [snack, setSnack] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const route = routeOf(path);
  const tab = tabOf(route);
  // Each screen starts with its fallback title and names itself once it has loaded.
  useEffect(() => setTitle(''), [path]);
  const nav = useMemo<Nav>(
    () => ({
      go: onGo,
      note: (text: string) => {
        setSnack(text);
        window.setTimeout(() => setSnack((s) => (s === text ? null : s)), 2600);
      },
      setTitle,
    }),
    [onGo],
  );

  return (
    <NavCtx.Provider value={nav}>
      <div className="ap-phone" data-ap-theme={theme}>
        <div className="ap-status">
          <span>9:41</span>
          <span className="ap-status-icons">
            <i />
            <i />
            <i />
            <b />
          </span>
        </div>

        {tab ? (
          <div className="ap-appbar">
            <div className="ap-appbar-row">
              <span className="ap-wordmark">
                <LogoMark />
                Marketly
              </span>
              <span className="ap-iconbtn" onClick={() => onGo('/news')} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onGo('/news')}>
                <Icon name="newspaper" />
              </span>
              <span className="ap-iconbtn" onClick={() => nav.note('Notifications need a signed-in shopper.')} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && nav.note('Notifications need a signed-in shopper.')}>
                <Icon name="bell" />
              </span>
            </div>
            <div className="ap-searchbar" onClick={() => nav.note('Search is off in the preview.')} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && nav.note('Search is off in the preview.')}>
              <Icon name="search" />
              <span>Search Marketly</span>
              <span className="ap-scan">
                <Icon name="scan-line" />
              </span>
            </div>
          </div>
        ) : (
          <div className="ap-subbar">
            <button type="button" className="ap-iconbtn" onClick={onBack} aria-label={canBack ? 'Back' : 'Back to Home'}>
              <Icon name="arrow-left" />
            </button>
            <span className="ap-subbar-title">{title || titleOf(route)}</span>
            {route.kind === 'product' && (
              <>
                <span className="ap-iconbtn" role="button" tabIndex={0} onClick={() => nav.note('Sharing is off in the preview.')} onKeyDown={(e) => e.key === 'Enter' && nav.note('Sharing is off in the preview.')}>
                  <Icon name="share-2" />
                </span>
                <span className="ap-iconbtn" role="button" tabIndex={0} onClick={() => onGo('/cart')} onKeyDown={(e) => e.key === 'Enter' && onGo('/cart')}>
                  <Icon name="shopping-cart" />
                </span>
              </>
            )}
            {route.kind === 'category' && (
              <span className="ap-iconbtn" role="button" tabIndex={0} onClick={() => nav.note('Search is off in the preview.')} onKeyDown={(e) => e.key === 'Enter' && nav.note('Search is off in the preview.')}>
                <Icon name="search" />
              </span>
            )}
            {SHARE_SCREENS.has(route.kind) && (
              <span className="ap-iconbtn" role="button" tabIndex={0} aria-label="Share" onClick={() => nav.note('Sharing is off in the preview.')} onKeyDown={(e) => e.key === 'Enter' && nav.note('Sharing is off in the preview.')}>
                <Icon name="share-2" />
              </span>
            )}
            {route.kind === 'dept-restaurant' && (
              <span className="ap-iconbtn" role="button" tabIndex={0} aria-label="Basket" onClick={() => nav.note('The basket needs a signed-in shopper.')} onKeyDown={(e) => e.key === 'Enter' && nav.note('The basket needs a signed-in shopper.')}>
                <Icon name="shopping-bag" />
              </span>
            )}
            {route.kind === 'department' &&
              DEPARTMENT_ACTIONS[route.dept].map((a) => (
                <span key={a.icon} className="ap-iconbtn" role="button" tabIndex={0} aria-label={a.label} onClick={() => (a.to ? onGo(a.to) : nav.note(a.note ?? ''))} onKeyDown={(e) => e.key === 'Enter' && (a.to ? onGo(a.to) : nav.note(a.note ?? ''))}>
                  <Icon name={a.icon} />
                </span>
              ))}
          </div>
        )}

        <div className="ap-scroll" key={path}>
          {route.kind === 'home' && <HomeScreen />}
          {route.kind === 'categories' && <CategoriesScreen />}
          {route.kind === 'category' && <CategoryScreen slug={route.slug} />}
          {route.kind === 'product' && <ProductScreen id={route.id} />}
          {route.kind === 'deals' && <DealsScreen />}
          {route.kind === 'news' && <NewsScreen />}
          {route.kind === 'news-post' && <NewsPostScreen slug={route.slug} />}
          {route.kind === 'page' && <PageScreen slug={route.slug} />}
          {route.kind === 'department' && <DepartmentScreen dept={route.dept} query={route.query} />}
          {route.kind === 'dept-phone' && <PhonePage slug={route.slug} />}
          {route.kind === 'dept-service' && <ServicePage area={route.area} slug={route.slug} />}
          {route.kind === 'dept-machine' && <MachinePage productId={route.productId} />}
          {route.kind === 'dept-app' && <AppPage slug={route.slug} />}
          {route.kind === 'dept-apps' && <AppsListPage query={route.query} />}
          {route.kind === 'dept-provider' && <ProviderPage slug={route.slug} />}
          {route.kind === 'dept-restaurant' && <RestaurantPage slug={route.slug} />}
          {route.kind === 'dept-food-item' && <FoodItemPage id={route.id} />}
          {route.kind === 'dept-food-list' && <FoodListPage what={route.what} query={route.query} />}
          {route.kind === 'dept-post' && <BlogPostPage slug={route.slug} />}
          {route.kind === 'dept-author' && <BlogAuthorPage slug={route.slug} />}
          {route.kind === 'dept-company' && <CompanyPage slug={route.slug} />}
          {route.kind === 'dept-game' && <GamePage slug={route.slug} />}
          {route.kind === 'elsewhere' && <ElsewhereScreen path={route.path} />}
        </div>

        {tab && (
          <div className="ap-tabbar">
            {TABS.map((t) => (
              <button key={t.key} type="button" className={cx('ap-tab', t.key === tab && 'on')} onClick={() => onGo(t.path)}>
                <Icon name={t.icon} />
                <span>{t.label}</span>
              </button>
            ))}
          </div>
        )}

        {snack && <div className="ap-snack">{snack}</div>}
      </div>
    </NavCtx.Provider>
  );
}

// ---------------------------------------------------------------- the Admin Center page

export default function AppPreview() {
  const qc = useQueryClient();
  const { can } = useStaffSession();
  const canView = can('content.view');
  const [params, setParams] = useSearchParams();
  const path = params.get('path') || '/';
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [zoom, setZoom] = useState('1');
  const [stack, setStack] = useState<string[]>([]);
  const [nonce, setNonce] = useState(0);

  const open = (next: string, keepStack = true) => {
    setStack((s) => (keepStack ? [...s, path] : []));
    const p = new URLSearchParams(params);
    p.set('path', next);
    setParams(p, { replace: false });
  };
  // Back pops the preview's own stack; with nothing behind it (a link opened straight into this screen) it goes
  // Home, like the app's back stack falling through to its start destination.
  const back = () => {
    const previous = stack[stack.length - 1] ?? '/';
    setStack((s) => s.slice(0, -1));
    const p = new URLSearchParams(params);
    p.set('path', previous);
    setParams(p, { replace: false });
  };
  // Reload drops what the preview has read and starts a new guest session, so the screens are rebuilt from the API.
  const reload = () => {
    resetStoreSession();
    qc.removeQueries({ queryKey: ['app-preview'] });
    setNonce((n) => n + 1);
  };

  if (!canView) {
    return (
      <AdminLayout active="app-preview">
        <PageHeader crumbs={[{ label: 'Admin', to: href('admin/dashboard') }, { label: 'Marketing and content' }]} title="App preview" />
        <Alert tone="info" title="You don’t have access to the app preview">
          Seeing the store content as the app shows it needs the “View content” permission. A Platform Administrator can change your roles in Staff and roles.
        </Alert>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout active="app-preview">
      <PageHeader
        crumbs={[{ label: 'Admin', to: href('admin/dashboard') }, { label: 'Marketing and content' }, { label: 'App preview' }]}
        title="App preview"
        sub="The Android app's screens with the content customers get right now · a guest session, read only: nothing is added to a cart and no ad display is counted"
        actions={
          <>
            <Button variant="secondary" size="sm" icon="rotate-ccw" onClick={reload}>
              Reload
            </Button>
            <Button variant="secondary" size="sm" icon="layout-template" to={href('admin/content')}>
              Homepage and pages
            </Button>
          </>
        }
      />

      <div className="ab-main">
        <div className="stack gap-5">
          <Card flush>
            <div className="card-body row between wrap gap-3">
              <div className="row gap-3">
                <SegmentedControl
                  items={PREVIEW_SCREENS.map((s) => ({ label: s.label, value: s.path }))}
                  active={PREVIEW_SCREENS.some((s) => s.path === path) ? path : ''}
                  onChange={(v) => open(v, false)}
                  label="Screen"
                />
                <Select
                  id="ap-dept"
                  aria-label="Department page"
                  value={PREVIEW_DEPARTMENTS.find((d) => d.path === path)?.path ?? ''}
                  onChange={(e) => e.target.value && open(e.target.value, false)}
                  options={[{ value: '', label: 'Department page…' }, ...PREVIEW_DEPARTMENTS.map((d) => ({ value: d.path, label: d.label }))]}
                />
              </div>
              <div className="row gap-3">
                <SegmentedControl
                  items={[
                    { label: 'Light', value: 'light' },
                    { label: 'Dark', value: 'dark' },
                  ]}
                  active={theme}
                  onChange={(v) => setTheme(v as 'light' | 'dark')}
                  label="Theme"
                />
                <SegmentedControl
                  items={[
                    { label: '100%', value: '1' },
                    { label: '85%', value: '0.85' },
                    { label: '70%', value: '0.7' },
                  ]}
                  active={zoom}
                  onChange={setZoom}
                  label="Phone size"
                />
              </div>
            </div>
            <div className="ap-stage">
              <div className="ap-frame" style={{ '--ap-zoom': zoom } as CSSProperties}>
                <Phone key={nonce} path={path} theme={theme} canBack={stack.length > 0} onBack={back} onGo={(p) => open(p)} />
              </div>
            </div>
            <div className="card-foot between">
              <span className="xs muted">
                Showing <code>{path}</code> · 390 × 844 dp, the app's own layout
              </span>
              <span className="xs muted">Tap anything: links open the screen the app opens.</span>
            </div>
          </Card>
        </div>

        <div className="stack gap-5">
          <Card title="What this shows" titleAs="h2" titleClassName="h4">
            <p className="small">
              The same screens as the Android customer app, built from the same Store API calls: the homepage layout and its sections in order, the Departments rail, flash deals and coupons, categories and
              listings, a product page with its live offer, News, campaign pages, and the ten department pages — Phones, Farm machines, Softwares, Welfare services, Food delivery, Booking, Blogs, Companies,
              the Play center and Daily rewards.
            </p>
            <p className="small">Use it to check a layout, a department tile, a campaign page or a news post on a phone before and after publishing.</p>
          </Card>
          <Card title="What it can’t do" titleAs="h2" titleClassName="h4">
            <ul className="list pad small">
              <li>It browses as a guest, so Recently viewed is empty, Daily rewards shows its signed-out screen, and cart, account and order screens are out.</li>
              <li>Ordering a machine, booking a slot, basket and buying stop at the button: they need a signed-in customer.</li>
              <li>Add to cart, search, filters and coupon clipping are off: tapping one says so.</li>
              <li>Ads are real decisions, but no display or click is reported, so nothing is billed to an advertiser.</li>
              <li>Opening ads and pop-ups are never requested.</li>
            </ul>
          </Card>
          <Card title="Deep link" titleAs="h2" titleClassName="h4">
            <p className="small">Open the same screen on a phone that has the app installed:</p>
            <p className="small strong" style={{ wordBreak: 'break-all' }}>
              <code>marketly://store{path === '/' ? '' : path}</code>
            </p>
          </Card>
        </div>
      </div>
    </AdminLayout>
  );
}
