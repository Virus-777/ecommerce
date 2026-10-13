/**
 * Row types and search filters of the customers module (its collections are read and written by repository.ts),
 * and the address validation provider it may call.
 */
import type * as common from '../../spec/common.js';
import type { CustomersDb } from '../../spec/customers.js';

export type CustomerRow = CustomersDb['customers'];
export type AddressRow = CustomersDb['addresses'];
export type PreferencesRow = CustomersDb['marketing_preferences'];
export type ConsentRow = CustomersDb['consent_log'];
export type ViewRow = CustomersDb['recently_viewed'];
export type RestrictionRow = CustomersDb['account_restrictions'];
export type ActionRow = CustomersDb['account_actions'];
export type GuestBuyerRow = CustomersDb['guest_buyers'];
export type NoteRow = CustomersDb['customer_notes'];
export type DataRequestRow = CustomersDb['data_requests'];
export type LookupAttemptRow = CustomersDb['guest_lookup_attempts'];

/** A customer with what it may do now (active ordering / messaging blocks), read in one call. */
export interface CustomerStanding {
  row: CustomerRow;
  /** An active ordering or account restriction */
  orderBlock: boolean;
  /** An active messaging or account restriction; latest end (null = until lifted) */
  messageBlock: boolean;
  messageBlockUntil: Date | null;
}

export type ViewOwner = { kind: 'customer' | 'guest'; id: string };

export interface CustomerSearch {
  q?: string;
  /** Customer ids resolved from the query outside this module (e.g. an order reference) */
  extraIds?: string[];
  /** Only these customers (filters resolved in other modules before paging; empty = nobody) */
  onlyIds?: string[];
  /** Never these customers (filters resolved in other modules before paging) */
  excludeIds?: string[];
  statuses?: string[];
  verification?: string;
  joinedFrom?: Date;
  joinedTo?: Date;
  sort?: 'newest' | 'spend' | 'orders' | 'name';
}

export interface GuestBuyerSearch {
  q?: string;
  orderedFrom?: Date;
  orderedTo?: Date;
}

export interface DataRequestSearch {
  kind?: 'export' | 'closure';
  state?: string;
  overdueAt?: Date;
}

/* ------------------------------------------------------------------ providers */

/** Address validation provider (optional integration): normalises US addresses and detects PO boxes. */
export interface AddressValidationProvider {
  readonly name: string;
  /** A normalised copy of the address, or null when the provider does not know it (not_found) */
  normalise(address: common.Address): Promise<{ address: common.Address; poBox: boolean } | null>;
}
