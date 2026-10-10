/**
 * Searching: query preparation (filters, synonyms, spelling correction), results with product cards,
 * everything around them (facets with counts, applied filters, sorts, store match, category context,
 * empty guidance), sponsored hits, suggestions and recent searches.
 */
import type { Principal } from '../../../kernel/auth/index.js';
import { AppError } from '../../../kernel/errors/index.js';
import { newId } from '../../../kernel/lib/ids.js';
import { decodeCursor, encodeCursor, type PageRequest } from '../../../kernel/lib/pagination.js';
import type * as catalog from '../../../spec/catalog.js';
import type * as common from '../../../spec/common.js';
import type { AppliedFilter, CategoryContext, EmptyGuidance, Facet, FacetValue, ProductCard, RecentSearch, SearchContext, SearchHit, SortOption, StoreMatch, Suggestions } from '../../../spec/search.js';
import { chips, clearAll, fromRest, toQueryString, validateFilters, FilterError, type Chip, type Labels, type QueryState, type RestSearchParams } from '../domain/query.js';
import { DEFAULT_FACTORS, FROM_PRICE_NOTE, OFFICIAL_BADGE, OFFICIAL_STORE_NAME, RANKING_NOTE, STORE_NOTE, weightsOf } from '../domain/ranking.js';
import { attrKey, expandQuery, isUuid, normalizeQuery, plural, queryGtin, synonymTerms, tokens, type SynonymSet } from '../domain/text.js';
import type { PageInfo, SearchFilters, SearchMatch, SearchQuery, SearchResultSet, SearchSession, SortKey, SponsoredSlot } from '../domain/types.js';
import type { DocRow, EngineFilters, EngineHit, EngineQuery, FacetCounts, RecentRow } from '../ports.js';
import type { CategoryNode, CategoryTree } from './base.js';
import { SearchIndexer } from './indexer.js';

const FACET_VALUES = 10;

export type Mode = { kind: 'search' } | { kind: 'category' } | { kind: 'seller'; sellerId: string } | { kind: 'collection' };

export interface Prepared {
  mode: Mode;
  engineQuery: EngineQuery;
  state: QueryState;
  tree: CategoryTree;
  category: { node: CategoryNode; filters: catalog.Attribute[] } | null;
  categoryIsFilter: boolean;
  /** REST tokens → ids (chips are removed by token) */
  brandTokens: Map<string, string>;
  sellerTokens: Map<string, string>;
  attributeKeys: string[];
  attributeNames: Map<string, string>;
  text: { raw: string | null; normalized: string | null; correctedTo: string | null; correctionApplied: boolean; searchInsteadFor: string | null; synonymsUsed: string[] };
  sort: SortKey;
  bestSellingAvailable: boolean;
  postalCode?: string;
  exact: boolean;
}

const SORT_LABEL: Record<SortKey, string> = {
  recommended: 'Recommended',
  price_asc: 'Price: low to high',
  price_desc: 'Price: high to low',
  newest: 'Newest arrivals',
  rating: 'Highest rated',
  best_selling: 'Best selling',
};

const money = (amount: number, currency: string): common.Money => ({ amount, currency });

/** Window of a paging request (offset paging: the query string is the state) */
export function windowOf(page: PageRequest): { offset: number; limit: number } {
  if (page.mode === 'page') return { offset: (page.page - 1) * page.limit, limit: page.limit };
  const offset = page.cursor ? Number(decodeCursor(page.cursor)[0]) : 0;
  if (!Number.isInteger(offset) || offset < 0) throw new AppError('VALIDATION_FAILED', 'Invalid cursor', { issues: [{ path: 'cursor', message: 'not a cursor from this list' }] });
  return { offset, limit: page.limit };
}

export function pageInfoOf(page: PageRequest, offset: number, limit: number, total: number): { nextCursor: string | null; page?: number; totalPages?: number; total?: number } {
  const next = offset + limit < total ? encodeCursor([offset + limit]) : null;
  if (page.mode === 'page') return { nextCursor: next, page: page.page, totalPages: Math.max(1, Math.ceil(total / limit)), total };
  return { nextCursor: next, total };
}

/** 'Fri, Oct 16' n business days after a market date */
function businessDate(from: string, days: number): string {
  const d = new Date(`${from}T12:00:00Z`);
  let left = days;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) left--;
  }
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function businessDaysBetween(from: string, to: string): number {
  const a = new Date(`${from}T12:00:00Z`);
  const b = new Date(`${to}T12:00:00Z`);
  if (b <= a) return 0;
  let n = 0;
  while (a < b) {
    a.setUTCDate(a.getUTCDate() + 1);
    const wd = a.getUTCDay();
    if (wd !== 0 && wd !== 6) n++;
  }
  return n;
}

export class SearchQueries extends SearchIndexer {
  /* ---------------------------------------------------------------- preparing a query */

  protected async synonymSets(): Promise<SynonymSet[]> {
    return (await this.repo.activeSynonyms()).map((s) => ({ id: s.id, terms: synonymTerms(s.terms), kind: s.kind === 'one_way' ? 'one_way' : 'equivalent', from: s.from_term ? normalizeQuery(s.from_term) : null }));
  }

  protected async weights() {
    const policy = await this.repo.currentPolicy(this.now());
    return weightsOf(policy ? (policy.factors as never) : DEFAULT_FACTORS);
  }

  /** Validates and resolves a query: slugs to ids, filters for the engine, synonyms and spelling correction */
  async prepare(query: SearchQuery & { exact?: boolean; postalCode?: string }, mode: Mode, opts: { strictSort: boolean }): Promise<Prepared> {
    const f: SearchFilters = { ...(query.filters ?? {}) };
    try {
      validateFilters(f, query.sort ?? undefined);
    } catch (err) {
      this.filterError(err);
    }
    const tree = await this.categoryTree();
    const ef: EngineFilters = { inStockOnly: f.inStockOnly ?? (await this.setting('excludeOutOfStockByDefault')) };

    // category: a slug (REST, category page) or ids (GraphQL)
    let category: Prepared['category'] = null;
    let categoryToken: string | null = null;
    const categoryNodes: CategoryNode[] = [];
    if (f.categorySlug) {
      const node = tree.bySlug.get(f.categorySlug);
      if (!node) throw this.ctx.error('INVALID_FILTER', `Unknown category '${f.categorySlug}'`, { filter: 'category' });
      categoryNodes.push(node);
    }
    for (const id of f.categoryIds ?? []) {
      const node = tree.byId.get(id);
      if (!node) throw this.ctx.error('INVALID_FILTER', 'Unknown category', { filter: 'category' });
      if (!categoryNodes.some((n) => n.id === id)) categoryNodes.push(node);
    }
    if (categoryNodes.length) {
      ef.categoryIds = categoryNodes.map((n) => n.id);
      categoryToken = categoryNodes[0]!.slug;
      if (categoryNodes.length === 1) {
        const detail = await this.optional('catalog', 'category', (c) => c.getCategoryBySlug(categoryNodes[0]!.slug));
        if (detail === null) throw this.ctx.error('INVALID_FILTER', `Unknown category '${categoryNodes[0]!.slug}'`, { filter: 'category' });
        category = { node: categoryNodes[0]!, filters: (detail?.filters ?? []).filter((a) => a.filterable) };
      }
    }

    // brands: slugs or ids
    const brandTokens = new Map<string, string>();
    for (const id of f.brandIds ?? []) brandTokens.set(id, id);
    for (const token of f.brandSlugs ?? []) {
      if (isUuid(token)) {
        brandTokens.set(token, token);
        continue;
      }
      const brand = await this.optional('catalog', 'brand', (c) => c.getBrandBySlug(token));
      if (!brand) throw this.ctx.error('INVALID_FILTER', `Unknown brand '${token}'`, { filter: 'brand' });
      brandTokens.set(token, brand.id);
    }
    if (brandTokens.size) ef.brandIds = [...new Set(brandTokens.values())];

    // sellers: slugs or ids; 'official' is the Official Store
    const sellerTokens = new Map<string, string>();
    if (mode.kind === 'seller') {
      ef.sellerIds = [mode.sellerId];
    } else {
      for (const id of f.sellerIds ?? []) sellerTokens.set(id, id);
      for (const token of f.sellerSlugs ?? []) {
        if (isUuid(token)) {
          sellerTokens.set(token, token);
          continue;
        }
        const store = await this.optional('sellers', 'store', (s) => s.getStorefrontBySlug(token));
        if (!store) throw this.ctx.error('INVALID_FILTER', `Unknown store '${token}'`, { filter: 'seller' });
        sellerTokens.set(token, store.seller.id);
      }
      if (sellerTokens.size) ef.sellerIds = [...new Set(sellerTokens.values())];
      if (f.official) ef.official = true;
    }

    // category attribute filters
    const attributeNames = new Map<string, string>();
    for (const a of category?.filters ?? []) attributeNames.set(attrKey(a.name), a.name);
    if (f.attributes?.length) {
      for (const a of f.attributes) {
        const key = attrKey(a.key);
        if (category) {
          const attr = category.filters.find((x) => attrKey(x.name) === key);
          if (!attr) throw this.ctx.error('INVALID_FILTER', `'${a.key}' is not a filter of ${category.node.name}`, { filter: a.key });
          if (attr.kind === 'enum' && attr.options.length) {
            const bad = a.values.find((v) => !attr.options.some((o) => o.toLowerCase() === v.trim().toLowerCase()));
            if (bad) throw this.ctx.error('INVALID_FILTER', `'${bad}' is not a value of ${attr.name}`, { filter: a.key });
          }
        }
        if (!attributeNames.has(key)) attributeNames.set(key, a.key);
      }
      ef.attributes = f.attributes.map((a) => ({ key: attrKey(a.key), values: a.values }));
    }

    if (f.priceMin != null) ef.priceMin = f.priceMin;
    if (f.priceMax != null) ef.priceMax = f.priceMax;
    if (f.minRating != null) ef.minRating = f.minRating;
    if (f.conditions?.length) ef.conditions = f.conditions;
    if (f.freeDelivery) ef.freeDelivery = true;
    if (f.shipsToday) ef.shipsToday = true;
    if (f.arrivesBy) ef.maxDispatchDays = businessDaysBetween(this.marketDate(), f.arrivesBy) - Number(await this.setting('transitBusinessDays'));
    if (f.onSale) ef.onSale = true;
    if (f.listedWithinDays) ef.listedSince = new Date(this.now().getTime() - f.listedWithinDays * 86_400_000);

    const engineQuery: EngineQuery = { text: null, filters: ef, marketTime: this.marketTime() };

    // sort
    const minOrders = await this.setting('bestSellingMinOrders');
    const bestSellingAvailable = await this.engine.bestSellingAvailable(minOrders);
    let sort: SortKey = query.sort ?? 'recommended';
    if (sort === 'best_selling' && !bestSellingAvailable) {
      if (opts.strictSort) throw this.ctx.error('SORT_NOT_AVAILABLE', 'Best selling is offered once there is enough sales history');
      sort = 'recommended';
    }

    // text: synonyms, GTINs and spelling correction
    const raw = query.q?.trim() || null;
    const text: Prepared['text'] = { raw, normalized: null, correctedTo: null, correctionApplied: false, searchInsteadFor: null, synonymsUsed: [] };
    const exact = Boolean(query.exact);
    if (raw) {
      const normalized = normalizeQuery(raw);
      text.normalized = normalized;
      const gtin = queryGtin(raw);
      const sets = await this.synonymSets();
      const exp = expandQuery(normalized, sets);
      text.synonymsUsed = exp.used;
      engineQuery.text = { groups: exp.groups, gtin };
      if (!exact && !gtin && normalized) {
        const below = await this.setting('autoCorrectBelowResults');
        const n = await this.engine.count(engineQuery);
        if (n < below) {
          const threshold = await this.setting('typoSimilarityThreshold');
          const words = tokens(normalized);
          const fixed = await Promise.all(words.map(async (w) => (await this.engine.correctWord(w, threshold)) ?? w));
          const corrected = fixed.join(' ');
          if (corrected !== normalized) {
            const cexp = expandQuery(corrected, sets);
            const correctedQuery: EngineQuery = { ...engineQuery, text: { groups: cexp.groups, gtin: null } };
            const m = await this.engine.count(correctedQuery);
            if (m > n) {
              engineQuery.text = correctedQuery.text;
              text.correctedTo = corrected;
              text.correctionApplied = true;
              text.searchInsteadFor = raw;
              text.synonymsUsed = cexp.used;
            }
          }
        }
      }
    }

    const state: QueryState = {
      q: raw,
      exact: exact || undefined,
      category: categoryToken,
      brand: [...brandTokens.keys()],
      seller: mode.kind === 'seller' ? [] : [...(ef.official ? ['official'] : []), ...sellerTokens.keys()],
      condition: [...(f.conditions ?? [])],
      delivery: [...(f.freeDelivery ? ['free'] : []), ...(f.shipsToday ? ['ships_today'] : []), ...(f.arrivesBy ? ['arrives_by'] : [])],
      attrs: (ef.attributes ?? []).map((a) => ({ key: a.key, values: [...a.values] })),
      sort,
      ...(f.priceMin != null ? { priceMin: f.priceMin } : {}),
      ...(f.priceMax != null ? { priceMax: f.priceMax } : {}),
      ...(f.minRating != null ? { rating: f.minRating } : {}),
      ...(f.inStockOnly === false ? { availability: 'include_out_of_stock' as const } : {}),
      ...(f.arrivesBy ? { arrivesBy: f.arrivesBy } : {}),
      ...(f.listedWithinDays ? { listedWithinDays: f.listedWithinDays } : {}),
      ...(f.onSale ? { onSale: true } : {}),
    };

    return {
      mode,
      engineQuery,
      state,
      tree,
      category,
      categoryIsFilter: mode.kind !== 'category',
      brandTokens,
      sellerTokens,
      attributeKeys: [...attributeNames.keys()].filter((k) => category?.filters.some((a) => attrKey(a.name) === k)),
      attributeNames,
      text,
      sort,
      bestSellingAvailable,
      ...(query.postalCode ? { postalCode: query.postalCode } : {}),
      exact,
    };
  }

  /* ---------------------------------------------------------------- cards */

  /** Store names of sellers (sellers optional: unknown names fall back to a neutral label) */
  protected async sellerNames(ids: (string | null | undefined)[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter((i): i is string => Boolean(i)))];
    if (!unique.length) return new Map();
    const found = await this.optional('sellers', 'store names', (s) => s.getSellers(unique));
    const map = new Map((found ?? []).map((s) => [s.id, s.storeName]));
    const missing = unique.filter((id) => !map.has(id));
    if (missing.length) for (const t of await this.repo.terms('store', missing)) if (t.target_id) map.set(t.target_id, t.term);
    return map;
  }

  /** Product cards (and their matches) for engine hits; positions start after `offset` */
  protected async cards(hits: EngineHit[], opts: { offset?: number; attributes?: { key: string; values: string[] }[] } = {}): Promise<{ card: ProductCard; match: SearchMatch }[]> {
    const names = await this.sellerNames(hits.map((h) => (h.offer && h.offer.offerId !== h.doc.featured_offer_id ? h.offer.sellerId : null)));
    const now = this.now();
    const newDays = await this.setting('newArrivalsWindowDays');
    const today = this.marketDate(now);
    // carrier transit assumed for every destination (setting transitBusinessDays, decision S-D4)
    const transit = Number(await this.setting('transitBusinessDays'));
    return hits.map((h, i) => {
      const d = h.doc;
      const o = h.offer;
      const featured = Boolean(o && o.offerId === d.featured_offer_id);
      const priceIsFrom = Boolean(o && !featured && o.matching > 1);
      const sellerName = !o || featured ? (d.featured_seller_name ?? (o?.official ? OFFICIAL_STORE_NAME : 'Marketplace seller')) : o.official ? OFFICIAL_STORE_NAME : (names.get(o.sellerId ?? '') ?? 'Marketplace seller');
      const variants = (Array.isArray(d.variant_options) ? d.variant_options : []) as { id: string; options: Record<string, string> }[];
      // the variant the filters picked (e.g. color), else the card offer's variant
      let variant = opts.attributes?.length
        ? variants.find((v) => opts.attributes!.every((a) => {
            const hit = Object.entries(v.options ?? {}).find(([k]) => attrKey(k) === a.key);
            return !hit || a.values.some((x) => x.toLowerCase() === String(hit[1]).toLowerCase());
          }) && opts.attributes!.some((a) => Object.keys(v.options ?? {}).some((k) => attrKey(k) === a.key)))
        : undefined;
      const variantId = variant?.id ?? o?.variantId ?? variants[0]?.id ?? null;
      variant ??= variants.find((v) => v.id === variantId);
      let variantCue: string | null = null;
      if (opts.attributes?.length && variant && variants.length > 1) variantCue = Object.values(variant.options ?? {}).join(' / ') || null;
      else if (variants.length > 1) {
        const keys = [...new Set(variants.flatMap((v) => Object.keys(v.options ?? {})))];
        const varying = keys.filter((k) => new Set(variants.map((v) => v.options?.[k])).size > 1);
        variantCue = varying.length === 1 ? plural(new Set(variants.map((v) => v.options?.[varying[0]!])).size, varying[0]!) : `${variants.length} options`;
      }
      const price = o?.price ?? d.featured_price ?? d.min_price ?? 0;
      const was = featured && d.was_price && d.was_price > price ? d.was_price : null;
      const inStock = o?.inStock ?? d.in_stock;
      const dispatch = o?.dispatchDays ?? d.fastest_dispatch_days;
      const free = o?.freeDelivery ?? d.free_delivery;
      const official = o?.official ?? d.featured_official;
      const badges: string[] = [];
      if (official) badges.push(OFFICIAL_BADGE);
      if (featured && d.on_sale) badges.push('Deal');
      if (d.first_listed_at && now.getTime() - new Date(d.first_listed_at).getTime() <= newDays * 86_400_000) badges.push('New listing');
      if (d.best_seller_rank !== null && d.best_seller_rank <= 3) badges.push('Best seller');
      const card: ProductCard = {
        productId: d.product_id,
        slug: d.slug,
        title: d.title,
        brandName: d.brand_name,
        image: (d.image as unknown as common.MediaRef | null) ?? null,
        variantId,
        variantCue,
        rating: d.rating === null || !d.rating_count ? null : Number(d.rating),
        ratingCount: d.rating_count,
        price: money(price, d.currency),
        priceIsFrom,
        offerId: o?.offerId ?? d.featured_offer_id,
        sellerName,
        sellerId: o ? o.sellerId : null,
        official,
        condition: o?.condition ?? d.conditions[0] ?? 'new',
        wasPrice: was ? money(was, d.currency) : null,
        discountPct: was ? Math.round(((was - price) / was) * 100) : null,
        dealEndsAt: featured && d.on_sale && d.deal_ends_at ? new Date(d.deal_ends_at).toISOString() : null,
        deliveryCue: inStock && dispatch !== null && dispatch !== undefined ? `${free ? 'Free delivery' : 'Arrives'} ${businessDate(today, dispatch + transit)}` : null,
        freeDelivery: free,
        availability: !inStock ? 'out_of_stock' : featured && d.low_stock ? 'low_stock' : 'in_stock',
        offerCount: d.offer_count,
        badges,
      };
      const match: SearchMatch = { position: (opts.offset ?? 0) + i + 1, variantId, variantCue, offerId: card.offerId ?? null, priceIsFrom, badges };
      return { card, match };
    });
  }

  /** Cards for product ids in the given order (unknown or unlisted products are left out) */
  protected async cardsFor(productIds: string[], opts: { sellerId?: string; inStockOnly?: boolean } = {}): Promise<ProductCard[]> {
    const ids = [...new Set(productIds)];
    if (!ids.length) return [];
    const q: EngineQuery = { text: null, filters: { inStockOnly: Boolean(opts.inStockOnly), ...(opts.sellerId ? { sellerIds: [opts.sellerId] } : {}) }, productIds: ids, marketTime: this.marketTime() };
    const { hits } = await this.engine.search(q, 'recommended', await this.weights(), { offset: 0, limit: ids.length });
    const cards = await this.cards(hits);
    const byId = new Map(cards.map((c) => [c.card.productId, c.card]));
    return ids.map((id) => byId.get(id)).filter((c): c is ProductCard => Boolean(c));
  }

  /* ---------------------------------------------------------------- results and context */

  protected async results(p: Prepared, window: { offset: number; limit: number }) {
    const { hits, total } = await this.engine.search(p.engineQuery, p.sort, await this.weights(), window);
    const cards = await this.cards(hits, { offset: window.offset, attributes: p.engineQuery.filters.attributes });
    return { cards, total, hits };
  }

  /** Engine filters with one applied filter removed (empty guidance counts) */
  protected withoutChip(p: Prepared, chip: Chip): EngineFilters {
    const f: EngineFilters = { ...p.engineQuery.filters };
    switch (chip.key) {
      case 'category':
        delete f.categoryIds;
        break;
      case 'brand':
        f.brandIds = (f.brandIds ?? []).filter((id) => id !== p.brandTokens.get(chip.value));
        if (!f.brandIds.length) delete f.brandIds;
        break;
      case 'seller':
        if (chip.value === 'official') delete f.official;
        else {
          f.sellerIds = (f.sellerIds ?? []).filter((id) => id !== p.sellerTokens.get(chip.value));
          if (!f.sellerIds.length) delete f.sellerIds;
        }
        break;
      case 'price':
        delete f.priceMin;
        delete f.priceMax;
        break;
      case 'rating':
        delete f.minRating;
        break;
      case 'condition':
        f.conditions = (f.conditions ?? []).filter((c) => c !== chip.value);
        if (!f.conditions.length) delete f.conditions;
        break;
      case 'availability':
        f.inStockOnly = true;
        break;
      case 'delivery':
        if (chip.value === 'free') delete f.freeDelivery;
        if (chip.value === 'ships_today') delete f.shipsToday;
        if (chip.value === 'arrives_by') delete f.maxDispatchDays;
        break;
      case 'listedWithinDays':
        delete f.listedSince;
        break;
      case 'onSale':
        delete f.onSale;
        break;
      default:
        f.attributes = (f.attributes ?? []).map((a) => (a.key === chip.key ? { key: a.key, values: a.values.filter((v) => v !== chip.value) } : a)).filter((a) => a.values.length);
    }
    return f;
  }

  protected async facetsOf(p: Prepared, counts: FacetCounts, sellerNames: Map<string, string>): Promise<Facet[]> {
    const f = p.engineQuery.filters;
    const currency = this.ctx.config.market.currency;
    const facets: Facet[] = [];
    const selectedCategory = p.category?.node ?? null;
    const categoryCandidates = (selectedCategory ? selectedCategory.children : p.tree.roots).map((id) => p.tree.byId.get(id)!).filter((c) => c && c.visible);
    facets.push({
      key: 'category',
      label: 'Category',
      group: 'universal',
      kind: 'category',
      multiSelect: false,
      values: categoryCandidates
        .map((c): FacetValue => ({ value: c.slug, label: c.name, count: counts.categories.get(c.id) ?? 0, selected: false }))
        .filter((v) => v.count > 0),
      collapsed: false,
    });
    facets.push({
      key: 'price',
      label: 'Price',
      group: 'universal',
      kind: 'price',
      multiSelect: false,
      values: [],
      range: {
        min: counts.price.min !== null ? money(counts.price.min, currency) : null,
        max: counts.price.max !== null ? money(counts.price.max, currency) : null,
        selectedMin: f.priceMin != null ? money(f.priceMin, currency) : null,
        selectedMax: f.priceMax != null ? money(f.priceMax, currency) : null,
      },
      collapsed: false,
    });
    const brandValues = counts.brands.map((b): FacetValue => ({ value: b.id, label: b.name, count: b.count, selected: Boolean(f.brandIds?.includes(b.id)) }));
    const brandShown = [...brandValues.filter((v) => v.selected), ...brandValues.filter((v) => !v.selected)].slice(0, Math.max(FACET_VALUES, brandValues.filter((v) => v.selected).length));
    facets.push({ key: 'brand', label: 'Brand', group: 'universal', kind: 'brand', multiSelect: true, values: brandShown, moreCount: brandValues.length > brandShown.length ? brandValues.length - brandShown.length : null, collapsed: false });
    facets.push({
      key: 'rating',
      label: 'Customer rating',
      group: 'universal',
      kind: 'rating',
      multiSelect: false,
      values: [4, 3, 2, 1].map((n) => ({ value: String(n), label: `${n} stars and up`, count: counts.ratings.get(n) ?? 0, selected: f.minRating === n })),
      collapsed: false,
    });
    if (p.mode.kind !== 'seller') {
      const sellerValues: FacetValue[] = [];
      if (counts.official || f.official) sellerValues.push({ value: 'official', label: OFFICIAL_STORE_NAME, count: counts.official, selected: Boolean(f.official), note: 'Shows company offers at the prices listed' });
      const others = [...counts.sellers.entries()]
        .map(([id, n]): FacetValue => ({ value: id, label: sellerNames.get(id) ?? 'Marketplace seller', count: n, selected: Boolean(f.sellerIds?.includes(id)) }))
        .sort((a, b) => Number(b.selected) - Number(a.selected) || b.count - a.count || a.label.localeCompare(b.label));
      const shown = others.slice(0, FACET_VALUES);
      facets.push({ key: 'seller', label: 'Seller', group: 'universal', kind: 'seller', multiSelect: true, values: [...sellerValues, ...shown], moreCount: others.length > shown.length ? others.length - shown.length : null, collapsed: false });
    }
    facets.push({
      key: 'condition',
      label: 'Condition',
      group: 'universal',
      kind: 'condition',
      multiSelect: true,
      values: (['new', 'used', 'refurbished'] as const).map((c) => ({ value: c, label: c === 'new' ? 'New' : c === 'used' ? 'Used' : 'Refurbished', count: counts.conditions.get(c) ?? 0, selected: Boolean(f.conditions?.includes(c)) })),
      collapsed: false,
    });
    facets.push({
      key: 'availability',
      label: 'Availability',
      group: 'universal',
      kind: 'availability',
      multiSelect: false,
      values: [
        { value: 'in_stock', label: 'In stock now', count: counts.inStock, selected: f.inStockOnly },
        { value: 'include_out_of_stock', label: 'Include out of stock', count: counts.includingOutOfStock, selected: !f.inStockOnly },
      ],
      collapsed: false,
    });
    facets.push({
      key: 'delivery',
      label: 'Delivery',
      group: 'universal',
      kind: 'delivery',
      multiSelect: true,
      values: [
        { value: 'free', label: 'Free delivery', count: counts.freeDelivery, selected: Boolean(f.freeDelivery) },
        { value: 'ships_today', label: 'Ships today', count: counts.shipsToday, selected: Boolean(f.shipsToday) },
      ],
      collapsed: false,
    });
    // category attribute filters, e.g. 'Headphone features'
    if (p.category) {
      let i = 0;
      for (const attr of p.category.filters) {
        const key = attrKey(attr.name);
        const found = counts.attributes.get(key) ?? new Map<string, number>();
        const selected = f.attributes?.find((a) => a.key === key)?.values.map((v) => v.toLowerCase()) ?? [];
        const values = [...found.entries()]
          .map(([value, count]): FacetValue => ({ value, label: value, count, selected: selected.includes(value.toLowerCase()) }))
          .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, undefined, { numeric: true }));
        for (const s of selected) if (!values.some((v) => v.value.toLowerCase() === s)) values.push({ value: s, label: s, count: 0, selected: true });
        facets.push({
          key,
          label: attr.name,
          group: 'category',
          groupLabel: `${p.category.node.name} features`,
          kind: 'attribute',
          multiSelect: true,
          values: values.slice(0, FACET_VALUES),
          unit: attr.unit ?? null,
          moreCount: values.length > FACET_VALUES ? values.length - FACET_VALUES : null,
          collapsed: i++ >= 3 && !selected.length,
        });
      }
    }
    return facets;
  }

  protected sortsOf(p: Prepared): SortOption[] {
    return (Object.keys(SORT_LABEL) as SortKey[]).map((key) => ({ key, label: SORT_LABEL[key], available: key !== 'best_selling' || p.bestSellingAvailable, selected: key === p.sort }));
  }

  protected async storeMatchOf(p: Prepared): Promise<StoreMatch | null> {
    if (p.mode.kind !== 'search' || !p.text.normalized) return null;
    const q = p.text.correctedTo ?? p.text.normalized;
    const [term] = await this.engine.suggestTerms('store', q, 0.5, 1);
    if (!term?.target_id) return null;
    const name = term.term.toLowerCase();
    const strong = name === q || (q.length >= 3 && (name.startsWith(q) || q.includes(name)));
    if (!strong) {
      const sim = await this.engine.suggestTerms('store', q, 0.6, 1);
      if (!sim.length) return null;
    }
    const card = (await this.optional('sellers', 'store card', (s) => s.getStorefrontCard([term.target_id!])))?.[0];
    if (!card) return null;
    const count = (await this.engine.productCountsBySeller([card.id])).get(card.id) ?? 0;
    return {
      sellerId: card.id,
      name: card.storeName,
      slug: card.slug,
      logo: card.logo ?? null,
      verified: card.verified,
      official: false,
      positivePct: card.positivePct == null ? null : Math.round(card.positivePct),
      ratingCount: card.ratingCount ?? null,
      productCount: count,
      location: card.location ?? null,
      note: STORE_NOTE,
    };
  }

  protected async categoryContextOf(p: Prepared, counts: FacetCounts, sellerCount: number): Promise<CategoryContext | null> {
    if (!p.category) return null;
    const node = p.category.node;
    return {
      category: p.tree.crumb(node),
      breadcrumb: p.tree.path(node.id).map(p.tree.crumb),
      subcategories: node.children
        .map((id) => p.tree.byId.get(id)!)
        .filter((c) => c && c.visible)
        .map((c) => ({ id: c.id, name: c.name, slug: c.slug, count: counts.categories.get(c.id) ?? 0, comingSoon: c.comingSoon })),
      sellerCount,
    };
  }

  protected async emptyGuidanceOf(p: Prepared, applied: Chip[]): Promise<EmptyGuidance> {
    const base = p.engineQuery;
    const removable = [];
    for (const chip of applied) {
      const count = await this.engine.count({ ...base, filters: this.withoutChip(p, chip) });
      removable.push({ filter: this.appliedFilter(chip, p), resultCount: count });
    }
    const cleared: EngineFilters = { inStockOnly: await this.setting('excludeOutOfStockByDefault'), ...(p.categoryIsFilter || !base.filters.categoryIds ? {} : { categoryIds: base.filters.categoryIds }) };
    const clearAllCount = applied.length ? await this.engine.count({ ...base, filters: cleared }) : null;
    // nearby categories: where the words find something, or the category's neighbours
    const nearbyCounts = await this.engine.facets({ ...base, filters: { inStockOnly: true } }, []);
    const tree = p.tree;
    const current = p.category?.node ?? null;
    const neighbourIds = current ? [...(current.parentId ? tree.byId.get(current.parentId)?.children ?? [] : tree.roots), ...current.children].filter((id) => id !== current.id) : [...tree.byId.keys()];
    const withResults = neighbourIds.map((id) => tree.byId.get(id)!).filter((c) => c && c.visible && (nearbyCounts.categories.get(c.id) ?? 0) > 0);
    // the most specific categories: leave out ancestors of another candidate
    const nearby = withResults
      .filter((c) => !withResults.some((o) => o.id !== c.id && tree.path(o.id).some((a) => a.id === c.id)))
      .map((c) => ({ id: c.id, name: c.name, slug: c.slug, count: nearbyCounts.categories.get(c.id) ?? 0, comingSoon: c.comingSoon }))
      .sort((a, b) => (tree.path(b.id).length - tree.path(a.id).length) || b.count - a.count)
      .slice(0, 4);
    const closest = current?.id ?? nearby[0]?.id ?? null;
    const popularIds = await this.engine.popular(closest ? [closest] : null, 4);
    const popular = popularIds.length ? popularIds : await this.engine.popular(null, 4);
    const q = p.text.raw;
    return {
      title: applied.length ? 'Nothing matches all your filters' : q ? `No results for "${q}"` : 'Nothing here yet',
      message: applied.length
        ? 'Try removing a filter. Each one below shows how many results you would get without it.'
        : q
          ? 'Check the spelling, use fewer or more general words, or browse a nearby category.'
          : 'Products appear here as soon as they are listed. Browse a nearby category in the meantime.',
      removableFilters: removable,
      clearAllCount,
      nearbyCategories: nearby,
      tips: ['Check the spelling', 'Use fewer or more general words', 'Remove a filter', 'Search by brand or model number'],
      popular: await this.cardsFor(popular, { inStockOnly: true }),
    };
  }

  protected appliedFilter(chip: Chip, p: Prepared): AppliedFilter {
    return { key: chip.key, value: chip.value, label: chip.label, removeQuery: toQueryString(chip.without) || (p.mode.kind === 'category' && p.state.category ? `category=${p.state.category}` : '') };
  }

  /** Everything around the results: total, correction, applied filters, facets, sorts, store match, category, guidance */
  async context(p: Prepared, searchId: string): Promise<SearchContext> {
    const [summary, counts] = await Promise.all([this.engine.summary(p.engineQuery), this.engine.facets(p.engineQuery, p.attributeKeys)]);
    const sellerIds = [...counts.sellers.keys(), ...(p.engineQuery.filters.sellerIds ?? [])];
    const names = await this.sellerNames(sellerIds);
    const labels: Labels = {
      category: p.category ? p.tree.crumb(p.category.node) : null,
      brands: [...p.brandTokens].map(([token, id]) => ({ key: token, name: counts.brands.find((b) => b.id === id)?.name ?? token })),
      sellers: [...p.sellerTokens].map(([token, id]) => ({ key: token, name: names.get(id) ?? token })),
      attributes: p.attributeNames,
    };
    for (const b of labels.brands) {
      if (b.name !== b.key) continue;
      // a selected brand without results this time: its name from any of its documents
      const [docId] = await this.repo.documentIds({ brandIds: [p.brandTokens.get(b.key)!] });
      const doc = docId ? await this.repo.getDocument(docId) : undefined;
      if (doc?.brand_name) b.name = doc.brand_name;
    }
    const applied = chips(p.state, labels, { categoryIsFilter: p.categoryIsFilter, currency: this.ctx.config.market.currency });
    const total = summary.total;
    const totalLabel =
      total === 0
        ? 'No results'
        : `${total} ${total === 1 ? 'result' : 'results'} from ${summary.sellers} ${summary.sellers === 1 ? 'seller' : 'sellers'}${summary.official ? (summary.sellers === 1 ? ', the Official Store' : ', including the Official Store') : ''}`;
    return {
      searchId,
      query: { raw: p.text.raw, normalized: p.text.normalized, correctedTo: p.text.correctedTo, correctionApplied: p.text.correctionApplied, searchInsteadFor: p.text.searchInsteadFor },
      total,
      totalLabel,
      appliedFilters: applied.map((c) => this.appliedFilter(c, p)),
      clearAllQuery: toQueryString(clearAll(p.state, { categoryIsFilter: p.categoryIsFilter })),
      facets: await this.facetsOf(p, counts, names),
      sorts: this.sortsOf(p),
      storeMatch: await this.storeMatchOf(p),
      category: await this.categoryContextOf(p, counts, summary.sellers),
      emptyGuidance: total === 0 ? await this.emptyGuidanceOf(p, applied) : null,
      fromPriceNote: FROM_PRICE_NOTE,
      rankingNote: RANKING_NOTE,
    };
  }

  /* ---------------------------------------------------------------- logging and recent searches */

  /** Who is searching, from the caller (customer id through customers; visitors are their guest session) */
  async sessionOf(principal: Principal | null | undefined): Promise<SearchSession> {
    if (!principal) return {};
    if (principal.kind === 'customer' && principal.accountId) {
      const customerId = await this.customerIdOf(principal.accountId);
      return { ...(customerId ? { customerId } : {}), sessionKey: principal.sessionId };
    }
    if (principal.kind === 'visitor') return { guestSessionId: principal.guestSessionId ?? principal.sessionId, sessionKey: principal.sessionId };
    return { sessionKey: principal.sessionId };
  }

  /** The recent-search owner of a session (customers only while their recent searches are on) */
  protected async recentOwner(session: SearchSession | undefined): Promise<{ kind: 'customer' | 'guest'; id: string } | null> {
    if (session?.customerId) return (await this.recentSearchesOn(session.customerId)) ? { kind: 'customer', id: session.customerId } : null;
    if (session?.guestSessionId) return { kind: 'guest', id: session.guestSessionId };
    return null;
  }

  /** Query log (zero-result reports, suggestions) and the session's recent searches */
  protected async record(p: Prepared, context: SearchContext, session: SearchSession | undefined) {
    const searchId = context.searchId;
    const total = context.total;
    const at = this.now();
    const { q: _q, sort: _s, exact: _e, ...filters } = p.state;
    await this.repo.logQuery({
      id: newId(),
      search_id: searchId,
      raw: p.text.raw,
      normalized: p.text.normalized,
      filters: filters as never,
      sort: p.sort,
      results: total,
      corrected_to: p.text.correctedTo,
      session_key: session?.sessionKey ?? null,
      at,
    });
    if (!p.text.raw) return;
    const owner = await this.recentOwner(session);
    if (!owner) return;
    const label = [...(p.category && !p.categoryIsFilter ? [p.category.node.name] : []), ...context.appliedFilters.map((a) => a.label)].join(' · ');
    const row: RecentRow = { id: newId(), owner_kind: owner.kind, owner_id: owner.id, query: p.text.raw, filters: { ...filters, label: label || null } as never, searched_at: at };
    await this.repo.saveRecentSearch(row, await this.setting('recentSearchesMax'));
  }

  protected recentOut = (r: RecentRow): RecentSearch => {
    const f = (r.filters ?? {}) as { label?: string | null };
    return { id: r.id, query: r.query, filtersLabel: f.label || null, searchedAt: new Date(r.searched_at).toISOString() };
  };

  async listRecent(session: SearchSession): Promise<RecentSearch[]> {
    const owner = await this.recentOwner(session);
    if (!owner) return [];
    return (await this.repo.recentSearches(owner, await this.setting('recentSearchesMax'))).map(this.recentOut);
  }

  /* ---------------------------------------------------------------- REST: products and context */

  protected modeOfRest(p: RestSearchParams): Mode {
    return p.q?.trim() ? { kind: 'search' } : p.category ? { kind: 'category' } : { kind: 'collection' };
  }

  protected parseRest(params: RestSearchParams) {
    try {
      return fromRest(params);
    } catch (err) {
      if (err instanceof FilterError) this.filterError(err);
      throw err;
    }
  }

  /** GET /products: one page of hits; sponsored hits from advertising on the first page only */
  async restProducts(params: RestSearchParams, page: PageRequest, principal: Principal | null): Promise<common.Page<SearchHit>> {
    const query = this.parseRest(params);
    const mode = this.modeOfRest(params);
    const p = await this.prepare(query, mode, { strictSort: true });
    const window = windowOf(page);
    const { cards, total, hits } = await this.results(p, window);
    const items: SearchHit[] = cards.map((c) => ({ position: c.match.position, kind: 'organic', slot: null, product: c.card, sponsored: null }));
    if (window.offset === 0) await this.addSponsored(items, p, hits, principal);
    const info = pageInfoOf(page, window.offset, window.limit, total);
    return { items, ...info };
  }

  protected pageTypeOf(p: Prepared): 'search' | 'category' | 'brand' | 'seller_store' | 'official_store' | 'deals' | 'collection' {
    if (p.mode.kind === 'search') return 'search';
    if (p.mode.kind === 'seller') return 'seller_store';
    if (p.mode.kind === 'category') return p.engineQuery.filters.onSale ? 'deals' : 'category';
    if (p.engineQuery.filters.official && !p.engineQuery.filters.sellerIds) return 'official_store';
    if (p.engineQuery.filters.sellerIds?.length === 1) return 'seller_store';
    if (p.engineQuery.filters.brandIds?.length === 1) return 'brand';
    if (p.engineQuery.filters.onSale) return 'deals';
    return 'collection';
  }

  /**
   * Who is looking, for ad targeting: a signed-in customer's id, and personalization only when that customer
   * allows personalized recommendations (customers marketing preferences). Visitors carry no privacy choice
   * here, so their ads use page context only.
   */
  protected async adPrivacyOf(principal: Principal | null): Promise<{ personalizationAllowed: boolean; customerId: string | null }> {
    if (principal?.kind !== 'customer' || !principal.accountId) return { personalizationAllowed: false, customerId: null };
    const customerId = (await this.customerIdOf(principal.accountId)) ?? null;
    if (!customerId) return { personalizationAllowed: false, customerId: null };
    const prefs = await this.optional('customers', 'marketing consent', (c) => c.getMarketingConsent(customerId));
    return { personalizationAllowed: Boolean(prefs?.personalizedRecommendations), customerId };
  }

  /** Sponsored hits: a labelled top row on search, inline positions on listings (advertising decides; none when it is off) */
  protected async addSponsored(items: SearchHit[], p: Prepared, hits: EngineHit[], principal: Principal | null) {
    if (!this.ctx.tryUse('advertising')) return;
    const privacy = await this.adPrivacyOf(principal);
    const slots = await this.optional('advertising', 'sponsored products', (a) =>
      a.sponsoredForResults({
        personalizationAllowed: privacy.personalizationAllowed,
        ...(privacy.customerId ? { customerId: privacy.customerId } : {}),
        page: this.pageTypeOf(p),
        ...(p.text.normalized ? { query: p.text.correctedTo ?? p.text.normalized } : {}),
        ...(p.category ? { categoryId: p.category.node.id } : {}),
        visitorId: principal?.sessionId ?? 'anonymous',
        sessionId: principal?.sessionId ?? 'anonymous',
        device: 'web',
        organicOfferIds: hits.map((h) => h.offer?.offerId).filter((x): x is string => Boolean(x)),
      }),
    );
    if (!slots?.length) return;
    const promoted = slots.filter((s) => s.impression.promotedOffer);
    const cards = await this.cardsFor(promoted.map((s) => s.impression.promotedOffer!.productId));
    const byId = new Map(cards.map((c) => [c.productId, c]));
    const topRow = p.mode.kind === 'search';
    const sponsored: SearchHit[] = [];
    for (const s of promoted) {
      const po = s.impression.promotedOffer!;
      const base = byId.get(po.productId);
      if (!base) continue;
      const product: ProductCard = {
        ...base,
        offerId: po.offerId,
        price: po.price,
        priceIsFrom: false,
        sellerName: po.sellerName,
        wasPrice: po.wasPrice ?? null,
        discountPct: po.wasPrice && po.wasPrice.amount > po.price.amount ? Math.round(((po.wasPrice.amount - po.price.amount) / po.wasPrice.amount) * 100) : null,
      };
      sponsored.push({
        position: s.position,
        kind: 'sponsored',
        slot: topRow ? 'top_row' : 'inline',
        product,
        sponsored: { label: 'Sponsored', advertiserName: s.impression.advertiserName, impressionToken: s.impression.impressionToken, whyUrl: '/help/why-these-ads' },
      });
    }
    if (topRow) items.unshift(...sponsored.sort((a, b) => a.position - b.position));
    else for (const h of sponsored.sort((a, b) => a.position - b.position)) items.splice(Math.min(Math.max(h.position - 1, 0), items.length), 0, h);
  }

  /** GET /facets: the context of the same query; logs the search and saves it to recent searches */
  async restContext(params: RestSearchParams, principal: Principal | null): Promise<SearchContext> {
    const query = this.parseRest(params);
    const p = await this.prepare(query, this.modeOfRest(params), { strictSort: false });
    const searchId = newId();
    const context = await this.context(p, searchId);
    await this.record(p, context, await this.sessionOf(principal));
    return context;
  }

  /* ---------------------------------------------------------------- in-process result sets */

  protected sponsoredSlotsOf(p: Prepared, offset: number, shown: number): SponsoredSlot[] {
    if (offset > 0) return [];
    if (p.mode.kind === 'search') return [{ placement: 'search_top_row', kind: 'top_row', positions: [], maxItems: 4 }];
    if (p.mode.kind === 'category')
      return [
        { placement: 'category_banner', kind: 'banner', positions: [], maxItems: 1 },
        { placement: 'category_inline', kind: 'inline', positions: [5, 13, 21].filter((n) => n <= Math.max(shown, 1) + 1), maxItems: 3 },
      ];
    return [];
  }

  async resultSet(query: SearchQuery & { exact?: boolean; postalCode?: string; searchId?: string }, mode: Mode, page: PageRequest, session?: SearchSession): Promise<SearchResultSet> {
    const p = await this.prepare(query, mode, { strictSort: true });
    const window = windowOf(page);
    const { cards, total } = await this.results(p, window);
    const searchId = query.searchId || newId();
    const context = await this.context(p, searchId);
    if (window.offset === 0 && !query.searchId && mode.kind === 'search') await this.record(p, context, session);
    return {
      context,
      items: cards.map((c) => ({ productId: c.card.productId, match: c.match })),
      sponsoredSlots: this.sponsoredSlotsOf(p, window.offset, cards.length),
      page: pageInfoOf(page, window.offset, window.limit, total),
    };
  }

  /* ---------------------------------------------------------------- suggestions */

  async suggestions(prefix: string, session: SearchSession | undefined, limit = 5): Promise<Suggestions> {
    const per = Math.min(Math.max(limit, 1), 10);
    const norm = normalizeQuery(prefix);
    const owner = await this.recentOwner(session);
    const recentRows = owner ? await this.repo.recentSearches(owner, await this.setting('recentSearchesMax')) : [];
    const recent = recentRows.filter((r) => !norm || normalizeQuery(r.query).startsWith(norm)).slice(0, per).map(this.recentOut);
    const empty: Suggestions = { query: prefix, queries: [], categories: [], brands: [], stores: [], products: [], recent };
    if (!norm) return empty;
    const threshold = await this.setting('typoSimilarityThreshold');
    const tree = await this.categoryTree();
    const prefixOf = (text: string) => (text.toLowerCase().startsWith(norm) ? norm : '');

    // queries: popular queries, with a spelling fix first when the words look misspelled
    const queryTerms = await this.engine.suggestTerms('query', norm, threshold, per);
    const queries = queryTerms.map((t) => ({ text: t.term, matchedPrefix: prefixOf(t.term), categoryScope: null }));
    const words = tokens(norm);
    // the last word may still be being typed: it is fixed only when no known word starts with it
    const fixed = await Promise.all(
      words.map(async (w, i) => (i === words.length - 1 && (w.length < 4 || (await this.engine.knownPrefix(w))) ? w : ((await this.engine.correctWord(w, threshold)) ?? w))),
    );
    const corrected = fixed.join(' ');
    if (corrected !== norm && !queries.some((q) => q.text === corrected)) queries.unshift({ text: corrected, matchedPrefix: '', categoryScope: null });

    // categories: names that match, then the query scoped to the categories where it finds most
    const categories: Suggestions['categories'] = [];
    for (const t of await this.engine.suggestTerms('category', norm, threshold, per)) {
      const node = t.target_id ? tree.byId.get(t.target_id) : undefined;
      if (node && node.visible) categories.push({ text: node.name, matchedPrefix: prefixOf(node.name), categoryScope: tree.crumb(node) });
    }
    const scopeText = queries[0]?.text ?? norm;
    for (const c of await this.engine.categoriesForPrefix(corrected, per)) {
      const node = tree.byId.get(c.categoryId);
      if (node && node.visible && !categories.some((x) => x.categoryScope?.id === node.id && x.text === scopeText)) categories.push({ text: scopeText, matchedPrefix: prefixOf(scopeText), categoryScope: tree.crumb(node) });
    }

    // brands (active ones only: brand terms exist for active brands)
    const brandTerms = await this.engine.suggestTerms('brand', norm, threshold, per);
    const brandCounts = await this.engine.productCountsByBrand(brandTerms.map((t) => t.target_id!).filter(Boolean));
    const brands: Suggestions['brands'] = [];
    for (const t of brandTerms) {
      if (!t.target_id) continue;
      const [docId] = await this.repo.documentIds({ brandIds: [t.target_id] });
      const product = docId ? await this.optional('catalog', 'brand', (c) => c.getProduct(docId)) : undefined;
      const brand = product?.brand;
      if (!brand) continue;
      brands.push({ brandId: brand.id, name: brand.name, slug: brand.slug, logo: brand.logo ?? null, productCount: brandCounts.get(brand.id) ?? 0 });
    }

    // stores: lead to the store page, never into product results
    const storeTerms = await this.engine.suggestTerms('store', norm, threshold, per);
    const storeIds = storeTerms.map((t) => t.target_id!).filter(Boolean);
    const cards = storeIds.length ? ((await this.optional('sellers', 'store cards', (s) => s.getStorefrontCard(storeIds))) ?? []) : [];
    const storeCounts = await this.engine.productCountsBySeller(storeIds);
    const storeCats = await this.engine.sellerCategoryCounts(storeIds);
    const stores: Suggestions['stores'] = storeIds
      .map((id) => cards.find((c) => c.id === id))
      .filter((c): c is NonNullable<typeof c> => Boolean(c))
      .map((c) => {
        const n = storeCounts.get(c.id) ?? 0;
        const top = storeCats.find((x) => x.sellerId === c.id);
        const topName = top ? tree.byId.get(top.categoryId)?.name : undefined;
        return { sellerId: c.id, name: c.storeName, slug: c.slug, logo: c.logo ?? null, verified: c.verified, productCount: n, summary: `Seller store · ${n} ${n === 1 ? 'product' : 'products'}${topName ? ` in ${topName.toLowerCase()}` : ''}` };
      });

    // products
    const docs: DocRow[] = await this.engine.suggestProducts(corrected, threshold, per);
    const products = docs.map((d) => ({
      productId: d.product_id,
      slug: d.slug,
      title: d.title,
      image: (d.image as unknown as common.MediaRef | null) ?? null,
      fromPrice: d.min_price !== null ? money(d.min_price, d.currency) : d.featured_price !== null ? money(d.featured_price, d.currency) : null,
      sellerName: d.featured_seller_name,
    }));

    return { query: prefix, queries: queries.slice(0, per), categories: categories.slice(0, per), brands, stores, products, recent };
  }
}
