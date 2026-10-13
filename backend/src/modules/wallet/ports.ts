/** Row types of the wallet collections and the shapes the repository (repository.ts) and the service share. */
import type { WalletDb } from '../../spec/wallet.js';

export type AccountRow = WalletDb['accounts'];
export type LotRow = WalletDb['lots'];
export type EntryRow = WalletDb['ledger'];
export type HoldRow = WalletDb['holds'];
export type GrantRow = WalletDb['goodwill_grants'];
export type GiftCardRow = WalletDb['gift_cards'];
export type GiftCardBatchRow = WalletDb['gift_card_batches'];
export type CorrectionRow = WalletDb['credit_corrections'];

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
