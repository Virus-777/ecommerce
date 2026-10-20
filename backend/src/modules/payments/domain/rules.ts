/**
 * Pure payment rules: customer-facing states and texts, decline messages, backoff, card expiry, refund
 * caps and views. No I/O.
 */
import { format as moneyFormat } from '../../../kernel/lib/money.js';
import { money as checkedMoney } from '../../../kernel/lib/money.js';
import type * as common from '../../../spec/common.js';
import type { Decline, PaymentDetail, Refund, RefundView } from '../../../spec/payments.js';
import type { DeclineCategory } from '../ports.js';

export type IntentStatus = PaymentDetail['status'];
export type CustomerState = PaymentDetail['customerState'];
export type RefundStatus = Refund['status'];
export type DisputeStatus = 'opened' | 'under_review' | 'won' | 'lost';

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** Money moved or held at the bank */
export const ACCEPTED: readonly IntentStatus[] = ['authorized', 'partially_captured', 'captured'];
export const PENDING: readonly IntentStatus[] = ['created', 'authorizing', 'requires_action', 'pending_check'];
export const ENDED: readonly IntentStatus[] = ['failed', 'voided', 'expired'];
export const is = <T extends string>(list: readonly T[], v: string): v is T => (list as readonly string[]).includes(v);

export const STATUS_LABEL: Record<IntentStatus, string> = {
  created: 'Created',
  requires_action: 'Waiting for bank confirmation',
  authorizing: 'Authorizing',
  pending_check: 'Pending check',
  authorized: 'Authorized',
  partially_captured: 'Partly captured',
  captured: 'Captured',
  failed: 'Failed',
  voided: 'Voided',
  expired: 'Expired',
};

export const CUSTOMER_STATE_LABEL: Record<CustomerState, string> = {
  accepted: 'Accepted',
  pending: 'Pending',
  failed: 'Failed',
  partly_refunded: 'Partly refunded',
  refunded: 'Refunded',
};

/**
 * Customer view: Accepted = authorized, partially_captured or captured; Pending = authorizing, requires_action
 * or pending_check; Failed = failed, voided before an order or expired. Refunded / Partly refunded from sent refunds.
 * A void after an order (order cancelled before capture) released an accepted payment: it stays Accepted.
 */
export function customerState(i: { status: string; order_id: string | null; captured_amount: number; refunded_amount: number }): CustomerState {
  if (is(PENDING, i.status)) return 'pending';
  if (i.status === 'failed' || i.status === 'expired' || (i.status === 'voided' && !i.order_id)) return 'failed';
  if (i.captured_amount > 0 && i.refunded_amount >= i.captured_amount) return 'refunded';
  if (i.refunded_amount > 0) return 'partly_refunded';
  return 'accepted';
}

const BRAND_NAMES: Record<string, string> = { visa: 'Visa', mastercard: 'Mastercard', amex: 'American Express', discover: 'Discover', unionpay: 'UnionPay' };
export const brandName = (brand: string | null | undefined) => (brand ? (BRAND_NAMES[brand.toLowerCase()] ?? brand.charAt(0).toUpperCase() + brand.slice(1)) : 'Card');
const WALLET_NAMES = { apple_pay: 'Apple Pay', google_pay: 'Google Pay' } as const;

/** 'Visa •••• 4417', 'Apple Pay (Visa •••• 4242)' */
export function methodLabel(o: { brand?: string | null; last4?: string | null; wallet?: 'apple_pay' | 'google_pay' | null }): string {
  const card = `${brandName(o.brand)} •••• ${o.last4 ?? '????'}`;
  return o.wallet ? `${WALLET_NAMES[o.wallet]} (${card})` : card;
}

const DECLINE_TEXT: Record<DeclineCategory, { message: (label: string) => string; advice: string; retryable: boolean }> = {
  insufficient_funds: { message: (l) => `Your bank declined ${l} for insufficient funds. Nothing was charged.`, advice: 'Use another card, or contact your bank and try again.', retryable: false },
  card_declined: { message: (l) => `Your bank declined ${l}. Nothing was charged.`, advice: 'Use another card or payment method, or contact your bank.', retryable: false },
  expired_card: { message: (l) => `${l} has expired. Nothing was charged.`, advice: 'Update the expiry date or use another card.', retryable: false },
  incorrect_details: { message: (l) => `Some card details for ${l} were not accepted. Nothing was charged.`, advice: 'Check the card number, expiry date and security code, then try again.', retryable: true },
  authentication_failed: { message: (l) => `Your bank could not confirm ${l}. Nothing was charged.`, advice: 'Try again and complete the check from your bank, or use another card.', retryable: true },
  processing_error: { message: (l) => `We couldn't process ${l}. Nothing was charged.`, advice: 'Try again in a few minutes or use another card.', retryable: true },
  fraud_suspected: { message: (l) => `Your bank declined ${l}. Nothing was charged.`, advice: 'Use another payment method or contact your bank.', retryable: false },
};

/** Customer-safe decline text (never the bank's internal reason) */
export function declineOf(code: string, category: DeclineCategory, label: string): Decline {
  const t = DECLINE_TEXT[category] ?? DECLINE_TEXT.card_declined;
  return { code, category, message: t.message(label), advice: t.advice, retryable: t.retryable };
}

/** Status-check backoff: 30 s, 1 min, 2 min, 5 min, 10 min, then every 15 min */
export function checkBackoffMs(attempts: number): number {
  const steps = [30_000, 60_000, 120_000, 300_000, 600_000];
  return steps[attempts] ?? 900_000;
}

/** Refund re-check and retry backoff: 1, 5, 15, 60 minutes, then every 2 hours */
export function refundBackoffMs(attempts: number): number {
  const steps = [MINUTE, 5 * MINUTE, 15 * MINUTE, HOUR];
  return steps[attempts] ?? 2 * HOUR;
}

/** A card expires at the end of its expiry month; `today` is the market date YYYY-MM-DD */
export function isExpired(expMonth: number, expYear: number, today: string): boolean {
  const [y, m] = today.split('-').map(Number) as [number, number];
  return expYear < y || (expYear === y && expMonth < m);
}

export function validExpiry(expMonth: number, expYear: number): boolean {
  return Number.isInteger(expMonth) && expMonth >= 1 && expMonth <= 12 && Number.isInteger(expYear) && expYear >= 2000 && expYear <= 2100;
}

/** Money in integer minor units (the kernel refuses anything else) */
export const money = (amount: number, currency: string): common.Money => checkedMoney(amount, currency);

export function fmt(m: common.Money): string {
  return moneyFormat(m);
}

/* ---------------------------------------------------------------- refunds */

export const REFUND_STATUS_LABEL: Record<RefundStatus, string> = { requested: 'Requested', processing: 'Processing', sent: 'Sent', failed: 'Failed', cancelled: 'Cancelled' };

/** Customer steps; currentStep is the index (0-based) of the step the refund is at */
export function refundSteps(status: RefundStatus): { steps: string[]; currentStep: number } {
  if (status === 'failed') return { steps: ['Requested', 'Processing', 'Failed'], currentStep: 2 };
  if (status === 'cancelled') return { steps: ['Requested', 'Cancelled'], currentStep: 1 };
  return { steps: ['Requested', 'Processing', 'Sent'], currentStep: status === 'requested' ? 0 : status === 'processing' ? 1 : 2 };
}

export function refundExplanation(status: RefundStatus, storeCredit: boolean): string {
  if (storeCredit) return status === 'sent' ? 'Sent means the credit is in your Marketly account and ready to use.' : 'Store credit is added to your Marketly account as soon as the refund is sent.';
  switch (status) {
    case 'requested':
      return "Requested means we've started your refund. Nothing has been sent to your bank yet.";
    case 'processing':
      return "Processing means we're sending the refund to your bank.";
    case 'sent':
      return "Sent means we've sent it to your bank; it usually shows in 3–5 business days.";
    case 'failed':
      return "We couldn't send this refund. Nothing is lost: choose where it should go instead or wait while we try again.";
    default:
      return 'This refund was cancelled.';
  }
}

/** What the customer can do about a failed refund */
export function refundFailureAction(r: { status: RefundStatus; attempts: number; failure_code: string | null }, retryable: boolean, maxAttempts: number): RefundView['failure'] {
  if (r.status !== 'failed') return null;
  const reason = 'We could not send your refund.';
  if (retryable && r.attempts < maxAttempts) return { reason, action: 'wait_for_retry' };
  return { reason, action: 'choose_new_destination' };
}

const NON_RETRYABLE = new Set(['card_closed', 'account_closed', 'expired_card', 'no_payment', 'invalid_destination', 'destination_needed']);
export const retryableRefundFailure = (code: string | null | undefined) => Boolean(code) && !NON_RETRYABLE.has(code!);

/* ---------------------------------------------------------------- disputes */

export const DISPUTE_STATUS_LABEL: Record<DisputeStatus, string> = { opened: 'Opened: evidence needed', under_review: 'Under review by the issuer', won: 'Won', lost: 'Lost' };

export function deadlineOf(dueAt: Date | null, now: Date, dueSoonMs = 48 * HOUR): common.Deadline | null {
  if (!dueAt) return null;
  const left = dueAt.getTime() - now.getTime();
  return { dueAt: dueAt.toISOString(), state: left < 0 ? 'overdue' : left <= dueSoonMs ? 'due_soon' : 'on_time' };
}

/** Effect on the seller balance (finance holds on chargeback.opened and applies or releases on decided) */
export function sellerBalanceEffect(d: { status: string; amount: number; currency: string }, ownerType: 'official' | 'seller' | null): string {
  const amount = fmt(money(d.amount, d.currency));
  if (ownerType === 'official') return d.status === 'lost' ? `Company sale. A loss of ${amount} is recorded in company trading.` : 'Company sale. A loss is recorded in company trading.';
  if (ownerType !== 'seller') return 'Not linked to one seller. Finance decides who carries the loss.';
  if (d.status === 'won') return `Hold of ${amount} released`;
  if (d.status === 'lost') return `${amount} deducted from the seller balance`;
  return `Held ${amount}`;
}

/** Reference prefix per dispute kind: CB- chargebacks, DP- inquiries and wallet disputes */
export const disputePrefix = (kind: string) => (kind === 'chargeback' ? 'CB' : 'DP');

/** The order a refund belongs to as the API and the refund events show it: an orphan payment refund has no order, its checkout session stands in */
export const refundOrderKey = (r: { order_id: string | null; checkout_session_id: string }): string => r.order_id ?? r.checkout_session_id;
