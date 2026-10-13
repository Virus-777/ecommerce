/**
 * What the finance service needs from the outside world, database-agnostic.
 * The MongoDB adapter is repository.ts.
 * The payout provider (bank transfers, micro-deposits, settlement reports) is a port with a
 * deterministic development adapter in providers/payouts.ts.
 */
import type { PageRequest } from '../../kernel/lib/pagination.js';
import type * as common from '../../spec/common.js';
import type { FinanceDb } from '../../spec/finance.js';

export type Db = FinanceDb;
export type Table = keyof Db & string;
/** Tables keyed by `id` */
export type IdTable =
  | 'ledger_entries'
  | 'earnings_lots'
  | 'fee_rule_sets'
  | 'fee_charges'
  | 'holds'
  | 'adjustments'
  | 'amounts_owed'
  | 'payout_destinations'
  | 'destination_reviews'
  | 'payout_runs'
  | 'payouts'
  | 'statements'
  | 'trading_entries'
  | 'trading_targets'
  | 'recon_items'
  | 'seller_credits'
  | 'captures'
  | 'discount_funding'
  | 'platform_costs'
  | 'store_credit_liability';

export type AccountRec = Db['seller_accounts'];
export type EntryRec = Db['ledger_entries'];
export type LotRec = Db['earnings_lots'];
export type RuleSetRec = Db['fee_rule_sets'];
export type CategoryRateRec = Db['fee_category_rates'];
export type FeeChargeRec = Db['fee_charges'];
export type AllocationRec = Db['refund_allocations'];
export type HoldRec = Db['holds'];
export type AdjustmentRec = Db['adjustments'];
export type OwedRec = Db['amounts_owed'];
export type DestinationRec = Db['payout_destinations'];
export type ReviewRec = Db['destination_reviews'];
export type RunRec = Db['payout_runs'];
export type PayoutRec = Db['payouts'];
export type StatementRec = Db['statements'];
export type TradingRec = Db['trading_entries'];
export type TargetRec = Db['trading_targets'];
export type ReconDayRec = Db['recon_days'];
export type ReconItemRec = Db['recon_items'];
export type SellerCreditRec = Db['seller_credits'];
export type CaptureRec = Db['captures'];
export type FundingRec = Db['discount_funding'];
export type PlatformCostRec = Db['platform_costs'];
export type LiabilityRec = Db['store_credit_liability'];

/** A column condition: a value (=), a list (in), null (is null) or an operator */
export type Cond<V> = V | readonly V[] | { op: '<' | '<=' | '>' | '>=' | '<>' | 'is not' | 'like' | 'not in'; value: V | readonly V[] | null };
export type Where<R> = { [K in keyof R]?: Cond<R[K]> };

export interface FindOptions<R> {
  orderBy?: [keyof R & string, 'asc' | 'desc'][];
  limit?: number;
  offset?: number;
  forUpdate?: boolean;
}

/** Sum of ledger amounts per (market date, seller, type) */
export interface DailyTypeSum {
  day: string;
  sellerId: string;
  type: string;
  amount: number;
}

export interface FinanceRepository {
  transaction<R>(fn: (tx: FinanceRepository) => Promise<R>): Promise<R>;
  /** Inbox (ctx.mongo.claim): true the first time this key is claimed; inside a transaction it commits with the effects */
  claim(key: string): Promise<boolean>;

  /* generic table access */
  get<T extends IdTable>(table: T, id: string, o?: { forUpdate?: boolean }): Promise<Db[T] | undefined>;
  getMany<T extends IdTable>(table: T, ids: readonly string[]): Promise<Db[T][]>;
  find<T extends Table>(table: T, where: Where<Db[T]>, o?: FindOptions<Db[T]>): Promise<Db[T][]>;
  findOne<T extends Table>(table: T, where: Where<Db[T]>, o?: FindOptions<Db[T]>): Promise<Db[T] | undefined>;
  count<T extends Table>(table: T, where: Where<Db[T]>): Promise<number>;
  /** Sum of a numeric column over the matching rows */
  sum<T extends Table>(table: T, column: keyof Db[T] & string, where: Where<Db[T]>): Promise<number>;
  insert<T extends Table>(table: T, row: Db[T]): Promise<Db[T]>;
  /** Insert unless a unique key exists; true when inserted */
  insertIgnore<T extends Table>(table: T, row: Db[T]): Promise<boolean>;
  update<T extends IdTable>(table: T, id: string, patch: Partial<Db[T]>): Promise<Db[T]>;
  updateWhere<T extends Table>(table: T, where: Where<Db[T]>, patch: Partial<Db[T]>): Promise<number>;
  removeWhere<T extends Table>(table: T, where: Where<Db[T]>): Promise<number>;
  page<T extends Table>(table: T, where: Where<Db[T]>, page: PageRequest, order: { column: keyof Db[T] & string; direction: 'asc' | 'desc'; id?: string }): Promise<common.Page<Db[T]>>;

  /* specific reads */
  /** The seller account row, locked for the transaction (created empty when missing) */
  lockAccount(sellerId: string, currency: string, now: Date): Promise<AccountRec>;
  /** Ledger page for a seller with filters, newest first */
  ledgerPage(sellerId: string, f: { types?: string[]; from?: Date; to?: Date; q?: string }, page: PageRequest): Promise<common.Page<EntryRec>>;
  /** Sum of entries per (market date, seller, type) for a range of instants */
  dailyTypeSums(from: Date, to: Date, timeZone: string, types: string[], sellerId?: string): Promise<DailyTypeSum[]>;
  /** Sum of ledger amounts by type in a range (all sellers) */
  typeSums(from: Date, to: Date, types: string[]): Promise<Map<string, number>>;
  /** Pending part of each lot (entries of lots that are still pending), per seller */
  pendingFromLedger(sellerId: string): Promise<number>;
  /** Unassigned entries a statement at `cutoff` takes: non-lot entries, and entries of lots no longer pending */
  entriesForStatement(sellerId: string, cutoff: Date): Promise<EntryRec[]>;
  /** Sum of available-affecting entries already on issued statements (the opening available of the next one) */
  assignedAvailable(sellerId: string): Promise<number>;
  /** Sellers with unassigned entries up to the cutoff, or a positive available balance */
  sellersForRun(cutoff: Date): Promise<string[]>;
}

/* ---------------------------------------------------------------- payout provider */

export interface ProviderResult {
  status: 'processing' | 'paid' | 'failed' | 'returned';
  at?: Date;
  failureCode?: string | null;
  failureReason?: string | null;
  bankReference?: string | null;
}

/** The payout provider: bank transfers to sellers, micro-deposit checks and daily settlement reports */
export interface PayoutProvider {
  /** Sends a payout; idempotent on the payout id */
  send(input: { payoutId: string; amount: common.Money; providerDestinationId: string | null; reference: string }): Promise<{ providerPayoutId: string }>;
  /** Asks for the result of a payout that has no webhook result yet */
  status(providerPayoutId: string): Promise<ProviderResult>;
  /** Sends two small test deposits to a new destination */
  sendTestDeposits(providerDestinationId: string): Promise<{ sentAt: Date }>;
  /** Whether the amounts the owner entered match the test deposits */
  checkTestDeposits(providerDestinationId: string, amounts: number[]): Promise<boolean>;
  /** The provider's deposit total for a market day, null while the report is not available */
  settlementReport(date: string, currency: string): Promise<common.Money | null>;
}
