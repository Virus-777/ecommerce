// Cart and checkout API helpers for the purchase-flow screens: types, queries, the URL params each
// checkout page carries, Idempotency-Key handling and the development payment tokens (gap G9).
import { useQuery } from '@tanstack/react-query';
import { useRef } from 'react';
import { call, newIdempotencyKey, toApiError, useApi, type components } from '@marketly/web-shared/api';
import { href } from '@marketly/web-shared/routes';

type S = components['schemas'];
export type CartView = S['cart.CartView'];
export type CartItem = S['cart.CartItem'];
export type CartNotice = S['cart.CartNotice'];
export type CartPackage = S['cart.CartPackage'];
export type CouponPreview = S['cart.CouponPreview'];
export type CheckoutView = S['checkout.CheckoutView'];
export type CheckoutPackage = S['checkout.CheckoutPackage'];
export type CheckoutLine = S['checkout.CheckoutLine'];
export type CouponResult = S['checkout.CouponResult'];
export type QuoteTotals = S['checkout.QuoteTotals'];
export type PlaceOrderResult = S['checkout.PlaceOrderResult'];
export type ChangeSet = S['checkout.ChangeSet'];
export type Change = S['checkout.Change'];
export type ChangeDecision = S['checkout.ChangeDecision'];
export type ConfirmationView = S['checkout.ConfirmationView'];
export type PaymentStatusView = S['payments.PaymentStatusView'];
export type MethodSelection = S['payments.MethodSelection'];
export type SavedPaymentMethod = S['payments.SavedPaymentMethod'];
export type SavedAddress = S['customers.SavedAddress'];
export type Address = S['Address'];
export type Money = S['Money'];

/* ---------------- Routes: the checkout session travels in the URL ---------------- */

/** /checkout?session=<checkout session id> */
export const checkoutHref = (session: string) => href('store/checkout', '', undefined, { session });
/** /checkout/review-changes?session=<id>&changes=<change set id> */
export const reviewChangesHref = (session: string, changes?: string | null) => href('store/checkout-review-changes', '', undefined, changes ? { session, changes } : { session });
/** /checkout/payment?session=<id>&intent=<payment intent id> */
export const paymentHref = (session: string, intent?: string | null) => href('store/payment-result', '', undefined, intent ? { session, intent } : { session });
/** /checkout/confirmation?session=<id> */
export const confirmationHref = (session: string) => href('store/confirmation', '', undefined, { session });

/** The screen a Place order / retry / complete-action result sends the shopper to. */
export function nextHref(r: PlaceOrderResult, session: string): string {
  switch (r.next) {
    case 'confirmation':
      return confirmationHref(session);
    case 'review_changes':
      return reviewChangesHref(session, r.changeSet?.id ?? r.checkout.openChangeSetId);
    default:
      // payment_result and complete_action (the bank check) are both handled on the payment-result page.
      return paymentHref(session, r.payment?.intentId ?? r.checkout.lastPayment?.intentId);
  }
}

/** Where a checkout in a given state belongs (null = the checkout page itself). */
export function routeForStatus(c: CheckoutView): string | null {
  if (c.status === 'completed') return confirmationHref(c.id);
  if (c.status === 'payment_pending' || c.status === 'awaiting_action' || c.status === 'payment_failed') return paymentHref(c.id, c.lastPayment?.intentId);
  if (c.status === 'changes_pending' && c.openChangeSetId) return reviewChangesHref(c.id, c.openChangeSetId);
  return null;
}

/** Return URL for a bank challenge (absolute, as the API requires a URL). */
export const returnUrl = (session: string) => `${window.location.origin}${paymentHref(session)}`;

/* ---------------- Queries ---------------- */

export const checkoutKey = (id: string) => ['checkout', 'session', id] as const;

export function useCheckoutSession(id: string | null) {
  const { api } = useApi();
  return useQuery({
    queryKey: checkoutKey(id ?? ''),
    queryFn: () => call(api.GET('/api/store/checkout/sessions/{id}', { params: { path: { id: id! } } })),
    enabled: !!id,
  });
}

export const intentKey = (id: string) => ['payments', 'intent', id] as const;

/** Payment result; re-read on its own while the bank is still answering (every nextCheckInSeconds, default 30 s). */
export function usePaymentIntent(id: string | null | undefined) {
  const { api } = useApi();
  return useQuery({
    queryKey: intentKey(id ?? ''),
    queryFn: () => call(api.GET('/api/store/payments/intents/{id}', { params: { path: { id: id! } } })),
    enabled: !!id,
    refetchInterval: (q) => (q.state.data?.state === 'pending' ? Math.max(q.state.data.nextCheckInSeconds ?? 30, 5) * 1000 : false),
  });
}

/** Support phone and hours, guest checkout switch (GET /api/public/settings/app-config). */
export function useAppConfig() {
  const { api } = useApi();
  return useQuery({
    queryKey: ['settings', 'app-config'],
    queryFn: () => call(api.GET('/api/public/settings/app-config')),
    staleTime: 5 * 60_000,
  });
}

/* ---------------- Idempotency ---------------- */

/**
 * One Idempotency-Key per user action: the same key while the request is the same (retries after a
 * network failure replay the first result), a new key once the request changes (new quote, new method).
 */
export function useIdempotencyKey() {
  const ref = useRef<{ sig: string; key: string } | null>(null);
  return (sig: string) => {
    if (!ref.current || ref.current.sig !== sig) ref.current = { sig, key: newIdempotencyKey() };
    return ref.current.key;
  };
}

/* ---------------- Payment (development tokens, gap G9) ---------------- */

/**
 * Development card processor tokens. The API takes a provider token, never a card number; in production the
 * payment provider's card fields produce the token. Until then the new-card form offers these test cards.
 */
export const DEV_CARDS: Array<{ value: string; label: string }> = [
  { value: 'tok_visa', label: 'Visa •••• 4242 · approved' },
  { value: 'tok_mastercard', label: 'Mastercard •••• 4444 · approved' },
  { value: 'tok_amex', label: 'American Express · approved' },
  { value: 'tok_declined', label: 'Card declined by the bank (code 05)' },
  { value: 'tok_insufficient', label: 'Insufficient funds (code 51)' },
  { value: 'tok_expired', label: 'Expired card (code 54)' },
  { value: 'tok_3ds', label: 'Bank asks for a security check (3-D Secure)' },
  { value: 'tok_timeout', label: 'Bank answers late (payment pending)' },
  { value: 'tok_pending', label: 'Bank keeps checking (settle it on the payment page)' },
];

/**
 * Development only (gap G60): answers a payment the development processor holds (card token tok_pending)
 * with POST /api/dev/payments/intents/{id}/settle. The dev routes are outside the API spec, so this is a
 * plain fetch with the session token. Returns the PaymentStatusView.
 */
export function useDevSettle() {
  const { session } = useApi();
  return async (intentId: string, outcome: 'authorized' | 'declined'): Promise<PaymentStatusView> => {
    const res = await fetch(`/api/dev/payments/intents/${encodeURIComponent(intentId)}/settle`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await session.token()}`, 'Content-Type': 'application/json', 'X-Client': 'web' },
      body: JSON.stringify({ outcome }),
    });
    if (!res.ok) throw await toApiError(res);
    return (await res.json()) as PaymentStatusView;
  };
}

/** Dev 3-D Secure results for complete-action: approve or fail the bank check. */
export const DEV_3DS_OK = '3ds_ok';
export const DEV_3DS_FAIL = '3ds_fail';

export const BRAND: Record<string, string> = { visa: 'Visa', mastercard: 'Mastercard', amex: 'American Express', discover: 'Discover' };
export const brandName = (b: string) => BRAND[b.toLowerCase()] ?? b.charAt(0).toUpperCase() + b.slice(1);
export const savedCardTitle = (m: SavedPaymentMethod) => `${brandName(m.brand)} •••• ${m.last4}`;
export const expiry = (m: SavedPaymentMethod) => `${String(m.expMonth).padStart(2, '0')}/${String(m.expYear).slice(-2)}`;

export const DECLINE_LABEL: Record<string, string> = {
  insufficient_funds: 'insufficient funds',
  card_declined: 'card declined',
  expired_card: 'expired card',
  incorrect_details: 'incorrect card details',
  authentication_failed: 'security check failed',
  processing_error: 'processing error',
  fraud_suspected: 'blocked by the bank',
};

/* ---------------- Formatting ---------------- */

const TZ = 'America/Los_Angeles';
/** "3:15 PM PT" in the market time zone. */
export const timePT = (iso: string) => `${new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: TZ })} PT`;
/** "Thu, Oct 8, 2:39 PM PT" */
export const dateTimePT = (iso: string) =>
  `${new Date(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: TZ })}, ${timePT(iso)}`;

/** "Order within 2 h 18 min" for a delivery option cutoff in the future (null when past or far away). */
export function orderWithin(cutoffAt?: string | null, now = Date.now()): string | null {
  if (!cutoffAt) return null;
  const mins = Math.floor((new Date(cutoffAt).getTime() - now) / 60_000);
  if (mins <= 0 || mins > 12 * 60) return null;
  const h = Math.floor(mins / 60);
  return `Order within ${h ? `${h} h ` : ''}${mins % 60} min`;
}

export const addressLine = (a: Address) => [a.line1, a.line2, `${a.city}, ${a.region} ${a.postalCode}`].filter(Boolean).join(', ');

/** US states and DC (name ↔ region code) for the address forms. */
export const US_STATES: Array<{ value: string; label: string }> = [
  ['AL', 'Alabama'], ['AK', 'Alaska'], ['AZ', 'Arizona'], ['AR', 'Arkansas'], ['CA', 'California'], ['CO', 'Colorado'], ['CT', 'Connecticut'],
  ['DE', 'Delaware'], ['DC', 'District of Columbia'], ['FL', 'Florida'], ['GA', 'Georgia'], ['HI', 'Hawaii'], ['ID', 'Idaho'], ['IL', 'Illinois'],
  ['IN', 'Indiana'], ['IA', 'Iowa'], ['KS', 'Kansas'], ['KY', 'Kentucky'], ['LA', 'Louisiana'], ['ME', 'Maine'], ['MD', 'Maryland'],
  ['MA', 'Massachusetts'], ['MI', 'Michigan'], ['MN', 'Minnesota'], ['MS', 'Mississippi'], ['MO', 'Missouri'], ['MT', 'Montana'], ['NE', 'Nebraska'],
  ['NV', 'Nevada'], ['NH', 'New Hampshire'], ['NJ', 'New Jersey'], ['NM', 'New Mexico'], ['NY', 'New York'], ['NC', 'North Carolina'],
  ['ND', 'North Dakota'], ['OH', 'Ohio'], ['OK', 'Oklahoma'], ['OR', 'Oregon'], ['PA', 'Pennsylvania'], ['RI', 'Rhode Island'],
  ['SC', 'South Carolina'], ['SD', 'South Dakota'], ['TN', 'Tennessee'], ['TX', 'Texas'], ['UT', 'Utah'], ['VT', 'Vermont'], ['VA', 'Virginia'],
  ['WA', 'Washington'], ['WV', 'West Virginia'], ['WI', 'Wisconsin'], ['WY', 'Wyoming'],
].map(([value, label]) => ({ value, label }));
