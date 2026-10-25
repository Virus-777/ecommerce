import { useState } from 'react';
import { cx } from '@marketly/web-shared/lib/cx';
import { date as longishDate, weekdayDate } from '@marketly/web-shared/lib/dates';
import { Icon, iconFor, Img } from '@marketly/web-shared/ui';
import {
  compactCount, decodeEntities, deptLabel, initials, num, plural, price, priceShort, ratingValue, servicePrice, tileTint, useStore,
  type AppCard, type BlogPostCard, type BlogTopic, type CompanyCard, type CustomerArea, type DealerCard, type DeptKey, type FarmPage, type FoodCategory, type GameCard, type Industry, type MenuItemCard, type PackCard, type PhonesPage, type PlayGames, type ProductCard, type ProviderCard, type RankingTable, type RestaurantCard, type ServiceCard, type ServiceCategory, type SoftwareCategory, type SoftwareDeals, type SoftwareHome, type SoftwareRail, type Page as ApiPage,
} from './data/appPreview';
import { AdSlot, EndNote, ErrorBox, Loading, PriceLine, SectionHead, StateBox, Stars, Tap, useAds, useNav } from './AppPreviewUi';

/**
 * The ten department pages of the App preview — the areas that exist only in the Android app, each drawn from the
 * same Store API calls its screen makes: Phones (PhonesFragment), Farm machines (FarmFragment), Softwares
 * (SoftwareFragment), Welfare services and Booking (WelfareFragment, BookingFragment), Food delivery
 * (FoodHomeFragment), Blogs (BlogsFragment), Companies (CompaniesFragment), Play center (PlayFragment) and Daily
 * rewards (RewardsFragment).
 *
 * The preview browses as a guest, which changes two of them the way it changes the app for a signed-out customer:
 * Daily rewards shows its signed-out state (the app's own), and the screens that place the customer (Welfare's
 * "near you" count and Nearest sort, Booking's next booking, Food's delivery address) leave those parts out,
 * because `services/area` answers "not located" without a default address. Lists load their first page only:
 * paging as you scroll belongs to the app.
 */

const LIMIT = 20;

/** The brand line of a machine card ("Kestrel · 2 colors"), as the farm list draws it. */
const brand = (p: ProductCard): string => [p.brandName, p.variantCue].filter(Boolean).join(' · ');

export function DepartmentScreen({ dept, query }: { dept: DeptKey; query: URLSearchParams }) {
  switch (dept) {
    case 'phones':
      return <PhonesScreen tab={query.get('tab') ?? 'phone'} />;
    case 'farm':
      return <FarmScreen type={query.get('type')} />;
    case 'software':
      return <SoftwareScreen tab={query.get('tab') ?? 'recommended'} />;
    case 'welfare':
      return <WelfareScreen category={query.get('category')} />;
    case 'food':
      return <FoodScreen />;
    case 'booking':
      return <BookingScreen category={query.get('category')} />;
    case 'blogs':
      return <BlogsScreen topic={query.get('topic')} />;
    case 'companies':
      return <CompaniesScreen industry={query.get('industry')} />;
    case 'play':
      return <PlayScreen tab={query.get('tab') ?? 'games'} />;
    case 'rewards':
      return <RewardsScreen />;
  }
}

/** The sub bar's title for a department, as `setupSubBar` sets it. */
export const departmentTitle = (dept: DeptKey): string => deptLabel(dept);

// ---------------------------------------------------------------- shared bits

/** The app's pill chips (`addPill`): a filter row that scrolls sideways. */
function Pills({ items, active, onPick }: { items: Array<{ value: string | null; label: string; icon?: string | null }>; active: string | null; onPick: (v: string | null) => void }) {
  return (
    <div className="ap-chips" style={{ paddingTop: 4 }}>
      {items.map((it) => (
        <button key={it.value ?? 'all'} type="button" className={cx('ap-chip', it.value === active && 'on')} onClick={() => onPick(it.value)}>
          {it.icon && <Icon name={iconFor(it.icon, 'circle-check')} />}
          {it.label}
        </button>
      ))}
    </div>
  );
}

/** The count + Sort row the listing departments share (Phones, Welfare). */
function CountSort({ count, sort, onSort }: { count: string; sort?: string; onSort?: () => void }) {
  return (
    <div className="ap-controls">
      <span className="ap-sm ap-sub">{count}</span>
      <span style={{ flex: 1 }} />
      {sort && (
        <button type="button" className="ap-sortbox" onClick={onSort}>
          Sort: {sort}
          <Icon name="chevron-down" />
        </button>
      )}
    </div>
  );
}

/** A logo tile with the initials when there is no picture (`bindCompanyLogo`, seller and brand tiles). */
function LogoBox({ src, name, className, size = 44 }: { src?: string | null; name: string; className?: string; size?: number }) {
  return (
    <span className={cx('ap-logo', className)} style={{ width: size, height: size }}>
      {src ? <img src={src} alt="" /> : initials(name)}
    </span>
  );
}

// ---------------------------------------------------------------- Phones (feature/phones/PhonesFragment.kt)

const PHONE_SORTS = [
  { key: 'featured', label: 'Popular' },
  { key: 'price_asc', label: 'Price: low to high' },
  { key: 'price_desc', label: 'Price: high to low' },
];

function PhonesScreen({ tab }: { tab: string }) {
  const [open, setOpen] = useState(tab === 'os-install' ? 'os-install' : tab === 'post-sale' ? 'post-sale' : 'phone');
  return (
    <div className="ap-page">
      <div className="ap-tabs" role="tablist" aria-label="Phones">
        {[
          { key: 'phone', label: 'Phone' },
          { key: 'os-install', label: 'OS install' },
          { key: 'post-sale', label: 'Post-sale services' },
        ].map((t) => (
          <button key={t.key} type="button" role="tab" aria-selected={open === t.key} className={cx('ap-tab-item', open === t.key && 'on')} onClick={() => setOpen(t.key)}>
            {t.label}
          </button>
        ))}
      </div>
      {open === 'phone' ? <PhonesList /> : <ServicesList area={open === 'os-install' ? 'os_install' : 'post_sale'} />}
    </div>
  );
}

function PhonesList() {
  const [brand, setBrand] = useState<string | null>(null);
  const [sort, setSort] = useState('featured');
  const [deals, setDeals] = useState(false);
  const { note } = useNav();
  const q = useStore<PhonesPage>(['phones'], '/api/store/departments/phones');

  if (q.isPending) return <Loading />;
  if (q.isError) return <ErrorBox title="We couldn’t load the phones" error={q.error} onRetry={() => void q.refetch()} />;

  const brands = (q.data.brands ?? []).filter(Boolean);
  const all = q.data.phones ?? [];
  const filtered = all.filter((p) => (brand === null || p.brand === brand) && (!deals || (p.dealPercent ?? 0) > 0));
  const shown = sort === 'price_asc' ? [...filtered].sort((a, b) => a.price.amount - b.price.amount) : sort === 'price_desc' ? [...filtered].sort((a, b) => b.price.amount - a.price.amount) : filtered;
  const sortLabel = PHONE_SORTS.find((s) => s.key === sort)?.label ?? 'Popular';

  return (
    <>
      {brands.length > 1 && <Pills items={[{ value: null, label: 'All' }, ...brands.map((b) => ({ value: b, label: b }))]} active={brand} onPick={setBrand} />}
      <div className="ap-controls">
        <span className="ap-sm ap-sub">{plural(shown.length, 'phone')}</span>
        <span style={{ flex: 1 }} />
        <button type="button" className={cx('ap-btn', deals ? 'soft' : 'secondary', 'sm')} onClick={() => setDeals((d) => !d)}>
          <Icon name="sliders-horizontal" />
          {deals ? 'Filters (1)' : 'Filters'}
        </button>
        <label className="ap-sortbox">
          <select value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort phones">
            {PHONE_SORTS.map((s) => (
              <option key={s.key} value={s.key}>
                Sort: {s.label}
              </option>
            ))}
          </select>
        </label>
        <span className="sr-only">{sortLabel}</span>
      </div>
      {all.length === 0 ? (
        <StateBox icon="smartphone" title="No phones yet" text="Phones appear here as the Marketly team adds them." />
      ) : shown.length === 0 ? (
        <StateBox icon="sliders-horizontal" title={deals ? 'No phones match these filters' : `No ${brand ?? ''} phones yet`} action={deals ? 'Clear' : undefined} onAction={() => setDeals(false)} />
      ) : (
        <>
          <div className="ap-gutter ap-grid" style={{ marginTop: 16 }}>
            {shown.map((p) => (
              <Tap key={p.id} className="ap-pcard" to={`/phones/${p.slug}`} label={p.name}>
                <div className="ap-pcard-art">
                  <Img icon="smartphone" tint={tileTint(p.id)} src={p.image?.thumbUrl ?? p.image?.url ?? undefined} alt="" />
                  <div className="ap-pcard-tags">{(p.dealPercent ?? 0) > 0 && <span className="ap-badge deal">−{p.dealPercent}%</span>}</div>
                </div>
                <div className="ap-pcard-title ap-clamp2">{p.name}</div>
                {p.meta && <div className="ap-pcard-line">{p.meta}</div>}
                <PriceLine now={p.price} was={p.was} />
              </Tap>
            ))}
          </div>
          <EndNote>That’s every phone</EndNote>
        </>
      )}
      <div className="ap-gutter" style={{ display: 'none' }} onClick={() => note('')} />
    </>
  );
}

/** The OS install and Post-sale tabs of Phones: the services of that area (`GET services/services?area=`). */
function ServicesList({ area }: { area: 'os_install' | 'post_sale' }) {
  const q = useStore<ApiPage<ServiceCard>>(['services', area], `/api/store/services/services?area=${area}&limit=${LIMIT}`);
  if (q.isPending) return <Loading list rows={4} />;
  if (q.isError) return <ErrorBox title="We couldn’t load the services" error={q.error} onRetry={() => void q.refetch()} />;
  const items = q.data.items ?? [];

  return (
    <>
      <div className="ap-section ap-gutter">
        <div className="ap-box" style={{ margin: 0 }}>
          <div className="ap-h4">{area === 'os_install' ? 'Have a technician set up your phone' : 'Repairs and cover after you buy'}</div>
          <p className="ap-sm ap-sub" style={{ marginTop: 4 }}>
            {area === 'os_install' ? 'Clean installs, restores and updates. Drop off at a partner shop or book a visit.' : 'Screen, battery and board repairs from checked partners.'}
          </p>
        </div>
      </div>
      {items.length === 0 ? (
        <StateBox icon="wrench" title={area === 'os_install' ? 'No OS install services yet' : 'No services in this category yet'} text="Partner shops appear here as they join." />
      ) : (
        <>
          <div className="ap-section ap-gutter ap-stack">
            {items.map((s) => (
              <ServiceRow key={s.id} s={s} to={`/phones/${area === 'os_install' ? 'os-install' : 'post-sale'}/${s.slug}`} icon="wrench" />
            ))}
          </div>
          <EndNote>That’s every service</EndNote>
        </>
      )}
    </>
  );
}

/** A service card (ServicesItemWelfare / the OS install and post-sale rows). */
function ServiceRow({ s, to, icon }: { s: ServiceCard; to: string; icon: 'wrench' | 'hand-heart' }) {
  const where = s.distance?.trim() || s.coverage;
  return (
    <Tap className="ap-row-card top" to={to} label={s.title}>
      <span style={{ flex: 'none', width: 72 }}>
        <Img icon={icon} tint={tileTint(s.id)} src={s.image?.thumbUrl ?? s.image?.url ?? undefined} alt="" />
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        {s.provider?.name && (
          <span className="ap-xs ap-muted" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            {decodeEntities(s.provider.name)}
            {s.provider.verified && <Icon name="badge-check" style={{ width: 13, height: 13, color: 'var(--brand)' }} />}
          </span>
        )}
        <span className="ap-h4 ap-clamp2" style={{ display: 'block', marginTop: 2 }}>{decodeEntities(s.title)}</span>
        {s.summary && <span className="ap-xs ap-muted ap-clamp2" style={{ display: 'block', marginTop: 2 }}>{decodeEntities(s.summary)}</span>}
        <span className="ap-xs ap-muted" style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
          {(s.rating?.count ?? 0) > 0 && <Stars rating={s.rating?.average} count={s.rating?.count} />}
          {where && <span>{(s.rating?.count ?? 0) > 0 ? '· ' : ''}{where}</span>}
        </span>
      </span>
      {s.fromPrice && <span className="ap-h4" style={{ flex: 'none' }}>{servicePrice(s.fromPrice, s.priceUnit)}</span>}
    </Tap>
  );
}

// ---------------------------------------------------------------- Farm machines (feature/farm/FarmFragment.kt)

function FarmScreen({ type }: { type: string | null }) {
  const [picked, setPicked] = useState<string | null>(type);
  const q = useStore<FarmPage>(['farm'], '/api/store/departments/farm');
  const dealer = useStore<{ dealer?: DealerCard | null }>(['farm-dealer'], '/api/store/farm/dealers/nearest');

  const page = q.data;
  const types = (page?.types ?? []).filter((t) => (page?.machines ?? []).some((m) => m.typeId === t.id));
  const shownTypes = types.length ? types : (page?.types ?? []);
  const current = shownTypes.find((t) => t.id === picked) ?? shownTypes[0];
  const machines = current ? (page?.machines ?? []).filter((m) => m.typeId === current.id) : (page?.machines ?? []);

  return (
    <div className="ap-page">
      <div className="ap-gutter" style={{ paddingTop: 16 }}>
        <div className="ap-banner" style={{ margin: 0 }}>
          <div className="ap-eyebrow">Buy online · delivered to your farm</div>
          <h2>Machines for every season</h2>
          <p>Tractors, harvesters and tillers from trusted dealers, with setup and operator training included.</p>
          <div className="ap-banner-cta">
            <span className="ap-btn sm">Order a machine</span>
          </div>
        </div>
      </div>

      {q.isPending ? (
        <Loading list rows={3} />
      ) : q.isError ? (
        <ErrorBox title="We couldn’t load the machines" error={q.error} onRetry={() => void q.refetch()} />
      ) : (page?.machines ?? []).length === 0 ? (
        <StateBox icon="tractor" title="No machines yet" text="Dealers’ machines appear here as they are added." />
      ) : (
        <>
          {shownTypes.length > 1 && <Pills items={shownTypes.map((t) => ({ value: t.id, label: t.name }))} active={current?.id ?? null} onPick={setPicked} />}
          <div className="ap-section">
            <div className="ap-head ap-gutter">
              <h2>{current?.name ?? 'Farm machines'}</h2>
              <span className="ap-sm ap-sub">{plural(machines.length, 'machine')}</span>
            </div>
            <div className="ap-gutter ap-stack">
              {machines.map((m) => (
                <Tap key={m.product.productId} className="ap-row-card top" to={`/farm-machines/${m.product.productId}`} label={m.product.title}>
                  <span style={{ flex: 'none', width: 84 }}>
                    <Img icon="tractor" tint={tileTint(m.product.productId)} src={m.product.image?.thumbUrl ?? m.product.image?.url ?? undefined} alt="" />
                  </span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    {brand(m.product) && <span className="ap-xs ap-muted" style={{ display: 'block' }}>{decodeEntities(brand(m.product))}</span>}
                    <span className="ap-h4 ap-clamp2" style={{ display: 'block', marginTop: 2 }}>{decodeEntities(m.product.title ?? '')}</span>
                    {!!m.highlights?.length && (
                      <span className="ap-specs">
                        {m.highlights.map((h) => (
                          <span key={h}>{h}</span>
                        ))}
                      </span>
                    )}
                    {m.product.price && (
                      <span className="ap-sm" style={{ display: 'block', marginTop: 6 }}>
                        from <b className="ap-h4">{priceShort(m.product.price)}</b>
                      </span>
                    )}
                  </span>
                </Tap>
              ))}
              {machines.length === 0 && <div className="ap-sm ap-muted">No {current?.name.toLowerCase()} yet</div>}
            </div>
          </div>
        </>
      )}

      <div className="ap-section ap-gutter">
        <h2 className="ap-h3">Why order on Marketly</h2>
        <div className="ap-stack" style={{ marginTop: 12 }}>
          {[
            { icon: 'truck' as const, title: 'Delivered to your farm', text: 'Low-loader delivery and setup on site.' },
            { icon: 'graduation-cap' as const, title: 'Operator training', text: 'A half-day session with the dealer’s technician.' },
            { icon: 'wrench' as const, title: 'Service network', text: 'Parts and repairs from workshops near you.' },
          ].map((w) => (
            <div key={w.title} className="ap-row-card">
              <Icon name={w.icon} style={{ width: 22, height: 22, flex: 'none', color: 'var(--brand)' }} />
              <span style={{ flex: 1 }}>
                <span className="ap-h4" style={{ display: 'block' }}>{w.title}</span>
                <span className="ap-xs ap-muted">{w.text}</span>
              </span>
            </div>
          ))}
        </div>
      </div>

      {dealer.data?.dealer && (
        <div className="ap-section ap-gutter">
          <div className="ap-box" style={{ margin: 0 }}>
            <div className="ap-eyebrow ap-muted">Your nearest dealer</div>
            <div className="ap-h3" style={{ marginTop: 4 }}>{decodeEntities(dealer.data.dealer.name)}</div>
            {dealer.data.dealer.metaLabel && <div className="ap-sm ap-sub" style={{ marginTop: 2 }}>{dealer.data.dealer.metaLabel}</div>}
            {dealer.data.dealer.hours && <div className="ap-xs ap-muted" style={{ marginTop: 2 }}>{dealer.data.dealer.hours}</div>}
            <div className="row gap-2" style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <span className="ap-btn secondary sm">Call</span>
              <span className="ap-btn secondary sm">Message</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Softwares (feature/software/SoftwareFragment.kt)

function SoftwareScreen({ tab }: { tab: string }) {
  const [open, setOpen] = useState(tab === 'categories' || tab === 'deals' ? tab : 'recommended');
  return (
    <div className="ap-page">
      <div className="ap-tabs ap-tabs-fixed" role="tablist" aria-label="Softwares">
        {[
          { key: 'recommended', label: 'Recommended' },
          { key: 'categories', label: 'Categories' },
          { key: 'deals', label: 'Deals' },
        ].map((t) => (
          <button key={t.key} type="button" role="tab" aria-selected={open === t.key} className={cx('ap-tab-item', open === t.key && 'on')} onClick={() => setOpen(t.key)}>
            {t.label}
          </button>
        ))}
      </div>
      {open === 'recommended' && <SoftwareRecommended />}
      {open === 'categories' && <SoftwareCategories />}
      {open === 'deals' && <SoftwareDealsTab />}
    </div>
  );
}

const appPrice = (a: AppCard): string => a.price?.label || (a.price?.free ? 'Free' : price(a.price?.current));
const appIcon = (a: AppCard) => {
  const slug = a.category?.slug ?? '';
  return slug.includes('game') ? 'gamepad-2' : slug.includes('browser') ? 'globe' : slug.includes('multimedia') || slug.includes('photo') ? 'image' : 'app-window';
};

function SoftwareRecommended() {
  const q = useStore<SoftwareHome>(['software-home'], '/api/store/software/home');
  const ads = useAds('software', ['software_top']);
  if (q.isPending) return <Loading />;
  if (q.isError) return <ErrorBox title="We couldn't load Softwares" error={q.error} onRetry={() => void q.refetch()} />;
  const rails = (q.data.rails ?? []).filter((r) => r.apps.length);
  if (!rails.length && !q.data.featuredPack) return <StateBox icon="app-window" title="No apps yet" text="Apps for your phone and PC show up here soon." />;

  return (
    <>
      <AdSlot decision={ads.data} slotKey="software_top" />
      {rails.map((rail, i) => (
        <div key={rail.key}>
          <SoftwareRailView rail={rail} />
          {i === 0 && q.data.featuredPack && <PackDeal pack={q.data.featuredPack} />}
        </div>
      ))}
      {!rails.length && q.data.featuredPack && <PackDeal pack={q.data.featuredPack} />}
    </>
  );
}

function SoftwareRailView({ rail }: { rail: SoftwareRail }) {
  const wide = rail.source === 'category';
  return (
    <div className="ap-section">
      <SectionHead title={rail.title} link={rail.seeAll ? 'See all' : undefined} to={rail.seeAll ? `/software/apps?${rail.seeAll}` : undefined} />
      {rail.style === 'list' ? (
        <div className="ap-gutter">
          {rail.apps.map((a, i) => (
            <Tap key={a.id} className={cx('ap-app-row', i > 0 && 'divided')} to={`/software/app/${a.slug}`} label={a.title}>
              <Img icon={appIcon(a)} tint={tileTint(a.id)} className="ap-app-icon" src={a.icon?.thumbUrl ?? a.icon?.url ?? undefined} alt="" />
              <span style={{ flex: 1, minWidth: 0 }}>
                <span className="ap-h4 ap-clamp2" style={{ display: 'block' }}>{a.title}</span>
                <span className="ap-xs ap-muted">
                  {a.rating != null ? <Stars rating={a.rating} /> : 'New'}
                  {a.category?.name ? ` · ${a.category.name}` : ''}
                  {a.sizeLabel ? ` · ${a.sizeLabel}` : ''}
                </span>
              </span>
              <span className={cx('ap-btn sm', a.owned ? 'secondary' : 'soft')}>{a.owned ? 'Open' : appPrice(a)}</span>
            </Tap>
          ))}
        </div>
      ) : (
        <div className="ap-rail">
          {rail.apps.map((a) => (
            <Tap key={a.id} className={wide ? 'ap-app-wide' : 'ap-app-tile'} to={`/software/app/${a.slug}`} label={a.title}>
              <Img icon={appIcon(a)} tint={tileTint(a.id)} className="ap-app-icon" src={a.icon?.thumbUrl ?? a.icon?.url ?? undefined} alt="" />
              <span className="ap-sm ap-strong ap-clamp2" style={{ display: 'block', marginTop: 6 }}>{a.title}</span>
              <span className="ap-xs ap-muted" style={{ display: 'block' }}>{a.rating != null ? <Stars rating={a.rating} /> : 'New'}</span>
              <span className="ap-xs ap-strong" style={{ display: 'block', marginTop: 2 }}>{a.owned ? 'Owned' : appPrice(a)}</span>
            </Tap>
          ))}
        </div>
      )}
    </div>
  );
}

function PackDeal({ pack }: { pack: PackCard }) {
  return (
    <div className="ap-section ap-gutter">
      <div className="ap-box" style={{ margin: 0 }}>
        <span className="ap-badge deal">Pack deal · Save {pack.savePercent ?? 0}%</span>
        <div className="ap-h3" style={{ marginTop: 8 }}>{decodeEntities(pack.name)}</div>
        {pack.summary && <div className="ap-sm ap-sub" style={{ marginTop: 4 }}>{decodeEntities(pack.summary)}</div>}
        <div className="ap-pack-apps">
          {(pack.apps ?? []).slice(0, 5).map((a) => (
            <Img key={a.id} icon="app-window" tint={tileTint(a.id)} className="ap-app-icon sm" src={a.icon?.thumbUrl ?? a.icon?.url ?? undefined} alt="" />
          ))}
          {(pack.count ?? 0) > 5 && <span className="ap-xs ap-muted">+{(pack.count ?? 0) - 5}</span>}
        </div>
        <div className="ap-sm ap-muted" style={{ marginTop: 8 }}>
          {pack.count ?? 0} apps{pack.licenceLabel ? ` · ${pack.licenceLabel}` : ''}
        </div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 10 }}>
          <span className="ap-h2">{pack.priceLabel}</span>
          {pack.totalLabel && <span className="ap-xs ap-muted">{pack.totalLabel} if bought separately</span>}
        </div>
        <span className="ap-btn block" style={{ marginTop: 12 }}>{pack.owned ? 'You own every app' : 'Buy pack'}</span>
      </div>
    </div>
  );
}

function SoftwareCategories() {
  const q = useStore<SoftwareCategory[]>(['software-categories'], '/api/store/software/categories');
  if (q.isPending) return <Loading />;
  if (q.isError) return <ErrorBox title="We couldn't load the categories" error={q.error} onRetry={() => void q.refetch()} />;
  const cats = (q.data ?? []).filter((c) => c.visible !== false).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  if (!cats.length) return <StateBox icon="app-window" title="No categories yet" />;
  const tints = ['1', '4', '3', '6', '5', '2'];
  return (
    <div className="ap-section">
      <SectionHead title="Browse by category" />
      <div className="ap-gutter ap-grid">
        {cats.map((c, i) => (
          <Tap key={c.id} className="ap-cat-tile" to={`/software/apps?category=${c.slug}`} label={c.name}>
            <span className={cx('imgph', `tint-${tints[i % tints.length]}`)} style={{ width: 48, height: 48, borderRadius: 12, aspectRatio: 'auto' }}>
              <Icon name={iconFor(c.icon, 'app-window')} />
            </span>
            <span className="ap-h4" style={{ display: 'block', marginTop: 8 }}>{c.name}</span>
            <span className="ap-xs ap-muted">{plural(c.appCount ?? 0, 'app')}</span>
          </Tap>
        ))}
      </div>
    </div>
  );
}

function SoftwareDealsTab() {
  const [filter, setFilter] = useState<'all' | 'discounts' | 'packs'>('all');
  const q = useStore<SoftwareDeals>(['software-deals'], '/api/store/software/deals');
  if (q.isPending) return <Loading />;
  if (q.isError) return <ErrorBox title="We couldn't load the deals" error={q.error} onRetry={() => void q.refetch()} />;
  const packs = filter === 'discounts' ? [] : q.data.packs ?? [];
  const discounts = filter === 'packs' ? [] : q.data.discounts ?? [];
  return (
    <>
      <div className="ap-seg ap-gutter" role="group" aria-label="Deal type">
        {(['all', 'discounts', 'packs'] as const).map((f) => (
          <button key={f} type="button" className={cx(filter === f && 'on')} onClick={() => setFilter(f)}>
            {f === 'all' ? 'All' : f === 'discounts' ? 'Discounts' : 'Packs'}
          </button>
        ))}
      </div>
      {!packs.length && !discounts.length ? (
        <StateBox icon="tag" title="No deals right now" text="Packs and apps on sale show up here." />
      ) : (
        <>
          {!!packs.length && (
            <div className="ap-section">
              <SectionHead title="Packs" />
              {packs.map((p) => (
                <PackDeal key={p.id} pack={p} />
              ))}
            </div>
          )}
          {!!discounts.length && (
            <div className="ap-section">
              <SectionHead title="Discounts" />
              {q.data.discountsUntilLabel && <div className="ap-gutter ap-xs ap-muted" style={{ marginTop: -6, marginBottom: 10 }}>{q.data.discountsUntilLabel}</div>}
              <div className="ap-gutter">
                {discounts.map((a, i) => (
                  <Tap key={a.id} className={cx('ap-app-row', i > 0 && 'divided')} to={`/software/app/${a.slug}`} label={a.title}>
                    <Img icon={appIcon(a)} tint={tileTint(a.id)} className="ap-app-icon" src={a.icon?.thumbUrl ?? a.icon?.url ?? undefined} alt="" />
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span className="ap-h4 ap-clamp2" style={{ display: 'block' }}>{a.title}</span>
                      <span className="ap-xs ap-muted">{a.category?.name}</span>
                    </span>
                    <span className="ap-stack" style={{ alignItems: 'flex-end', gap: 2, flex: 'none' }}>
                      {a.price?.offPercent ? <span className="ap-badge deal">-{a.price.offPercent}%</span> : null}
                      <span className="ap-sm ap-strong">{appPrice(a)}</span>
                      {a.price?.wasLabel && <span className="ap-xs ap-muted" style={{ textDecoration: 'line-through' }}>{a.price.wasLabel}</span>}
                    </span>
                  </Tap>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------- Welfare services (feature/services/WelfareFragment.kt)

const WELFARE_SORTS: Record<string, string> = { recommended: 'Recommended', price: 'Lowest price', rating: 'Top rated' };

function WelfareScreen({ category }: { category: string | null }) {
  const [cat, setCat] = useState<string | null>(category);
  const [sort, setSort] = useState('recommended');
  const cats = useStore<ServiceCategory[]>(['welfare-categories'], '/api/store/services/categories?area=welfare');
  const area = useStore<CustomerArea>(['services-area', 'welfare'], '/api/store/services/area?area=welfare');
  const list = useStore<ApiPage<ServiceCard>>(['welfare', cat ?? '', sort], `/api/store/services/services?area=welfare&sort=${sort}${cat ? `&category=${encodeURIComponent(cat)}` : ''}&limit=${LIMIT}`);

  const items = list.data?.items ?? [];
  const city = area.data?.located ? area.data.city : null;
  const count = city ? `${num(items.length)} ${items.length === 1 ? 'service' : 'services'} near ${city}` : plural(items.length, 'service');

  return (
    <div className="ap-page">
      <div className="ap-gutter" style={{ paddingTop: 16 }}>
        <div className="ap-searchbar" style={{ border: '1px solid var(--border-strong)' }}>
          <Icon name="search" />
          <span>Search services or providers</span>
        </div>
      </div>
      {!!(cats.data ?? []).length && <Pills items={[{ value: null, label: 'All' }, ...(cats.data ?? []).filter((c) => c.visible !== false).map((c) => ({ value: c.slug, label: c.name }))]} active={cat} onPick={setCat} />}
      <CountSort count={count} sort={WELFARE_SORTS[sort]} onSort={() => setSort(sort === 'recommended' ? 'price' : sort === 'price' ? 'rating' : 'recommended')} />
      {list.isPending ? (
        <Loading list rows={4} />
      ) : list.isError ? (
        <ErrorBox title="We couldn’t load the services" error={list.error} onRetry={() => void list.refetch()} />
      ) : items.length === 0 ? (
        <StateBox icon="hand-heart" title="No welfare services here yet" text="Providers appear here as they join." />
      ) : (
        <>
          <div className="ap-section ap-gutter ap-stack">
            {items.map((s) => (
              <ServiceRow key={s.id} s={s} to={`/welfare/${s.slug}`} icon="hand-heart" />
            ))}
          </div>
          <EndNote>That’s every service</EndNote>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Booking (feature/booking/BookingFragment.kt)

function BookingScreen({ category }: { category: string | null }) {
  const [cat, setCat] = useState<string | null>(category);
  const { note } = useNav();
  const cats = useStore<ServiceCategory[]>(['booking-categories'], '/api/store/services/categories?area=booking');
  const list = useStore<ApiPage<ProviderCard>>(['booking', cat ?? ''], `/api/store/services/providers?area=booking${cat ? `&category=${encodeURIComponent(cat)}` : ''}&limit=${LIMIT}`);
  const items = list.data?.items ?? [];

  return (
    <div className="ap-page">
      <div className="ap-gutter" style={{ paddingTop: 16, display: 'flex', gap: 8 }}>
        <div className="ap-searchbar" style={{ flex: 1, border: '1px solid var(--border-strong)' }}>
          <Icon name="search" />
          <span>Salons, clinics, car wash, hotels…</span>
        </div>
        <button type="button" className="ap-btn secondary sm" style={{ height: 40 }} onClick={() => note('The booking map is off in the preview.')}>
          <Icon name="map-pin" />
          Map
        </button>
      </div>
      {!!(cats.data ?? []).length && (
        <Pills
          items={[{ value: null, label: 'All' }, ...(cats.data ?? []).filter((c) => c.visible !== false).map((c) => ({ value: c.slug, label: c.name, icon: c.icon }))]}
          active={cat}
          onPick={setCat}
        />
      )}
      <SectionHead title="Available near you" />
      {list.isPending ? (
        <Loading list rows={4} />
      ) : list.isError ? (
        <ErrorBox title="We couldn’t load the places" error={list.error} onRetry={() => void list.refetch()} />
      ) : items.length === 0 ? (
        <StateBox icon="calendar-check" title="No places to book yet" text="Salons, clinics and more appear here as they join." />
      ) : (
        <>
          <div className="ap-gutter ap-stack">
            {items.map((p) => (
              <Tap key={p.id} className="ap-row-card top" to={`/booking/${p.slug}`} label={p.name}>
                <span style={{ flex: 'none', width: 72 }}>
                  <Img icon={iconFor(p.category?.slug, 'calendar-check')} tint={tileTint(p.id)} src={(p.cover ?? p.logo)?.thumbUrl ?? (p.cover ?? p.logo)?.url ?? undefined} alt="" />
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span className="ap-h4" style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                    {decodeEntities(p.name)}
                    {p.verified && <Icon name="badge-check" style={{ width: 14, height: 14, color: 'var(--brand)' }} />}
                  </span>
                  <span className="ap-xs ap-muted" style={{ display: 'block', marginTop: 2 }}>{[p.kind, p.distance?.trim() || p.city].filter(Boolean).join(' · ')}</span>
                  <span className="ap-xs ap-muted" style={{ display: 'flex', gap: 5, marginTop: 2 }}>
                    {(p.rating?.count ?? 0) > 0 && <Stars rating={p.rating?.average} count={p.rating?.count} />}
                    {p.fromPrice && <span>{(p.rating?.count ?? 0) > 0 ? '· ' : ''}from {priceShort(p.fromPrice)}</span>}
                  </span>
                  {p.nextFree && <span className={cx('ap-badge', /today/i.test(p.nextFree) ? 'brand' : '')} style={{ marginTop: 6 }}>{p.nextFree}</span>}
                </span>
              </Tap>
            ))}
          </div>
          <EndNote>That’s every place</EndNote>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Food delivery (feature/food/FoodHomeFragment.kt)

function FoodScreen() {
  const cats = useStore<FoodCategory[]>(['food-categories'], '/api/store/food/categories');
  const restaurants = useStore<ApiPage<RestaurantCard>>(['food-restaurants'], '/api/store/food/restaurants?limit=5');
  const foods = useStore<ApiPage<MenuItemCard>>(['food-items'], '/api/store/food/items?recommended=true&limit=6');
  const ads = useAds('food', ['food_top']);
  const list = (cats.data ?? []).filter((c) => c.visible !== false).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

  return (
    <div className="ap-page">
      {!!list.length && (
        <div className="ap-section">
          <div className="ap-rail">
            {list.map((c, i) => (
              <Tap key={c.id} className="ap-food-cat" to={`/food/restaurants?category=${c.slug}`} label={c.name}>
                <Img icon={iconFor(c.icon, 'utensils')} tint={String((i % 6) + 1)} src={c.image?.url ?? undefined} alt="" />
                <span className="ap-xs ap-strong">{c.name}</span>
              </Tap>
            ))}
          </div>
        </div>
      )}
      <AdSlot decision={ads.data} slotKey="food_top" />

      {restaurants.isPending ? (
        <Loading list rows={3} />
      ) : restaurants.isError ? (
        <ErrorBox title="Food delivery didn't load" error={restaurants.error} onRetry={() => void restaurants.refetch()} />
      ) : !(restaurants.data?.items ?? []).length && !(foods.data?.items ?? []).length ? (
        <StateBox icon="utensils" title="No restaurants yet" text="Restaurants appear here as they join Marketly." />
      ) : (
        <>
          {!!(restaurants.data?.items ?? []).length && (
            <div className="ap-section">
              <SectionHead title="Food services near you" link="See all" to="/food/restaurants" />
              <div className="ap-gutter ap-stack">
                {(restaurants.data?.items ?? []).map((r, i) => (
                  <Tap key={r.id} className="ap-food-card" to={`/food/restaurants/${r.slug}`} label={r.name}>
                    <span className="ap-food-cover">
                      <Img icon="utensils" tint={String(((i * 2 + 1) % 6) + 1)} src={r.image?.url ?? undefined} alt="" />
                      <span className={cx('ap-badge', r.open ? 'success' : '')} style={{ position: 'absolute', top: 8, left: 8 }}>
                        {r.open ? 'Open' : r.openLabel || 'Closed'}
                      </span>
                      {r.promoBadge && <span className="ap-badge deal" style={{ position: 'absolute', top: 8, right: 8 }}>{r.promoBadge}</span>}
                    </span>
                    <span className="ap-food-body">
                      <span className="ap-h4" style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                        <span className="ap-clamp2" style={{ flex: 1 }}>{decodeEntities(r.name)}</span>
                        {(r.ratingCount ?? 0) > 0 && <Stars rating={r.rating} count={r.ratingCount} />}
                      </span>
                      {r.cuisine && <span className="ap-xs ap-muted" style={{ display: 'block', marginTop: 2 }}>{r.cuisine}</span>}
                      <span className="ap-xs ap-muted" style={{ display: 'block', marginTop: 4 }}>
                        {[r.deliveryLabel, r.feeLabel, r.distanceLabel?.trim() || r.city].filter(Boolean).join(' · ')}
                      </span>
                    </span>
                  </Tap>
                ))}
              </div>
            </div>
          )}
          {!!(foods.data?.items ?? []).length && (
            <div className="ap-section">
              <SectionHead title="Recommended foods" link="See all" to="/food/items?recommended=true" />
              <div className="ap-gutter ap-grid">
                {(foods.data?.items ?? []).map((f, i) => (
                  <Tap key={f.id} className="ap-pcard" to={`/food/items/${f.id}`} label={f.name}>
                    <div className="ap-pcard-art">
                      <Img icon="utensils" tint={String(([2, 0, 4, 5][i % 4] % 6) + 1)} src={f.image?.url ?? undefined} alt="" />
                      <div className="ap-pcard-tags">{f.badge && <span className="ap-badge deal">{f.badge}</span>}</div>
                    </div>
                    <div className="ap-pcard-title ap-clamp2">{decodeEntities(f.name)}</div>
                    {f.restaurantName && <div className="ap-pcard-line">{decodeEntities(f.restaurantName)}</div>}
                    {(f.ratingCount ?? 0) > 0 && (
                      <div className="ap-pcard-rating">
                        <Stars rating={f.rating} count={f.ratingCount} />
                      </div>
                    )}
                    <div className="ap-price">
                      <span>{f.priceLabel || price(f.price)}</span>
                      {f.wasLabel && <span className="was">{f.wasLabel}</span>}
                    </div>
                  </Tap>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Blogs (feature/blogs/BlogsFragment.kt)

function BlogsScreen({ topic }: { topic: string | null }) {
  const [open, setOpen] = useState<string | null>(topic);
  const topics = useStore<BlogTopic[]>(['blog-topics'], '/api/store/departments/blogs/topics');
  const posts = useStore<ApiPage<BlogPostCard>>(['blog-posts', open ?? ''], `/api/store/departments/blogs/posts?limit=${LIMIT}${open ? `&topic=${encodeURIComponent(open)}` : ''}`);
  const items = posts.data?.items ?? [];
  const featured = open === null ? items.find((p) => p.featured) : undefined;
  const rest = items.filter((p) => p.id !== featured?.id);
  const list = (topics.data ?? []).filter((t) => t.visible !== false);
  const topicName = list.find((t) => t.slug === open)?.name;

  const meta = (p: BlogPostCard, withRead: boolean) =>
    [p.author?.name, p.publishedAt && longishDate(p.publishedAt), withRead && (p.readMinutes ?? 0) > 0 ? `${p.readMinutes} min read` : null].filter(Boolean).join(' · ');

  return (
    <div className="ap-page">
      {!!list.length && (
        <div className="ap-tabs" role="tablist" aria-label="Topics">
          {[{ slug: null as string | null, name: 'All' }, ...list].map((t) => (
            <button key={t.slug ?? 'all'} type="button" role="tab" aria-selected={open === t.slug} className={cx('ap-tab-item', open === t.slug && 'on')} onClick={() => setOpen(t.slug)}>
              {t.name}
            </button>
          ))}
        </div>
      )}
      {posts.isPending ? (
        <Loading list rows={3} />
      ) : posts.isError ? (
        <ErrorBox title="We couldn’t load the posts" error={posts.error} onRetry={() => void posts.refetch()} />
      ) : items.length === 0 ? (
        <StateBox icon="newspaper" title={topicName ? `No posts in ${topicName} yet` : 'No posts yet'} text={topicName ? null : 'New posts appear here as soon as they’re published.'} />
      ) : (
        <>
          {featured && (
            <div className="ap-section ap-gutter">
              <Tap className="ap-blog-featured" to={`/blogs/${featured.slug}`} label={featured.title}>
                <Img icon="newspaper" tint={tileTint(featured.id)} src={featured.cover?.url ?? undefined} alt="" />
                {featured.topic?.name && <span className="ap-badge brand" style={{ marginTop: 10 }}>{featured.topic.name}</span>}
                <span className="ap-h3" style={{ display: 'block', marginTop: 6 }}>{decodeEntities(featured.title)}</span>
                <span className="ap-xs ap-muted">{meta(featured, true)}</span>
              </Tap>
            </div>
          )}
          {!!rest.length && <SectionHead title="Latest posts" />}
          <div className="ap-gutter">
            {rest.map((p) => (
              <Tap key={p.id} className="ap-blog-row" to={`/blogs/${p.slug}`} label={p.title}>
                <span style={{ flex: 1, minWidth: 0 }}>
                  {p.topic?.name && <span className="ap-xs ap-strong" style={{ color: 'var(--brand-text)' }}>{p.topic.name}</span>}
                  <span className="ap-h4 ap-clamp2" style={{ display: 'block', marginTop: 2 }}>{decodeEntities(p.title)}</span>
                  <span className="ap-xs ap-muted" style={{ display: 'block', marginTop: 2 }}>{meta(p, false)}</span>
                  <span className="ap-xs ap-muted" style={{ display: 'flex', gap: 12, marginTop: 6 }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <Icon name="heart" style={{ width: 13, height: 13 }} />
                      {compactCount(p.likeCount ?? 0)}
                    </span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <Icon name="message-circle" style={{ width: 13, height: 13 }} />
                      {compactCount(p.replyCount ?? 0)}
                    </span>
                  </span>
                </span>
                <Img icon="newspaper" tint={tileTint(p.id)} className="ap-blog-thumb" src={p.cover?.thumbUrl ?? p.cover?.url ?? undefined} alt="" />
              </Tap>
            ))}
          </div>
          <EndNote>You’re all caught up</EndNote>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Companies (feature/companies/CompaniesFragment.kt)

function CompaniesScreen({ industry }: { industry: string | null }) {
  const [open, setOpen] = useState<string | null>(industry);
  const industries = useStore<Industry[]>(['industries'], '/api/store/departments/industries');
  const list = useStore<ApiPage<CompanyCard>>(['companies', open ?? ''], `/api/store/departments/companies?limit=${LIMIT}${open ? `&industry=${encodeURIComponent(open)}` : ''}`);
  const ads = useAds('companies', ['companies_top']);
  const items = list.data?.items ?? [];
  const names = (industries.data ?? []).filter((i) => i.visible !== false);
  const industryName = names.find((i) => i.slug === open)?.name;

  return (
    <div className="ap-page">
      <AdSlot decision={ads.data} slotKey="companies_top" />
      {!!names.length && <Pills items={[{ value: null, label: 'All' }, ...names.map((i) => ({ value: i.slug, label: i.name }))]} active={open} onPick={setOpen} />}
      {list.isPending ? (
        <Loading list rows={4} />
      ) : list.isError ? (
        <ErrorBox title="We couldn’t load the companies" error={list.error} onRetry={() => void list.refetch()} />
      ) : items.length === 0 ? (
        <StateBox icon="building-2" title={industryName ? `No companies in ${industryName} yet` : 'No companies yet'} text={industryName ? null : 'Company pages appear here as the Marketly team adds them.'} />
      ) : (
        <>
          <div className="ap-controls">
            <span className="ap-sm ap-sub">{plural(list.data?.total ?? items.length, 'company', 'companies')}</span>
          </div>
          <div className="ap-gutter ap-stack" style={{ marginTop: 12 }}>
            {items.map((c) => (
              <Tap key={c.id} className="ap-row-card top" to={`/companies/${c.slug}`} label={c.name}>
                <LogoBox src={c.logo?.thumbUrl ?? c.logo?.url} name={c.name} size={48} />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span className="ap-h4" style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                    {decodeEntities(c.name)}
                    {c.verified && <Icon name="badge-check" style={{ width: 14, height: 14, color: 'var(--brand)' }} />}
                  </span>
                  <span className="ap-xs ap-muted" style={{ display: 'block', marginTop: 2 }}>{[c.industry?.name, c.city].filter(Boolean).join(' · ')}</span>
                  {c.tagline && <span className="ap-xs ap-sub ap-clamp2" style={{ display: 'block', marginTop: 4 }}>{decodeEntities(c.tagline)}</span>}
                  {ratingValue(c.rating) && (
                    <span className="ap-xs" style={{ display: 'block', marginTop: 4 }}>
                      <Stars rating={c.rating} count={c.ratingCount} />
                    </span>
                  )}
                </span>
              </Tap>
            ))}
          </div>
          <EndNote>That’s every company</EndNote>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Play center (feature/play/PlayFragment.kt)

function PlayScreen({ tab }: { tab: string }) {
  const [open, setOpen] = useState(tab === 'rankings' ? 'rankings' : 'games');
  return (
    <div className="ap-page">
      <div className="ap-tabs ap-tabs-fixed" role="tablist" aria-label="Play center">
        {[
          { key: 'games', label: 'Games' },
          { key: 'rankings', label: 'Rankings' },
        ].map((t) => (
          <button key={t.key} type="button" role="tab" aria-selected={open === t.key} className={cx('ap-tab-item', open === t.key && 'on')} onClick={() => setOpen(t.key)}>
            {t.label}
          </button>
        ))}
      </div>
      {open === 'games' ? <PlayGamesTab /> : <PlayRankingsTab />}
    </div>
  );
}

function PlayGamesTab() {
  const [genre, setGenre] = useState<string | null>(null);
  const q = useStore<PlayGames>(['play-games'], '/api/store/departments/play/games');
  const ads = useAds('play', ['play_top']);
  if (q.isPending) return <Loading list rows={4} />;
  if (q.isError) return <ErrorBox title="We couldn’t load the games" error={q.error} onRetry={() => void q.refetch()} />;
  const games = q.data.games ?? [];
  if (!games.length) return <StateBox icon="gamepad-2" title="No games yet" text="Games appear here as the Marketly team adds them." />;
  const shown = genre ? games.filter((g) => g.genre === genre) : games;
  const top = shown.find((g) => g.featured);
  const rest = shown.filter((g) => g.id !== top?.id);

  return (
    <>
      <AdSlot decision={ads.data} slotKey="play_top" />
      {(q.data.genres ?? []).length > 1 && <Pills items={[{ value: null, label: 'All' }, ...(q.data.genres ?? []).map((g) => ({ value: g, label: g }))]} active={genre} onPick={setGenre} />}
      {top && (
        <div className="ap-section ap-gutter">
          <Tap className="ap-play-featured" to={`/play/games/${top.slug}`} label={top.title}>
            <Img icon="gamepad-2" tint={tileTint(top.id)} src={(top.cover ?? top.icon)?.url ?? undefined} alt="" />
            <span className="ap-play-featured-body">
              {top.hasPrizes && <span className="ap-badge deal">Win coupons</span>}
              <span className="ap-h3" style={{ display: 'block', marginTop: 6 }}>{top.title}</span>
              <span className="ap-xs ap-muted" style={{ display: 'block' }}>{[top.genre, top.playersLabel].filter(Boolean).join(' · ')}</span>
              <span className="ap-btn sm" style={{ marginTop: 12 }}>Play</span>
            </span>
          </Tap>
        </div>
      )}
      {shown.length === 0 ? (
        <StateBox icon="gamepad-2" title={`No ${genre ?? ''} games yet`} />
      ) : (
        <div className="ap-section">
          <div className="ap-head ap-gutter">
            <h2>All games</h2>
            <span className="ap-sm ap-sub">{plural(shown.length, 'game')}</span>
          </div>
          <div className="ap-gutter">
            {rest.map((g, i) => (
              <GameRow key={g.id} g={g} first={i === 0} />
            ))}
          </div>
        </div>
      )}
    </>
  );
}

function GameRow({ g, first }: { g: GameCard; first: boolean }) {
  return (
    <Tap className={cx('ap-app-row', !first && 'divided')} to={`/play/games/${g.slug}`} label={g.title}>
      <Img icon="gamepad-2" tint={tileTint(g.id)} className="ap-app-icon" src={g.icon?.thumbUrl ?? g.icon?.url ?? undefined} alt="" />
      <span style={{ flex: 1, minWidth: 0 }}>
        <span className="ap-h4" style={{ display: 'block' }}>{g.title}</span>
        <span className="ap-xs ap-muted">
          {g.genre}
          {ratingValue(g.rating) ? ' · ' : ''}
          {ratingValue(g.rating) && <Stars rating={g.rating} count={g.ratingCount} />}
        </span>
      </span>
      {g.hasPrizes && <span className="ap-badge deal-soft">Win coupons</span>}
      <span className="ap-btn soft sm">Play</span>
    </Tap>
  );
}

const PLAY_PERIODS = [
  { key: 'today', label: 'Today' },
  { key: 'week', label: 'This week' },
  { key: 'all_time', label: 'All time' },
];

function PlayRankingsTab() {
  const [period, setPeriod] = useState('week');
  const [game, setGame] = useState<string | null>(null);
  const games = useStore<PlayGames>(['play-games'], '/api/store/departments/play/games');
  const table = useStore<RankingTable>(['play-rankings', game ?? '', period], `/api/store/departments/play/rankings?period=${period}${game ? `&game=${encodeURIComponent(game)}` : ''}`);

  const list = games.data?.games ?? [];
  const selected = game ?? table.data?.game?.slug ?? null;
  const entries = [...(table.data?.entries ?? [])].sort((a, b) => a.rank - b.rank);
  const podium = entries.slice(0, 3);
  const rest = entries.slice(podium.length);
  const week = period === 'week' ? table.data?.week?.endsOn : null;
  const info = [
    table.data?.game?.title,
    week ? `week ends ${weekdayDate(week)}` : period === 'today' ? 'Today' : period === 'all_time' ? 'All time' : 'This week',
    table.data?.game?.hasPrizes ? 'top ranks win coupons' : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <>
      {list.length > 1 && (
        <div className="ap-chips" style={{ paddingTop: 16 }}>
          {list.map((g) => (
            <button key={g.id} type="button" className={cx('ap-chip', g.slug === selected && 'on')} onClick={() => setGame(g.slug)}>
              <Img icon="gamepad-2" tint={tileTint(g.id)} className="ap-chip-icon" src={g.icon?.thumbUrl ?? g.icon?.url ?? undefined} alt="" />
              {g.title}
            </button>
          ))}
        </div>
      )}
      <div className="ap-seg ap-gutter" role="group" aria-label="Ranking period">
        {PLAY_PERIODS.map((p) => (
          <button key={p.key} type="button" className={cx(period === p.key && 'on')} onClick={() => setPeriod(p.key)}>
            {p.label}
          </button>
        ))}
      </div>
      {table.isPending ? (
        <Loading list rows={4} />
      ) : table.isError ? (
        <ErrorBox title="We couldn’t load the rankings" error={table.error} onRetry={() => void table.refetch()} />
      ) : entries.length === 0 ? (
        <StateBox icon="trophy" title="No rankings for this period yet." />
      ) : (
        <>
          {info && (
            <div className="ap-gutter ap-xs ap-muted" style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 5 }}>
              <Icon name="clock" style={{ width: 13, height: 13 }} />
              {info}
            </div>
          )}
          <div className="ap-podium ap-gutter">
            {[1, 0, 2].map((i) => {
              const e = podium[i];
              if (!e) return <span key={i} />;
              return (
                <span key={e.rank} className={cx('ap-place', `p${e.rank}`)}>
                  <span className="ap-place-rank">{e.rank}</span>
                  <span className="ap-sm ap-strong ap-clamp2">{e.name}</span>
                  <span className="ap-xs ap-muted">{num(e.score)}</span>
                </span>
              );
            })}
          </div>
          {!!rest.length && (
            <div className="ap-section ap-gutter">
              <div className="ap-rank-head">
                <span>Rank</span>
                <span style={{ flex: 1 }}>Player</span>
                <span>Score</span>
                <span style={{ width: 28, textAlign: 'right' }}>±</span>
              </div>
              {rest.map((e) => (
                <div key={e.rank} className={cx('ap-rank-row', e.mine && 'mine')}>
                  <span className="ap-strong">{e.rank}</span>
                  <span style={{ flex: 1, minWidth: 0 }} className="ap-clamp2">{e.name}</span>
                  <span className="ap-strong">{num(e.score)}</span>
                  <span className={cx('ap-xs', (e.change ?? 0) > 0 ? 'ap-up' : (e.change ?? 0) < 0 ? 'ap-down' : 'ap-muted')} style={{ width: 28, textAlign: 'right' }}>
                    {e.change == null ? 'New' : e.change === 0 ? '–' : e.change > 0 ? `▲${e.change}` : `▼${Math.abs(e.change)}`}
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------- Daily rewards (feature/rewards/RewardsFragment.kt)

/**
 * Daily rewards needs a signed-in customer (`GET rewards/summary` is customer-only), so the preview's guest sees
 * exactly what a signed-out customer sees in the app: the Collect points screen with its Sign in button.
 */
function RewardsScreen() {
  const { note } = useNav();
  return (
    <div className="ap-page">
      <StateBox
        icon="gift"
        title="Collect points every day"
        text="Sign in to check in, finish daily tasks and swap points for coupons."
        action="Sign in"
        onAction={() => note('Signing in is off in the preview: it browses as a guest.')}
      />
      <div className="ap-gutter ap-xs ap-muted" style={{ textAlign: 'center', marginTop: -16 }}>
        The app shows this screen to a signed-out customer too. Points, streaks, tasks and the coupons they buy need a
        customer session, which the preview doesn’t have.
      </div>
    </div>
  );
}

