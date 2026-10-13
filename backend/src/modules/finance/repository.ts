import type { ModuleStore, Table as Collection } from '../../kernel/mongo/index.js';
import type { Filter } from '../../kernel/mongo/table.js';
import type { AccountRec, EntryRec, FinanceRepository, Table } from './ports.js';
import { containsText, encode, insertIfNew, jsonColumns, sortOf, sumOf, toFilter } from './generic.js';

type Row = Record<string, unknown>;

/** MongoDB adapter for FinanceRepository (docs/04-mongodb-migration.md): one collection per spec table. */
export function createMongoFinanceRepository(store: ModuleStore): FinanceRepository {
  // generic table access: the row types are checked at the FinanceRepository boundary
  const t = (table: Table): Collection<any> => store.table(table);
  const json = new Map<string, Set<string>>();
  const enc = (table: Table, row: unknown) => {
    let cols = json.get(table);
    if (!cols) json.set(table, (cols = jsonColumns(store.schemas[table]!)));
    return encode(cols, row as Row);
  };
  const where = (w: unknown) => toFilter(w as Row);
  const entries = store.table<EntryRec>('ledger_entries');
  /** collection name of a table, for $lookup */
  const coll = (table: Table) => t(table).model.collection.collectionName;

  const repo: FinanceRepository = {
    transaction: (fn) => store.transaction((tx) => fn(tx === store ? repo : createMongoFinanceRepository(tx))),
    // inbox: inside a transaction the claim commits with the effects
    claim: (key) => store.claim(key),

    /* ---------------------------------------------------------------- generic */
    get: (table, id, o) => t(table).get(id, o),
    getMany: (table, ids) => t(table).getMany([...new Set(ids)]),
    find: (table, w, o) => t(table).find(where(w), { sort: sortOf(o?.orderBy as never), limit: o?.limit, skip: o?.offset, forUpdate: o?.forUpdate }),
    async findOne(table, w, o) {
      return (await repo.find(table, w, { ...o, limit: 1 }))[0];
    },
    count: (table, w) => t(table).count(where(w)),
    sum: (table, column, w) => sumOf(t(table), column, where(w)),
    insert: (table, row) => t(table).insert(enc(table, row)),
    async insertIgnore(table, row) {
      return (await insertIfNew(t(table), enc(table, row))) !== undefined;
    },
    async update(table, id, patch) {
      const values = enc(table, patch);
      const row = Object.keys(values).length ? await t(table).update(id, values) : await t(table).get(id);
      if (!row) throw new Error(`finance: ${table} ${id} not found`);
      return row;
    },
    async updateWhere(table, w, patch) {
      const values = enc(table, patch);
      if (!Object.keys(values).length) return 0;
      return t(table).updateMany(where(w), values);
    },
    removeWhere: (table, w) => t(table).deleteMany(where(w)),
    page: (table, w, page, order) => t(table).page(where(w), page, order),

    /* ---------------------------------------------------------------- specific */
    async lockAccount(sellerId, currency, now) {
      const accounts = store.table<AccountRec>('seller_accounts');
      await accounts.insertIfAbsent({ seller_id: sellerId, pending: 0, available: 0, held: 0, currency, negative_since: null, payouts_blocked_reason: null, fee_override_set_id: null, updated_at: now });
      // lock-by-write: a second transaction changing this balance conflicts and runs again after this one commits
      const acct = await accounts.findOne({ seller_id: sellerId }, { forUpdate: true });
      if (!acct) throw new Error(`finance: seller account ${sellerId} not found`);
      return acct;
    },
    async ledgerPage(sellerId, f, page) {
      const conds: Filter[] = [{ seller_id: sellerId }];
      if (f.types?.length) conds.push({ type: { $in: f.types } });
      if (f.from) conds.push({ at: { $gte: f.from } });
      if (f.to) conds.push({ at: { $lt: f.to } });
      if (f.q?.trim()) {
        const term = containsText(f.q);
        conds.push({ $or: [{ description: term }, { ref_label: term }, { ref_id: term }] });
      }
      return entries.page({ $and: conds }, page, { column: 'at', direction: 'desc' });
    },
    async dailyTypeSums(from, to, timeZone, types, sellerId) {
      if (!types.length) return [];
      const rows = await entries.aggregate<{ _id: { day: string; seller_id: string; type: string }; amount: unknown }>([
        { $match: { at: { $gte: from, $lt: to }, type: { $in: types }, ...(sellerId ? { seller_id: sellerId } : {}) } },
        { $group: { _id: { day: { $dateToString: { format: '%Y-%m-%d', date: '$at', timezone: timeZone } }, seller_id: '$seller_id', type: '$type' }, amount: { $sum: '$amount' } } },
        { $sort: { '_id.day': 1, '_id.seller_id': 1 } },
      ]);
      return rows.map((r) => ({ day: r._id.day, sellerId: r._id.seller_id, type: r._id.type, amount: Number(r.amount ?? 0) }));
    },
    async typeSums(from, to, types) {
      const out = new Map<string, number>();
      if (!types.length) return out;
      const rows = await entries.aggregate<{ _id: string; amount: unknown }>([{ $match: { at: { $gte: from, $lt: to }, type: { $in: types } } }, { $group: { _id: '$type', amount: { $sum: '$amount' } } }]);
      for (const r of rows) out.set(r._id, Number(r.amount ?? 0));
      return out;
    },
    async pendingFromLedger(sellerId) {
      // entries of lots still pending (join on the lot)
      const [r] = await entries.aggregate<{ n: unknown }>([
        { $match: { seller_id: sellerId, bucket: 'pending', lot_id: { $ne: null } } },
        { $lookup: { from: coll('earnings_lots'), localField: 'lot_id', foreignField: '_id', as: 'lot' } },
        { $match: { 'lot.state': 'pending' } },
        { $group: { _id: null, n: { $sum: '$amount' } } },
      ]);
      return Number(r?.n ?? 0);
    },
    async entriesForStatement(sellerId, cutoff) {
      // entries not on a statement yet, of lots past pending (or without a lot), except payouts of a payout run
      const docs = await entries.aggregate<Row>([
        { $match: { seller_id: sellerId, statement_id: null, at: { $lte: cutoff } } },
        { $lookup: { from: coll('earnings_lots'), localField: 'lot_id', foreignField: '_id', as: 'lot' } },
        { $addFields: { lot_state: { $arrayElemAt: ['$lot.state', 0] } } },
        { $match: { $or: [{ lot_id: null }, { lot_state: { $nin: ['pending', null] } }] } },
        { $lookup: { from: coll('payouts'), localField: 'ref_id', foreignField: '_id', as: 'payout' } },
        { $addFields: { payout_run_id: { $arrayElemAt: ['$payout.run_id', 0] } } },
        { $match: { $nor: [{ type: 'payout', ref_kind: 'payout', payout_run_id: { $type: 'string' } }] } },
        { $sort: { at: 1, _id: 1 } },
        { $project: { lot: 0, lot_state: 0, payout: 0, payout_run_id: 0 } },
      ]);
      return docs.map((d) => entries.fromDoc(d));
    },
    async assignedAvailable(sellerId) {
      const [r] = await entries.aggregate<{ n: unknown }>([
        { $match: { seller_id: sellerId, bucket: { $nin: ['held', null] }, statement_id: { $ne: null } } },
        { $lookup: { from: coll('statements'), localField: 'statement_id', foreignField: '_id', as: 'statement' } },
        { $match: { 'statement.status': 'issued' } },
        { $group: { _id: null, n: { $sum: '$amount' } } },
      ]);
      return Number(r?.n ?? 0);
    },
    async sellersForRun(cutoff) {
      const fromEntries = await entries.aggregate<{ _id: string }>([
        { $match: { statement_id: null, at: { $lte: cutoff } } },
        { $lookup: { from: coll('earnings_lots'), localField: 'lot_id', foreignField: '_id', as: 'lot' } },
        { $addFields: { lot_state: { $arrayElemAt: ['$lot.state', 0] } } },
        { $match: { $or: [{ lot_id: null }, { lot_state: { $nin: ['pending', null] } }] } },
        { $group: { _id: '$seller_id' } },
      ]);
      const withAvailable = await t('seller_accounts').distinct<string>('seller_id', { available: { $gt: 0 } });
      return [...new Set([...fromEntries.map((r) => r._id), ...withAvailable])].sort();
    },
  };
  return repo;
}
