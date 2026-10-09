import { sql, type Kysely, type RawBuilder } from 'kysely';
import type { Inbox } from '../../../../kernel/events/inbox.js';
import { paginate } from '../../../../kernel/lib/pagination.js';
import type { ReportsDb } from '../../../../spec/reports.js';
import type { DailyTable, ReportsRepository, SalesFilter, SalesGroup, Table } from '../../ports.js';

/** jsonb columns per table: values are sent as JSON text (pg would turn JS arrays into PG arrays) */
const JSON_COLUMNS: Partial<Record<Table, readonly string[]>> = {
  metric_definitions: ['includes', 'excludes', 'date_basis_options', 'related_keys'],
  metric_versions: ['snapshot'],
  report_definitions: ['metrics', 'dimensions', 'filters', 'layout'],
  saved_views: ['query'],
  report_schedules: ['recipients'],
  export_datasets: ['columns', 'screens'],
  export_jobs: ['filters', 'columns_excluded'],
  fact_service_daily: ['complaints_by_category'],
  fact_campaigns_daily: ['funded_by'],
};

function encode(table: Table, row: Record<string, unknown>): Record<string, unknown> {
  const cols = JSON_COLUMNS[table] ?? [];
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v === undefined) continue;
    out[k] = cols.includes(k) ? (v === null ? null : JSON.stringify(v)) : v;
  }
  return out;
}

/** Key columns and counter defaults of the daily fact tables */
const DAILY: Record<DailyTable, { key: string[]; defaults: Record<string, unknown> }> = {
  fact_marketplace_finance_daily: {
    key: ['seller_id', 'day'],
    defaults: { seller_sales_minor: 0, fee_income_minor: 0, platform_discount_minor: 0, seller_discount_minor: 0, held_minor: 0, payouts_paid_minor: 0, payouts_failed: 0, owed_minor: 0, ad_charges_minor: 0 },
  },
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

const bucketExpr = (col: RawBuilder<unknown>, unit: string) => sql<string>`to_char(date_trunc(${unit}, ${col}), 'YYYY-MM-DD')`;
const sumInt = (col: string) => sql<number>`coalesce(sum(${sql.ref(col)}), 0)::bigint`;

/** jsonb counters merged into a json column: { a: old.a + n, … } */
function jsonAddExpr(table: string, column: string, add: Record<string, number>): RawBuilder<unknown> {
  let expr: RawBuilder<unknown> = sql`coalesce(${sql.ref(`${table}.${column}`)}, '{}'::jsonb)`;
  for (const [k, n] of Object.entries(add)) {
    expr = sql`${expr} || jsonb_build_object(${k}::text, coalesce((${sql.ref(`${table}.${column}`)} ->> ${k}::text)::bigint, 0) + ${n}::bigint)`;
  }
  return expr;
}

/** Lookups kept between events (open stock-out intervals, redemption and charge campaigns) */
const LOOKUP = 'lookup:';

/**
 * Postgres adapter for ReportsRepository. `db` is scoped to the `reports` schema; `inbox` (ctx.inbox) records
 * the natural keys idempotent consumers handled, in the same transaction as their effects.
 */
export function createPostgresReportsRepository(db: Kysely<ReportsDb>, inbox: Inbox): ReportsRepository {
  const d = db as Kysely<any>;
  const repo: ReportsRepository = {
    async transaction(fn) {
      if (db.isTransaction) return fn(repo);
      return db.transaction().execute((trx) => fn(createPostgresReportsRepository(trx, inbox)));
    },

    /* ---------------------------------------------------------------- catalogue and definitions */

    async seedGroup(row) {
      await d.insertInto('report_groups').values(row).onConflict((oc: any) => oc.column('key').doUpdateSet({ label: row.label, position: row.position })).execute();
    },
    async listGroups() {
      return db.selectFrom('report_groups').selectAll().orderBy('position').execute();
    },
    async seedMetric(row, version) {
      const inserted = await d.insertInto('metric_definitions').values(encode('metric_definitions', row as never)).onConflict((oc: any) => oc.column('key').doNothing()).returning('key').execute();
      if (inserted.length) await d.insertInto('metric_versions').values(encode('metric_versions', version as never)).onConflict((oc: any) => oc.columns(['metric_key', 'version']).doNothing()).execute();
    },
    async getMetric(key, opts = {}) {
      let q = db.selectFrom('metric_definitions').selectAll().where('key', '=', key);
      if (opts.forUpdate) q = q.forUpdate();
      return q.executeTakeFirst();
    },
    async listMetrics(f) {
      let q = db.selectFrom('metric_definitions').selectAll();
      if (f.group) q = q.where('group_key', '=', f.group);
      if (f.status) q = q.where('status', '=', f.status);
      if (f.keys) q = f.keys.length ? q.where('key', 'in', f.keys) : q.where(sql<boolean>`false`);
      return q.orderBy('group_key').orderBy('key').execute();
    },
    async insertMetric(row) {
      return d.insertInto('metric_definitions').values(encode('metric_definitions', row as never)).returningAll().executeTakeFirstOrThrow() as never;
    },
    async updateMetric(key, patch) {
      return d.updateTable('metric_definitions').set(encode('metric_definitions', patch as never)).where('key', '=', key).returningAll().executeTakeFirstOrThrow() as never;
    },
    async insertVersion(row) {
      await d.insertInto('metric_versions').values(encode('metric_versions', row as never)).execute();
    },
    async listVersions(key) {
      return db.selectFrom('metric_versions').selectAll().where('metric_key', '=', key).orderBy('version', 'desc').execute();
    },
    async versionsInEffect(keys, day) {
      let q = db.selectFrom('metric_versions').selectAll().distinctOn('metric_key').where('effective_from', '<=', day);
      if (keys) q = keys.length ? q.where('metric_key', 'in', keys) : q.where(sql<boolean>`false`);
      return q.orderBy('metric_key').orderBy('version', 'desc').execute();
    },
    async insertSuggestion(row) {
      return db.insertInto('metric_suggestions').values(row).returningAll().executeTakeFirstOrThrow();
    },
    async getSuggestion(id, opts = {}) {
      let q = db.selectFrom('metric_suggestions').selectAll().where('id', '=', id);
      if (opts.forUpdate) q = q.forUpdate();
      return q.executeTakeFirst();
    },
    async updateSuggestion(id, patch) {
      return db.updateTable('metric_suggestions').set(patch).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
    },
    async listSuggestions(key) {
      return db.selectFrom('metric_suggestions').selectAll().where('metric_key', '=', key).orderBy('created_at', 'desc').execute();
    },
    async upsertReport(row) {
      const v = encode('report_definitions', row as never);
      const { key: _key, active: _active, ...update } = v;
      await d.insertInto('report_definitions').values(v).onConflict((oc: any) => oc.column('key').doUpdateSet(update)).execute();
    },
    async getReport(key) {
      return db.selectFrom('report_definitions').selectAll().where('key', '=', key).executeTakeFirst();
    },
    async listReports(f) {
      let q = db.selectFrom('report_definitions').selectAll();
      if (f.audience) q = q.where('audience', '=', f.audience);
      if (f.active !== undefined) q = q.where('active', '=', f.active);
      return q.orderBy('group_key').orderBy('key').execute();
    },

    /* ---------------------------------------------------------------- saved views and schedules */

    async listSavedViews(ownerId, reportKey) {
      let q = db.selectFrom('saved_views').selectAll().where((eb) => eb.or([eb('owner_staff_id', '=', ownerId), eb('shared', '=', true)]));
      if (reportKey) q = q.where('report_key', '=', reportKey);
      return q.orderBy('created_at', 'desc').execute();
    },
    async insertSavedView(row) {
      return d.insertInto('saved_views').values(encode('saved_views', row as never)).returningAll().executeTakeFirstOrThrow() as never;
    },
    async getSavedView(id) {
      return db.selectFrom('saved_views').selectAll().where('id', '=', id).executeTakeFirst();
    },
    async deleteSavedView(id) {
      await db.deleteFrom('saved_views').where('id', '=', id).execute();
    },
    async insertSchedule(row) {
      return d.insertInto('report_schedules').values(encode('report_schedules', row as never)).returningAll().executeTakeFirstOrThrow() as never;
    },
    async listSchedules() {
      return db.selectFrom('report_schedules').selectAll().where('active', '=', true).orderBy('next_run_at').execute();
    },
    async getSchedule(id, opts = {}) {
      let q = db.selectFrom('report_schedules').selectAll().where('id', '=', id);
      if (opts.forUpdate) q = q.forUpdate();
      return q.executeTakeFirst();
    },
    async updateSchedule(id, patch) {
      return d.updateTable('report_schedules').set(encode('report_schedules', patch as never)).where('id', '=', id).returningAll().executeTakeFirstOrThrow() as never;
    },
    async dueSchedules(now, limit) {
      return db.selectFrom('report_schedules').selectAll().where('active', '=', true).where('next_run_at', '<=', now).orderBy('next_run_at').limit(limit).execute();
    },

    /* ---------------------------------------------------------------- export registry and jobs */

    async listDatasets() {
      return db.selectFrom('export_datasets').selectAll().orderBy('key').execute();
    },
    async getDataset(key) {
      return db.selectFrom('export_datasets').selectAll().where('key', '=', key).executeTakeFirst();
    },
    async seedDataset(row) {
      const v = encode('export_datasets', row as never);
      await d
        .insertInto('export_datasets')
        .values(v)
        .onConflict((oc: any) => oc.column('key').doUpdateSet({ owner_module: v.owner_module, permission: v.permission, audience: v.audience, screens: v.screens, phase: v.phase, available: v.available }))
        .execute();
    },
    async registerDataset(row) {
      const v = encode('export_datasets', row as never);
      await d
        .insertInto('export_datasets')
        .values(v)
        .onConflict((oc: any) => oc.column('key').doUpdateSet({ title: v.title, columns: v.columns, available: v.available, registered_at: v.registered_at }))
        .execute();
    },
    async insertJob(row) {
      return d.insertInto('export_jobs').values(encode('export_jobs', row as never)).returningAll().executeTakeFirstOrThrow() as never;
    },
    async getJob(id, opts = {}) {
      let q = db.selectFrom('export_jobs').selectAll().where('id', '=', id);
      if (opts.forUpdate) q = q.forUpdate();
      return q.executeTakeFirst();
    },
    async updateJob(id, patch) {
      return d.updateTable('export_jobs').set(encode('export_jobs', patch as never)).where('id', '=', id).returningAll().executeTakeFirstOrThrow() as never;
    },
    async listJobs(f, page) {
      let q = db.selectFrom('export_jobs').selectAll();
      if (f.requesterId) q = q.where('requested_by_id', '=', f.requesterId);
      if (f.sellerId) q = q.where('seller_id', '=', f.sellerId);
      if (f.dataset) q = q.where('dataset', '=', f.dataset);
      if (f.state) q = q.where('state', '=', f.state);
      return paginate(q, page, { column: 'created_at', direction: 'desc' });
    },
    async countActiveJobs(requesterId) {
      const r = await db.selectFrom('export_jobs').select(sql<number>`count(*)::int`.as('n')).where('requested_by_id', '=', requesterId).where('state', 'in', ['queued', 'running']).executeTakeFirst();
      return r?.n ?? 0;
    },
    async queuedJobs(limit) {
      return db.selectFrom('export_jobs').selectAll().where('state', '=', 'queued').orderBy('created_at').limit(limit).execute();
    },
    async readyJobsExpiring(now, limit) {
      return db.selectFrom('export_jobs').selectAll().where('state', '=', 'ready').where('expires_at', '<=', now).orderBy('expires_at').limit(limit).execute();
    },

    /* ---------------------------------------------------------------- facts: order items */

    async insertOrderItems(rows) {
      if (!rows.length) return [];
      const r = await db.insertInto('fact_order_items').values(rows).onConflict((oc) => oc.column('order_item_id').doNothing()).returning('order_item_id').execute();
      return r.map((x) => x.order_item_id);
    },
    async getOrderItems(orderId) {
      return db.selectFrom('fact_order_items').selectAll().where('order_id', '=', orderId).execute();
    },
    async getOrderItemsByIds(ids) {
      if (!ids.length) return [];
      return db.selectFrom('fact_order_items').selectAll().where('order_item_id', 'in', ids).execute();
    },
    async updateOrderItems(w, patch) {
      let q = db.updateTable('fact_order_items').set(patch);
      if (w.orderId) q = q.where('order_id', '=', w.orderId);
      if (w.itemIds) q = w.itemIds.length ? q.where('order_item_id', 'in', w.itemIds) : q.where(sql<boolean>`false`);
      if (w.ownerType) q = q.where('owner_type', '=', w.ownerType as 'official' | 'seller');
      if (w.sellerId !== undefined) q = w.sellerId === null ? q.where('seller_id', 'is', null) : q.where('seller_id', '=', w.sellerId);
      if (w.nullColumn) q = q.where(w.nullColumn, 'is', null);
      const r = await q.executeTakeFirst();
      return Number(r.numUpdatedRows);
    },
    async addToOrderItem(itemId, add, patch) {
      return db
        .updateTable('fact_order_items')
        .set({
          ...patch,
          ...(add.cancelled_minor ? { cancelled_minor: sql<number>`cancelled_minor + ${add.cancelled_minor}` } : {}),
          ...(add.refunded_minor ? { refunded_minor: sql<number>`refunded_minor + ${add.refunded_minor}` } : {}),
        })
        .where('order_item_id', '=', itemId)
        .returningAll()
        .executeTakeFirst();
    },
    async orderIdsWithFacts(after, limit) {
      let q = db.selectFrom('fact_order_items').select('order_id').distinct().orderBy('order_id').limit(limit);
      if (after) q = q.where('order_id', '>', after);
      return (await q.execute()).map((r) => r.order_id);
    },
    async officialItemsWithoutCost(since, limit) {
      return db.selectFrom('fact_order_items').selectAll().where('owner_type', '=', 'official').where('buying_cost_minor', 'is', null).where('placed_at', '>=', since).orderBy('placed_at', 'desc').limit(limit).execute();
    },
    async salesAgg(f: SalesFilter, group: SalesGroup, bucket = 'day') {
      const col = sql.ref(f.basis);
      const keyExpr =
        group === 'bucket'
          ? bucketExpr(sql`${col} at time zone ${f.timeZone}`, bucket)
          : group === 'customer'
            ? sql<string>`customer_key`
            : group === 'none'
              ? sql<string>`null::text`
              : sql<string>`${sql.ref(group)}::text`;
      let q = d
        .selectFrom('fact_order_items')
        .select([
          keyExpr.as('key'),
          sumInt('item_minor').as('gross'),
          sumInt('tax_minor').as('tax'),
          sumInt('cancelled_minor').as('cancelled'),
          sumInt('refunded_minor').as('refunded'),
          sql<number>`count(distinct order_id)::int`.as('orders'),
          sumInt('quantity').as('units'),
          sql<number>`coalesce(sum(case when buying_cost_minor is not null then item_minor else 0 end), 0)::bigint`.as('costed_sales'),
          sumInt('buying_cost_minor').as('cost'),
          sql<number>`count(distinct customer_key)::int`.as('buyers'),
          sumInt('discount_platform_minor').as('platform_discount'),
          sumInt('discount_seller_minor').as('seller_discount'),
        ])
        .where(col, '>=', f.start)
        .where(col, '<', f.end);
      if (f.ownerType) q = q.where('owner_type', '=', f.ownerType);
      if (f.sellerId) q = q.where('seller_id', '=', f.sellerId);
      if (f.categoryId) q = q.where('category_id', '=', f.categoryId);
      if (f.productId) q = q.where('product_id', '=', f.productId);
      if (group !== 'none') q = q.groupBy(sql.raw('1')).orderBy(sql.raw('1'));
      const rows = (await q.execute()) as { key: string | null; gross: number; tax: number; cancelled: number; refunded: number; orders: number; units: number; costed_sales: number; cost: number; buyers: number; platform_discount: number; seller_discount: number }[];
      return rows.map((r) => ({ key: r.key, gross: r.gross, tax: r.tax, cancelled: r.cancelled, refunded: r.refunded, orders: r.orders, units: r.units, costedSales: r.costed_sales, cost: r.cost, buyers: r.buyers, platformDiscount: r.platform_discount, sellerDiscount: r.seller_discount }));
    },
    async cancellationsAgg(f, group, bucket = 'day') {
      const keyExpr = group === 'bucket' ? bucketExpr(sql`cancelled_at at time zone ${f.timeZone}`, bucket) : group === 'cancelled_by' ? sql<string>`cancelled_by` : sql<string>`null::text`;
      let q = d
        .selectFrom('fact_order_items')
        .select([keyExpr.as('key'), sumInt('cancelled_minor').as('amount'), sql<number>`count(*)::int`.as('items')])
        .where('cancelled_at', '>=', f.start)
        .where('cancelled_at', '<', f.end);
      if (f.ownerType) q = q.where('owner_type', '=', f.ownerType);
      if (f.sellerId) q = q.where('seller_id', '=', f.sellerId);
      if (f.categoryId) q = q.where('category_id', '=', f.categoryId);
      if (f.productId) q = q.where('product_id', '=', f.productId);
      if (group !== 'none') q = q.groupBy(sql.raw('1')).orderBy(sql.raw('1'));
      return q.execute();
    },
    async sellerSalesByDay(from, to, tz) {
      const day = sql<string>`to_char((placed_at at time zone ${tz})::date, 'YYYY-MM-DD')`;
      const rows = await d
        .selectFrom('fact_order_items')
        .select([sql<string>`seller_id`.as('sellerId'), day.as('day'), sumInt('item_minor').as('sales'), sumInt('discount_platform_minor').as('platformDiscount'), sumInt('discount_seller_minor').as('sellerDiscount')])
        .where('owner_type', '=', 'seller')
        .where('seller_id', 'is not', null)
        .where(sql<boolean>`(placed_at at time zone ${tz})::date between ${from}::date and ${to}::date`)
        .groupBy(sql.raw('1, 2'))
        .execute();
      return rows;
    },
    async purchasesByDay(from, to, tz) {
      const day = sql<string>`to_char((placed_at at time zone ${tz})::date, 'YYYY-MM-DD')`;
      return d
        .selectFrom('fact_order_items')
        .select([sql<string>`product_id`.as('productId'), day.as('day'), sumInt('quantity').as('units')])
        .where(sql<boolean>`(placed_at at time zone ${tz})::date between ${from}::date and ${to}::date`)
        .groupBy(sql.raw('1, 2'))
        .execute();
    },

    /* ---------------------------------------------------------------- facts: refunds, returns, customers */

    async insertRefund(row) {
      const r = await db.insertInto('fact_refunds').values(row).onConflict((oc) => oc.column('refund_id').doNothing()).returning('refund_id').execute();
      return r.length > 0;
    },
    async refundsAgg(f, group, bucket = 'day') {
      const keyExpr = group === 'bucket' ? bucketExpr(sql`sent_at at time zone ${f.timeZone}`, bucket) : group === 'reason' ? sql<string>`coalesce(reason, 'unspecified')` : sql<string>`null::text`;
      let q = d
        .selectFrom('fact_refunds')
        .select([keyExpr.as('key'), sumInt('amount_minor').as('amount'), sql<number>`count(*)::int`.as('count')])
        .where('sent_at', '>=', f.start)
        .where('sent_at', '<', f.end);
      if (f.ownerType) q = q.where('owner_type', '=', f.ownerType);
      if (f.sellerId) q = q.where('seller_id', '=', f.sellerId);
      if (group !== 'none') q = q.groupBy(sql.raw('1')).orderBy(sql.raw('1'));
      return q.execute();
    },
    async insertReturn(row) {
      const r = await db.insertInto('fact_returns').values(row).onConflict((oc) => oc.column('return_id').doNothing()).returning('return_id').execute();
      return r.length > 0;
    },
    async updateReturn(returnId, patch) {
      const r = await db.updateTable('fact_returns').set(patch).where('return_id', '=', returnId).executeTakeFirst();
      return Number(r.numUpdatedRows);
    },
    async returnsAgg(f, group) {
      const keyExpr = group === 'none' ? sql<string>`null::text` : group === 'outcome' ? sql<string>`coalesce(outcome, 'not_inspected')` : sql<string>`${sql.ref(group)}::text`;
      let q = d
        .selectFrom('fact_returns')
        .select([keyExpr.as('key'), sql<number>`count(*)::int`.as('requests'), sumInt('units').as('units')])
        .where('requested_at', '>=', f.start)
        .where('requested_at', '<', f.end);
      if (f.sellerId) q = q.where('seller_id', '=', f.sellerId);
      if (f.productId) q = q.where('product_id', '=', f.productId);
      if (group !== 'none') q = q.groupBy(sql.raw('1')).orderBy(sql.raw('2 desc'));
      return q.execute();
    },
    async upsertCustomer(key, at, spend) {
      await db
        .insertInto('fact_customers')
        .values({ customer_key: key, first_order_at: at, last_order_at: at, orders: 1, net_spend_minor: spend })
        .onConflict((oc) =>
          oc.column('customer_key').doUpdateSet({
            first_order_at: sql<Date>`least(fact_customers.first_order_at, excluded.first_order_at)`,
            last_order_at: sql<Date>`greatest(fact_customers.last_order_at, excluded.last_order_at)`,
            orders: sql<number>`fact_customers.orders + 1`,
            net_spend_minor: sql<number>`fact_customers.net_spend_minor + excluded.net_spend_minor`,
          }),
        )
        .execute();
    },
    async adjustCustomerSpend(key, delta) {
      await db.updateTable('fact_customers').set({ net_spend_minor: sql<number>`net_spend_minor + ${delta}` }).where('customer_key', '=', key).execute();
    },
    async rebuildCustomers() {
      await db.deleteFrom('fact_customers').execute();
      const rows = await d
        .selectFrom('fact_order_items')
        .select([
          'customer_key',
          sql<Date>`min(placed_at)`.as('first_order_at'),
          sql<Date>`max(placed_at)`.as('last_order_at'),
          sql<number>`count(distinct order_id)::int`.as('orders'),
          sql<number>`coalesce(sum(item_minor + shipping_minor + tax_minor - cancelled_minor - refunded_minor), 0)::bigint`.as('net_spend_minor'),
        ])
        .groupBy('customer_key')
        .execute();
      for (let i = 0; i < rows.length; i += 500) await db.insertInto('fact_customers').values(rows.slice(i, i + 500)).execute();
      return rows.length;
    },
    async customersAgg(f) {
      const r = await d
        .selectFrom('fact_order_items as i')
        .innerJoin('fact_customers as c', 'c.customer_key', 'i.customer_key')
        .select([
          sql<number>`count(distinct i.customer_key)::int`.as('buyers'),
          sql<number>`count(distinct i.customer_key) filter (where c.first_order_at >= ${f.start})::int`.as('newBuyers'),
          sql<number>`count(distinct i.customer_key) filter (where c.first_order_at < ${f.start})::int`.as('returning'),
          sql<number>`count(distinct i.customer_key) filter (where c.orders >= 2)::int`.as('repeat'),
        ])
        .where('i.placed_at', '>=', f.start)
        .where('i.placed_at', '<', f.end)
        .executeTakeFirst();
      return r ?? { buyers: 0, newBuyers: 0, returning: 0, repeat: 0 };
    },

    /* ---------------------------------------------------------------- facts: daily tables */

    async bumpDaily(table, key, add, set = {}, jsonAdd?: { column: string; add: Record<string, number> }) {
      const def = DAILY[table];
      const values = encode(table, { ...def.defaults, ...key, ...add, ...set, ...(jsonAdd ? { [jsonAdd.column]: jsonAdd.add } : {}) });
      const update: Record<string, unknown> = {};
      for (const [c, n] of Object.entries(add)) update[c] = sql`${sql.ref(`${table}.${c}`)} + ${n}`;
      for (const [c, v] of Object.entries(encode(table, set))) update[c] = v;
      if (jsonAdd) update[jsonAdd.column] = jsonAddExpr(table, jsonAdd.column, jsonAdd.add);
      const q = d.insertInto(table).values(values);
      await (Object.keys(update).length ? q.onConflict((oc: any) => oc.columns(def.key).doUpdateSet(update)) : q.onConflict((oc: any) => oc.columns(def.key).doNothing())).execute();
    },
    async bumpService(sellerId, day, add, complaintCategory) {
      const existing = await db.selectFrom('fact_service_daily').select('day').where('seller_id', '=', sellerId).where('day', '=', day).executeTakeFirst();
      if (!existing) {
        const prev = await db.selectFrom('fact_service_daily').select('cases_open_eod').where('seller_id', '=', sellerId).where('day', '<', day).orderBy('day', 'desc').limit(1).executeTakeFirst();
        await d
          .insertInto('fact_service_daily')
          .values(encode('fact_service_daily', { ...DAILY.fact_service_daily.defaults, seller_id: sellerId, day, cases_open_eod: prev?.cases_open_eod ?? 0 }))
          .onConflict((oc: any) => oc.columns(['seller_id', 'day']).doNothing())
          .execute();
      }
      const set: Record<string, unknown> = {};
      for (const [c, n] of Object.entries(add)) set[c] = sql`${sql.ref(c)} + ${n}`;
      if (complaintCategory) set.complaints_by_category = jsonAddExpr('fact_service_daily', 'complaints_by_category', { [complaintCategory]: 1 });
      if (Object.keys(set).length) await d.updateTable('fact_service_daily').set(set).where('seller_id', '=', sellerId).where('day', '=', day).execute();
    },
    async dailySums(table, f, columns, group, bucket = 'day') {
      const keyExpr =
        group === 'bucket'
          ? bucketExpr(sql`day::timestamp`, bucket)
          : group === 'campaign'
            ? sql<string>`campaign_kind || ':' || campaign_id::text`
            : group === 'none'
              ? sql<string>`null::text`
              : sql<string>`${sql.ref(group)}::text`;
      let q = d
        .selectFrom(table)
        .select([keyExpr.as('key'), ...columns.map((c) => (c === 'first_reply_minutes_p50' ? sql<number>`coalesce(avg(${sql.ref(c)}), 0)::float8`.as(c) : sumInt(c).as(c)))])
        .where('day', '>=', f.from)
        .where('day', '<=', f.to);
      if (f.sellerId) q = q.where('seller_id', '=', f.sellerId);
      if (f.productId) q = q.where('product_id', '=', f.productId);
      if (f.campaignKind) q = q.where('campaign_kind', '=', f.campaignKind);
      if (group !== 'none') q = q.groupBy(sql.raw('1')).orderBy(sql.raw('1'));
      return q.execute();
    },
    async caseBacklog(day, sellerId) {
      let inner = d.selectFrom('fact_service_daily').select(['seller_id', 'cases_open_eod']).distinctOn('seller_id').where('day', '<=', day).orderBy('seller_id').orderBy('day', 'desc');
      if (sellerId) inner = inner.where('seller_id', '=', sellerId);
      const r = await d.selectFrom(inner.as('t')).select(sql<number>`coalesce(sum(greatest(cases_open_eod, 0)), 0)::bigint`.as('n')).executeTakeFirst();
      return (r as { n: number } | undefined)?.n ?? 0;
    },
    async sellersWithMessages(day) {
      const rows = await db.selectFrom('fact_service_daily').select('seller_id').where('day', '=', day).where('messages_received', '>', 0).execute();
      return rows.map((r) => r.seller_id);
    },

    /* ---------------------------------------------------------------- read model bookkeeping */

    async getCheckpoint(key) {
      return db.selectFrom('read_model_checkpoints').selectAll().where('key', '=', key).executeTakeFirst();
    },
    async listCheckpoints(keys) {
      if (!keys.length) return [];
      return db.selectFrom('read_model_checkpoints').selectAll().where('key', 'in', keys).execute();
    },
    async upsertCheckpoint(key, patch) {
      await db
        .insertInto('read_model_checkpoints')
        .values({ key, state: 'live', last_event_id: null, last_event_at: null, rebuild_started_at: null, rebuild_progress: null, ...patch })
        .onConflict((oc) => oc.column('key').doUpdateSet(patch))
        .execute();
    },
    async claim(key) {
      return inbox.claim(db, key);
    },
    async remember(key, value) {
      const r = await db.insertInto('read_model_checkpoints').values({ key: `${LOOKUP}${key}`, state: 'lookup', last_event_id: value, last_event_at: null, rebuild_started_at: null, rebuild_progress: null }).onConflict((oc) => oc.column('key').doNothing()).returning('key').execute();
      return r.length > 0;
    },
    async recall(key) {
      const r = await db.selectFrom('read_model_checkpoints').select('last_event_id').where('key', '=', `${LOOKUP}${key}`).executeTakeFirst();
      return r?.last_event_id ?? null;
    },
    async forget(key) {
      await db.deleteFrom('read_model_checkpoints').where('key', '=', `${LOOKUP}${key}`).execute();
    },
    async countRows(table) {
      const r = await d.selectFrom(table).select(sql<number>`count(*)::int`.as('n')).executeTakeFirst();
      return (r as { n: number } | undefined)?.n ?? 0;
    },
  };
  return repo;
}
