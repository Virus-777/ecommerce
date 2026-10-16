import type { PageRequest } from '../../kernel/lib/pagination.js';
import { orThrow } from '../../kernel/lib/or-throw.js';
import { escapeRegExp } from '../../kernel/lib/text.js';
import type { ModuleStore } from '../../kernel/mongo/index.js';
import type * as common from '../../spec/common.js';
import type { WalletDb } from '../../spec/wallet.js';
import type {
  AccountRow,
  BalanceSnapshot,
  CorrectionRow,
  EntryRow,
  GiftCardBatchRow,
  GiftCardFilter,
  GiftCardRow,
  GrantFilter,
  GrantRow,
  HoldRow,
  LotAllocation,
  LotRow,
} from './ports.js';

type LoyaltyRow = WalletDb['loyalty_entries'];
type ForUpdate = { forUpdate?: boolean };

/** The total of a `{ $group: { _id: null, total: … } }` aggregation (0 when nothing matched) */
const sumOf = (rows: { total?: number }[]) => Number(rows[0]?.total ?? 0);

/**
 * wallet.accounts, wallet.lots, wallet.ledger, wallet.holds, wallet.goodwill_grants, wallet.credit_corrections,
 * wallet.gift_cards, wallet.gift_card_batches, wallet.loyalty_entries (MongoDB, docs/04-mongodb-migration.md).
 * Every change to a customer's credit locks the account document first (lock-by-write), then lots, so concurrent
 * uses, refunds and expiries of one customer run one after another and never lose an update.
 */
export class WalletRepository {
  readonly #t;

  constructor(private readonly store: ModuleStore) {
    this.#t = {
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
  }

  /** fn in one transaction (reuses the current one when already inside) */
  transaction<R>(fn: (tx: WalletRepository) => Promise<R>): Promise<R> {
    return this.store.transaction((tx) => fn(new WalletRepository(tx)));
  }

  /** Inbox (ctx.mongo.claim): true the first time this key is claimed; commits with the transaction it runs in */
  claim(key: string): Promise<boolean> {
    return this.store.claim(key);
  }

  /** Sums of `field` per customer id over the matching documents */
  async #sumsBy(table: 'ledger' | 'lots' | 'holds', field: string, match: Record<string, unknown>): Promise<Map<string, number>> {
    const rows = await this.#t[table].aggregate<{ _id: string; total: number }>([{ $match: match }, { $group: { _id: '$customer_id', total: { $sum: `$${field}` } } }]);
    return new Map(rows.map((r) => [r._id, Number(r.total)]));
  }

  /* ---------------------------------------------------------------- accounts: every change to a customer's credit locks the account row first */

  getAccount(customerId: string): Promise<AccountRow | undefined> {
    return this.#t.accounts.get(customerId);
  }

  /** The account row, locked for the transaction (lock-by-write), or undefined when the customer never had credit */
  lockAccount(customerId: string): Promise<AccountRow | undefined> {
    return this.#t.accounts.get(customerId, { forUpdate: true });
  }

  /** Creates the account on first credit (lazily) and locks it */
  async lockOrCreateAccount(customerId: string, currency: string, now: Date): Promise<AccountRow> {
    await this.#t.accounts.insertIfAbsent({ customer_id: customerId, currency, available: 0, held: 0, updated_at: now, version: 0 });
    return orThrow(await this.#t.accounts.get(customerId, { forUpdate: true }), `wallet: account ${customerId}`);
  }

  async updateAccount(customerId: string, patch: Pick<AccountRow, 'available' | 'held' | 'updated_at'>): Promise<AccountRow> {
    return orThrow(await this.#t.accounts.update(customerId, { $set: patch, $inc: { version: 1 } }), `wallet: account ${customerId}`);
  }

  /* ---------------------------------------------------------------- lots */

  insertLot(row: LotRow): Promise<LotRow> {
    return this.#t.lots.insert(row);
  }

  getLots(ids: readonly string[], o?: ForUpdate): Promise<LotRow[]> {
    return this.#t.lots.getMany([...new Set(ids)], { forUpdate: o?.forUpdate, sort: { id: 1 } });
  }

  async updateLot(id: string, patch: Partial<Pick<LotRow, 'remaining' | 'state'>>): Promise<LotRow> {
    return orThrow(await this.#t.lots.update(id, patch), `wallet: lot ${id}`);
  }

  /** Active lots with credit left that have not reached their expiry, earliest-expiring first (never-expiring last) */
  usableLots(customerId: string, now: Date, o?: ForUpdate): Promise<LotRow[]> {
    return this.#t.lots.find(
      { customer_id: customerId, state: 'active', remaining: { $gt: 0 }, $or: [{ expires_at: null }, { expires_at: { $gt: now } }] },
      { sort: { expires_at: 1, created_at: 1, id: 1 }, nullsLast: ['expires_at'], forUpdate: o?.forUpdate },
    );
  }

  /** Active lots at or past their expiry */
  dueLots(customerId: string, now: Date, o?: ForUpdate): Promise<LotRow[]> {
    return this.#t.lots.find({ customer_id: customerId, state: 'active', expires_at: { $lte: now } }, { sort: { expires_at: 1, id: 1 }, forUpdate: o?.forUpdate });
  }

  /** Customers with lots at or past their expiry (expiry job batches) */
  async customersWithDueLots(now: Date, limit: number): Promise<string[]> {
    const rows = await this.#t.lots.aggregate<{ _id: string }>([
      { $match: { state: 'active', expires_at: { $lte: now } } },
      { $group: { _id: '$customer_id' } },
      { $sort: { _id: 1 } },
      { $limit: limit },
    ]);
    return rows.map((r) => r._id);
  }

  /** Active lots with credit left expiring in [from, to) (reminders) */
  lotsExpiringBetween(from: Date, to: Date, limit: number): Promise<LotRow[]> {
    return this.#t.lots.find({ state: 'active', remaining: { $gt: 0 }, expires_at: { $gte: from, $lt: to } }, { sort: { expires_at: 1, id: 1 }, limit });
  }

  /* ---------------------------------------------------------------- ledger (append-only: never updated or deleted here) */

  insertEntry(row: Omit<EntryRow, 'lot_allocations'> & { lot_allocations: LotAllocation[] }): Promise<EntryRow> {
    return this.#t.ledger.insert({ ...row, lot_allocations: row.lot_allocations as unknown as EntryRow['lot_allocations'] });
  }

  getEntry(id: string): Promise<EntryRow | undefined> {
    return this.#t.ledger.get(id);
  }

  getEntries(ids: readonly string[]): Promise<EntryRow[]> {
    return this.#t.ledger.getMany([...new Set(ids)]);
  }

  entryByKey(idempotencyKey: string): Promise<EntryRow | undefined> {
    return this.#t.ledger.findOne({ idempotency_key: idempotencyKey });
  }

  entriesOfRefund(refundId: string): Promise<EntryRow[]> {
    return this.#t.ledger.find({ refund_id: refundId }, { sort: { at: 1, id: 1 } });
  }

  entryOfHold(holdId: string, kind: string): Promise<EntryRow | undefined> {
    return this.#t.ledger.findOne({ hold_id: holdId, kind });
  }

  /** Credit used on an order (captures, positive) and credit already given back for it (order_refund_returned) */
  async orderCredit(customerId: string, orderId: string): Promise<{ used: number; returned: number }> {
    const rows = await this.#t.ledger.aggregate<{ _id: string; total: number }>([
      { $match: { customer_id: customerId, order_id: orderId, kind: { $in: ['capture', 'order_refund_returned'] } } },
      { $group: { _id: '$kind', total: { $sum: '$amount' } } },
    ]);
    const of = (k: string) => Number(rows.find((r) => r._id === k)?.total ?? 0);
    return { used: -of('capture'), returned: of('order_refund_returned') };
  }

  entriesPage(customerId: string, f: { kinds?: readonly string[]; excludeKinds?: readonly string[] }, page: PageRequest): Promise<common.Page<EntryRow>> {
    const kind = { ...(f.kinds?.length ? { $in: [...f.kinds] } : {}), ...(f.excludeKinds?.length ? { $nin: [...f.excludeKinds] } : {}) };
    return this.#t.ledger.page({ customer_id: customerId, ...(Object.keys(kind).length ? { kind } : {}) }, page, { column: 'at', direction: 'desc' });
  }

  recentEntries(customerId: string, limit: number, excludeKinds?: readonly string[]): Promise<EntryRow[]> {
    return this.#t.ledger.find({ customer_id: customerId, ...(excludeKinds?.length ? { kind: { $nin: [...excludeKinds] } } : {}) }, { sort: { at: -1, id: -1 }, limit });
  }

  /* ---------------------------------------------------------------- holds */

  insertHold(row: HoldRow): Promise<HoldRow> {
    return this.#t.holds.insert(row);
  }

  getHold(id: string, o?: ForUpdate): Promise<HoldRow | undefined> {
    return this.#t.holds.get(id, { forUpdate: o?.forUpdate });
  }

  holdByKey(idempotencyKey: string): Promise<HoldRow | undefined> {
    return this.#t.holds.findOne({ idempotency_key: idempotencyKey });
  }

  liveHoldOfQuote(quoteId: string, o?: ForUpdate): Promise<HoldRow | undefined> {
    return this.#t.holds.findOne({ quote_id: quoteId, state: 'held' }, { forUpdate: o?.forUpdate });
  }

  async updateHold(id: string, patch: Partial<Pick<HoldRow, 'state' | 'order_id' | 'expires_at'>>): Promise<HoldRow> {
    return orThrow(await this.#t.holds.update(id, patch), `wallet: hold ${id}`);
  }

  staleHolds(now: Date, limit: number): Promise<HoldRow[]> {
    return this.#t.holds.find({ state: 'held', expires_at: { $lte: now } }, { sort: { expires_at: 1, id: 1 }, limit });
  }

  /* ---------------------------------------------------------------- goodwill */

  /** Inserts unless one with the same idempotency key exists (then undefined) */
  insertGrant(row: GrantRow): Promise<GrantRow | undefined> {
    return this.#t.grants.insertIfAbsent(row, ['idempotency_key']);
  }

  getGrant(id: string, o?: ForUpdate): Promise<GrantRow | undefined> {
    return this.#t.grants.get(id, { forUpdate: o?.forUpdate });
  }

  grantByKey(idempotencyKey: string): Promise<GrantRow | undefined> {
    return this.#t.grants.findOne({ idempotency_key: idempotencyKey });
  }

  grantByApproval(requestId: string): Promise<GrantRow | undefined> {
    return this.#t.grants.findOne({ approval_request_id: requestId });
  }

  grantsOfEntries(entryIds: readonly string[]): Promise<GrantRow[]> {
    return this.#t.grants.find({ ledger_entry_id: { $in: [...new Set(entryIds)] } });
  }

  async updateGrant(id: string, patch: Partial<Pick<GrantRow, 'state' | 'approval_request_id' | 'decided_by' | 'ledger_entry_id'>>): Promise<GrantRow> {
    return orThrow(await this.#t.grants.update(id, patch), `wallet: goodwill grant ${id}`);
  }

  grantsPage(f: GrantFilter, page: PageRequest): Promise<common.Page<GrantRow>> {
    const created = { ...(f.from ? { $gte: f.from } : {}), ...(f.to ? { $lt: f.to } : {}) };
    return this.#t.grants.page(
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
  }

  grantsOfCustomer(customerId: string, states: readonly string[]): Promise<GrantRow[]> {
    return this.#t.grants.find({ customer_id: customerId, state: { $in: [...states] } }, { sort: { created_at: -1, id: -1 } });
  }

  /** Goodwill granted or waiting for approval since a time (per-customer 30-day limit) */
  async goodwillSince(customerId: string, since: Date): Promise<number> {
    return sumOf(
      await this.#t.grants.aggregate<{ total: number }>([
        { $match: { customer_id: customerId, state: { $in: ['granted', 'pending_approval'] }, created_at: { $gt: since } } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
    );
  }

  /* ---------------------------------------------------------------- balance corrections */

  /** Inserts unless one with the same idempotency key exists (then undefined) */
  insertCorrection(row: CorrectionRow): Promise<CorrectionRow | undefined> {
    return this.#t.corrections.insertIfAbsent(row, ['idempotency_key']);
  }

  getCorrection(id: string, o?: ForUpdate): Promise<CorrectionRow | undefined> {
    return this.#t.corrections.get(id, { forUpdate: o?.forUpdate });
  }

  correctionByKey(idempotencyKey: string): Promise<CorrectionRow | undefined> {
    return this.#t.corrections.findOne({ idempotency_key: idempotencyKey });
  }

  correctionByApproval(requestId: string): Promise<CorrectionRow | undefined> {
    return this.#t.corrections.findOne({ approval_request_id: requestId });
  }

  async updateCorrection(
    id: string,
    patch: Partial<Pick<CorrectionRow, 'state' | 'decided_by' | 'decided_at' | 'ledger_entry_id' | 'failure' | 'approval_request_id'>>,
  ): Promise<CorrectionRow> {
    return orThrow(await this.#t.corrections.update(id, patch), `wallet: correction ${id}`);
  }

  correctionsOfCustomer(customerId: string, states: readonly string[]): Promise<CorrectionRow[]> {
    return this.#t.corrections.find({ customer_id: customerId, state: { $in: [...states] } }, { sort: { created_at: -1, id: -1 } });
  }

  /* ---------------------------------------------------------------- customer data export */

  /** Every lot of a customer, oldest first */
  allLotsOf(customerId: string): Promise<LotRow[]> {
    return this.#t.lots.find({ customer_id: customerId }, { sort: { created_at: 1, id: 1 } });
  }

  /** Every ledger entry of a customer, oldest first */
  allEntriesOf(customerId: string): Promise<EntryRow[]> {
    return this.#t.ledger.find({ customer_id: customerId }, { sort: { at: 1, id: 1 } });
  }

  /* ---------------------------------------------------------------- gift cards */

  insertGiftCards(rows: GiftCardRow[]): Promise<void> {
    return this.#t.giftCards.insertMany(rows);
  }

  getGiftCard(id: string, o?: ForUpdate): Promise<GiftCardRow | undefined> {
    return this.#t.giftCards.get(id, { forUpdate: o?.forUpdate });
  }

  giftCardByHash(codeHash: string, o?: ForUpdate): Promise<GiftCardRow | undefined> {
    return this.#t.giftCards.findOne({ code_hash: codeHash }, { forUpdate: o?.forUpdate });
  }

  giftCardsOfBatch(batchId: string): Promise<GiftCardRow[]> {
    return this.#t.giftCards.find({ batch_id: batchId }, { sort: { created_at: 1, id: 1 } });
  }

  async updateGiftCard(id: string, patch: Partial<Pick<GiftCardRow, 'state' | 'remaining' | 'redeemed_by' | 'redeemed_at'>>): Promise<GiftCardRow> {
    return orThrow(await this.#t.giftCards.update(id, patch), `wallet: gift card ${id}`);
  }

  giftCardsPage(f: GiftCardFilter, page: PageRequest): Promise<common.Page<GiftCardRow>> {
    return this.#t.giftCards.page(
      { ...(f.last4 ? { code_last4: f.last4.trim().toUpperCase() } : {}), ...(f.batchId ? { batch_id: f.batchId } : {}), ...(f.state ? { state: f.state } : {}) },
      page,
      { column: 'created_at', direction: 'desc' },
    );
  }

  /** Active cards at or past their expiry */
  dueGiftCards(now: Date, limit: number): Promise<GiftCardRow[]> {
    return this.#t.giftCards.find({ state: 'active', expires_at: { $lte: now } }, { sort: { expires_at: 1, id: 1 }, limit });
  }

  /* ---------------------------------------------------------------- gift card batches */

  /** Inserts the batch unless one with its id exists; the stored row either way */
  async insertBatch(row: GiftCardBatchRow): Promise<GiftCardBatchRow> {
    await this.#t.batches.insertIfAbsent(row);
    return orThrow(await this.#t.batches.get(row.id), `wallet: gift card batch ${row.id}`);
  }

  getBatch(id: string, o?: ForUpdate): Promise<GiftCardBatchRow | undefined> {
    return this.#t.batches.get(id, { forUpdate: o?.forUpdate });
  }

  async updateBatch(
    id: string,
    patch: Partial<Pick<GiftCardBatchRow, 'status' | 'approval_request_id' | 'codes_ciphertext' | 'codes_file_id' | 'codes_delivered_at' | 'codes_expire_at'>>,
  ): Promise<GiftCardBatchRow> {
    return orThrow(await this.#t.batches.update(id, patch), `wallet: gift card batch ${id}`);
  }

  /** Deletes undelivered encrypted codes whose download window ended; how many batches were cleared */
  clearExpiredBatchCodes(now: Date): Promise<number> {
    return this.#t.batches.updateMany({ codes_ciphertext: { $ne: null }, codes_expire_at: { $lte: now } }, { codes_ciphertext: null });
  }

  /* ---------------------------------------------------------------- loyalty (phase 4 experiment) */

  async loyaltyPoints(customerId: string): Promise<number> {
    return sumOf(await this.#t.loyalty.aggregate<{ total: number }>([{ $match: { customer_id: customerId } }, { $group: { _id: null, total: { $sum: '$points' } } }]));
  }

  /* ---------------------------------------------------------------- checks */

  /** Accounts ordered by customer id after a cursor, each with its ledger, lot and hold sums */
  async balanceSnapshots(afterCustomerId: string | null, limit: number): Promise<BalanceSnapshot[]> {
    const accounts = await this.#t.accounts.find(afterCustomerId ? { customer_id: { $gt: afterCustomerId } } : {}, { sort: { customer_id: 1 }, limit });
    const ids = accounts.map((a) => a.customer_id);
    // a job outside any transaction: the three sums are read at the same time
    const [ledger, lots, holds] = await Promise.all([
      this.#sumsBy('ledger', 'amount', { customer_id: { $in: ids } }),
      this.#sumsBy('lots', 'remaining', { customer_id: { $in: ids }, state: 'active' }),
      this.#sumsBy('holds', 'amount', { customer_id: { $in: ids }, state: 'held' }),
    ]);
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
  }

  /** Credit outstanding over all accounts now (from the account balances) */
  async liabilityNow(): Promise<{ available: number; held: number; accounts: number }> {
    const [x] = await this.#t.accounts.aggregate<{ available: number; held: number; accounts: number }>([
      { $group: { _id: null, available: { $sum: '$available' }, held: { $sum: '$held' }, accounts: { $sum: 1 } } },
    ]);
    return { available: Number(x?.available ?? 0), held: Number(x?.held ?? 0), accounts: Number(x?.accounts ?? 0) };
  }

  /** Credit outstanding at a past time, rebuilt from the ledger (total) and the hold entries (held) */
  async liabilityAt(asOf: Date): Promise<{ total: number; held: number; accounts: number }> {
    // total: the ledger up to asOf (append-only, so the sum is the balance then);
    // held: holds whose 'hold' entry is at or before asOf and that no capture or release ended by then
    const total = sumOf(await this.#t.ledger.aggregate<{ total: number }>([{ $match: { at: { $lte: asOf } } }, { $group: { _id: null, total: { $sum: '$amount' } } }]));
    const accounts = (await this.#t.ledger.distinct('customer_id', { at: { $lte: asOf } })).length;
    const open = await this.#t.ledger.aggregate<{ _id: string }>([
      { $match: { hold_id: { $ne: null }, kind: { $in: ['hold', 'capture', 'release'] }, at: { $lte: asOf } } },
      { $group: { _id: '$hold_id', held: { $max: { $cond: [{ $eq: ['$kind', 'hold'] }, 1, 0] } }, ended: { $max: { $cond: [{ $eq: ['$kind', 'hold'] }, 0, 1] } } } },
      { $match: { held: 1, ended: 0 } },
    ]);
    const held = sumOf(
      await this.#t.holds.aggregate<{ total: number }>([{ $match: { _id: { $in: open.map((o) => o._id) } } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
    );
    return { total, held, accounts };
  }
}
