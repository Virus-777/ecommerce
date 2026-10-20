/**
 * Calendar dates (YYYY-MM-DD), month arithmetic and time-zone names: one rule each for every module. Instants in a
 * time zone (the market's "today", wall-clock times) are in clock.ts.
 */

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** A real calendar date written YYYY-MM-DD: 2026-02-30 and month 13 are refused */
export function isIsoDate(s: unknown): s is string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** A calendar date plus n days (n may be negative), as YYYY-MM-DD */
export const addCalendarDays = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

/** An instant n calendar months later (UTC); the 31st becomes the last day of a shorter month (Jan 31 + 1 = Feb 28) */
export function addMonths(at: Date, months: number): Date {
  const d = new Date(at.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}

/**
 * An IANA time-zone name the server knows, such as America/Los_Angeles, or UTC. Abbreviations and offsets ("EST",
 * "GMT", "+05:00") are refused: they ignore daylight saving.
 */
export function isTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !(tz.includes('/') || tz === 'UTC')) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** A length of time for people: 95 minutes → "1 h 35 min", 30 → "30 min", 5 h 20 min → "5 h 20 min", 26 h → "1 d 2 h" */
export function durationText(ms: number): string {
  const min = Math.max(1, Math.round(Math.abs(ms) / MINUTE));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return min % 60 && h < 10 ? `${h} h ${min % 60} min` : `${h} h`;
  const days = Math.floor(h / 24);
  return h % 24 ? `${days} d ${h % 24} h` : `${days} d`;
}
