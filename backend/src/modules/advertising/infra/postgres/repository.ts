import { sql, type Kysely } from 'kysely';
import type { Inbox } from '../../../../kernel/events/inbox.js';
import { paginate } from '../../../../kernel/lib/pagination.js';
import type { AdvertisingDb } from '../../../../spec/advertising.js';
import type { AdvertisingRepository, CampaignListFilter, CreativeListFilter, StatTotals } from '../../ports.js';

/** jsonb columns per table: values are sent as JSON text (pg would turn JS arrays into PG arrays) */
const JSON_COLUMNS: Record<string, readonly string[]> = {
  placements: ['eligible_pages', 'formats', 'frequency_cap', 'trigger', 'rotation', 'dismissal', 'positions'],
  global_rules: ['rules'],
  campaigns: ['pages', 'page_category_ids', 'audience', 'destination', 'frequency_cap', 'dismissal'],
  creatives: ['link_check', 'auto_checks'],
};

function encode(table: string, row: Record<string, unknown>): Record<string, unknown> {
  const cols = JSON_COLUMNS[table];
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v === undefined) continue;
    out[k] = cols?.includes(k) && v !== null ? JSON.stringify(v) : v;
  }
  return out;
}

const isOp = (v: unknown): v is { op: string; value: unknown } => typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date) && 'op' in v;

function applyWhere(q: any, where: Record<string, unknown>): any {
  for (const [k, v] of Object.entries(where)) {
    if (v === undefined) continue;
    if (v === null) q = q.where(k, 'is', null);
    else if (Array.isArray(v)) q = v.length ? q.where(k, 'in', v) : q.where(sql<boolean>`false`);
    else if (isOp(v)) q = q.where(k, v.op, v.value);
    else q = q.where(k, '=', v);
  }
  return q;
}

const like = (s: string) => `%${s.trim().toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
const uniq = <T>(xs: readonly T[]) => [...new Set(xs)];
const none = sql<boolean>`false`;

/** Postgres adapter for AdvertisingRepository. `db` is scoped to the `advertising` schema. */
export function createPostgresAdvertisingRepository(db: Kysely<AdvertisingDb>, inbox: Inbox): AdvertisingRepository {
  // generic table access: the row types are checked at the AdvertisingRepository boundary
  const d: any = db;

  const creativeFilter = (q: any, f: CreativeListFilter) => {
    if (f.q?.trim()) {
      const term = like(f.q);
      q = q.where((eb: any) =>
        eb.or([
          eb(sql`lower(coalesce(file_name, ''))`, 'like', term),
          eb(sql`lower(coalesce(headline, ''))`, 'like', term),
          eb(
            sql<boolean>`exists (select 1 from advertising.campaign_creatives cc join advertising.campaigns c on c.id = cc.campaign_id where cc.creative_id = creatives.id and (lower(c.name) like ${term} or lower(c.ref) like ${term}))`,
            '=',
            true,
          ),
        ]),
      );
    }
    if (f.status) q = q.where('status', '=', f.status);
    if (f.advertiserKinds) q = f.advertiserKinds.length ? q.where('advertiser_kind', 'in', f.advertiserKinds) : q.where(none);
    if (f.placementKey) q = q.where('placement_key', '=', f.placementKey);
    if (f.kind) q = q.where('kind', '=', f.kind);
    if (f.linkCheck) q = q.where(sql`link_check->>'state'`, '=', f.linkCheck);
    if (f.sellerId) q = q.where('seller_id', '=', f.sellerId);
    return q;
  };

  const repo: AdvertisingRepository = {
    async transaction(fn) {
      if (db.isTransaction) return fn(repo);
      return db.transaction().execute((trx) => fn(createPostgresAdvertisingRepository(trx, inbox)));
    },
    claim(key) {
      return inbox.claim(db, key);
    },

    /* ---------------------------------------------------------------- generic */
    async get(table, id, o) {
      let q = d.selectFrom(table).selectAll().where('id', '=', id);
      if (o?.forUpdate) q = q.forUpdate();
      return q.executeTakeFirst();
    },
    async getMany(table, ids) {
      if (!ids.length) return [];
      return d.selectFrom(table).selectAll().where('id', 'in', uniq(ids)).execute();
    },
    async find(table, where, o) {
      let q = applyWhere(d.selectFrom(table).selectAll(), where as Record<string, unknown>);
      for (const [c, dir] of o?.orderBy ?? []) q = q.orderBy(c, dir);
      if (o?.limit) q = q.limit(o.limit);
      if (o?.offset) q = q.offset(o.offset);
      if (o?.forUpdate) q = q.forUpdate();
      return q.execute();
    },
    async findOne(table, where, o) {
      return (await repo.find(table, where, { ...o, limit: 1 }))[0];
    },
    async count(table, where) {
      const r = await applyWhere(d.selectFrom(table).select(sql<number>`count(*)::int`.as('n')), where as Record<string, unknown>).executeTakeFirst();
      return (r as { n: number } | undefined)?.n ?? 0;
    },
    async insert(table, row) {
      return d.insertInto(table).values(encode(table, row as Record<string, unknown>)).returningAll().executeTakeFirstOrThrow();
    },
    async insertIgnore(table, row) {
      const r = await d
        .insertInto(table)
        .values(encode(table, row as Record<string, unknown>))
        .onConflict((oc: any) => oc.doNothing())
        .executeTakeFirst();
      return Number(r?.numInsertedOrUpdatedRows ?? 0) > 0;
    },
    async update(table, id, patch) {
      const values = encode(table, patch as Record<string, unknown>);
      if (!Object.keys(values).length) return (await repo.get(table, id))!;
      return d.updateTable(table).set(values).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
    },
    async updateWhere(table, where, patch) {
      const values = encode(table, patch as Record<string, unknown>);
      if (!Object.keys(values).length) return 0;
      const r = await applyWhere(d.updateTable(table).set(values), where as Record<string, unknown>).executeTakeFirst();
      return Number(r?.numUpdatedRows ?? 0);
    },
    async removeWhere(table, where) {
      const r = await applyWhere(d.deleteFrom(table), where as Record<string, unknown>).executeTakeFirst();
      return Number(r?.numDeletedRows ?? 0);
    },
    async page(table, where, page, order) {
      const q = applyWhere(d.selectFrom(table).selectAll(), where as Record<string, unknown>);
      return paginate(q, page, order) as never;
    },

    /* ---------------------------------------------------------------- rules */
    async maxRulesVersion() {
      const r = await d.selectFrom('global_rules').select(sql<number>`coalesce(max(version), 0)::int`.as('v')).executeTakeFirst();
      return (r as { v: number } | undefined)?.v ?? 0;
    },

    /* ---------------------------------------------------------------- campaigns and creatives */
    async listCampaigns(f: CampaignListFilter, page) {
      let q = d.selectFrom('campaigns').selectAll();
      if (f.q?.trim()) {
        const term = like(f.q);
        q = q.where((eb: any) => eb.or([eb(sql`lower(name)`, 'like', term), eb(sql`lower(ref)`, 'like', term)]));
      }
      if (f.advertiserKinds) q = f.advertiserKinds.length ? q.where('advertiser_kind', 'in', f.advertiserKinds) : q.where(none);
      if (f.placementId) q = q.where('placement_id', '=', f.placementId);
      if (f.statuses?.length) q = q.where('status', 'in', f.statuses);
      if (f.linkedPromotionId) q = q.where('linked_promotion_id', '=', f.linkedPromotionId);
      if (f.sellerId) q = q.where('seller_id', '=', f.sellerId);
      if (f.origin) q = q.where('origin', '=', f.origin);
      return paginate(q, page, { column: 'created_at', direction: 'desc' }) as never;
    },
    async listCreatives(f, page) {
      return paginate(creativeFilter(d.selectFrom('creatives').selectAll(), f), page, { column: 'created_at', direction: 'desc' }) as never;
    },
    async creativeCounts(f) {
      const rows = await creativeFilter(d.selectFrom('creatives').select(['status', sql<number>`count(*)::int`.as('n')]), { ...f, status: undefined }).groupBy('status').execute();
      return Object.fromEntries(rows.map((r: { status: string; n: number }) => [r.status, r.n]));
    },
    async liveCampaigns(at) {
      return d.selectFrom('campaigns').selectAll().where('status', '=', 'live').where('starts_at', '<=', at).where('ends_at', '>', at).orderBy('id').execute();
    },
    async lastLogs(campaignIds, actions) {
      const out = new Map();
      if (!campaignIds.length || !actions.length) return out;
      const rows = await sql<any>`
        select distinct on (campaign_id) * from advertising.campaign_log
        where campaign_id in (${sql.join(uniq(campaignIds))}) and action in (${sql.join(uniq(actions))})
        order by campaign_id, at desc, id desc`.execute(d);
      for (const r of rows.rows) out.set(r.campaign_id, r);
      return out;
    },
    async campaignsPromoting(kinds, targetIds) {
      if (!kinds.length || !targetIds.length) return [];
      return d.selectFrom('campaign_items').selectAll().where('kind', 'in', uniq(kinds)).where('target_id', 'in', uniq(targetIds)).execute();
    },

    /* ---------------------------------------------------------------- frequency and suppression */
    async frequencyRows(visitorKeys, campaignIds) {
      if (!visitorKeys.length || !campaignIds.length) return [];
      return d.selectFrom('frequency_state').selectAll().where('visitor_key', 'in', uniq(visitorKeys)).where('campaign_id', 'in', uniq(campaignIds)).execute();
    },
    async hasHistory(visitorKeys) {
      if (!visitorKeys.length) return false;
      const r = await d.selectFrom('frequency_state').select('campaign_id').where('visitor_key', 'in', uniq(visitorKeys)).limit(1).executeTakeFirst();
      return Boolean(r);
    },
    async recordDisplay(visitorKeys, campaignId, sessionId, now, windowDays) {
      const cutoff = windowDays ? new Date(now.getTime() - windowDays * 86_400_000) : null;
      for (const key of uniq(visitorKeys)) {
        await sql`
          insert into advertising.frequency_state (visitor_key, campaign_id, session_id, session_displays, window_displays, window_started_at, last_display_at, suppressed_until)
          values (${key}, ${campaignId}, ${sessionId}, 1, 1, ${now}, ${now}, null)
          on conflict (visitor_key, campaign_id) do update set
            session_displays = case when frequency_state.session_id = excluded.session_id then frequency_state.session_displays + 1 else 1 end,
            session_id = excluded.session_id,
            window_displays = case when ${cutoff}::timestamptz is null or frequency_state.window_started_at > ${cutoff}::timestamptz then frequency_state.window_displays + 1 else 1 end,
            window_started_at = case when ${cutoff}::timestamptz is null or frequency_state.window_started_at > ${cutoff}::timestamptz then frequency_state.window_started_at else excluded.window_started_at end,
            last_display_at = excluded.last_display_at`.execute(d);
      }
    },
    async recordDismissal(visitorKeys, campaignId, sessionId, until, now) {
      for (const key of uniq(visitorKeys)) {
        await sql`
          insert into advertising.frequency_state (visitor_key, campaign_id, session_id, session_displays, window_displays, window_started_at, last_display_at, suppressed_until)
          values (${key}, ${campaignId}, ${sessionId}, 0, 0, ${now}, null, ${until})
          on conflict (visitor_key, campaign_id) do update set
            session_displays = case when frequency_state.session_id = excluded.session_id then frequency_state.session_displays else 0 end,
            session_id = excluded.session_id,
            suppressed_until = greatest(coalesce(frequency_state.suppressed_until, excluded.suppressed_until), excluded.suppressed_until)`.execute(d);
      }
    },
    async displayCounts(visitorKeys, campaignIds, since) {
      const out = new Map<string, number>();
      if (!visitorKeys.length || !campaignIds.length) return out;
      let q = d
        .selectFrom('ad_events')
        .select(['campaign_id', sql<number>`count(*)::int`.as('n')])
        .where('visitor_key', 'in', uniq(visitorKeys))
        .where('campaign_id', 'in', uniq(campaignIds))
        .where('kind', '=', 'display');
      if (since) q = q.where('at', '>=', since);
      for (const r of await q.groupBy('campaign_id').execute()) out.set(r.campaign_id, r.n);
      return out;
    },
    async expireFrequency(now, oldestWindowStart, endedCampaignIds) {
      let n = 0;
      if (endedCampaignIds.length) n += Number((await d.deleteFrom('frequency_state').where('campaign_id', 'in', uniq(endedCampaignIds)).executeTakeFirst())?.numDeletedRows ?? 0);
      const r = await d
        .deleteFrom('frequency_state')
        .where((eb: any) => eb.or([eb('suppressed_until', 'is', null), eb('suppressed_until', '<', now)]))
        .where('window_started_at', '<', oldestWindowStart)
        .where((eb: any) => eb.or([eb('last_display_at', 'is', null), eb('last_display_at', '<', oldestWindowStart)]))
        .executeTakeFirst();
      return n + Number(r?.numDeletedRows ?? 0);
    },

    /* ---------------------------------------------------------------- spend */
    async chargeClick(eventId, campaignId, day) {
      if (!db.isTransaction) return db.transaction().execute((trx) => createPostgresAdvertisingRepository(trx, inbox).chargeClick(eventId, campaignId, day));
      // total limit first (campaign row), then the day (daily_stats row): one lock order, no deadlocks
      const total = await sql<{ spent: number; rate: number; total_limit: number | null; daily_limit: number | null }>`
        update advertising.campaigns set spent = spent + coalesce(rate, 0)
        where id = ${campaignId} and rate is not null and (total_limit is null or spent + rate <= total_limit)
        returning spent, rate, total_limit, daily_limit`.execute(d);
      const t = total.rows[0];
      if (!t) {
        const exists = await d.selectFrom('campaigns').select(['id', 'rate']).where('id', '=', campaignId).executeTakeFirst();
        return { charged: false, limit: exists && exists.rate !== null ? 'total' : 'missing' };
      }
      await sql`
        insert into advertising.daily_stats (campaign_id, day, displays, clicks, dismissals, spend, attributed_orders, attributed_sales)
        values (${campaignId}, ${day}, 0, 0, 0, 0, 0, 0) on conflict (campaign_id, day) do nothing`.execute(d);
      const daily = await sql<{ spend: number }>`
        update advertising.daily_stats set spend = spend + ${t.rate}
        where campaign_id = ${campaignId} and day = ${day} and (${t.daily_limit}::bigint is null or spend + ${t.rate} <= ${t.daily_limit}::bigint)
        returning spend`.execute(d);
      const dayRow = daily.rows[0];
      if (!dayRow) {
        await sql`update advertising.campaigns set spent = spent - ${t.rate} where id = ${campaignId}`.execute(d);
        return { charged: false, limit: 'daily' };
      }
      await d.updateTable('ad_events').set({ cost: t.rate }).where('id', '=', eventId).execute();
      const exhausted = t.total_limit !== null && t.spent + t.rate > t.total_limit ? 'total' : t.daily_limit !== null && dayRow.spend + t.rate > t.daily_limit ? 'daily' : null;
      return { charged: true, amount: t.rate, exhausted };
    },
    async spendOn(campaignIds, day) {
      const out = new Map<string, number>();
      if (!campaignIds.length) return out;
      const rows = await d.selectFrom('daily_stats').select(['campaign_id', 'spend']).where('campaign_id', 'in', uniq(campaignIds)).where('day', '=', day).execute();
      for (const r of rows) out.set(r.campaign_id, r.spend);
      return out;
    },
    async addSpend(campaignId, day, delta) {
      if (!delta) return;
      await sql`update advertising.campaigns set spent = greatest(spent + ${delta}, 0) where id = ${campaignId}`.execute(d);
      await sql`
        insert into advertising.daily_stats (campaign_id, day, displays, clicks, dismissals, spend, attributed_orders, attributed_sales)
        values (${campaignId}, ${day}, 0, 0, 0, greatest(${delta}::bigint, 0), 0, 0)
        on conflict (campaign_id, day) do update set spend = greatest(daily_stats.spend + ${delta}::bigint, 0)`.execute(d);
    },
    async clickBilling(campaignId, span) {
      const r = await sql<{ units: number; amount: number }>`
        select (count(*) filter (where cost is not null))::int as units, coalesce(sum(cost), 0)::bigint as amount
        from advertising.ad_events where campaign_id = ${campaignId} and kind = 'click' and at >= ${span.from} and at < ${span.to}`.execute(d);
      return r.rows[0] ?? { units: 0, amount: 0 };
    },
    async displaysIn(campaignId, span) {
      const r = await sql<{ n: number }>`
        select count(*)::int as n from advertising.ad_events where campaign_id = ${campaignId} and kind = 'display' and at >= ${span.from} and at < ${span.to}`.execute(d);
      return r.rows[0]?.n ?? 0;
    },

    async listCharges(f, page) {
      let q = d.selectFrom('ad_charges').selectAll();
      if (f.sellerId) q = q.where('seller_id', '=', f.sellerId);
      if (f.campaignId) q = q.where('campaign_id', '=', f.campaignId);
      if (f.state) q = q.where('state', '=', f.state);
      if (f.from) q = q.where('day', '>=', f.from);
      if (f.to) q = q.where('day', '<=', f.to);
      return paginate(q, page, { column: 'day', direction: 'desc' }) as never;
    },

    /* ---------------------------------------------------------------- read models */
    async rollup(span, timeZone) {
      const r = await sql`
        insert into advertising.daily_stats (campaign_id, day, displays, clicks, dismissals, spend, attributed_orders, attributed_sales)
        select campaign_id, day, sum(displays)::int, sum(clicks)::int, sum(dismissals)::int, 0, sum(orders)::int, sum(sales)::bigint from (
          select campaign_id, (at at time zone ${timeZone})::date as day,
            count(*) filter (where kind = 'display') as displays,
            count(*) filter (where kind = 'click') as clicks,
            count(*) filter (where kind in ('dismiss', 'close')) as dismissals,
            0::bigint as orders, 0::bigint as sales
          from advertising.ad_events where at >= ${span.from} and at < ${span.to}
          group by 1, 2
          union all
          select campaign_id, (attributed_at at time zone ${timeZone})::date as day, 0, 0, 0,
            count(*) filter (where amount > 0 and not reversed) as orders,
            coalesce(sum(amount), 0)::bigint as sales
          from advertising.attributions where attributed_at >= ${span.from} and attributed_at < ${span.to}
          group by 1, 2
        ) x
        group by campaign_id, day
        on conflict (campaign_id, day) do update set
          displays = excluded.displays, clicks = excluded.clicks, dismissals = excluded.dismissals,
          attributed_orders = excluded.attributed_orders, attributed_sales = excluded.attributed_sales`.execute(d);
      return Number(r.numAffectedRows ?? 0);
    },
    async totals(campaignIds, days) {
      const out = new Map<string, StatTotals>();
      if (campaignIds && !campaignIds.length) return out;
      let q = d
        .selectFrom('daily_stats')
        .select([
          'campaign_id',
          sql<number>`coalesce(sum(displays), 0)::int`.as('displays'),
          sql<number>`coalesce(sum(clicks), 0)::int`.as('clicks'),
          sql<number>`coalesce(sum(dismissals), 0)::int`.as('dismissals'),
          sql<number>`coalesce(sum(spend), 0)::bigint`.as('spend'),
          sql<number>`coalesce(sum(attributed_orders), 0)::int`.as('orders'),
          sql<number>`coalesce(sum(attributed_sales), 0)::bigint`.as('sales'),
        ]);
      if (campaignIds) q = q.where('campaign_id', 'in', uniq(campaignIds));
      if (days) q = q.where('day', '>=', days.from).where('day', '<=', days.to);
      for (const r of await q.groupBy('campaign_id').execute())
        out.set(r.campaign_id, { displays: r.displays, clicks: r.clicks, dismissals: r.dismissals, spend: r.spend, attributedOrders: r.orders, attributedSales: r.sales });
      return out;
    },
    async statsInRange(days, campaignIds) {
      let q = d.selectFrom('daily_stats').selectAll().where('day', '>=', days.from).where('day', '<=', days.to);
      if (campaignIds) q = campaignIds.length ? q.where('campaign_id', 'in', uniq(campaignIds)) : q.where(none);
      return q.orderBy('day', 'asc').orderBy('campaign_id', 'asc').execute();
    },
    async reach(placementKey, since) {
      const r = await sql<{ n: number }>`
        select count(distinct visitor_key)::int as n from advertising.ad_events where placement_key = ${placementKey} and kind = 'display' and at >= ${since}`.execute(d);
      return r.rows[0]?.n ?? 0;
    },
    async lastClick(customerId, since) {
      return d.selectFrom('ad_events').selectAll().where('customer_id', '=', customerId).where('kind', '=', 'click').where('at', '>=', since).orderBy('at', 'desc').limit(1).executeTakeFirst();
    },
  };
  return repo;
}
