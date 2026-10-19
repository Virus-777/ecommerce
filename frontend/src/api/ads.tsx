import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { call, useApi, useSessionState, type components } from '@marketly/web-shared/api';
import { dollars } from '@marketly/web-shared/lib/format';
import { useIsPhone } from '@marketly/web-shared/lib/hooks';
import { cx } from '@marketly/web-shared/lib/cx';
import { Button, Icon, IconButton, Img, Price } from '@marketly/web-shared/ui';
import { AdOverlay } from '@/pages/ads/data/overlay';
import { initialsOf, tintOf } from './catalog';
import { LogoPic, Pic } from './cards';
import { useAdEvents, useAdTracking } from './ad-events';
import { contentLinkTo, isExternal } from './content';

// Ad positions of the store browse pages (BACKEND-REQUESTS G23): POST /api/store/advertising/decisions
// says which ads a page view shows per placement key, POST /api/store/advertising/events records displays,
// clicks and closes with each ad's impression token. visitorId is the browser's first-party install id
// (shared with the sign-in screens), sessionId the visitor/customer session id. There are no privacy
// choices in the store yet, so personalizationAllowed is false (page context only). An empty or failed
// decision renders nothing: ad positions have no empty state of their own.

type S = components['schemas'];
export type AdImpression = S['advertising.AdImpression'];
export type AdDecision = S['advertising.ServeDecision'];
type ServeContext = S['advertising.ServeContext'];
export type AdPage = 'home' | 'category' | 'search' | 'product' | 'campaign' | 'collection' | 'deals' | 'brand' | 'seller_store' | 'official_store';

const INSTALL_KEY = 'marketly.installationId';
const OVERLAY_KEY = 'marketly.ads.overlayShown';

/** The first-party visitor id: this browser's install id, else the session id. */
function visitorId(sid: string): string {
  try {
    let id = localStorage.getItem(INSTALL_KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(INSTALL_KEY, id);
    }
    return id;
  } catch {
    return sid;
  }
}

const overlayShown = () => {
  try {
    return sessionStorage.getItem(OVERLAY_KEY) === '1';
  } catch {
    return false;
  }
};
/** Remembers that an overlay ad was shown in this browser session (at most one per visit). */
export const markOverlayShown = () => {
  try {
    sessionStorage.setItem(OVERLAY_KEY, '1');
  } catch {
    /* private mode */
  }
};

/** The first page view of this visit (opening ads only show there). */
let entryPending = true;

/** Ads for one page view: placement key → ads, plus at most one overlay. */
export function useAdDecision(page: AdPage, slots: string[], context: ServeContext = {}, { enabled = true }: { enabled?: boolean } = {}) {
  const { api } = useApi();
  const { claims } = useSessionState();
  const phone = useIsPhone();
  const sid = claims?.sid ?? '';
  const [isEntryPage] = useState(() => {
    const entry = entryPending;
    entryPending = false;
    return entry;
  });
  return useQuery({
    queryKey: ['advertising', 'decision', page, slots, context, phone ? 'phone' : 'desktop'],
    queryFn: () =>
      call(
        api.POST('/api/store/advertising/decisions', {
          body: {
            page,
            context,
            device: phone ? 'phone' : 'desktop',
            visitorId: visitorId(sid),
            sessionId: sid,
            isEntryPage,
            slots,
            overlayShownThisSession: overlayShown(),
            personalizationAllowed: false,
          },
        }),
      ),
    enabled: enabled && !!sid && slots.length > 0,
    // The server says how long a decision may be reused.
    staleTime: (q) => (q.state.data?.ttlSeconds ?? 60) * 1000,
    retry: false,
  });
}

/** Link to an ad destination (store route or absolute URL). */
function AdLink({ ad, className, label, onClick, children }: { ad: AdImpression; className?: string; label?: string; onClick: () => void; children: ReactNode }) {
  const to = contentLinkTo(ad.destination);
  return isExternal(to) ? (
    <a className={className} href={to} aria-label={label} onClick={onClick} rel="sponsored noopener">
      {children}
    </a>
  ) : (
    <Link className={className} to={to} aria-label={label} onClick={onClick}>
      {children}
    </Link>
  );
}

/** Category banner ad (design store-category .shop-banner, placement category_banner). */
export function BannerAd({ ad }: { ad: AdImpression }) {
  const { ref, click } = useAdTracking<HTMLSpanElement>(ad.impressionToken);
  return (
    <span ref={ref} style={{ display: 'contents' }}>
      <AdLink ad={ad} className="shop-banner" label={`Advertisement: ${ad.headline}`} onClick={click}>
        <span className="ad-label">{ad.label}</span>
        <div className="copy">
          {ad.eyebrow && <span className="eyebrow">{ad.eyebrow}</span>}
          <span className="h2">{ad.headline}</span>
          {(ad.body ?? ad.footnote) && <span className="small sub">{ad.body ?? ad.footnote}</span>}
          <span className="row gap-3">
            <span className="btn btn-primary btn-sm">{ad.buttonText}</span>
            <span className="xs muted">Advertiser: {ad.advertiserName}</span>
          </span>
        </div>
        <div className="art" aria-hidden="true">
          {ad.image ? <Pic image={ad.image} alt="" /> : <Pic image={ad.promotedOffer?.image} tint="2" />}
          {ad.promotedOffer?.image && ad.image && <Pic image={ad.promotedOffer.image} alt="" />}
        </div>
      </AdLink>
    </span>
  );
}

/** Sponsored brand block on the home page (design store-home .home-sponsor, placement home_banner). */
export function SponsoredBrandAd({ ad }: { ad: AdImpression }) {
  const { ref, click } = useAdTracking<HTMLElement>(ad.impressionToken);
  const offer = ad.promotedOffer;
  const to = contentLinkTo(ad.destination);
  const external = isExternal(to);
  return (
    <section ref={ref} className="home-sponsor" aria-label={ad.label === 'Sponsored' ? 'Sponsored brand' : 'Advertisement'}>
      <span className="ad-label">{ad.label}</span>
      <div className="stack gap-3 u-p-sp-6">
        <div className="row gap-3">
          <LogoPic logo={ad.advertiserLogo} initials={initialsOf(ad.advertiserName)} tint={tintOf(ad.advertiserName)} className="lg" />
          <div className="stack gap-0">
            <span className="h3">{ad.advertiserName}</span>
            {ad.eyebrow && <span className="xs muted">{ad.eyebrow}</span>}
          </div>
        </div>
        <p className="sub">{ad.body ?? ad.headline}</p>
        <div>
          {external ? (
            <a className="btn btn-secondary" href={to} onClick={click} rel="sponsored noopener">
              <span>{ad.buttonText}</span>
            </a>
          ) : (
            <Link className="btn btn-secondary" to={to} onClick={click}>
              <span>{ad.buttonText}</span>
            </Link>
          )}
        </div>
      </div>
      <div className="grid c2 gap-3 u-p-sp-4 u-content-center">
        {offer ? (
          <AdLink ad={ad} className="stack gap-2 link-plain" onClick={click}>
            <Pic image={offer.image} className="r43" />
            <span className="small strong clamp-2">{offer.title}</span>
            <Price amount={dollars(offer.price)} was={offer.wasPrice ? dollars(offer.wasPrice) : null} noOff />
          </AdLink>
        ) : (
          ad.image && <Pic image={ad.image} className="r43" alt="" />
        )}
      </div>
    </section>
  );
}

/** An image ad on the home banner: the whole creative links to the destination; the headline names it. */
function ImageBannerAd({ ad }: { ad: AdImpression }) {
  const { ref, click } = useAdTracking<HTMLSpanElement>(ad.impressionToken);
  return (
    <span ref={ref} style={{ display: 'contents' }}>
      <AdLink ad={ad} className="home-adc-img" label={`${ad.label}: ${ad.headline}`} onClick={click}>
        <Pic image={ad.image} icon="megaphone" tint="2" alt="" />
        <span className="ad-label">{ad.label}</span>
      </AdLink>
    </span>
  );
}

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Home banner ads (placement home_banner): a carousel of every ad in the decision (all live ads unless staff set a
 * "Most ads per page" limit on the placement), advancing every
 * `seconds` (decision.rotationSeconds, 6 s) while more than one is live. Image creatives fill the slide
 * (750 × 400 phone, 1200 × 300 desktop); a creative without an image shows as the sponsored brand block.
 * It pauses on hover and keyboard focus (the placement's pauseOnHoverAndFocus) and while the tab is hidden;
 * the pause button stops it for good (WCAG 2.2.2), and it starts stopped for people who prefer reduced motion.
 * Swipe on touch screens; dots (and previous/next on wider screens) otherwise. Slides off screen are inert, and
 * each ad records its display only once it is half on screen (useAdTracking), so unseen slides don't count.
 */
export function HomeAdCarousel({ ads, seconds }: { ads: AdImpression[]; seconds?: number | null }) {
  const n = ads.length;
  const [index, setIndex] = useState(0);
  const [held, setHeld] = useState(false);
  const [stopped, setStopped] = useState(reducedMotion);
  const [hidden, setHidden] = useState(() => typeof document !== 'undefined' && document.hidden);
  const at = n ? Math.min(index, n - 1) : 0;
  const go = (k: number) => setIndex(((k % n) + n) % n);

  useEffect(() => {
    const onVis = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);
  useEffect(() => {
    if (n < 2 || held || stopped || hidden) return;
    const t = setTimeout(() => setIndex((x) => (x + 1) % n), Math.max(seconds ?? 6, 2) * 1000);
    return () => clearTimeout(t);
  }, [at, n, held, stopped, hidden, seconds]);

  // touch swipe: a mostly horizontal move of 40 px changes the slide and cancels the tap on the ad
  const swipe = useRef<{ x: number; y: number } | null>(null);
  const swiped = useRef(false);
  const onPointerDown = (e: ReactPointerEvent) => {
    if (e.pointerType !== 'mouse') swipe.current = { x: e.clientX, y: e.clientY };
  };
  const onPointerUp = (e: ReactPointerEvent) => {
    const s = swipe.current;
    swipe.current = null;
    if (!s || n < 2) return;
    const dx = e.clientX - s.x;
    if (Math.abs(dx) < 40 || Math.abs(dx) < Math.abs(e.clientY - s.y)) return;
    swiped.current = true;
    go(at + (dx < 0 ? 1 : -1));
  };
  const onClickCapture = (e: ReactMouseEvent) => {
    if (!swiped.current) return;
    swiped.current = false;
    e.preventDefault();
    e.stopPropagation();
  };

  if (!n) return null;
  const rotating = n > 1 && !held && !stopped && !hidden;
  return (
    <section
      className="home-adc"
      aria-roledescription="carousel"
      aria-label="Advertisements"
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setHeld(false)}
    >
      <div className="home-adc-view" onPointerDown={onPointerDown} onPointerUp={onPointerUp} onPointerCancel={() => (swipe.current = null)} onClickCapture={onClickCapture}>
        <div className="home-adc-track" style={{ transform: `translateX(-${at * 100}%)` }} aria-live={rotating ? 'off' : 'polite'}>
          {ads.map((ad, k) => (
            <div key={ad.impressionToken || `${ad.campaignId}-${k}`} className="home-adc-slide" role="group" aria-roledescription="slide" aria-label={`${k + 1} of ${n}`} aria-hidden={k !== at || undefined} inert={k !== at}>
              {ad.image ? <ImageBannerAd ad={ad} /> : <SponsoredBrandAd ad={ad} />}
            </div>
          ))}
        </div>
      </div>
      {n > 1 && (
        <div className="home-adc-nav">
          <IconButton icon="chevron-left" label="Previous ad" size="sm" className="no-phone" onClick={() => go(at - 1)} />
          <span className="home-adc-dots">
            {ads.map((ad, k) => (
              <button key={ad.impressionToken || k} type="button" className={cx('home-adc-dot', k === at && 'is-active')} aria-label={`Show ad ${k + 1} of ${n}`} aria-current={k === at || undefined} onClick={() => go(k)} />
            ))}
          </span>
          <IconButton icon="chevron-right" label="Next ad" size="sm" className="no-phone" onClick={() => go(at + 1)} />
          <IconButton icon={stopped ? 'play' : 'pause'} label={stopped ? 'Play the ads' : 'Pause the ads'} size="sm" onClick={() => setStopped((s) => !s)} />
        </div>
      )}
    </section>
  );
}

/** The ads of one placement key in a decision. */
export const adsFor =(d: AdDecision | undefined, key: string): AdImpression[] => d?.slots[key] ?? [];

/** Placement keys whose ads come as the decision's overlay, not inline. */
export const OVERLAY_KEYS = ['opening_fullscreen', 'popup', 'interstitial'];

/**
 * Opening full-screen ad on the entry page (design ads-opening, .shop-oa .ad): the decision's overlay,
 * once per visit. Close, Esc and the secondary action record `close`; the button records `click`.
 */
export function OpeningAd({ ad, onClose }: { ad: AdImpression; onClose: () => void }) {
  const { ref, click } = useAdTracking<HTMLSpanElement>(ad.impressionToken);
  const send = useAdEvents();
  useEffect(() => markOverlayShown(), []);
  const close = () => {
    send([{ impressionToken: ad.impressionToken, kind: 'close', at: new Date().toISOString() }]);
    onClose();
  };
  const to = contentLinkTo(ad.destination);
  const offer = ad.promotedOffer;
  const sponsored = ad.label === 'Sponsored';
  return (
    <AdOverlay open onClose={close} overlayClassName="shop-oa" className="ad" label={`${ad.label}: ${ad.headline}`}>
      <span ref={ref} style={{ display: 'contents' }}>
        <div className="top">
          <span className="shop-adtag">{sponsored ? 'Sponsored' : `${ad.label} · ${ad.advertiserName}`}</span>
          <button type="button" className="shop-skip" onClick={close}>
            {ad.closeLabel ?? (sponsored ? 'Close ad' : 'Skip')} <Icon name="x" className="ic-sm" />
          </button>
        </div>
        <div className="art" aria-hidden="true">
          {ad.image ? <Img icon="image" src={ad.image.url} className="big" /> : <Img icon="image" tint="surface" className="big" />}
          {offer?.image && <Img icon="package" src={offer.image.url} />}
        </div>
        <div className="copy">
          {sponsored ? (
            <span className="row gap-2">
              <LogoPic logo={ad.advertiserLogo} initials={initialsOf(ad.advertiserName)} tint={tintOf(ad.advertiserName)} />
              <span className="stack gap-0">
                <span className="strong">{ad.advertiserName}</span>
                <span className="xs muted">Advertiser</span>
              </span>
            </span>
          ) : (
            ad.eyebrow && <span className="eyebrow">{ad.eyebrow}</span>
          )}
          <h2 className="display d-xl">{ad.headline}</h2>
          {ad.body && <p className="sub">{ad.body}</p>}
          {offer && (
            <div className="row gap-2 base">
              <Price amount={dollars(offer.price)} was={offer.wasPrice ? dollars(offer.wasPrice) : null} lg />
            </div>
          )}
          {offer?.deliveryNote && <span className="small sub">{offer.deliveryNote}</span>}
          <div className="row gap-2">
            {isExternal(to) ? (
              <a className="btn btn-primary btn-lg" href={to} onClick={click} rel="sponsored noopener">
                <span>{ad.buttonText}</span>
                <Icon name="arrow-right" />
              </a>
            ) : (
              <Button size="lg" to={to} iconRight="arrow-right" onClick={click}>
                {ad.buttonText}
              </Button>
            )}
            <Button variant="ghost" onClick={close}>
              {ad.secondaryText ?? 'Continue to home page'}
            </Button>
          </div>
          {ad.footnote && <span className="xs muted">{ad.footnote}</span>}
        </div>
      </span>
    </AdOverlay>
  );
}
