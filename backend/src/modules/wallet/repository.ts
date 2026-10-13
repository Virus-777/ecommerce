import type { ModuleStore } from '../../kernel/mongo/index.js';
import type {
  AccountRow,
  BalanceSnapshot,
  CorrectionRow,
  EntryRow,
  GiftCardBatchRow,
  GiftCardRow,
  GrantRow,
  HoldRow,
  LotRow,
  WalletRepository,
} from './ports.js';
import type { WalletDb } from '../../spec/wallet.js';

type LoyaltyRow = WalletDb['loyalty_entries'];

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Sum of a field over matching documents (0 when none) */
const sumOf = (rows: { total?: number }[]) => Number(rows[0]?.total ?? 0);

/**
 * MongoDB adapter for WalletRepository (docs/04-mongodb-migration.md). Every change to a customer's credit locks
 * the account document first (lock-by-write), then lots, so concurrent uses, refunds and expiries of one customer
 * run one after another and never lose an update.
 */
export function createMongoWalletRepository(store: ModuleStore): WalletRepository {
  const t = {
    accounts: store.table<AccountRow>('accounts'),
    lots: store.table<LotRow>('lots'),
    ledger: store.table<EntryRow>('ledger'),
    holds: store.table<HoldRow>('holds'),
    grants: store.table<GrantRow>('goodwill_grants'),
    corrections: store.table<CorrectionRow>('credit_corrections'),
    giftCards: store.table<GiftCardRow>('gift_cards'),
    batches: store.table<GiftCardBatchRow>('gift_card_batches'),
    loyalty: store.table<LoyaltyRow>('loyalty_entries'),
  };

  /** Sums of `field` per customer id over the matching documents */
  async function sumsBy(table: 'ledger' | 'lots' | 'holds', field: string, match: Record<string, unknown>): Promise<Map<string, number>> {
    const rows = await t[table].aggregate<{ _id: string; total: number }>([{ $match: match }, { $group: { _id: '$customer_id', total: { $sum: `$${field}` } } }]);
    return new Map(rows.map((r) => [r._id, Number(r.total)]));
  }

  const repo: WalletRepository = {
    transaction: (fn) => store.transaction((tx) => fn(createMongoWalletRepository(tx))),
    claim: (key) => store.claim(key),

    /* ---------------------------------------------------------------- accounts */
    getAccount: (customerId) => t.accounts.get(customerId),
    lockAccount: (customerId) => t.accounts.get(customerId, { forUpdate: true }),
    async lockOrCreateAccount(customerId, currency, now) {
      await t.accounts.insertIfAbsent({ customer_id: customerId, currency, available: 0, held: 0, updated_at: now, version: 0 });
      const a = await t.accounts.get(customerId, { forUpdate: true });
      if (!a) throw new Error(`wallet: account ${customerId} not found`);
      return a;
    },
    async updateAccount(customerId, patch) {
      const a = await t.accounts.update(customerId, { $set: patch, $inc: { version: 1 } });
      if (!a) throw new Error(`wallet: account ${customerId} not found`);
      return a;
    },

    /* ---------------------------------------------------------------- lots */
    insertLot: (row) => t.lots.insert(row),
    getLots: (ids, o) => t.lots.getMany([...new Set(ids)], { forUpdate: o?.forUpdate, sort: { id: 1 } }),
    async updateLot(id, patch) {
      const r = await t.lots.update(id, patch);
      if (!r) throw new Error(`wallet: lot ${id} not found`);
      return r;
    },
    async usableLots(customerId, now, o) {
      const rows = await t.lots.find(
        { customer_id: customerId, state: 'active', remaining: { $gt: 0 }, $or: [{ expires_at: null }, { expires_at: { $gt: now } }] },
        { sort: { expires_at: 1, created_at: 1, id: 1 }, forUpdate: o?.forUpdate },
      );
      // expires_at asc nulls last (MongoDB sorts null first)
      return [...rows.filter((l) => l.expires_at !== null), ...rows.filter((l) => l.expires_at === null)];
    },
    dueLots: (customerId, now, o) => t.lots.find({ customer_id: customerId, state: 'active', expires_at: { $lte: now } }, { sort: { expires_at: 1, id: 1 }, forUpdate: o?.forUpdate }),
    async customersWithDueLots(now, limit) {
      const rows = await t.lots.aggregate<{ _id: string }>([
        { $match: { state: 'active', expires_at: { $lte: now } } },
        { $group: { _id: '$customer_id' } },
        { $sort: { _id: 1 } },
        { $limit: limit },
      ]);
      return rows.map((r) => r._id);
    },
    lotsExpiringBetween: (from, to, limit) => t.lots.find({ state: 'active', remaining: { $gt: 0 }, expires_at: { $gte: from, $lt: to } }, { sort: { expires_at: 1, id: 1 }, limit }),

    /* ---------------------------------------------------------------- ledger (append-only: never updated or deleted here) */
    insertEntry: (row) => t.ledger.insert({ ...row, lot_allocations: row.lot_allocations as unknown as EntryRow['lot_allocations'] }),
    getEntry: (id) => t.ledger.get(id),
    getEntries: (ids) => t.ledger.getMany([...new Set(ids)]),
    entryByKey: (key) => t.ledger.findOne({ idempotency_key: key }),
    entriesOfRefund: (refundId) => t.ledger.find({ refund_id: refundId }, { sort: { at: 1, id: 1 } }),
    entryOfHold: (holdId, kind) => t.ledger.findOne({ hold_id: holdId, kind }),
    async orderCredit(customerId, orderId) {
      const rows = await t.ledger.aggregate<{ _id: string; total: number }>([
        { $match: { customer_id: customerId, order_id: orderId, kind: { $in: ['capture', 'order_refund_returned'] } } },
        { $group: { _id: '$kind', total: { $sum: '$amount' } } },
      ]);
      const of = (k: string) => Number(rows.find((r) => r._id === k)?.total ?? 0);
      return { used: -of('capture'), returned: of('order_refund_returned') };
    },
    entriesPage(customerId, f, page) {
      const kind = { ...(f.kinds?.length ? { $in: [...f.kinds] } : {}), ...(f.excludeKinds?.length ? { $nin: [...f.excludeKinds] } : {}) };
      return t.ledger.page({ customer_id: customerId, ...(Object.keys(kind).length ? { kind } : {}) }, page, { column: 'at', direction: 'desc' });
    },
    recentEntries: (customerId, limit, excludeKinds) =>
      t.ledger.find({ customer_id: customerId, ...(excludeKinds?.length ? { kind: { $nin: [...excludeKinds] } } : {}) }, { sort: { at: -1, id: -1 }, limit }),

    /* ---------------------------------------------------------------- holds */
    insertHold: (row) => t.holds.insert(row),
    getHold: (id, o) => t.holds.get(id, { forUpdate: o?.forUpdate }),
    holdByKey: (key) => t.holds.findOne({ idempotency_key: key }),
    liveHoldOfQuote: (quoteId, o) => t.holds.findOne({ quote_id: quoteId, state: 'held' }, { forUpdate: o?.forUpdate }),
    holdsOfQuote: (quoteId) => t.holds.find({ quote_id: quoteId }, { sort: { expires_at: -1 } }),
    async updateHold(id, patch) {
      const r = await t.holds.update(id, patch);
      if (!r) throw new Error(`wallet: hold ${id} not found`);
      return r;
    },
    staleHolds: (now, limit) => t.holds.find({ state: 'held', expires_at: { $lte: now } }, { sort: { expires_at: 1, id: 1 }, limit }),

    /* ---------------------------------------------------------------- goodwill */
    insertGrant: (row) => t.grants.insertIfAbsent(row, ['idempotency_key']),
    getGrant: (id, o) => t.grants.get(id, { forUpdate: o?.forUpdate }),
    grantByKey: (key) => t.grants.findOne({ idempotency_key: key }),
    grantByApproval: (requestId) => t.grants.findOne({ approval_request_id: requestId }),
    grantsOfEntries: (entryIds) => t.grants.find({ ledger_entry_id: { $in: [...new Set(entryIds)] } }),
    async updateGrant(id, patch) {
      const r = await t.grants.update(id, patch);
      if (!r) throw new Error(`wallet: goodwill grant ${id} not found`);
      return r;
    },
    grantsPage(f, page) {
      const created = { ...(f.from ? { $gte: f.from } : {}), ...(f.to ? { $lt: f.to } : {}) };
      return t.grants.page(
        {
          ...(f.state ? { state: f.state } : {}),
          ...(f.customerId ? { customer_id: f.customerId } : {}),
          ...(f.from || f.to ? { created_at: created } : {}),
          // requested_by is the actor as JSON text (actorText): its top-level "id"
          ...(f.requestedBy ? { requested_by: { $regex: `"id":${escapeRegExp(JSON.stringify(f.requestedBy))}[,}]` } } : {}),
        },
        page,
        { column: 'created_at', direction: 'desc' },
      );
    },
    grantsOfCustomer: (customerId, states) => t.grants.find({ customer_id: customerId, state: { $in: [...states] } }, { sort: { created_at: -1, id: -1 } }),
    async goodwillSince(customerId, since) {
      return sumOf(
        await t.grants.aggregate<{ total: number }>([
          { $match: { customer_id: customerId, state: { $in: ['granted', 'pending_approval'] }, created_at: { $gt: since } } },
          { $group: { _id: null, total: { $sum: '$amount' } } },
        ]),
      );
    },

    /* ---------------------------------------------------------------- corrections */
    insertCorrection: (row) => t.corrections.insertIfAbsent(row, ['idempotency_key']),
    getCorrection: (id, o) => t.corrections.get(id, { forUpdate: o?.forUpdate }),
    correctionByKey: (key) => t.corrections.findOne({ idempotency_key: key }),
    correctionByApproval: (requestId) => t.corrections.findOne({ approval_request_id: requestId }),
    async updateCorrection(id, patch) {
      const r = await t.corrections.update(id, patch);
      if (!r) throw new Error(`wallet: correction ${id} not found`);
      return r;
    },
    correctionsOfCustomer: (customerId, states) => t.corrections.find({ customer_id: customerId, state: { $in: [...states] } }, { sort: { created_at: -1, id: -1 } }),

    /* ---------------------------------------------------------------- customer data export */
    allLotsOf: (customerId) => t.lots.find({ customer_id: customerId }, { sort: { created_at: 1, id: 1 } }),
    allEntriesOf: (customerId) => t.ledger.find({ customer_id: customerId }, { sort: { at: 1, id: 1 } }),

    /* ---------------------------------------------------------------- gift cards */
    insertGiftCards: (rows) => t.giftCards.insertMany(rows),
    getGiftCard: (id, o) => t.giftCards.get(id, { forUpdate: o?.forUpdate }),
    giftCardByHash: (codeHash, o) => t.giftCards.findOne({ code_hash: codeHash }, { forUpdate: o?.forUpdate }),
    giftCardsOfBatch: (batchId) => t.giftCards.find({ batch_id: batchId }, { sort: { created_at: 1, id: 1 } }),
    async updateGiftCard(id, patch) {
      const r = await t.giftCards.update(id, patch);
      if (!r) throw new Error(`wallet: gift card ${id} not found`);
      return r;
    },
    giftCardsPage: (f, page) =>
      t.giftCards.page(
        { ...(f.last4 ? { code_last4: f.last4.trim().toUpperCase() } : {}), ...(f.batchId ? { batch_id: f.batchId } : {}), ...(f.state ? { state: f.state } : {}) },
        page,
        { column: 'created_at', direction: 'desc' },
      ),
    dueGiftCards: (now, limit) => t.giftCards.find({ state: 'active', expires_at: { $lte: now } }, { sort: { expires_at: 1, id: 1 }, limit }),

    /* ---------------------------------------------------------------- gift card batches */
    async insertBatch(row) {
      await t.batches.insertIfAbsent(row);
      const b = await t.batches.get(row.id);
      if (!b) throw new Error(`wallet: gift card batch ${row.id} not found`);
      return b;
    },
    getBatch: (id, o) => t.batches.get(id, { forUpdate: o?.forUpdate }),
    async updateBatch(id, patch) {
      const r = await t.batches.update(id, patch);
      if (!r) throw new Error(`wallet: gift card batch ${id} not found`);
      return r;
    },
    clearExpiredBatchCodes: (now) => t.batches.updateMany({ codes_ciphertext: { $ne: null }, codes_expire_at: { $lte: now } }, { codes_ciphertext: null }),

    /* ---------------------------------------------------------------- loyalty */
    async loyaltyPoints(customerId) {
      return sumOf(await t.loyalty.aggregate<{ total: number }>([{ $match: { customer_id: customerId } }, { $group: { _id: null, total: { $sum: '$points' } } }]));
    },

    /* ---------------------------------------------------------------- checks */
    async balanceSnapshots(after, limit) {
      const accounts = await t.accounts.find(after ? { customer_id: { $gt: after } } : {}, { sort: { customer_id: 1 }, limit });
      const ids = accounts.map((a) => a.customer_id);
      const ledger = await sumsBy('ledger', 'amount', { customer_id: { $in: ids } });
      const lots = await sumsBy('lots', 'remaining', { customer_id: { $in: ids }, state: 'active' });
      const holds = await sumsBy('holds', 'amount', { customer_id: { $in: ids }, state: 'held' });
      return accounts.map(
        (a): BalanceSnapshot => ({
          customerId: a.customer_id,
          available: Number(a.available),
          held: Number(a.held),
          ledgerSum: ledger.get(a.customer_id) ?? 0,
          lotsSum: lots.get(a.customer_id) ?? 0,
          holdsSum: holds.get(a.customer_id) ?? 0,
        }),
      );
    },
    async liabilityNow() {
      const [x] = await t.accounts.aggregate<{ available: number; held: number; accounts: number }>([
        { $group: { _id: null, available: { $sum: '$available' }, held: { $sum: '$held' }, accounts: { $sum: 1 } } },
      ]);
      return { available: Number(x?.available ?? 0), held: Number(x?.held ?? 0), accounts: Number(x?.accounts ?? 0) };
    },
    async liabilityAt(asOf) {
      // total: the ledger up to asOf (append-only, so the sum is the balance then);
      // held: holds whose 'hold' entry is at or before asOf and that no capture or release ended by then
      const total = sumOf(await t.ledger.aggregate<{ total: number }>([{ $match: { at: { $lte: asOf } } }, { $group: { _id: null, total: { $sum: '$amount' } } }]));
      const accounts = (await t.ledger.distinct('customer_id', { at: { $lte: asOf } })).length;
      const open = await t.ledger.aggregate<{ _id: string }>([
        { $match: { hold_id: { $ne: null }, kind: { $in: ['hold', 'capture', 'release'] }, at: { $lte: asOf } } },
        { $group: { _id: '$hold_id', held: { $max: { $cond: [{ $eq: ['$kind', 'hold'] }, 1, 0] } }, ended: { $max: { $cond: [{ $eq: ['$kind', 'hold'] }, 0, 1] } } } },
        { $match: { held: 1, ended: 0 } },
      ]);
      const held = sumOf(
        await t.holds.aggregate<{ total: number }>([{ $match: { _id: { $in: open.map((o) => o._id) } } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
      );
      return { total, held, accounts };
    },
  };
  return repo;
}
