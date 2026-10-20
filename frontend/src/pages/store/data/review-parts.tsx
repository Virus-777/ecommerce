// Blocks shared by the product sub-pages (All offers, Product reviews, Questions and answers) and
// the product page: keyword matching and highlighting, product photos, the product summary card
// and phone action bar, a review card, and the load-error alert.
import { LoadError as SharedLoadError } from '@marketly/web-shared/ui';
import { Fragment, type ReactNode } from 'react';
import { Link } from 'react-router';
import { cx } from '@marketly/web-shared/lib/cx';
import { dollars, formatMoney } from '@marketly/web-shared/lib/format';
import { ApiError } from '@marketly/web-shared/api';
import { Avatar, Badge, Button, Icon, Price, Stars, Stars5, type IconName, type Tone } from '@marketly/web-shared/ui';
import {
  fmtDate, productCrumbs, productHref, useCartButton, useCatalogProduct, useCategories, usePurchaseBox, useRatingSummary,
  type CatalogProduct, type MediaRef, type PurchaseBox, type RatingSummary,
} from './product';
import type { ApiReview, ReviewPhoto } from './reviews';

/* ---------------- Keyword search ---------------- */

const STOP = new Set(
  'a an and are as at be but by can do does for from has have how i if in into is it its me my no not of on or so that the their them they this to was what when where which who will with would you your'.split(' '),
);

/** Significant words of a search ("does it work in cold weather" -> work, cold, weather). */
export function tokens(query: string): string[] {
  const words = query.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? [];
  const sig = words.filter((w) => w.length > 1 && !STOP.has(w));
  return [...new Set(sig.length ? sig : words)];
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A search word matches at the start of a word ("case" finds "cases", not "briefcase"). */
const wordStart = (t: string) => new RegExp(`(?<![\\p{L}\\p{N}])${escape(t)}`, 'iu');

/** How many of the search words a text contains (for "similar questions"). */
export const matchCount = (toks: string[], text: string) => toks.filter((t) => wordStart(t).test(text)).length;

/** Text with the search words marked. */
export function Highlight({ text, toks }: { text: string; toks: string[] }) {
  if (!toks.length) return <>{text}</>;
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(${toks.map(escape).join('|')})`, 'giu');
  const parts = text.split(re);
  return (
    <>
      {parts.map((p, i) =>
        i % 2 ? (
          <mark key={i} className="rv-mark">
            {p}
          </mark>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        ),
      )}
    </>
  );
}

/* ---------------- Photos ---------------- */

const FILL = { width: '100%', height: '100%', objectFit: 'cover' } as const;

/** Image tile (.imgph) showing an API photo; the icon placeholder when there is none. */
export function Photo({ media, icon = 'image', className, alt }: { media?: Pick<MediaRef, 'url' | 'alt'> | null; icon?: IconName; className?: string; alt?: string }) {
  return (
    <div className={cx('imgph tint-1', className)}>
      {media ? <img src={media.url} alt={alt ?? media.alt ?? ''} style={FILL} loading="lazy" /> : <Icon name={icon} />}
    </div>
  );
}

/* ---------------- Product context of the sub-pages ---------------- */

/** Product, featured offer, rating summary and category tree for a product sub-page. */
export function useProductContext(id: string) {
  const product = useCatalogProduct(id);
  const box = usePurchaseBox(id);
  const summary = useRatingSummary(id);
  const categories = useCategories();
  return {
    product: product.data,
    box: box.data,
    summary: summary.data,
    crumbs: productCrumbs(product.data, categories.data),
    loading: product.isPending,
    notFound: product.error instanceof ApiError && product.error.status === 404,
    error: product.error ?? null,
    refetch: () => {
      void product.refetch();
      void box.refetch();
      void summary.refetch();
    },
  };
}
export type ProductContext = ReturnType<typeof useProductContext>;

/** Breadcrumbs of a product sub-page: Home › categories › product › this page. */
export const subpageCrumbs = (ctx: ProductContext, slug: string, id: string, last: string) => [
  ...ctx.crumbs,
  { label: ctx.product?.title ?? 'Product', to: productHref(slug, id) },
  { label: last },
];

/** Product header of a product sub-page: photo, name, rating, featured offer, actions. */
export function ProductSummary({ product, box, summary, slug, id }: { product?: CatalogProduct; box?: PurchaseBox; summary?: RatingSummary; slug: string; id: string }) {
  const cart = useCartButton('product_page');
  if (!product) {
    return (
      <div className="card pad shop-mini rv-prod" aria-busy="true">
        <span className="sk sk-thumb" />
        <div className="sk-lines grow">
          <span className="sk sk-line" />
          <span className="sk sk-line short" />
        </div>
      </div>
    );
  }
  const offer = box?.selected;
  const added = !!offer && cart.added === offer.offerId;
  return (
    <div className="card pad shop-mini rv-prod">
      <Photo media={box?.product.image ?? product.images[0]} />
      <div className="stack gap-1 grow">
        <Link to={productHref(slug, id)} className="strong link-plain rv-prod-name">
          {product.title}
        </Link>
        <span className="row gap-3">
          {summary?.hasReviews && summary.average != null && <Stars rating={summary.average} count={summary.ratingCount} />}
          {offer && <Price amount={dollars(offer.price)} was={offer.compareAt ? dollars(offer.compareAt.amount) : null} noOff />}
        </span>
        {offer && (
          <span className="xs muted no-phone">
            {box?.selectedBy === 'only_offer' ? 'Only offer' : 'Featured offer'} from {offer.seller.name} · {offer.delivery.label}
          </span>
        )}
        {cart.error && <span className="error-text xs">{cart.error.text}</span>}
      </div>
      <div className="row gap-2 no-phone rv-prod-actions">
        <Button variant="secondary" size="sm" icon="arrow-left" to={productHref(slug, id)}>
          Back to product
        </Button>
        {offer && (
          <Button size="sm" icon={added ? 'check' : 'shopping-cart'} disabled={cart.pending === offer.offerId} onClick={() => cart.run(offer.offerId, 1, product.title)}>
            {added ? 'Added to cart' : 'Add to cart'}
          </Button>
        )}
      </div>
    </div>
  );
}

/** Phone action bar (replaces the tab bar on the product sub-pages). */
export function SummaryActionBar({ box, title }: { box?: PurchaseBox; title?: string }) {
  const cart = useCartButton('product_page');
  const offer = box?.selected;
  if (!offer) return null;
  const added = cart.added === offer.offerId;
  return (
    <>
      <div className="stack gap-0 none">
        <Price amount={dollars(offer.price)} was={offer.compareAt ? dollars(offer.compareAt.amount) : null} noOff />
        <span className="xs muted">{cart.error ? cart.error.text : offer.delivery.free ? offer.delivery.label : `+ ${formatMoney(offer.delivery.shippingCost)} shipping`}</span>
      </div>
      <span className="grow" />
      <Button size="sm" disabled={cart.pending === offer.offerId} onClick={() => cart.run(offer.offerId, 1, title ?? 'this item')}>
        {added ? 'Added to cart' : 'Add to cart'}
      </Button>
    </>
  );
}

/* ---------------- Load errors ---------------- */

/** A failed read: the server's message and Try again. */
export function LoadError({ error, onRetry, title = 'We couldn’t load this page' }: { error: unknown; onRetry: () => void; title?: ReactNode }) {
  return <SharedLoadError error={error} onRetry={onRetry} title={title} />;
}

/** Skeleton of a list of text rows (reviews, questions). */
export function ListSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="sk-list" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="sk-row">
          <span className="sk sk-thumb" />
          <div className="sk-lines">
            <span className="sk sk-line" />
            <span className="sk sk-line short" />
          </div>
        </div>
      ))}
    </div>
  );
}

/* ---------------- Reviews ---------------- */

export const REPLY_ROLE: Record<'official' | 'seller', { tone: Tone; icon: IconName; label: string }> = {
  official: { tone: 'brand', icon: 'badge-check', label: 'Official Store' },
  seller: { tone: 'info', icon: 'store', label: 'Seller' },
};

/** "Verified Purchase" for reviewers who bought the item on Marketly. */
export function ReviewSource({ r }: { r: ApiReview }) {
  return r.author.verifiedPurchase ? (
    <Badge tone="success" icon="circle-check">
      Verified Purchase
    </Badge>
  ) : null;
}

export function reviewMeta(r: ApiReview) {
  return [`Reviewed ${fmtDate(r.reviewedAt)}`, r.variantLabel, r.soldBy?.name && `Sold by ${r.soldBy.name}`].filter(Boolean).join(' · ');
}

/** Current helpful state of a review: the server's, or the viewer's vote made on this page. */
export interface VoteState {
  voted: boolean;
  count: number;
}

interface ReviewCardProps {
  r: ApiReview;
  toks: string[];
  vote: VoteState;
  reported: boolean;
  onHelpful: () => void;
  onReport: () => void;
  onPhoto: (p: ReviewPhoto) => void;
}

export function ReviewCard({ r, toks, vote, reported, onHelpful, onReport, onPhoto }: ReviewCardProps) {
  const name = r.author.displayName;
  return (
    <article className="shop-rev" id={`review-${r.id}`}>
      <div className="row gap-2">
        <Avatar name={name} />
        <span className="small strong">{name}</span>
        <ReviewSource r={r} />
      </div>
      <div className="row gap-2">
        <Stars5 rating={r.rating} size="md" />
        <h3 className="h4">
          <Highlight text={r.headline} toks={toks} />
        </h3>
      </div>
      <span className="xs muted">{reviewMeta(r)}</span>
      <p className="small">
        <Highlight text={r.text} toks={toks} />
      </p>
      {r.media.length > 0 && (
        <div className="row gap-2 rv-thumbs" role="group" aria-label={`Photos from ${name}’s review`}>
          {r.media.map((m, i) => (
            <button
              key={m.id}
              type="button"
              className="rv-ph"
              aria-label={`Open photo ${i + 1} of ${r.media.length}${m.alt ? `: ${m.alt}` : ''}`}
              onClick={() => onPhoto({ id: m.id, url: m.url, alt: m.alt ?? '', review: r, n: i + 1 })}
            >
              <Photo media={m} />
            </button>
          ))}
        </div>
      )}
      {r.response && <Reply response={r.response} />}
      <ReviewActions vote={vote} reported={reported} onHelpful={onHelpful} onReport={onReport} />
    </article>
  );
}

export function Reply({ response }: { response: NonNullable<ApiReview['response']> }) {
  const role = REPLY_ROLE[response.fromKind === 'official_store' ? 'official' : 'seller'];
  return (
    <div className="shop-reply">
      <span className="row gap-2">
        <Badge tone={role.tone} icon={role.icon}>
          {role.label}
        </Badge>
        <span className="xs strong">Response from {response.fromName}</span>
        {response.publishedAt && <span className="xs muted">· {fmtDate(response.publishedAt)}</span>}
      </span>
      <span>{response.text}</span>
    </div>
  );
}

/** Helpful (one vote per review) and Report. */
export function ReviewActions({ vote, reported, onHelpful, onReport }: { vote: VoteState; reported: boolean; onHelpful: () => void; onReport: () => void }) {
  return (
    <div className="row gap-2">
      <Button variant="ghost" size="sm" icon={vote.voted ? 'check' : 'thumbs-up'} aria-pressed={vote.voted} onClick={vote.voted ? undefined : onHelpful} className={cx(vote.voted && 'is-active')}>
        Helpful ({vote.count})
      </Button>
      <Button variant="ghost" size="sm" icon="flag" aria-disabled={reported || undefined} onClick={reported ? undefined : onReport}>
        {reported ? 'Reported' : 'Report'}
      </Button>
      {vote.voted && <span className="xs muted">Thanks for your feedback</span>}
    </div>
  );
}
