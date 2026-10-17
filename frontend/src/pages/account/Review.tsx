import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useSession } from '@/app/session';
import { AccountLayout } from '@/layouts';
import { ApiError, call, errorMessage, useApi, type components, assetPreview, uploadMedia } from '@marketly/web-shared/api';
import { cx } from '@marketly/web-shared/lib/cx';
import { href } from '@marketly/web-shared/routes';
import { Alert, announce, Badge, Breadcrumbs, Button, Card, Checkbox, EmptyState, Field, FileDrop, Icon, IconButton, Img, SegmentedControl, SellerBadge, TextInput, Textarea } from '@marketly/web-shared/ui';
import { date, slugify } from './data/when';

// Design: pages/store/account-review.html (one view): product review (rating, headline, text,
// photos) and separate seller feedback, posted together.
// API: reviews (GET /api/store/reviews/me/review-context/{orderItemId}, POST/PATCH …/me/reviews and
// …/me/feedback, drafts with draft: true), photos through media uploads (purpose review_photo).
// Route params (the design route has none): ?item=<orderItemId> for a product review (+ the package's seller
// feedback); ?order=<orderId>&seller=<sellerId> for seller feedback only. Without either, the first
// delivered purchase waiting for a review opens.

const RATING_WORDS = ['', 'Poor', 'Fair', 'Okay', 'Good', 'Excellent'];
const MAX_HEADLINE = 120;
import { OFFICIAL_STORE_ID } from '@marketly/web-shared/config';

type Context = components['schemas']['reviews.ReviewContext'];

function StarRating({ name, legend, value, onChange, sm, note, hint, error }: { name: string; legend: string; value: number; onChange: (n: number) => void; sm?: boolean; note?: ReactNode; hint?: string; error?: string }) {
  const [hover, setHover] = useState(0);
  const shown = hover || value;
  const hintId = hint || error ? `${name}-1-${error ? 'err' : 'hint'}` : undefined;
  return (
    <fieldset className="acct-stars">
      <legend className="label">{legend}</legend>
      <div className="row gap-1" onMouseLeave={() => setHover(0)}>
        {[1, 2, 3, 4, 5].map((n) => (
          <label key={n} className={cx('acct-star', sm && 'sm', n <= shown && 'on')} htmlFor={`${name}-${n}`} onMouseEnter={() => setHover(n)}>
            <input
              type="radio"
              className="sr-only"
              name={name}
              id={`${name}-${n}`}
              checked={value === n}
              aria-describedby={n === 1 ? hintId : undefined}
              onChange={() => onChange(n)}
              onClick={() => value === n && hint && onChange(0)}
            />
            <Icon name="star" />
            <span className="sr-only">
              {n} star{n > 1 ? 's' : ''}
            </span>
          </label>
        ))}
        {note && <span className="small sub u-ml-6px">{note}</span>}
      </div>
      {error ? (
        <span className="error-text" id={hintId}>
          <Icon name="circle-alert" className="ic-sm" />
          {error}
        </span>
      ) : (
        hint && (
          <span className="hint" id={hintId}>
            {hint}
          </span>
        )
      )}
    </fieldset>
  );
}

interface Photo {
  key: string;
  name: string;
  src: string;
  assetId?: string;
  state: 'uploading' | 'ready' | 'error';
  error?: string;
  local?: boolean;
}

/** VALIDATION_FAILED issues by field (paths are "rating", "headline", "text", "mediaIds", "dispatchRating"…). */
const fieldErrors = (e: unknown): Record<string, string> => (e instanceof ApiError && e.code === 'VALIDATION_FAILED' ? e.fieldErrors : {});

export default function Review() {
  const { api, session } = useApi();
  const { customer } = useSession();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const orderParam = params.get('order');
  const sellerParam = params.get('seller');
  const feedbackOnly = !params.get('item') && !!orderParam && !!sellerParam;

  const pending = useQuery({ queryKey: ['reviews', 'me', 'pending'], queryFn: () => call(api.GET('/api/store/reviews/me/pending')) });
  const itemId = params.get('item') ?? (feedbackOnly ? null : (pending.data?.products[0]?.orderItemId ?? null));
  const ctx = useQuery({
    queryKey: ['reviews', 'me', 'context', itemId],
    queryFn: () => call(api.GET('/api/store/reviews/me/review-context/{orderItemId}', { params: { path: { orderItemId: itemId! } } })),
    enabled: !!itemId,
  });
  // Feedback-only mode: the package from the pending list, and my feedback for it if I already left some.
  const myFeedback = useQuery({
    queryKey: ['reviews', 'me', 'feedback', 'all'],
    queryFn: () => call(api.GET('/api/store/reviews/me/feedback', { params: { query: { limit: 100 } } })),
    enabled: feedbackOnly,
  });
  const pkg = feedbackOnly ? pending.data?.sellerFeedback.find((s) => s.orderId === orderParam && s.sellerId === sellerParam) : undefined;
  const existingFbOnly = feedbackOnly ? myFeedback.data?.items.find((f) => f.feedback.orderId === orderParam && f.feedback.sellerId === sellerParam) : undefined;

  const c: Context | undefined = ctx.data;
  const existingReview = c?.existingReview ?? null;
  const existingFeedback = feedbackOnly ? (existingFbOnly ?? null) : (c?.existingFeedback ?? null);
  const feedbackOpen = feedbackOnly ? !!pkg?.eligible || !!existingFeedback : !!c && (c.feedbackEligible || !!existingFeedback);
  const feedbackEditable = existingFeedback ? existingFeedback.canEdit : feedbackOpen;
  const reviewEditable = !existingReview || existingReview.canEdit;
  const minText = c?.minTextLength ?? 50;
  const maxPhotos = c?.maxPhotos ?? 6;
  const seller = feedbackOnly
    ? pkg
      ? { id: pkg.sellerId, name: pkg.sellerName, official: pkg.ownerType === 'official', slug: null as string | null }
      : existingFeedback
        ? { id: existingFeedback.feedback.sellerId, name: existingFeedback.feedback.sellerName, official: existingFeedback.feedback.sellerId === OFFICIAL_STORE_ID, slug: null as string | null }
        : null
    : c
      ? { id: c.seller.id, name: c.seller.name, official: c.seller.ownerType === 'official', slug: c.seller.slug ?? null }
      : null;
  const orderId = feedbackOnly ? orderParam! : c?.orderId;
  const orderRef = feedbackOnly ? (pkg?.orderRef ?? existingFeedback?.feedback.orderRef ?? '') : (c?.orderRef ?? '');

  const [rating, setRating] = useState(0);
  const [headline, setHeadline] = useState('');
  const [text, setText] = useState('');
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [showName, setShowName] = useState(true);
  const [described, setDescribed] = useState<'yes' | 'no'>('yes');
  const [dispatch, setDispatch] = useState(0);
  const [comm, setComm] = useState(0);
  const [comment, setComment] = useState('');
  const [fbDirty, setFbDirty] = useState(false);
  const [tried, setTried] = useState(false);
  const [draftSaved, setDraftSaved] = useState(false);
  const [photoMsg, setPhotoMsg] = useState('');
  const photosRef = useRef(photos);
  photosRef.current = photos;
  useEffect(() => () => photosRef.current.forEach((ph) => ph.local && URL.revokeObjectURL(ph.src)), []);

  // Prefill from an existing review / feedback once loaded.
  const filled = useRef<string | null>(null);
  const fillKey = `${itemId ?? ''}|${orderParam ?? ''}|${existingReview?.review.id ?? ''}|${existingFeedback?.feedback.id ?? ''}|${ctx.isSuccess || myFeedback.isSuccess}`;
  useEffect(() => {
    if (filled.current === fillKey || (!ctx.isSuccess && !(feedbackOnly && myFeedback.isSuccess))) return;
    filled.current = fillKey;
    if (existingReview) {
      const r = existingReview.review;
      setRating(r.rating);
      setHeadline(r.headline);
      setText(r.text);
      setPhotos(r.media.map((m) => ({ key: m.id, name: m.alt ?? 'Photo', src: m.url, assetId: m.id, state: 'ready' })));
      setShowName(r.author.displayName !== 'Marketly customer'); // the API shows this label when the name is hidden (reviews ANONYMOUS_REVIEWER)
    }
    if (existingFeedback) {
      const d = existingFeedback.feedback.dimensions;
      setDescribed(d.asDescribed ? 'yes' : 'no');
      setDispatch(d.dispatchRating);
      setComm(d.communicationRating ?? 0);
      setComment(existingFeedback.feedback.comment ?? '');
    }
  }, [fillKey, ctx.isSuccess, feedbackOnly, myFeedback.isSuccess, existingReview, existingFeedback]);

  const addPhotos = async (files: File[]) => {
    const images = files.filter((f) => /image\/(jpeg|png|webp)/.test(f.type));
    const room = maxPhotos - photos.length;
    const take = images.slice(0, room);
    setPhotoMsg(images.length > room ? `Only ${maxPhotos} photos fit. We added the first ${room}.` : images.length < files.length ? 'Some files were skipped: use JPG or PNG.' : '');
    const added: Photo[] = take.map((f, i) => ({ key: `${Date.now()}-${i}`, name: f.name, src: URL.createObjectURL(f), state: 'uploading', local: true }));
    setPhotos((ps) => [...ps, ...added]);
    await Promise.all(
      take.map(async (f, i) => {
        const key = added[i]!.key;
        try {
          const asset = await uploadMedia(session, f, 'review_photo', { alt: c ? `Photo of ${c.product.title}` : undefined });
          setPhotos((ps) => ps.map((p) => (p.key === key ? { ...p, assetId: asset.id, state: 'ready', src: assetPreview(asset) || p.src } : p)));
        } catch (e) {
          setPhotos((ps) => ps.map((p) => (p.key === key ? { ...p, state: 'error', error: errorMessage(e) } : p)));
        }
      }),
    );
  };
  const removePhoto = (key: string) =>
    setPhotos((ps) => {
      const ph = ps.find((x) => x.key === key);
      if (ph?.local) URL.revokeObjectURL(ph.src);
      return ps.filter((x) => x.key !== key);
    });

  const submit = useMutation({
    mutationFn: async (draft: boolean) => {
      const mediaIds = photos.filter((p) => p.state === 'ready' && p.assetId).map((p) => p.assetId!);
      if (!feedbackOnly && c && reviewEditable) {
        if (existingReview) {
          await call(api.PATCH('/api/store/reviews/me/reviews/{id}', { params: { path: { id: existingReview.review.id } }, body: { rating, headline: headline.trim(), text: text.trim(), mediaIds, showName, draft } }));
        } else {
          await call(api.POST('/api/store/reviews/me/reviews', { body: { orderItemId: c.orderItemId, rating, headline: headline.trim(), text: text.trim(), mediaIds, showName, draft } }));
        }
      }
      const sendFeedback = feedbackOpen && feedbackEditable && dispatch > 0 && (!existingFeedback || fbDirty || existingFeedback.status === 'draft');
      if (sendFeedback && seller && orderId) {
        const body = { asDescribed: described === 'yes', dispatchRating: dispatch, communicationRating: comm || null, comment: comment.trim() || null, draft };
        if (existingFeedback) await call(api.PATCH('/api/store/reviews/me/feedback/{id}', { params: { path: { id: existingFeedback.feedback.id } }, body }));
        else await call(api.POST('/api/store/reviews/me/feedback', { body: { orderId, sellerId: seller.id, ...body } }));
      }
    },
    onSuccess: (_, draft) => {
      void qc.invalidateQueries({ queryKey: ['reviews'] });
      if (draft) {
        setDraftSaved(true);
        announce('Draft saved');
      } else {
        navigate(href('account/reviews', feedbackOnly ? 'seller-feedback' : ''));
      }
    },
  });

  const server = fieldErrors(submit.error);
  const local = tried
    ? {
        rating: feedbackOnly || rating ? undefined : 'Choose a rating from 1 to 5 stars.',
        headline: feedbackOnly || headline.trim() ? undefined : 'Add a short headline.',
        text: feedbackOnly || text.trim().length >= minText ? undefined : `Write at least ${minText} characters. ${text.trim().length} so far.`,
        dispatch: !feedbackOpen || !feedbackEditable || dispatch ? undefined : 'Rate how fast the seller dispatched your order.',
      }
    : {};
  const errors = {
    rating: local.rating ?? server.rating,
    headline: local.headline ?? server.headline,
    text: local.text ?? server.text,
    photos: server.mediaIds,
    dispatch: local.dispatch ?? server.dispatchRating,
    comment: server.comment,
  };
  const nErr = Object.values(errors).filter(Boolean).length;
  const otherError = submit.isError && !Object.keys(server).length ? submit.error : null;
  const uploading = photos.some((p) => p.state === 'uploading');

  const saveDraft = () => {
    if (!feedbackOnly && !rating) {
      setTried(true);
      return;
    }
    setTried(false);
    submit.mutate(true);
  };
  const post = () => {
    setTried(true);
    const ok = (feedbackOnly || (rating && headline.trim() && text.trim().length >= minText)) && (!feedbackOpen || !feedbackEditable || dispatch);
    if (!ok) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    submit.mutate(false);
  };
  const edited = () => {
    setDraftSaved(false);
    if (submit.isError) submit.reset();
  };

  const canPost = !uploading && !submit.isPending && (feedbackOnly ? feedbackEditable : reviewEditable || feedbackEditable);
  const actions = (
    <>
      <Button variant="ghost" onClick={saveDraft} disabled={!canPost}>
        Save draft
      </Button>
      <Button onClick={post} disabled={!canPost}>
        {submit.isPending ? 'Posting…' : feedbackOnly ? 'Post feedback' : 'Post review'}
      </Button>
    </>
  );

  const loading = (!feedbackOnly && (pending.isPending || (!!itemId && ctx.isPending))) || (feedbackOnly && (pending.isPending || myFeedback.isPending));
  const loadError = ctx.error ?? pending.error ?? myFeedback.error;
  const nothing = !loading && !loadError && (feedbackOnly ? !seller : !itemId);

  const frame = (body: ReactNode) => (
    <AccountLayout active="reviews" title="Write a review">
      <div className="acct-head">
        <div className="stack gap-1">
          <h1 className="h1 acct-h1">Write a review</h1>
          <p className="small sub">Two short parts. Each one appears in a different place.</p>
        </div>
      </div>
      {body}
    </AccountLayout>
  );

  if (loadError) {
    const notFound = loadError instanceof ApiError && (loadError.status === 404 || loadError.code === 'REVIEW_NOT_ELIGIBLE');
    return frame(
      notFound ? (
        <div className="card">
          <EmptyState icon="star" as="h2" title="This item can't be reviewed" action={<Button to={href('account/reviews')}>Reviews and feedback</Button>}>
            {errorMessage(loadError)}
          </EmptyState>
        </div>
      ) : (
        <Alert tone="danger" title="We couldn't load this review">
          {errorMessage(loadError)}{' '}
          <Button variant="ghost" size="sm" onClick={() => void (ctx.isError ? ctx.refetch() : pending.isError ? pending.refetch() : myFeedback.refetch())}>
            Try again
          </Button>
        </Alert>
      ),
    );
  }
  if (nothing) {
    return frame(
      <div className="card">
        <EmptyState icon="star" as="h2" title="Nothing waiting for a review" action={<Button to={href('account/orders')}>Your orders</Button>}>
          When a purchase is delivered, you can review it here or from the order.
        </EmptyState>
      </div>,
    );
  }
  if (loading || !seller) {
    return frame(
      <section className="card pad row gap-4 nowrap top" aria-hidden="true">
        <span className="sk sk-thumb" />
        <span className="sk-lines grow">
          <span className="sk sk-line" />
          <span className="sk sk-line short" />
        </span>
      </section>,
    );
  }

  const productTo = c ? href('store/product', '', { slug: slugify(c.product.title), id: c.product.id }) : '';
  // The storefront link needs the seller's slug (ReviewContext.seller.slug); feedback-only mode has none, so the name isn't linked.
  const sellerTo = seller.official ? href('store/official') : seller.slug ? href('store/seller', '', { slug: seller.slug }) : null;
  const deliveredAt = feedbackOnly ? pkg?.deliveredAt : c?.deliveredAt;
  const guidelines = c?.guidelines ?? ['Describe your own experience with this item.', 'No personal details, links, prices or order numbers.', 'No offers of payment or free items for reviews.', "We don't remove fair negative reviews."];

  return (
    <AccountLayout
      active="reviews"
      title="Write a review"
      actionBar={
        <>
          <Button variant="ghost" onClick={saveDraft} disabled={!canPost}>
            Save draft
          </Button>
          <span className="grow" />
          <Button onClick={post} disabled={!canPost}>
            {feedbackOnly ? 'Post feedback' : 'Post review'}
          </Button>
        </>
      }
    >
      <Breadcrumbs items={[{ label: 'Orders', to: href('account/orders') }, ...(orderRef ? [{ label: orderRef, to: href('account/order', '', { ref: orderRef }) }] : []), { label: 'Write a review' }]} />
      <div className="acct-head">
        <div className="stack gap-1">
          <h1 className="h1 acct-h1">Write a review</h1>
          <p className="small sub">{feedbackOnly ? 'Seller feedback appears on the seller profile.' : 'Two short parts. Each one appears in a different place.'}</p>
        </div>
      </div>
      {nErr > 0 && (
        <Alert tone="danger" title={`Check ${nErr} field${nErr > 1 ? 's' : ''}`}>
          Fix the highlighted fields to post your review.
        </Alert>
      )}
      {otherError && (
        <Alert tone="danger" title="We couldn't post this">
          {otherError instanceof ApiError && otherError.code === 'ALREADY_REVIEWED' ? 'You already reviewed this product. Edit your review from Reviews and feedback.' : errorMessage(otherError)}
        </Alert>
      )}
      {draftSaved && nErr === 0 && <Alert tone="success" title="Draft saved">Finish it any time from Reviews and feedback. Drafts aren't public.</Alert>}
      {existingReview && !existingReview.canEdit && <Alert tone="info" title="You already reviewed this item">This review can't be edited any more.</Alert>}
      <section className="card pad row gap-4 nowrap top">
        <Img icon="package" tint="2" className="thumb" src={c?.product.imageUrl ?? undefined} alt="" />
        <div className="stack gap-1">
          {c ? (
            <Link className="small strong link-plain" to={productTo}>
              {c.product.title}
            </Link>
          ) : (
            <span className="small strong">{pkg?.packageLabel ?? 'Package'}</span>
          )}
          <span className="xs muted">
            {[c?.product.variantLabel?.replace(/^[^:]+:\s*/, ''), deliveredAt ? `Delivered ${date(deliveredAt)}` : null].filter(Boolean).join(' · ')}
            {orderRef && (
              <>
                {' '}· Order <span className="mono">{orderRef}</span>
              </>
            )}
          </span>
          <span className="row gap-2">
            {(feedbackOnly || c?.verifiedPurchase) && (
              <Badge tone="success" icon="badge-check">
                Verified Purchase
              </Badge>
            )}
            <span className="seller-line">
              Sold by{' '}
              {sellerTo ? (
                <Link to={sellerTo}>
                  <b>{seller.name}</b>
                </Link>
              ) : (
                <b>{seller.name}</b>
              )}
              <SellerBadge seller={{ official: seller.official }} compact />
            </span>
          </span>
        </div>
      </section>
      <div className="acct-split">
        <div className="stack gap-4">
          {!feedbackOnly && c && (
            <Card title="1. Product review" sub="About the product itself: quality, comfort, how it works. Shown on the product page for every seller.">
              <StarRating name="rv-prod" legend="Overall rating" value={rating} onChange={(n) => (setRating(n), edited())} note={RATING_WORDS[rating] || undefined} error={errors.rating} />
              <Field label="Headline" error={errors.headline}>
                <TextInput id="rv-head" value={headline} error={!!errors.headline} maxLength={MAX_HEADLINE} disabled={!reviewEditable} onChange={(e) => (setHeadline(e.target.value), edited())} />
              </Field>
              <Field label="Your review" hint={`At least ${minText} characters. ${text.trim().length} so far.`} error={errors.text}>
                <Textarea id="rv-text" value={text} className={cx(errors.text && 'is-error')} disabled={!reviewEditable} onChange={(e) => (setText(e.target.value), edited())} />
              </Field>
              <div className="field">
                <span className="label">
                  Photos <span className="opt">(optional)</span>
                </span>
                {photos.length > 0 && (
                  <div className="row gap-2">
                    {photos.map((ph) => (
                      <span key={ph.key} className="stack gap-1 u-items-center">
                        <Img icon="image" tint="2" className="thumb" src={ph.src} alt={ph.name} />
                        {ph.state === 'uploading' ? (
                          <span className="xs muted">Uploading…</span>
                        ) : ph.state === 'error' ? (
                          <span className="xs t-danger-text" title={ph.error}>
                            Failed
                          </span>
                        ) : null}
                        <IconButton icon="x" size="sm" label={`Remove ${ph.name}`} onClick={() => removePhoto(ph.key)} />
                      </span>
                    ))}
                  </div>
                )}
                {photos.length < maxPhotos && reviewEditable && (
                  <FileDrop
                    title="Add photos of the product"
                    hint={`Up to ${maxPhotos} photos, JPG or PNG${photos.length ? ` · ${maxPhotos - photos.length} left` : ''}`}
                    accept="image/jpeg,image/png,image/webp"
                    onFiles={(f) => void addPhotos(f)}
                  />
                )}
                {(photoMsg || errors.photos || photos.some((p) => p.state === 'error')) && (
                  <span className="hint">{errors.photos ?? (photos.find((p) => p.state === 'error')?.error ? `A photo didn't upload: ${photos.find((p) => p.state === 'error')!.error}` : photoMsg)}</span>
                )}
              </div>
              <Checkbox id="rv-name" label={customer ? `Show my name as ${customer.first} ${customer.last.charAt(0)}.` : 'Show my first name and last initial'} checked={showName} disabled={!reviewEditable} onChange={(e) => (setShowName(e.target.checked), edited())} />
            </Card>
          )}
          {feedbackOpen ? (
            <Card
              title={`${feedbackOnly ? '' : '2. '}Seller feedback for ${seller.name}`}
              titleAs="h3"
              sub="About buying from this seller: accuracy, dispatch and communication. Shown on the seller profile, not the product page."
            >
              {existingFeedback && !existingFeedback.canEdit && <Alert tone="info" title="Feedback already given">You can't change this feedback any more.</Alert>}
              <div className="field">
                <span className="label" id="rv-desc-l">
                  Was the item as described?
                </span>
                <SegmentedControl<'yes' | 'no'>
                  label="Was the item as described?"
                  active={described}
                  onChange={(v) => (setDescribed(v), setFbDirty(true), edited())}
                  items={[
                    { value: 'yes', label: 'Yes' },
                    { value: 'no', label: 'No' },
                  ]}
                />
              </div>
              <StarRating
                name="rv-ship"
                legend="Dispatch speed"
                sm
                value={dispatch}
                onChange={(n) => (setDispatch(n), setFbDirty(true), edited())}
                note={deliveredAt ? `Arrived ${date(deliveredAt)}` : undefined}
                error={errors.dispatch}
              />
              <StarRating name="rv-comm" legend="Communication" sm value={comm} onChange={(n) => (setComm(n), setFbDirty(true), edited())} hint="Leave blank if you didn't contact the seller." />
              <Field label="Comment for the seller" optional error={errors.comment}>
                <Textarea id="rv-seller" placeholder="For example: well packed, arrived early." value={comment} disabled={!feedbackEditable} onChange={(e) => (setComment(e.target.value), setFbDirty(true), edited())} />
              </Field>
            </Card>
          ) : (
            !feedbackOnly &&
            c && (
              <Card title={`2. Seller feedback for ${seller.name}`} titleAs="h3" sub="Shown on the seller profile, not the product page.">
                <p className="small sub">Seller feedback for this package opens once it's delivered, or you already left it.</p>
              </Card>
            )
          )}
          <div className="row between only-desktop">{actions}</div>
        </div>
        <aside>
          <Card title="Product review or seller feedback?" titleAs="h3">
            <div className="stack gap-3 small sub">
              <p>
                <span className="strong u-c-text">Product review</span>: the item. If it broke or doesn't work well, say it here.
              </p>
              <p>
                <span className="strong u-c-text">Seller feedback</span>: the purchase. Late dispatch, poor packing or slow replies go here.
              </p>
              <p>
                Need a refund or repair instead?{' '}
                <Link to={href('help/order-problem')} className="link-inline">
                  Report a problem
                </Link>
                {orderRef && (
                  <>
                    {' '}or{' '}
                    <Link to={href('account/return-new', '', { ref: orderRef })} className="link-inline">
                      return the item
                    </Link>
                  </>
                )}
                .
              </p>
            </div>
          </Card>
          <Card title="Review guidelines" titleAs="h3">
            <ul className="ul small sub stack gap-1">
              {guidelines.map((g) => (
                <li key={g}>{g}</li>
              ))}
            </ul>
            <Link className="small strong" to={href('help/article', '', { slug: 'how-reviews-work' })}>
              Full review rules
            </Link>
          </Card>
          <Alert tone="info" title="You can edit later">
            <span className="strong">Verified Purchase</span> means this review is linked to your recorded order. You can edit or delete it any time from{' '}
            <Link to={href('account/reviews')} className="link-inline">
              Reviews and feedback
            </Link>
            , and we'll tell you if moderation changes it.
          </Alert>
        </aside>
      </div>
    </AccountLayout>
  );
}
