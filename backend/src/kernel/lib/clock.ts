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

/** YYYY-MM-DD of an instant in a time zone (e.g. the market's America/Los_Angeles). */
export function dateInZone(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
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
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const n = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asUtc = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second'));
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

export const toIso = (d: Date | string | null | undefined): string | null => (d == null ? null : new Date(d).toISOString());
