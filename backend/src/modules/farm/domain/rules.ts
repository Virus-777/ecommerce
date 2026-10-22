/**
 * Pure farm rules: order statuses and their labels, staff actions, money and date labels, payment options, the
 * Installments line, farm locations and dealer lines, order references. No I/O.
 */
import { addCalendarDays, isIsoDate } from '../../../kernel/lib/dates.js';
import { format as formatMoney, type Money } from '../../../kernel/lib/money.js';

export const ORDER_STATUSES = ['payment_pending', 'payment_failed', 'placed', 'confirmed', 'out_for_delivery', 'delivered', 'rejected', 'cancelled'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];
/** Orders still on their way (listMyOrders state=open, openOrders on a dealer) */
export const OPEN_STATUSES: OrderStatus[] = ['payment_pending', 'placed', 'confirmed', 'out_for_delivery'];
export const PAST_STATUSES: OrderStatus[] = ['payment_failed', 'delivered', 'rejected', 'cancelled'];

/** Staff moves; reschedule changes the date of a confirmed order without moving it */
export const ADMIN_ACTIONS = ['confirm', 'reject', 'dispatch', 'deliver', 'cancel', 'reschedule'] as const;
export type AdminAction = (typeof ADMIN_ACTIONS)[number];

export const PAYMENT_OPTIONS = ['pay_in_full', 'installments', 'pay_on_delivery'] as const;
export type PaymentOption = (typeof PAYMENT_OPTIONS)[number];

export const LIMITS = {
  name: 80,
  line: 120,
  city: 60,
  region: 40,
  postalCode: 20,
  hours: 80,
  phone: 40,
  email: 120,
  notes: 500,
  reason: 300,
  staffNote: 1000,
  attachments: 8,
  leadDays: 60,
} as const;

/* ------------------------------------------------------------------ labels */

/** $18,900 for whole dollars, $18,900.50 otherwise */
export function moneyLabel(m: Money): string {
  const s = formatMoney(m);
  return m.amount % 100 === 0 ? s.replace(/\.00(?=\D*$)/, '') : s;
}

/** Tue, Nov 3 (a YYYY-MM-DD calendar day) */
export function dayLabel(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).format(d);
}

/** Machine + 1 attachment · delivery included */
export function summaryLabel(attachments: number): string {
  const what = attachments === 0 ? 'Machine' : `Machine + ${attachments} attachment${attachments === 1 ? '' : 's'}`;
  return `${what} · delivery included`;
}

/** The monthly amount of an installment plan, rounded up to whole dollars ($22,100 over 12 months → $1,842) */
export function monthlyAmount(total: number, months: number): number {
  return Math.ceil(total / Math.max(1, months) / 100) * 100;
}

/** Pay on delivery's deposit: `percent` of the total, rounded to whole cents */
export const depositOf = (total: number, percent: number) => Math.round((total * percent) / 100);

/** What the card is authorized and charged for: the total, the pay-on-delivery deposit, or nothing for installments */
export function cardAmountOf(option: string, total: number, depositPercent: number): number {
  if (option === 'pay_in_full') return total;
  if (option === 'pay_on_delivery') return depositOf(total, depositPercent);
  return 0;
}

/** $2,210.00 now (or paid, once charged) · $19,890.00 when it arrives: full amounts, cents included */
export const depositLabel = (m: Money, paid = false) => `${formatMoney(m)} ${paid ? 'paid' : 'now'}`;
export const balanceLabel = (m: Money) => `${formatMoney(m)} when it arrives`;

export interface OptionInfo {
  option: PaymentOption;
  title: string;
  subtitle: string;
  needsCard: boolean;
  cardAmount: Money;
}

/** The three payment options under Payment (FarmOrder artboard) */
export function paymentOptionsFor(total: Money, months: number, depositPercent: number): OptionInfo[] {
  const m = (amount: number) => ({ amount, currency: total.currency });
  return [
    { option: 'pay_in_full', title: 'Pay in full', subtitle: 'Card now · charged when the dealer confirms', needsCard: true, cardAmount: total },
    { option: 'installments', title: 'Installments', subtitle: `${months} months · ${moneyLabel(m(monthlyAmount(total.amount, months)))}/mo, subject to approval`, needsCard: false, cardAmount: m(0) },
    { option: 'pay_on_delivery', title: 'Pay on delivery', subtitle: `${depositPercent}% deposit now, the rest when it arrives`, needsCard: true, cardAmount: m(depositOf(total.amount, depositPercent)) },
  ];
}

/** Pay in full · Visa •••• 4242, Installments · 12 months, subject to approval, Pay on delivery · 10% deposit · Visa •••• 4242 */
export function paymentLabel(option: string, methodLabel: string | null, months: number, depositPercent?: number | null): string {
  if (option === 'pay_in_full') return methodLabel ? `Pay in full · ${methodLabel}` : 'Pay in full';
  if (option === 'installments') return `Installments · ${months} months, subject to approval`;
  return ['Pay on delivery', depositPercent ? `${depositPercent}% deposit` : null, methodLabel].filter(Boolean).join(' · ');
}

/** The deposit percent an order was placed with (its card amount over its total) */
export const percentOf = (cardAmount: number, total: number) => (total > 0 ? Math.round((cardAmount / total) * 100) : 0);

const STATUS_LABEL: Record<OrderStatus, (dealer: string, date: string) => string> = {
  payment_pending: () => 'Confirming your payment',
  payment_failed: () => 'Payment failed',
  placed: (d) => `Waiting for ${d} to confirm`,
  confirmed: (_d, date) => `Confirmed · delivery ${date}`,
  out_for_delivery: () => 'Out for delivery',
  delivered: () => 'Delivered',
  rejected: (d) => `Not accepted by ${d}`,
  cancelled: () => 'Cancelled',
};
export const statusLabel = (status: string, dealer: string, deliveryDate: string) => (STATUS_LABEL[status as OrderStatus] ?? (() => status))(dealer, dayLabel(deliveryDate));

/** Delivery Tue, Nov 3 once the dealer set the date, Requested for Tue, Nov 3 before */
export const deliveryLabel = (date: string, confirmed: boolean, status: string) =>
  status === 'delivered' ? `Delivered · ${dayLabel(date)}` : confirmed ? `Delivery ${dayLabel(date)}` : `Requested for ${dayLabel(date)}`;

/* ------------------------------------------------------------------ dates */

/** Earliest and latest delivery days counted from `today` (YYYY-MM-DD) */
export const deliveryWindow = (today: string, leadDays: number, maxAheadDays: number) => ({ earliest: addCalendarDays(today, leadDays), latest: addCalendarDays(today, Math.max(leadDays, maxAheadDays)) });

export const inWindow = (day: unknown, w: { earliest: string; latest: string }): day is string => isIsoDate(day) && day >= w.earliest && day <= w.latest;

/* ------------------------------------------------------------------ places and contacts */

/** At least 7 digits, only phone characters */
export const isPhone = (s: string) => /^[+\d(][\d\s().+-]*$/.test(s) && s.replace(/\D/g, '').length >= 7;
export const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

/** Hollow Creek Farm, 4410 County Rd 12, Millbrook */
export const locationLabel = (l: { name?: string | null; line1: string; city: string }) => [l.name, l.line1, l.city].filter((x) => x && x.trim()).join(', ');

/** Route 9, Millbrook */
export const addressLabel = (d: { line1: string; city: string }) => `${d.line1}, ${d.city}`;

/** Route 9, Millbrook · 12 mi away, or the address alone */
export const dealerMeta = (address: string, distance: string | null) => (distance ? `${address} · ${distance} away` : address);

/** The Message button: a text to the message phone, else an email */
export function messageOf(d: { message_phone: string | null; message_email: string | null }): { kind: 'sms' | 'email'; to: string } | null {
  if (d.message_phone) return { kind: 'sms', to: d.message_phone };
  if (d.message_email) return { kind: 'email', to: d.message_email };
  return null;
}

/* ------------------------------------------------------------------ references */

export const REF_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
/** FM- plus five characters from the unambiguous alphabet */
export function makeRef(random: () => number = Math.random): string {
  let s = '';
  for (let i = 0; i < 5; i++) s += REF_ALPHABET[Math.floor(random() * REF_ALPHABET.length)];
  return `FM-${s}`;
}
