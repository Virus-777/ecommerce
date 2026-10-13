import { orThrow } from '../../kernel/lib/or-throw.js';
import type { PageRequest } from '../../kernel/lib/pagination.js';
import { CASE_INSENSITIVE, contains, whereFilter, type Filter, type ModuleStore, type Table as Collection, type Where } from '../../kernel/mongo/index.js';
import type * as common from '../../spec/common.js';
import type { CampaignListFilter, CampaignRec, CodeRec, CostTotals, CounterResult, Db, EligibleRec, FindOptions, FlashItemRec, IdTable, RedemptionLineRec, RedemptionRec, ResultRec, Table } from './ports.js';

const upperAll = (codes: readonly string[]) => [...new Set(codes.map((c) => c.trim().toUpperCase()).filter(Boolean))];

/** The promotions module's collections (MongoDB, docs/04-mongodb-migration.md): one per spec table. */
export class PromotionsRepository {
  readonly #codes;
  readonly #campaigns;
  readonly #flash;
  readonly #redemptions;

  constructor(private readonly store: ModuleStore) {
    this.#codes = this.#t('coupon_codes');
    this.#campaigns = this.#t('campaigns');
    this.#flash = this.#t('flash_items');
    this.#redemptions = this.#t('redemptions');
  }

  /** fn with a repository bound to one transaction */
  transaction<T>(fn: (tx: PromotionsRepository) => Promise<T>): Promise<T> {
    return this.store.transaction((tx) => fn(new PromotionsRepository(tx)));
  }

  /** Inbox (ctx.mongo.claim): true the first time this key is claimed; inside a transaction it commits with the effects */
  claim(key: string): Promise<boolean> {
    return this.store.claim(key);
  }

  /* ---------------------------------------------------------------- generic */
  get<T extends IdTable>(table: T, id: string, o?: { forUpdate?: boolean }): Promise<Db[T] | undefined> {
    return this.#t(table).get(id, { forUpdate: o?.forUpdate });
  }

  getMany<T extends IdTable>(table: T, ids: readonly string[]): Promise<Db[T][]> {
    return this.#t(table).getMany([...new Set(ids)]);
  }

  find<T extends Table>(table: T, where: Where<Db[T]>, o?: FindOptions<Db[T]>): Promise<Db[T][]> {
    return this.#t(table).find(whereFilter(where), {
      sort: o?.orderBy?.length ? Object.fromEntries(o.orderBy.map(([c, dir]) => [c, dir === 'desc' ? -1 : 1])) : undefined,
      limit: o?.limit,
      skip: o?.offset,
      forUpdate: o?.forUpdate,
    });
  }

  async findOne<T extends Table>(table: T, where: Where<Db[T]>, o?: FindOptions<Db[T]>): Promise<Db[T] | undefined> {
    return (await this.find(table, where, { ...o, limit: 1 }))[0];
  }

  count<T extends Table>(table: T, where: Where<Db[T]>): Promise<number> {
    return this.#t(table).count(whereFilter(where));
  }

  insert<T extends Table>(table: T, row: Db[T]): Promise<Db[T]> {
    return this.#t(table).insert(row);
  }

  async insertMany<T extends Table>(table: T, rows: Db[T][]): Promise<void> {
    for (let i = 0; i < rows.length; i += 500) await this.#t(table).insertMany(rows.slice(i, i + 500));
  }

  /** Insert unless a row with the same unique key exists; true when inserted */
  async insertIfAbsent<T extends Table>(table: T, row: Db[T]): Promise<boolean> {
    return Boolean(await this.#t(table).insertIfAbsent(row));
  }

  async update<T extends IdTable>(table: T, id: string, patch: Partial<Db[T]>): Promise<Db[T]> {
    const values = Object.fromEntries(Object.entries(patch as Record<string, unknown>).filter(([, v]) => v !== undefined));
    if (!Object.keys(values).length) return (await this.get(table, id))!;
    return orThrow(await this.#t(table).update(id, values), `promotions: ${table} ${id}`);
  }

  async updateWhere<T extends Table>(table: T, where: Where<Db[T]>, patch: Partial<Db[T]>): Promise<number> {
    const values = Object.fromEntries(Object.entries(patch as Record<string, unknown>).filter(([, v]) => v !== undefined));
    if (!Object.keys(values).length) return 0;
    return this.#t(table).updateMany(whereFilter(where), values);
  }

  removeWhere<T extends Table>(table: T, where: Where<Db[T]>): Promise<number> {
    return this.#t(table).deleteMany(whereFilter(where));
  }

  page<T extends Table>(table: T, where: Where<Db[T]>, page: PageRequest, order: { column: keyof Db[T] & string; direction: 'asc' | 'desc'; id?: string }): Promise<common.Page<Db[T]>> {
    return this.#t(table).page(whereFilter(where), page, order);
  }

  /* ---------------------------------------------------------------- campaigns */
  async listCampaigns(f: CampaignListFilter, page: PageRequest): Promise<common.Page<CampaignRec>> {
    const and: Filter[] = [];
    if (f.q?.trim()) {
      const term = contains(f.q);
      const withCode = await this.#codes.distinct<string>('campaign_id', { code: term });
      and.push({ $or: [{ name: term }, { ref: term }, { id: { $in: withCode } }] });
    }
    if (f.statuses?.length) and.push({ status: { $in: f.statuses } });
    if (f.kind) and.push({ kind: f.kind });
    if (f.fundingOwner) and.push({ funding_owner: f.fundingOwner });
    if (f.ownerKind) and.push({ owner_kind: f.ownerKind });
    if (f.sellerId) and.push({ seller_id: f.sellerId });
    return this.#campaigns.page(and.length ? { $and: and } : {}, page, { column: 'created_at', direction: 'desc' });
  }

  /** Campaigns that may apply at `at`: scheduled or live with the period covering `at` */
  runningCampaigns(at: Date, o?: { kinds?: string[]; ownerKind?: 'platform' | 'seller'; sellerIds?: string[] }): Promise<CampaignRec[]> {
    return this.#campaigns.find(
      {
        status: { $in: ['scheduled', 'live'] },
        starts_at: { $lte: at },
        ends_at: { $gt: at },
        ...(o?.kinds?.length ? { kind: { $in: o.kinds } } : {}),
        ...(o?.ownerKind ? { owner_kind: o.ownerKind } : {}),
        ...(o?.sellerIds ? { seller_id: { $in: o.sellerIds } } : {}),
      },
      { sort: { ends_at: 1, id: 1 } },
    );
  }

  /** Campaign ids among `campaignIds` whose eligible offers include each offer */
  async eligibleFor(offerIds: readonly string[], campaignIds: readonly string[]): Promise<EligibleRec[]> {
    if (!offerIds.length || !campaignIds.length) return [];
    return this.#t('eligible_offers').find({ offer_id: { $in: [...new Set(offerIds)] }, campaign_id: { $in: [...new Set(campaignIds)] }, eligible: true });
  }

  /** Active code rows by case-insensitive code */
  async activeCodes(list: readonly string[]): Promise<CodeRec[]> {
    const upper = upperAll(list);
    return upper.length ? this.#codesLike({ active: true, code: { $in: upper } }) : [];
  }

  /** Latest code rows by case-insensitive code, active or not */
  async anyCodes(list: readonly string[]): Promise<CodeRec[]> {
    const upper = upperAll(list);
    return upper.length ? this.#codesLike({ code: { $in: upper } }, { created_at: -1 }) : [];
  }

  async codeTaken(code: string, exceptCampaignId: string | null): Promise<boolean> {
    const rows = await this.#codesLike({ active: true, code: code.trim().toUpperCase(), ...(exceptCampaignId ? { campaign_id: { $ne: exceptCampaignId } } : {}) });
    if (!rows.length) return false;
    return this.#campaigns.exists({ id: { $in: [...new Set(rows.map((r) => r.campaign_id))] }, status: { $nin: ['ended', 'cancelled'] } });
  }

  async costTotals(campaignIds: readonly string[]): Promise<Map<string, CostTotals>> {
    const out = new Map<string, CostTotals>();
    if (!campaignIds.length) return out;
    const rows = await this.#redemptions.aggregate<{ _id: string; total: number; platform: number; redemptions: number; orders: (string | null)[] }>([
      { $match: { campaign_id: { $in: [...new Set(campaignIds)] }, state: { $in: ['committed', 'partially_reversed', 'reversed'] } } },
      {
        $group: {
          _id: '$campaign_id',
          total: { $sum: { $subtract: ['$amount', '$reversed'] } },
          // platform_part - round(reversed * platform_part / amount), halves away from zero (values are >= 0)
          platform: {
            $sum: {
              $subtract: ['$platform_part', { $cond: [{ $eq: ['$amount', 0] }, 0, { $floor: { $add: [{ $divide: [{ $multiply: ['$reversed', '$platform_part'] }, '$amount'] }, 0.5] } }] }],
            },
          },
          redemptions: { $sum: { $cond: [{ $in: ['$state', ['committed', 'partially_reversed']] }, 1, 0] } },
          orders: { $addToSet: '$order_id' },
        },
      },
    ]);
    for (const r of rows) {
      const total = Number(r.total);
      const platform = Number(r.platform);
      // count(distinct order_id) skips nulls
      out.set(r._id, { total, platform, seller: total - platform, redemptions: Number(r.redemptions), orders: r.orders.filter((o) => o !== null).length });
    }
    return out;
  }

  /** Discount still held by open reservations per campaign */
  async heldAmounts(campaignIds: readonly string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!campaignIds.length) return out;
    const rows = await this.#redemptions.aggregate<{ _id: string; held: number }>([
      { $match: { campaign_id: { $in: [...new Set(campaignIds)] }, state: 'reserved' } },
      { $group: { _id: '$campaign_id', held: { $sum: '$amount' } } },
    ]);
    for (const r of rows) out.set(r._id, Number(r.held));
    return out;
  }

  /* ---------------------------------------------------------------- atomic counters (conditional single-document updates) */
  /** budget_used += amount, usage_count += uses, only when the budget and usage cap allow it */
  async addCampaignUsage(campaignId: string, amount: number, uses: number): Promise<CounterResult> {
    const done = await this.#campaigns.updateOne(
      {
        id: campaignId,
        $and: [
          { $or: [{ budget_amount: null }, { $expr: { $lte: [{ $add: ['$budget_used', amount] }, '$budget_amount'] } }] },
          { $or: [{ usage_cap: null }, { $expr: { $lte: [{ $add: ['$usage_count', uses] }, '$usage_cap'] } }] },
        ],
      },
      { $inc: { budget_used: amount, usage_count: uses } },
    );
    if (done) return 'ok';
    const row: CampaignRec | undefined = await this.#campaigns.get(campaignId);
    if (!row) return 'missing';
    if (row.budget_amount !== null && row.budget_used + amount > row.budget_amount) return 'budget';
    return 'usage';
  }

  /** Gives budget and/or uses back (never below zero) */
  async subtractCampaignUsage(campaignId: string, amount: number, uses: number): Promise<void> {
    await this.#campaigns.updateOne({ id: campaignId }, [
      { $set: { budget_used: { $max: [{ $subtract: ['$budget_used', amount] }, 0] }, usage_count: { $max: [{ $subtract: ['$usage_count', uses] }, 0] } } },
    ]);
  }

  /** Per-customer uses and units, created on first use; refused above the limits */
  async addCustomerUsage(campaignId: string, customerKey: string, uses: number, units: number, limits: { perCustomer: number | null; perCustomerUnits: number | null }): Promise<'ok' | 'uses' | 'units'> {
    const counters = this.#t('usage_counters');
    const key = { campaign_id: campaignId, customer_key: customerKey };
    await counters.insertIfAbsent({ ...key, uses: 0, units: 0 }, ['campaign_id', 'customer_key']);
    const done = await counters.updateOne(
      {
        ...key,
        ...(limits.perCustomer !== null || limits.perCustomerUnits !== null
          ? {
              $expr: {
                $and: [
                  ...(limits.perCustomer !== null ? [{ $lte: [{ $add: ['$uses', uses] }, limits.perCustomer] }] : []),
                  ...(limits.perCustomerUnits !== null ? [{ $lte: [{ $add: ['$units', units] }, limits.perCustomerUnits] }] : []),
                ],
              },
            }
          : {}),
      },
      { $inc: { uses, units } },
    );
    if (done) return 'ok';
    const row = await counters.findOne(key);
    if (limits.perCustomer !== null && row && row.uses + uses > limits.perCustomer) return 'uses';
    return 'units';
  }

  async subtractCustomerUsage(campaignId: string, customerKey: string, uses: number, units: number): Promise<void> {
    await this.#t('usage_counters').updateOne({ campaign_id: campaignId, customer_key: customerKey }, [
      { $set: { uses: { $max: [{ $subtract: ['$uses', uses] }, 0] }, units: { $max: [{ $subtract: ['$units', units] }, 0] } } },
    ]);
  }

  async addCodeRedemption(codeId: string): Promise<boolean> {
    const done = await this.#codes.updateOne(
      { id: codeId, active: true, $or: [{ max_redemptions: null }, { $expr: { $lte: [{ $add: ['$redemptions', 1] }, '$max_redemptions'] } }] },
      { $inc: { redemptions: 1 } },
    );
    return Boolean(done);
  }

  async subtractCodeRedemption(codeId: string): Promise<void> {
    await this.#codes.updateOne({ id: codeId }, [{ $set: { redemptions: { $max: [{ $subtract: ['$redemptions', 1] }, 0] } } }]);
  }

  /** reserved += qty when deal stock allows; returns the row after the change */
  reserveDealStock(campaignId: string, offerId: string, qty: number): Promise<FlashItemRec | undefined> {
    return this.#flash.updateOne({ campaign_id: campaignId, offer_id: offerId, state: 'active', $expr: { $lte: [{ $add: ['$claimed', '$reserved', qty] }, '$deal_stock'] } }, { $inc: { reserved: qty } });
  }

  /** reserved -= qty (release) */
  releaseDealStock(campaignId: string, offerId: string, qty: number): Promise<FlashItemRec | undefined> {
    return this.#flash.updateOne({ campaign_id: campaignId, offer_id: offerId }, [{ $set: { reserved: { $max: [{ $subtract: ['$reserved', qty] }, 0] } } }]);
  }

  /** reserved -= qty, claimed += qty (commit) */
  claimDealStock(campaignId: string, offerId: string, qty: number): Promise<FlashItemRec | undefined> {
    return this.#flash.updateOne({ campaign_id: campaignId, offer_id: offerId }, [{ $set: { reserved: { $max: [{ $subtract: ['$reserved', qty] }, 0] }, claimed: { $add: ['$claimed', qty] } } }]);
  }

  /** claimed -= qty (cancelled before dispatch) */
  unclaimDealStock(campaignId: string, offerId: string, qty: number): Promise<FlashItemRec | undefined> {
    return this.#flash.updateOne({ campaign_id: campaignId, offer_id: offerId }, [{ $set: { claimed: { $max: [{ $subtract: ['$claimed', qty] }, 0] } } }]);
  }

  /* ---------------------------------------------------------------- jobs and read models */
  async expiredReservations(now: Date, limit: number): Promise<string[]> {
    const rows = await this.#redemptions.aggregate<{ _id: string }>([{ $match: { state: 'reserved', expires_at: { $lt: now } } }, { $group: { _id: '$reservation_id' } }, { $limit: limit }]);
    return rows.map((r) => r._id);
  }

  async deleteStaleEvaluations(before: Date, limit: number): Promise<number> {
    // evaluations past their validity that no redemption points at, at most `limit`
    const evaluations = this.#t('evaluations');
    let deleted = 0;
    let after: string | null = null;
    while (deleted < limit) {
      const batch: { id: string }[] = await evaluations.find({ valid_until: { $lt: before }, ...(after ? { id: { $gt: after } } : {}) }, { sort: { id: 1 }, limit: Math.max(limit, 100) });
      if (!batch.length) break;
      after = batch.at(-1)!.id;
      const ids = batch.map((e) => e.id);
      const used = new Set(await this.#redemptions.distinct<string>('evaluation_id', { evaluation_id: { $in: ids } }));
      const stale = ids.filter((id) => !used.has(id)).slice(0, limit - deleted);
      if (stale.length) deleted += await evaluations.deleteMany({ id: { $in: stale } });
      if (batch.length < Math.max(limit, 100)) break;
    }
    return deleted;
  }

  /** Committed redemption lines of a campaign with the evaluation line they came from, for the results roll-up */
  async resultFacts(campaignId: string): Promise<{ redemption: RedemptionRec; lines: RedemptionLineRec[]; evaluation: unknown }[]> {
    const reds = await this.#redemptions.find({ campaign_id: campaignId, state: { $in: ['committed', 'partially_reversed', 'reversed'] } });
    if (!reds.length) return [];
    const lines = await this.#t('redemption_lines').find({ redemption_id: { $in: reds.map((r) => r.id) } });
    const evals = await this.#t('evaluations').getMany([...new Set(reds.map((r) => r.evaluation_id))]);
    const evalById = new Map(evals.map((e) => [e.id, e.result as unknown]));
    return reds.map((r) => ({ redemption: r, lines: lines.filter((l) => l.redemption_id === r.id), evaluation: evalById.get(r.evaluation_id) ?? null }));
  }

  resultsInRange(from: string, to: string, campaignIds?: readonly string[]): Promise<ResultRec[]> {
    return this.#t('campaign_results_daily').find({ day: { $gte: from, $lte: to }, ...(campaignIds ? { campaign_id: { $in: [...campaignIds] } } : {}) }, { sort: { day: 1 } });
  }

  async upsertResult(row: ResultRec): Promise<void> {
    await this.#t('campaign_results_daily').upsert(row, { key: ['campaign_id', 'day'] });
  }

  #t<T extends Table>(table: T) {
    return this.store.table<Db[T]>(table) as Collection<Db[T]>;
  }

  /** coupon_codes rows matching codes case-insensitively (the collation of the code index: codes compare as upper(code) did) */
  #codesLike(filter: Filter, sort?: Record<string, 1 | -1>): Promise<CodeRec[]> {
    return this.#codes.find(filter, { collation: CASE_INSENSITIVE, sort });
  }

}
