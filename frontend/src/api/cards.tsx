import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { errorMessage } from '@marketly/web-shared/api';
import { cx } from '@marketly/web-shared/lib/cx';
import { dollars } from '@marketly/web-shared/lib/format';
import { href } from '@marketly/web-shared/routes';
import { Alert, Button, Img, LazyLoad, Pager, ProductCard, type CardProduct, type IconName } from '@marketly/web-shared/ui';
import { useAdTracking } from './ad-events';
import type { MediaRef } from './catalog';
import { productHref, type Listing, type StoreCard } from './search';

// Store browse building blocks rendered from API data with the design's markup: the product card
// (.pcard), image tiles with real photos, skeletons, the load-error alert and the listing pager.

const FILL: CSSProperties = { width: '100%', height: '100%', objectFit: 'cover', borderRadius: 'inherit' };

/** Image tile (.imgph): the API photo when there is one, else the design's tinted icon placeholder. */
export function Pic({ image, icon = 'package', tint = '1', className, alt }: { image?: MediaRef | null; icon?: IconName; tint?: string; className?: string; alt?: string }) {
  return <Img icon={icon} tint={tint} className={className} src={image?.url} alt={alt ?? image?.alt ?? ''} />;
}

/** Logo tile (.logo-tile) with the logo image, or initials. */
export function LogoPic({ logo, initials, tint, size, className }: { logo?: MediaRef | null; initials: string; tint: string; size?: 'xs' | 'sm' | 'md'; className?: string }) {
  return (
    <span className={cx('logo-tile', size, `tint-${tint}`, className)} aria-hidden="true">
      {logo ? <img src={logo.url} alt="" style={FILL} /> : initials}
    </span>
  );
}

/** Storefront link for a card's seller: the Official Store page, a seller store when its slug is known. */
export const sellerHref = (s: { official: boolean; slug?: string | null }) => (s.official ? href('store/official') : s.slug ? href('store/seller', '', { slug: s.slug }) : null);

/** A store card as the shared ProductCard's data (API fields: photo, seller name and link, Official badge). */
export function toCardData(c: StoreCard): CardProduct {
  return {
    id: c.id,
    name: c.title,
    price: dollars(c.price),
    was: c.was ? dollars(c.was) : null,
    rating: c.rating ?? 0,
    reviews: c.ratingCount,
    icon: c.icon,
    tint: c.tint,
    offers: c.from ? 2 : 1,
    delivery: c.delivery ?? '',
    free: c.free,
    image: c.image?.url ?? null,
    sellerName: c.seller?.name,
    sellerTo: c.seller ? (sellerHref(c.seller) ?? undefined) : undefined,
    official: c.seller?.official ?? false,
  };
}

/**
 * Product card from API data: the shared ProductCard (design .pcard) with the product route and its id,
 * the photo and the seller from the API, and no wishlist heart (wishlist is off at launch).
 * `onOpen` reports search result clicks; sponsored cards also record their ad display and click with
 * the impression token. The wrapper has display: contents so the grid is unchanged.
 */
export function ApiProductCard({ c, compact, showSeller, from, extra, onOpen }: { c: StoreCard; compact?: boolean; showSeller?: boolean; from?: boolean; extra?: ReactNode; onOpen?: (c: StoreCard) => void }) {
  const card = (
    <ProductCard
      p={toCardData(c)}
      to={productHref(c)}
      sponsored={c.sponsored}
      compact={compact}
      showSeller={showSeller}
      from={from}
      noFav
      extra={
        <>
          {c.availability === 'out_of_stock' && (
            <div className="meta">
              <span>Out of stock</span>
            </div>
          )}
          {extra}
        </>
      }
    />
  );
  if (!onOpen && !c.impressionToken) return card;
  return (
    <TrackedCard c={c} onOpen={onOpen}>
      {card}
    </TrackedCard>
  );
}

function TrackedCard({ c, onOpen, children }: { c: StoreCard; onOpen?: (c: StoreCard) => void; children: ReactNode }) {
  const ad = useAdTracking<HTMLDivElement>(c.impressionToken);
  return (
    <div
      ref={ad.ref}
      style={{ display: 'contents' }}
      onClickCapture={(e) => {
        if (!(e.target as HTMLElement).closest('a')) return;
        onOpen?.(c);
        ad.click();
      }}
    >
      {children}
    </div>
  );
}

/** Skeleton cards in the product grid while a listing loads (design .sk-card). */
export function CardGridSkeleton({ n = 8, wide, className }: { n?: number; wide?: boolean; className?: string }) {
  return (
    <div className={cx('grid-products', wide && 'wide', className)} aria-busy="true" aria-label="Loading products">
      {Array.from({ length: n }, (_, i) => (
        <div className="sk-card" key={i} aria-hidden="true">
          <span className="sk sk-img" />
          <span className="sk sk-line" />
          <span className="sk sk-line short" />
        </div>
      ))}
    </div>
  );
}

/** Skeleton text lines (headings, counts) while a page loads. */
export function SkLines({ n = 2, className }: { n?: number; className?: string }) {
  return (
    <span className={cx('sk-lines', className)} aria-hidden="true">
      {Array.from({ length: n }, (_, i) => (
        <span key={i} className={cx('sk sk-line', i === n - 1 && n > 1 && 'short')} />
      ))}
    </span>
  );
}

/** A failed read: the server's message and a Try again button (API.md rule 4). */
export function LoadError({ error, onRetry, title = 'We couldn’t load this' }: { error: unknown; onRetry: () => void; title?: ReactNode }) {
  return (
    <Alert tone="danger" title={title}>
      {errorMessage(error)}{' '}
      <Button variant="secondary" size="sm" icon="refresh-cw" onClick={onRetry}>
        Try again
      </Button>
    </Alert>
  );
}

/** Phone lazy-load row: loads the next cursor page when it scrolls into view (design .lazy-load). */
export function InfiniteRow({ listing }: { listing: Pick<Listing, 'hasMore' | 'loadMore' | 'loadingMore'> }) {
  const ref = useRef<HTMLSpanElement>(null);
  const { hasMore, loadMore } = listing;
  useEffect(() => {
    const el = ref.current;
    if (!el || !hasMore) return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && loadMore(), { rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, loadMore]);
  return (
    <>
      <span ref={ref} aria-hidden="true" />
      <LazyLoad grid end={!hasMore} />
    </>
  );
}

/** Listing paging: website page numbers (`page`) and the phone lazy-load row (`cursor`). */
export function ListingPager({ listing, onPage }: { listing: Listing; onPage: (p: number) => void }) {
  return (
    <>
      {listing.phone && <InfiniteRow listing={listing} />}
      {!listing.phone && listing.totalPages > 1 && <Pager page={listing.page} total={listing.totalPages} onPage={onPage} grid only="website" />}
    </>
  );
}
