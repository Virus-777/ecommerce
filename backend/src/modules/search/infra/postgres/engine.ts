/**
 * PostgreSQL search engine: full-text search (tsvector/tsquery, english configuration) for matching and
 * relevance, pg_trgm similarity for misspellings and suggestions, offer rows for seller, condition, price
 * and delivery filters. Implements the SearchEngine port; an external engine can replace it later.
 */
import { sql, type Kysely, type RawBuilder } from 'kysely';
import type { SearchDb } from '../../../../spec/search.js';
import type { RankingFactorKey } from '../../domain/ranking.js';
import type { SortKey } from '../../domain/types.js';
import type { DocRow, EngineFilters, EngineHit, EngineQuery, FacetCounts, FacetOmit, SearchEngine, TermKind, TermRow } from '../../ports.js';

type Db = Kysely<SearchDb>;
type Frag = RawBuilder<unknown>;

const and = (parts: Frag[]): Frag => (parts.length ? sql`(${sql.join(parts, sql` and `)})` : sql`true`);
const or = (parts: Frag[]): Frag => (parts.length ? sql`(${sql.join(parts, sql` or `)})` : sql`false`);

/** One tsquery: every group must match, any alternative of a group (phrases match as phrases) */
function tsquery(groups: string[][]): Frag {
  const alt = (a: string) => (a.includes(' ') ? sql`phraseto_tsquery('english', ${a})` : sql`plainto_tsquery('english', ${a})`);
  return sql`(${sql.join(
    groups.map((g) => sql`(${sql.join(g.map(alt), sql` || `)})`),
    sql` && `,
  )})`;
}

/** Prefix tsquery for typing: 'wireless head' → wireless:* & head:* */
function prefixQuery(prefix: string): Frag | null {
  const parts = prefix
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .slice(0, 8);
  if (!parts.length) return null;
  return sql`to_tsquery('english', ${parts.map((p) => `${p}:*`).join(' & ')})`;
}

const like = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Conditions on an offer row (alias o) */
function offerConds(f: EngineFilters, omit?: FacetOmit): Frag[] {
  const c: Frag[] = [];
  if (omit !== 'seller' && (f.sellerIds?.length || f.official)) {
    const parts: Frag[] = [];
    if (f.sellerIds?.length) parts.push(sql`o.seller_id = any(${f.sellerIds}::uuid[])`);
    if (f.official) parts.push(sql`o.official`);
    c.push(or(parts));
  }
  if (omit !== 'condition' && f.conditions?.length) c.push(sql`o.condition = any(${f.conditions}::text[])`);
  if (omit !== 'price') {
    if (f.priceMin !== undefined) c.push(sql`o.price >= ${f.priceMin}`);
    if (f.priceMax !== undefined) c.push(sql`o.price <= ${f.priceMax}`);
  }
  if (omit !== 'availability' && f.inStockOnly) c.push(sql`o.in_stock`);
  if (omit !== 'delivery') {
    if (f.freeDelivery) c.push(sql`o.free_delivery`);
    if (f.shipsToday) c.push(sql`o.dispatch_days = 0`);
    if (f.maxDispatchDays !== undefined) c.push(sql`o.dispatch_days <= ${f.maxDispatchDays}`);
  }
  return c;
}

/** FROM clause: documents with the offer the card shows (featured first, then in stock, then cheapest) */
function fromClause(q: EngineQuery, omit?: FacetOmit): Frag {
  const conds = offerConds(q.filters, omit);
  return sql`
    from search.search_documents d
    left join lateral (
      select o.offer_id, o.variant_id, o.seller_id, o.official, o.condition, o.price, o.in_stock, o.free_delivery, o.dispatch_days,
             count(*) over () as matching
        from search.search_offers o
       where o.product_id = d.product_id ${conds.length ? sql`and ${and(conds)}` : sql``}
       order by coalesce(o.offer_id = d.featured_offer_id, false) desc, o.in_stock desc, o.price asc, o.offer_id
       limit 1
    ) eo on true`;
}

function textMatch(q: EngineQuery): Frag | null {
  if (!q.text) return null;
  const parts: Frag[] = [];
  if (q.text.groups.length) parts.push(sql`d.tsv @@ ${tsquery(q.text.groups)}`);
  if (q.text.gtin) parts.push(sql`d.gtins @> ${[q.text.gtin]}::text[]`);
  return or(parts);
}

/** WHERE clause on documents (alias d) and the card offer (alias eo) */
function whereClause(q: EngineQuery, omit?: FacetOmit): Frag {
  const f = q.filters;
  const c: Frag[] = [sql`eo.offer_id is not null`];
  const text = textMatch(q);
  if (text) c.push(text);
  if (q.productIds) c.push(q.productIds.length ? sql`d.product_id = any(${q.productIds}::uuid[])` : sql`false`);
  if (q.excludeProductIds?.length) c.push(sql`not (d.product_id = any(${q.excludeProductIds}::uuid[]))`);
  if (omit !== 'category' && f.categoryIds?.length) c.push(sql`d.category_path_ids && ${f.categoryIds}::uuid[]`);
  if (omit !== 'brand' && f.brandIds?.length) c.push(sql`d.brand_id = any(${f.brandIds}::uuid[])`);
  if (omit !== 'rating' && f.minRating !== undefined) c.push(sql`d.rating >= ${f.minRating}`);
  if (f.onSale) c.push(sql`d.on_sale`);
  if (f.listedSince) c.push(sql`d.first_listed_at >= ${f.listedSince}`);
  if (omit !== 'delivery' && f.shipsToday) c.push(sql`(d.same_day_cutoff is null or d.same_day_cutoff > ${q.marketTime}::time)`);
  for (const a of f.attributes ?? []) {
    if (omit === `attr:${a.key}`) continue;
    const values = a.values.map((v) => v.trim().toLowerCase());
    c.push(sql`exists (select 1 from jsonb_array_elements_text(coalesce(d.attributes -> ${a.key}, '[]'::jsonb)) v(value) where lower(v.value) = any(${values}::text[]))`);
  }
  return and(c);
}

/** Weighted ranking factors of the recommended sort, each 0..weight */
function factorColumns(q: EngineQuery, w: Record<RankingFactorKey, number>): Record<RankingFactorKey | 'gtin', Frag> {
  const text = q.text?.groups.length ? sql`ts_rank_cd(d.tsv, ${tsquery(q.text.groups)}, 32)` : sql`0`;
  return {
    text_relevance: sql`(${w.text_relevance}::float8 * coalesce(${text}, 0))`,
    in_stock: sql`(${w.in_stock}::float8 * (case when eo.in_stock then 1 else 0 end))`,
    featured_offer: sql`(${w.featured_offer}::float8 * (case when d.featured_offer_id is not null then 1 else 0 end))`,
    delivery_speed: sql`(${w.delivery_speed}::float8 * (1.0 / (1 + coalesce(eo.dispatch_days, 5))))`,
    rating: sql`(${w.rating}::float8 * (case when d.rating_count >= 3 then coalesce(d.rating, 0)::float8 / 5 else 0 end))`,
    conversion: sql`(${w.conversion}::float8 * least(1, ln(1 + greatest(d.popularity, 0)::float8) / ln(101)))`,
    gtin: q.text?.gtin ? sql`(case when d.gtins @> ${[q.text.gtin]}::text[] then 1 else 0 end)::float8` : sql`0::float8`,
  };
}

const ORDER: Record<SortKey, Frag> = {
  recommended: sql`score desc, d.product_id`,
  price_asc: sql`eo.price asc, score desc, d.product_id`,
  price_desc: sql`eo.price desc, score desc, d.product_id`,
  newest: sql`d.first_listed_at desc, d.product_id`,
  rating: sql`d.rating desc nulls last, d.rating_count desc, score desc, d.product_id`,
  best_selling: sql`d.sales_30d desc, score desc, d.product_id`,
};

interface HitRow extends DocRow {
  score: number;
  f_text_relevance: number;
  f_in_stock: number;
  f_featured_offer: number;
  f_delivery_speed: number;
  f_rating: number;
  f_conversion: number;
  f_gtin: number;
  eo_offer_id: string | null;
  eo_variant_id: string | null;
  eo_seller_id: string | null;
  eo_official: boolean | null;
  eo_condition: string | null;
  eo_price: number | null;
  eo_in_stock: boolean | null;
  eo_free_delivery: boolean | null;
  eo_dispatch_days: number | null;
  eo_matching: number | null;
}

function toHit(r: HitRow): EngineHit {
  const { score, f_text_relevance, f_in_stock, f_featured_offer, f_delivery_speed, f_rating, f_conversion, f_gtin, eo_offer_id, eo_variant_id, eo_seller_id, eo_official, eo_condition, eo_price, eo_in_stock, eo_free_delivery, eo_dispatch_days, eo_matching, ...doc } = r;
  return {
    doc: doc as DocRow,
    score: Number(score),
    factors: {
      text_relevance: Number(f_text_relevance),
      in_stock: Number(f_in_stock),
      featured_offer: Number(f_featured_offer),
      delivery_speed: Number(f_delivery_speed),
      rating: Number(f_rating),
      conversion: Number(f_conversion),
      gtin: Number(f_gtin),
    },
    offer: eo_offer_id
      ? {
          offerId: eo_offer_id,
          variantId: eo_variant_id!,
          sellerId: eo_seller_id,
          official: Boolean(eo_official),
          condition: eo_condition ?? 'new',
          price: Number(eo_price),
          inStock: Boolean(eo_in_stock),
          freeDelivery: Boolean(eo_free_delivery),
          dispatchDays: Number(eo_dispatch_days ?? 0),
          matching: Number(eo_matching ?? 1),
        }
      : null,
  };
}

export function createPostgresSearchEngine(db: Db): SearchEngine {
  const rows = async <T>(q: Frag) => (await (q as RawBuilder<T>).execute(db)).rows;

  return {
    name: 'postgres-fts',

    async search(q, sort, weights, window) {
      const fc = factorColumns(q, weights);
      const from = fromClause(q);
      const where = whereClause(q);
      const [countRow] = await rows<{ n: number }>(sql`select count(*)::int as n ${from} where ${where}`);
      const total = countRow?.n ?? 0;
      if (!total || window.limit <= 0) return { hits: [], total };
      const found = await rows<HitRow>(sql`
        select d.*,
               ${fc.text_relevance} as f_text_relevance, ${fc.in_stock} as f_in_stock, ${fc.featured_offer} as f_featured_offer,
               ${fc.delivery_speed} as f_delivery_speed, ${fc.rating} as f_rating, ${fc.conversion} as f_conversion, ${fc.gtin} as f_gtin,
               (${fc.gtin} + ${fc.text_relevance} + ${fc.in_stock} + ${fc.featured_offer} + ${fc.delivery_speed} + ${fc.rating} + ${fc.conversion}) as score,
               eo.offer_id as eo_offer_id, eo.variant_id as eo_variant_id, eo.seller_id as eo_seller_id, eo.official as eo_official,
               eo.condition as eo_condition, eo.price as eo_price, eo.in_stock as eo_in_stock, eo.free_delivery as eo_free_delivery,
               eo.dispatch_days as eo_dispatch_days, eo.matching::int as eo_matching
        ${from}
        where ${where}
        order by ${ORDER[sort]}
        offset ${window.offset} limit ${window.limit}`);
      return { hits: found.map(toHit), total };
    },

    async count(q) {
      const [r] = await rows<{ n: number }>(sql`select count(*)::int as n ${fromClause(q)} where ${whereClause(q)}`);
      return r?.n ?? 0;
    },

    async summary(q) {
      const [t] = await rows<{ n: number }>(sql`select count(*)::int as n ${fromClause(q)} where ${whereClause(q)}`);
      const oc = offerConds(q.filters);
      const [s] = await rows<{ sellers: number; official: boolean | null }>(sql`
        select count(distinct coalesce(o.seller_id::text, 'official'))::int as sellers, bool_or(o.official) as official
        ${fromClause(q)}
        join search.search_offers o on o.product_id = d.product_id ${oc.length ? sql`and ${and(oc)}` : sql``}
        where ${whereClause(q)}`);
      return { total: t?.n ?? 0, sellers: s?.sellers ?? 0, official: Boolean(s?.official) };
    },

    async facets(q, attributeKeys) {
      const f = q.filters;
      const base = (omit?: FacetOmit) => ({ from: fromClause(q, omit), where: whereClause(q, omit) });

      const cat = base('category');
      const categories = new Map(
        (await rows<{ id: string; n: number }>(sql`select c.id::text as id, count(*)::int as n ${cat.from} cross join lateral unnest(d.category_path_ids) as c(id) where ${cat.where} group by c.id`)).map((r) => [r.id, r.n]),
      );

      const br = base('brand');
      const brands = await rows<{ id: string; name: string | null; n: number }>(sql`
        select d.brand_id::text as id, max(d.brand_name) as name, count(*)::int as n
        ${br.from}
        where ${br.where} and d.brand_id is not null
          and d.brand_id in (select t.target_id from search.suggestion_terms t where t.kind = 'brand' and t.target_id is not null)
        group by d.brand_id
        order by n desc, name`);

      const offerFacet = async (omit: 'seller' | 'condition', column: Frag) => {
        const b = base(omit);
        const oc = offerConds(f, omit);
        return rows<{ v: string | null; n: number }>(sql`
          select ${column} as v, count(distinct d.product_id)::int as n
          ${b.from}
          join search.search_offers o on o.product_id = d.product_id ${oc.length ? sql`and ${and(oc)}` : sql``}
          where ${b.where}
          group by 1`);
      };
      const sellerRows = await offerFacet('seller', sql`o.seller_id::text`);
      const conditionRows = await offerFacet('condition', sql`o.condition`);
      const officialRows = await (async () => {
        const b = base('seller');
        const oc = offerConds(f, 'seller');
        return rows<{ n: number }>(sql`
          select count(distinct d.product_id)::int as n ${b.from}
          join search.search_offers o on o.product_id = d.product_id and o.official ${oc.length ? sql`and ${and(oc)}` : sql``}
          where ${b.where}`);
      })();

      const rt = base('rating');
      const [ratingRow] = await rows<Record<string, number>>(sql`
        select count(*) filter (where d.rating >= 1)::int as r1, count(*) filter (where d.rating >= 2)::int as r2,
               count(*) filter (where d.rating >= 3)::int as r3, count(*) filter (where d.rating >= 4)::int as r4,
               count(*) filter (where d.rating >= 5)::int as r5
        ${rt.from} where ${rt.where}`);

      const av = base('availability');
      const [availRow] = await rows<{ in_stock: number; total_n: number }>(sql`
        select count(*) filter (where eo.in_stock)::int as in_stock, count(*)::int as total_n ${av.from} where ${av.where}`);

      const dl = base('delivery');
      const dlOffer = offerConds(f, 'delivery');
      const [deliveryRow] = await rows<{ free: number; today: number }>(sql`
        select count(*) filter (where exists (select 1 from search.search_offers o where o.product_id = d.product_id and o.free_delivery ${dlOffer.length ? sql`and ${and(dlOffer)}` : sql``}))::int as free,
               count(*) filter (where (d.same_day_cutoff is null or d.same_day_cutoff > ${q.marketTime}::time)
                                  and exists (select 1 from search.search_offers o where o.product_id = d.product_id and o.dispatch_days = 0 ${dlOffer.length ? sql`and ${and(dlOffer)}` : sql``}))::int as today
        ${dl.from} where ${dl.where}`);

      const pr = base('price');
      const [priceRow] = await rows<{ min: number | null; max: number | null }>(sql`select min(eo.price)::bigint as min, max(eo.price)::bigint as max ${pr.from} where ${pr.where}`);

      const attributes = new Map<string, Map<string, number>>();
      const filtered = new Set((f.attributes ?? []).map((a) => a.key));
      const attrQuery = async (keys: string[], omit?: FacetOmit) => {
        if (!keys.length) return;
        const b = base(omit);
        const found = await rows<{ k: string; v: string; n: number }>(sql`
          select a.key as k, v.value as v, count(distinct d.product_id)::int as n
          ${b.from}
          cross join lateral jsonb_each(d.attributes) as a(key, value)
          cross join lateral jsonb_array_elements_text(case when jsonb_typeof(a.value) = 'array' then a.value else '[]'::jsonb end) as v(value)
          where ${b.where} and a.key = any(${keys}::text[])
          group by 1, 2`);
        for (const r of found) {
          const m = attributes.get(r.k) ?? new Map<string, number>();
          m.set(r.v, (m.get(r.v) ?? 0) + r.n);
          attributes.set(r.k, m);
        }
      };
      await attrQuery(attributeKeys.filter((k) => !filtered.has(k)));
      for (const k of attributeKeys.filter((k) => filtered.has(k))) await attrQuery([k], `attr:${k}`);

      const result: FacetCounts = {
        categories,
        brands: brands.map((b) => ({ id: b.id, name: b.name ?? '', count: b.n })),
        sellers: new Map(sellerRows.filter((r) => r.v).map((r) => [r.v!, r.n])),
        official: officialRows[0]?.n ?? 0,
        conditions: new Map(conditionRows.filter((r) => r.v).map((r) => [r.v!, r.n])),
        ratings: new Map([1, 2, 3, 4, 5].map((n) => [n, ratingRow?.[`r${n}`] ?? 0])),
        inStock: availRow?.in_stock ?? 0,
        includingOutOfStock: availRow?.total_n ?? 0,
        freeDelivery: deliveryRow?.free ?? 0,
        shipsToday: deliveryRow?.today ?? 0,
        price: { min: priceRow?.min == null ? null : Number(priceRow.min), max: priceRow?.max == null ? null : Number(priceRow.max) },
        attributes,
      };
      return result;
    },

    async correctWord(word, threshold) {
      if (word.length < 3 || /\d/.test(word)) return null;
      const [known] = await rows<{ ok: boolean }>(sql`
        select exists (select 1 from search.search_documents d where d.tsv @@ plainto_tsquery('english', ${word}))
            or exists (select 1 from search.suggestion_terms t where lower(t.term) = ${word}) as ok`);
      if (known?.ok) return null;
      const [best] = await rows<{ w: string; s: number }>(sql`
        select v.w, similarity(v.w, ${word}) as s
          from (
            select distinct regexp_split_to_table(d.title_norm, '\\s+') as w from search.search_documents d
            union
            select distinct regexp_split_to_table(lower(t.term), '\\s+') as w from search.suggestion_terms t
          ) v
         where length(v.w) >= 3 and v.w <> ${word} and similarity(v.w, ${word}) >= ${threshold}
         order by s desc, abs(length(v.w) - ${word.length}), v.w
         limit 1`);
      return best?.w ?? null;
    },

    async knownPrefix(prefix) {
      const p = like(prefix.toLowerCase());
      const [r] = await rows<{ ok: boolean }>(sql`
        select exists (select 1 from search.search_documents d where d.title_norm like ${`${p}%`} or d.title_norm like ${`% ${p}%`})
            or exists (select 1 from search.suggestion_terms t where lower(t.term) like ${`${p}%`} or lower(t.term) like ${`% ${p}%`}) as ok`);
      return Boolean(r?.ok);
    },

    async suggestTerms(kind: TermKind, prefix, threshold, limit) {
      const p = prefix.toLowerCase();
      return rows<TermRow>(sql`
        select t.* from search.suggestion_terms t
         where t.kind = ${kind}
           and (lower(t.term) like ${`${like(p)}%`} or lower(t.term) like ${`% ${like(p)}%`}
                or similarity(lower(t.term), ${p}) >= ${threshold} or word_similarity(${p}, lower(t.term)) >= ${threshold})
         order by (lower(t.term) like ${`${like(p)}%`}) desc, t.weight desc, similarity(lower(t.term), ${p}) desc, t.term
         limit ${limit}`);
    },

    async suggestProducts(prefix, threshold, limit) {
      const pq = prefixQuery(prefix);
      const p = prefix.toLowerCase();
      return rows<DocRow>(sql`
        select d.* from search.search_documents d
         where d.offer_count > 0
           and (${pq ? sql`d.tsv @@ ${pq}` : sql`false`} or word_similarity(${p}, d.title_norm) >= ${threshold})
         order by (d.title_norm like ${`%${like(p)}%`}) desc, d.in_stock desc, d.popularity desc, d.rating_count desc, d.title
         limit ${limit}`);
    },

    async categoriesForPrefix(prefix, limit) {
      const pq = prefixQuery(prefix);
      if (!pq) return [];
      const found = await rows<{ category_id: string; n: number }>(sql`
        select d.category_id::text as category_id, count(*)::int as n from search.search_documents d
         where d.offer_count > 0 and d.category_id is not null and d.tsv @@ ${pq}
         group by d.category_id order by n desc, d.category_id limit ${limit}`);
      return found.map((r) => ({ categoryId: r.category_id, count: r.n }));
    },

    async similar(productId, limit) {
      const found = await rows<{ product_id: string }>(sql`
        select d.product_id from search.search_documents d, search.search_documents b
         where b.product_id = ${productId} and d.product_id <> b.product_id
           and d.offer_count > 0 and d.in_stock
           and (d.category_path_ids && b.category_path_ids or d.brand_id = b.brand_id or similarity(d.title_norm, b.title_norm) >= 0.3)
         order by (d.category_id is not distinct from b.category_id) desc,
                  (d.brand_id is not distinct from b.brand_id) desc,
                  similarity(d.title_norm, b.title_norm) desc,
                  d.popularity desc, d.product_id
         limit ${limit}`);
      return found.map((r) => r.product_id);
    },

    async sellerCategoryCounts(sellerIds) {
      if (!sellerIds.length) return [];
      const found = await rows<{ seller_id: string; category_id: string; n: number }>(sql`
        select o.seller_id::text as seller_id, d.category_id::text as category_id, count(distinct d.product_id)::int as n
          from search.search_offers o join search.search_documents d on d.product_id = o.product_id
         where o.seller_id = any(${sellerIds}::uuid[]) and d.category_id is not null
         group by o.seller_id, d.category_id
         order by n desc, d.category_id`);
      return found.map((r) => ({ sellerId: r.seller_id, categoryId: r.category_id, count: r.n }));
    },

    async productCountsBySeller(sellerIds) {
      if (!sellerIds.length) return new Map();
      const found = await rows<{ id: string; n: number }>(sql`
        select o.seller_id::text as id, count(distinct o.product_id)::int as n from search.search_offers o
         where o.seller_id = any(${sellerIds}::uuid[]) group by o.seller_id`);
      return new Map(found.map((r) => [r.id, r.n]));
    },

    async productCountsByBrand(brandIds) {
      if (!brandIds.length) return new Map();
      const found = await rows<{ id: string; n: number }>(sql`
        select d.brand_id::text as id, count(*)::int as n from search.search_documents d
         where d.offer_count > 0 and d.brand_id = any(${brandIds}::uuid[]) group by d.brand_id`);
      return new Map(found.map((r) => [r.id, r.n]));
    },

    async popular(categoryIds, limit) {
      const found = await rows<{ product_id: string }>(sql`
        select d.product_id from search.search_documents d
         where d.offer_count > 0 and d.in_stock ${categoryIds?.length ? sql`and d.category_path_ids && ${categoryIds}::uuid[]` : sql``}
         order by d.popularity desc, d.rating_count desc, d.rating desc nulls last, d.first_listed_at desc, d.product_id
         limit ${limit}`);
      return found.map((r) => r.product_id);
    },

    async lookupProducts(q, gtin, limit) {
      const norm = q.toLowerCase().trim();
      return rows<DocRow>(sql`
        select d.* from search.search_documents d
         where ${gtin ? sql`d.gtins @> ${[gtin]}::text[] or` : sql``}
               d.title_norm like ${`%${like(norm)}%`} or d.tsv @@ plainto_tsquery('english', ${norm})
         order by ${gtin ? sql`(d.gtins @> ${[gtin]}::text[]) desc,` : sql``} (d.title_norm like ${`${like(norm)}%`}) desc, d.popularity desc, d.title
         limit ${limit}`);
    },

    async bestSellingAvailable(minOrders) {
      const [r] = await rows<{ n: number }>(sql`select coalesce(sum(sales_30d), 0)::int as n from search.search_documents`);
      return (r?.n ?? 0) >= minOrders;
    },
  };
}
