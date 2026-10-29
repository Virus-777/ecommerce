/**
 * The MySQL half of catalog's queries port (queries.ts).
 *
 * Three of the nine are an ordinary `Table` read with one extra condition (`ReadOptions.and`, §10.5), which is
 * what keeps the paging, the keyset cursor and the row conversion written once; `liveBrandCountsIn` is
 * `countBy` with the same kind of condition, which is the shape §13.1 gives a `$lookup` used as a filter
 * (`EXISTS` on `catalog_listing_stats`, answered by its primary key). Only the two reads that group or project
 * across a join are Kysely, because `Table` reads whole rows of one table.
 */
import type { ModuleStore } from '../../kernel/mysql/module-store.js';
import { raw, whereSql, type Sql } from '../../kernel/mysql/where.js';
import type { WhereWithOr } from '../../kernel/store/index.js';
import type { CatalogTables } from '../../spec/catalog.js';
import type { BrandRow, ProductRow } from './ports.js';
import { modelPattern, type CatalogQueries, type LiveCountRow } from './queries.js';

/** Products customers can buy: approved, active, not merged */
const LIVE: WhereWithOr<ProductRow> = { review_state: 'approved', publication: 'active', merged_into_id: null };

/**
 * The Admin catalog's missing-content tab: a content score under 100, or images still to re-crop.
 *
 * `COALESCE` and not `JSON_LENGTH(...) > 0` alone: `recrop_media_ids` is a nullable JSON column, and
 * `JSON_LENGTH(NULL)` is NULL, so the negated form would read `NOT (FALSE OR NULL)` — NULL, which excludes
 * the row. A product with a full content score and no flagged images belongs in "nothing missing", which is
 * what MongoDB's `$nor` over `recrop_media_ids.0: { $exists: true }` answers.
 */

/** At least one live offer: the `$lookup` + `$match` of the MongoDB side, as the EXISTS of §13.1 */
const HAS_LIVE_OFFER: Sql = raw('EXISTS (SELECT 1 FROM `catalog_listing_stats` l WHERE l.`product_id` = `catalog_products`.`id` AND l.`live_offer_count` > 0)');

/** `parts` as one ORed condition; an empty list is left to the caller (it means "no candidates at all") */
const anyOf = (parts: readonly Sql[]): Sql => ({ sql: `(${parts.map((p) => `(${p.sql})`).join(' OR ')})`, params: parts.flatMap((p) => p.params) });

/**
 * The model-number pattern as SQL. `LOWER()` is what MongoDB's `$options: 'i'` does for a pattern made only of
 * lower-case letters, digits and `[^a-z0-9]`, and it has to be said here because the column's collation is
 * binary (§5.2) and `REGEXP` follows the collation.
 */
const modelRegexp = (pattern: string): Sql => raw('LOWER(`model_number`) REGEXP ?', [pattern]);

export function mysqlCatalogQueries(store: ModuleStore<CatalogTables>): CatalogQueries {
  const products = store.table<ProductRow>('products');
  const brands = store.table<BrandRow>('brands');

  return {
    async liveBrandCountsIn(categoryIds): Promise<Map<string, number>> {
      if (!categoryIds.length) return new Map<string, number>();
      const rows = await products.countBy(['brand_id'], { ...LIVE, category_id: [...new Set(categoryIds)], brand_id: { op: 'is not', value: null } }, { and: HAS_LIVE_OFFER });
      return new Map(rows.filter((r) => r.brand_id !== null).map((r) => [r.brand_id!, r.n]));
    },

    async liveCountsSource(): Promise<LiveCountRow[]> {
      const rows = await store.db
        .selectFrom('catalog_products as p')
        .leftJoin('catalog_listing_stats as l', 'l.product_id', 'p.id')
        .select(['p.id', 'p.brand_id', 'p.category_id', 'p.review_state', 'p.publication', 'l.live_offer_count', 'l.offer_count'])
        .where('p.merged_into_id', 'is', null)
        .execute();
      return rows.map((r) => ({
        id: r.id,
        brand_id: r.brand_id ?? null,
        category_id: r.category_id ?? null,
        live: r.review_state === 'approved' && r.publication === 'active',
        live_offers: Number(r.live_offer_count ?? 0),
        offers: Number(r.offer_count ?? 0),
      }));
    },

    async pausedSubmissionCounts(sellerIds): Promise<Map<string, number>> {
      const out = new Map<string, number>();
      if (!sellerIds.length) return out;
      const rows = await store.db
        .selectFrom('catalog_submissions as s')
        .innerJoin('catalog_products as p', 'p.id', 's.product_id')
        .select(({ fn }) => ['p.owner_seller_id as seller_id', fn.countAll().as('n')])
        .where('p.owner_seller_id', 'in', [...new Set(sellerIds)])
        .where('s.state', '=', 'open')
        .where('s.paused_at', 'is not', null)
        .groupBy('p.owner_seller_id')
        .execute();
      for (const r of rows) if (r.seller_id !== null) out.set(r.seller_id, Number(r.n));
      return out;
    },

    productsByModelPrefixes(prefixes, limit): Promise<ProductRow[]> {
      if (!prefixes.length) return Promise.resolve([]);
      return products.find(LIVE, { and: anyOf(prefixes.map((pre) => modelRegexp(modelPattern(pre, false)))), limit });
    },

    duplicateCandidates({ productId, modelNormalised, gtinOwnerIds, titleWords }): Promise<ProductRow[]> {
      const any: Sql[] = [];
      if (modelNormalised) any.push(modelRegexp(modelPattern(modelNormalised, true)));
      // the ids and the title words are ordinary conditions, so they are built by the one translator and
      // only ORed by hand: an `or` of the filter cannot hold the regular expression beside them
      if (gtinOwnerIds.length) any.push(whereSql<ProductRow>({ id: [...new Set(gtinOwnerIds)] }));
      if (titleWords.length) any.push(whereSql<ProductRow>({ and: titleWords.map((w) => ({ title: { op: 'contains', value: w } })) }));
      if (!any.length) return Promise.resolve([]);
      return products.find({ id: { op: '<>', value: productId }, merged_into_id: null, review_state: ['approved', 'submitted', 'changes_requested'] }, { and: anyOf(any), limit: 20 });
    },

    /**
     * The same name, any case, ignoring leading and trailing spaces (spaces only, not tabs or new lines):
     * MySQL's `TRIM` removes spaces and nothing else, and the `as_ci` collation on the bound value is what
     * makes the comparison ignore case (§5.2) — the column's own collation is binary.
     */
    async brandByName(name: string): Promise<BrandRow | undefined> {
      const rows = await brands.find({}, { and: raw('TRIM(`name`) = ? COLLATE utf8mb4_0900_as_ci', [name.replace(/^ +| +$/g, '')]), sort: { created_at: 1 }, limit: 1 });
      return rows[0];
    },
  };
}
