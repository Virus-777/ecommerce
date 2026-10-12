/**
 * What the customers service needs from the outside world, database-agnostic.
 * The MongoDB adapter lives in infra/mongo/.
 */
import type * as common from '../../spec/common.js';
import type { CustomersDb } from '../../spec/customers.js';
import type { PageRequest } from '../../kernel/lib/pagination.js';

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

/** A customer with what it may do now (active ordering / messaging blocks), read in one statement. */
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

/** Persistence for this module's own tables: customers.customers, customers.addresses, customers.marketing_preferences, customers.consent_log, customers.recently_viewed, customers.account_restrictions, customers.account_actions, customers.guest_buyers, customers.customer_notes, customers.data_requests, customers.guest_lookup_attempts. */
export interface CustomersRepository {
  /** Runs fn in one transaction with a repository bound to it (nested calls reuse the outer one) */
  transaction<T>(fn: (repo: CustomersRepository) => Promise<T>): Promise<T>;
  /** Inbox (ctx.mongo.claim): true the first time this key is claimed; commits with the transaction it runs in */
  claim(key: string): Promise<boolean>;

  /* customers */
  getCustomer(id: string, o?: { forUpdate?: boolean }): Promise<CustomerRow | undefined>;
  getCustomerByUserId(userId: string, o?: { forUpdate?: boolean }): Promise<CustomerRow | undefined>;
  getCustomers(ids: readonly string[]): Promise<CustomerRow[]>;
  findCustomerByEmail(email: string): Promise<CustomerRow | undefined>;
  standingById(id: string, now: Date): Promise<CustomerStanding | undefined>;
  standingByUserId(userId: string, now: Date): Promise<CustomerStanding | undefined>;
  standings(ids: readonly string[], now: Date): Promise<CustomerStanding[]>;
  /** Inserts unless the user already has a customer; true when inserted */
  insertCustomer(row: CustomerRow): Promise<boolean>;
  updateCustomer(id: string, patch: Partial<CustomerRow>): Promise<CustomerRow>;
  searchCustomers(f: CustomerSearch, page: PageRequest): Promise<common.Page<CustomerRow>>;

  /* addresses (live = not soft-deleted) */
  listAddresses(customerId: string): Promise<AddressRow[]>;
  getAddress(customerId: string, id: string, o?: { forUpdate?: boolean }): Promise<AddressRow | undefined>;
  countAddresses(customerId: string): Promise<number>;
  insertAddress(row: AddressRow): Promise<AddressRow>;
  updateAddress(id: string, patch: Partial<AddressRow>): Promise<AddressRow>;
  clearDefaultAddress(customerId: string, now: Date): Promise<void>;
  defaultAddresses(customerIds: readonly string[]): Promise<AddressRow[]>;
  /** Overwrites personal fields of every address and soft-deletes them (closure) */
  anonymiseAddresses(customerId: string, now: Date): Promise<void>;

  /* marketing consent */
  getPreferences(customerId: string): Promise<PreferencesRow | undefined>;
  upsertPreferences(row: PreferencesRow): Promise<PreferencesRow>;
  insertConsent(rows: ConsentRow[]): Promise<void>;
  consentLog(customerId: string): Promise<ConsentRow[]>;

  /* recently viewed */
  upsertView(row: ViewRow): Promise<void>;
  listViews(owner: ViewOwner, limit: number): Promise<ViewRow[]>;
  trimViews(owner: ViewOwner, keep: number): Promise<number>;
  deleteViews(owner: ViewOwner, productId?: string): Promise<number>;
  repointProduct(fromProductId: string, toProductId: string, variantId: string | null): Promise<number>;
  pruneViews(before: Date, guestBefore: Date): Promise<number>;

  /* restrictions */
  listRestrictions(customerId: string, o?: { activeAt?: Date }): Promise<RestrictionRow[]>;
  getRestriction(customerId: string, id: string, o?: { forUpdate?: boolean }): Promise<RestrictionRow | undefined>;
  findRestrictionByEnforcement(customerId: string, enforcementId: string): Promise<RestrictionRow | undefined>;
  /** Active restrictions a trust enforcement created, any customer */
  activeRestrictionsByEnforcement(enforcementId: string): Promise<RestrictionRow[]>;
  insertRestriction(row: RestrictionRow): Promise<RestrictionRow>;
  updateRestriction(id: string, patch: Partial<RestrictionRow>): Promise<RestrictionRow>;
  /** Active restrictions whose end has passed */
  dueRestrictions(now: Date, limit: number): Promise<RestrictionRow[]>;
  countActiveRestrictions(customerId: string, now: Date): Promise<number>;

  /* account actions and notes */
  insertAction(row: ActionRow): Promise<ActionRow>;
  listActions(customerId: string, page: PageRequest): Promise<common.Page<ActionRow>>;
  recentActions(customerId: string, limit: number): Promise<ActionRow[]>;
  insertNote(row: NoteRow): Promise<NoteRow>;
  listNotes(customerId: string): Promise<NoteRow[]>;

  /* guest buyers */
  getGuestBuyer(emailNormalized: string, o?: { forUpdate?: boolean }): Promise<GuestBuyerRow | undefined>;
  insertGuestBuyer(row: GuestBuyerRow): Promise<void>;
  updateGuestBuyer(id: string, patch: Partial<GuestBuyerRow>): Promise<void>;
  deleteGuestBuyer(emailNormalized: string): Promise<number>;
  listGuestBuyers(f: GuestBuyerSearch, page: PageRequest): Promise<common.Page<GuestBuyerRow>>;

  /* data requests */
  insertDataRequest(row: DataRequestRow): Promise<DataRequestRow>;
  getDataRequest(id: string, o?: { customerId?: string; forUpdate?: boolean }): Promise<DataRequestRow | undefined>;
  updateDataRequest(id: string, patch: Partial<DataRequestRow>): Promise<DataRequestRow>;
  listDataRequests(customerId: string): Promise<DataRequestRow[]>;
  /** The open request of a kind (requested or processing; failed exports count as open too) */
  openDataRequest(customerId: string, kind: 'export' | 'closure'): Promise<DataRequestRow | undefined>;
  countExportsSince(customerId: string, since: Date): Promise<number>;
  /** Exports to build: requested ones and retried (processing) ones, oldest first, locked for this run */
  exportsToBuild(limit: number): Promise<DataRequestRow[]>;
  readyExportsExpiring(now: Date, limit: number): Promise<DataRequestRow[]>;
  closuresDue(now: Date, limit: number): Promise<DataRequestRow[]>;
  searchDataRequests(f: DataRequestSearch, page: PageRequest): Promise<common.Page<DataRequestRow & { customer_first_name: string; customer_last_name: string }>>;

  /* guest order lookups */
  insertLookupAttempt(row: LookupAttemptRow): Promise<void>;
  countLookupAttempts(by: { emailHash?: string; ip?: string }, since: Date): Promise<number>;
}

/* ------------------------------------------------------------------ providers */

/** Address validation provider (optional integration): normalises US addresses and detects PO boxes. */
export interface AddressValidationProvider {
  readonly name: string;
  /** A normalised copy of the address, or null when the provider does not know it (not_found) */
  normalise(address: common.Address): Promise<{ address: common.Address; poBox: boolean } | null>;
}
