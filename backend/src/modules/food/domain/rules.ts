/**
 * Pure food rules: opening hours and the open/closed labels, card labels (delivery time, fee, prices, discounts),
 * option groups and the choices a basket line makes, line prices, order references, statuses and ETAs, ratings and
 * how reviews are signed. No I/O.
 */
import { format as formatMoney, money, type Money } from '../../../kernel/lib/money.js';
import { slugify } from '../../../kernel/lib/text.js';
import { zoneOffsetMs } from '../../../kernel/lib/clock.js';
import type { LineOptionInput, OpeningDay, OptionGroup, RatingSummary } from '../../../spec/food.js';

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export const ORDER_STATUSES = ['payment_pending', 'payment_failed', 'placed', 'accepted', 'preparing', 'on_the_way', 'delivered', 'cancelled', 'declined'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];
/** Orders still on their way to the customer (listMyOrders state=open, openOrders on the restaurant) */
export const OPEN_STATUSES: OrderStatus[] = ['payment_pending', 'placed', 'accepted', 'preparing', 'on_the_way'];
export const PAST_STATUSES: OrderStatus[] = ['payment_failed', 'delivered', 'cancelled', 'declined'];
/** Restaurants the store shows (paused ones as closed) */
export const LISTED: string[] = ['published', 'paused'];

export const ADMIN_ACTIONS = ['accept', 'decline', 'prepare', 'send', 'deliver', 'cancel'] as const;
export type AdminAction = (typeof ADMIN_ACTIONS)[number];

export const LIMITS = {
  name: 80,
  cuisine: 60,
  short: 60,
  address: 200,
  city: 60,
  phone: 40,
  promoText: 120,
  promoBadge: 30,
  description: 1000,
  tag: 30,
  dietTags: 6,
  photos: 10,
  itemPhotos: 5,
  groups: 10,
  choices: 20,
  note: 200,
  courierNote: 200,
  maxQuantity: 20,
  reviewText: 1000,
  staffNote: 1000,
  deliveryMinutes: 240,
} as const;

export const INSTRUCTIONS_HINT = 'The restaurant will do its best; allergy needs should be confirmed by phone.';

/* ------------------------------------------------------------------ slugs */

export const SLUG_MAX = 80;
export const isValidSlug = (s: string) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s) && s.length <= SLUG_MAX;
export const slugOf = (given: string | null | undefined, from: string) => slugify(given?.trim() || from, { max: SLUG_MAX });

/* ------------------------------------------------------------------ opening hours */

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
export const isHhmm = (s: unknown): s is string => typeof s === 'string' && HHMM.test(s);
export const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** A new restaurant's hours: every day 11:00–22:00 */
export const defaultHours = (): OpeningDay[] => WEEKDAYS.map((weekday) => ({ weekday, open: true, from: '11:00', to: '22:00' }));

/** The stored days in Monday-first order (a day missing from storage reads as closed) */
export function daysOf(v: unknown): OpeningDay[] {
  const list = Array.isArray(v) ? (v as OpeningDay[]) : [];
  return WEEKDAYS.map((weekday) => {
    const d = list.find((x) => x && x.weekday === weekday);
    return d && d.open && isHhmm(d.from) && isHhmm(d.to) && d.from !== d.to ? { weekday, open: true, from: d.from, to: d.to } : { weekday, open: false, from: null, to: null };
  });
}

/** 11 PM, or 10:45 PM: a wall time in minutes after midnight (wraps past midnight) */
export function shortTime(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${((h + 11) % 12) + 1}${mm ? `:${String(mm).padStart(2, '0')}` : ''} ${h < 12 ? 'AM' : 'PM'}`;
}

/** The wall clock of an instant in a zone: Monday = 0 weekday index and minutes after midnight */
export function wallClock(at: Date, tz: string): { weekday: number; minutes: number } {
  const wall = new Date(at.getTime() + zoneOffsetMs(at, tz));
  return { weekday: (wall.getUTCDay() + 6) % 7, minutes: wall.getUTCHours() * 60 + wall.getUTCMinutes() };
}

export interface OpenState {
  open: boolean;
  /** Open until 11 PM · Closes soon · 10:45 PM · Closed · opens 5 PM · Closed today */
  label: string;
  /** When closed: opens 5 PM, opens tomorrow 11 AM, opens Tue 11 AM; null when it does not open within a week (or is paused) */
  opensLabel: string | null;
}

const DAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/**
 * Whether a restaurant is open at `at` from its weekly hours in its zone. A closing time earlier than the opening
 * time closes past midnight (the next calendar day). Paused restaurants read as closed.
 */
export function openStateOf(hours: unknown, at: Date, tz: string, paused = false): OpenState {
  if (paused) return { open: false, label: 'Closed today', opensLabel: null };
  const days = daysOf(hours);
  const { weekday, minutes } = wallClock(at, tz);
  const today = days[weekday]!;
  const yesterday = days[(weekday + 6) % 7]!;
  // last night's hours that run past midnight
  if (yesterday.open && minutesOf(yesterday.to!) < minutesOf(yesterday.from!) && minutes < minutesOf(yesterday.to!)) return openUntil(minutesOf(yesterday.to!), minutes);
  if (today.open) {
    const from = minutesOf(today.from!);
    const to = minutesOf(today.to!);
    const end = to > from ? to : to + 1440;
    if (minutes >= from && minutes < end) return openUntil(end, minutes);
    if (minutes < from) return { open: false, label: `Closed · opens ${shortTime(from)}`, opensLabel: `opens ${shortTime(from)}` };
  }
  for (let i = 1; i <= 7; i++) {
    const d = days[(weekday + i) % 7]!;
    if (!d.open) continue;
    const when = i === 1 ? 'tomorrow' : DAY_SHORT[(weekday + i) % 7];
    return { open: false, label: 'Closed today', opensLabel: `opens ${when} ${shortTime(minutesOf(d.from!))}` };
  }
  return { open: false, label: 'Closed today', opensLabel: null };
}

function openUntil(end: number, now: number): OpenState {
  return { open: true, label: end - now <= 30 ? `Closes soon · ${shortTime(end)}` : `Open until ${shortTime(end)}`, opensLabel: null };
}

/* ------------------------------------------------------------------ labels */

/** $14.50 */
export const moneyLabel = (m: Money) => formatMoney(m);
/** 20–30 min */
export const deliveryLabel = (min: number, max: number) => (min === max ? `${min} min` : `${min}–${max} min`);
/** $1.99 delivery, or Free delivery */
export const feeLabel = (fee: Money) => (fee.amount === 0 ? 'Free delivery' : `${moneyLabel(fee)} delivery`);
/** -15%: how much below the was-price the price is (whole percent, never more than the real discount) */
export function discountBadge(price: number, was: number | null | undefined): string | null {
  if (was == null || was <= price || was <= 0) return null;
  const pct = Math.floor(((was - price) / was) * 100);
  return pct >= 1 ? `-${pct}%` : null;
}

const STATUS_LABEL: Record<OrderStatus, (restaurant: string) => string> = {
  payment_pending: () => 'Confirming your payment',
  payment_failed: () => 'Payment failed',
  placed: (r) => `Waiting for ${r} to accept`,
  accepted: (r) => `Accepted by ${r}`,
  preparing: () => 'Preparing your food',
  on_the_way: () => 'On the way',
  delivered: () => 'Delivered',
  cancelled: () => 'Cancelled',
  declined: () => 'Declined by the restaurant',
};
export const statusLabel = (status: string, restaurant: string) => (STATUS_LABEL[status as OrderStatus] ?? (() => status))(restaurant);

/** 7:40 PM in a zone */
const timeFormats = new Map<string, Intl.DateTimeFormat>();
function hm(at: Date, tz: string): { time: string; meridiem: string } {
  let f = timeFormats.get(tz);
  if (!f) timeFormats.set(tz, (f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' })));
  const [time = '', meridiem = ''] = f.format(at).split(/\s+/);
  return { time, meridiem };
}
/** 7:40–7:50 PM, or 11:50 AM–12:10 PM */
export function timeRangeLabel(from: Date, to: Date, tz: string): string {
  const a = hm(from, tz);
  const b = hm(to, tz);
  return a.meridiem === b.meridiem ? `${a.time}–${b.time} ${b.meridiem}` : `${a.time} ${a.meridiem}–${b.time} ${b.meridiem}`;
}
/** An instant rounded up to the next 5 minutes */
export const ceilToFive = (at: Date) => new Date(Math.ceil(at.getTime() / 300_000) * 300_000);

/** The delivery window once a restaurant accepts: acceptance plus its delivery minutes, rounded up to 5 minutes */
export const etaWindow = (acceptedAt: Date, min: number, max: number) => ({ from: ceilToFive(new Date(acceptedAt.getTime() + min * 60_000)), to: ceilToFive(new Date(acceptedAt.getTime() + max * 60_000)) });

/** Usually 20–30 min before acceptance; Arrives 7:40–7:50 PM after it; nothing once the order ends */
export function etaLabel(status: string, eta: { from: Date | null; to: Date | null }, delivery: { min: number; max: number }, tz: string): string | null {
  if (status === 'payment_pending' || status === 'placed') return `Usually ${deliveryLabel(delivery.min, delivery.max)}`;
  if ((status === 'accepted' || status === 'preparing' || status === 'on_the_way') && eta.from && eta.to) return `Arrives ${timeRangeLabel(eta.from, eta.to, tz)}`;
  return null;
}

/* ------------------------------------------------------------------ references */

export const REF_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
/** FD- plus five characters from the unambiguous alphabet */
export function makeRef(random: () => number = Math.random): string {
  let s = '';
  for (let i = 0; i < 5; i++) s += REF_ALPHABET[Math.floor(random() * REF_ALPHABET.length)];
  return `FD-${s}`;
}

/* ------------------------------------------------------------------ option groups */

/** The stored option groups of an item */
export function groupsOf(v: unknown, currency: string): OptionGroup[] {
  if (!Array.isArray(v)) return [];
  return (v as OptionGroup[])
    .filter((g) => g && typeof g.id === 'string' && Array.isArray(g.choices))
    .map((g) => ({
      id: g.id,
      name: g.name,
      required: Boolean(g.required),
      min: g.min ?? 0,
      max: g.max ?? 1,
      choices: g.choices
        .filter((c) => c && typeof c.id === 'string')
        .map((c) => ({ id: c.id, name: c.name, priceDelta: money(Number(c.priceDelta?.amount ?? 0), c.priceDelta?.currency || currency), default: Boolean(c.default), available: c.available !== false })),
    }));
}

/** The lowest unit price the groups allow: each group's cheapest allowed picks (its minimum, plus any further discounts up to its maximum) */
export function lowestUnitPrice(price: number, groups: OptionGroup[]): number {
  let total = price;
  for (const g of groups) {
    const deltas = g.choices.map((c) => c.priceDelta.amount).sort((a, b) => a - b);
    deltas.forEach((d, i) => {
      if (i < g.min || (i < g.max && d < 0)) total += d;
    });
  }
  return total;
}

export type OptionProblem = { groupId: string; message: string };

/**
 * A line's choices checked against the item's groups: known groups and choices, available choices, each group's
 * min and max (required groups need at least one). Defaults are not applied. Returns the choices in the item's
 * order (groups without choices dropped) or the first problem.
 */
export function checkChoices(groups: OptionGroup[], input: readonly LineOptionInput[] | null | undefined): { options: LineOptionInput[] } | { problem: OptionProblem } {
  const given = new Map<string, string[]>();
  for (const o of input ?? []) {
    const g = groups.find((x) => x.id === o.groupId);
    if (!g) return { problem: { groupId: o.groupId, message: 'This option is not on the menu any more' } };
    if (given.has(o.groupId)) return { problem: { groupId: o.groupId, message: `Choose ${g.name} once` } };
    const ids = o.choiceIds ?? [];
    if (new Set(ids).size !== ids.length) return { problem: { groupId: g.id, message: `Pick each ${g.name.toLowerCase()} choice once` } };
    for (const id of ids) {
      const c = g.choices.find((x) => x.id === id);
      if (!c) return { problem: { groupId: g.id, message: `Pick one of the ${g.name.toLowerCase()} choices` } };
      if (!c.available) return { problem: { groupId: g.id, message: `${c.name} is not available now` } };
    }
    given.set(o.groupId, ids);
  }
  const options: LineOptionInput[] = [];
  for (const g of groups) {
    const ids = given.get(g.id) ?? [];
    const min = Math.max(g.min, g.required ? 1 : 0);
    if (ids.length < min) return { problem: { groupId: g.id, message: min === 1 ? `Choose a ${g.name.toLowerCase()}` : `Choose at least ${min} ${g.name.toLowerCase()}` } };
    if (ids.length > g.max) return { problem: { groupId: g.id, message: g.max === 1 ? `Choose one ${g.name.toLowerCase()}` : `Choose up to ${g.max} ${g.name.toLowerCase()}` } };
    if (ids.length) options.push({ groupId: g.id, choiceIds: g.choices.filter((c) => ids.includes(c.id)).map((c) => c.id) });
  }
  return { options };
}

/** What the chosen options add to the unit price, and their label (12" regular · Extra mozzarella) */
export function choicesPriced(groups: OptionGroup[], options: readonly LineOptionInput[]): { delta: number; label: string | null } {
  let delta = 0;
  const names: string[] = [];
  for (const o of options) {
    const g = groups.find((x) => x.id === o.groupId);
    for (const id of o.choiceIds) {
      const c = g?.choices.find((x) => x.id === id);
      if (!c) continue;
      delta += c.priceDelta.amount;
      names.push(c.name);
    }
  }
  return { delta, label: names.length ? names.join(' · ') : null };
}

/** The key two basket lines merge on: the item, its choices and its note */
export const lineKey = (itemId: string, options: readonly LineOptionInput[], note: string | null) => JSON.stringify([itemId, options.map((o) => [o.groupId, [...o.choiceIds].sort()]), note ?? '']);

/* ------------------------------------------------------------------ ratings */

/** Stars stored as [5★, 4★, 3★, 2★, 1★] counts */
export const starsOf = (v: unknown): number[] => {
  const a = Array.isArray(v) ? v.map((n) => (typeof n === 'number' && n >= 0 ? Math.floor(n) : 0)) : [];
  return [0, 1, 2, 3, 4].map((i) => a[i] ?? 0);
};
export function ratingOf(sum: number, count: number, stars: unknown): RatingSummary {
  return { average: count > 0 ? Math.round((sum / count) * 10) / 10 : null, count, stars: starsOf(stars) };
}
export const averageOf = (sum: number, count: number): number | null => (count > 0 ? Math.round((sum / count) * 10) / 10 : null);
/** The stars array after adding (+1) or taking away (−1) one rating */
export function withRating(stars: unknown, rating: number, delta: 1 | -1): number[] {
  const s = starsOf(stars);
  const i = 5 - rating;
  s[i] = Math.max(0, (s[i] ?? 0) + delta);
  return s;
}

/** How a review is signed: first name and last initial ("Dana Ross" → "Dana R."); Customer when unknown */
export function shortName(displayName: string | null | undefined): string {
  const parts = String(displayName ?? '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'Customer';
  const [first, ...rest] = parts;
  const last = rest.at(-1);
  return last ? `${first} ${last[0]!.toUpperCase()}.` : first!;
}

/** Lower-case words a search box matches */
export const searchTextOf = (...parts: (string | null | undefined)[]) => parts.filter(Boolean).join(' ').toLowerCase().replace(/\s+/g, ' ').trim();
