import type { ModuleStore } from '../../../../kernel/mongo/index.js';
import type { Filter, Table as MongoTable } from '../../../../kernel/mongo/table.js';
import type { Page } from '../../../../spec/common.js';
import type {
  AdvertisingRepository,
  ChargeRec,
  CreativeListFilter,
  EventRec,
  ItemRec,
  LogRec,
  StatRec,
  StatTotals,
  Table,
} from '../../ports.js';
import type { FrequencyRow } from '../../domain/rules.js';

const uniq = <T>(xs: readonly T[]) => [...new Set(xs)];
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** lower(col) like '%x%' (trimmed, any case) */
const containsAnyCase = (s: string) => ({ $regex: escapeRegExp(s.trim()), $options: 'i' });
/** A value inside an aggregation expression, never read as a field path or operator */
const lit = (v: unknown) => ({ $literal: v });

/** Unique keys an "insert unless it exists" checks (an existing row with the same key wins); default: the primary key */
const UNIQUE: Partial<Record<Table, readonly string[]>> = {
  placements: ['key'],
  campaign_creatives: ['campaign_id', 'creative_id'],
  frequency_state: ['visitor_key', 'campaign_id'],
  attributions: ['order_id', 'campaign_id'],
  daily_stats: ['campaign_id', 'day'],
  ad_charges: ['campaign_id', 'day'],
};

const isOp = (v: unknown): v is { op: string; value: unknown } => typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date) && 'op' in v;

/** A Where of the ports as a filter, with SQL's meaning (`<>` skips nulls, an empty list matches nothing) */
function where(w: Record<string, unknown>): Filter {
  const out: Filter = {};
  for (const [k, v] of Object.entries(w)) {
    if (v === undefined) continue;
    if (v === null) out[k] = null;
    else if (Array.isArray(v)) out[k] = { $in: v };
    else if (isOp(v)) {
      const { op, value } = v;
      if (op === 'is not') out[k] = { $ne: null };
      else if (op === '<>') out[k] = { $nin: [value, null] };
      else out[k] = { [op === '<' ? '$lt' : op === '<=' ? '$lte' : op === '>' ? '$gt' : '$gte']: value };
    } else out[k] = v;
  }
  return out;
}

const EMPTY_TOTALS = (): StatTotals => ({ displays: 0, clicks: 0, dismissals: 0, spend: 0, attributedOrders: 0, attributedSales: 0 });

/** MongoDB adapter for AdvertisingRepository (docs/04-mongodb-migration.md): one collection per spec table. */
export function createMongoAdvertisingRepository(store: ModuleStore): AdvertisingRepository {
  // generic table access: the row types are checked at the AdvertisingRepository boundary
  const t = (name: Table): MongoTable<any> => store.table(name);
  const campaigns = t('campaigns');
  const events = t('ad_events');
  const frequency = t('frequency_state');
  const stats = t('daily_stats');

  /** The creative filter; the search also matches the names and refs of the campaigns a creative is linked to (two reads) */
  async function creativeFilter(f: CreativeListFilter): Promise<Filter> {
    const c: Filter[] = [];
    if (f.q?.trim()) {
      const term = containsAnyCase(f.q);
      const linked = (await campaigns.find({ $or: [{ name: term }, { ref: term }] })).map((r) => r.id as string);
      const creativeIds = linked.length ? await t('campaign_creatives').distinct<string>('creative_id', { campaign_id: { $in: linked } }) : [];
      c.push({ $or: [{ file_name: term }, { headline: term }, ...(creativeIds.length ? [{ id: { $in: creativeIds } }] : [])] });
    }
    if (f.status) c.push({ status: f.status });
    if (f.advertiserKinds) c.push({ advertiser_kind: { $in: f.advertiserKinds } });
    if (f.placementKey) c.push({ placement_key: f.placementKey });
    if (f.kind) c.push({ kind: f.kind });
    if (f.linkCheck) c.push({ 'link_check.state': f.linkCheck });
    if (f.sellerId) c.push({ seller_id: f.sellerId });
    return c.length ? { $and: c } : {};
  }

  const repo: AdvertisingRepository = {
    transaction: (fn) => store.transaction((tx) => fn(createMongoAdvertisingRepository(tx))),
    claim: (key) => store.claim(key),

    /* ---------------------------------------------------------------- generic */
    get: (table, id, o) => t(table).get(id, o),
    getMany: (table, ids) => t(table).getMany(uniq(ids)),
    find: (table, w, o) =>
      t(table).find(where(w as Record<string, unknown>), {
        ...(o?.orderBy?.length ? { sort: Object.fromEntries(o.orderBy.map(([c, d]) => [c, d === 'desc' ? -1 : 1])) } : {}),
        ...(o?.limit ? { limit: o.limit } : {}),
        ...(o?.offset ? { skip: o.offset } : {}),
        ...(o?.forUpdate ? { forUpdate: true } : {}),
      }),
    async findOne(table, w, o) {
      return (await repo.find(table, w, { ...o, limit: 1 }))[0];
    },
    count: (table, w) => t(table).count(where(w as Record<string, unknown>)),
    insert: (table, row) => t(table).insert(row as Record<string, unknown>),
    async insertIgnore(table, row) {
      const tbl = t(table);
      const key = UNIQUE[table] ?? (tbl.def.idField ? [tbl.def.idField] : tbl.def.key);
      return Boolean(await tbl.insertIfAbsent(row as Record<string, unknown>, key));
    },
    async update(table, id, patch) {
      const values = Object.fromEntries(Object.entries(patch as Record<string, unknown>).filter(([, v]) => v !== undefined));
      if (!Object.keys(values).length) return (await repo.get(table, id))!;
      const row = await t(table).update(id, values);
      if (!row) throw new Error(`advertising: ${table} ${id} not found`);
      return row;
    },
    async updateWhere(table, w, patch) {
      const values = Object.fromEntries(Object.entries(patch as Record<string, unknown>).filter(([, v]) => v !== undefined));
      if (!Object.keys(values).length) return 0;
      return t(table).updateMany(where(w as Record<string, unknown>), values);
    },
    removeWhere: (table, w) => t(table).deleteMany(where(w as Record<string, unknown>)),
    page: (table, w, page, order) => t(table).page(where(w as Record<string, unknown>), page, order) as never,

    /* ---------------------------------------------------------------- rules */
    async maxRulesVersion() {
      const top = await t('global_rules').findOne({}, { sort: { version: -1 } });
      return (top?.version as number | undefined) ?? 0;
    },

    /* ---------------------------------------------------------------- campaigns and creatives */
    listCampaigns(f, page) {
      const c: Filter[] = [];
      if (f.q?.trim()) {
        const term = containsAnyCase(f.q);
        c.push({ $or: [{ name: term }, { ref: term }] });
      }
      if (f.advertiserKinds) c.push({ advertiser_kind: { $in: f.advertiserKinds } });
      if (f.placementId) c.push({ placement_id: f.placementId });
      if (f.statuses?.length) c.push({ status: { $in: f.statuses } });
      if (f.linkedPromotionId) c.push({ linked_promotion_id: f.linkedPromotionId });
      if (f.sellerId) c.push({ seller_id: f.sellerId });
      if (f.origin) c.push({ origin: f.origin });
      return campaigns.page(c.length ? { $and: c } : {}, page, { column: 'created_at', direction: 'desc' });
    },
    async listCreatives(f, page) {
      return t('creatives').page(await creativeFilter(f), page, { column: 'created_at', direction: 'desc' });
    },
    async creativeCounts(f) {
      const creatives = t('creatives');
      const rows = await creatives.aggregate<{ _id: string; n: number }>([{ $match: creatives.filter(await creativeFilter({ ...f, status: undefined })) }, { $group: { _id: '$status', n: { $sum: 1 } } }]);
      return Object.fromEntries(rows.map((r) => [r._id, r.n]));
    },
    liveCampaigns: (at) => campaigns.find({ status: 'live', starts_at: { $lte: at }, ends_at: { $gt: at } }, { sort: { id: 1 } }),
    async lastLogs(campaignIds, actions) {
      const out = new Map<string, LogRec>();
      if (!campaignIds.length || !actions.length) return out;
      const log = t('campaign_log');
      const rows = await log.aggregate<{ doc: Record<string, unknown> }>([
        { $match: log.filter({ campaign_id: { $in: uniq(campaignIds) }, action: { $in: uniq(actions) } }) },
        { $sort: { campaign_id: 1, at: -1, _id: -1 } },
        { $group: { _id: '$campaign_id', doc: { $first: '$$ROOT' } } },
      ]);
      for (const r of rows) {
        const row = log.fromDoc(r.doc) as LogRec;
        out.set(row.campaign_id, row);
      }
      return out;
    },
    async campaignsPromoting(kinds, targetIds) {
      if (!kinds.length || !targetIds.length) return [];
      return t('campaign_items').find({ kind: { $in: uniq(kinds) }, target_id: { $in: uniq(targetIds) } }) as Promise<ItemRec[]>;
    },

    /* ---------------------------------------------------------------- frequency and suppression */
    async frequencyRows(visitorKeys, campaignIds) {
      if (!visitorKeys.length || !campaignIds.length) return [];
      return frequency.find({ visitor_key: { $in: uniq(visitorKeys) }, campaign_id: { $in: uniq(campaignIds) } }) as Promise<(FrequencyRow & { visitor_key: string })[]>;
    },
    async hasHistory(visitorKeys) {
      if (!visitorKeys.length) return false;
      return frequency.exists({ visitor_key: { $in: uniq(visitorKeys) } });
    },
    async recordDisplay(visitorKeys, campaignId, sessionId, now, windowDays, day) {
      const cutoff = windowDays ? new Date(now.getTime() - windowDays * 86_400_000) : null;
      // the window goes on while it started after the cutoff (no window: always)
      const inWindow = cutoff ? { $gt: ['$window_started_at', cutoff] } : true;
      for (const key of uniq(visitorKeys)) {
        const inserted = await frequency.insertIfAbsent(
          { visitor_key: key, campaign_id: campaignId, session_id: sessionId, session_displays: 1, window_displays: 1, window_started_at: now, display_day: day.day, day_displays: 1, total_displays: 1, last_display_at: now, suppressed_until: null },
          ['visitor_key', 'campaign_id'],
        );
        if (inserted) continue;
        // one atomic update of the stored row; every expression reads the row as it was before this display
        await frequency.updateOne({ visitor_key: key, campaign_id: campaignId }, [
          {
            $set: {
              day_displays: { $cond: [{ $eq: ['$display_day', lit(day.day)] }, { $add: ['$day_displays', 1] }, 1] },
              display_day: lit(day.day),
              total_displays: { $add: ['$total_displays', 1] },
              session_displays: { $cond: [{ $eq: ['$session_id', lit(sessionId)] }, { $add: ['$session_displays', 1] }, 1] },
              session_id: lit(sessionId),
              window_displays: { $cond: [inWindow, { $add: ['$window_displays', 1] }, 1] },
              window_started_at: { $cond: [inWindow, '$window_started_at', now] },
              last_display_at: now,
            },
          },
        ]);
      }
    },
    async recordDismissal(visitorKeys, campaignId, sessionId, until, now) {
      for (const key of uniq(visitorKeys)) {
        const inserted = await frequency.insertIfAbsent(
          { visitor_key: key, campaign_id: campaignId, session_id: sessionId, session_displays: 0, window_displays: 0, window_started_at: now, display_day: null, day_displays: 0, total_displays: 0, last_display_at: null, suppressed_until: until },
          ['visitor_key', 'campaign_id'],
        );
        if (inserted) continue;
        await frequency.updateOne({ visitor_key: key, campaign_id: campaignId }, [
          {
            $set: {
              session_displays: { $cond: [{ $eq: ['$session_id', lit(sessionId)] }, '$session_displays', 0] },
              session_id: lit(sessionId),
              suppressed_until: { $max: [{ $ifNull: ['$suppressed_until', until] }, until] },
            },
          },
        ]);
      }
    },
    async displayCounts(visitorKeys, campaignIds, since) {
      const out = new Map<string, number>();
      if (!visitorKeys.length || !campaignIds.length) return out;
      const rows = await events.aggregate<{ _id: string; n: number }>([
        { $match: events.filter({ visitor_key: { $in: uniq(visitorKeys) }, campaign_id: { $in: uniq(campaignIds) }, kind: 'display', ...(since ? { at: { $gte: since } } : {}) }) },
        { $group: { _id: '$campaign_id', n: { $sum: 1 } } },
      ]);
      for (const r of rows) out.set(r._id, r.n);
      return out;
    },
    async expireFrequency(now, oldestWindowStart, endedCampaignIds, keepCampaignIds = []) {
      let n = 0;
      if (endedCampaignIds.length) n += await frequency.deleteMany({ campaign_id: { $in: uniq(endedCampaignIds) } });
      n += await frequency.deleteMany({
        ...(keepCampaignIds.length ? { campaign_id: { $nin: uniq(keepCampaignIds) } } : {}),
        window_started_at: { $lt: oldestWindowStart },
        $and: [{ $or: [{ suppressed_until: null }, { suppressed_until: { $lt: now } }] }, { $or: [{ last_display_at: null }, { last_display_at: { $lt: oldestWindowStart } }] }],
      });
      return n;
    },

    /* ---------------------------------------------------------------- spend */
    async chargeClick(eventId, campaignId, day) {
      if (!store.inTransaction) return store.transaction((tx) => createMongoAdvertisingRepository(tx).chargeClick(eventId, campaignId, day));
      // total limit first (campaign document), then the day (daily_stats document): one write order
      const c = await campaigns.updateOne(
        { id: campaignId, rate: { $ne: null }, $or: [{ total_limit: null }, { $expr: { $lte: [{ $add: ['$spent', '$rate'] }, '$total_limit'] } }] },
        [{ $set: { spent: { $add: ['$spent', { $ifNull: ['$rate', 0] }] } } }],
      );
      if (!c) {
        const exists = await campaigns.get(campaignId);
        return { charged: false, limit: exists && exists.rate !== null ? 'total' : 'missing' };
      }
      const rate = c.rate as number;
      const dailyLimit = c.daily_limit as number | null;
      const totalLimit = c.total_limit as number | null;
      await stats.insertIfAbsent({ campaign_id: campaignId, day, displays: 0, clicks: 0, dismissals: 0, spend: 0, attributed_orders: 0, attributed_sales: 0 }, ['campaign_id', 'day']);
      const dayRow = await stats.updateOne(
        { campaign_id: campaignId, day, ...(dailyLimit !== null ? { $expr: { $lte: [{ $add: ['$spend', rate] }, dailyLimit] } } : {}) },
        { $inc: { spend: rate } },
      );
      if (!dayRow) {
        await campaigns.update(campaignId, { $inc: { spent: -rate } });
        return { charged: false, limit: 'daily' };
      }
      await events.update(eventId, { cost: rate });
      const spent = c.spent as number;
      const exhausted = totalLimit !== null && spent + rate > totalLimit ? 'total' : dailyLimit !== null && (dayRow.spend as number) + rate > dailyLimit ? 'daily' : null;
      return { charged: true, amount: rate, exhausted };
    },
    async spendOn(campaignIds, day) {
      const out = new Map<string, number>();
      if (!campaignIds.length) return out;
      for (const r of (await stats.find({ campaign_id: { $in: uniq(campaignIds) }, day })) as StatRec[]) out.set(r.campaign_id, r.spend);
      return out;
    },
    async addSpend(campaignId, day, delta) {
      if (!delta) return;
      await campaigns.update(campaignId, [{ $set: { spent: { $max: [{ $add: ['$spent', delta] }, 0] } } }]);
      const inserted = await stats.insertIfAbsent(
        { campaign_id: campaignId, day, displays: 0, clicks: 0, dismissals: 0, spend: Math.max(delta, 0), attributed_orders: 0, attributed_sales: 0 },
        ['campaign_id', 'day'],
      );
      if (!inserted) await stats.updateOne({ campaign_id: campaignId, day }, [{ $set: { spend: { $max: [{ $add: ['$spend', delta] }, 0] } } }]);
    },
    async clickBilling(campaignId, span) {
      const [r] = await events.aggregate<{ units: number; amount: number }>([
        { $match: events.filter({ campaign_id: campaignId, kind: 'click', at: { $gte: span.from, $lt: span.to } }) },
        { $group: { _id: null, units: { $sum: { $cond: [{ $ne: [{ $ifNull: ['$cost', null] }, null] }, 1, 0] } }, amount: { $sum: { $ifNull: ['$cost', 0] } } } },
      ]);
      return { units: r?.units ?? 0, amount: r?.amount ?? 0 };
    },
    displaysIn: (campaignId, span) => events.count({ campaign_id: campaignId, kind: 'display', at: { $gte: span.from, $lt: span.to } }),

    listCharges(f, page) {
      const dayRange: Record<string, string> = {};
      if (f.from) dayRange.$gte = f.from;
      if (f.to) dayRange.$lte = f.to;
      return t('ad_charges').page(
        {
          ...(f.sellerId ? { seller_id: f.sellerId } : {}),
          ...(f.campaignId ? { campaign_id: f.campaignId } : {}),
          ...(f.state ? { state: f.state } : {}),
          ...(f.from || f.to ? { day: dayRange } : {}),
        },
        page,
        { column: 'day', direction: 'desc' },
      ) as Promise<Page<ChargeRec>>;
    },

    /* ---------------------------------------------------------------- read models */
    async rollup(span, timeZone) {
      const dayOf = (field: string) => ({ $dateToString: { format: '%Y-%m-%d', date: `$${field}`, timezone: timeZone } });
      const isKind = (...kinds: string[]) => ({ $cond: [{ $in: ['$kind', kinds] }, 1, 0] });
      const fromEvents = await events.aggregate<{ _id: { c: string; d: string }; displays: number; clicks: number; dismissals: number }>([
        { $match: events.filter({ at: { $gte: span.from, $lt: span.to } }) },
        { $group: { _id: { c: '$campaign_id', d: dayOf('at') }, displays: { $sum: isKind('display') }, clicks: { $sum: isKind('click') }, dismissals: { $sum: isKind('dismiss', 'close') } } },
      ]);
      const attributions = t('attributions');
      const fromOrders = await attributions.aggregate<{ _id: { c: string; d: string }; orders: number; sales: number }>([
        { $match: attributions.filter({ attributed_at: { $gte: span.from, $lt: span.to } }) },
        {
          $group: {
            _id: { c: '$campaign_id', d: dayOf('attributed_at') },
            orders: { $sum: { $cond: [{ $and: [{ $gt: ['$amount', 0] }, { $not: ['$reversed'] }] }, 1, 0] } },
            sales: { $sum: '$amount' },
          },
        },
      ]);
      const rows = new Map<string, { campaign_id: string; day: string; displays: number; clicks: number; dismissals: number; attributed_orders: number; attributed_sales: number }>();
      const rowOf = (id: { c: string; d: string }) => {
        const k = `${id.c}|${id.d}`;
        let r = rows.get(k);
        if (!r) rows.set(k, (r = { campaign_id: id.c, day: id.d, displays: 0, clicks: 0, dismissals: 0, attributed_orders: 0, attributed_sales: 0 }));
        return r;
      };
      for (const e of fromEvents) Object.assign(rowOf(e._id), { displays: e.displays, clicks: e.clicks, dismissals: e.dismissals });
      for (const o of fromOrders) Object.assign(rowOf(o._id), { attributed_orders: o.orders, attributed_sales: o.sales });
      // spend is kept as charged: set on a new row only
      await stats.upsertMany(
        [...rows.values()].map((r) => ({ ...r, spend: 0 })),
        { key: ['campaign_id', 'day'], update: (r) => ({ displays: r.displays, clicks: r.clicks, dismissals: r.dismissals, attributed_orders: r.attributed_orders, attributed_sales: r.attributed_sales }) },
      );
      return rows.size;
    },
    async totals(campaignIds, days) {
      const out = new Map<string, StatTotals>();
      if (campaignIds && !campaignIds.length) return out;
      const rows = await stats.aggregate<{ _id: string } & StatTotals>([
        { $match: stats.filter({ ...(campaignIds ? { campaign_id: { $in: uniq(campaignIds) } } : {}), ...(days ? { day: { $gte: days.from, $lte: days.to } } : {}) }) },
        {
          $group: {
            _id: '$campaign_id',
            displays: { $sum: '$displays' },
            clicks: { $sum: '$clicks' },
            dismissals: { $sum: '$dismissals' },
            spend: { $sum: '$spend' },
            attributedOrders: { $sum: '$attributed_orders' },
            attributedSales: { $sum: '$attributed_sales' },
          },
        },
      ]);
      for (const { _id, ...r } of rows) out.set(_id, { ...EMPTY_TOTALS(), ...r });
      return out;
    },
    statsInRange: (days, campaignIds) =>
      stats.find({ day: { $gte: days.from, $lte: days.to }, ...(campaignIds ? { campaign_id: { $in: uniq(campaignIds) } } : {}) }, { sort: { day: 1, campaign_id: 1 } }),
    async reach(placementKey, since) {
      const [r] = await events.aggregate<{ n: number }>([
        { $match: events.filter({ placement_key: placementKey, kind: 'display', at: { $gte: since } }) },
        { $group: { _id: '$visitor_key' } },
        { $count: 'n' },
      ]);
      return r?.n ?? 0;
    },
    lastClick: (customerId, since) => events.findOne({ customer_id: customerId, kind: 'click', at: { $gte: since } }, { sort: { at: -1 } }) as Promise<EventRec | undefined>,
    async enforcementTargets(marker) {
      // LIKE '%marker%': case-sensitive
      const has = { $regex: escapeRegExp(marker) };
      const creativeIds = await t('creative_reviews').distinct<string>('creative_id', { decision: 'rejected', comment: has });
      const campaignIds = await t('campaign_log').distinct<string>('campaign_id', { action: 'reject', reason: has });
      return { creativeIds, campaignIds };
    },
    lastClickByVisitor: (visitorKey, since) => events.findOne({ visitor_key: visitorKey, kind: 'click', at: { $gte: since } }, { sort: { at: -1 } }) as Promise<EventRec | undefined>,
  };
  return repo;
}
