import type { EventPayload } from '../../kernel/events/index.js';
import type * as common from '../../spec/common.js';
import type {
  AddressValidation,
  CustomerSnapshot,
  CustomersPublicApi,
  MarketingPreferences,
  RecentlyViewedItem,
  SavedAddress,
} from '../../spec/customers.js';
import type * as identity from '../../spec/identity.js';
import type * as reports from '../../spec/reports.js';
import { Core, type CustomersServiceDeps } from './service/core.js';
import { Profiles } from './service/profiles.js';
import { Addresses } from './service/addresses.js';
import { Marketing } from './service/marketing.js';
import { RecentlyViewed } from './service/recently-viewed.js';
import { DataRequests } from './service/data-requests.js';
import { GuestOrders } from './service/guest-orders.js';
import { Admin } from './service/admin.js';
import { AccountActions } from './service/account-actions.js';

export type { CustomersServiceDeps, StaffBy } from './service/core.js';

/**
 * Customers use cases. Depends only on its repository, the event bus, the clock and other modules' public APIs.
 * The work is split by feature (service/*.ts; endpoints call service.<feature>.<method>); this class is the module's
 * public API, its event consumers and jobs (docs/api/spec/modules/customers.json).
 *
 * Rule kept throughout: other modules are never called inside a repository transaction (they use their
 * own connections), so cross-module calls happen before or after the transaction.
 */
export class CustomersService implements CustomersPublicApi {
  readonly core: Core;
  readonly profiles: Profiles;
  readonly addresses: Addresses;
  readonly marketing: Marketing;
  readonly recentlyViewed: RecentlyViewed;
  readonly dataRequests: DataRequests;
  readonly guestOrders: GuestOrders;
  readonly admin: Admin;
  readonly accountActions: AccountActions;

  constructor(deps: CustomersServiceDeps) {
    this.core = new Core(deps);
    this.profiles = new Profiles(this.core);
    this.addresses = new Addresses(this.core, this.profiles);
    this.marketing = new Marketing(this.core, this.profiles);
    this.recentlyViewed = new RecentlyViewed(this.core, this.profiles, this.marketing);
    this.dataRequests = new DataRequests(this.core, this.profiles, this.marketing);
    this.admin = new Admin(this.core, this.marketing, this.profiles);
    this.guestOrders = new GuestOrders(this.core, this.admin);
    this.accountActions = new AccountActions(this.core, this.dataRequests);
  }

  /** Name, email, phone, account status and what the customer may do now */
  getCustomer(customerId: string): Promise<CustomerSnapshot | null> {
    return this.profiles.getCustomer(customerId);
  }

  /** Resolve the customer for an identity session (the kernel calls this for every own-customer request, so it stays one lookup) */
  getCustomerByUserId(userId: string): Promise<CustomerSnapshot | null> {
    return this.profiles.getCustomerByUserId(userId);
  }

  /** Returns a copy of a saved address. Checkout stores that copy on the order; later edits never change it (plan ch. 7). */
  getAddressForOrder(customerId: string, addressId: string): Promise<common.Address> {
    return this.addresses.getAddressForOrder(customerId, addressId);
  }

  /** Save an address entered at checkout when the customer ticks 'save to my addresses' (an identical saved address is reused) */
  rememberCheckoutAddress(customerId: string, address: common.Address, label?: string): Promise<SavedAddress> {
    return this.addresses.rememberCheckoutAddress(customerId, address, label);
  }

  /** False while the account is suspended, closed or has an active ordering restriction */
  canPlaceOrders(customerId: string): Promise<{ allowed: boolean; reason?: string }> {
    return this.profiles.canPlaceOrders(customerId);
  }

  /** False during an active messaging restriction. Replies inside open cases stay allowed (support decides). */
  canSendMessages(customerId: string): Promise<{ allowed: boolean; reason?: string; until?: string }> {
    return this.profiles.canSendMessages(customerId);
  }

  /** Promotional consent per channel plus the personalisation switches. Essential order messages ignore it. */
  getMarketingConsent(customerId: string): Promise<MarketingPreferences> {
    return this.marketing.getMarketingConsent(customerId);
  }

  /** Same checks as POST /addresses/validate (provider when configured) */
  validateAddress(address: common.Address): Promise<AddressValidation> {
    return this.addresses.validateAddress(address);
  }

  /** Product ids, newest first, for recommendations and the phase-3 wishlist */
  listRecentlyViewed(owner: { customerId?: string; guestSessionId?: string }, limit: number): Promise<string[]> {
    return this.recentlyViewed.listRecentlyViewed(owner, limit);
  }

  /** Recently viewed rows with the title and image snapshot and availability (same rows as GET /recently-viewed) */
  listRecentlyViewedItems(owner: { customerId?: string; guestSessionId?: string }, limit: number): Promise<RecentlyViewedItem[]> {
    return this.recentlyViewed.listRecentlyViewedItems(owner, limit);
  }

  /** Admin customer list with the same filters as GET /api/admin/customers/customers */
  searchCustomers(
    filter: { search?: string; statuses?: string[]; verification?: string; joinedFrom?: string; joinedTo?: string },
    page: common.PageInput,
  ): Promise<common.Page<CustomerSnapshot>> {
    return this.admin.searchCustomers(filter, page);
  }

  /** Export rows for reports dataset customers.admin.accounts (the filtered customer list) */
  exportRows(dataset: string, filters: unknown, _principal: identity.Principal, cursor?: string): Promise<{ rows: unknown[]; nextCursor?: string }> {
    return this.admin.exportRows(dataset, filters, _principal, cursor);
  }

  /**
   * access.approval.decided for customers.accounts.close-with-obligations: approved closes the account as the
   * requester, with the reason they gave; rejected, cancelled or expired leaves it as it is (the pending closure
   * lived only in the approval request). A status the close no longer applies to is logged and ignored.
   */
  onApprovalDecidedFromAccess(event: EventPayload<'access.approval.decided'>, eventId?: string): Promise<void> {
    return this.accountActions.onApprovalDecidedFromAccess(event, eventId);
  }

  /** orders.order.placed: guest buyer row for guest checkouts; order count, spend and the used address's lastUsedAt for customers */
  onOrderPlacedFromOrders(event: EventPayload<'orders.order.placed'>, eventId?: string): Promise<void> {
    return this.guestOrders.onOrderPlacedFromOrders(event, eventId);
  }

  /** identity.user.registered: profile, default preferences and the first consent rows; the guest buyer row goes */
  onUserRegisteredFromIdentity(event: EventPayload<'identity.user.registered'>): Promise<void> {
    return this.profiles.onUserRegisteredFromIdentity(event);
  }

  /** identity.user.verified: email or phone verified */
  onUserVerifiedFromIdentity(event: EventPayload<'identity.user.verified'>): Promise<void> {
    return this.profiles.onUserVerifiedFromIdentity(event);
  }

  /** identity.guest_session.claimed: merge the guest list into the account (newest view wins) and delete the guest rows */
  onGuestSessionClaimedFromIdentity(event: EventPayload<'identity.guest_session.claimed'>): Promise<void> {
    return this.recentlyViewed.onGuestSessionClaimedFromIdentity(event);
  }

  /** identity.email.changed: mirrored email and its verification date */
  onEmailChangedFromIdentity(event: EventPayload<'identity.email.changed'>): Promise<void> {
    return this.profiles.onEmailChangedFromIdentity(event);
  }

  /** identity.account.closed: identity closed the account directly (staff tool): the customer is closed and promotions stop */
  onAccountClosedFromIdentity(event: EventPayload<'identity.account.closed'>): Promise<void> {
    return this.dataRequests.onAccountClosedFromIdentity(event);
  }

  /** trust.enforcement.recorded: customer restrictions with the enforcement's reason, end date and appeal route */
  onEnforcementRecordedFromTrust(event: EventPayload<'trust.enforcement.recorded'>, actor?: common.Actor): Promise<void> {
    return this.accountActions.onEnforcementRecordedFromTrust(event, actor);
  }

  /**
   * trust.enforcement.reversed: lift every active restriction that enforcement created (actor system on behalf of trust);
   * the last one returns the account to active. Restrictions already lifted or expired stay as they are, so a
   * redelivered event changes nothing; each lift also claims (event, restriction) in the inbox.
   */
  onEnforcementReversedFromTrust(event: EventPayload<'trust.enforcement.reversed'>, eventId?: string): Promise<void> {
    return this.accountActions.onEnforcementReversedFromTrust(event, eventId);
  }

  /** catalog.product.merged: recently viewed rows follow the kept product */
  onProductMergedFromCatalog(event: EventPayload<'catalog.product.merged'>): Promise<void> {
    return this.recentlyViewed.onProductMergedFromCatalog(event);
  }

  /** customers.expire-restrictions: expire restrictions past endsAt; the last one returns the account to active */
  expireRestrictions(): Promise<{ expired: number }> {
    return this.accountActions.expireRestrictions();
  }

  /** customers.build-data-exports: requested (and retried) exports become a ZIP in media, then ready */
  buildDataExports(): Promise<{ built: number; failed: number }> {
    return this.dataRequests.buildDataExports();
  }

  /** customers.expire-export-links: ready exports past their link lifetime expire and the file is deleted */
  expireExportLinks(): Promise<{ expired: number }> {
    return this.dataRequests.expireExportLinks();
  }

  /** customers.complete-closures: closures past the cooling-off date re-check obligations, then close and anonymise */
  completeClosures(): Promise<{ completed: number; waiting: number }> {
    return this.dataRequests.completeClosures();
  }

  /** customers.prune-recently-viewed: views older than recentlyViewedRetentionDays, and guest views whose session has expired */
  pruneRecentlyViewed(): Promise<{ deleted: number }> {
    return this.recentlyViewed.pruneRecentlyViewed();
  }
}
