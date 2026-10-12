// Listing filters shared by the Category and Search pages: filter state, matching, sorting and
// the filter groups (desktop rail and phone sheet). Same markup as the design's .shop-fg groups.
import { Fragment, useState, type MouseEvent, type ReactNode } from 'react';
import { Checkbox, Icon, Radio, Stars5 } from '@marketly/web-shared/ui';
import {
  ANCS, BATTERY, BRANDS, BRANDS_SHOWN, CONDITIONS, CONNECTIONS, PRICE_RANGES, RATINGS, SELLERS, TYPES,
  type Anc, type Condition, type Connection, type HeadphoneType, type Listing, type Sort,
} from './category';

export interface Filters {
  min: string;
  max: string;
  range: string;
  rating: string;
  /** Search only: result groups (Headphones, Earbuds, Speakers). */
  cats: string[];
  brands: string[];
  sellers: string[];
  conditions: Condition[];
  inStock: boolean;
  includeOos: boolean;
  free: boolean;
  byFri: boolean;
  today: boolean;
  types: HeadphoneType[];
  ancs: Anc[];
  battery: string;
  connections: Connection[];
}

export const DEFAULT_FILTERS: Filters = {
  min: '', max: '', range: '', rating: '', cats: [], brands: [], sellers: [], conditions: [], inStock: true, includeOos: false,
  free: false, byFri: false, today: false, types: [], ancs: [], battery: '', connections: [],
};

export type ListKey = 'cats' | 'brands' | 'sellers' | 'conditions' | 'types' | 'ancs' | 'connections';
export type SetFilter = <K extends keyof Filters>(k: K, v: Filters[K]) => void;

export const toggleIn = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
export const sameFilters = (a: Filters, b: Filters) => JSON.stringify(a) === JSON.stringify(b);
const parseMoney = (s: string) => {
  const n = parseFloat(s.replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};

/** Result group used by the search Category facet. */
export const groupOf = (l: Listing) => l.group ?? (l.type === 'in' ? 'Earbuds' : 'Headphones');

export function matches(l: Listing, f: Filters): boolean {
  const min = parseMoney(f.min);
  const max = parseMoney(f.max);
  if (min !== null && l.price < min) return false;
  if (max !== null && l.price > max) return false;
  const range = PRICE_RANGES.find((r) => r.id === f.range);
  if (range && (l.price < range.min || l.price >= range.max)) return false;
  if (f.rating && l.rating < Number(f.rating)) return false;
  if (f.cats.length && !f.cats.includes(groupOf(l))) return false;
  if (f.brands.length && !f.brands.includes(l.brand)) return false;
  if (f.sellers.length && !f.sellers.includes(l.seller ?? '')) return false;
  if (f.conditions.length && !f.conditions.includes(l.condition)) return false;
  if (f.inStock && !f.includeOos && !l.inStock) return false;
  if (f.free && !l.free) return false;
  if (f.byFri && !l.byFri) return false;
  if (f.today && !l.shipsToday) return false;
  if (f.types.length && !f.types.includes(l.type)) return false;
  if (f.ancs.length && !f.ancs.includes(l.anc)) return false;
  const battery = BATTERY.find((b) => b.id === f.battery);
  if (battery && l.battery < battery.hours) return false;
  if (f.connections.length && !f.connections.some((c) => l.connection.includes(c))) return false;
  return true;
}

export function sortListings(list: Listing[], sort: Sort): Listing[] {
  const out = [...list];
  if (sort === 'Price: low to high') out.sort((a, b) => a.price - b.price);
  else if (sort === 'Price: high to low') out.sort((a, b) => b.price - a.price);
  else if (sort === 'Newest') out.sort((a, b) => a.age - b.age);
  else if (sort === 'Highest rated') out.sort((a, b) => b.rating - a.rating);
  return out;
}

function Summary({ children }: { children: string }) {
  return (
    <summary>
      {children}
      <Icon name="chevron-down" className="ic-sm" />
    </summary>
  );
}

export function Count({ n }: { n: number }) {
  return <span className="muted">({n})</span>;
}

/**
 * The filter groups, rendered in the desktop rail and in the phone sheet (`p` prefixes the ids:
 * cf/cs on the category page, sf on search). `category` is the content of the first group.
 */
export function FilterGroups({ p, f, set, toggle, category }: { p: string; f: Filters; set: SetFilter; toggle: (k: ListKey, v: string) => void; category: ReactNode }) {
  const [allBrands, setAllBrands] = useState(false);
  const brands = allBrands ? BRANDS : BRANDS.slice(0, BRANDS_SHOWN);
  const moreBrands = (e: MouseEvent) => {
    e.preventDefault();
    setAllBrands((v) => !v);
  };
  return (
    <div className="stack gap-0">
      <details className="shop-fg" open>
        <Summary>Category</Summary>
        <div className="opts">{category}</div>
      </details>
      <details className="shop-fg" open>
        <Summary>Price</Summary>
        <div className="opts">
          <div className="row nowrap gap-2">
            <div className="field">
              <label className="label" htmlFor={`${p}-min`}>
                Min
              </label>
              <span className="input-group">
                <span className="affix">$</span>
                <input className="input" id={`${p}-min`} type="text" inputMode="decimal" value={f.min} onChange={(e) => set('min', e.target.value)} placeholder="0" />
              </span>
            </div>
            <div className="field">
              <label className="label" htmlFor={`${p}-max`}>
                Max
              </label>
              <span className="input-group">
                <span className="affix">$</span>
                <input className="input" id={`${p}-max`} type="text" inputMode="decimal" value={f.max} onChange={(e) => set('max', e.target.value)} placeholder="Any" />
              </span>
            </div>
          </div>
          {PRICE_RANGES.map((r, i) => (
            <Radio key={r.id} id={`${p}-pr${i}`} name={`${p}-pr`} checked={f.range === r.id} onChange={() => set('range', r.id)} label={<>{r.label} <Count n={r.n} /></>} />
          ))}
        </div>
      </details>
      <details className="shop-fg" open>
        <Summary>Customer rating</Summary>
        <div className="opts">
          {RATINGS.map((r) => (
            <Radio
              key={r.id}
              id={`${p}-rt${r.id}`}
              name={`${p}-rt`}
              checked={f.rating === r.id}
              onChange={() => set('rating', r.id)}
              label={
                <>
                  <span className="row gap-1 nowrap">
                    <Stars5 rating={r.stars} size="sm" />
                    <span>&amp; up</span>
                  </span>{' '}
                  <Count n={r.n} />
                </>
              }
            />
          ))}
        </div>
      </details>
      <details className="shop-fg" open>
        <Summary>Brand</Summary>
        <div className="opts">
          {brands.map((b, i) => (
            <Checkbox key={b.name} id={`${p}-b${i}`} checked={f.brands.includes(b.name)} onChange={() => toggle('brands', b.name)} label={<>{b.name} <Count n={b.n} /></>} />
          ))}
          <a className="small strong" href="#" onClick={moreBrands} aria-expanded={allBrands}>
            {allBrands ? 'Show fewer brands' : `Show ${BRANDS.length - BRANDS_SHOWN} more brands`}
          </a>
        </div>
      </details>
      <details className="shop-fg" open>
        <Summary>Seller</Summary>
        <div className="opts">
          {SELLERS.map((s, i) => (
            <Fragment key={s.id}>
              <Checkbox id={`${p}-s${i}`} checked={f.sellers.includes(s.id)} onChange={() => toggle('sellers', s.id)} label={<>{s.label} <Count n={s.n} /></>} />
              {'hint' in s && <span className="xs muted check-hint">{s.hint}</span>}
            </Fragment>
          ))}
        </div>
      </details>
      <details className="shop-fg" open>
        <Summary>Condition</Summary>
        <div className="opts">
          {CONDITIONS.map((c, i) => (
            <Checkbox key={c.id} id={`${p}-cd${i}`} checked={f.conditions.includes(c.id)} onChange={() => toggle('conditions', c.id)} label={<>{c.label} <Count n={c.n} /></>} />
          ))}
        </div>
      </details>
      <details className="shop-fg" open>
        <Summary>Availability</Summary>
        <div className="opts">
          <Checkbox id={`${p}-av0`} checked={f.inStock} onChange={(e) => set('inStock', e.target.checked)} label={<>In stock now <Count n={121} /></>} />
          <Checkbox id={`${p}-av1`} checked={f.includeOos} onChange={(e) => set('includeOos', e.target.checked)} label={<>Include out of stock <Count n={7} /></>} />
        </div>
      </details>
      <details className="shop-fg" open>
        <Summary>Delivery</Summary>
        <div className="opts">
          <Checkbox id={`${p}-d0`} checked={f.free} onChange={(e) => set('free', e.target.checked)} label={<>Free delivery <Count n={98} /></>} />
          <Checkbox id={`${p}-d1`} checked={f.byFri} onChange={(e) => set('byFri', e.target.checked)} label={<>Arrives by Fri, Oct 16 <Count n={74} /></>} />
          <Checkbox id={`${p}-d2`} checked={f.today} onChange={(e) => set('today', e.target.checked)} label={<>Ships today <Count n={41} /></>} />
        </div>
      </details>
      <span className="shop-fhead">Headphone features</span>
      <details className="shop-fg" open>
        <Summary>Type</Summary>
        <div className="opts">
          {TYPES.map((t, i) => (
            <Checkbox key={t.id} id={`${p}-t${i}`} checked={f.types.includes(t.id)} onChange={() => toggle('types', t.id)} label={<>{t.label} <Count n={t.n} /></>} />
          ))}
        </div>
      </details>
      <details className="shop-fg" open>
        <Summary>Noise cancelling</Summary>
        <div className="opts">
          {ANCS.map((a, i) => (
            <Checkbox key={a.id} id={`${p}-n${i}`} checked={f.ancs.includes(a.id)} onChange={() => toggle('ancs', a.id)} label={<>{a.label} <Count n={a.n} /></>} />
          ))}
        </div>
      </details>
      <details className="shop-fg">
        <Summary>Battery life</Summary>
        <div className="opts">
          {BATTERY.map((b, i) => (
            <Radio key={b.id} id={`${p}-bl${i}`} name={`${p}-bl`} checked={f.battery === b.id} onChange={() => set('battery', b.id)} label={<>{b.label} <Count n={b.n} /></>} />
          ))}
        </div>
      </details>
      <details className="shop-fg">
        <Summary>Connection</Summary>
        <div className="opts">
          {CONNECTIONS.map((c, i) => (
            <Checkbox key={c.id} id={`${p}-cn${i}`} checked={f.connections.includes(c.id)} onChange={() => toggle('connections', c.id)} label={<>{c.label} <Count n={c.n} /></>} />
          ))}
        </div>
      </details>
    </div>
  );
}
