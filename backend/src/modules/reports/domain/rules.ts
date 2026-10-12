/** Pure reporting rules: date ranges in market time, deltas, display formatting, validation. No I/O. */
import { createHash } from 'node:crypto';
import { dateInZone, zonedTimeToUtc } from '../../../kernel/lib/clock.js';
import type { MetricDefinition, ReportQuery } from '../../../spec/reports.js';
import { DATE_BASES, GROUP_KEYS, UNITS } from './catalogue.js';

export type Preset = NonNullable<ReportQuery['preset']>;
export type Granularity = 'day' | 'week' | 'month';
export type Basis = 'placement' | 'payment' | 'shipment' | 'completion';

export interface DayRange {
  from: string;
  to: string;
}

export interface Issue {
  path: string;
  message: string;
}

const DAY_MS = 86_400_000;

/** Calendar arithmetic on YYYY-MM-DD strings (time-zone free) */
export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  return new Date(d.getTime() + n * DAY_MS).toISOString().slice(0, 10);
}

/** Days from `from` to `to`, both included */
export const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;

export const isDay = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

export function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The days a preset covers, ending today (market time) */
export function presetRange(preset: Exclude<Preset, 'custom'>, today: string): DayRange {
  switch (preset) {
    case 'today':
      return { from: today, to: today };
    case 'last_7_days':
      return { from: addDays(today, -6), to: today };
    case 'last_14_days':
      return { from: addDays(today, -13), to: today };
    case 'last_30_days':
      return { from: addDays(today, -29), to: today };
    case 'last_90_days':
      return { from: addDays(today, -89), to: today };
    case 'month_to_date':
      return { from: `${today.slice(0, 8)}01`, to: today };
  }
}

/** The previous period of the same length, just before the range */
export function previousRange(r: DayRange): DayRange {
  const n = daysBetween(r.from, r.to);
  return { from: addDays(r.from, -n), to: addDays(r.from, -1) };
}

/** UTC instants of a market-day range: [start of `from`, start of the day after `to`) */
export function instantsOf(r: DayRange, timeZone: string): { start: Date; end: Date } {
  return { start: zonedTimeToUtc(r.from, '00:00', timeZone), end: zonedTimeToUtc(addDays(r.to, 1), '00:00', timeZone) };
}

export const marketDay = (at: Date | string, timeZone: string) => dateInZone(typeof at === 'string' ? new Date(at) : at, timeZone);

/** Start day of the bucket a day falls in (weeks start on Monday) */
export function bucketOf(day: string, g: Granularity): string {
  if (g === 'day') return day;
  if (g === 'month') return `${day.slice(0, 8)}01`;
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay(); // 0 Sunday
  return addDays(day, -((dow + 6) % 7));
}

/** Every bucket of a range, in order (series points with zeros for empty buckets) */
export function bucketsOf(r: DayRange, g: Granularity): string[] {
  const out: string[] = [];
  let day = r.from;
  while (day <= r.to) {
    const b = bucketOf(day, g);
    if (out.at(-1) !== b) out.push(b);
    day = addDays(day, 1);
  }
  return out;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** Axis label, e.g. Oct 8 (months: Oct 2026) */
export function dayLabel(day: string, g: Granularity = 'day'): string {
  const m = MONTHS[Number(day.slice(5, 7)) - 1];
  return g === 'month' ? `${m} ${day.slice(0, 4)}` : `${m} ${Number(day.slice(8, 10))}`;
}

/* ---------------------------------------------------------------- figures */

export const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);

export interface Delta {
  value: number;
  unit: 'pct' | 'pts';
  direction: 'up' | 'down' | 'flat';
  good: boolean;
}

/** Change against the comparison period: percent change for amounts and counts, points for percentages */
/** A report period for people: Oct 9, 2026 · Sep 27 – Oct 10, 2026 · Dec 28, 2025 – Jan 3, 2026 */
export function periodLabel(r: DayRange): string {
  const full = (day: string) => `${dayLabel(day)}, ${day.slice(0, 4)}`;
  if (r.from === r.to) return full(r.from);
  return `${r.from.slice(0, 4) === r.to.slice(0, 4) ? dayLabel(r.from) : full(r.from)} – ${full(r.to)}`;
}

export function deltaOf(current: number, previous: number, unit: MetricDefinition['unit'], higherIsBetter = true): Delta | null {
  if (unit === 'percent') {
    const value = Math.round((current - previous) * 10) / 10;
    const direction = value > 0 ? 'up' : value < 0 ? 'down' : 'flat';
    return { value: Math.abs(value), unit: 'pts', direction, good: direction === 'flat' || (direction === 'up') === higherIsBetter };
  }
  if (previous === 0) return current === 0 ? { value: 0, unit: 'pct', direction: 'flat', good: true } : null;
  const value = Math.round(((current - previous) / Math.abs(previous)) * 1000) / 10;
  const direction = value > 0 ? 'up' : value < 0 ? 'down' : 'flat';
  return { value: Math.abs(value), unit: 'pct', direction, good: direction === 'flat' || (direction === 'up') === higherIsBetter };
}

const number = (n: number, digits = 0) => new Intl.NumberFormat('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(n);

/** Money for tiles: $71.20, $9,412.50, $241.3k, $1.2M */
export function displayMoney(minor: number, currency: string): string {
  const symbol = currency === 'USD' ? '$' : `${currency} `;
  const major = minor / 100;
  const sign = major < 0 ? '−' : '';
  const abs = Math.abs(major);
  if (abs >= 1_000_000) return `${sign}${symbol}${number(abs / 1_000_000, 1)}M`;
  if (abs >= 10_000) return `${sign}${symbol}${number(abs / 1000, 1)}k`;
  return `${sign}${symbol}${number(abs, 2)}`;
}

export function display(value: number, unit: MetricDefinition['unit'], currency: string): string {
  switch (unit) {
    case 'money':
      return displayMoney(value, currency);
    case 'percent':
      return `${number(value, 1)}%`;
    case 'ratio':
      return number(value, 2);
    case 'duration_hours':
      return `${number(value, 1)} h`;
    case 'days':
      return `${number(value, 1)} days`;
    default:
      return number(value);
  }
}

/* ---------------------------------------------------------------- metric definitions */

export const METRIC_KEY = /^[a-z][a-z_]*\.[a-z][a-z0-9_]*$/;

export interface MetricInputLike {
  name: string;
  group: string;
  definition: string;
  formula: string;
  unit: string;
  dateBasisOptions: string[];
  defaultDateBasis: string;
  ownerId?: string | null;
  changeNote: string;
}

/** Business validation of a metric definition (shape is checked by the schema) */
export function metricIssues(m: MetricInputLike, key?: string): Issue[] {
  const issues: Issue[] = [];
  if (key !== undefined && !METRIC_KEY.test(key)) issues.push({ path: 'key', message: 'Use group.name in lower case, e.g. commerce.gross_sales' });
  if (!m.name.trim()) issues.push({ path: 'metric.name', message: 'Name the metric' });
  if (!GROUP_KEYS.includes(m.group as never)) issues.push({ path: 'metric.group', message: `Group is one of ${GROUP_KEYS.join(', ')}` });
  if (!m.definition.trim()) issues.push({ path: 'metric.definition', message: 'Say in plain words what the figure means' });
  if (!m.formula.trim()) issues.push({ path: 'metric.formula', message: 'Say how the figure is computed' });
  if (!UNITS.includes(m.unit as never)) issues.push({ path: 'metric.unit', message: `Unit is one of ${UNITS.join(', ')}` });
  const bad = m.dateBasisOptions.filter((b) => !DATE_BASES.includes(b as never));
  if (!m.dateBasisOptions.length || bad.length) issues.push({ path: 'metric.dateBasisOptions', message: `Date bases are ${DATE_BASES.join(', ')}` });
  if (!m.dateBasisOptions.includes(m.defaultDateBasis)) issues.push({ path: 'metric.defaultDateBasis', message: 'The default date basis must be one of the options' });
  if (!m.changeNote.trim()) issues.push({ path: 'metric.changeNote', message: 'Say what changed' });
  return issues;
}

/* ---------------------------------------------------------------- customers */

/** Buyers are counted without storing who they are: a hash of the customer id or the guest email */
export function customerKey(customerId: string | null | undefined, email: string | null | undefined): string {
  const basis = customerId ? `c:${customerId}` : `g:${(email ?? 'unknown').trim().toLowerCase()}`;
  return createHash('sha256').update(basis).digest('hex').slice(0, 40);
}

/* ---------------------------------------------------------------- schedules */

/** Next run of a schedule after `after`, at `time` market time (weekly on dayOfWeek 0=Sunday, monthly on the 1st) */
export function nextRun(s: { frequency: 'daily' | 'weekly' | 'monthly'; dayOfWeek?: number | null; time: string }, after: Date, timeZone: string): Date {
  let day = dateInZone(after, timeZone);
  for (let i = 0; i < 400; i++) {
    const at = zonedTimeToUtc(day, s.time, timeZone);
    const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
    const fits = s.frequency === 'daily' || (s.frequency === 'weekly' && dow === (s.dayOfWeek ?? 1)) || (s.frequency === 'monthly' && day.endsWith('-01'));
    if (fits && at > after) return at;
    day = addDays(day, 1);
  }
  return new Date(after.getTime() + DAY_MS);
}

export const TIME_OF_DAY = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * A refund split per seller (decision D5): the named items' amounts go to their sellers; the rest is split in
 * proportion to each seller's item amounts on the order (largest remainder, so the shares add up exactly). Without
 * order lines the rest goes to the named sellers in proportion to their items.
 */
export function splitRefund(total: number, named: { sellerId: string; amount: number }[], lines: { sellerId: string; weight: number }[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const n of named) out.set(n.sellerId, (out.get(n.sellerId) ?? 0) + Math.max(0, n.amount));
  const namedSum = [...out.values()].reduce((s, x) => s + x, 0);
  // the named amounts exceed the refund: scale them down to the total
  if (namedSum > total) return largestRemainder(total, [...out].map(([key, weight]) => ({ key, weight })));
  const rest = total - namedSum;
  if (rest === 0) return out;
  const weights = new Map<string, number>();
  for (const l of lines) weights.set(l.sellerId, (weights.get(l.sellerId) ?? 0) + Math.max(0, l.weight));
  let basis = [...weights].filter(([, w]) => w > 0).map(([key, weight]) => ({ key, weight }));
  if (!basis.length) basis = [...out].filter(([, v]) => v > 0).map(([key, weight]) => ({ key, weight }));
  if (!basis.length) basis = [{ key: named[0]?.sellerId ?? lines[0]?.sellerId ?? '', weight: 1 }];
  for (const [k, v] of largestRemainder(rest, basis)) out.set(k, (out.get(k) ?? 0) + v);
  return out;
}

/** Integer shares of a total in proportion to weights; the leftover units go to the largest remainders */
function largestRemainder(total: number, parts: { key: string; weight: number }[]): Map<string, number> {
  const sum = parts.reduce((s, p) => s + p.weight, 0);
  const out = new Map<string, number>();
  if (!parts.length || sum <= 0) return out;
  const raw = parts.map((p) => ({ key: p.key, exact: (total * p.weight) / sum }));
  let given = 0;
  for (const r of raw) {
    const v = Math.floor(r.exact);
    out.set(r.key, (out.get(r.key) ?? 0) + v);
    given += v;
  }
  const order = [...raw].sort((a, b) => b.exact - Math.floor(b.exact) - (a.exact - Math.floor(a.exact)));
  for (let i = 0; given < total; i = (i + 1) % order.length, given++) out.set(order[i]!.key, out.get(order[i]!.key)! + 1);
  return out;
}
