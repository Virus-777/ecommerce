// Shared types, colours and number formats of the charts (Recharts 3, styled with the Marketly chart tokens).
// Colours are CSS variables, so a chart follows the light/dark theme without re-rendering.
import { money, num } from '../../lib/format';

/** Formats one value for the axis, the tooltip or the table. */
export type Fmt = (v: number) => string;

/**
 * One point on the x axis: `x` (a date or a category key), `label` (what the axis shows) and one number per series
 * key. A comparison value sits under `<key>:compare` on the same row (same x as the current period).
 */
export interface ChartRow {
  x: string;
  label: string;
  [key: string]: string | number | null | undefined;
}

/** A series the chart draws from `ChartRow[key]`. */
export interface ChartSeries {
  key: string;
  label: string;
  /** Colour override (a CSS colour or var()); default: the series' slot, chartColor(index). */
  color?: string;
  /** TrendChart/ComboChart: draw on the right-hand percentage axis. */
  axis?: 'left' | 'right';
}

/** Series slots --chart-1 … --chart-6. Never cycled: past 6, fold the rest into "Other" (see foldSlices). */
export const MAX_SERIES = 6;
export const COMPARE_COLOR = 'var(--chart-compare)';
export const POSITIVE_COLOR = 'var(--chart-positive)';
export const NEGATIVE_COLOR = 'var(--chart-negative)';

/** The colour of series slot i (0-based). Slots past the sixth get the muted comparison grey ("Other"). */
export const chartColor = (i: number) => (i >= 0 && i < MAX_SERIES ? `var(--chart-${i + 1})` : COMPARE_COLOR);

export const seriesColor = (s: ChartSeries, i: number) => s.color ?? chartColor(i);

/** The key of a series' comparison twin (the backend's `<key>:compare`, docs/09 §3.3). */
export const compareKey = (key: string) => `${key}:compare`;

/** A row's number for a key, or null when missing. */
export function valueOf(row: ChartRow | undefined, key: string): number | null {
  const v = row?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** True when any row has a comparison value for the series. */
export const hasCompare = (rows: ChartRow[], key: string) => rows.some((r) => valueOf(r, compareKey(key)) !== null);

/** Change from the comparison value, e.g. "+12.5%"; empty when there is nothing to compare with. */
export function changeText(current: number | null, before: number | null): string {
  if (current === null || before === null || before === 0) return '';
  const pct = ((current - before) / Math.abs(before)) * 100;
  if (Math.abs(pct) < 0.05) return '0.0%';
  return `${pct > 0 ? '+' : '−'}${Math.abs(pct).toFixed(1)}%`;
}

/* ----- formats (money comes from the API in minor units: cents) ----- */

const compact = (v: number) => {
  const a = Math.abs(v);
  const sign = v < 0 ? '−' : '';
  if (a >= 1e6) return `${sign}${trim(a / 1e6)}M`;
  if (a >= 1e3) return `${sign}${trim(a / 1e3)}k`;
  return `${sign}${trim(a)}`;
};
const trim = (n: number) => (n >= 100 ? String(Math.round(n)) : n.toFixed(1).replace(/\.0$/, ''));

/** Cents → "$1,234.50", "−$213.30" (tooltips, tables). */
export const fmtMoney: Fmt = (cents) => money(cents / 100);
/** Cents → "$1.2k" (axis ticks). */
export const fmtMoneyCompact: Fmt = (cents) => {
  const c = compact(cents / 100);
  return c.startsWith('−') ? `−$${c.slice(1)}` : `$${c}`;
};
/** 1,234 */
export const fmtCount: Fmt = (v) => num(Math.round(v * 10) / 10);
/** 12k */
export const fmtCountCompact: Fmt = compact;
/** 12.5% (the value is already a percentage, 0–100). */
export const fmtPercent: Fmt = (v) => `${v.toFixed(1)}%`;
/** 13% (axis ticks). */
export const fmtPercentCompact: Fmt = (v) => `${Math.round(v)}%`;

/** Formats for a report metric unit (reports.MetricDefinition.unit): [full, axis]. */
export function fmtForUnit(unit: string | null | undefined): [Fmt, Fmt] {
  switch ((unit ?? '').toLowerCase()) {
    case 'money':
      return [fmtMoney, fmtMoneyCompact];
    case 'percent':
      return [fmtPercent, fmtPercentCompact];
    case 'duration_hours':
      return [(v) => `${v.toFixed(1)} h`, (v) => `${Math.round(v)} h`];
    case 'days':
      return [(v) => `${v.toFixed(1)} days`, (v) => `${Math.round(v)} d`];
    default:
      return [fmtCount, fmtCountCompact];
  }
}
