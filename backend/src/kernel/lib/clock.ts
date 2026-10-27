/**
 * Time is stored in UTC; the market time zone is applied at the edges (architecture §5).
 * Services take a Clock so tests can freeze time.
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export function fixedClock(at: Date | string): Clock & { set(d: Date | string): void; advance(ms: number): void } {
  let t = new Date(at).getTime();
  return {
    now: () => new Date(t),
    set: (d) => {
      t = new Date(d).getTime();
    },
    advance: (ms) => {
      t += ms;
    },
  };
}

/**
 * Formatters per time zone, built once: building one costs about ten times using it, and dates in the market zone
 * are computed on every reference, date filter and schedule.
 */
const dayFormats = new Map<string, Intl.DateTimeFormat>();
const wallClockFormats = new Map<string, Intl.DateTimeFormat>();

function formatIn(cache: Map<string, Intl.DateTimeFormat>, timeZone: string, make: () => Intl.DateTimeFormat): Intl.DateTimeFormat {
  let f = cache.get(timeZone);
  if (!f) {
    f = make();
    cache.set(timeZone, f);
  }
  return f;
}

/** YYYY-MM-DD of an instant in a time zone (e.g. the market's America/Los_Angeles). */
export function dateInZone(at: Date, timeZone: string): string {
  const parts = formatIn(dayFormats, timeZone, () => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** The hour of the day (0–23) of an instant in a time zone, for "when do you order" style reports. */
export function hourInZone(at: Date, timeZone: string): number {
  return new Date(at.getTime() + zoneOffsetMs(at, timeZone)).getUTCHours();
}

/**
 * The instants a range of calendar days covers in a time zone: from the start of `from` up to (not including) the
 * start of the day after `to`. Use it for date filters ("orders from 2026-10-01 to 2026-10-07"): reading such
 * dates as UTC days shifts every range by the market's offset.
 */
export function zonedDayRange(range: { from?: string | null; to?: string | null }, timeZone: string): { start?: Date; end?: Date } {
  const nextDay = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  return {
    ...(range.from ? { start: zonedTimeToUtc(range.from, '00:00', timeZone) } : {}),
    ...(range.to ? { end: zonedTimeToUtc(nextDay(range.to), '00:00', timeZone) } : {}),
  };
}

/** The UTC instant of a wall-clock time in a time zone, e.g. 23:59 market time on a date. */
export function zonedTimeToUtc(date: string, time: string, timeZone: string): Date {
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number];
  const [h = 0, mi = 0] = time.split(':').map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  // apply the zone offset twice so instants next to a DST change settle on the right side
  let t = wall - zoneOffsetMs(new Date(wall), timeZone);
  t = wall - zoneOffsetMs(new Date(t), timeZone);
  return new Date(t);
}

/** How far a time zone's wall clock is ahead of UTC at an instant (negative west of Greenwich). */
export function zoneOffsetMs(at: Date, timeZone: string): number {
  const parts = formatIn(
    wallClockFormats,
    timeZone,
    () => new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }),
  ).formatToParts(at);
  const n = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asUtc = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second'));
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

