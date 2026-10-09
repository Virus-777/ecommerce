import { sql, type Kysely } from 'kysely';
import { paginate, type PageRequest } from '../../../../kernel/lib/pagination.js';
import type * as common from '../../../../spec/common.js';
import type { CatalogDb } from '../../../../spec/catalog.js';
import type {
  AttributeRow,
  AuthorizedSellerRow,
  BrandFilter,
  BrandRow,
  BrandStatsRow,
  CatalogRepository,
  CategoryRow,
  CategoryStatsRow,
  CheckRow,
  CorrectionRow,
  ImageStandardRow,
  ListingStatsRow,
  MatchHit,
  OfferIndexRow,
  ProductFilter,
  ProductRow,
  ProductStatsCounts,
  QueueFilter,
  ReviewDraftRow,
  ReviewLogRow,
  SubmissionRow,
  VariantRow,
} from '../../ports.js';

type Db = Kysely<CatalogDb>;

/** jsonb columns are written as JSON text (arrays would otherwise be sent as PostgreSQL arrays) */
const JSON_COLUMNS: Record<string, readonly string[]> = {
  attributes: ['options'],
  image_standards: ['rules'],
  products: ['key_features', 'specs', 'included_items', 'media_ids', 'requested_brand'],
  variants: ['options', 'media_ids'],
  review_log: ['fields'],
  correction_suggestions: ['evidence_media_ids'],
  submissions: ['submitted_by', 'last_saved_by'],
  submission_checks: ['details', 'evidence', 'dismissed_by'],
  review_drafts: ['fields'],
  brand_authorized_sellers: ['added_by'],
  offer_index: ['price'],
  listing_stats: ['best_price'],
};

function enc(table: keyof CatalogDb, row: object): any {
  const cols = JSON_COLUMNS[table] ?? [];
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v === undefined) continue;
    out[k] = cols.includes(k) && v !== null ? JSON.stringify(v) : v;
  }
  return out;
}

/** ILIKE pattern with the user's text taken literally */
const contains = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

const DUPLICATE_SUSPECTED = sql<boolean>`exists (
  select 1 from catalog.submission_checks c
  where c.submission_id = (select s.id from catalog.submissions s where s.product_id = p.id order by s.submitted_at desc, s.id desc limit 1)
    and c.kind = 'duplicate' and c.result in ('warn', 'fail')
    and (c.dismissed_at is null or c.dismissed_matched_product_id is not null))`;

/** Postgres adapter for CatalogRepository. `db` is scoped to the `catalog` schema. */
export function createPostgresCatalogRepository(db: Db): CatalogRepository {
  return new PgCatalogRepository(db);
}

class PgCatalogRepository implements CatalogRepository {
  constructor(private readonly db: Db) {}

  async transaction<T>(fn: (tx: CatalogRepository) => Promise<T>): Promise<T> {
    if (this.db.isTransaction) return fn(this);
    return this.db.transaction().execute((trx) => fn(new PgCatalogRepository(trx)));
  }

  /* ================================================================ categories */

  allCategories() {
    return this.db.selectFrom('categories').selectAll().orderBy('position').orderBy('name').execute();
  }
  getCategory(id: string) {
    return this.db.selectFrom('categories').selectAll().where('id', '=', id).executeTakeFirst();
  }
  async insertCategory(row: CategoryRow) {
    return this.db.insertInto('categories').values(row).returningAll().executeTakeFirstOrThrow();
  }
  async updateCategory(id: string, patch: Partial<CategoryRow>) {
    if (!Object.keys(patch).length) return (await this.getCategory(id))!;
    return this.db.updateTable('categories').set(patch).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
  }
  async categorySlugTaken(slug: string, exceptId?: string) {
    let q = this.db.selectFrom('categories').select('id').where('slug', '=', slug);
    if (exceptId) q = q.where('id', '!=', exceptId);
    return Boolean(await q.executeTakeFirst());
  }
  async attributesOf(categoryIds: string[]) {
    if (!categoryIds.length) return [];
    return this.db.selectFrom('attributes').selectAll().where('category_id', 'in', categoryIds).orderBy('position').orderBy('name').execute();
  }
  async replaceAttributes(categoryId: string, rows: AttributeRow[]) {
    await this.db.deleteFrom('attributes').where('category_id', '=', categoryId).execute();
    if (rows.length) await this.db.insertInto('attributes').values(rows.map((r) => enc('attributes', r))).execute();
  }
  async imageStandardsOf(categoryIds: string[]) {
    if (!categoryIds.length) return [];
    return this.db.selectFrom('image_standards').selectAll().where('category_id', 'in', categoryIds).execute();
  }
  async saveImageStandard(categoryId: string, row: ImageStandardRow | null) {
    await this.db.deleteFrom('image_standards').where('category_id', '=', categoryId).execute();
    if (row) await this.db.insertInto('image_standards').values(enc('image_standards', row)).execute();
  }
  categoryStats() {
    return this.db.selectFrom('category_stats').selectAll().execute();
  }
  async replaceCategoryStats(rows: CategoryStatsRow[]) {
    await this.db.deleteFrom('category_stats').execute();
    for (let i = 0; i < rows.length; i += 500) await this.db.insertInto('category_stats').values(rows.slice(i, i + 500)).execute();
  }

  /* ================================================================ brands */

  getBrand(id: string, opts: { forUpdate?: boolean } = {}) {
    let q = this.db.selectFrom('brands').selectAll().where('id', '=', id);
    if (opts.forUpdate) q = q.forUpdate();
    return q.executeTakeFirst();
  }
  async getBrands(ids: string[]) {
    if (!ids.length) return [];
    return this.db.selectFrom('brands').selectAll().where('id', 'in', [...new Set(ids)]).execute();
  }
  getBrandBySlug(slug: string) {
    return this.db.selectFrom('brands').selectAll().where('slug', '=', slug).executeTakeFirst();
  }
  findBrandByName(name: string) {
    return this.db
      .selectFrom('brands')
      .selectAll()
      .where(sql<boolean>`lower(trim(name)) = lower(trim(${name}))`)
      .orderBy('created_at')
      .executeTakeFirst();
  }
  findBrandByChangeRequest(changeRequestId: string) {
    return this.db.selectFrom('brands').selectAll().where('requested_change_request_id', '=', changeRequestId).executeTakeFirst();
  }
  async brandSlugTaken(slug: string, exceptId?: string) {
    let q = this.db.selectFrom('brands').select('id').where('slug', '=', slug);
    if (exceptId) q = q.where('id', '!=', exceptId);
    return Boolean(await q.executeTakeFirst());
  }
  private brandQuery(filter: BrandFilter) {
    let q = this.db.selectFrom('brands as b').selectAll('b');
    if (filter.q?.trim()) q = q.where('b.name', 'ilike', contains(filter.q.trim()));
    if (filter.statuses?.length) q = q.where('b.status', 'in', filter.statuses as BrandRow['status'][]);
    if (filter.sellingPolicy) q = q.where('b.selling_policy', '=', filter.sellingPolicy as BrandRow['selling_policy']);
    if (filter.requested === true) q = q.where('b.requested_by_seller_id', 'is not', null);
    if (filter.requested === false) q = q.where('b.requested_by_seller_id', 'is', null);
    if (filter.activeOrRequestedBy) {
      const seller = filter.activeOrRequestedBy;
      q = q.where((eb) => eb.or([eb('b.status', '=', 'active'), eb.and([eb('b.status', '=', 'under_review'), eb('b.requested_by_seller_id', '=', seller)])]));
    }
    return q;
  }
  listBrands(filter: BrandFilter, page: PageRequest) {
    return paginate(this.brandQuery(filter), page, { column: 'b.name', direction: 'asc', id: 'b.id' });
  }
  async listPopularBrands(filter: BrandFilter, categoryId: string | null, page: PageRequest): Promise<common.Page<BrandRow>> {
    const q = this.brandQuery(filter)
      .innerJoin('brand_stats as st', 'st.brand_id', 'b.id')
      .where((eb) => (categoryId ? eb('st.category_id', '=', categoryId) : eb('st.category_id', 'is', null)))
      .where('st.product_count', '>', 0)
      .select('st.product_count');
    const p = await paginate(q, page, { column: 'st.product_count', direction: 'desc', id: 'b.id' });
    return { ...p, items: p.items.map(({ product_count: _p, ...b }) => b as BrandRow) };
  }
  async insertBrand(row: BrandRow) {
    return this.db.insertInto('brands').values(row).returningAll().executeTakeFirstOrThrow();
  }
  async updateBrand(id: string, patch: Partial<BrandRow>) {
    if (!Object.keys(patch).length) return (await this.getBrand(id))!;
    return this.db.updateTable('brands').set(patch).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
  }
  async authorizedSellers(brandIds: string[]) {
    if (!brandIds.length) return [];
    return this.db.selectFrom('brand_authorized_sellers').selectAll().where('brand_id', 'in', brandIds).orderBy('added_at').execute();
  }
  async replaceStaffAuthorizedSellers(brandId: string, sellerIds: string[], addedBy: common.Actor, at: Date) {
    await this.db.deleteFrom('brand_authorized_sellers').where('brand_id', '=', brandId).where('source', '=', 'staff').execute();
    const unique = [...new Set(sellerIds)];
    if (!unique.length) return;
    const rows: AuthorizedSellerRow[] = unique.map((seller_id) => ({ brand_id: brandId, seller_id, source: 'staff', added_by: addedBy as never, added_at: at }));
    await this.db
      .insertInto('brand_authorized_sellers')
      .values(rows.map((r) => enc('brand_authorized_sellers', r)))
      .onConflict((oc) => oc.columns(['brand_id', 'seller_id']).doNothing())
      .execute();
  }
  async brandStats(brandIds: string[], categoryId: string | null) {
    if (!brandIds.length) return [];
    return this.db
      .selectFrom('brand_stats')
      .selectAll()
      .where('brand_id', 'in', brandIds)
      .where((eb) => (categoryId ? eb('category_id', '=', categoryId) : eb('category_id', 'is', null)))
      .execute();
  }
  async replaceBrandStats(rows: BrandStatsRow[]) {
    await this.db.deleteFrom('brand_stats').execute();
    for (let i = 0; i < rows.length; i += 500) await this.db.insertInto('brand_stats').values(rows.slice(i, i + 500)).execute();
  }
  async productCountsByBrand(brandIds: string[]) {
    if (!brandIds.length) return new Map<string, number>();
    const rows = await this.db
      .selectFrom('products')
      .select(['brand_id', sql<number>`count(*)::int`.as('n')])
      .where('brand_id', 'in', brandIds)
      .where('merged_into_id', 'is', null)
      .groupBy('brand_id')
      .execute();
    return new Map(rows.map((r) => [r.brand_id!, r.n]));
  }
  async liveProductCountsByBrandIn(categoryIds: string[]) {
    if (!categoryIds.length) return new Map<string, number>();
    const rows = await this.db
      .selectFrom('products as p')
      .innerJoin('listing_stats as l', 'l.product_id', 'p.id')
      .select(['p.brand_id', sql<number>`count(*)::int`.as('n')])
      .where('p.category_id', 'in', categoryIds)
      .where('p.brand_id', 'is not', null)
      .where('p.review_state', '=', 'approved')
      .where('p.publication', '=', 'active')
      .where('p.merged_into_id', 'is', null)
      .where('l.live_offer_count', '>', 0)
      .groupBy('p.brand_id')
      .execute();
    return new Map(rows.map((r) => [r.brand_id!, r.n]));
  }

  /* ================================================================ products */

  getProduct(id: string, opts: { forUpdate?: boolean } = {}) {
    let q = this.db.selectFrom('products').selectAll().where('id', '=', id);
    if (opts.forUpdate) q = q.forUpdate();
    return q.executeTakeFirst();
  }
  async getProducts(ids: string[]) {
    if (!ids.length) return [];
    return this.db.selectFrom('products').selectAll().where('id', 'in', [...new Set(ids)]).execute();
  }
  async insertProduct(row: ProductRow) {
    return this.db.insertInto('products').values(enc('products', row)).returningAll().executeTakeFirstOrThrow();
  }
  async updateProduct(id: string, patch: Partial<ProductRow>) {
    if (!Object.keys(patch).length) return (await this.getProduct(id))!;
    return this.db.updateTable('products').set(enc('products', patch)).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
  }
  private productQuery(f: ProductFilter) {
    let q = this.db.selectFrom('products as p').selectAll('p');
    if (!f.includeMerged) q = q.where('p.merged_into_id', 'is', null);
    if (f.q?.trim()) {
      const text = f.q.trim();
      q = q.where((eb) => eb.or([eb('p.title', 'ilike', contains(text)), eb('p.ref', '=', text.toUpperCase()), eb('p.model_number', 'ilike', contains(text)), eb('p.mpn', 'ilike', contains(text))]));
    }
    if (f.categoryIds) q = f.categoryIds.length ? q.where('p.category_id', 'in', f.categoryIds) : q.where(sql<boolean>`false`);
    if (f.brandId) q = q.where('p.brand_id', '=', f.brandId);
    if (f.ownerSellerId) q = q.where('p.owner_seller_id', '=', f.ownerSellerId);
    if (f.reviewStates?.length) q = q.where('p.review_state', 'in', f.reviewStates);
    if (f.publication) q = q.where('p.publication', '=', f.publication);
    if (f.missingContent === true) q = q.where('p.content_score', '<', 100);
    if (f.missingContent === false) q = q.where('p.content_score', '>=', 100);
    if (f.duplicateSuspected === true) q = q.where(DUPLICATE_SUSPECTED);
    if (f.duplicateSuspected === false) q = q.where(sql<boolean>`not ${DUPLICATE_SUSPECTED}`);
    return q;
  }
  listProducts(filter: ProductFilter, page: PageRequest) {
    return paginate(this.productQuery(filter), page, { column: 'p.updated_at', direction: 'desc', id: 'p.id' });
  }
  async productBatch(filter: ProductFilter, afterId: string | null, limit: number) {
    let q = this.productQuery(filter);
    if (afterId) q = q.where('p.id', '>', afterId);
    return q.orderBy('p.id').limit(limit).execute();
  }
  async productStats(): Promise<ProductStatsCounts> {
    const r = await this.db
      .selectFrom('products as p')
      .select([
        sql<number>`count(*)::int`.as('all'),
        sql<number>`count(*) filter (where p.publication = 'active' and p.review_state = 'approved')::int`.as('active'),
        sql<number>`count(*) filter (where p.publication = 'hidden')::int`.as('hidden'),
        sql<number>`count(*) filter (where p.publication = 'suspended')::int`.as('suspended'),
        sql<number>`count(*) filter (where p.content_score < 100)::int`.as('missingContent'),
        sql<number>`count(*) filter (where ${DUPLICATE_SUSPECTED})::int`.as('duplicatesSuspected'),
      ])
      .where('p.merged_into_id', 'is', null)
      .executeTakeFirstOrThrow();
    const queue = await this.db
      .selectFrom('submissions')
      .select(sql<number>`count(*)::int`.as('n'))
      .where('state', '=', 'open')
      .where('review_due_at', 'is not', null)
      .executeTakeFirstOrThrow();
    const offers = await this.db.selectFrom('offer_index').select(sql<number>`count(*)::int`.as('n')).where('status', '!=', 'removed').executeTakeFirstOrThrow();
    return { ...r, inReview: queue.n, offers: offers.n };
  }
  async productsInCategories(categoryIds: string[], reviewStates: string[]) {
    if (!categoryIds.length) return [];
    let q = this.db.selectFrom('products').selectAll().where('category_id', 'in', categoryIds).where('merged_into_id', 'is', null);
    if (reviewStates.length) q = q.where('review_state', 'in', reviewStates);
    return q.execute();
  }
  productsOfBrand(brandId: string, reviewStates: string[]) {
    let q = this.db.selectFrom('products').selectAll().where('brand_id', '=', brandId).where('merged_into_id', 'is', null);
    if (reviewStates.length) q = q.where('review_state', 'in', reviewStates);
    return q.execute();
  }
  async countBySellerAndState(sellerIds: string[]) {
    if (!sellerIds.length) return [];
    const rows = await this.db
      .selectFrom('products')
      .select(['owner_seller_id', 'review_state', sql<number>`count(*)::int`.as('n')])
      .where('owner_seller_id', 'in', sellerIds)
      .where('merged_into_id', 'is', null)
      .groupBy(['owner_seller_id', 'review_state'])
      .execute();
    return rows.map((r) => ({ seller_id: r.owner_seller_id!, review_state: r.review_state, n: r.n }));
  }
  async matchProducts(input: { q: string; gtin?: string; limit: number }): Promise<MatchHit[]> {
    const live = this.db.selectFrom('products as p').selectAll('p').where('p.review_state', '=', 'approved').where('p.publication', '=', 'active').where('p.merged_into_id', 'is', null);
    const hits = new Map<string, MatchHit>();
    const gtins = [input.gtin, /^\d{8,14}$/.test(input.q.trim()) ? input.q.trim() : undefined].filter((g): g is string => Boolean(g));
    if (gtins.length) {
      const rows = await live.innerJoin('variants as v', 'v.product_id', 'p.id').where('v.gtin', 'in', gtins).limit(input.limit).execute();
      for (const r of rows) if (!hits.has(r.id)) hits.set(r.id, { product: r, matchedOn: 'gtin' });
    }
    const text = input.q.trim();
    if (text) {
      const model = text.replace(/[^a-z0-9]/gi, '');
      const tokens = text.split(/\s+/).map((t) => t.replace(/[^a-z0-9]/gi, '')).filter((t) => t.length >= 3 && /\d/.test(t));
      const prefixes = [...new Set([model, ...tokens].filter((t) => t.length >= 3).map((t) => t.slice(0, Math.max(3, Math.min(t.length - 1, 4)))))];
      if (prefixes.length) {
        const rows = await live
          .where('p.model_number', 'is not', null)
          .where((eb) => eb.or(prefixes.map((pre) => eb(sql`regexp_replace(lower(p.model_number), '[^a-z0-9]', '', 'g')`, 'like', `${pre.toLowerCase()}%`))))
          .limit(input.limit * 2)
          .execute();
        for (const r of rows) if (!hits.has(r.id)) hits.set(r.id, { product: r, matchedOn: 'model' });
      }
      const words = text.split(/\s+/).filter((w) => w.length >= 2).slice(0, 6);
      if (words.length) {
        const rows = await live
          .where((eb) => eb.and(words.map((w) => eb('p.title', 'ilike', contains(w)))))
          .orderBy('p.listed_at', 'desc')
          .limit(input.limit * 2)
          .execute();
        for (const r of rows) if (!hits.has(r.id)) hits.set(r.id, { product: r, matchedOn: 'title' });
      }
    }
    return [...hits.values()];
  }
  async duplicateCandidates(input: { productId: string; modelNumber: string | null; gtins: string[]; titleWords: string[] }) {
    const conditions: ReturnType<typeof sql<boolean>>[] = [];
    if (input.modelNumber) conditions.push(sql<boolean>`regexp_replace(lower(p.model_number), '[^a-z0-9]', '', 'g') = ${input.modelNumber.toLowerCase().replace(/[^a-z0-9]/g, '')}`);
    if (input.gtins.length) conditions.push(sql<boolean>`exists (select 1 from catalog.variants v where v.product_id = p.id and v.gtin in (${sql.join(input.gtins)}))`);
    if (input.titleWords.length) conditions.push(sql<boolean>`(${sql.join(input.titleWords.map((w) => sql`p.title ilike ${contains(w)}`), sql` and `)})`);
    if (!conditions.length) return [];
    return this.db
      .selectFrom('products as p')
      .selectAll('p')
      .where('p.id', '!=', input.productId)
      .where('p.merged_into_id', 'is', null)
      .where('p.review_state', 'in', ['approved', 'submitted', 'changes_requested'])
      .where(sql<boolean>`(${sql.join(conditions, sql` or `)})`)
      .limit(20)
      .execute();
  }
  async liveCountsSource() {
    return this.db
      .selectFrom('products as p')
      .leftJoin('listing_stats as l', 'l.product_id', 'p.id')
      .select([
        'p.id',
        'p.brand_id',
        'p.category_id',
        sql<boolean>`(p.review_state = 'approved' and p.publication = 'active')`.as('live'),
        sql<number>`coalesce(l.live_offer_count, 0)`.as('live_offers'),
        sql<number>`coalesce(l.offer_count, 0)`.as('offers'),
      ])
      .where('p.merged_into_id', 'is', null)
      .execute();
  }

  /* ================================================================ variants */

  async variantsOf(productIds: string[]) {
    if (!productIds.length) return [];
    return this.db.selectFrom('variants').selectAll().where('product_id', 'in', [...new Set(productIds)]).orderBy('position').execute();
  }
  getVariant(id: string) {
    return this.db.selectFrom('variants').selectAll().where('id', '=', id).executeTakeFirst();
  }
  async insertVariant(row: VariantRow) {
    return this.db.insertInto('variants').values(enc('variants', row)).returningAll().executeTakeFirstOrThrow();
  }
  async updateVariant(id: string, patch: Partial<VariantRow>) {
    if (Object.keys(patch).length) await this.db.updateTable('variants').set(enc('variants', patch)).where('id', '=', id).execute();
  }
  async deleteVariants(ids: string[]) {
    if (ids.length) await this.db.deleteFrom('variants').where('id', 'in', ids).execute();
  }
  async gtinOwners(gtins: string[]) {
    if (!gtins.length) return [];
    const rows = await this.db.selectFrom('variants').select(['gtin', 'product_id', 'id']).where('gtin', 'in', gtins).execute();
    return rows.map((r) => ({ gtin: r.gtin!, product_id: r.product_id, variant_id: r.id }));
  }

  /* ================================================================ review log */

  async insertLog(row: ReviewLogRow) {
    await this.db.insertInto('review_log').values(enc('review_log', row)).execute();
  }
  async logsOf(productIds: string[]) {
    if (!productIds.length) return [];
    return this.db.selectFrom('review_log').selectAll().where('product_id', 'in', productIds).orderBy('at').orderBy('id').execute();
  }
  latestLog(productId: string, action: string) {
    return this.db.selectFrom('review_log').selectAll().where('product_id', '=', productId).where('action', '=', action).orderBy('at', 'desc').orderBy('id', 'desc').executeTakeFirst();
  }

  /* ================================================================ submissions, checks, drafts */

  async insertSubmission(row: SubmissionRow) {
    return this.db.insertInto('submissions').values(enc('submissions', row)).returningAll().executeTakeFirstOrThrow();
  }
  async updateSubmission(id: string, patch: Partial<SubmissionRow>) {
    return this.db.updateTable('submissions').set(enc('submissions', patch)).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
  }
  getSubmission(id: string) {
    return this.db.selectFrom('submissions').selectAll().where('id', '=', id).executeTakeFirst();
  }
  openSubmission(productId: string, opts: { forUpdate?: boolean } = {}) {
    let q = this.db.selectFrom('submissions').selectAll().where('product_id', '=', productId).where('state', '=', 'open').orderBy('submitted_at', 'desc');
    if (opts.forUpdate) q = q.forUpdate();
    return q.executeTakeFirst();
  }
  async latestSubmissions(productIds: string[]) {
    if (!productIds.length) return [];
    return this.db
      .selectFrom('submissions')
      .selectAll()
      .distinctOn('product_id')
      .where('product_id', 'in', [...new Set(productIds)])
      .orderBy('product_id')
      .orderBy('submitted_at', 'desc')
      .orderBy('id', 'desc')
      .execute();
  }
  async submissionCount(productId: string) {
    const r = await this.db.selectFrom('submissions').select(sql<number>`count(*)::int`.as('n')).where('product_id', '=', productId).executeTakeFirstOrThrow();
    return r.n;
  }
  reviewQueue(filter: QueueFilter, page: PageRequest) {
    let q = this.db
      .selectFrom('submissions as s')
      .innerJoin('products as p', 'p.id', 's.product_id')
      .selectAll('s')
      .where('s.state', '=', 'open')
      .where('s.review_due_at', 'is not', null)
      .where('p.merged_into_id', 'is', null);
    if (filter.kind) q = q.where('s.kind', '=', filter.kind as SubmissionRow['kind']);
    if (filter.categoryIds) q = filter.categoryIds.length ? q.where('p.category_id', 'in', filter.categoryIds) : q.where(sql<boolean>`false`);
    return paginate(q, page, { column: 's.review_due_at', direction: 'asc', id: 's.id' });
  }
  async openSubmissionsOfSeller(sellerId: string, opts: { categoryIds?: string[]; paused?: boolean } = {}) {
    let q = this.db
      .selectFrom('submissions as s')
      .innerJoin('products as p', 'p.id', 's.product_id')
      .selectAll('s')
      .where('p.owner_seller_id', '=', sellerId)
      .where('s.state', '=', 'open');
    if (opts.categoryIds?.length) q = q.where('p.category_id', 'in', opts.categoryIds);
    if (opts.paused === true) q = q.where('s.review_due_at', 'is', null);
    if (opts.paused === false) q = q.where('s.review_due_at', 'is not', null);
    return q.execute();
  }
  async pausedCounts(sellerIds: string[]) {
    if (!sellerIds.length) return new Map<string, number>();
    const rows = await this.db
      .selectFrom('submissions as s')
      .innerJoin('products as p', 'p.id', 's.product_id')
      .select(['p.owner_seller_id', sql<number>`count(*)::int`.as('n')])
      .where('p.owner_seller_id', 'in', sellerIds)
      .where('s.state', '=', 'open')
      .where('s.review_due_at', 'is', null)
      .groupBy('p.owner_seller_id')
      .execute();
    return new Map(rows.map((r) => [r.owner_seller_id!, r.n]));
  }
  async insertChecks(rows: CheckRow[]) {
    if (rows.length) await this.db.insertInto('submission_checks').values(rows.map((r) => enc('submission_checks', r))).execute();
  }
  async checksOf(submissionIds: string[]) {
    if (!submissionIds.length) return [];
    return this.db.selectFrom('submission_checks').selectAll().where('submission_id', 'in', submissionIds).orderBy('ran_at').orderBy('id').execute();
  }
  async updateCheck(id: string, patch: Partial<CheckRow>) {
    await this.db.updateTable('submission_checks').set(enc('submission_checks', patch)).where('id', '=', id).execute();
  }
  async saveDraft(row: ReviewDraftRow) {
    const values = enc('review_drafts', row);
    return this.db
      .insertInto('review_drafts')
      .values(values)
      .onConflict((oc) => oc.columns(['submission_id', 'staff_id']).doUpdateSet({ decision: values.decision, reason: values.reason, fields: values.fields, saved_at: values.saved_at }))
      .returningAll()
      .executeTakeFirstOrThrow();
  }
  async draftsOf(submissionIds: string[], staffId: string) {
    if (!submissionIds.length) return [];
    return this.db.selectFrom('review_drafts').selectAll().where('submission_id', 'in', submissionIds).where('staff_id', '=', staffId).execute();
  }
  async deleteDrafts(submissionId: string) {
    await this.db.deleteFrom('review_drafts').where('submission_id', '=', submissionId).execute();
  }

  /* ================================================================ corrections */

  async insertCorrection(row: CorrectionRow) {
    return this.db.insertInto('correction_suggestions').values(enc('correction_suggestions', row)).returningAll().executeTakeFirstOrThrow();
  }
  getCorrection(id: string, opts: { forUpdate?: boolean } = {}) {
    let q = this.db.selectFrom('correction_suggestions').selectAll().where('id', '=', id);
    if (opts.forUpdate) q = q.forUpdate();
    return q.executeTakeFirst();
  }
  async updateCorrection(id: string, patch: Partial<CorrectionRow>) {
    return this.db.updateTable('correction_suggestions').set(enc('correction_suggestions', patch)).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
  }
  listCorrections(filter: { state?: string }, page: PageRequest) {
    let q = this.db.selectFrom('correction_suggestions as c').selectAll('c');
    if (filter.state) q = q.where('c.state', '=', filter.state);
    return paginate(q, page, { column: 'c.created_at', direction: 'asc', id: 'c.id' });
  }

  /* ================================================================ offer index and listing stats */

  getOffer(offerId: string) {
    return this.db.selectFrom('offer_index').selectAll().where('offer_id', '=', offerId).executeTakeFirst();
  }
  async upsertOffer(row: OfferIndexRow) {
    const values = enc('offer_index', row);
    await this.db
      .insertInto('offer_index')
      .values(values)
      .onConflict((oc) =>
        oc.column('offer_id').doUpdateSet({
          product_id: values.product_id,
          variant_id: values.variant_id,
          owner_type: values.owner_type,
          seller_id: values.seller_id,
          seller_name: sql`coalesce(excluded.seller_name, offer_index.seller_name)`,
          condition: values.condition,
          updated_at: values.updated_at,
        }),
      )
      .execute();
  }
  async updateOffer(offerId: string, patch: Partial<OfferIndexRow>) {
    if (Object.keys(patch).length) await this.db.updateTable('offer_index').set(enc('offer_index', patch)).where('offer_id', '=', offerId).execute();
  }
  async offersOf(productIds: string[]) {
    if (!productIds.length) return [];
    return this.db.selectFrom('offer_index').selectAll().where('product_id', 'in', [...new Set(productIds)]).orderBy('updated_at').execute();
  }
  async offersOfSeller(sellerId: string, productIds: string[]) {
    if (!productIds.length) return [];
    return this.db.selectFrom('offer_index').selectAll().where('seller_id', '=', sellerId).where('product_id', 'in', productIds).execute();
  }
  async moveOffers(fromProductId: string, toProductId: string, variantMap: Map<string, string>) {
    const offers = await this.db.selectFrom('offer_index').select(['offer_id', 'variant_id']).where('product_id', '=', fromProductId).execute();
    for (const o of offers) {
      await this.db
        .updateTable('offer_index')
        .set({ product_id: toProductId, variant_id: variantMap.get(o.variant_id) ?? o.variant_id })
        .where('offer_id', '=', o.offer_id)
        .execute();
    }
    return offers.length;
  }
  async listingStats(productIds: string[]) {
    if (!productIds.length) return [];
    return this.db.selectFrom('listing_stats').selectAll().where('product_id', 'in', [...new Set(productIds)]).execute();
  }
  async saveListingStats(row: ListingStatsRow) {
    const values = enc('listing_stats', row);
    await this.db
      .insertInto('listing_stats')
      .values(values)
      .onConflict((oc) =>
        oc.column('product_id').doUpdateSet({
          offer_count: values.offer_count,
          live_offer_count: values.live_offer_count,
          in_stock: values.in_stock,
          best_price: values.best_price,
          offer_note: values.offer_note,
          refreshed_at: values.refreshed_at,
        }),
      )
      .execute();
  }
  async productIdsWithOffers() {
    const rows = await this.db.selectFrom('offer_index').select('product_id').distinct().execute();
    const stats = await this.db.selectFrom('listing_stats').select('product_id').execute();
    return [...new Set([...rows.map((r) => r.product_id), ...stats.map((r) => r.product_id)])];
  }
}
