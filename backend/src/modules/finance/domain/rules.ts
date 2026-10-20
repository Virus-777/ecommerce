/**
 * Pure finance rules: fee calculation, ledger vocabulary, statement sections, payout schedule dates
 * and small helpers. No I/O.
 */
import { format as moneyFormat } from '../../../kernel/lib/money.js';
import { money as checkedMoney } from '../../../kernel/lib/money.js';
import { createHash } from 'node:crypto';
import { dateInZone, zonedTimeToUtc } from '../../../kernel/lib/clock.js';
import type * as common from '../../../spec/common.js';
import type { FeeCalculation, FeeLine, FeeTreatment } from '../../../spec/finance.js';

export const DAY = 86_400_000;

/** A UUID derived from a key (idempotent inserts: the same fact always gets the same id) */
export function detId(key: string): string {
  const h = createHash('sha256').update(key).digest('hex');
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Money in integer minor units (the kernel refuses anything else) */
export const m = (amount: number, currency: string): common.Money => checkedMoney(amount, currency);

/** Display money, e.g. $184.00 or -$5.90 */
export function fmt(amount: number, currency = 'USD'): string {
  const s = moneyFormat({ amount: Math.abs(amount), currency });
  return amount < 0 ? `-${s}` : s;
}

export const pct = (bps: number) => `${bps % 100 === 0 ? String(bps / 100) : (bps / 100).toFixed(2).replace(/0$/, '')}%`;

/** amount × bps / 10 000, rounded half away from zero */
export function bpsOf(amount: number, bps: number): number {
  const exact = (amount * bps) / 10_000;
  return Math.sign(exact) * Math.round(Math.abs(exact));
}

/** part × num / den, rounded half away from zero (den 0 → 0) */
export function prorate(part: number, num: number, den: number): number {
  if (!den) return 0;
  const exact = (part * num) / den;
  return Math.sign(exact) * Math.round(Math.abs(exact));
}

/* ---------------------------------------------------------------- fees */

export interface RuleModel {
  id: string;
  version: string;
  basis: 'after_seller_discounts' | 'before_discounts';
  includeShipping: boolean;
  platformDiscountsReduceFee: boolean;
  defaultRateBps: number;
  categoryRates: Map<string, number>;
  treatment: FeeTreatment;
}

export interface FeeInput {
  categoryId?: string | null;
  itemPrice: number;
  sellerDiscount?: number;
  platformDiscount?: number;
  shippingCharged?: number;
}

export const DEFAULT_TREATMENT: FeeTreatment = {
  cancellationBeforeDispatch: 'no_fee',
  returns: 'fee_returned_pro_rata',
  paymentDisputes: 'fee_kept_returned_if_won',
  text: 'No fee is charged on items cancelled before dispatch. On returns the fee is returned in proportion to the refunded item price. During a payment dispute the fee is kept; it is returned if the dispute is won.',
};

export const rateFor = (rule: RuleModel, categoryId?: string | null) => (categoryId && rule.categoryRates.has(categoryId) ? rule.categoryRates.get(categoryId)! : rule.defaultRateBps);

/** Fee basis and seller earnings for one item under a rule set */
export function calculate(rule: RuleModel, input: FeeInput, currency: string): FeeCalculation {
  const price = input.itemPrice;
  const sellerDiscount = Math.max(0, input.sellerDiscount ?? 0);
  const platformDiscount = Math.max(0, input.platformDiscount ?? 0);
  const shipping = Math.max(0, input.shippingCharged ?? 0);
  let basis = rule.basis === 'after_seller_discounts' ? price - sellerDiscount : price;
  if (rule.platformDiscountsReduceFee) basis -= platformDiscount;
  if (rule.includeShipping) basis += shipping;
  basis = Math.max(0, basis);
  const rateBps = rateFor(rule, input.categoryId);
  const fee = bpsOf(basis, rateBps);
  const proceeds = price - sellerDiscount - (rule.platformDiscountsReduceFee ? platformDiscount : 0) + shipping;
  const lines: FeeLine[] = [{ label: 'Item price', amount: m(price, currency) }];
  if (sellerDiscount) lines.push({ label: 'Your discount', amount: m(-sellerDiscount, currency) });
  if (platformDiscount) lines.push({ label: rule.platformDiscountsReduceFee ? 'Marketly-funded discount' : 'Marketly-funded discount (paid by Marketly, not deducted)', amount: m(rule.platformDiscountsReduceFee ? -platformDiscount : 0, currency) });
  if (shipping) lines.push({ label: 'Shipping charged', amount: m(shipping, currency) });
  lines.push({ label: `Marketplace fee: ${pct(rateBps)} of ${fmt(basis, currency)}${rule.includeShipping ? '' : shipping ? ' (shipping excluded)' : ''}`, amount: m(-fee, currency) });
  return {
    itemPrice: m(price, currency),
    sellerDiscount: m(sellerDiscount, currency),
    platformDiscount: m(platformDiscount, currency),
    shippingCharged: m(shipping, currency),
    feeBasis: m(basis, currency),
    rateBps,
    fee: m(fee, currency),
    sellerEarnings: m(proceeds - fee, currency),
    lines,
    ruleVersion: rule.version,
  };
}

export function feeBasisNote(rule: RuleModel, rateBps = rule.defaultRateBps): string {
  const after = rule.basis === 'after_seller_discounts' ? 'the item price after your discounts' : 'the item price before discounts';
  const ship = rule.includeShipping ? 'shipping is included' : 'shipping is not included';
  const platform = rule.platformDiscountsReduceFee ? 'Marketly-funded discounts lower the basis' : 'Marketly-funded discounts do not lower your proceeds or the fee';
  return `Fee is ${pct(rateBps)} of ${after}; ${ship}. ${platform}.`;
}

/* ---------------------------------------------------------------- ledger vocabulary */

export type EntryType =
  | 'sale'
  | 'shipping_charge'
  | 'seller_discount'
  | 'marketplace_fee'
  | 'fee_refund'
  | 'refund'
  | 'refund_after_payout'
  | 'hold'
  | 'hold_release'
  | 'adjustment'
  | 'ad_charge'
  | 'service_fee'
  | 'charge_credit'
  | 'seller_credit'
  | 'label_charge'
  | 'chargeback'
  | 'payout'
  | 'payout_returned'
  | 'owed_offset'
  | 'cancellation';

export const TYPE_LABELS: Record<EntryType, string> = {
  sale: 'Sale',
  shipping_charge: 'Shipping charged',
  seller_discount: 'Your discount',
  marketplace_fee: 'Marketplace fee',
  fee_refund: 'Fee refund',
  refund: 'Refund',
  refund_after_payout: 'Refund after payout',
  hold: 'Hold',
  hold_release: 'Hold released',
  adjustment: 'Adjustment',
  ad_charge: 'Ad charge',
  service_fee: 'Fulfillment service fee',
  charge_credit: 'Charge credited back',
  seller_credit: 'Credit from Marketly',
  label_charge: 'Label charge',
  chargeback: 'Chargeback',
  payout: 'Payout',
  payout_returned: 'Payout returned',
  owed_offset: 'Amount owed settled',
  cancellation: 'Cancellation',
};

/** Seller ledger tabs (GET /ledger?type=) */
export const TYPE_GROUPS: Record<string, EntryType[]> = {
  sales: ['sale', 'shipping_charge', 'seller_discount', 'cancellation'],
  fees: ['marketplace_fee', 'fee_refund'],
  refunds: ['refund', 'refund_after_payout', 'chargeback'],
  payouts: ['payout', 'payout_returned'],
  holds: ['hold', 'hold_release'],
  adjustments: ['adjustment', 'owed_offset', 'label_charge', 'service_fee', 'charge_credit', 'seller_credit'],
  ads: ['ad_charge'],
};

export type SectionKey = 'sales' | 'fees' | 'refunds' | 'holds' | 'adjustments' | 'ads';

/** Statement section of an entry type (payouts are the reconciliation's payout line) */
export const SECTION_OF: Record<EntryType, SectionKey | null> = {
  sale: 'sales',
  shipping_charge: 'sales',
  seller_discount: 'sales',
  cancellation: 'sales',
  marketplace_fee: 'fees',
  fee_refund: 'fees',
  refund: 'refunds',
  refund_after_payout: 'refunds',
  chargeback: 'refunds',
  hold: 'holds',
  hold_release: 'holds',
  adjustment: 'adjustments',
  owed_offset: 'adjustments',
  label_charge: 'adjustments',
  payout_returned: 'adjustments',
  ad_charge: 'ads',
  // fulfillment-service fees stay apart from commission; a credit follows its charge (sectionOf)
  service_fee: 'adjustments',
  charge_credit: 'adjustments',
  // credits without an original charge (fulfillment-service reimbursements, goodwill to a seller)
  seller_credit: 'adjustments',
  payout: null,
};

/** Statement section of an entry: credits of an ad charge sit with the ad charges */
export const sectionOf = (type: EntryType, refKind: string | null | undefined): SectionKey | null => (type === 'charge_credit' && refKind === 'ad_campaign' ? 'ads' : SECTION_OF[type]);

export const SECTIONS: { key: SectionKey; title: string; subtitle: string; totalLabel: string }[] = [
  { key: 'sales', title: 'Sales', subtitle: 'Items whose earnings settle in this statement, with shipping you charged and your discounts', totalLabel: 'Sales proceeds' },
  { key: 'fees', title: 'Marketplace fees', subtitle: 'Fee per item with the basis it was charged on, and fees returned on refunds', totalLabel: 'Fees total' },
  { key: 'refunds', title: 'Refunds', subtitle: 'Refunds and cancellations, including refunds after a payout', totalLabel: 'Refunds total' },
  { key: 'holds', title: 'Holds and releases', subtitle: 'Earnings withheld with a reason and review date, and earlier holds released', totalLabel: 'Holds net' },
  { key: 'adjustments', title: 'Adjustments', subtitle: 'Credits and debits with reasons, label charges, fulfillment service fees and returned payouts', totalLabel: 'Adjustments net' },
  { key: 'ads', title: 'Advertising', subtitle: 'Ad charges and ad credits, separate from commission', totalLabel: 'Ad charges' },
];

/* ---------------------------------------------------------------- dates */

export const addDays = (date: string, days: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
export const marketDate = (at: Date, tz: string) => dateInZone(at, tz);
/** Start of a market day as an instant */
export const dayStart = (date: string, tz: string) => zonedTimeToUtc(date, '00:00', tz);
export const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);
export const weekday = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();
export const isPeriod = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
export const daysInMonth = (period: string) => {
  const [y, mo] = period.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, mo, 0)).getUTCDate();
};

const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** payoutSchedule 'weekly:FRI' → payout weekday (0 = Sunday); unknown values fall back to Friday */
export function payoutWeekday(schedule: string): number {
  const day = String(schedule ?? '').split(':')[1]?.toUpperCase() ?? 'FRI';
  const i = WEEKDAYS.indexOf(day);
  return i >= 0 ? i : 5;
}

export const scheduleLabel = (schedule: string) => `Weekly, ${WEEKDAY_NAMES[payoutWeekday(schedule)]}`;

export interface PayoutSlot {
  /** Payout day (market date) */
  payDate: string;
  /** Earnings up to this instant are in the run: 23:59 market time the day before the payout day */
  cutoffAt: Date;
  /** When the run is released: payoutReleaseTime on the payout day */
  releaseAt: Date;
}

/** The payout slot of a payout day */
export function slotFor(payDate: string, releaseTime: string, tz: string): PayoutSlot {
  const cutoffDay = addDays(payDate, -1);
  return { payDate, cutoffAt: new Date(zonedTimeToUtc(cutoffDay, '23:59', tz).getTime() + 59_000), releaseAt: zonedTimeToUtc(payDate, /^\d{2}:\d{2}$/.test(releaseTime) ? releaseTime : '10:00', tz) };
}

/** The next payout whose cutoff has not passed */
export function nextSlot(now: Date, schedule: string, releaseTime: string, tz: string): PayoutSlot {
  const wd = payoutWeekday(schedule);
  let date = marketDate(now, tz);
  for (let i = 0; i < 15; i++) {
    if (weekday(date) === wd) {
      const s = slotFor(date, releaseTime, tz);
      if (s.cutoffAt.getTime() > now.getTime()) return s;
    }
    date = addDays(date, 1);
  }
  return slotFor(date, releaseTime, tz);
}

/** The latest payout slot whose cutoff has passed */
export function lastSlot(now: Date, schedule: string, releaseTime: string, tz: string): PayoutSlot {
  const wd = payoutWeekday(schedule);
  let date = addDays(marketDate(now, tz), 1);
  for (let i = 0; i < 15; i++) {
    if (weekday(date) === wd) {
      const s = slotFor(date, releaseTime, tz);
      if (s.cutoffAt.getTime() <= now.getTime()) return s;
    }
    date = addDays(date, -1);
  }
  return slotFor(date, releaseTime, tz);
}

export const shortDate = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/* ---------------------------------------------------------------- actors */

export function encodeActor(a: common.Actor | null | undefined): string | null {
  if (!a) return null;
  return JSON.stringify({ kind: a.kind, id: a.id ?? null, ...(a.name ? { name: a.name } : {}) });
}

export function decodeActor(s: string | null | undefined): common.Actor | null {
  if (!s) return null;
  try {
    const v = JSON.parse(s);
    if (v && typeof v === 'object' && typeof v.kind === 'string') return { kind: v.kind, id: v.id ?? null, ...(v.name ? { name: v.name } : {}) };
  } catch {
    /* plain id */
  }
  return { kind: 'staff', id: s };
}

export const SYSTEM: common.Actor = { kind: 'system', id: null };
