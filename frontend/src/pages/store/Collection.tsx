import { useState } from 'react';
import { Link } from 'react-router';
import { StoreLayout, type StoreNavKey } from '@/layouts';
import { useView } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import { Alert, Avatar, Breadcrumbs, Chip, ChipRow, EmptyState, Icon, Img, Pager, ProductCard, StatusBadge, Tabs } from '@marketly/web-shared/ui';
import { BEST_SELLERS, BEST_TABS, CURATED_SECTIONS, NEW_CHIPS, NEW_GROUPS, NEW_PAGES, SEASON_SECTIONS, SEASON_TERMS, item, items } from './data/collection';

// Design: pages/store/store-collection.html (New arrivals) · views: best-sellers, seasonal (Home Week),
// curated-collection (Desk setup for small spaces). The store nav ("New arrivals", "Best sellers"),
// the brand/Official Store collection tiles and the "Collections" crumb link between them.

type View = 'best-sellers' | 'seasonal' | 'curated-collection';

const CHROME: Record<View | '', { title: string; nav?: StoreNavKey }> = {
  '': { title: 'New arrivals', nav: 'new' },
  'best-sellers': { title: 'Best sellers', nav: 'best' },
  seasonal: { title: 'Home Week' },
  'curated-collection': { title: 'Collection' },
};

export default function Collection() {
  const [view] = useView<View>();
  const chrome = CHROME[view] ?? CHROME[''];
  return (
    <StoreLayout nav={chrome.nav} appbar={{ title: chrome.title }}>
      <div className="container page gap-6">
        {view === 'best-sellers' ? <BestSellers /> : view === 'seasonal' ? <Seasonal /> : view === 'curated-collection' ? <Curated /> : <NewArrivals />}
      </div>
    </StoreLayout>
  );
}

/* ---------------- New arrivals ---------------- */

function NewArrivals() {
  const [cat, setCat] = useState('');
  const [page, setPage] = useState(1);
  const groups = NEW_GROUPS.map((g) => ({ ...g, list: items(g.ids).filter((p) => !cat || p.cat === cat) })).filter((g) => g.list.length > 0);
  const total = cat ? 1 : NEW_PAGES;
  const pick = (v: string) => {
    setCat(v);
    setPage(1);
  };
  return (
    <>
      <Breadcrumbs items={[{ label: 'Home', to: href('store/home') }, { label: 'New arrivals' }]} />
      <div className="stack gap-2">
        <h1 className="h1">New arrivals</h1>
        <p className="small sub">Products first listed on Marketly in the last 30 days, newest first. Updated daily.</p>
      </div>
      <ChipRow>
        {NEW_CHIPS.map((c) => (
          <Chip key={c.value} active={cat === c.value} onClick={() => pick(c.value)}>
            {c.label}
          </Chip>
        ))}
      </ChipRow>
      {groups.map((g) => (
        <section key={g.added} className="stack gap-3" aria-label={`Added ${g.added}`}>
          <h2 className="h3 row gap-2">
            <Icon name="calendar-plus" /> Added {g.added}
          </h2>
          <div className="grid-products">
            {g.list.map((p) => (
              <ProductCard key={p.id} p={p} from showSeller />
            ))}
          </div>
        </section>
      ))}
      {groups.length === 0 && (
        <EmptyState icon="package-search" title="No new arrivals in this category yet" as="h2">
          New products show up here the day they are first listed.
        </EmptyState>
      )}
      <div className="row end">
        <Pager page={page} total={total} onPage={setPage} grid end={page >= total} />
      </div>
    </>
  );
}

/* ---------------- Best sellers ---------------- */

function BestSellers() {
  const [cat, setCat] = useState('');
  // Ranks are across all categories; a category tab filters the list but keeps each item's rank.
  const ranked = BEST_SELLERS.map((b, i) => ({ ...b, rank: i + 1, p: item(b.id) })).filter((r) => !cat || r.p.cat === cat);
  const catName = BEST_TABS.find((t) => t.value === cat)?.label ?? '';
  return (
    <>
      <Breadcrumbs items={[{ label: 'Home', to: href('store/home') }, { label: 'Best sellers' }]} />
      <div className="stack gap-2">
        <h1 className="h1">Best sellers</h1>
        <p className="small sub">Ranked by units sold in the last 30 days across all sellers. Updated every hour. Sponsored placements don’t affect rank.</p>
      </div>
      <Tabs items={BEST_TABS} active={cat} onChange={setCat} />
      {ranked.length > 0 ? (
        <div className="grid-products wide">
          {ranked.map((r) => (
            <div key={r.id} className="stack gap-2">
              <span className="shop-rank">
                <span className={r.rank <= 3 ? 'n top' : 'n'}>#{r.rank}</span>
                <span className="xs muted">{r.rank <= 3 ? 'Top 3 this month' : r.label}</span>
              </span>
              <ProductCard p={r.p} from showSeller />
            </div>
          ))}
        </div>
      ) : (
        <EmptyState icon="package-search" title={`No ${catName} items in the top 10 right now`} as="h2">
          Ranks update every hour.
        </EmptyState>
      )}
      <p className="xs muted">Last updated Oct 8, 2026, 6:00 PM PT</p>
    </>
  );
}

/* ---------------- Seasonal: Home Week ---------------- */

function Seasonal() {
  const [only, setOnly] = useState('');
  return (
    <>
      <Breadcrumbs items={[{ label: 'Home', to: href('store/home') }, { label: 'Home Week' }]} />
      <section className="shop-season" aria-labelledby="hw-h">
        <div className="copy">
          <span className="eyebrow u-c-on-brand u-o-_85">Seasonal campaign</span>
          <h1 className="display d-xl u-c-on-brand" id="hw-h">
            Home Week
          </h1>
          <p style={{ opacity: 0.92 }} className="measure-md">
            Up to 30% off bedding, lighting and cookware from the Official Store, Casa Verde Home and other approved sellers.
          </p>
          <div className="meta">
            <span>
              <Icon name="calendar" className="ic-sm" /> Oct 6 – Oct 19, 2026
            </span>
            <span>
              <Icon name="clock" className="ic-sm" /> Ends in 11 days
            </span>
          </div>
        </div>
        <div className="art" aria-hidden="true">
          <Img icon="bed-double" tint="1" />
          <Img icon="lamp-desk" tint="5" />
          <Img icon="cooking-pot" tint="3" />
          <Img icon="coffee" tint="3" />
        </div>
      </section>
      <ChipRow>
        {SEASON_SECTIONS.map((s) => (
          <Chip key={s.name} icon={s.icon} active={only === s.name} onClick={() => setOnly((o) => (o === s.name ? '' : s.name))}>
            {s.name}
          </Chip>
        ))}
      </ChipRow>
      {SEASON_SECTIONS.map((s) =>
        only && only !== s.name ? null : (
          <section key={s.name} className="stack gap-4" aria-label={s.name}>
            <div className="row between base">
              <h2 className="h2">
                <span className="row gap-2">
                  <Icon name={s.icon} />
                  {s.name}
                </span>
              </h2>
              <Link className="small strong" to={href('store/category')}>
                See all <Icon name="arrow-right" className="ic-sm" />
              </Link>
            </div>
            <div className="grid-products">
              {items(s.ids).map((p) => (
                <ProductCard key={p.id} p={p} from showSeller />
              ))}
            </div>
          </section>
        ),
      )}
      <section className="card pad stack gap-2" aria-labelledby="hw-terms">
        <h2 className="h4" id="hw-terms">
          Home Week terms
        </h2>
        <ul className="ul small sub stack gap-1">
          {SEASON_TERMS.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      </section>
    </>
  );
}

/* ---------------- Curated collection ---------------- */

function Curated() {
  const [only, setOnly] = useState('');
  return (
    <>
      <Breadcrumbs items={[{ label: 'Home', to: href('store/home') }, { label: 'Collections', to: href('store/collection', 'curated-collection') }, { label: 'Desk setup for small spaces' }]} />
      <section className="stack gap-3 measure-lg" aria-labelledby="cc-h">
        <span className="eyebrow">Curated collection</span>
        <h1 className="display d-xl" id="cc-h">
          Desk setup for small spaces
        </h1>
        <p className="lead">Twelve pieces for a desk in a studio apartment or a shared room: fewer cables, smaller footprints and light that doesn’t need a second outlet.</p>
        <div className="row gap-3">
          <Avatar name="Noor Aziz" />
          <span className="stack gap-0">
            <span className="small strong">Curated by Noor Aziz, Marketly editors</span>
            <span className="xs muted">Updated Oct 7, 2026 · 4 sections · 12 products</span>
          </span>
        </div>
      </section>
      <Alert tone="info" title="Only in-stock offers are included">
        We check availability every hour. If an item sells out, we replace it or remove it from this page. No seller paid to be included; items come from the Official Store and approved sellers, and each card names the seller.
      </Alert>
      <ChipRow>
        {CURATED_SECTIONS.map((s) => (
          <Chip key={s.name} icon={s.icon} active={only === s.name} onClick={() => setOnly((o) => (o === s.name ? '' : s.name))}>
            {s.name}
          </Chip>
        ))}
      </ChipRow>
      {CURATED_SECTIONS.map((s, i) =>
        only && only !== s.name ? null : (
          <section key={s.name} className="stack gap-4" aria-labelledby={`cc-s${i}`}>
            <div className="stack gap-2">
              <h2 className="h2 row gap-2" id={`cc-s${i}`}>
                <Icon name={s.icon} />
                {s.name}
              </h2>
              <p className="small sub u-maxw-72ch">
                <b>Editor’s note:</b> {s.note}
              </p>
            </div>
            <div className="grid-products">
              {s.picks.map((pk) => (
                <div key={pk.id} className="stack gap-2">
                  <ProductCard p={item(pk.id)} from showSeller />
                  <span className="row gap-2">
                    <StatusBadge status={pk.stock} />
                    <span className="xs muted">{pk.available} available · checked 6:00 PM PT</span>
                  </span>
                </div>
              ))}
            </div>
          </section>
        ),
      )}
      <p className="xs muted">Prices and stock are live and can change before you check out. You’ll see the final total before paying.</p>
    </>
  );
}
