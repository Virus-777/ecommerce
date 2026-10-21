/**
 * Pure services rules: areas, opening hours and the time slots cut from them, labels the app shows (prices, times,
 * statuses), request references, ratings and how reviews are signed. No I/O.
 */
import { format as formatMoney, type Money } from '../../../kernel/lib/money.js';
import { slugify } from '../../../kernel/lib/text.js';
import { zonedTimeToUtc } from '../../../kernel/lib/clock.js';
import type { OpeningDay, OpeningHours, RatingSummary, ServiceRequest } from '../../../spec/services.js';

export const AREAS = ['os_install', 'post_sale', 'welfare', 'booking'] as const;
export type Area = (typeof AREAS)[number];
export const PRICE_UNITS = ['fixed', 'hour', 'visit', 'night', 'free'] as const;
export type PriceUnit = (typeof PRICE_UNITS)[number];
export const HANDOVER_MODES = ['dropoff', 'pickup', 'at_home', 'online'] as const;
export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** Requests that hold their slot and count as open for the customer and staff */
export const OPEN_STATUSES = ['requested', 'confirmed', 'in_progress'] as const;
export type RequestStatus = ServiceRequest['status'];

export const LIMITS = {
  name: 80,
  title: 120,
  summary: 240,
  kind: 60,
  city: 60,
  listItems: 20,
  listItem: 200,
  priceRows: 30,
  steps: 8,
  photos: 12,
  staff: 20,
  notes: 1000,
  reviewText: 1000,
  address: 200,
  short: 80,
  days: 14,
} as const;

/* ------------------------------------------------------------------ slugs */

export const SLUG_MAX = 80;
export const isValidSlug = (s: string) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s) && s.length <= SLUG_MAX;
export const slugOf = (given: string | null | undefined, from: string) => slugify(given?.trim() || from, { max: SLUG_MAX });

/* ------------------------------------------------------------------ opening hours */

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
export const isHhmm = (s: unknown): s is string => typeof s === 'string' && HHMM.test(s);
export const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** A new provider's hours: Monday to Friday 9:00–17:00, closed at the weekend */
export const defaultDays = (): OpeningDay[] => WEEKDAYS.map((weekday, i) => (i < 5 ? { weekday, open: true, from: '09:00', to: '17:00' } : { weekday, open: false, from: null, to: null }));

/** The stored days in Monday-first order (a day missing from storage reads as closed) */
export function daysOf(v: unknown): OpeningDay[] {
  const list = Array.isArray(v) ? (v as OpeningDay[]) : [];
  return WEEKDAYS.map((weekday) => {
    const d = list.find((x) => x && x.weekday === weekday);
    return d && d.open && isHhmm(d.from) && isHhmm(d.to) ? { weekday, open: true, from: d.from, to: d.to } : { weekday, open: false, from: null, to: null };
  });
}

/** Monday = 0 … Sunday = 6 for a YYYY-MM-DD calendar day */
export const weekdayIndex = (day: string) => (new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7;

const timeFormats = new Map<string, Intl.DateTimeFormat>();
const fmt = (key: string, make: () => Intl.DateTimeFormat) => {
  let f = timeFormats.get(key);
  if (!f) timeFormats.set(key, (f = make()));
  return f;
};
/** 3:30 PM in a time zone */
export const timeLabel = (at: Date, tz: string) => fmt(`t|${tz}`, () => new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' })).format(at);
/** Thu */
export const weekdayLabel = (day: string) => fmt('wd', () => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short' })).format(new Date(`${day}T12:00:00Z`));
/** Sat, Oct 24 */
export const dayLabel = (at: Date, tz: string) => fmt(`d|${tz}`, () => new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' })).format(at);
/** 9:00 AM for an HH:MM wall time */
export function hhmmLabel(hhmm: string): string {
  const m = minutesOf(hhmm);
  const h = Math.floor(m / 60);
  return `${((h + 11) % 12) + 1}:${String(m % 60).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/** "Open today 9:00 AM – 7:00 PM" or "Closed today" */
export function todayLabel(days: OpeningDay[], today: string): string {
  const d = days[weekdayIndex(today)];
  return d?.open && d.from && d.to ? `Open today ${hhmmLabel(d.from)} – ${hhmmLabel(d.to)}` : 'Closed today';
}

export function hoursOut(v: unknown, tz: string, today: string): OpeningHours {
  const stored = (v && typeof v === 'object' ? v : {}) as { days?: unknown; timeZone?: unknown };
  const days = daysOf(stored.days);
  const timeZone = typeof stored.timeZone === 'string' && stored.timeZone ? stored.timeZone : tz;
  return { days, timeZone, todayLabel: todayLabel(days, today) };
}

/** The start and end of each slot of a day: from opening time, every slotMinutes, while the slot ends by closing */
export function slotsOfDay(day: string, hours: OpeningDay, slotMinutes: number, tz: string): { start: Date; end: Date }[] {
  if (!hours.open || !hours.from || !hours.to || slotMinutes <= 0) return [];
  const open = minutesOf(hours.from);
  const close = minutesOf(hours.to);
  const out: { start: Date; end: Date }[] = [];
  for (let m = open; m + slotMinutes <= close; m += slotMinutes) {
    const hhmm = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    const start = zonedTimeToUtc(day, hhmm, tz);
    out.push({ start, end: new Date(start.getTime() + slotMinutes * 60_000) });
  }
  return out;
}

export const overlaps = (a: { start: Date; end: Date }, b: { start: Date; end: Date }) => a.start < b.end && b.start < a.end;

/* ------------------------------------------------------------------ labels */

const UNIT_SUFFIX: Record<string, string> = { fixed: '', hour: '/hr', visit: '/visit', night: '/night', free: '' };

/** "from $29", "$24/hr", "Free" */
export function priceText(price: Money | null | undefined, unit: string, from = true): string | null {
  if (unit === 'free') return 'Free';
  if (!price) return null;
  const amount = formatMoney(price).replace(/\.00$/, '');
  return `${from && unit === 'fixed' ? 'from ' : ''}${amount}${UNIT_SUFFIX[unit] ?? ''}`;
}

/** What the customer pays and how, e.g. "from $29 · pay at the provider" */
export const requestPriceLabel = (price: Money | null | undefined, unit: string) => {
  const p = priceText(price, unit);
  return p ? `${p} · pay at the provider` : 'Pay at the provider';
};

const STATUS_LABEL: Record<string, (provider: string) => string> = {
  requested: (p) => `Waiting for ${p} to confirm`,
  confirmed: () => 'Confirmed',
  in_progress: () => 'In progress',
  completed: () => 'Completed',
  cancelled: () => 'Cancelled',
  declined: (p) => `Declined by ${p}`,
};
export const statusLabel = (status: string, provider: string) => (STATUS_LABEL[status] ?? (() => status))(provider);

/** The admin status a request moves to, and the state machine event that moves it */
export const STATUS_EVENT = { confirmed: 'confirm', in_progress: 'start', completed: 'complete', declined: 'decline', cancelled: 'cancel' } as const;

/* ------------------------------------------------------------------ references */

export const REF_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
/** SR- plus five characters from the unambiguous alphabet */
export function makeRef(random: () => number = Math.random): string {
  let s = '';
  for (let i = 0; i < 5; i++) s += REF_ALPHABET[Math.floor(random() * REF_ALPHABET.length)];
  return `SR-${s}`;
}

/* ------------------------------------------------------------------ ratings */

/** Stars stored as [5★, 4★, 3★, 2★, 1★] counts */
export const starsOf = (v: unknown): number[] => {
  const a = Array.isArray(v) ? v.map((n) => (typeof n === 'number' && n >= 0 ? Math.floor(n) : 0)) : [];
  return [0, 1, 2, 3, 4].map((i) => a[i] ?? 0);
};
export function ratingOf(sum: number, count: number, stars: unknown): RatingSummary {
  return { average: count > 0 ? Math.round((sum / count) * 10) / 10 : null, count, stars: starsOf(stars) };
}
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
