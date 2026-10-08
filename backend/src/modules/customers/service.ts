import { notImplemented } from '../../kernel/errors/index.js';
import type { EventPayload } from '../../kernel/events/index.js';
import type { ModuleContext } from '../../kernel/module-system/index.js';
import type * as common from '../../spec/common.js';
import type * as identity from '../../spec/identity.js';
import type { CustomersPublicApi, CustomerSnapshot, SavedAddress, AddressValidation, MarketingPreferences, RecentlyViewedItem } from '../../spec/customers.js';
import type { CustomersRepository } from './ports.js';

export interface CustomersServiceDeps {
  repo: CustomersRepository;
  ctx: ModuleContext<'customers'>;
}

/**
 * Customers use cases. Depends only on ports, the event bus, the clock and other modules' public APIs.
 * Each method maps to a publicApi function, a consumed event or a job in docs/api/spec/modules/customers.json.
 */
export class CustomersService implements CustomersPublicApi {
  constructor(protected readonly deps: CustomersServiceDeps) {}

  /* ---------------- public API (in-process) */

  /** Name, email, phone, account status and what the customer may do now */
  async getCustomer(customerId: string): Promise<CustomerSnapshot | null> {
    throw notImplemented("customers.getCustomer");
  }

  /** Resolve the customer for an identity session */
  async getCustomerByUserId(userId: string): Promise<CustomerSnapshot | null> {
    throw notImplemented("customers.getCustomerByUserId");
  }

  /** Returns a copy of a saved address. Checkout stores that copy on the order. Later edits or deletions never change the order (plan ch. 7). */
  async getAddressForOrder(customerId: string, addressId: string): Promise<common.Address> {
    throw notImplemented("customers.getAddressForOrder");
  }

  /** Save an address entered at checkout when the customer ticks 'save to my addresses' */
  async rememberCheckoutAddress(customerId: string, address: common.Address, label?: string): Promise<SavedAddress> {
    throw notImplemented("customers.rememberCheckoutAddress");
  }

  /** False while the account is suspended, closed or has an active ordering restriction */
  async canPlaceOrders(customerId: string): Promise<{ allowed: boolean, reason?: string }> {
    throw notImplemented("customers.canPlaceOrders");
  }

  /** False during an active messaging restriction. Replies inside open cases stay allowed (support decides). */
  async canSendMessages(customerId: string): Promise<{ allowed: boolean, reason?: string, until?: string }> {
    throw notImplemented("customers.canSendMessages");
  }

  /** Promotional consent per channel plus the personalisation switches (recommendations, recent searches). Essential order messages ignore it. search reads recentSearches before saving a search to the account. */
  async getMarketingConsent(customerId: string): Promise<MarketingPreferences> {
    throw notImplemented("customers.getMarketingConsent");
  }

  /** Same checks as POST /addresses/validate (provider when configured): issues, deliverability and a suggested correction. Used for addresses typed at checkout that are not saved. */
  async validateAddress(address: common.Address): Promise<AddressValidation> {
    throw notImplemented("customers.validateAddress");
  }

  /** Product ids, newest first, for recommendations and the phase-3 wishlist */
  async listRecentlyViewed(owner: { customerId?: string, guestSessionId?: string }, limit: number): Promise<string[]> {
    throw notImplemented("customers.listRecentlyViewed");
  }

  /** Recently viewed rows, newest first, with the title and image snapshot and availability (same rows as GET /recently-viewed). In GraphQL the current price comes from offers through RecentlyViewedItem.product. */
  async listRecentlyViewedItems(owner: { customerId?: string, guestSessionId?: string }, limit: number): Promise<RecentlyViewedItem[]> {
    throw notImplemented("customers.listRecentlyViewedItems");
  }

  /** Admin customer list with the same filters and permission rules as GET /api/admin/customers/customers */
  async searchCustomers(filter: { search?: string, statuses?: string[], verification?: string, joinedFrom?: string, joinedTo?: string }, page: common.PageInput): Promise<common.Page<CustomerSnapshot>> {
    throw notImplemented("customers.searchCustomers");
  }

  /** Export rows for reports dataset customers.admin.accounts (the filtered customer list) */
  async exportRows(dataset: string, filters: unknown, principal: identity.Principal, cursor?: string): Promise<{ rows: unknown[], nextCursor?: string }> {
    throw notImplemented("customers.exportRows");
  }

  /* ---------------- events consumed */

  /** orders.order.placed: When guestEmail is set, add or update the guest buyer row (order count, spend, last order) Also: Update order count, spend and the used address's lastUsedAt */
  async onOrderPlacedFromOrders(event: EventPayload<"orders.order.placed">): Promise<void> {
    throw notImplemented("customers consumer of orders.order.placed");
  }

  /** identity.user.registered: Create the customer profile, default marketing preferences (all promotional channels off unless opted in at registration) and the first consent log rows; remove the guest buyer row with the same email */
  async onUserRegisteredFromIdentity(event: EventPayload<"identity.user.registered">): Promise<void> {
    throw notImplemented("customers consumer of identity.user.registered");
  }

  /** identity.user.verified: Mark email or phone verified (orders attaches guest orders with that email itself) */
  async onUserVerifiedFromIdentity(event: EventPayload<"identity.user.verified">): Promise<void> {
    throw notImplemented("customers consumer of identity.user.verified");
  }

  /** identity.guest_session.claimed: Merge the guest session's recently viewed list into the customer's list (newest view wins) and delete the guest rows */
  async onGuestSessionClaimedFromIdentity(event: EventPayload<"identity.guest_session.claimed">): Promise<void> {
    throw notImplemented("customers consumer of identity.guest_session.claimed");
  }

  /** identity.email.changed: Update the mirrored email and its verification date */
  async onEmailChangedFromIdentity(event: EventPayload<"identity.email.changed">): Promise<void> {
    throw notImplemented("customers consumer of identity.email.changed");
  }

  /** identity.account.closed: If identity closed the account directly (staff tool), move the customer to closed and stop promotional consent */
  async onAccountClosedFromIdentity(event: EventPayload<"identity.account.closed">): Promise<void> {
    throw notImplemented("customers consumer of identity.account.closed");
  }

  /** trust.enforcement.recorded: When the target is a customer (restrict messaging, ordering, reviews or account), create the restriction with the enforcement's reason, end date and appeal route */
  async onEnforcementRecordedFromTrust(event: EventPayload<"trust.enforcement.recorded">): Promise<void> {
    throw notImplemented("customers consumer of trust.enforcement.recorded");
  }

  /** catalog.product.merged: Repoint recently viewed rows from the duplicate to the kept product */
  async onProductMergedFromCatalog(event: EventPayload<"catalog.product.merged">): Promise<void> {
    throw notImplemented("customers consumer of catalog.product.merged");
  }

  /* ---------------- jobs */

  /** Job customers.expire-restrictions (every 10 min): Expire restrictions past endsAt; return the account to active when none remain */
  async expireRestrictions(): Promise<void> {
    throw notImplemented("job customers.expire-restrictions");
  }

  /** Job customers.build-data-exports (every 5 min): Process requested exports: collect each enabled module's export hook, write a ZIP to media, mark ready, publish customers.data_export.ready */
  async buildDataExports(): Promise<void> {
    throw notImplemented("job customers.build-data-exports");
  }

  /** Job customers.expire-export-links (hourly): Expire ready exports after exportLinkValidDays and delete the file */
  async expireExportLinks(): Promise<void> {
    throw notImplemented("job customers.expire-export-links");
  }

  /** Job customers.complete-closures (daily 02:00 market time): For closures past the cooling-off date, re-check obligations; close the account, anonymise profile and addresses, keep order references */
  async completeClosures(): Promise<void> {
    throw notImplemented("job customers.complete-closures");
  }

  /** Job customers.prune-recently-viewed (daily): Delete rows older than recentlyViewedRetentionDays and guest rows whose session expired */
  async pruneRecentlyViewed(): Promise<void> {
    throw notImplemented("job customers.prune-recently-viewed");
  }
}
