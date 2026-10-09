/** Customer account rules (pure): restrictions, what a status allows, texts shown to customers and staff. */
import type { AccountActionInput, AccountRestriction, ClosureBlocker, CustomerSnapshot } from '../../../spec/customers.js';

export type AccountStatus = CustomerSnapshot['accountStatus'];
export type RestrictionScope = AccountRestriction['scope'];
export type ReasonCode = AccountRestriction['reasonCode'];
export type ActionKind = AccountActionInput['action'];

export const REASON_CODES: readonly ReasonCode[] = ['customer_request', 'suspected_takeover', 'abusive_messages', 'payment_fraud_review', 'policy_violation', 'other'];

/** Staff actions that create a scoped restriction */
export const RESTRICT_ACTIONS: Partial<Record<ActionKind, RestrictionScope>> = {
  restrict_messaging: 'messaging',
  restrict_ordering: 'ordering',
  restrict_reviews: 'reviews',
  restrict_account: 'account',
};

/** Actions that call identity and need customers.accounts.security */
export const SECURITY_ACTIONS: readonly ActionKind[] = ['send_password_reset', 'sign_out_everywhere'];

/** Trust enforcement actions owned by customers, and the restriction scope each creates */
export function scopeOfTrustAction(action: string): RestrictionScope | null {
  const a = action.toLowerCase();
  if (!a.startsWith('restrict_customer')) return null;
  if (a.includes('messag')) return 'messaging';
  if (a.includes('order')) return 'ordering';
  if (a.includes('review')) return 'reviews';
  if (a.includes('account')) return 'account';
  return null;
}

/** Which scopes stop new orders / new messages */
export const blocksOrdering = (s: string) => s === 'ordering' || s === 'account';
export const blocksMessaging = (s: string) => s === 'messaging' || s === 'account';

/** What the customer may still do under any restriction or suspension (plan ch. 17, scenario 7) */
export const STILL_WORKS = ['Existing orders', 'Returns and refunds', 'Support cases', 'Order tracking'];

export function stillWorksFor(scope: RestrictionScope): string[] {
  switch (scope) {
    case 'messaging':
      return [...STILL_WORKS, 'Shopping and checkout', 'Replies inside open support cases'];
    case 'ordering':
      return [...STILL_WORKS, 'Messages to sellers', 'Reviews'];
    case 'reviews':
      return [...STILL_WORKS, 'Shopping and checkout', 'Messages to sellers'];
    case 'account':
      return [...STILL_WORKS];
  }
}

const SCOPE_LABEL: Record<RestrictionScope, string> = {
  messaging: 'sending new messages',
  ordering: 'placing new orders',
  reviews: 'writing reviews and answers',
  account: 'new orders, messages and reviews',
};

const REASON_TEXT: Record<ReasonCode, string> = {
  customer_request: 'You asked us to pause this activity on your account.',
  suspected_takeover: 'We noticed activity that suggests someone else may be using your account.',
  abusive_messages: 'Messages sent from your account broke our community rules.',
  payment_fraud_review: 'We are checking recent payments on your account.',
  policy_violation: 'Activity on your account broke our marketplace rules.',
  other: 'We had to limit some activity on your account.',
};

/** Default text shown to the customer with a restriction */
export const customerMessageFor = (scope: RestrictionScope, reason: ReasonCode) => `${REASON_TEXT[reason]} Paused: ${SCOPE_LABEL[scope]}.`;

/** Staff restrictions are appealed through a support case; trust enforcement through trust appeals */
export const STAFF_APPEAL_ROUTE = 'Open a support case from Help > Contact us and ask us to review this restriction.';
export const trustAppealRoute = (deadline: string | null | undefined) =>
  `Appeal from Help > Trust actions on your account${deadline ? ` before ${deadline.slice(0, 10)}` : ''}.`;

export const STAY_OPEN = 'Existing orders, returns, refunds and cases stay open';

export function effectsOf(action: string, scope?: RestrictionScope | null, endsAt?: string | null): string[] {
  switch (action) {
    case 'send_password_reset':
      return ['Password reset link emailed to the customer', 'Current sign-ins keep working until the password changes'];
    case 'sign_out_everywhere':
      return ['Signed out on every device', 'The customer can sign in again with their password'];
    case 'mark_under_review':
      return ['Account marked under review', 'The customer can keep shopping', STAY_OPEN];
    case 'clear_review':
      return ['Review cleared; account is active'];
    case 'restrict':
      return [`Paused: ${SCOPE_LABEL[scope ?? 'account']}${endsAt ? ` until ${endsAt.slice(0, 10)}` : ' until lifted'}`, STAY_OPEN];
    case 'lift_restriction':
      return [`Allowed again: ${SCOPE_LABEL[scope ?? 'account']}`];
    case 'suspend':
      return ['New orders, messages and reviews are stopped', STAY_OPEN];
    case 'reinstate':
      return ['Account active again: new orders, messages and reviews are allowed'];
    case 'close':
      return ['Account closed: sign-in disabled and promotional messages stopped', 'Order, return and refund records are kept'];
    default:
      return [];
  }
}

/** Records kept after closure as the law requires */
export const RETAINED_RECORDS = [
  'Order, payment and tax records',
  'Return, refund and support case records linked to orders',
  'Consent history (proof of opt-in and opt-out)',
];

const BLOCKER_DETAIL: Record<ClosureBlocker['kind'], (n: number) => string> = {
  open_orders: (n) => `${n} order${n === 1 ? '' : 's'} still in progress`,
  open_returns: (n) => `${n} open return${n === 1 ? '' : 's'}`,
  open_cases: (n) => `${n} open support case${n === 1 ? '' : 's'}`,
  pending_refunds: (n) => `${n} refund${n === 1 ? '' : 's'} not sent yet`,
  store_credit_balance: () => 'Store credit balance left on the account',
};

export const blocker = (kind: ClosureBlocker['kind'], count: number, detail?: string): ClosureBlocker => ({ kind, count, detail: detail ?? BLOCKER_DETAIL[kind](count) });

/** Refund states that mean money has not reached the customer yet */
export const PENDING_REFUND = new Set(['requested', 'under_review', 'approved', 'processing']);
export const isPendingRefund = (status: string | null | undefined) => !!status && PENDING_REFUND.has(status.toLowerCase().replace(/\s+/g, '_'));

/** Name shown in the account and to staff (same as identity's display name) */
export const displayName = (first: string, last: string) => [first.trim(), last.trim()].filter(Boolean).join(' ') || 'Customer';

export function verificationOf(emailVerifiedAt: Date | null, phoneVerifiedAt: Date | null): 'email_and_phone' | 'email_only' | 'not_verified' {
  if (!emailVerifiedAt) return 'not_verified';
  return phoneVerifiedAt ? 'email_and_phone' : 'email_only';
}

export const normalizeEmail = (e: string) => e.trim().toLowerCase();

/** A phone number a person typed: digits with an optional leading + (7 to 15 digits) */
export function cleanPhone(p: string): string | null {
  const t = p.trim();
  if (!t) return null;
  const digits = t.replace(/[^\d]/g, '');
  if (!/^\+?[\d\s().-]+$/.test(t) || digits.length < 7 || digits.length > 15) return null;
  return t.startsWith('+') ? `+${digits}` : digits.length === 10 ? `+1${digits}` : `+${digits}`;
}
