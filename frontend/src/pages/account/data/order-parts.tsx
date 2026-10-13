// Small building blocks shared by the account order and return screens: loading skeletons, the
// load-error alert, the not-found card, the API seller line and the phone "load more" trigger.
import { useEffect, useRef, type ReactNode } from 'react';
import { Link } from 'react-router';
import { errorMessage } from '@marketly/web-shared/api';
import { href } from '@marketly/web-shared/routes';
import { Alert, Button, EmptyState, SellerBadge } from '@marketly/web-shared/ui';

/** A failed read: the error and a Try again button (API.md rule 4). */
export function LoadError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <Alert tone="danger" title="We couldn't load this">
      {errorMessage(error)}{' '}
      <Button variant="secondary" size="sm" onClick={onRetry}>
        Try again
      </Button>
    </Alert>
  );
}

/** Skeleton rows for a list card while it loads. */
export function SkeletonRows({ rows = 3, thumb = true }: { rows?: number; thumb?: boolean }) {
  return (
    <div className="sk-list pad" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="sk-row">
          {thumb && <span className="sk sk-thumb" />}
          <span className="sk-lines">
            <span className="sk sk-line" />
            <span className="sk sk-line short" />
          </span>
        </div>
      ))}
    </div>
  );
}

/** Page skeleton for a detail screen: heading lines plus a few cards. */
export function DetailSkeleton({ cards = 2 }: { cards?: number }) {
  return (
    <div className="stack gap-4" role="status" aria-label="Loading">
      <div className="stack gap-2" aria-hidden="true">
        <span className="sk sk-line short" />
        <span className="sk sk-line" />
      </div>
      {Array.from({ length: cards }, (_, i) => (
        <section key={i} className="card">
          <SkeletonRows rows={i === 0 ? 2 : 3} />
        </section>
      ))}
    </div>
  );
}

/** Not-found state for a ref that isn't this shopper's (or doesn't exist). */
export function NotFoundCard({ title, children, back = href('account/orders'), backLabel = 'Back to orders' }: { title: ReactNode; children?: ReactNode; back?: string; backLabel?: string }) {
  return (
    <div className="card">
      <EmptyState icon="search-x" as="h1" title={title} action={<Button to={back}>{backLabel}</Button>}>
        {children}
      </EmptyState>
    </div>
  );
}

/** "Sold by <seller>" with the storefront link and badge, from API seller fields. */
export function SellerLineApi({ seller }: { seller: { name: string; slug?: string | null; official?: boolean; verified?: boolean } }) {
  const to = seller.official ? href('store/official') : seller.slug ? href('store/seller', '', { slug: seller.slug }) : null;
  return (
    <span className="seller-line">
      Sold by{' '}
      {to ? (
        <Link to={to}>
          <b>{seller.name}</b>
        </Link>
      ) : (
        <b>{seller.name}</b>
      )}
      <SellerBadge seller={seller} compact />
    </span>
  );
}

/** Calls `onVisible` when the returned element scrolls into view (phone lists load the next page). */
export function useInView<T extends HTMLElement>(onVisible: () => void, enabled: boolean) {
  const ref = useRef<T | null>(null);
  const cb = useRef(onVisible);
  cb.current = onVisible;
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && cb.current(), { rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, [enabled]);
  return ref;
}
