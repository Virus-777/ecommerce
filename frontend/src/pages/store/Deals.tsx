import { useState, type CSSProperties } from 'react';
import { Link, useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { StoreLayout } from '@/layouts';
import { useSession } from '@/app/session';
import { call, errorMessage, useApi, type components } from '@marketly/web-shared/api';
import { dollars, money } from '@marketly/web-shared/lib/format';
import { href } from '@marketly/web-shared/routes';
import { Badge, Button, Countdown, Dialog, EmptyState, Icon, Meter, Price, Tabs, announce } from '@marketly/web-shared/ui';
import { ApiProductCard, CardGridSkeleton, LoadError, Pic, SkLines } from '@/api/cards';
import { OFFICIAL_STORE_ID } from '@marketly/web-shared/config';
import { productHref, useProductCards, type SearchCard, type StoreCard } from '@/api/search';

// Design: pages/store/store-deals.html. Data: GET /api/store/promotions/deals?tab= (tabs with counts,
// flash sales with live meters, coupons, clearance, upcoming events, rules; deal items name their seller's
// store slug); deal items are filled in with GET /api/store/search/cards (product slugs, ratings, delivery:
// flash and clearance items carry no product slug). Clip/unclip a coupon
// (POST/DELETE /api/store/promotions/coupons/{campaignId}/clip) and event reminders
// (POST/DELETE /api/store/promotions/events/{campaignId}/reminder) need a signed-in customer; "Eligible items"
// lists GET /api/store/promotions/campaigns/{id}/eligible-products.

type DealTab = 'all' | 'flash' | 'clearance' | 'coupons' | 'events';
type FlashItem = components['schemas']['promotions.FlashItem'];
type DealProduct = components['schemas']['promotions.DealProduct'];
type Coupon = components['schemas']['promotions.CouponCard'];

const TAB_ORDER: DealTab[] = ['all', 'flash', 'clearance', 'coupons', 'events'];
const dateLabel = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Los_Angeles' });
const timeLabel = (iso: string) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles' });

/** A clearance product as a store card (the deal gives price and seller; search cards give product slug, rating, delivery). */
function dealToCard(d: DealProduct, c: SearchCard | undefined): StoreCard {
  return {
    id: d.productId,
    slug: c?.slug ?? '',
    title: d.title,
    image: d.image ?? c?.image ?? null,
    icon: 'package',
    tint: '1',
    price: d.price,
    was: d.wasPrice ?? null,
    from: false,
    rating: c?.rating ?? null,
    ratingCount: c?.ratingCount ?? 0,
    delivery: c?.deliveryCue?.replace(/^Arrives\s+/i, '') ?? null,
    free: c?.freeDelivery ?? false,
    seller: { name: d.sellerName, official: c?.official ?? false, slug: d.sellerSlug },
  };
}

function EligibleItems({ coupon, onClose }: { coupon: Coupon; onClose: () => void }) {
  const { api } = useApi();
  const items = useQuery({
    queryKey: ['promotions', 'eligible-products', coupon.campaignId],
    queryFn: () => call(api.GET('/api/store/promotions/campaigns/{id}/eligible-products', { params: { path: { id: coupon.campaignId }, query: { page: 1, limit: 50 } } })),
  });
  const cards = useProductCards(items.data?.items.map((i) => i.productId) ?? []);
  return (
    <Dialog open onClose={onClose} title={`Eligible items: ${coupon.title}`}>
      {items.isPending ? (
        <SkLines n={4} />
      ) : items.isError ? (
        <LoadError error={items.error} onRetry={() => void items.refetch()} />
      ) : items.data.items.length === 0 ? (
        <p className="small muted">{coupon.conditions}</p>
      ) : (
        <ul className="list">
          {items.data.items.map((d) => (
            <li key={d.offerId}>
              <Link className="row gap-3 nowrap link-plain grow" to={productHref({ id: d.productId, slug: cards.data?.get(d.productId)?.slug })}>
                <Pic image={d.image} className="tiny" />
                <span className="stack gap-0">
                  <span className="small strong truncate">{d.title}</span>
                  <span className="xs muted">
                    {money(dollars(d.price))} · {d.sellerName}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}

export default function Deals() {
  const { api } = useApi();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { signedIn } = useSession();
  const [tab, setTab] = useState<DealTab>('all');
  const [eligible, setEligible] = useState<Coupon | null>(null);
  const [actionError, setActionError] = useState('');

  const deals = useQuery({
    queryKey: ['promotions', 'deals', tab],
    queryFn: () => call(api.GET('/api/store/promotions/deals', { params: { query: { tab } } })),
  });
  const d = deals.data;
  const flashItems = (d?.flashSales ?? []).flatMap((f) => f.items);
  const cards = useProductCards([...flashItems.map((i) => i.productId), ...(d?.clearance ?? []).map((c) => c.productId)]);
  const card = (id: string) => cards.data?.get(id);
  const show = (t: DealTab) => tab === 'all' || tab === t;
  const refresh = () => void qc.invalidateQueries({ queryKey: ['promotions'] });
  const requireSignIn = () => {
    navigate(href('auth/sign-in'));
    return false;
  };

  const clip = useMutation({
    mutationFn: ({ c, on }: { c: Coupon; on: boolean }) =>
      on
        ? call(api.POST('/api/store/promotions/coupons/{campaignId}/clip', { params: { path: { campaignId: c.campaignId } } }))
        : call(api.DELETE('/api/store/promotions/coupons/{campaignId}/clip', { params: { path: { campaignId: c.campaignId } } })),
    onSuccess: (_r, { c, on }) => {
      setActionError('');
      announce(on ? `Coupon clipped: ${c.title}. It applies automatically at checkout.` : `Coupon removed: ${c.title}.`);
      refresh();
    },
    onError: (e) => setActionError(errorMessage(e)),
  });
  const remind = useMutation({
    mutationFn: ({ id, on }: { id: string; name: string; on: boolean }) =>
      on
        ? call(api.POST('/api/store/promotions/events/{campaignId}/reminder', { params: { path: { campaignId: id } } }))
        : call(api.DELETE('/api/store/promotions/events/{campaignId}/reminder', { params: { path: { campaignId: id } } })),
    onSuccess: (_r, { name, on }) => {
      setActionError('');
      announce(on ? `We'll remind you when ${name} starts.` : `Reminder removed for ${name}.`);
      refresh();
    },
    onError: (e) => setActionError(errorMessage(e)),
  });

  const tabs = TAB_ORDER.map((k) => {
    const t = d?.tabs.find((x) => x.key === k);
    return { value: k, label: t?.label ?? { all: 'All deals', flash: 'Flash sales', clearance: 'Clearance', coupons: 'Coupons', events: 'Upcoming events' }[k], count: t?.count };
  });
  const clearanceCount = d?.tabs.find((t) => t.key === 'clearance')?.count ?? 0;
  const empty = d && !d.flashSales.length && !d.coupons.length && !d.clearance.length && !d.upcomingEvents.length;

  return (
    <StoreLayout nav="deals" tab="deals">
      <div className="container page gap-6">
        <div className="stack gap-2">
          <h1 className="h1">Deals</h1>
          <p className="small sub">Every deal names the seller whose offer it applies to. A deal price is valid only for that offer, until the end time or until deal stock runs out.</p>
        </div>
        <Tabs<DealTab> items={tabs} active={tab} onChange={setTab} label="Deal types" />
        {actionError && (
          <p className="small t-danger-text" role="alert">
            {actionError}
          </p>
        )}
        {deals.isError && <LoadError error={deals.error} onRetry={() => void deals.refetch()} title="We couldn’t load the deals" />}
        {deals.isPending && <CardGridSkeleton n={5} wide />}
        {empty && (
          <EmptyState icon="tag" title="No deals here right now" as="h2">
            New flash sales, coupons and clearance prices show up here as soon as they start.
          </EmptyState>
        )}

        {d &&
          show('flash') &&
          d.flashSales.map((f) => (
            <section key={f.campaignId} className="shop-flash" aria-labelledby={`dl-flash-${f.campaignId}`}>
              <div className="row between">
                <div className="stack gap-1">
                  <h2 className="h2 row gap-2 u-c-deal-text" id={`dl-flash-${f.campaignId}`}>
                    <Icon name="zap" /> {f.name || 'Flash sale'}
                  </h2>
                  <span className="small sub">{f.period.display}</span>
                </div>
                {f.state === 'live' ? (
                  <span className="row gap-2 small sub">
                    Ends in <Countdown seconds={f.secondsLeft} />
                  </span>
                ) : f.state === 'upcoming' ? (
                  <span className="row gap-2 small sub">
                    Starts in <Countdown seconds={f.secondsLeft} />
                  </span>
                ) : (
                  <Badge>Ended</Badge>
                )}
              </div>
              <div className="shop-dgrid">
                {f.items.map((it) => (
                  <FlashCard key={it.id} d={it} slug={card(it.productId)?.slug} />
                ))}
              </div>
            </section>
          ))}

        {d && show('coupons') && d.coupons.length > 0 && (
          <section className="stack gap-4" aria-labelledby="dl-cp">
            <div className="row between base">
              <h2 className="h2">
                <span id="dl-cp">Coupons</span>
              </h2>
              <Link className="small strong" to={href('account/coupons')}>
                My coupons <Icon name="arrow-right" className="ic-sm" />
              </Link>
            </div>
            <div className="shop-coupons">
              {d.coupons.map((c) => (
                <article key={c.campaignId} className="shop-coupon">
                  <div className="amt">
                    {c.amountLabel}
                    <span>{c.unitLabel}</span>
                  </div>
                  <div className="body">
                    <span className="strong">{c.title}</span>
                    <span className="xs sub">{c.conditions}</span>
                    <span className="xs muted">
                      Expires {dateLabel(c.expiresAt)} · Funded by {c.fundedBy}
                    </span>
                    <div className="row gap-2">
                      {c.state === 'clipped' ? (
                        <>
                          <Badge tone="success" icon="check">
                            Clipped
                          </Badge>
                          <span className="xs muted">Applies automatically at checkout</span>
                        </>
                      ) : c.state === 'used' ? (
                        <Badge>Used</Badge>
                      ) : c.state === 'expired' ? (
                        <Badge>Expired</Badge>
                      ) : c.autoApply ? (
                        <span className="xs muted">Applies automatically at checkout</span>
                      ) : c.code ? (
                        <span className="xs muted">
                          Enter code <b className="mono">{c.code}</b> at checkout
                        </span>
                      ) : (
                        <Button variant="soft" size="sm" icon="scissors" disabled={clip.isPending} onClick={() => (signedIn ? clip.mutate({ c, on: true }) : requireSignIn())}>
                          Clip coupon
                        </Button>
                      )}
                      <a
                        className="xs"
                        href="#"
                        onClick={(e) => {
                          e.preventDefault();
                          setEligible(c);
                        }}
                      >
                        Eligible items
                      </a>
                    </div>
                  </div>
                </article>
              ))}
            </div>
            {d.rules.length > 0 && <p className="xs muted">{d.rules.slice(0, 2).join(' ')}</p>}
          </section>
        )}

        {d && show('clearance') && d.clearance.length > 0 && (
          <section className="stack gap-4" aria-labelledby="dl-cl">
            <div className="row between base">
              <h2 className="h2">
                <span id="dl-cl">Clearance</span>
              </h2>
              {tab === 'all' && clearanceCount > d.clearance.length && (
                <a
                  className="small strong"
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    setTab('clearance');
                  }}
                >
                  See all {clearanceCount} <Icon name="arrow-right" className="ic-sm" />
                </a>
              )}
            </div>
            <p className="small sub" style={{ marginTop: 'calc(-1 * var(--sp-2))' } as CSSProperties}>
              Clearance prices last while the listed seller’s current stock lasts. Normal return terms apply.
            </p>
            <div className="grid-products wide">
              {d.clearance.map((p) => (
                <ApiProductCard key={p.offerId} c={dealToCard(p, card(p.productId))} from showSeller />
              ))}
            </div>
          </section>
        )}

        {d && show('events') && d.upcomingEvents.length > 0 && (
          <section className="card" aria-labelledby="dl-up">
            <div className="card-head">
              <h2 className="h3" id="dl-up">
                Upcoming events
              </h2>
              <span className="xs muted">Times in Pacific Time</span>
            </div>
            <ul className="list pad">
              {d.upcomingEvents.map((ev) => {
                const start = new Date(ev.period.startsAt);
                return (
                  <li key={ev.campaignId}>
                    <div className="shop-event grow">
                      <span className="shop-date">
                        <span className="m">{start.toLocaleDateString('en-US', { month: 'short', timeZone: 'America/Los_Angeles' })}</span>
                        <span className="d">{start.toLocaleDateString('en-US', { day: 'numeric', timeZone: 'America/Los_Angeles' })}</span>
                      </span>
                      <span className="stack gap-0 grow minw-200">
                        <span className="strong">{ev.name}</span>
                        <span className="xs muted">{[ev.period.display, ev.summary].filter(Boolean).join(' · ')}</span>
                      </span>
                      <Button
                        variant="secondary"
                        size="sm"
                        icon={ev.reminderSet ? 'bell-ring' : 'bell'}
                        aria-pressed={ev.reminderSet}
                        disabled={remind.isPending}
                        onClick={() => (signedIn ? remind.mutate({ id: ev.campaignId, name: ev.name, on: !ev.reminderSet }) : requireSignIn())}
                      >
                        {ev.reminderSet ? 'Reminder set' : 'Remind me'}
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </div>
      {eligible && <EligibleItems coupon={eligible} onClose={() => setEligible(null)} />}
    </StoreLayout>
  );
}

/** Flash-sale card (.shop-dcard); a sold-out deal shows the seller's regular offer. */
function FlashCard({ d, slug }: { d: FlashItem; slug?: string }) {
  const to = productHref({ id: d.productId, slug });
  const sub = `${d.sellerName} · Limit ${d.purchaseLimit} per customer`;
  const store = d.sellerSlug ? href('store/seller', '', { slug: d.sellerSlug }) : d.sellerId === OFFICIAL_STORE_ID ? href('store/official') : null;
  const seller = store ? (
    <Link className="link-plain" to={store}>
      {d.sellerName}
    </Link>
  ) : (
    d.sellerName
  );
  const pct = Math.round(d.percentOffBps / 100);
  if (d.state === 'sold_out') {
    const r = d.regularOffer;
    return (
      <article className="shop-dcard is-out">
        <Link to={to} aria-label={d.title}>
          <Pic image={d.image} />
        </Link>
        <div className="tagrow">
          <Badge tone="solid">Deal sold out</Badge>
        </div>
        <span className="row gap-2 base">
          <span className="price">
            <span className="now u-c-text-3" style={{ textDecoration: 'line-through' }}>
              {money(dollars(d.dealPrice))}
            </span>
          </span>
          <span className="xs muted">deal price</span>
        </span>
        <Link className="small clamp-2 link-plain" to={to}>
          {d.title}
        </Link>
        <div className="stack gap-1">
          <Meter pct={100} tone="deal" label={`${d.title}: share claimed`} />
          <span className="xs muted">100% claimed{d.soldOutAt ? ` at ${timeLabel(d.soldOutAt)}` : ''}</span>
        </div>
        {r && (
          <div className="regular">
            <span className="xs strong">Regular offer still available</span>
            <Price amount={dollars(r.price)} was={r.wasPrice ? dollars(r.wasPrice) : null} noOff />
            <span className="xs muted">{seller} · not part of the flash sale</span>
            <Button variant="secondary" size="sm" to={to}>
              View regular offer
            </Button>
          </div>
        )}
      </article>
    );
  }
  return (
    <article className="shop-dcard">
      <Link to={to} aria-label={d.title}>
        <Pic image={d.image} />
      </Link>
      <div className="tagrow">{pct > 0 && <Badge tone="deal">−{pct}%</Badge>}</div>
      <Price amount={dollars(d.dealPrice)} was={dollars(d.regularPrice)} noOff />
      <Link className="small clamp-2 link-plain" to={to}>
        {d.title}
      </Link>
      <span className="xs muted">
        {seller} · Limit {d.purchaseLimit} per customer
      </span>
      <div className="stack gap-1">
        <Meter pct={d.claimedPct} tone="deal" label={`${sub}: share claimed`} />
        <span className="xs muted">{d.claimedPct}% claimed</span>
      </div>
    </article>
  );
}
