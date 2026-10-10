/** Read-model rows â†” OpenSearch documents (pure). */
import type { DocRow, DocTexts, IndexedDocument, OfferRow } from '../../ports.js';

const iso = (d: Date | string | null | undefined) => (d == null ? null : new Date(d).toISOString());
const num = (v: unknown) => (v == null ? null : Number(v));

/** 'HH:mm' or 'HH:mm:ss' â†’ 'HH:mm:ss' (compared as text against the market time) */
export const cutoffText = (t: string | null | undefined) => {
  if (!t) return null;
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(t);
  return m ? `${m[1]!.padStart(2, '0')}:${m[2]}:${m[3] ?? '00'}` : null;
};

/** The product's card order: featured first, then in stock, then cheapest, then offer id (the Postgres engine's order) */
export function cardOrder(doc: Pick<DocRow, 'featured_offer_id'>, offers: OfferRow[]): OfferRow[] {
  return [...offers].sort(
    (a, b) =>
      Number(b.offer_id === doc.featured_offer_id) - Number(a.offer_id === doc.featured_offer_id) ||
      Number(b.in_stock) - Number(a.in_stock) ||
      a.price - b.price ||
      (a.offer_id < b.offer_id ? -1 : a.offer_id > b.offer_id ? 1 : 0),
  );
}

/** Every field but the texts (a partial write keeps the indexed texts) */
export function fieldsOf(doc: DocRow, offers: OfferRow[]): Record<string, unknown> {
  const attributes = (doc.attributes ?? {}) as Record<string, unknown>;
  const attrs: { k: string; v: string; vl: string }[] = [];
  for (const [k, values] of Object.entries(attributes)) if (Array.isArray(values)) for (const v of values) attrs.push({ k, v: String(v), vl: String(v).trim().toLowerCase() });
  return {
    product_id: doc.product_id,
    version: Number(doc.version ?? 0),
    indexed_at: iso(doc.indexed_at),
    slug: doc.slug,
    title_norm: doc.title_norm,
    brand_id: doc.brand_id,
    category_id: doc.category_id,
    category_path_ids: doc.category_path_ids ?? [],
    attrs,
    attributes,
    variant_count: doc.variant_count,
    variant_options: doc.variant_options ?? [],
    image: doc.image ?? null,
    seller_ids: doc.seller_ids ?? [],
    has_official: doc.has_official,
    conditions: doc.conditions ?? [],
    offer_count: doc.offer_count,
    featured_offer_id: doc.featured_offer_id,
    featured_price: num(doc.featured_price),
    featured_seller_name: doc.featured_seller_name,
    featured_official: doc.featured_official,
    min_price: num(doc.min_price),
    max_price: num(doc.max_price),
    currency: doc.currency,
    was_price: num(doc.was_price),
    deal_ends_at: iso(doc.deal_ends_at),
    on_sale: doc.on_sale,
    gtins: doc.gtins ?? [],
    variant_gtins: doc.variant_gtins ?? {},
    badges: doc.badges ?? [],
    in_stock: doc.in_stock,
    low_stock: doc.low_stock,
    free_delivery: doc.free_delivery,
    fastest_dispatch_days: doc.fastest_dispatch_days,
    same_day_cutoff: cutoffText(doc.same_day_cutoff),
    rating: num(doc.rating),
    rating_count: doc.rating_count,
    sales_30d: doc.sales_30d,
    popularity: Number(doc.popularity ?? 0),
    first_listed_at: iso(doc.first_listed_at),
    best_seller_rank: doc.best_seller_rank,
    best_seller_category_id: doc.best_seller_category_id,
    // title and brand name are read-model columns as well as texts: partial writes keep them current
    title: doc.title,
    brand_name: doc.brand_name,
    offers: cardOrder(doc, offers).map((o, i) => ({
      offer_id: o.offer_id,
      variant_id: o.variant_id,
      seller_id: o.seller_id,
      seller_key: o.seller_id ?? 'official',
      official: o.official,
      condition: o.condition,
      price: Number(o.price),
      in_stock: o.in_stock,
      free_delivery: o.free_delivery,
      dispatch_days: o.dispatch_days,
      featured: o.offer_id === doc.featured_offer_id,
      featured_eligible: o.featured_eligible,
      card_rank: i,
    })),
  };
}

/** The whole document: fields plus the searchable texts */
export function sourceOf(d: IndexedDocument): Record<string, unknown> {
  const t: DocTexts = d.texts ?? { title: d.doc.title, brand: d.doc.brand_name ?? '', category: '', attributes: '', description: '' };
  return { ...fieldsOf(d.doc, d.offers), title: t.title, brand_name: d.doc.brand_name ?? (t.brand || null), category_text: t.category, attributes_text: t.attributes, description: t.description };
}

/** The read-model row back from a hit's _source (cards, suggestions, lookups) */
export function docOf(s: Record<string, any>): DocRow {
  const date = (v: unknown) => (v == null ? null : new Date(v as string));
  return {
    product_id: s.product_id,
    slug: s.slug,
    title: s.title,
    brand_id: s.brand_id ?? null,
    brand_name: s.brand_name ?? null,
    category_id: s.category_id ?? null,
    category_path_ids: s.category_path_ids ?? [],
    attributes: s.attributes ?? {},
    variant_count: s.variant_count ?? 0,
    variant_options: s.variant_options ?? [],
    image: s.image ?? null,
    seller_ids: s.seller_ids ?? [],
    has_official: Boolean(s.has_official),
    conditions: s.conditions ?? [],
    offer_count: s.offer_count ?? 0,
    featured_offer_id: s.featured_offer_id ?? null,
    featured_price: s.featured_price ?? null,
    featured_seller_name: s.featured_seller_name ?? null,
    featured_official: Boolean(s.featured_official),
    min_price: s.min_price ?? null,
    max_price: s.max_price ?? null,
    currency: s.currency ?? 'USD',
    was_price: s.was_price ?? null,
    deal_ends_at: date(s.deal_ends_at),
    on_sale: Boolean(s.on_sale),
    gtins: s.gtins ?? [],
    variant_gtins: s.variant_gtins ?? {},
    badges: s.badges ?? [],
    in_stock: Boolean(s.in_stock),
    low_stock: Boolean(s.low_stock),
    free_delivery: Boolean(s.free_delivery),
    fastest_dispatch_days: s.fastest_dispatch_days ?? null,
    same_day_cutoff: s.same_day_cutoff ?? null,
    rating: s.rating == null ? null : Number(s.rating).toFixed(1),
    rating_count: s.rating_count ?? 0,
    sales_30d: s.sales_30d ?? 0,
    first_listed_at: date(s.first_listed_at)!,
    popularity: String(s.popularity ?? 0),
    tsv: null,
    title_norm: s.title_norm ?? '',
    version: s.version ?? 0,
    indexed_at: date(s.indexed_at)!,
    best_seller_rank: s.best_seller_rank ?? null,
    best_seller_category_id: s.best_seller_category_id ?? null,
  } as DocRow;
}

