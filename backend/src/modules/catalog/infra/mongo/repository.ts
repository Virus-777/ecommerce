import type { ModuleStore } from '../../../../kernel/mongo/index.js';
import type { Filter } from '../../../../kernel/mongo/table.js';
import { decodeCursor, encodeCursor, type PageRequest } from '../../../../kernel/lib/pagination.js';
import type * as common from '../../../../spec/common.js';
import type {
  AttributeRow,
  AuthorizedSellerRow,
  BrandFilter,
  BrandRow,
  BrandStatsRow,
  CatalogRepository,
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
} from '../../ports.js';

/** One of `values`, or nothing when the list is empty (an empty IN matches no row) */
const oneOf = (values: readonly unknown[]) => ({ $in: [...new Set(values)] });
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** ILIKE '%q%' with the user's text taken literally */
const contains = (q: string) => ({ $regex: escapeRegExp(q), $options: 'i' });
/** All of the conditions (an empty list: every row) */
const allOf = (conds: Filter[]): Filter => (conds.length === 0 ? {} : conds.length === 1 ? conds[0]! : { $and: conds });

/**
 * regexp_replace(lower(col), '[^a-z0-9]', '', 'g') compared with `normalised` (already lower-case alphanumerics):
 * the characters in order with anything else around them. `whole`: equal; otherwise a prefix (like 'x%').
 */
function modelPattern(normalised: string, whole: boolean) {
  const gap = '[^a-z0-9]*';
  return { $regex: `^${gap}${[...normalised].join(gap)}${whole ? `${gap}$` : ''}`, $options: 'i' };
}

/** The tsvector column `search` is not stored on MongoDB (docs/04 §2); rows keep the field, always null */
const productOut = (r: ProductRow): ProductRow => ({ ...r, search: null });
const productOutOpt = (r: ProductRow | undefined) => (r ? productOut(r) : r);
const productIn = <T extends Partial<ProductRow>>(row: T): Omit<T, 'search'> => {
  const { search: _s, ...rest } = row;
  return rest;
};

/** A duplicate GTIN (unique index variants.gtin) as an error whose message says "unique": the service matches /unique/ */
async function gtinUnique<T>(op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (err) {
    if ((err as { code?: number }).code === 11000) throw new Error(`variants_gtin_key: a GTIN must be unique (${(err as Error).message})`);
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

/** MongoDB adapter for CatalogRepository (docs/04-mongodb-migration.md): one collection per spec table. */
export function createMongoCatalogRepository(store: ModuleStore): CatalogRepository {
  const t = {
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
  const LISTING = 'catalog.listing_stats';

  /* ------------------------------------------------ helpers (joins as two reads) */

  /** Latest submission per product (submitted_at desc, id desc) */
  async function latestSubmissions(productIds: string[]): Promise<SubmissionRow[]> {
    if (!productIds.length) return [];
    const rows = await t.submissions.find({ product_id: oneOf(productIds) }, { sort: { product_id: 1, submitted_at: -1, id: -1 } });
    const out = new Map<string, SubmissionRow>();
    for (const r of rows) if (!out.has(r.product_id)) out.set(r.product_id, r);
    return [...out.values()];
  }

  /**
   * Products whose latest submission has an open duplicate finding: a duplicate check that warned or failed and is not
   * dismissed, or was dismissed for one candidate only (dismissed_matched_product_id set).
   */
  async function duplicateSuspectedIds(): Promise<string[]> {
    const checks = await t.checks.find({ kind: 'duplicate', result: oneOf(['warn', 'fail']), $or: [{ dismissed_at: null }, { dismissed_matched_product_id: { $ne: null } }] });
    if (!checks.length) return [];
    const subIds = new Set(checks.map((c) => c.submission_id));
    const subs = await t.submissions.getMany([...subIds]);
    const latest = await latestSubmissions([...new Set(subs.map((s) => s.product_id))]);
    return latest.filter((s) => subIds.has(s.id)).map((s) => s.product_id);
  }

  async function productFilter(f: ProductFilter): Promise<Filter> {
    const conds: Filter[] = [];
    if (!f.includeMerged) conds.push({ merged_into_id: null });
    if (f.q?.trim()) {
      const text = f.q.trim();
      const any: Filter[] = [{ title: contains(text) }, { ref: text.toUpperCase() }, { model_number: contains(text) }, { mpn: contains(text) }];
      if (f.matchGtin) {
        const owners = await t.variants.distinct<string>('product_id', { gtin: text.replace(/\s+/g, '') });
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
    if (f.missingContent === true) conds.push({ content_score: { $lt: 100 } });
    if (f.missingContent === false) conds.push({ content_score: { $gte: 100 } });
    if (f.duplicateSuspected !== undefined) {
      const ids = await duplicateSuspectedIds();
      conds.push({ id: f.duplicateSuspected ? oneOf(ids) : { $nin: ids } });
    }
    return allOf(conds);
  }

  function brandFilter(f: BrandFilter): Filter {
    const conds: Filter[] = [];
    if (f.q?.trim()) conds.push({ name: contains(f.q.trim()) });
    if (f.statuses?.length) conds.push({ status: oneOf(f.statuses) });
    if (f.sellingPolicy) conds.push({ selling_policy: f.sellingPolicy });
    if (f.requested === true) conds.push({ requested_by_seller_id: { $ne: null } });
    if (f.requested === false) conds.push({ requested_by_seller_id: null });
    if (f.activeOrRequestedBy) conds.push({ $or: [{ status: 'active' }, { status: 'under_review', requested_by_seller_id: f.activeOrRequestedBy }] });
    return allOf(conds);
  }

  const live: Filter = { review_state: 'approved', publication: 'active', merged_into_id: null };

  const repo: CatalogRepository = {
    transaction: (fn) => store.transaction((tx) => fn(createMongoCatalogRepository(tx))),
    claim: (key) => store.claim(key),

    /* ================================================================ categories */

    allCategories: () => t.categories.find({}, { sort: { position: 1, name: 1 } }),
    getCategory: (id) => t.categories.get(id),
    insertCategory: (row) => t.categories.insert(row),
    async updateCategory(id, patch) {
      if (!Object.keys(patch).length) return (await t.categories.get(id))!;
      return (await t.categories.update(id, patch))!;
    },
    categorySlugTaken: (slug, exceptId) => t.categories.exists({ slug, ...(exceptId ? { id: { $ne: exceptId } } : {}) }),
    async attributesOf(categoryIds) {
      if (!categoryIds.length) return [];
      return t.attributes.find({ category_id: oneOf(categoryIds) }, { sort: { position: 1, name: 1 } });
    },
    async replaceAttributes(categoryId, rows) {
      await t.attributes.deleteMany({ category_id: categoryId });
      await t.attributes.insertMany(rows);
    },
    async imageStandardsOf(categoryIds) {
      if (!categoryIds.length) return [];
      return t.imageStandards.getMany(categoryIds);
    },
    async saveImageStandard(categoryId, row) {
      await t.imageStandards.deleteMany({ category_id: categoryId });
      if (row) await t.imageStandards.insert(row);
    },
    categoryStats: () => t.categoryStats.find(),
    async replaceCategoryStats(rows) {
      await t.categoryStats.deleteMany({});
      for (let i = 0; i < rows.length; i += 500) await t.categoryStats.insertMany(rows.slice(i, i + 500));
    },

    /* ================================================================ brands */

    getBrand: (id, opts = {}) => t.brands.get(id, opts),
    getBrands: (ids) => t.brands.getMany([...new Set(ids)]),
    getBrandBySlug: (slug) => t.brands.findOne({ slug }),
    // the same name, any case, ignoring leading and trailing spaces (spaces only, not tabs or new lines)
    findBrandByName: (name) => t.brands.findOne({ name: { $regex: `^ *${escapeRegExp(name.replace(/^ +| +$/g, ''))} *$`, $options: 'i' } }, { sort: { created_at: 1 } }),
    findBrandByChangeRequest: (changeRequestId) => t.brands.findOne({ requested_change_request_id: changeRequestId }),
    brandSlugTaken: (slug, exceptId) => t.brands.exists({ slug, ...(exceptId ? { id: { $ne: exceptId } } : {}) }),
    listBrands: (filter, page) => t.brands.page(brandFilter(filter), page, { column: 'name', direction: 'asc' }),
    async listPopularBrands(filter, categoryId, page) {
      // brands joined to their brand_stats row of the category (null = all categories), by product_count desc, id desc
      const stats = await t.brandStats.find({ category_id: categoryId, product_count: { $gt: 0 } });
      const counts = new Map(stats.map((s) => [s.brand_id, s.product_count]));
      const brands = counts.size ? await t.brands.find({ $and: [brandFilter(filter), { id: oneOf([...counts.keys()]) }] }) : [];
      const sorted = brands
        .map((b) => ({ value: counts.get(b.id)!, id: b.id, item: b }))
        .sort((a, b) => b.value - a.value || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
      return pageDesc(sorted, page);
    },
    insertBrand: (row) => t.brands.insert(row),
    async updateBrand(id, patch) {
      if (!Object.keys(patch).length) return (await t.brands.get(id))!;
      return (await t.brands.update(id, patch))!;
    },
    async authorizedSellers(brandIds) {
      if (!brandIds.length) return [];
      return t.authorized.find({ brand_id: oneOf(brandIds) }, { sort: { added_at: 1 } });
    },
    async replaceStaffAuthorizedSellers(brandId, sellerIds, addedBy, at) {
      await t.authorized.deleteMany({ brand_id: brandId, source: 'staff' });
      const unique = [...new Set(sellerIds)];
      if (!unique.length) return;
      const rows: AuthorizedSellerRow[] = unique.map((seller_id) => ({ brand_id: brandId, seller_id, source: 'staff', added_by: addedBy as never, added_at: at }));
      await t.authorized.insertManyIfAbsent(rows, ['brand_id', 'seller_id']);
    },
    async brandStats(brandIds, categoryId) {
      if (!brandIds.length) return [];
      return t.brandStats.find({ brand_id: oneOf(brandIds), category_id: categoryId });
    },
    async replaceBrandStats(rows) {
      await t.brandStats.deleteMany({});
      for (let i = 0; i < rows.length; i += 500) await t.brandStats.insertMany(rows.slice(i, i + 500));
    },
    async productCountsByBrand(brandIds) {
      if (!brandIds.length) return new Map<string, number>();
      const rows = await t.products.aggregate<{ _id: string; n: number }>([
        { $match: { brand_id: oneOf(brandIds), merged_into_id: null } },
        { $group: { _id: '$brand_id', n: { $sum: 1 } } },
      ]);
      return new Map(rows.map((r) => [r._id, r.n]));
    },
    async liveProductCountsByBrandIn(categoryIds) {
      if (!categoryIds.length) return new Map<string, number>();
      const rows = await t.products.aggregate<{ _id: string; n: number }>([
        { $match: { category_id: oneOf(categoryIds), brand_id: { $ne: null }, ...live } },
        { $lookup: { from: LISTING, localField: '_id', foreignField: '_id', as: 'l' } },
        { $match: { 'l.live_offer_count': { $gt: 0 } } },
        { $group: { _id: '$brand_id', n: { $sum: 1 } } },
      ]);
      return new Map(rows.map((r) => [r._id, r.n]));
    },

    /* ================================================================ products */

    getProduct: async (id, opts = {}) => productOutOpt(await t.products.get(id, opts)),
    getProducts: async (ids) => (await t.products.getMany([...new Set(ids)])).map(productOut),
    insertProduct: async (row) => productOut(await t.products.insert(productIn(row))),
    async updateProduct(id, patch) {
      const values = productIn(patch);
      if (!Object.keys(values).length) return productOut((await t.products.get(id))!);
      return productOut((await t.products.update(id, values))!);
    },
    async listProducts(filter, page) {
      const p = await t.products.page(await productFilter(filter), page, { column: 'updated_at', direction: 'desc' });
      return { ...p, items: p.items.map(productOut) };
    },
    async productIdsAfter(filter, afterId, limit) {
      const f = await productFilter(filter);
      const rows = await t.products.find(afterId ? { $and: [f, { id: { $gt: afterId } }] } : f, { sort: { id: 1 }, limit });
      return rows.map((r) => r.id);
    },
    async productBatch(filter, afterId, limit) {
      const f = await productFilter(filter);
      return (await t.products.find(afterId ? { $and: [f, { id: { $gt: afterId } }] } : f, { sort: { id: 1 }, limit })).map(productOut);
    },
    async productStats(): Promise<ProductStatsCounts> {
      const notMerged = { merged_into_id: null };
      const suspected = await duplicateSuspectedIds();
      return {
        all: await t.products.count(notMerged),
        active: await t.products.count({ ...notMerged, publication: 'active', review_state: 'approved' }),
        hidden: await t.products.count({ ...notMerged, publication: 'hidden' }),
        suspended: await t.products.count({ ...notMerged, publication: 'suspended' }),
        missingContent: await t.products.count({ ...notMerged, content_score: { $lt: 100 } }),
        duplicatesSuspected: suspected.length ? await t.products.count({ ...notMerged, id: oneOf(suspected) }) : 0,
        inReview: await t.submissions.count({ state: 'open', paused_at: null }),
        offers: await t.offers.count({ status: { $nin: ['removed', null] } }),
      };
    },
    async productsInCategories(categoryIds, reviewStates) {
      if (!categoryIds.length) return [];
      return (await t.products.find({ category_id: oneOf(categoryIds), merged_into_id: null, ...(reviewStates.length ? { review_state: oneOf(reviewStates) } : {}) })).map(productOut);
    },
    productsOfBrand: async (brandId, reviewStates) =>
      (await t.products.find({ brand_id: brandId, merged_into_id: null, ...(reviewStates.length ? { review_state: oneOf(reviewStates) } : {}) })).map(productOut),
    async countBySellerAndState(sellerIds) {
      if (!sellerIds.length) return [];
      const rows = await t.products.aggregate<{ _id: { seller: string; state: string }; n: number }>([
        { $match: { owner_seller_id: oneOf(sellerIds), merged_into_id: null } },
        { $group: { _id: { seller: '$owner_seller_id', state: '$review_state' }, n: { $sum: 1 } } },
      ]);
      return rows.map((r) => ({ seller_id: r._id.seller, review_state: r._id.state, n: r.n }));
    },
    async matchProducts(input): Promise<MatchHit[]> {
      const hits = new Map<string, MatchHit>();
      const gtins = [input.gtin, /^\d{8,14}$/.test(input.q.trim()) ? input.q.trim() : undefined].filter((g): g is string => Boolean(g));
      if (gtins.length) {
        const owners = await t.variants.distinct<string>('product_id', { gtin: oneOf(gtins) });
        const rows = owners.length ? await t.products.find({ ...live, id: oneOf(owners) }, { limit: input.limit }) : [];
        for (const r of rows) if (!hits.has(r.id)) hits.set(r.id, { product: productOut(r), matchedOn: 'gtin' });
      }
      const text = input.q.trim();
      if (text) {
        const model = text.replace(/[^a-z0-9]/gi, '');
        const tokens = text.split(/\s+/).map((tk) => tk.replace(/[^a-z0-9]/gi, '')).filter((tk) => tk.length >= 3 && /\d/.test(tk));
        const prefixes = [...new Set([model, ...tokens].filter((tk) => tk.length >= 3).map((tk) => tk.slice(0, Math.max(3, Math.min(tk.length - 1, 4)))))];
        if (prefixes.length) {
          const rows = await t.products.find({ ...live, $or: prefixes.map((pre) => ({ model_number: modelPattern(pre.toLowerCase(), false) })) }, { limit: input.limit * 2 });
          for (const r of rows) if (!hits.has(r.id)) hits.set(r.id, { product: productOut(r), matchedOn: 'model' });
        }
        const words = text.split(/\s+/).filter((w) => w.length >= 2).slice(0, 6);
        if (words.length) {
          const rows = await t.products.find({ ...live, $and: words.map((w) => ({ title: contains(w) })) }, { sort: { listed_at: -1 }, limit: input.limit * 2 });
          for (const r of rows) if (!hits.has(r.id)) hits.set(r.id, { product: productOut(r), matchedOn: 'title' });
        }
      }
      return [...hits.values()];
    },
    async duplicateCandidates(input) {
      const any: Filter[] = [];
      if (input.modelNumber) any.push({ model_number: modelPattern(input.modelNumber.toLowerCase().replace(/[^a-z0-9]/g, ''), true) });
      if (input.gtins.length) {
        const owners = await t.variants.distinct<string>('product_id', { gtin: oneOf(input.gtins) });
        if (owners.length) any.push({ id: oneOf(owners) });
      }
      if (input.titleWords.length) any.push({ $and: input.titleWords.map((w) => ({ title: contains(w) })) });
      if (!any.length) return [];
      const rows = await t.products.find(
        { $and: [{ id: { $ne: input.productId }, merged_into_id: null, review_state: oneOf(['approved', 'submitted', 'changes_requested']) }, { $or: any }] },
        { limit: 20 },
      );
      return rows.map(productOut);
    },
    async liveCountsSource() {
      const rows = await t.products.aggregate<{ _id: string; brand_id: string | null; category_id: string | null; review_state: string; publication: string; l: { live_offer_count: number; offer_count: number }[] }>([
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
    },

    /* ================================================================ variants */

    async variantsOf(productIds) {
      if (!productIds.length) return [];
      return t.variants.find({ product_id: oneOf(productIds) }, { sort: { position: 1 } });
    },
    getVariant: (id) => t.variants.get(id),
    getVariants: (ids) => t.variants.getMany([...new Set(ids)]),
    insertVariant: (row) => gtinUnique(() => t.variants.insert(row)),
    async updateVariant(id, patch) {
      if (Object.keys(patch).length) await gtinUnique(() => t.variants.update(id, patch));
    },
    async deleteVariants(ids) {
      if (ids.length) await t.variants.deleteMany({ id: oneOf(ids) });
    },
    async gtinOwners(gtins) {
      if (!gtins.length) return [];
      const rows = await t.variants.find({ gtin: oneOf(gtins) });
      return rows.map((r) => ({ gtin: r.gtin!, product_id: r.product_id, variant_id: r.id }));
    },

    /* ================================================================ review log */

    async insertLog(row) {
      await t.log.insert(row);
    },
    async logsOf(productIds) {
      if (!productIds.length) return [];
      return t.log.find({ product_id: oneOf(productIds) }, { sort: { at: 1, id: 1 } });
    },
    latestLog: (productId, action) => t.log.findOne({ product_id: productId, action }, { sort: { at: -1, id: -1 } }),

    /* ================================================================ submissions, checks, drafts */

    insertSubmission: (row) => t.submissions.insert(row),
    async updateSubmission(id, patch) {
      if (!Object.keys(patch).length) return (await t.submissions.get(id))!;
      const row = await t.submissions.update(id, patch);
      if (!row) throw new Error(`catalog: submission ${id} not found`);
      return row;
    },
    getSubmission: (id) => t.submissions.get(id),
    openSubmission: (productId, opts = {}) => t.submissions.findOne({ product_id: productId, state: 'open' }, { sort: { submitted_at: -1 }, forUpdate: opts.forUpdate }),
    latestSubmissions,
    submissionCount: (productId) => t.submissions.count({ product_id: productId }),
    async reviewQueue(filter: QueueFilter, page: PageRequest) {
      // joined to products: merged products leave the queue; a category filter keeps products in those categories
      const products: Filter = filter.categoryIds
        ? { product_id: oneOf(filter.categoryIds.length ? await t.products.distinct<string>('id', { category_id: oneOf(filter.categoryIds), merged_into_id: null }) : []) }
        : { product_id: { $nin: await t.products.distinct<string>('id', { merged_into_id: { $ne: null } }) } };
      return t.submissions.page(
        { state: 'open', paused_at: null, review_due_at: { $ne: null }, ...(filter.kind ? { kind: filter.kind } : {}), ...products },
        page,
        { column: 'review_due_at', direction: 'asc' },
      );
    },
    async openSubmissionsOfSeller(sellerId, opts = {}) {
      const productIds = await t.products.distinct<string>('id', { owner_seller_id: sellerId, ...(opts.categoryIds?.length ? { category_id: oneOf(opts.categoryIds) } : {}) });
      if (!productIds.length) return [];
      return t.submissions.find({
        product_id: oneOf(productIds),
        state: 'open',
        ...(opts.paused === true ? { paused_at: { $ne: null } } : opts.paused === false ? { paused_at: null } : {}),
      });
    },
    async pausedCounts(sellerIds) {
      const out = new Map<string, number>();
      if (!sellerIds.length) return out;
      const owners = new Map((await t.products.find({ owner_seller_id: oneOf(sellerIds) })).map((p) => [p.id, p.owner_seller_id!]));
      if (!owners.size) return out;
      const subs = await t.submissions.find({ product_id: oneOf([...owners.keys()]), state: 'open', paused_at: { $ne: null } });
      for (const s of subs) {
        const seller = owners.get(s.product_id)!;
        out.set(seller, (out.get(seller) ?? 0) + 1);
      }
      return out;
    },
    async insertChecks(rows) {
      await t.checks.insertMany(rows);
    },
    async checksOf(submissionIds) {
      if (!submissionIds.length) return [];
      return t.checks.find({ submission_id: oneOf(submissionIds) }, { sort: { ran_at: 1, id: 1 } });
    },
    async updateCheck(id, patch) {
      if (Object.keys(patch).length) await t.checks.update(id, patch);
    },
    async insertDismissals(rows) {
      await t.dismissals.insertManyIfAbsent(rows, ['check_id', 'matched_product_id']);
    },
    async dismissalsOf(checkIds) {
      if (!checkIds.length) return [];
      return t.dismissals.find({ check_id: oneOf(checkIds) });
    },
    saveDraft: (row) =>
      t.drafts.upsert(row, { key: ['submission_id', 'staff_id'], update: { decision: row.decision, reason: row.reason, fields: row.fields, saved_at: row.saved_at } }),
    async draftsOf(submissionIds, staffId) {
      if (!submissionIds.length) return [];
      return t.drafts.find({ submission_id: oneOf(submissionIds), staff_id: staffId });
    },
    async deleteDrafts(submissionId) {
      await t.drafts.deleteMany({ submission_id: submissionId });
    },

    /* ================================================================ corrections */

    insertCorrection: (row) => t.corrections.insert(row),
    getCorrection: (id, opts = {}) => t.corrections.get(id, opts),
    async updateCorrection(id, patch) {
      if (!Object.keys(patch).length) return (await t.corrections.get(id))!;
      const row = await t.corrections.update(id, patch);
      if (!row) throw new Error(`catalog: correction ${id} not found`);
      return row;
    },
    listCorrections: (filter, page) => t.corrections.page(filter.state ? { state: filter.state } : {}, page, { column: 'created_at', direction: 'asc' }),

    /* ================================================================ offer index and listing stats */

    getOffer: (offerId) => t.offers.get(offerId),
    async upsertOffer(row) {
      await t.offers.upsert(row, {
        update: {
          product_id: row.product_id,
          variant_id: row.variant_id,
          owner_type: row.owner_type,
          seller_id: row.seller_id,
          // coalesce(excluded.seller_name, offer_index.seller_name)
          ...(row.seller_name != null ? { seller_name: row.seller_name } : {}),
          condition: row.condition,
          updated_at: row.updated_at,
        },
      });
    },
    async insertOfferIfMissing(row) {
      await t.offers.insertIfAbsent(row);
    },
    async updateOffer(offerId, patch) {
      if (Object.keys(patch).length) await t.offers.update(offerId, patch);
    },
    async offersOf(productIds) {
      if (!productIds.length) return [];
      return t.offers.find({ product_id: oneOf(productIds) }, { sort: { updated_at: 1 } });
    },
    async offersOfSeller(sellerId, productIds) {
      if (!productIds.length) return [];
      return t.offers.find({ seller_id: sellerId, product_id: oneOf(productIds) });
    },
    async moveOffers(fromProductId, toProductId, variantMap) {
      const offers = await t.offers.find({ product_id: fromProductId });
      for (const o of offers) await t.offers.update(o.offer_id, { product_id: toProductId, variant_id: variantMap.get(o.variant_id) ?? o.variant_id });
      return offers.length;
    },
    async listingStats(productIds) {
      if (!productIds.length) return [];
      return t.listing.getMany([...new Set(productIds)]);
    },
    async saveListingStats(row) {
      await t.listing.upsert(row, {
        update: { offer_count: row.offer_count, live_offer_count: row.live_offer_count, in_stock: row.in_stock, best_price: row.best_price, offer_note: row.offer_note, refreshed_at: row.refreshed_at },
      });
    },
    async productIdsWithOffers() {
      const offered = await t.offers.distinct<string>('product_id');
      const stats = await t.listing.distinct<string>('product_id');
      return [...new Set([...offered, ...stats])];
    },
  };
  return repo;
}
