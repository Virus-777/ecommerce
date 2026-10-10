/**
 * What the wallet service needs from the outside world, database-agnostic.
 * The Postgres adapter lives in infra/postgres/; a MongoDB switch would add infra/mongo/.
 */
import type { PageRequest } from '../../kernel/lib/pagination.js';
import type * as common from '../../spec/common.js';
import type { WalletDb } from '../../spec/wallet.js';

export type AccountRow = WalletDb['accounts'];
export type LotRow = WalletDb['lots'];
export type EntryRow = WalletDb['ledger'];
export type HoldRow = WalletDb['holds'];
export type GrantRow = WalletDb['goodwill_grants'];
export type GiftCardRow = WalletDb['gift_cards'];
export type GiftCardBatchRow = WalletDb['gift_card_batches'];

/** Which lots an entry took credit from (or gave it to), stored on the ledger entry */
export interface LotAllocation {
  lotId: string;
  amount: number;
}

/** One account's balance next to what its ledger, lots and holds add up to (wallet.balance-check) */
export interface BalanceSnapshot {
  customerId: string;
  available: number;
  held: number;
  ledgerSum: number;
  lotsSum: number;
  holdsSum: number;
}

export interface GrantFilter {
  state?: string;
  from?: Date;
  to?: Date;
  requestedBy?: string;
  customerId?: string;
}

export interface GiftCardFilter {
  last4?: string;
  batchId?: string;
  state?: string;
}

/** Persistence for this module's own tables: wallet.accounts, wallet.lots, wallet.ledger, wallet.holds, wallet.goodwill_grants, wallet.gift_cards, wallet.loyalty_entries. */
export interface WalletRepository {
  /** Runs fn in one transaction (reuses the current one when already inside) */
  transaction<R>(fn: (tx: WalletRepository) => Promise<R>): Promise<R>;
  /** Inbox (ctx.inbox): true the first time this key is claimed; commits with the transaction it runs in */
  claim(key: string): Promise<boolean>;

  /* accounts: every change to a customer's credit locks the account row first */
  getAccount(customerId: string): Promise<AccountRow | undefined>;
  /** The account row locked FOR UPDATE, or undefined when the customer never had credit */
  lockAccount(customerId: string): Promise<AccountRow | undefined>;
  /** Creates the account on first credit (lazily) and locks it */
  lockOrCreateAccount(customerId: string, currency: string, now: Date): Promise<AccountRow>;
  updateAccount(customerId: string, patch: Pick<AccountRow, 'available' | 'held' | 'updated_at'>): Promise<AccountRow>;

  /* lots */
  insertLot(row: LotRow): Promise<LotRow>;
  getLots(ids: readonly string[], o?: { forUpdate?: boolean }): Promise<LotRow[]>;
  updateLot(id: string, patch: Partial<Pick<LotRow, 'remaining' | 'state'>>): Promise<LotRow>;
  /** Active lots with credit left that have not reached their expiry, earliest-expiring first (never-expiring last) */
  usableLots(customerId: string, now: Date, o?: { forUpdate?: boolean }): Promise<LotRow[]>;
  /** Active lots at or past their expiry */
  dueLots(customerId: string, now: Date, o?: { forUpdate?: boolean }): Promise<LotRow[]>;
  /** Customers with lots at or past their expiry (expiry job batches) */
  customersWithDueLots(now: Date, limit: number): Promise<string[]>;
  /** Active lots with credit left expiring in [from, to) (reminders) */
  lotsExpiringBetween(from: Date, to: Date, limit: number): Promise<LotRow[]>;

  /* ledger (append-only) */
  insertEntry(row: Omit<EntryRow, 'lot_allocations'> & { lot_allocations: LotAllocation[] }): Promise<EntryRow>;
  getEntry(id: string): Promise<EntryRow | undefined>;
  getEntries(ids: readonly string[]): Promise<EntryRow[]>;
  entryByKey(idempotencyKey: string): Promise<EntryRow | undefined>;
  entriesOfRefund(refundId: string): Promise<EntryRow[]>;
  entryOfHold(holdId: string, kind: string): Promise<EntryRow | undefined>;
  /** Credit used on an order (captures, positive) and credit already given back for it (order_refund_returned) */
  orderCredit(customerId: string, orderId: string): Promise<{ used: number; returned: number }>;
  entriesPage(customerId: string, f: { kinds?: readonly string[]; excludeKinds?: readonly string[] }, page: PageRequest): Promise<common.Page<EntryRow>>;
  recentEntries(customerId: string, limit: number, excludeKinds?: readonly string[]): Promise<EntryRow[]>;

  /* holds */
  insertHold(row: HoldRow): Promise<HoldRow>;
  getHold(id: string, o?: { forUpdate?: boolean }): Promise<HoldRow | undefined>;
  holdByKey(idempotencyKey: string): Promise<HoldRow | undefined>;
  liveHoldOfQuote(quoteId: string, o?: { forUpdate?: boolean }): Promise<HoldRow | undefined>;
  holdsOfQuote(quoteId: string): Promise<HoldRow[]>;
  updateHold(id: string, patch: Partial<Pick<HoldRow, 'state' | 'order_id' | 'expires_at'>>): Promise<HoldRow>;
  staleHolds(now: Date, limit: number): Promise<HoldRow[]>;

  /* goodwill */
  insertGrant(row: GrantRow): Promise<GrantRow | undefined>;
  getGrant(id: string, o?: { forUpdate?: boolean }): Promise<GrantRow | undefined>;
  grantByKey(idempotencyKey: string): Promise<GrantRow | undefined>;
  grantByApproval(requestId: string): Promise<GrantRow | undefined>;
  grantsOfEntries(entryIds: readonly string[]): Promise<GrantRow[]>;
  updateGrant(id: string, patch: Partial<Pick<GrantRow, 'state' | 'approval_request_id' | 'decided_by' | 'ledger_entry_id'>>): Promise<GrantRow>;
  grantsPage(f: GrantFilter, page: PageRequest): Promise<common.Page<GrantRow>>;
  grantsOfCustomer(customerId: string, states: readonly string[]): Promise<GrantRow[]>;
  /** Goodwill granted or waiting for approval since a time (per-customer 30-day limit) */
  goodwillSince(customerId: string, since: Date): Promise<number>;

  /* gift cards */
  insertGiftCards(rows: GiftCardRow[]): Promise<void>;
  getGiftCard(id: string, o?: { forUpdate?: boolean }): Promise<GiftCardRow | undefined>;
  giftCardByHash(codeHash: string, o?: { forUpdate?: boolean }): Promise<GiftCardRow | undefined>;
  giftCardsOfBatch(batchId: string): Promise<GiftCardRow[]>;
  updateGiftCard(id: string, patch: Partial<Pick<GiftCardRow, 'state' | 'remaining' | 'redeemed_by' | 'redeemed_at'>>): Promise<GiftCardRow>;
  giftCardsPage(f: GiftCardFilter, page: PageRequest): Promise<common.Page<GiftCardRow>>;
  /** Active cards at or past their expiry */
  dueGiftCards(now: Date, limit: number): Promise<GiftCardRow[]>;

  /* gift card batches */
  /** Inserts the batch unless one with its id exists; the stored row either way */
  insertBatch(row: GiftCardBatchRow): Promise<GiftCardBatchRow>;
  getBatch(id: string, o?: { forUpdate?: boolean }): Promise<GiftCardBatchRow | undefined>;
  updateBatch(id: string, patch: Partial<Pick<GiftCardBatchRow, 'status' | 'approval_request_id' | 'codes_ciphertext' | 'codes_file_id' | 'codes_delivered_at' | 'codes_expire_at'>>): Promise<GiftCardBatchRow>;
  /** Deletes undelivered encrypted codes whose download window ended; how many batches were cleared */
  clearExpiredBatchCodes(now: Date): Promise<number>;

  /* loyalty (phase 4 experiment) */
  loyaltyPoints(customerId: string): Promise<number>;

  /* checks */
  /** Accounts ordered by customer id after a cursor, each with its ledger, lot and hold sums */
  balanceSnapshots(afterCustomerId: string | null, limit: number): Promise<BalanceSnapshot[]>;
  /** Credit outstanding over all accounts now (from the account balances) */
  liabilityNow(): Promise<{ available: number; held: number; accounts: number }>;
  /** Credit outstanding at a past time, rebuilt from the ledger (total) and the hold entries (held) */
  liabilityAt(asOf: Date): Promise<{ total: number; held: number; accounts: number }>;
}
