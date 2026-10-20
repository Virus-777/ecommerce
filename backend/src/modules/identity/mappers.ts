/** Rows (snake_case) → API types (camelCase), one place per type. */
import { maskEmail, maskPhone } from '../../kernel/lib/mask.js';
import type { Actor } from '../../spec/common.js';
import type {
  AccountSummary,
  Device,
  Invitation,
  SecurityEvent,
  SellerContext,
  TwoStepMethod,
  TwoStepStatus,
  VerificationChallenge,
} from '../../spec/identity.js';
import { lockInForce } from './domain/policy.js';
import { securityLabel } from './domain/text.js';
import type { AccountRow, ChallengeRow, DeviceWithSessions, InvitationRow, SecurityEventRow, SellerAccessRow, TwoStepMethodRow } from './ports.js';

export const iso = (d: Date) => d.toISOString();
export const isoOrNull = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/** A lock whose end has passed counts as active (it is cleared at the next sign-in or by the job). */
export const effectiveStatus = (a: AccountRow, now: Date): AccountSummary['status'] =>
  a.status === 'locked' && !lockInForce(a, now) ? 'active' : (a.status as AccountSummary['status']);

export const accountSummary = (a: AccountRow, twoStepEnabled: boolean, now: Date): AccountSummary => ({
  id: a.id,
  realm: a.realm,
  email: a.email,
  displayName: a.display_name,
  status: effectiveStatus(a, now),
  emailVerified: a.email_verified_at !== null,
  twoStepEnabled,
  lastActiveAt: isoOrNull(a.last_active_at),
});

export const twoStepMethod = (m: TwoStepMethodRow): TwoStepMethod => ({
  id: m.id,
  method: m.method,
  label: m.method === 'sms' ? `Text message to ${m.phone_masked ?? 'your phone'}` : 'Authenticator app',
  phoneMasked: m.phone_masked,
  addedAt: iso(m.confirmed_at!),
  lastUsedAt: isoOrNull(m.last_used_at),
});

/** 2-step is never required: members choose it, and staff sign in with email and password only (2026-10-14) */
export const twoStepStatus = (methods: TwoStepMethodRow[], recoveryCodesRemaining: number): TwoStepStatus => ({
  enabled: methods.length > 0,
  required: false,
  methods: methods.map(twoStepMethod),
  recoveryCodesRemaining: methods.length ? recoveryCodesRemaining : 0,
});

export const device = (d: DeviceWithSessions, currentSessionId?: string | null): Device => ({
  id: d.id,
  kind: d.kind,
  label: d.label,
  location: d.last_location,
  current: Boolean(currentSessionId && d.sessionIds.includes(currentSessionId)),
  audiences: d.audiences,
  firstSeenAt: iso(d.first_seen_at),
  lastActiveAt: iso(d.last_active_at),
  twoStepTrustedUntil: isoOrNull(d.two_step_trusted_until),
});

const ACTOR_KINDS = new Set<Actor['kind']>(['customer', 'visitor', 'seller', 'staff', 'provider', 'anonymous', 'system']);

export function actorOfRow(kind: string | null, id: string | null): Actor | null {
  if (!kind || !ACTOR_KINDS.has(kind as Actor['kind'])) return null;
  return { kind: kind as Actor['kind'], id };
}

export const securityEvent = (e: SecurityEventRow): SecurityEvent => {
  const detail = (e.detail && typeof e.detail === 'object' && !Array.isArray(e.detail) ? e.detail : {}) as Record<string, unknown>;
  // the actor is shown when someone else (staff, the system) made the change
  const actor = e.actor_kind && e.actor_id !== e.account_id ? actorOfRow(e.actor_kind, e.actor_id) : null;
  return {
    id: e.id,
    at: iso(e.at),
    kind: e.kind as SecurityEvent['kind'],
    label: securityLabel(e.kind, detail, e.audience),
    device: e.device_label,
    location: e.location,
    audience: e.audience as SecurityEvent['audience'],
    result: e.result as SecurityEvent['result'],
    actor,
    reason: e.reason,
  };
};

export const sellerContext = (s: SellerAccessRow): SellerContext => ({
  sellerId: s.seller_id,
  sellerName: s.seller_name,
  memberId: s.seller_member_id,
  roleLabel: s.role_label,
  isOwner: s.is_owner,
  lastUsedAt: isoOrNull(s.last_used_at),
});

export const invitation = (i: InvitationRow, now: Date): Invitation => ({
  id: i.id,
  realm: i.realm as Invitation['realm'],
  purpose: i.purpose,
  email: i.email,
  name: i.name,
  // a pending link past its end is expired even before the hourly job marks it
  status: (i.status === 'pending' && i.expires_at <= now ? 'expired' : i.status) as Invitation['status'],
  contextRef: i.context_ref,
  contextLabel: i.context_label,
  invitedBy: actorOfRow(i.invited_by_kind, i.invited_by_id) ?? { kind: 'system' },
  sentAt: iso(i.sent_at),
  expiresAt: iso(i.expires_at),
  acceptedAt: isoOrNull(i.accepted_at),
  accountId: i.account_id,
});

/** The destination a challenge's code went to, masked */
export const challengeDestination = (c: ChallengeRow): string => {
  const payload = (c.payload ?? {}) as Record<string, unknown>;
  if (typeof payload.phoneMasked === 'string') return payload.phoneMasked;
  if (typeof payload.phone === 'string') return maskPhone(payload.phone);
  return c.target_email ? maskEmail(c.target_email) : '•••';
};

export const verificationChallenge = (c: ChallengeRow): VerificationChallenge => ({
  id: c.id,
  purpose: c.purpose as VerificationChallenge['purpose'],
  emailMasked: challengeDestination(c),
  codeLength: 6,
  expiresAt: iso(c.expires_at),
  resendAvailableAt: iso(c.resend_available_at ?? c.created_at),
  attemptsLeft: Math.max(0, c.max_attempts - c.attempts),
});
