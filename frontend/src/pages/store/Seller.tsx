import { date } from '@marketly/web-shared/lib/dates';
import { useState, type MouseEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { AppbarSearch, StoreLayout } from '@/layouts';
import { useSession } from '@/app/session';
import NotFound from './NotFound';
import { AskSellerDialog } from './data/ask-seller';
import { useCollectionOffers, useStorefrontCollection, type CollectionOffer } from './data/collections';
import { useSignInHref } from './data/product';
import { ReportDialog } from './data/report-dialog';
import { Photo } from './data/review-parts';
import { ApiError, call, useApi } from '@marketly/web-shared/api';
import { dollars, num, percentOff } from '@marketly/web-shared/lib/format';
import { href } from '@marketly/web-shared/routes';
import { Alert, Badge, Button, Chip, ChipRow, CopyButton, EmptyState, Icon, KeyValue, Price, SearchInput, SellerBadge, Stars, Stat, Tabs } from '@marketly/web-shared/ui';
import { initialsOf, tintOf } from '@/api/catalog';
import { ApiProductCard, CardGridSkeleton, ListingPager, LoadError, LogoPic, SkLines } from '@/api/cards';
import { SortSelect, useListingParams } from '@/api/listing';
import { readPage, readQuery, toCardProduct, useFacets, useListing, useSearchClick } from '@/api/search';

// Design: pages/store/store-seller.html. Data: GET /api/store/sellers/stores/{slug} (header, about,
// highlights, verification, shipping and returns, promotion; closed store → 404), seller feedback
// GET /api/store/reviews/sellers/{sellerId}/feedback-summary and …/feedback, the product grid
// GET /api/store/search/products?seller={slug}&q&category&sort (+ /search/facets for the category chips).
// "Contact seller" starts a pre-sale conversation about one of the store's products
// (POST /api/store/messaging/product-conversations; signed-in customers, a visitor goes to sign-in first).
// Featured collections: cards from the storefront response; ?collection=<id> opens one above the
// product grid (GET …/stores/{slug}/collections/{collectionId}, its offers from data/collections.ts).
// "Report this seller" sends a Trust and Risk report (data/report-dialog.tsx; visitors sign in first).
// REST rather than the SellerStorefront screen query: that query would reload the whole storefront for
// every search keystroke, filter and page, and its product cards have no stock state or thumbUrl.

const PER_PAGE = 12;

type Tab = 'products' | 'feedback' | 'about';
const TAB_TARGET: Record<Tab, string> = { products: 'sl-all', feedback: 'sl-fb', about: 'sl-pol' };
const jump = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

const REPLY: Record<string, string> = { within_24h: 'Usually within 24 hours', within_48h: 'Usually within 2 days', within_12h: 'Usually within 12 hours' };
const monthYear = (d: string) => new Date(`${d.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const dayLabel = (d: string) => date(d);
const pct = (n: number | null | undefined) => (n == null ? '—' : `${Math.round(n)}%`);

export default function Seller() {
  const { slug = '' } = useParams();
  const { api } = useApi();
  const lp = useListingParams();
  const [tab, setTab] = useState<Tab>('products');
  const [allFeedback, setAllFeedback] = useState(false);
  const [askOpen, setAskOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const { signedIn } = useSession();
  const navigate = useNavigate();
  const signIn = useSignInHref();

  const store = useQuery({
    queryKey: ['sellers', 'store', slug],
    queryFn: () => call(api.GET('/api/store/sellers/stores/{slug}', { params: { path: { slug } } })),
  });
  const sellerId = store.data?.seller.id;
  const summary = useQuery({
    queryKey: ['reviews', 'seller-feedback-summary', sellerId],
    queryFn: () => call(api.GET('/api/store/reviews/sellers/{sellerId}/feedback-summary', { params: { path: { sellerId: sellerId! } } })),
    enabled: !!sellerId,
  });
  const feedback = useQuery({
    queryKey: ['reviews', 'seller-feedback', sellerId, { limit: allFeedback ? 50 : 3 }],
    queryFn: () => call(api.GET('/api/store/reviews/sellers/{sellerId}/feedback', { params: { path: { sellerId: sellerId! }, query: { page: 1, limit: allFeedback ? 50 : 3 } } })),
    enabled: !!sellerId,
  });
  const found = store.isSuccess;
  const base = useFacets({ seller: [slug] }, { enabled: found });
  const query = readQuery(lp.params, { seller: [slug] });
  const facets = useFacets(query, { enabled: found });
  const listing = useListing(query, readPage(lp.params), { limit: PER_PAGE, enabled: found });
  const onOpen = useSearchClick(facets.data?.searchId);

  if (store.error instanceof ApiError && store.error.status === 404) return <NotFound />;

  const s = store.data;
  const seller = s?.seller;
  const name = seller?.storeName ?? '';
  const hl = s?.highlights;
  const ship = s?.shipping;
  const ret = s?.returns;
  const contact = s?.contact;
  const promo = s?.promotion ?? null;
  const collections = (s?.collections ?? []).filter((c) => c.visible && c.itemCount > 0);
  const openCollection = lp.params.get('collection');
  const chips = base.data?.facets.find((f) => f.kind === 'category')?.values ?? [];
  const chip = lp.params.get('category') ?? '';
  const q = lp.params.get('q') ?? '';
  const ratingCount = summary.data?.count ?? seller?.ratingCount ?? 0;
  const error = store.error ?? facets.error ?? listing.error;

  // Products the customer can ask about: this store's offers in the loaded grid.
  const askOffers = listing.hits
    .filter((h) => h.product.sellerSlug === slug && h.product.offerId)
    .map((h) => ({ offerId: h.product.offerId!, title: h.product.variantCue ? `${h.product.title} (${h.product.variantCue})` : h.product.title }));
  const contactSeller = () => (signedIn ? setAskOpen(true) : navigate(signIn()));
  const openTab = (t: Tab) => {
    setTab(t);
    jump(TAB_TARGET[t]);
  };
  const toAll = (e?: MouseEvent) => {
    e?.preventDefault();
    jump('sl-all');
  };
  const setParam = (k: string, v: string, replace = false) =>
    lp.update(
      (p) => {
        if (v) p.set(k, v);
        else p.delete(k);
      },
      { replace },
    );

  const policies: Array<[string, string]> = [
    ['Ships from', ship?.shipsFrom ?? ''],
    ['Ships to', ship?.shipsTo ?? ''],
    ['Dispatch', ship?.dispatch ?? seller?.dispatchLabel ?? ''],
    ['Carriers', (ship?.carriers ?? []).join(', ')],
    ['Returns', [ret?.window, ret?.returnShipping].filter(Boolean).join(' · ')],
    ['Warranty', ret?.warranty ?? s?.warranty ?? ''],
    ['Replies', contact?.replyTarget ? (REPLY[contact.replyTarget] ?? contact.replyTarget.replace(/_/g, ' ')) : ''],
  ];
  const reportSeller = () => (signedIn ? setReportOpen(true) : navigate(signIn()));

  return (
    <StoreLayout
      appbar={{
        title: name || 'Store',
        back: href('store/home'),
        // phone: the store search lives in the app bar; typing the first letter scrolls to the products
        actions: (
          <AppbarSearch
            id="sl-mq"
            label="Search this store"
            value={q}
            onChange={(v) => {
              if (v && !q) toAll();
              setParam('q', v, true);
            }}
            onSubmit={() => toAll()}
          />
        ),
      }}
    >
      <div className="container page gap-6">
        {error ? (
          <LoadError
            error={error}
            onRetry={() => {
              void store.refetch();
              void facets.refetch();
              listing.refetch();
            }}
            title="We couldn’t load this store"
          />
        ) : null}
        {s && !s.sellingNow && (
          <Alert tone="warning" title="This store isn’t selling right now">
            You can still read its feedback and policies. Orders you already placed are not affected.
          </Alert>
        )}
        <section className="shop-hero" aria-labelledby="sl-h">
          <div className="ban tint-2">
            {s?.banner && <img src={s.banner.url} alt="" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />}
            {s?.tagline && (
              <span className="shop-ban-t" style={s.banner ? { position: 'relative' } : undefined}>
                {s.tagline}
              </span>
            )}
          </div>
          <div className="id">
            <LogoPic logo={seller?.logo} initials={initialsOf(name || '?')} tint={tintOf(name)} className="lg" />
            <div className="stack gap-1 grow minw-200">
              {seller ? (
                <>
                  <div className="row gap-2">
                    <h1 className="h1" id="sl-h">
                      {name}
                    </h1>
                    <SellerBadge seller={{ verified: seller.verified }} />
                  </div>
                  <div className="row gap-3 small sub">
                    <span>
                      {summary.data?.average != null && <Stars rating={summary.data.average} />}{' '}
                      {seller.positivePct != null ? (
                        <>
                          <b>{Math.round(seller.positivePct)}% positive</b> ({num(ratingCount)} ratings)
                        </>
                      ) : (
                        'No ratings yet'
                      )}
                    </span>
                    {seller.location && (
                      <span>
                        <Icon name="map-pin" className="ic-sm" /> {seller.location}
                      </span>
                    )}
                    {seller.dispatchLabel && (
                      <span>
                        <Icon name="clock" className="ic-sm" /> {seller.dispatchLabel.split(' · ')[0]}
                      </span>
                    )}
                    <span>Selling on Marketly since {monthYear(s!.sellingSince)}</span>
                  </div>
                </>
              ) : (
                <>
                  <h1 className="h1 sr-only" id="sl-h">
                    Store
                  </h1>
                  <SkLines n={2} />
                </>
              )}
            </div>
            <div className="row gap-2">
              <Button
                variant="secondary"
                icon="message-square"
                disabled={!s || contact?.canMessage === false || (signedIn && askOffers.length === 0)}
                title={contact?.canMessage === false ? 'This seller isn’t taking messages right now.' : undefined}
                onClick={contactSeller}
              >
                Contact seller
              </Button>
              <CopyButton text={typeof window !== 'undefined' ? window.location.href : href('store/seller', '', { slug })} label="Share store" icon="share-2" />
              <Button variant="ghost" icon="flag" disabled={!seller} onClick={reportSeller}>
                Report
                <span className="sr-only"> this seller</span>
              </Button>
            </div>
          </div>
          {s?.introduction && <p className="small sub measure-lg u-p-0-sp-5-sp-5">{s.introduction}</p>}
        </section>

        <div className="split">
          <div className="stack gap-6">
            <Tabs<Tab>
              items={[
                { value: 'products', label: 'Products', count: s ? num(s.productCount) : undefined },
                { value: 'feedback', label: 'Feedback', count: num(ratingCount) },
                { value: 'about', label: 'About and policies' },
              ]}
              active={tab}
              onChange={openTab}
            />
            {openCollection ? (
              <CollectionView slug={slug} collectionId={openCollection} storeName={name} onClose={() => setParam('collection', '')} />
            ) : (
              collections.length > 0 && (
                <section className="stack gap-3" aria-labelledby="sl-col">
                  <h2 className="h3" id="sl-col">
                    Featured collections
                  </h2>
                  <div className="shop-collections">
                    {collections.map((c) => (
                      <Link key={c.id} className="shop-coll" to={href('store/seller', '', { slug }, { collection: c.id })}>
                        <Photo media={c.image} icon="layers" className="tint-2" />
                        <span className="stack gap-1">
                          <span className="strong">{c.title}</span>
                          <span className="xs muted">
                            {num(c.itemCount)} product{c.itemCount === 1 ? '' : 's'}
                          </span>
                        </span>
                      </Link>
                    ))}
                  </div>
                </section>
              )
            )}
            {promo?.title && (
              <div className="shop-promo">
                <Icon name="ticket-percent" />
                <div className="stack gap-0 grow">
                  <span className="strong">{promo.title}</span>
                  {promo.detail && <span className="xs sub">{promo.detail}</span>}
                </div>
                <Button variant="secondary" size="sm" onClick={() => toAll()}>
                  Shop eligible items
                </Button>
              </div>
            )}

            <section className="stack gap-4" aria-labelledby="sl-all">
              <h2 className="h3" id="sl-all">
                All products{s ? ` (${num(s.productCount)})` : ''}
              </h2>
              {chips.length > 1 && (
                <ChipRow>
                  <Chip active={!chip} onClick={() => setParam('category', '')}>
                    All
                  </Chip>
                  {chips.map((c) => (
                    <Chip key={c.value} active={chip === c.value} onClick={() => setParam('category', c.value)}>
                      {`${c.label} (${num(c.count)})`}
                    </Chip>
                  ))}
                </ChipRow>
              )}
              <div className="shop-toolbar">
                <SearchInput id="sl-q" className="no-phone" placeholder="Search this store" value={q} onChange={(v) => setParam('q', v, true)} />
                <span className="shop-sort">
                  <label className="small sub nowrap" htmlFor="sl-sort">
                    Sort by
                  </label>
                  <SortSelect id="sl-sort" ctx={facets.data} lp={lp} />
                </span>
              </div>
              {listing.isPending || store.isPending ? (
                <CardGridSkeleton n={8} />
              ) : listing.hits.length > 0 ? (
                <div className="grid-products" aria-busy={listing.isFetching || undefined}>
                  {listing.hits.map((h) => (
                    <ApiProductCard key={`${h.kind}-${h.position}-${h.product.productId}`} c={toCardProduct(h.product, h)} from onOpen={onOpen} />
                  ))}
                </div>
              ) : !error ? (
                <EmptyState
                  icon="search-x"
                  title={q || chip ? 'No products in this store match your search' : 'This store has no products in stock right now'}
                  action={
                    q || chip ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() =>
                          lp.update((p) => {
                            p.delete('q');
                            p.delete('category');
                          })
                        }
                      >
                        Clear search
                      </Button>
                    ) : undefined
                  }
                >
                  {q || chip ? 'Try a different word, or search all of Marketly from the search bar.' : 'New listings show up here as soon as they are in stock.'}
                </EmptyState>
              ) : null}
              <div className="row end">
                <ListingPager listing={listing} onPage={lp.setPage} />
              </div>
            </section>

            <section className="card" aria-labelledby="sl-fb">
              <div className="card-head">
                <div className="stack gap-0">
                  <h2 className="h3" id="sl-fb">
                    Seller feedback
                  </h2>
                  <span className="xs muted">About shipping, packaging and communication. Product reviews are on each product page.</span>
                </div>
                {!allFeedback && (feedback.data?.total ?? 0) > (feedback.data?.items.length ?? 0) && (
                  <a
                    className="small strong"
                    href="#"
                    onClick={(e) => {
                      e.preventDefault();
                      setAllFeedback(true);
                    }}
                  >
                    See all {num(feedback.data!.total ?? 0)}
                  </a>
                )}
              </div>
              <div className="card-body">
                <div className="grid md3 gap-4">
                  <Stat label={`Positive, last ${summary.data?.periodMonths ?? 12} months`} value={pct(summary.data?.positivePct ?? hl?.positivePct)} note={summary.data?.label ?? `${num(ratingCount)} ratings`} />
                  <Stat label="On-time dispatch" value={pct(hl?.onTimeDispatchPct ?? summary.data?.onTimeDispatchPct)} note={hl?.onTimeDispatchPct == null ? 'Not enough orders yet' : 'Last 90 days'} />
                  <Stat label="Replies within 24 h" value={pct(hl?.repliesWithin24hPct)} note={hl?.medianReplyHours != null ? `Median ${Math.round(hl.medianReplyHours)} h` : 'Not enough messages yet'} />
                </div>
                {feedback.isPending ? (
                  <SkLines n={3} />
                ) : feedback.isError ? (
                  <LoadError error={feedback.error} onRetry={() => void feedback.refetch()} title="We couldn’t load the feedback" />
                ) : (feedback.data?.items.length ?? 0) === 0 ? (
                  <p className="small muted">No feedback yet.</p>
                ) : (
                  <ul className="list">
                    {feedback.data!.items.map((f) => (
                      <li key={f.id} className="items-start">
                        <div className="stack gap-1 grow">
                          <div className="row gap-2">
                            {f.sentiment === 'positive' ? (
                              <Badge tone="success" icon="thumbs-up">
                                Positive
                              </Badge>
                            ) : f.sentiment === 'negative' ? (
                              <Badge tone="danger" icon="thumbs-down">
                                Negative
                              </Badge>
                            ) : (
                              <Badge>Neutral</Badge>
                            )}
                            <span className="xs muted">
                              {[f.author.displayName, dayLabel(f.postedAt), f.itemTitle ? `Item: ${f.itemTitle}` : null].filter(Boolean).join(' · ')}
                            </span>
                          </div>
                          {f.comment && <p className="small">{f.comment}</p>}
                          {f.response && (
                            <div className="shop-reply">
                              <span className="xs strong">{f.response.fromName} replied</span>
                              <span>{f.response.text}</span>
                            </div>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </section>
          </div>

          <aside className="stack gap-4">
            <section className="card" aria-labelledby="sl-ver">
              <div className="card-head">
                <h2 className="h4 row gap-2" id="sl-ver">
                  <Icon name="shield-check" /> What we verified
                </h2>
              </div>
              <div className="card-body shop-verify">
                {s ? (
                  <>
                    <p className="small sub">{s.verification.state === 'verified' ? 'Verified seller means Marketly checked these details before approving the store:' : 'Marketly checks these details for every approved store:'}</p>
                    <ul>
                      {s.verification.checked.map((v) => (
                        <li key={v}>
                          <Icon name="circle-check" />
                          <span>{v}</span>
                        </li>
                      ))}
                      {s.verification.notChecked.map((v, i) => (
                        <li key={v} className="no">
                          <Icon name="circle-minus" />
                          <span>
                            <b>Not checked:</b> {v}
                            {i === 0 && (
                              <>
                                . If something looks wrong,{' '}
                                <button type="button" className="btn-bare link-inline" onClick={reportSeller}>
                                  report this seller
                                </button>
                                .
                              </>
                            )}
                          </span>
                        </li>
                      ))}
                    </ul>
                    {s.verification.lastCheckedAt && <span className="xs muted">Last checked {dayLabel(s.verification.lastCheckedAt)}</span>}
                  </>
                ) : (
                  <SkLines n={4} />
                )}
              </div>
            </section>
            <section className="card" aria-labelledby="sl-pol">
              <div className="card-head">
                <h2 className="h4" id="sl-pol">
                  Shipping and returns
                </h2>
              </div>
              <div className="card-body">{s ? <KeyValue pairs={policies.filter(([, v]) => v)} /> : <SkLines n={5} />}</div>
            </section>
            <p className="xs muted">
              Marketly support steps in if a seller doesn’t resolve a problem.{' '}
              <Link to={href('help/center')} className="link-inline">
                How buyer protection works
              </Link>
            </p>
          </aside>
        </div>
      </div>
      <AskSellerDialog open={askOpen} onClose={() => setAskOpen(false)} sellerName={name} offers={askOffers} />
      {seller && <ReportDialog open={reportOpen} onClose={() => setReportOpen(false)} targets={[{ kind: 'seller', id: seller.id, label: name }]} />}
    </StoreLayout>
  );
}

/**
 * One featured collection (?collection=<id>): its title and the products in it, each opening the
 * product page with this store's offer chosen. A hidden or removed collection (404) says so.
 */
function CollectionView({ slug, collectionId, storeName, onClose }: { slug: string; collectionId: string; storeName: string; onClose: () => void }) {
  const collection = useStorefrontCollection(slug, collectionId);
  const offers = useCollectionOffers(slug, collectionId);
  const c = collection.data;
  const gone = collection.error instanceof ApiError && collection.error.status === 404;
  const error = gone ? null : (collection.error ?? offers.error);
  const items = offers.data ?? [];

  return (
    <section className="card" aria-labelledby="sl-coll-h">
      <div className="card-head">
        <div className="row gap-3 nowrap min-w-0">
          {c && (
            <span className="none" style={{ width: '56px' }}>
              <Photo media={c.image} icon="layers" className="tint-2" />
            </span>
          )}
          <div className="stack gap-0 min-w-0">
            <span className="xs muted">Collection from {storeName || 'this store'}</span>
            <h2 className="h3" id="sl-coll-h">
              {c?.title ?? (gone ? 'Collection not available' : 'Collection')}
            </h2>
          </div>
        </div>
        <Button variant="ghost" size="sm" icon="arrow-left" onClick={onClose}>
          All products
        </Button>
      </div>
      <div className="card-body">
        {gone ? (
          <EmptyState icon="layers" title="This collection isn’t available any more">
            The seller may have removed or hidden it. Their other products are below.
          </EmptyState>
        ) : error ? (
          <LoadError
            error={error}
            onRetry={() => {
              void collection.refetch();
              void offers.refetch();
            }}
            title="We couldn’t load this collection"
          />
        ) : collection.isPending || offers.isPending ? (
          <CardGridSkeleton n={4} />
        ) : items.length === 0 ? (
          <EmptyState icon="package" title="Nothing in this collection is for sale right now">
            The products in it are out of stock or paused. Check back later.
          </EmptyState>
        ) : (
          <>
            <span className="xs muted">
              {num(items.length)} product{items.length === 1 ? '' : 's'}
              {c && c.offerCount > items.length ? ` · ${num(c.offerCount - items.length)} not available right now` : ''}
            </span>
            <div className="grid-products">
              {items.map((o) => (
                <CollectionCard key={o.id} o={o} />
              ))}
            </div>
          </>
        )}
      </div>
    </section>
  );
}

/** Product card (.pcard) for an offer in a collection: this store's price, linking to its offer. */
function CollectionCard({ o }: { o: CollectionOffer }) {
  const p = o.product;
  const to = href('store/product', 'seller-offer-selected', { slug: p.slug || 'product', id: p.id }, { offer: o.id });
  const price = dollars(o.deal?.price ?? o.price);
  const was = o.deal?.wasPrice ? dollars(o.deal.wasPrice) : null;
  const off = percentOff(price, was);
  const rating = p.reviewSummary?.hasReviews ? p.reviewSummary : null;
  return (
    <article className="pcard">
      <div className="pcard-media">
        <Link to={to} aria-label={p.title}>
          <Photo media={p.images[0]} icon="package" />
        </Link>
        {off > 0 && (
          <div className="tags">
            <Badge tone="deal">−{off}%</Badge>
          </div>
        )}
      </div>
      <Link className="name" to={to}>
        {p.title}
      </Link>
      {rating?.average != null && <Stars rating={rating.average} count={rating.ratingCount} />}
      <Price amount={price} was={was} noOff />
    </article>
  );
}
