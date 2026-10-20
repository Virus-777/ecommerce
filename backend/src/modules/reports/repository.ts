import { orThrow } from '../../kernel/lib/or-throw.js';
import type { PageRequest } from '../../kernel/lib/pagination.js';
import type { Filter, ModuleStore, Table as MongoTable } from '../../kernel/mongo/index.js';
import type { Page } from '../../spec/common.js';
import type { CheckpointRow, DailyFilter, DailyTable, DatasetRow, GroupRow, JobRow, MetricRow, OfferProfitAgg, OrderItemFact, OwnerChangeRow, ReportRow, Row, SalesAgg, SalesFilter, SalesGroup, SavedViewRow, ScheduleRow, SuggestionRow, Table, VersionRow } from './ports.js';

type Doc = Record<string, unknown>;

/** The fact_marketplace_finance_daily columns filled from finance.ledgerDailyTotals (zero until pulled) */
export const LEDGER_COLUMN_DEFAULTS = { fee_gross_minor: 0, fee_refunds_minor: 0, refunds_minor: 0, shipping_charged_minor: 0, label_charges_minor: 0, adjustments_minor: 0, chargebacks_minor: 0 };

/** Key columns and counter defaults of the daily fact tables */
const DAILY: Record<DailyTable, { key: string[]; defaults: Record<string, unknown> }> = {
  fact_marketplace_finance_daily: {
    key: ['seller_id', 'day'],
    defaults: { seller_sales_minor: 0, fee_income_minor: 0, platform_discount_minor: 0, seller_discount_minor: 0, held_minor: 0, payouts_paid_minor: 0, payouts_failed: 0, owed_minor: 0, ad_charges_minor: 0, service_fees_minor: 0, ...LEDGER_COLUMN_DEFAULTS },
  },
  fact_company_daily: { key: ['day', 'source', 'kind'], defaults: { amount_minor: 0 } },
  fact_seller_balances_daily: { key: ['seller_id', 'day'], defaults: { pending_minor: 0, available_minor: 0, held_minor: 0, owed_minor: 0 } },
  fact_marketly_fulfillment_daily: { key: ['seller_id', 'day'], defaults: { dispatched: 0, dispatched_on_time: 0, overdue: 0, delivery_exceptions: 0 } },
  fact_service_daily: {
    key: ['seller_id', 'day'],
    defaults: { dispatched: 0, dispatched_on_time: 0, overdue: 0, valid_tracking: 0, seller_cancellations: 0, delivery_exceptions: 0, messages_received: 0, first_reply_minutes_p50: null, cases_opened: 0, cases_open_eod: 0, complaints_by_category: {} },
  },
  fact_discovery_daily: { key: ['product_id', 'day'], defaults: { views: 0, cart_adds: 0, purchases: 0, stockout_minutes: 0 } },
  fact_search_misses_daily: { key: ['day', 'query_norm'], defaults: { count: 0, had_unavailable_match: false } },
  fact_campaigns_daily: {
    key: ['campaign_kind', 'campaign_id', 'day'],
    defaults: { sales_minor: 0, discount_cost_minor: 0, funded_by: {}, redemptions: 0, displays: 0, clicks: 0, dismissals: 0, spend_minor: 0, attributed_purchases: 0 },
  },
};

/** A value inside an aggregation expression, never read as a field path or operator */
const lit = (v: unknown) => ({ $literal: v });

/**
 * The market day, week (from Monday, ISO weeks) or month an instant falls in, as YYYY-MM-DD of its first day
 */
const bucketOf = (date: unknown, unit: string, timezone: string) => ({
  $dateToString: { format: '%Y-%m-%d', timezone, date: { $dateTrunc: { date, unit, timezone, ...(unit === 'week' ? { startOfWeek: 'monday' } : {}) } } },
});
/** The first day (YYYY-MM-DD) of the day, week (from Monday) or month a `day` column falls in */
const dayBucket = (unit: string) => ({
  $dateToString: { format: '%Y-%m-%d', date: { $dateTrunc: { date: { $dateFromString: { dateString: '$day', format: '%Y-%m-%d' } }, unit, ...(unit === 'week' ? { startOfWeek: 'monday' } : {}) } } },
});
/** The market day of an instant ((<instant> at time zone tz)::date) */
const dayOf = (field: string, timezone: string) => ({ $dateToString: { format: '%Y-%m-%d', date: `$${field}`, timezone } });

/** Rows by key: text order, nulls last */
const byKey = <T extends { key: string | null }>(rows: T[]): T[] =>
  rows.sort((a, b) => (a.key === b.key ? 0 : a.key === null ? 1 : b.key === null ? -1 : a.key < b.key ? -1 : 1));

/** An aggregate without GROUP BY answers one row even when nothing matches */
const oneRow = <T>(rows: T[], empty: T): T[] => (rows.length ? rows : [empty]);

/** Market days from..to (inclusive) as a loose instant range for an index, before the exact test on the market day */
const looseRange = (from: string, to: string) => ({ $gte: new Date(Date.parse(`${from}T00:00:00Z`) - 36 * 3_600_000), $lt: new Date(Date.parse(`${to}T00:00:00Z`) + 60 * 3_600_000) });

/** coalesce(col, '{}') || { k: coalesce(col->>k, 0) + n, … } */
function jsonAdd(column: string, add: Record<string, number>) {
  const current = { $ifNull: [`$${column}`, {}] };
  return {
    $mergeObjects: [
      current,
      { $arrayToObject: [Object.entries(add).map(([k, n]) => ({ k: lit(k), v: { $add: [{ $ifNull: [{ $getField: { field: lit(k), input: current } }, 0] }, n] } }))] },
    ],
  };
}

/** The update of an existing daily row: counters added, columns set, json counters merged (one atomic pipeline) */
function dailyUpdate(add: Record<string, number>, set: Record<string, unknown>, json?: { column: string; add: Record<string, number> }): Doc {
  const out: Doc = {};
  for (const [c, n] of Object.entries(add)) out[c] = { $add: [`$${c}`, n] };
  for (const [c, v] of Object.entries(set)) if (v !== undefined) out[c] = lit(v);
  if (json) out[json.column] = jsonAdd(json.column, json.add);
  return out;
}

/** The reports module's collections (MongoDB, docs/04-mongodb-migration.md): one per spec table. */
export class ReportsRepository {
  readonly #groups;
  readonly #metrics;
  readonly #versions;
  readonly #ownerChanges;
  readonly #suggestions;
  readonly #reports;
  readonly #views;
  readonly #schedules;
  readonly #datasets;
  readonly #jobs;
  readonly #items;
  readonly #refunds;
  readonly #returns;
  readonly #customers;
  readonly #service;
  readonly #checkpoints;

  constructor(private readonly store: ModuleStore) {
    this.#groups = this.#t<GroupRow>('report_groups');
    this.#metrics = this.#t<MetricRow>('metric_definitions');
    this.#versions = this.#t<VersionRow>('metric_versions');
    this.#ownerChanges = this.#t<OwnerChangeRow>('metric_owner_changes');
    this.#suggestions = this.#t<SuggestionRow>('metric_suggestions');
    this.#reports = this.#t<ReportRow>('report_definitions');
    this.#views = this.#t<SavedViewRow>('saved_views');
    this.#schedules = this.#t<ScheduleRow>('report_schedules');
    this.#datasets = this.#t<DatasetRow>('export_datasets');
    this.#jobs = this.#t<JobRow>('export_jobs');
    this.#items = this.#t<OrderItemFact>('fact_order_items');
    this.#refunds = this.#t<Row<'fact_refunds'>>('fact_refunds');
    this.#returns = this.#t<Row<'fact_returns'>>('fact_returns');
    this.#customers = this.#t<Row<'fact_customers'>>('fact_customers');
    this.#service = this.#t<Row<'fact_service_daily'>>('fact_service_daily');
    this.#checkpoints = this.#t<CheckpointRow>('read_model_checkpoints');
  }

  /** fn with a repository bound to one transaction */
  transaction<T>(fn: (tx: ReportsRepository) => Promise<T>): Promise<T> {
    return this.store.transaction((tx) => fn(new ReportsRepository(tx)));
  }

  /* ---------------------------------------------------------------- catalogue and definitions */
  async seedGroup(row: GroupRow): Promise<void> {
    await this.#groups.upsert(row, { update: { label: row.label, position: row.position } });
  }

  /** Names the owner of a report group; undefined for an unknown group */
  setGroupOwner(key: string, ownerStaffId: string): Promise<GroupRow | undefined> {
    return this.#groups.update(key, { owner_staff_id: ownerStaffId });
  }

  listGroups(): Promise<GroupRow[]> {
    return this.#groups.find({}, { sort: { position: 1 } });
  }

  async seedMetric(row: MetricRow, version: VersionRow): Promise<void> {
    if (await this.#metrics.insertIfAbsent(row)) await this.#versions.insertIfAbsent(version, ['metric_key', 'version']);
  }

  getMetric(key: string, opts: { forUpdate?: boolean } = {}): Promise<MetricRow | undefined> {
    return this.#metrics.get(key, opts);
  }

  listMetrics(f: { group?: string; status?: string; keys?: string[] }): Promise<MetricRow[]> {
    return this.#metrics.find({ ...(f.group ? { group_key: f.group } : {}), ...(f.status ? { status: f.status } : {}), ...(f.keys ? { key: { $in: f.keys } } : {}) }, { sort: { group_key: 1, key: 1 } });
  }

  insertMetric(row: MetricRow): Promise<MetricRow> {
    return this.#metrics.insert(row);
  }

  async updateMetric(key: string, patch: Partial<MetricRow>): Promise<MetricRow> {
    return orThrow(await this.#metrics.update(key, patch), `metric ${key}`);
  }

  async insertVersion(row: VersionRow): Promise<void> {
    await this.#versions.insert(row);
  }

  async insertOwnerChange(row: OwnerChangeRow): Promise<void> {
    await this.#ownerChanges.insert(row);
  }

  /** Owner history of a metric, newest first */
  listOwnerChanges(key: string): Promise<OwnerChangeRow[]> {
    return this.#ownerChanges.find({ metric_key: key }, { sort: { changed_at: -1, id: -1 } });
  }

  listVersions(key: string): Promise<VersionRow[]> {
    return this.#versions.find({ metric_key: key }, { sort: { version: -1 } });
  }

  /** Latest published version of each metric in effect on `day` */
  async versionsInEffect(keys: string[] | null, day: string): Promise<VersionRow[]> {
    // distinct on (metric_key) … order by metric_key, version desc
    const rows = await this.#versions.aggregate<{ doc: Doc }>([
      { $match: this.#versions.filter({ effective_from: { $lte: day }, ...(keys ? { metric_key: { $in: keys } } : {}) }) },
      { $sort: { metric_key: 1, version: -1 } },
      { $group: { _id: '$metric_key', doc: { $first: '$$ROOT' } } },
      { $sort: { _id: 1 } },
    ]);
    return rows.map((r) => this.#versions.fromDoc(r.doc));
  }

  insertSuggestion(row: SuggestionRow): Promise<SuggestionRow> {
    return this.#suggestions.insert(row);
  }

  getSuggestion(id: string, opts: { forUpdate?: boolean } = {}): Promise<SuggestionRow | undefined> {
    return this.#suggestions.get(id, opts);
  }

  async updateSuggestion(id: string, patch: Partial<SuggestionRow>): Promise<SuggestionRow> {
    return orThrow(await this.#suggestions.update(id, patch), `suggestion ${id}`);
  }

  listSuggestions(key: string): Promise<SuggestionRow[]> {
    return this.#suggestions.find({ metric_key: key }, { sort: { created_at: -1 } });
  }

  async upsertReport(row: ReportRow): Promise<void> {
    const { key: _key, active: _active, ...update } = row;
    await this.#reports.upsert(row, { update: Object.fromEntries(Object.entries(update).filter(([, v]) => v !== undefined)) });
  }

  getReport(key: string): Promise<ReportRow | undefined> {
    return this.#reports.get(key);
  }

  listReports(f: { audience?: string; active?: boolean }): Promise<ReportRow[]> {
    return this.#reports.find({ ...(f.audience ? { audience: f.audience } : {}), ...(f.active !== undefined ? { active: f.active } : {}) }, { sort: { group_key: 1, key: 1 } });
  }

  /* ---------------------------------------------------------------- saved views and schedules */
  listSavedViews(ownerId: string, reportKey?: string): Promise<SavedViewRow[]> {
    return this.#views.find({ $or: [{ owner_staff_id: ownerId }, { shared: true }], ...(reportKey ? { report_key: reportKey } : {}) }, { sort: { created_at: -1 } });
  }

  insertSavedView(row: SavedViewRow): Promise<SavedViewRow> {
    return this.#views.insert(row);
  }

  getSavedView(id: string): Promise<SavedViewRow | undefined> {
    return this.#views.get(id);
  }

  async deleteSavedView(id: string): Promise<void> {
    await this.#views.delete(id);
  }

  insertSchedule(row: ScheduleRow): Promise<ScheduleRow> {
    return this.#schedules.insert(row);
  }

  listSchedules(): Promise<ScheduleRow[]> {
    return this.#schedules.find({ active: true }, { sort: { next_run_at: 1 } });
  }

  getSchedule(id: string, opts: { forUpdate?: boolean } = {}): Promise<ScheduleRow | undefined> {
    return this.#schedules.get(id, opts);
  }

  async updateSchedule(id: string, patch: Partial<ScheduleRow>): Promise<ScheduleRow> {
    return orThrow(await this.#schedules.update(id, patch), `schedule ${id}`);
  }

  dueSchedules(now: Date, limit: number): Promise<ScheduleRow[]> {
    return this.#schedules.find({ active: true, next_run_at: { $lte: now } }, { sort: { next_run_at: 1 }, limit });
  }

  /* ---------------------------------------------------------------- export registry and jobs */
  listDatasets(): Promise<DatasetRow[]> {
    return this.#datasets.find({}, { sort: { key: 1 } });
  }

  getDataset(key: string): Promise<DatasetRow | undefined> {
    return this.#datasets.get(key);
  }

  /** Seed from the registry setting: keeps registered columns and title */
  async seedDataset(row: DatasetRow): Promise<void> {
    await this.#datasets.upsert(row, { update: { owner_module: row.owner_module, permission: row.permission, audience: row.audience, screens: row.screens, phase: row.phase, available: row.available } });
  }

  /** Owner registration: columns, title and availability */
  async registerDataset(row: DatasetRow): Promise<void> {
    await this.#datasets.upsert(row, { update: { title: row.title, columns: row.columns, available: row.available, registered_at: row.registered_at } });
  }

  insertJob(row: JobRow): Promise<JobRow> {
    return this.#jobs.insert(row);
  }

  getJob(id: string, opts: { forUpdate?: boolean } = {}): Promise<JobRow | undefined> {
    return this.#jobs.get(id, opts);
  }

  async updateJob(id: string, patch: Partial<JobRow>): Promise<JobRow> {
    return orThrow(await this.#jobs.update(id, patch), `export job ${id}`);
  }

  listJobs(f: { requesterId?: string; sellerId?: string; dataset?: string; state?: string }, page: PageRequest): Promise<Page<JobRow>> {
    return this.#jobs.page(
      { ...(f.requesterId ? { requested_by_id: f.requesterId } : {}), ...(f.sellerId ? { seller_id: f.sellerId } : {}), ...(f.dataset ? { dataset: f.dataset } : {}), ...(f.state ? { state: f.state } : {}) },
      page,
      { column: 'created_at', direction: 'desc' },
    );
  }

  countActiveJobs(requesterId: string): Promise<number> {
    return this.#jobs.count({ requested_by_id: requesterId, state: { $in: ['queued', 'running'] } });
  }

  queuedJobs(limit: number): Promise<JobRow[]> {
    return this.#jobs.find({ state: 'queued' }, { sort: { created_at: 1 }, limit });
  }

  readyJobsExpiring(now: Date, limit: number): Promise<JobRow[]> {
    return this.#jobs.find({ state: 'ready', expires_at: { $lte: now } }, { sort: { expires_at: 1 }, limit });
  }

  /* ---------------------------------------------------------------- facts: order items */
  async insertOrderItems(rows: OrderItemFact[]): Promise<string[]> {
    const inserted: string[] = [];
    for (const row of rows) if (await this.#items.insertIfAbsent(row)) inserted.push(row.order_item_id);
    return inserted;
  }

  getOrderItems(orderId: string): Promise<OrderItemFact[]> {
    return this.#items.find({ order_id: orderId });
  }

  async getOrderItemsByIds(ids: string[]): Promise<OrderItemFact[]> {
    return (ids.length ? this.#items.getMany(ids) : []);
  }

  updateOrderItems(w: { orderId?: string; itemIds?: string[]; groupId?: string | null; ownerType?: string; sellerId?: string | null; nullColumn?: keyof OrderItemFact }, patch: Partial<OrderItemFact>): Promise<number> {
    const f: Filter = {};
    if (w.orderId) f.order_id = w.orderId;
    if (w.itemIds) f.order_item_id = { $in: w.itemIds };
    if (w.groupId !== undefined) f.group_id = w.groupId;
    if (w.ownerType) f.owner_type = w.ownerType;
    if (w.sellerId !== undefined) f.seller_id = w.sellerId;
    if (w.nullColumn) f[w.nullColumn] = null;
    return this.#items.updateMany(f, patch);
  }

  async addToOrderItem(itemId: string, add: { cancelled_minor?: number; refunded_minor?: number }, patch: Partial<OrderItemFact>): Promise<OrderItemFact | undefined> {
    const set = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    const inc: Record<string, number> = {};
    if (add.cancelled_minor) inc.cancelled_minor = add.cancelled_minor;
    if (add.refunded_minor) inc.refunded_minor = add.refunded_minor;
    if (!Object.keys(set).length && !Object.keys(inc).length) return this.#items.get(itemId);
    return this.#items.update(itemId, { ...(Object.keys(set).length ? { $set: set } : {}), ...(Object.keys(inc).length ? { $inc: inc } : {}) });
  }

  /**
   * The next order ids (ascending) after `after`: at most `limit`, read from the next limit × 20 fact rows in
   * order_id order (the (order_id, group_id) index), so a page never groups the whole collection. A page may hold
   * fewer ids when orders have many items; walking on from the last id still visits every order once.
   */
  async orderIdsWithFacts(after: string | null, limit: number): Promise<string[]> {
    const rows = await this.#items.aggregate<{ _id: string }>([
      ...(after ? [{ $match: this.#items.filter({ order_id: { $gt: after } }) }] : []),
      { $sort: { order_id: 1 } },
      { $limit: limit * 20 },
      { $group: { _id: '$order_id' } },
      { $sort: { _id: 1 } },
      { $limit: limit },
    ]);
    return rows.map((r) => r._id);
  }

  /** A seller's rows of one offer placed at or after `since`, by order item id after `after` (re-costing on a cost change) */
  sellerRowsOfOffer(sellerId: string, offerId: string, since: Date, after: string | null, limit: number): Promise<OrderItemFact[]> {
    return this.#items.find({ seller_id: sellerId, placed_at: { $gte: since }, offer_id: offerId, owner_type: 'seller', ...(after ? { order_item_id: { $gt: after } } : {}) }, { sort: { order_item_id: 1 }, limit });
  }

  officialItemsWithoutCost(since: Date, limit: number): Promise<OrderItemFact[]> {
    return this.#items.find({ owner_type: 'official', buying_cost_minor: null, placed_at: { $gte: since } }, { sort: { placed_at: -1 }, limit });
  }

  async salesAgg(f: SalesFilter, group: SalesGroup, bucket: 'day' | 'week' | 'month' = 'day'): Promise<SalesAgg[]> {
    const key =
      group === 'bucket' ? bucketOf(`$${f.basis}`, bucket, f.timeZone) : group === 'customer' ? '$customer_key' : group === 'none' ? null : { $ifNull: [`$${group}`, null] };
    const sums = ['gross', 'tax', 'cancelled', 'refunded', 'units', 'costed_sales', 'cost', 'platform_discount', 'seller_discount', 'shipping', 'fee', 'costed_platform_discount'];
    const reSum = (prefix: string) => Object.fromEntries(sums.map((s) => [s, { $sum: `$${prefix}${s}` }]));
    // count(distinct order_id) and count(distinct customer_key) without holding every id of a group in one
    // document: rows → (key, customer, order) → (key, customer) → key; an order has one customer
    const costed = (value: string) => ({ $cond: [{ $eq: [{ $ifNull: ['$buying_cost_minor', null] }, null] }, 0, value] });
    const rows = await this.#items.aggregate<{ _id: string | null; orders: number; buyers: number; gross: number; tax: number; cancelled: number; refunded: number; units: number; costed_sales: number; cost: number; platform_discount: number; seller_discount: number; shipping: number; fee: number; costed_platform_discount: number }>([
      {
        $match: this.#items.filter({
          [f.basis]: { $gte: f.start, $lt: f.end },
          ...(f.ownerType ? { owner_type: f.ownerType } : {}),
          ...(f.sellerId ? { seller_id: f.sellerId } : {}),
          ...(f.categoryId ? { category_id: f.categoryId } : {}),
          ...(f.productId ? { product_id: f.productId } : {}),
        }),
      },
      {
        $group: {
          _id: { k: key, c: '$customer_key', o: '$order_id' },
          gross: { $sum: '$item_minor' },
          tax: { $sum: '$tax_minor' },
          cancelled: { $sum: '$cancelled_minor' },
          refunded: { $sum: '$refunded_minor' },
          units: { $sum: '$quantity' },
          costed_sales: { $sum: costed('$item_minor') },
          cost: { $sum: '$buying_cost_minor' },
          platform_discount: { $sum: '$discount_platform_minor' },
          seller_discount: { $sum: '$discount_seller_minor' },
          shipping: { $sum: '$shipping_minor' },
          fee: { $sum: '$fee_minor' },
          costed_platform_discount: { $sum: costed('$discount_platform_minor') },
        },
      },
      { $group: { _id: { k: '$_id.k', c: '$_id.c' }, ...reSum(''), orders: { $sum: 1 } } },
      { $group: { _id: '$_id.k', ...reSum(''), orders: { $sum: '$orders' }, buyers: { $sum: { $cond: [{ $eq: ['$_id.c', null] }, 0, 1] } } } },
    ]);
    const out = rows.map(
      (r): SalesAgg => ({
        key: r._id === null || r._id === undefined ? null : String(r._id),
        gross: r.gross,
        tax: r.tax,
        cancelled: r.cancelled,
        refunded: r.refunded,
        orders: r.orders,
        units: r.units,
        costedSales: r.costed_sales,
        cost: r.cost,
        buyers: r.buyers,
        platformDiscount: r.platform_discount,
        sellerDiscount: r.seller_discount,
        shipping: r.shipping,
        fee: r.fee,
        costedPlatformDiscount: r.costed_platform_discount,
      }),
    );
    if (group === 'none') return oneRow(out, { key: null, gross: 0, tax: 0, cancelled: 0, refunded: 0, orders: 0, units: 0, costedSales: 0, cost: 0, buyers: 0, platformDiscount: 0, sellerDiscount: 0, shipping: 0, fee: 0, costedPlatformDiscount: 0 });
    return byKey(out);
  }

  /**
   * Sales, refunds, fees and costs per seller offer (and its product) in a range on the date basis, the parts with a
   * known cost apart: Profit by product, a seller's own report (the filter always names the seller)
   */
  async offerProfitAgg(f: SalesFilter): Promise<OfferProfitAgg[]> {
    const costed = (value: unknown) => ({ $cond: [{ $eq: [{ $ifNull: ['$buying_cost_minor', null] }, null] }, 0, value] });
    const itemSales = { $add: ['$item_minor', '$discount_platform_minor'] };
    const refunds = { $add: ['$cancelled_minor', '$refunded_minor'] };
    const fee = { $ifNull: ['$fee_minor', 0] };
    const rows = await this.#items.aggregate<{ _id: { o: string; p: string }; units: number; itemSales: number; refunds: number; fee: number; cost: number; costedItemSales: number; costedRefunds: number; costedFee: number; rows: number; costedRows: number }>([
      {
        $match: this.#items.filter({
          [f.basis]: { $gte: f.start, $lt: f.end },
          ...(f.ownerType ? { owner_type: f.ownerType } : {}),
          ...(f.sellerId ? { seller_id: f.sellerId } : {}),
          ...(f.categoryId ? { category_id: f.categoryId } : {}),
          ...(f.productId ? { product_id: f.productId } : {}),
        }),
      },
      {
        $group: {
          _id: { o: '$offer_id', p: '$product_id' },
          units: { $sum: '$quantity' },
          itemSales: { $sum: itemSales },
          refunds: { $sum: refunds },
          fee: { $sum: fee },
          cost: { $sum: '$buying_cost_minor' },
          costedItemSales: { $sum: costed(itemSales) },
          costedRefunds: { $sum: costed(refunds) },
          costedFee: { $sum: costed(fee) },
          rows: { $sum: 1 },
          costedRows: { $sum: costed(1) },
        },
      },
      { $sort: { itemSales: -1, '_id.o': 1 } },
    ]);
    return rows.map(({ _id, ...r }) => ({ offerId: _id.o, productId: _id.p, ...r }));
  }

  /** Cancellations by cancellation date */
  async cancellationsAgg(f: Omit<SalesFilter, 'basis'>, group: 'bucket' | 'cancelled_by' | 'none', bucket: 'day' | 'week' | 'month' = 'day'): Promise<{ key: string | null; amount: number; items: number }[]> {
    const key = group === 'bucket' ? bucketOf('$cancelled_at', bucket, f.timeZone) : group === 'cancelled_by' ? { $ifNull: ['$cancelled_by', null] } : null;
    const rows = await this.#items.aggregate<{ _id: string | null; amount: number; items: number }>([
      {
        $match: this.#items.filter({
          cancelled_at: { $gte: f.start, $lt: f.end },
          ...(f.ownerType ? { owner_type: f.ownerType } : {}),
          ...(f.sellerId ? { seller_id: f.sellerId } : {}),
          ...(f.categoryId ? { category_id: f.categoryId } : {}),
          ...(f.productId ? { product_id: f.productId } : {}),
        }),
      },
      { $group: { _id: key, amount: { $sum: '$cancelled_minor' }, items: { $sum: 1 } } },
    ]);
    const out = rows.map((r) => ({ key: r._id ?? null, amount: r.amount, items: r.items }));
    return group === 'none' ? oneRow(out, { key: null, amount: 0, items: 0 }) : byKey(out);
  }

  /** Seller sales and discount funding per seller and placement day (for the finance daily facts) */
  async sellerSalesByDay(from: string, to: string, tz: string): Promise<{ sellerId: string; day: string; sales: number; platformDiscount: number; sellerDiscount: number }[]> {
    const rows = await this.#items.aggregate<{ _id: { s: string; d: string }; sales: number; platformDiscount: number; sellerDiscount: number }>([
      { $match: this.#items.filter({ owner_type: 'seller', seller_id: { $ne: null }, placed_at: looseRange(from, to) }) },
      { $addFields: { _day: dayOf('placed_at', tz) } },
      { $match: { _day: { $gte: from, $lte: to } } },
      { $group: { _id: { s: '$seller_id', d: '$_day' }, sales: { $sum: '$item_minor' }, platformDiscount: { $sum: '$discount_platform_minor' }, sellerDiscount: { $sum: '$discount_seller_minor' } } },
    ]);
    return rows.map((r) => ({ sellerId: r._id.s, day: r._id.d, sales: r.sales, platformDiscount: r.platformDiscount, sellerDiscount: r.sellerDiscount }));
  }

  async purchasesByDay(from: string, to: string, tz: string): Promise<{ productId: string; day: string; units: number }[]> {
    const rows = await this.#items.aggregate<{ _id: { p: string; d: string }; units: number }>([
      { $match: this.#items.filter({ placed_at: looseRange(from, to) }) },
      { $addFields: { _day: dayOf('placed_at', tz) } },
      { $match: { _day: { $gte: from, $lte: to } } },
      { $group: { _id: { p: '$product_id', d: '$_day' }, units: { $sum: '$quantity' } } },
    ]);
    return rows.map((r) => ({ productId: r._id.p, day: r._id.d, units: r.units }));
  }

  /* ---------------------------------------------------------------- facts: refunds, returns, customers */
  async insertRefund(row: Row<'fact_refunds'>): Promise<boolean> {
    return Boolean(await this.#refunds.insertIfAbsent(row, ['refund_id', 'seller_id']));
  }

  /** A payout to the seller was paid on a day between these market days (inclusive) */
  paidPayoutBetween(sellerId: string, fromDay: string, toDay: string): Promise<boolean> {
    return this.#t('fact_marketplace_finance_daily').exists({ seller_id: sellerId, payouts_paid_minor: { $gt: 0 }, day: { $gte: fromDay, $lte: toDay } });
  }

  async refundsAgg(f: { start: Date; end: Date; timeZone: string; ownerType?: string; sellerId?: string }, group: 'bucket' | 'reason' | 'none', bucket: 'day' | 'week' | 'month' = 'day'): Promise<{ key: string | null; amount: number; count: number }[]> {
    const key = group === 'bucket' ? bucketOf('$sent_at', bucket, f.timeZone) : group === 'reason' ? { $ifNull: ['$reason', 'unspecified'] } : null;
    const rows = await this.#refunds.aggregate<{ _id: string | null; amount: number; count: number }>([
      { $match: this.#refunds.filter({ sent_at: { $gte: f.start, $lt: f.end }, ...(f.ownerType ? { owner_type: f.ownerType } : {}), ...(f.sellerId ? { seller_id: f.sellerId } : {}) }) },
      // count(distinct refund_id)
      { $group: { _id: { k: key, r: '$refund_id' }, amount: { $sum: '$amount_minor' } } },
      { $group: { _id: '$_id.k', amount: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]);
    const out = rows.map((r) => ({ key: r._id ?? null, amount: r.amount, count: r.count }));
    return group === 'none' ? oneRow(out, { key: null, amount: 0, count: 0 }) : byKey(out);
  }

  async insertReturn(row: Row<'fact_returns'>): Promise<boolean> {
    return Boolean(await this.#returns.insertIfAbsent(row));
  }

  updateReturn(returnId: string, patch: Partial<Row<'fact_returns'>>): Promise<number> {
    return this.#returns.updateMany({ return_id: returnId }, patch);
  }

  async returnsAgg(f: { start: Date; end: Date; sellerId?: string; productId?: string; timeZone: string }, group: 'reason' | 'product_id' | 'seller_id' | 'outcome' | 'none'): Promise<{ key: string | null; requests: number; units: number }[]> {
    const key = group === 'none' ? null : group === 'outcome' ? { $ifNull: ['$outcome', 'not_inspected'] } : { $ifNull: [`$${group}`, null] };
    const rows = await this.#returns.aggregate<{ _id: string | null; requests: number; units: number }>([
      { $match: this.#returns.filter({ requested_at: { $gte: f.start, $lt: f.end }, ...(f.sellerId ? { seller_id: f.sellerId } : {}), ...(f.productId ? { product_id: f.productId } : {}) }) },
      { $group: { _id: key, requests: { $sum: 1 }, units: { $sum: '$units' } } },
    ]);
    const out = rows.map((r) => ({ key: r._id ?? null, requests: r.requests, units: r.units }));
    if (group === 'none') return oneRow(out, { key: null, requests: 0, units: 0 });
    // order by requests desc (ties by key, for a stable order)
    return byKey(out).sort((a, b) => b.requests - a.requests);
  }

  async upsertCustomer(key: string, at: Date, spend: number): Promise<void> {
    const inserted = await this.#customers.insertIfAbsent({ customer_key: key, first_order_at: at, last_order_at: at, orders: 1, net_spend_minor: spend });
    if (!inserted) await this.#customers.update(key, { $min: { first_order_at: at }, $max: { last_order_at: at }, $inc: { orders: 1, net_spend_minor: spend } });
  }

  async adjustCustomerSpend(key: string, delta: number): Promise<void> {
    await this.#customers.update(key, { $inc: { net_spend_minor: delta } });
  }

  /**
   * Recomputes fact_customers from the order item facts, a batch of customers at a time (keyset by customer key, index
   * fact_order_items (customer_key, order_id)), so only one batch is ever held in memory:
   *
   * 1. the customer keys of the next `batch` item facts after the last key done (at most `batch` customers);
   * 2. those customers' totals from all their item facts (orders counted once each);
   * 3. one upsertMany of the batch, and the removal of rows in the batch's key range that no longer have item facts.
   *
   * Rows are replaced in place instead of the table being emptied first, so reports read whole buyer rows during a
   * rebuild, and a buyer's first order arriving meanwhile (upsertCustomer) cannot clash with an insert here.
   * How many customers were written.
   */
  async rebuildCustomers(batch = 500): Promise<number> {
    let after: string | null = null;
    let written = 0;
    for (;;) {
      const keys: string[] = (
        await this.#items.aggregate<{ _id: string }>([
          { $match: after === null ? {} : { customer_key: { $gt: after } } },
          { $sort: { customer_key: 1 } },
          { $limit: batch },
          { $group: { _id: '$customer_key' } },
          { $sort: { _id: 1 } }, // the database's string order, which the $gt above follows
        ])
      ).map((r) => r._id);
      if (!keys.length) break;
      const rows = await this.#items.aggregate<{ _id: string; first_order_at: Date; last_order_at: Date; orders: number; net_spend_minor: number }>([
        { $match: { customer_key: { $in: keys } } },
        {
          $group: {
            _id: { k: '$customer_key', o: '$order_id' },
            first_order_at: { $min: '$placed_at' },
            last_order_at: { $max: '$placed_at' },
            net: { $sum: { $subtract: [{ $add: ['$item_minor', '$shipping_minor', '$tax_minor'] }, { $add: ['$cancelled_minor', '$refunded_minor'] }] } },
          },
        },
        { $group: { _id: '$_id.k', first_order_at: { $min: '$first_order_at' }, last_order_at: { $max: '$last_order_at' }, orders: { $sum: 1 }, net_spend_minor: { $sum: '$net' } } },
      ]);
      await this.#customers.upsertMany(rows.map((r) => ({ customer_key: r._id, first_order_at: r.first_order_at, last_order_at: r.last_order_at, orders: r.orders, net_spend_minor: r.net_spend_minor })));
      const last: string = keys.at(-1)!;
      // buyers in this key range without item facts any more (none of `keys`) are dropped
      await this.#customers.deleteMany({ customer_key: { ...(after === null ? {} : { $gt: after }), $lte: last, $nin: keys } });
      written += rows.length;
      after = last;
    }
    // and those after the last key that has item facts (every row when there are no item facts)
    await this.#customers.deleteMany(after === null ? {} : { customer_key: { $gt: after } });
    return written;
  }

  async customersAgg(f: { start: Date; end: Date }): Promise<{ buyers: number; newBuyers: number; returning: number; repeat: number }> {
    // the buyers of the range (inner join fact_customers): two reads
    const keys = (await this.#items.aggregate<{ _id: string }>([{ $match: this.#items.filter({ placed_at: { $gte: f.start, $lt: f.end } }) }, { $group: { _id: '$customer_key' } }])).map((r) => r._id);
    const out = { buyers: 0, newBuyers: 0, returning: 0, repeat: 0 };
    for (let i = 0; i < keys.length; i += 5000) {
      for (const c of await this.#customers.getMany(keys.slice(i, i + 5000))) {
        out.buyers++;
        if (c.first_order_at >= f.start) out.newBuyers++;
        else out.returning++;
        if (c.orders >= 2) out.repeat++;
      }
    }
    return out;
  }

  /* ---------------------------------------------------------------- facts: daily tables */
  /** Adds to counters of one (key, day) row, creating it; returns nothing. `set` overwrites columns. */
  async bumpDaily(table: DailyTable, key: Record<string, string>, add: Record<string, number>, set: Record<string, unknown> = {}, json?: { column: string; add: Record<string, number> }): Promise<void> {
    const def = DAILY[table];
    const daily = this.#t(table);
    const inserted = await daily.insertIfAbsent({ ...def.defaults, ...key, ...add, ...set, ...(json ? { [json.column]: json.add } : {}) }, def.key);
    if (inserted) return;
    const update = dailyUpdate(add, set, json);
    if (Object.keys(update).length) await daily.updateOne(key, [{ $set: update }]);
  }

  /** Service rows carry the open-case count forward from the seller's previous day */
  async bumpService(sellerId: string, day: string, add: Record<string, number>, complaintCategory?: string): Promise<void> {
    if (!(await this.#service.exists({ seller_id: sellerId, day }))) {
      const prev = await this.#service.findOne({ seller_id: sellerId, day: { $lt: day } }, { sort: { day: -1 } });
      await this.#service.insertIfAbsent({ ...DAILY.fact_service_daily.defaults, seller_id: sellerId, day, cases_open_eod: prev?.cases_open_eod ?? 0 }, ['seller_id', 'day']);
    }
    const update = dailyUpdate(add, {}, complaintCategory ? { column: 'complaints_by_category', add: { [complaintCategory]: 1 } } : undefined);
    if (Object.keys(update).length) await this.#service.updateOne({ seller_id: sellerId, day }, [{ $set: update }]);
  }

  /**
   * Replaces one day of a pulled fact table with what the source gave: each row's values set (upserted on its key),
   * and the day's rows the source no longer gives deleted (a seller whose balances went to zero). Safe to run twice.
   */
  async replaceDay(table: 'fact_company_daily' | 'fact_seller_balances_daily', day: string, rows: Record<string, unknown>[]): Promise<void> {
    const def = DAILY[table];
    const t = this.#t(table);
    for (const row of rows) await this.bumpDaily(table, Object.fromEntries(def.key.map((k) => [k, String(row[k])])), {}, Object.fromEntries(Object.entries(row).filter(([k]) => !def.key.includes(k))));
    const keep = rows.map((r) => ({ $and: def.key.filter((k) => k !== 'day').map((k) => ({ [k]: r[k] })) }));
    await t.deleteMany({ day, ...(keep.length ? { $nor: keep } : {}) });
  }

  /** fact_company_daily summed per (bucket or nothing, source, kind) over market days */
  async companySums(from: string, to: string, group: 'bucket' | 'none', bucket: 'day' | 'week' | 'month' = 'day'): Promise<{ key: string | null; source: string; kind: string; amount: number }[]> {
    const t = this.#t('fact_company_daily');
    const key = group === 'bucket' ? dayBucket(bucket) : null;
    const rows = await t.aggregate<{ _id: { k: string | null; s: string; kind: string }; amount: number }>([
      { $match: t.filter({ day: { $gte: from, $lte: to } }) },
      { $group: { _id: { k: key, s: '$source', kind: '$kind' }, amount: { $sum: '$amount_minor' } } },
    ]);
    return rows.map((r) => ({ key: r._id.k ?? null, source: r._id.s, kind: r._id.kind, amount: r.amount }));
  }

  /**
   * Seller balances summed per day for the given days: owed to sellers (pending + available of each seller, never
   * below zero), held, owed by sellers and how many sellers owe (fact_seller_balances_daily)
   */
  async balanceTotals(days: string[], sellerId?: string): Promise<{ day: string; owed: number; held: number; negative: number; negativeCount: number }[]> {
    if (!days.length) return [];
    const t = this.#t('fact_seller_balances_daily');
    const rows = await t.aggregate<{ _id: string; owed: number; held: number; negative: number; negativeCount: number }>([
      { $match: t.filter({ day: { $in: days }, ...(sellerId ? { seller_id: sellerId } : {}) }) },
      {
        $group: {
          _id: '$day',
          owed: { $sum: { $max: [0, { $add: ['$pending_minor', '$available_minor'] }] } },
          held: { $sum: '$held_minor' },
          negative: { $sum: '$owed_minor' },
          negativeCount: { $sum: { $cond: [{ $gt: ['$owed_minor', 0] }, 1, 0] } },
        },
      },
    ]);
    return rows.map((r) => ({ day: r._id, owed: r.owed, held: r.held, negative: r.negative, negativeCount: r.negativeCount }));
  }

  /** Each seller's balance row of a day */
  sellerBalancesOn(day: string, sellerIds: string[]): Promise<Row<'fact_seller_balances_daily'>[]> {
    if (!sellerIds.length) return Promise.resolve([]);
    return this.#t<Row<'fact_seller_balances_daily'>>('fact_seller_balances_daily').find({ day, seller_id: { $in: sellerIds } });
  }

  async dailySums(table: DailyTable, f: DailyFilter, columns: string[], group: 'bucket' | 'seller_id' | 'product_id' | 'campaign' | 'query_norm' | 'none', bucket: 'day' | 'week' | 'month' = 'day'): Promise<({ key: string | null } & Record<string, number>)[]> {
    const daily = this.#t(table);
    const key =
      group === 'bucket'
        ? dayBucket(bucket)
        : group === 'campaign'
          ? { $concat: ['$campaign_kind', ':', '$campaign_id'] }
          : group === 'none'
            ? null
            : { $ifNull: [`$${group}`, null] };
    const AVG = 'first_reply_minutes_p50';
    const rows = await daily.aggregate<Doc>([
      { $match: daily.filter({ day: { $gte: f.from, $lte: f.to }, ...(f.sellerId ? { seller_id: f.sellerId } : {}), ...(f.productId ? { product_id: f.productId } : {}), ...(f.campaignKind ? { campaign_kind: f.campaignKind } : {}) }) },
      { $group: { _id: key, ...Object.fromEntries(columns.map((c) => [c, c === AVG ? { $avg: `$${c}` } : { $sum: `$${c}` }])) } },
    ]);
    const out = rows.map((r) => ({ key: (r._id as string | null) ?? null, ...Object.fromEntries(columns.map((c) => [c, (r[c] as number | null) ?? 0])) }) as { key: string | null } & Record<string, number>);
    if (group === 'none') return oneRow(out, { key: null, ...Object.fromEntries(columns.map((c) => [c, 0])) } as { key: string | null } & Record<string, number>);
    return byKey(out);
  }

  async caseBacklog(day: string, sellerId?: string): Promise<number> {
    // each seller's latest row up to the day (distinct on seller_id … order by day desc), open cases summed
    const [r] = await this.#service.aggregate<{ n: number }>([
      { $match: this.#service.filter({ day: { $lte: day }, ...(sellerId ? { seller_id: sellerId } : {}) }) },
      { $sort: { seller_id: 1, day: -1 } },
      { $group: { _id: '$seller_id', open: { $first: '$cases_open_eod' } } },
      { $group: { _id: null, n: { $sum: { $max: ['$open', 0] } } } },
    ]);
    return r?.n ?? 0;
  }

  sellersWithMessages(day: string): Promise<string[]> {
    return this.#service.distinct<string>('seller_id', { day, messages_received: { $gt: 0 } });
  }

  /* ---------------------------------------------------------------- read model bookkeeping */
  getCheckpoint(key: string): Promise<CheckpointRow | undefined> {
    return this.#checkpoints.get(key);
  }

  async listCheckpoints(keys: string[]): Promise<CheckpointRow[]> {
    return (keys.length ? this.#checkpoints.getMany(keys) : []);
  }

  async upsertCheckpoint(key: string, patch: Partial<CheckpointRow>): Promise<void> {
    const update = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    await this.#checkpoints.upsert({ key, state: 'live', last_event_id: null, last_event_at: null, rebuild_started_at: null, rebuild_progress: null, ...update }, { update });
  }

  /** Claims a natural key in the inbox (ctx.mongo.claim) within this repository's transaction; false when it was already handled */
  claim(key: string): Promise<boolean> {
    return this.store.claim(key);
  }

  /** Opens an out-of-stock interval for a stock item (open_stockouts); an open one stays as it is */
  async openStockout(stockItemId: string, productId: string, since: Date): Promise<boolean> {
    return Boolean(await this.#t('open_stockouts').insertIfAbsent({ stock_item_id: stockItemId, product_id: productId, since }));
  }

  getStockout(stockItemId: string, opts?: { forUpdate?: boolean }): Promise<Row<'open_stockouts'> | undefined> {
    return this.#t<Row<'open_stockouts'>>('open_stockouts').get(stockItemId, opts);
  }

  async closeStockout(stockItemId: string): Promise<void> {
    await this.#t('open_stockouts').delete(stockItemId);
  }

  /** The campaign behind a coupon redemption or ad charge (campaign_refs); the first value stays */
  async rememberCampaign(kind: 'redemption' | 'charge', refId: string, campaignId: string, at: Date): Promise<void> {
    await this.#t('campaign_refs').insertIfAbsent({ kind, ref_id: refId, campaign_id: campaignId, created_at: at }, ['kind', 'ref_id']);
  }

  async campaignOf(kind: 'redemption' | 'charge', refId: string): Promise<string | null> {
    const r = await this.#t<Row<'campaign_refs'>>('campaign_refs').findOne({ kind, ref_id: refId });
    return r?.campaign_id ?? null;
  }

  countRows(table: Table): Promise<number> {
    return this.#t(table).count();
  }

  #t<R extends object = any>(name: Table): MongoTable<R> {
    return this.store.table<R>(name);
  }
}
