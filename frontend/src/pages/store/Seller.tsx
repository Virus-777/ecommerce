import { useState, type MouseEvent } from 'react';
import { Link, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { StoreLayout } from '@/layouts';
import NotFound from './NotFound';
import { ApiError, call, useApi } from '@marketly/web-shared/api';
import { num } from '@marketly/web-shared/lib/format';
import { href } from '@marketly/web-shared/routes';
import { Alert, Badge, Button, Chip, ChipRow, CopyButton, EmptyState, Icon, IconButton, KeyValue, SearchInput, SellerBadge, Stars, Stat, Tabs } from '@marketly/web-shared/ui';
import { initialsOf, tintOf } from '@/api/catalog';
import { ApiProductCard, CardGridSkeleton, ListingPager, LoadError, LogoPic, SkLines } from '@/api/cards';
import { SortSelect, useListingParams } from '@/api/listing';
import { readPage, readQuery, toCardProduct, useFacets, useListing, useSearchClick } from '@/api/search';

// Design: pages/store/store-seller.html. Data: GET /api/store/sellers/stores/{slug} (header, about,
// highlights, verification, shipping and returns, promotion; closed store → 404), seller feedback
// GET /api/store/reviews/sellers/{sellerId}/feedback-summary and …/feedback, the product grid
// GET /api/store/search/products?seller={slug}&q&category&sort (+ /search/facets for the category chips).
// Not shown: featured collections (REST gives offer ids only, no product cards) and messaging the
// seller without an order (gap G4).

const PER_PAGE = 12;

type Tab = 'products' | 'feedback' | 'about';
const TAB_TARGET: Record<Tab, string> = { products: 'sl-all', feedback: 'sl-fb', about: 'sl-pol' };
const jump = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

// Storefront fields typed `unknown` in the API spec (shapes from GET /api/store/sellers/stores/{slug}).
interface Highlights {
  positivePct?: number | null;
  ratingCount?: number | null;
  onTimeDispatchPct?: number | null;
  repliesWithin24hPct?: number | null;
  medianReplyHours?: number | null;
}
interface Shipping {
  shipsFrom?: string | null;
  shipsTo?: string | null;
  dispatch?: string | null;
  carriers?: string[];
}
interface Returns {
  window?: string | null;
  returnShipping?: string | null;
  warranty?: string | null;
}
interface Contact {
  canMessage?: boolean;
  replyTarget?: string | null;
}
interface Promotion {
  title?: string;
  detail?: string;
}

const REPLY: Record<string, string> = { within_24h: 'Usually within 24 hours', within_48h: 'Usually within 2 days', within_12h: 'Usually within 12 hours' };
const monthYear = (d: string) => new Date(`${d.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const dayLabel = (d: string) => new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Los_Angeles' });
const pct = (n: number | null | undefined) => (n == null ? '—' : `${Math.round(n)}%`);

export default function Seller() {
  const { slug = '' } = useParams();
  const { api } = useApi();
  const lp = useListingParams();
  const [tab, setTab] = useState<Tab>('products');
  const [allFeedback, setAllFeedback] = useState(false);

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
  const hl = (s?.highlights ?? {}) as Highlights;
  const ship = (s?.shipping ?? {}) as Shipping;
  const ret = (s?.returns ?? {}) as Returns;
  const contact = (s?.contact ?? {}) as Contact;
  const promo = (s?.promotion ?? null) as Promotion | null;
  const chips = base.data?.facets.find((f) => f.kind === 'category')?.values ?? [];
  const chip = lp.params.get('category') ?? '';
  const q = lp.params.get('q') ?? '';
  const ratingCount = summary.data?.count ?? seller?.ratingCount ?? 0;
  const error = store.error ?? facets.error ?? listing.error;

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
    ['Ships from', ship.shipsFrom ?? ''],
    ['Ships to', ship.shipsTo ?? ''],
    ['Dispatch', ship.dispatch ?? seller?.dispatchLabel ?? ''],
    ['Carriers', (ship.carriers ?? []).join(', ')],
    ['Returns', [ret.window, ret.returnShipping].filter(Boolean).join(' · ')],
    ['Warranty', ret.warranty ?? s?.warranty ?? ''],
    ['Replies', contact.replyTarget ? (REPLY[contact.replyTarget] ?? contact.replyTarget.replace(/_/g, ' ')) : ''],
  ];

  return (
    <StoreLayout
      appbar={{
        title: name || 'Store',
        back: href('store/home'),
        actions: <IconButton icon="search" label="Search this store" onClick={() => document.getElementById('sl-q')?.focus()} />,
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
              {/* Messaging needs an order (POST messaging/conversations requires orderId; gap G4). */}
              <Button variant="secondary" icon="message-square" disabled title="Message a seller from one of your orders. Questions about a product go to its Questions and answers.">
                Contact seller
              </Button>
              <CopyButton text={typeof window !== 'undefined' ? window.location.href : href('store/seller', '', { slug })} label="Share store" icon="share-2" />
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
                <SearchInput id="sl-q" placeholder="Search this store" value={q} onChange={(v) => setParam('q', v, true)} />
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
                  <Stat label={`Positive, last ${summary.data?.periodMonths ?? 12} months`} value={pct(summary.data?.positivePct ?? hl.positivePct)} note={summary.data?.label ?? `${num(ratingCount)} ratings`} />
                  <Stat label="On-time dispatch" value={pct(hl.onTimeDispatchPct ?? summary.data?.onTimeDispatchPct)} note={hl.onTimeDispatchPct == null ? 'Not enough orders yet' : 'Last 90 days'} />
                  <Stat label="Replies within 24 h" value={pct(hl.repliesWithin24hPct)} note={hl.medianReplyHours != null ? `Median ${Math.round(hl.medianReplyHours)} h` : 'Not enough messages yet'} />
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
                                . If a listing looks wrong,{' '}
                                <Link to={href('help/contact')} className="link-inline">
                                  report it
                                </Link>
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
    </StoreLayout>
  );
}
