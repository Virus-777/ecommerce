import { sql, type Kysely } from 'kysely';
import { paginate } from '../../../../kernel/lib/pagination.js';
import type { PromotionsDb } from '../../../../spec/promotions.js';
import type { CostTotals, PromotionsRepository, Where } from '../../ports.js';

/** jsonb columns per table: values are sent as JSON text (pg would turn JS arrays into PG arrays) */
const JSON_COLUMNS: Record<string, readonly string[]> = {
  campaigns: ['discount', 'eligibility', 'stacking', 'participation', 'deals'],
  funding_reviews: ['checks'],
  participation_offers: ['ineligible_reasons'],
  evaluations: ['result'],
  campaign_log: ['detail'],
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
const upperAll = (codes: readonly string[]) => [...new Set(codes.map((c) => c.trim().toUpperCase()).filter(Boolean))];

/** Postgres adapter for PromotionsRepository. `db` is scoped to the `promotions` schema. */
export function createPostgresPromotionsRepository(db: Kysely<PromotionsDb>): PromotionsRepository {
  // generic table access: the row types are checked at the PromotionsRepository boundary
  const d: any = db;

  const repo: PromotionsRepository = {
    async transaction(fn) {
      if (db.isTransaction) return fn(repo);
      return db.transaction().execute((trx) => fn(createPostgresPromotionsRepository(trx)));
    },

    /* ---------------------------------------------------------------- generic */
    async get(table, id, o) {
      let q = d.selectFrom(table).selectAll().where('id', '=', id);
      if (o?.forUpdate) q = q.forUpdate();
      return q.executeTakeFirst();
    },
    async getMany(table, ids) {
      if (!ids.length) return [];
      return d.selectFrom(table).selectAll().where('id', 'in', [...new Set(ids)]).execute();
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
    async insertMany(table, rows) {
      for (let i = 0; i < rows.length; i += 500) {
        const chunk = rows.slice(i, i + 500).map((r) => encode(table, r as Record<string, unknown>));
        if (chunk.length) await d.insertInto(table).values(chunk).execute();
      }
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

    /* ---------------------------------------------------------------- campaigns */
    async listCampaigns(f, page) {
      let q = d.selectFrom('campaigns').selectAll();
      if (f.q?.trim()) {
        const term = like(f.q);
        q = q.where((eb: any) =>
          eb.or([
            eb(sql`lower(name)`, 'like', term),
            eb(sql`lower(ref)`, 'like', term),
            eb(sql<boolean>`exists (select 1 from promotions.coupon_codes c where c.campaign_id = campaigns.id and lower(c.code) like ${term})`, '=', true),
          ]),
        );
      }
      if (f.statuses?.length) q = q.where('status', 'in', f.statuses);
      if (f.kind) q = q.where('kind', '=', f.kind);
      if (f.fundingOwner) q = q.where('funding_owner', '=', f.fundingOwner);
      if (f.ownerKind) q = q.where('owner_kind', '=', f.ownerKind);
      if (f.sellerId) q = q.where('seller_id', '=', f.sellerId);
      return paginate(q, page, { column: 'created_at', direction: 'desc' }) as never;
    },
    async runningCampaigns(at, o) {
      let q = d.selectFrom('campaigns').selectAll().where('status', 'in', ['scheduled', 'live']).where('starts_at', '<=', at).where('ends_at', '>', at);
      if (o?.kinds?.length) q = q.where('kind', 'in', o.kinds);
      if (o?.ownerKind) q = q.where('owner_kind', '=', o.ownerKind);
      if (o?.sellerIds) q = o.sellerIds.length ? q.where('seller_id', 'in', o.sellerIds) : q.where(sql<boolean>`false`);
      return q.orderBy('ends_at', 'asc').orderBy('id', 'asc').execute();
    },
    async eligibleFor(offerIds, campaignIds) {
      if (!offerIds.length || !campaignIds.length) return [];
      return d.selectFrom('eligible_offers').selectAll().where('offer_id', 'in', [...new Set(offerIds)]).where('campaign_id', 'in', [...new Set(campaignIds)]).where('eligible', '=', true).execute();
    },
    async activeCodes(codes) {
      const list = upperAll(codes);
      if (!list.length) return [];
      return d.selectFrom('coupon_codes').selectAll().where('active', '=', true).where(sql`upper(code)`, 'in', list).execute();
    },
    async anyCodes(codes) {
      const list = upperAll(codes);
      if (!list.length) return [];
      return d.selectFrom('coupon_codes').selectAll().where(sql`upper(code)`, 'in', list).orderBy('created_at', 'desc').execute();
    },
    async codeTaken(code, exceptCampaignId) {
      let q = d
        .selectFrom('coupon_codes as c')
        .innerJoin('campaigns as k', 'k.id', 'c.campaign_id')
        .select('c.id')
        .where(sql`upper(c.code)`, '=', code.trim().toUpperCase())
        .where('c.active', '=', true)
        .where('k.status', 'not in', ['ended', 'cancelled']);
      if (exceptCampaignId) q = q.where('c.campaign_id', '<>', exceptCampaignId);
      return Boolean(await q.executeTakeFirst());
    },
    async costTotals(campaignIds) {
      const out = new Map<string, CostTotals>();
      if (!campaignIds.length) return out;
      const rows = await sql<{ campaign_id: string; total: number; platform: number; redemptions: number; orders: number }>`
        select campaign_id,
          coalesce(sum(amount - reversed), 0)::bigint as total,
          coalesce(sum(platform_part - case when amount = 0 then 0 else round(reversed::numeric * platform_part / amount) end), 0)::bigint as platform,
          (count(*) filter (where state in ('committed', 'partially_reversed')))::int as redemptions,
          (count(distinct order_id))::int as orders
        from promotions.redemptions
        where campaign_id in (${sql.join([...new Set(campaignIds)])}) and state in ('committed', 'partially_reversed', 'reversed')
        group by campaign_id`.execute(d);
      for (const r of rows.rows) out.set(r.campaign_id, { total: r.total, platform: r.platform, seller: r.total - r.platform, redemptions: r.redemptions, orders: r.orders });
      return out;
    },
    async heldAmounts(campaignIds) {
      const out = new Map<string, number>();
      if (!campaignIds.length) return out;
      const rows = await sql<{ campaign_id: string; held: number }>`
        select campaign_id, coalesce(sum(amount), 0)::bigint as held from promotions.redemptions
        where campaign_id in (${sql.join([...new Set(campaignIds)])}) and state = 'reserved' group by campaign_id`.execute(d);
      for (const r of rows.rows) out.set(r.campaign_id, r.held);
      return out;
    },

    /* ---------------------------------------------------------------- atomic counters */
    async addCampaignUsage(campaignId, amount, uses) {
      const r = await sql<{ id: string }>`
        update promotions.campaigns set budget_used = budget_used + ${amount}, usage_count = usage_count + ${uses}
        where id = ${campaignId}
          and (budget_amount is null or budget_used + ${amount} <= budget_amount)
          and (usage_cap is null or usage_count + ${uses} <= usage_cap)
        returning id`.execute(d);
      if (r.rows.length) return 'ok';
      const row = await d.selectFrom('campaigns').select(['budget_amount', 'budget_used', 'usage_cap', 'usage_count']).where('id', '=', campaignId).executeTakeFirst();
      if (!row) return 'missing';
      if (row.budget_amount !== null && row.budget_used + amount > row.budget_amount) return 'budget';
      return 'usage';
    },
    async subtractCampaignUsage(campaignId, amount, uses) {
      await sql`
        update promotions.campaigns set budget_used = greatest(budget_used - ${amount}, 0), usage_count = greatest(usage_count - ${uses}, 0)
        where id = ${campaignId}`.execute(d);
    },
    async addCustomerUsage(campaignId, customerKey, uses, units, limits) {
      await sql`insert into promotions.usage_counters (campaign_id, customer_key, uses, units) values (${campaignId}, ${customerKey}, 0, 0) on conflict do nothing`.execute(d);
      const r = await sql<{ uses: number }>`
        update promotions.usage_counters set uses = uses + ${uses}, units = units + ${units}
        where campaign_id = ${campaignId} and customer_key = ${customerKey}
          and (${limits.perCustomer}::int is null or uses + ${uses} <= ${limits.perCustomer}::int)
          and (${limits.perCustomerUnits}::int is null or units + ${units} <= ${limits.perCustomerUnits}::int)
        returning uses`.execute(d);
      if (r.rows.length) return 'ok';
      const row = await d.selectFrom('usage_counters').selectAll().where('campaign_id', '=', campaignId).where('customer_key', '=', customerKey).executeTakeFirst();
      if (limits.perCustomer !== null && row && row.uses + uses > limits.perCustomer) return 'uses';
      return 'units';
    },
    async subtractCustomerUsage(campaignId, customerKey, uses, units) {
      await sql`
        update promotions.usage_counters set uses = greatest(uses - ${uses}, 0), units = greatest(units - ${units}, 0)
        where campaign_id = ${campaignId} and customer_key = ${customerKey}`.execute(d);
    },
    async addCodeRedemption(codeId) {
      const r = await sql<{ id: string }>`
        update promotions.coupon_codes set redemptions = redemptions + 1
        where id = ${codeId} and active and (max_redemptions is null or redemptions + 1 <= max_redemptions) returning id`.execute(d);
      return r.rows.length > 0;
    },
    async subtractCodeRedemption(codeId) {
      await sql`update promotions.coupon_codes set redemptions = greatest(redemptions - 1, 0) where id = ${codeId}`.execute(d);
    },
    async reserveDealStock(campaignId, offerId, qty) {
      const r = await sql<any>`
        update promotions.flash_items set reserved = reserved + ${qty}
        where campaign_id = ${campaignId} and offer_id = ${offerId} and state = 'active' and claimed + reserved + ${qty} <= deal_stock
        returning *`.execute(d);
      return r.rows[0];
    },
    async releaseDealStock(campaignId, offerId, qty) {
      const r = await sql<any>`
        update promotions.flash_items set reserved = greatest(reserved - ${qty}, 0)
        where campaign_id = ${campaignId} and offer_id = ${offerId} returning *`.execute(d);
      return r.rows[0];
    },
    async claimDealStock(campaignId, offerId, qty) {
      const r = await sql<any>`
        update promotions.flash_items set reserved = greatest(reserved - ${qty}, 0), claimed = claimed + ${qty}
        where campaign_id = ${campaignId} and offer_id = ${offerId} returning *`.execute(d);
      return r.rows[0];
    },
    async unclaimDealStock(campaignId, offerId, qty) {
      const r = await sql<any>`
        update promotions.flash_items set claimed = greatest(claimed - ${qty}, 0)
        where campaign_id = ${campaignId} and offer_id = ${offerId} returning *`.execute(d);
      return r.rows[0];
    },

    /* ---------------------------------------------------------------- jobs and read models */
    async expiredReservations(now, limit) {
      const rows = await d.selectFrom('redemptions').select('reservation_id').distinct().where('state', '=', 'reserved').where('expires_at', '<', now).limit(limit).execute();
      return rows.map((r: { reservation_id: string }) => r.reservation_id);
    },
    async deleteStaleEvaluations(before, limit) {
      const r = await sql`
        delete from promotions.evaluations where id in (
          select e.id from promotions.evaluations e
          where e.valid_until < ${before} and not exists (select 1 from promotions.redemptions r where r.evaluation_id = e.id)
          limit ${limit})`.execute(d);
      return Number(r.numAffectedRows ?? 0);
    },
    async resultFacts(campaignId) {
      const reds = await d.selectFrom('redemptions').selectAll().where('campaign_id', '=', campaignId).where('state', 'in', ['committed', 'partially_reversed', 'reversed']).execute();
      if (!reds.length) return [];
      const ids = reds.map((r: { id: string }) => r.id);
      const lines = await d.selectFrom('redemption_lines').selectAll().where('redemption_id', 'in', ids).execute();
      const evals = await d.selectFrom('evaluations').select(['id', 'result']).where('id', 'in', [...new Set(reds.map((r: { evaluation_id: string }) => r.evaluation_id))]).execute();
      const evalById = new Map(evals.map((e: { id: string; result: unknown }) => [e.id, e.result]));
      return reds.map((r: any) => ({ redemption: r, lines: lines.filter((l: any) => l.redemption_id === r.id), evaluation: evalById.get(r.evaluation_id) ?? null }));
    },
    async resultsInRange(from, to, campaignIds) {
      let q = d.selectFrom('campaign_results_daily').selectAll().where('day', '>=', from).where('day', '<=', to);
      if (campaignIds) q = campaignIds.length ? q.where('campaign_id', 'in', [...campaignIds]) : q.where(sql<boolean>`false`);
      return q.orderBy('day', 'asc').execute();
    },
    async upsertResult(row) {
      const { campaign_id: _c, day: _d, ...rest } = row;
      await d
        .insertInto('campaign_results_daily')
        .values(row)
        .onConflict((oc: any) => oc.columns(['campaign_id', 'day']).doUpdateSet(rest))
        .execute();
    },
  };
  return repo;
}
