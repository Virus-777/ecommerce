/**
 * Shared plumbing of the customers use cases: time, events, audit and the look-ups every feature starts from. The
 * use cases live in the feature classes (service/*.ts).
 */
import { SYSTEM_ACTOR, type Principal } from '../../../kernel/auth/index.js';
import { AppError, isNotImplemented } from '../../../kernel/errors/index.js';
import { newId } from '../../../kernel/lib/ids.js';
import type { ModuleContext } from '../../../kernel/module-system/index.js';
import type * as audit from '../../../spec/audit.js';
import type * as common from '../../../spec/common.js';
import { spec as customersSpec } from '../../../spec/customers.js';
import { specs } from '../../../spec/index.js';
import { displayName } from '../domain/rules.js';
import type { ActionRow, AddressValidationProvider, CustomerRow, Geocoder } from '../ports.js';
import type { CustomersRepository } from '../repository.js';

export interface CustomersServiceDeps {
  repo: CustomersRepository;
  ctx: ModuleContext<'customers'>;
  /** Address validation provider (optional integration); format rules only without it */
  addressProvider?: AddressValidationProvider;
  /** Geocoder provider; without it (or with the unconfigured stub) addresses keep no point */
  geocoder?: Geocoder;
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

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const CLOSE_WITH_OBLIGATIONS = 'customers.accounts.close-with-obligations';
export const DATASET = 'customers.admin.accounts';
/** Visitor sessions end 30 days after last activity (docs/03-auth-middleware.md §2); their views go with them */
export const GUEST_SESSION_DAYS = 30;
export const EXPORTS_PER_DAY = 3;
export const BATCH = 50;

export type PrefKey = 'emailPromotions' | 'smsPromotions' | 'pushPromotions' | 'wishlistAlerts' | 'personalizedRecommendations' | 'recentSearches';
type PrefColumn = 'email_promotions' | 'sms_promotions' | 'push_promotions' | 'wishlist_alerts' | 'personalized_recommendations' | 'recent_searches';
/** API field → column and consent log channel */
export const PREFS: Record<PrefKey, [PrefColumn, string]> = {
  emailPromotions: ['email_promotions', 'email'],
  smsPromotions: ['sms_promotions', 'sms'],
  pushPromotions: ['push_promotions', 'push'],
  wishlistAlerts: ['wishlist_alerts', 'wishlist'],
  personalizedRecommendations: ['personalized_recommendations', 'personalization'],
  recentSearches: ['recent_searches', 'recent_searches'],
};
export const PROMOTIONAL_OFF: Partial<Record<PrefKey, boolean>> = { emailPromotions: false, smsPromotions: false, pushPromotions: false, wishlistAlerts: false };

/** Optional dependencies whose spec declares the customer data export hook (FORMAT.md, Customer data export hook) */
export const EXPORT_HOOK_MODULES = customersSpec.optionalDeps.filter((m) => (specs as Record<string, { publicApi: readonly string[] } | undefined>)[m]?.publicApi.includes('exportCustomerData'));
/** Attachment errors that leave the file out (listed in the README) instead of failing the export */
export const SKIPPED_ATTACHMENT = new Set(['NOT_FOUND', 'ASSET_NOT_OWNED', 'ILLEGAL_TRANSITION', 'FILE_TOO_LARGE']);
export const safeName = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

export const invalid = (path: string, message: string) => new AppError('VALIDATION_FAILED', message, { issues: [{ path, message }] });
export const notFound = (what: string) => new AppError('NOT_FOUND', `${what} not found`);
export const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export const ACTION_LABEL: Record<string, string> = {
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

export class Core {
  constructor(readonly deps: CustomersServiceDeps) {}

  get ctx() {
    return this.deps.ctx;
  }

  get repo() {
    return this.deps.repo;
  }

  now() {
    return this.ctx.clock.now();
  }

  get tz() {
    return this.ctx.config.market.timeZone;
  }

  meta(by?: { actor?: common.Actor; requestId?: string }) {
    return { actor: by?.actor ?? SYSTEM_ACTOR, requestId: by?.requestId };
  }

  async audit(entry: Omit<audit.RecordInput, 'actor' | 'module' | 'requestId'>, by: { actor: common.Actor; requestId?: string }) {
    try {
      await this.ctx.tryUse('audit')?.record({ ...entry, actor: by.actor, module: this.ctx.name, requestId: by.requestId ?? null });
    } catch (err) {
      // the change is committed; a missing audit entry is logged, never turned into a failed request
      this.ctx.log[isNotImplemented(err) ? 'debug' : 'error']({ err, action: entry.action }, 'audit entry not recorded');
    }
  }

  /** A call to another module whose failure must not break this one (lists, read-only decorations) */
  async soft<T>(what: string, call: (() => Promise<T>) | undefined): Promise<T | undefined> {
    if (!call) return undefined;
    try {
      return await call();
    } catch (err) {
      if (!isNotImplemented(err)) this.ctx.log.warn({ err, what }, `customers: ${what} failed; shown without it`);
      return undefined;
    }
  }

  target(c: CustomerRow) {
    return { type: 'customer', id: c.id, ref: c.ref, label: `${displayName(c.first_name, c.last_name)} (${c.email})`, screen: 'admin/customers' };
  }

  actionRow(c: CustomerRow, a: { action: string; reasonCode: string; details: string; from: string | null; to: string | null; restrictionId?: string | null; actor: common.Actor; at: Date }): ActionRow {
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

  statusChanged(c: CustomerRow, from: string, to: string, reasonCode: string, by: By) {
    if (from !== to) this.ctx.events.publish('customers.account.status_changed', { customerId: c.id, from, to, reasonCode }, this.meta(by));
  }
}
