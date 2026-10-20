import { LoadError as SharedLoadError, LogoTile } from '@marketly/web-shared/ui';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import { call, errorMessage, useApi } from '@marketly/web-shared/api';
import { cx } from '@marketly/web-shared/lib/cx';
import { dollars } from '@marketly/web-shared/lib/format';
import { href } from '@marketly/web-shared/routes';
import { Icon, Img, LazyLoad, Pager, ProductCard, announce, type CardProduct, type IconName } from '@marketly/web-shared/ui';
import { useSession } from '@/app/session';
import { useAdTracking } from './ad-events';
import type { MediaRef } from './catalog';
import { productHref, type Listing, type StoreCard } from './search';

// Store browse building blocks rendered from API data with the design's markup: the product card
// (.pcard), image tiles with real photos, skeletons, the load-error alert and the listing pager.


/** Image tile (.imgph): the API photo when there is one, else the design's tinted icon placeholder. */
export function Pic({ image, icon = 'package', tint = '1', className, alt }: { image?: MediaRef | null; icon?: IconName; tint?: string; className?: string; alt?: string }) {
  return <Img icon={icon} tint={tint} className={className} src={image?.url} alt={alt ?? image?.alt ?? ''} />;
}

/** Logo tile (.logo-tile) with the logo image, or initials. */
export function LogoPic({ logo, initials, tint, size, className }: { logo?: MediaRef | null; initials: string; tint: string; size?: 'xs' | 'sm' | 'md'; className?: string }) {
  return <LogoTile initials={initials} tint={tint} size={size} className={className} src={logo?.url} />;
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
  const [cartError, setCartError] = useState('');
  const canAdd = !!c.offerId && !!c.price && c.availability !== 'out_of_stock';
  const card = (
    <ProductCard
      p={toCardData(c)}
      to={productHref(c)}
      sponsored={c.sponsored}
      compact={compact}
      showSeller={showSeller}
      from={from}
      noFav
      action={canAdd ? <CardCartButton offerId={c.offerId!} title={c.title} onError={setCartError} /> : undefined}
      extra={
        <>
          {c.availability === 'out_of_stock' && (
            <div className="meta">
              <span>Out of stock</span>
            </div>
          )}
          {cartError && (
            <span className="xs t-danger-text" role="alert">
              {cartError}
            </span>
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

/**
 * Cart button on a card's thumbnail: adds one of the offer the card shows (POST cart/items), refreshes the cart
 * badge and shows a check for a moment. Errors (e.g. a purchase limit) appear under the card.
 */
function CardCartButton({ offerId, title, onError }: { offerId: string; title: string; onError: (text: string) => void }) {
  const { api } = useApi();
  const { refreshCart } = useSession();
  const [added, setAdded] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const add = useMutation({
    mutationFn: () => call(api.POST('/api/store/cart/cart/items', { body: { offerId, quantity: 1 } })),
    onSuccess: (r) => {
      refreshCart();
      onError('');
      setAdded(true);
      announce(r.message || `Added ${title} to your cart`);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setAdded(false), 2500);
    },
    onError: (e) => {
      const text = errorMessage(e);
      onError(text);
      announce(text);
    },
  });
  return (
    <button type="button" className="cart-add" aria-label={added ? `${title} added to cart` : `Add ${title} to cart`} disabled={add.isPending} onClick={() => add.mutate()}>
      <Icon name={added ? 'check' : 'shopping-cart'} />
    </button>
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
  return <SharedLoadError error={error} onRetry={onRetry} title={title} />;
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
