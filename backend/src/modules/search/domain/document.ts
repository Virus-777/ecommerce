/**
 * Building a search document from what the source modules say (pure: no I/O). One document per
 * purchasable product, with offer rows for live offers (active or out of stock).
 */
import type * as catalog from '../../../spec/catalog.js';
import type * as common from '../../../spec/common.js';
import type { DocRow, DocWrite, OfferRow } from '../ports.js';
import { OFFICIAL_BADGE, OFFICIAL_STORE_NAME } from './ranking.js';
import { attrKey, normalizeGtin, titleNorm } from './text.js';
import type { ConditionGroup } from './types.js';

/** A live offer as the indexer sees it (from offers.listOffersAdmin + offers.quoteOffer, inventory, promotions) */
export interface SourceOffer {
  offerId: string;
  variantId: string;
  sellerId: string | null;
  sellerName: string;
  official: boolean;
  /** offers condition: new, used_like_new, used_good, used_acceptable, refurbished */
  condition: string;
  /** Price the customer pays now (campaign price when a markdown or flash sale applies) */
  price: number;
  currency: string;
  /** Verified was-price (compare-at or the regular price under a campaign); unverified ones are never shown */
  wasPrice: number | null;
  saleEndsAt: string | null;
  campaign: boolean;
  inStock: boolean;
  lowStock: boolean;
  freeDelivery: boolean;
  dispatchDays: number;
  /** HH:mm market time */
  sameDayCutoff: string | null;
  featuredEligible: boolean;
}

export interface SourceProduct {
  product: catalog.Product;
  /** Root → product's category */
  categoryPath: { id: string; name: string; slug: string }[];
  offers: SourceOffer[];
  /** offers' featured offer for the product, if any */
  featuredOfferId: string | null;
  rating: { average: number | null; count: number } | null;
  /** Keeps what the index already knows (sales, rating when reviews is off, first listing) */
  existing: DocRow | undefined;
}

export const conditionGroup = (c: string): ConditionGroup => (c === 'new' ? 'new' : c === 'refurbished' ? 'refurbished' : 'used');

/** Variant options and specs → filterable attribute key → values */
export function attributesOf(p: catalog.Product): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const add = (name: string, value: string | null | undefined) => {
    const key = attrKey(name);
    const v = value?.trim();
    if (!key || !v) return;
    const list = (out[key] ??= []);
    if (!list.some((x) => x.toLowerCase() === v.toLowerCase())) list.push(v);
  };
  for (const [name, value] of Object.entries(p.specs ?? {})) add(name, value);
  for (const v of p.variants ?? []) for (const [name, value] of Object.entries(v.options ?? {})) add(name, value);
  return out;
}

/** Display names of attribute keys (variant option and spec names) */
export function attributeNames(p: catalog.Product): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of Object.keys(p.specs ?? {})) out[attrKey(name)] ??= name;
  for (const v of p.variants ?? []) for (const name of Object.keys(v.options ?? {})) out[attrKey(name)] ??= name;
  return out;
}

/** The featured offer: offers' choice when it is live, else the cheapest eligible in-stock offer, else the cheapest */
export function pickFeatured(offers: SourceOffer[], featuredOfferId: string | null): SourceOffer | null {
  const chosen = featuredOfferId ? offers.find((o) => o.offerId === featuredOfferId) : undefined;
  if (chosen) return chosen;
  const by = (list: SourceOffer[]) => [...list].sort((a, b) => a.price - b.price || a.offerId.localeCompare(b.offerId))[0];
  return by(offers.filter((o) => o.inStock && o.featuredEligible)) ?? by(offers.filter((o) => o.inStock)) ?? by(offers) ?? null;
}

const hhmm = (s: string | null | undefined) => (s && /^\d{1,2}:\d{2}/.test(s) ? s.slice(0, 5).padStart(5, '0') : null);

export function buildDocument(src: SourceProduct, now: Date): { doc: DocWrite; offers: OfferRow[] } {
  const p = src.product;
  const offers = src.offers;
  const featured = pickFeatured(offers, src.featuredOfferId);
  const inStockOffers = offers.filter((o) => o.inStock);
  const priced = inStockOffers.length ? inStockOffers : offers;
  const prices = priced.map((o) => o.price);
  const gtins: string[] = [];
  const variantGtins: Record<string, string> = {};
  for (const v of p.variants ?? []) {
    const g = normalizeGtin(v.gtin);
    if (g) {
      if (!gtins.includes(g)) gtins.push(g);
      variantGtins[g] = v.id;
    }
  }
  const image: common.MediaRef | null = p.images?.[0] ?? p.variants?.find((v) => v.images?.length)?.images[0] ?? null;
  const wasPrice = featured?.wasPrice != null && featured.wasPrice > featured.price ? featured.wasPrice : null;
  const onSale = Boolean(featured && (wasPrice !== null || featured.campaign));
  const sameDay = inStockOffers.filter((o) => o.dispatchDays === 0);
  const cutoffs = sameDay.map((o) => hhmm(o.sameDayCutoff));
  const sameDayCutoff = !sameDay.length || cutoffs.some((c) => c === null) ? null : cutoffs.sort().at(-1)!;
  const attributes = attributesOf(p);
  const badges: string[] = [];
  if (featured?.official) badges.push(OFFICIAL_BADGE);
  if (onSale) badges.push('Deal');
  const categoryNames = src.categoryPath.map((c) => c.name);
  const listedAt = p.listedAt ? new Date(p.listedAt) : null;
  const rating = src.rating ? src.rating : src.existing ? { average: src.existing.rating === null ? null : Number(src.existing.rating), count: src.existing.rating_count } : { average: null, count: 0 };

  const doc: DocWrite = {
    product_id: p.id,
    slug: p.slug,
    title: p.title,
    brand_id: p.brand?.id ?? null,
    brand_name: p.brand?.name ?? null,
    category_id: p.categoryId ?? null,
    category_path_ids: src.categoryPath.map((c) => c.id),
    attributes: attributes as never,
    variant_count: p.variants?.length ?? 0,
    variant_options: (p.variants ?? []).map((v) => ({ id: v.id, options: v.options ?? {}, gtin: normalizeGtin(v.gtin), image: v.images?.[0] ?? null })) as never,
    image: image as never,
    seller_ids: [...new Set(offers.map((o) => o.sellerId).filter((s): s is string => Boolean(s)))],
    has_official: offers.some((o) => o.official),
    conditions: [...new Set(offers.map((o) => conditionGroup(o.condition)))],
    offer_count: offers.length,
    featured_offer_id: featured?.offerId ?? null,
    featured_price: featured?.price ?? null,
    featured_seller_name: featured ? (featured.official ? featured.sellerName || OFFICIAL_STORE_NAME : featured.sellerName) : null,
    featured_official: Boolean(featured?.official),
    min_price: prices.length ? Math.min(...prices) : null,
    max_price: prices.length ? Math.max(...prices) : null,
    currency: (featured?.currency ?? offers[0]?.currency ?? src.existing?.currency ?? 'USD').slice(0, 3),
    was_price: wasPrice,
    deal_ends_at: onSale && featured?.saleEndsAt ? new Date(featured.saleEndsAt) : null,
    on_sale: onSale,
    gtins,
    variant_gtins: variantGtins as never,
    badges: badges as never,
    in_stock: inStockOffers.length > 0,
    low_stock: Boolean(featured?.inStock && featured.lowStock),
    free_delivery: Boolean(featured?.freeDelivery),
    fastest_dispatch_days: inStockOffers.length ? Math.min(...inStockOffers.map((o) => o.dispatchDays)) : null,
    same_day_cutoff: sameDayCutoff,
    rating: rating.average === null || !rating.count ? null : (Math.round(rating.average * 10) / 10).toFixed(1),
    rating_count: rating.count,
    sales_30d: src.existing?.sales_30d ?? 0,
    first_listed_at: src.existing?.first_listed_at ?? listedAt ?? now,
    popularity: src.existing?.popularity ?? '0',
    title_norm: titleNorm(p.title, p.brand?.name),
    best_seller_rank: src.existing?.best_seller_rank ?? null,
    best_seller_category_id: src.existing?.best_seller_category_id ?? null,
    texts: {
      title: p.title,
      brand: p.brand?.name ?? '',
      category: categoryNames.join(' '),
      attributes: [...Object.values(attributes).flat(), p.modelNumber ?? '', ...(p.keyFeatures ?? [])].join(' '),
      description: p.description ?? '',
    },
  };
  const rows: OfferRow[] = offers.map((o) => ({
    offer_id: o.offerId,
    product_id: p.id,
    variant_id: o.variantId,
    seller_id: o.sellerId,
    official: o.official,
    condition: conditionGroup(o.condition),
    price: o.price,
    in_stock: o.inStock,
    free_delivery: o.freeDelivery,
    dispatch_days: o.dispatchDays,
    featured_eligible: o.featuredEligible,
  }));
  return { doc, offers: rows };
}

/** Document aggregates recomputed from its offer rows (after an in-place offer or stock update) */
export function aggregatesFromOffers(doc: DocRow, rows: OfferRow[]): Partial<DocRow> {
  const inStock = rows.filter((r) => r.in_stock);
  const priced = inStock.length ? inStock : rows;
  let featured = rows.find((r) => r.offer_id === doc.featured_offer_id) ?? null;
  if (!featured) {
    const by = (list: OfferRow[]) => [...list].sort((a, b) => a.price - b.price || a.offer_id.localeCompare(b.offer_id))[0];
    featured = by(inStock.filter((r) => r.featured_eligible)) ?? by(inStock) ?? by(rows) ?? null;
  }
  const featuredChanged = featured?.offer_id !== doc.featured_offer_id;
  return {
    seller_ids: [...new Set(rows.map((r) => r.seller_id).filter((s): s is string => Boolean(s)))],
    has_official: rows.some((r) => r.official),
    conditions: [...new Set(rows.map((r) => r.condition))],
    offer_count: rows.length,
    featured_offer_id: featured?.offer_id ?? null,
    featured_price: featured?.price ?? null,
    featured_official: Boolean(featured?.official),
    // the seller name of a newly featured offer is filled by the next rebuild
    ...(featuredChanged ? { featured_seller_name: featured?.official ? OFFICIAL_STORE_NAME : doc.featured_seller_name } : {}),
    min_price: priced.length ? Math.min(...priced.map((r) => r.price)) : null,
    max_price: priced.length ? Math.max(...priced.map((r) => r.price)) : null,
    in_stock: inStock.length > 0,
    free_delivery: Boolean(featured?.free_delivery),
    fastest_dispatch_days: inStock.length ? Math.min(...inStock.map((r) => r.dispatch_days)) : null,
    ...(featured?.in_stock ? {} : { low_stock: false }),
  };
}
