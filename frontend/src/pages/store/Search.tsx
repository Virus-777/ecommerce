import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router';
import { StoreLayout } from '@/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { money, percentOff } from '@marketly/web-shared/lib/format';
import { useView } from '@marketly/web-shared/lib/hooks';
import { brands, sellers } from '@marketly/web-shared/data/fixtures';
import { href } from '@marketly/web-shared/routes';
import { Badge, Button, Checkbox, Dialog, EmptyState, Icon, IconButton, Img, LogoTile, Pager, Price, Radio, Select, SellerLine, Stars } from '@marketly/web-shared/ui';
import { ANCS, BATTERY, CONDITIONS, CONNECTIONS, HEADPHONES, PRICE_RANGES, SELLERS, SORTS, TYPES, type Listing, type Sort } from './data/category';
import { Count, DEFAULT_FILTERS, FilterGroups, matches, sortListings, toggleIn, type Filters, type ListKey, type SetFilter } from './data/listing-filters';
import {
  DESIGN_FILTERS, DESIGN_PAGES, DESIGN_PARTIAL, DESIGN_QUERY, DESIGN_RESULTS, DESIGN_TOTAL, DESIGN_TYPED, RECENT_SEARCHES, SEARCH_CATS, SEARCH_POOL, SPONSORED, SUGGESTIONS,
} from './data/search';

// Design: pages/store/store-search.html · view "suggestions-open" = the search suggestions panel
// (opened by focusing or typing in the header search field). The query comes from ?q=.

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
const STOP = new Set(['for', 'and', 'the', 'with', 'under', 'in', 'of', 'a']);
const searchHref = (q: string) => href('store/search', '', undefined, { q });
const isAudio = (s: string) => !s.trim() || /head|ear|bud|wireless|audio|halden|speaker|northwind|noise/.test(s);

/** Product card (.pcard). Unlike ProductCard, a sponsored Official Store item keeps its Official badge (design: sponsored row). */
function ResultCard({ p, sponsored }: { p: Listing; sponsored?: boolean }) {
  const [saved, setSaved] = useState(false);
  const off = percentOff(p.price, p.was);
  const official = p.seller === 'official';
  const to = href('store/product');
  return (
    <article className="pcard">
      <div className="pcard-media">
        <Link to={to} aria-label={p.name}>
          <Img icon={p.icon} tint={p.tint} />
        </Link>
        <div className="tags">
          {off > 0 && <Badge tone="deal">−{off}%</Badge>}
          {official && <Badge tone="brand">Official</Badge>}
          {sponsored && (
            <Badge tone="outline" className="sponsored-badge">
              Sponsored
            </Badge>
          )}
        </div>
        <button type="button" className={cx('fav', saved && 'is-active')} aria-label={`Save ${p.name} to wishlist`} aria-pressed={saved} onClick={() => setSaved((v) => !v)}>
          <Icon name="heart" fill={saved ? 'currentColor' : 'none'} />
        </button>
      </div>
      <Link className="name" to={to}>
        {p.name}
      </Link>
      <Stars rating={p.rating} count={p.reviews} />
      <Price amount={p.price} was={p.was} from={(p.offers ?? 1) > 1} noOff />
      <div className="meta">
        {p.free ? (
          <span>
            <Icon name="truck" className="ic-sm" /> Free delivery {p.delivery}
          </span>
        ) : (
          <span>Delivery {p.delivery}</span>
        )}
      </div>
      {p.seller && (
        <div className="meta">
          <SellerLine seller={p.seller} />
        </div>
      )}
    </article>
  );
}

/** Applied filters as removable chips. */
function activeFilters(f: Filters): Array<{ label: string; clear: (f: Filters) => Filters }> {
  const out: Array<{ label: string; clear: (f: Filters) => Filters }> = [];
  const without = <K extends keyof Filters>(k: K, v: string) => (x: Filters) => ({ ...x, [k]: (x[k] as string[]).filter((y) => y !== v) });
  if (f.min || f.max) {
    const label = f.min && f.max ? `Price: $${f.min} to $${f.max}` : f.min ? `Price: $${f.min} and up` : `Price: up to $${f.max}`;
    out.push({ label, clear: (x) => ({ ...x, min: '', max: '' }) });
  }
  const range = PRICE_RANGES.find((r) => r.id === f.range);
  if (range) out.push({ label: `Price: ${range.label}`, clear: (x) => ({ ...x, range: '' }) });
  if (f.rating) out.push({ label: `${f.rating} stars and up`, clear: (x) => ({ ...x, rating: '' }) });
  f.cats.forEach((c) => out.push({ label: c, clear: without('cats', c) }));
  f.brands.forEach((b) => out.push({ label: b, clear: without('brands', b) }));
  f.sellers.forEach((s) => out.push({ label: SELLERS.find((x) => x.id === s)?.label ?? s, clear: without('sellers', s) }));
  f.conditions.forEach((c) => out.push({ label: CONDITIONS.find((x) => x.id === c)?.label ?? c, clear: without('conditions', c) }));
  if (f.includeOos) out.push({ label: 'Include out of stock', clear: (x) => ({ ...x, includeOos: false }) });
  if (f.free) out.push({ label: 'Free delivery', clear: (x) => ({ ...x, free: false }) });
  if (f.byFri) out.push({ label: 'Arrives by Fri, Oct 16', clear: (x) => ({ ...x, byFri: false }) });
  if (f.today) out.push({ label: 'Ships today', clear: (x) => ({ ...x, today: false }) });
  f.types.forEach((t) => out.push({ label: TYPES.find((x) => x.id === t)?.label ?? t, clear: without('types', t) }));
  f.ancs.forEach((a) => out.push({ label: `Noise cancelling: ${ANCS.find((x) => x.id === a)?.label ?? a}`, clear: without('ancs', a) }));
  const battery = BATTERY.find((b) => b.id === f.battery);
  if (battery) out.push({ label: `Battery: ${battery.label}`, clear: (x) => ({ ...x, battery: '' }) });
  f.connections.forEach((c) => out.push({ label: CONNECTIONS.find((x) => x.id === c)?.label ?? c, clear: without('connections', c) }));
  return out;
}

/** True when every facet is either as the design loaded it or cleared (only filters were removed). */
const isRelaxation = (f: Filters) =>
  (Object.keys(f) as Array<keyof Filters>).every((k) => JSON.stringify(f[k]) === JSON.stringify(DESIGN_FILTERS[k]) || JSON.stringify(f[k]) === JSON.stringify(DEFAULT_FILTERS[k]));

function SearchCats({ p, f, toggle }: { p: string; f: Filters; toggle: (k: ListKey, v: string) => void }) {
  return (
    <>
      {SEARCH_CATS.map((c, i) => (
        <Checkbox key={c.name} id={`${p}-c${i}`} checked={f.cats.includes(c.name)} onChange={() => toggle('cats', c.name)} label={<>{c.name} <Count n={c.n} /></>} />
      ))}
    </>
  );
}

/** Suggestions panel under the header search field. */
function Suggestions({ typed, onClose }: { typed: string; onClose: () => void }) {
  const [recent, setRecent] = useState(RECENT_SEARCHES);
  const t = typed.replace(/^\s+/, '').toLowerCase();
  const cut = t.lastIndexOf(' ') + 1;
  const done = t.slice(0, cut);
  const partial = t.slice(cut);
  const cands = SUGGESTIONS.filter((s) => s.startsWith(done) && s !== done.trim());
  const sugg = [...cands.filter((s) => s.slice(done.length).startsWith(partial)), ...cands.filter((s) => !s.slice(done.length).startsWith(partial))].slice(0, 5);
  const audio = isAudio(t);
  const tokens = t.split(' ').filter((w) => w.length > 1);
  const brandHits = audio ? brands.filter((b) => b.name === 'Halden' || b.name === 'Kestrel') : brands.filter((b) => tokens.some((w) => b.name.toLowerCase().startsWith(w)));
  const productHits = audio
    ? [HEADPHONES[0], HEADPHONES.find((h) => h.id === 'wave')!]
    : SEARCH_POOL.filter((p) => tokens.length && tokens.every((w) => `${p.name} ${p.brand}`.toLowerCase().includes(w))).slice(0, 2);
  const top = sugg[0] ?? t;
  const clearRecent = (e: MouseEvent) => {
    e.preventDefault();
    setRecent([]);
  };

  return (
    <div className="shop-sugg-wrap">
      <div className="shop-sugg" role="region" aria-label="Search suggestions">
        <div className="shop-sugg-grid">
          <div>
            <h3>Suggestions</h3>
            {sugg.map((s, i) => (
              <Link key={s} className={cx('it', i === 0 && 'is-hl')} to={searchHref(s)}>
                <Icon name="search" />
                <span>
                  <span className="q">{done}</span>
                  <b>{s.slice(done.length)}</b>
                </span>
              </Link>
            ))}
            {audio && (
              <Link className="it" to={href('store/category')}>
                <Icon name="folder-tree" />
                <span>
                  <span className="q">{top}</span> in <b>Electronics › Headphones</b>
                </span>
              </Link>
            )}
            {brandHits.length > 0 && (
              <>
                <h3>Brands</h3>
                {brandHits.map((b) => (
                  <Link key={b.name} className="it" to={href('store/brand', '', { slug: b.name.toLowerCase() })}>
                    <LogoTile initials={b.initials} tint={b.tint} size="sm" />
                    <span className="stack gap-0">
                      <span className="strong">{b.name}</span>
                      <span className="xs muted">Brand · {b.products} products</span>
                    </span>
                  </Link>
                ))}
              </>
            )}
            {audio && (
              <>
                <h3>Stores</h3>
                <Link className="it" to={href('store/seller')}>
                  <LogoTile initials={sellers.northwind.initials} tint={sellers.northwind.tint} size="sm" />
                  <span className="stack gap-0 grow">
                    <span className="row gap-2">
                      <span className="strong">{sellers.northwind.name}</span>
                      <Badge tone="info" icon="shield-check">
                        Verified
                      </Badge>
                    </span>
                    <span className="xs muted">Seller store · 86 products in audio</span>
                  </span>
                  <span className="small strong t-brand-text nowrap">Visit store</span>
                </Link>
              </>
            )}
          </div>
          <div>
            {recent.length > 0 && (
              <>
                <div className="row between" style={{ paddingRight: 'var(--sp-3)' }}>
                  <h3>Recent searches</h3>
                  <a className="xs strong" href="#" onClick={clearRecent}>
                    Clear all
                  </a>
                </div>
                {recent.map((r) => (
                  <div key={r} className="recent">
                    <Link to={searchHref(r)}>
                      <Icon name="history" />
                      <span>{r}</span>
                    </Link>
                    <IconButton icon="x" label={`Remove “${r}” from recent searches`} onClick={() => setRecent((l) => l.filter((x) => x !== r))} />
                  </div>
                ))}
              </>
            )}
            {productHits.length > 0 && (
              <>
                <h3>Products</h3>
                {productHits.map((p) => (
                  <Link key={p.id} className="it" to={href('store/product')}>
                    <Img icon={p.icon} tint={p.tint} className="tiny" />
                    <span className="stack gap-0">
                      <span className="small truncate">{p.name}</span>
                      <span className="xs muted">
                        {(p.offers ?? 1) > 1 ? 'from ' : ''}
                        {money(p.price)} · {p.seller ? sellers[p.seller].name : ''}
                      </span>
                    </span>
                  </Link>
                ))}
              </>
            )}
            <p className="xs muted" style={{ padding: 'var(--sp-2) var(--sp-3)' }}>
              Recent searches are saved to your account (on this device when you're not signed in). Turn them off in{' '}
              <Link to={href('account/profile')} className="link-inline">
                Profile
              </Link>
              .
            </p>
          </div>
        </div>
      </div>
      <div className="shop-sugg-scrim" aria-hidden="true" onClick={onClose} />
    </div>
  );
}

function SearchPage({ q }: { q: string }) {
  const [view, setView] = useView<'suggestions-open'>();
  const suggOpen = view === 'suggestions-open';
  const designQuery = norm(q) === DESIGN_QUERY;

  const [typed, setTyped] = useState(suggOpen ? DESIGN_PARTIAL : q);
  const [f, setF] = useState<Filters>(designQuery ? DESIGN_FILTERS : DEFAULT_FILTERS);
  const [sort, setSort] = useState<Sort>('Recommended');
  const [page, setPage] = useState(1);
  const [sheet, setSheet] = useState(false);

  // The header search field lives in the layout: open the suggestions when it is focused or typed in.
  const viewRef = useRef(view);
  viewRef.current = view;
  useEffect(() => {
    const field = (t: EventTarget | null) => (t instanceof HTMLInputElement && (t.id === 'hdr-q' || t.id === 'hdr-mq') ? t : null);
    const open = (e: Event) => {
      const input = field(e.target);
      if (!input) return;
      setTyped(input.value);
      if (viewRef.current !== 'suggestions-open') setView('suggestions-open', { replace: true });
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && viewRef.current === 'suggestions-open') setView('', { replace: true });
    };
    document.addEventListener('focusin', open);
    document.addEventListener('input', open);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('focusin', open);
      document.removeEventListener('input', open);
      document.removeEventListener('keydown', onKey);
    };
  }, [setView]);

  const set: SetFilter = (k, v) => {
    setF((prev) => ({ ...prev, [k]: v }));
    setPage(1);
  };
  const toggle = (k: ListKey, v: string) => {
    setF((prev) => ({ ...prev, [k]: toggleIn(prev[k] as string[], v) }));
    setPage(1);
  };
  const clearAll = () => {
    setF(DEFAULT_FILTERS);
    setPage(1);
  };

  // Query matches: the design query returns the design's result page; any other query is matched
  // word by word against the sample catalogue.
  const base = useMemo(() => {
    if (designQuery) return DESIGN_RESULTS;
    const words = norm(q).split(' ').filter((w) => w.length > 1 && !STOP.has(w));
    return SEARCH_POOL.filter((p) => {
      const hay = `${p.name} ${p.brand} ${p.group ?? 'headphones earbuds audio'} ${p.seller ? sellers[p.seller].name : ''}`.toLowerCase();
      return words.some((w) => hay.includes(w));
    });
  }, [q, designQuery]);

  const untouched = designQuery && isRelaxation(f);
  const results = useMemo(() => sortListings(untouched ? base : base.filter((l) => matches(l, f)), sort), [base, f, sort, untouched]);
  const chips = activeFilters(f);
  const removedInitial = activeFilters(DESIGN_FILTERS).filter((c) => !chips.some((x) => x.label === c.label)).length;
  const total = untouched ? DESIGN_TOTAL + removedInitial * 14 : results.length;
  const pages = untouched ? DESIGN_PAGES : Math.max(1, Math.ceil(total / 12));
  const showStore = designQuery || /audio|northwind|head|ear|bud|speaker/.test(norm(q));

  if (!base.length) return <Navigate to={href('store/search-empty', '', undefined, { q })} replace />;

  const filterPanel = (p: string) => <FilterGroups p={p} f={f} set={set} toggle={toggle} category={<SearchCats p={p} f={f} toggle={toggle} />} />;

  return (
    <StoreLayout tab="home" q={suggOpen ? typed : q}>
      {suggOpen && <Suggestions typed={typed} onClose={() => setView('', { replace: true })} />}
      <div className="container page gap-5">
        <div className="stack gap-2">
          <h1 className="h2">Results for “{q}”</h1>
          {designQuery && (
            <p className="small sub">
              Showing results for <b>{DESIGN_QUERY}</b>.{' '}
              <Link to={href('store/search-empty', '', undefined, { q: DESIGN_TYPED })} className="link-inline">
                Search instead for “{DESIGN_TYPED}”
              </Link>
            </p>
          )}
        </div>
        {chips.length > 0 && (
          <div className="shop-active" aria-label="Active filters">
            <span className="small strong">Filters:</span>
            {chips.map((c) => (
              <a
                key={c.label}
                className="chip is-soft"
                href="#"
                aria-label={`Remove filter ${c.label}`}
                onClick={(e) => {
                  e.preventDefault();
                  setF(c.clear);
                  setPage(1);
                }}
              >
                {c.label}
                <Icon name="x" className="ic-sm" />
              </a>
            ))}
            <a
              className="small strong"
              href="#"
              onClick={(e) => {
                e.preventDefault();
                clearAll();
              }}
            >
              Clear all
            </a>
          </div>
        )}
        {showStore && (
          <section className="card pad row between gap-4" aria-labelledby="sr-store">
            <div className="row gap-3 nowrap min-w-0">
              <LogoTile initials={sellers.northwind.initials} tint={sellers.northwind.tint} />
              <div className="stack gap-1">
                <span className="eyebrow">Store match</span>
                <span className="row gap-2">
                  <h2 className="h4" id="sr-store">
                    Store: {sellers.northwind.name}
                  </h2>
                  <Badge tone="info" icon="shield-check">
                    Verified
                  </Badge>
                </span>
                <span className="xs muted">98% positive (4,812 ratings) · 86 products · Portland, OR</span>
              </div>
            </div>
            <div className="stack gap-1 items-start">
              <Button variant="secondary" size="sm" to={href('store/seller')} iconRight="arrow-right">
                Visit store
              </Button>
              <span className="xs muted">Stores are listed here, not mixed into product results.</span>
            </div>
          </section>
        )}
        {designQuery && (
          <section className="stack gap-3" aria-labelledby="sr-sp">
            <div className="row between base">
              <h2 className="h4" id="sr-sp">
                Sponsored products
              </h2>
              <Link className="xs" to={href('help/article')}>
                Why these ads?
              </Link>
            </div>
            <div className="grid-products">
              {SPONSORED.map((p) => (
                <ResultCard key={p.id} p={p} sponsored />
              ))}
            </div>
          </section>
        )}
        <div className="shop-listing">
          <aside className="only-desktop" aria-labelledby="sf-h">
            <h2 className="h4" id="sf-h">
              Filters
            </h2>
            {filterPanel('sf')}
          </aside>
          <div className="stack gap-4">
            <div className="shop-toolbar">
              <div className="row gap-2">
                <Button variant="secondary" size="sm" icon="sliders-horizontal" className="no-desktop" onClick={() => setSheet(true)} aria-haspopup="dialog">
                  {chips.length ? `Filters (${chips.length})` : 'Filters'}
                </Button>
                <span className="small sub">
                  {total} result{total === 1 ? '' : 's'}
                </span>
              </div>
              <span className="shop-sort">
                <label className="small sub nowrap" htmlFor="sr-sort">
                  Sort by
                </label>
                <Select id="sr-sort" options={[...SORTS]} value={sort} onChange={(e) => setSort(e.target.value as Sort)} />
              </span>
            </div>
            <p className="shop-from">
              <Icon name="info" />
              <span>A “from” price is the lowest eligible offer for that product, from one named seller. The product page shows that seller, the shipping cost and delivery date before you add it to your cart.</span>
            </p>
            {results.length ? (
              <div className="grid-products">
                {results.map((p) => (
                  <ResultCard key={p.id} p={p} />
                ))}
              </div>
            ) : (
              <EmptyState
                icon="search-x"
                title="Nothing matches all your filters"
                action={
                  <Button variant="secondary" onClick={clearAll}>
                    Clear all filters
                  </Button>
                }
              >
                Try removing a filter. Your search still has results without them.
              </EmptyState>
            )}
            <div className="row between">
              <span className="xs muted">Results match product names, brands and descriptions. Sponsored items are labeled.</span>
              <Pager page={page} total={pages} onPage={setPage} grid end={page === pages} />
            </div>
          </div>
        </div>
      </div>

      <Dialog
        open={sheet}
        onClose={() => setSheet(false)}
        title="Filters and sort"
        foot={
          <>
            <Button variant="ghost" onClick={clearAll}>
              Clear all
            </Button>
            <Button className="grow" onClick={() => setSheet(false)}>
              Show {total} results
            </Button>
          </>
        }
      >
        <div className="stack gap-2">
          <h3 className="h4">Sort by</h3>
          {SORTS.map((s, i) => (
            <Radio key={s} id={`ss-sort${i}`} name="ss-sort" checked={sort === s} onChange={() => setSort(s)} label={s} />
          ))}
        </div>
        {filterPanel('ss')}
      </Dialog>
    </StoreLayout>
  );
}

export default function Search() {
  const [params] = useSearchParams();
  const q = params.get('q')?.trim() || DESIGN_QUERY;
  // A new query starts a fresh result page (filters, sort, page).
  return <SearchPage key={norm(q)} q={q} />;
}

