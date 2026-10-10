import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { StoreLayout } from '@/layouts';
import { useView } from '@/lib/hooks';
import { href } from '@/routes/href';
import { Breadcrumbs, Button, Dialog, EmptyState, Icon, IconButton, Img, Pager, ProductCard, Radio, Select } from '@/ui';
import { CHIPS, HEADPHONES, PAGE_SIZE, SORTS, TOTAL_RESULTS, TYPES, type Sort } from './data/category';
import { Count, DEFAULT_FILTERS, FilterGroups, matches, sameFilters, sortListings, toggleIn, type Filters, type ListKey, type SetFilter } from './data/listing-filters';

// Design: pages/store/store-category.html · view "filters-phone-sheet" = the phone filters & sort sheet.

/** Category group of the filters: back to the parent, this category and its sub-categories. */
function CategoryTree() {
  return (
    <>
      <Link className="small" to={href('store/categories')}>
        <Icon name="chevron-left" className="ic-sm" /> Electronics
      </Link>
      <span className="small strong">
        Headphones <Count n={TOTAL_RESULTS} />
      </span>
      <div className="stack gap-1 u-pl-sp-3">
        {TYPES.map((t) => (
          <Link key={t.id} className="small" to={href('store/category', '', { slug: CHIPS.find((c) => c.label === t.label)?.slug ?? 'headphones' })}>
            {t.label} <Count n={t.n} />
          </Link>
        ))}
      </div>
    </>
  );
}

export default function Category() {
  const [view, setView] = useView<'filters-phone-sheet'>();
  const { slug = 'headphones' } = useParams();
  const chip = CHIPS.find((c) => c.slug === slug) ?? CHIPS[0];
  const sheetOpen = view === 'filters-phone-sheet';

  const [f, setF] = useState<Filters>(DEFAULT_FILTERS);
  const [sort, setSort] = useState<Sort>('Recommended');
  const [page, setPage] = useState(1);

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
    setSort('Recommended');
    setPage(1);
  };

  const filtered = !sameFilters(f, DEFAULT_FILTERS) || !!chip.match;
  const results = useMemo(() => sortListings(HEADPHONES.filter((l) => matches(l, f) && (!chip.match || chip.match(l))), sort), [f, sort, chip]);
  // The sample holds the first page of 128 results; once filtered, the sample is the whole result set.
  const total = filtered ? results.length : TOTAL_RESULTS;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const from = total ? (page - 1) * PAGE_SIZE + 1 : 0;
  const to = Math.min(page * PAGE_SIZE, total);

  return (
    <StoreLayout
      tab="categories"
      appbar={{ title: 'Headphones', back: href('store/categories'), actions: <IconButton icon="search" label="Search" to={href('store/search')} /> }}
    >
      <div className="container page gap-5">
        <div className="stack gap-2">
          <Breadcrumbs items={[{ label: 'Home', to: href('store/home') }, { label: 'Electronics', to: href('store/categories') }, { label: 'Headphones' }]} />
          <h1 className="h1 acct-h1">Headphones</h1>
          <p className="small muted">{TOTAL_RESULTS} results from 9 sellers, including the Official Store</p>
        </div>
        <div className="hscroll gap-2">
          {CHIPS.map((c) => (
            <Link key={c.slug} className={c.slug === chip.slug ? 'chip is-active' : 'chip'} to={href('store/category', '', { slug: c.slug })} aria-current={c.slug === chip.slug ? 'true' : undefined}>
              {c.label}
            </Link>
          ))}
        </div>
        <Link className="shop-banner" to={href('store/product')} aria-label="Advertisement: Halden Aurora headphones at the Official Store">
          <span className="ad-label">Ad</span>
          <div className="copy">
            <span className="eyebrow">Halden · at the Official Store</span>
            <span className="h2">40 hours of quiet. Aurora ANC headphones, now $189.00.</span>
            <span className="small sub">Sale ends Oct 19, 11:59 PM PT. Sold and shipped by Marketly Official.</span>
            <span className="row gap-3">
              <span className="btn btn-primary btn-sm">Shop Aurora</span>
              <span className="xs muted">Advertiser: Halden Audio</span>
            </span>
          </div>
          <div className="art" aria-hidden="true">
            <Img icon="headphones" tint="2" />
            <Img icon="ear" tint="2" />
          </div>
        </Link>
        <div className="shop-listing">
          <aside className="only-desktop" aria-labelledby="cf-h">
            <h2 className="h4" id="cf-h">
              Filters
            </h2>
            <FilterGroups p="cf" f={f} set={set} toggle={toggle} category={<CategoryTree />} />
          </aside>
          <div className="stack gap-4">
            <div className="shop-toolbar">
              <div className="row gap-2">
                <Button variant="secondary" size="sm" icon="sliders-horizontal" className="no-desktop" onClick={() => setView('filters-phone-sheet')} aria-haspopup="dialog">
                  Filters
                </Button>
                <span className={sheetOpen ? 'small sub' : 'small sub no-phone'}>
                  Showing {from}–{to} of {total}
                </span>
              </div>
              <span className="shop-sort">
                <label className="small sub nowrap" htmlFor="cat-sort">
                  Sort by
                </label>
                <Select id="cat-sort" options={[...SORTS]} value={sort} onChange={(e) => setSort(e.target.value as Sort)} />
              </span>
            </div>
            <p className="shop-from">
              <Icon name="info" />
              <span>A “from” price is the lowest eligible offer for that product, from one named seller. The product page shows that seller, the shipping cost and delivery date before you add it to your cart.</span>
            </p>
            {results.length ? (
              <div className="grid-products">
                {results.map((l) => (
                  <ProductCard key={l.id} p={l} sponsored={l.sponsored} showSeller from />
                ))}
              </div>
            ) : (
              <EmptyState icon="search-x" title="No headphones match these filters" action={<Button variant="secondary" onClick={clearAll}>Clear all filters</Button>}>
                Try removing a filter or widening the price range.
              </EmptyState>
            )}
            <div className="row between">
              <span className="xs muted">
                Sponsored items are paid placements and are labeled.{' '}
                <Link to={href('help/article')} className="link-inline">
                  How results are ranked
                </Link>
              </span>
              <Pager page={page} total={pages} onPage={setPage} grid end={pages === 1 || page === pages} />
            </div>
          </div>
        </div>
      </div>

      <Dialog
        open={sheetOpen}
        onClose={() => setView('')}
        title="Filters and sort"
        foot={
          <>
            <Button variant="ghost" onClick={clearAll}>
              Clear all
            </Button>
            <Button className="grow" onClick={() => setView('')}>
              Show {total} results
            </Button>
          </>
        }
      >
        <div className="stack gap-2">
          <h3 className="h4">Sort by</h3>
          {SORTS.map((s, i) => (
            <Radio key={s} id={`cs-sort${i}`} name="cs-sort" checked={sort === s} onChange={() => setSort(s)} label={s} />
          ))}
        </div>
        <FilterGroups p="cs" f={f} set={set} toggle={toggle} category={<CategoryTree />} />
      </Dialog>
    </StoreLayout>
  );
}
