import type { ModuleStore } from '../../../../kernel/mongo/index.js';
import type { Filter, Sort, Table as Collection } from '../../../../kernel/mongo/table.js';
import type { OfferListFilter, OffersRepository, Table } from '../../ports.js';

/** One of `values`, or nothing when the list is empty (an empty IN matches no row) */
const oneOf = (values: readonly unknown[]) => ({ $in: [...new Set(values)] });
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const isOp = (v: unknown): v is { op: string; value: unknown } => typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date) && 'op' in v;

/** A Where (ports.ts) as a filter, with SQL's meaning: `<>` and `not in` skip nulls, an empty list matches nothing */
function where(w: Record<string, unknown>): Filter {
  const out: Filter = {};
  for (const [col, v] of Object.entries(w)) {
    if (v === undefined) continue;
    if (v === null) out[col] = null;
    else if (Array.isArray(v)) out[col] = oneOf(v);
    else if (isOp(v)) {
      const value = v.value;
      switch (v.op) {
        case '<':
          out[col] = { $lt: value };
          break;
        case '<=':
          out[col] = { $lte: value };
          break;
        case '>':
          out[col] = { $gt: value };
          break;
        case '>=':
          out[col] = { $gte: value };
          break;
        case '<>':
          out[col] = value === null ? { $in: [] } : { $nin: [value, null] };
          break;
        case 'is not':
          out[col] = value === null ? { $ne: null } : { $nin: [value, null] };
          break;
        case 'not in': {
          const list = value as unknown[];
          if (list.length) out[col] = { $nin: [...list, null] };
          break;
        }
        default:
          throw new Error(`offers repository: unknown operator ${v.op}`);
      }
    } else out[col] = v;
  }
  return out;
}

const definedOnly = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined));

/**
 * A duplicate key as a unique violation error (code 23505, the index name as `constraint`): the service
 * tells DUPLICATE_OFFER reasons apart by the index name (stock_item, sku, variant).
 */
function uniqueViolation(err: unknown): unknown {
  const e = err as { code?: unknown; message?: string; errmsg?: string; writeErrors?: { errmsg?: string }[] };
  if (e?.code !== 11000) return err;
  const text = e.writeErrors?.[0]?.errmsg ?? e.errmsg ?? e.message ?? '';
  const constraint = /index: (\S+)/.exec(text)?.[1] ?? '';
  return Object.assign(new Error(`duplicate key value violates unique constraint "${constraint}"`), { code: '23505', constraint, cause: err });
}

async function unique<R>(fn: () => Promise<R>): Promise<R> {
  try {
    return await fn();
  } catch (err) {
    throw uniqueViolation(err);
  }
}

/** MongoDB adapter for OffersRepository (docs/04-mongodb-migration.md): one collection per spec table. */
export function createMongoOffersRepository(store: ModuleStore): OffersRepository {
  const table = (name: Table) => store.table<any>(name) as Collection<any>;
  const t = {
    offers: table('offers'),
    priceChanges: table('price_changes'),
    eligibility: table('offer_eligibility'),
    featured: table('featured_offers'),
    rules: table('featured_rules'),
    bulkJobs: table('bulk_update_jobs'),
    bulkRows: table('bulk_update_rows'),
  };

  async function offerFilter(f: OfferListFilter): Promise<Filter> {
    const and: Filter[] = [];
    if (f.ownerType) and.push({ owner_type: f.ownerType });
    if (f.sellerId) and.push({ seller_id: f.sellerId });
    if (f.productId) and.push({ product_id: f.productId });
    if (f.productIds) and.push({ product_id: oneOf(f.productIds) });
    if (f.variantIds) and.push({ variant_id: oneOf(f.variantIds) });
    if (f.ids) and.push({ id: oneOf(f.ids) });
    if (f.statuses?.length) and.push({ status: oneOf(f.statuses) });
    if (f.excludeStatuses?.length) and.push({ status: { $nin: [...f.excludeStatuses, null] } });
    if (f.conditions?.length) and.push({ condition: oneOf(f.conditions) });
    if (f.contentGap) and.push({ content_gaps: f.contentGap });
    if (f.shippingProfileId) and.push({ shipping_profile_id: f.shippingProfileId });
    const q = f.q?.trim();
    if (q) {
      // title (substring, any case), seller SKU, or the exact offer id; misspellings are not matched here: search
      // proper is the search module's
      const like = { $regex: escapeRegExp(q), $options: 'i' };
      and.push({ $or: [{ title: like }, { seller_sku: like }, { id: q.toLowerCase() }] });
    }
    if (f.featuredEligible !== undefined) {
      const eligible = await t.eligibility.distinct<string>('offer_id', { eligible: true });
      and.push({ id: f.featuredEligible ? oneOf(eligible) : { $nin: eligible } });
    }
    if (f.ineligibilityCode) and.push({ id: oneOf(await t.eligibility.distinct<string>('offer_id', { 'reasons.code': f.ineligibilityCode })) });
    return and.length ? { $and: and } : {};
  }

  const sortOf = (orderBy: [string, 'asc' | 'desc'][] | undefined): Sort | undefined =>
    orderBy?.length ? Object.fromEntries(orderBy.map(([c, d]) => [c, d === 'desc' ? -1 : 1])) : undefined;

  const repo: OffersRepository = {
    transaction: (fn) => store.transaction((tx) => fn(createMongoOffersRepository(tx))),
    claim: (key) => store.claim(key),

    /* ---------------------------------------------------------------- generic */
    get: (name, id, o) => table(name).get(id, { forUpdate: o?.forUpdate }),
    async getMany(name, ids) {
      return table(name).getMany([...new Set(ids)]);
    },
    find: (name, w, o) => table(name).find(where(w as Record<string, unknown>), { sort: sortOf(o?.orderBy), limit: o?.limit, forUpdate: o?.forUpdate }),
    findOne: (name, w, o) => table(name).findOne(where(w as Record<string, unknown>), { sort: sortOf(o?.orderBy), forUpdate: o?.forUpdate }),
    count: (name, w) => table(name).count(where(w as Record<string, unknown>)),
    insert: (name, row) => unique(() => table(name).insert(definedOnly(row as Record<string, unknown>))),
    async insertMany(name, rows) {
      for (let i = 0; i < rows.length; i += 500) {
        const chunk = rows.slice(i, i + 500).map((r) => definedOnly(r as Record<string, unknown>));
        await unique(() => table(name).insertMany(chunk));
      }
    },
    async update(name, id, patch) {
      const values = definedOnly(patch as Record<string, unknown>);
      if (!Object.keys(values).length) return (await repo.get(name, id))!;
      const row = await unique(() => table(name).update(id, values));
      if (!row) throw new Error(`offers: ${name} ${id} not found`);
      return row;
    },
    async updateWhere(name, w, patch) {
      const values = definedOnly(patch as Record<string, unknown>);
      if (!Object.keys(values).length) return 0;
      return unique(() => table(name).updateMany(where(w as Record<string, unknown>), values));
    },
    async deleteWhere(name, w) {
      await table(name).deleteMany(where(w as Record<string, unknown>));
    },

    /* ---------------------------------------------------------------- offers */
    async listOffers(filter, page, order) {
      return t.offers.page(await offerFilter(filter), page, order ?? { column: 'updated_at', direction: 'desc' });
    },
    async allOffers(filter, limit) {
      return t.offers.find(await offerFilter(filter), { sort: { updated_at: -1, id: -1 }, limit });
    },
    async countByStatus(filter) {
      const rows = await t.offers.aggregate<{ _id: string; n: number }>([{ $match: t.offers.filter(await offerFilter(filter)) }, { $group: { _id: '$status', n: { $sum: 1 } } }]);
      return Object.fromEntries(rows.map((r) => [r._id, r.n]));
    },
    async featuredOfferIds(offerIds) {
      if (!offerIds.length) return new Set();
      return new Set(await t.featured.distinct<string>('offer_id', { offer_id: oneOf(offerIds) }));
    },

    /* ---------------------------------------------------------------- price changes */
    async listPriceChanges(f, page) {
      const and: Filter[] = [];
      if (f.states?.length) and.push({ state: oneOf(f.states) });
      if (f.offerId) and.push({ offer_id: f.offerId });
      if (f.ownerType || f.sellerId) {
        const ids = await t.offers.distinct<string>('id', { ...(f.ownerType ? { owner_type: f.ownerType } : {}), ...(f.sellerId ? { seller_id: f.sellerId } : {}) });
        and.push({ offer_id: oneOf(ids) });
      }
      return t.priceChanges.page(and.length ? { $and: and } : {}, page, { column: 'created_at', direction: 'desc' });
    },

    /* ---------------------------------------------------------------- eligibility */
    async getEligibility(offerIds) {
      if (!offerIds.length) return [];
      return t.eligibility.find({ offer_id: oneOf(offerIds) });
    },
    async upsertEligibility(row) {
      await t.eligibility.upsert(definedOnly(row as never));
    },

    /* ---------------------------------------------------------------- featured */
    getFeatured: (variantId, group, zone) => t.featured.findOne({ variant_id: variantId, condition_group: group, zone_key: zone }),
    async upsertFeatured(row) {
      await t.featured.upsert(definedOnly(row as never), { key: ['variant_id', 'condition_group', 'zone_key'] });
    },
    async markFeaturedDirty(w) {
      if (w.all) return t.featured.updateMany({ dirty: false }, { dirty: true });
      const or: Filter[] = [];
      if (w.variantIds?.length) or.push({ variant_id: oneOf(w.variantIds) });
      if (w.productIds?.length) or.push({ product_id: oneOf(w.productIds) });
      if (w.olderThan) or.push({ computed_at: { $lt: w.olderThan } });
      if (w.ruleVersionNot !== undefined) or.push({ rule_version: { $nin: [w.ruleVersionNot, null] } });
      if (!or.length) return 0;
      return t.featured.updateMany({ $or: or, dirty: false }, { dirty: true });
    },
    dirtyFeatured: (limit) => t.featured.find({ dirty: true }, { sort: { computed_at: 1 }, limit }),

    /* ---------------------------------------------------------------- rules */
    rules: () => t.rules.find({}, { sort: { version: 1 } }),

    /* ---------------------------------------------------------------- bulk */
    listBulkJobs: (f, page) => t.bulkJobs.page({ owner_type: f.ownerType, ...(f.sellerId ? { seller_id: f.sellerId } : {}) }, page, { column: 'uploaded_at', direction: 'desc' }),
    bulkRows: (jobId, result, page) => t.bulkRows.page({ job_id: jobId, ...(result ? { result } : {}) }, page, { column: 'row_no', direction: 'asc', id: 'row_no' }),
    async updateBulkRow(jobId, rowNo, patch) {
      const values = definedOnly(patch as Record<string, unknown>);
      if (!Object.keys(values).length) return;
      await t.bulkRows.updateMany({ job_id: jobId, row_no: rowNo }, values);
    },
  };
  return repo;
}
