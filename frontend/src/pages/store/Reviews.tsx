import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type TouchEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useSession } from '@/app/session';
import { StoreLayout } from '@/layouts';
import { ApiError, errorMessage } from '@marketly/web-shared/api';
import { cx } from '@marketly/web-shared/lib/cx';
import { num } from '@marketly/web-shared/lib/format';
import { useIsPhone } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import {
  Alert, Avatar, Breadcrumbs, Button, Chip, Dialog, EmptyState, Field, Icon, IconButton, Pager, Radio, SearchInput, Select, Stars5, Textarea, announce,
} from '@marketly/web-shared/ui';
import NotFound from './NotFound';
import { fmtDate, productHref, useProductParams, useSignInHref, variantName } from './data/product';
import {
  REPORT_REASONS, REVIEW_SORTS, useHelpfulVote, useReport, useReviewFeed, useReviewPage, useReviewPhotos,
  type ApiReview, type ReportReason, type ReviewFilters, type ReviewPhoto, type ReviewSort,
} from './data/reviews';
import { useDebounced } from './data/questions';
import {
  ListSkeleton, LoadError, Photo, ProductSummary, reviewMeta, ReviewActions, ReviewCard, ReviewSource, subpageCrumbs, SummaryActionBar, tokens,
  useProductContext, type VoteState,
} from './data/review-parts';
import './Reviews.css';

// Product reviews (no design file: designed in React from the design system, following
// reports/Best ecommerce site UX patterns.md, "Reviews and Q&A").
//   view ""              = all reviews: summary + live histogram, photos, filters, list
//   view "photos"        = review photos viewer (&photo=<id> picks the photo)
//   view "report-review" = Report review dialog (&review=<id> picks the review)
// ?q=<words> starts the list with a keyword search (linked from Questions and answers). The search runs
// on the server (q: headline, text, reviewer name); matches are highlighted here. There is no AI summary
// (the server is offline), so "Customers say" is hidden.

type View = 'photos' | 'report-review';

const PAGE = 10;

export default function Reviews() {
  const { slug, id } = useProductParams();
  const [params, setParams] = useSearchParams();
  const view = (params.get('view') ?? '') as View | '';
  const isPhone = useIsPhone();
  const navigate = useNavigate();
  const signIn = useSignInHref();
  const { signedIn } = useSession();
  const ctx = useProductContext(id);
  const summary = ctx.summary;
  const product = ctx.product;

  // Filters and sort
  const [star, setStar] = useState<number | null>(null);
  const [verified, setVerified] = useState(false);
  const [withPhotos, setWithPhotos] = useState(false);
  const [variant, setVariant] = useState<string | null>(null);
  const [query, setQuery] = useState(() => params.get('q') ?? '');
  const [sort, setSort] = useState<ReviewSort>('helpful');
  const [page, setPage] = useState(1);
  const listTop = useRef<HTMLHeadingElement>(null);

  // Votes and reports made on this page (the server's viewerVotedHelpful / viewerReported otherwise)
  const vote = useHelpfulVote();
  const [votes, setVotes] = useState<Record<string, VoteState>>({});
  const [reported, setReported] = useState<Record<string, boolean>>({});
  const voteOf = (r: ApiReview): VoteState => votes[r.id] ?? { voted: !!r.viewerVotedHelpful, count: r.helpfulCount };

  const search = useDebounced(query.trim());
  const toks = useMemo(() => tokens(search), [search]);
  const searching = search.length > 0;
  const filters: ReviewFilters = { rating: star, verifiedOnly: verified, withPhotos, variantId: variant, q: search, sort };
  const hasReviews = summary?.hasReviews ?? true;

  // Website pages by page number; the phone app by cursor.
  const paged = useReviewPage(id, filters, page, PAGE, hasReviews && !isPhone);
  const feed = useReviewFeed(id, filters, PAGE, hasReviews && isPhone);
  const list = isPhone ? feed : paged;

  let visible: ApiReview[] = [];
  let total: number | null = null;
  let pages = 1;
  let current = 1;
  let hasMore = false;
  let loadMore = () => undefined as unknown;
  if (isPhone) {
    visible = feed.data?.pages.flatMap((p) => p.items) ?? [];
    hasMore = !!feed.hasNextPage;
    loadMore = () => feed.fetchNextPage();
  } else {
    visible = paged.data?.items ?? [];
    total = paged.data?.total ?? visible.length;
    pages = Math.max(1, paged.data?.totalPages ?? 1);
    current = Math.min(page, pages);
  }
  const anyFilter = star !== null || verified || withPhotos || variant !== null || searching;
  // The phone feed has no total: without filters it is every written review.
  if (total === null && !anyFilter && summary) total = summary.writtenCount;
  const from = isPhone ? 1 : (current - 1) * PAGE + 1;
  const to = from + visible.length - 1;

  // Any change to filters or sort starts the list again from the top.
  const reset = () => setPage(1);
  const apply =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      set(v);
      reset();
    };
  const clearAll = () => {
    setStar(null);
    setVerified(false);
    setWithPhotos(false);
    setVariant(null);
    setQuery('');
    reset();
  };

  // Views carried in the URL: ?view=photos&photo=<id>, ?view=report-review&review=<id>
  const openView = (v: View, extra: Record<string, string>, replace = false) =>
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        p.set('view', v);
        for (const [k, val] of Object.entries(extra)) p.set(k, val);
        return p;
      },
      { preventScrollReset: true, replace },
    );
  const closeView = () =>
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        ['view', 'photo', 'review'].forEach((k) => p.delete(k));
        return p;
      },
      { preventScrollReset: true },
    );

  const photosQ = useReviewPhotos(id, (summary?.withPhotos ?? 0) > 0);
  const photos = photosQ.data ?? [];
  const photoIdx = Math.max(0, photos.findIndex((p) => p.id === params.get('photo')));
  const openPhoto = (p: Pick<ReviewPhoto, 'id'>) => openView('photos', { photo: p.id });

  const reviewId = params.get('review');
  const reportTarget = reviewId ? ([...visible, ...(paged.data?.items ?? []), ...photos.map((p) => p.review)].find((r) => r.id === reviewId) ?? null) : null;
  const openReport = (r: ApiReview) => {
    if (r.viewerReported) return;
    if (!signedIn) {
      const next = href('store/reviews', 'report-review', { slug, id }, { review: r.id });
      navigate(signIn(next));
      return;
    }
    openView('report-review', { review: r.id });
  };

  const helpful = (r: ApiReview) => {
    if (!signedIn) {
      navigate(signIn());
      return;
    }
    const prev = voteOf(r);
    setVotes((m) => ({ ...m, [r.id]: { voted: true, count: prev.count + 1 } }));
    vote.mutate(
      { targetType: 'product_review', targetId: r.id, helpful: true },
      {
        onSuccess: (res) => {
          setVotes((m) => ({ ...m, [r.id]: { voted: true, count: res.helpfulCount } }));
          announce(`Thanks. You marked ${r.author.displayName}’s review as helpful.`);
        },
        onError: (e) => {
          setVotes((m) => ({ ...m, [r.id]: prev }));
          announce(errorMessage(e));
        },
      },
    );
  };

  const goPage = (p: number) => {
    setPage(p);
    listTop.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };

  if (ctx.notFound) return <NotFound />;

  const plural = (n: number) => `review${n === 1 ? '' : 's'}`;
  const rating = summary?.average ?? 0;
  const variants = (product?.variants ?? []).filter((v) => variantName(v));

  return (
    <StoreLayout
      nav="categories"
      appbar={{ title: summary ? `Reviews (${num(summary.writtenCount)})` : 'Reviews', back: productHref(slug, id) }}
      actionBar={<SummaryActionBar box={ctx.box} title={product?.title} />}
    >
      <div className="container page gap-5">
        <Breadcrumbs items={subpageCrumbs(ctx, slug, id, 'Reviews')} />
        {ctx.error ? (
          <LoadError error={ctx.error} onRetry={ctx.refetch} title="We couldn’t load this product" />
        ) : (
          <>
            <ProductSummary product={product} box={ctx.box} summary={summary} slug={slug} id={id} />

            <div className="shop-two rv-layout">
              {/* Summary and histogram */}
              <aside className="stack gap-4 rv-side" aria-labelledby="rv-h">
                <h1 className="h2" id="rv-h">
                  Customer reviews
                </h1>
                {!summary ? (
                  <ListSkeleton rows={2} />
                ) : summary.hasReviews ? (
                  <>
                    <div className="row gap-3 base">
                      <span className="display d-xl">{rating.toFixed(1)}</span>
                      <span className="stack gap-1">
                        <Stars5 rating={rating} className="u-fs-18" />
                        <span className="small sub">
                          {num(summary.ratingCount)} ratings · {num(summary.writtenCount)} written reviews
                        </span>
                      </span>
                    </div>
                    <div className="stack gap-2">
                      <div className="rv-hist" role="group" aria-label="Filter by star rating">
                        {summary.distribution.map(({ stars: s, pct }) => {
                          const on = star === s;
                          const label = `${s} star${s === 1 ? '' : 's'}`;
                          return (
                            <button
                              key={s}
                              type="button"
                              className={cx('rv-bar', on && 'is-active', star !== null && !on && 'is-dim')}
                              aria-pressed={on}
                              aria-label={`${label}, ${pct}%, filter`}
                              onClick={() => apply(setStar)(on ? null : s)}
                            >
                              <span className="lbl">{label}</span>
                              <span className="meter" aria-hidden="true">
                                <i style={{ width: `${pct}%` } as CSSProperties} />
                              </span>
                              <span className="pct">{pct}%</span>
                            </button>
                          );
                        })}
                      </div>
                      <p className="xs muted">Select a bar to see only those reviews. Shares are of all {num(summary.ratingCount)} ratings, including ratings without a written review.</p>
                    </div>
                  </>
                ) : (
                  <p className="small sub">No reviews yet. We don’t show a star rating until customers who bought this item have reviewed it.</p>
                )}
                <p className="xs muted">
                  <b>Verified Purchase</b> means the reviewer bought this item on Marketly. Feedback about a seller’s shipping and service is on{' '}
                  <Link to={ctx.box?.selected && !ctx.box.selected.seller.official && ctx.box.selected.seller.storeSlug ? href('store/seller', '', { slug: ctx.box.selected.seller.storeSlug }) : href('store/official')} className="link-inline">
                    each seller’s page
                  </Link>
                  .
                </p>
                <Button variant="secondary" icon="pencil-line" to={href('account/review')}>
                  Write a review
                </Button>
              </aside>

              <div className="stack gap-5 rv-main">
                {/* Photo strip */}
                {photos.length > 0 && (
                  <section className="stack gap-3" aria-labelledby="rv-ph-h">
                    <div className="row between base">
                      <h2 className="h4" id="rv-ph-h">
                        Photos from reviews <span className="sub">({photos.length})</span>
                      </h2>
                      <button type="button" className="btn btn-link small" onClick={() => openPhoto(photos[0])}>
                        See all photos
                      </button>
                    </div>
                    <div className="hscroll gap-2 rv-strip" role="group" aria-label="Review photos">
                      {photos.map((p, i) => (
                        <button
                          key={p.id}
                          type="button"
                          className="rv-ph"
                          aria-label={`Photo ${i + 1} of ${photos.length}: ${p.alt}, from ${p.review.author.displayName}’s review`}
                          onClick={() => openPhoto(p)}
                        >
                          <Photo media={p} />
                        </button>
                      ))}
                    </div>
                  </section>
                )}

                {/* Search, filters, sort, list */}
                <section className="stack gap-3" aria-labelledby="rv-list-h">
                  <h2 className="h3 rv-anchor" id="rv-list-h" ref={listTop}>
                    All reviews
                  </h2>
                  {summary && !summary.hasReviews ? (
                    <div className="card">
                      <EmptyState
                        icon="message-square-text"
                        title="Be the first to review after you buy it"
                        action={
                          <Button variant="secondary" size="sm" to={href('store/questions', '', { slug, id })}>
                            Ask a question
                          </Button>
                        }
                      >
                        Only verified purchases can review. We’ll ask you for a review a few days after delivery.
                      </EmptyState>
                    </div>
                  ) : (
                    <>
                      <form className="toolbar" role="search" aria-label="Reviews" onSubmit={(e: FormEvent) => e.preventDefault()}>
                        <SearchInput id="rv-q" label="Search reviews" placeholder="Search reviews, e.g. battery or case" value={query} onChange={apply(setQuery)} />
                        <span className="shop-sort">
                          <label className="small sub nowrap" htmlFor="rv-sort">
                            Sort by
                          </label>
                          <Select id="rv-sort" options={REVIEW_SORTS} value={sort} onChange={(e) => apply(setSort)(e.target.value as ReviewSort)} />
                        </span>
                      </form>
                      <div className="hscroll gap-2" role="group" aria-label="Filter reviews">
                        <Chip icon="circle-check" active={verified} onClick={() => apply(setVerified)(!verified)}>
                          Verified purchase
                        </Chip>
                        <Chip icon="camera" active={withPhotos} onClick={() => apply(setWithPhotos)(!withPhotos)}>
                          With photos ({num(summary?.withPhotos ?? 0)})
                        </Chip>
                        {variants.length > 1 && (
                          <>
                            <span className="rv-sep" aria-hidden="true" />
                            {variants.map((v) => {
                              const img = v.images?.[0];
                              return (
                                <Chip key={v.id} active={variant === v.id} onClick={() => apply(setVariant)(variant === v.id ? null : v.id)}>
                                  <span
                                    className="rv-swatch"
                                    aria-hidden="true"
                                    style={img ? ({ backgroundImage: `url("${img.url}")`, backgroundSize: 'cover', backgroundPosition: 'center' } as CSSProperties) : undefined}
                                  />
                                  <span className="sr-only">{Object.keys(v.options)[0] ?? 'Option'}: </span>
                                  {variantName(v)}
                                </Chip>
                              );
                            })}
                          </>
                        )}
                      </div>

                      {anyFilter && (
                        <div className="shop-active">
                          {star !== null && (
                            <Chip removable onClick={() => apply(setStar)(null)}>
                              <span className="sr-only">Remove filter: </span>
                              {star} star{star === 1 ? '' : 's'}
                            </Chip>
                          )}
                          {searching && (
                            <Chip removable onClick={() => apply(setQuery)('')}>
                              <span className="sr-only">Clear search: </span>“{query.trim()}”
                            </Chip>
                          )}
                          <button type="button" className="btn btn-link small" onClick={clearAll}>
                            Clear all
                          </button>
                        </div>
                      )}

                      {list.error ? (
                        <LoadError error={list.error} onRetry={() => void list.refetch()} title="We couldn’t load the reviews" />
                      ) : !list.data ? (
                        <ListSkeleton rows={4} />
                      ) : (
                        <>
                          <p className="small sub" role="status">
                            {visible.length === 0
                              ? 'No reviews match'
                              : total === null
                                ? `Showing ${visible.length} ${plural(visible.length)}`
                                : isPhone
                                  ? `Showing ${visible.length} of ${total} ${plural(total)}`
                                  : `Showing ${from}–${to} of ${total} ${plural(total)}`}
                            {visible.length > 0 && (anyFilter ? ' that match your filters' : ` · ${REVIEW_SORTS.find((s) => s.value === sort)!.label.toLowerCase()} first`)}
                          </p>

                          {visible.length > 0 ? (
                            <div className="stack gap-0">
                              {visible.map((r) => (
                                <ReviewCard key={r.id} r={r} toks={toks} vote={voteOf(r)} reported={!!reported[r.id] || !!r.viewerReported} onHelpful={() => helpful(r)} onReport={() => openReport(r)} onPhoto={openPhoto} />
                              ))}
                            </div>
                          ) : (
                            <div className="card">
                              <EmptyState
                                icon="search-x"
                                title="No reviews match these filters"
                                action={
                                  <Button variant="secondary" size="sm" onClick={clearAll}>
                                    Clear all filters
                                  </Button>
                                }
                              >
                                Try removing a filter or searching for a different word. You can also ask other customers in{' '}
                                <Link to={href('store/questions', '', { slug, id })} className="link-inline">
                                  Questions and answers
                                </Link>
                                .
                              </EmptyState>
                            </div>
                          )}

                          {/* Website: numbered pages. Phone app: Load more (not infinite scroll). */}
                          {!isPhone && pages > 1 && <Pager only="website" page={current} total={pages} onPage={goPage} />}
                          {isPhone && hasMore && (
                            <div className="only-phone">
                              <Button variant="secondary" block disabled={feed.isFetchingNextPage} onClick={() => void loadMore()}>
                                Load more reviews
                              </Button>
                            </div>
                          )}
                        </>
                      )}
                    </>
                  )}
                </section>
              </div>
            </div>
          </>
        )}
      </div>

      {photos.length > 0 && (
        <PhotoViewer
          photos={photos}
          open={view === 'photos'}
          index={photoIdx}
          onIndex={(i) => openView('photos', { photo: photos[i].id }, true)}
          onClose={closeView}
          voteOf={voteOf}
          reported={reported}
          onHelpful={helpful}
          onReport={openReport}
        />
      )}
      <ReportDialog
        key={reviewId ?? 'none'}
        open={view === 'report-review' && !!reviewId}
        review={reportTarget}
        reviewId={reviewId}
        onClose={closeView}
        onReported={(rid) => setReported((m) => ({ ...m, [rid]: true }))}
        onSignIn={() => navigate(signIn())}
        signedIn={signedIn}
      />
    </StoreLayout>
  );
}

/* ---------------- Photos viewer ---------------- */

interface PhotoViewerProps {
  photos: ReviewPhoto[];
  open: boolean;
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
  voteOf: (r: ApiReview) => VoteState;
  reported: Record<string, boolean>;
  onHelpful: (r: ApiReview) => void;
  onReport: (r: ApiReview) => void;
}

/** Full-screen (phone) / large (website) gallery of every review photo with its review. */
function PhotoViewer({ photos, open, index, onIndex, onClose, voteOf, reported, onHelpful, onReport }: PhotoViewerProps) {
  const n = photos.length;
  const photo = photos[Math.min(index, n - 1)];
  const r = photo.review;
  const go = (d: number) => onIndex((index + d + n) % n);
  const goRef = useRef(go);
  goRef.current = go;
  const touchX = useRef<number | null>(null);
  const strip = useRef<HTMLDivElement>(null);

  // ← / → move through the photos (Esc is handled by the dialog).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        goRef.current(e.key === 'ArrowLeft' ? -1 : 1);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  // Keep the current thumbnail in view.
  useEffect(() => {
    if (!open) return;
    strip.current?.querySelector<HTMLElement>('[aria-current="true"]')?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [open, index]);

  // Swipe on touch screens.
  const onTouchStart = (e: TouchEvent) => {
    touchX.current = e.touches[0].clientX;
  };
  const onTouchEnd = (e: TouchEvent) => {
    if (touchX.current === null) return;
    const dx = e.changedTouches[0].clientX - touchX.current;
    touchX.current = null;
    if (Math.abs(dx) > 40) go(dx < 0 ? 1 : -1);
  };

  return (
    <Dialog open={open} onClose={onClose} title="Review photos" size="lg" className="rv-viewer" bodyClassName="rv-viewer-body">
      <div className="rv-stage" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
        <Photo media={photo} alt={photo.alt} />
        <span className="rv-count">
          <span className="badge t-solid" aria-live="polite">
            <span className="sr-only">Photo </span>
            {index + 1} / {n}
          </span>
        </span>
        {n > 1 && (
          <>
            <IconButton icon="chevron-left" label="Previous photo" className="rv-nav prev" onClick={() => go(-1)} />
            <IconButton icon="chevron-right" label="Next photo" className="rv-nav next" onClick={() => go(1)} />
          </>
        )}
      </div>
      <div className="rv-caption stack gap-2">
        <div className="row gap-2">
          <Avatar name={r.author.displayName} />
          <span className="small strong">{r.author.displayName}</span>
          <ReviewSource r={r} />
        </div>
        <div className="row gap-2">
          <Stars5 rating={r.rating} size="md" />
          <h3 className="h4">{r.headline}</h3>
        </div>
        <span className="xs muted">{reviewMeta(r)}</span>
        <p className="small">{r.text}</p>
        <p className="xs muted">
          <Icon name="image" className="ic-sm" /> Photo {photo.n} of {r.media.length} in this review{photo.alt ? `: ${photo.alt}` : ''}
        </p>
        <ReviewActions vote={voteOf(r)} reported={!!reported[r.id] || !!r.viewerReported} onHelpful={() => onHelpful(r)} onReport={() => onReport(r)} />
      </div>
      <div className="hscroll gap-2 rv-film" role="group" aria-label="All review photos" ref={strip}>
        {photos.map((p, i) => (
          <button
            key={p.id}
            type="button"
            className={cx('rv-ph', i === index && 'is-active')}
            aria-current={i === index ? 'true' : undefined}
            aria-label={`Photo ${i + 1} of ${n}: ${p.alt}`}
            onClick={() => onIndex(i)}
          >
            <Photo media={p} />
          </button>
        ))}
      </div>
    </Dialog>
  );
}

/* ---------------- Report review ---------------- */

interface ReportDialogProps {
  open: boolean;
  /** The review, when it is loaded on this page (shown as a quote). */
  review: ApiReview | null;
  reviewId: string | null;
  signedIn: boolean;
  onClose: () => void;
  onReported: (reviewId: string) => void;
  onSignIn: () => void;
}

function ReportDialog({ open, review, reviewId, signedIn, onClose, onReported, onSignIn }: ReportDialogProps) {
  const report = useReport();
  const [reason, setReason] = useState<ReportReason | ''>('');
  const [details, setDetails] = useState('');
  const [errors, setErrors] = useState<{ reason?: string; details?: string; form?: string }>({});
  const [done, setDone] = useState<'' | 'sent' | 'already'>('');

  // Fresh form each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setReason('');
    setDetails('');
    setErrors({});
    setDone('');
  }, [open]);

  const submit = () => {
    if (!signedIn) return onSignIn();
    const e: typeof errors = {};
    if (!reason) e.reason = 'Choose a reason for your report.';
    if (reason === 'other' && !details.trim()) e.details = 'Tell us what’s wrong with this review.';
    setErrors(e);
    if (e.reason || e.details || !reviewId || !reason) return;
    const api = REPORT_REASONS.find((o) => o.id === reason)!.api;
    report.mutate(
      { targetType: 'product_review', targetId: reviewId, reason: api, note: details.trim() || undefined },
      {
        onSuccess: () => {
          onReported(reviewId);
          setDone('sent');
          announce('Report sent. Thanks for helping keep reviews useful.');
        },
        onError: (err) => {
          if (err instanceof ApiError && err.code === 'ALREADY_REPORTED') {
            onReported(reviewId);
            setDone('already');
            return;
          }
          if (err instanceof ApiError && err.details.reason === 'sign_in_required') return onSignIn();
          if (err instanceof ApiError && err.code === 'VALIDATION_FAILED' && err.fieldErrors.note) return setErrors({ details: err.fieldErrors.note });
          setErrors({ form: errorMessage(err) });
        },
      },
    );
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={done ? 'Report sent' : 'Report this review'}
      foot={
        done ? (
          <Button onClick={onClose}>Done</Button>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={report.isPending}>
              {signedIn ? 'Submit report' : 'Sign in to report'}
            </Button>
          </>
        )
      }
    >
      {done ? (
        <EmptyState icon="circle-check" title={done === 'already' ? 'You’ve already reported this review' : 'Thanks, we’ve received your report'}>
          Our moderation team reviews reports within 2 business days. The review stays visible until then, and we’ll tell you what we decided in Notifications. The reviewer won’t see who reported it.
        </EmptyState>
      ) : (
        <>
          {review && (
            <div className="rv-quote">
              <div className="row gap-2">
                <Stars5 rating={review.rating} size="sm" />
                <span className="small strong">{review.headline}</span>
              </div>
              <span className="xs muted">
                By {review.author.displayName} · {fmtDate(review.reviewedAt)}
              </span>
              <span className="small sub rv-clamp">{review.text}</span>
            </div>
          )}
          {errors.form && <Alert tone="danger">{errors.form}</Alert>}
          <fieldset className="fieldset-reset stack gap-2" aria-describedby={errors.reason ? 'rr-reason-err' : undefined}>
            <legend className="label u-mb-sp-2">Why are you reporting this review?</legend>
            {REPORT_REASONS.map((o) => (
              <Radio
                key={o.id}
                id={`rr-${o.id}`}
                name="rr-reason"
                label={o.label}
                checked={reason === o.id}
                onChange={() => {
                  setReason(o.id);
                  setErrors((x) => ({ ...x, reason: undefined }));
                }}
              />
            ))}
            {errors.reason && (
              <span className="error-text" id="rr-reason-err">
                <Icon name="circle-alert" className="ic-sm" />
                {errors.reason}
              </span>
            )}
          </fieldset>
          <Field label="Details" optional={reason !== 'other'} hint={`${details.length}/500. Don’t include personal information.`} error={errors.details}>
            <Textarea
              id="rr-details"
              rows={3}
              maxLength={500}
              value={details}
              onChange={(e) => {
                setDetails(e.target.value);
                setErrors((x) => ({ ...x, details: undefined }));
              }}
            />
          </Field>
          <p className="xs muted">Reports are for reviews that break the review rules. A review stays up if it is only negative. For a problem with your own order, use order messages.</p>
        </>
      )}
    </Dialog>
  );
}
