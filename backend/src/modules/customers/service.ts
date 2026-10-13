import { createHmac } from 'node:crypto';
import { SYSTEM_ACTOR, type Principal } from '../../kernel/auth/index.js';
import type { Scope } from '../../kernel/auth/scope.js';
import { AppError, isAppError, isNotImplemented } from '../../kernel/errors/index.js';
import type { EventPayload } from '../../kernel/events/index.js';
import { dateInZone, zonedTimeToUtc } from '../../kernel/lib/clock.js';
import { isUuid, newId } from '../../kernel/lib/ids.js';
import { format as formatMoney } from '../../kernel/lib/money.js';
import { toPageRequest, type PageRequest } from '../../kernel/lib/pagination.js';
import { secretFor } from '../../kernel/lib/secrets.js';
import type { ModuleContext } from '../../kernel/module-system/index.js';
import type * as audit from '../../spec/audit.js';
import type * as common from '../../spec/common.js';
import type {
  AccountActionInput,
  AccountActionResult,
  AccountOverview,
  AddressInput,
  AddressValidation,
  AdminCustomerDetail,
  AdminCustomerRow,
  ClosureBlocker,
  ClosureEligibility,
  CustomerNote,
  CustomerProfile,
  CustomerSnapshot,
  CustomersPublicApi,
  DataRequest,
  GuestBuyerRow,
  GuestOrderAccess,
  MarketingPreferences,
  MarketingPreferencesInput,
  OverviewAlert,
  OverviewTile,
  ProfileInput,
  RecentlyViewedItem,
  SavedAddress,
} from '../../spec/customers.js';
import type * as identity from '../../spec/identity.js';
import type * as reports from '../../spec/reports.js';
import { spec as customersSpec } from '../../spec/customers.js';
import { specs } from '../../spec/index.js';
import { checkAddress, cleanAddress, hardIssues, sameAddress } from './domain/address.js';
import {
  blocker,
  cleanPhone,
  customerMessageFor,
  displayName,
  effectsOf,
  isPendingRefund,
  normalizeEmail,
  REASON_CODES,
  RESTRICT_ACTIONS,
  RETAINED_RECORDS,
  scopeOfTrustAction,
  SECURITY_ACTIONS,
  STAFF_APPEAL_ROUTE,
  stillWorksFor,
  trustAppealRoute,
  verificationOf,
  type AccountStatus,
  type ReasonCode,
  type RestrictionScope,
} from './domain/rules.js';
import { accountRestrictionMachine, customerAccountStatusMachine, dataRequestMachine } from './domain/state-machines.js';
import { zip } from './domain/zip.js';
import * as map from './mappers.js';
import type {
  ActionRow,
  AddressRow,
  AddressValidationProvider,
  ConsentRow,
  CustomerRow,
  CustomerStanding,
  DataRequestRow,
  PreferencesRow,
  RestrictionRow,
  ViewOwner,
  ViewRow,
} from './ports.js';
import type { CustomersRepository } from './repository.js';

export interface CustomersServiceDeps {
  repo: CustomersRepository;
  ctx: ModuleContext<'customers'>;
  /** Address validation provider (optional integration); format rules only without it */
  addressProvider?: AddressValidationProvider;
}

/** Who acts, for events, audit and the consent log */
export interface By {
  actor: common.Actor;
  requestId?: string;
  principal?: Principal | null;
  ip?: string | null;
}

/** Staff callers also answer permission questions (business permissions beyond the endpoint's) */
export interface StaffBy extends By {
  principal: Principal;
  can(permission: string): Promise<boolean>;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const CLOSE_WITH_OBLIGATIONS = 'customers.accounts.close-with-obligations';
const DATASET = 'customers.admin.accounts';
/** Visitor sessions end 30 days after last activity (docs/03-auth-middleware.md §2); their views go with them */
const GUEST_SESSION_DAYS = 30;
const EXPORTS_PER_DAY = 3;
const BATCH = 50;

type PrefKey = 'emailPromotions' | 'smsPromotions' | 'pushPromotions' | 'wishlistAlerts' | 'personalizedRecommendations' | 'recentSearches';
type PrefColumn = 'email_promotions' | 'sms_promotions' | 'push_promotions' | 'wishlist_alerts' | 'personalized_recommendations' | 'recent_searches';
/** API field → column and consent log channel */
const PREFS: Record<PrefKey, [PrefColumn, string]> = {
  emailPromotions: ['email_promotions', 'email'],
  smsPromotions: ['sms_promotions', 'sms'],
  pushPromotions: ['push_promotions', 'push'],
  wishlistAlerts: ['wishlist_alerts', 'wishlist'],
  personalizedRecommendations: ['personalized_recommendations', 'personalization'],
  recentSearches: ['recent_searches', 'recent_searches'],
};
const PROMOTIONAL_OFF: Partial<Record<PrefKey, boolean>> = { emailPromotions: false, smsPromotions: false, pushPromotions: false, wishlistAlerts: false };

/** Optional dependencies whose spec declares the customer data export hook (FORMAT.md, Customer data export hook) */
const EXPORT_HOOK_MODULES = customersSpec.optionalDeps.filter((m) => (specs as Record<string, { publicApi: readonly string[] } | undefined>)[m]?.publicApi.includes('exportCustomerData'));
/** Attachment errors that leave the file out (listed in the README) instead of failing the export */
const SKIPPED_ATTACHMENT = new Set(['NOT_FOUND', 'ASSET_NOT_OWNED', 'ILLEGAL_TRANSITION', 'FILE_TOO_LARGE']);
const safeName = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

const invalid = (path: string, message: string) => new AppError('VALIDATION_FAILED', message, { issues: [{ path, message }] });
const notFound = (what: string) => new AppError('NOT_FOUND', `${what} not found`);
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Customers use cases. Depends only on its repository, the event bus, the clock and other modules' public APIs.
 * Each method maps to a publicApi function, an endpoint, a consumed event or a job in docs/api/spec/modules/customers.json.
 *
 * Rule kept throughout: other modules are never called inside a repository transaction (they use their
 * own connections), so cross-module calls happen before or after the transaction.
 */
export class CustomersService implements CustomersPublicApi {
  #datasetRegistered?: Promise<void>;

  constructor(protected readonly deps: CustomersServiceDeps) {}

  private get ctx() {
    return this.deps.ctx;
  }
  private get repo() {
    return this.deps.repo;
  }
  private now() {
    return this.ctx.clock.now();
  }
  private get tz() {
    return this.ctx.config.market.timeZone;
  }
  private meta(by?: { actor?: common.Actor; requestId?: string }) {
    return { actor: by?.actor ?? SYSTEM_ACTOR, requestId: by?.requestId };
  }

  protected async audit(entry: Omit<audit.RecordInput, 'actor' | 'module' | 'requestId'>, by: { actor: common.Actor; requestId?: string }) {
    await this.ctx.tryUse('audit')?.record({ ...entry, actor: by.actor, module: this.ctx.name, requestId: by.requestId ?? null });
  }

  /** A call to another module whose failure must not break this one (lists, read-only decorations) */
  private async soft<T>(what: string, call: (() => Promise<T>) | undefined): Promise<T | undefined> {
    if (!call) return undefined;
    try {
      return await call();
    } catch (err) {
      if (!isNotImplemented(err)) this.ctx.log.warn({ err, what }, `customers: ${what} failed; shown without it`);
      return undefined;
    }
  }

  private target(c: CustomerRow) {
    return { type: 'customer', id: c.id, ref: c.ref, label: `${displayName(c.first_name, c.last_name)} (${c.email})`, screen: 'admin/customers' };
  }

  /* ================================================================ customers */

  /** The signed-in customer of an own-customer request (created from identity when the registration event has not arrived yet) */
  async ownCustomer(scope: Scope): Promise<CustomerRow> {
    if (scope.kind !== 'customer') throw new AppError('UNAUTHORIZED', 'Sign in to continue', { reason: 'sign_in_required' });
    const row =
      (scope.customerId ? await this.repo.getCustomer(scope.customerId) : undefined) ??
      (await this.repo.getCustomerByUserId(scope.accountId)) ??
      (await this.ensureCustomer(scope.accountId));
    if (!row) throw notFound('Customer profile');
    return row;
  }

  /** The customer of an identity account, created from the identity account if it is missing */
  private async ensureCustomer(accountId: string): Promise<CustomerRow | undefined> {
    if (!isUuid(accountId)) return undefined;
    const existing = await this.repo.getCustomerByUserId(accountId);
    if (existing) return existing;
    const acct = await this.ctx.use('identity').getAccount(accountId);
    if (!acct || acct.realm !== 'member' || ['closed', 'disabled', 'invited'].includes(acct.status)) return undefined;
    const [first = '', ...rest] = acct.displayName.trim().split(/\s+/);
    const out = await this.createCustomer(
      { accountId, email: acct.email, firstName: first, lastName: rest.join(' '), marketingOptIn: false, emailVerifiedAt: acct.emailVerified ? this.now() : null },
      { actor: SYSTEM_ACTOR },
    );
    return out.row;
  }

  private async createCustomer(
    i: { accountId: string; email: string; firstName: string; lastName: string; marketingOptIn: boolean; emailVerifiedAt: Date | null },
    by: By,
  ): Promise<{ row: CustomerRow; created: boolean }> {
    const now = this.now();
    const id = newId();
    const email = normalizeEmail(i.email);
    const ref = await this.ctx.refs.next('CU', { digits: 6, daily: false });
    const out = await this.repo.transaction(async (repo) => {
      const inserted = await repo.insertCustomer({
        id,
        user_id: i.accountId,
        ref,
        first_name: i.firstName.trim().slice(0, 100),
        last_name: i.lastName.trim().slice(0, 100),
        email,
        email_verified_at: i.emailVerifiedAt,
        phone: null,
        phone_verified_at: null,
        account_status: customerAccountStatusMachine.initial,
        default_address_id: null,
        order_count: 0,
        total_spend_minor: 0,
        currency: this.ctx.config.market.currency,
        closed_at: null,
        created_at: now,
        updated_at: now,
      });
      if (!inserted) return { row: (await repo.getCustomerByUserId(i.accountId))!, created: false };
      const prefs: PreferencesRow = {
        customer_id: id,
        email_promotions: i.marketingOptIn,
        sms_promotions: false,
        push_promotions: false,
        wishlist_alerts: false,
        personalized_recommendations: true,
        recent_searches: true,
        updated_at: now,
      };
      await repo.upsertPreferences(prefs);
      await repo.insertConsent(
        (Object.keys(PREFS) as PrefKey[]).map((k) => ({
          id: newId(),
          customer_id: id,
          channel: PREFS[k][1],
          granted: prefs[PREFS[k][0]],
          source: 'registration',
          actor_kind: 'customer',
          actor_id: i.accountId,
          ip: null,
          at: now,
        })),
      );
      await repo.deleteGuestBuyer(email); // the guest moves to the customer list
      return { row: (await repo.getCustomer(id))!, created: true };
    });
    if (out.created) this.ctx.events.publish('customers.customer.created', { customerId: out.row.id, userId: i.accountId }, this.meta(by));
    return out;
  }

  /** Name, email, phone, account status and what the customer may do now */
  async getCustomer(customerId: string): Promise<CustomerSnapshot | null> {
    if (!isUuid(customerId)) return null;
    const s = await this.repo.standingById(customerId, this.now());
    return s ? map.snapshot(s) : null;
  }

  /** Resolve the customer for an identity session (the kernel calls this for every own-customer request, so it stays one lookup) */
  async getCustomerByUserId(userId: string): Promise<CustomerSnapshot | null> {
    if (!isUuid(userId)) return null;
    const s = await this.repo.standingByUserId(userId, this.now());
    return s ? map.snapshot(s) : null;
  }

  /** False while the account is suspended, closed or has an active ordering restriction */
  async canPlaceOrders(customerId: string): Promise<{ allowed: boolean; reason?: string }> {
    const s = isUuid(customerId) ? await this.repo.standingById(customerId, this.now()) : undefined;
    if (!s) return { allowed: false, reason: 'Customer not found' };
    const st = map.status(s.row);
    if (st === 'closed') return { allowed: false, reason: 'This account is closed' };
    if (st === 'suspended') return { allowed: false, reason: 'This account is suspended; existing orders stay available' };
    if (s.orderBlock) return { allowed: false, reason: 'New orders are paused on this account; existing orders stay available' };
    return { allowed: true };
  }

  /** False during an active messaging restriction. Replies inside open cases stay allowed (support decides). */
  async canSendMessages(customerId: string): Promise<{ allowed: boolean; reason?: string; until?: string }> {
    const s = isUuid(customerId) ? await this.repo.standingById(customerId, this.now()) : undefined;
    if (!s) return { allowed: false, reason: 'Customer not found' };
    const st = map.status(s.row);
    if (st === 'closed') return { allowed: false, reason: 'This account is closed' };
    if (st === 'suspended') return { allowed: false, reason: 'This account is suspended' };
    if (s.messageBlock) {
      return { allowed: false, reason: 'Sending new messages is paused on this account', ...(s.messageBlockUntil ? { until: map.iso(s.messageBlockUntil) } : {}) };
    }
    return { allowed: true };
  }

  /* ================================================================ profile */

  async getProfile(scope: Scope): Promise<CustomerProfile> {
    return this.profileOf(await this.ownCustomer(scope));
  }

  private async profileOf(c: CustomerRow): Promise<CustomerProfile> {
    return map.profile(c, await this.repo.listRestrictions(c.id, { activeAt: this.now() }), this.tz);
  }

  async updateProfile(scope: Scope, body: ProfileInput, by: By): Promise<CustomerProfile> {
    const c = await this.ownCustomer(scope);
    const patch: Partial<CustomerRow> = {};
    const fields: string[] = [];
    const name = (key: 'firstName' | 'lastName', col: 'first_name' | 'last_name', label: string) => {
      const raw = body[key];
      if (raw === undefined || raw === null) return;
      const v = raw.replace(/\s+/g, ' ').trim();
      if (!v) throw invalid(key, `Enter your ${label}`);
      if (v.length > 100) throw invalid(key, `Use at most 100 characters for your ${label}`);
      if (v !== c[col]) {
        patch[col] = v;
        fields.push(key);
      }
    };
    name('firstName', 'first_name', 'first name');
    name('lastName', 'last_name', 'last name');
    let newPhone: string | null = null;
    if (body.phone !== undefined) {
      const raw = body.phone?.trim() ?? '';
      const phone = raw ? cleanPhone(raw) : null;
      if (raw && !phone) throw invalid('phone', 'Enter a mobile number with country code, e.g. +1 503 555 0100');
      if (phone !== c.phone) {
        patch.phone = phone;
        patch.phone_verified_at = null; // a new number is unverified until identity confirms the code
        fields.push('phone');
        newPhone = phone;
      }
    }
    if (!fields.length) return this.profileOf(c);
    const row = await this.repo.updateCustomer(c.id, { ...patch, updated_at: this.now() });
    this.ctx.events.publish('customers.profile.updated', { customerId: c.id, fields }, this.meta(by));
    if (newPhone) {
      try {
        await this.ctx.use('identity').startPhoneVerification(c.user_id, newPhone);
      } catch (err) {
        // text message codes arrive with SMS (phase 2); until then the number stays unverified
        this.ctx.log.info({ code: isAppError(err) ? err.code : undefined, customerId: c.id }, 'customers: phone verification not started');
      }
    }
    return this.profileOf(row);
  }

  /* ================================================================ addresses */

  async listAddresses(scope: Scope): Promise<SavedAddress[]> {
    const c = await this.ownCustomer(scope);
    return (await this.repo.listAddresses(c.id)).map(map.savedAddress);
  }

  /** Same checks as POST /addresses/validate (provider when configured) */
  async validateAddress(address: common.Address): Promise<AddressValidation> {
    const v = checkAddress(address);
    const provider = this.deps.addressProvider;
    if (!v.valid || !provider) return v;
    let found: Awaited<ReturnType<AddressValidationProvider['normalise']>> | undefined;
    try {
      found = await provider.normalise(cleanAddress(address));
    } catch (err) {
      this.ctx.log.warn({ err, provider: provider.name }, 'customers: address provider failed; format rules only');
      return v;
    }
    if (found === null) {
      return { ...v, issues: [...v.issues, { field: 'line1', code: 'not_found', message: 'We couldn’t find this address; check the street and ZIP code' }] };
    }
    const poBox = v.poBox || found.poBox;
    const issues = poBox && !v.poBox ? [...v.issues, { field: 'line1', code: 'po_box_not_allowed' as const, message: 'We can’t deliver to PO boxes; use a street address' }] : v.issues;
    const changed = !sameAddress(found.address, address) || JSON.stringify(found.address) !== JSON.stringify(cleanAddress(address));
    return { ...v, issues, poBox, deliverable: v.deliverable && !poBox, suggestion: changed ? found.address : null };
  }

  /** Validated, cleaned address for saving: VALIDATION_FAILED for format problems, ADDRESS_UNDELIVERABLE outside the region */
  private async addressForSave(address: common.Address): Promise<common.Address> {
    const v = await this.validateAddress(address);
    const hard = hardIssues(v);
    if (hard.length) throw new AppError('VALIDATION_FAILED', hard[0]!.message, { issues: hard.map((i) => ({ path: `address.${i.field}`, ...i })) });
    if (!v.deliverable) {
      const why = v.issues.filter((i) => i.code === 'outside_service_region' || i.code === 'po_box_not_allowed');
      throw new AppError('ADDRESS_UNDELIVERABLE', why[0]?.message ?? 'We can’t deliver to this address', { issues: why.map((i) => ({ path: `address.${i.field}`, ...i })) });
    }
    return cleanAddress(address);
  }

  private static label(v: string | null | undefined) {
    const t = v?.replace(/\s+/g, ' ').trim();
    if (t && t.length > 40) throw invalid('label', 'Use at most 40 characters for the label');
    return t || null;
  }

  private static instructions(v: string | null | undefined) {
    const t = v?.trim();
    if (t && t.length > 500) throw invalid('deliveryInstructions', 'Use at most 500 characters for delivery instructions');
    return t || null;
  }

  private addressColumns(a: common.Address) {
    return { name: a.name, line1: a.line1, line2: a.line2 ?? null, city: a.city, region: a.region, postal_code: a.postalCode, country: a.country, phone: a.phone ?? null };
  }

  private async addAddress(c: CustomerRow, input: AddressInput, by: By): Promise<SavedAddress> {
    const address = await this.addressForSave(input.address);
    const label = CustomersService.label(input.label);
    const instructions = CustomersService.instructions(input.deliveryInstructions);
    const max = await this.ctx.settings.get('maxAddresses');
    const now = this.now();
    const row = await this.repo.transaction(async (repo) => {
      await repo.getCustomer(c.id, { forUpdate: true });
      const n = await repo.countAddresses(c.id);
      if (n >= max) throw new AppError('ADDRESS_LIMIT_REACHED', `You can save up to ${max} addresses. Remove one to add another.`, { max });
      const makeDefault = input.makeDefault === true || n === 0;
      if (makeDefault) await repo.clearDefaultAddress(c.id, now);
      const a = await repo.insertAddress({
        id: newId(),
        customer_id: c.id,
        label,
        ...this.addressColumns(address),
        delivery_instructions: instructions,
        is_default: makeDefault,
        validated_at: now,
        last_used_at: null,
        deleted_at: null,
        created_at: now,
        updated_at: now,
      });
      if (makeDefault) await repo.updateCustomer(c.id, { default_address_id: a.id, updated_at: now });
      return a;
    });
    this.ctx.events.publish('customers.address.saved', { customerId: c.id, addressId: row.id, isDefault: row.is_default }, this.meta(by));
    return map.savedAddress(row);
  }

  async createAddress(scope: Scope, body: AddressInput, by: By): Promise<SavedAddress> {
    return this.addAddress(await this.ownCustomer(scope), body, by);
  }

  async updateAddress(scope: Scope, id: string, body: AddressInput, by: By): Promise<SavedAddress> {
    const c = await this.ownCustomer(scope);
    if (!(await this.repo.getAddress(c.id, id))) throw notFound('Address');
    const address = await this.addressForSave(body.address);
    const label = CustomersService.label(body.label);
    const instructions = CustomersService.instructions(body.deliveryInstructions);
    const now = this.now();
    const row = await this.repo.transaction(async (repo) => {
      const a = await repo.getAddress(c.id, id, { forUpdate: true });
      if (!a) throw notFound('Address');
      if (body.makeDefault && !a.is_default) {
        await repo.clearDefaultAddress(c.id, now);
        await repo.updateCustomer(c.id, { default_address_id: a.id, updated_at: now });
      }
      return repo.updateAddress(a.id, {
        label,
        ...this.addressColumns(address),
        delivery_instructions: instructions,
        is_default: a.is_default || body.makeDefault === true,
        validated_at: now,
        updated_at: now,
      });
    });
    // accepted orders keep the copy made at checkout
    this.ctx.events.publish('customers.address.saved', { customerId: c.id, addressId: row.id, isDefault: row.is_default }, this.meta(by));
    return map.savedAddress(row);
  }

  async deleteAddress(scope: Scope, id: string): Promise<void> {
    const c = await this.ownCustomer(scope);
    const now = this.now();
    await this.repo.transaction(async (repo) => {
      const a = await repo.getAddress(c.id, id, { forUpdate: true });
      if (!a) throw notFound('Address');
      await repo.updateAddress(a.id, { deleted_at: now, is_default: false, updated_at: now });
      if (!a.is_default) return;
      // the most recently used remaining address becomes the default
      const rest = (await repo.listAddresses(c.id)).sort(
        (x, y) => (y.last_used_at?.getTime() ?? -1) - (x.last_used_at?.getTime() ?? -1) || y.created_at.getTime() - x.created_at.getTime(),
      );
      const next = rest[0];
      if (next) await repo.updateAddress(next.id, { is_default: true, updated_at: now });
      await repo.updateCustomer(c.id, { default_address_id: next?.id ?? null, updated_at: now });
    });
  }

  async makeDefaultAddress(scope: Scope, id: string): Promise<SavedAddress[]> {
    const c = await this.ownCustomer(scope);
    const now = this.now();
    await this.repo.transaction(async (repo) => {
      const a = await repo.getAddress(c.id, id, { forUpdate: true });
      if (!a) throw notFound('Address');
      if (a.is_default) return;
      await repo.clearDefaultAddress(c.id, now);
      await repo.updateAddress(a.id, { is_default: true, updated_at: now });
      await repo.updateCustomer(c.id, { default_address_id: a.id, updated_at: now });
    });
    return (await this.repo.listAddresses(c.id)).map(map.savedAddress);
  }

  /** Returns a copy of a saved address. Checkout stores that copy on the order; later edits never change it (plan ch. 7). */
  async getAddressForOrder(customerId: string, addressId: string): Promise<common.Address> {
    const a = isUuid(customerId) && isUuid(addressId) ? await this.repo.getAddress(customerId, addressId) : undefined;
    if (!a) throw notFound('Address');
    return { ...map.addressOf(a) };
  }

  /** Save an address entered at checkout when the customer ticks 'save to my addresses' (an identical saved address is reused) */
  async rememberCheckoutAddress(customerId: string, address: common.Address, label?: string): Promise<SavedAddress> {
    const c = isUuid(customerId) ? await this.repo.getCustomer(customerId) : undefined;
    if (!c) throw notFound('Customer');
    const same = (await this.repo.listAddresses(c.id)).find((a) => sameAddress(map.addressOf(a), address));
    if (same) {
      const l = CustomersService.label(label);
      if (!l || l === same.label) return map.savedAddress(same);
      return map.savedAddress(await this.repo.updateAddress(same.id, { label: l, updated_at: this.now() }));
    }
    return this.addAddress(c, { address, label: label ?? null, makeDefault: false }, { actor: { kind: 'customer', id: c.user_id } });
  }

  /* ================================================================ marketing consent */

  private defaultPrefs(customerId: string, at: Date): PreferencesRow {
    return {
      customer_id: customerId,
      email_promotions: false,
      sms_promotions: false,
      push_promotions: false,
      wishlist_alerts: false,
      personalized_recommendations: true,
      recent_searches: true,
      updated_at: at,
    };
  }

  private async prefsOf(c: CustomerRow): Promise<PreferencesRow> {
    return (await this.repo.getPreferences(c.id)) ?? this.defaultPrefs(c.id, c.created_at);
  }

  async getMarketingPreferences(scope: Scope): Promise<MarketingPreferences> {
    const c = await this.ownCustomer(scope);
    return map.preferences(await this.prefsOf(c), c.phone);
  }

  /** Promotional consent per channel plus the personalisation switches. Essential order messages ignore it. */
  async getMarketingConsent(customerId: string): Promise<MarketingPreferences> {
    if (!isUuid(customerId)) throw notFound('Customer');
    const [c, p] = await Promise.all([this.repo.getCustomer(customerId), this.repo.getPreferences(customerId)]);
    if (!c) throw notFound('Customer');
    return map.preferences(p ?? this.defaultPrefs(c.id, c.created_at), c.phone);
  }

  async updateMarketingPreferences(scope: Scope, body: MarketingPreferencesInput, by: By): Promise<MarketingPreferences> {
    const c = await this.ownCustomer(scope);
    const patch: Partial<Record<PrefKey, boolean>> = {};
    for (const k of Object.keys(PREFS) as PrefKey[]) if (typeof body[k] === 'boolean') patch[k] = body[k] as boolean;
    return this.changePreferences(c, patch, body.source ?? 'profile', { kind: 'customer', id: c.user_id, ip: by.ip ?? null }, by);
  }

  /** Only the fields sent change; every change is appended to the consent log */
  private async changePreferences(
    c: CustomerRow,
    patch: Partial<Record<PrefKey, boolean>>,
    source: string,
    who: { kind: string; id: string | null; ip?: string | null },
    by: By,
    publish = true,
  ): Promise<MarketingPreferences> {
    const now = this.now();
    const { prefs, changed } = await this.repo.transaction(async (repo) => {
      const cur = (await repo.getPreferences(c.id)) ?? this.defaultPrefs(c.id, c.created_at);
      const next: PreferencesRow = { ...cur };
      const rows: ConsentRow[] = [];
      for (const k of Object.keys(PREFS) as PrefKey[]) {
        const v = patch[k];
        const [col, channel] = PREFS[k];
        if (typeof v !== 'boolean' || cur[col] === v) continue;
        next[col] = v;
        rows.push({ id: newId(), customer_id: c.id, channel, granted: v, source, actor_kind: who.kind, actor_id: who.id, ip: who.ip ?? null, at: now });
      }
      if (!rows.length) return { prefs: cur, changed: false };
      next.updated_at = now;
      const saved = await repo.upsertPreferences(next);
      await repo.insertConsent(rows);
      return { prefs: saved, changed: true };
    });
    if (changed && publish) {
      this.ctx.events.publish(
        'customers.marketing_preferences.changed',
        {
          customerId: c.id,
          emailPromotions: prefs.email_promotions,
          smsPromotions: prefs.sms_promotions,
          pushPromotions: prefs.push_promotions,
          wishlistAlerts: prefs.wishlist_alerts,
          personalizedRecommendations: prefs.personalized_recommendations,
          recentSearches: prefs.recent_searches,
          source,
        },
        this.meta(by),
      );
    }
    return map.preferences(prefs, c.phone);
  }

  /** POST /api/public/customers/unsubscribe: one-click stop from an email or SMS link (token signed by notifications) */
  async unsubscribe(body: { token: string; channel?: 'email' | 'sms' | 'push' | 'all' | null }, by: By): Promise<MarketingPreferences> {
    const refuse = () => new AppError('UNSUBSCRIBE_TOKEN_INVALID', 'This unsubscribe link is invalid or has expired');
    const notifications = this.ctx.tryUse('notifications');
    if (!notifications || typeof body.token !== 'string' || !body.token) throw refuse();
    const t = await notifications.verifyUnsubscribeToken(body.token);
    if (!t || t.audience !== 'customer' || !t.accountId) throw refuse();
    const c = await this.repo.getCustomerByUserId(t.accountId);
    if (!c) throw refuse();
    const channel = body.channel ?? t.channel;
    const patch: Partial<Record<PrefKey, boolean>> =
      channel === 'all' ? { ...PROMOTIONAL_OFF } : channel === 'sms' ? { smsPromotions: false } : channel === 'push' ? { pushPromotions: false } : { emailPromotions: false };
    return this.changePreferences(c, patch, 'unsubscribe_link', { kind: 'customer', id: c.user_id, ip: by.ip ?? null }, by);
  }

  /* ================================================================ recently viewed */

  private ownerOf(owner: { customerId?: string; guestSessionId?: string }): ViewOwner | null {
    if (owner?.customerId) return { kind: 'customer', id: owner.customerId };
    if (owner?.guestSessionId) return { kind: 'guest', id: owner.guestSessionId };
    return null;
  }

  /** The list owner of a shopper request: the account for customers, the visitor (guest) session otherwise */
  private async viewerOf(scope: Scope): Promise<{ owner: ViewOwner; customer?: CustomerRow }> {
    if (scope.kind === 'visitor') return { owner: { kind: 'guest', id: scope.visitorSessionId } };
    const c = await this.ownCustomer(scope);
    return { owner: { kind: 'customer', id: c.id }, customer: c };
  }

  private async viewLimit(limit: number | undefined) {
    const [shown, retained] = await Promise.all([this.ctx.settings.get('recentlyViewedShown'), this.ctx.settings.get('recentlyViewedRetained')]);
    return Math.min(Math.max(Math.floor(limit ?? shown) || shown, 1), retained);
  }

  /** Product ids, newest first, for recommendations and the phase-3 wishlist */
  async listRecentlyViewed(owner: { customerId?: string; guestSessionId?: string }, limit: number): Promise<string[]> {
    const o = this.ownerOf(owner);
    if (!o) return [];
    return (await this.repo.listViews(o, await this.viewLimit(limit))).map((r) => r.product_id);
  }

  /** Recently viewed rows with the title and image snapshot and availability (same rows as GET /recently-viewed) */
  async listRecentlyViewedItems(owner: { customerId?: string; guestSessionId?: string }, limit: number): Promise<RecentlyViewedItem[]> {
    const o = this.ownerOf(owner);
    if (!o) return [];
    return this.viewItems(await this.repo.listViews(o, await this.viewLimit(limit)));
  }

  async listRecentlyViewedFor(scope: Scope, limit?: number): Promise<RecentlyViewedItem[]> {
    const { owner } = await this.viewerOf(scope);
    return this.viewItems(await this.repo.listViews(owner, await this.viewLimit(limit)));
  }

  /** Price and availability from offers and catalog when they are enabled */
  private async viewItems(rows: ViewRow[]): Promise<RecentlyViewedItem[]> {
    if (!rows.length) return [];
    const catalog = this.ctx.tryUse('catalog');
    const offers = this.ctx.tryUse('offers');
    const media = this.ctx.tryUse('media');
    const imageIds = [...new Set(rows.map((r) => r.image_media_id).filter((x): x is string => !!x))];
    const [products, featured, refs] = await Promise.all([
      this.soft('catalog products', catalog && (() => Promise.all(rows.map((r) => catalog.getProduct(r.product_id))))),
      this.soft('featured offers', offers && (() => offers.getFeaturedOfferForProduct(rows.map((r) => ({ productId: r.product_id, ...(r.variant_id ? { variantId: r.variant_id } : {}) }))))),
      this.soft('media refs', media && imageIds.length ? () => media.refs(imageIds, 'small') : undefined),
    ]);
    const images = new Map((refs ?? []).map((m) => [m.id, m]));
    return rows.map((r, i) => {
      const product = products?.[i];
      const offer = featured ? (featured[r.product_id] ?? null) : undefined;
      const hidden = products !== undefined && product === null;
      const noOffer = offer === null;
      return {
        productId: r.product_id,
        variantId: r.variant_id,
        slug: product?.slug ?? null,
        title: r.title || product?.title || '',
        image: (r.image_media_id ? images.get(r.image_media_id) : undefined) ?? product?.images?.[0] ?? null,
        price: offer?.price ?? null,
        wasPrice: offer?.compareAt?.verified ? offer.compareAt.amount : null,
        available: !hidden && !noOffer,
        viewedAt: map.iso(r.viewed_at),
      };
    });
  }

  /** Product for GraphQL RecentlyViewedItem.product (null when hidden, suspended or catalog is off) */
  async productOf(productId: string): Promise<unknown> {
    const catalog = this.ctx.tryUse('catalog');
    return (await this.soft('catalog product', catalog && (() => catalog.getProduct(productId)))) ?? null;
  }

  async recordView(scope: Scope, body: { productId: string; variantId?: string | null }): Promise<void> {
    const { owner, customer } = await this.viewerOf(scope);
    if (customer && !(await this.prefsOf(customer)).personalized_recommendations) return; // switched off: nothing is recorded
    let title = '';
    let image: string | null = null;
    const catalog = this.ctx.tryUse('catalog');
    if (catalog) {
      const p = await catalog.getProduct(body.productId);
      if (!p) throw notFound('Product');
      title = p.title;
      image = p.images?.[0]?.id ?? null;
    }
    await this.repo.upsertView({
      id: newId(),
      owner_kind: owner.kind,
      owner_id: owner.id,
      product_id: body.productId,
      variant_id: body.variantId ?? null,
      title,
      image_media_id: image,
      viewed_at: this.now(),
    });
    await this.repo.trimViews(owner, await this.ctx.settings.get('recentlyViewedRetained'));
  }

  async clearViews(scope: Scope): Promise<void> {
    await this.repo.deleteViews((await this.viewerOf(scope)).owner);
  }

  async removeView(scope: Scope, productId: string): Promise<void> {
    await this.repo.deleteViews((await this.viewerOf(scope)).owner, productId);
  }

  /* ================================================================ account overview */

  /** One source of the aggregate: answers within the budget, or is listed in `unavailable` */
  private async gather<T>(key: string, missing: string[], budgetMs: number, call: (() => Promise<T>) | undefined): Promise<T | undefined> {
    if (!call) {
      missing.push(key);
      return undefined;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        call(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`no answer within ${budgetMs} ms`)), budgetMs);
        }),
      ]);
    } catch (err) {
      if (!isNotImplemented(err)) this.ctx.log.warn({ err, source: key }, 'customers: overview source unavailable');
      missing.push(key);
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  async getAccountOverview(scope: Scope): Promise<AccountOverview> {
    const c = await this.ownCustomer(scope);
    const budget = await this.ctx.settings.get('overviewSourceTimeoutMs');
    const missing: string[] = [];
    const orders = this.ctx.tryUse('orders');
    const returns = this.ctx.tryUse('returns');
    const messaging = this.ctx.tryUse('messaging');
    const support = this.ctx.tryUse('support');
    const wallet = this.ctx.tryUse('wallet');
    const [progress, recent, delayed, openReturns, unread, cases, credit] = await Promise.all([
      this.gather('orders_in_progress', missing, budget, orders && (() => orders.countInProgress(c.id))),
      this.gather('recent_orders', missing, budget, orders && (() => orders.listRecentForCustomer(c.id, 3))),
      this.gather('delay_alerts', missing, budget, orders && (() => orders.listDelayedItemsForCustomer(c.id))),
      this.gather('open_returns', missing, budget, returns && (() => returns.listOpenForCustomer(c.id, 2))),
      this.gather('unread_messages', missing, budget, messaging && (() => messaging.unreadCount({ kind: 'customer', id: c.id }))),
      this.gather('open_cases', missing, budget, support && (() => support.listOpenCasesForCustomer(c.id, 3))),
      this.gather('store_credit', missing, budget, wallet && (() => wallet.getBalance(c.id))),
    ]);

    const tiles: OverviewTile[] = [
      {
        key: 'orders_in_progress',
        count: progress?.inProgress ?? null,
        note: progress?.delayedPackages ? `${plural(progress.delayedPackages, 'package')} delayed` : null,
        available: progress !== undefined,
      },
      { key: 'open_returns', count: openReturns?.total ?? null, available: openReturns !== undefined },
      { key: 'unread_messages', count: unread ?? null, available: unread !== undefined },
      { key: 'store_credit', amount: credit?.available ?? null, available: credit !== undefined },
    ];

    const alerts: OverviewAlert[] = [];
    for (const d of delayed ?? []) {
      alerts.push({
        kind: 'item_delayed',
        title: `${d.title} is delayed`,
        body: `${d.sellerName} needs more time${d.newDispatchBy ? `; it should ship by ${dateInZone(new Date(d.newDispatchBy), this.tz)}` : ''}.`,
        orderId: d.orderId,
        orderRef: d.orderRef,
        caseRef: d.caseRef ?? null,
        actions: d.options,
      });
    }
    for (const o of recent ?? []) {
      if (o.status?.flags?.includes('payment_checking')) {
        alerts.push({ kind: 'payment_being_checked', title: 'We’re checking your payment', body: `Order ${o.ref} starts as soon as the payment is confirmed.`, orderId: o.id, orderRef: o.ref, actions: ['wait'] });
      }
    }
    for (const k of cases?.items ?? []) {
      if (k.nextAction?.youNeedToAct) {
        alerts.push({ kind: 'case_waiting_on_you', title: `Case ${k.ref} is waiting on you`, body: k.nextAction.label, caseRef: k.ref, orderRef: k.orderRef ?? null, orderId: k.orderId ?? null, actions: ['view_case'] });
      }
    }

    const menuCounts: Record<string, number> = {};
    if (progress) menuCounts['account/orders'] = progress.inProgress;
    if (openReturns) menuCounts['account/returns'] = openReturns.total;
    if (unread !== undefined) menuCounts['account/messages'] = unread;

    return {
      customer: { firstName: c.first_name, displayName: displayName(c.first_name, c.last_name), email: c.email, memberSince: dateInZone(c.created_at, this.tz) },
      tiles,
      alerts,
      recentOrders: (recent ?? []).slice(0, 3).map((o) => {
        const itemStates: Record<string, number> = {};
        for (const p of o.packages ?? []) itemStates[p.status] = (itemStates[p.status] ?? 0) + 1;
        return { orderId: o.id, ref: o.ref, placedAt: o.placedAt, total: o.total, statusLabel: o.statusLabel, packageCount: o.packageCount, thumbnails: o.thumbnails ?? [], itemStates };
      }),
      openCases: (cases?.items ?? []).slice(0, 3).map((k) => ({
        caseId: k.id,
        ref: k.ref,
        subject: k.subject,
        statusLabel: k.statusLabel,
        handledBy: k.handledBy?.name ?? null,
        nextUpdateBy: k.nextAction?.due?.dueAt ?? null,
        orderRef: k.orderRef ?? null,
        sellerName: k.handledBy?.kind === 'seller' ? k.handledBy.name : null,
      })),
      openReturns: (openReturns?.items ?? []).slice(0, 2).map((r) => ({
        returnId: r.id,
        ref: r.ref,
        productTitle: r.item?.title ?? '',
        image: null,
        returnStatus: r.statusLabel,
        refundStatus: r.refundStatus ?? 'Requested',
      })),
      menuCounts,
      unavailable: [...new Set(missing)],
      generatedAt: map.iso(this.now()),
    };
  }

  /* ================================================================ closure obligations */

  /** Open orders, returns, pending refunds, cases and store credit. A module that does not answer fails the check (closing is irreversible). */
  async obligations(customerId: string): Promise<ClosureBlocker[]> {
    const orders = this.ctx.tryUse('orders');
    const returns = this.ctx.tryUse('returns');
    const support = this.ctx.tryUse('support');
    const wallet = this.ctx.tryUse('wallet');
    const [o, r, s, w] = await Promise.all([
      orders?.countInProgress(customerId),
      returns?.listOpenForCustomer(customerId, 50),
      support?.listOpenCasesForCustomer(customerId, 1),
      wallet?.getBalance(customerId),
    ]);
    const out: ClosureBlocker[] = [];
    if (o && o.inProgress > 0) out.push(blocker('open_orders', o.inProgress));
    if (r && r.total > 0) out.push(blocker('open_returns', r.total));
    const pending = (r?.items ?? []).filter((x) => isPendingRefund(x.refundStatus)).length;
    if (pending > 0) out.push(blocker('pending_refunds', pending));
    if (s && s.total > 0) out.push(blocker('open_cases', s.total));
    if (w && w.available.amount > 0) out.push(blocker('store_credit_balance', 1, `${formatMoney(w.available)} store credit left on the account`));
    return out;
  }

  async getClosureEligibility(scope: Scope): Promise<ClosureEligibility> {
    const c = await this.ownCustomer(scope);
    const blockers = await this.obligations(c.id);
    return { eligible: blockers.length === 0 && c.account_status !== 'closed', blockers, retainedRecords: RETAINED_RECORDS };
  }

  /* ================================================================ data requests (customer) */

  async requestDataExport(scope: Scope, by: By): Promise<DataRequest> {
    const c = await this.ownCustomer(scope);
    const now = this.now();
    const sla = await this.ctx.settings.get('dataExportSlaHours');
    const row = await this.repo.transaction(async (repo) => {
      await repo.getCustomer(c.id, { forUpdate: true });
      if (await repo.openDataRequest(c.id, 'export')) throw new AppError('DATA_REQUEST_IN_PROGRESS', 'A copy of your data is already being prepared');
      if ((await repo.countExportsSince(c.id, new Date(now.getTime() - DAY))) >= EXPORTS_PER_DAY) {
        throw new AppError('RATE_LIMITED', `You can request your data ${EXPORTS_PER_DAY} times a day; try again tomorrow`);
      }
      return repo.insertDataRequest(this.newRequest(c.id, 'export', now, new Date(now.getTime() + sla * HOUR)));
    });
    this.ctx.events.publish('customers.data_export.requested', { customerId: c.id, requestId: row.id }, this.meta(by));
    return map.dataRequest(row);
  }

  private newRequest(customerId: string, kind: 'export' | 'closure', now: Date, dueBy: Date, scheduledFor: Date | null = null): DataRequestRow {
    return {
      id: newId(),
      customer_id: customerId,
      kind,
      state: dataRequestMachine.initial,
      requested_at: now,
      due_by: dueBy,
      file_media_id: null,
      ready_at: null,
      expires_at: null,
      scheduled_for: scheduledFor,
      completed_at: null,
      cancelled_at: null,
      failure: null,
    };
  }

  /** The customer's requests; ready exports carry a fresh signed link */
  async listDataRequests(scope: Scope, principal: Principal | null): Promise<DataRequest[]> {
    const c = await this.ownCustomer(scope);
    return this.dataRequestsOf(c.id, principal);
  }

  /** Data requests newest first; `principal` (the customer) gets download links for ready exports */
  async dataRequestsOf(customerId: string, principal: Principal | null): Promise<DataRequest[]> {
    const rows = await this.repo.listDataRequests(customerId);
    const media = principal ? this.ctx.tryUse('media') : undefined;
    return Promise.all(
      rows.map(async (r) => {
        const url =
          r.state === 'ready' && r.file_media_id && media && principal
            ? (await this.soft('export link', () => media.signedDownload(r.file_media_id!, principal as identity.Principal, 'Personal data export')))?.url
            : null;
        return map.dataRequest(r, url ?? null);
      }),
    );
  }

  async requestClosure(scope: Scope, body: { reason?: string | null }, by: By): Promise<DataRequest> {
    const c = await this.ownCustomer(scope);
    if (c.account_status === 'closed') throw new AppError('ILLEGAL_TRANSITION', 'This account is already closed', { from: 'closed', event: 'close' });
    if (await this.repo.openDataRequest(c.id, 'closure')) throw new AppError('DATA_REQUEST_IN_PROGRESS', 'Your account is already scheduled to close');
    const blockers = await this.obligations(c.id);
    if (blockers.length) throw new AppError('CLOSURE_BLOCKED', 'Finish your open orders, returns and cases before closing your account', { blockers });
    const days = await this.ctx.settings.get('closureCoolingOffDays');
    const now = this.now();
    const scheduled = new Date(now.getTime() + days * DAY);
    const row = await this.repo.transaction(async (repo) => {
      await repo.getCustomer(c.id, { forUpdate: true });
      if (await repo.openDataRequest(c.id, 'closure')) throw new AppError('DATA_REQUEST_IN_PROGRESS', 'Your account is already scheduled to close');
      return repo.insertDataRequest(this.newRequest(c.id, 'closure', now, scheduled, scheduled));
    });
    this.ctx.events.publish('customers.closure.requested', { customerId: c.id, requestId: row.id, scheduledFor: map.iso(scheduled) }, this.meta(by));
    await this.audit(
      {
        action: 'customers.closure.request',
        actionLabel: 'Requested account closure',
        category: 'customers',
        target: this.target(c),
        reason: body.reason?.trim() || null,
        after: { requestId: row.id, scheduledFor: map.iso(scheduled) },
      },
      by,
    );
    return map.dataRequest(row);
  }

  async cancelDataRequest(scope: Scope, id: string, by: By): Promise<DataRequest> {
    const c = await this.ownCustomer(scope);
    const row = await this.repo.transaction(async (repo) => {
      const r = await repo.getDataRequest(id, { customerId: c.id, forUpdate: true });
      if (!r) throw notFound('Request');
      const state = dataRequestMachine.next(r.state as never, 'cancel');
      return repo.updateDataRequest(r.id, { state, cancelled_at: this.now() });
    });
    if (row.kind === 'closure') {
      await this.audit({ action: 'customers.closure.cancel', actionLabel: 'Cancelled account closure', category: 'customers', target: this.target(c), after: { requestId: row.id } }, by);
    }
    return map.dataRequest(row);
  }

  /* ================================================================ guest orders */

  private emailHash(email: string) {
    return createHmac('sha256', secretFor(this.ctx.config, 'customers.guest-lookup')).update(normalizeEmail(email)).digest('hex');
  }

  /** Per IP and per email, guestLookupAttemptsPerHour */
  private async limitLookups(emailHash: string, ip: string) {
    const limit = await this.ctx.settings.get('guestLookupAttemptsPerHour');
    const since = new Date(this.now().getTime() - HOUR);
    const [byEmail, byIp] = await Promise.all([this.repo.countLookupAttempts({ emailHash }, since), this.repo.countLookupAttempts({ ip }, since)]);
    if (byEmail >= limit || byIp >= limit) throw new AppError('RATE_LIMITED', 'Too many lookups; try again in an hour', { retryAfterSeconds: 3600 });
  }

  async lookupGuestOrder(principal: Principal, body: { orderRef: string; email: string }, ip: string): Promise<GuestOrderAccess> {
    const email = normalizeEmail(body.email);
    const hash = this.emailHash(email);
    await this.limitLookups(hash, ip);
    const orders = this.ctx.tryUse('orders');
    const ref = body.orderRef.trim().toUpperCase();
    const found = orders && ref ? await orders.findGuestOrder(ref, email) : null;
    const guestSessionId = principal.kind === 'visitor' && isUuid(principal.sessionId) ? principal.sessionId : null;
    await this.repo.insertLookupAttempt({ id: newId(), email_hash: hash, ip, guest_session_id: guestSessionId, succeeded: !!found, order_id: found?.orderId ?? null, at: this.now() });
    // the same answer whichever part was wrong
    if (!found) throw new AppError('GUEST_ORDER_NOT_FOUND', 'No order matches that order number and email');
    const identityApi = this.ctx.use('identity');
    let granted = false;
    let accessUntil = map.iso(this.now());
    if (guestSessionId) {
      const session = await identityApi.grantGuestOrderAccess(guestSessionId, found.orderId, email, 'lookup');
      granted = true;
      accessUntil = session.expiresAt;
    }
    const member = await identityApi.findAccountByEmail(email, 'member');
    return { orderId: found.orderId, orderRef: ref, granted, accessUntil, canCreateAccount: !member };
  }

  /** Always answers 202 so it cannot be used to probe which emails have orders */
  async sendGuestOrderLinks(body: { email: string }, ip: string): Promise<void> {
    const email = normalizeEmail(body.email);
    const hash = this.emailHash(email);
    await this.limitLookups(hash, ip);
    try {
      const orders = this.ctx.tryUse('orders');
      const list = orders ? await orders.listGuestOrdersByEmail(email) : [];
      await this.repo.insertLookupAttempt({ id: newId(), email_hash: hash, ip, guest_session_id: null, succeeded: list.length > 0, order_id: null, at: this.now() });
      if (!list.length) return;
      const identityApi = this.ctx.use('identity');
      const recent = [...list].sort((a, b) => b.placedAt.localeCompare(a.placedAt)).slice(0, 20);
      const links = await Promise.all(recent.map(async (o) => ({ ...o, ...(await identityApi.issueOrderLink(o.orderId, email)) })));
      const first = links[0]!;
      await this.ctx.tryUse('notifications')?.notify({
        topic: 'customer.order.guest_link',
        recipients: [{ kind: 'guest_email', email }],
        context: { order: { ref: first.ref }, guest: { url: first.url }, orders: links.map((l) => ({ ref: l.ref, url: l.url, placedAt: l.placedAt, expiresAt: l.expiresAt })) },
        link: { kind: 'order', id: first.orderId, ref: first.ref, label: 'Open order', screen: 'account/order', url: first.url },
        dedupeKey: `guest-links:${hash}:${Math.floor(this.now().getTime() / (10 * 60_000))}`,
      });
    } catch (err) {
      this.ctx.log.warn({ err }, 'customers: guest order links not sent');
    }
  }

  /* ================================================================ admin: lists and detail */

  private dateFrom(d?: string) {
    return d ? zonedTimeToUtc(d, '00:00', this.tz) : undefined;
  }
  private dateTo(d?: string) {
    return d ? zonedTimeToUtc(addDays(d, 1), '00:00', this.tz) : undefined;
  }

  async listGuestBuyers(query: { q?: string; orderedFrom?: string; orderedTo?: string }, page: PageRequest): Promise<common.Page<GuestBuyerRow>> {
    const p = await this.repo.listGuestBuyers({ q: query.q, orderedFrom: this.dateFrom(query.orderedFrom), orderedTo: this.dateTo(query.orderedTo) }, page);
    // support keeps no guest-buyer lookup, so open cases stay unknown (null) for guests
    return { ...p, items: p.items.map((g) => map.guestBuyer(g, null)) };
  }

  /** Customer ids an order reference resolves to (orders) */
  private async idsForQuery(q: string | undefined): Promise<string[]> {
    const ref = q?.trim();
    if (!ref || !/^MK-/i.test(ref)) return [];
    const orders = this.ctx.tryUse('orders');
    const order = await this.soft('order lookup', orders && (() => orders.getOrderAdmin(ref.toUpperCase())));
    const id = order?.order?.contact?.customerId;
    return id ? [id] : [];
  }

  async listCustomersAdmin(
    query: { q?: string; status?: string; verification?: string; hasOpenCases?: boolean; hasAbuseReports?: boolean; joinedFrom?: string; joinedTo?: string; sort?: 'newest' | 'spend' | 'orders' | 'name' },
    page: PageRequest,
  ): Promise<common.Page<AdminCustomerRow>> {
    // open cases and abuse reports live in support and trust: their id sets filter the query before paging
    const { onlyIds, excludeIds } = await this.crossModuleFilter(query);
    const p = await this.repo.searchCustomers(
      {
        q: query.q,
        extraIds: await this.idsForQuery(query.q),
        onlyIds,
        excludeIds,
        statuses: query.status ? [query.status] : undefined,
        verification: query.verification,
        joinedFrom: this.dateFrom(query.joinedFrom),
        joinedTo: this.dateTo(query.joinedTo),
        sort: query.sort,
      },
      page,
    );
    return { ...p, items: await this.adminRows(p.items) };
  }

  /**
   * hasOpenCases / hasAbuseReports as id sets from support and trust (true: only those customers, false: all but them).
   * A filter whose source module is off is refused rather than ignored.
   */
  private async crossModuleFilter(query: { hasOpenCases?: boolean; hasAbuseReports?: boolean }): Promise<{ onlyIds?: string[]; excludeIds?: string[] }> {
    const wanted: { key: 'hasOpenCases' | 'hasAbuseReports'; value: boolean; ids: () => Promise<string[]> | undefined; source: string }[] = [];
    const support = this.ctx.tryUse('support');
    const trust = this.ctx.tryUse('trust');
    if (query.hasOpenCases !== undefined) wanted.push({ key: 'hasOpenCases', value: query.hasOpenCases, source: 'support', ids: () => support?.customerIdsWithOpenCases({}) });
    if (query.hasAbuseReports !== undefined) wanted.push({ key: 'hasAbuseReports', value: query.hasAbuseReports, source: 'trust', ids: () => trust?.subjectIdsWithReports('customer', { role: 'against' }) });
    const unavailable = wanted.filter((w) => (w.source === 'support' ? !support : !trust));
    if (unavailable.length) {
      const message = `This filter is not available right now (${unavailable.map((w) => w.source).join(', ')} is off)`;
      throw new AppError('VALIDATION_FAILED', message, { issues: unavailable.map((w) => ({ path: w.key, message })), unavailable: unavailable.map((w) => w.source) });
    }
    let onlyIds: string[] | undefined;
    const excludeIds: string[] = [];
    for (const w of wanted) {
      const ids = (await w.ids()) ?? [];
      if (!w.value) excludeIds.push(...ids);
      else onlyIds = onlyIds ? onlyIds.filter((id) => ids.includes(id)) : [...new Set(ids)];
    }
    return { onlyIds, excludeIds: excludeIds.length ? [...new Set(excludeIds)] : undefined };
  }

  private async adminRows(rows: CustomerRow[]): Promise<AdminCustomerRow[]> {
    const support = this.ctx.tryUse('support');
    const trust = this.ctx.tryUse('trust');
    const ids = rows.map((r) => r.id);
    const [defaults, cases, reportsAbout] = await Promise.all([
      this.repo.defaultAddresses(ids),
      Promise.all(rows.map((r) => this.soft('open cases', support && (() => support.listOpenCasesForCustomer(r.id, 1))))),
      Promise.all(rows.map((r) => this.soft('trust reports', trust && (() => trust.reportsAbout('customer', r.id))))),
    ]);
    const byCustomer = new Map(defaults.map((a) => [a.customer_id, a]));
    return rows.map((r, i) => ({
      id: r.id,
      ref: r.ref,
      name: displayName(r.first_name, r.last_name),
      email: r.email,
      location: map.location(byCustomer.get(r.id)),
      orderCount: r.order_count,
      totalSpend: { amount: Number(r.total_spend_minor), currency: r.currency },
      openCases: cases[i]?.total ?? 0,
      accountStatus: map.status(r),
      verification: verificationOf(r.email_verified_at, r.phone_verified_at),
      abuseReports: reportsAbout[i]?.against ?? 0,
      joinedAt: map.iso(r.created_at),
    }));
  }

  /** Admin customer list with the same filters as GET /api/admin/customers/customers */
  async searchCustomers(
    filter: { search?: string; statuses?: string[]; verification?: string; joinedFrom?: string; joinedTo?: string },
    page: common.PageInput,
  ): Promise<common.Page<CustomerSnapshot>> {
    const p = await this.searchStandings(filter, page);
    return { ...p, items: p.items.map(map.snapshot) };
  }

  async searchStandings(
    filter: { search?: string; statuses?: string[]; verification?: string; joinedFrom?: string; joinedTo?: string } | null | undefined,
    page: common.PageInput | null | undefined,
  ): Promise<common.Page<CustomerStanding>> {
    const f = filter ?? {};
    const p = await this.repo.searchCustomers(
      {
        q: f.search,
        extraIds: await this.idsForQuery(f.search),
        statuses: f.statuses?.map((s) => s.toLowerCase()),
        verification: f.verification?.toLowerCase(),
        joinedFrom: this.dateFrom(f.joinedFrom),
        joinedTo: this.dateTo(f.joinedTo),
      },
      toPageRequest(page ?? undefined),
    );
    const standings = new Map((await this.repo.standings(p.items.map((r) => r.id), this.now())).map((s) => [s.row.id, s]));
    return { ...p, items: p.items.map((r) => standings.get(r.id)).filter((s): s is CustomerStanding => !!s) };
  }

  /** Export rows for reports dataset customers.admin.accounts (the filtered customer list) */
  async exportRows(dataset: string, filters: unknown, _principal: identity.Principal, cursor?: string): Promise<{ rows: unknown[]; nextCursor?: string }> {
    if (dataset !== DATASET) throw new AppError('VALIDATION_FAILED', `Unknown dataset ${dataset}`, { issues: [{ path: 'dataset', message: 'not a customers dataset' }] });
    const f = (filters && typeof filters === 'object' ? filters : {}) as Record<string, unknown>;
    const str = (k: string) => (typeof f[k] === 'string' && f[k] ? (f[k] as string) : undefined);
    const sort = str('sort');
    const p = await this.repo.searchCustomers(
      {
        q: str('q'),
        extraIds: await this.idsForQuery(str('q')),
        statuses: str('status') ? [str('status')!] : undefined,
        verification: str('verification'),
        joinedFrom: this.dateFrom(str('joinedFrom')),
        joinedTo: this.dateTo(str('joinedTo')),
        sort: sort === 'spend' || sort === 'orders' || sort === 'name' ? sort : 'newest',
      },
      { mode: 'cursor', cursor: cursor ?? null, limit: 100 },
    );
    const rows = await this.adminRows(p.items);
    const phones = new Map(p.items.map((r) => [r.id, r.phone]));
    return {
      rows: rows.map((r) => ({
        ref: r.ref,
        name: r.name,
        email: r.email,
        phone: phones.get(r.id) ?? null,
        location: r.location ?? null,
        accountStatus: r.accountStatus,
        verification: r.verification,
        orderCount: r.orderCount,
        totalSpend: formatMoney(r.totalSpend),
        openCases: r.openCases,
        abuseReports: r.abuseReports,
        joinedAt: r.joinedAt,
      })),
      ...(p.nextCursor ? { nextCursor: p.nextCursor } : {}),
    };
  }

  /** reports reads the rows through exportRows; the dataset is registered once per process */
  registerDataset(): Promise<void> | undefined {
    const api = this.ctx.tryUse('reports');
    if (!api) return undefined;
    this.#datasetRegistered ??= api
      .registerDataset({
        key: DATASET,
        owner: 'customers',
        title: 'Customer accounts',
        permission: 'customers.accounts.export',
        audience: 'staff',
        screens: ['admin/customers'],
        available: true,
        phase: 1,
        columns: [
          { key: 'ref', label: 'Customer' },
          { key: 'name', label: 'Name' },
          { key: 'email', label: 'Email', permission: 'customers.accounts.export' },
          { key: 'phone', label: 'Phone', permission: 'customers.accounts.export' },
          { key: 'location', label: 'Location' },
          { key: 'accountStatus', label: 'Status' },
          { key: 'verification', label: 'Verification' },
          { key: 'orderCount', label: 'Orders' },
          { key: 'totalSpend', label: 'Spend' },
          { key: 'openCases', label: 'Open cases' },
          { key: 'abuseReports', label: 'Abuse reports' },
          { key: 'joinedAt', label: 'Joined' },
        ],
      })
      .catch((err) => {
        this.#datasetRegistered = undefined;
        if (!isNotImplemented(err)) throw err; // reports not built yet: requestExport answers for it
      });
    return this.#datasetRegistered;
  }

  async exportCustomers(body: { filters?: unknown; format?: 'csv' | 'xlsx' | null }, by: StaffBy): Promise<reports.ExportJob> {
    const api = this.ctx.tryUse('reports');
    if (!api) throw new AppError('SERVICE_UNAVAILABLE', 'Exports are unavailable right now');
    await this.registerDataset();
    const filters = body.filters ?? {};
    await this.audit(
      {
        action: 'customers.accounts.export',
        actionLabel: 'Exported the customer list',
        category: 'customers',
        target: { type: 'export', id: DATASET, label: `Customer accounts (${(body.format ?? 'csv').toUpperCase()})`, screen: 'admin/customers' },
        after: { filters, format: body.format ?? 'csv' },
      },
      by,
    );
    return api.requestExport({ dataset: DATASET, filters, format: body.format ?? 'csv', principal: by.principal as identity.Principal });
  }

  async getCustomerAdmin(id: string, by: StaffBy): Promise<AdminCustomerDetail> {
    const c = await this.repo.getCustomer(id);
    if (!c) throw notFound('Customer');
    const missing: string[] = [];
    const budget = Math.max(await this.ctx.settings.get('overviewSourceTimeoutMs'), 1000);
    const identityApi = this.ctx.use('identity');
    const orders = this.ctx.tryUse('orders');
    const support = this.ctx.tryUse('support');
    const messaging = this.ctx.tryUse('messaging');
    const trust = this.ctx.tryUse('trust');
    const [addresses, prefs, restrictions, notes, actions, requests, security, recent, cases, conversations, abuse] = await Promise.all([
      this.repo.listAddresses(c.id),
      this.prefsOf(c),
      this.repo.listRestrictions(c.id),
      this.repo.listNotes(c.id),
      this.repo.recentActions(c.id, 20),
      this.repo.listDataRequests(c.id),
      this.gather('sign_in', missing, budget, () => identityApi.accountSecurityOf([c.user_id], { activityLimit: 1 })),
      this.gather('orders', missing, budget, orders && (() => orders.listRecentForCustomer(c.id, 3))),
      this.gather('open_cases', missing, budget, support && (() => support.listOpenCasesForCustomer(c.id, 10))),
      this.gather('messages', missing, budget, messaging && (() => messaging.customerConversationSummaries([c.id]))),
      this.gather('abuse_reports', missing, budget, trust && (() => trust.reportsAbout('customer', c.id))),
    ]);
    const sec = security?.get(c.user_id) as { signInSummary?: string; twoStep?: { enabled?: boolean }; lastSignInAt?: string | null } | undefined;
    const conv = conversations?.[c.id];
    const counterparty = (conv?.counterparties?.[0] ?? null) as { name?: string } | null;
    const now = this.now();
    await this.audit({ action: 'customers.customer.view', actionLabel: 'Viewed customer account', category: 'customers', target: this.target(c) }, by);
    return {
      profile: map.profile(c, restrictions.filter((r) => map.inForce(r, now)), this.tz),
      defaultAddress: addresses.find((a) => a.is_default) ? map.savedAddress(addresses.find((a) => a.is_default)!) : null,
      addresses: addresses.map(map.savedAddress),
      signIn: sec ? { method: sec.signInSummary ?? null, twoStepEnabled: sec.twoStep?.enabled ?? false, lastSignInAt: sec.lastSignInAt ?? null } : null,
      marketing: map.preferences(prefs, c.phone),
      orders: {
        count: c.order_count,
        totalSpend: { amount: Number(c.total_spend_minor), currency: c.currency },
        recent: (recent ?? []).map((o) => {
          const itemStates: Record<string, number> = {};
          for (const p of o.packages ?? []) itemStates[p.status] = (itemStates[p.status] ?? 0) + 1;
          return { orderId: o.id, ref: o.ref, placedAt: o.placedAt, total: o.total, statusLabel: o.statusLabel, packageCount: o.packageCount, thumbnails: o.thumbnails ?? [], itemStates };
        }),
      },
      openCases: (cases?.items ?? []).map((k) => ({
        caseId: k.id,
        ref: k.ref,
        subject: k.subject,
        statusLabel: k.statusLabel,
        handledBy: k.handledBy?.name ?? null,
        nextUpdateBy: k.nextAction?.due?.dueAt ?? null,
        orderRef: k.orderRef ?? null,
        sellerName: k.handledBy?.kind === 'seller' ? k.handledBy.name : null,
      })),
      messages: { conversationCount: conv?.conversationCount ?? 0, lastMessageAt: conv?.lastMessageAt ?? null, lastCounterparty: counterparty?.name ?? null },
      abuseReports: { filedBy: abuse?.filedBy ?? 0, against: abuse?.against ?? 0, reportIds: abuse?.reportIds ?? [] },
      notes: notes.map(map.note),
      restrictions: restrictions.map(map.restriction),
      recentActions: actions.map(map.action),
      dataRequests: requests.map((r) => map.dataRequest(r)),
      unavailable: [...new Set(missing)],
    };
  }

  async addNote(customerId: string, body: { body: string }, by: StaffBy): Promise<CustomerNote> {
    const c = await this.repo.getCustomer(customerId);
    if (!c) throw notFound('Customer');
    const text = body.body?.trim();
    if (!text) throw invalid('body', 'Write the note');
    if (text.length > 5000) throw invalid('body', 'Use at most 5,000 characters');
    const authorId = by.actor.id ?? 'unknown';
    const author =
      by.actor.name ?? (isUuid(authorId) ? (await this.soft('author name', () => this.ctx.use('identity').getAccount(authorId)))?.displayName : undefined) ?? 'Staff';
    const row = await this.repo.insertNote({ id: newId(), customer_id: c.id, body: text, author_id: authorId, author_name: author, created_at: this.now() });
    await this.audit({ action: 'customers.note.add', actionLabel: 'Added an internal note', category: 'customers', target: this.target(c), afterText: text.slice(0, 200) }, by);
    return map.note(row);
  }

  async listAccountActions(customerId: string, page: PageRequest): Promise<common.Page<import('../../spec/customers.js').AccountActionRecord>> {
    if (!(await this.repo.getCustomer(customerId))) throw notFound('Customer');
    const p = await this.repo.listActions(customerId, page);
    return { ...p, items: p.items.map(map.action) };
  }

  async listDataRequestsAdmin(query: { kind?: 'export' | 'closure'; state?: string; overdue?: boolean }, page: PageRequest) {
    const p = await this.repo.searchDataRequests({ kind: query.kind, state: query.state, overdueAt: query.overdue ? this.now() : undefined }, page);
    return {
      ...p,
      items: p.items.map((r) => ({ request: map.dataRequest(r), customerId: r.customer_id, customerName: displayName(r.customer_first_name, r.customer_last_name) })),
    };
  }

  async retryDataRequest(id: string, by: StaffBy): Promise<DataRequest> {
    const row = await this.repo.transaction(async (repo) => {
      const r = await repo.getDataRequest(id, { forUpdate: true });
      if (!r) throw notFound('Request');
      const state = dataRequestMachine.next(r.state as never, 'retry');
      return repo.updateDataRequest(r.id, { state, failure: null });
    });
    const c = await this.repo.getCustomer(row.customer_id);
    await this.audit(
      { action: 'customers.data_request.retry', actionLabel: 'Retried a data export', category: 'customers', target: c ? this.target(c) : { type: 'customer', id: row.customer_id }, after: { requestId: row.id } },
      by,
    );
    return map.dataRequest(row);
  }

  /* ================================================================ admin: account actions */

  private actionRow(c: CustomerRow, a: { action: string; reasonCode: string; details: string; from: string | null; to: string | null; restrictionId?: string | null; actor: common.Actor; at: Date }): ActionRow {
    return {
      id: newId(),
      customer_id: c.id,
      action: a.action,
      reason_code: a.reasonCode,
      details: a.details,
      from_status: a.from,
      to_status: a.to,
      restriction_id: a.restrictionId ?? null,
      actor_kind: a.actor.kind,
      actor_id: a.actor.id ?? (a.actor.kind === 'system' ? 'system' : 'unknown'),
      at: a.at,
    };
  }

  /** Adds a scoped restriction inside a transaction; moves active / under_review accounts to restricted */
  private async addRestriction(
    repo: CustomersRepository,
    c: CustomerRow,
    r: { scope: RestrictionScope; reasonCode: ReasonCode; reason: string; endsAt: Date | null; appealRoute: string; appealDeadline: Date | null; setBy: common.Actor; trustReportId?: string | null; trustEnforcementId?: string | null },
    now: Date,
    opts: { keepSuspension: boolean },
  ): Promise<{ row: RestrictionRow; from: AccountStatus; to: AccountStatus }> {
    const from = map.status(c);
    let to = from;
    if (from !== 'restricted' && !(opts.keepSuspension && from === 'suspended')) to = customerAccountStatusMachine.next(from, 'restrict');
    const row = await repo.insertRestriction({
      id: newId(),
      customer_id: c.id,
      scope: r.scope,
      reason_code: r.reasonCode,
      reason: r.reason,
      still_works: stillWorksFor(r.scope),
      appeal_route: r.appealRoute,
      appeal_deadline: r.appealDeadline,
      starts_at: now,
      ends_at: r.endsAt,
      state: accountRestrictionMachine.initial,
      set_by_kind: r.setBy.kind,
      set_by_id: r.setBy.id ?? null,
      trust_report_id: r.trustReportId ?? null,
      trust_enforcement_id: r.trustEnforcementId ?? null,
      lifted_at: null,
      lift_reason: null,
    });
    if (to !== from) await repo.updateCustomer(c.id, { account_status: to, updated_at: now });
    return { row, from, to };
  }

  /** Lifts or expires a restriction inside a transaction; the last one returns a restricted account to active */
  private async endRestriction(
    repo: CustomersRepository,
    c: CustomerRow,
    r: RestrictionRow,
    event: 'lift' | 'expire',
    reason: string | null,
    now: Date,
  ): Promise<{ row: RestrictionRow; from: AccountStatus; to: AccountStatus }> {
    const state = accountRestrictionMachine.next(r.state as never, event);
    const row = await repo.updateRestriction(r.id, { state, lifted_at: event === 'lift' ? now : null, lift_reason: reason });
    const from = map.status(c);
    let to = from;
    if (from === 'restricted' && (await repo.countActiveRestrictions(c.id, now)) === 0) {
      to = customerAccountStatusMachine.next('restricted', 'liftLastRestriction');
      await repo.updateCustomer(c.id, { account_status: to, updated_at: now });
    }
    return { row, from, to };
  }

  private statusChanged(c: CustomerRow, from: string, to: string, reasonCode: string, by: By) {
    if (from !== to) this.ctx.events.publish('customers.account.status_changed', { customerId: c.id, from, to, reasonCode }, this.meta(by));
  }

  private restricted(c: CustomerRow, r: RestrictionRow, by: By) {
    this.ctx.events.publish(
      'customers.account.restricted',
      { customerId: c.id, restrictionId: r.id, scope: r.scope, endsAt: map.isoOrNull(r.ends_at), trustReportId: r.trust_report_id, trustEnforcementId: r.trust_enforcement_id },
      this.meta(by),
    );
  }

  private lifted(c: CustomerRow, r: RestrictionRow, by: By) {
    this.ctx.events.publish('customers.account.restriction_lifted', { customerId: c.id, restrictionId: r.id, scope: r.scope, trustEnforcementId: r.trust_enforcement_id }, this.meta(by));
  }

  async applyAccountAction(customerId: string, input: AccountActionInput, by: StaffBy): Promise<AccountActionResult> {
    const details = input.details?.trim();
    if (!details) throw invalid('details', 'Say what happened and what evidence you checked');
    if (!REASON_CODES.includes(input.reasonCode)) throw invalid('reasonCode', 'Choose a reason');
    const c = await this.repo.getCustomer(customerId);
    if (!c) throw notFound('Customer');
    const now = this.now();

    if (SECURITY_ACTIONS.includes(input.action)) return this.securityAction(c, input, details, by);
    if (input.action === 'close') return this.closeByStaff(c, input, details, by);

    const scope = RESTRICT_ACTIONS[input.action];
    let endsAt: Date | null = null;
    if (scope && input.endsAt) {
      endsAt = new Date(input.endsAt);
      if (endsAt <= now) throw invalid('endsAt', 'The end date must be in the future');
    }
    const out = await this.repo.transaction(async (repo) => {
      const cur = (await repo.getCustomer(c.id, { forUpdate: true }))!;
      if (scope) {
        const r = await this.addRestriction(
          repo,
          cur,
          {
            scope,
            reasonCode: input.reasonCode,
            reason: input.customerMessage?.trim() || customerMessageFor(scope, input.reasonCode),
            endsAt,
            appealRoute: STAFF_APPEAL_ROUTE,
            appealDeadline: null,
            setBy: by.actor,
            trustReportId: input.trustReportId ?? null,
          },
          now,
          { keepSuspension: false },
        );
        const action = await repo.insertAction(this.actionRow(cur, { action: 'restrict', reasonCode: input.reasonCode, details, from: r.from, to: r.to, restrictionId: r.row.id, actor: by.actor, at: now }));
        return { cur, from: r.from as string, to: r.to as string, steps: [[r.from, r.to]] as [string, string][], restriction: r.row, action };
      }
      const event = ({ mark_under_review: 'markUnderReview', clear_review: 'clearReview', suspend: 'suspend', reinstate: 'reinstate' } as const)[
        input.action as 'mark_under_review' | 'clear_review' | 'suspend' | 'reinstate'
      ];
      if (!event) throw invalid('action', 'Unknown account action');
      const from = map.status(cur);
      const steps: [string, string][] = [];
      let to = customerAccountStatusMachine.next(from, event);
      steps.push([from, to]);
      // a reinstated account with restrictions still in force is restricted, not active
      if (input.action === 'reinstate' && (await repo.countActiveRestrictions(cur.id, now)) > 0) {
        const next = customerAccountStatusMachine.next(to, 'restrict');
        steps.push([to, next]);
        to = next;
      }
      await repo.updateCustomer(cur.id, { account_status: to, updated_at: now });
      const action = await repo.insertAction(this.actionRow(cur, { action: input.action, reasonCode: input.reasonCode, details, from, to, actor: by.actor, at: now }));
      return { cur, from: from as string, to: to as string, steps, restriction: undefined, action };
    });

    for (const [f, t] of out.steps) this.statusChanged(c, f, t, input.reasonCode, by);
    if (out.restriction) this.restricted(c, out.restriction, by);
    await this.audit(
      {
        action: `customers.account.${out.action.action}`,
        actionLabel: ACTION_LABEL[out.action.action] ?? 'Account action',
        category: 'customers',
        target: this.target(c),
        reason: `${input.reasonCode}: ${details}`,
        before: { accountStatus: out.from },
        after: { accountStatus: out.to, ...(out.restriction ? { restrictionId: out.restriction.id, scope: out.restriction.scope, endsAt: map.isoOrNull(out.restriction.ends_at) } : {}) },
      },
      by,
    );
    return {
      accountStatus: out.to as AccountStatus,
      record: map.action(out.action),
      restriction: out.restriction ? map.restriction(out.restriction) : null,
      effects: effectsOf(out.action.action, out.restriction?.scope as RestrictionScope | undefined, map.isoOrNull(out.restriction?.ends_at)),
    };
  }

  /** send_password_reset and sign_out_everywhere: identity does it; customers records the reason */
  private async securityAction(c: CustomerRow, input: AccountActionInput, details: string, by: StaffBy): Promise<AccountActionResult> {
    if (!(await by.can('customers.accounts.security'))) {
      throw new AppError('FORBIDDEN', 'Sending reset links and signing customers out needs the security permission', { permission: 'customers.accounts.security' });
    }
    const identityApi = this.ctx.use('identity');
    if (input.action === 'send_password_reset') await identityApi.sendPasswordReset(c.user_id, { reason: details, by: by.actor, revokeSessions: false });
    else await identityApi.revokeSessions(c.user_id, details);
    const st = map.status(c);
    const row = await this.repo.insertAction(this.actionRow(c, { action: input.action, reasonCode: input.reasonCode, details, from: st, to: st, actor: by.actor, at: this.now() }));
    await this.audit(
      { action: `customers.account.${input.action}`, actionLabel: ACTION_LABEL[input.action] ?? 'Account action', category: 'security', target: this.target(c), reason: `${input.reasonCode}: ${details}` },
      by,
    );
    return { accountStatus: st, record: map.action(row), restriction: null, effects: effectsOf(input.action) };
  }

  /**
   * Close by staff: same obligation check as a customer request unless the reason is suspected fraud
   * (payment_fraud_review). Open obligations need a second reviewer (access approval request): the account stays
   * as it is (APPROVAL_REQUIRED with details.approvalRequestId) and closes when the request is approved
   * (onApprovalDecidedFromAccess). Nothing is stored here while it waits; the request carries the reason.
   */
  private async closeByStaff(c: CustomerRow, input: AccountActionInput, details: string, by: StaffBy): Promise<AccountActionResult> {
    customerAccountStatusMachine.next(map.status(c), 'close'); // ILLEGAL_TRANSITION before asking anyone
    if (input.reasonCode !== 'payment_fraud_review') {
      const blockers = await this.obligations(c.id);
      if (blockers.length) {
        const access = this.ctx.tryUse('access');
        if (!access) throw new AppError('APPROVAL_REQUIRED', 'Closing an account with open obligations needs a second reviewer, and approvals are unavailable right now', { blockers });
        const principal = by.principal as identity.Principal;
        const check = await access.check(principal, CLOSE_WITH_OBLIGATIONS);
        if (check.decision === 'denied') throw new AppError('FORBIDDEN', check.reason, { action: CLOSE_WITH_OBLIGATIONS });
        if (check.decision === 'approval_required') {
          const latest = (await access.approvalForTargets(principal, 'customer', [c.id])).get(c.id);
          const req =
            latest && ['pending', 'partially_approved'].includes(latest.status) && latest.action.key === CLOSE_WITH_OBLIGATIONS
              ? latest
              : await access.requestApproval({
                  action: CLOSE_WITH_OBLIGATIONS,
                  target: { type: 'customer', id: c.id, ref: c.ref, label: displayName(c.first_name, c.last_name), screen: 'admin/customers' },
                  summary: `Close customer account ${c.ref} with ${blockers.map((b) => b.detail).join(', ')}`,
                  details: { blockers, reasonCode: input.reasonCode, details },
                  reason: details,
                  requestedBy: principal,
                });
          throw new AppError('APPROVAL_REQUIRED', 'Closing an account with open orders, returns or cases needs a second reviewer. It closes once approved.', {
            approvalRequestId: req.id,
            approvers: req.eligibleApprovers.map((a) => a.name),
            blockers,
          });
        }
      }
    }
    const done = await this.closeAccountTx(c.id, { source: 'staff', actor: by.actor, reasonCode: input.reasonCode, details, anonymise: false });
    await this.afterClosure(c, done, input.reasonCode, by, `${input.reasonCode}: ${details}`);
    return { accountStatus: 'closed', record: map.action(done.action!), restriction: null, effects: effectsOf('close') };
  }

  /**
   * access.approval.decided for customers.accounts.close-with-obligations: approved closes the account as the
   * requester, with the reason they gave; rejected, cancelled or expired leaves it as it is (the pending closure
   * lived only in the approval request). A status the close no longer applies to is logged and ignored.
   */
  async onApprovalDecidedFromAccess(event: EventPayload<'access.approval.decided'>, eventId?: string): Promise<void> {
    if (event.actionKey !== CLOSE_WITH_OBLIGATIONS || event.target?.type !== 'customer') return;
    const key = `approval-decided:${event.requestId}`;
    const c = await this.repo.getCustomer(event.target.id);
    if (!c) {
      this.ctx.log.info({ customerId: event.target.id, approvalRequestId: event.requestId, eventId }, 'customers: approval decided for an unknown customer; ignored');
      return;
    }
    if (event.outcome !== 'approved' || !customerAccountStatusMachine.can(map.status(c), 'close')) {
      if (event.outcome === 'approved') this.ctx.log.info({ customerId: c.id, status: c.account_status, approvalRequestId: event.requestId }, 'customers: approved closure no longer applies');
      await this.repo.transaction((repo) => repo.claim(key));
      return;
    }
    const request = await this.ctx
      .tryUse('access')
      ?.getApproval(event.requestId)
      .catch(() => null);
    const asked = (request?.details ?? {}) as { reasonCode?: string; details?: string };
    const reasonCode = asked.reasonCode && REASON_CODES.includes(asked.reasonCode as never) ? asked.reasonCode : 'other';
    const details = asked.details?.trim() || request?.reason?.trim() || 'Closure approved by a second reviewer';
    const actor: common.Actor = request?.requestedBy ?? { kind: 'staff', id: event.requestedById };
    const done = await this.closeAccountTx(c.id, { source: 'staff', actor, reasonCode, details, anonymise: false, claim: key });
    await this.afterClosure(c, done, reasonCode, { actor }, `${reasonCode}: ${details}`, event.requestId);
  }

  /** Moves a customer to closed in one transaction: promotional consent off, an open closure request completed, optional anonymisation */
  private async closeAccountTx(
    customerId: string,
    o: { source: string; actor: common.Actor; reasonCode: string; details: string; anonymise: boolean; force?: boolean; requestId?: string; claim?: string },
  ): Promise<{ from: AccountStatus; action?: ActionRow; changed: boolean }> {
    const now = this.now();
    return this.repo.transaction(async (repo) => {
      const c = await repo.getCustomer(customerId, { forUpdate: true });
      if (!c) throw notFound('Customer');
      const from = map.status(c);
      if (o.claim && !(await repo.claim(o.claim))) return { from, changed: false }; // event already handled
      if (from === 'closed') return { from, changed: false };
      const to = o.force ? 'closed' : customerAccountStatusMachine.next(from, 'close');
      const patch: Partial<CustomerRow> = { account_status: to, closed_at: now, updated_at: now };
      if (o.anonymise) {
        Object.assign(patch, {
          first_name: 'Closed',
          last_name: 'account',
          email: `closed.${c.ref.toLowerCase()}@deleted.marketly.invalid`,
          email_verified_at: null,
          phone: null,
          phone_verified_at: null,
          default_address_id: null,
        });
      }
      await repo.updateCustomer(c.id, patch);
      if (o.anonymise) await repo.anonymiseAddresses(c.id, now);
      await repo.deleteViews({ kind: 'customer', id: c.id });
      // promotional consent stops with the account (essential notices for open obligations stay with notifications)
      const prefs = (await repo.getPreferences(c.id)) ?? this.defaultPrefs(c.id, now);
      const consent: ConsentRow[] = [];
      for (const k of Object.keys(PREFS) as PrefKey[]) {
        const [col, channel] = PREFS[k];
        if (prefs[col]) consent.push({ id: newId(), customer_id: c.id, channel, granted: false, source: o.source, actor_kind: o.actor.kind, actor_id: o.actor.id ?? null, ip: null, at: now });
      }
      await repo.upsertPreferences({ ...prefs, email_promotions: false, sms_promotions: false, push_promotions: false, wishlist_alerts: false, personalized_recommendations: false, recent_searches: false, updated_at: now });
      await repo.insertConsent(consent);
      const open = await repo.openDataRequest(c.id, 'closure');
      if (open) {
        await repo.updateDataRequest(open.id, { state: dataRequestMachine.next(open.state as never, 'completeClosure'), completed_at: now, failure: null });
      }
      const action = o.actor.kind === 'staff' ? await repo.insertAction(this.actionRow(c, { action: 'close', reasonCode: o.reasonCode, details: o.details, from, to, actor: o.actor, at: now })) : undefined;
      return { from, action, changed: true };
    });
  }

  /** identity disables sign-in (and also consumes customers.account.closed as a backstop); notifications and media react to the event */
  private async afterClosure(c: CustomerRow, done: { from: AccountStatus; changed: boolean }, reasonCode: string, by: By, reason: string, approvalRequestId: string | null = null, callIdentity = true) {
    if (!done.changed) return;
    if (callIdentity) {
      try {
        await this.ctx.use('identity').closeAccount(c.user_id, reason);
      } catch (err) {
        this.ctx.log.warn({ err, customerId: c.id }, 'customers: identity.closeAccount failed; customers.account.closed is the backstop');
      }
    }
    this.statusChanged(c, done.from, 'closed', reasonCode, by);
    this.ctx.events.publish('customers.account.closed', { customerId: c.id, userId: c.user_id }, this.meta(by));
    await this.audit(
      {
        action: 'customers.account.close',
        actionLabel: 'Closed customer account',
        category: 'customers',
        target: this.target(c),
        reason,
        before: { accountStatus: done.from },
        after: { accountStatus: 'closed' },
        approvalRequestId,
      },
      by,
    );
  }

  async liftRestriction(customerId: string, restrictionId: string, body: { reason: string }, by: StaffBy): Promise<AccountActionResult> {
    const reason = body.reason?.trim();
    if (!reason) throw invalid('reason', 'Say why the restriction is lifted');
    const c = await this.repo.getCustomer(customerId);
    if (!c) throw notFound('Customer');
    const now = this.now();
    const out = await this.repo.transaction(async (repo) => {
      const cur = (await repo.getCustomer(c.id, { forUpdate: true }))!;
      const r = await repo.getRestriction(c.id, restrictionId, { forUpdate: true });
      if (!r) throw notFound('Restriction');
      const ended = await this.endRestriction(repo, cur, r, 'lift', reason, now);
      const action = await repo.insertAction(
        this.actionRow(cur, { action: 'lift_restriction', reasonCode: r.reason_code, details: reason, from: ended.from, to: ended.to, restrictionId: r.id, actor: by.actor, at: now }),
      );
      return { ...ended, action };
    });
    this.lifted(c, out.row, by);
    this.statusChanged(c, out.from, out.to, out.row.reason_code, by);
    await this.audit(
      {
        action: 'customers.account.lift_restriction',
        actionLabel: 'Lifted a customer restriction',
        category: 'customers',
        target: this.target(c),
        reason,
        before: { restriction: 'active', accountStatus: out.from },
        after: { restriction: 'lifted', accountStatus: out.to, restrictionId: out.row.id },
      },
      by,
    );
    return { accountStatus: out.to, record: map.action(out.action), restriction: map.restriction(out.row), effects: effectsOf('lift_restriction', out.row.scope as RestrictionScope) };
  }

  /* ================================================================ GraphQL reads */

  async standing(customerId: string): Promise<CustomerStanding | undefined> {
    return isUuid(customerId) ? this.repo.standingById(customerId, this.now()) : undefined;
  }
  async standingOfUser(userId: string): Promise<CustomerStanding | undefined> {
    if (!isUuid(userId)) return undefined;
    const s = await this.repo.standingByUserId(userId, this.now());
    if (s) return s;
    return (await this.ensureCustomer(userId)) ? this.repo.standingByUserId(userId, this.now()) : undefined;
  }
  async customerIdOfAccount(accountId: string): Promise<string | undefined> {
    return (await this.standingOfUser(accountId))?.row.id;
  }
  async restrictionsOf(customerId: string, includeEnded: boolean) {
    return (await this.repo.listRestrictions(customerId, includeEnded ? undefined : { activeAt: this.now() })).map(map.restriction);
  }
  async addressesOf(customerId: string) {
    return (await this.repo.listAddresses(customerId)).map(map.savedAddress);
  }
  async defaultAddressesOf(customerIds: string[]): Promise<Map<string, AddressRow>> {
    return new Map((await this.repo.defaultAddresses(customerIds)).map((a) => [a.customer_id, a]));
  }
  async preferencesOf(c: CustomerRow) {
    return map.preferences(await this.prefsOf(c), c.phone);
  }
  async notesOf(customerId: string) {
    return (await this.repo.listNotes(customerId)).map(map.note);
  }
  async actionsOf(customerId: string, limit: number) {
    return (await this.repo.recentActions(customerId, Math.min(Math.max(limit, 1), 100))).map(map.action);
  }
  get marketTimeZone() {
    return this.tz;
  }

  /* ================================================================ events consumed */

  /** orders.order.placed: guest buyer row for guest checkouts; order count, spend and the used address's lastUsedAt for customers */
  async onOrderPlacedFromOrders(event: EventPayload<'orders.order.placed'>, eventId?: string): Promise<void> {
    const placedAt = new Date(event.placedAt);
    const c = event.customerId ? await this.repo.getCustomer(event.customerId) : undefined;
    if (event.customerId && !c) this.ctx.log.warn({ customerId: event.customerId, orderId: event.orderId, eventId }, 'customers: order for an unknown customer; ignored');
    const email = event.guestEmail ? normalizeEmail(event.guestEmail) : null;
    // a member with the guest email: orders attaches the order on verification, no guest buyer row
    const guest = email && !(await this.repo.findCustomerByEmail(email)) ? email : null;
    if (!c && !guest) return;
    // the saved address the order used comes in the payload (no orders lookup); only this customer's own address counts
    const used = c && event.deliveryAddressId ? await this.repo.getAddress(c.id, event.deliveryAddressId) : undefined;
    await this.repo.transaction(async (repo) => {
      // the claim commits with the counts: a second delivery of the same order changes nothing
      if (!(await repo.claim(`order-placed:${event.orderId}`))) return;
      if (c) {
        const cur = (await repo.getCustomer(c.id, { forUpdate: true }))!;
        const same = cur.order_count === 0 || cur.currency === event.total.currency;
        await repo.updateCustomer(cur.id, {
          order_count: cur.order_count + 1,
          total_spend_minor: same ? Number(cur.total_spend_minor) + event.total.amount : Number(cur.total_spend_minor),
          currency: cur.order_count === 0 ? event.total.currency : cur.currency,
          updated_at: this.now(),
        });
        if (used && (!used.last_used_at || used.last_used_at < placedAt)) await repo.updateAddress(used.id, { last_used_at: placedAt });
      }
      if (guest) await this.recordGuestOrder(repo, event, guest, event.contactName?.trim() || guest.split('@')[0]!);
    });
  }

  /** Guest buyer row for a guest checkout (inside the consumer's transaction) */
  private async recordGuestOrder(repo: CustomersRepository, event: EventPayload<'orders.order.placed'>, email: string, name: string) {
    const placedAt = new Date(event.placedAt);
    const g = await repo.getGuestBuyer(email, { forUpdate: true });
    if (!g) {
      await repo.insertGuestBuyer({
        id: newId(),
        email_normalized: email,
        email: event.guestEmail!,
        name,
        order_count: 1,
        total_spend: event.total.amount,
        currency: event.total.currency,
        first_order_at: placedAt,
        last_order_at: placedAt,
        last_order_id: event.orderId,
        last_order_ref: event.ref,
      });
      return;
    }
    if (g.last_order_id === event.orderId) return; // recorded before the inbox existed
    const later = placedAt >= g.last_order_at;
    await repo.updateGuestBuyer(g.id, {
      order_count: g.order_count + 1,
      total_spend: Number(g.total_spend) + (g.currency === event.total.currency ? event.total.amount : 0),
      first_order_at: placedAt < g.first_order_at ? placedAt : g.first_order_at,
      ...(later ? { last_order_at: placedAt, last_order_id: event.orderId, last_order_ref: event.ref, name, email: event.guestEmail! } : {}),
    });
  }

  /** identity.user.registered: profile, default preferences and the first consent rows; the guest buyer row goes */
  async onUserRegisteredFromIdentity(event: EventPayload<'identity.user.registered'>): Promise<void> {
    await this.createCustomer(
      { accountId: event.accountId, email: event.email, firstName: event.firstName, lastName: event.lastName, marketingOptIn: event.marketingOptIn, emailVerifiedAt: null },
      { actor: { kind: 'customer', id: event.accountId } },
    );
  }

  /** identity.user.verified: email or phone verified */
  async onUserVerifiedFromIdentity(event: EventPayload<'identity.user.verified'>): Promise<void> {
    const c = (await this.repo.getCustomerByUserId(event.accountId)) ?? (await this.ensureCustomer(event.accountId));
    if (!c) {
      this.ctx.log.info({ accountId: event.accountId }, 'customers: verification for an account without a customer profile; ignored');
      return;
    }
    const at = new Date(event.at);
    if (event.channel === 'email') {
      const email = normalizeEmail(event.email);
      if (c.email === email && c.email_verified_at) return;
      await this.repo.updateCustomer(c.id, { email, email_verified_at: at, updated_at: this.now() });
    } else {
      const phone = event.phone ?? c.phone;
      if (!phone || (c.phone === phone && c.phone_verified_at)) return;
      await this.repo.updateCustomer(c.id, { phone, phone_verified_at: at, updated_at: this.now() });
    }
  }

  /** identity.guest_session.claimed: merge the guest list into the account (newest view wins) and delete the guest rows */
  async onGuestSessionClaimedFromIdentity(event: EventPayload<'identity.guest_session.claimed'>): Promise<void> {
    const guest: ViewOwner = { kind: 'guest', id: event.guestSessionId };
    const c = (await this.repo.getCustomerByUserId(event.accountId)) ?? (await this.ensureCustomer(event.accountId));
    if (!c) return;
    const retained = await this.ctx.settings.get('recentlyViewedRetained');
    const keep = (await this.prefsOf(c)).personalized_recommendations;
    await this.repo.transaction(async (repo) => {
      const owner: ViewOwner = { kind: 'customer', id: c.id };
      if (keep) {
        for (const v of await repo.listViews(guest, retained)) await repo.upsertView({ ...v, id: newId(), owner_kind: 'customer', owner_id: c.id });
        await repo.trimViews(owner, retained);
      }
      await repo.deleteViews(guest);
    });
  }

  /** identity.email.changed: mirrored email and its verification date */
  async onEmailChangedFromIdentity(event: EventPayload<'identity.email.changed'>): Promise<void> {
    const c = await this.repo.getCustomerByUserId(event.accountId);
    if (!c) return;
    const now = this.now();
    await this.repo.updateCustomer(c.id, { email: normalizeEmail(event.newEmail), email_verified_at: now, updated_at: now });
  }

  /** identity.account.closed: identity closed the account directly (staff tool): the customer is closed and promotions stop */
  async onAccountClosedFromIdentity(event: EventPayload<'identity.account.closed'>): Promise<void> {
    const c = await this.repo.getCustomerByUserId(event.accountId);
    if (!c || c.account_status === 'closed') return;
    // identity owns the credential: the customer follows whatever its status was
    const done = await this.closeAccountTx(c.id, { source: 'staff', actor: SYSTEM_ACTOR, reasonCode: 'other', details: 'Closed in identity', anonymise: false, force: true });
    await this.afterClosure(c, done, 'other', { actor: SYSTEM_ACTOR }, 'Account closed in identity', null, false);
  }

  /** trust.enforcement.recorded: customer restrictions with the enforcement's reason, end date and appeal route */
  async onEnforcementRecordedFromTrust(event: EventPayload<'trust.enforcement.recorded'>, actor?: common.Actor): Promise<void> {
    const scope = scopeOfTrustAction(event.action);
    if (!scope || event.alreadyApplied) return;
    const params = (event.params && typeof event.params === 'object' ? event.params : {}) as { endsAt?: unknown; customerMessage?: unknown; reasonCode?: unknown };
    const endsAt = typeof params.endsAt === 'string' && !Number.isNaN(Date.parse(params.endsAt)) ? new Date(params.endsAt) : null;
    const reasonCode: ReasonCode =
      typeof params.reasonCode === 'string' && (REASON_CODES as readonly string[]).includes(params.reasonCode) ? (params.reasonCode as ReasonCode) : scope === 'messaging' ? 'abusive_messages' : 'policy_violation';
    const by: By = { actor: actor ?? SYSTEM_ACTOR };
    for (const t of event.targets as { type?: string; id?: string }[]) {
      if (t?.type !== 'customer' || !t.id || !isUuid(t.id)) continue;
      const c = await this.repo.getCustomer(t.id);
      if (!c) {
        this.ctx.log.warn({ customerId: t.id, enforcementId: event.enforcementId }, 'customers: trust enforcement for an unknown customer; ignored');
        continue;
      }
      if (c.account_status === 'closed' || (await this.repo.findRestrictionByEnforcement(c.id, event.enforcementId))) continue;
      const now = this.now();
      const out = await this.repo.transaction(async (repo) => {
        const cur = (await repo.getCustomer(c.id, { forUpdate: true }))!;
        if (await repo.findRestrictionByEnforcement(c.id, event.enforcementId)) return undefined;
        const r = await this.addRestriction(
          repo,
          cur,
          {
            scope,
            reasonCode,
            reason: (typeof params.customerMessage === 'string' && params.customerMessage.trim()) || event.reason || customerMessageFor(scope, reasonCode),
            endsAt: endsAt && endsAt > now ? endsAt : null,
            appealRoute: trustAppealRoute(event.appealDeadline),
            appealDeadline: event.appealDeadline ? new Date(event.appealDeadline) : null,
            setBy: by.actor,
            trustReportId: event.reportId,
            trustEnforcementId: event.enforcementId,
          },
          now,
          { keepSuspension: true },
        );
        await repo.insertAction(
          this.actionRow(cur, { action: 'restrict', reasonCode, details: `Trust enforcement: ${event.reason}`, from: r.from, to: r.to, restrictionId: r.row.id, actor: by.actor, at: now }),
        );
        return r;
      });
      if (!out) continue;
      this.statusChanged(c, out.from, out.to, reasonCode, by);
      this.restricted(c, out.row, by);
    }
  }

  /**
   * trust.enforcement.reversed: lift every active restriction that enforcement created (actor system on behalf of trust);
   * the last one returns the account to active. Restrictions already lifted or expired stay as they are, so a
   * redelivered event changes nothing; each lift also claims (event, restriction) in the inbox.
   */
  async onEnforcementReversedFromTrust(event: EventPayload<'trust.enforcement.reversed'>, eventId?: string): Promise<void> {
    const rows = await this.repo.activeRestrictionsByEnforcement(event.enforcementId);
    if (!rows.length) return;
    const reason = `Trust reversed enforcement ${event.ref}: ${event.reason}`.slice(0, 1000);
    const by: By = { actor: SYSTEM_ACTOR };
    for (const r of rows) {
      const now = this.now();
      const out = await this.repo.transaction(async (repo) => {
        if (!(await repo.claim(`enforcement-reversed:${eventId ?? event.enforcementId}:${r.id}`))) return undefined;
        const c = await repo.getCustomer(r.customer_id, { forUpdate: true });
        const cur = c && (await repo.getRestriction(r.customer_id, r.id, { forUpdate: true }));
        if (!c || !cur || cur.state !== 'active') return undefined;
        const ended = await this.endRestriction(repo, c, cur, 'lift', reason, now);
        await repo.insertAction(
          this.actionRow(c, { action: 'lift_restriction', reasonCode: cur.reason_code, details: reason, from: ended.from, to: ended.to, restrictionId: cur.id, actor: by.actor, at: now }),
        );
        return { c, ...ended };
      });
      if (!out) continue;
      this.lifted(out.c, out.row, by);
      this.statusChanged(out.c, out.from, out.to, out.row.reason_code, by);
      await this.audit(
        {
          action: 'customers.account.lift_restriction',
          actionLabel: 'Lifted a customer restriction (trust enforcement reversed)',
          category: 'customers',
          target: this.target(out.c),
          reason,
          before: { restriction: 'active', accountStatus: out.from },
          after: { restriction: 'lifted', accountStatus: out.to, restrictionId: out.row.id, trustEnforcementId: event.enforcementId },
        },
        by,
      );
    }
  }

  /** catalog.product.merged: recently viewed rows follow the kept product */
  async onProductMergedFromCatalog(event: EventPayload<'catalog.product.merged'>): Promise<void> {
    if (event.duplicateProductId === event.keptProductId) return;
    await this.repo.transaction((repo) => repo.repointProduct(event.duplicateProductId, event.keptProductId, event.intoVariantId ?? event.newVariantId ?? null));
  }

  /* ================================================================ jobs */

  /** customers.expire-restrictions: expire restrictions past endsAt; the last one returns the account to active */
  async expireRestrictions(): Promise<{ expired: number }> {
    let expired = 0;
    for (let round = 0; round < 20; round++) {
      const now = this.now();
      const due = await this.repo.dueRestrictions(now, BATCH);
      if (!due.length) break;
      for (const r of due) {
        const out = await this.repo.transaction(async (repo) => {
          const c = await repo.getCustomer(r.customer_id, { forUpdate: true });
          const cur = c && (await repo.getRestriction(r.customer_id, r.id, { forUpdate: true }));
          if (!c || !cur || cur.state !== 'active' || !cur.ends_at || cur.ends_at > now) return undefined;
          return { c, ...(await this.endRestriction(repo, c, cur, 'expire', null, now)) };
        });
        if (!out) continue;
        expired++;
        const by = { actor: SYSTEM_ACTOR };
        this.lifted(out.c, out.row, by);
        this.statusChanged(out.c, out.from, out.to, out.row.reason_code, by);
      }
      if (due.length < BATCH) break;
    }
    return { expired };
  }

  /** customers.build-data-exports: requested (and retried) exports become a ZIP in media, then ready */
  async buildDataExports(): Promise<{ built: number; failed: number }> {
    const claimed = await this.repo.transaction(async (repo) => {
      const rows = await repo.exportsToBuild(10);
      const out: DataRequestRow[] = [];
      for (const r of rows) out.push(r.state === 'requested' ? await repo.updateDataRequest(r.id, { state: dataRequestMachine.next('requested', 'startExport') }) : r);
      return out;
    });
    let built = 0;
    let failed = 0;
    for (const r of claimed) {
      try {
        await this.buildExport(r);
        built++;
      } catch (err) {
        failed++;
        this.ctx.log.warn({ err, requestId: r.id }, 'customers: data export failed');
        const failure = (isAppError(err) ? err.message : (err as Error)?.message) || 'Export failed';
        await this.repo.updateDataRequest(r.id, { state: dataRequestMachine.next('processing', 'fail'), failure: failure.slice(0, 500) });
      }
    }
    return { built, failed };
  }

  private async buildExport(r: DataRequestRow) {
    const media = this.ctx.tryUse('media');
    if (!media) throw new Error('File storage (media) is not available');
    const c = await this.repo.getCustomer(r.customer_id);
    if (!c) throw new Error('Customer not found');
    const now = this.now();
    const [restrictions, addresses, prefs, consent, views, requests] = await Promise.all([
      this.repo.listRestrictions(c.id),
      this.repo.listAddresses(c.id),
      this.prefsOf(c),
      this.repo.consentLog(c.id),
      this.repo.listViews({ kind: 'customer', id: c.id }, 1000),
      this.repo.listDataRequests(c.id),
    ]);
    // every enabled module that declares the export hook (FORMAT.md, Customer data export hook); one that throws fails the export (retried).
    // A module that declares it but is off has nothing to export here and is listed under notIncluded.
    const sections = await this.exportSections({ customerId: c.id, accountId: c.user_id });
    const unavailable: string[] = EXPORT_HOOK_MODULES.filter((m) => !this.ctx.modules.includes(m));
    const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
    const used = new Set(['readme', 'profile', 'addresses', 'marketing-preferences', 'consent-log', 'recently-viewed', 'restrictions', 'data-requests']);
    const sectionFiles: { name: string; data: string; title: string; module: string }[] = [];
    for (const s of sections) {
      let key = safeName(s.key) || safeName(s.module) || 'section';
      if (used.has(key)) key = `${safeName(s.module)}-${key}`;
      for (let i = 2; used.has(key); i++) key = `${safeName(s.key)}-${i}`;
      used.add(key);
      sectionFiles.push({ name: `${key}.json`, data: json(s.records), title: s.title, module: s.module });
    }
    const attachments = await this.exportAttachments(sections, c.user_id, unavailable);
    const entries = [
      {
        name: 'README.json',
        data: json({
          generatedAt: map.iso(now),
          customer: c.ref,
          files: [
            'profile.json',
            'addresses.json',
            'marketing-preferences.json',
            'consent-log.json',
            'recently-viewed.json',
            'restrictions.json',
            'data-requests.json',
            ...sectionFiles.map((f) => f.name),
            ...attachments.map((a) => a.name),
          ],
          sections: sectionFiles.map((f) => ({ file: f.name, title: f.title, module: f.module })),
          notIncluded: unavailable,
        }),
      },
      { name: 'profile.json', data: json(map.profile(c, restrictions.filter((x) => map.inForce(x, now)), this.tz)) },
      { name: 'addresses.json', data: json(addresses.map(map.savedAddress)) },
      { name: 'marketing-preferences.json', data: json(map.preferences(prefs, c.phone)) },
      { name: 'consent-log.json', data: json(consent.map((x) => ({ channel: x.channel, granted: x.granted, source: x.source, at: map.iso(x.at) }))) },
      { name: 'recently-viewed.json', data: json(views.map((v) => ({ productId: v.product_id, variantId: v.variant_id, title: v.title, viewedAt: map.iso(v.viewed_at) }))) },
      { name: 'restrictions.json', data: json(restrictions.map(map.restriction)) },
      { name: 'data-requests.json', data: json(requests.map((x) => map.dataRequest(x))) },
      ...sectionFiles.map(({ name, data }) => ({ name, data })),
      ...attachments,
    ];
    const file = zip(entries, now);
    const days = await this.ctx.settings.get('exportLinkValidDays');
    const asset = await media.storeGeneratedFile({
      owner: { kind: 'customer', id: c.user_id, label: c.ref },
      fileName: `marketly-data-${c.ref}-${dateInZone(now, this.tz)}.zip`,
      contentType: 'application/zip',
      body: new Blob([new Uint8Array(file)]).stream(),
      ttlHours: days * 24,
      purpose: 'data_export',
    });
    const expiresAt = new Date(now.getTime() + days * DAY);
    const row = await this.repo.updateDataRequest(r.id, {
      state: dataRequestMachine.next('processing', 'finishExport'),
      file_media_id: asset.id,
      ready_at: now,
      expires_at: expiresAt,
      failure: null,
    });
    this.ctx.events.publish('customers.data_export.ready', { customerId: c.id, requestId: row.id, expiresAt: map.iso(expiresAt) }, this.meta({ actor: SYSTEM_ACTOR }));
  }

  /** exportCustomerData of every enabled module that declares it; any failure fails the export (retried, never left out) */
  private async exportSections(input: { customerId: string; accountId: string }): Promise<common.CustomerDataSection[]> {
    const out: common.CustomerDataSection[] = [];
    for (const m of EXPORT_HOOK_MODULES) {
      const api = this.ctx.tryUse(m) as unknown as { exportCustomerData(i: typeof input): Promise<common.CustomerDataSection[]> } | undefined;
      if (!api) continue;
      let sections: common.CustomerDataSection[];
      try {
        sections = await api.exportCustomerData(input);
      } catch (err) {
        throw new Error(`${m} could not export its part (${(err as Error)?.message ?? 'unknown error'})`, { cause: err });
      }
      for (const s of sections ?? []) out.push({ ...s, module: s.module || m, records: Array.isArray(s.records) ? s.records : [] });
    }
    return out;
  }

  /** The customer's own uploads the sections name (attachments/<section>/<file>); files gone or not theirs are listed as not included */
  private async exportAttachments(sections: common.CustomerDataSection[], accountId: string, notIncluded: string[]): Promise<{ name: string; data: Buffer }[]> {
    const wanted = sections.flatMap((s) => (s.attachmentIds ?? []).map((id) => ({ id, folder: safeName(s.key) || 'files' })));
    if (!wanted.length) return [];
    const media = this.ctx.tryUse('media');
    if (!media) throw new Error('File storage (media) is not available');
    const out: { name: string; data: Buffer }[] = [];
    const seen = new Set<string>();
    for (const w of wanted) {
      if (seen.has(w.id)) continue;
      seen.add(w.id);
      try {
        const f = await media.readFile(w.id, { kind: 'customer', id: accountId });
        out.push({ name: `attachments/${w.folder}/${w.id.slice(0, 8)}-${safeName(f.fileName.replace(/\.[^.]*$/, '')) || 'file'}${/\.[A-Za-z0-9]{1,8}$/.exec(f.fileName)?.[0] ?? ''}`, data: Buffer.from(f.body) });
      } catch (err) {
        if (!isAppError(err) || !SKIPPED_ATTACHMENT.has(err.code)) throw err;
        notIncluded.push(`attachment ${w.id} (${err.code === 'FILE_TOO_LARGE' ? 'too large' : 'no longer available'})`);
      }
    }
    return out;
  }

  /** customers.expire-export-links: ready exports past their link lifetime expire and the file is deleted */
  async expireExportLinks(): Promise<{ expired: number }> {
    const media = this.ctx.tryUse('media');
    let expired = 0;
    for (let round = 0; round < 20; round++) {
      const rows = await this.repo.readyExportsExpiring(this.now(), BATCH);
      if (!rows.length) break;
      for (const r of rows) {
        await this.repo.updateDataRequest(r.id, { state: dataRequestMachine.next('ready', 'expireLink') });
        expired++;
        if (r.file_media_id && media) await this.soft('remove export file', () => media.remove(r.file_media_id!, { reason: 'Data export link expired', by: SYSTEM_ACTOR }));
      }
      if (rows.length < BATCH) break;
    }
    return { expired };
  }

  /** customers.complete-closures: closures past the cooling-off date re-check obligations, then close and anonymise */
  async completeClosures(): Promise<{ completed: number; waiting: number }> {
    let completed = 0;
    let waiting = 0;
    for (const r of await this.repo.closuresDue(this.now(), 200)) {
      const c = await this.repo.getCustomer(r.customer_id);
      if (!c) continue;
      let blockers: ClosureBlocker[];
      try {
        blockers = await this.obligations(c.id);
      } catch (err) {
        this.ctx.log.warn({ err, requestId: r.id }, 'customers: closure obligations could not be checked; retried at the next run');
        waiting++;
        continue;
      }
      const why = blockers.length ? `Waiting: ${blockers.map((b) => b.detail).join(', ')}` : c.account_status === 'under_review' ? 'Waiting: the account is under review' : null;
      if (why) {
        // new obligations appeared: the request keeps waiting (shown in the privacy queue)
        if (r.failure !== why) await this.repo.updateDataRequest(r.id, { failure: why });
        if (blockers.length) await this.closureDelayed(c, r, blockers);
        waiting++;
        continue;
      }
      const done = await this.closeAccountTx(c.id, { source: 'profile', actor: SYSTEM_ACTOR, reasonCode: 'customer_request', details: 'Customer requested closure', anonymise: true });
      await this.afterClosure(c, done, 'customer_request', { actor: SYSTEM_ACTOR }, 'Customer requested closure');
      completed++;
    }
    return { completed, waiting };
  }

  /** customers.closure.delayed, once per new set of blockers (the set of blocker kinds, claimed in the inbox per request) */
  private async closureDelayed(c: CustomerRow, r: DataRequestRow, blockers: ClosureBlocker[]) {
    const kinds = [...new Set(blockers.map((b) => b.kind))].sort().join(',');
    const fresh = await this.repo.transaction((repo) => repo.claim(`closure-delayed:${r.id}:${kinds}`));
    if (!fresh) return;
    this.ctx.events.publish(
      'customers.closure.delayed',
      { customerId: c.id, userId: c.user_id, requestId: r.id, blockers, nextCheckAt: this.nextClosureCheck().toISOString() },
      this.meta({ actor: SYSTEM_ACTOR }),
    );
  }

  /** The next run of customers.complete-closures (daily 02:00 market time) */
  private nextClosureCheck(): Date {
    const now = this.now();
    const today = dateInZone(now, this.tz);
    const at = zonedTimeToUtc(today, '02:00', this.tz);
    return at > now ? at : zonedTimeToUtc(addDays(today, 1), '02:00', this.tz);
  }

  /** customers.prune-recently-viewed: views older than recentlyViewedRetentionDays, and guest views whose session has expired */
  async pruneRecentlyViewed(): Promise<{ deleted: number }> {
    const now = this.now().getTime();
    const days = await this.ctx.settings.get('recentlyViewedRetentionDays');
    const deleted = await this.repo.pruneViews(new Date(now - days * DAY), new Date(now - GUEST_SESSION_DAYS * DAY));
    return { deleted };
  }
}

const ACTION_LABEL: Record<string, string> = {
  send_password_reset: 'Sent a password reset link',
  sign_out_everywhere: 'Signed the customer out everywhere',
  mark_under_review: 'Marked account under review',
  clear_review: 'Cleared account review',
  restrict: 'Restricted customer account',
  lift_restriction: 'Lifted a customer restriction',
  suspend: 'Suspended customer account',
  reinstate: 'Reinstated customer account',
  close: 'Closed customer account',
};
