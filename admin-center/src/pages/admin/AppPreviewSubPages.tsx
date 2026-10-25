import { useState } from 'react';
import { cx } from '@marketly/web-shared/lib/cx';
import { date as longishDate, weekdayDate } from '@marketly/web-shared/lib/dates';
import { Icon, iconFor, Img, RichText, type ContentLink } from '@marketly/web-shared/ui';
import {
  compactCount, decodeEntities, initials, num, plural, price, priceShort, ratingValue, servicePrice, tileTint, useStore,
  type AppCard, type BlogAuthor, type BlogPost, type BlogPostCard, type CompanyDetail, type FarmMachine, type FoodItemDetail, type GameDetail, type MediaRef, type MenuItemCard, type OpenDay, type Phone, type PhoneStorage, type ProviderDetail, type RestaurantDetail, type ServiceCard, type ServiceDetail, type SoftwareApp, type Page as ApiPage,
} from './data/appPreview';
import { EndNote, ErrorBox, Loading, PriceLine, SectionHead, StateBox, Stars, Tap, useNav, useScreenTitle } from './AppPreviewUi';

/**
 * The sub-pages of the department areas: what a card on a department page opens. A phone, an OS install or
 * post-sale service, a farm machine, an app and the app list, a welfare service, a place to book, a restaurant and
 * a dish (and their lists), a blog post and its author, a company, and a game — each drawn from the same Store API
 * call its screen in the app makes (PhoneDetailFragment, SoftwareAppFragment, WelfareServiceFragment,
 * BookingProviderFragment, FoodRestaurantFragment, FoodItemFragment, BlogPostFragment, BlogAuthorFragment,
 * CompanyFragment, GameFragment, FarmOrderFragment).
 *
 * The screens that are a *form* in the app — ordering a machine, booking a slot, adding a dish to the basket,
 * buying an app — draw what the customer sees and stop at the button: ordering, booking and buying all need a
 * signed-in customer, which the preview's guest session is not. Tapping one says so.
 */

const LIMIT = 20;

/** The quiet note under a form the preview can show but not submit. */
function OffNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="ap-gutter ap-xs ap-muted" style={{ marginTop: 10 }}>
      {children}
    </div>
  );
}

/** The sticky bar a detail screen ends with (the app's action bar). */
function ActionBar({ children }: { children: React.ReactNode }) {
  return <div className="ap-actionbar ap-actionbar-sticky">{children}</div>;
}

const openDays = (days: OpenDay[] | undefined): string => {
  const d = (days ?? []).filter((x) => x.open);
  if (!d.length) return 'Closed';
  return d.map((x) => `${x.weekday[0].toUpperCase()}${x.weekday.slice(1)} ${x.from}–${x.to}`).join(' · ');
};

// ---------------------------------------------------------------- the phone page (PhoneDetailFragment)

export function PhonePage({ slug }: { slug: string }) {
  const [tab, setTab] = useState<'detail' | 'ads'>('detail');
  const [storage, setStorage] = useState(0);
  const [colour, setColour] = useState(0);
  const [photo, setPhoto] = useState(0);
  const { go, note } = useNav();
  const q = useStore<Phone>(['phone', slug], `/api/store/departments/phones/${encodeURIComponent(slug)}`);
  useScreenTitle(q.data?.name);

  if (q.isPending) return <Loading />;
  if (q.isError) return <ErrorBox title="We couldn’t load this phone" error={q.error} onRetry={() => void q.refetch()} />;
  const p = q.data;
  const st: PhoneStorage | undefined = (p.storage ?? [])[Math.min(storage, (p.storage ?? []).length - 1)];
  const col = (p.colors ?? [])[Math.min(colour, (p.colors ?? []).length - 1)];
  const was = st?.was && st.was.amount > st.price.amount ? st.was : null;
  const saving = was && st ? { amount: was.amount - st.price.amount, currency: st.price.currency } : null;
  const pct = was && st ? Math.trunc(((was.amount - st.price.amount) * 100) / was.amount) : null;
  const selection = [st?.size, col?.name].filter(Boolean).join(' · ');
  const photos = p.photos ?? [];
  const shown = photos[Math.min(photo, Math.max(0, photos.length - 1))];
  const ads = p.adImages ?? [];

  return (
    <div className="ap-page ap-page-flush">
      {ads.length > 0 && (
        <div className="ap-seg ap-gutter" style={{ marginTop: 12 }} role="group" aria-label="Phone page">
          <button type="button" className={cx(tab === 'detail' && 'on')} onClick={() => setTab('detail')}>
            Detail
          </button>
          <button type="button" className={cx(tab === 'ads' && 'on')} onClick={() => setTab('ads')}>
            Advertisements <span className="ap-badge">{ads.length}</span>
          </button>
        </div>
      )}

      {tab === 'ads' ? (
        <div className="ap-section ap-gutter ap-stack">
          {ads.map((a, i) => (
            <div key={a.id} style={{ position: 'relative' }}>
              <Img icon="megaphone" tint={tileTint(a.id)} src={a.url} alt={a.alt ?? ''} />
              <span className="ap-ad-label">
                {i + 1} / {ads.length}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <>
          <div className="ap-gallery">
            <Img icon="smartphone" tint={tileTint(p.id)} src={shown?.url ?? undefined} alt={shown?.alt ?? ''} />
            {pct != null && pct > 0 && <span className="ap-badge deal" style={{ position: 'absolute', top: 12, left: 12 }}>−{pct}%</span>}
            {photos.length > 0 && (
              <span className="ap-gallery-count">
                {Math.min(photo, photos.length - 1) + 1} / {photos.length}
              </span>
            )}
          </div>
          {photos.length > 1 && (
            <div className="ap-thumbs">
              {photos.map((m, i) => (
                <button key={m.id} type="button" className="ap-thumb" aria-label={`Photo ${i + 1}`} onClick={() => setPhoto(i)}>
                  <Img icon="smartphone" tint={tileTint(p.id)} className={cx(i === photo && 'on')} src={m.thumbUrl ?? m.url} alt="" />
                </button>
              ))}
            </div>
          )}

          <div className="ap-gutter" style={{ marginTop: 16 }}>
            {p.brand && <div className="ap-xs ap-muted">{p.brand}</div>}
            <h1 className="ap-h1" style={{ marginTop: 2 }}>{p.name}</h1>
            {selection && <div className="ap-sm ap-sub" style={{ marginTop: 6 }}>{selection}</div>}
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 8 }}>
              <PriceLine now={st?.price} was={was} />
              {saving && <span className="ap-badge deal-soft">Save {priceShort(saving)}</span>}
            </div>
          </div>

          {!!(p.storage ?? []).length && (
            <div className="ap-section ap-gutter">
              <div className="ap-h4">
                <b>Storage:</b> {st?.size}
              </div>
              <div className="ap-opts" style={{ marginTop: 10 }}>
                {(p.storage ?? []).map((s, i) => (
                  <button key={s.size} type="button" className={cx('ap-opt', i === Math.min(storage, (p.storage ?? []).length - 1) && 'on')} onClick={() => setStorage(i)}>
                    <span className="ap-sm ap-strong">{s.size}</span>
                    <span className="ap-xs ap-muted">{price(s.price)}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {!!(p.colors ?? []).length && (
            <div className="ap-section ap-gutter">
              <div className="ap-h4">
                <b>Color:</b> {col?.name}
              </div>
              <div className="ap-swatches">
                {(p.colors ?? []).map((c, i) => (
                  <button key={c.name} type="button" className={cx('ap-opt', i === Math.min(colour, (p.colors ?? []).length - 1) && 'on')} onClick={() => setColour(i)}>
                    <span className="ap-swatch" style={{ background: c.hex }} />
                    <span className="ap-xs ap-strong">{c.short || c.name}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {p.showServices && (
            <div className="ap-section ap-gutter">
              <div className="ap-box" style={{ margin: 0 }}>
                <div className="ap-h4">Includes free OS install and 1-year post-sale service</div>
                <p className="ap-sm ap-sub" style={{ marginTop: 4 }}>Setup with your data moved over, plus screen and battery cover for 12 months.</p>
                <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                  <button type="button" className="ap-btn secondary sm" onClick={() => go('/phones?tab=os-install')}>
                    OS install
                  </button>
                  <button type="button" className="ap-btn secondary sm" onClick={() => go('/phones?tab=post-sale')}>
                    Post-sale services
                  </button>
                </div>
              </div>
            </div>
          )}

          {!!p.overview && (
            <div className="ap-section ap-gutter">
              <h2 className="ap-h3">Overview</h2>
              {p.overview
                .split(/\r?\n\s*\r?\n/)
                .map((t) => t.trim())
                .filter(Boolean)
                .map((t) => (
                  <p key={t} className="ap-sm ap-sub" style={{ marginTop: 8 }}>
                    {decodeEntities(t)}
                  </p>
                ))}
            </div>
          )}

          {!!(p.specGroups ?? []).length && (
            <div className="ap-section ap-gutter">
              <h2 className="ap-h3">Specifications</h2>
              {(p.specGroups ?? []).map((g) => (
                <div key={g.name} style={{ marginTop: 14 }}>
                  {g.name && <div className="ap-h4">{g.name}</div>}
                  <dl style={{ margin: '6px 0 0' }}>
                    {g.rows.map((r) => (
                      <div key={`${r.name}${r.value}`} className="ap-kv">
                        <dt>{r.name}</dt>
                        <dd>{r.value}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      <ActionBar>
        <div className="ap-actionbar-price">
          <PriceLine now={st?.price} />
          <div className="ap-xs ap-muted">{selection}</div>
        </div>
        <button type="button" className="ap-btn" onClick={() => note('Find in store opens a search in the app; search is off in the preview.')}>
          Find in store
        </button>
      </ActionBar>
    </div>
  );
}

// ---------------------------------------------------------------- a service page (WelfareServiceFragment, the OS install and post-sale pages)

const AREA_ICON = { os_install: 'wrench', post_sale: 'shield-check', welfare: 'hand-heart' } as const;

export function ServicePage({ area, slug }: { area: 'os_install' | 'post_sale' | 'welfare'; slug: string }) {
  const { note } = useNav();
  const q = useStore<ServiceDetail>(['service', slug], `/api/store/services/services/${encodeURIComponent(slug)}`);
  useScreenTitle(q.data?.title);

  if (q.isPending) return <Loading />;
  if (q.isError) return <ErrorBox title="We couldn’t load this service" error={q.error} onRetry={() => void q.refetch()} />;
  const s = q.data;
  const photos = s.photos?.length ? s.photos : s.image ? [s.image] : [];

  return (
    <div className="ap-page ap-page-flush">
      {!!photos.length && (
        <div className="ap-gallery">
          <Img icon={AREA_ICON[area]} tint={tileTint(s.id)} src={photos[0].url ?? undefined} alt={photos[0].alt ?? ''} />
          {photos.length > 1 && <span className="ap-gallery-count">1 / {photos.length}</span>}
        </div>
      )}
      <div className="ap-gutter" style={{ paddingTop: photos.length ? 0 : 20 }}>
        {s.provider?.name && (
          <Tap className="ap-link" to={s.provider.slug ? `/providers/${s.provider.slug}` : null}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              {decodeEntities(s.provider.name)}
              {s.provider.verified && <Icon name="badge-check" style={{ width: 14, height: 14 }} />}
            </span>
          </Tap>
        )}
        <h1 className="ap-h1" style={{ marginTop: 4 }}>{decodeEntities(s.title)}</h1>
        <div className="ap-sm ap-sub" style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {(s.rating?.count ?? 0) > 0 && <Stars rating={s.rating?.average} count={s.rating?.count} />}
          {s.category?.name && <span className="ap-badge">{s.category.name}</span>}
          {s.badge && <span className="ap-badge brand">{s.badge}</span>}
        </div>
        {s.description && <p className="ap-sm ap-sub" style={{ marginTop: 12 }}>{decodeEntities(s.description)}</p>}
      </div>

      {!!s.included?.length && (
        <div className="ap-section ap-gutter">
          <h2 className="ap-h3">What’s included</h2>
          <ul className="ap-bullets" style={{ marginTop: 8 }}>
            {s.included.map((t) => (
              <li key={t}>{decodeEntities(t)}</li>
            ))}
          </ul>
        </div>
      )}

      {!!s.requirements?.length && (
        <div className="ap-section ap-gutter">
          <h2 className="ap-h3">Who it’s for</h2>
          <ul className="ap-bullets" style={{ marginTop: 8 }}>
            {s.requirements.map((t) => (
              <li key={t}>{decodeEntities(t)}</li>
            ))}
          </ul>
        </div>
      )}

      {!!s.priceTable?.length && (
        <div className="ap-section ap-gutter">
          <h2 className="ap-h3">{s.priceTableTitle || 'Price by option'}</h2>
          <div className="ap-box" style={{ margin: '10px 0 0' }}>
            {s.priceTable.map((r) => (
              <div key={`${r.label}${r.price}`} className="ap-kv">
                <dt>
                  <span className="ap-sm ap-strong" style={{ display: 'block', color: 'var(--text)' }}>{r.label}</span>
                  {r.detail && <span className="ap-xs ap-muted">{r.detail}</span>}
                </dt>
                <dd className="ap-strong">{r.price}</dd>
              </div>
            ))}
          </div>
        </div>
      )}

      {!!s.terms?.length && (
        <div className="ap-section ap-gutter">
          <h2 className="ap-h3">Warranty terms</h2>
          <ul className="ap-bullets" style={{ marginTop: 8 }}>
            {s.terms.map((t) => (
              <li key={t}>{decodeEntities(t)}</li>
            ))}
          </ul>
        </div>
      )}

      {s.provider?.name && (
        <div className="ap-section ap-gutter">
          <div className="ap-box" style={{ margin: 0 }}>
            <div className="ap-h4" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {decodeEntities(s.provider.name)}
              {s.provider.verified && <Icon name="badge-check" style={{ width: 15, height: 15, color: 'var(--brand)' }} />}
            </div>
            {s.coverage && <div className="ap-sm ap-sub" style={{ marginTop: 4 }}>{s.coverage}</div>}
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <span className="ap-btn secondary sm">Call</span>
              <span className="ap-btn secondary sm">Message</span>
            </div>
          </div>
        </div>
      )}

      <ActionBar>
        <div className="ap-actionbar-price">
          <div className="ap-price">{servicePrice(s.fromPrice, s.priceUnit)}</div>
          <div className="ap-xs ap-muted">{s.firstAvailable ?? s.coverage ?? ''}</div>
        </div>
        <button type="button" className="ap-btn" onClick={() => note('Booking needs a signed-in customer; it is off in the preview.')}>
          Book
        </button>
      </ActionBar>
    </div>
  );
}

// ---------------------------------------------------------------- a farm machine (FarmOrderFragment)

export function MachinePage({ productId }: { productId: string }) {
  const { note } = useNav();
  const q = useStore<FarmMachine>(['machine', productId], `/api/store/departments/farm/machines/${encodeURIComponent(productId)}`);
  useScreenTitle(q.data ? 'Order a machine' : undefined);

  if (q.isPending) return <Loading list rows={3} />;
  if (q.isError) return <ErrorBox title="We couldn’t load this machine" error={q.error} onRetry={() => void q.refetch()} />;
  const m = q.data;
  const p = m.product;

  return (
    <div className="ap-page ap-page-flush">
      <div className="ap-section ap-gutter">
        <div className="ap-row-card top">
          <span style={{ flex: 'none', width: 84 }}>
            <Img icon="tractor" tint={tileTint(p.productId)} src={p.image?.thumbUrl ?? p.image?.url ?? undefined} alt="" />
          </span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span className="ap-h4 ap-clamp2" style={{ display: 'block' }}>{decodeEntities(p.title ?? '')}</span>
            {!!m.highlights?.length && (
              <span className="ap-specs">
                {m.highlights.map((h) => (
                  <span key={h}>{h}</span>
                ))}
              </span>
            )}
            {p.price && <span className="ap-h4" style={{ display: 'block', marginTop: 8 }}>{price(p.price)}</span>}
          </span>
        </div>
      </div>

      {!!m.attachments?.length && (
        <div className="ap-section">
          <SectionHead title="Attachments" />
          <div className="ap-gutter ap-stack">
            {m.attachments.map((a) => (
              <div key={a.productId} className="ap-row-card">
                <span style={{ flex: 'none', width: 56 }}>
                  <Img icon="wrench" tint={tileTint(a.productId)} src={a.image?.thumbUrl ?? a.image?.url ?? undefined} alt="" />
                </span>
                <span style={{ flex: 1, minWidth: 0 }} className="ap-sm ap-clamp2">{decodeEntities(a.title ?? '')}</span>
                {a.price && <span className="ap-sm ap-strong">{price(a.price)}</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="ap-section ap-gutter">
        <h2 className="ap-h3">Delivery and contact</h2>
        <div className="ap-stack" style={{ marginTop: 10 }}>
          {['Delivery date', 'Delivery address', 'Contact name', 'Contact phone'].map((f) => (
            <label key={f} className="ap-field">
              <span className="ap-xs ap-muted">{f}</span>
              <span className="ap-input">—</span>
            </label>
          ))}
        </div>
        <OffNote>The order form needs a signed-in customer, so its fields stay empty here. Payment options load with the customer’s account.</OffNote>
      </div>

      <ActionBar>
        <div className="ap-actionbar-price">
          <PriceLine now={p.price} />
          <div className="ap-xs ap-muted">Total</div>
        </div>
        <button type="button" className="ap-btn" onClick={() => note('Ordering a machine needs a signed-in customer; it is off in the preview.')}>
          Place order
        </button>
      </ActionBar>
    </div>
  );
}

// ---------------------------------------------------------------- an app and the app list (SoftwareAppFragment, SoftwareAppsFragment)

const appIcon = (a: { category?: { slug?: string } }) => {
  const slug = a.category?.slug ?? '';
  return slug.includes('game') ? 'gamepad-2' : slug.includes('browser') ? 'globe' : slug.includes('multimedia') || slug.includes('photo') ? 'image' : 'app-window';
};
const appPriceLabel = (a: AppCard): string => a.price?.label || (a.price?.free ? 'Free' : price(a.price?.current));

export function AppPage({ slug }: { slug: string }) {
  const { go, note } = useNav();
  const q = useStore<SoftwareApp>(['app', slug], `/api/store/software/apps/${encodeURIComponent(slug)}`);
  useScreenTitle(q.data?.title);

  if (q.isPending) return <Loading />;
  if (q.isError) return <ErrorBox title="We couldn’t load this app" error={q.error} onRetry={() => void q.refetch()} />;
  const a = q.data;
  const stats = [
    { label: 'Rating', value: ratingValue(a.rating) ?? 'New' },
    { label: 'Size', value: a.sizeLabel || '—' },
    { label: 'Downloads', value: compactCount(a.downloads ?? 0) },
    { label: 'Version', value: a.version ?? '—' },
  ];

  return (
    <div className="ap-page ap-page-flush">
      <div className="ap-gutter" style={{ paddingTop: 20, display: 'flex', gap: 14 }}>
        <Img icon={appIcon(a)} tint={tileTint(a.id)} className="ap-app-icon lg" src={a.icon?.url ?? undefined} alt="" />
        <span style={{ flex: 1, minWidth: 0 }}>
          <span className="ap-h2" style={{ display: 'block' }}>{a.title}</span>
          {a.company?.name && (
            <Tap className="ap-link" to={a.company.companySlug ? `/companies/${a.company.companySlug}` : null}>
              {decodeEntities(a.company.name)}
            </Tap>
          )}
          <span className="ap-xs ap-muted" style={{ display: 'block', marginTop: 4 }}>{[a.category?.name, a.subcategory].filter(Boolean).join(' · ')}</span>
        </span>
      </div>

      <div className="ap-stats ap-gutter">
        {stats.map((s) => (
          <span key={s.label}>
            <b>{s.value}</b>
            <i>{s.label}</i>
          </span>
        ))}
      </div>

      {!!a.screenshots?.length && (
        <div className="ap-section">
          <div className="ap-rail">
            {a.screenshots.map((m: MediaRef, i) => (
              <Img key={m.id ?? i} icon="image" tint={tileTint(a.id)} className="ap-shot" src={m.url ?? undefined} alt={m.alt ?? ''} />
            ))}
          </div>
        </div>
      )}

      {a.description && (
        <div className="ap-section ap-gutter">
          <h2 className="ap-h3">About this app</h2>
          <p className="ap-sm ap-sub" style={{ marginTop: 8 }}>{decodeEntities(a.description)}</p>
          {a.moreDescription && <p className="ap-sm ap-sub" style={{ marginTop: 8 }}>{decodeEntities(a.moreDescription)}</p>}
        </div>
      )}

      {!!a.whatYouGet?.length && (
        <div className="ap-section ap-gutter">
          <h2 className="ap-h3">What you get</h2>
          <ul className="ap-bullets" style={{ marginTop: 8 }}>
            {a.whatYouGet.map((t) => (
              <li key={t}>{decodeEntities(t)}</li>
            ))}
          </ul>
        </div>
      )}

      {(a.licenceLabel || a.licenceDevices) && (
        <div className="ap-section ap-gutter">
          <div className="ap-box" style={{ margin: 0 }}>
            <div className="ap-h4">Licence</div>
            <div className="ap-sm ap-sub" style={{ marginTop: 4 }}>{[a.licenceLabel, a.licenceDevices].filter(Boolean).join(' · ')}</div>
          </div>
        </div>
      )}

      {!!a.platformLabels?.length && (
        <div className="ap-section ap-gutter">
          <h2 className="ap-h3">Works on</h2>
          <div className="ap-chips" style={{ padding: 0, marginTop: 8 }}>
            {a.platformLabels.map((t) => (
              <span key={t} className="ap-chip">{t}</span>
            ))}
          </div>
        </div>
      )}

      {a.whatsNew && (
        <div className="ap-section ap-gutter">
          <h2 className="ap-h3">What’s new</h2>
          <p className="ap-sm ap-sub" style={{ marginTop: 8 }}>{decodeEntities(a.whatsNew)}</p>
        </div>
      )}

      {!!a.minRequirements?.length && (
        <div className="ap-section ap-gutter">
          <h2 className="ap-h3">Requirements</h2>
          <ul className="ap-bullets" style={{ marginTop: 8 }}>
            {a.minRequirements.map((t) => (
              <li key={t}>{decodeEntities(t)}</li>
            ))}
          </ul>
        </div>
      )}

      {a.notice && <OffNote>{decodeEntities(a.notice)}</OffNote>}

      <ActionBar>
        <div className="ap-actionbar-price">
          <div className="ap-price">{appPriceLabel(a)}</div>
          {a.price?.wasLabel && <div className="ap-xs ap-muted" style={{ textDecoration: 'line-through' }}>{a.price.wasLabel}</div>}
        </div>
        <button type="button" className="ap-btn secondary" onClick={() => go(`/software/apps?category=${a.category?.slug ?? ''}`)}>
          More like this
        </button>
        <button type="button" className="ap-btn" onClick={() => note(a.price?.free ? 'Getting an app needs a signed-in customer.' : 'Buying needs a signed-in customer; it is off in the preview.')}>
          {a.price?.free ? 'Get' : 'Buy'}
        </button>
      </ActionBar>
    </div>
  );
}

export function AppsListPage({ query }: { query: URLSearchParams }) {
  const search = new URLSearchParams(query);
  search.set('limit', String(LIMIT));
  const title = query.get('title') || query.get('q') || 'Apps';
  const q = useStore<ApiPage<AppCard>>(['apps', search.toString()], `/api/store/software/apps?${search.toString()}`);
  useScreenTitle(title);

  if (q.isPending) return <Loading list rows={5} />;
  if (q.isError) return <ErrorBox title="We couldn't load the apps" error={q.error} onRetry={() => void q.refetch()} />;
  const items = q.data.items ?? [];
  if (!items.length) return <StateBox icon="app-window" title="No apps here yet" text="Apps for your phone and PC show up here soon." />;

  return (
    <div className="ap-page">
      <div className="ap-gutter" style={{ paddingTop: 16 }}>
        <span className="ap-sm ap-sub">{plural(q.data.total ?? items.length, 'app')}</span>
        <div style={{ marginTop: 8 }}>
          {items.map((a, i) => (
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
              <span className={cx('ap-btn sm', a.owned ? 'secondary' : 'soft')}>{a.owned ? 'Open' : appPriceLabel(a)}</span>
            </Tap>
          ))}
        </div>
      </div>
      <EndNote>That’s every app</EndNote>
    </div>
  );
}

// ---------------------------------------------------------------- a place to book (BookingProviderFragment, ProviderFragment)

export function ProviderPage({ slug }: { slug: string }) {
  const { note } = useNav();
  const q = useStore<ProviderDetail>(['provider', slug], `/api/store/services/providers/${encodeURIComponent(slug)}`);
  useScreenTitle(q.data?.name);

  if (q.isPending) return <Loading />;
  if (q.isError) return <ErrorBox title="We couldn’t load this place" error={q.error} onRetry={() => void q.refetch()} />;
  const p = q.data;
  const photos = p.photos?.length ? p.photos : [p.cover, p.logo].filter(Boolean as unknown as (m: MediaRef | null | undefined) => m is MediaRef);

  return (
    <div className="ap-page">
      <div className="ap-gallery">
        <Img icon={iconFor(p.category?.slug, 'calendar-check')} tint={tileTint(p.id)} src={photos[0]?.url ?? undefined} alt={photos[0]?.alt ?? ''} />
        {photos.length > 1 && <span className="ap-gallery-count">1 / {photos.length}</span>}
      </div>

      <div className="ap-gutter" style={{ marginTop: 16 }}>
        <h1 className="ap-h1" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {decodeEntities(p.name)}
          {p.verified && <Icon name="badge-check" style={{ width: 18, height: 18, color: 'var(--brand)' }} />}
        </h1>
        <div className="ap-sm ap-sub" style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {(p.rating?.count ?? 0) > 0 && <Stars rating={p.rating?.average} count={p.rating?.count} />}
          {p.kind && <span>{p.kind}</span>}
        </div>
        {p.address && <div className="ap-sm ap-sub" style={{ marginTop: 6 }}>{p.address}</div>}
        {p.openLabel && <div className="ap-xs ap-muted" style={{ marginTop: 2 }}>{p.openLabel} · {openDays(p.hours?.days)}</div>}
        {p.replyTime && <div className="ap-xs ap-muted" style={{ marginTop: 2 }}>{p.replyTime}</div>}
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <span className="ap-btn secondary sm">Call</span>
          <span className="ap-btn secondary sm">Message</span>
        </div>
      </div>

      {p.description && (
        <div className="ap-section ap-gutter">
          <h2 className="ap-h3">About</h2>
          <p className="ap-sm ap-sub" style={{ marginTop: 8 }}>{decodeEntities(p.description)}</p>
          {p.since && <p className="ap-xs ap-muted" style={{ marginTop: 6 }}>In business since {p.since}</p>}
        </div>
      )}

      <div className="ap-section">
        <SectionHead title="Services" />
        {(p.services ?? []).length === 0 ? (
          <div className="ap-gutter ap-sm ap-muted">This place has no services to book yet.</div>
        ) : (
          <div className="ap-gutter ap-stack">
            {(p.services ?? []).map((s: ServiceCard) => (
              <div key={s.id} className="ap-row-card">
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span className="ap-h4" style={{ display: 'block' }}>{decodeEntities(s.title)}</span>
                  {s.summary && <span className="ap-xs ap-muted">{decodeEntities(s.summary)}</span>}
                </span>
                <span className="ap-sm ap-strong">{servicePrice(s.fromPrice, s.priceUnit)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {!!p.staff?.length && (
        <div className="ap-section ap-gutter">
          <h2 className="ap-h3">Staff</h2>
          <div className="ap-stack" style={{ marginTop: 10 }}>
            {p.staff.map((m) => (
              <div key={m.id} className="ap-row-card">
                <span className="ap-logo" style={{ width: 36, height: 36 }}>{initials(m.name)}</span>
                <span style={{ flex: 1 }}>
                  <span className="ap-sm ap-strong" style={{ display: 'block' }}>{m.name}</span>
                  {m.role && <span className="ap-xs ap-muted">{m.role}</span>}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="ap-section ap-gutter">
        <h2 className="ap-h3">Book a time</h2>
        <OffNote>Choosing a service, a day and a free slot needs a signed-in customer, so the booking steps stop here in the preview.</OffNote>
        <button type="button" className="ap-btn block" style={{ marginTop: 12 }} onClick={() => note('Booking needs a signed-in customer; it is off in the preview.')}>
          Confirm booking
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- a restaurant, a dish and their lists (Food*)

function FoodRow({ f, to }: { f: MenuItemCard; to: string }) {
  const { note } = useNav();
  return (
    <Tap className="ap-row-card top" to={to} label={f.name}>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span className="ap-h4 ap-clamp2" style={{ display: 'block' }}>{decodeEntities(f.name)}</span>
        {f.description && <span className="ap-xs ap-muted ap-clamp2" style={{ display: 'block', marginTop: 2 }}>{decodeEntities(f.description)}</span>}
        <span className="ap-sm ap-strong" style={{ display: 'block', marginTop: 6 }}>
          {f.priceLabel || price(f.price)}
          {f.wasLabel && <span className="ap-xs ap-muted" style={{ marginLeft: 6, textDecoration: 'line-through' }}>{f.wasLabel}</span>}
        </span>
      </span>
      <span style={{ flex: 'none', width: 76, position: 'relative' }}>
        <Img icon="utensils" tint={tileTint(f.id)} src={f.image?.thumbUrl ?? f.image?.url ?? undefined} alt="" />
        {f.available !== false && (
          <span className="ap-food-add" role="button" tabIndex={0} onClick={(e) => (e.stopPropagation(), note('The basket needs a signed-in shopper.'))} onKeyDown={(e) => e.key === 'Enter' && (e.stopPropagation(), note('The basket needs a signed-in shopper.'))}>
            <Icon name="plus" />
          </span>
        )}
      </span>
    </Tap>
  );
}

export function RestaurantPage({ slug }: { slug: string }) {
  const q = useStore<RestaurantDetail>(['restaurant', slug], `/api/store/food/restaurants/${encodeURIComponent(slug)}`);
  useScreenTitle(q.data?.name);

  if (q.isPending) return <Loading />;
  if (q.isError) return <ErrorBox title="We couldn’t load this restaurant" error={q.error} onRetry={() => void q.refetch()} />;
  const r = q.data;

  return (
    <div className="ap-page">
      <div style={{ position: 'relative' }}>
        <Img icon="utensils" tint={tileTint(r.id)} className="wide" src={(r.photos?.[0] ?? r.image)?.url ?? undefined} alt="" />
        <span className={cx('ap-badge', r.open ? 'success' : '')} style={{ position: 'absolute', top: 12, left: 12 }}>
          {r.open ? 'Open' : r.openLabel || 'Closed'}
        </span>
      </div>
      <div className="ap-gutter" style={{ marginTop: 14 }}>
        <h1 className="ap-h1">{decodeEntities(r.name)}</h1>
        <div className="ap-sm ap-sub" style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {(r.ratings?.count ?? 0) > 0 && <Stars rating={r.ratings?.average} count={r.ratings?.count} />}
          {r.cuisine && <span>{r.cuisine}</span>}
        </div>
        <div className="ap-stats" style={{ marginTop: 12, paddingLeft: 0, paddingRight: 0 }}>
          <span>
            <b>{r.deliveryLabel}</b>
            <i>Delivery</i>
          </span>
          <span>
            <b>{r.feeLabel}</b>
            <i>Fee</i>
          </span>
          <span>
            <b>{r.minOrderLabel ?? '—'}</b>
            <i>Minimum</i>
          </span>
        </div>
        {r.promoText && <div className="ap-badge deal-soft" style={{ marginTop: 12 }}>{r.promoText}</div>}
        {r.address && <div className="ap-xs ap-muted" style={{ marginTop: 10 }}>{[r.address, r.city].filter(Boolean).join(', ')}</div>}
        {r.openLabel && <div className="ap-xs ap-muted" style={{ marginTop: 2 }}>{r.openLabel}</div>}
      </div>

      {(r.sections ?? []).map((sec) => (
        <div key={sec.name} className="ap-section">
          <SectionHead title={sec.name ?? 'Menu'} />
          <div className="ap-gutter ap-stack">
            {sec.items.map((f) => (
              <FoodRow key={f.id} f={f} to={`/food/items/${f.id}`} />
            ))}
          </div>
        </div>
      ))}
      {!(r.sections ?? []).length && <StateBox icon="utensils" title="No menu yet" text="Dishes appear here as the restaurant adds them." />}
    </div>
  );
}

export function FoodItemPage({ id }: { id: string }) {
  const { note } = useNav();
  const q = useStore<FoodItemDetail>(['food-item', id], `/api/store/food/items/${encodeURIComponent(id)}`);
  useScreenTitle(q.data?.name);

  if (q.isPending) return <Loading />;
  if (q.isError) return <ErrorBox title="We couldn’t load this dish" error={q.error} onRetry={() => void q.refetch()} />;
  const f = q.data;

  return (
    <div className="ap-page ap-page-flush">
      <div className="ap-gallery">
        <Img icon="utensils" tint={tileTint(f.id)} src={f.photos?.[0]?.url ?? undefined} alt="" />
        {(f.photos ?? []).length > 1 && <span className="ap-gallery-count">1 / {(f.photos ?? []).length}</span>}
      </div>
      <div className="ap-gutter" style={{ marginTop: 14 }}>
        {f.restaurant && (
          <Tap className="ap-link" to={f.restaurant.slug ? `/food/restaurants/${f.restaurant.slug}` : null}>
            {decodeEntities(f.restaurant.name)}
          </Tap>
        )}
        <h1 className="ap-h1" style={{ marginTop: 4 }}>{decodeEntities(f.name)}</h1>
        <div className="ap-sm ap-sub" style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {(f.ratingCount ?? 0) > 0 && <Stars rating={f.rating} count={f.ratingCount} />}
          {(f.dietTags ?? []).map((t) => (
            <span key={t} className="ap-badge">{t}</span>
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 10 }}>
          <span className="ap-h2">{f.priceLabel || price(f.price)}</span>
          {f.wasLabel && <span className="ap-sm ap-muted" style={{ textDecoration: 'line-through' }}>{f.wasLabel}</span>}
        </div>
        {f.description && <p className="ap-sm ap-sub" style={{ marginTop: 10 }}>{decodeEntities(f.description)}</p>}
      </div>

      {(f.optionGroups ?? []).map((g) => (
        <div key={g.id} className="ap-section ap-gutter">
          <h2 className="ap-h3">
            {g.name}
            {g.required && <span className="ap-badge brand" style={{ marginLeft: 8 }}>Required</span>}
          </h2>
          <div className="ap-box" style={{ margin: '10px 0 0' }}>
            {(g.options ?? []).map((o) => (
              <div key={o.id} className="ap-kv">
                <dt style={{ color: 'var(--text)' }}>{o.name}</dt>
                <dd className="ap-muted">{o.priceLabel ?? ''}</dd>
              </div>
            ))}
          </div>
        </div>
      ))}

      <ActionBar>
        <div className="ap-actionbar-price">
          <div className="ap-price">{f.priceLabel || price(f.price)}</div>
          <div className="ap-xs ap-muted">{f.available === false ? 'Not available now' : '1 item'}</div>
        </div>
        <button type="button" className="ap-btn" onClick={() => note('The basket needs a signed-in shopper; it is off in the preview.')}>
          Add to basket
        </button>
      </ActionBar>
    </div>
  );
}

export function FoodListPage({ what, query }: { what: 'restaurants' | 'items'; query: URLSearchParams }) {
  const search = new URLSearchParams(query);
  search.delete('search');
  search.set('limit', String(LIMIT));
  const title = what === 'restaurants' ? 'Food services' : 'Foods';
  useScreenTitle(title);
  const restaurants = useStore<ApiPage<RestaurantDetail>>(['food-list', 'restaurants', search.toString()], what === 'restaurants' ? `/api/store/food/restaurants?${search.toString()}` : null);
  const items = useStore<ApiPage<MenuItemCard>>(['food-list', 'items', search.toString()], what === 'items' ? `/api/store/food/items?${search.toString()}` : null);
  const q = what === 'restaurants' ? restaurants : items;

  if (q.isPending) return <Loading list rows={4} />;
  if (q.isError) return <ErrorBox title="Food delivery didn't load" error={q.error} onRetry={() => void q.refetch()} />;

  if (what === 'restaurants') {
    const list = restaurants.data?.items ?? [];
    if (!list.length) return <StateBox icon="utensils" title="No restaurants here yet" />;
    return (
      <div className="ap-page">
        <div className="ap-gutter ap-stack" style={{ paddingTop: 16 }}>
          {list.map((r, i) => (
            <Tap key={r.id} className="ap-food-card" to={`/food/restaurants/${r.slug}`} label={r.name}>
              <span className="ap-food-cover">
                <Img icon="utensils" tint={String(((i * 2 + 1) % 6) + 1)} src={(r.photos?.[0] ?? r.image)?.url ?? undefined} alt="" />
                <span className={cx('ap-badge', r.open ? 'success' : '')} style={{ position: 'absolute', top: 8, left: 8 }}>
                  {r.open ? 'Open' : r.openLabel || 'Closed'}
                </span>
              </span>
              <span className="ap-food-body">
                <span className="ap-h4" style={{ display: 'block' }}>{decodeEntities(r.name)}</span>
                <span className="ap-xs ap-muted" style={{ display: 'block', marginTop: 4 }}>{[r.cuisine, r.deliveryLabel, r.feeLabel].filter(Boolean).join(' · ')}</span>
              </span>
            </Tap>
          ))}
        </div>
        <EndNote>That’s every restaurant</EndNote>
      </div>
    );
  }

  const list = items.data?.items ?? [];
  if (!list.length) return <StateBox icon="utensils" title="No foods here yet" />;
  return (
    <div className="ap-page">
      <div className="ap-gutter ap-stack" style={{ paddingTop: 16 }}>
        {list.map((f) => (
          <FoodRow key={f.id} f={f} to={`/food/items/${f.id}`} />
        ))}
      </div>
      <EndNote>That’s every dish</EndNote>
    </div>
  );
}

// ---------------------------------------------------------------- a blog post and its author (BlogPostFragment, BlogAuthorFragment)

export function BlogPostPage({ slug }: { slug: string }) {
  const { go, note } = useNav();
  const q = useStore<BlogPost>(['blog-post', slug], `/api/store/departments/blogs/posts/${encodeURIComponent(slug)}`);
  useScreenTitle('Blogs');
  const Link: ContentLink = ({ url, className, children }) =>
    /^https?:/i.test(url) ? (
      <span className={className}>{children}</span>
    ) : (
      <button type="button" className={cx(className, 'ap-link')} onClick={() => go(url)}>
        {children}
      </button>
    );

  if (q.isPending) return <Loading rows={2} />;
  if (q.isError) return <ErrorBox title="We couldn’t load this post" error={q.error} onRetry={() => void q.refetch()} />;
  const p = q.data;

  return (
    <div className="ap-page">
      <div className="ap-gutter" style={{ paddingTop: 20 }}>
        {p.topic?.name && <span className="ap-badge brand">{p.topic.name}</span>}
        <h1 className="ap-h1" style={{ marginTop: 8 }}>{decodeEntities(p.title)}</h1>
        <div className="ap-xs ap-muted" style={{ marginTop: 6 }}>
          {[p.publishedAt && longishDate(p.publishedAt), (p.readMinutes ?? 0) > 0 ? `${p.readMinutes} min read` : null].filter(Boolean).join(' · ')}
        </div>
        {p.author?.name && (
          <Tap className="ap-row-card" to={p.author.slug ? `/blogs/authors/${p.author.slug}` : null} label={p.author.name}>
            <span className="ap-logo" style={{ width: 40, height: 40, borderRadius: '50%' }}>{initials(p.author.name)}</span>
            <span style={{ flex: 1 }}>
              <span className="ap-h4" style={{ display: 'block' }}>{decodeEntities(p.author.name)}</span>
              <span className="ap-xs ap-muted">
                {[plural(p.authorPostCount ?? 0, 'post'), `${compactCount(p.authorLikeCount ?? 0)} likes`].join(' · ')}
              </span>
            </span>
            <Icon name="chevron-right" style={{ width: 16, height: 16, color: 'var(--text-3)' }} />
          </Tap>
        )}
      </div>

      <div style={{ padding: '16px 16px 0' }}>
        <Img icon="newspaper" tint={tileTint(p.id)} className="wide" src={p.cover?.url ?? undefined} alt={p.cover?.alt ?? ''} />
      </div>

      <div className="ap-gutter">
        <RichText html={p.body} link={Link} proseClassName="ap-prose" />
      </div>

      <div className="ap-gutter" style={{ display: 'flex', gap: 10, marginTop: 20 }}>
        <button type="button" className="ap-btn secondary sm" onClick={() => note('Reacting needs a signed-in customer.')}>
          <Icon name="heart" />
          Like {compactCount(p.likeCount ?? 0)}
        </button>
        <button type="button" className="ap-btn secondary sm" onClick={() => note('Replies need a signed-in customer.')}>
          <Icon name="message-circle" />
          {plural(p.replyCount ?? 0, 'reply', 'replies')}
        </button>
      </div>

      {(p.previous || p.next) && (
        <div className="ap-section ap-gutter ap-stack">
          {p.previous && (
            <Tap className="ap-row-card" to={`/blogs/${p.previous.slug}`} label={p.previous.title}>
              <Icon name="arrow-left" style={{ width: 16, height: 16, flex: 'none', color: 'var(--text-3)' }} />
              <span className="ap-sm ap-clamp2">{decodeEntities(p.previous.title)}</span>
            </Tap>
          )}
          {p.next && (
            <Tap className="ap-row-card" to={`/blogs/${p.next.slug}`} label={p.next.title}>
              <span className="ap-sm ap-clamp2" style={{ flex: 1 }}>{decodeEntities(p.next.title)}</span>
              <Icon name="arrow-right" style={{ width: 16, height: 16, flex: 'none', color: 'var(--text-3)' }} />
            </Tap>
          )}
        </div>
      )}
    </div>
  );
}

export function BlogAuthorPage({ slug }: { slug: string }) {
  const { note } = useNav();
  const author = useStore<BlogAuthor>(['blog-author', slug], `/api/store/departments/blogs/authors/${encodeURIComponent(slug)}`);
  const posts = useStore<ApiPage<BlogPostCard>>(['blog-author-posts', slug], `/api/store/departments/blogs/authors/${encodeURIComponent(slug)}/posts?limit=${LIMIT}`);
  useScreenTitle(author.data?.name);

  if (author.isPending) return <Loading list rows={3} />;
  if (author.isError) return <ErrorBox title="We couldn’t load this author" error={author.error} onRetry={() => void author.refetch()} />;
  const a = author.data;

  return (
    <div className="ap-page">
      <div className="ap-gutter" style={{ paddingTop: 20, textAlign: 'center' }}>
        <span className="ap-logo" style={{ width: 72, height: 72, borderRadius: '50%', margin: '0 auto', fontSize: 20 }}>
          {a.avatar?.url ? <img src={a.avatar.url} alt="" /> : initials(a.name)}
        </span>
        <h1 className="ap-h2" style={{ marginTop: 10 }}>{decodeEntities(a.name)}</h1>
        {a.bio && <p className="ap-sm ap-sub" style={{ marginTop: 6 }}>{decodeEntities(a.bio)}</p>}
        <div className="ap-stats" style={{ paddingLeft: 0, paddingRight: 0, marginTop: 14 }}>
          <span>
            <b>{compactCount(a.postCount ?? 0)}</b>
            <i>Posts</i>
          </span>
          <span>
            <b>{compactCount(a.likeCount ?? 0)}</b>
            <i>Likes</i>
          </span>
          <span>
            <b>{compactCount(a.followerCount ?? 0)}</b>
            <i>Followers</i>
          </span>
        </div>
        <button type="button" className="ap-btn block" style={{ marginTop: 14 }} onClick={() => note('Following an author needs a signed-in customer.')}>
          Follow
        </button>
      </div>

      <div className="ap-section">
        <SectionHead title="Posts" />
        <div className="ap-gutter">
          {(posts.data?.items ?? []).map((p) => (
            <Tap key={p.id} className="ap-blog-row" to={`/blogs/${p.slug}`} label={p.title}>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span className="ap-h4 ap-clamp2" style={{ display: 'block' }}>{decodeEntities(p.title)}</span>
                <span className="ap-xs ap-muted" style={{ display: 'block', marginTop: 2 }}>
                  {[p.publishedAt && longishDate(p.publishedAt), plural(p.likeCount ?? 0, 'like'), plural(p.replyCount ?? 0, 'reply', 'replies')].filter(Boolean).join(' · ')}
                </span>
              </span>
              <Img icon="newspaper" tint={tileTint(p.id)} className="ap-blog-thumb" src={p.cover?.thumbUrl ?? p.cover?.url ?? undefined} alt="" />
            </Tap>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- a company (CompanyFragment)

export function CompanyPage({ slug }: { slug: string }) {
  const { note } = useNav();
  const q = useStore<CompanyDetail>(['company', slug], `/api/store/departments/companies/${encodeURIComponent(slug)}`);
  useScreenTitle(q.data?.name);

  if (q.isPending) return <Loading />;
  if (q.isError) return <ErrorBox title="We couldn’t load this company" error={q.error} onRetry={() => void q.refetch()} />;
  const c = q.data;
  const facts = [
    { label: 'Industry', value: c.industry?.name },
    { label: 'Founded', value: c.founded ? String(c.founded) : null },
    { label: 'Employees', value: c.employees },
    { label: 'City', value: c.city },
  ].filter((f) => f.value);

  return (
    <div className="ap-page">
      <div style={{ position: 'relative' }}>
        <Img icon="building-2" tint={tileTint(c.id)} className="wide" src={c.photos?.[0]?.url ?? undefined} alt="" />
      </div>
      <div className="ap-gutter" style={{ marginTop: -28 }}>
        <span className="ap-logo" style={{ width: 64, height: 64, border: '3px solid var(--surface)' }}>
          {c.logo?.url ? <img src={c.logo.url} alt="" /> : initials(c.name)}
        </span>
        <h1 className="ap-h1" style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
          {decodeEntities(c.name)}
          {c.verified && <Icon name="badge-check" style={{ width: 18, height: 18, color: 'var(--brand)' }} />}
        </h1>
        {c.tagline && <p className="ap-sm ap-sub" style={{ marginTop: 4 }}>{decodeEntities(c.tagline)}</p>}
        {ratingValue(c.rating) && (
          <div className="ap-sm" style={{ marginTop: 6 }}>
            <Stars rating={c.rating} count={c.ratingCount} />
          </div>
        )}
      </div>

      {!!facts.length && (
        <div className="ap-section ap-gutter">
          <div className="ap-box" style={{ margin: 0 }}>
            {facts.map((f) => (
              <div key={f.label} className="ap-kv">
                <dt>{f.label}</dt>
                <dd>{f.value}</dd>
              </div>
            ))}
          </div>
          <button type="button" className="ap-btn soft sm" style={{ marginTop: 12 }} onClick={() => note('Rating a company needs a signed-in customer.')}>
            <Icon name="star" />
            Rate this company
          </button>
        </div>
      )}

      {c.description && (
        <div className="ap-section ap-gutter">
          <h2 className="ap-h3">About</h2>
          {c.description
            .split(/\r?\n\s*\r?\n/)
            .map((t) => t.trim())
            .filter(Boolean)
            .map((t) => (
              <p key={t} className="ap-sm ap-sub" style={{ marginTop: 8 }}>
                {decodeEntities(t)}
              </p>
            ))}
        </div>
      )}

      {!!c.photos?.length && (
        <div className="ap-section">
          <SectionHead title="Photos" />
          <div className="ap-rail">
            {c.photos.map((m, i) => (
              <Img key={m.id ?? i} icon="image" tint={tileTint(c.id)} className="ap-shot" src={m.url ?? undefined} alt={m.alt ?? ''} />
            ))}
          </div>
        </div>
      )}

      {c.contacts && (
        <div className="ap-section ap-gutter">
          <h2 className="ap-h3">Contact</h2>
          <div className="ap-box" style={{ margin: '10px 0 0' }}>
            {([['Phone', c.contacts.phone], ['Email', c.contacts.email], ['Website', c.contacts.website], ['Address', c.contacts.address]] as const)
              .filter(([, v]) => v)
              .map(([k, v]) => (
                <div key={k} className="ap-kv">
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- a game (GameFragment)

export function GamePage({ slug }: { slug: string }) {
  const { go, note } = useNav();
  const q = useStore<GameDetail>(['game', slug], `/api/store/departments/play/games/${encodeURIComponent(slug)}`);
  useScreenTitle(q.data?.title);

  if (q.isPending) return <Loading />;
  if (q.isError) return <ErrorBox title="We couldn’t load this game" error={q.error} onRetry={() => void q.refetch()} />;
  const g = q.data;

  return (
    <div className="ap-page ap-page-flush">
      <Img icon="gamepad-2" tint={tileTint(g.id)} className="wide" src={(g.cover ?? g.icon)?.url ?? undefined} alt="" />
      <div className="ap-gutter" style={{ marginTop: 14 }}>
        <h1 className="ap-h1">{g.title}</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
          {g.genre && <span className="ap-badge">{g.genre}</span>}
          {g.hasPrizes && <span className="ap-badge deal">Win coupons</span>}
          {ratingValue(g.rating) && <Stars rating={g.rating} count={g.ratingCount} />}
        </div>
        {g.playersLabel && <div className="ap-xs ap-muted" style={{ marginTop: 6 }}>{g.playersLabel}</div>}
        {g.description && <p className="ap-sm ap-sub" style={{ marginTop: 12 }}>{decodeEntities(g.description)}</p>}
        <button type="button" className="ap-btn soft sm" style={{ marginTop: 12 }} onClick={() => note('Rating a game needs a signed-in customer.')}>
          <Icon name="star" />
          Rate this game
        </button>
      </div>

      {!!g.howToPlay?.length && (
        <div className="ap-section ap-gutter">
          <h2 className="ap-h3">How to play</h2>
          <ul className="ap-bullets" style={{ marginTop: 8 }}>
            {g.howToPlay.map((t) => (
              <li key={t}>{decodeEntities(t)}</li>
            ))}
          </ul>
        </div>
      )}

      {!!g.prizes?.length && (
        <div className="ap-section ap-gutter">
          <h2 className="ap-h3">Prizes</h2>
          {g.week?.endsOn && <div className="ap-xs ap-muted" style={{ marginTop: 4 }}>Week ends {weekdayDate(g.week.endsOn)}</div>}
          <div className="ap-box" style={{ margin: '10px 0 0' }}>
            {g.prizes.map((p) => (
              <div key={p.ranks} className="ap-kv">
                <dt style={{ color: 'var(--text)' }}>{p.ranks}</dt>
                <dd className="ap-strong">{p.reward}</dd>
              </div>
            ))}
          </div>
          {g.prizeNote && <div className="ap-xs ap-muted" style={{ marginTop: 8 }}>{decodeEntities(g.prizeNote)}</div>}
        </div>
      )}

      <div className="ap-section ap-gutter">
        <button type="button" className="ap-btn secondary block" onClick={() => go('/play/rankings')}>
          See the rankings
        </button>
      </div>

      <ActionBar>
        <div className="ap-actionbar-price">
          <div className="ap-sm ap-strong">{g.title}</div>
          <div className="ap-xs ap-muted">{num(g.ratingCount ?? 0)} ratings</div>
        </div>
        <button type="button" className="ap-btn" onClick={() => note('Playing happens in the app; it is off in the preview.')}>
          Play
        </button>
      </ActionBar>
    </div>
  );
}
