import { zonedDayRange } from '../../../../kernel/lib/clock.js';
import { decodeCursor, encodeCursor, type PageRequest } from '../../../../kernel/lib/pagination.js';
import type { ModuleStore, Table as Collection } from '../../../../kernel/mongo/index.js';
import type { Filter } from '../../../../kernel/mongo/table.js';
import type { Page } from '../../../../spec/common.js';
import type { PaymentsRepository, Recs, Table, WebhookRec } from '../../ports.js';

/** jsonb columns per table: stored as JSON (dates inside become ISO strings when read back) */
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

const TABLES = Object.keys(JSON_COLUMNS) as Table[];

function encode(table: Table, row: Record<string, unknown>): Record<string, unknown> {
  const cols = JSON_COLUMNS[table];
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v === undefined) continue;
    out[k] = cols.includes(k) && v !== null ? JSON.parse(JSON.stringify(v)) : v;
  }
  return out;
}

const isOp = (v: unknown): v is { op: string; value: unknown } => typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date) && 'op' in v;

const OPS: Record<string, string> = { '<': '$lt', '<=': '$lte', '>': '$gt', '>=': '$gte' };

/** The port's Where as a filter, with SQL's meaning: <> skips nulls, an empty list matches nothing */
function toFilter(where: Record<string, unknown>): Filter {
  const out: Filter = {};
  for (const [k, v] of Object.entries(where)) {
    if (v === undefined) continue;
    if (v === null) out[k] = null;
    else if (Array.isArray(v)) out[k] = { $in: [...v] };
    else if (isOp(v)) {
      if (v.op === '<>') out[k] = { $nin: [v.value, null] };
      else if (v.op === 'is not') out[k] = { $ne: v.value };
      else out[k] = { [OPS[v.op]!]: v.value };
    } else out[k] = v;
  }
  return out;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** lower(col) like '%term%' */
const contains = (s: string) => ({ $regex: escapeRegExp(s.trim().toLowerCase()), $options: 'i' });
const and = (conds: Filter[]): Filter => (conds.length ? { $and: conds } : {});
const isDuplicateKey = (err: unknown) => (err as { code?: number })?.code === 11000;

/** Refund statuses that hold part of the refundable amount (cancel releases it) */
const IN_FLIGHT = ['requested', 'processing', 'failed'];
/** Intent statuses that end an attempt: a new attempt for the same checkout session may start */
const ENDED_INTENT = ['failed', 'voided', 'expired'];

/**
 * The unique keys of a row (unique indexes of the spec), as filters: an insert into a transaction must not hit a
 * duplicate key (it aborts the transaction), so insertIfNew looks for each first.
 */
function uniqueKeys(table: 'refunds' | 'captures' | 'intents', row: Record<string, unknown>): Filter[] {
  switch (table) {
    case 'intents':
      return [
        { ref: row.ref },
        { idempotency_key: row.idempotency_key },
        // one live intent per checkout session
        ...(ENDED_INTENT.includes(row.status as string) ? [] : [{ checkout_session_id: row.checkout_session_id, status: { $nin: ENDED_INTENT } }]),
      ];
    case 'refunds':
      return [
        { ref: row.ref },
        { idempotency_key: row.idempotency_key },
        // one refund per origin, except cancellations (one per cancelled item) and cancelled refunds
        ...(row.origin_id != null && row.origin !== 'cancellation' && row.status !== 'cancelled'
          ? [{ origin: row.origin, origin_id: row.origin_id, status: { $ne: 'cancelled' } }]
          : []),
      ];
    case 'captures':
      return [{ idempotency_key: row.idempotency_key }];
  }
}

/** MongoDB adapter for PaymentsRepository (docs/04-mongodb-migration.md): one collection per spec table. */
export function createMongoPaymentsRepository(store: ModuleStore): PaymentsRepository {
  const tables = Object.fromEntries(TABLES.map((t) => [t, store.table(t)])) as { [T in Table]: Collection<Recs[T]> };
  const sequences = store.table<{ kind: string; day: string; last_value: number }>('ref_sequences');
  // generic table access: the row types are checked at the PaymentsRepository boundary
  const t = (table: Table): Collection<any> => tables[table];

  const sortOf = (orderBy: [string, 'asc' | 'desc'][] | undefined) => (orderBy?.length ? Object.fromEntries(orderBy.map(([c, d]) => [c, d === 'desc' ? -1 : 1])) : undefined) as Record<string, 1 | -1> | undefined;

  const repo: PaymentsRepository = {
    transaction: (fn) => store.transaction((tx) => fn(tx === store ? repo : createMongoPaymentsRepository(tx))),

    /* ---------------------------------------------------------------- generic */
    get: (table, id, o) => t(table).get(id, o),
    find: (table, where, o) => t(table).find(toFilter(where as Record<string, unknown>), { sort: sortOf(o?.orderBy as never), limit: o?.limit, forUpdate: o?.forUpdate }),
    insert: (table, row) => t(table).insert(encode(table, row as Record<string, unknown>)),
    async liveAuthorizations(after, upTo, limit) {
      const keyset = after ? [{ $or: [{ updated_at: { $gt: after.updatedAt } }, { updated_at: after.updatedAt, id: { $gt: after.id } }] }] : [];
      return tables.intents.find(and([{ status: { $in: ['authorized', 'partially_captured'] }, updated_at: { $lte: upTo } }, ...keyset]), { sort: { updated_at: 1, id: 1 }, limit });
    },
    async insertMany(table, rows) {
      await t(table).insertMany(rows.map((r) => encode(table, r as Record<string, unknown>)));
    },
    async update(table, id, patch) {
      const values = encode(table, patch as Record<string, unknown>);
      const row = Object.keys(values).length ? await t(table).update(id, values) : await t(table).get(id);
      if (!row) throw new Error(`payments: ${table} ${id} not found`);
      return row;
    },
    async updateWhere(table, where, patch) {
      const values = encode(table, patch as Record<string, unknown>);
      const filter = toFilter(where as Record<string, unknown>);
      if (!Object.keys(values).length) return t(table).find(filter);
      // the rows that matched, changed together: in a transaction a concurrent writer conflicts and is retried
      return store.transaction(async (tx) => {
        const c = tx.table<Record<string, unknown>>(table);
        const ids = (await c.aggregate<{ _id: unknown }>([{ $match: c.filter(filter) }, { $project: { _id: 1 } }])).map((d) => d._id);
        if (!ids.length) return [];
        await c.model.updateMany({ _id: { $in: ids } }, { $set: c.toDoc(values) }, { session: c.session, runValidators: true });
        return (await c.model.find({ _id: { $in: ids } }, null, { session: c.session, lean: true })).map((d) => c.fromDoc(d as never)) as never;
      });
    },
    async deleteWhere(table, where) {
      await t(table).deleteMany(toFilter(where as Record<string, unknown>));
    },

    /* ---------------------------------------------------------------- specific */
    async nextSequence(kind, day) {
      // on conflict (kind, day) do update set last_value = last_value + 1
      const doc = await sequences.model.findOneAndUpdate({ kind, day }, { $inc: { last_value: 1 } }, { upsert: true, new: true, lean: true, session: sequences.session ?? null });
      return (doc as unknown as { last_value: number }).last_value;
    },
    async insertWebhookIfNew(row) {
      const r = await tables.webhook_events.insertIfAbsent(encode('webhook_events', row as unknown as Record<string, unknown>), ['provider', 'external_id']);
      return (r as WebhookRec | undefined) ?? null;
    },
    async insertIfNew(table, row) {
      const values = encode(table, row as Record<string, unknown>);
      const c = t(table);
      for (const key of uniqueKeys(table, values)) if (await c.exists(key)) return null;
      try {
        return await c.insert(values);
      } catch (err) {
        // outside a transaction a concurrent insert of the same key may still win (inside one it is a write conflict, retried)
        if (!store.inTransaction && isDuplicateKey(err)) return null;
        throw err;
      }
    },

    async refundTotals(orderId) {
      const refunds = await tables.refunds.find({ order_id: orderId });
      const status = new Map(refunds.map((r) => [r.id, r.status]));
      const items = refunds.length ? await tables.refund_items.find({ refund_id: { $in: [...status.keys()] } }) : [];
      const totals = new Map<string, { orderItemId: string; sent: number; inFlight: number }>();
      for (const i of items) {
        const s = status.get(i.refund_id)!;
        const tot = totals.get(i.order_item_id) ?? { orderItemId: i.order_item_id, sent: 0, inFlight: 0 };
        if (s === 'sent') tot.sent += i.amount;
        else if (IN_FLIGHT.includes(s)) tot.inFlight += i.amount;
        totals.set(i.order_item_id, tot);
      }
      return [...totals.values()];
    },
    async intentRefundTotals(intentId) {
      const refunds = await tables.refunds.find({ intent_id: intentId });
      const sum = (statuses: string[]) => refunds.filter((r) => statuses.includes(r.status)).reduce((s, r) => s + r.amount, 0);
      return { sent: sum(['sent']), inFlight: sum(IN_FLIGHT) };
    },

    /* ---------------------------------------------------------------- lists */
    async listIntents(f, page: PageRequest) {
      const conds: Filter[] = [];
      if (f.status) conds.push({ status: f.status });
      const days = zonedDayRange(f, f.timeZone ?? 'UTC');
      if (days.start) conds.push({ created_at: { $gte: days.start } });
      if (days.end) conds.push({ created_at: { $lt: days.end } });
      if (f.q?.trim() || f.orderIds?.length) {
        const or: Filter[] = [];
        if (f.q?.trim()) {
          const term = contains(f.q);
          or.push({ ref: term }, { provider_ref: term }, { guest_email: term }, { 'method.last4': f.q.trim() });
        }
        if (f.orderIds?.length) or.push({ order_id: { $in: f.orderIds } });
        conds.push({ $or: or });
      }
      switch (f.flag) {
        case 'orphan':
          conds.push({ orphan: true });
          break;
        case 'pending_check':
          conds.push({ status: 'pending_check' });
          break;
        case 'capture_failed':
          conds.push({ status: { $in: ['authorized', 'partially_captured'] } }, { id: { $in: await tables.captures.distinct('intent_id', { status: 'failed' }) } });
          break;
        case 'chargeback':
          conds.push({ id: { $in: await tables.disputes.distinct('intent_id') } });
          break;
        case 'partly_refunded':
          conds.push({ refunded_amount: { $gt: 0 }, $expr: { $lt: ['$refunded_amount', '$captured_amount'] } });
          break;
        case 'refunded':
          conds.push({ captured_amount: { $gt: 0 }, $expr: { $gte: ['$refunded_amount', '$captured_amount'] } });
          break;
      }
      return tables.intents.page(and(conds), page, { column: 'created_at', direction: 'desc' });
    },
    async listRefunds(f, page) {
      const conds: Filter[] = [];
      if (f.status) conds.push({ status: f.status });
      if (f.failing) conds.push({ $or: [{ status: 'failed' }, { status: 'processing', outcome_unknown: true }] });
      if (f.origin) conds.push({ origin: f.origin });
      // an orphan payment refund has no order: its checkout session stands in (Refund.orderId)
      if (f.orderId) conds.push({ $or: [{ order_id: f.orderId }, { order_id: null, checkout_session_id: f.orderId }] });
      if (f.customerId) conds.push({ intent_id: { $in: await tables.intents.distinct('id', { customer_id: f.customerId }) } });
      if (f.q?.trim()) {
        const term = contains(f.q);
        conds.push({ $or: [{ ref: term }, { origin_ref: term }, { provider_ref: term }] });
      }
      return tables.refunds.page(and(conds), page, { column: 'created_at', direction: 'desc' });
    },
    async listDisputes(f, page) {
      // evidence due first (cases without a deadline last): page on a computed sort key
      const filter = {
        ...(f.status ? { status: f.status } : {}),
        ...(f.kind ? { kind: f.kind } : {}),
        ...(f.sellerId ? { seller_id: f.sellerId } : {}),
      };
      return pageByDue(tables.disputes, filter, page);
    },
    async webhooksFor(intentId) {
      const refundIds = await tables.refunds.distinct('id', { intent_id: intentId });
      return tables.webhook_events.find({ $or: [{ intent_id: intentId }, { refund_id: { $in: refundIds } }] }, { sort: { received_at: 1 }, limit: 200 });
    },
  };
  return repo;
}

/** coalesce(evidence_due_at, '9999-01-01'): disputes without a deadline sort last */
const NO_DUE = new Date('9999-01-01T00:00:00.000Z');

/** Keyset (cursor) or offset (page) paging of disputes by (evidence due, id) ascending */
async function pageByDue<R extends object>(c: Collection<R>, f: Filter, req: PageRequest): Promise<Page<R>> {
  const match = c.filter(f);
  const head = [{ $match: match }, { $addFields: { sort_due: { $ifNull: ['$evidence_due_at', NO_DUE] } } }];
  const sort = { $sort: { sort_due: 1, _id: 1 } };
  const rowOf = (d: Record<string, unknown>) => {
    const { sort_due: _s, ...doc } = d;
    return c.fromDoc(doc);
  };
  const cursorOf = (d: Record<string, unknown>) => encodeCursor([(d.sort_due as Date).toISOString(), d._id]);
  if (req.mode === 'page') {
    const total = await c.count(f);
    const docs = await c.aggregate<Record<string, unknown>>([...head, sort, { $skip: (req.page - 1) * req.limit }, { $limit: req.limit }]);
    const totalPages = Math.max(1, Math.ceil(total / req.limit));
    const last = docs.at(-1);
    return { items: docs.map(rowOf), nextCursor: req.page < totalPages && last ? cursorOf(last) : null, page: req.page, totalPages, total };
  }
  const after: Record<string, unknown>[] = [];
  if (req.cursor) {
    const [due, id] = decodeCursor(req.cursor);
    const at = new Date(String(due));
    after.push({ $match: { $or: [{ sort_due: { $gt: at } }, { sort_due: at, _id: { $gt: id } }] } });
  }
  const docs = await c.aggregate<Record<string, unknown>>([...head, ...after, sort, { $limit: req.limit + 1 }]);
  const items = docs.slice(0, req.limit);
  return { items: items.map(rowOf), nextCursor: docs.length > req.limit ? cursorOf(items.at(-1)!) : null };
}

export { IN_FLIGHT };
