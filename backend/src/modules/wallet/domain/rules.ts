/**
 * Pure wallet rules: lot allocation, expiry dates, ledger labels, gift card codes, actor encoding.
 * No I/O here; the service feeds rows in and writes what comes out.
 */
import { addMonths } from '../../../kernel/lib/dates.js';
import { createHash, createHmac, randomInt } from 'node:crypto';
import { format } from '../../../kernel/lib/money.js';
import type * as common from '../../../spec/common.js';
import type { CreditLot, LedgerEntry } from '../../../spec/wallet.js';
import type { LotAllocation } from '../ports.js';

export type EntryKind = LedgerEntry['kind'];
export type LotSource = CreditLot['source'];

export const m = (amount: number, currency: string): common.Money => ({ amount, currency });

/** Entries that only move credit between available and held (shown to staff; the customer sees the balance) */
export const RESERVATION_KINDS: readonly EntryKind[] = ['hold', 'release'];

export const USABLE_ON = 'Any item from any seller; not on gift cards';
export const HOW_TO_USE = 'Choose to use it at the payment step of checkout.';

/**
 * Takes `amount` from lots in the order given (callers pass them earliest-expiring first).
 * Returns null when the lots hold less than the amount.
 */
export function allocate(lots: readonly { id: string; remaining: number }[], amount: number): LotAllocation[] | null {
  const out: LotAllocation[] = [];
  let left = amount;
  for (const lot of lots) {
    if (left <= 0) break;
    const take = Math.min(lot.remaining, left);
    if (take <= 0) continue;
    out.push({ lotId: lot.id, amount: take });
    left -= take;
  }
  return left > 0 ? null : out;
}

export const allocated = (a: readonly LotAllocation[] | null | undefined) => (a ?? []).reduce((s, x) => s + x.amount, 0);

/** Goodwill and price-adjustment credit: the grant's own days, else creditExpiryMonths (0 or less: no expiry) */
export function goodwillExpiry(now: Date, expiresInDays: number | null | undefined, months: number): Date | null {
  if (expiresInDays != null && expiresInDays > 0) return new Date(now.getTime() + expiresInDays * 86_400_000);
  return months > 0 ? addMonths(now, months) : null;
}

/** expiryReminderDays setting → distinct positive whole days, largest first (anything unusable: [30, 7]) */
export function reminderDays(setting: unknown): number[] {
  const days = Array.isArray(setting) ? [...new Set(setting.map(Number).filter((d) => Number.isInteger(d) && d > 0))] : [];
  return (days.length ? days : [30, 7]).sort((a, b) => b - a);
}

/** Whole days left until expiry, rounded up (a lot expiring in 6.5 days has 7 days left) */
export const daysLeft = (expiresAt: Date, now: Date) => Math.ceil((expiresAt.getTime() - now.getTime()) / 86_400_000);

/**
 * The reminder a lot is due for: the smallest reminder day it has reached (days left ≤ day). A lot that
 * skips a reminder (granted with 20 days left, or a missed run) gets the latest one it reached, never two at once.
 */
export function dueReminder(left: number, days: readonly number[]): number | null {
  if (left <= 0) return null;
  const reached = days.filter((d) => left <= d);
  return reached.length ? Math.min(...reached) : null;
}

const REASONS: Record<string, string | null> = {
  late_delivery: 'late delivery',
  service_failure: 'service issue',
  price_adjustment: 'price adjustment',
  damaged_item: 'damaged item',
  other: null,
};

export interface LabelFacts {
  kind: EntryKind;
  /** The amount the entry concerns (holds and releases move credit without changing the balance) */
  amount: common.Money;
  orderRef?: string | null;
  caseRef?: string | null;
  /** Lot reference of a credit entry, e.g. "case CS-…", "gift card ••••7KQ2" */
  reference?: string | null;
  reasonCode?: string | null;
}

/** One line of the credit history, e.g. "Goodwill credit · case CS-260903-1876, late delivery" */
export function entryLabel(f: LabelFacts): string {
  const order = f.orderRef ? `order ${f.orderRef}` : null;
  const amount = format(m(Math.abs(f.amount.amount), f.amount.currency));
  switch (f.kind) {
    case 'refund_to_credit':
      return `Refund to store credit${order ? ` · ${order}` : ''}`;
    case 'order_refund_returned':
      return order ? `Credit returned from refunded ${order}` : 'Credit returned from a refund';
    case 'goodwill': {
      const about = f.caseRef ? `case ${f.caseRef}` : order;
      const why = f.reasonCode ? REASONS[f.reasonCode] : null;
      return `Goodwill credit${about ? ` · ${about}` : ''}${why ? `${about ? ',' : ' ·'} ${why}` : ''}`;
    }
    case 'price_adjustment':
      return `Price adjustment${order ? ` · ${order}` : ''}`;
    case 'gift_card_redeemed':
      return `${f.reference ? capitalize(f.reference) : 'Gift card'} added`;
    case 'hold':
      return `${amount} reserved for checkout`;
    case 'capture':
      return order ? `Used on ${order}` : 'Used at checkout';
    case 'release':
      return `${amount} reservation released`;
    case 'expiry':
      return 'Credit expired';
    case 'correction':
      return 'Balance correction';
    case 'reversal':
      return `Goodwill credit reversed${f.caseRef ? ` · case ${f.caseRef}` : order ? ` · ${order}` : ''}`;
  }
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "case CS-…" in a lot reference → the case reference */
export const caseRefOf = (reference: string | null | undefined) => reference?.match(/^case (\S+)/)?.[1] ?? null;

/* ---------------------------------------------------------------- gift card codes */

/** No 0/O, 1/I: codes are read off cards and typed */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_CHARS = 16; // 80 bits

/** A new random code, e.g. 7KQ2-M9XA-PL4D-T8WE */
export function newGiftCardCode(): string {
  let s = '';
  for (let i = 0; i < CODE_CHARS; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return s.match(/.{4}/g)!.join('-');
}

/** Upper case without spaces or dashes; null when it cannot be a code */
export function normalizeCode(code: string): string | null {
  const s = code.toUpperCase().replace(/[\s-]/g, '');
  if (s.length !== CODE_CHARS) return null;
  for (const c of s) if (!ALPHABET.includes(c)) return null;
  return s;
}

/** Codes are stored only as keyed hashes (HMAC-SHA256 with the wallet.giftcards key) */
export const hashCode = (key: string, normalized: string) => createHmac('sha256', key).update(normalized).digest('hex');

export const last4Of = (normalized: string) => normalized.slice(-4);

/* ---------------------------------------------------------------- ids and actors */

/** A stable UUID for a key (approval targets, batches), so retries find the same record */
export function detId(key: string): string {
  const h = createHash('sha256').update(key).digest('hex');
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export const actorText = (a: common.Actor) => JSON.stringify({ kind: a.kind, id: a.id ?? null, ...(a.name ? { name: a.name } : {}) });

export function actorFrom(text: string | null | undefined): common.Actor | null {
  if (!text) return null;
  try {
    const a = JSON.parse(text) as common.Actor;
    if (a && typeof a.kind === 'string') return { kind: a.kind, id: a.id ?? null, ...(a.name ? { name: a.name } : {}) };
  } catch {
    /* not JSON: an old plain value */
  }
  return { kind: 'system', id: text };
}

export const SYSTEM: common.Actor = { kind: 'system', id: null, name: 'Marketly' };
