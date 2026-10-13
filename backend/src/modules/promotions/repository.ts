import type { ModuleStore } from '../../kernel/mongo/index.js';
import type { Filter, Table as Collection } from '../../kernel/mongo/table.js';
import type { CampaignRec, CodeRec, CostTotals, Db, FlashItemRec, PromotionsRepository, Table, Where } from './ports.js';

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const upperAll = (codes: readonly string[]) => [...new Set(codes.map((c) => c.trim().toUpperCase()).filter(Boolean))];
/** The collation of coupon_codes' unique code index: codes compare case-insensitively, as upper(code) did */
const CODE_COLLATION = { locale: 'en', strength: 2 } as const;
const NOTHING: Filter = { $expr: false };

const isOp = (v: unknown): v is { op: string; value: unknown } => typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date) && 'op' in v;
const COMPARE: Record<string, string> = { '<': '$lt', '<=': '$lte', '>': '$gt', '>=': '$gte' };

/** A Where (value, list, null or operator per column) as a filter, with SQL's meaning of null kept */
function toFilter(where: Record<string, unknown>): Filter {
  const and: Filter[] = [];
  for (const [k, v] of Object.entries(where)) {
    if (v === undefined) continue;
    if (v === null) and.push({ [k]: null });
    else if (Array.isArray(v)) and.push({ [k]: { $in: [...new Set(v)] } });
    else if (isOp(v)) {
      if (v.op === 'is not') and.push({ [k]: { $ne: v.value } });
      // comparisons with null are never true in SQL; `col <> x` skips rows where col is null
      else if (v.value === null) and.push(NOTHING);
      else if (v.op === '<>') and.push({ [k]: { $nin: [v.value, null] } });
      else and.push({ [k]: { [COMPARE[v.op]!]: v.value } });
    } else and.push({ [k]: v });
  }
  return and.length === 0 ? {} : and.length === 1 ? and[0]! : { $and: and };
}

/** MongoDB adapter for PromotionsRepository (docs/04-mongodb-migration.md): one collection per spec table. */
export function createMongoPromotionsRepository(store: ModuleStore): PromotionsRepository {
  const t = <T extends Table>(table: T) => store.table<Db[T]>(table) as Collection<Db[T]>;
  /** The unique key insertIgnore is "on conflict do nothing" on: the table's unique index, else its primary key */
  const conflictKey = (table: Table): readonly string[] => {
    const def = store.collections[table]!;
    const unique = (def.indexes as readonly { key: Record<string, number>; unique?: boolean; partial?: unknown }[]).find((i) => i.unique && !i.partial);
    return unique ? Object.keys(unique.key) : def.idField ? [def.idField] : def.key;
  };
  const codes = t('coupon_codes');
  /** coupon_codes rows matching codes case-insensitively (through the code index's collation) */
  const codesLike = async (filter: Filter, sort?: Record<string, 1 | -1>): Promise<CodeRec[]> => {
    const docs = await codes.model
      .find(codes.filter(filter), null, { session: codes.session ?? null, lean: true, ...(sort ? { sort } : {}) })
      .collation(CODE_COLLATION);
    return (docs as Record<string, unknown>[]).map((d) => codes.fromDoc(d));
  };
  const campaigns = t('campaigns');
  const flash = t('flash_items');
  const redemptions = t('redemptions');

  const repo: PromotionsRepository = {
    transaction: (fn) => store.transaction((tx) => fn(createMongoPromotionsRepository(tx))),
    claim: (key) => store.claim(key),

    /* ---------------------------------------------------------------- generic */
    get: (table, id, o) => t(table).get(id, { forUpdate: o?.forUpdate }),
    getMany: (table, ids) => t(table).getMany([...new Set(ids)]),
    find: (table, where, o) =>
      t(table).find(toFilter(where as Record<string, unknown>), {
        sort: o?.orderBy?.length ? Object.fromEntries(o.orderBy.map(([c, dir]) => [c, dir === 'desc' ? -1 : 1])) : undefined,
        limit: o?.limit,
        skip: o?.offset,
        forUpdate: o?.forUpdate,
      }),
    async findOne(table, where, o) {
      return (await repo.find(table, where, { ...o, limit: 1 }))[0];
    },
    count: (table, where) => t(table).count(toFilter(where as Record<string, unknown>)),
    insert: (table, row) => t(table).insert(row),
    async insertMany(table, rows) {
      for (let i = 0; i < rows.length; i += 500) await t(table).insertMany(rows.slice(i, i + 500));
    },
    async insertIgnore(table, row) {
      return Boolean(await t(table).insertIfAbsent(row, conflictKey(table)));
    },
    async update(table, id, patch) {
      const values = Object.fromEntries(Object.entries(patch as Record<string, unknown>).filter(([, v]) => v !== undefined));
      if (!Object.keys(values).length) return (await repo.get(table, id))!;
      const row = await t(table).update(id, values);
      if (!row) throw new Error(`promotions: ${table} ${id} not found`);
      return row;
    },
    async updateWhere(table, where, patch) {
      const values = Object.fromEntries(Object.entries(patch as Record<string, unknown>).filter(([, v]) => v !== undefined));
      if (!Object.keys(values).length) return 0;
      return t(table).updateMany(toFilter(where as Record<string, unknown>), values);
    },
    removeWhere: (table, where) => t(table).deleteMany(toFilter(where as Record<string, unknown>)),
    page: (table, where, page, order) => t(table).page(toFilter(where as Record<string, unknown>), page, order),

    /* ---------------------------------------------------------------- campaigns */
    async listCampaigns(f, page) {
      const and: Filter[] = [];
      if (f.q?.trim()) {
        const term = { $regex: escapeRegExp(f.q.trim()), $options: 'i' };
        const withCode = await codes.distinct<string>('campaign_id', { code: term });
        and.push({ $or: [{ name: term }, { ref: term }, { id: { $in: withCode } }] });
      }
      if (f.statuses?.length) and.push({ status: { $in: f.statuses } });
      if (f.kind) and.push({ kind: f.kind });
      if (f.fundingOwner) and.push({ funding_owner: f.fundingOwner });
      if (f.ownerKind) and.push({ owner_kind: f.ownerKind });
      if (f.sellerId) and.push({ seller_id: f.sellerId });
      return campaigns.page(and.length ? { $and: and } : {}, page, { column: 'created_at', direction: 'desc' });
    },
    runningCampaigns: (at, o) =>
      campaigns.find(
        {
          status: { $in: ['scheduled', 'live'] },
          starts_at: { $lte: at },
          ends_at: { $gt: at },
          ...(o?.kinds?.length ? { kind: { $in: o.kinds } } : {}),
          ...(o?.ownerKind ? { owner_kind: o.ownerKind } : {}),
          ...(o?.sellerIds ? { seller_id: { $in: o.sellerIds } } : {}),
        },
        { sort: { ends_at: 1, id: 1 } },
      ),
    async eligibleFor(offerIds, campaignIds) {
      if (!offerIds.length || !campaignIds.length) return [];
      return t('eligible_offers').find({ offer_id: { $in: [...new Set(offerIds)] }, campaign_id: { $in: [...new Set(campaignIds)] }, eligible: true });
    },
    async activeCodes(list) {
      const upper = upperAll(list);
      return upper.length ? codesLike({ active: true, code: { $in: upper } }) : [];
    },
    async anyCodes(list) {
      const upper = upperAll(list);
      return upper.length ? codesLike({ code: { $in: upper } }, { created_at: -1 }) : [];
    },
    async codeTaken(code, exceptCampaignId) {
      const rows = await codesLike({ active: true, code: code.trim().toUpperCase(), ...(exceptCampaignId ? { campaign_id: { $ne: exceptCampaignId } } : {}) });
      if (!rows.length) return false;
      return campaigns.exists({ id: { $in: [...new Set(rows.map((r) => r.campaign_id))] }, status: { $nin: ['ended', 'cancelled'] } });
    },
    async costTotals(campaignIds) {
      const out = new Map<string, CostTotals>();
      if (!campaignIds.length) return out;
      const rows = await redemptions.aggregate<{ _id: string; total: number; platform: number; redemptions: number; orders: (string | null)[] }>([
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
    },
    async heldAmounts(campaignIds) {
      const out = new Map<string, number>();
      if (!campaignIds.length) return out;
      const rows = await redemptions.aggregate<{ _id: string; held: number }>([
        { $match: { campaign_id: { $in: [...new Set(campaignIds)] }, state: 'reserved' } },
        { $group: { _id: '$campaign_id', held: { $sum: '$amount' } } },
      ]);
      for (const r of rows) out.set(r._id, Number(r.held));
      return out;
    },

    /* ---------------------------------------------------------------- atomic counters (conditional single-document updates) */
    async addCampaignUsage(campaignId, amount, uses) {
      const done = await campaigns.updateOne(
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
      const row: CampaignRec | undefined = await campaigns.get(campaignId);
      if (!row) return 'missing';
      if (row.budget_amount !== null && row.budget_used + amount > row.budget_amount) return 'budget';
      return 'usage';
    },
    async subtractCampaignUsage(campaignId, amount, uses) {
      await campaigns.updateOne({ id: campaignId }, [
        { $set: { budget_used: { $max: [{ $subtract: ['$budget_used', amount] }, 0] }, usage_count: { $max: [{ $subtract: ['$usage_count', uses] }, 0] } } },
      ]);
    },
    async addCustomerUsage(campaignId, customerKey, uses, units, limits) {
      const counters = t('usage_counters');
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
    },
    async subtractCustomerUsage(campaignId, customerKey, uses, units) {
      await t('usage_counters').updateOne({ campaign_id: campaignId, customer_key: customerKey }, [
        { $set: { uses: { $max: [{ $subtract: ['$uses', uses] }, 0] }, units: { $max: [{ $subtract: ['$units', units] }, 0] } } },
      ]);
    },
    async addCodeRedemption(codeId) {
      const done = await codes.updateOne(
        { id: codeId, active: true, $or: [{ max_redemptions: null }, { $expr: { $lte: [{ $add: ['$redemptions', 1] }, '$max_redemptions'] } }] },
        { $inc: { redemptions: 1 } },
      );
      return Boolean(done);
    },
    async subtractCodeRedemption(codeId) {
      await codes.updateOne({ id: codeId }, [{ $set: { redemptions: { $max: [{ $subtract: ['$redemptions', 1] }, 0] } } }]);
    },
    reserveDealStock: (campaignId, offerId, qty): Promise<FlashItemRec | undefined> =>
      flash.updateOne({ campaign_id: campaignId, offer_id: offerId, state: 'active', $expr: { $lte: [{ $add: ['$claimed', '$reserved', qty] }, '$deal_stock'] } }, { $inc: { reserved: qty } }),
    releaseDealStock: (campaignId, offerId, qty) => flash.updateOne({ campaign_id: campaignId, offer_id: offerId }, [{ $set: { reserved: { $max: [{ $subtract: ['$reserved', qty] }, 0] } } }]),
    claimDealStock: (campaignId, offerId, qty) =>
      flash.updateOne({ campaign_id: campaignId, offer_id: offerId }, [{ $set: { reserved: { $max: [{ $subtract: ['$reserved', qty] }, 0] }, claimed: { $add: ['$claimed', qty] } } }]),
    unclaimDealStock: (campaignId, offerId, qty) => flash.updateOne({ campaign_id: campaignId, offer_id: offerId }, [{ $set: { claimed: { $max: [{ $subtract: ['$claimed', qty] }, 0] } } }]),

    /* ---------------------------------------------------------------- jobs and read models */
    async expiredReservations(now, limit) {
      const rows = await redemptions.aggregate<{ _id: string }>([{ $match: { state: 'reserved', expires_at: { $lt: now } } }, { $group: { _id: '$reservation_id' } }, { $limit: limit }]);
      return rows.map((r) => r._id);
    },
    async deleteStaleEvaluations(before, limit) {
      // evaluations past their validity that no redemption points at, at most `limit`
      const evaluations = t('evaluations');
      let deleted = 0;
      let after: string | null = null;
      while (deleted < limit) {
        const batch: { id: string }[] = await evaluations.find({ valid_until: { $lt: before }, ...(after ? { id: { $gt: after } } : {}) }, { sort: { id: 1 }, limit: Math.max(limit, 100) });
        if (!batch.length) break;
        after = batch.at(-1)!.id;
        const ids = batch.map((e) => e.id);
        const used = new Set(await redemptions.distinct<string>('evaluation_id', { evaluation_id: { $in: ids } }));
        const stale = ids.filter((id) => !used.has(id)).slice(0, limit - deleted);
        if (stale.length) deleted += await evaluations.deleteMany({ id: { $in: stale } });
        if (batch.length < Math.max(limit, 100)) break;
      }
      return deleted;
    },
    async resultFacts(campaignId) {
      const reds = await redemptions.find({ campaign_id: campaignId, state: { $in: ['committed', 'partially_reversed', 'reversed'] } });
      if (!reds.length) return [];
      const lines = await t('redemption_lines').find({ redemption_id: { $in: reds.map((r) => r.id) } });
      const evals = await t('evaluations').getMany([...new Set(reds.map((r) => r.evaluation_id))]);
      const evalById = new Map(evals.map((e) => [e.id, e.result as unknown]));
      return reds.map((r) => ({ redemption: r, lines: lines.filter((l) => l.redemption_id === r.id), evaluation: evalById.get(r.evaluation_id) ?? null }));
    },
    resultsInRange: (from, to, campaignIds) =>
      t('campaign_results_daily').find({ day: { $gte: from, $lte: to }, ...(campaignIds ? { campaign_id: { $in: [...campaignIds] } } : {}) }, { sort: { day: 1 } }),
    async upsertResult(row) {
      await t('campaign_results_daily').upsert(row, { key: ['campaign_id', 'day'] });
    },
  };
  return repo;
}
