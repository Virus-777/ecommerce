import { useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { StoreLayout } from '@/layouts';
import { call, useApi, type components } from '@marketly/web-shared/api';
import { dollars } from '@marketly/web-shared/lib/format';
import { useIsPhone } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import { Badge, Button, Countdown, Icon, Meter, Price, SectionHeader } from '@marketly/web-shared/ui';
import { adsFor, HomeAdCarousel, OpeningAd, OVERLAY_KEYS, useAdDecision } from '@/api/ads';
import { categoryArt, initialsOf, tintOf } from '@/api/catalog';
import { ApiProductCard, CardGridSkeleton, LoadError, LogoPic, Pic } from '@/api/cards';
import { contentIcon, contentLinkTo, isExternal, useOfficialStore } from '@/api/content';
import { NewsCardLink } from '@/api/news-cards';
import { productHref, tileToCard, useProductCards, type SearchCard } from '@/api/search';

// Design: pages/store/store-home.html. Sections come from GET /api/store/content/home in the order the
// content team set; tiles carry product, category, brand and store slugs. Product tiles and flash deals are
// filled in with GET /api/store/search/cards (delivery cues, offer counts, flash-deal product slugs), recently
// viewed comes from GET /api/store/customers/recently-viewed and the Official Store copy from
// GET /api/store/content/official-store. Ad positions (ad_position sections: the opening full-screen ad and
// the sponsored brand banner, a carousel of every live ad) ask POST /api/store/advertising/decisions and show
// nothing when no ad is live. A `news` section ("Latest news") carries its posts (`news`, up to 3) and hides when empty.
// REST rather than the HomePage screen query: the query has no device (phone and desktop section sets),
// selects images without thumbUrl and has no stock state on product cards.

type Section = components['schemas']['content.HomeSection'];
type LinkRef = components['schemas']['content.LinkRef'];
type FlashSale = components['schemas']['promotions.FlashSaleBlock'];

const dealsOf = (s: Section): FlashSale[] => s.deals ?? [];

function CtaLink({ link, className }: { link: LinkRef; className: string }) {
  const to = contentLinkTo(link.url);
  return isExternal(to) ? (
    <a className={className} href={to}>
      {link.label}
    </a>
  ) : (
    <Link className={className} to={to}>
      {link.label}
    </Link>
  );
}

const sectionLink = (s: Section) => (s.link ? { label: s.link.label, to: contentLinkTo(s.link.url) } : undefined);

export default function Home() {
  const { api } = useApi();
  const qc = useQueryClient();
  const device = useIsPhone() ? 'phone' : 'desktop';
  const home = useQuery({
    queryKey: ['content', 'home', device],
    queryFn: () => call(api.GET('/api/store/content/home', { params: { query: { device } } })),
  });
  const sections = home.data?.sections ?? [];
  const official = useOfficialStore();
  // Ad positions of this layout; the design page /ads/opening shows its own sample ad over the home page.
  const onHome = useLocation().pathname === href('store/home');
  const adKeys = sections.filter((s) => s.kind === 'ad_position' && s.adPlacementKey).map((s) => s.adPlacementKey!);
  const ads = useAdDecision('home', adKeys, {}, { enabled: home.isSuccess && onHome });
  const [overlayClosed, setOverlayClosed] = useState(false);
  const overlay = !overlayClosed && ads.data?.overlay?.placementKey === 'opening_fullscreen' ? ads.data.overlay : null;
  const recent = useQuery({
    queryKey: ['customers', 'recently-viewed'],
    queryFn: () => call(api.GET('/api/store/customers/recently-viewed', { params: { query: { limit: 12 } } })),
  });
  const clearRecent = useMutation({
    mutationFn: () => call(api.DELETE('/api/store/customers/recently-viewed')),
    onSuccess: () => qc.setQueryData(['customers', 'recently-viewed'], []),
  });

  const cards = useProductCards(sections.flatMap((s) => [...s.products.map((p) => p.productId), ...dealsOf(s).flatMap((d) => d.items.map((i) => i.productId))]));
  const card = (id: string): SearchCard | undefined => cards.data?.get(id);

  if (home.isPending || home.isError) {
    return (
      <StoreLayout tab="home">
        <div className="container page gap-7" aria-busy={home.isPending || undefined}>
          <h1 className="sr-only">Marketly</h1>
          {home.isError ? (
            <LoadError error={home.error} onRetry={() => void home.refetch()} title="We couldn’t load the home page" />
          ) : (
            <>
              <span className="sk sk-img" style={{ aspectRatio: '16 / 5' }} />
              <CardGridSkeleton n={5} wide />
              <CardGridSkeleton n={10} wide />
            </>
          )}
        </div>
      </StoreLayout>
    );
  }

  const firstBanner = sections.find((s) => s.kind === 'campaign_banner' && s.banner);
  const recentItems = recent.data ?? [];
  const recentAt = sections.findIndex((s) => s.kind === 'recently_viewed');
  const promiseAt = sections.findIndex((s) => s.kind === 'promise_strip');
  // Recently viewed sits where the content team put it, else before the promise strip (design order).
  const recentIndex = recentAt >= 0 ? recentAt : promiseAt >= 0 ? promiseAt : sections.length;

  const recentBlock =
    recentItems.length > 0 ? (
      <section className="home-row stack gap-4" aria-labelledby="h-recent">
        <div className="row between base">
          <h2 className="h2">
            <span id="h-recent">Recently viewed</span>
          </h2>
          <a
            className="small strong"
            href="#"
            aria-disabled={clearRecent.isPending || undefined}
            onClick={(e) => {
              e.preventDefault();
              clearRecent.mutate();
            }}
          >
            Clear <Icon name="arrow-right" className="ic-sm" />
          </a>
        </div>
        <div className="hscroll">
          {recentItems.map((r) => (
            <Link key={r.productId} to={productHref({ id: r.productId, slug: r.slug })} className="stack gap-2 link-plain">
              <Pic image={r.image} />
              <span className="xs clamp-2">{r.title}</span>
              {r.price ? <Price amount={dollars(r.price)} was={r.wasPrice ? dollars(r.wasPrice) : null} noOff /> : !r.available && <span className="xs muted">No longer available</span>}
            </Link>
          ))}
        </div>
      </section>
    ) : null;

  const render = (s: Section): ReactNode => {
    const hid = `h-${s.id.slice(-8)}`;
    const link = sectionLink(s);
    switch (s.kind) {
      case 'campaign_banner': {
        const b = s.banner;
        if (!b) return null;
        const H = s === firstBanner ? 'h1' : 'h2';
        return (
          <section key={s.id} className="hero-banner home-hero" aria-label="Campaign">
            <div className="copy">
              {b.eyebrow && <span className="eyebrow u-c-on-brand u-o-_85">{b.eyebrow}</span>}
              <H className="display d-xl u-c-on-brand">{b.headline}</H>
              {b.body && <p className="u-o-_9 u-maxw-40ch">{b.body}</p>}
              <div className="row gap-2">
                <CtaLink link={b.primaryCta} className="btn btn-lg u-bg-on-brand u-c-brand-text-i" />
                {b.secondaryCta && <CtaLink link={b.secondaryCta} className="btn btn-lg btn-ghost u-c-on-brand-i" />}
              </div>
            </div>
            <div className="home-hero-art" aria-hidden="true">
              {b.images.length > 0 ? (
                b.images.slice(0, 3).map((img) => <Pic key={img.id} image={img} alt="" />)
              ) : (
                <>
                  <Pic icon="bed-double" tint="1" />
                  <Pic icon="lamp-desk" tint="5" />
                  <Pic icon="cooking-pot" tint="3" />
                </>
              )}
            </div>
          </section>
        );
      }
      case 'category_shortcuts':
        if (!s.categories.length) return null;
        return (
          <section key={s.id} className="stack gap-4" aria-labelledby={hid}>
            <SectionHeader title={s.heading ?? 'Shop by category'} id={hid} link={link?.label ?? 'All categories'} to={link?.to ?? href('store/categories')} />
            <div className="home-cats">
              {s.categories.map((c) => {
                const art = categoryArt(c.slug);
                const tile = (
                  <>
                    <Pic image={c.image} icon={art.icon} tint={art.tint} />
                    <span>{c.name}</span>
                  </>
                );
                return c.slug ? (
                  <Link key={c.categoryId} className="home-cat" to={href('store/category', '', { slug: c.slug })}>
                    {tile}
                  </Link>
                ) : (
                  <span key={c.categoryId} className="home-cat">
                    {tile}
                  </span>
                );
              })}
            </div>
          </section>
        );
      case 'deals': {
        const sale = dealsOf(s).find((d) => d.state === 'live') ?? dealsOf(s)[0];
        const items = sale?.items ?? [];
        if (!items.length && !s.products.length) return null;
        const all = link ?? { label: 'See all deals', to: href('store/deals') };
        return (
          <section key={s.id} className="home-deals stack gap-4" aria-labelledby={hid}>
            <div className="row between">
              <div className="row gap-3">
                <h2 className="h2 u-c-deal-text" id={hid}>
                  <Icon name="zap" /> {s.heading ?? 'Flash deals'}
                </h2>
                {sale?.state === 'live' && (
                  <span className="row gap-2 small sub">
                    Ends in <Countdown seconds={sale.secondsLeft} />
                  </span>
                )}
              </div>
              <Link className="small strong" to={all.to}>
                {all.label} <Icon name="arrow-right" className="ic-sm" />
              </Link>
            </div>
            <div className="hscroll">
              {items.length > 0
                ? items.map((d) => {
                    const to = productHref({ id: d.productId, slug: card(d.productId)?.slug });
                    const pct = Math.round(d.percentOffBps / 100);
                    return (
                      <article key={d.id} className="deal-card">
                        <Link to={to} aria-label={d.title}>
                          <Pic image={d.image} />
                        </Link>
                        <div className="row gap-1">
                          {pct > 0 && <Badge tone="deal">−{pct}%</Badge>}
                          {d.purchaseLimit ? <span className="xs muted">Limit {d.purchaseLimit}</span> : null}
                        </div>
                        <Price amount={dollars(d.dealPrice)} was={dollars(d.regularPrice)} noOff />
                        <Link className="small clamp-2 link-plain" to={to}>
                          {d.title}
                        </Link>
                        <div className="stack gap-1">
                          <Meter pct={d.claimedPct} tone="deal" label={`${d.title}: share claimed`} />
                          <span className="xs muted">{d.state === 'sold_out' ? 'Deal sold out' : `${d.claimedPct}% claimed`}</span>
                        </div>
                      </article>
                    );
                  })
                : s.products.map((t) => {
                    const c = tileToCard(t, card(t.productId));
                    const to = productHref(c);
                    return (
                      <article key={t.productId} className="deal-card">
                        <Link to={to} aria-label={c.title}>
                          <Pic image={c.image} />
                        </Link>
                        <div className="row gap-1">{t.badge && <Badge tone="deal">{t.badge}</Badge>}</div>
                        {c.price && <Price amount={dollars(c.price)} was={c.was ? dollars(c.was) : null} noOff />}
                        <Link className="small clamp-2 link-plain" to={to}>
                          {c.title}
                        </Link>
                      </article>
                    );
                  })}
            </div>
          </section>
        );
      }
      case 'official_highlights':
        return (
          <section key={s.id} className="home-official" aria-labelledby={hid}>
            <div className="stack gap-3">
              <Badge tone="brand" icon="badge-check">
                Official Store
              </Badge>
              <h2 className="display d-lg" id={hid}>
                {s.heading ?? 'Sold and shipped by Marketly'}
              </h2>
              {(s.subheading ?? official.data?.introduction) && <p className="small sub">{s.subheading ?? official.data?.introduction}</p>}
              <div>
                <Button to={href('store/official')} iconRight="arrow-right">
                  Visit the Official Store
                </Button>
              </div>
            </div>
            <div className="grid-products">
              {s.products.slice(0, 4).map((t) => (
                <ApiProductCard key={t.productId} c={tileToCard(t, card(t.productId))} compact />
              ))}
            </div>
          </section>
        );
      case 'featured_products':
      case 'popular_products':
      case 'collection_teaser':
        if (!s.products.length) return null;
        return (
          <section key={s.id} className="stack gap-4" aria-labelledby={hid}>
            <SectionHeader title={s.heading ?? 'Featured for you'} id={hid} link={link?.label} to={link?.to} />
            <div className="grid-products wide">
              {s.products.map((t) => (
                <ApiProductCard key={t.productId} c={tileToCard(t, card(t.productId))} showSeller from />
              ))}
            </div>
          </section>
        );
      case 'new_arrivals':
        if (!s.products.length) return null;
        return (
          <section key={s.id} className="home-row stack gap-4" aria-labelledby={hid}>
            <SectionHeader title={s.heading ?? 'New arrivals'} id={hid} link={link?.label ?? 'See all'} to={link?.to ?? href('store/collection', '', { slug: 'new-arrivals' })} />
            <div className="hscroll">
              {s.products.map((t) => (
                <ApiProductCard key={t.productId} c={tileToCard(t, card(t.productId))} compact />
              ))}
            </div>
          </section>
        );
      case 'featured_sellers':
        if (!s.sellers.length) return null;
        return (
          <section key={s.id} className="stack gap-4" aria-labelledby={hid}>
            <SectionHeader title={s.heading ?? 'Featured sellers'} id={hid} link="How sellers are checked" to={href('info/policy', 'seller-rules')} />
            <div className="home-sellers">
              {s.sellers.map((x) => {
                const inner = (
                  <>
                    <LogoPic logo={x.logo} initials={initialsOf(x.name)} tint={tintOf(x.name)} />
                    <span className="stack gap-1">
                    <span className="strong truncate">{x.name}</span>
                    <span className="row gap-2">
                      {x.verified && (
                        <Badge tone="info" icon="shield-check">
                          Verified
                        </Badge>
                      )}
                      {x.positivePct != null && <span className="xs muted">{Math.round(x.positivePct)}% positive</span>}
                    </span>
                    <span className="xs muted">{[x.location, x.dispatchLabel?.split(' · ')[0]].filter(Boolean).join(' · ')}</span>
                    </span>
                  </>
                );
                return x.sellerSlug ? (
                  <Link key={x.sellerId} className="card pad row gap-3 nowrap link-plain" to={href('store/seller', '', { slug: x.sellerSlug })}>
                    {inner}
                  </Link>
                ) : (
                  <div key={x.sellerId} className="card pad row gap-3 nowrap">
                    {inner}
                  </div>
                );
              })}
            </div>
          </section>
        );
      case 'brand_collections':
        if (!s.brands.length) return null;
        return (
          <section key={s.id} className="stack gap-4" aria-labelledby={hid}>
            <SectionHeader title={s.heading ?? 'Brand collections'} id={hid} link={link?.label} to={link?.to} />
            <div className="hscroll">
              {s.brands.map((b) => {
                const slug = b.slug;
                const inner = (
                  <>
                    <LogoPic logo={b.logo} initials={initialsOf(b.name)} tint={tintOf(b.name)} className="lg" />
                    <span className="strong small">{b.name}</span>
                    <span className="xs muted">{b.productCount} products</span>
                  </>
                );
                return slug ? (
                  <Link key={b.brandId} className="card pad stack gap-2 link-plain u-w-150px u-items-center u-ta-center" to={href('store/brand', '', { slug })}>
                    {inner}
                  </Link>
                ) : (
                  <div key={b.brandId} className="card pad stack gap-2 u-w-150px u-items-center u-ta-center">
                    {inner}
                  </div>
                );
              })}
            </div>
          </section>
        );
      case 'promise_strip':
        if (!s.promiseItems.length) return null;
        return (
          <section key={s.id} className="home-promise" aria-label={s.heading ?? 'Our promise'}>
            {s.promiseItems.map((x) => (
              <div key={x.title}>
                <Icon name={contentIcon(x.icon)} />
                <span className="stack gap-1">
                  <span className="small strong">{x.title}</span>
                  <span className="xs muted">{x.body}</span>
                </span>
              </div>
            ))}
          </section>
        );
      case 'news':
        // Latest news: up to 3 posts (pinned first); a horizontal row on the phone, 3 columns wider (docs/06-news.md §5).
        if (!s.news.length) return null;
        return (
          <section key={s.id} className="stack gap-4" aria-labelledby={hid}>
            <SectionHeader title={s.heading ?? 'Latest news'} id={hid} link={link?.label ?? 'All news'} to={link?.to ?? href('store/news')} />
            <div className="news-row">
              {s.news.slice(0, 3).map((n) => (
                <NewsCardLink key={n.id} post={n} />
              ))}
            </div>
          </section>
        );
      case 'ad_position': {
        // Overlay positions (the opening ad) show the decision's overlay below; inline ones (the sponsored brand
        // banner) a carousel of their ads, rotating at the decision's rotationSeconds.
        const key = s.adPlacementKey ?? '';
        const list = OVERLAY_KEYS.includes(key) ? [] : adsFor(ads.data, key);
        return list.length ? <HomeAdCarousel key={s.id} ads={list} seconds={ads.data?.rotationSeconds} /> : null;
      }
      default:
        // recently_viewed renders the customer's list (above).
        return null;
    }
  };

  return (
    <StoreLayout tab="home">
      <div className="container page gap-7">
        {!firstBanner && <h1 className="sr-only">Marketly</h1>}
        {sections.slice(0, recentIndex).map(render)}
        {recentBlock}
        {sections.slice(recentIndex).map(render)}
      </div>
      {overlay && (
        <OpeningAd
          ad={overlay}
          onClose={() => setOverlayClosed(true)}
        />
      )}
    </StoreLayout>
  );
}
