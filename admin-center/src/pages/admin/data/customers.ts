// Types and labels for the admin "Customers" screen (design: pages/admin/admin-customers.html and
// admin-customers--customer-detail.html), mapped from GET /api/admin/customers/customers, /customers/{id},
// /guest-buyers and POST /customers/{id}/actions. useDebounced is shared with the cases queue search.
import { useEffect, useState } from 'react';
import type { components } from '@marketly/web-shared/api';
import type { Tone } from '@marketly/web-shared/ui';

type S = components['schemas'];
export type CustomerRow = S['customers.AdminCustomerRow'];
export type CustomerDetail = S['customers.AdminCustomerDetail'];
export type GuestBuyer = S['customers.GuestBuyerRow'];
export type DataRequest = S['customers.DataRequest'];
export type AccountActionInput = S['customers.AccountActionInput'];
export type AccountStatus = CustomerRow['accountStatus'];
export type Verification = CustomerRow['verification'];

export const STATUS_LABEL: Record<AccountStatus, string> = { active: 'Active', under_review: 'Under review', restricted: 'Restricted', suspended: 'Suspended', closed: 'Closed' };
export const VERIFICATION_LABEL: Record<Verification, string> = { email_and_phone: 'Email and phone', email_only: 'Email only', not_verified: 'Not verified' };
export const VERIFIED_TONE: Record<Verification, Tone> = { email_and_phone: 'success', email_only: 'outline', not_verified: 'warning' };

export type AccountAction = AccountActionInput['action'];
export type ReasonCode = AccountActionInput['reasonCode'];

/** The design's actions plus the API's other account actions. Security actions need customers.accounts.security. */
export const ACCOUNT_ACTIONS: Array<{ value: AccountAction; label: string; security?: boolean }> = [
  { value: 'send_password_reset', label: 'Send password reset link', security: true },
  { value: 'sign_out_everywhere', label: 'Sign out of all devices', security: true },
  { value: 'restrict_messaging', label: 'Restrict messaging' },
  { value: 'restrict_ordering', label: 'Restrict ordering' },
  { value: 'restrict_reviews', label: 'Restrict reviews' },
  { value: 'restrict_account', label: 'Restrict account' },
  { value: 'mark_under_review', label: 'Mark under review' },
  { value: 'clear_review', label: 'Clear review' },
  { value: 'suspend', label: 'Suspend account' },
  { value: 'reinstate', label: 'Reinstate account' },
  { value: 'close', label: 'Close account' },
];

export const ACTION_REASONS: Array<{ value: ReasonCode; label: string }> = [
  { value: 'customer_request', label: 'Customer request' },
  { value: 'suspected_takeover', label: 'Suspected account takeover' },
  { value: 'abusive_messages', label: 'Abusive messages' },
  { value: 'payment_fraud_review', label: 'Payment fraud review' },
  { value: 'policy_violation', label: 'Policy violation' },
  { value: 'other', label: 'Other' },
];

export const DATA_REQUEST_LABEL: Record<string, string> = {
  requested: 'Requested',
  preparing: 'Preparing',
  ready: 'Ready',
  failed: 'Failed',
  expired: 'Expired',
  cancelled: 'Cancelled',
  scheduled: 'Scheduled',
  completed: 'Completed',
};

/** A value that settles after the user stops typing (search boxes). */
export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}
