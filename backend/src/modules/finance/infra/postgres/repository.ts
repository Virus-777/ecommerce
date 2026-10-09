import { sql, type Kysely } from 'kysely';
import { paginate } from '../../../../kernel/lib/pagination.js';
import type { FinanceDb } from '../../../../spec/finance.js';
import type { EntryRec, FinanceRepository } from '../../ports.js';

/** jsonb columns per table: values are sent as JSON text (pg would turn JS arrays into PG arrays) */
const JSON_COLUMNS: Record<string, readonly string[]> = {
  fee_rule_sets: ['treatment'],
  refund_allocations: ['breakdown'],
  amounts_owed: ['origin'],
  destination_reviews: ['checks'],
  payout_runs: ['approvals'],
  statements: ['sections', 'reconciliation'],
  recon_days: ['checklist'],
  recon_items: ['correction'],
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
    const col = k === 'check' ? sql.ref('check') : k;
    if (v === null) q = q.where(col, 'is', null);
    else if (Array.isArray(v)) q = v.length ? q.where(col, 'in', v) : q.where(sql<boolean>`false`);
    else if (isOp(v)) {
      if (v.op === 'not in') q = Array.isArray(v.value) && v.value.length ? q.where(col, 'not in', v.value) : q;
      else q = q.where(col, v.op, v.value);
    } else q = q.where(col, '=', v);
  }
  return q;
}

const like = (s: string) => `%${s.trim().toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** Postgres adapter for FinanceRepository. `db` is scoped to the `finance` schema. */
export function createPostgresFinanceRepository(db: Kysely<FinanceDb>): FinanceRepository {
  // generic table access: the row types are checked at the FinanceRepository boundary
  const d: any = db;

  const repo: FinanceRepository = {
    async transaction(fn) {
      if (db.isTransaction) return fn(repo);
      return db.transaction().execute((trx) => fn(createPostgresFinanceRepository(trx)));
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
    async sum(table, column, where) {
      const r = await applyWhere(d.selectFrom(table).select(sql<number>`coalesce(sum(${sql.ref(column)}), 0)::bigint`.as('n')), where as Record<string, unknown>).executeTakeFirst();
      return Number((r as { n: number } | undefined)?.n ?? 0);
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

    /* ---------------------------------------------------------------- specific */
    async lockAccount(sellerId, currency, now) {
      await d
        .insertInto('seller_accounts')
        .values({ seller_id: sellerId, pending: 0, available: 0, held: 0, currency, negative_since: null, payouts_blocked_reason: null, fee_override_set_id: null, updated_at: now })
        .onConflict((oc: any) => oc.column('seller_id').doNothing())
        .execute();
      return d.selectFrom('seller_accounts').selectAll().where('seller_id', '=', sellerId).forUpdate().executeTakeFirstOrThrow();
    },
    async ledgerPage(sellerId, f, page) {
      let q = d.selectFrom('ledger_entries').selectAll().where('seller_id', '=', sellerId);
      if (f.types?.length) q = q.where('type', 'in', f.types);
      if (f.from) q = q.where('at', '>=', f.from);
      if (f.to) q = q.where('at', '<', f.to);
      if (f.q?.trim()) {
        const term = like(f.q);
        q = q.where((eb: any) => eb.or([eb(sql`lower(description)`, 'like', term), eb(sql`lower(coalesce(ref_label, ''))`, 'like', term), eb(sql`lower(ref_id)`, 'like', term)]));
      }
      return paginate(q, page, { column: 'at', direction: 'desc' }) as never;
    },
    async dailyTypeSums(from, to, timeZone, types, sellerId) {
      if (!types.length) return [];
      const rows = await sql<{ day: string; seller_id: string; type: string; amount: number }>`
        select to_char((at at time zone ${timeZone})::date, 'YYYY-MM-DD') as day, seller_id, type, coalesce(sum(amount), 0)::bigint as amount
        from finance.ledger_entries
        where at >= ${from} and at < ${to} and type in (${sql.join(types)}) ${sellerId ? sql`and seller_id = ${sellerId}` : sql``}
        group by 1, 2, 3 order by 1, 2`.execute(d);
      return rows.rows.map((r) => ({ day: r.day, sellerId: r.seller_id, type: r.type, amount: Number(r.amount) }));
    },
    async typeSums(from, to, types) {
      const out = new Map<string, number>();
      if (!types.length) return out;
      const rows = await sql<{ type: string; amount: number }>`
        select type, coalesce(sum(amount), 0)::bigint as amount from finance.ledger_entries
        where at >= ${from} and at < ${to} and type in (${sql.join(types)}) group by type`.execute(d);
      for (const r of rows.rows) out.set(r.type, Number(r.amount));
      return out;
    },
    async pendingFromLedger(sellerId) {
      const r = await sql<{ n: number }>`
        select coalesce(sum(e.amount), 0)::bigint as n from finance.ledger_entries e
        join finance.earnings_lots l on l.id = e.lot_id
        where e.seller_id = ${sellerId} and e.bucket = 'pending' and l.state = 'pending'`.execute(d);
      return Number(r.rows[0]?.n ?? 0);
    },
    async entriesForStatement(sellerId, cutoff) {
      const r = await sql<EntryRec>`
        select e.* from finance.ledger_entries e
        left join finance.earnings_lots l on l.id = e.lot_id
        left join finance.payouts p on e.type = 'payout' and e.ref_kind = 'payout' and p.id::text = e.ref_id
        where e.seller_id = ${sellerId} and e.statement_id is null and e.at <= ${cutoff}
          and (e.lot_id is null or l.state <> 'pending')
          and not (e.type = 'payout' and p.run_id is not null)
        order by e.at, e.id`.execute(d);
      return r.rows;
    },
    async assignedAvailable(sellerId) {
      const r = await sql<{ n: number }>`
        select coalesce(sum(e.amount), 0)::bigint as n from finance.ledger_entries e
        join finance.statements s on s.id = e.statement_id
        where e.seller_id = ${sellerId} and e.bucket <> 'held' and s.status = 'issued'`.execute(d);
      return Number(r.rows[0]?.n ?? 0);
    },
    async sellersForRun(cutoff) {
      const r = await sql<{ seller_id: string }>`
        select distinct seller_id from (
          select e.seller_id from finance.ledger_entries e
          left join finance.earnings_lots l on l.id = e.lot_id
          where e.statement_id is null and e.at <= ${cutoff} and (e.lot_id is null or l.state <> 'pending')
          union select seller_id from finance.seller_accounts where available > 0
        ) s order by seller_id`.execute(d);
      return r.rows.map((x) => x.seller_id);
    },
  };
  return repo;
}
