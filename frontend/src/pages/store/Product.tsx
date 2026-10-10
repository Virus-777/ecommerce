import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Link } from 'react-router';
import { useSession } from '@/app/session';
import { sellers } from '@/data/fixtures';
import { StoreLayout } from '@/layouts';
import { cx } from '@/lib/cx';
import { money, num } from '@/lib/format';
import { useView } from '@/lib/hooks';
import { href } from '@/routes/href';
import {
  Alert, Avatar, Badge, Breadcrumbs, Button, Chip, EmptyState, Icon, IconButton, Img, KeyValue, Meter, PhoneCollapse,
  Price, ProductCard, SearchInput, SellerBadge, Stars5, announce, type IconName,
} from '@/ui';
import { aurora, lamp, type BuyOffer, type ProductDetail, type QaAnswer, type Review } from './data/product';

// Design: pages/store/store-product.html (Official Store offer)
//   view "seller-offer-selected" = Northwind Audio's offer chosen in the buy box
//   view "no-reviews-yet"        = a new listing with zero reviews (the Brightline desk lamp)

type View = 'seller-offer-selected' | 'no-reviews-yet';

export default function Product() {
  const [view, setView] = useView<View>();
  const product = view === 'no-reviews-yet' ? lamp : aurora;
  // The buy-box offer lives in the URL so the seller choice is linkable: the second seller's
  // offer is the "seller-offer-selected" view, the featured (first) offer is the default.
  const offer = view === 'seller-offer-selected' && product.offers[1] ? product.offers[1] : product.offers[0];
  const chooseOffer = (o: BuyOffer) => setView(o === product.offers[0] ? '' : 'seller-offer-selected');
  return <ProductPage key={product.id} product={product} offer={offer} onChooseOffer={chooseOffer} />;
}

const sellerHref = (id: BuyOffer['seller']) => ('official' in sellers[id] ? href('store/official') : href('store/seller'));

const QA_ROLE: Record<QaAnswer['role'], { tone: '' | 'brand' | 'info'; icon: IconName; label: string }> = {
  staff: { tone: 'brand', icon: 'badge-check', label: 'Marketly staff' },
  seller: { tone: 'info', icon: 'store', label: 'Seller' },
  customer: { tone: '', icon: 'user-round', label: 'Customer' },
};

type ReviewFilter = 'all' | 'verified' | 'photos' | 'critical' | 'color' | `star-${number}`;

function ProductPage({ product, offer, onChooseOffer }: { product: ProductDetail; offer: BuyOffer; onChooseOffer: (o: BuyOffer) => void }) {
  const { cartCount, setCartCount } = useSession();
  const px = product.px;
  const featured = product.offers[0];
  const isFeatured = offer === featured;
  const others = product.market.filter((o) => !o.main);
  const onlyOffer = product.market.length === 0;
  const seller = sellers[offer.seller];
  const official = 'official' in seller && seller.official;
  const hasReviews = product.reviews.length > 0;

  // Gallery, variant, wishlist
  const [variantIdx, setVariantIdx] = useState(0);
  const variant = product.variants[variantIdx];
  const [thumbIdx, setThumbIdx] = useState(() => Math.max(0, product.thumbs.findIndex((t) => !t.video)));
  const thumb = product.thumbs[thumbIdx];
  const photoNo = product.thumbs.slice(0, thumbIdx + 1).filter((t) => !t.video).length;
  const [saved, setSaved] = useState(false);

  // Quantity and add to cart
  const [qty, setQty] = useState(1);
  const [added, setAdded] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const addToCart = () => {
    setCartCount(cartCount + qty);
    setAdded(true);
    announce(`Added ${qty} × ${product.name} from ${seller.name} to your cart`);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setAdded(false), 2500);
  };
  const addLabel = added ? 'Added to cart' : 'Add to cart';

  // Reviews
  const [filter, setFilter] = useState<ReviewFilter>('all');
  const [voted, setVoted] = useState<Record<string, boolean>>({});
  const [reported, setReported] = useState<Record<string, boolean>>({});
  const matches = (r: Review) => {
    if (filter === 'verified') return r.verified;
    if (filter === 'photos') return r.photos;
    if (filter === 'critical') return r.rating <= 2;
    if (filter === 'color') return r.color === variant.name;
    if (filter.startsWith('star-')) return r.rating === Number(filter.slice(5));
    return true;
  };
  const reviews = product.reviews.filter(matches);
  const chips: Array<[ReviewFilter, string]> = [
    ['all', 'All reviews'],
    ['verified', 'Verified Purchase only'],
    ['photos', 'With photos'],
    ['critical', 'Critical (1–2 stars)'],
    ['color', variant.name],
  ];

  // Questions
  const [qaQuery, setQaQuery] = useState('');
  const q = qaQuery.trim().toLowerCase();
  const questions = product.questionList.filter((it) => !q || it.q.toLowerCase().includes(q) || it.answers.some((a) => a.body.toLowerCase().includes(q)));

  const share = () => {
    if (navigator.share) navigator.share({ title: product.name, url: window.location.href }).catch(() => undefined);
  };

  return (
    <StoreLayout
      nav="categories"
      appbar={{
        title: product.appbarTitle,
        back: href('store/category'),
        actions: (
          <>
            <IconButton icon="share-2" label="Share" onClick={share} />
            <IconButton icon="shopping-cart" label={`Cart, ${cartCount} items`} to={href('store/cart')} count={cartCount} />
          </>
        ),
      }}
      actionBar={
        <>
          <div className="stack gap-0 none">
            <Price amount={offer.price} was={offer.was} noOff />
            <span className="xs muted">{offer.barNote}</span>
          </div>
          <span className="grow" />
          <Button size="sm" onClick={addToCart}>
            {addLabel}
          </Button>
          <Button variant="secondary" size="sm" to={href('store/checkout')}>
            Buy now
          </Button>
        </>
      }
    >
      <div className="container page gap-8">
        <div className="stack gap-4">
          <Breadcrumbs
            items={[
              { label: 'Home', to: href('store/home') },
              { label: product.crumbs.cat, to: href('store/categories') },
              { label: product.crumbs.sub, to: href('store/category') },
              { label: product.crumbs.name },
            ]}
          />
          <div className="shop-pdp">
            {/* Gallery */}
            <div className="shop-gal">
              <div className="main">
                <Img icon={thumb.icon} tint={thumb.tint ?? variant.tint} />
                <span className="cnt">
                  <Badge tone="solid">{thumb.video ? thumb.video : `${photoNo} / ${product.photosTotal}`}</Badge>
                </span>
                <span className="fav">
                  <button
                    type="button"
                    className={cx('icon-btn', saved && 'is-active')}
                    aria-label="Save to wishlist"
                    aria-pressed={saved}
                    onClick={() => {
                      setSaved((v) => !v);
                      announce(saved ? 'Removed from your wishlist' : 'Saved to your wishlist');
                    }}
                  >
                    <Icon name="heart" fill={saved ? 'currentColor' : 'none'} />
                  </button>
                </span>
              </div>
              <div className="shop-thumbs" role="group" aria-label={product.thumbsLabel}>
                {product.thumbs.map((t, i) => (
                  <button key={t.label} type="button" className={cx(i === thumbIdx && 'is-active')} aria-label={t.label} aria-pressed={i === thumbIdx} onClick={() => setThumbIdx(i)}>
                    <Img icon={t.icon} tint={t.tint ?? variant.tint} className="thumb" />
                    {t.video && (
                      <span className="vid">
                        <Icon name="circle-play" />
                        {t.video}
                      </span>
                    )}
                  </button>
                ))}
              </div>
              <p className="xs muted">
                <Icon name="info" className="ic-sm" /> Photos show {variant.name}. Choosing another color updates the photos, offers and price.
              </p>
            </div>

            {/* Title, variants, features */}
            <div className="stack gap-4">
              <div className="stack gap-2">
                <Link className="small strong" to={href('store/brand')}>
                  Visit the {product.brand} brand page
                </Link>
                <h1 className="h2">{product.name}</h1>
                {hasReviews ? (
                  <div className="row gap-3">
                    <Stars5 rating={product.rating} className="u-fs-16" />
                    <a className="small" href="#">
                      {product.rating} · {num(product.ratings)} ratings
                    </a>
                    <span className="xs muted">·</span>
                    <a className="small" href="#">
                      {product.questions} answered questions
                    </a>
                  </div>
                ) : (
                  <div className="row gap-2">
                    <Badge tone="info" icon="sparkles">
                      New listing
                    </Badge>
                    <span className="small sub">No reviews yet</span>
                    <span className="xs muted">·</span>
                    <a className="small" href="#">
                      {product.questions} answered question{product.questions === 1 ? '' : 's'}
                    </a>
                  </div>
                )}
                {product.rank ? (
                  <span className="xs muted">
                    <Badge tone="outline">{product.rank.badge}</Badge> {product.rank.note}
                  </span>
                ) : (
                  product.listed && <span className="xs muted">{product.listed}</span>
                )}
              </div>
              <div className="stack gap-2">
                <span className="small">
                  <b>Color:</b> {variant.name}
                </span>
                <div className="shop-var" role="group" aria-label="Color">
                  {product.variants.map((v, i) => (
                    <button key={v.name} type="button" className={cx(i === variantIdx && 'is-selected')} aria-pressed={i === variantIdx} onClick={() => setVariantIdx(i)}>
                      <Img icon={v.icon} tint={v.tint} />
                      <span className="vn">{v.name}</span>
                      <span className="sub">{v.sub}</span>
                    </button>
                  ))}
                </div>
              </div>
              <div className="stack gap-2">
                <h2 className="h4">Key features</h2>
                <ul className="shop-feat stack gap-2">
                  {product.features.map((f) => (
                    <li key={f}>
                      <Icon name="check" />
                      <span>{f}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>

            {/* Buy box */}
            <section className="card shop-buy" aria-labelledby="buy-h">
              <div className="card-body">
                <h2 className="sr-only" id="buy-h">
                  Purchase options
                </h2>
                {onlyOffer ? (
                  <div className="row between">
                    <span className="eyebrow">Only offer</span>
                    <span className="xs muted">1 seller</span>
                  </div>
                ) : isFeatured ? (
                  <div className="row between">
                    <span className="eyebrow">Featured offer</span>
                    <Link className="xs" to={href('store/offers')}>
                      How it’s chosen
                    </Link>
                  </div>
                ) : (
                  <Alert tone="info" title={`You chose ${seller.name}’s offer`}>
                    This seller stays with the item in your cart. We never switch sellers for you.
                  </Alert>
                )}
                <OfferPrice offer={offer} />
                <div className="row gap-2">
                  <Badge tone={offer.stock.tone}>{offer.stock.label}</Badge>
                  <span className="small sub">
                    {offer.stock.available} available · Condition: <b>{offer.stock.condition}</b>
                  </span>
                </div>
                <div className="stack gap-2">
                  <div className="shop-line">
                    <Icon name="truck" />
                    <span>
                      <b>{offer.delivery}</b> to Portland 97205 ·{' '}
                      <a href="#" className="link-inline">
                        Change
                      </a>
                      {offer.deliveryNote && (
                        <>
                          <br />
                          <span className="xs muted">{offer.deliveryNote}</span>
                        </>
                      )}
                    </span>
                  </div>
                  <div className="shop-line">
                    <Icon name="package" />
                    <span>
                      Ships from {offer.shipsFrom} by <b>{official ? 'Marketly' : seller.name}</b> with {offer.carrier}
                      {offer.showShipCost && ` · ${offer.ship === 0 ? 'Free' : money(offer.ship)}`}
                    </span>
                  </div>
                  <div className="shop-line">
                    <Icon name="store" />
                    <span>
                      Sold by{' '}
                      <Link to={sellerHref(offer.seller)} className="link-inline">
                        <b>{seller.name}</b>
                      </Link>{' '}
                      <SellerBadge seller={seller} compact />
                      <br />
                      <span className="xs muted">
                        {seller.positive}% positive · {num(seller.ratings)} ratings{offer.ratingsSuffix}
                      </span>
                    </span>
                  </div>
                  <div className="shop-line">
                    <Icon name="undo-2" />
                    <span>
                      {offer.returns} ·{' '}
                      <Link to={href('info/policy')} className="link-inline">
                        Return policy
                      </Link>
                    </span>
                  </div>
                  <div className="shop-line">
                    <Icon name="shield-check" />
                    <span>{offer.warranty}</span>
                  </div>
                </div>
                <div className="row gap-3">
                  <label className="small strong" htmlFor={`${px}-qty`}>
                    Quantity
                  </label>
                  <select className="select" id={`${px}-qty`} value={qty} onChange={(e) => setQty(Number(e.target.value))}>
                    {Array.from({ length: offer.limit }, (_, i) => i + 1).map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                  <span className="xs muted">Limit {offer.limit} per customer</span>
                </div>
                <div className="stack gap-2">
                  <Button block icon={added ? 'check' : 'shopping-cart'} onClick={addToCart}>
                    {addLabel}
                  </Button>
                  <Button variant="secondary" block to={href('store/checkout')}>
                    Buy now
                  </Button>
                  <span className="xs muted center">You’ll review totals, delivery and seller details before paying.</span>
                </div>
                <Link className="small strong" to={sellerHref(offer.seller)}>
                  <Icon name="store" className="ic-sm" /> {offer.visit}
                </Link>
              </div>
              {onlyOffer ? (
                <div className="card-foot start">
                  <span className="small sub">No other sellers offer this product yet.</span>
                </div>
              ) : isFeatured ? (
                <div className="card-foot between">
                  <span className="small sub">Other sellers on Marketly</span>
                  <Link className="small strong" to={href('store/offers')}>
                    {others.length} offers from {money(Math.min(...others.map((o) => o.price)))} <Icon name="chevron-right" className="ic-sm" />
                  </Link>
                </div>
              ) : (
                <FeaturedFoot product={product} onChoose={() => onChooseOffer(featured)} />
              )}
            </section>
          </div>
        </div>

        {/* About and specifications */}
        <section className="shop-two even" aria-label="Product details">
          <div className="stack gap-4">
            <h2 className="h3">About this item</h2>
            <p className="sub">{product.about}</p>
            <div className="stack gap-2">
              <PhoneCollapse className="pdp-collapse" summaryClassName="pdp-sum" summary={<h3 className="h4">In the box</h3>}>
                <ul className="shop-feat stack gap-1">
                  {product.inBox.map((it) => (
                    <li key={it}>
                      <Icon name="package" />
                      <span>{it}</span>
                    </li>
                  ))}
                </ul>
              </PhoneCollapse>
            </div>
          </div>
          <div className="stack gap-3">
            <PhoneCollapse className="pdp-collapse" summaryClassName="pdp-sum" summary={<h2 className="h3">Specifications</h2>}>
              <div className="card pad">
                <KeyValue pairs={product.specs.map(([k, v]) => [k, k === 'SKU' ? <span className="mono">{v}</span> : v])} />
              </div>
            </PhoneCollapse>
          </div>
        </section>

        {/* Reviews */}
        <section className="stack gap-5" id={hasReviews ? `${px}-reviews` : undefined} aria-labelledby={`${px}-rev-h`}>
          <h2 className="h2" id={`${px}-rev-h`}>
            Customer reviews
          </h2>
          {hasReviews ? (
            <div className="shop-two">
              <div className="stack gap-4">
                <div className="row gap-3 base">
                  <span className="display d-xl">{product.rating}</span>
                  <span className="stack gap-1">
                    <Stars5 rating={product.rating} className="u-fs-18" />
                    <span className="small sub">
                      {num(product.ratings)} ratings · {num(product.written)} written reviews
                    </span>
                  </span>
                </div>
                <div className="rating-bars">
                  {product.ratingBars.map(([star, pct]) => (
                    <RatingBar key={star} star={star} pct={pct} active={filter === `star-${star}`} onClick={() => setFilter(filter === `star-${star}` ? 'all' : `star-${star}`)} />
                  ))}
                </div>
                <Alert tone="info" title="About these reviews">
                  Product reviews describe the headphones. Feedback about a seller’s shipping and service is on each seller’s page, for example{' '}
                  <Link to={href('store/seller')} className="link-inline">
                    Northwind Audio feedback
                  </Link>
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
                {reviews.map((r) => {
                  const on = !!voted[r.id];
                  return (
                    <article key={r.id} className="shop-rev">
                      <div className="row gap-2">
                        <Avatar name={r.name} />
                        <span className="small strong">{r.name}</span>
                        {r.verified && (
                          <Badge tone="success" icon="circle-check">
                            Verified Purchase
                          </Badge>
                        )}
                      </div>
                      <div className="row gap-2">
                        <Stars5 rating={r.rating} size="md" />
                        <h3 className="h4">{r.title}</h3>
                      </div>
                      <span className="xs muted">
                        Reviewed {r.date} · Color: {r.color} · Sold by {r.soldBy}
                      </span>
                      <p className="small">{r.body}</p>
                      {r.reply && (
                        <div className="shop-reply">
                          <span className="xs strong">
                            Response from {r.reply.from} · {r.reply.date}
                          </span>
                          <span>{r.reply.body}</span>
                        </div>
                      )}
                      <div className="row gap-2">
                        <Button variant="ghost" size="sm" icon="thumbs-up" aria-pressed={on} onClick={() => setVoted((m) => ({ ...m, [r.id]: !on }))}>
                          Helpful ({r.helpful + (on ? 1 : 0)})
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          icon="flag"
                          disabled={reported[r.id]}
                          onClick={() => {
                            setReported((m) => ({ ...m, [r.id]: true }));
                            announce('Thanks. We’ll review this report.');
                          }}
                        >
                          {reported[r.id] ? 'Reported' : 'Report'}
                        </Button>
                      </div>
                    </article>
                  );
                })}
                {reviews.length === 0 && <p className="small sub u-pt-sp-3">No reviews match this filter.</p>}
                <a className="small strong u-pt-sp-3" href="#">
                  See all {num(product.written)} reviews <Icon name="arrow-right" className="ic-sm" />
                </a>
              </div>
            </div>
          ) : (
            <div className="shop-two">
              <div className="stack gap-3">
                <span className="h3">No reviews yet</span>
                <p className="small sub">This product was listed on Oct 6. We don’t show a star rating until customers who bought it have reviewed it.</p>
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
            <Button variant="secondary" size="sm" icon="message-circle-question">
              Ask a question
            </Button>
          </div>
          <PhoneCollapse className="pdp-collapse" summaryClassName="pdp-sum pdp-sum--more" summary="Show customer questions">
            <div className="toolbar">
              <SearchInput id={`${px}-qa-q`} placeholder={product.qaPlaceholder} value={qaQuery} onChange={setQaQuery} />
            </div>
            <div className="card pad stack gap-0">
              {questions.map((it) => (
                <div key={it.q} className="shop-qa">
                  <div className="row gap-2 top nowrap">
                    <span className="strong small none">Q:</span>
                    <span className="strong small">{it.q}</span>
                  </div>
                  {it.answers.map((a, i) => {
                    const role = QA_ROLE[a.role];
                    return (
                      <div key={i} className="a">
                        <div className="row gap-2">
                          <Badge tone={role.tone} icon={role.icon}>
                            {role.label}
                          </Badge>
                          <span className="xs muted">
                            {a.who} · {a.date}
                          </span>
                        </div>
                        <span>{a.body}</span>
                      </div>
                    );
                  })}
                  {it.pending && (
                    <div className="a">
                      <span className="xs muted">{it.pending}</span>
                    </div>
                  )}
                </div>
              ))}
              {questions.length === 0 && <p className="small sub">No questions match “{qaQuery.trim()}”.</p>}
            </div>
            <p className="xs muted">
              Answers are labeled Seller, Marketly staff or Customer so you know who is speaking.
              {product.qaOrderNote && (
                <>
                  {' '}
                  Questions about your own order go to{' '}
                  <Link to={href('account/messages')} className="link-inline">
                    order messages
                  </Link>
                  .
                </>
              )}
            </p>
          </PhoneCollapse>
        </section>

        {/* Related and sponsored */}
        <section className="stack gap-4" aria-labelledby={`${px}-rel`}>
          <div className="row between base">
            <h2 className="h2">
              <span id={`${px}-rel`}>Related products</span>
            </h2>
            <Link className="small strong" to={href('store/category')}>
              {product.relatedMore} <Icon name="arrow-right" className="ic-sm" />
            </Link>
          </div>
          <div className="grid-products wide">
            {product.related.map((p) => (
              <ProductCard key={p.name} p={p} showSeller from />
            ))}
          </div>
        </section>
        <section className="stack gap-4" aria-labelledby={`${px}-sp`}>
          <div className="row between base">
            <h2 className="h3" id={`${px}-sp`}>
              Sponsored products related to this item
            </h2>
            <Link className="xs" to={href('help/article')}>
              Why these ads?
            </Link>
          </div>
          <div className="grid-products wide">
            {product.sponsored.map((p) => (
              <ProductCard key={p.name} p={p} sponsored showSeller from />
            ))}
          </div>
        </section>
      </div>
    </StoreLayout>
  );
}

/** Price block of the buy box: sale copy for a featured sale, or the shipping total for a seller offer. */
function OfferPrice({ offer }: { offer: BuyOffer }) {
  const price = <Price amount={offer.price} was={offer.was} lg />;
  if (offer.saleEnds) {
    return (
      <div className="stack gap-1">
        {price}
        <span className="small t-deal-text strong">{offer.saleEnds}</span>
        {offer.wasNote && <span className="xs muted">{offer.wasNote}</span>}
      </div>
    );
  }
  if (offer.shippingNote) {
    return (
      <div className="stack gap-1">
        {price}
        <span className="small sub">
          + {money(offer.ship)} shipping · <b>{money(offer.price + offer.ship)}</b> before tax
        </span>
      </div>
    );
  }
  return price;
}

/** Card foot while another seller's offer is chosen: the featured offer, with a way back to it. */
function FeaturedFoot({ product, onChoose }: { product: ProductDetail; onChoose: () => void }) {
  const main = product.market.find((o) => o.main) ?? product.market[0];
  const s = sellers[main.seller];
  return (
    <div className="card-foot u-fd-column" style={{ justifyContent: 'stretch', alignItems: 'stretch' } as CSSProperties}>
      <span className="eyebrow">Featured offer</span>
      <div className="row between gap-2">
        <span className="stack gap-0">
          <span className="row gap-2">
            <b className="small">{s.name}</b>
            <SellerBadge seller={s} compact />
          </span>
          <span className="xs muted">
            {money(main.price)} · {main.ship === 0 ? `Free delivery ${main.delivery}` : `+ ${money(main.ship)} shipping`} · {main.returns}
          </span>
        </span>
        <Button variant="secondary" size="sm" onClick={onChoose}>
          Choose
        </Button>
      </div>
      <Link className="small strong" to={href('store/offers')}>
        See all {product.market.length} offers
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
