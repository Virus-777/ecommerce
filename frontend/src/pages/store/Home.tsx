import { useState, type MouseEvent } from 'react';
import { Link } from 'react-router';
import { StoreLayout } from '@/layouts';
import { percentOff } from '@marketly/web-shared/lib/format';
import { brands, categories, P, sellers, type Product, type SellerId } from '@marketly/web-shared/data/fixtures';
import { href } from '@marketly/web-shared/routes';
import { Badge, Button, Countdown, Icon, Img, LogoTile, Meter, Price, ProductCard, SectionHeader, type IconName } from '@marketly/web-shared/ui';

// Design: pages/store/store-home.html

/** Flash deals: product + share of the deal stock already claimed. */
const FLASH: Array<{ p: Product; claimed: number; limit: number }> = [
  { p: P.vacuum, claimed: 72, limit: 2 },
  { p: P.aurora, claimed: 41, limit: 2 },
  { p: P.duvet, claimed: 58, limit: 2 },
  { p: P.skillet, claimed: 86, limit: 2 },
  { p: P.ssd1tb, claimed: 33, limit: 2 },
];
const FLASH_ENDS_IN = 5 * 3600 + 42 * 60 + 18;

const OFFICIAL_PICKS = [P.aurora, P.skillet, P.sweater, P.pourover];
const FEATURED: Array<{ p: Product; sponsored?: boolean }> = [
  { p: P.kestrel27 },
  { p: P.speaker },
  { p: P.backpack, sponsored: true },
  { p: P.keyboard },
  { p: P.serum },
  { p: P.shoes },
  { p: P.bottle },
  { p: P.lamp },
  { p: P.yogamat },
  { p: P.vacuum },
];
const FEATURED_SELLERS: SellerId[] = ['northwind', 'casaverde', 'pixelport', 'trailhead'];
const NEW_ARRIVALS = [P.lamp, P.yogamat, P.serum, P.keyboard, P.bottle, P.sweater, P.pourover];
const RECENT = [P.ssd1tb, P.kestrel27, P.duvet, P.aurora];
const SPONSOR_PRODUCTS = [P.aurora, P.speaker];

const PROMISE: Array<{ icon: IconName; title: string; text: string }> = [
  { icon: 'store', title: 'Know who sells it', text: 'Every item names its seller and who ships it.' },
  { icon: 'calendar-check', title: 'Delivery date first', text: 'See arrival dates and the full total before you pay.' },
  { icon: 'undo-2', title: 'Clear returns', text: 'Return terms are shown on every offer.' },
  { icon: 'life-buoy', title: 'We step in', text: "Marketly support helps if a seller doesn't." },
];

export default function Home() {
  const [recent, setRecent] = useState(RECENT);
  const clearRecent = (e: MouseEvent) => {
    e.preventDefault();
    setRecent([]);
  };

  return (
    <StoreLayout tab="home">
      <div className="container page gap-7">
        <section className="hero-banner home-hero" aria-label="Campaign">
          <div className="copy">
            <span className="eyebrow u-c-on-brand u-o-_85">Home Week · Oct 6–19</span>
            <h1 className="display d-xl u-c-on-brand">Up to 30% off bedding, lighting and cookware</h1>
            <p className="u-o-_9 u-maxw-40ch">Linen sets from Casa Verde, cast iron from the Official Store and smart lamps that charge your phone.</p>
            <div className="row gap-2">
              <Link className="btn btn-lg u-bg-on-brand u-c-brand-text-i" to={href('store/collection', 'seasonal')}>
                Shop Home Week
              </Link>
              <Link className="btn btn-lg btn-ghost u-c-on-brand-i" to={href('store/deals')}>
                All deals
              </Link>
            </div>
          </div>
          <div className="home-hero-art" aria-hidden="true">
            <Img icon="bed-double" tint="1" />
            <Img icon="lamp-desk" tint="5" />
            <Img icon="cooking-pot" tint="3" />
          </div>
        </section>

        <section className="stack gap-4" aria-labelledby="h-cats">
          <SectionHeader title="Shop by category" id="h-cats" link="All categories" to={href('store/categories')} />
          <div className="home-cats">
            {categories.map((c) => (
              <Link key={c.id} className="home-cat" to={href('store/category', '', { slug: c.id })}>
                <Img icon={c.icon} tint={c.tint} />
                <span>{c.name}</span>
              </Link>
            ))}
          </div>
        </section>

        <section className="home-deals stack gap-4" aria-labelledby="h-deals">
          <div className="row between">
            <div className="row gap-3">
              <h2 className="h2 u-c-deal-text" id="h-deals">
                <Icon name="zap" /> Flash deals
              </h2>
              <span className="row gap-2 small sub">
                Ends in <Countdown seconds={FLASH_ENDS_IN} />
              </span>
            </div>
            <Link className="small strong" to={href('store/deals')}>
              See all deals <Icon name="arrow-right" className="ic-sm" />
            </Link>
          </div>
          <div className="hscroll">
            {FLASH.map(({ p, claimed, limit }) => (
              <article key={p.id} className="deal-card">
                <Link to={href('store/product')} aria-label={p.name}>
                  <Img icon={p.icon} tint={p.tint} />
                </Link>
                <div className="row gap-1">
                  <Badge tone="deal">−{percentOff(p.price, p.was)}%</Badge>
                  <span className="xs muted">Limit {limit}</span>
                </div>
                <Price amount={p.price} was={p.was} noOff />
                <Link className="small clamp-2 link-plain" to={href('store/product')}>
                  {p.name}
                </Link>
                <div className="stack gap-1">
                  <Meter pct={claimed} tone="deal" label={`${p.name}: share claimed`} />
                  <span className="xs muted">{claimed}% claimed</span>
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className="home-official" aria-labelledby="h-official">
          <div className="stack gap-3">
            <Badge tone="brand" icon="badge-check">
              Official Store
            </Badge>
            <h2 className="display d-lg" id="h-official">
              Sold and shipped by Marketly
            </h2>
            <p className="small sub">Our own stock, packed in our Reno warehouse. Free delivery over $35 and 30-day free returns.</p>
            <div>
              <Button to={href('store/official')} iconRight="arrow-right">
                Visit the Official Store
              </Button>
            </div>
          </div>
          <div className="grid-products">
            {OFFICIAL_PICKS.map((p) => (
              <ProductCard key={p.id} p={p} compact />
            ))}
          </div>
        </section>

        <section className="stack gap-4" aria-labelledby="h-feat">
          <SectionHeader title="Featured for you" id="h-feat" link="See more" to={href('store/collection', 'best-sellers')} />
          <div className="grid-products wide">
            {FEATURED.map(({ p, sponsored }) => (
              <ProductCard key={p.id} p={p} sponsored={sponsored} showSeller from />
            ))}
          </div>
        </section>

        <section className="home-sponsor" aria-label="Sponsored brand">
          <span className="ad-label">Sponsored</span>
          <div className="stack gap-3 u-p-sp-6">
            <div className="row gap-3">
              <span className="logo-tile lg tint-2" aria-hidden="true">
                H
              </span>
              <div className="stack gap-0">
                <span className="h3">Halden Audio</span>
                <span className="xs muted">Brand collection · 48 products</span>
              </div>
            </div>
            <p className="sub">Noise cancelling that lasts a long-haul flight. Aurora headphones now with 40-hour battery.</p>
            <div>
              <Button variant="secondary" to={href('store/brand')} iconRight="arrow-right">
                Shop Halden
              </Button>
            </div>
          </div>
          <div className="grid c2 gap-3 u-p-sp-4 u-content-center">
            {SPONSOR_PRODUCTS.map((p) => (
              <Link key={p.id} to={href('store/product')} className="stack gap-2 link-plain">
                <Img icon={p.icon} tint={p.tint} className="r43" />
                <span className="small strong clamp-2">{p.name}</span>
                <Price amount={p.price} was={p.was} noOff />
              </Link>
            ))}
          </div>
        </section>

        <section className="stack gap-4" aria-labelledby="h-sellers">
          <SectionHeader title="Featured sellers" id="h-sellers" link="How sellers are checked" to={href('info/policy', 'seller-rules')} />
          <div className="home-sellers">
            {FEATURED_SELLERS.map((id) => {
              const s = sellers[id];
              return (
                <Link key={id} className="card pad row gap-3 nowrap link-plain" to={href('store/seller')}>
                  <LogoTile initials={s.initials} tint={s.tint} />
                  <span className="stack gap-1">
                    <span className="strong truncate">{s.name}</span>
                    <span className="row gap-2">
                      <Badge tone="info" icon="shield-check">
                        Verified
                      </Badge>
                      <span className="xs muted">{s.positive}% positive</span>
                    </span>
                    <span className="xs muted">
                      {s.location} · ships in {s.dispatch}
                    </span>
                  </span>
                </Link>
              );
            })}
          </div>
        </section>

        <section className="home-row stack gap-4" aria-labelledby="h-new">
          <SectionHeader title="New arrivals" id="h-new" link="See all" to={href('store/collection')} />
          <div className="hscroll">
            {NEW_ARRIVALS.map((p) => (
              <ProductCard key={p.id} p={p} compact />
            ))}
          </div>
        </section>

        <section className="stack gap-4" aria-labelledby="h-brands">
          <SectionHeader title="Brand collections" id="h-brands" link="All brands" to={href('store/brand')} />
          <div className="hscroll">
            {brands.map((b) => (
              <Link key={b.name} className="card pad stack gap-2 link-plain u-w-150px u-items-center u-ta-center" to={href('store/brand', '', { slug: b.name.toLowerCase() })}>
                <span className={`logo-tile lg tint-${b.tint}`} aria-hidden="true">
                  {b.initials}
                </span>
                <span className="strong small">{b.name}</span>
                <span className="xs muted">{b.products} products</span>
              </Link>
            ))}
          </div>
        </section>

        {recent.length > 0 && (
          <section className="home-row stack gap-4" aria-labelledby="h-recent">
            <div className="row between base">
              <h2 className="h2">
                <span id="h-recent">Recently viewed</span>
              </h2>
              <a className="small strong" href="#" onClick={clearRecent}>
                Clear <Icon name="arrow-right" className="ic-sm" />
              </a>
            </div>
            <div className="hscroll">
              {recent.map((p) => (
                <Link key={p.id} to={href('store/product')} className="stack gap-2 link-plain">
                  <Img icon={p.icon} tint={p.tint} />
                  <span className="xs clamp-2">{p.name}</span>
                  <Price amount={p.price} was={p.was} noOff />
                </Link>
              ))}
            </div>
          </section>
        )}

        <section className="home-promise" aria-label="Our promise">
          {PROMISE.map((x) => (
            <div key={x.title}>
              <Icon name={x.icon} />
              <span className="stack gap-1">
                <span className="small strong">{x.title}</span>
                <span className="xs muted">{x.text}</span>
              </span>
            </div>
          ))}
        </section>
      </div>
    </StoreLayout>
  );
}
