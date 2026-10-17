import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useSession } from '@/app/session';
import { StoreLayout } from '@/layouts';
import { ApiError, errorMessage, renditionUrl } from '@marketly/web-shared/api';
import { cx } from '@marketly/web-shared/lib/cx';
import { dollars, formatMoney, num, percentOff } from '@marketly/web-shared/lib/format';
import { href } from '@marketly/web-shared/routes';
import {
  Alert, Avatar, Badge, Breadcrumbs, Button, Chip, EmptyState, Icon, IconButton, KeyValue, Meter, PhoneCollapse,
  Price, SearchInput, SellerBadge, Stars, Stars5, announce, type IconName,
} from '@marketly/web-shared/ui';
import NotFound from './NotFound';
import { AskSellerDialog } from './data/ask-seller';
import { DeliverToDialog } from './data/deliver-to';
import {
  STOCK_LABEL, STOCK_TONE, categoryTrail, fmtDate, fmtDateTime, orderWithin, productCrumbs, productHref, sellerHref, shipperName,
  useBuyNow, useCartButton, useCatalogProduct, useCategories, useProductParams, usePurchaseBox, useRatingSummary, useRecordView,
  useSignInHref, useSimilarProducts, variantAxis, variantImages, variantName,
  type CatalogProduct, type OfferView, type PurchaseBox, type RatingSummary, type SimilarProduct,
} from './data/product';
import { useDebounced, useQuestionPage, type ApiAnswer } from './data/questions';
import { useHelpfulVote, useReviewPage, type ApiReview, type ReviewFilters } from './data/reviews';
import { LoadError, ListSkeleton, Photo, type VoteState } from './data/review-parts';

/** A product image at one of its two sizes: 'detail' for the gallery, 'thumb' for thumbnails and cards (BACKEND-PRODUCT-IMAGES.md). */
const sized = <M extends { url: string }>(m: M | null | undefined, size: 'detail' | 'thumb'): M | undefined => (m ? { ...m, url: renditionUrl(m, size) ?? m.url } : undefined);

// Design: pages/store/store-product.html
//   view "seller-offer-selected" (+ &offer=<offerId>) = another seller's offer chosen in the buy box
//   view "no-reviews-yet" follows the data: a product without reviews shows the no-reviews state
// REST rather than the ProductPage screen query: the query has no purchase-box choice state (selectedBy,
// featured offer, other-offers cue, unavailable and Official Store states), no viewerReported on reviews
// and selects images without thumbUrl.

const px = 'pdp';

export default function Product() {
  const { id } = useProductParams();
  // A new product (related products) starts with fresh page state.
  return <ProductScreen key={id} />;
}

function ProductScreen() {
  const { slug, id } = useProductParams();
  const [params, setParams] = useSearchParams();
  const offerId = params.get('offer') ?? undefined;
  const [variantId, setVariantId] = useState<string | undefined>(undefined);

  const product = useCatalogProduct(id);
  const box = usePurchaseBox(id, variantId, offerId);
  const summary = useRatingSummary(id);
  const categories = useCategories();

  // Recently viewed (customers and guest sessions), once per product.
  const record = useRecordView();
  const recorded = useRef(false);
  useEffect(() => {
    if (recorded.current || !product.data) return;
    recorded.current = true;
    record.mutate({ productId: id }, { onError: () => undefined });
  }, [product.data, id, record]);

  const setOffer = (o: string | null) =>
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        if (o) {
          p.set('view', 'seller-offer-selected');
          p.set('offer', o);
        } else {
          p.delete('view');
          p.delete('offer');
        }
        return p;
      },
      { preventScrollReset: true },
    );
  const chooseVariant = (v: string) => {
    setVariantId(v);
    // An offer belongs to one variant: a new variant starts from its featured offer.
    if (offerId) setOffer(null);
  };

  if (product.error instanceof ApiError && product.error.status === 404) return <NotFound />;
  if (product.error) {
    return (
      <StoreLayout nav="categories" appbar={{ title: 'Product', back: href('store/home') }}>
        <div className="container page gap-5">
          <LoadError error={product.error} onRetry={() => void product.refetch()} title="We couldn’t load this product" />
        </div>
      </StoreLayout>
    );
  }
  if (!product.data) return <ProductSkeleton />;

  return (
    <ProductPage
      slug={slug}
      id={id}
      product={product.data}
      box={box.data}
      boxError={box.error}
      onRetryBox={() => void box.refetch()}
      summary={summary.data}
      crumbs={productCrumbs(product.data, categories.data)}
      leaf={categoryTrail(categories.data, product.data.categoryId).at(-1)}
      onVariant={chooseVariant}
      onOffer={setOffer}
    />
  );
}

const QA_ROLE: Record<ApiAnswer['label'], { tone: '' | 'brand' | 'info'; icon: IconName; label: string }> = {
  marketly_staff: { tone: 'brand', icon: 'badge-check', label: 'Marketly staff' },
  seller: { tone: 'info', icon: 'store', label: 'Seller' },
  customer: { tone: '', icon: 'user-round', label: 'Customer' },
};

type ReviewFilter = 'all' | 'verified' | 'photos' | 'critical' | 'color' | `star-${number}`;

const toFilters = (f: ReviewFilter, variantId: string | undefined): ReviewFilters => ({
  verifiedOnly: f === 'verified',
  withPhotos: f === 'photos',
  critical: f === 'critical',
  variantId: f === 'color' ? variantId : undefined,
  rating: f.startsWith('star-') ? Number(f.slice(5)) : undefined,
  sort: 'helpful',
});

interface ProductPageProps {
  slug: string;
  id: string;
  product: CatalogProduct;
  box?: PurchaseBox;
  boxError: unknown;
  onRetryBox: () => void;
  summary?: RatingSummary;
  crumbs: Array<{ label: string; to?: string }>;
  leaf?: { name: string; slug: string };
  onVariant: (variantId: string) => void;
  onOffer: (offerId: string | null) => void;
}

function ProductPage({ slug, id, product, box, boxError, onRetryBox, summary, crumbs, leaf, onVariant, onOffer }: ProductPageProps) {
  const navigate = useNavigate();
  const signIn = useSignInHref();
  const { signedIn, cartCount } = useSession();
  const [deliverOpen, setDeliverOpen] = useState(false);
  const [askOpen, setAskOpen] = useState(false);
  const askSeller = () => (signedIn ? setAskOpen(true) : navigate(signIn()));
  const offer = box?.selected ?? null;
  const featured = box?.featured ?? null;
  const isFeatured = box?.selectedBy === 'featured';
  const onlyOffer = box?.selectedBy === 'only_offer';
  const hasReviews = !!summary?.hasReviews;
  const rating = summary?.average ?? 0;

  // Gallery and variant
  const variantId = box?.variantId;
  const variantRow = box?.variants.find((v) => v.variantId === variantId);
  const catalogVariant = product.variants.find((v) => v.id === variantId) ?? product.variants[0];
  const color = variantRow?.label ?? variantName(catalogVariant);
  const axis = variantAxis(catalogVariant) || 'Option';
  const images = variantImages(product, variantId);
  const thumbs = [...(product.video ? [{ kind: 'video' as const, media: product.video }] : []), ...images.map((m) => ({ kind: 'photo' as const, media: m }))];
  const [thumbIdx, setThumbIdx] = useState(product.video ? 1 : 0);
  useEffect(() => setThumbIdx(product.video ? 1 : 0), [variantId, product.video]);
  const thumb = thumbs[Math.min(thumbIdx, thumbs.length - 1)];
  const photoNo = thumbs.slice(0, thumbIdx + 1).filter((t) => t.kind === 'photo').length;

  // Quantity, add to cart, Buy now
  const [qty, setQty] = useState(1);
  const qtyOptions = box?.quantityOptions?.length ? box.quantityOptions : Array.from({ length: Math.max(1, offer?.availability.maxPerOrder ?? 1) }, (_, i) => i + 1);
  const quantity = Math.min(qty, qtyOptions.at(-1) ?? 1);
  const cart = useCartButton('product_page');
  const buyNow = useBuyNow();
  const added = !!offer && cart.added === offer.offerId;
  const addToCart = () => offer && cart.run(offer.offerId, quantity, `${quantity} × ${product.title} from ${offer.seller.name}`);
  const buy = () => offer && buyNow.mutate({ offerId: offer.offerId, quantity }, { onError: (e) => announce(errorMessage(e)) });
  const addLabel = added ? 'Added to cart' : 'Add to cart';
  const actionError = (offer && cart.error?.offerId === offer.offerId ? cart.error.text : null) ?? (buyNow.error ? errorMessage(buyNow.error) : null);

  // Reviews (first three, filtered on the server)
  const [filter, setFilter] = useState<ReviewFilter>('all');
  const reviews = useReviewPage(id, toFilters(filter, variantId), 1, 3, hasReviews);
  const vote = useHelpfulVote();
  const [votes, setVotes] = useState<Record<string, VoteState>>({});
  const voteOf = (r: ApiReview): VoteState => votes[r.id] ?? { voted: !!r.viewerVotedHelpful, count: r.helpfulCount };
  const helpful = (r: ApiReview) => {
    if (!signedIn) return navigate(signIn());
    const prev = voteOf(r);
    const on = !prev.voted;
    setVotes((m) => ({ ...m, [r.id]: { voted: on, count: prev.count + (on ? 1 : -1) } }));
    vote.mutate(
      { targetType: 'product_review', targetId: r.id, helpful: on },
      {
        onSuccess: (res) => setVotes((m) => ({ ...m, [r.id]: { voted: on, count: res.helpfulCount } })),
        onError: (e) => {
          setVotes((m) => ({ ...m, [r.id]: prev }));
          announce(errorMessage(e));
        },
      },
    );
  };
  const report = (r: ApiReview) => {
    if (r.viewerReported) return;
    const to = href('store/reviews', 'report-review', { slug, id }, { review: r.id });
    navigate(signedIn ? to : signIn(to));
  };
  const chips: Array<[ReviewFilter, string]> = [
    ['all', 'All reviews'],
    ['verified', 'Verified Purchase only'],
    ['photos', 'With photos'],
    ['critical', 'Critical (1–2 stars)'],
    ...(product.variants.length > 1 && color ? ([['color', color]] as Array<[ReviewFilter, string]>) : []),
  ];

  // Questions (first three; search runs on the server)
  const [qaQuery, setQaQuery] = useState('');
  const qaSearch = useDebounced(qaQuery.trim());
  const questions = useQuestionPage(id, qaSearch, 'helpful', 1, 3);
  const qaTotal = useQuestionPage(id, '', 'helpful', 1, 3).data?.total;

  const share = () => {
    if (navigator.share) navigator.share({ title: product.title, url: window.location.href }).catch(() => undefined);
  };

  const shipping = offer?.delivery.shippingCost;
  const barNote = offer ? (offer.delivery.free || !shipping?.amount ? offer.delivery.label : `+ ${formatMoney(shipping)} shipping`) : '';
  const offersLink = href('store/offers', '', { slug, id }, variantId ? { variant: variantId } : undefined);
  const sellerFeedback = offer && !offer.seller.official ? offer.seller : null;

  return (
    <StoreLayout
      nav="categories"
      appbar={{
        title: product.title,
        back: leaf ? href('store/category', '', { slug: leaf.slug }) : href('store/home'),
        actions: (
          <>
            <IconButton icon="share-2" label="Share" onClick={share} />
            <IconButton icon="shopping-cart" label={`Cart, ${cartCount} items`} to={href('store/cart')} count={cartCount} />
          </>
        ),
      }}
      actionBar={
        offer ? (
          <>
            <div className="stack gap-0 grow">
              <Price amount={dollars(offer.price)} was={offer.compareAt ? dollars(offer.compareAt.amount) : null} noOff />
              <span className="xs muted truncate" title={barNote}>
                {barNote}
              </span>
            </div>
            <Button size="sm" className="none nowrap" onClick={addToCart} disabled={cart.pending === offer.offerId}>
              {addLabel}
            </Button>
            <Button variant="secondary" size="sm" className="none nowrap" onClick={buy} disabled={buyNow.isPending}>
              Buy now
            </Button>
          </>
        ) : undefined
      }
    >
      <div className="container page gap-8">
        <div className="stack gap-4">
          <Breadcrumbs items={[...crumbs, { label: product.title }]} />
          <div className="shop-pdp">
            {/* Gallery */}
            <div className="shop-gal">
              <div className="main">
                {thumb?.kind === 'video' ? (
                  <div className="imgph tint-6">
                    <video src={thumb.media.url} controls style={{ width: '100%', height: '100%' }} aria-label="Product video" />
                  </div>
                ) : (
                  <Photo media={sized(thumb?.media, 'detail')} />
                )}
                {thumbs.length > 0 && (
                  <span className="cnt">
                    <Badge tone="solid">{thumb?.kind === 'video' ? 'Video' : `${photoNo} / ${images.length}`}</Badge>
                  </span>
                )}
              </div>
              {thumbs.length > 1 && (
                <div className="shop-thumbs" role="group" aria-label={product.video ? 'Photos and video' : 'Photos'}>
                  {thumbs.map((t, i) => (
                    <button
                      key={t.media.id}
                      type="button"
                      className={cx(i === thumbIdx && 'is-active')}
                      aria-label={t.kind === 'video' ? 'Play product video' : `Photo ${i + (product.video ? 0 : 1)}`}
                      aria-pressed={i === thumbIdx}
                      onClick={() => setThumbIdx(i)}
                    >
                      {t.kind === 'video' ? (
                        <>
                          <Photo className="thumb" icon="circle-play" />
                          <span className="vid">
                            <Icon name="circle-play" />
                            Video
                          </span>
                        </>
                      ) : (
                        <Photo media={sized(t.media, 'thumb')} className="thumb" />
                      )}
                    </button>
                  ))}
                </div>
              )}
              {product.variants.length > 1 && color && (
                <p className="xs muted">
                  <Icon name="info" className="ic-sm" /> Photos show {color}. Choosing another {axis.toLowerCase()} updates the photos, offers and price.
                </p>
              )}
            </div>

            {/* Title, variants, features */}
            <div className="stack gap-4">
              <div className="stack gap-2">
                {product.brand && (
                  <Link className="small strong" to={href('store/brand', '', { slug: product.brand.slug })}>
                    Visit the {product.brand.name} brand page
                  </Link>
                )}
                <h1 className="h2">{product.title}</h1>
                {hasReviews ? (
                  <div className="row gap-3">
                    <Stars5 rating={rating} className="u-fs-16" />
                    <Link className="small" to={href('store/reviews', '', { slug, id })}>
                      {rating.toFixed(1)} · {num(summary?.ratingCount ?? 0)} ratings
                    </Link>
                    <span className="xs muted">·</span>
                    <Link className="small" to={href('store/questions', '', { slug, id })}>
                      {num(summary?.answeredQuestions ?? 0)} answered questions
                    </Link>
                  </div>
                ) : (
                  <div className="row gap-2">
                    {product.isNewListing && (
                      <Badge tone="info" icon="sparkles">
                        New listing
                      </Badge>
                    )}
                    <span className="small sub">No reviews yet</span>
                    <span className="xs muted">·</span>
                    {/* A new listing's few questions are all on this page: jump to them. */}
                    <a
                      className="small"
                      href={`#${px}-qa-h`}
                      onClick={(e) => {
                        e.preventDefault();
                        document.getElementById(`${px}-qa-h`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                      }}
                    >
                      {summary?.answeredQuestions ?? 0} answered question{summary?.answeredQuestions === 1 ? '' : 's'}
                    </a>
                  </div>
                )}
                {(product.bestSellerRank || product.listedAt) && (
                  <span className="row gap-2">
                    {product.bestSellerRank && (
                      <Badge tone="info" icon="award">
                        {product.bestSellerRank.label}
                      </Badge>
                    )}
                    {product.listedAt && <span className="xs muted">Listed on Marketly {fmtDate(product.listedAt)}</span>}
                  </span>
                )}
              </div>
              {box && box.variants.length > 1 && (
                <div className="stack gap-2">
                  <span className="small">
                    <b>{axis}:</b> {color}
                  </span>
                  <div className="shop-var" role="group" aria-label={axis}>
                    {box.variants.map((v) => {
                      const on = v.variantId === variantId;
                      const cv = product.variants.find((x) => x.id === v.variantId);
                      return (
                        <button key={v.variantId} type="button" className={cx(on && 'is-selected')} aria-pressed={on} onClick={() => !on && onVariant(v.variantId)}>
                          <Photo media={sized(cv?.images?.[0] ?? product.images[0], 'thumb')} />
                          <span className="vn">{v.label}</span>
                          <span className="sub">{v.summary}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
              {product.keyFeatures.length > 0 && (
                <div className="stack gap-2">
                  <h2 className="h4">Key features</h2>
                  <ul className="shop-feat stack gap-2">
                    {product.keyFeatures.map((f) => (
                      <li key={f}>
                        <Icon name="check" />
                        <span>{f}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            {/* Buy box */}
            <section className="card shop-buy" aria-labelledby="buy-h" aria-busy={!box || undefined}>
              <div className="card-body">
                <h2 className="sr-only" id="buy-h">
                  Purchase options
                </h2>
                {boxError && !box ? (
                  <LoadError error={boxError} onRetry={onRetryBox} title="We couldn’t load the offers" />
                ) : !box ? (
                  <div className="sk-lines">
                    <span className="sk h-30" />
                    <span className="sk sk-line" />
                    <span className="sk sk-line short" />
                    <span className="sk h-46" />
                  </div>
                ) : !offer ? (
                  <Unavailable box={box} offersLink={offersLink} />
                ) : (
                  <>
                    {onlyOffer ? (
                      <div className="row between">
                        <span className="eyebrow">Only offer</span>
                        <span className="xs muted">1 seller</span>
                      </div>
                    ) : isFeatured ? (
                      <div className="row between">
                        <span className="eyebrow">Featured offer</span>
                        <Link className="xs" to={offersLink}>
                          How it’s chosen
                        </Link>
                      </div>
                    ) : (
                      <Alert tone="info" title={`You chose ${offer.seller.name}’s offer`}>
                        This seller stays with the item in your cart. We never switch sellers for you.
                      </Alert>
                    )}
                    {box.officialStore && <OfficialStoreCue cue={box.officialStore} productId={id} variantId={box.variantId} />}
                    <OfferPrice offer={offer} />
                    <div className="row gap-2">
                      <Badge tone={STOCK_TONE[offer.availability.state]}>
                        {offer.availability.state === 'low_stock' && offer.availability.quantity ? `${offer.availability.quantity} left` : STOCK_LABEL[offer.availability.state]}
                      </Badge>
                      <span className="small sub">
                        {offer.availability.quantity != null && `${offer.availability.quantity} available · `}Condition: <b>{offer.conditionLabel}</b>
                      </span>
                    </div>
                    {(offer.conditionNotes || offer.missingItems.length > 0) && (
                      <span className="xs muted">
                        {offer.conditionNotes}
                        {offer.missingItems.length > 0 && ` Missing: ${offer.missingItems.join(', ')}.`}
                      </span>
                    )}
                    <div className="stack gap-2">
                      <div className="shop-line">
                        <Icon name="truck" />
                        <span>
                          <b>{offer.delivery.label}</b> to {offer.delivery.locationLabel ?? box.deliverTo.label} ·{' '}
                          <button type="button" className="btn-bare link-inline" onClick={() => setDeliverOpen(true)}>
                            Change
                          </button>
                          {deliveryNote(offer) && (
                            <>
                              <br />
                              <span className="xs muted">{deliveryNote(offer)}</span>
                            </>
                          )}
                        </span>
                      </div>
                      <div className="shop-line">
                        <Icon name="package" />
                        <span>
                          Ships from {offer.delivery.shipsFrom} by <b>{shipperName(offer)}</b>
                          {offer.delivery.carrier && ` with ${offer.delivery.carrier}`}
                          {` · ${offer.delivery.free || !shipping?.amount ? 'Free' : formatMoney(shipping)}`}
                        </span>
                      </div>
                      <div className="shop-line">
                        <Icon name="store" />
                        <span>
                          Sold by{' '}
                          <Link to={sellerHref(offer.seller)} className="link-inline">
                            <b>{offer.seller.name}</b>
                          </Link>{' '}
                          <SellerBadge seller={offer.seller} compact />
                          <br />
                          <span className="xs muted">{sellerRatingLine(offer)}</span>
                        </span>
                      </div>
                      <div className="shop-line">
                        <Icon name="undo-2" />
                        <span>
                          {offer.returns.summary} ·{' '}
                          <Link to={href('info/policy')} className="link-inline">
                            Return policy
                          </Link>
                        </span>
                      </div>
                      <div className="shop-line">
                        <Icon name="shield-check" />
                        <span>{offer.warranty.summary}</span>
                      </div>
                    </div>
                    <div className="row gap-3">
                      <label className="small strong" htmlFor={`${px}-qty`}>
                        Quantity
                      </label>
                      <select className="select" id={`${px}-qty`} value={quantity} onChange={(e) => setQty(Number(e.target.value))}>
                        {qtyOptions.map((n) => (
                          <option key={n} value={n}>
                            {n}
                          </option>
                        ))}
                      </select>
                      {offer.availability.purchaseLimit != null && <span className="xs muted">Limit {offer.availability.purchaseLimit} per customer</span>}
                    </div>
                    <div className="stack gap-2">
                      <Button block icon={added ? 'check' : 'shopping-cart'} onClick={addToCart} disabled={cart.pending === offer.offerId}>
                        {addLabel}
                      </Button>
                      <Button variant="secondary" block onClick={buy} disabled={buyNow.isPending}>
                        Buy now
                      </Button>
                      {actionError ? (
                        <span className="error-text" role="alert">
                          <Icon name="circle-alert" className="ic-sm" />
                          {actionError}
                        </span>
                      ) : (
                        <span className="xs muted center">You’ll review totals, delivery and seller details before paying.</span>
                      )}
                    </div>
                    <div className="row gap-4">
                      <Link className="small strong" to={sellerHref(offer.seller)}>
                        <Icon name="store" className="ic-sm" /> {offer.seller.official ? 'Visit the Official Store' : `Visit ${offer.seller.name}’s store`}
                      </Link>
                      <button type="button" className="btn-bare link-inline small strong" onClick={askSeller}>
                        <Icon name="message-square" className="ic-sm" /> Ask the seller
                      </button>
                    </div>
                  </>
                )}
              </div>
              {box &&
                offer &&
                (onlyOffer ? (
                  <div className="card-foot start">
                    <span className="small sub">No other sellers offer this product yet.</span>
                  </div>
                ) : isFeatured ? (
                  <div className="card-foot between">
                    <span className="small sub">Other sellers on Marketly</span>
                    <Link className="small strong" to={offersLink}>
                      {box.otherOffers.count} offer{box.otherOffers.count === 1 ? '' : 's'}
                      {box.otherOffers.lowestPrice && ` from ${formatMoney(box.otherOffers.lowestPrice)}`} <Icon name="chevron-right" className="ic-sm" />
                    </Link>
                  </div>
                ) : (
                  featured && <FeaturedFoot featured={featured} total={box.otherOffers.count + 1} offersLink={offersLink} onChoose={() => onOffer(null)} />
                ))}
            </section>
          </div>
        </div>

        {/* About and specifications */}
        <section className="shop-two even" aria-label="Product details">
          <div className="stack gap-4">
            <h2 className="h3">About this item</h2>
            <p className="sub">{product.description}</p>
            {product.includedItems.length > 0 && (
              <div className="stack gap-2">
                <PhoneCollapse className="pdp-collapse" summaryClassName="pdp-sum" summary={<h3 className="h4">In the box</h3>}>
                  <ul className="shop-feat stack gap-1">
                    {product.includedItems.map((it) => (
                      <li key={it}>
                        <Icon name="package" />
                        <span>{it}</span>
                      </li>
                    ))}
                  </ul>
                </PhoneCollapse>
              </div>
            )}
          </div>
          <div className="stack gap-3">
            <PhoneCollapse className="pdp-collapse" summaryClassName="pdp-sum" summary={<h2 className="h3">Specifications</h2>}>
              <div className="card pad">
                <KeyValue pairs={specPairs(product)} />
              </div>
            </PhoneCollapse>
          </div>
        </section>

        {/* Reviews */}
        <section className="stack gap-5" id={hasReviews ? `${px}-reviews` : undefined} aria-labelledby={`${px}-rev-h`}>
          <h2 className="h2" id={`${px}-rev-h`}>
            Customer reviews
          </h2>
          {!summary ? (
            <ListSkeleton rows={2} />
          ) : hasReviews ? (
            <div className="shop-two">
              <div className="stack gap-4">
                <div className="row gap-3 base">
                  <span className="display d-xl">{rating.toFixed(1)}</span>
                  <span className="stack gap-1">
                    <Stars5 rating={rating} className="u-fs-18" />
                    <span className="small sub">
                      {num(summary.ratingCount)} ratings · {num(summary.writtenCount)} written reviews
                    </span>
                  </span>
                </div>
                <div className="rating-bars">
                  {summary.distribution.map((b) => (
                    <RatingBar key={b.stars} star={b.stars} pct={b.pct} active={filter === `star-${b.stars}`} onClick={() => setFilter(filter === `star-${b.stars}` ? 'all' : `star-${b.stars}`)} />
                  ))}
                </div>
                <Alert tone="info" title="About these reviews">
                  Product reviews describe the product. Feedback about a seller’s shipping and service is on each seller’s page
                  {sellerFeedback ? (
                    <>
                      , for example{' '}
                      <Link to={sellerHref(sellerFeedback)} className="link-inline">
                        {sellerFeedback.name} feedback
                      </Link>
                    </>
                  ) : null}
                  . Verified Purchase means the reviewer bought this product on Marketly.
                </Alert>
                <Button variant="secondary" to={href('account/review')}>
                  Write a review
                </Button>
              </div>
              <div className="stack gap-0">
                <div className="hscroll gap-2">
                  {chips.map(([v, label]) => (
                    <Chip key={v} active={filter === v} onClick={() => setFilter(v)}>
                      {label}
                    </Chip>
                  ))}
                </div>
                {reviews.error ? (
                  <div className="u-pt-sp-3">
                    <LoadError error={reviews.error} onRetry={() => void reviews.refetch()} title="We couldn’t load the reviews" />
                  </div>
                ) : !reviews.data ? (
                  <div className="u-pt-sp-3">
                    <ListSkeleton />
                  </div>
                ) : (
                  reviews.data.items.map((r) => {
                    const v = voteOf(r);
                    return (
                      <article key={r.id} className="shop-rev">
                        <div className="row gap-2">
                          <Avatar name={r.author.displayName} />
                          <span className="small strong">{r.author.displayName}</span>
                          {r.author.verifiedPurchase && (
                            <Badge tone="success" icon="circle-check">
                              Verified Purchase
                            </Badge>
                          )}
                        </div>
                        <div className="row gap-2">
                          <Stars5 rating={r.rating} size="md" />
                          <h3 className="h4">{r.headline}</h3>
                        </div>
                        <span className="xs muted">
                          {[`Reviewed ${fmtDate(r.reviewedAt)}`, r.variantLabel, `Sold by ${r.soldBy.name}`].filter(Boolean).join(' · ')}
                        </span>
                        <p className="small">{r.text}</p>
                        {r.response && (
                          <div className="shop-reply">
                            <span className="xs strong">
                              Response from {r.response.fromName}
                              {r.response.publishedAt && ` · ${fmtDate(r.response.publishedAt)}`}
                            </span>
                            <span>{r.response.text}</span>
                          </div>
                        )}
                        <div className="row gap-2">
                          <Button variant="ghost" size="sm" icon="thumbs-up" aria-pressed={v.voted} onClick={() => helpful(r)}>
                            Helpful ({v.count})
                          </Button>
                          <Button variant="ghost" size="sm" icon="flag" aria-disabled={r.viewerReported || undefined} onClick={() => report(r)}>
                            {r.viewerReported ? 'Reported' : 'Report'}
                          </Button>
                        </div>
                      </article>
                    );
                  })
                )}
                {reviews.data?.items.length === 0 && <p className="small sub u-pt-sp-3">No reviews match this filter.</p>}
                <Link className="small strong u-pt-sp-3" to={href('store/reviews', '', { slug, id })}>
                  See all {num(summary.writtenCount)} reviews <Icon name="arrow-right" className="ic-sm" />
                </Link>
              </div>
            </div>
          ) : (
            <div className="shop-two">
              <div className="stack gap-3">
                <span className="h3">No reviews yet</span>
                <p className="small sub">
                  {product.listedAt ? `This product was listed on ${fmtDate(product.listedAt)}. ` : ''}We don’t show a star rating until customers who bought it have reviewed it.
                </p>
                <Alert tone="info" title="Only verified purchases can review">
                  Reviews are linked to a recorded purchase on Marketly. Seller feedback for the Official Store is shown on{' '}
                  <Link to={href('store/official')} className="link-inline">
                    its store page
                  </Link>
                  .
                </Alert>
              </div>
              <div className="card">
                <EmptyState
                  icon="message-square-text"
                  title="Be the first to review after you buy it"
                  action={
                    <Button variant="secondary" size="sm" to={href('help/article')}>
                      How reviews work
                    </Button>
                  }
                >
                  Only verified purchases can review. We’ll ask you for a review a few days after delivery.
                </EmptyState>
              </div>
            </div>
          )}
        </section>

        {/* Questions */}
        <section className="stack gap-4" id={hasReviews ? `${px}-qa` : undefined} aria-labelledby={`${px}-qa-h`}>
          <div className="row between">
            <h2 className="h2" id={`${px}-qa-h`}>
              Customer questions
            </h2>
            <Button variant="secondary" size="sm" icon="message-circle-question" to={href('store/questions', 'ask', { slug, id })}>
              Ask a question
            </Button>
          </div>
          <PhoneCollapse className="pdp-collapse" summaryClassName="pdp-sum pdp-sum--more" summary="Show customer questions">
            <div className="toolbar">
              <SearchInput
                id={`${px}-qa-q`}
                placeholder={qaTotal ? `Search ${num(qaTotal)} questions and answers` : 'Search questions and answers'}
                value={qaQuery}
                onChange={setQaQuery}
              />
            </div>
            <div className="card pad stack gap-0">
              {questions.error ? (
                <LoadError error={questions.error} onRetry={() => void questions.refetch()} title="We couldn’t load the questions" />
              ) : !questions.data ? (
                <ListSkeleton rows={2} />
              ) : (
                questions.data.items.map((it) => (
                  <div key={it.id} className="shop-qa">
                    <div className="row gap-2 top nowrap">
                      <span className="strong small none">Q:</span>
                      <span className="strong small">{it.text}</span>
                    </div>
                    {it.answers.map((a) => {
                      const role = QA_ROLE[a.label];
                      return (
                        <div key={a.id} className="a">
                          <div className="row gap-2">
                            <Badge tone={role.tone} icon={role.icon}>
                              {role.label}
                            </Badge>
                            <span className="xs muted">
                              {a.by.displayName} · {fmtDate(a.answeredAt)}
                            </span>
                          </div>
                          <span>{a.text}</span>
                        </div>
                      );
                    })}
                    {it.answers.length === 0 && (
                      <div className="a">
                        <span className="xs muted">
                          Not answered yet. Asked {fmtDate(it.askedAt)}.{it.answerExpectation ? ` ${it.answerExpectation}` : ''}
                        </span>
                      </div>
                    )}
                  </div>
                ))
              )}
              {questions.data?.items.length === 0 &&
                (qaSearch ? <p className="small sub">No questions match “{qaSearch}”.</p> : <p className="small sub">No questions yet. Ask the sellers and other customers.</p>)}
              {!qaSearch && (questions.data?.total ?? 0) > (questions.data?.items.length ?? 0) && (
                <Link className="small strong u-pt-sp-3" to={href('store/questions', '', { slug, id })}>
                  See all {num(questions.data?.total ?? 0)} questions <Icon name="arrow-right" className="ic-sm" />
                </Link>
              )}
              {qaSearch && (questions.data?.total ?? 0) > (questions.data?.items.length ?? 0) && (
                <Link className="small strong u-pt-sp-3" to={href('store/questions', '', { slug, id }, { q: qaSearch })}>
                  See all {num(questions.data?.total ?? 0)} matching questions <Icon name="arrow-right" className="ic-sm" />
                </Link>
              )}
            </div>
            <p className="xs muted">
              Answers are labeled Seller, Marketly staff or Customer so you know who is speaking. Questions about your own order go to{' '}
              <Link to={href('account/messages')} className="link-inline">
                order messages
              </Link>
              .
            </p>
          </PhoneCollapse>
        </section>

        <Related id={id} leaf={leaf} />
      </div>
      {offer && (
        <AskSellerDialog open={askOpen} onClose={() => setAskOpen(false)} sellerName={offer.seller.name} offers={[{ offerId: offer.offerId, title: color ? `${product.title} (${color})` : product.title }]} />
      )}
      <DeliverToDialog open={deliverOpen} onClose={() => setDeliverOpen(false)} signedIn={signedIn} current={box?.deliverTo} />
    </StoreLayout>
  );
}

/* ---------------- Pieces ---------------- */

/** Spec table rows: the product's specs plus the model number when the specs don't name it. */
function specPairs(p: CatalogProduct): Array<[string, string]> {
  const rows = Object.entries(p.specs ?? {}).map(([k, v]) => [k, String(v)] as [string, string]);
  if (p.modelNumber && !rows.some(([, v]) => v.includes(p.modelNumber!))) rows.push(['Model number', p.modelNumber]);
  return rows;
}

const deliveryNote = (o: OfferView) =>
  [orderWithin(o.delivery.orderWithinMinutes), o.delivery.freeOver && !o.delivery.free ? `Free on orders over ${formatMoney(o.delivery.freeOver)}` : '', o.delivery.serviceNotice ?? '']
    .filter(Boolean)
    .join(' · ');

const sellerRatingLine = (o: OfferView) =>
  o.seller.ratingCount && o.seller.positivePct != null ? `${o.seller.positivePct}% positive · ${num(o.seller.ratingCount)} ratings` : 'No seller ratings yet';

/**
 * The Official Store has this variant but can't sell it here now while another seller's offer is in the
 * buy box (G59): its state, restock estimate and price, with the details page (store/search-empty
 * product-unavailable view).
 */
function OfficialStoreCue({ cue, productId, variantId }: { cue: NonNullable<PurchaseBox['officialStore']>; productId: string; variantId: string }) {
  return (
    <div className="shop-line">
      <Icon name="badge-check" />
      <span className="small">
        <b>{cue.title}</b> · Official Store price {formatMoney(cue.price)}
        <br />
        <span className="xs muted">
          {cue.message}
          {cue.expectedRestockDate && ` Expected back around ${fmtDate(`${cue.expectedRestockDate}T12:00:00Z`)} (estimate).`}{' '}
          <Link className="link-inline" to={href('store/search-empty', 'product-unavailable', undefined, { id: productId, variantId })}>
            Details
          </Link>
        </span>
      </span>
    </div>
  );
}

/** Price block of the buy box: sale and was-price notes, and the shipping total for a paid-shipping offer. */
function OfferPrice({ offer }: { offer: OfferView }) {
  const price = <Price amount={dollars(offer.price)} was={offer.compareAt ? dollars(offer.compareAt.amount) : null} lg />;
  const ends = offer.saleEndsAt ?? offer.promotion?.endsAt;
  const sale = ends ? `${offer.promotion?.label ?? 'Sale'} ends ${fmtDateTime(ends)}` : offer.promotion?.label;
  const wasNote = offer.compareAt ? (offer.promotion?.wasPriceRule ?? offer.compareAt.explanation) : null;
  const ship = offer.delivery.shippingCost;
  const paidShipping = !offer.delivery.free && !!ship?.amount;
  if (!sale && !wasNote && !paidShipping) return price;
  return (
    <div className="stack gap-1">
      {price}
      {sale && <span className="small t-deal-text strong">{sale}</span>}
      {wasNote && <span className="xs muted">{wasNote}</span>}
      {paidShipping && (
        <span className="small sub">
          + {formatMoney(ship)} shipping · <b>{formatMoney(offer.total)}</b> before tax
        </span>
      )}
    </div>
  );
}

/** No offer can be bought for this variant: why, when it may return, and other sellers. */
function Unavailable({ box, offersLink }: { box: PurchaseBox; offersLink: string }) {
  const u = box.unavailable;
  return (
    <div className="stack gap-3">
      <Alert tone="warning" title={u?.title ?? 'Currently unavailable'}>
        {u?.message ?? 'No seller offers this item right now.'}
        {u?.expectedRestockDate && ` Expected back around ${fmtDate(u.expectedRestockDate)}.`}
      </Alert>
      {(u?.alternatives.length ?? 0) > 0 && (
        <Link className="small strong" to={offersLink}>
          See {u!.alternatives.length} other offer{u!.alternatives.length === 1 ? '' : 's'} <Icon name="chevron-right" className="ic-sm" />
        </Link>
      )}
    </div>
  );
}

/** Card foot while another seller's offer is chosen: the featured offer, with a way back to it. */
function FeaturedFoot({ featured, total, offersLink, onChoose }: { featured: OfferView; total: number; offersLink: string; onChoose: () => void }) {
  const ship = featured.delivery.shippingCost;
  return (
    <div className="card-foot u-fd-column" style={{ justifyContent: 'stretch', alignItems: 'stretch' } as CSSProperties}>
      <span className="eyebrow">Featured offer</span>
      <div className="row between gap-2">
        <span className="stack gap-0">
          <span className="row gap-2">
            <b className="small">{featured.seller.name}</b>
            <SellerBadge seller={featured.seller} compact />
          </span>
          <span className="xs muted">
            {formatMoney(featured.price)} · {featured.delivery.free || !ship?.amount ? featured.delivery.label : `+ ${formatMoney(ship)} shipping`} · {featured.returns.summary}
          </span>
        </span>
        <Button variant="secondary" size="sm" onClick={onChoose}>
          Choose
        </Button>
      </div>
      <Link className="small strong" to={offersLink}>
        See all {total} offers
      </Link>
    </div>
  );
}

/** One row of the rating histogram; the star link filters the reviews. */
function RatingBar({ star, pct, active, onClick }: { star: number; pct: number; active: boolean; onClick: () => void }) {
  const label = `${star} star`;
  return (
    <>
      <a
        href="#"
        className={cx('nowrap', active && 'strong')}
        aria-current={active ? 'true' : undefined}
        onClick={(e) => {
          e.preventDefault();
          onClick();
        }}
      >
        {label}
      </a>
      <Meter pct={pct} label={label} />
      <span>{pct}%</span>
    </>
  );
}

/** Related products: similar in-stock products from search. Hidden when there are none. */
function Related({ id, leaf }: { id: string; leaf?: { name: string; slug: string } }) {
  const related = useSimilarProducts(id, 5);
  if (related.isError || (related.data && related.data.length === 0)) return null;
  return (
    <section className="stack gap-4" aria-labelledby={`${px}-rel`}>
      <div className="row between base">
        <h2 className="h2">
          <span id={`${px}-rel`}>Related products</span>
        </h2>
        {leaf && (
          <Link className="small strong" to={href('store/category', '', { slug: leaf.slug })}>
            More {leaf.name.toLowerCase()} <Icon name="arrow-right" className="ic-sm" />
          </Link>
        )}
      </div>
      <div className="grid-products wide">
        {related.data
          ? related.data.map((p) => <RelatedCard key={p.productId} p={p} />)
          : Array.from({ length: 5 }, (_, i) => (
              <div key={i} className="sk-card" aria-hidden="true">
                <span className="sk sk-img" />
                <span className="sk sk-line" />
                <span className="sk sk-line short" />
              </div>
            ))}
      </div>
    </section>
  );
}

/** Product card (.pcard) for a search ProductCard. The wishlist heart is hidden (wishlist is off at launch). */
function RelatedCard({ p }: { p: SimilarProduct }) {
  const to = productHref(p.slug, p.productId);
  const price = dollars(p.price);
  const was = p.wasPrice ? dollars(p.wasPrice) : null;
  const off = percentOff(price, was);
  return (
    <article className="pcard">
      <div className="pcard-media">
        <Link to={to} aria-label={p.title}>
          <Photo media={sized(p.image, 'thumb')} />
        </Link>
        <div className="tags">
          {off > 0 && <Badge tone="deal">−{off}%</Badge>}
          {p.official && <Badge tone="brand">Official</Badge>}
        </div>
      </div>
      <Link className="name" to={to}>
        {p.title}
      </Link>
      {p.rating != null && <Stars rating={p.rating} count={p.ratingCount} />}
      <Price amount={price} was={was} from={p.priceIsFrom && p.offerCount > 1} noOff />
      {p.deliveryCue && (
        <div className="meta">
          {p.freeDelivery ? (
            <span>
              <Icon name="truck" className="ic-sm" /> {p.deliveryCue}
            </span>
          ) : (
            <span>{p.deliveryCue}</span>
          )}
        </div>
      )}
      <div className="meta">
        <span className="seller-line">
          Sold by{' '}
          {p.official || p.sellerSlug ? (
            <Link to={p.official ? href('store/official') : href('store/seller', '', { slug: p.sellerSlug! })}>
              <b>{p.sellerName}</b>
            </Link>
          ) : (
            <b>{p.sellerName}</b>
          )}
        </span>
      </div>
    </article>
  );
}

function ProductSkeleton() {
  return (
    <StoreLayout nav="categories" appbar={{ title: 'Product', back: href('store/home') }}>
      <div className="container page gap-8" aria-busy="true" aria-label="Loading product">
        <div className="stack gap-4">
          <span className="sk sk-line short" />
          <div className="shop-pdp">
            <div className="shop-gal">
              <span className="sk sk-img" />
            </div>
            <div className="sk-lines">
              <span className="sk sk-line short" />
              <span className="sk h-30" />
              <span className="sk sk-line" />
              <span className="sk sk-line" />
              <span className="sk sk-line short" />
            </div>
            <div className="card shop-buy">
              <div className="card-body sk-lines">
                <span className="sk h-30" />
                <span className="sk sk-line" />
                <span className="sk sk-line short" />
                <span className="sk h-46" />
                <span className="sk h-46" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </StoreLayout>
  );
}
