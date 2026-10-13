import type { ModuleStore } from '../../kernel/mongo/index.js';
import type { Filter, Table as MongoTable } from '../../kernel/mongo/table.js';
import type {
  CheckpointRow,
  DailyTable,
  DatasetRow,
  GroupRow,
  JobRow,
  MetricRow,
  OrderItemFact,
  OwnerChangeRow,
  ReportRow,
  ReportsRepository,
  Row,
  SalesAgg,
  SalesFilter,
  SalesGroup,
  SavedViewRow,
  ScheduleRow,
  SuggestionRow,
  Table,
  VersionRow,
} from './ports.js';

type Doc = Record<string, unknown>;

/** Key columns and counter defaults of the daily fact tables */
const DAILY: Record<DailyTable, { key: string[]; defaults: Record<string, unknown> }> = {
  fact_marketplace_finance_daily: {
    key: ['seller_id', 'day'],
    defaults: { seller_sales_minor: 0, fee_income_minor: 0, platform_discount_minor: 0, seller_discount_minor: 0, held_minor: 0, payouts_paid_minor: 0, payouts_failed: 0, owed_minor: 0, ad_charges_minor: 0, service_fees_minor: 0 },
  },
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

/** MongoDB adapter for ReportsRepository (docs/04-mongodb-migration.md): one collection per spec table. */
export function createMongoReportsRepository(store: ModuleStore): ReportsRepository {
  const t = <R extends object = any>(name: Table): MongoTable<R> => store.table<R>(name);
  const groups = t<GroupRow>('report_groups');
  const metrics = t<MetricRow>('metric_definitions');
  const versions = t<VersionRow>('metric_versions');
  const ownerChanges = t<OwnerChangeRow>('metric_owner_changes');
  const suggestions = t<SuggestionRow>('metric_suggestions');
  const reports = t<ReportRow>('report_definitions');
  const views = t<SavedViewRow>('saved_views');
  const schedules = t<ScheduleRow>('report_schedules');
  const datasets = t<DatasetRow>('export_datasets');
  const jobs = t<JobRow>('export_jobs');
  const items = t<OrderItemFact>('fact_order_items');
  const refunds = t<Row<'fact_refunds'>>('fact_refunds');
  const returns = t<Row<'fact_returns'>>('fact_returns');
  const customers = t<Row<'fact_customers'>>('fact_customers');
  const service = t<Row<'fact_service_daily'>>('fact_service_daily');
  const checkpoints = t<CheckpointRow>('read_model_checkpoints');

  const found = <T>(row: T | undefined, what: string): T => {
    if (!row) throw new Error(`reports: ${what} not found`);
    return row;
  };

  const repo: ReportsRepository = {
    transaction: (fn) => store.transaction((tx) => fn(createMongoReportsRepository(tx))),

    /* ---------------------------------------------------------------- catalogue and definitions */

    async seedGroup(row) {
      await groups.upsert(row, { update: { label: row.label, position: row.position } });
    },
    setGroupOwner: (key, ownerStaffId) => groups.update(key, { owner_staff_id: ownerStaffId }),
    listGroups: () => groups.find({}, { sort: { position: 1 } }),
    async seedMetric(row, version) {
      if (await metrics.insertIfAbsent(row)) await versions.insertIfAbsent(version, ['metric_key', 'version']);
    },
    getMetric: (key, opts = {}) => metrics.get(key, opts),
    listMetrics: (f) =>
      metrics.find({ ...(f.group ? { group_key: f.group } : {}), ...(f.status ? { status: f.status } : {}), ...(f.keys ? { key: { $in: f.keys } } : {}) }, { sort: { group_key: 1, key: 1 } }),
    insertMetric: (row) => metrics.insert(row),
    updateMetric: async (key, patch) => found(await metrics.update(key, patch), `metric ${key}`),
    async insertVersion(row) {
      await versions.insert(row);
    },
    async insertOwnerChange(row) {
      await ownerChanges.insert(row);
    },
    listOwnerChanges: (key) => ownerChanges.find({ metric_key: key }, { sort: { changed_at: -1, id: -1 } }),
    listVersions: (key) => versions.find({ metric_key: key }, { sort: { version: -1 } }),
    async versionsInEffect(keys, day) {
      // distinct on (metric_key) … order by metric_key, version desc
      const rows = await versions.aggregate<{ doc: Doc }>([
        { $match: versions.filter({ effective_from: { $lte: day }, ...(keys ? { metric_key: { $in: keys } } : {}) }) },
        { $sort: { metric_key: 1, version: -1 } },
        { $group: { _id: '$metric_key', doc: { $first: '$$ROOT' } } },
        { $sort: { _id: 1 } },
      ]);
      return rows.map((r) => versions.fromDoc(r.doc));
    },
    insertSuggestion: (row) => suggestions.insert(row),
    getSuggestion: (id, opts = {}) => suggestions.get(id, opts),
    updateSuggestion: async (id, patch) => found(await suggestions.update(id, patch), `suggestion ${id}`),
    listSuggestions: (key) => suggestions.find({ metric_key: key }, { sort: { created_at: -1 } }),
    async upsertReport(row) {
      const { key: _key, active: _active, ...update } = row;
      await reports.upsert(row, { update: Object.fromEntries(Object.entries(update).filter(([, v]) => v !== undefined)) });
    },
    getReport: (key) => reports.get(key),
    listReports: (f) => reports.find({ ...(f.audience ? { audience: f.audience } : {}), ...(f.active !== undefined ? { active: f.active } : {}) }, { sort: { group_key: 1, key: 1 } }),

    /* ---------------------------------------------------------------- saved views and schedules */

    listSavedViews: (ownerId, reportKey) =>
      views.find({ $or: [{ owner_staff_id: ownerId }, { shared: true }], ...(reportKey ? { report_key: reportKey } : {}) }, { sort: { created_at: -1 } }),
    insertSavedView: (row) => views.insert(row),
    getSavedView: (id) => views.get(id),
    async deleteSavedView(id) {
      await views.delete(id);
    },
    insertSchedule: (row) => schedules.insert(row),
    listSchedules: () => schedules.find({ active: true }, { sort: { next_run_at: 1 } }),
    getSchedule: (id, opts = {}) => schedules.get(id, opts),
    updateSchedule: async (id, patch) => found(await schedules.update(id, patch), `schedule ${id}`),
    dueSchedules: (now, limit) => schedules.find({ active: true, next_run_at: { $lte: now } }, { sort: { next_run_at: 1 }, limit }),

    /* ---------------------------------------------------------------- export registry and jobs */

    listDatasets: () => datasets.find({}, { sort: { key: 1 } }),
    getDataset: (key) => datasets.get(key),
    async seedDataset(row) {
      await datasets.upsert(row, { update: { owner_module: row.owner_module, permission: row.permission, audience: row.audience, screens: row.screens, phase: row.phase, available: row.available } });
    },
    async registerDataset(row) {
      await datasets.upsert(row, { update: { title: row.title, columns: row.columns, available: row.available, registered_at: row.registered_at } });
    },
    insertJob: (row) => jobs.insert(row),
    getJob: (id, opts = {}) => jobs.get(id, opts),
    updateJob: async (id, patch) => found(await jobs.update(id, patch), `export job ${id}`),
    listJobs: (f, page) =>
      jobs.page(
        { ...(f.requesterId ? { requested_by_id: f.requesterId } : {}), ...(f.sellerId ? { seller_id: f.sellerId } : {}), ...(f.dataset ? { dataset: f.dataset } : {}), ...(f.state ? { state: f.state } : {}) },
        page,
        { column: 'created_at', direction: 'desc' },
      ),
    countActiveJobs: (requesterId) => jobs.count({ requested_by_id: requesterId, state: { $in: ['queued', 'running'] } }),
    queuedJobs: (limit) => jobs.find({ state: 'queued' }, { sort: { created_at: 1 }, limit }),
    readyJobsExpiring: (now, limit) => jobs.find({ state: 'ready', expires_at: { $lte: now } }, { sort: { expires_at: 1 }, limit }),

    /* ---------------------------------------------------------------- facts: order items */

    async insertOrderItems(rows) {
      const inserted: string[] = [];
      for (const row of rows) if (await items.insertIfAbsent(row)) inserted.push(row.order_item_id);
      return inserted;
    },
    getOrderItems: (orderId) => items.find({ order_id: orderId }),
    getOrderItemsByIds: async (ids) => (ids.length ? items.getMany(ids) : []),
    updateOrderItems(w, patch) {
      const f: Filter = {};
      if (w.orderId) f.order_id = w.orderId;
      if (w.itemIds) f.order_item_id = { $in: w.itemIds };
      if (w.groupId !== undefined) f.group_id = w.groupId;
      if (w.ownerType) f.owner_type = w.ownerType;
      if (w.sellerId !== undefined) f.seller_id = w.sellerId;
      if (w.nullColumn) f[w.nullColumn] = null;
      return items.updateMany(f, patch);
    },
    async addToOrderItem(itemId, add, patch) {
      const set = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
      const inc: Record<string, number> = {};
      if (add.cancelled_minor) inc.cancelled_minor = add.cancelled_minor;
      if (add.refunded_minor) inc.refunded_minor = add.refunded_minor;
      if (!Object.keys(set).length && !Object.keys(inc).length) return items.get(itemId);
      return items.update(itemId, { ...(Object.keys(set).length ? { $set: set } : {}), ...(Object.keys(inc).length ? { $inc: inc } : {}) });
    },
    async orderIdsWithFacts(after, limit) {
      const rows = await items.aggregate<{ _id: string }>([
        ...(after ? [{ $match: items.filter({ order_id: { $gt: after } }) }] : []),
        { $group: { _id: '$order_id' } },
        { $sort: { _id: 1 } },
        { $limit: limit },
      ]);
      return rows.map((r) => r._id);
    },
    officialItemsWithoutCost: (since, limit) => items.find({ owner_type: 'official', buying_cost_minor: null, placed_at: { $gte: since } }, { sort: { placed_at: -1 }, limit }),
    async salesAgg(f: SalesFilter, group: SalesGroup, bucket = 'day') {
      const key =
        group === 'bucket' ? bucketOf(`$${f.basis}`, bucket, f.timeZone) : group === 'customer' ? '$customer_key' : group === 'none' ? null : { $ifNull: [`$${group}`, null] };
      const sums = ['gross', 'tax', 'cancelled', 'refunded', 'units', 'costed_sales', 'cost', 'platform_discount', 'seller_discount'];
      const reSum = (prefix: string) => Object.fromEntries(sums.map((s) => [s, { $sum: `$${prefix}${s}` }]));
      // count(distinct order_id) and count(distinct customer_key) without holding every id of a group in one
      // document: rows → (key, customer, order) → (key, customer) → key; an order has one customer
      const rows = await items.aggregate<{ _id: string | null; orders: number; buyers: number; gross: number; tax: number; cancelled: number; refunded: number; units: number; costed_sales: number; cost: number; platform_discount: number; seller_discount: number }>([
        {
          $match: items.filter({
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
            costed_sales: { $sum: { $cond: [{ $eq: [{ $ifNull: ['$buying_cost_minor', null] }, null] }, 0, '$item_minor'] } },
            cost: { $sum: '$buying_cost_minor' },
            platform_discount: { $sum: '$discount_platform_minor' },
            seller_discount: { $sum: '$discount_seller_minor' },
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
        }),
      );
      if (group === 'none') return oneRow(out, { key: null, gross: 0, tax: 0, cancelled: 0, refunded: 0, orders: 0, units: 0, costedSales: 0, cost: 0, buyers: 0, platformDiscount: 0, sellerDiscount: 0 });
      return byKey(out);
    },
    async cancellationsAgg(f, group, bucket = 'day') {
      const key = group === 'bucket' ? bucketOf('$cancelled_at', bucket, f.timeZone) : group === 'cancelled_by' ? { $ifNull: ['$cancelled_by', null] } : null;
      const rows = await items.aggregate<{ _id: string | null; amount: number; items: number }>([
        {
          $match: items.filter({
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
    },
    async sellerSalesByDay(from, to, tz) {
      const rows = await items.aggregate<{ _id: { s: string; d: string }; sales: number; platformDiscount: number; sellerDiscount: number }>([
        { $match: items.filter({ owner_type: 'seller', seller_id: { $ne: null }, placed_at: looseRange(from, to) }) },
        { $addFields: { _day: dayOf('placed_at', tz) } },
        { $match: { _day: { $gte: from, $lte: to } } },
        { $group: { _id: { s: '$seller_id', d: '$_day' }, sales: { $sum: '$item_minor' }, platformDiscount: { $sum: '$discount_platform_minor' }, sellerDiscount: { $sum: '$discount_seller_minor' } } },
      ]);
      return rows.map((r) => ({ sellerId: r._id.s, day: r._id.d, sales: r.sales, platformDiscount: r.platformDiscount, sellerDiscount: r.sellerDiscount }));
    },
    async purchasesByDay(from, to, tz) {
      const rows = await items.aggregate<{ _id: { p: string; d: string }; units: number }>([
        { $match: items.filter({ placed_at: looseRange(from, to) }) },
        { $addFields: { _day: dayOf('placed_at', tz) } },
        { $match: { _day: { $gte: from, $lte: to } } },
        { $group: { _id: { p: '$product_id', d: '$_day' }, units: { $sum: '$quantity' } } },
      ]);
      return rows.map((r) => ({ productId: r._id.p, day: r._id.d, units: r.units }));
    },

    /* ---------------------------------------------------------------- facts: refunds, returns, customers */

    insertRefund: async (row) => Boolean(await refunds.insertIfAbsent(row, ['refund_id', 'seller_id'])),
    paidPayoutBetween: (sellerId, fromDay, toDay) => t('fact_marketplace_finance_daily').exists({ seller_id: sellerId, payouts_paid_minor: { $gt: 0 }, day: { $gte: fromDay, $lte: toDay } }),
    async refundsAgg(f, group, bucket = 'day') {
      const key = group === 'bucket' ? bucketOf('$sent_at', bucket, f.timeZone) : group === 'reason' ? { $ifNull: ['$reason', 'unspecified'] } : null;
      const rows = await refunds.aggregate<{ _id: string | null; amount: number; count: number }>([
        { $match: refunds.filter({ sent_at: { $gte: f.start, $lt: f.end }, ...(f.ownerType ? { owner_type: f.ownerType } : {}), ...(f.sellerId ? { seller_id: f.sellerId } : {}) }) },
        // count(distinct refund_id)
        { $group: { _id: { k: key, r: '$refund_id' }, amount: { $sum: '$amount_minor' } } },
        { $group: { _id: '$_id.k', amount: { $sum: '$amount' }, count: { $sum: 1 } } },
      ]);
      const out = rows.map((r) => ({ key: r._id ?? null, amount: r.amount, count: r.count }));
      return group === 'none' ? oneRow(out, { key: null, amount: 0, count: 0 }) : byKey(out);
    },
    insertReturn: async (row) => Boolean(await returns.insertIfAbsent(row)),
    updateReturn: (returnId, patch) => returns.updateMany({ return_id: returnId }, patch),
    async returnsAgg(f, group) {
      const key = group === 'none' ? null : group === 'outcome' ? { $ifNull: ['$outcome', 'not_inspected'] } : { $ifNull: [`$${group}`, null] };
      const rows = await returns.aggregate<{ _id: string | null; requests: number; units: number }>([
        { $match: returns.filter({ requested_at: { $gte: f.start, $lt: f.end }, ...(f.sellerId ? { seller_id: f.sellerId } : {}), ...(f.productId ? { product_id: f.productId } : {}) }) },
        { $group: { _id: key, requests: { $sum: 1 }, units: { $sum: '$units' } } },
      ]);
      const out = rows.map((r) => ({ key: r._id ?? null, requests: r.requests, units: r.units }));
      if (group === 'none') return oneRow(out, { key: null, requests: 0, units: 0 });
      // order by requests desc (ties by key, for a stable order)
      return byKey(out).sort((a, b) => b.requests - a.requests);
    },
    async upsertCustomer(key, at, spend) {
      const inserted = await customers.insertIfAbsent({ customer_key: key, first_order_at: at, last_order_at: at, orders: 1, net_spend_minor: spend });
      if (!inserted) await customers.update(key, { $min: { first_order_at: at }, $max: { last_order_at: at }, $inc: { orders: 1, net_spend_minor: spend } });
    },
    async adjustCustomerSpend(key, delta) {
      await customers.update(key, { $inc: { net_spend_minor: delta } });
    },
    async rebuildCustomers() {
      await customers.deleteMany({});
      const rows = await items.aggregate<{ _id: string; first_order_at: Date; last_order_at: Date; orders: number; net_spend_minor: number }>([
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
      const out = rows.map((r) => ({ customer_key: r._id, first_order_at: r.first_order_at, last_order_at: r.last_order_at, orders: r.orders, net_spend_minor: r.net_spend_minor }));
      for (let i = 0; i < out.length; i += 500) await customers.insertMany(out.slice(i, i + 500));
      return out.length;
    },
    async customersAgg(f) {
      // the buyers of the range (inner join fact_customers): two reads
      const keys = (await items.aggregate<{ _id: string }>([{ $match: items.filter({ placed_at: { $gte: f.start, $lt: f.end } }) }, { $group: { _id: '$customer_key' } }])).map((r) => r._id);
      const out = { buyers: 0, newBuyers: 0, returning: 0, repeat: 0 };
      for (let i = 0; i < keys.length; i += 5000) {
        for (const c of await customers.getMany(keys.slice(i, i + 5000))) {
          out.buyers++;
          if (c.first_order_at >= f.start) out.newBuyers++;
          else out.returning++;
          if (c.orders >= 2) out.repeat++;
        }
      }
      return out;
    },

    /* ---------------------------------------------------------------- facts: daily tables */

    async bumpDaily(table, key, add, set = {}, json?: { column: string; add: Record<string, number> }) {
      const def = DAILY[table];
      const daily = t(table);
      const inserted = await daily.insertIfAbsent({ ...def.defaults, ...key, ...add, ...set, ...(json ? { [json.column]: json.add } : {}) }, def.key);
      if (inserted) return;
      const update = dailyUpdate(add, set, json);
      if (Object.keys(update).length) await daily.updateOne(key, [{ $set: update }]);
    },
    async bumpService(sellerId, day, add, complaintCategory) {
      if (!(await service.exists({ seller_id: sellerId, day }))) {
        const prev = await service.findOne({ seller_id: sellerId, day: { $lt: day } }, { sort: { day: -1 } });
        await service.insertIfAbsent({ ...DAILY.fact_service_daily.defaults, seller_id: sellerId, day, cases_open_eod: prev?.cases_open_eod ?? 0 }, ['seller_id', 'day']);
      }
      const update = dailyUpdate(add, {}, complaintCategory ? { column: 'complaints_by_category', add: { [complaintCategory]: 1 } } : undefined);
      if (Object.keys(update).length) await service.updateOne({ seller_id: sellerId, day }, [{ $set: update }]);
    },
    async dailySums(table, f, columns, group, bucket = 'day') {
      const daily = t(table);
      const key =
        group === 'bucket'
          ? { $dateToString: { format: '%Y-%m-%d', date: { $dateTrunc: { date: { $dateFromString: { dateString: '$day', format: '%Y-%m-%d' } }, unit: bucket, ...(bucket === 'week' ? { startOfWeek: 'monday' } : {}) } } } }
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
    },
    async caseBacklog(day, sellerId) {
      // each seller's latest row up to the day (distinct on seller_id … order by day desc), open cases summed
      const [r] = await service.aggregate<{ n: number }>([
        { $match: service.filter({ day: { $lte: day }, ...(sellerId ? { seller_id: sellerId } : {}) }) },
        { $sort: { seller_id: 1, day: -1 } },
        { $group: { _id: '$seller_id', open: { $first: '$cases_open_eod' } } },
        { $group: { _id: null, n: { $sum: { $max: ['$open', 0] } } } },
      ]);
      return r?.n ?? 0;
    },
    sellersWithMessages: (day) => service.distinct<string>('seller_id', { day, messages_received: { $gt: 0 } }),

    /* ---------------------------------------------------------------- read model bookkeeping */

    getCheckpoint: (key) => checkpoints.get(key),
    listCheckpoints: async (keys) => (keys.length ? checkpoints.getMany(keys) : []),
    async upsertCheckpoint(key, patch) {
      const update = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
      await checkpoints.upsert({ key, state: 'live', last_event_id: null, last_event_at: null, rebuild_started_at: null, rebuild_progress: null, ...update }, { update });
    },
    claim: (key) => store.claim(key),
    openStockout: async (stockItemId, productId, since) => Boolean(await t('open_stockouts').insertIfAbsent({ stock_item_id: stockItemId, product_id: productId, since })),
    getStockout: (stockItemId, opts) => t<Row<'open_stockouts'>>('open_stockouts').get(stockItemId, opts),
    async closeStockout(stockItemId) {
      await t('open_stockouts').delete(stockItemId);
    },
    async rememberCampaign(kind, refId, campaignId, at) {
      await t('campaign_refs').insertIfAbsent({ kind, ref_id: refId, campaign_id: campaignId, created_at: at }, ['kind', 'ref_id']);
    },
    async campaignOf(kind, refId) {
      const r = await t<Row<'campaign_refs'>>('campaign_refs').findOne({ kind, ref_id: refId });
      return r?.campaign_id ?? null;
    },
    countRows: (table) => t(table).count(),
  };
  return repo;
}
