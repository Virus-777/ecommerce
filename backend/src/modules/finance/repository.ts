import type { PageRequest } from '../../kernel/lib/pagination.js';
import { orThrow } from '../../kernel/lib/or-throw.js';
import { contains, whereFilter, type Filter, type ModuleStore, type Table as Collection, type Where } from '../../kernel/mongo/index.js';
import type * as common from '../../spec/common.js';
import type { AccountRec, DailyTypeSum, Db, EntryRec, FindOptions, IdTable, Table } from './ports.js';

type Row = Record<string, unknown>;

/**
 * finance.* (MongoDB, docs/04-mongodb-migration.md): seller accounts, the ledger, earnings lots, fees, holds,
 * adjustments, payouts, statements, reconciliation and the trading facts. Most reads and writes go through the
 * generic get / find / insert / update by table name with a Where of column conditions (kernel whereFilter, SQL's
 * meaning of null); the row types are checked here, at the boundary. The ledger reads below are specific.
 */
export class FinanceRepository {
  readonly #entries;
  /** The JSON (Mixed) columns of each table, read from its generated schema on first use */
  readonly #json = new Map<string, Set<string>>();

  constructor(private readonly store: ModuleStore) {
    this.#entries = store.table<EntryRec>('ledger_entries');
  }

  /** fn in a transaction with a repository bound to it (nested calls join the outer one) */
  transaction<R>(fn: (tx: FinanceRepository) => Promise<R>): Promise<R> {
    return this.store.transaction((tx) => fn(tx === this.store ? this : new FinanceRepository(tx)));
  }

  /** Inbox (ctx.mongo.claim): true the first time this key is claimed; inside a transaction it commits with the effects */
  claim(key: string): Promise<boolean> {
    return this.store.claim(key);
  }

  /** Generic table access: callers name the table, the signatures give the row type */
  #t(table: Table): Collection<any> {
    return this.store.table(table);
  }

  /** A row or patch as stored: undefined fields left out, JSON columns through JSON (dates inside become strings, as jsonb gave them back) */
  #encode(table: Table, row: unknown): Row {
    let json = this.#json.get(table);
    if (!json) {
      json = new Set(Object.entries(this.store.schemas[table]!.paths).filter(([, p]) => p.instance === 'Mixed').map(([k]) => k));
      this.#json.set(table, json);
    }
    const out: Row = {};
    for (const [k, v] of Object.entries(row as Row)) {
      if (v === undefined) continue;
      out[k] = json.has(k) && v !== null ? JSON.parse(JSON.stringify(v)) : v;
    }
    return out;
  }

  /** A table's collection name, for $lookup */
  #collection(table: Table): string {
    return `${this.store.module}.${table}`;
  }

  /* ---------------------------------------------------------------- generic table access */

  get<T extends IdTable>(table: T, id: string, o?: { forUpdate?: boolean }): Promise<Db[T] | undefined> {
    return this.#t(table).get(id, o);
  }

  getMany<T extends IdTable>(table: T, ids: readonly string[]): Promise<Db[T][]> {
    return this.#t(table).getMany([...new Set(ids)]);
  }

  find<T extends Table>(table: T, where: Where<Db[T]>, o?: FindOptions<Db[T]>): Promise<Db[T][]> {
    const sort = o?.orderBy?.length ? Object.fromEntries(o.orderBy.map(([c, d]) => [c, d === 'desc' ? -1 : 1] as const)) : undefined;
    return this.#t(table).find(whereFilter(where), { sort, limit: o?.limit, skip: o?.offset, forUpdate: o?.forUpdate });
  }

  async findOne<T extends Table>(table: T, where: Where<Db[T]>, o?: FindOptions<Db[T]>): Promise<Db[T] | undefined> {
    return (await this.find(table, where, { ...o, limit: 1 }))[0];
  }

  count<T extends Table>(table: T, where: Where<Db[T]>): Promise<number> {
    return this.#t(table).count(whereFilter(where));
  }

  /** Rows whose `column` is in [from, to) and that match `where` (both bounds in the query, so an index on the column serves it) */
  findInRange<T extends Table>(table: T, column: keyof Db[T] & string, from: Date, to: Date, where: Where<Db[T]> = {}): Promise<Db[T][]> {
    return this.#t(table).find({ ...whereFilter(where), [column]: { $gte: from, $lt: to } });
  }

  /**
   * One batch of a seller's (or every seller's) ledger in [from, to), oldest first, after the (at, id) of the last
   * row of the previous batch: a keyset walk, so a long export never re-reads the rows it already wrote.
   */
  ledgerBatch(o: { sellerId?: string; from?: Date; to?: Date; after?: { at: Date; id: string }; limit: number }): Promise<EntryRec[]> {
    const conds: Filter[] = [];
    if (o.sellerId) conds.push({ seller_id: o.sellerId });
    if (o.from) conds.push({ at: { $gte: o.from } });
    if (o.to) conds.push({ at: { $lt: o.to } });
    if (o.after) conds.push({ $or: [{ at: { $gt: o.after.at } }, { at: o.after.at, id: { $gt: o.after.id } }] });
    return this.#entries.find(conds.length ? { $and: conds } : {}, { sort: { at: 1, id: 1 }, limit: o.limit });
  }

  /** Sum of a numeric column over the matching rows (coalesce(sum(column), 0)) */
  async sum<T extends Table>(table: T, column: keyof Db[T] & string, where: Where<Db[T]>): Promise<number> {
    const t = this.#t(table);
    const [r] = await t.aggregate<{ n: unknown }>([{ $match: t.filter(whereFilter(where)) }, { $group: { _id: null, n: { $sum: `$${column}` } } }]);
    return Number(r?.n ?? 0);
  }

  insert<T extends Table>(table: T, row: Db[T]): Promise<Db[T]> {
    return this.#t(table).insert(this.#encode(table, row));
  }

  /** Inserts unless a unique key is taken (on conflict do nothing): the stored row, or undefined. `key`: on conflict of that key only (one upsert) */
  insertIfAbsent<T extends Table>(table: T, row: Db[T], key?: readonly (keyof Db[T] & string)[]): Promise<Db[T] | undefined> {
    return this.#t(table).insertIfAbsent(this.#encode(table, row), key);
  }

  async update<T extends IdTable>(table: T, id: string, patch: Partial<Db[T]>): Promise<Db[T]> {
    const values = this.#encode(table, patch);
    const row = Object.keys(values).length ? await this.#t(table).update(id, values) : await this.#t(table).get(id);
    return orThrow(row, `finance: ${table} ${id}`);
  }

  /** Updates the matching rows (a compare-and-set when `where` names the expected state); how many matched */
  async updateWhere<T extends Table>(table: T, where: Where<Db[T]>, patch: Partial<Db[T]>): Promise<number> {
    const values = this.#encode(table, patch);
    if (!Object.keys(values).length) return 0;
    return this.#t(table).updateMany(whereFilter(where), values);
  }

  removeWhere<T extends Table>(table: T, where: Where<Db[T]>): Promise<number> {
    return this.#t(table).deleteMany(whereFilter(where));
  }

  page<T extends Table>(table: T, where: Where<Db[T]>, page: PageRequest, order: { column: keyof Db[T] & string; direction: 'asc' | 'desc'; id?: string }): Promise<common.Page<Db[T]>> {
    return this.#t(table).page(whereFilter(where), page, order);
  }

  /* ---------------------------------------------------------------- specific reads */

  /** The seller account row, locked for the transaction (created empty when missing) */
  async lockAccount(sellerId: string, currency: string, now: Date): Promise<AccountRec> {
    const accounts = this.store.table<AccountRec>('seller_accounts');
    await accounts.insertIfAbsent({ seller_id: sellerId, pending: 0, available: 0, held: 0, currency, negative_since: null, payouts_blocked_reason: null, fee_override_set_id: null, updated_at: now });
    // lock-by-write: a second transaction changing this balance conflicts and runs again after this one commits
    return orThrow(await accounts.findOne({ seller_id: sellerId }, { forUpdate: true }), `finance: seller account ${sellerId}`);
  }

  /** Ledger page for a seller with filters, newest first */
  ledgerPage(sellerId: string, f: { types?: string[]; from?: Date; to?: Date; q?: string }, page: PageRequest): Promise<common.Page<EntryRec>> {
    const conds: Filter[] = [{ seller_id: sellerId }];
    if (f.types?.length) conds.push({ type: { $in: f.types } });
    if (f.from) conds.push({ at: { $gte: f.from } });
    if (f.to) conds.push({ at: { $lt: f.to } });
    if (f.q?.trim()) {
      const term = contains(f.q);
      conds.push({ $or: [{ description: term }, { ref_label: term }, { ref_id: term }] });
    }
    return this.#entries.page({ $and: conds }, page, { column: 'at', direction: 'desc' });
  }

  /** Sum of entries per (market date, seller, type) for a range of instants */
  async dailyTypeSums(from: Date, to: Date, timeZone: string, types: string[], sellerId?: string): Promise<DailyTypeSum[]> {
    if (!types.length) return [];
    const rows = await this.#entries.aggregate<{ _id: { day: string; seller_id: string; type: string }; amount: unknown }>([
      { $match: { at: { $gte: from, $lt: to }, type: { $in: types }, ...(sellerId ? { seller_id: sellerId } : {}) } },
      { $group: { _id: { day: { $dateToString: { format: '%Y-%m-%d', date: '$at', timezone: timeZone } }, seller_id: '$seller_id', type: '$type' }, amount: { $sum: '$amount' } } },
      { $sort: { '_id.day': 1, '_id.seller_id': 1 } },
    ]);
    return rows.map((r) => ({ day: r._id.day, sellerId: r._id.seller_id, type: r._id.type, amount: Number(r.amount ?? 0) }));
  }

  /** Sum of ledger amounts by type in a range (all sellers) */
  async typeSums(from: Date, to: Date, types: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!types.length) return out;
    const rows = await this.#entries.aggregate<{ _id: string; amount: unknown }>([{ $match: { at: { $gte: from, $lt: to }, type: { $in: types } } }, { $group: { _id: '$type', amount: { $sum: '$amount' } } }]);
    for (const r of rows) out.set(r._id, Number(r.amount ?? 0));
    return out;
  }

  /** Pending part of each lot (entries of lots that are still pending), per seller */
  async pendingFromLedger(sellerId: string): Promise<number> {
    // entries of lots still pending (join on the lot)
    const [r] = await this.#entries.aggregate<{ n: unknown }>([
      { $match: { seller_id: sellerId, bucket: 'pending', lot_id: { $ne: null } } },
      { $lookup: { from: this.#collection('earnings_lots'), localField: 'lot_id', foreignField: '_id', as: 'lot' } },
      { $match: { 'lot.state': 'pending' } },
      { $group: { _id: null, n: { $sum: '$amount' } } },
    ]);
    return Number(r?.n ?? 0);
  }

  /** Unassigned entries a statement at `cutoff` takes: non-lot entries, and entries of lots no longer pending */
  async entriesForStatement(sellerId: string, cutoff: Date): Promise<EntryRec[]> {
    // entries not on a statement yet, of lots past pending (or without a lot), except payouts of a payout run
    const docs = await this.#entries.aggregate<Row>([
      { $match: { seller_id: sellerId, statement_id: null, at: { $lte: cutoff } } },
      { $lookup: { from: this.#collection('earnings_lots'), localField: 'lot_id', foreignField: '_id', as: 'lot' } },
      { $addFields: { lot_state: { $arrayElemAt: ['$lot.state', 0] } } },
      { $match: { $or: [{ lot_id: null }, { lot_state: { $nin: ['pending', null] } }] } },
      { $lookup: { from: this.#collection('payouts'), localField: 'ref_id', foreignField: '_id', as: 'payout' } },
      { $addFields: { payout_run_id: { $arrayElemAt: ['$payout.run_id', 0] } } },
      { $match: { $nor: [{ type: 'payout', ref_kind: 'payout', payout_run_id: { $type: 'string' } }] } },
      { $sort: { at: 1, _id: 1 } },
      { $project: { lot: 0, lot_state: 0, payout: 0, payout_run_id: 0 } },
    ]);
    return docs.map((d) => this.#entries.fromDoc(d));
  }

  /** Sum of available-affecting entries already on issued statements (the opening available of the next one) */
  async assignedAvailable(sellerId: string): Promise<number> {
    const [r] = await this.#entries.aggregate<{ n: unknown }>([
      { $match: { seller_id: sellerId, bucket: { $nin: ['held', null] }, statement_id: { $ne: null } } },
      { $lookup: { from: this.#collection('statements'), localField: 'statement_id', foreignField: '_id', as: 'statement' } },
      { $match: { 'statement.status': 'issued' } },
      { $group: { _id: null, n: { $sum: '$amount' } } },
    ]);
    return Number(r?.n ?? 0);
  }

  /** Totals over every seller account, summed in the database (no account rows loaded) */
  async accountTotals(): Promise<{ balance: number; owed: number; pending: number; positiveAvailable: number; positiveHeld: number; held: number; heldSellers: number; negativeSellers: number }> {
    const positive = (f: unknown) => ({ $max: [0, f] });
    const balance = { $add: ['$pending', '$available', '$held'] };
    const [r] = await this.#t('seller_accounts').aggregate<Record<string, unknown>>([
      {
        $group: {
          _id: null,
          balance: { $sum: balance },
          owed: { $sum: positive(balance) },
          pending: { $sum: '$pending' },
          positiveAvailable: { $sum: positive('$available') },
          positiveHeld: { $sum: positive('$held') },
          held: { $sum: '$held' },
          heldSellers: { $sum: { $cond: [{ $gt: ['$held', 0] }, 1, 0] } },
          negativeSellers: { $sum: { $cond: [{ $lt: ['$available', 0] }, 1, 0] } },
        },
      },
    ]);
    const n = (k: string) => Number(r?.[k] ?? 0);
    return { balance: n('balance'), owed: n('owed'), pending: n('pending'), positiveAvailable: n('positiveAvailable'), positiveHeld: n('positiveHeld'), held: n('held'), heldSellers: n('heldSellers'), negativeSellers: n('negativeSellers') };
  }

  /** Per seller: the sum of all ledger entries and of the held bucket */
  async ledgerTotalsBySeller(sellerIds: readonly string[]): Promise<Map<string, { total: number; held: number }>> {
    const out = new Map<string, { total: number; held: number }>();
    if (!sellerIds.length) return out;
    const rows = await this.#entries.aggregate<{ _id: string; total: unknown; held: unknown }>([
      { $match: { seller_id: { $in: [...new Set(sellerIds)] } } },
      { $group: { _id: '$seller_id', total: { $sum: '$amount' }, held: { $sum: { $cond: [{ $eq: ['$bucket', 'held'] }, '$amount', 0] } } } },
    ]);
    for (const r of rows) out.set(r._id, { total: Number(r.total ?? 0), held: Number(r.held ?? 0) });
    return out;
  }

  /** pendingFromLedger for several sellers in one aggregation */
  async pendingFromLedgerBySeller(sellerIds: readonly string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!sellerIds.length) return out;
    const rows = await this.#entries.aggregate<{ _id: string; n: unknown }>([
      { $match: { seller_id: { $in: [...new Set(sellerIds)] }, bucket: 'pending', lot_id: { $ne: null } } },
      { $lookup: { from: this.#collection('earnings_lots'), localField: 'lot_id', foreignField: '_id', as: 'lot' } },
      { $match: { 'lot.state': 'pending' } },
      { $group: { _id: '$seller_id', n: { $sum: '$amount' } } },
    ]);
    for (const r of rows) out.set(r._id, Number(r.n ?? 0));
    return out;
  }

  /** The latest payout (by requested_on) of each seller */
  async lastPayouts(sellerIds: readonly string[]): Promise<Map<string, { status: string }>> {
    const out = new Map<string, { status: string }>();
    if (!sellerIds.length) return out;
    const rows = await this.#t('payouts').aggregate<{ _id: string; status: string }>([
      { $match: { seller_id: { $in: [...new Set(sellerIds)] } } },
      { $sort: { seller_id: 1, requested_on: -1 } },
      { $group: { _id: '$seller_id', status: { $first: '$status' } } },
    ]);
    for (const r of rows) out.set(r._id, { status: r.status });
    return out;
  }

  /** Sellers with unassigned entries up to the cutoff, or a positive available balance */
  async sellersForRun(cutoff: Date): Promise<string[]> {
    const fromEntries = await this.#entries.aggregate<{ _id: string }>([
      { $match: { statement_id: null, at: { $lte: cutoff } } },
      { $lookup: { from: this.#collection('earnings_lots'), localField: 'lot_id', foreignField: '_id', as: 'lot' } },
      { $addFields: { lot_state: { $arrayElemAt: ['$lot.state', 0] } } },
      { $match: { $or: [{ lot_id: null }, { lot_state: { $nin: ['pending', null] } }] } },
      { $group: { _id: '$seller_id' } },
    ]);
    const withAvailable = await this.#t('seller_accounts').distinct<string>('seller_id', { available: { $gt: 0 } });
    return [...new Set([...fromEntries.map((r) => r._id), ...withAvailable])].sort();
  }
}
