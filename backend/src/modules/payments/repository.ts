import { zonedDayRange } from '../../kernel/lib/clock.js';
import type { PageRequest } from '../../kernel/lib/pagination.js';
import { orThrow } from '../../kernel/lib/or-throw.js';
import { contains, whereFilter, type Filter, type ModuleStore, type Table as Collection, type Where } from '../../kernel/mongo/index.js';
import type * as common from '../../spec/common.js';
import type { DisputeListFilter, FindOptions, IntentRec, PaymentListFilter, Recs, RefundListFilter, RefundTotals, Table, WebhookRec } from './ports.js';

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

/** A row or patch as stored: JSON columns go through JSON (as a jsonb column did), undefined fields are left out */
function encode(table: Table, row: Record<string, unknown>): Record<string, unknown> {
  const cols = JSON_COLUMNS[table];
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v === undefined) continue;
    out[k] = cols.includes(k) && v !== null ? JSON.parse(JSON.stringify(v)) : v;
  }
  return out;
}

const and = (conds: Filter[]): Filter => (conds.length ? { $and: conds } : {});

/** Refund statuses that hold part of the refundable amount (cancel releases it) */
const IN_FLIGHT = ['requested', 'processing', 'failed'];

/** coalesce(evidence_due_at, '9999-01-01'): disputes without a deadline sort last */
const NO_DUE = new Date('9999-01-01T00:00:00.000Z');

/**
 * payments.intents, payments.allocations, payments.captures, payments.provider_calls, payments.refunds,
 * payments.refund_items, payments.refund_log, payments.disputes, payments.dispute_log, payments.saved_methods,
 * payments.webhook_events, payments.ref_sequences (MongoDB, docs/04-mongodb-migration.md). Most reads and writes go
 * through the generic get / find / insert / update by table name; the row types are checked here, at the boundary.
 */
export class PaymentsRepository {
  readonly #tables: { [T in Table]: Collection<Recs[T]> };
  readonly #sequences;

  constructor(private readonly store: ModuleStore) {
    this.#tables = Object.fromEntries(TABLES.map((t) => [t, store.table(t)])) as { [T in Table]: Collection<Recs[T]> };
    this.#sequences = store.table<{ kind: string; day: string; last_value: number }>('ref_sequences');
  }

  /** fn in a transaction with a repository bound to it (nested calls join the outer one) */
  transaction<T>(fn: (tx: PaymentsRepository) => Promise<T>): Promise<T> {
    return this.store.transaction((tx) => fn(tx === this.store ? this : new PaymentsRepository(tx)));
  }

  /** Generic table access: callers name the table, the signatures give the row type */
  #t(table: Table): Collection<any> {
    return this.#tables[table];
  }

  /* ---------------------------------------------------------------- generic */

  get<T extends Table>(table: T, id: string, o?: { forUpdate?: boolean }): Promise<Recs[T] | undefined> {
    return this.#t(table).get(id, o);
  }

  find<T extends Table>(table: T, where: Where<Recs[T]>, o?: FindOptions<Recs[T]>): Promise<Recs[T][]> {
    const sort = o?.orderBy?.length ? Object.fromEntries(o.orderBy.map(([c, d]) => [c, d === 'desc' ? -1 : 1] as const)) : undefined;
    return this.#t(table).find(whereFilter(where), { sort, limit: o?.limit, forUpdate: o?.forUpdate });
  }

  insert<T extends Table>(table: T, row: Recs[T]): Promise<Recs[T]> {
    return this.#t(table).insert(encode(table, row as Record<string, unknown>));
  }

  async insertMany<T extends Table>(table: T, rows: Recs[T][]): Promise<void> {
    await this.#t(table).insertMany(rows.map((r) => encode(table, r as Record<string, unknown>)));
  }

  /**
   * Inserts unless a unique key is taken (refund per origin, capture per key, one live intent per checkout
   * session): undefined then. Safe inside a transaction; outside one a lost race also answers undefined.
   */
  insertIfAbsent<T extends 'refunds' | 'captures' | 'intents'>(table: T, row: Recs[T]): Promise<Recs[T] | undefined> {
    return this.#t(table).insertIfAbsent(encode(table, row as Record<string, unknown>));
  }

  async update<T extends Table>(table: T, id: string, patch: Partial<Recs[T]>): Promise<Recs[T]> {
    const values = encode(table, patch as Record<string, unknown>);
    const row = Object.keys(values).length ? await this.#t(table).update(id, values) : await this.#t(table).get(id);
    return orThrow(row, `payments: ${table} ${id}`);
  }

  /** Conditional update: only rows matching `where` change (money-safe compare-and-set); returns the changed rows */
  async updateWhere<T extends Table>(table: T, where: Where<Recs[T]>, patch: Partial<Recs[T]>): Promise<Recs[T][]> {
    const values = encode(table, patch as Record<string, unknown>);
    const filter = whereFilter(where);
    if (!Object.keys(values).length) return this.#t(table).find(filter);
    // the rows that matched, changed together: in a transaction a concurrent writer conflicts and is retried.
    // By document _id, since allocations and refund_items have no id column.
    return this.store.transaction(async (tx) => {
      const c = tx.table<Recs[T]>(table);
      const ids = (await c.aggregate<{ _id: unknown }>([{ $match: c.filter(filter) }, { $project: { _id: 1 } }])).map((d) => d._id);
      if (!ids.length) return [];
      await c.updateMany({ _id: { $in: ids } }, values);
      return c.find({ _id: { $in: ids } });
    });
  }

  async deleteWhere<T extends Table>(table: T, where: Where<Recs[T]>): Promise<void> {
    await this.#t(table).deleteMany(whereFilter(where));
  }

  /* ---------------------------------------------------------------- specific */

  /**
   * Live authorizations (authorized, partially_captured) last changed at or before `upTo`, in keyset order
   * (updated_at, id) after the given position: the expiry sweep walks them page by page until none are left.
   */
  liveAuthorizations(after: { updatedAt: Date; id: string } | null, upTo: Date, limit: number): Promise<IntentRec[]> {
    const keyset = after ? [{ $or: [{ updated_at: { $gt: after.updatedAt } }, { updated_at: after.updatedAt, id: { $gt: after.id } }] }] : [];
    return this.#tables.intents.find(and([{ status: { $in: ['authorized', 'partially_captured'] }, updated_at: { $lte: upTo } }, ...keyset]), { sort: { updated_at: 1, id: 1 }, limit });
  }

  /** Next value of a daily counter (RF-, CB-, DP- references); inside a transaction it counts with it */
  async nextSequence(kind: string, day: string): Promise<number> {
    return (await this.#sequences.increment({ kind, day }, { last_value: 1 })).last_value;
  }

  /** Stores a provider event unless (provider, external_id) is known; null for a replay */
  async insertWebhookIfNew(row: WebhookRec): Promise<WebhookRec | null> {
    const r = await this.#tables.webhook_events.insertIfAbsent(encode('webhook_events', row as unknown as Record<string, unknown>), ['provider', 'external_id']);
    return r ?? null;
  }

  /** Sent and in-flight refund money per order item of an order */
  async refundTotals(orderId: string): Promise<RefundTotals[]> {
    const refunds = await this.#tables.refunds.find({ order_id: orderId });
    const status = new Map(refunds.map((r) => [r.id, r.status]));
    const items = refunds.length ? await this.#tables.refund_items.find({ refund_id: { $in: [...status.keys()] } }) : [];
    const totals = new Map<string, RefundTotals>();
    for (const i of items) {
      const s = status.get(i.refund_id)!;
      const tot = totals.get(i.order_item_id) ?? { orderItemId: i.order_item_id, sent: 0, inFlight: 0 };
      if (s === 'sent') tot.sent += i.amount;
      else if (IN_FLIGHT.includes(s)) tot.inFlight += i.amount;
      totals.set(i.order_item_id, tot);
    }
    return [...totals.values()];
  }

  /** Sent and in-flight refund money of a payment intent (all its refunds) */
  async intentRefundTotals(intentId: string): Promise<{ sent: number; inFlight: number }> {
    const refunds = await this.#tables.refunds.find({ intent_id: intentId });
    const sum = (statuses: string[]) => refunds.filter((r) => statuses.includes(r.status)).reduce((s, r) => s + r.amount, 0);
    return { sent: sum(['sent']), inFlight: sum(IN_FLIGHT) };
  }

  /* ---------------------------------------------------------------- lists */

  async listIntents(f: PaymentListFilter, page: PageRequest): Promise<common.Page<Recs['intents']>> {
    // checkout payments: purchase intents (software, food) are shown by their own modules
    const conds: Filter[] = [{ checkout_session_id: { $ne: null } }];
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
        conds.push({ status: { $in: ['authorized', 'partially_captured'] } }, { id: { $in: await this.#tables.captures.distinct('intent_id', { status: 'failed' }) } });
        break;
      case 'chargeback':
        conds.push({ id: { $in: await this.#tables.disputes.distinct('intent_id') } });
        break;
      case 'partly_refunded':
        conds.push({ refunded_amount: { $gt: 0 }, $expr: { $lt: ['$refunded_amount', '$captured_amount'] } });
        break;
      case 'refunded':
        conds.push({ captured_amount: { $gt: 0 }, $expr: { $gte: ['$refunded_amount', '$captured_amount'] } });
        break;
    }
    return this.#tables.intents.page(and(conds), page, { column: 'created_at', direction: 'desc' });
  }

  async listRefunds(f: RefundListFilter, page: PageRequest): Promise<common.Page<Recs['refunds']>> {
    const conds: Filter[] = [];
    if (f.status) conds.push({ status: f.status });
    if (f.failing) conds.push({ $or: [{ status: 'failed' }, { status: 'processing', outcome_unknown: true }] });
    if (f.origin) conds.push({ origin: f.origin });
    // an orphan payment refund has no order: its checkout session stands in (Refund.orderId)
    if (f.orderId) conds.push({ $or: [{ order_id: f.orderId }, { order_id: null, checkout_session_id: f.orderId }] });
    if (f.customerId) conds.push({ intent_id: { $in: await this.#tables.intents.distinct('id', { customer_id: f.customerId }) } });
    if (f.q?.trim()) {
      const term = contains(f.q);
      conds.push({ $or: [{ ref: term }, { origin_ref: term }, { provider_ref: term }] });
    }
    return this.#tables.refunds.page(and(conds), page, { column: 'created_at', direction: 'desc' });
  }

  /** Evidence due first, cases without a deadline last (paged on the computed due date, then id) */
  listDisputes(f: DisputeListFilter, page: PageRequest): Promise<common.Page<Recs['disputes']>> {
    const c = this.#tables.disputes;
    const filter = {
      ...(f.status ? { status: f.status } : {}),
      ...(f.kind ? { kind: f.kind } : {}),
      ...(f.sellerId ? { seller_id: f.sellerId } : {}),
    };
    return c.pageAggregate([{ $match: c.filter(filter) }, { $addFields: { sort_due: { $ifNull: ['$evidence_due_at', NO_DUE] } } }], page, { key: 'sort_due', direction: 'asc' });
  }

  /** Provider events applied to the payment or to one of its refunds, oldest first */
  async webhooksFor(intentId: string): Promise<WebhookRec[]> {
    return (await this.webhooksForMany([intentId])).get(intentId) ?? [];
  }

  /**
   * webhooksFor for several payments at once: two reads for the whole set instead of two per payment
   * (docs/10 Appendix D). Events are grouped by the intent they belong to, directly or through its refund.
   */
  async webhooksForMany(intentIds: readonly string[]): Promise<Map<string, WebhookRec[]>> {
    const out = new Map<string, WebhookRec[]>();
    const ids = [...new Set(intentIds)];
    if (!ids.length) return out;
    const refunds = await this.#tables.refunds.find({ intent_id: { $in: ids } });
    const intentOfRefund = new Map(refunds.map((r) => [r.id as string, r.intent_id as string]));
    const events = await this.#tables.webhook_events.find(
      { $or: [{ intent_id: { $in: ids } }, ...(intentOfRefund.size ? [{ refund_id: { $in: [...intentOfRefund.keys()] } }] : [])] },
      { sort: { received_at: 1 }, limit: 200 * ids.length },
    );
    for (const id of ids) out.set(id, []);
    for (const e of events) {
      const intentId = e.intent_id ?? (e.refund_id ? intentOfRefund.get(e.refund_id) : undefined);
      if (intentId) out.get(intentId)?.push(e);
    }
    return out;
  }
}
