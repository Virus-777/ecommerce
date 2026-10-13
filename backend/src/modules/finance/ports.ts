/**
 * Row types of the finance collections, the shapes the repository (repository.ts) and the service share, and the
 * payout provider (bank transfers, micro-deposits, settlement reports), with a deterministic development provider
 * in providers/payouts.ts.
 */
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
export type FeeChargeRec = Db['fee_charges'];
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
export type FundingRec = Db['discount_funding'];
export type PlatformCostRec = Db['platform_costs'];
export type LiabilityRec = Db['store_credit_liability'];

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
