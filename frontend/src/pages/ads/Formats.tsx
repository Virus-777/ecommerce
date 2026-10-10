import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { StoreLayout } from '@/layouts';
import { useView } from '@/lib/hooks';
import { cx } from '@/lib/cx';
import { percentOff } from '@/lib/format';
import { sellers } from '@/data/fixtures';
import { href } from '@/routes/href';
import { Badge, Breadcrumbs, Button, Icon, IconButton, Img, Meter, Price, SellerLine, Stars, announce, type IconName } from '@/ui';
import { HEADPHONES, SORTS, sortProducts, type AdProduct, type Sort } from './data/headphones';
import { AdOverlay } from './data/overlay';

// Design: pages/store/ads-formats.html: every ad placement on a category page, annotated.
//   view "sticky-ad"    = the plain page as shoppers see it, with the sticky ad strip explained
//   view "interstitial" = the interstitial between category and product (from "Preview interstitial")
// The default view keeps the annotation card's h1 and demotes the demo page title to h2 (REVIEW: one h1).

type View = 'sticky-ad' | 'interstitial';

const LEGEND: Array<{ icon: IconName; name: string; text: string }> = [
  { icon: 'image', name: 'Banner ad', text: 'launch. Home, category and campaign pages.' },
  { icon: 'store', name: 'Sponsored store or brand', text: 'home and discovery pages.' },
  { icon: 'layout-grid', name: 'Sponsored product', text: 'search, categories, related products.' },
  { icon: 'panel-bottom', name: 'Floating / sticky ad', text: 'dismissible strip, selected pages.' },
  { icon: 'panel-top-open', name: 'Interstitial', text: 'between browsing steps, never in checkout.' },
  { icon: 'video', name: 'Video ad', text: 'later phase, play and mute controls.' },
  { icon: 'maximize', name: 'Opening full-screen', text: 'see Opening full-screen ad.' },
  { icon: 'message-square', name: 'Pop-up', text: 'see Promotional pop-up.' },
];

const VIDEO_SECONDS = 30;
const SPONSORED = HEADPHONES.filter((p) => p.sponsored);
const ORGANIC = HEADPHONES.filter((p) => !p.sponsored);
const POPULAR = ['air', 'kids'].map((id) => HEADPHONES.find((p) => p.id === id)!);
const mss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

/** Annotation wrapper (.shop-ann + tag) shown only in the annotated default view. */
function Ann({ on, tag, children }: { on: boolean; tag: string; children: ReactNode }) {
  if (!on) return <>{children}</>;
  return (
    <div className="shop-ann">
      <span className="shop-ann-tag">
        <Icon name="tag" />
        {tag}
      </span>
      {children}
    </div>
  );
}

/** Product card with the design's tag stack: deal, Official and Sponsored can all show together. */
function AdCard({ p }: { p: AdProduct }) {
  const [saved, setSaved] = useState(false);
  const off = percentOff(p.price, p.was);
  const official = 'official' in sellers[p.seller];
  return (
    <article className="pcard">
      <div className="pcard-media">
        <Link to={href('store/product')} aria-label={p.name}>
          <Img icon={p.icon} tint={p.tint} />
        </Link>
        <div className="tags">
          {off > 0 && <Badge tone="deal">−{off}%</Badge>}
          {official && <Badge tone="brand">Official</Badge>}
          {p.sponsored && (
            <Badge tone="outline" className="sponsored-badge">
              Sponsored
            </Badge>
          )}
        </div>
        <button type="button" className={cx('fav', saved && 'is-active')} aria-label={`Save ${p.name} to wishlist`} aria-pressed={saved} onClick={() => setSaved((v) => !v)}>
          <Icon name="heart" fill={saved ? 'currentColor' : 'none'} />
        </button>
      </div>
      <Link className="name" to={href('store/product')}>
        {p.name}
      </Link>
      <Stars rating={p.rating} count={p.reviews} />
      <Price amount={p.price} was={p.was} from={p.from} noOff />
      <div className="meta">
        {p.free ? (
          <span>
            <Icon name="truck" className="ic-sm" /> Free delivery {p.delivery}
          </span>
        ) : (
          <span>Delivery {p.delivery}</span>
        )}
      </div>
      <div className="meta">
        <SellerLine seller={p.seller} />
      </div>
    </article>
  );
}

function VideoAd() {
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(true);
  const [t, setT] = useState(0);
  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      setT((s) => {
        if (s + 1 >= VIDEO_SECONDS) {
          setPlaying(false);
          return 0;
        }
        return s + 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [playing]);
  const pct = Math.round((t / VIDEO_SECONDS) * 100);
  return (
    <div className="stack gap-2">
      <div className="shop-video" aria-label="Video ad: Kestrel Wave Pro">
        <span className="ad-label">Ad</span>
        <div className="bg" aria-hidden="true">
          <Icon name="headphones" />
          <Icon name="audio-lines" />
        </div>
        {!playing && (
          <button type="button" className="play" aria-label="Play video ad" onClick={() => setPlaying(true)}>
            <Icon name="play" />
          </button>
        )}
        <div className="ctl">
          <IconButton icon={playing ? 'pause' : 'play'} label={playing ? 'Pause' : 'Play'} onClick={() => setPlaying((v) => !v)} />
          <Meter pct={pct} label="Video progress" />
          <span className="xs strong">
            {mss(t)} / {mss(VIDEO_SECONDS)}
          </span>
          <IconButton icon={muted ? 'volume-x' : 'audio-lines'} label={muted ? 'Unmute' : 'Mute'} aria-pressed={!muted} onClick={() => setMuted((v) => !v)} />
        </div>
      </div>
      <span className="xs muted">Kestrel Wave Pro · sponsored by Pixel &amp; Port · Starts muted and only plays when you press play.</span>
    </div>
  );
}

export default function Formats() {
  const [view, setView] = useView<View>();
  const annotate = view === '';
  const [sort, setSort] = useState<Sort>('Recommended');
  const [stickyClosed, setStickyClosed] = useState(false);

  const organic = sortProducts(ORGANIC, sort);
  const grid1 = [...SPONSORED, ...organic.slice(0, 2)];
  const grid2 = organic.slice(2, 6);
  const grid3 = organic.slice(6, 10);

  const strip = (
    <div className="strip" role="complementary" aria-label="Advertisement">
      <Img icon="headphones" tint="2" />
      <div className="stack gap-0 grow">
        <span className="row gap-2">
          <span className="shop-adtag">Ad</span>
          <span className="small strong truncate">Halden Aurora, $189.00 at the Official Store</span>
        </span>
        <span className="xs muted truncate">Sale ends Oct 19 · Advertiser: Halden Audio</span>
      </div>
      <Button size="sm" to={href('store/product')}>
        Shop
      </Button>
      <IconButton
        icon="x"
        label="Close ad"
        onClick={() => {
          setStickyClosed(true);
          announce('Ad closed. It stays hidden for the rest of your visit.');
        }}
      />
    </div>
  );

  return (
    <StoreLayout nav="categories" appbar={{ title: 'Headphones', back: href('store/categories') }}>
      <div className="container page gap-6">
        {annotate && (
          <section className="card pad stack gap-3" aria-labelledby="af-h">
            <div className="row between">
              <h1 className="h3" id="af-h">
                Ad placements on a category page
              </h1>
              <Badge tone="info" icon="tag">
                Prototype annotation
              </Badge>
            </div>
            <div className="shop-legend">
              {LEGEND.map((l) => (
                <div key={l.name}>
                  <Icon name={l.icon} />
                  <span>
                    <b>{l.name}</b>: {l.text}
                  </span>
                </div>
              ))}
            </div>
            <p className="xs muted">Every paid placement carries an Ad or Sponsored label and names the advertiser or seller. Only one overlay shows at a time.</p>
          </section>
        )}
        <div className="stack gap-2">
          <Breadcrumbs items={[{ label: 'Home', to: href('store/home') }, { label: 'Electronics', to: href('store/categories') }, { label: 'Headphones' }]} />
          {annotate ? <h2 className="h1">Headphones</h2> : <h1 className="h1">Headphones</h1>}
          <p className="small muted">128 results</p>
        </div>

        <Ann on={annotate} tag="Banner ad">
          <Link className="shop-banner" to={href('store/product')} aria-label="Advertisement: Halden Aurora headphones at the Official Store">
            <span className="ad-label">Ad</span>
            <div className="copy">
              <span className="eyebrow">Halden · at the Official Store</span>
              <span className="h2">40 hours of quiet. Aurora ANC headphones, now $189.00.</span>
              <span className="small sub">Sale ends Oct 19, 11:59 PM PT. Sold and shipped by Marketly Official.</span>
              <span className="row gap-3">
                <span className="btn btn-primary btn-sm">Shop Aurora</span>
                <span className="xs muted">Advertiser: Halden Audio</span>
              </span>
            </div>
            <div className="art" aria-hidden="true">
              <Img icon="headphones" tint="2" />
              <Img icon="ear" tint="2" />
            </div>
          </Link>
        </Ann>

        <Ann on={annotate} tag="Sponsored store feature">
          <section className="shop-sfeat" aria-label="Sponsored store">
            <span className="ad-label">Sponsored</span>
            <div className="stack gap-3">
              <div className="row gap-3 nowrap">
                <span className="logo-tile lg tint-2" aria-hidden="true">
                  NA
                </span>
                <div className="stack gap-1">
                  <span className="row gap-2">
                    <span className="h3">Northwind Audio</span>
                    <Badge tone="info" icon="shield-check">
                      Verified
                    </Badge>
                  </span>
                  <span className="xs muted">98% positive · Portland, OR · Ships in 1 business day</span>
                </div>
              </div>
              <p className="small sub">Tested, warrantied audio from an independent Portland shop. 10% off orders over $100 this month.</p>
              <div>
                <Button variant="secondary" size="sm" to={href('store/seller')} iconRight="arrow-right">
                  Visit store
                </Button>
              </div>
            </div>
            <div className="grid c2 gap-3">
              {[
                { name: 'Halden Aria True Wireless Earbuds', icon: 'ear' as const, price: 99, was: 129 },
                { name: 'Halden Pocket Bluetooth Speaker', icon: 'speaker' as const, price: 59, was: 79 },
              ].map((x) => (
                <Link key={x.name} to={href('store/product')} className="stack gap-2 link-plain">
                  <Img icon={x.icon} tint="2" className="r43" />
                  <span className="small clamp-2">{x.name}</span>
                  <Price amount={x.price} was={x.was} noOff />
                </Link>
              ))}
            </div>
          </section>
        </Ann>

        <div className="shop-toolbar">
          <span className="small sub">Showing 1–8 of 128</span>
          <span className="shop-sort">
            <label className="small sub nowrap" htmlFor="af-sort">
              Sort by
            </label>
            <select className="select" id="af-sort" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
              {SORTS.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </span>
        </div>

        <Ann on={annotate} tag="Sponsored product cards">
          <div className="grid-products">
            {grid1.map((p) => (
              <AdCard key={p.id} p={p} />
            ))}
          </div>
        </Ann>
        <div className="grid-products">
          {grid2.map((p) => (
            <AdCard key={p.id} p={p} />
          ))}
        </div>

        <div className="grid md2 gap-6">
          <Ann on={annotate} tag="Video ad · later phase">
            <VideoAd />
          </Ann>
          {annotate ? (
            <Ann on tag="Interstitial">
              <div className="card pad row gap-3 nowrap">
                <Img icon="panel-top-open" tint="6" className="thumb" />
                <div className="stack gap-1">
                  <span className="small strong">Interstitial</span>
                  <span className="xs sub">Appears between selected browsing steps (for example category to product), with a Skip button. Never shown in checkout, payment results, tracking or returns.</span>
                  <Link className="xs strong" to={href('ads/formats', 'interstitial')}>
                    Preview interstitial
                  </Link>
                </div>
              </div>
            </Ann>
          ) : (
            <div className="stack gap-3">
              <h2 className="h3">Popular in Headphones</h2>
              <div className="grid c2">
                {POPULAR.map((p) => (
                  <AdCard key={p.id} p={p} />
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="grid-products">
          {grid3.map((p) => (
            <AdCard key={p.id} p={p} />
          ))}
        </div>
      </div>

      {!stickyClosed && (
        <div className="shop-sticky">
          {annotate ? (
            <Ann on tag="Floating / sticky ad">
              {strip}
            </Ann>
          ) : (
            <>
              {view === 'sticky-ad' && (
                <p className="xs muted center u-mb-sp-2">
                  <span className="shop-adtag wrap ta-left">
                    <Icon name="info" className="ic-sm" />
                    Sticky ad stays visible while browsing. Closing it hides it for the rest of the visit.
                  </span>
                </p>
              )}
              {strip}
            </>
          )}
        </div>
      )}

      <AdOverlay open={view === 'interstitial'} onClose={() => setView('sticky-ad', { replace: true })} className="shop-inter" labelledBy="int-h">
        <div className="art">
          <span className="ad-label">Ad</span>
          <Img icon="monitor" tint="6" />
        </div>
        <div className="modal-body">
          <span className="row gap-2">
            <span className="shop-adtag">Sponsored</span>
            <span className="xs muted">by Pixel &amp; Port</span>
          </span>
          <h2 className="h2" id="int-h">
            Kestrel 27" 4K IPS Monitor, USB-C 65 W
          </h2>
          <div className="row gap-2 base">
            <Price amount={329} />
            <span className="xs muted">Free delivery Fri, Oct 16 · Sold by Pixel &amp; Port</span>
          </div>
          <div className="row gap-2">
            <Button to={href('store/product')}>View offer</Button>
            <Link className="shop-skip" to={href('store/product')} data-dialog-close="">
              Skip ad <Icon name="arrow-right" className="ic-sm" />
            </Link>
          </div>
          <span className="xs muted">You’re on your way to Halden Aurora. Shown at most once per visit, between category and product pages. Never shown in checkout, payment results, tracking or returns.</span>
        </div>
      </AdOverlay>
    </StoreLayout>
  );
}
