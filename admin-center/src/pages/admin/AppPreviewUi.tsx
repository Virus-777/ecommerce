import { useQuery } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { errorMessage } from '@marketly/web-shared/api';
import { cx } from '@marketly/web-shared/lib/cx';
import { useCountdown } from '@marketly/web-shared/lib/hooks';
import { Icon, Img, type IconName } from '@marketly/web-shared/ui';
import { adDecision, decodeEntities, num, price, productPath, tileTint, type AdDecision, type CardModel, type Money } from './data/appPreview';

// The pieces every screen of the App preview phone is built from: its navigation (a tap opens a store path, the
// way `Links.open` does in the app), the app's product card, prices, section headers, loading and empty states,
// and the ad carousel. AppPreview.tsx draws the store screens with them, AppPreviewDepartments.tsx the ten
// department pages. The CSS is AppPreview.css, scoped to .ap-phone.

// ---------------------------------------------------------------- the phone's navigation

export interface Nav {
  go: (path: string) => void;
  note: (text: string) => void;
  /** The sub bar's title, which a screen sets once it knows it (the app's `toolbar.title = …`). */
  setTitle: (text: string) => void;
}
export const NavCtx = createContext<Nav>({ go: () => {}, note: () => {}, setTitle: () => {} });
export const useNav = () => useContext(NavCtx);

/** Puts a loaded screen's own name in the sub bar. */
export function useScreenTitle(title: string | undefined) {
  const { setTitle } = useNav();
  useEffect(() => {
    if (title) setTitle(title);
  }, [title, setTitle]);
}

/** A tap target inside the phone that opens a store path (`Links.open`). */
export function Tap({ to, className, children, label }: { to?: string | null; className?: string; children: ReactNode; label?: string }) {
  const { go } = useNav();
  if (!to) return <div className={className}>{children}</div>;
  return (
    <button type="button" className={className} aria-label={label} onClick={() => go(to)}>
      {children}
    </button>
  );
}

/** A "See all" link of a section header or row. */
export function TapLink({ to, label, onClick }: { to?: string | null; label?: string | null; onClick?: () => void }) {
  const { go } = useNav();
  if (!label || (!to && !onClick)) return null;
  return (
    <button type="button" className="ap-link" onClick={() => (onClick ? onClick() : to && go(to))}>
      {label}
    </button>
  );
}

// ---------------------------------------------------------------- small pieces of the app's design system

export function SectionHead({ title, link, to, onLink }: { title: string; link?: string | null; to?: string | null; onLink?: () => void }) {
  const { go } = useNav();
  return (
    <div className="ap-head ap-gutter">
      <h2>{decodeEntities(title)}</h2>
      {link && (
        <button type="button" className="ap-link" onClick={() => (onLink ? onLink() : to && go(to))}>
          {link}
        </button>
      )}
    </div>
  );
}

/** `Prices.bind`: the price bold (deal colour when discounted), the was price struck through, an optional "from". */
export function PriceLine({ now, was, from, className }: { now?: Money | null; was?: Money | null; from?: boolean; className?: string }) {
  if (!now) return null;
  const discounted = !!was && was.amount > now.amount;
  return (
    <div className={cx('ap-price', discounted && 'deal', className)}>
      {from && <span className="from">from</span>}
      <span>{price(now)}</span>
      {discounted && <span className="was">{price(was)}</span>}
    </div>
  );
}

/** "★ 4.6 (1,284)" as the cards draw it; nothing without ratings. */
export function Stars({ rating, count }: { rating?: number | null; count?: number | null }) {
  if (rating == null) return null;
  return (
    <span className="ap-stars">
      <i>★ </i>
      <b>{rating.toFixed(1)}</b>
      {count != null && count > 0 && <span className="ap-muted"> ({num(count)})</span>}
    </span>
  );
}

/** The store's product card (`ProductCardView`): tap opens the product, the round button adds to the cart. */
export function PCard({ m, compact = false, showSeller = !compact }: { m: CardModel; compact?: boolean; showSeller?: boolean }) {
  const { note } = useNav();
  const cartNote = 'Adding to the cart is off in the preview.';
  return (
    <Tap className="ap-pcard" to={productPath(m.slug, m.productId)} label={m.title}>
      <div className="ap-pcard-art">
        <Img icon="package" tint={tileTint(m.productId)} src={m.image?.thumbUrl ?? m.image?.url ?? undefined} alt="" />
        <div className="ap-pcard-tags">
          {m.discountLabel && <span className="ap-badge deal">{m.discountLabel}</span>}
          {m.official && !compact && <span className="ap-badge brand">Official</span>}
          {m.sponsored && <span className="ap-badge outline">Sponsored</span>}
        </div>
        {m.offerId && m.price && !m.outOfStock && (
          <span className="ap-cartbtn" role="button" tabIndex={0} onClick={(e) => (e.stopPropagation(), note(cartNote))} onKeyDown={(e) => e.key === 'Enter' && (e.stopPropagation(), note(cartNote))}>
            <span>
              <Icon name="shopping-cart" />
            </span>
          </span>
        )}
      </div>
      <div className="ap-pcard-title ap-clamp2">{decodeEntities(m.title)}</div>
      {m.rating != null && m.ratingCount > 0 && (
        <div className="ap-pcard-rating">
          <Stars rating={m.rating} count={m.ratingCount} />
        </div>
      )}
      <PriceLine now={m.price} was={m.wasPrice} from={m.priceIsFrom} />
      {m.deliveryCue && !m.outOfStock && (
        <div className="ap-pcard-line">
          {m.freeDelivery && <Icon name="truck" />}
          <span>{m.deliveryCue}</span>
        </div>
      )}
      {showSeller && m.sellerName && (
        <div className="ap-pcard-line ap-pcard-seller">
          Sold by <b>{decodeEntities(m.sellerName)}</b>
        </div>
      )}
      {m.outOfStock && <div className="ap-pcard-line ap-strong">Out of stock</div>}
    </Tap>
  );
}

/** The app's countdown (`startCountdown`): hh : mm : ss, counting down from the seconds the API sent. */
export function Countdown({ seconds }: { seconds: number }) {
  const [hh, mm, ss] = useCountdown(seconds);
  return (
    <span className="ap-countdown">
      <b>{hh}</b>:<b>{mm}</b>:<b>{ss}</b>
    </span>
  );
}

export function Loading({ rows = 3, list = false }: { rows?: number; list?: boolean }) {
  return (
    <div className="ap-gutter ap-section" aria-label="Loading">
      <div className="ap-skel" style={{ height: 22, width: '55%' }} />
      {list ? (
        <div className="ap-stack" style={{ marginTop: 16 }}>
          {Array.from({ length: rows }, (_, i) => (
            <div key={i} className="ap-skel" style={{ height: 76 }} />
          ))}
        </div>
      ) : (
        <div className="ap-grid" style={{ marginTop: 16 }}>
          {Array.from({ length: rows * 2 }, (_, i) => (
            <div key={i}>
              <div className="ap-skel" style={{ aspectRatio: '1 / 1' }} />
              <div className="ap-skel" style={{ height: 13, marginTop: 8 }} />
              <div className="ap-skel" style={{ height: 13, width: '60%', marginTop: 6 }} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** `StateView.showError` / `showEmpty`: the server's message, with the screen's retry. */
export function StateBox({ icon = 'triangle-alert', title, text, action, onAction }: { icon?: IconName; title: string; text?: string | null; action?: string; onAction?: () => void }) {
  return (
    <div className="ap-state">
      <Icon name={icon} />
      <h3>{title}</h3>
      {text && <p>{text}</p>}
      {action && (
        <button type="button" className="ap-btn secondary sm" style={{ marginTop: 16 }} onClick={onAction}>
          {action}
        </button>
      )}
    </div>
  );
}

export function ErrorBox({ title, error, onRetry }: { title: string; error: unknown; onRetry: () => void }) {
  return <StateBox title={title} text={errorMessage(error)} action="Try again" onAction={onRetry} />;
}

/** `ListFooter.showEnd`: the quiet line that closes a fully loaded list. */
export function EndNote({ children }: { children: ReactNode }) {
  return (
    <div className="ap-xs ap-muted" style={{ textAlign: 'center', padding: '20px 16px' }}>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------- ads

/** The ads of a page's inline slots. Decisions only: no display or click is ever reported from a preview. */
export function useAds(page: string, keys: string[], context?: { categoryId?: string }) {
  const slots = [...new Set(keys)].filter((k) => k !== 'opening_fullscreen');
  return useQuery<AdDecision>({
    queryKey: ['app-preview', 'ads', page, slots.join(','), context?.categoryId ?? ''],
    enabled: slots.length > 0,
    queryFn: () => adDecision(page, slots, context),
    staleTime: 60_000,
  });
}

/** The app's ad carousel (`HomeAdCarousel`), without its tilt-and-depth motion: one banner at a time, with dots. */
export function AdSlot({ decision, slotKey }: { decision: AdDecision | undefined; slotKey: string }) {
  const [at, setAt] = useState(0);
  const ads = decision?.slots?.[slotKey] ?? [];
  if (!decision) return null;
  if (!ads.length) {
    return (
      <div className="ap-adslot ap-section">
        <div className="ap-slot-empty">Ad position “{slotKey}” · no ad is running for it now</div>
      </div>
    );
  }
  const ad = ads[Math.min(at, ads.length - 1)];
  return (
    <div className="ap-adslot ap-section">
      <Tap className="ap-ad" to={ad.destination} label={ad.headline}>
        {ad.image ? (
          <div style={{ position: 'relative' }}>
            <Img icon="megaphone" tint={tileTint(ad.impressionToken)} src={ad.image.url ?? undefined} alt={ad.image.alt ?? ''} />
            <span className="ap-ad-label">{ad.label ?? 'Ad'}</span>
          </div>
        ) : (
          <div className="ap-ad-text">
            <span className="ap-badge">{ad.label ?? 'Ad'}</span>
            {ad.eyebrow && <div className="ap-eyebrow ap-muted" style={{ marginTop: 8 }}>{decodeEntities(ad.eyebrow)}</div>}
            <div className="ap-h3" style={{ marginTop: 4 }}>{decodeEntities(ad.headline)}</div>
            {ad.body && <div className="ap-sm ap-sub" style={{ marginTop: 4 }}>{decodeEntities(ad.body)}</div>}
            <div className="ap-xs ap-muted" style={{ marginTop: 8 }}>Ad by {ad.advertiserName}</div>
          </div>
        )}
      </Tap>
      {ads.length > 1 && (
        <div className="ap-ad-dots">
          {ads.map((a, i) => (
            <i key={a.impressionToken} className={cx(i === Math.min(at, ads.length - 1) && 'on')} onClick={() => setAt(i)} />
          ))}
        </div>
      )}
    </div>
  );
}
