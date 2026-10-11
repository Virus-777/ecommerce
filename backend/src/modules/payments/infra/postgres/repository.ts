import { sql, type Kysely } from 'kysely';
import { zonedDayRange } from '../../../../kernel/lib/clock.js';
import { paginate, type PageRequest } from '../../../../kernel/lib/pagination.js';
import type { PaymentsDb } from '../../../../spec/payments.js';
import type { PaymentsRepository, Recs, Table, WebhookRec } from '../../ports.js';

/** jsonb columns per table: values are sent as JSON text (pg would turn JS arrays into PG arrays) */
const JSON_COLUMNS: Record<Table, readonly string[]> = {
  intents: ['tenders', 'method', 'decline', 'next_action'],
  allocations: [],
  captures: [],
  provider_calls: [],
  refunds: ['requested_by'],
  refund_items: [],
  refund_log: ['actor'],
  disputes: ['evidence'],
  dispute_log: ['actor'],
  saved_methods: ['billing_address'],
  webhook_events: ['payload'],
};

function encode(table: Table, row: Record<string, unknown>): Record<string, unknown> {
  const cols = JSON_COLUMNS[table];
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v === undefined) continue;
    out[k] = cols.includes(k) ? (v === null ? null : JSON.stringify(v)) : v;
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
const isUniqueViolation = (err: unknown) => (err as { code?: string })?.code === '23505' || /duplicate key|unique constraint/i.test(String((err as Error)?.message ?? ''));

/** Refund statuses that hold part of the refundable amount (cancel releases it) */
const IN_FLIGHT = ['requested', 'processing', 'failed'];

/** Postgres adapter for PaymentsRepository. `db` is scoped to the `payments` schema. */
export function createPostgresPaymentsRepository(db: Kysely<PaymentsDb>): PaymentsRepository {
  // generic table access: the row types are checked at the PaymentsRepository boundary
  const d: any = db;

  const repo: PaymentsRepository = {
    async transaction(fn) {
      if (db.isTransaction) return fn(repo);
      return db.transaction().execute((trx) => fn(createPostgresPaymentsRepository(trx)));
    },

    /* ---------------------------------------------------------------- generic */
    async get(table, id, o) {
      let q = d.selectFrom(table).selectAll().where('id', '=', id);
      if (o?.forUpdate) q = q.forUpdate();
      return q.executeTakeFirst();
    },
    async find(table, where, o) {
      let q = applyWhere(d.selectFrom(table).selectAll(), where as Record<string, unknown>);
      for (const [c, dir] of o?.orderBy ?? []) q = q.orderBy(c, dir);
      if (o?.limit) q = q.limit(o.limit);
      if (o?.forUpdate) q = q.forUpdate();
      return q.execute();
    },
    async insert(table, row) {
      return d.insertInto(table).values(encode(table, row as Record<string, unknown>)).returningAll().executeTakeFirstOrThrow();
    },
    async liveAuthorizations(after, upTo, limit) {
      let q = db
        .selectFrom('intents')
        .selectAll()
        .where('status', 'in', ['authorized', 'partially_captured'])
        .where('updated_at', '<=', upTo);
      if (after) q = q.where((eb) => eb.or([eb('updated_at', '>', after.updatedAt), eb.and([eb('updated_at', '=', after.updatedAt), eb('id', '>', after.id)])]));
      return (await q.orderBy('updated_at', 'asc').orderBy('id', 'asc').limit(limit).execute()) as never;
    },
    async insertMany(table, rows) {
      if (!rows.length) return;
      await d
        .insertInto(table)
        .values(rows.map((r) => encode(table, r as Record<string, unknown>)))
        .execute();
    },
    async update(table, id, patch) {
      const values = encode(table, patch as Record<string, unknown>);
      if (!Object.keys(values).length) return (await repo.get(table, id))!;
      return d.updateTable(table).set(values).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
    },
    async updateWhere(table, where, patch) {
      const values = encode(table, patch as Record<string, unknown>);
      if (!Object.keys(values).length) return repo.find(table, where);
      return applyWhere(d.updateTable(table).set(values), where as Record<string, unknown>).returningAll().execute();
    },
    async deleteWhere(table, where) {
      await applyWhere(d.deleteFrom(table), where as Record<string, unknown>).execute();
    },

    /* ---------------------------------------------------------------- specific */
    async nextSequence(kind, day) {
      const r = await sql<{ last_value: number }>`
        insert into payments.ref_sequences (kind, day, last_value) values (${kind}, ${day}, 1)
        on conflict (kind, day) do update set last_value = payments.ref_sequences.last_value + 1
        returning last_value`.execute(db);
      return r.rows[0]!.last_value;
    },
    async insertWebhookIfNew(row) {
      const r = await d
        .insertInto('webhook_events')
        .values(encode('webhook_events', row as unknown as Record<string, unknown>))
        .onConflict((oc: any) => oc.columns(['provider', 'external_id']).doNothing())
        .returningAll()
        .executeTakeFirst();
      return (r as WebhookRec | undefined) ?? null;
    },
    async insertIfNew(table, row) {
      // a savepoint keeps the surrounding transaction usable after a unique violation
      const run = async (x: any) => {
        try {
          return await x.insertInto(table).values(encode(table, row as Record<string, unknown>)).returningAll().executeTakeFirstOrThrow();
        } catch (err) {
          if (isUniqueViolation(err)) return null;
          throw err;
        }
      };
      if (!db.isTransaction) return run(d);
      await sql`savepoint payments_insert`.execute(db);
      const r = await run(d);
      await sql.raw(r ? 'release savepoint payments_insert' : 'rollback to savepoint payments_insert').execute(db);
      return r as never;
    },

    async refundTotals(orderId) {
      const rows = await sql<{ order_item_id: string; sent: number; in_flight: number }>`
        select ri.order_item_id,
               coalesce(sum(ri.amount) filter (where r.status = 'sent'), 0)::int as sent,
               coalesce(sum(ri.amount) filter (where r.status in ('requested', 'processing', 'failed')), 0)::int as in_flight
        from payments.refund_items ri join payments.refunds r on r.id = ri.refund_id
        where r.order_id = ${orderId}
        group by ri.order_item_id`.execute(db);
      return rows.rows.map((r) => ({ orderItemId: r.order_item_id, sent: Number(r.sent), inFlight: Number(r.in_flight) }));
    },
    async intentRefundTotals(intentId) {
      const r = await sql<{ sent: number; in_flight: number }>`
        select coalesce(sum(amount) filter (where status = 'sent'), 0)::int as sent,
               coalesce(sum(amount) filter (where status in ('requested', 'processing', 'failed')), 0)::int as in_flight
        from payments.refunds where intent_id = ${intentId}`.execute(db);
      return { sent: Number(r.rows[0]?.sent ?? 0), inFlight: Number(r.rows[0]?.in_flight ?? 0) };
    },

    /* ---------------------------------------------------------------- lists */
    async listIntents(f, page: PageRequest) {
      let q = d.selectFrom('intents').selectAll();
      if (f.status) q = q.where('status', '=', f.status);
      const days = zonedDayRange(f, f.timeZone ?? 'UTC');
      if (days.start) q = q.where('created_at', '>=', days.start);
      if (days.end) q = q.where('created_at', '<', days.end);
      if (f.q?.trim() || f.orderIds?.length) {
        const term = like(f.q ?? '');
        const ids = f.orderIds ?? [];
        q = q.where(
          sql<boolean>`(${f.q?.trim() ? sql`(lower(ref) like ${term} or lower(coalesce(provider_ref, '')) like ${term} or lower(coalesce(guest_email, '')) like ${term} or method->>'last4' = ${f.q.trim()})` : sql`false`}
            or ${ids.length ? sql`order_id in (${sql.join(ids.map((i) => sql`${i}`))})` : sql`false`})`,
        );
      }
      switch (f.flag) {
        case 'orphan':
          q = q.where('orphan', '=', true);
          break;
        case 'pending_check':
          q = q.where('status', '=', 'pending_check');
          break;
        case 'capture_failed':
          q = q.where('status', 'in', ['authorized', 'partially_captured']).where(sql<boolean>`exists (select 1 from payments.captures c where c.intent_id = intents.id and c.status = 'failed')`);
          break;
        case 'chargeback':
          q = q.where(sql<boolean>`exists (select 1 from payments.disputes x where x.intent_id = intents.id)`);
          break;
        case 'partly_refunded':
          q = q.where(sql<boolean>`refunded_amount > 0 and refunded_amount < captured_amount`);
          break;
        case 'refunded':
          q = q.where(sql<boolean>`captured_amount > 0 and refunded_amount >= captured_amount`);
          break;
      }
      return paginate(q, page, { column: 'created_at', direction: 'desc' }) as never;
    },
    async listRefunds(f, page) {
      let q = d.selectFrom('refunds').selectAll();
      if (f.status) q = q.where('status', '=', f.status);
      if (f.failing) q = q.where(sql<boolean>`(status = 'failed' or (status = 'processing' and outcome_unknown))`);
      if (f.origin) q = q.where('origin', '=', f.origin);
      // an orphan payment refund has no order: its checkout session stands in (Refund.orderId)
      if (f.orderId) q = q.where(sql<boolean>`(order_id = ${f.orderId} or (order_id is null and checkout_session_id = ${f.orderId}))`);
      if (f.customerId) q = q.where(sql<boolean>`exists (select 1 from payments.intents i where i.id = refunds.intent_id and i.customer_id = ${f.customerId})`);
      if (f.q?.trim()) {
        const term = like(f.q);
        q = q.where(sql<boolean>`(lower(ref) like ${term} or lower(coalesce(origin_ref, '')) like ${term} or lower(coalesce(provider_ref, '')) like ${term})`);
      }
      return paginate(q, page, { column: 'created_at', direction: 'desc' }) as never;
    },
    async listDisputes(f, page) {
      // evidence due first (cases without a deadline last): page on a computed sort key
      let inner = d.selectFrom('disputes').selectAll().select(sql<Date>`coalesce(evidence_due_at, timestamptz '9999-01-01')`.as('sort_due'));
      if (f.status) inner = inner.where('status', '=', f.status);
      if (f.kind) inner = inner.where('kind', '=', f.kind);
      if (f.sellerId) inner = inner.where('seller_id', '=', f.sellerId);
      const q = d.selectFrom(inner.as('d')).selectAll();
      const res = await paginate(q, page, { column: 'sort_due', direction: 'asc' });
      return { ...res, items: (res.items as unknown as (Recs["disputes"] & { sort_due?: unknown })[]).map(({ sort_due: _s, ...r }) => r) } as never;
    },
    async webhooksFor(intentId) {
      return d
        .selectFrom('webhook_events')
        .selectAll()
        .where((eb: any) => eb.or([eb('intent_id', '=', intentId), eb('refund_id', 'in', eb.selectFrom('refunds').select('id').where('intent_id', '=', intentId))]))
        .orderBy('received_at', 'asc')
        .limit(200)
        .execute();
    },
  };
  return repo;
}

export { IN_FLIGHT };
