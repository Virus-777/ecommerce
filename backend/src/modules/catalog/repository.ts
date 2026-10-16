import { contains, isDuplicateKey, type ModuleStore } from '../../kernel/mongo/index.js';
import type { Filter } from '../../kernel/mongo/table.js';
import { decodeCursor, encodeCursor, type PageRequest } from '../../kernel/lib/pagination.js';
import { escapeRegExp } from '../../kernel/lib/text.js';
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

/** A variant write refused because another variant already has the GTIN (unique index variants.gtin) */
export class GtinTakenError extends Error {
  constructor(options?: { cause?: unknown }) {
    super('A GTIN is already used by another variant', options);
  }
}

/** One of `values`, or nothing when the list is empty (an empty IN matches no row) */
const oneOf = (values: readonly unknown[]) => ({ $in: [...new Set(values)] });
/** All of the conditions (an empty list: every row) */
const allOf = (conds: Filter[]): Filter => (conds.length === 0 ? {} : conds.length === 1 ? conds[0]! : { $and: conds });

/**
 * The model number with everything but letters and digits removed, compared with `normalised` (already lower-case
 * alphanumerics): the characters in order with anything else around them. `whole`: equal; otherwise a prefix.
 */
function modelPattern(normalised: string, whole: boolean) {
  const gap = '[^a-z0-9]*';
  return { $regex: `^${gap}${[...normalised].join(gap)}${whole ? `${gap}$` : ''}`, $options: 'i' };
}

/** The spec's full-text column `search` is not stored (search is the search module's); rows keep the field, always null */
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

const LISTING = 'catalog.listing_stats';
/** Products customers can buy: approved, active, not merged */
const LIVE: Filter = { review_state: 'approved', publication: 'active', merged_into_id: null };
/** The Admin catalog's missing-content tab: a content score under 100, or images to re-crop */
const MISSING_CONTENT: Filter = { $or: [{ content_score: { $lt: 100 } }, { 'recrop_media_ids.0': { $exists: true } }] };

/** The catalog module's collections (catalog.*): one Table per spec table; joins run as two reads or a $lookup. */
export class CatalogRepository {
  readonly #t;

  constructor(private readonly store: ModuleStore) {
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
    return this.store.transaction((tx) => fn(new CatalogRepository(tx)));
  }

  /** Inbox (ctx.mongo.claim): true the first time this key is claimed; commits with the transaction it runs in */
  claim(key: string): Promise<boolean> {
    return this.store.claim(key);
  }

  /* ------------------------------------------------ helpers (joins as two reads) */

  /**
   * Products whose latest submission has an open duplicate finding: a duplicate check that warned or failed and is not
   * dismissed, or was dismissed for one candidate only (dismissed_matched_product_id set).
   */
  async #duplicateSuspectedIds(): Promise<string[]> {
    const checks = await this.#t.checks.find({ kind: 'duplicate', result: oneOf(['warn', 'fail']), $or: [{ dismissed_at: null }, { dismissed_matched_product_id: { $ne: null } }] });
    if (!checks.length) return [];
    const subIds = new Set(checks.map((c) => c.submission_id));
    const subs = await this.#t.submissions.getMany([...subIds]);
    const latest = await this.latestSubmissions([...new Set(subs.map((s) => s.product_id))]);
    return latest.filter((s) => subIds.has(s.id)).map((s) => s.product_id);
  }

  async #productFilter(f: ProductFilter): Promise<Filter> {
    const conds: Filter[] = [];
    if (!f.includeMerged) conds.push({ merged_into_id: null });
    if (f.q?.trim()) {
      const text = f.q.trim();
      const any: Filter[] = [{ title: contains(text) }, { ref: text.toUpperCase() }, { model_number: contains(text) }, { mpn: contains(text) }];
      if (f.matchGtin) {
        const owners = await this.#t.variants.distinct<string>('product_id', { gtin: text.replace(/\s+/g, '') });
        if (owners.length) any.push({ id: oneOf(owners) });
      }
      conds.push({ $or: any });
    }
    if (f.purchasableOnly) conds.push({ review_state: 'approved', publication: 'active' });
    if (f.updatedSince) conds.push({ updated_at: { $gte: f.updatedSince } });
    if (f.categoryIds) conds.push({ category_id: oneOf(f.categoryIds) });
    if (f.brandId) conds.push({ brand_id: f.brandId });
    if (f.ownerSellerId) conds.push({ owner_seller_id: f.ownerSellerId });
    if (f.reviewStates?.length) conds.push({ review_state: oneOf(f.reviewStates) });
    if (f.publication) conds.push({ publication: f.publication });
    // missing content: a content score under 100, or images to re-crop after a product image ratio change
    if (f.missingContent === true) conds.push(MISSING_CONTENT);
    if (f.missingContent === false) conds.push({ $nor: [MISSING_CONTENT] });
    if (f.duplicateSuspected !== undefined) {
      const ids = await this.#duplicateSuspectedIds();
      conds.push({ id: f.duplicateSuspected ? oneOf(ids) : { $nin: ids } });
    }
    return allOf(conds);
  }

  #brandFilter(f: BrandFilter): Filter {
    const conds: Filter[] = [];
    if (f.q?.trim()) conds.push({ name: contains(f.q) });
    if (f.statuses?.length) conds.push({ status: oneOf(f.statuses) });
    if (f.sellingPolicy) conds.push({ selling_policy: f.sellingPolicy });
    if (f.requested === true) conds.push({ requested_by_seller_id: { $ne: null } });
    if (f.requested === false) conds.push({ requested_by_seller_id: null });
    if (f.activeOrRequestedBy) conds.push({ $or: [{ status: 'active' }, { status: 'under_review', requested_by_seller_id: f.activeOrRequestedBy }] });
    return allOf(conds);
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

  categorySlugTaken(slug: string, exceptId?: string): Promise<boolean> {
    return this.#t.categories.exists({ slug, ...(exceptId ? { id: { $ne: exceptId } } : {}) });
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
    return this.#t.brands.getMany([...new Set(ids)]);
  }

  getBrandBySlug(slug: string): Promise<BrandRow | undefined> {
    return this.#t.brands.findOne({ slug });
  }

  /** The same name, any case, ignoring leading and trailing spaces (spaces only, not tabs or new lines) */
  findBrandByName(name: string): Promise<BrandRow | undefined> {
    return this.#t.brands.findOne({ name: { $regex: `^ *${escapeRegExp(name.replace(/^ +| +$/g, ''))} *$`, $options: 'i' } }, { sort: { created_at: 1 } });
  }

  findBrandByChangeRequest(changeRequestId: string): Promise<BrandRow | undefined> {
    return this.#t.brands.findOne({ requested_change_request_id: changeRequestId });
  }

  brandSlugTaken(slug: string, exceptId?: string): Promise<boolean> {
    return this.#t.brands.exists({ slug, ...(exceptId ? { id: { $ne: exceptId } } : {}) });
  }

  listBrands(filter: BrandFilter, page: PageRequest): Promise<common.Page<BrandRow>> {
    return this.#t.brands.page(this.#brandFilter(filter), page, { column: 'name', direction: 'asc' });
  }

  /** Brands ordered by in-stock products from brand_stats (null = all categories), by product_count desc, id desc */
  async listPopularBrands(filter: BrandFilter, categoryId: string | null, page: PageRequest): Promise<common.Page<BrandRow>> {
    const stats = await this.#t.brandStats.find({ category_id: categoryId, product_count: { $gt: 0 } });
    const counts = new Map(stats.map((s) => [s.brand_id, s.product_count]));
    const brands = counts.size ? await this.#t.brands.find({ $and: [this.#brandFilter(filter), { id: oneOf([...counts.keys()]) }] }) : [];
    const sorted = brands
      .map((b) => ({ value: counts.get(b.id)!, id: b.id, item: b }))
      .sort((a, b) => b.value - a.value || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    return pageDesc(sorted, page);
  }

  insertBrand(row: BrandRow): Promise<BrandRow> {
    return this.#t.brands.insert(row);
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
    const unique = [...new Set(sellerIds)];
    if (!unique.length) return;
    const rows: AuthorizedSellerRow[] = unique.map((seller_id) => ({ brand_id: brandId, seller_id, source: 'staff', added_by: addedBy as never, added_at: at }));
    await this.#t.authorized.insertManyIfAbsent(rows, ['brand_id', 'seller_id']);
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
    const rows = await this.#t.products.aggregate<{ _id: string; n: number }>([
      { $match: { brand_id: oneOf(brandIds), merged_into_id: null } },
      { $group: { _id: '$brand_id', n: { $sum: 1 } } },
    ]);
    return new Map(rows.map((r) => [r._id, r.n]));
  }

  /** Live product counts by brand within the given categories (popular brands of a subcategory) */
  async liveProductCountsByBrandIn(categoryIds: string[]): Promise<Map<string, number>> {
    if (!categoryIds.length) return new Map<string, number>();
    const rows = await this.#t.products.aggregate<{ _id: string; n: number }>([
      { $match: { category_id: oneOf(categoryIds), brand_id: { $ne: null }, ...LIVE } },
      { $lookup: { from: LISTING, localField: '_id', foreignField: '_id', as: 'l' } },
      { $match: { 'l.live_offer_count': { $gt: 0 } } },
      { $group: { _id: '$brand_id', n: { $sum: 1 } } },
    ]);
    return new Map(rows.map((r) => [r._id, r.n]));
  }

  /* ================================================================ products */

  async getProduct(id: string, opts: { forUpdate?: boolean } = {}): Promise<ProductRow | undefined> {
    return productOutOpt(await this.#t.products.get(id, opts));
  }

  async getProducts(ids: string[]): Promise<ProductRow[]> {
    return (await this.#t.products.getMany([...new Set(ids)])).map(productOut);
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
    const f = await this.#productFilter(filter);
    const rows = await this.#t.products.find(afterId ? { $and: [f, { id: { $gt: afterId } }] } : f, { sort: { id: 1 }, limit });
    return rows.map((r) => r.id);
  }

  /** Keyset batches by id for exports */
  async productBatch(filter: ProductFilter, afterId: string | null, limit: number): Promise<ProductRow[]> {
    const f = await this.#productFilter(filter);
    return (await this.#t.products.find(afterId ? { $and: [f, { id: { $gt: afterId } }] } : f, { sort: { id: 1 }, limit })).map(productOut);
  }

  async productStats(): Promise<ProductStatsCounts> {
    const notMerged = { merged_into_id: null };
    const products = this.#t.products;
    // independent counts, read at once (never called inside a transaction)
    const [all, active, hidden, suspended, missingContent, duplicatesSuspected, inReview, offers] = await Promise.all([
      products.count(notMerged),
      products.count({ ...notMerged, publication: 'active', review_state: 'approved' }),
      products.count({ ...notMerged, publication: 'hidden' }),
      products.count({ ...notMerged, publication: 'suspended' }),
      products.count({ ...notMerged, ...MISSING_CONTENT }),
      this.#duplicateSuspectedIds().then((ids) => (ids.length ? products.count({ ...notMerged, id: oneOf(ids) }) : 0)),
      this.#t.submissions.count({ state: 'open', paused_at: null }),
      this.#t.offers.count({ status: { $nin: ['removed', null] } }),
    ]);
    return { all, active, hidden, suspended, missingContent, duplicatesSuspected, inReview, offers };
  }

  async productsInCategories(categoryIds: string[], reviewStates: string[]): Promise<ProductRow[]> {
    if (!categoryIds.length) return [];
    return (await this.#t.products.find({ category_id: oneOf(categoryIds), merged_into_id: null, ...(reviewStates.length ? { review_state: oneOf(reviewStates) } : {}) })).map(productOut);
  }

  async productsOfBrand(brandId: string, reviewStates: string[]): Promise<ProductRow[]> {
    return (await this.#t.products.find({ brand_id: brandId, merged_into_id: null, ...(reviewStates.length ? { review_state: oneOf(reviewStates) } : {}) })).map(productOut);
  }

  /** Review states of the products sellers submitted */
  async countBySellerAndState(sellerIds: string[]): Promise<{ seller_id: string; review_state: string; n: number }[]> {
    if (!sellerIds.length) return [];
    const rows = await this.#t.products.aggregate<{ _id: { seller: string; state: string }; n: number }>([
      { $match: { owner_seller_id: oneOf(sellerIds), merged_into_id: null } },
      { $group: { _id: { seller: '$owner_seller_id', state: '$review_state' }, n: { $sum: 1 } } },
    ]);
    return rows.map((r) => ({ seller_id: r._id.seller, review_state: r._id.state, n: r.n }));
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
      const model = text.replace(/[^a-z0-9]/gi, '');
      const tokens = text.split(/\s+/).map((tk) => tk.replace(/[^a-z0-9]/gi, '')).filter((tk) => tk.length >= 3 && /\d/.test(tk));
      const prefixes = [...new Set([model, ...tokens].filter((tk) => tk.length >= 3).map((tk) => tk.slice(0, Math.max(3, Math.min(tk.length - 1, 4)))))];
      if (prefixes.length) {
        const rows = await this.#t.products.find({ ...LIVE, $or: prefixes.map((pre) => ({ model_number: modelPattern(pre.toLowerCase(), false) })) }, { limit: input.limit * 2 });
        for (const r of rows) if (!hits.has(r.id)) hits.set(r.id, { product: productOut(r), matchedOn: 'model' });
      }
      const words = text.split(/\s+/).filter((w) => w.length >= 2).slice(0, 6);
      if (words.length) {
        const rows = await this.#t.products.find({ ...LIVE, $and: words.map((w) => ({ title: contains(w) })) }, { sort: { listed_at: -1 }, limit: input.limit * 2 });
        for (const r of rows) if (!hits.has(r.id)) hits.set(r.id, { product: productOut(r), matchedOn: 'title' });
      }
    }
    return [...hits.values()];
  }

  /** Candidates for the duplicate check */
  async duplicateCandidates(input: { productId: string; modelNumber: string | null; gtins: string[]; titleWords: string[] }): Promise<ProductRow[]> {
    const any: Filter[] = [];
    if (input.modelNumber) any.push({ model_number: modelPattern(input.modelNumber.toLowerCase().replace(/[^a-z0-9]/g, ''), true) });
    if (input.gtins.length) {
      const owners = await this.#t.variants.distinct<string>('product_id', { gtin: oneOf(input.gtins) });
      if (owners.length) any.push({ id: oneOf(owners) });
    }
    if (input.titleWords.length) any.push({ $and: input.titleWords.map((w) => ({ title: contains(w) })) });
    if (!any.length) return [];
    const rows = await this.#t.products.find(
      { $and: [{ id: { $ne: input.productId }, merged_into_id: null, review_state: oneOf(['approved', 'submitted', 'changes_requested']) }, { $or: any }] },
      { limit: 20 },
    );
    return rows.map(productOut);
  }

  /** Live products (approved, active, not merged) with their listing stats, for the counts job */
  async liveCountsSource(): Promise<{ id: string; brand_id: string | null; category_id: string | null; live: boolean; live_offers: number; offers: number }[]> {
    const rows = await this.#t.products.aggregate<{ _id: string; brand_id: string | null; category_id: string | null; review_state: string; publication: string; l: { live_offer_count: number; offer_count: number }[] }>([
      { $match: { merged_into_id: null } },
      { $lookup: { from: LISTING, localField: '_id', foreignField: '_id', as: 'l' } },
      { $project: { brand_id: 1, category_id: 1, review_state: 1, publication: 1, 'l.live_offer_count': 1, 'l.offer_count': 1 } },
    ]);
    return rows.map((r) => ({
      id: r._id,
      brand_id: r.brand_id ?? null,
      category_id: r.category_id ?? null,
      live: r.review_state === 'approved' && r.publication === 'active',
      live_offers: r.l[0]?.live_offer_count ?? 0,
      offers: r.l[0]?.offer_count ?? 0,
    }));
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
    return this.#t.variants.getMany([...new Set(ids)]);
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

  /** Latest submission per product (submitted_at desc, id desc) */
  async latestSubmissions(productIds: string[]): Promise<SubmissionRow[]> {
    if (!productIds.length) return [];
    const rows = await this.#t.submissions.find({ product_id: oneOf(productIds) }, { sort: { product_id: 1, submitted_at: -1, id: -1 } });
    const out = new Map<string, SubmissionRow>();
    for (const r of rows) if (!out.has(r.product_id)) out.set(r.product_id, r);
    return [...out.values()];
  }

  submissionCount(productId: string): Promise<number> {
    return this.#t.submissions.count({ product_id: productId });
  }

  async reviewQueue(filter: QueueFilter, page: PageRequest): Promise<common.Page<SubmissionRow>> {
    // joined to products: merged products leave the queue; a category filter keeps products in those categories
    const products: Filter = filter.categoryIds
      ? { product_id: oneOf(filter.categoryIds.length ? await this.#t.products.distinct<string>('id', { category_id: oneOf(filter.categoryIds), merged_into_id: null }) : []) }
      : { product_id: { $nin: await this.#t.products.distinct<string>('id', { merged_into_id: { $ne: null } }) } };
    return this.#t.submissions.page(
      { state: 'open', paused_at: null, review_due_at: { $ne: null }, ...(filter.kind ? { kind: filter.kind } : {}), ...products },
      page,
      { column: 'review_due_at', direction: 'asc' },
    );
  }

  /** Open submissions of a seller's products (optionally only in some categories, or only paused / not paused ones: paused_at) */
  async openSubmissionsOfSeller(sellerId: string, opts: { categoryIds?: string[]; paused?: boolean } = {}): Promise<SubmissionRow[]> {
    const productIds = await this.#t.products.distinct<string>('id', { owner_seller_id: sellerId, ...(opts.categoryIds?.length ? { category_id: oneOf(opts.categoryIds) } : {}) });
    if (!productIds.length) return [];
    return this.#t.submissions.find({
      product_id: oneOf(productIds),
      state: 'open',
      ...(opts.paused === true ? { paused_at: { $ne: null } } : opts.paused === false ? { paused_at: null } : {}),
    });
  }

  async pausedCounts(sellerIds: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!sellerIds.length) return out;
    // only the id and owner of each product (not whole product documents)
    const owned = await this.#t.products.aggregate<{ _id: string; owner_seller_id: string }>([{ $match: { owner_seller_id: oneOf(sellerIds) } }, { $project: { owner_seller_id: 1 } }]);
    const owners = new Map(owned.map((p) => [p._id, p.owner_seller_id]));
    if (!owners.size) return out;
    const subs = await this.#t.submissions.find({ product_id: oneOf([...owners.keys()]), state: 'open', paused_at: { $ne: null } });
    for (const s of subs) {
      const seller = owners.get(s.product_id)!;
      out.set(seller, (out.get(seller) ?? 0) + 1);
    }
    return out;
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

  /** Per-candidate duplicate dismissals (an existing row for the same candidate is kept) */
  async insertDismissals(rows: CheckDismissalRow[]): Promise<void> {
    await this.#t.dismissals.insertManyIfAbsent(rows, ['check_id', 'matched_product_id']);
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

  saveDraft(row: ReviewDraftRow): Promise<ReviewDraftRow> {
    return this.#t.drafts.upsert(row, { key: ['submission_id', 'staff_id'], update: { decision: row.decision, reason: row.reason, fields: row.fields, saved_at: row.saved_at } });
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
    return this.#t.corrections.page(filter.state ? { state: filter.state } : {}, page, { column: 'created_at', direction: 'asc' });
  }

  /* ================================================================ offer index and listing stats */

  getOffer(offerId: string): Promise<OfferIndexRow | undefined> {
    return this.#t.offers.get(offerId);
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

  /** Indexed offers (not removed) without a price yet, oldest first */
  offersWithoutPrice(limit: number): Promise<OfferIndexRow[]> {
    return this.#t.offers.find({ price: null, status: { $ne: 'removed' } }, { sort: { updated_at: 1 }, limit });
  }

  async offersOfSeller(sellerId: string, productIds: string[]): Promise<OfferIndexRow[]> {
    if (!productIds.length) return [];
    return this.#t.offers.find({ seller_id: sellerId, product_id: oneOf(productIds) });
  }

  async moveOffers(fromProductId: string, toProductId: string, variantMap: Map<string, string>): Promise<number> {
    const offers = await this.#t.offers.find({ product_id: fromProductId });
    for (const o of offers) await this.#t.offers.update(o.offer_id, { product_id: toProductId, variant_id: variantMap.get(o.variant_id) ?? o.variant_id });
    return offers.length;
  }

  async listingStats(productIds: string[]): Promise<ListingStatsRow[]> {
    if (!productIds.length) return [];
    return this.#t.listing.getMany([...new Set(productIds)]);
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
