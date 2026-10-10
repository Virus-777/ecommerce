/**
 * Business-hour arithmetic in the market time zone (pure): weekly business hours minus closures.
 * Used for SLA deadlines (support, workqueues, returns, sellers), "open now" and the admin calendar.
 */
import { dateInZone, zonedTimeToUtc, zoneOffsetMs } from '../../../kernel/lib/clock.js';
import type { BusinessDay, Closure, DayHours } from '../../../spec/settings.js';

const WEEKDAY_OF = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
const DAY_MS = 86_400_000;
const MAX_DAYS = 800; // search horizon; a calendar with no open hours at all gives up after this

export interface Interval {
  start: Date;
  end: Date;
}

/** YYYY-MM-DD plus n days */
export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export const weekdayOf = (date: string) => WEEKDAY_OF[new Date(`${date}T12:00:00Z`).getUTCDay()]!;

export interface BusinessCalendar {
  /** Open intervals of a market-local date, in order */
  intervals(date: string): Interval[];
  isOpen(at: Date): boolean;
  /** `after` itself while open, else the next opening; null when the calendar never opens */
  nextOpen(after: Date): Date | null;
  /** `from` plus business minutes (only open time counts); null when the calendar never opens */
  addBusinessMinutes(from: Date, minutes: number): Date | null;
  /** The market-local date has opening hours (closures and closed weekdays are not business days) */
  isBusinessDay(date: string): boolean;
  /**
   * `from` plus whole business days, keeping the local time of day (moved to closing time when that day
   * closes earlier); from inside a closed day it counts from the next business day. null when the calendar never opens.
   */
  addBusinessDays(from: Date, days: number): Date | null;
  day(date: string): BusinessDay;
}

export function createCalendar(hours: readonly DayHours[], closures: readonly Closure[], timeZone: string): BusinessCalendar {
  const closureOf = new Map(closures.map((c) => [c.date, c]));
  const hasHours = hours.length > 0 || closures.some((c) => c.kind === 'reduced_hours');
  const cache = new Map<string, Interval[]>();

  const intervals = (date: string): Interval[] => {
    let list = cache.get(date);
    if (list) return list;
    const closure = closureOf.get(date);
    const spans: { opens: string; closes: string }[] =
      closure?.kind === 'closed'
        ? []
        : closure?.kind === 'reduced_hours' && closure.opens && closure.closes
          ? [{ opens: closure.opens, closes: closure.closes }]
          : hours.filter((h) => h.weekday === weekdayOf(date));
    list = spans
      .map((s) => ({ start: zonedTimeToUtc(date, s.opens, timeZone), end: zonedTimeToUtc(date, s.closes, timeZone) }))
      .filter((i) => i.end > i.start)
      .sort((a, b) => a.start.getTime() - b.start.getTime());
    if (cache.size > 1000) cache.clear();
    cache.set(date, list);
    return list;
  };

  const isOpen = (at: Date) => intervals(dateInZone(at, timeZone)).some((i) => i.start <= at && at < i.end);

  const nextOpen = (after: Date): Date | null => {
    if (!hasHours) return null;
    const first = dateInZone(after, timeZone);
    for (let d = 0; d < MAX_DAYS; d++) {
      for (const i of intervals(addDays(first, d))) {
        if (i.end > after) return i.start > after ? i.start : after;
      }
    }
    return null;
  };

  const addBusinessMinutes = (from: Date, minutes: number): Date | null => {
    if (!hasHours) return null;
    let remaining = Math.max(0, minutes) * 60_000;
    let cursor = from;
    const first = dateInZone(from, timeZone);
    for (let d = 0; d < MAX_DAYS * 5; d++) {
      for (const i of intervals(addDays(first, d))) {
        if (i.end <= cursor) continue;
        const start = i.start > cursor ? i.start : cursor;
        const available = i.end.getTime() - start.getTime();
        if (remaining <= available) return new Date(start.getTime() + remaining);
        remaining -= available;
        cursor = i.end;
      }
    }
    return null;
  };

  const isBusinessDay = (date: string) => intervals(date).length > 0;

  const nextBusinessDay = (date: string): string | null => {
    for (let d = 1; d <= MAX_DAYS; d++) if (isBusinessDay(addDays(date, d))) return addDays(date, d);
    return null;
  };

  const addBusinessDays = (from: Date, days: number): Date | null => {
    if (!hasHours) return null;
    let date: string | null = dateInZone(from, timeZone);
    // from inside a closed day: count from the next business day
    if (!isBusinessDay(date)) date = nextBusinessDay(date);
    for (let n = 0; date && n < Math.max(0, Math.trunc(days)); n++) date = nextBusinessDay(date);
    if (!date) return null;
    // keep the local time of day (seconds included)
    const ofDay = (((from.getTime() + zoneOffsetMs(from, timeZone)) % DAY_MS) + DAY_MS) % DAY_MS;
    const hh = String(Math.floor(ofDay / 3_600_000)).padStart(2, '0');
    const mm = String(Math.floor((ofDay % 3_600_000) / 60_000)).padStart(2, '0');
    const at = new Date(zonedTimeToUtc(date, `${hh}:${mm}`, timeZone).getTime() + (ofDay % 60_000));
    // the day closes earlier than that time: its closing time
    const close = intervals(date).at(-1)!.end;
    return at > close ? close : at;
  };

  const day = (date: string): BusinessDay => {
    const list = intervals(date);
    const closure = closureOf.get(date);
    return {
      date,
      open: list.length > 0,
      opensAt: list[0]?.start.toISOString() ?? null,
      closesAt: list.at(-1)?.end.toISOString() ?? null,
      label: closure ? closure.label : null,
    };
  };

  return { intervals, isOpen, nextOpen, addBusinessMinutes, isBusinessDay, addBusinessDays, day };
}
