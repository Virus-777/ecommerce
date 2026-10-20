// Report periods (docs/09 §4.1): the presets, grains and comparisons of PeriodControl, read from and written to the
// URL (?preset=&from=&to=&grain=&compare=), and turned into the ReportQuery fields the reports API takes. Days
// are Pacific calendar days as YYYY-MM-DD. The ranges here mirror the backend (reports/domain/rules.ts) closely
// enough to label the control and limit the grain; pages show the range the result reports (meta.range).

export type PeriodPreset =
  | 'today'
  | 'last_7_days'
  | 'last_14_days'
  | 'last_30_days'
  | 'last_90_days'
  | 'month_to_date'
  | 'quarter_to_date'
  | 'year_to_date'
  | 'last_12_months'
  | 'custom';
export type PeriodGrain = 'day' | 'week' | 'month';
export type PeriodCompare = 'none' | 'previous_period' | 'same_period_last_year';

export interface DayRange {
  from: string;
  to: string;
}

/** The ReportQuery fields a period sets (spread into the query body). */
export interface PeriodQuery {
  preset: PeriodPreset;
  range?: DayRange;
  granularity?: PeriodGrain;
  compare: PeriodCompare;
}

export const PRESET_LABEL: Record<PeriodPreset, string> = {
  today: 'Today',
  last_7_days: '7 days',
  last_14_days: '14 days',
  last_30_days: '30 days',
  last_90_days: '90 days',
  month_to_date: 'Month to date',
  quarter_to_date: 'Quarter to date',
  year_to_date: 'Year to date',
  last_12_months: '12 months',
  custom: 'Custom',
};

/** The presets PeriodControl offers by default (docs/09 §4.1). */
export const DEFAULT_PRESETS: PeriodPreset[] = ['today', 'last_7_days', 'last_30_days', 'last_90_days', 'month_to_date', 'quarter_to_date', 'year_to_date', 'last_12_months', 'custom'];

export const GRAIN_LABEL: Record<PeriodGrain, string> = { day: 'Day', week: 'Week', month: 'Month' };
export const COMPARE_LABEL: Record<PeriodCompare, string> = { none: 'No comparison', previous_period: 'Previous period', same_period_last_year: 'Same period last year' };

/** The longest range the reports API answers (days, both ends included). */
export const MAX_RANGE_DAYS = 400;
/** Longer ranges than this cannot be shown per day. */
export const MAX_DAY_GRAIN_DAYS = 92;

/* ----- calendar arithmetic on YYYY-MM-DD (time-zone free) ----- */

const toDate = (d: string) => new Date(`${d}T00:00:00Z`);
const toDay = (d: Date) => d.toISOString().slice(0, 10);
export const isDay = (v: string | null | undefined): v is string => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(toDate(v).getTime());

export function addDays(day: string, n: number): string {
  const d = toDate(day);
  d.setUTCDate(d.getUTCDate() + n);
  return toDay(d);
}

/** Same day n months later; the 31st becomes the month's last day (and 29 Feb → 28 Feb). */
export function addMonths(day: string, n: number): string {
  const d = toDate(day);
  const want = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(want, last));
  return toDay(d);
}

/** Days from `from` to `to`, both included. */
export const daysIn = (r: DayRange) => Math.round((toDate(r.to).getTime() - toDate(r.from).getTime()) / 86_400_000) + 1;

/** The days a preset covers, ending `today`. */
export function presetRange(preset: Exclude<PeriodPreset, 'custom'>, today: string): DayRange {
  const y = today.slice(0, 4);
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
    case 'quarter_to_date': {
      const q = Math.floor((Number(today.slice(5, 7)) - 1) / 3) * 3 + 1;
      return { from: `${y}-${String(q).padStart(2, '0')}-01`, to: today };
    }
    case 'year_to_date':
      return { from: `${y}-01-01`, to: today };
    case 'last_12_months':
      return { from: addDays(addMonths(today, -12), 1), to: today };
  }
}

/** The grain the backend picks when none is sent: day up to 31 days, week up to 92, then month. */
export const autoGrain = (days: number): PeriodGrain => (days > MAX_DAY_GRAIN_DAYS ? 'month' : days > 31 ? 'week' : 'day');

/** Grains that make sense for a range: no day grain past 92 days. */
export const grainAllowed = (g: PeriodGrain, days: number) => g !== 'day' || days <= MAX_DAY_GRAIN_DAYS;

/** The comparison range: the same number of days just before, or the same dates a year earlier. */
export function compareRange(r: DayRange, compare: PeriodCompare): DayRange | null {
  if (compare === 'none') return null;
  if (compare === 'same_period_last_year') return { from: addMonths(r.from, -12), to: addMonths(r.to, -12) };
  const n = daysIn(r);
  return { from: addDays(r.from, -n), to: addDays(r.from, -1) };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const md = (d: string) => `${MONTHS[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}`;
/** "Oct 1 – Oct 21, 2026", "Dec 1, 2025 – Jan 5, 2026", "Oct 21, 2026". */
export function rangeLabel(r: DayRange): string {
  if (r.from === r.to) return `${md(r.from)}, ${r.from.slice(0, 4)}`;
  return r.from.slice(0, 4) === r.to.slice(0, 4) ? `${md(r.from)} – ${md(r.to)}, ${r.to.slice(0, 4)}` : `${md(r.from)}, ${r.from.slice(0, 4)} – ${md(r.to)}, ${r.to.slice(0, 4)}`;
}

/* ----- URL state ----- */

export interface PeriodDefaults {
  preset?: PeriodPreset;
  compare?: PeriodCompare;
}

export interface Period {
  preset: PeriodPreset;
  /** The days covered (for custom: the chosen days). */
  range: DayRange;
  days: number;
  /** The grain the charts use: the chosen one, else the backend's automatic one. */
  grain: PeriodGrain;
  /** True when the reader picked the grain (it is then sent to the API). */
  grainChosen: boolean;
  compare: PeriodCompare;
  compareRange: DayRange | null;
  /** "Oct 1 – Oct 21, 2026" */
  label: string;
  /** Spread into the report query body. */
  query: PeriodQuery;
}

const PRESETS = Object.keys(PRESET_LABEL) as PeriodPreset[];
const GRAINS: PeriodGrain[] = ['day', 'week', 'month'];
const COMPARES = Object.keys(COMPARE_LABEL) as PeriodCompare[];
const pick = <T extends string>(v: string | null, all: readonly T[]): T | undefined => (v && (all as readonly string[]).includes(v) ? (v as T) : undefined);

/**
 * The period in URL parameters, with defaults for anything missing or invalid. A custom range must be real days,
 * from ≤ to ≤ today and at most 400 days; otherwise the default preset applies.
 */
export function readPeriod(params: URLSearchParams, today: string, defaults: PeriodDefaults = {}): Period {
  const fallback = defaults.preset && defaults.preset !== 'custom' ? defaults.preset : 'last_30_days';
  let preset = pick(params.get('preset'), PRESETS) ?? fallback;
  const from = params.get('from');
  const to = params.get('to');
  let range: DayRange;
  if (preset === 'custom' && isDay(from) && isDay(to) && from <= to && to <= today && daysIn({ from, to }) <= MAX_RANGE_DAYS) range = { from, to };
  else {
    if (preset === 'custom') preset = fallback;
    range = presetRange(preset as Exclude<PeriodPreset, 'custom'>, today);
  }
  const days = daysIn(range);
  const chosen = pick(params.get('grain'), GRAINS);
  const grainChosen = !!chosen && grainAllowed(chosen, days);
  const grain = grainChosen ? chosen! : autoGrain(days);
  const compare = pick(params.get('compare'), COMPARES) ?? defaults.compare ?? 'previous_period';
  return {
    preset,
    range,
    days,
    grain,
    grainChosen,
    compare,
    compareRange: compareRange(range, compare),
    label: rangeLabel(range),
    query: { preset, ...(preset === 'custom' ? { range } : {}), ...(grainChosen ? { granularity: grain } : {}), compare },
  };
}

export interface PeriodChange {
  preset?: PeriodPreset;
  range?: DayRange;
  grain?: PeriodGrain | null;
  compare?: PeriodCompare;
}

/** New URL parameters after a change; values equal to the defaults are left out so links stay short. */
export function writePeriod(params: URLSearchParams, current: Period, change: PeriodChange, defaults: PeriodDefaults = {}): URLSearchParams {
  const next = new URLSearchParams(params);
  const preset = change.preset ?? current.preset;
  const range = change.range ?? current.range;
  const set = (k: string, v: string | null | undefined) => (v ? next.set(k, v) : next.delete(k));
  set('preset', preset === (defaults.preset ?? 'last_30_days') ? null : preset);
  set('from', preset === 'custom' ? range.from : null);
  set('to', preset === 'custom' ? range.to : null);
  const grain = change.grain === undefined ? (current.grainChosen ? current.grain : null) : change.grain;
  set('grain', grain);
  const compare = change.compare ?? current.compare;
  set('compare', compare === (defaults.compare ?? 'previous_period') ? null : compare);
  return next;
}
