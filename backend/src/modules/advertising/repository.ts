import { orThrow } from '../../kernel/lib/or-throw.js';
import type { PageRequest } from '../../kernel/lib/pagination.js';
import { escapeRegExp } from '../../kernel/lib/text.js';
import { contains, whereFilter, type Filter, type ModuleStore, type Table as MongoTable, type Where } from '../../kernel/mongo/index.js';
import type * as common from '../../spec/common.js';
import type { FrequencyRow } from './domain/rules.js';
import type { CampaignListFilter, CampaignRec, ChargeRec, ClickCharge, CreativeListFilter, CreativeRec, Db, EventRec, FindOptions, IdTable, ItemRec, LogRec, Span, StatRec, StatTotals, Table } from './ports.js';

const uniq = <T>(xs: readonly T[]) => [...new Set(xs)];
/** A value inside an aggregation expression, never read as a field path or operator */
const lit = (v: unknown) => ({ $literal: v });


const EMPTY_TOTALS = (): StatTotals => ({ displays: 0, clicks: 0, dismissals: 0, spend: 0, attributedOrders: 0, attributedSales: 0 });

/** The advertising module's collections (MongoDB, docs/04-mongodb-migration.md): one per spec table. */
export class AdvertisingRepository {
  readonly #campaigns;
  readonly #events;
  readonly #frequency;
  readonly #stats;

  constructor(private readonly store: ModuleStore) {
    this.#campaigns = this.#t('campaigns');
    this.#events = this.#t('ad_events');
    this.#frequency = this.#t('frequency_state');
    this.#stats = this.#t('daily_stats');
  }

  /** fn with a repository bound to one transaction */
  transaction<T>(fn: (tx: AdvertisingRepository) => Promise<T>): Promise<T> {
    return this.store.transaction((tx) => fn(new AdvertisingRepository(tx)));
  }

  /** Inbox (ctx.mongo.claim): true the first time this key is claimed; commits with the transaction it runs in */
  claim(key: string): Promise<boolean> {
    return this.store.claim(key);
  }

  /* ---------------------------------------------------------------- generic */
  get<T extends IdTable>(table: T, id: string, o?: { forUpdate?: boolean }): Promise<Db[T] | undefined> {
    return this.#t(table).get(id, o);
  }

  getMany<T extends IdTable>(table: T, ids: readonly string[]): Promise<Db[T][]> {
    return this.#t(table).getMany(uniq(ids));
  }

  find<T extends Table>(table: T, w: Where<Db[T]>, o?: FindOptions<Db[T]>): Promise<Db[T][]> {
    return this.#t(table).find(whereFilter(w), {
      ...(o?.orderBy?.length ? { sort: Object.fromEntries(o.orderBy.map(([c, d]) => [c, d === 'desc' ? -1 : 1])) } : {}),
      ...(o?.limit ? { limit: o.limit } : {}),
      ...(o?.offset ? { skip: o.offset } : {}),
      ...(o?.forUpdate ? { forUpdate: true } : {}),
    });
  }

  async findOne<T extends Table>(table: T, w: Where<Db[T]>, o?: FindOptions<Db[T]>): Promise<Db[T] | undefined> {
    return (await this.find(table, w, { ...o, limit: 1 }))[0];
  }

  count<T extends Table>(table: T, w: Where<Db[T]>): Promise<number> {
    return this.#t(table).count(whereFilter(w));
  }

  insert<T extends Table>(table: T, row: Db[T]): Promise<Db[T]> {
    return this.#t(table).insert(row as Record<string, unknown>);
  }

  /** Insert unless a row with the same unique key exists (the primary key or a unique index); true when inserted */
  async insertIfAbsent<T extends Table>(table: T, row: Db[T]): Promise<boolean> {
    return Boolean(await this.#t(table).insertIfAbsent(row as Record<string, unknown>));
  }

  async update<T extends IdTable>(table: T, id: string, patch: Partial<Db[T]>): Promise<Db[T]> {
    const values = Object.fromEntries(Object.entries(patch as Record<string, unknown>).filter(([, v]) => v !== undefined));
    if (!Object.keys(values).length) return (await this.get(table, id))!;
    return orThrow(await this.#t(table).update(id, values), `advertising: ${table} ${id}`);
  }

  async updateWhere<T extends Table>(table: T, w: Where<Db[T]>, patch: Partial<Db[T]>): Promise<number> {
    const values = Object.fromEntries(Object.entries(patch as Record<string, unknown>).filter(([, v]) => v !== undefined));
    if (!Object.keys(values).length) return 0;
    return this.#t(table).updateMany(whereFilter(w), values);
  }

  removeWhere<T extends Table>(table: T, w: Where<Db[T]>): Promise<number> {
    return this.#t(table).deleteMany(whereFilter(w));
  }

  page<T extends Table>(table: T, w: Where<Db[T]>, page: PageRequest, order: { column: keyof Db[T] & string; direction: 'asc' | 'desc'; id?: string }): Promise<common.Page<Db[T]>> {
    return this.#t(table).page(whereFilter(w), page, order) as never;
  }

  /* ---------------------------------------------------------------- rules */
  async maxRulesVersion(): Promise<number> {
    const top = await this.#t('global_rules').findOne({}, { sort: { version: -1 } });
    return (top?.version as number | undefined) ?? 0;
  }

  /* ---------------------------------------------------------------- campaigns and creatives */
  listCampaigns(f: CampaignListFilter, page: PageRequest): Promise<common.Page<CampaignRec>> {
    const c: Filter[] = [];
    if (f.q?.trim()) {
      const term = contains(f.q);
      c.push({ $or: [{ name: term }, { ref: term }] });
    }
    if (f.advertiserKinds) c.push({ advertiser_kind: { $in: f.advertiserKinds } });
    if (f.placementId) c.push({ placement_id: f.placementId });
    if (f.statuses?.length) c.push({ status: { $in: f.statuses } });
    if (f.linkedPromotionId) c.push({ linked_promotion_id: f.linkedPromotionId });
    if (f.sellerId) c.push({ seller_id: f.sellerId });
    if (f.origin) c.push({ origin: f.origin });
    return this.#campaigns.page(c.length ? { $and: c } : {}, page, { column: 'created_at', direction: 'desc' });
  }

  async listCreatives(f: CreativeListFilter, page: PageRequest): Promise<common.Page<CreativeRec>> {
    return this.#t('creatives').page(await this.#creativeFilter(f), page, { column: 'created_at', direction: 'desc' });
  }

  async creativeCounts(f: CreativeListFilter): Promise<Record<string, number>> {
    const creatives = this.#t('creatives');
    const rows = await creatives.aggregate<{ _id: string; n: number }>([{ $match: creatives.filter(await this.#creativeFilter({ ...f, status: undefined })) }, { $group: { _id: '$status', n: { $sum: 1 } } }]);
    return Object.fromEntries(rows.map((r) => [r._id, r.n]));
  }

  /** Live campaigns whose period covers `at` */
  liveCampaigns(at: Date): Promise<CampaignRec[]> {
    return this.#campaigns.find({ status: 'live', starts_at: { $lte: at }, ends_at: { $gt: at } }, { sort: { id: 1 } });
  }

  /** Latest log row per campaign for the given actions */
  async lastLogs(campaignIds: readonly string[], actions: readonly string[]): Promise<Map<string, LogRec>> {
    const out = new Map<string, LogRec>();
    if (!campaignIds.length || !actions.length) return out;
    const log = this.#t('campaign_log');
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
  }

  /** Campaign ids promoting any of the targets (campaign_items) */
  async campaignsPromoting(kinds: readonly string[], targetIds: readonly string[]): Promise<ItemRec[]> {
    if (!kinds.length || !targetIds.length) return [];
    return this.#t('campaign_items').find({ kind: { $in: uniq(kinds) }, target_id: { $in: uniq(targetIds) } }) as Promise<ItemRec[]>;
  }

  /* ---------------------------------------------------------------- frequency and suppression */
  async frequencyRows(visitorKeys: readonly string[], campaignIds: readonly string[]): Promise<(FrequencyRow & { visitor_key: string })[]> {
    if (!visitorKeys.length || !campaignIds.length) return [];
    return this.#frequency.find({ visitor_key: { $in: uniq(visitorKeys) }, campaign_id: { $in: uniq(campaignIds) } }) as Promise<(FrequencyRow & { visitor_key: string })[]>;
  }

  /** Any counter for these visitor keys (returning visitor) */
  async hasHistory(visitorKeys: readonly string[]): Promise<boolean> {
    if (!visitorKeys.length) return false;
    return this.#frequency.exists({ visitor_key: { $in: uniq(visitorKeys) } });
  }

  /** Display counters: session (reset when the session changes) and window (restarted when the window has passed) */
  /** Counts a display on every key: session, window, the market day (day.day, starting at day.start) and the campaign total */
  async recordDisplay(visitorKeys: readonly string[], campaignId: string, sessionId: string, now: Date, windowDays: number | null, day: { day: string; start: Date }): Promise<void> {
    const cutoff = windowDays ? new Date(now.getTime() - windowDays * 86_400_000) : null;
    // the window goes on while it started after the cutoff (no window: always)
    const inWindow = cutoff ? { $gt: ['$window_started_at', cutoff] } : true;
    for (const key of uniq(visitorKeys)) {
      const inserted = await this.#frequency.insertIfAbsent(
        { visitor_key: key, campaign_id: campaignId, session_id: sessionId, session_displays: 1, window_displays: 1, window_started_at: now, display_day: day.day, day_displays: 1, total_displays: 1, last_display_at: now, suppressed_until: null },
        ['visitor_key', 'campaign_id'],
      );
      if (inserted) continue;
      // one atomic update of the stored row; every expression reads the row as it was before this display
      await this.#frequency.updateOne({ visitor_key: key, campaign_id: campaignId }, [
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
  }

  async recordDismissal(visitorKeys: readonly string[], campaignId: string, sessionId: string, until: Date, now: Date): Promise<void> {
    for (const key of uniq(visitorKeys)) {
      const inserted = await this.#frequency.insertIfAbsent(
        { visitor_key: key, campaign_id: campaignId, session_id: sessionId, session_displays: 0, window_displays: 0, window_started_at: now, display_day: null, day_displays: 0, total_displays: 0, last_display_at: null, suppressed_until: until },
        ['visitor_key', 'campaign_id'],
      );
      if (inserted) continue;
      await this.#frequency.updateOne({ visitor_key: key, campaign_id: campaignId }, [
        {
          $set: {
            session_displays: { $cond: [{ $eq: ['$session_id', lit(sessionId)] }, '$session_displays', 0] },
            session_id: lit(sessionId),
            suppressed_until: { $max: [{ $ifNull: ['$suppressed_until', until] }, until] },
          },
        },
      ]);
    }
  }

  /** Tracked displays per campaign for the visitor keys since `since` (all time when null) */
  async displayCounts(visitorKeys: readonly string[], campaignIds: readonly string[], since: Date | null): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!visitorKeys.length || !campaignIds.length) return out;
    const rows = await this.#events.aggregate<{ _id: string; n: number }>([
      { $match: this.#events.filter({ visitor_key: { $in: uniq(visitorKeys) }, campaign_id: { $in: uniq(campaignIds) }, kind: 'display', ...(since ? { at: { $gte: since } } : {}) }) },
      { $group: { _id: '$campaign_id', n: { $sum: 1 } } },
    ]);
    for (const r of rows) out.set(r._id, r.n);
    return out;
  }

  /** Deletes stale rows (and every row of ended campaigns), keeping rows of keepCampaignIds (running campaigns with a total cap) */
  /** Deletes ad events older than `before` (retention; the daily_stats rollups keep the totals) */
  pruneEvents(before: Date): Promise<number> {
    return this.#events.deleteMany({ at: { $lt: before } });
  }

  async expireFrequency(now: Date, oldestWindowStart: Date, endedCampaignIds: readonly string[], keepCampaignIds: readonly string[] = []): Promise<number> {
    let n = 0;
    if (endedCampaignIds.length) n += await this.#frequency.deleteMany({ campaign_id: { $in: uniq(endedCampaignIds) } });
    n += await this.#frequency.deleteMany({
      ...(keepCampaignIds.length ? { campaign_id: { $nin: uniq(keepCampaignIds) } } : {}),
      window_started_at: { $lt: oldestWindowStart },
      $and: [{ $or: [{ suppressed_until: null }, { suppressed_until: { $lt: now } }] }, { $or: [{ last_display_at: null }, { last_display_at: { $lt: oldestWindowStart } }] }],
    });
    return n;
  }

  /* ---------------------------------------------------------------- spend */
  /**
   * Charges one click atomically: campaigns.spent within the total limit, then the day's spend within the
   * daily limit; parallel clicks can never overspend. Sets ad_events.cost on success.
   */
  async chargeClick(eventId: string, campaignId: string, day: string): Promise<ClickCharge> {
    if (!this.store.inTransaction) return this.store.transaction((tx) => new AdvertisingRepository(tx).chargeClick(eventId, campaignId, day));
    // total limit first (campaign document), then the day (daily_stats document): one write order
    const c = await this.#campaigns.updateOne(
      { id: campaignId, rate: { $ne: null }, $or: [{ total_limit: null }, { $expr: { $lte: [{ $add: ['$spent', '$rate'] }, '$total_limit'] } }] },
      [{ $set: { spent: { $add: ['$spent', { $ifNull: ['$rate', 0] }] } } }],
    );
    if (!c) {
      const exists = await this.#campaigns.get(campaignId);
      return { charged: false, limit: exists && exists.rate !== null ? 'total' : 'missing' };
    }
    const rate = c.rate as number;
    const dailyLimit = c.daily_limit as number | null;
    const totalLimit = c.total_limit as number | null;
    await this.#stats.insertIfAbsent({ campaign_id: campaignId, day, displays: 0, clicks: 0, dismissals: 0, spend: 0, attributed_orders: 0, attributed_sales: 0 }, ['campaign_id', 'day']);
    const dayRow = await this.#stats.updateOne(
      { campaign_id: campaignId, day, ...(dailyLimit !== null ? { $expr: { $lte: [{ $add: ['$spend', rate] }, dailyLimit] } } : {}) },
      { $inc: { spend: rate } },
    );
    if (!dayRow) {
      await this.#campaigns.update(campaignId, { $inc: { spent: -rate } });
      return { charged: false, limit: 'daily' };
    }
    await this.#events.update(eventId, { cost: rate });
    const spent = c.spent as number;
    const exhausted = totalLimit !== null && spent + rate > totalLimit ? 'total' : dailyLimit !== null && (dayRow.spend as number) + rate > dailyLimit ? 'daily' : null;
    return { charged: true, amount: rate, exhausted };
  }

  /** Day spend per campaign */
  async spendOn(campaignIds: readonly string[], day: string): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!campaignIds.length) return out;
    for (const r of (await this.#stats.find({ campaign_id: { $in: uniq(campaignIds) }, day })) as StatRec[]) out.set(r.campaign_id, r.spend);
    return out;
  }

  /** Adds (or with a negative delta gives back) spend on a campaign and its day, never below zero */
  async addSpend(campaignId: string, day: string, delta: number): Promise<void> {
    if (!delta) return;
    await this.#campaigns.update(campaignId, [{ $set: { spent: { $max: [{ $add: ['$spent', delta] }, 0] } } }]);
    const inserted = await this.#stats.insertIfAbsent(
      { campaign_id: campaignId, day, displays: 0, clicks: 0, dismissals: 0, spend: Math.max(delta, 0), attributed_orders: 0, attributed_sales: 0 },
      ['campaign_id', 'day'],
    );
    if (!inserted) await this.#stats.updateOne({ campaign_id: campaignId, day }, [{ $set: { spend: { $max: [{ $add: ['$spend', delta] }, 0] } } }]);
  }

  /** Billable clicks and their cost between two instants */
  async clickBilling(campaignId: string, span: Span): Promise<{ units: number; amount: number }> {
    const [r] = await this.#events.aggregate<{ units: number; amount: number }>([
      { $match: this.#events.filter({ campaign_id: campaignId, kind: 'click', at: { $gte: span.from, $lt: span.to } }) },
      { $group: { _id: null, units: { $sum: { $cond: [{ $ne: [{ $ifNull: ['$cost', null] }, null] }, 1, 0] } }, amount: { $sum: { $ifNull: ['$cost', 0] } } } },
    ]);
    return { units: r?.units ?? 0, amount: r?.amount ?? 0 };
  }

  displaysIn(campaignId: string, span: Span): Promise<number> {
    return this.#events.count({ campaign_id: campaignId, kind: 'display', at: { $gte: span.from, $lt: span.to } });
  }

  listCharges(f: { sellerId?: string; campaignId?: string; state?: string; from?: string; to?: string }, page: PageRequest): Promise<common.Page<ChargeRec>> {
    const dayRange: Record<string, string> = {};
    if (f.from) dayRange.$gte = f.from;
    if (f.to) dayRange.$lte = f.to;
    return this.#t('ad_charges').page(
      {
        ...(f.sellerId ? { seller_id: f.sellerId } : {}),
        ...(f.campaignId ? { campaign_id: f.campaignId } : {}),
        ...(f.state ? { state: f.state } : {}),
        ...(f.from || f.to ? { day: dayRange } : {}),
      },
      page,
      { column: 'day', direction: 'desc' },
    ) as Promise<common.Page<ChargeRec>>;
  }

  /* ---------------------------------------------------------------- read models */
  /** Recomputes displays, clicks, dismissals and attributions per campaign and market day (spend is kept as charged) */
  async rollup(span: Span, timeZone: string): Promise<number> {
    const dayOf = (field: string) => ({ $dateToString: { format: '%Y-%m-%d', date: `$${field}`, timezone: timeZone } });
    const isKind = (...kinds: string[]) => ({ $cond: [{ $in: ['$kind', kinds] }, 1, 0] });
    const fromEvents = await this.#events.aggregate<{ _id: { c: string; d: string }; displays: number; clicks: number; dismissals: number }>([
      { $match: this.#events.filter({ at: { $gte: span.from, $lt: span.to } }) },
      { $group: { _id: { c: '$campaign_id', d: dayOf('at') }, displays: { $sum: isKind('display') }, clicks: { $sum: isKind('click') }, dismissals: { $sum: isKind('dismiss', 'close') } } },
    ]);
    const attributions = this.#t('attributions');
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
    await this.#stats.upsertMany(
      [...rows.values()].map((r) => ({ ...r, spend: 0 })),
      { key: ['campaign_id', 'day'], update: (r) => ({ displays: r.displays, clicks: r.clicks, dismissals: r.dismissals, attributed_orders: r.attributed_orders, attributed_sales: r.attributed_sales }) },
    );
    return rows.size;
  }

  async totals(campaignIds: readonly string[] | null, days?: { from: string; to: string }): Promise<Map<string, StatTotals>> {
    const out = new Map<string, StatTotals>();
    if (campaignIds && !campaignIds.length) return out;
    const rows = await this.#stats.aggregate<{ _id: string } & StatTotals>([
      { $match: this.#stats.filter({ ...(campaignIds ? { campaign_id: { $in: uniq(campaignIds) } } : {}), ...(days ? { day: { $gte: days.from, $lte: days.to } } : {}) }) },
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
  }

  statsInRange(days: { from: string; to: string }, campaignIds?: readonly string[] | null): Promise<StatRec[]> {
    return this.#stats.find({ day: { $gte: days.from, $lte: days.to }, ...(campaignIds ? { campaign_id: { $in: uniq(campaignIds) } } : {}) }, { sort: { day: 1, campaign_id: 1 } });
  }

  /** Distinct visitors that saw ads on a placement since `since` */
  async reach(placementKey: string, since: Date): Promise<number> {
    const [r] = await this.#events.aggregate<{ n: number }>([
      { $match: this.#events.filter({ placement_key: placementKey, kind: 'display', at: { $gte: since } }) },
      { $group: { _id: '$visitor_key' } },
      { $count: 'n' },
    ]);
    return r?.n ?? 0;
  }

  /** The visitor's latest click within the window (by customer id) */
  lastClick(customerId: string, since: Date): Promise<EventRec | undefined> {
    return this.#events.findOne({ customer_id: customerId, kind: 'click', at: { $gte: since } }, { sort: { at: -1 } }) as Promise<EventRec | undefined>;
  }

  /** Creatives revoked and campaigns rejected with this marker in their reason (trust enforcement id) */
  async enforcementTargets(marker: string): Promise<{ creativeIds: string[]; campaignIds: string[] }> {
    // LIKE '%marker%': case-sensitive
    const has = { $regex: escapeRegExp(marker) };
    const creativeIds = await this.#t('creative_reviews').distinct<string>('creative_id', { decision: 'rejected', comment: has });
    const campaignIds = await this.#t('campaign_log').distinct<string>('campaign_id', { action: 'reject', reason: has });
    return { creativeIds, campaignIds };
  }

  /** Last click stored under a visitor key (guests who allowed personalization) */
  lastClickByVisitor(visitorKey: string, since: Date): Promise<EventRec | undefined> {
    return this.#events.findOne({ visitor_key: visitorKey, kind: 'click', at: { $gte: since } }, { sort: { at: -1 } }) as Promise<EventRec | undefined>;
  }

  /** One collection, untyped: the generic methods above type their rows through Db[T] */
  #t(name: Table): MongoTable<any> {
    return this.store.table(name);
  }

  /** The creative filter; the search also matches the names and refs of the campaigns a creative is linked to (two reads) */
  async #creativeFilter(f: CreativeListFilter): Promise<Filter> {
    const c: Filter[] = [];
    if (f.q?.trim()) {
      const term = contains(f.q);
      const linked = (await this.#campaigns.find({ $or: [{ name: term }, { ref: term }] })).map((r) => r.id as string);
      const creativeIds = linked.length ? await this.#t('campaign_creatives').distinct<string>('creative_id', { campaign_id: { $in: linked } }) : [];
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
}
