import { decodeCursor, encodeCursor, type PageRequest } from '../../kernel/lib/pagination.js';
import { isDuplicateKey, type Store, type WhereWithOr } from '../../kernel/store/index.js';
import { normalizeModel } from './domain/rules.js';
import type * as common from '../../spec/common.js';
import type {
  AttributeRow,
  AuthorizedSellerRow,
  BrandFilter,
  BrandRow,
  BrandStatsRow,
  CategoryRow,
  CategoryStatsRow,
  CheckDismissalRow,
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
} from './ports.js';
import type { CatalogQueries } from './queries.js';

/** A variant write refused because another variant already has the GTIN (unique index variants.gtin) */
export class GtinTakenError extends Error {
  constructor(options?: { cause?: unknown }) {
    super('A GTIN is already used by another variant', options);
  }
}

/** The values with duplicates removed (an empty list matches no row on either store) */
const oneOf = <T>(values: readonly T[]): T[] => [...new Set(values)];

/**
 * The spec's full-text column `search` is not stored (search is the search module's); rows keep the field,
 * always null. MySQL's table has no such column and MongoDB's schema does not declare it, so it is stripped
 * from every write and put back on every read.
 */
const productOut = (r: ProductRow): ProductRow => ({ ...r, search: null });
const productOutOpt = (r: ProductRow | undefined) => (r ? productOut(r) : r);
const productIn = <T extends Partial<ProductRow>>(row: T): Omit<T, 'search'> => {
  const { search: _s, ...rest } = row;
  return rest;
};

/** fn, with a duplicate GTIN turned into GtinTakenError (the only unique key a variant write can break besides its id) */
async function refusingTakenGtin<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    // the store seam's test, so neither database's error code is named here (kernel/store/index.ts)
    if (isDuplicateKey(err)) throw new GtinTakenError({ cause: err });
    throw err;
  }
}

/** Keyset paging of an in-memory list sorted by (value desc, id desc), cursors as kernel/lib/pagination.ts writes them */
function pageDesc<T>(sorted: { value: number; id: string; item: T }[], req: PageRequest): common.Page<T> {
  const cursorOf = (r: { value: number; id: string }) => encodeCursor([r.value, r.id]);
  if (req.mode === 'page') {
    const total = sorted.length;
    const totalPages = Math.max(1, Math.ceil(total / req.limit));
    const slice = sorted.slice((req.page - 1) * req.limit, req.page * req.limit);
    const last = slice.at(-1);
    return { items: slice.map((s) => s.item), nextCursor: req.page < totalPages && last ? cursorOf(last) : null, page: req.page, totalPages, total };
  }
  let rows = sorted;
  if (req.cursor) {
    const [v, id] = decodeCursor(req.cursor) as [number, string];
    rows = rows.filter((r) => r.value < Number(v) || (r.value === Number(v) && r.id < String(id)));
  }
  const items = rows.slice(0, req.limit);
  return { items: items.map((s) => s.item), nextCursor: rows.length > req.limit ? cursorOf(items.at(-1)!) : null };
}

/** Products customers can buy: approved, active, not merged */
const LIVE: WhereWithOr<ProductRow> = { review_state: 'approved', publication: 'active', merged_into_id: null };

/**
 * The catalog module's tables, whichever database holds them (`ctx.store`, docs/10 §10.5). Joins run as two
 * reads; the reads that are not the same question in both databases — the joins to `listing_stats`, the
 * missing-content condition and the model-number pattern — are the module's queries port (queries.ts), which
 * module.ts picks one implementation of and which the transaction clone carries with it.
 */
export class CatalogRepository {
  readonly #t;

  constructor(
    private readonly store: Store,
    private readonly queries: CatalogQueries,
  ) {
    this.#t = {
      categories: store.table<CategoryRow>('categories'),
      attributes: store.table<AttributeRow>('attributes'),
      imageStandards: store.table<ImageStandardRow>('image_standards'),
      brands: store.table<BrandRow>('brands'),
      products: store.table<ProductRow>('products'),
      variants: store.table<VariantRow>('variants'),
      log: store.table<ReviewLogRow>('review_log'),
      corrections: store.table<CorrectionRow>('correction_suggestions'),
      submissions: store.table<SubmissionRow>('submissions'),
      checks: store.table<CheckRow>('submission_checks'),
      dismissals: store.table<CheckDismissalRow>('check_dismissals'),
      drafts: store.table<ReviewDraftRow>('review_drafts'),
      authorized: store.table<AuthorizedSellerRow>('brand_authorized_sellers'),
      offers: store.table<OfferIndexRow>('offer_index'),
      listing: store.table<ListingStatsRow>('listing_stats'),
      categoryStats: store.table<CategoryStatsRow>('category_stats'),
      brandStats: store.table<BrandStatsRow>('brand_stats'),
    };
  }

  transaction<T>(fn: (tx: CatalogRepository) => Promise<T>): Promise<T> {
    return this.store.transaction((tx) => fn(new CatalogRepository(tx, this.queries)));
  }

  /** Inbox (store.claim): true the first time this key is claimed; commits with the transaction it runs in */
  claim(key: string): Promise<boolean> {
    return this.store.claim(key);
  }

  /** Serialises transactions on a name (§11.2 rule 5), for a check-then-insert with no unique key behind it */
  lock(name: string): Promise<void> {
    return this.store.lock(name);
  }

  /* ------------------------------------------------ helpers (joins as two reads) */

  /**
   * Products whose latest submission has an open duplicate finding: a duplicate check that warned or failed and is not
   * dismissed, or was dismissed for one candidate only (dismissed_matched_product_id set).
   */
  async #duplicateSuspectedIds(): Promise<string[]> {
    const checks = await this.#t.checks.find({
      kind: 'duplicate',
      result: ['warn', 'fail'],
      // "dismissed for one candidate only" means the column has a value, which is `is not null`
      or: [{ dismissed_at: null }, { dismissed_matched_product_id: { op: 'is not', value: null } }],
    });
    if (!checks.length) return [];
    const subIds = new Set(checks.map((c) => c.submission_id));
    const subs = await this.#t.submissions.getMany([...subIds]);
    const latest = await this.latestSubmissions([...new Set(subs.map((s) => s.product_id))]);
    return latest.filter((s) => subIds.has(s.id)).map((s) => s.product_id);
  }

  /**
   * A product filter in the neutral vocabulary, the missing-content condition included. That one asks whether
   * a JSON array holds anything, which the vocabulary says since reviews became its second caller
   * (`{ op: 'is not empty' }`, §10.5h); it was a queries-port read in the first version of this conversion.
   */
  async #productFilter(f: ProductFilter): Promise<WhereWithOr<ProductRow>> {
    const conds: WhereWithOr<ProductRow>[] = [];
    if (!f.includeMerged) conds.push({ merged_into_id: null });
    if (f.q?.trim()) {
      const text = f.q.trim();
      const any: WhereWithOr<ProductRow>[] = [
        { title: { op: 'contains', value: text } },
        { ref: text.toUpperCase() },
        { model_number: { op: 'contains', value: text } },
        { mpn: { op: 'contains', value: text } },
      ];
      if (f.matchGtin) {
        const owners = await this.#t.variants.distinct<string>('product_id', { gtin: text.replace(/\s+/g, '') });
        if (owners.length) any.push({ id: oneOf(owners) });
      }
      conds.push({ or: any });
    }
    if (f.purchasableOnly) conds.push({ review_state: 'approved', publication: 'active' });
    if (f.updatedSince) conds.push({ updated_at: { op: '>=', value: f.updatedSince } });
    if (f.categoryIds) conds.push({ category_id: oneOf(f.categoryIds) });
    if (f.brandId) conds.push({ brand_id: f.brandId });
    if (f.ownerSellerId) conds.push({ owner_seller_id: f.ownerSellerId });
    if (f.reviewStates?.length) conds.push({ review_state: oneOf(f.reviewStates) as ProductRow['review_state'][] });
    if (f.publication) conds.push({ publication: f.publication as ProductRow['publication'] });
    if (f.duplicateSuspected !== undefined) {
      const ids = oneOf(await this.#duplicateSuspectedIds());
      // `not in` of an empty list leaves the column unfiltered on both stores, which is "none of none"
      conds.push({ id: f.duplicateSuspected ? ids : { op: 'not in', value: ids } });
    }
    // Missing content: a content score under 100, or images to re-crop after a product image ratio change.
    // "Nothing missing" is the complement of that pair, which `$nor` said in one word: De Morgan's law, and
    // sound because `content_score` is NOT NULL (so `>= 100` is exactly "not under 100") while the array
    // condition folds its own null in — `is empty` is true for a column nobody ever wrote.
    if (f.missingContent === true) conds.push({ or: [{ content_score: { op: '<', value: 100 } }, { recrop_media_ids: { op: 'is not empty' } }] });
    if (f.missingContent === false) conds.push({ content_score: { op: '>=', value: 100 } }, { recrop_media_ids: { op: 'is empty' } });
    return { and: conds };
  }

  #brandFilter(f: BrandFilter): WhereWithOr<BrandRow> {
    const conds: WhereWithOr<BrandRow>[] = [];
    if (f.q?.trim()) conds.push({ name: { op: 'contains', value: f.q } });
    if (f.statuses?.length) conds.push({ status: oneOf(f.statuses) as BrandRow['status'][] });
    if (f.sellingPolicy) conds.push({ selling_policy: f.sellingPolicy as BrandRow['selling_policy'] });
    if (f.requested === true) conds.push({ requested_by_seller_id: { op: 'is not', value: null } });
    if (f.requested === false) conds.push({ requested_by_seller_id: null });
    if (f.activeOrRequestedBy) conds.push({ or: [{ status: 'active' }, { status: 'under_review', requested_by_seller_id: f.activeOrRequestedBy }] });
    return { and: conds };
  }

  /* ================================================================ categories, attributes, image standards */

  allCategories(): Promise<CategoryRow[]> {
    return this.#t.categories.find({}, { sort: { position: 1, name: 1 } });
  }

  getCategory(id: string): Promise<CategoryRow | undefined> {
    return this.#t.categories.get(id);
  }

  insertCategory(row: CategoryRow): Promise<CategoryRow> {
    return this.#t.categories.insert(row);
  }

  async updateCategory(id: string, patch: Partial<CategoryRow>): Promise<CategoryRow> {
    if (!Object.keys(patch).length) return (await this.#t.categories.get(id))!;
    return (await this.#t.categories.update(id, patch))!;
  }

  /** `<>` and not `is not`: `id` is the primary key, so no row can tell the two readings apart */
  categorySlugTaken(slug: string, exceptId?: string): Promise<boolean> {
    return this.#t.categories.exists({ slug, ...(exceptId ? { id: { op: '<>' as const, value: exceptId } } : {}) });
  }

  async attributesOf(categoryIds: string[]): Promise<AttributeRow[]> {
    if (!categoryIds.length) return [];
    return this.#t.attributes.find({ category_id: oneOf(categoryIds) }, { sort: { position: 1, name: 1 } });
  }

  async replaceAttributes(categoryId: string, rows: AttributeRow[]): Promise<void> {
    await this.#t.attributes.deleteMany({ category_id: categoryId });
    await this.#t.attributes.insertMany(rows);
  }

  async imageStandardsOf(categoryIds: string[]): Promise<ImageStandardRow[]> {
    if (!categoryIds.length) return [];
    return this.#t.imageStandards.getMany(categoryIds);
  }

  async saveImageStandard(categoryId: string, row: ImageStandardRow | null): Promise<void> {
    await this.#t.imageStandards.deleteMany({ category_id: categoryId });
    if (row) await this.#t.imageStandards.insert(row);
  }

  categoryStats(): Promise<CategoryStatsRow[]> {
    return this.#t.categoryStats.find();
  }

  async replaceCategoryStats(rows: CategoryStatsRow[]): Promise<void> {
    await this.#t.categoryStats.deleteMany({});
    for (let i = 0; i < rows.length; i += 500) await this.#t.categoryStats.insertMany(rows.slice(i, i + 500));
  }

  /* ================================================================ brands */

  getBrand(id: string, opts: { forUpdate?: boolean } = {}): Promise<BrandRow | undefined> {
    return this.#t.brands.get(id, opts);
  }

  getBrands(ids: string[]): Promise<BrandRow[]> {
    return this.#t.brands.getMany(oneOf(ids));
  }

  getBrandBySlug(slug: string): Promise<BrandRow | undefined> {
    return this.#t.brands.findOne({ slug });
  }

  /** The same name, any case, ignoring leading and trailing spaces (spaces only, not tabs or new lines) */
  findBrandByName(name: string): Promise<BrandRow | undefined> {
    return this.queries.brandByName(name);
  }

  findBrandByChangeRequest(changeRequestId: string): Promise<BrandRow | undefined> {
    return this.#t.brands.findOne({ requested_change_request_id: changeRequestId });
  }

  /** `<>` and not `is not`: `id` is the primary key, so no row can tell the two readings apart */
  brandSlugTaken(slug: string, exceptId?: string): Promise<boolean> {
    return this.#t.brands.exists({ slug, ...(exceptId ? { id: { op: '<>' as const, value: exceptId } } : {}) });
  }

  listBrands(filter: BrandFilter, page: PageRequest): Promise<common.Page<BrandRow>> {
    return this.#t.brands.page(this.#brandFilter(filter), page, { column: 'name', direction: 'asc' });
  }

  /** Brands ordered by in-stock products from brand_stats (null = all categories), by product_count desc, id desc */
  async listPopularBrands(filter: BrandFilter, categoryId: string | null, page: PageRequest): Promise<common.Page<BrandRow>> {
    const stats = await this.#t.brandStats.find({ category_id: categoryId, product_count: { op: '>', value: 0 } });
    const counts = new Map(stats.map((s) => [s.brand_id, s.product_count]));
    const brands = counts.size ? await this.#t.brands.find({ and: [this.#brandFilter(filter), { id: [...counts.keys()] }] }) : [];
    const sorted = brands
      .map((b) => ({ value: counts.get(b.id)!, id: b.id, item: b }))
      .sort((a, b) => b.value - a.value || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    return pageDesc(sorted, page);
  }

  insertBrand(row: BrandRow): Promise<BrandRow> {
    return this.#t.brands.insert(row);
  }

  /**
   * Inserts the brand unless a unique key of `brands` is already taken, in which case the answer is
   * `undefined`: the insert itself decides, rather than a read before it (Appendix C, the brand race found on
   * 2026-10-28). `insertIfAbsent` with no key is insert-and-catch outside a transaction on both stores, and
   * the duplicate-key test it uses is the store seam's, so neither database's code is named here.
   *
   * **It only closes the race once `brands.requested_change_request_id` is a unique key**, which is a spec
   * change and so not this conversion's to make (docs/10 §10.5e). Until then the only unique key an insert can
   * find taken is `slug`, so a second delivery of the same approval whose slug happens to differ still writes
   * a second row — which is the bug, unchanged. The caller treats `undefined` as "already handled".
   */
  insertBrandIfAbsent(row: BrandRow): Promise<BrandRow | undefined> {
    return this.#t.brands.insertIfAbsent(row);
  }

  async updateBrand(id: string, patch: Partial<BrandRow>): Promise<BrandRow> {
    if (!Object.keys(patch).length) return (await this.#t.brands.get(id))!;
    return (await this.#t.brands.update(id, patch))!;
  }

  async authorizedSellers(brandIds: string[]): Promise<AuthorizedSellerRow[]> {
    if (!brandIds.length) return [];
    return this.#t.authorized.find({ brand_id: oneOf(brandIds) }, { sort: { added_at: 1 } });
  }

  /** Replaces the staff-added authorized sellers; claim-based entries stay */
  async replaceStaffAuthorizedSellers(brandId: string, sellerIds: string[], addedBy: common.Actor, at: Date): Promise<void> {
    await this.#t.authorized.deleteMany({ brand_id: brandId, source: 'staff' });
    const unique = oneOf(sellerIds);
    if (!unique.length) return;
    const rows: AuthorizedSellerRow[] = unique.map((seller_id) => ({ brand_id: brandId, seller_id, source: 'staff', added_by: addedBy as never, added_at: at }));
    // no key named: (brand_id, seller_id) is this table's primary key, and with no key both stores check every
    // unique key the spec gives it, which is the question meant (docs/10 §10.5a)
    await this.#t.authorized.insertManyIfAbsent(rows);
  }

  async brandStats(brandIds: string[], categoryId: string | null): Promise<BrandStatsRow[]> {
    if (!brandIds.length) return [];
    return this.#t.brandStats.find({ brand_id: oneOf(brandIds), category_id: categoryId });
  }

  async replaceBrandStats(rows: BrandStatsRow[]): Promise<void> {
    await this.#t.brandStats.deleteMany({});
    for (let i = 0; i < rows.length; i += 500) await this.#t.brandStats.insertMany(rows.slice(i, i + 500));
  }

  /** Products by brand (not merged), for brand admin counts */
  async productCountsByBrand(brandIds: string[]): Promise<Map<string, number>> {
    if (!brandIds.length) return new Map<string, number>();
    const rows = await this.#t.products.countBy(['brand_id'], { brand_id: oneOf(brandIds), merged_into_id: null });
    return new Map(rows.filter((r) => r.brand_id !== null).map((r) => [r.brand_id!, r.n]));
  }

  /** Live product counts by brand within the given categories (popular brands of a subcategory) */
  liveProductCountsByBrandIn(categoryIds: string[]): Promise<Map<string, number>> {
    return this.queries.liveBrandCountsIn(oneOf(categoryIds));
  }

  /* ================================================================ products */

  async getProduct(id: string, opts: { forUpdate?: boolean } = {}): Promise<ProductRow | undefined> {
    return productOutOpt(await this.#t.products.get(id, opts));
  }

  async getProducts(ids: string[]): Promise<ProductRow[]> {
    return (await this.#t.products.getMany(oneOf(ids))).map(productOut);
  }

  async insertProduct(row: ProductRow): Promise<ProductRow> {
    return productOut(await this.#t.products.insert(productIn(row)));
  }

  async updateProduct(id: string, patch: Partial<ProductRow>): Promise<ProductRow> {
    const values = productIn(patch);
    if (!Object.keys(values).length) return productOut((await this.#t.products.get(id))!);
    return productOut((await this.#t.products.update(id, values))!);
  }

  async listProducts(filter: ProductFilter, page: PageRequest): Promise<common.Page<ProductRow>> {
    const p = await this.#t.products.page(await this.#productFilter(filter), page, { column: 'updated_at', direction: 'desc' });
    return { ...p, items: p.items.map(productOut) };
  }

  /** Keyset walk over product ids (index rebuilds) */
  async productIdsAfter(filter: ProductFilter, afterId: string | null, limit: number): Promise<string[]> {
    return (await this.#productsAfterId(filter, afterId, limit)).map((r) => r.id);
  }

  /** Keyset batches by id for exports */
  async productBatch(filter: ProductFilter, afterId: string | null, limit: number): Promise<ProductRow[]> {
    return (await this.#productsAfterId(filter, afterId, limit)).map(productOut);
  }

  /** One page of a keyset walk by id, which both callers above read in batches */
  async #productsAfterId(filter: ProductFilter, afterId: string | null, limit: number): Promise<ProductRow[]> {
    const where = await this.#productFilter(filter);
    return this.#t.products.find(afterId ? { and: [where, { id: { op: '>', value: afterId } }] } : where, { sort: { id: 1 }, limit });
  }

  async productStats(): Promise<ProductStatsCounts> {
    const notMerged: WhereWithOr<ProductRow> = { merged_into_id: null };
    const products = this.#t.products;
    // independent counts, read at once (never called inside a transaction)
    const [all, active, hidden, suspended, missingContent, duplicatesSuspected, inReview, offers] = await Promise.all([
      products.count(notMerged),
      products.count({ ...notMerged, publication: 'active', review_state: 'approved' }),
      products.count({ ...notMerged, publication: 'hidden' }),
      products.count({ ...notMerged, publication: 'suspended' }),
      products.count({ and: [notMerged, { or: [{ content_score: { op: '<', value: 100 } }, { recrop_media_ids: { op: 'is not empty' } }] }] }),
      this.#duplicateSuspectedIds().then((ids) => (ids.length ? products.count({ ...notMerged, id: oneOf(ids) }) : 0)),
      this.#t.submissions.count({ state: 'open', paused_at: null }),
      // `<>` and not `is not`: it was `$nin: ['removed', null]`, which is what `<>` means. `offer_index.status`
      // cannot be null, so no row can tell the two readings apart, and this is the one the spec writes
      this.#t.offers.count({ status: { op: '<>', value: 'removed' } }),
    ]);
    return { all, active, hidden, suspended, missingContent, duplicatesSuspected, inReview, offers };
  }

  async productsInCategories(categoryIds: string[], reviewStates: string[]): Promise<ProductRow[]> {
    if (!categoryIds.length) return [];
    return (await this.#t.products.find({ category_id: oneOf(categoryIds), merged_into_id: null, ...(reviewStates.length ? { review_state: oneOf(reviewStates) as ProductRow['review_state'][] } : {}) })).map(productOut);
  }

  async productsOfBrand(brandId: string, reviewStates: string[]): Promise<ProductRow[]> {
    return (await this.#t.products.find({ brand_id: brandId, merged_into_id: null, ...(reviewStates.length ? { review_state: oneOf(reviewStates) as ProductRow['review_state'][] } : {}) })).map(productOut);
  }

  /** Review states of the products sellers submitted */
  async countBySellerAndState(sellerIds: string[]): Promise<{ seller_id: string; review_state: string; n: number }[]> {
    if (!sellerIds.length) return [];
    const rows = await this.#t.products.countBy(['owner_seller_id', 'review_state'], { owner_seller_id: oneOf(sellerIds), merged_into_id: null });
    return rows.filter((r) => r.owner_seller_id !== null).map((r) => ({ seller_id: r.owner_seller_id!, review_state: r.review_state, n: r.n }));
  }

  /** Approved, not merged products: GTIN, model number and title matches */
  async matchProducts(input: { q: string; gtin?: string; limit: number }): Promise<MatchHit[]> {
    const hits = new Map<string, MatchHit>();
    const gtins = [input.gtin, /^\d{8,14}$/.test(input.q.trim()) ? input.q.trim() : undefined].filter((g): g is string => Boolean(g));
    if (gtins.length) {
      const owners = await this.#t.variants.distinct<string>('product_id', { gtin: oneOf(gtins) });
      const rows = owners.length ? await this.#t.products.find({ ...LIVE, id: oneOf(owners) }, { limit: input.limit }) : [];
      for (const r of rows) if (!hits.has(r.id)) hits.set(r.id, { product: productOut(r), matchedOn: 'gtin' });
    }
    const text = input.q.trim();
    if (text) {
      const model = normalizeModel(text);
      const tokens = text.split(/\s+/).map((tk) => normalizeModel(tk)).filter((tk) => tk.length >= 3 && /\d/.test(tk));
      const prefixes = oneOf([model, ...tokens].filter((tk) => tk.length >= 3).map((tk) => tk.slice(0, Math.max(3, Math.min(tk.length - 1, 4)))));
      if (prefixes.length) {
        const rows = await this.queries.productsByModelPrefixes(prefixes, input.limit * 2);
        for (const r of rows) if (!hits.has(r.id)) hits.set(r.id, { product: productOut(r), matchedOn: 'model' });
      }
      const words = text.split(/\s+/).filter((w) => w.length >= 2).slice(0, 6);
      if (words.length) {
        // every word, each a condition on `title`, which one object cannot hold twice (§10.5a's `and`)
        const rows = await this.#t.products.find({ ...LIVE, and: words.map((w) => ({ title: { op: 'contains' as const, value: w } })) }, { sort: { listed_at: -1 }, limit: input.limit * 2 });
        for (const r of rows) if (!hits.has(r.id)) hits.set(r.id, { product: productOut(r), matchedOn: 'title' });
      }
    }
    return [...hits.values()];
  }

  /** Candidates for the duplicate check */
  async duplicateCandidates(input: { productId: string; modelNumber: string | null; gtins: string[]; titleWords: string[] }): Promise<ProductRow[]> {
    const gtinOwnerIds = input.gtins.length ? await this.#t.variants.distinct<string>('product_id', { gtin: oneOf(input.gtins) }) : [];
    const rows = await this.queries.duplicateCandidates({
      productId: input.productId,
      modelNormalised: input.modelNumber ? normalizeModel(input.modelNumber) : null,
      gtinOwnerIds: oneOf(gtinOwnerIds),
      titleWords: input.titleWords,
    });
    return rows.map(productOut);
  }

  /** Live products (approved, active, not merged) with their listing stats, for the counts job */
  liveCountsSource(): Promise<{ id: string; brand_id: string | null; category_id: string | null; live: boolean; live_offers: number; offers: number }[]> {
    return this.queries.liveCountsSource();
  }

  /* ================================================================ variants */

  async variantsOf(productIds: string[]): Promise<VariantRow[]> {
    if (!productIds.length) return [];
    return this.#t.variants.find({ product_id: oneOf(productIds) }, { sort: { position: 1 } });
  }

  getVariant(id: string): Promise<VariantRow | undefined> {
    return this.#t.variants.get(id);
  }

  getVariants(ids: string[]): Promise<VariantRow[]> {
    return this.#t.variants.getMany(oneOf(ids));
  }

  /** Throws GtinTakenError when another variant has the GTIN */
  insertVariant(row: VariantRow): Promise<VariantRow> {
    return refusingTakenGtin(() => this.#t.variants.insert(row));
  }

  /** Throws GtinTakenError when another variant has the GTIN */
  async updateVariant(id: string, patch: Partial<VariantRow>): Promise<void> {
    if (Object.keys(patch).length) await refusingTakenGtin(() => this.#t.variants.update(id, patch));
  }

  async deleteVariants(ids: string[]): Promise<void> {
    if (ids.length) await this.#t.variants.deleteMany({ id: oneOf(ids) });
  }

  /** Which products already use these GTINs */
  async gtinOwners(gtins: string[]): Promise<{ gtin: string; product_id: string; variant_id: string }[]> {
    if (!gtins.length) return [];
    const rows = await this.#t.variants.find({ gtin: oneOf(gtins) });
    return rows.map((r) => ({ gtin: r.gtin!, product_id: r.product_id, variant_id: r.id }));
  }

  /* ================================================================ review log */

  async insertLog(row: ReviewLogRow): Promise<void> {
    await this.#t.log.insert(row);
  }

  async logsOf(productIds: string[]): Promise<ReviewLogRow[]> {
    if (!productIds.length) return [];
    return this.#t.log.find({ product_id: oneOf(productIds) }, { sort: { at: 1, id: 1 } });
  }

  latestLog(productId: string, action: string): Promise<ReviewLogRow | undefined> {
    return this.#t.log.findOne({ product_id: productId, action }, { sort: { at: -1, id: -1 } });
  }

  /* ================================================================ submissions, checks, review drafts */

  insertSubmission(row: SubmissionRow): Promise<SubmissionRow> {
    return this.#t.submissions.insert(row);
  }

  async updateSubmission(id: string, patch: Partial<SubmissionRow>): Promise<SubmissionRow> {
    if (!Object.keys(patch).length) return (await this.#t.submissions.get(id))!;
    const row = await this.#t.submissions.update(id, patch);
    if (!row) throw new Error(`catalog: submission ${id} not found`);
    return row;
  }

  getSubmission(id: string): Promise<SubmissionRow | undefined> {
    return this.#t.submissions.get(id);
  }

  openSubmission(productId: string, opts: { forUpdate?: boolean } = {}): Promise<SubmissionRow | undefined> {
    return this.#t.submissions.findOne({ product_id: productId, state: 'open' }, { sort: { submitted_at: -1 }, forUpdate: opts.forUpdate });
  }

  /**
   * Latest submission per product (submitted_at desc, id desc).
   *
   * `forUpdate` locks the product's submissions while the latest one is picked and written: which row "the
   * latest" is comes out of this read, so a submission inserted between the read and the write would leave
   * the stamp on the wrong one (§11.2 rule 1; the detector refused three tests without it).
   */
  async latestSubmissions(productIds: string[], opts: { forUpdate?: boolean } = {}): Promise<SubmissionRow[]> {
    if (!productIds.length) return [];
    const rows = await this.#t.submissions.find({ product_id: oneOf(productIds) }, { sort: { product_id: 1, submitted_at: -1, id: -1 }, forUpdate: opts.forUpdate });
    const out = new Map<string, SubmissionRow>();
    for (const r of rows) if (!out.has(r.product_id)) out.set(r.product_id, r);
    return [...out.values()];
  }

  submissionCount(productId: string): Promise<number> {
    return this.#t.submissions.count({ product_id: productId });
  }

  async reviewQueue(filter: QueueFilter, page: PageRequest): Promise<common.Page<SubmissionRow>> {
    // joined to products: merged products leave the queue; a category filter keeps products in those categories
    const products: WhereWithOr<SubmissionRow> = filter.categoryIds
      ? { product_id: filter.categoryIds.length ? await this.#t.products.distinct<string>('id', { category_id: oneOf(filter.categoryIds), merged_into_id: null }) : [] }
      : { product_id: { op: 'not in', value: await this.#t.products.distinct<string>('id', { merged_into_id: { op: 'is not', value: null } }) } };
    // `review_due_at is not null` is a guard that **no test covers**, on either store: every open submission
    // the service writes is given a deadline, so there is no row the condition changes the answer for.
    // Breaking it changes nothing, and the sabotage pass says so rather than a test pretending otherwise
    return this.#t.submissions.page(
      { state: 'open', paused_at: null, review_due_at: { op: 'is not', value: null }, ...(filter.kind ? { kind: filter.kind as SubmissionRow['kind'] } : {}), ...products },
      page,
      { column: 'review_due_at', direction: 'asc' },
    );
  }

  /** Open submissions of a seller's products (optionally only in some categories, or only paused / not paused ones: paused_at) */
  async openSubmissionsOfSeller(sellerId: string, opts: { categoryIds?: string[]; paused?: boolean } = {}): Promise<SubmissionRow[]> {
    const productIds = await this.#t.products.distinct<string>('id', { owner_seller_id: sellerId, ...(opts.categoryIds?.length ? { category_id: oneOf(opts.categoryIds) } : {}) });
    if (!productIds.length) return [];
    return this.#t.submissions.find({
      product_id: productIds,
      state: 'open',
      ...(opts.paused === true ? { paused_at: { op: 'is not' as const, value: null } } : opts.paused === false ? { paused_at: null } : {}),
    });
  }

  /** Open paused submissions of each seller's products, counted per seller (a join, so the port's) */
  pausedCounts(sellerIds: string[]): Promise<Map<string, number>> {
    return this.queries.pausedSubmissionCounts(oneOf(sellerIds));
  }

  async insertChecks(rows: CheckRow[]): Promise<void> {
    await this.#t.checks.insertMany(rows);
  }

  async checksOf(submissionIds: string[]): Promise<CheckRow[]> {
    if (!submissionIds.length) return [];
    return this.#t.checks.find({ submission_id: oneOf(submissionIds) }, { sort: { ran_at: 1, id: 1 } });
  }

  async updateCheck(id: string, patch: Partial<CheckRow>): Promise<void> {
    if (Object.keys(patch).length) await this.#t.checks.update(id, patch);
  }

  /**
   * Per-candidate duplicate dismissals (an existing row for the same candidate is kept). No key named:
   * (check_id, matched_product_id) is this table's primary key (docs/10 §10.5a).
   */
  async insertDismissals(rows: CheckDismissalRow[]): Promise<void> {
    await this.#t.dismissals.insertManyIfAbsent(rows);
  }

  /** Undo dismissals of a check for these candidates */
  async deleteDismissals(checkId: string, matchedProductIds: string[]): Promise<void> {
    if (matchedProductIds.length) await this.#t.dismissals.deleteMany({ check_id: checkId, matched_product_id: oneOf(matchedProductIds) });
  }

  /**
   * Removes a draft product that was never listed with everything that belongs to it: variants, submissions with
   * their checks, dismissals and review drafts, the review log, correction suggestions and listing stats.
   */
  async deleteDraftProduct(productId: string): Promise<void> {
    const submissions = await this.#t.submissions.find({ product_id: productId });
    const subIds = submissions.map((s) => s.id);
    if (subIds.length) {
      const checks = await this.#t.checks.find({ submission_id: oneOf(subIds) });
      if (checks.length) await this.#t.dismissals.deleteMany({ check_id: oneOf(checks.map((c) => c.id)) });
      await this.#t.checks.deleteMany({ submission_id: oneOf(subIds) });
      await this.#t.drafts.deleteMany({ submission_id: oneOf(subIds) });
      await this.#t.submissions.deleteMany({ product_id: productId });
    }
    await this.#t.variants.deleteMany({ product_id: productId });
    await this.#t.log.deleteMany({ product_id: productId });
    await this.#t.corrections.deleteMany({ product_id: productId });
    await this.#t.listing.deleteMany({ product_id: productId });
    await this.#t.products.deleteMany({ id: productId });
  }

  async dismissalsOf(checkIds: string[]): Promise<CheckDismissalRow[]> {
    if (!checkIds.length) return [];
    return this.#t.dismissals.find({ check_id: oneOf(checkIds) });
  }

  /** No key named: (submission_id, staff_id) is this table's primary key (docs/10 §10.5a) */
  saveDraft(row: ReviewDraftRow): Promise<ReviewDraftRow> {
    return this.#t.drafts.upsert(row, { update: { decision: row.decision, reason: row.reason, fields: row.fields, saved_at: row.saved_at } });
  }

  async draftsOf(submissionIds: string[], staffId: string): Promise<ReviewDraftRow[]> {
    if (!submissionIds.length) return [];
    return this.#t.drafts.find({ submission_id: oneOf(submissionIds), staff_id: staffId });
  }

  async deleteDrafts(submissionId: string): Promise<void> {
    await this.#t.drafts.deleteMany({ submission_id: submissionId });
  }

  /* ================================================================ corrections */

  insertCorrection(row: CorrectionRow): Promise<CorrectionRow> {
    return this.#t.corrections.insert(row);
  }

  getCorrection(id: string, opts: { forUpdate?: boolean } = {}): Promise<CorrectionRow | undefined> {
    return this.#t.corrections.get(id, opts);
  }

  async updateCorrection(id: string, patch: Partial<CorrectionRow>): Promise<CorrectionRow> {
    if (!Object.keys(patch).length) return (await this.#t.corrections.get(id))!;
    const row = await this.#t.corrections.update(id, patch);
    if (!row) throw new Error(`catalog: correction ${id} not found`);
    return row;
  }

  listCorrections(filter: { state?: string }, page: PageRequest): Promise<common.Page<CorrectionRow>> {
    return this.#t.corrections.page(filter.state ? { state: filter.state as CorrectionRow['state'] } : {}, page, { column: 'created_at', direction: 'asc' });
  }

  /* ================================================================ offer index and listing stats */

  getOffer(offerId: string, opts: { forUpdate?: boolean } = {}): Promise<OfferIndexRow | undefined> {
    return this.#t.offers.get(offerId, opts);
  }

  async upsertOffer(row: OfferIndexRow): Promise<void> {
    await this.#t.offers.upsert(row, {
      update: {
        product_id: row.product_id,
        variant_id: row.variant_id,
        owner_type: row.owner_type,
        seller_id: row.seller_id,
        // a missing seller name keeps the one already indexed
        ...(row.seller_name != null ? { seller_name: row.seller_name } : {}),
        // a missing price keeps the one already indexed
        ...(row.price != null ? { price: row.price } : {}),
        condition: row.condition,
        updated_at: row.updated_at,
      },
    });
  }

  /** Inserts the row unless the offer is already indexed (then nothing changes) */
  async insertOfferIfMissing(row: OfferIndexRow): Promise<void> {
    await this.#t.offers.insertIfAbsent(row);
  }

  async updateOffer(offerId: string, patch: Partial<OfferIndexRow>): Promise<void> {
    if (Object.keys(patch).length) await this.#t.offers.update(offerId, patch);
  }

  async offersOf(productIds: string[]): Promise<OfferIndexRow[]> {
    if (!productIds.length) return [];
    return this.#t.offers.find({ product_id: oneOf(productIds) }, { sort: { updated_at: 1 } });
  }

  /**
   * Indexed offers (not removed) without a price yet, oldest first. `<>` and not `is not`: `status` cannot be
   * null, so no row can tell the two readings apart, and `<>` is the reading the spec's conditions have.
   */
  offersWithoutPrice(limit: number): Promise<OfferIndexRow[]> {
    return this.#t.offers.find({ price: null, status: { op: '<>', value: 'removed' } }, { sort: { updated_at: 1 }, limit });
  }

  async offersOfSeller(sellerId: string, productIds: string[]): Promise<OfferIndexRow[]> {
    if (!productIds.length) return [];
    return this.#t.offers.find({ seller_id: sellerId, product_id: oneOf(productIds) });
  }

  /**
   * Moves a duplicate's indexed offers to the kept product. The rows are locked as they are read (§11.2 rule
   * 1): each one's new `variant_id` falls back to the value just read when the merge maps no variant for it.
   */
  async moveOffers(fromProductId: string, toProductId: string, variantMap: Map<string, string>): Promise<number> {
    const offers = await this.#t.offers.find({ product_id: fromProductId }, { forUpdate: true, sort: { offer_id: 1 } });
    for (const o of offers) await this.#t.offers.update(o.offer_id, { product_id: toProductId, variant_id: variantMap.get(o.variant_id) ?? o.variant_id });
    return offers.length;
  }

  async listingStats(productIds: string[]): Promise<ListingStatsRow[]> {
    if (!productIds.length) return [];
    return this.#t.listing.getMany(oneOf(productIds));
  }

  async saveListingStats(row: ListingStatsRow): Promise<void> {
    await this.#t.listing.upsert(row, {
      update: { offer_count: row.offer_count, live_offer_count: row.live_offer_count, in_stock: row.in_stock, best_price: row.best_price, offer_note: row.offer_note, refreshed_at: row.refreshed_at },
    });
  }

  async productIdsWithOffers(): Promise<string[]> {
    const offered = await this.#t.offers.distinct<string>('product_id');
    const stats = await this.#t.listing.distinct<string>('product_id');
    return [...new Set([...offered, ...stats])];
  }
}
