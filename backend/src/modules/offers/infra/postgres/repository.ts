import { sql, type Kysely } from 'kysely';
import type { Inbox } from '../../../../kernel/events/inbox.js';
import { paginate } from '../../../../kernel/lib/pagination.js';
import type { OffersDb } from '../../../../spec/offers.js';
import type { OfferListFilter, OffersRepository } from '../../ports.js';

/** jsonb columns per table: values are sent as JSON text (pg would turn JS arrays into PG arrays) */
const JSON_COLUMNS: Record<string, readonly string[]> = {
  offers: ['included_items', 'missing_items', 'ineligible_source', 'status_reason'],
  offer_eligibility: ['reasons'],
  featured_offers: ['candidates'],
  featured_rules: ['steps', 'parameters'],
  bulk_update_jobs: ['totals'],
};

function encode(table: string, row: Record<string, unknown>): Record<string, unknown> {
  const cols = JSON_COLUMNS[table];
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v === undefined) continue;
    if (cols?.includes(k)) out[k] = v === null ? null : JSON.stringify(v);
    else out[k] = v;
  }
  return out;
}

const isOp = (v: unknown): v is { op: string; value: unknown } => typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date) && 'op' in v;

function applyWhere(q: any, where: Record<string, unknown>): any {
  for (const [col, v] of Object.entries(where)) {
    if (v === undefined) continue;
    if (v === null) q = q.where(col, 'is', null);
    else if (Array.isArray(v)) q = v.length ? q.where(col, 'in', v) : q.where(sql<boolean>`false`);
    else if (isOp(v)) {
      if (v.op === 'not in') {
        const list = v.value as unknown[];
        if (list.length) q = q.where(col, 'not in', list);
      } else q = q.where(col, v.op, v.value);
    } else q = q.where(col, '=', v);
  }
  return q;
}

const like = (s: string) => `%${s.trim().toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

function offerFilters(q: any, f: OfferListFilter): any {
  if (f.ownerType) q = q.where('owner_type', '=', f.ownerType);
  if (f.sellerId) q = q.where('seller_id', '=', f.sellerId);
  if (f.productId) q = q.where('product_id', '=', f.productId);
  if (f.productIds) q = f.productIds.length ? q.where('product_id', 'in', f.productIds) : q.where(sql<boolean>`false`);
  if (f.variantIds) q = f.variantIds.length ? q.where('variant_id', 'in', f.variantIds) : q.where(sql<boolean>`false`);
  if (f.ids) q = f.ids.length ? q.where('id', 'in', f.ids) : q.where(sql<boolean>`false`);
  if (f.statuses?.length) q = q.where('status', 'in', f.statuses);
  if (f.excludeStatuses?.length) q = q.where('status', 'not in', f.excludeStatuses);
  if (f.conditions?.length) q = q.where('condition', 'in', f.conditions);
  if (f.contentGap) q = q.where(sql<boolean>`${f.contentGap} = any(content_gaps)`);
  if (f.shippingProfileId) q = q.where('shipping_profile_id', '=', f.shippingProfileId);
  if (f.q?.trim()) {
    const term = like(f.q);
    // title: substring or trigram similarity (gin title index); seller SKU; exact offer id
    q = q.where((eb: any) => eb.or([eb(sql`lower(title)`, 'like', term), sql<boolean>`title % ${f.q!.trim()}`, eb(sql`lower(seller_sku)`, 'like', term), eb(sql`id::text`, '=', f.q!.trim().toLowerCase())]));
  }
  if (f.featuredEligible !== undefined) {
    q = f.featuredEligible
      ? q.where(sql<boolean>`exists (select 1 from offers.offer_eligibility e where e.offer_id = offers.id and e.eligible)`)
      : q.where(sql<boolean>`not exists (select 1 from offers.offer_eligibility e where e.offer_id = offers.id and e.eligible)`);
  }
  if (f.ineligibilityCode) {
    q = q.where(sql<boolean>`exists (select 1 from offers.offer_eligibility e where e.offer_id = offers.id and e.reasons @> ${JSON.stringify([{ code: f.ineligibilityCode }])}::jsonb)`);
  }
  return q;
}

/** Postgres adapter for OffersRepository. `db` is scoped to the `offers` schema. */
export function createPostgresOffersRepository(db: Kysely<OffersDb>, inbox?: Inbox): OffersRepository {
  // generic table access: the row types are checked at the OffersRepository boundary
  const d: any = db;

  const repo: OffersRepository = {
    async transaction(fn) {
      if (db.isTransaction) return fn(repo);
      return db.transaction().execute((trx) => fn(createPostgresOffersRepository(trx, inbox)));
    },
    async claim(key) {
      if (!inbox) throw new Error('offers repository: no inbox');
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
      return d.selectFrom(table).selectAll().where('id', 'in', [...new Set(ids)]).execute();
    },
    async find(table, where, o) {
      let q = applyWhere(d.selectFrom(table).selectAll(), where as Record<string, unknown>);
      for (const [c, dir] of o?.orderBy ?? []) q = q.orderBy(c, dir);
      if (o?.limit) q = q.limit(o.limit);
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
    async update(table, id, patch) {
      const values = encode(table, patch as Record<string, unknown>);
      if (!Object.keys(values).length) return (await repo.get(table, id))!;
      return d.updateTable(table).set(values).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
    },
    async updateWhere(table, where, patch) {
      const values = encode(table, patch as Record<string, unknown>);
      if (!Object.keys(values).length) return 0;
      const r = await applyWhere(d.updateTable(table).set(values), where as Record<string, unknown>).executeTakeFirst();
      return Number((r as { numUpdatedRows?: bigint } | undefined)?.numUpdatedRows ?? 0);
    },
    async deleteWhere(table, where) {
      await applyWhere(d.deleteFrom(table), where as Record<string, unknown>).execute();
    },

    /* ---------------------------------------------------------------- offers */
    async listOffers(filter, page, order) {
      const q = offerFilters(d.selectFrom('offers').selectAll(), filter);
      return paginate(q, page, order ?? { column: 'updated_at', direction: 'desc' }) as never;
    },
    async allOffers(filter, limit) {
      return offerFilters(d.selectFrom('offers').selectAll(), filter).orderBy('updated_at', 'desc').orderBy('id', 'desc').limit(limit).execute();
    },
    async countByStatus(filter) {
      const rows = await offerFilters(d.selectFrom('offers').select(['status', sql<number>`count(*)::int`.as('n')]), filter).groupBy('status').execute();
      return Object.fromEntries(rows.map((r: any) => [r.status, r.n]));
    },
    async featuredOfferIds(offerIds) {
      if (!offerIds.length) return new Set();
      const rows = await d.selectFrom('featured_offers').select('offer_id').where('offer_id', 'in', [...new Set(offerIds)]).execute();
      return new Set(rows.map((r: any) => r.offer_id as string));
    },

    /* ---------------------------------------------------------------- price changes */
    async listPriceChanges(f, page) {
      let q = d.selectFrom('price_changes').selectAll();
      if (f.states?.length) q = q.where('state', 'in', f.states);
      if (f.offerId) q = q.where('offer_id', '=', f.offerId);
      if (f.ownerType) q = q.where(sql<boolean>`exists (select 1 from offers.offers o where o.id = price_changes.offer_id and o.owner_type = ${f.ownerType})`);
      if (f.sellerId) q = q.where(sql<boolean>`exists (select 1 from offers.offers o where o.id = price_changes.offer_id and o.seller_id = ${f.sellerId})`);
      return paginate(q, page, { column: 'created_at', direction: 'desc' }) as never;
    },

    /* ---------------------------------------------------------------- eligibility */
    async getEligibility(offerIds) {
      if (!offerIds.length) return [];
      return d.selectFrom('offer_eligibility').selectAll().where('offer_id', 'in', [...new Set(offerIds)]).execute();
    },
    async upsertEligibility(row) {
      const values = encode('offer_eligibility', row as never);
      const { offer_id: _id, ...rest } = values;
      await d.insertInto('offer_eligibility').values(values).onConflict((oc: any) => oc.column('offer_id').doUpdateSet(rest)).execute();
    },

    /* ---------------------------------------------------------------- featured */
    async getFeatured(variantId, group, zone) {
      return d.selectFrom('featured_offers').selectAll().where('variant_id', '=', variantId).where('condition_group', '=', group).where('zone_key', '=', zone).executeTakeFirst();
    },
    async upsertFeatured(row) {
      const values = encode('featured_offers', row as never);
      const { variant_id: _v, condition_group: _g, zone_key: _z, ...rest } = values;
      await d
        .insertInto('featured_offers')
        .values(values)
        .onConflict((oc: any) => oc.columns(['variant_id', 'condition_group', 'zone_key']).doUpdateSet(rest))
        .execute();
    },
    async markFeaturedDirty(w) {
      let q = d.updateTable('featured_offers').set({ dirty: true });
      if (!w.all) {
        const conds: any[] = [];
        if (w.variantIds?.length) conds.push(sql<boolean>`variant_id in (${sql.join([...new Set(w.variantIds)])})`);
        if (w.productIds?.length) conds.push(sql<boolean>`product_id in (${sql.join([...new Set(w.productIds)])})`);
        if (w.olderThan) conds.push(sql<boolean>`computed_at < ${w.olderThan}`);
        if (w.ruleVersionNot !== undefined) conds.push(sql<boolean>`rule_version <> ${w.ruleVersionNot}`);
        if (!conds.length) return 0;
        q = q.where(sql<boolean>`(${sql.join(conds, sql` or `)})`);
      }
      const r = await q.where('dirty', '=', false).executeTakeFirst();
      return Number(r?.numUpdatedRows ?? 0);
    },
    async dirtyFeatured(limit) {
      return d.selectFrom('featured_offers').selectAll().where('dirty', '=', true).orderBy('computed_at', 'asc').limit(limit).execute();
    },

    /* ---------------------------------------------------------------- rules */
    async rules() {
      return d.selectFrom('featured_rules').selectAll().orderBy('version', 'asc').execute();
    },

    /* ---------------------------------------------------------------- bulk */
    async listBulkJobs(f, page) {
      let q = d.selectFrom('bulk_update_jobs').selectAll().where('owner_type', '=', f.ownerType);
      if (f.sellerId) q = q.where('seller_id', '=', f.sellerId);
      return paginate(q, page, { column: 'uploaded_at', direction: 'desc' }) as never;
    },
    async bulkRows(jobId, result, page) {
      let q = d.selectFrom('bulk_update_rows').selectAll().where('job_id', '=', jobId);
      if (result) q = q.where('result', '=', result);
      return paginate(q, page, { column: 'row_no', direction: 'asc', id: 'row_no' }) as never;
    },
    async updateBulkRow(jobId, rowNo, patch) {
      const values = encode('bulk_update_rows', patch as never);
      if (!Object.keys(values).length) return;
      await d.updateTable('bulk_update_rows').set(values).where('job_id', '=', jobId).where('row_no', '=', rowNo).execute();
    },
  };
  return repo;
}
