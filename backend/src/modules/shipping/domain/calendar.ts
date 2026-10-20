/**
 * Business days, cutoffs and arrival dates in the market time zone. Dates are 'YYYY-MM-DD' strings
 * (market days); instants are Dates. Pure: the service gathers business days, closures and notice
 * effects into a DayRules object first.
 */
import { durationText } from '../../../kernel/lib/dates.js';
import { dateInZone, zonedTimeToUtc } from '../../../kernel/lib/clock.js';
import type * as common from '../../../spec/common.js';

export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type Weekday = (typeof WEEKDAYS)[number];
export const MON_FRI: Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri'];
export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;

export const weekdayOf = (date: string): Weekday => WEEKDAYS[new Date(`${date}T12:00:00Z`).getUTCDay()]!;
export const addDays = (date: string, n: number): string => new Date(new Date(`${date}T12:00:00Z`).getTime() + n * DAY_MS).toISOString().slice(0, 10);
export const isTime = (s: unknown): s is string => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

/** HH:mm of an instant in a time zone */
export function timeInZone(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return `${get('hour')}:${get('minute')}`;
}

export interface DayRules {
  /** Weekdays work happens on */
  days: readonly string[];
  /** Closed market days (closures, holidays, notices) */
  closed: (date: string) => boolean;
}

export const isWorkDay = (date: string, r: DayRules) => r.days.includes(weekdayOf(date)) && !r.closed(date);

/** The first work day on or after date (bounded: a year of closures falls back to the date itself) */
export function onOrAfter(date: string, r: DayRules): string {
  let d = date;
  for (let i = 0; i < 370; i++) {
    if (isWorkDay(d, r)) return d;
    d = addDays(d, 1);
  }
  return date;
}

/** n work days after a work day (n = 0: the day itself) */
export function addWorkDays(date: string, n: number, r: DayRules): string {
  let d = onOrAfter(date, r);
  for (let i = 0; i < Math.max(0, n); i++) d = onOrAfter(addDays(d, 1), r);
  return d;
}

export interface DispatchPlan {
  /** Market day the package must leave */
  date: string;
  /** Deadline instant (dispatchDueTime on that day) */
  dueAt: Date;
  /** Order before this instant to keep the date (same-day cutoff of the current work day) */
  cutoffAt: Date | null;
  /** The order counts from today (before the cutoff on a work day) */
  countsToday: boolean;
}

/**
 * Dispatch date from an acceptance time: before the same-day cutoff on a work day the order counts from that
 * day, otherwise from the next work day; then handling work days are added. The deadline falls at dueTime.
 */
export function planDispatch(from: Date, o: { timeZone: string; handlingDays: number; cutoff: string | null; dueTime: string; rules: DayRules }): DispatchPlan {
  const today = dateInZone(from, o.timeZone);
  const now = timeInZone(from, o.timeZone);
  const cutoff = o.cutoff && isTime(o.cutoff) ? o.cutoff : null;
  const countsToday = isWorkDay(today, o.rules) && (!cutoff || now < cutoff);
  const day0 = countsToday ? today : onOrAfter(addDays(today, 1), o.rules);
  const date = addWorkDays(day0, Math.max(0, Math.floor(o.handlingDays)), o.rules);
  return {
    date,
    dueAt: zonedTimeToUtc(date, o.dueTime, o.timeZone),
    cutoffAt: countsToday && cutoff ? zonedTimeToUtc(today, cutoff, o.timeZone) : null,
    countsToday,
  };
}

/** Arrival range: the package leaves on the first pickup day on or after the ship day, then transit delivery days */
export function arrivalRange(shipDay: string, transit: { min: number; max: number }, pickup: DayRules, delivery: DayRules): { leaves: string; range: common.DateRange } {
  const leaves = onOrAfter(shipDay, pickup);
  const after = (n: number) => (n <= 0 ? onOrAfter(leaves, delivery) : addWorkDays(onOrAfter(addDays(leaves, 1), delivery), n - 1, delivery));
  const from = after(Math.max(1, transit.min));
  const to = after(Math.max(1, transit.max, transit.min));
  return { leaves, range: { from, to: to < from ? from : to } };
}

/* ---------------------------------------------------------------- labels */

const fmt = (date: string, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...o }).format(new Date(`${date}T12:00:00Z`));
/** Wed, Oct 14 */
export const dayLabel = (date: string) => fmt(date, { weekday: 'short', month: 'short', day: 'numeric' });

export function rangeLabel(r: common.DateRange | null | undefined): string {
  if (!r) return '';
  return r.from === r.to ? dayLabel(r.from) : `${dayLabel(r.from)} – ${dayLabel(r.to)}`;
}

export const arrivesLabel = (r: common.DateRange) => `Arrives ${rangeLabel(r)}`;

/** 'Ships today from Reno, NV' / 'Ships tomorrow' / 'Ships by Mon, Oct 12' */
export function shipsLabel(date: string, today: string, shipsFrom?: string | null): string {
  const when = date <= today ? 'Ships today' : date === addDays(today, 1) ? 'Ships tomorrow' : `Ships by ${dayLabel(date)}`;
  return shipsFrom ? `${when} from ${shipsFrom}` : when;
}

/** 2:00 PM */
export function clockLabel(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  const suffix = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${suffix}`;
}

/** Mon, Oct 12, 5:00 PM (market time) */
export function instantLabel(at: Date, timeZone: string): string {
  return `${dayLabel(dateInZone(at, timeZone))}, ${clockLabel(timeInZone(at, timeZone))}`;
}

const DAY_NAMES: Record<string, string> = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
const ORDER = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

/** Mon–Fri, Mon–Sat, Mon, Wed, Fri */
export function businessDaysLabel(days: readonly string[]): string {
  const idx = [...new Set(days)].map((d) => ORDER.indexOf(d)).filter((i) => i >= 0).sort((a, b) => a - b);
  if (!idx.length) return 'No dispatch days';
  if (idx.length === 7) return 'Every day';
  const contiguous = idx.every((v, i) => i === 0 || v === idx[i - 1]! + 1);
  if (contiguous && idx.length > 2) return `${DAY_NAMES[ORDER[idx[0]!]!]}–${DAY_NAMES[ORDER[idx.at(-1)!]!]}`;
  return idx.map((i) => DAY_NAMES[ORDER[i]!]).join(', ');
}

export const handlingLabel = (days: number) => (days <= 0 ? 'Ships the same business day' : `Ships in ${days} business day${days === 1 ? '' : 's'}`);

/** Deadline state: overdue past dueAt, due soon within the window */
export function deadlineState(dueAt: Date, now: Date, dueSoonMs = 4 * HOUR_MS): 'on_time' | 'due_soon' | 'overdue' {
  const left = dueAt.getTime() - now.getTime();
  return left < 0 ? 'overdue' : left <= dueSoonMs ? 'due_soon' : 'on_time';
}

export function deadlineLabel(dueAt: Date, now: Date, timeZone: string): string {
  const left = dueAt.getTime() - now.getTime();
  if (left < 0) return `Overdue by ${durationText(left)}`;
  if (left <= 24 * HOUR_MS) return `Due in ${durationText(left)}`;
  return `Due ${instantLabel(dueAt, timeZone)}`;
}
