import { parseCents } from '@marketly/web-shared/lib/format';
import { Fragment, useEffect, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { Checkbox, Icon, Radio, Select, Stars5 } from '@marketly/web-shared/ui';
import { FILTER_PARAMS, fromServerQuery, withoutPage, type Facet, type SearchContext, type SortKey } from './search';

// Listing filters for Category, Search, Brand, Seller and Official: the facet groups of
// GET /api/store/search/facets rendered with the design's .shop-fg markup (desktop rail and phone
// sheet), the applied-filter chips and the sort control. The page URL holds the REST parameters.

/** URL state of a listing: filters, sort and page as REST search parameters. */
export function useListingParams(routeParams: string[] = []) {
  const [params, setParams] = useSearchParams();
  /** Changes filters or sort (back to page 1). */
  const update = (fn: (p: URLSearchParams) => void, opts?: { replace?: boolean }) =>
    setParams(
      (prev) => {
        const p = withoutPage(prev);
        fn(p);
        return p;
      },
      { preventScrollReset: true, replace: opts?.replace },
    );
  const setPage = (n: number) =>
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        if (n > 1) p.set('page', String(n));
        else p.delete('page');
        return p;
      },
      { preventScrollReset: true },
    );
  /** Applies a server query string (removeQuery / clearAllQuery). */
  const applyServer = (qs: string) => setParams(fromServerQuery(qs, params, routeParams), { preventScrollReset: true });
  const clearFilters = () => update((p) => FILTER_PARAMS.forEach((k) => p.delete(k)));
  const filterCount = FILTER_PARAMS.filter((k) => !routeParams.includes(k) && params.getAll(k).length > 0).length;
  return { params, update, setPage, applyServer, clearFilters, filterCount };
}
export type ListingParams = ReturnType<typeof useListingParams>;

export function Count({ n }: { n: number }) {
  return <span className="muted">({n})</span>;
}

function Summary({ children }: { children: ReactNode }) {
  return (
    <summary>
      {children}
      <Icon name="chevron-down" className="ic-sm" />
    </summary>
  );
}

/* ---------------- attrs: 'key:v1|v2;key2:v3' ---------------- */

const readAttrs = (s: string | null): Record<string, string[]> =>
  Object.fromEntries(
    (s ?? '')
      .split(';')
      .map((part) => part.split(':'))
      .filter(([k, v]) => k && v)
      .map(([k, v]) => [k!, v!.split('|').filter(Boolean)]),
  );
const writeAttrs = (a: Record<string, string[]>) =>
  Object.entries(a)
    .filter(([, v]) => v.length)
    .map(([k, v]) => `${k}:${v.join('|')}`)
    .join(';');

/** Facet key → REST parameter. */
const PARAM: Record<string, string> = { category: 'category', brand: 'brand', seller: 'seller', condition: 'condition', delivery: 'delivery', rating: 'rating', availability: 'availability' };

const toCents = (s: string) => parseCents(s);
const toDollars = (c: string | null) => (c ? String(Number(c) / 100) : '');

/** Price filter: min/max fields and the server's price presets with result counts (setting search.pricePresets). */
function PriceGroup({ p, f, lp }: { p: string; f: Facet; lp: ListingParams }) {
  const minP = lp.params.get('priceMin');
  const maxP = lp.params.get('priceMax');
  const [min, setMin] = useState(toDollars(minP));
  const [max, setMax] = useState(toDollars(maxP));
  useEffect(() => {
    setMin(toDollars(minP));
    setMax(toDollars(maxP));
  }, [minP, maxP]);
  const apply = () =>
    lp.update((q) => {
      const a = toCents(min);
      const b = toCents(max);
      if (a) q.set('priceMin', String(a));
      else q.delete('priceMin');
      if (b) q.set('priceMax', String(b));
      else q.delete('priceMax');
    });
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => e.key === 'Enter' && (e.preventDefault(), apply());
  const preset = (v: Facet['values'][number]) =>
    lp.update((q) => {
      if (v.priceMin) q.set('priceMin', String(v.priceMin));
      else q.delete('priceMin');
      if (v.priceMax) q.set('priceMax', String(v.priceMax));
      else q.delete('priceMax');
    });
  return (
    <div className="opts">
      <div className="row nowrap gap-2">
        <div className="field">
          <label className="label" htmlFor={`${p}-min`}>
            Min
          </label>
          <span className="input-group">
            <span className="affix">$</span>
            <input className="input" id={`${p}-min`} type="text" inputMode="decimal" value={min} onChange={(e) => setMin(e.target.value)} onBlur={apply} onKeyDown={onKey} placeholder="0" />
          </span>
        </div>
        <div className="field">
          <label className="label" htmlFor={`${p}-max`}>
            Max
          </label>
          <span className="input-group">
            <span className="affix">$</span>
            <input className="input" id={`${p}-max`} type="text" inputMode="decimal" value={max} onChange={(e) => setMax(e.target.value)} onBlur={apply} onKeyDown={onKey} placeholder="Any" />
          </span>
        </div>
      </div>
      {f.values.map((v, i) => (
        <Radio
          key={v.value}
          id={`${p}-pr${i}`}
          name={`${p}-pr`}
          checked={(minP ?? null) === (v.priceMin ? String(v.priceMin) : null) && (maxP ?? null) === (v.priceMax ? String(v.priceMax) : null)}
          onChange={() => preset(v)}
          label={
            <>
              {v.label} <Count n={v.count} />
            </>
          }
        />
      ))}
    </div>
  );
}

function MultiGroup({ p, f, lp, param }: { p: string; f: Facet; lp: ListingParams; param: string }) {
  const [all, setAll] = useState(false);
  const selected = lp.params.getAll(param);
  const limit = f.kind === 'brand' ? 5 : Infinity;
  const values = all ? f.values : f.values.slice(0, limit);
  const more = f.values.length - limit;
  const toggle = (v: string) =>
    lp.update((q) => {
      const cur = q.getAll(param);
      q.delete(param);
      (cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v]).forEach((x) => q.append(param, x));
    });
  const moreClick = (e: MouseEvent) => {
    e.preventDefault();
    setAll((v) => !v);
  };
  return (
    <div className="opts">
      {values.map((v, i) => (
        <Fragment key={v.value}>
          <Checkbox id={`${p}-${f.key}${i}`} checked={selected.includes(v.value)} onChange={() => toggle(v.value)} label={<>{v.label} <Count n={v.count} /></>} />
          {v.note && <span className="xs muted check-hint">{v.note}</span>}
        </Fragment>
      ))}
      {more > 0 && (
        <a className="small strong" href="#" onClick={moreClick} aria-expanded={all}>
          {all ? `Show fewer ${f.label.toLowerCase()}s` : `Show ${more} more ${f.label.toLowerCase()}s`}
        </a>
      )}
    </div>
  );
}

/** Single-choice facets shown as checkboxes in the design (category on search, availability). */
function SingleCheckGroup({ p, f, lp, param }: { p: string; f: Facet; lp: ListingParams; param: string }) {
  const cur = lp.params.get(param);
  const isOn = (v: string) => (f.kind === 'availability' ? (cur ?? 'in_stock') === v : cur === v);
  const toggle = (v: string) =>
    lp.update((q) => {
      if (f.kind === 'availability') {
        // "In stock now" is the default; unticking it (or ticking the other) includes out-of-stock items.
        const next = isOn(v) ? (v === 'in_stock' ? 'include_out_of_stock' : 'in_stock') : v;
        if (next === 'in_stock') q.delete(param);
        else q.set(param, next);
        return;
      }
      if (isOn(v)) q.delete(param);
      else q.set(param, v);
    });
  return (
    <div className="opts">
      {f.values.map((v, i) => (
        <Checkbox key={v.value} id={`${p}-${f.key}${i}`} checked={isOn(v.value)} onChange={() => toggle(v.value)} label={<>{v.label} <Count n={v.count} /></>} />
      ))}
    </div>
  );
}

function RatingGroup({ p, f, lp }: { p: string; f: Facet; lp: ListingParams }) {
  const cur = lp.params.get('rating');
  return (
    <div className="opts">
      {f.values.map((v) => (
        <Radio
          key={v.value}
          id={`${p}-rt${v.value}`}
          name={`${p}-rt`}
          checked={cur === v.value}
          onChange={() => lp.update((q) => q.set('rating', v.value))}
          label={
            <>
              <span className="row gap-1 nowrap">
                <Stars5 rating={Number(v.value)} size="sm" />
                <span>&amp; up</span>
              </span>{' '}
              <Count n={v.count} />
            </>
          }
        />
      ))}
    </div>
  );
}

function AttributeGroup({ p, f, lp }: { p: string; f: Facet; lp: ListingParams }) {
  const attrs = readAttrs(lp.params.get('attrs'));
  const selected = attrs[f.key] ?? [];
  const toggle = (v: string) =>
    lp.update((q) => {
      const a = readAttrs(q.get('attrs'));
      const cur = a[f.key] ?? [];
      a[f.key] = f.multiSelect ? (cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v]) : cur.includes(v) ? [] : [v];
      const s = writeAttrs(a);
      if (s) q.set('attrs', s);
      else q.delete('attrs');
    });
  return (
    <div className="opts">
      {f.values.map((v, i) =>
        f.multiSelect ? (
          <Checkbox key={v.value} id={`${p}-${f.key}${i}`} checked={selected.includes(v.value)} onChange={() => toggle(v.value)} label={<>{v.label} <Count n={v.count} /></>} />
        ) : (
          <Radio key={v.value} id={`${p}-${f.key}${i}`} name={`${p}-${f.key}`} checked={selected.includes(v.value)} onChange={() => toggle(v.value)} label={<>{v.label} <Count n={v.count} /></>} />
        ),
      )}
    </div>
  );
}

/**
 * The filter groups from the API facets, rendered in the desktop rail and in the phone sheet
 * (`p` prefixes the ids). `category` replaces the Category group's content (the category page tree);
 * `hide` leaves out facets the page fixes (e.g. seller on a storefront).
 */
export function FacetFilters({ p, facets, lp, category, hide = [] }: { p: string; facets: Facet[]; lp: ListingParams; category?: ReactNode; hide?: string[] }) {
  const shown = facets.filter((f) => !hide.includes(f.key) && (f.kind === 'price' || f.kind === 'category' || f.values.length > 0));
  let headed = '';
  return (
    <div className="stack gap-0">
      {shown.map((f) => {
        const param = PARAM[f.key] ?? f.key;
        let body: ReactNode;
        if (f.kind === 'category') {
          if (!category && !f.values.length) return null;
          body = category ? <div className="opts">{category}</div> : <SingleCheckGroup p={p} f={f} lp={lp} param="category" />;
        } else if (f.kind === 'price') body = <PriceGroup p={p} f={f} lp={lp} />;
        else if (f.kind === 'rating') body = <RatingGroup p={p} f={f} lp={lp} />;
        else if (f.kind === 'attribute') body = <AttributeGroup p={p} f={f} lp={lp} />;
        else if (f.kind === 'availability' || !f.multiSelect) body = <SingleCheckGroup p={p} f={f} lp={lp} param={param} />;
        else body = <MultiGroup p={p} f={f} lp={lp} param={param} />;
        const head = f.group === 'category' && f.groupLabel && f.groupLabel !== headed ? f.groupLabel : null;
        if (head) headed = head;
        return (
          <Fragment key={f.key}>
            {head && <span className="shop-fhead">{head}</span>}
            <details className="shop-fg" open={!f.collapsed}>
              <Summary>{f.label}</Summary>
              {body}
            </details>
          </Fragment>
        );
      })}
    </div>
  );
}

/** Applied filters as removable chips (server labels and remove queries). */
export function ActiveFilters({ ctx, lp, hide = [] }: { ctx: SearchContext | undefined; lp: ListingParams; hide?: string[] }) {
  const chips = (ctx?.appliedFilters ?? []).filter((c) => !hide.includes(c.key));
  if (!chips.length) return null;
  return (
    <div className="shop-active" aria-label="Active filters">
      <span className="small strong">Filters:</span>
      {chips.map((c) => (
        <a
          key={`${c.key}:${c.value}`}
          className="chip is-soft"
          href="#"
          aria-label={`Remove filter ${c.label}`}
          onClick={(e) => {
            e.preventDefault();
            lp.applyServer(c.removeQuery);
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
          lp.clearFilters();
        }}
      >
        Clear all
      </a>
    </div>
  );
}

const DEFAULT_SORTS: Array<{ key: SortKey; label: string; available: boolean }> = [
  { key: 'recommended', label: 'Recommended', available: true },
  { key: 'price_asc', label: 'Price: low to high', available: true },
  { key: 'price_desc', label: 'Price: high to low', available: true },
  { key: 'newest', label: 'Newest arrivals', available: true },
  { key: 'rating', label: 'Highest rated', available: true },
];

/** Sort options of the listing (unavailable sorts, e.g. Best selling before sales history, are left out). */
export const sortOptions = (ctx: SearchContext | undefined) => (ctx?.sorts.length ? ctx.sorts : DEFAULT_SORTS).filter((s) => s.available).map((s) => ({ value: s.key, label: s.label }));

export function SortSelect({ id, ctx, lp }: { id: string; ctx: SearchContext | undefined; lp: ListingParams }) {
  return (
    <Select
      id={id}
      options={sortOptions(ctx)}
      value={lp.params.get('sort') ?? 'recommended'}
      onChange={(e) =>
        lp.update((q) => {
          if (e.target.value === 'recommended') q.delete('sort');
          else q.set('sort', e.target.value);
        })
      }
    />
  );
}

/** Sort radios for the phone filters sheet. */
export function SortRadios({ p, ctx, lp }: { p: string; ctx: SearchContext | undefined; lp: ListingParams }) {
  const cur = lp.params.get('sort') ?? 'recommended';
  return (
    <div className="stack gap-2">
      <h3 className="h4">Sort by</h3>
      {sortOptions(ctx).map((s, i) => (
        <Radio
          key={s.value}
          id={`${p}-sort${i}`}
          name={`${p}-sort`}
          checked={cur === s.value}
          onChange={() =>
            lp.update((q) => {
              if (s.value === 'recommended') q.delete('sort');
              else q.set('sort', s.value);
            })
          }
          label={s.label}
        />
      ))}
    </div>
  );
}
