import { sql, type Kysely } from 'kysely';
import { paginate } from '../../../../kernel/lib/pagination.js';
import type { SellersDb } from '../../../../spec/sellers.js';
import type { SellersRepository, Where } from '../../ports.js';

/** jsonb columns per table: values are sent as JSON text (pg would turn JS arrays into PG arrays) */
const JSON_COLUMNS: Record<string, readonly string[]> = {
  sellers: ['business_address', 'contact', 'verification_checked', 'launch_review', 'payout_blocked_reasons'],
  payout_changes: ['requested_by'],
  pending_changes: ['payload', 'requested_by'],
  applications: ['completed_steps', 'account', 'business', 'verification', 'payout', 'return_address', 'decision'],
  information_requests: ['items'],
  risk_reviews: ['flags'],
  store_profiles: ['contact_options'],
  featured_collections: ['offer_ids'],
  public_claims: ['evidence_media_ids'],
  change_requests: ['current', 'proposed', 'evidence_media_ids'],
  members: ['permissions'],
  performance_snapshots: ['metrics'],
  restrictions: ['affected_activities', 'scope', 'still_works', 'appeal_route', 'resolution_evidence'],
  suspensions: ['appeal_route'],
  appeals: ['evidence_media_ids', 'decision'],
};

function encode(table: string, row: Record<string, unknown>): Record<string, unknown> {
  const cols = JSON_COLUMNS[table];
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v === undefined) continue;
    if (cols?.includes(k)) out[k] = v === null ? null : JSON.stringify(v);
    else if (v instanceof Uint8Array && !Buffer.isBuffer(v)) out[k] = Buffer.from(v);
    else out[k] = v;
  }
  return out;
}

const isOp = (v: unknown): v is { op: string; value: unknown } => typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date) && 'op' in v;

function applyWhere(q: any, where: Record<string, unknown>, prefix = ''): any {
  for (const [k, v] of Object.entries(where)) {
    if (v === undefined) continue;
    const col = `${prefix}${k}`;
    if (v === null) q = q.where(col, 'is', null);
    else if (Array.isArray(v)) q = v.length ? q.where(col, 'in', v) : q.where(sql<boolean>`false`);
    else if (isOp(v)) q = q.where(col, v.op, v.value);
    else q = q.where(col, '=', v);
  }
  return q;
}

const like = (s: string) => `%${s.trim().toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** Postgres adapter for SellersRepository. `db` is scoped to the `sellers` schema. */
export function createPostgresSellersRepository(db: Kysely<SellersDb>): SellersRepository {
  // generic table access: the row types are checked at the SellersRepository boundary
  const d: any = db;

  const sellerFilters = (q: any, f: Parameters<SellersRepository['listSellers']>[0]) => {
    if (f.q?.trim()) {
      const term = like(f.q);
      q = q.where((eb: any) =>
        eb.or([eb(sql`lower(store_name)`, 'like', term), eb(sql`lower(legal_name)`, 'like', term), eb(sql`lower(contact->>'email')`, 'like', term), eb(sql`lower(ref)`, 'like', term)]),
      );
    }
    if (f.statuses?.length) q = q.where('status', 'in', f.statuses);
    if (f.verified !== undefined) q = f.verified ? q.where('verification_state', '=', 'verified') : q.where('verification_state', '<>', 'verified');
    if (f.categoryId) {
      q = q.where(
        sql<boolean>`exists (select 1 from sellers.applications a where a.id = sellers.application_id and a.business->'categoryIds' @> ${JSON.stringify([f.categoryId])}::jsonb)`,
      );
    }
    if (f.onTimeBelow !== undefined) {
      q = q.where(
        sql<boolean>`(select (s.metrics->'dispatch_reliability'->>'value')::numeric from sellers.performance_snapshots s where s.seller_id = sellers.id order by s.computed_at desc limit 1) < ${f.onTimeBelow}`,
      );
    }
    return q;
  };

  const repo: SellersRepository = {
    async transaction(fn) {
      if (db.isTransaction) return fn(repo);
      return db.transaction().execute((trx) => fn(createPostgresSellersRepository(trx)));
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
    async update(table, id, patch) {
      const values = encode(table, patch as Record<string, unknown>);
      if (!Object.keys(values).length) return (await repo.get(table, id))!;
      return d.updateTable(table).set(values).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
    },
    async remove(table, id) {
      await d.deleteFrom(table).where('id', '=', id).execute();
    },
    async page(table, where, page, order) {
      const q = applyWhere(d.selectFrom(table).selectAll(), where as Record<string, unknown>);
      return paginate(q, page, order) as never;
    },

    /* ---------------------------------------------------------------- store profiles */
    async getProfile(sellerId) {
      return d.selectFrom('store_profiles').selectAll().where('seller_id', '=', sellerId).executeTakeFirst();
    },
    async upsertProfile(row) {
      const values = encode('store_profiles', row as unknown as Record<string, unknown>);
      const { seller_id: _id, ...rest } = values;
      return d.insertInto('store_profiles').values(values).onConflict((oc: any) => oc.column('seller_id').doUpdateSet(rest)).returningAll().executeTakeFirstOrThrow();
    },

    /* ---------------------------------------------------------------- sellers */
    async sellerBySlug(slug) {
      return d.selectFrom('sellers').selectAll().where('slug', '=', slug).executeTakeFirst();
    },
    async sellersByStoreName(name) {
      return d.selectFrom('sellers').selectAll().where(sql`lower(store_name)`, '=', name.trim().toLowerCase()).execute();
    },
    async slugTaken(slug) {
      return Boolean(await d.selectFrom('sellers').select('id').where('slug', '=', slug).executeTakeFirst());
    },
    async listSellers(filter, page) {
      const q = sellerFilters(d.selectFrom('sellers').selectAll(), filter);
      if (filter.sort === 'name') return paginate(q, page, { column: 'store_name', direction: 'asc' }) as never;
      return paginate(q, page, { column: 'created_at', direction: 'desc' }) as never;
    },
    async allSellerIds(filter, limit) {
      return sellerFilters(d.selectFrom('sellers').selectAll(), filter).orderBy('created_at', 'desc').limit(limit).execute();
    },
    async countSellersByStatus() {
      const rows = await d.selectFrom('sellers').select(['status', sql<number>`count(*)::int`.as('n')]).groupBy('status').execute();
      return Object.fromEntries(rows.map((r: any) => [r.status, r.n]));
    },
    async countSellersCreatedSince(since) {
      const r = await d.selectFrom('sellers').select(sql<number>`count(*)::int`.as('n')).where('approved_at', '>=', since).executeTakeFirst();
      return (r as any)?.n ?? 0;
    },
    async countBelowDispatch() {
      const r = await sql<{ n: number }>`
        select count(*)::int as n from (
          select distinct on (seller_id) seller_id, metrics from sellers.performance_snapshots order by seller_id, computed_at desc
        ) s join sellers.sellers x on x.id = s.seller_id
        where x.status in ('approved','restricted','suspended') and s.metrics->'dispatch_reliability'->>'status' in ('below','action_needed')`.execute(d);
      return r.rows[0]?.n ?? 0;
    },

    /* ---------------------------------------------------------------- applications */
    async listApplications(f, page) {
      let q = d.selectFrom('applications').selectAll().where('submitted_at', 'is not', null).where('decision_target_at', 'is not', null);
      if (f.state) q = q.where('state', '=', f.state);
      if (f.reviewerId) q = q.where('reviewer_id', '=', f.reviewerId);
      if (f.riskLevel) q = q.where(sql<boolean>`exists (select 1 from sellers.risk_reviews r where r.application_id = applications.id and r.level = ${f.riskLevel})`);
      if (f.overdue !== undefined) {
        const open = sql<boolean>`(state in ('submitted','under_review','information_required') and decision_target_at < ${f.now})`;
        q = q.where(f.overdue ? open : sql<boolean>`not ${open}`);
      }
      if (f.q?.trim()) {
        const term = like(f.q);
        q = q.where((eb: any) =>
          eb.or([eb(sql`lower(ref)`, 'like', term), eb(sql`lower(account->>'storeName')`, 'like', term), eb(sql`lower(business->>'legalName')`, 'like', term), eb(sql`lower(account->>'contactName')`, 'like', term)]),
        );
      }
      return paginate(q, page, { column: 'decision_target_at', direction: 'asc' }) as never;
    },
    async latestApplicationOf(accountId) {
      return d.selectFrom('applications').selectAll().where('applicant_account_id', '=', accountId).orderBy('created_at', 'desc').orderBy('id', 'desc').limit(1).executeTakeFirst();
    },
    async applicationsMatching(s, excludeId) {
      const conds: any[] = [];
      if (s.emails.length) conds.push(sql<boolean>`lower(account->>'workEmail') in (${sql.join(s.emails.map((e) => e.toLowerCase()))})`);
      if (s.tokens.length) {
        conds.push(sql<boolean>`(payout->'current'->>'providerDestinationId') in (${sql.join(s.tokens)}) or (payout->'pendingChange'->>'providerDestinationId') in (${sql.join(s.tokens)})`);
      }
      for (const a of s.addresses) {
        conds.push(sql<boolean>`(lower(business->'address'->>'line1') = ${a.line1.toLowerCase().trim()} and business->'address'->>'postalCode' = ${a.postalCode.trim()})`);
        conds.push(sql<boolean>`(lower(return_address->'address'->>'line1') = ${a.line1.toLowerCase().trim()} and return_address->'address'->>'postalCode' = ${a.postalCode.trim()})`);
      }
      if (s.taxIdHashes?.length) conds.push(sql<boolean>`tax_id_hash in (${sql.join(s.taxIdHashes)})`);
      if (!conds.length) return [];
      return d
        .selectFrom('applications')
        .selectAll()
        .where('id', '<>', excludeId)
        .where(sql<boolean>`(${sql.join(conds, sql` or `)})`)
        .limit(20)
        .execute();
    },

    /* ---------------------------------------------------------------- members */
    async activeMember(sellerId, accountId) {
      return d.selectFrom('members').selectAll().where('account_id', '=', accountId).where('seller_id', '=', sellerId).where('status', '=', 'active').executeTakeFirst();
    },

    /* ---------------------------------------------------------------- performance */
    async insertPerformanceEvent(row) {
      const r = await d.insertInto('performance_events').values(encode('performance_events', row as never)).onConflict((oc: any) => oc.columns(['kind', 'subject_id']).doNothing()).returning('id').executeTakeFirst();
      return Boolean(r);
    },
    async performanceFacts(sellerId, since) {
      const rows = await sql<{ kind: string; n: number; total: string | null }>`
        select kind, count(*)::int as n, sum(value)::text as total from sellers.performance_events
        where seller_id = ${sellerId} and occurred_at >= ${since} group by kind`.execute(d);
      const missing = await sql<{ n: number }>`
        select count(*)::int as n from sellers.performance_events m
        where m.seller_id = ${sellerId} and m.kind = 'tracking_missing' and m.occurred_at >= ${since}
          and not exists (select 1 from sellers.performance_events v where v.kind = 'tracking_valid' and v.subject_id = m.subject_id)`.execute(d);
      const out = rows.rows.map((r) => ({ kind: r.kind, n: r.n, total: Number(r.total ?? 0) }));
      const m = out.find((r) => r.kind === 'tracking_missing');
      if (m) m.n = missing.rows[0]?.n ?? 0;
      return out;
    },
    async unresolvedCasesPastDeadline(sellerId, nowMs) {
      const r = await sql<{ n: number }>`
        select count(*)::int as n from sellers.performance_events o
        where o.seller_id = ${sellerId} and o.kind = 'case_opened'
          and coalesce(o.value, (extract(epoch from o.occurred_at) * 1000 + 172800000)) < ${nowMs}
          and not exists (select 1 from sellers.performance_events r where r.kind = 'case_resolved' and r.subject_id = o.subject_id)`.execute(d);
      return r.rows[0]?.n ?? 0;
    },
    async latestSnapshots(sellerIds, perSeller) {
      if (!sellerIds.length) return [];
      const r = await sql<any>`
        select * from (
          select s.*, row_number() over (partition by seller_id order by computed_at desc) as rn
          from sellers.performance_snapshots s where seller_id in (${sql.join([...new Set(sellerIds)])})
        ) t where rn <= ${perSeller} order by seller_id, computed_at desc`.execute(d);
      return r.rows.map(({ rn: _rn, ...row }: any) => row);
    },

    /* ---------------------------------------------------------------- jobs */
    async deleteDocumentsDue(today, limit) {
      const rows = await d.selectFrom('application_documents').selectAll().where('delete_after', '<=', today).orderBy('delete_after').limit(limit).execute();
      if (rows.length) await d.deleteFrom('application_documents').where('id', 'in', rows.map((r: any) => r.id)).execute();
      return rows;
    },
  };
  return repo;
}
