/** Pure wishlist rules: price hints, drop conditions, cooldowns, alert labels and share tokens. No I/O. */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { format } from '../../../kernel/lib/money.js';
import type { Money } from '../../../spec/common.js';
import type { PriceHint } from '../../../spec/wishlist.js';

/** Why an alert is paused (shown as pausedReason). System reasons resume on their own; the customer's does not. */
export const PAUSED = {
  byCustomer: 'Paused by you',
  productUnavailable: 'This product is not available right now',
  preferencesOff: 'Wishlist alerts are off in your notification preferences',
} as const;

export const DELIVERY_NOTE = {
  on: 'Alerts arrive as notifications and email. Turn alerts off any time. These are separate from order updates.',
  off: 'Wishlist alerts are off in your notification preferences. Turn them on in Account > Notifications to get price-drop and back-in-stock notices. These are separate from order updates.',
} as const;

export const MAX_LIST_NAME = 60;
export const MAX_NOTE = 500;
export const MAX_SAVED_STATUS_IDS = 100;
/** Items shown on a shared list (read-only page, no paging in the contract) */
export const SHARED_LIST_ITEMS = 100;

/** Publication states in which a product cannot be bought: alerts pause, items show as unavailable */
export const UNAVAILABLE_PUBLICATIONS = new Set(['suspended', 'hidden']);
/** Offer statuses a saved offer can still be shown with (out of stock keeps the same seller on the card) */
export const SHOWABLE_OFFER_STATUSES = new Set(['active', 'out_of_stock']);

/**
 * A drop that counts: the price is at least minDropPct below the reference (the price when the alert was armed,
 * or the price of its last notice), and at or below the target price when one is set.
 */
export function dropMet(price: number, referencePrice: number | null, targetPrice: number | null, minDropPct: number): boolean {
  if (targetPrice !== null && price > targetPrice) return false;
  if (referencePrice === null) return targetPrice !== null;
  if (price >= referencePrice) return false;
  const pct = Math.max(0, Number(minDropPct) || 0);
  return referencePrice - price >= Math.ceil((referencePrice * pct) / 100);
}

/** True while the last notice of an alert is inside the cooldown */
export function inCooldown(lastNotifiedAt: Date | null, now: Date, cooldownHours: number): boolean {
  if (!lastNotifiedAt) return false;
  return now.getTime() - lastNotifiedAt.getTime() < Math.max(0, Number(cooldownHours) || 0) * 3_600_000;
}

/**
 * Honest price hint from offers.priceRange: 'Lowest in N days' only when the shown price is the lowest in the
 * window; 'Same price for N days' when nothing changed; else the typical range.
 */
export function priceHint(range: { lowest: Money; highest: Money; current: Money; unchanged: boolean } | null, shown: Money | null, days: number): PriceHint {
  if (!range || !shown || range.lowest.currency !== shown.currency) return { kind: 'none', label: 'No price history yet', low: null, high: null, windowDays: days };
  if (range.unchanged && shown.amount === range.current.amount) return { kind: 'unchanged', label: `Same price for ${days} days`, low: range.current, high: range.current, windowDays: days };
  if (shown.amount <= range.lowest.amount) return { kind: 'lowest_in_window', label: `Lowest in ${days} days`, low: shown, high: range.highest, windowDays: days };
  return { kind: 'typical_range', label: `Typical price ${format(range.lowest)}–${format(range.highest)}`, low: range.lowest, high: range.highest, windowDays: days };
}

/** e.g. 'Any drop below $329.00', 'At or below $299.00, from Trailhead Outfitters', 'Olive, from Trailhead Outfitters' */
export function alertCondition(a: { kind: string; targetPrice: Money | null; referencePrice: Money | null; options: Record<string, string>; sellerName: string | null }): string {
  const from = a.sellerName ? `from ${a.sellerName}` : null;
  if (a.kind === 'price_drop') {
    const base = a.targetPrice ? `At or below ${format(a.targetPrice)}` : a.referencePrice ? `Any drop below ${format(a.referencePrice)}` : 'Any price drop';
    return from ? `${base}, ${from}` : base;
  }
  const variant = Object.values(a.options).filter(Boolean).join(' / ');
  const parts = [variant, from].filter(Boolean);
  return parts.length ? parts.join(', ') : 'Any seller';
}

/** First name for a shared list ('Ana Lopez' → 'Ana') */
export const firstName = (displayName: string | null | undefined) => displayName?.trim().split(/\s+/)[0] || null;

/* ---------------------------------------------------------------- share links */

/** Random id stored on the list; the link carries it with a signature, so ids alone can't be guessed or forged */
export const newShareId = () => randomBytes(18).toString('base64url');

const signature = (key: string, id: string) => createHmac('sha256', key).update(`wishlist.share:${id}`).digest('base64url').slice(0, 32);

export const shareToken = (key: string, id: string) => `${id}.${signature(key, id)}`;

/** The share id of a valid token, null for anything else */
export function verifyShareToken(key: string, token: string): string | null {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const id = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(signature(key, id));
  return given.length === expected.length && timingSafeEqual(given, expected) ? id : null;
}
