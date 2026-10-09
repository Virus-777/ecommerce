/** Row (snake_case) → API type (camelCase) mapping, one place per type. */
import { dateInZone } from '../../kernel/lib/clock.js';
import type * as common from '../../spec/common.js';
import type {
  AccountActionRecord,
  AccountRestriction,
  CustomerNote,
  CustomerProfile,
  CustomerSnapshot,
  DataRequest,
  GuestBuyerRow as GuestBuyerApi,
  MarketingPreferences,
  SavedAddress,
} from '../../spec/customers.js';
import { displayName, type AccountStatus } from './domain/rules.js';
import type { ActionRow, AddressRow, CustomerRow, CustomerStanding, DataRequestRow, GuestBuyerRow, NoteRow, PreferencesRow, RestrictionRow } from './ports.js';

export const iso = (d: Date | string) => new Date(d).toISOString();
export const isoOrNull = (d: Date | string | null | undefined) => (d ? iso(d) : null);

export const status = (row: CustomerRow) => row.account_status as AccountStatus;

export function snapshot(s: CustomerStanding): CustomerSnapshot {
  const r = s.row;
  const st = status(r);
  return {
    id: r.id,
    userId: r.user_id,
    ref: r.ref,
    displayName: displayName(r.first_name, r.last_name),
    email: r.email,
    phone: r.phone,
    accountStatus: st,
    canOrder: st !== 'suspended' && st !== 'closed' && !s.orderBlock,
    canMessage: st !== 'suspended' && st !== 'closed' && !s.messageBlock,
  };
}

export const actor = (kind: string, id: string | null): common.Actor => ({ kind: kind as common.Actor['kind'], id });

export function restriction(r: RestrictionRow): AccountRestriction {
  return {
    id: r.id,
    scope: r.scope as AccountRestriction['scope'],
    reasonCode: r.reason_code as AccountRestriction['reasonCode'],
    reason: r.reason,
    stillWorks: Array.isArray(r.still_works) ? (r.still_works as string[]) : [],
    appealRoute: r.appeal_route,
    appealDeadline: isoOrNull(r.appeal_deadline),
    startsAt: iso(r.starts_at),
    endsAt: isoOrNull(r.ends_at),
    state: r.state as AccountRestriction['state'],
    setBy: actor(r.set_by_kind, r.set_by_id),
    trustReportId: r.trust_report_id,
    trustEnforcementId: r.trust_enforcement_id,
  };
}

/** Whether a restriction row is in force at `now` (the expire job may not have run yet) */
export const inForce = (r: RestrictionRow, now: Date) => r.state === 'active' && (!r.ends_at || r.ends_at > now);

export function profile(r: CustomerRow, restrictions: RestrictionRow[], timeZone: string): CustomerProfile {
  return {
    id: r.id,
    ref: r.ref,
    firstName: r.first_name,
    lastName: r.last_name,
    displayName: displayName(r.first_name, r.last_name),
    email: r.email,
    emailVerified: r.email_verified_at !== null,
    emailVerifiedAt: isoOrNull(r.email_verified_at),
    phone: r.phone,
    phoneVerified: r.phone !== null && r.phone_verified_at !== null,
    memberSince: dateInZone(r.created_at, timeZone),
    defaultAddressId: r.default_address_id,
    accountStatus: status(r),
    restrictions: restrictions.map(restriction),
    updatedAt: iso(r.updated_at),
  };
}

export const addressOf = (a: AddressRow): common.Address => ({
  name: a.name,
  line1: a.line1,
  line2: a.line2,
  city: a.city,
  region: a.region,
  postalCode: a.postal_code,
  country: a.country,
  phone: a.phone,
});

export function savedAddress(a: AddressRow): SavedAddress {
  return {
    id: a.id,
    label: a.label,
    address: addressOf(a),
    deliveryInstructions: a.delivery_instructions,
    isDefault: a.is_default,
    lastUsedAt: isoOrNull(a.last_used_at),
    createdAt: iso(a.created_at),
    updatedAt: iso(a.updated_at),
  };
}

export function preferences(p: PreferencesRow, smsNumber: string | null): MarketingPreferences {
  return {
    emailPromotions: p.email_promotions,
    smsPromotions: p.sms_promotions,
    pushPromotions: p.push_promotions,
    wishlistAlerts: p.wishlist_alerts,
    personalizedRecommendations: p.personalized_recommendations,
    recentSearches: p.recent_searches,
    essentialAlwaysOn: true,
    smsNumber,
    updatedAt: iso(p.updated_at),
  };
}

export function dataRequest(r: DataRequestRow, downloadUrl?: string | null): DataRequest {
  return {
    id: r.id,
    kind: r.kind,
    state: r.state as DataRequest['state'],
    requestedAt: iso(r.requested_at),
    dueBy: iso(r.due_by),
    readyAt: isoOrNull(r.ready_at),
    downloadUrl: r.state === 'ready' ? (downloadUrl ?? null) : null,
    expiresAt: isoOrNull(r.expires_at),
    scheduledFor: isoOrNull(r.scheduled_for),
    completedAt: isoOrNull(r.completed_at),
    cancelledAt: isoOrNull(r.cancelled_at),
  };
}

export function action(r: ActionRow): AccountActionRecord {
  return {
    id: r.id,
    action: r.action as AccountActionRecord['action'],
    reasonCode: r.reason_code,
    details: r.details,
    fromStatus: r.from_status,
    toStatus: r.to_status,
    restrictionId: r.restriction_id,
    actor: actor(r.actor_kind, r.actor_id),
    at: iso(r.at),
  };
}

export const note = (n: NoteRow): CustomerNote => ({ id: n.id, body: n.body, author: { kind: 'staff', id: n.author_id, name: n.author_name }, createdAt: iso(n.created_at) });

export function guestBuyer(g: GuestBuyerRow, openCases: number | null): GuestBuyerApi {
  return {
    id: g.id,
    email: g.email,
    name: g.name,
    orderCount: g.order_count,
    totalSpend: { amount: Number(g.total_spend), currency: g.currency },
    firstOrderAt: iso(g.first_order_at),
    lastOrderAt: iso(g.last_order_at),
    openCases,
    lastOrderRef: g.last_order_ref,
  };
}

/** City and state of the default address, for lists */
export const location = (a: AddressRow | undefined) => (a ? `${a.city}, ${a.region}` : null);
