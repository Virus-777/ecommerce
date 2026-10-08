/**
 * Business-hour arithmetic in the market time zone (pure): weekly business hours minus closures.
 * Used for SLA deadlines (support, workqueues, returns, sellers), "open now" and the admin calendar.
 */
import { dateInZone, zonedTimeToUtc } from '../../../kernel/lib/clock.js';
import type { BusinessDay, Closure, DayHours } from '../../../spec/settings.js';

const WEEKDAY_OF = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
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

  return { intervals, isOpen, nextOpen, addBusinessMinutes, day };
}
