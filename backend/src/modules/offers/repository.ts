import type { PageRequest } from '../../kernel/lib/pagination.js';
import { isDuplicateKey, whereFilter, contains, type ModuleStore, type Where } from '../../kernel/mongo/index.js';
import type { Filter, Sort, Table as Collection } from '../../kernel/mongo/table.js';
import type * as common from '../../spec/common.js';
import type { BulkJobRec, BulkRowRec, CostRec, Db, EligibilityRec, FeaturedRec, IdTable, OfferListFilter, OfferRec, PriceChangeRec, RuleRec, Table } from './ports.js';

export interface FindOptions<R> {
  orderBy?: [keyof R & string, 'asc' | 'desc'][];
  limit?: number;
  forUpdate?: boolean;
}

/**
 * A write refused by a unique index of the collection. `index` is the index name: the service tells the
 * DUPLICATE_OFFER reasons apart by it (it names the columns: stock_item, seller_sku, variant).
 */
export class DuplicateKeyError extends Error {
  constructor(
    readonly index: string,
    options?: { cause?: unknown },
  ) {
    super(`a unique index refused the write: ${index}`, options);
  }
}

/** fn, with MongoDB's duplicate key error turned into DuplicateKeyError */
async function refusingDuplicates<R>(fn: () => Promise<R>): Promise<R> {
  try {
    return await fn();
  } catch (err) {
    if (!isDuplicateKey(err)) throw err;
    const e = err as { message?: string; errmsg?: string; writeErrors?: { errmsg?: string }[] };
    const text = e.writeErrors?.[0]?.errmsg ?? e.errmsg ?? e.message ?? '';
    throw new DuplicateKeyError(/index: (\S+)/.exec(text)?.[1] ?? '', { cause: err });
  }
}

/** One of `values`, or nothing when the list is empty (an empty IN matches no row) */
const oneOf = (values: readonly unknown[]) => ({ $in: [...new Set(values)] });
const definedOnly = (row: object) => Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined));
const sortOf = (orderBy: [string, 'asc' | 'desc'][] | undefined): Sort | undefined =>
  orderBy?.length ? Object.fromEntries(orderBy.map(([c, d]) => [c, d === 'desc' ? -1 : 1])) : undefined;

/**
 * offers.offers, offer_price_history, price_changes, offer_status_log, offer_eligibility, featured_offers,
 * featured_rules, bulk_update_jobs, bulk_update_rows, offer_costs: generic access by table (get / find / insert / update with a
 * Where of column conditions, kernel whereFilter) plus the offer list filters, featured decisions and bulk rows.
 * Writes that a unique index refuses throw DuplicateKeyError.
 */
export class OffersRepository {
  readonly #t;

  constructor(private readonly store: ModuleStore) {
    this.#t = {
      offers: this.#table('offers'),
      priceChanges: this.#table('price_changes'),
      eligibility: this.#table('offer_eligibility'),
      featured: this.#table('featured_offers'),
      rules: this.#table('featured_rules'),
      bulkJobs: this.#table('bulk_update_jobs'),
      bulkRows: this.#table('bulk_update_rows'),
      costs: this.#table('offer_costs'),
    };
  }

  transaction<R>(fn: (tx: OffersRepository) => Promise<R>): Promise<R> {
    return this.store.transaction((tx) => fn(new OffersRepository(tx)));
  }

  /** Inbox (ctx.mongo.claim): true the first time this key is claimed; inside a transaction it commits with the effects */
  claim(key: string): Promise<boolean> {
    return this.store.claim(key);
  }

  // generic table access: the row types are checked by the method signatures
  #table(name: Table): Collection<any> {
    return this.store.table(name);
  }

  /* ---------------------------------------------------------------- generic */

  get<T extends IdTable>(table: T, id: string, o?: { forUpdate?: boolean }): Promise<Db[T] | undefined> {
    return this.#table(table).get(id, { forUpdate: o?.forUpdate });
  }

  getMany<T extends IdTable>(table: T, ids: readonly string[]): Promise<Db[T][]> {
    return this.#table(table).getMany([...new Set(ids)]);
  }

  find<T extends Table>(table: T, where: Where<Db[T]>, o?: FindOptions<Db[T]>): Promise<Db[T][]> {
    return this.#table(table).find(whereFilter(where), { sort: sortOf(o?.orderBy), limit: o?.limit, forUpdate: o?.forUpdate });
  }

  findOne<T extends Table>(table: T, where: Where<Db[T]>, o?: FindOptions<Db[T]>): Promise<Db[T] | undefined> {
    return this.#table(table).findOne(whereFilter(where), { sort: sortOf(o?.orderBy), forUpdate: o?.forUpdate });
  }

  count<T extends Table>(table: T, where: Where<Db[T]>): Promise<number> {
    return this.#table(table).count(whereFilter(where));
  }

  insert<T extends Table>(table: T, row: Db[T]): Promise<Db[T]> {
    return refusingDuplicates(() => this.#table(table).insert(definedOnly(row)));
  }

  /** Inserts unless a unique key of the row is taken (on conflict do nothing): the row, or undefined */
  insertIfAbsent<T extends Table>(table: T, row: Db[T]): Promise<Db[T] | undefined> {
    return this.#table(table).insertIfAbsent(definedOnly(row));
  }

  async insertMany<T extends Table>(table: T, rows: Db[T][]): Promise<void> {
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500).map(definedOnly);
      await refusingDuplicates(() => this.#table(table).insertMany(chunk));
    }
  }

  async update<T extends IdTable>(table: T, id: string, patch: Partial<Db[T]>): Promise<Db[T]> {
    const values = definedOnly(patch);
    if (!Object.keys(values).length) return (await this.get(table, id))!;
    const row = await refusingDuplicates(() => this.#table(table).update(id, values));
    if (!row) throw new Error(`offers: ${table} ${id} not found`);
    return row;
  }

  async updateWhere<T extends Table>(table: T, where: Where<Db[T]>, patch: Partial<Db[T]>): Promise<number> {
    const values = definedOnly(patch);
    if (!Object.keys(values).length) return 0;
    return refusingDuplicates(() => this.#table(table).updateMany(whereFilter(where), values));
  }

  async deleteWhere<T extends Table>(table: T, where: Where<Db[T]>): Promise<void> {
    await this.#table(table).deleteMany(whereFilter(where));
  }

  /* ---------------------------------------------------------------- offers */

  async #offerFilter(f: OfferListFilter): Promise<Filter> {
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
      const like = contains(q);
      and.push({ $or: [{ title: like }, { seller_sku: like }, { id: q.toLowerCase() }] });
    }
    if (f.featuredEligible !== undefined) {
      const eligible = await this.#t.eligibility.distinct<string>('offer_id', { eligible: true });
      and.push({ id: f.featuredEligible ? oneOf(eligible) : { $nin: eligible } });
    }
    if (f.ineligibilityCode) and.push({ id: oneOf(await this.#t.eligibility.distinct<string>('offer_id', { 'reasons.code': f.ineligibilityCode })) });
    return and.length ? { $and: and } : {};
  }

  async listOffers(filter: OfferListFilter, page: PageRequest, order?: { column: 'created_at' | 'updated_at'; direction: 'asc' | 'desc' }): Promise<common.Page<OfferRec>> {
    return this.#t.offers.page(await this.#offerFilter(filter), page, order ?? { column: 'updated_at', direction: 'desc' });
  }

  async allOffers(filter: OfferListFilter, limit: number): Promise<OfferRec[]> {
    return this.#t.offers.find(await this.#offerFilter(filter), { sort: { updated_at: -1, id: -1 }, limit });
  }

  /** Ineligible offers held by one source (ineligible_source: a restriction, a product …) */
  heldBy(kind: string, id: string): Promise<OfferRec[]> {
    return this.#t.offers.find({ status: 'ineligible', 'ineligible_source.kind': kind, 'ineligible_source.id': id });
  }

  /** allOffers(filter, offset + limit).slice(offset), reading only that part */
  async offersSlice(filter: OfferListFilter, offset: number, limit: number): Promise<OfferRec[]> {
    if (limit <= 0) return [];
    return this.#t.offers.find(await this.#offerFilter(filter), { sort: { updated_at: -1, id: -1 }, skip: offset, limit });
  }

  async countByStatus(filter: OfferListFilter): Promise<Record<string, number>> {
    const rows = await this.#t.offers.aggregate<{ _id: string; n: number }>([{ $match: this.#t.offers.filter(await this.#offerFilter(filter)) }, { $group: { _id: '$status', n: { $sum: 1 } } }]);
    return Object.fromEntries(rows.map((r) => [r._id, r.n]));
  }

  /** Offers that are or were featured in any zone */
  async featuredOfferIds(offerIds: readonly string[]): Promise<Set<string>> {
    if (!offerIds.length) return new Set();
    return new Set(await this.#t.featured.distinct<string>('offer_id', { offer_id: oneOf(offerIds) }));
  }

  /* ---------------------------------------------------------------- price changes */

  async listPriceChanges(f: { states?: string[]; offerId?: string; ownerType?: 'official' | 'seller'; sellerId?: string }, page: PageRequest): Promise<common.Page<PriceChangeRec>> {
    const and: Filter[] = [];
    if (f.states?.length) and.push({ state: oneOf(f.states) });
    if (f.offerId) and.push({ offer_id: f.offerId });
    if (f.ownerType || f.sellerId) {
      const ids = await this.#t.offers.distinct<string>('id', { ...(f.ownerType ? { owner_type: f.ownerType } : {}), ...(f.sellerId ? { seller_id: f.sellerId } : {}) });
      and.push({ offer_id: oneOf(ids) });
    }
    return this.#t.priceChanges.page(and.length ? { $and: and } : {}, page, { column: 'created_at', direction: 'desc' });
  }

  /* ---------------------------------------------------------------- eligibility */

  async getEligibility(offerIds: readonly string[]): Promise<EligibilityRec[]> {
    if (!offerIds.length) return [];
    return this.#t.eligibility.find({ offer_id: oneOf(offerIds) });
  }

  /** One round trip for all the rows (insert or replace by offer id) */
  async upsertEligibility(rows: readonly EligibilityRec[]): Promise<void> {
    await this.#t.eligibility.upsertMany(rows.map(definedOnly));
  }

  /* ---------------------------------------------------------------- featured decisions */

  getFeatured(variantId: string, group: string, zoneKey: string): Promise<FeaturedRec | undefined> {
    return this.#t.featured.findOne({ variant_id: variantId, condition_group: group, zone_key: zoneKey });
  }

  /** The cached decisions of these variants in one condition group and zone */
  async featuredFor(variantIds: readonly string[], group: string, zoneKey: string): Promise<FeaturedRec[]> {
    if (!variantIds.length) return [];
    return this.#t.featured.find({ variant_id: oneOf(variantIds), condition_group: group, zone_key: zoneKey });
  }

  async upsertFeatured(row: FeaturedRec): Promise<void> {
    await this.#t.featured.upsert(definedOnly(row), { key: ['variant_id', 'condition_group', 'zone_key'] });
  }

  async markFeaturedDirty(w: { variantIds?: readonly string[]; productIds?: readonly string[]; all?: boolean; olderThan?: Date; ruleVersionNot?: number }): Promise<number> {
    if (w.all) return this.#t.featured.updateMany({ dirty: false }, { dirty: true });
    const or: Filter[] = [];
    if (w.variantIds?.length) or.push({ variant_id: oneOf(w.variantIds) });
    if (w.productIds?.length) or.push({ product_id: oneOf(w.productIds) });
    if (w.olderThan) or.push({ computed_at: { $lt: w.olderThan } });
    if (w.ruleVersionNot !== undefined) or.push({ rule_version: { $nin: [w.ruleVersionNot, null] } });
    if (!or.length) return 0;
    return this.#t.featured.updateMany({ $or: or, dirty: false }, { dirty: true });
  }

  dirtyFeatured(limit: number): Promise<FeaturedRec[]> {
    return this.#t.featured.find({ dirty: true }, { sort: { computed_at: 1 }, limit });
  }

  /* ---------------------------------------------------------------- rules */

  rules(): Promise<RuleRec[]> {
    return this.#t.rules.find({}, { sort: { version: 1 } });
  }

  /* ---------------------------------------------------------------- unit costs */

  /**
   * One offer's cost rows, newest effective_from first. Ids are time-ordered (newId), so the id tie-break of the
   * keyset puts the later saved row first among rows of the same day, as created_at would.
   */
  costHistory(offerId: string, page: PageRequest): Promise<common.Page<CostRec>> {
    return this.#t.costs.page({ offer_id: offerId }, page, { column: 'effective_from', direction: 'desc' });
  }

  /**
   * Every cost row of these offers that starts on or before `upTo` (a market day), per offer newest first
   * (effective_from, then created_at, then id): the first row of an offer on or before a day is its cost for that
   * day. One query, whatever the number of offers.
   */
  async costsUpTo(offerIds: readonly string[], upTo: string): Promise<CostRec[]> {
    if (!offerIds.length) return [];
    return this.#t.costs.find({ offer_id: oneOf(offerIds), effective_from: { $lte: upTo } }, { sort: { offer_id: 1, effective_from: -1, created_at: -1, id: -1 } });
  }

  /* ---------------------------------------------------------------- bulk */

  listBulkJobs(f: { ownerType: 'official' | 'seller'; sellerId?: string }, page: PageRequest): Promise<common.Page<BulkJobRec>> {
    return this.#t.bulkJobs.page({ owner_type: f.ownerType, ...(f.sellerId ? { seller_id: f.sellerId } : {}) }, page, { column: 'uploaded_at', direction: 'desc' });
  }

  bulkRows(jobId: string, result: string | undefined, page: PageRequest): Promise<common.Page<BulkRowRec>> {
    return this.#t.bulkRows.page({ job_id: jobId, ...(result ? { result } : {}) }, page, { column: 'row_no', direction: 'asc', id: 'row_no' });
  }

  /** The same patch on many rows of a job, in one update */
  async markBulkRows(jobId: string, rowNos: readonly number[], patch: Partial<BulkRowRec>): Promise<void> {
    if (rowNos.length) await this.#t.bulkRows.updateMany({ job_id: jobId, row_no: oneOf(rowNos) }, definedOnly(patch));
  }

  async updateBulkRow(jobId: string, rowNo: number, patch: Partial<BulkRowRec>): Promise<void> {
    const values = definedOnly(patch);
    if (!Object.keys(values).length) return;
    await this.#t.bulkRows.updateMany({ job_id: jobId, row_no: rowNo }, values);
  }
}
