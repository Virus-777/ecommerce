/**
 * The query string is the state of a results screen (spec notes): REST parameters ⇄ SearchQuery,
 * applied-filter chips with their removal query strings, and filter validation that needs no I/O.
 */
import { CONDITION_GROUPS, SORT_KEYS, type ConditionGroup, type SearchFilters, type SearchQuery, type SortKey } from './types.js';
import { OFFICIAL_STORE_NAME } from '../../../spec/common.js';
import { attrKey, formatMoney } from './text.js';

/** REST query parameters of GET /products and GET /facets (spec endpoints) */
export interface RestSearchParams {
  q?: string;
  exact?: boolean;
  category?: string;
  brand?: string[];
  priceMin?: number;
  priceMax?: number;
  rating?: number;
  seller?: string[];
  condition?: ConditionGroup[];
  availability?: 'in_stock' | 'include_out_of_stock';
  delivery?: ('free' | 'ships_today' | 'arrives_by')[];
  arrivesBy?: string;
  attrs?: string;
  listedWithinDays?: number;
  onSale?: boolean;
  sort?: SortKey;
  postalCode?: string;
}

export class FilterError extends Error {
  constructor(
    readonly filter: string,
    message: string,
  ) {
    super(message);
  }
}

/** 'noise_cancelling:active;battery_life:30|40' → [{ key, values }] */
export function parseAttrs(attrs: string | undefined): { key: string; values: string[] }[] {
  if (!attrs?.trim()) return [];
  const out: { key: string; values: string[] }[] = [];
  for (const part of attrs.split(';')) {
    if (!part.trim()) continue;
    const idx = part.indexOf(':');
    if (idx <= 0) throw new FilterError('attrs', `Attribute filter '${part}' must look like key:value`);
    const key = attrKey(part.slice(0, idx));
    const values = part
      .slice(idx + 1)
      .split('|')
      .map((v) => v.trim())
      .filter(Boolean);
    if (!key || !values.length) throw new FilterError('attrs', `Attribute filter '${part}' must look like key:value`);
    const existing = out.find((a) => a.key === key);
    if (existing) existing.values = [...new Set([...existing.values, ...values])];
    else out.push({ key, values: [...new Set(values)] });
  }
  return out;
}

export const formatAttrs = (attrs: { key: string; values: string[] }[]) => attrs.map((a) => `${a.key}:${a.values.join('|')}`).join(';');

/** REST parameters → SearchQuery (slugs are resolved to ids later) */
export function fromRest(p: RestSearchParams): SearchQuery & { exact?: boolean; postalCode?: string } {
  const f: SearchFilters = {};
  if (p.category) f.categorySlug = p.category;
  if (p.brand?.length) f.brandSlugs = [...new Set(p.brand)];
  if (p.seller?.length) {
    const sellers = [...new Set(p.seller)];
    if (sellers.includes('official')) f.official = true;
    const others = sellers.filter((s) => s !== 'official');
    if (others.length) f.sellerSlugs = others;
  }
  if (p.priceMin !== undefined) f.priceMin = p.priceMin;
  if (p.priceMax !== undefined) f.priceMax = p.priceMax;
  if (p.rating !== undefined) f.minRating = p.rating;
  if (p.condition?.length) f.conditions = [...new Set(p.condition)];
  if (p.availability) f.inStockOnly = p.availability === 'in_stock';
  for (const d of p.delivery ?? []) {
    if (d === 'free') f.freeDelivery = true;
    if (d === 'ships_today') f.shipsToday = true;
    if (d === 'arrives_by') {
      if (!p.arrivesBy) throw new FilterError('arrivesBy', 'Choose a date for arrives by');
      f.arrivesBy = p.arrivesBy;
    }
  }
  if (p.arrivesBy && !f.arrivesBy) f.arrivesBy = p.arrivesBy;
  const attrs = parseAttrs(p.attrs);
  if (attrs.length) f.attributes = attrs;
  if (p.listedWithinDays !== undefined) f.listedWithinDays = p.listedWithinDays;
  if (p.onSale !== undefined) f.onSale = p.onSale;
  return {
    q: p.q?.trim() ? p.q.trim() : null,
    filters: f,
    sort: p.sort,
    ...(p.exact !== undefined ? { exact: p.exact } : {}),
    ...(p.postalCode ? { postalCode: p.postalCode } : {}),
  };
}

/** Business validation of filter values that needs no lookups */
export function validateFilters(f: SearchFilters, sort: SortKey | undefined) {
  if (f.minRating !== undefined && (f.minRating < 1 || f.minRating > 5)) throw new FilterError('rating', 'Rating filter is 1 to 5 stars');
  if (f.priceMin !== undefined && f.priceMin < 0) throw new FilterError('priceMin', 'Minimum price cannot be negative');
  if (f.priceMax !== undefined && f.priceMax < 0) throw new FilterError('priceMax', 'Maximum price cannot be negative');
  if (f.priceMin !== undefined && f.priceMax !== undefined && f.priceMin > f.priceMax) throw new FilterError('priceMin', 'Minimum price is above the maximum');
  if (f.listedWithinDays !== undefined && f.listedWithinDays < 1) throw new FilterError('listedWithinDays', 'listedWithinDays is at least 1');
  if (f.arrivesBy !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(f.arrivesBy)) throw new FilterError('arrivesBy', 'arrivesBy is a date');
  for (const c of f.conditions ?? []) if (!CONDITION_GROUPS.includes(c)) throw new FilterError('condition', `Unknown condition '${c}'`);
  if (sort && !SORT_KEYS.includes(sort)) throw new FilterError('sort', `Unknown sort '${sort}'`);
}

/* ------------------------------------------------------------------ query strings and chips */

/** Names of the things a query refers to (from the category tree, brands and sellers) */
export interface Labels {
  category?: { id: string; slug: string; name: string } | null;
  brands: { key: string; name: string }[];
  sellers: { key: string; name: string }[];
  attributes: Map<string, string>;
}

/** Canonical REST state of a search: the parameters that make up the query string */
export interface QueryState {
  q?: string | null;
  exact?: boolean;
  category?: string | null;
  brand: string[];
  seller: string[];
  priceMin?: number;
  priceMax?: number;
  rating?: number;
  condition: string[];
  availability?: 'in_stock' | 'include_out_of_stock';
  delivery: string[];
  arrivesBy?: string;
  attrs: { key: string; values: string[] }[];
  listedWithinDays?: number;
  onSale?: boolean;
  sort?: SortKey;
}

export function toQueryString(s: QueryState): string {
  const p = new URLSearchParams();
  if (s.q) p.set('q', s.q);
  if (s.exact) p.set('exact', 'true');
  if (s.category) p.set('category', s.category);
  if (s.brand.length) p.set('brand', s.brand.join(','));
  if (s.seller.length) p.set('seller', s.seller.join(','));
  if (s.priceMin !== undefined) p.set('priceMin', String(s.priceMin));
  if (s.priceMax !== undefined) p.set('priceMax', String(s.priceMax));
  if (s.rating !== undefined) p.set('rating', String(s.rating));
  if (s.condition.length) p.set('condition', s.condition.join(','));
  if (s.availability) p.set('availability', s.availability);
  if (s.delivery.length) p.set('delivery', s.delivery.join(','));
  if (s.arrivesBy) p.set('arrivesBy', s.arrivesBy);
  if (s.attrs.length) p.set('attrs', formatAttrs(s.attrs));
  if (s.listedWithinDays !== undefined) p.set('listedWithinDays', String(s.listedWithinDays));
  if (s.onSale) p.set('onSale', 'true');
  if (s.sort && s.sort !== 'recommended') p.set('sort', s.sort);
  return p.toString();
}

export interface Chip {
  key: string;
  value: string;
  label: string;
  /** State without this chip */
  without: QueryState;
}

const DELIVERY_LABEL: Record<string, string> = { free: 'Free delivery', ships_today: 'Ships today', arrives_by: 'Arrives by' };
const CONDITION_LABEL: Record<string, string> = { new: 'New', used: 'Used', refurbished: 'Refurbished' };

const shortDate = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });

/**
 * Applied-filter chips, one per value, each with the state that removes it. `categoryIsFilter` is false on
 * a category page (the category is the page, not a filter).
 */
export function chips(s: QueryState, labels: Labels, opts: { categoryIsFilter: boolean; currency: string }): Chip[] {
  const out: Chip[] = [];
  const clone = (): QueryState => ({ ...s, brand: [...s.brand], seller: [...s.seller], condition: [...s.condition], delivery: [...s.delivery], attrs: s.attrs.map((a) => ({ key: a.key, values: [...a.values] })) });
  if (opts.categoryIsFilter && s.category) {
    const w = clone();
    w.category = null;
    out.push({ key: 'category', value: s.category, label: labels.category?.name ?? s.category, without: w });
  }
  for (const b of s.brand) {
    const w = clone();
    w.brand = w.brand.filter((x) => x !== b);
    out.push({ key: 'brand', value: b, label: labels.brands.find((x) => x.key === b)?.name ?? b, without: w });
  }
  for (const v of s.seller) {
    const w = clone();
    w.seller = w.seller.filter((x) => x !== v);
    out.push({ key: 'seller', value: v, label: v === 'official' ? OFFICIAL_STORE_NAME : (labels.sellers.find((x) => x.key === v)?.name ?? v), without: w });
  }
  if (s.priceMin !== undefined || s.priceMax !== undefined) {
    const w = clone();
    delete w.priceMin;
    delete w.priceMax;
    const min = s.priceMin !== undefined ? formatMoney(s.priceMin, opts.currency) : null;
    const max = s.priceMax !== undefined ? formatMoney(s.priceMax, opts.currency) : null;
    const label = min && max ? `Price: ${min} to ${max}` : min ? `Price: ${min} and up` : `Price: up to ${max}`;
    out.push({ key: 'price', value: `${s.priceMin ?? ''}-${s.priceMax ?? ''}`, label, without: w });
  }
  if (s.rating !== undefined) {
    const w = clone();
    delete w.rating;
    out.push({ key: 'rating', value: String(s.rating), label: s.rating >= 5 ? '5 stars' : `${s.rating} stars and up`, without: w });
  }
  for (const c of s.condition) {
    const w = clone();
    w.condition = w.condition.filter((x) => x !== c);
    out.push({ key: 'condition', value: c, label: CONDITION_LABEL[c] ?? c, without: w });
  }
  if (s.availability === 'include_out_of_stock') {
    const w = clone();
    delete w.availability;
    out.push({ key: 'availability', value: 'include_out_of_stock', label: 'Including out of stock', without: w });
  }
  for (const d of s.delivery) {
    const w = clone();
    w.delivery = w.delivery.filter((x) => x !== d);
    if (d === 'arrives_by') delete w.arrivesBy;
    out.push({ key: 'delivery', value: d, label: d === 'arrives_by' && s.arrivesBy ? `Arrives by ${shortDate(s.arrivesBy)}` : (DELIVERY_LABEL[d] ?? d), without: w });
  }
  for (const a of s.attrs) {
    for (const v of a.values) {
      const w = clone();
      w.attrs = w.attrs.map((x) => (x.key === a.key ? { key: x.key, values: x.values.filter((y) => y !== v) } : x)).filter((x) => x.values.length);
      out.push({ key: a.key, value: v, label: `${labels.attributes.get(a.key) ?? a.key}: ${v}`, without: w });
    }
  }
  if (s.listedWithinDays !== undefined) {
    const w = clone();
    delete w.listedWithinDays;
    out.push({ key: 'listedWithinDays', value: String(s.listedWithinDays), label: `Listed in the last ${s.listedWithinDays} days`, without: w });
  }
  if (s.onSale) {
    const w = clone();
    delete w.onSale;
    out.push({ key: 'onSale', value: 'true', label: 'Deals', without: w });
  }
  return out;
}

/** The state with every filter removed (q, the page's own category and the sort stay) */
export function clearAll(s: QueryState, opts: { categoryIsFilter: boolean }): QueryState {
  return { q: s.q, exact: s.exact, category: opts.categoryIsFilter ? null : s.category, brand: [], seller: [], condition: [], delivery: [], attrs: [], sort: s.sort };
}
