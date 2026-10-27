/**
 * The period maths behind every customer statistics endpoint (account/statistics): which market days a range
 * covers, how big each series point is, which point a day falls in, and the top-N-plus-Other breakdown rows.
 *
 * Market days are YYYY-MM-DD in the market time zone; the caller turns timestamps into them with
 * `dateInZone`. Nothing here reads the database: a range of `all` needs the day of the customer's first record,
 * which the caller looks up and passes as `firstDay`.
 *
 * It started as the orders module's spending report (modules/orders/service/spending.ts) and moved here when
 * farm, food, software and services grew reports of their own, so "last 3 months" means one thing everywhere.
 */
import { AppError } from '../errors/index.js';
import { money } from './money.js';
import type { StatPrevious, StatShare, StatWeekday } from '../../spec/common.js';
import { DAY } from './dates.js';

export type StatGrain = 'day' | 'week' | 'month';
export type StatRange = 'last_30_days' | 'last_3_months' | 'last_6_months' | 'last_12_months' | 'this_year' | 'last_year' | 'all';

/** Longest period from/to may ask for: 3 years */
export const MAX_PERIOD_DAYS = 3 * 366;
/** Breakdown rows before the rest becomes "Other" */
export const TOP_ROWS = 5;
export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

/* ------------------------------------------------------------------ market dates (YYYY-MM-DD) */

const utc = (ymd: string) => new Date(`${ymd}T00:00:00Z`);
export const addDays = (ymd: string, n: number): string => new Date(utc(ymd).getTime() + n * DAY).toISOString().slice(0, 10);
/** Days from `from` to `to`, both ends included */
export const daysBetween = (from: string, to: string): number => Math.round((utc(to).getTime() - utc(from).getTime()) / DAY) + 1;
/** 0 = Monday … 6 = Sunday */
export const weekdayOf = (ymd: string): number => (utc(ymd).getUTCDay() + 6) % 7;
const monthStart = (ymd: string) => `${ymd.slice(0, 7)}-01`;
const nextMonth = (ymd: string) => {
  const d = utc(monthStart(ymd));
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 10);
};
const fmt = (ymd: string, opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-US', { ...opts, timeZone: 'UTC' }).format(utc(ymd));

/** The point a day falls in: itself, its week's Monday or its month's 1st (never before `from`) */
export function bucketOf(ymd: string, grain: StatGrain, from: string): string {
  const start = grain === 'day' ? ymd : grain === 'week' ? addDays(ymd, -weekdayOf(ymd)) : monthStart(ymd);
  return start < from ? from : start;
}

/** Every point from `from` to `to`, zeros included */
export function buckets(from: string, to: string, grain: StatGrain): string[] {
  const out: string[] = [];
  let day = from;
  while (day <= to) {
    out.push(day);
    day = grain === 'day' ? addDays(day, 1) : grain === 'week' ? addDays(day, 7 - weekdayOf(day)) : nextMonth(day);
  }
  return out;
}

/** "Oct 14", "Week of Oct 13", "Oct 2026"; [years] spells the year out on day and week labels */
export function pointLabel(start: string, grain: StatGrain, years: boolean): string {
  if (grain === 'month') return fmt(start, { month: 'short', year: 'numeric' });
  const day = fmt(start, years ? { month: 'short', day: 'numeric', year: 'numeric' } : { month: 'short', day: 'numeric' });
  return grain === 'week' ? `Week of ${day}` : day;
}

/** Day up to 31 days, week up to 92, month beyond; a grain asked for that would give more than 400 points falls back */
export function grainFor(days: number, asked?: StatGrain): StatGrain {
  const auto: StatGrain = days <= 31 ? 'day' : days <= 92 ? 'week' : 'month';
  if (!asked) return auto;
  const points = asked === 'day' ? days : asked === 'week' ? days / 7 : days / 30;
  return points > 400 ? auto : asked;
}

/** One decimal, for shares and change percentages */
export const round1 = (n: number): number => Math.round(n * 10) / 10;

/* ------------------------------------------------------------------ the period asked for */

export interface PeriodQuery {
  range?: StatRange;
  from?: string;
  to?: string;
  grain?: StatGrain;
}

export interface StatPeriod {
  from: string;
  to: string;
  /** range=all: there is no period before this one, so no comparison */
  all: boolean;
  grain: StatGrain;
  /** Days covered, both ends included */
  days: number;
  /** The period covers more than one calendar year, so day and week labels spell the year out */
  years: boolean;
}

const invalid = (path: string, message: string) => new AppError('VALIDATION_FAILED', 'Some details need fixing', { issues: [{ path, message }] });

/**
 * The market days a request asks for, with the grain to draw them at. [today] is the market day now;
 * [firstDay] is the day of the customer's first record, used by range=all (today when they have none).
 */
export function statPeriod(q: PeriodQuery, today: string, firstDay?: string | null): StatPeriod {
  const { from, to, all } = periodDays(q, today, firstDay);
  const days = daysBetween(from, to);
  return { from, to, all, days, grain: grainFor(days, q.grain), years: from.slice(0, 4) !== to.slice(0, 4) };
}

function periodDays(q: PeriodQuery, today: string, firstDay?: string | null): { from: string; to: string; all: boolean } {
  if (q.from || q.to) {
    if (!q.from || !q.to) throw invalid(q.from ? 'to' : 'from', 'Give both from and to');
    if (q.from > q.to) throw invalid('to', 'to must be on or after from');
    if (daysBetween(q.from, q.to) > MAX_PERIOD_DAYS) throw invalid('from', 'At most 3 years at a time');
    return { from: q.from, to: q.to, all: false };
  }
  const year = Number(today.slice(0, 4));
  switch (q.range ?? 'last_12_months') {
    case 'last_30_days':
      return { from: addDays(today, -29), to: today, all: false };
    case 'last_3_months':
      return { from: addDays(today, -90), to: today, all: false };
    case 'last_6_months':
      return { from: addDays(today, -181), to: today, all: false };
    case 'this_year':
      return { from: `${year}-01-01`, to: today, all: false };
    case 'last_year':
      return { from: `${year - 1}-01-01`, to: `${year - 1}-12-31`, all: false };
    case 'all': {
      const day = firstDay ?? today;
      return { from: day < today ? day : today, to: today, all: true };
    }
    default:
      return { from: addDays(today, -364), to: today, all: false };
  }
}

/** The same number of days immediately before a period, for the "vs the period before" comparison */
export function previousPeriod(period: StatPeriod): { from: string; to: string } {
  const to = addDays(period.from, -1);
  return { from: addDays(to, -(period.days - 1)), to };
}

/** Builds the previous-period block; [changePct] is null when the previous period had nothing to compare with */
export function statPrevious(from: string, to: string, amount: number, count: number, now: number, currency: string): StatPrevious {
  return { from, to, amount: money(amount, currency), count, changePct: now > 0 || amount > 0 ? (amount > 0 ? round1(((now - amount) / amount) * 100) : null) : null };
}

/* ------------------------------------------------------------------ breakdown rows */

/** What one breakdown row counts up while the records are read */
export interface StatTally {
  label: string;
  amount: number;
  /** Records behind the row; a Set so the same record counted twice (two items of one order) stays one */
  records: Set<string>;
  units: number;
}

export const tallyInto = (map: Map<string, StatTally>, key: string, label: string, recordId: string, amount: number, units = 0): void => {
  const t = map.get(key) ?? { label, amount: 0, records: new Set<string>(), units: 0 };
  t.amount += amount;
  t.units += units;
  t.records.add(recordId);
  map.set(key, t);
};

export interface SharesOptions {
  /** What each row's share is a share of; shares are 0 when it is 0 */
  total: number;
  currency: string;
  /** Rank and keep rows by this instead of amount — `count` for reports that count records, not money */
  by?: 'amount' | 'count';
  /** Rows before the rest becomes "Other" */
  top?: number;
}

/** The label of the row that holds everything past the top rows */
const OTHER_LABEL = 'Other';

/**
 * Breakdown rows, biggest first, with everything past the top rows folded into one "Other" row.
 * `sharePct` is each row's share of [total] to one decimal, so the rows add up to about 100%.
 */
export function shares(map: Map<string, StatTally>, opts: SharesOptions): StatShare[] {
  const { total, currency, by = 'amount', top = TOP_ROWS } = opts;
  const weight = (t: StatTally) => (by === 'count' ? t.records.size : t.amount);
  const rows = [...map.entries()].filter(([, t]) => weight(t) > 0).sort((a, b) => weight(b[1]) - weight(a[1]));
  const pct = (n: number) => (total > 0 ? round1((n / total) * 100) : 0);
  const row = (key: string, t: StatTally): StatShare => ({
    key,
    label: t.label,
    amount: money(t.amount, currency),
    sharePct: pct(weight(t)),
    count: t.records.size,
    units: t.units,
  });
  if (rows.length <= top + 1) return rows.map(([k, t]) => row(k, t));
  const rest = rows.slice(top).reduce<StatTally>(
    (s, [, t]) => ({ label: OTHER_LABEL, amount: s.amount + t.amount, records: new Set([...s.records, ...t.records]), units: s.units + t.units }),
    { label: OTHER_LABEL, amount: 0, records: new Set(), units: 0 },
  );
  return [...rows.slice(0, top).map(([k, t]) => row(k, t)), row('other', rest)];
}

/** Monday to Sunday rows from seven tallies in that order */
export const weekdayRows = (days: readonly { amount: number; count: number }[], currency: string): StatWeekday[] =>
  WEEKDAYS.map((weekday, i) => ({ weekday, label: WEEKDAY_LABELS[i]!, amount: money(days[i]?.amount ?? 0, currency), count: days[i]?.count ?? 0 }));

/** Seven zeroed weekday tallies, indexed by [weekdayOf] */
export const emptyWeekdays = (): { amount: number; count: number }[] => WEEKDAYS.map(() => ({ amount: 0, count: 0 }));

/** An average to one decimal, or null when there is nothing to average */
export const average = (total: number, n: number): number | null => (n > 0 ? round1(total / n) : null);
