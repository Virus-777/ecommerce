// Axis, grid and cursor settings shared by the cartesian charts, spread into Recharts components
// (<XAxis {...xAxis} />). Recessive chrome: hairline grid, no tick marks, muted 11px tick text.

const tick = { fill: 'var(--chart-axis)', fontSize: 11 };

/** Category (x) axis: shows the row label; drops labels that would collide, keeps the first and last. */
export const xAxis = {
  dataKey: 'label',
  tick,
  tickLine: false,
  axisLine: { stroke: 'var(--border-strong)' },
  interval: 'preserveStartEnd' as const,
  minTickGap: 12,
  tickMargin: 6,
};

/** Value axis: width fits its labels (so a phone keeps every pixel for the plot). */
export const yAxis = {
  tick,
  tickLine: false,
  axisLine: false,
  width: 'auto' as const,
  tickCount: 5,
};

export const grid = { stroke: 'var(--chart-grid)', vertical: false };

export const margin = { top: 8, right: 8, bottom: 0, left: 0 };

/** Hover crosshair for line/area charts and band highlight for bar charts. */
export const lineCursor = { stroke: 'var(--border-strong)', strokeWidth: 1 };
export const barCursor = { fill: 'var(--surface-2)' };

/* ----- value axis ----- */

type Row = Readonly<Record<string, unknown>>;
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** True when no value under these keys (or their `:compare` twins) is anything but zero or missing. */
export function allZero(rows: ReadonlyArray<Row>, keys: string[]): boolean {
  return rows.every((r) => keys.every((k) => !num(r[k]) && !num(r[`${k}:compare`])));
}

/**
 * Domain and ticks for a value axis with nothing but zeros (no payouts this month): Recharts would spread five
 * "$0" ticks over a [0, 0] domain. A 0–1 domain with a single 0 tick keeps the flat line on a sane axis.
 */
export const zeroOnlyAxis = { domain: [0, 1] as [number, number], ticks: [0] };

/**
 * Props for a value axis (the YAxis, or the XAxis of horizontal bars): the tick format, plus
 *  - nothing but zeros: zeroOnlyAxis;
 *  - `whole` (counts, see model.allowsDecimals): whole-number ticks only, and fewer of them when the values are
 *    small, so a count of at most 1 gets the ticks 0 and 1 rather than 0, 1, 2, 3, 4.
 * `stacked` adds a row's values up (stacked bars) when finding how far the axis must reach.
 */
export function valueAxis(rows: ReadonlyArray<Row>, keys: string[], fmt: (v: number) => string, { whole = false, stacked = false } = {}) {
  if (allZero(rows, keys)) return { tickFormatter: fmt, ...zeroOnlyAxis };
  if (!whole) return { tickFormatter: fmt };
  let lo = 0;
  let hi = 0;
  for (const r of rows) {
    const values = keys.map((k) => num(r[k]));
    const twins = stacked ? [] : keys.map((k) => num(r[`${k}:compare`])); // stacked bars draw no comparison twins
    const up = stacked ? [values.filter((v) => v > 0).reduce((a, b) => a + b, 0)] : values;
    const down = stacked ? [values.filter((v) => v < 0).reduce((a, b) => a + b, 0)] : values;
    hi = Math.max(hi, ...up, ...twins);
    lo = Math.min(lo, ...down, ...twins);
  }
  const span = Math.ceil(hi) - Math.floor(lo);
  return { tickFormatter: fmt, allowDecimals: false, ...(span < 4 ? { tickCount: span + 1 } : {}) };
}

/* ----- category axis of horizontal bars ----- */

/** Room the axis keeps right of the label: the hidden tick line (6 px), the tick margin (6 px) and a little air. */
const LABEL_PAD = 16;
let canvas: CanvasRenderingContext2D | null | undefined;

/**
 * Width in px of an 11px tick label, measured with the page's font; without a page (tests) about 0.6 em a
 * character.
 */
export function labelWidth(s: string): number {
  if (canvas === undefined) canvas = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
  if (!canvas) return s.length * 6.6;
  canvas.font = `11px ${getComputedStyle(document.body).fontFamily}`;
  return canvas.measureText(s).width;
}

/**
 * The label column of horizontal bars: wide enough for the longest label, but at most 40% of the chart (the bars
 * need the rest; before the chart is measured, width 0, it assumes 400 px). `fit` shortens a label that does not
 * fit by cutting it in the middle (cutMiddle).
 */
export function labelColumn(labels: string[], chartWidth: number, measure: (s: string) => number = labelWidth): { width: number; fit: (s: string) => string } {
  const longest = labels.reduce((n, l) => Math.max(n, measure(l)), 0);
  const cap = Math.floor((chartWidth > 0 ? chartWidth : 400) * 0.4);
  const width = Math.max(40, Math.min(cap, Math.ceil(longest) + LABEL_PAD));
  const room = width - LABEL_PAD;
  const fitted = new Map<string, string>();
  const fit = (s: string) => {
    let out = fitted.get(s);
    if (out === undefined) {
      out = s;
      for (let n = s.length - 1; n >= 4 && measure(out) > room; n--) out = cutMiddle(s, n);
      fitted.set(s, out);
    }
    return out;
  };
  return { width, fit };
}

/**
 * Cuts a label to `max` characters in the middle: "Rose City Audio GZ0O99-2" → "Rose Cit…GZ0O99-2". Names often
 * share a long start (one seller's stores, "Electronics › …" categories) and differ at the end, so both stay.
 * The tooltip and the table show the whole name.
 */
export function cutMiddle(s: string, max: number): string {
  if (s.length <= max) return s;
  const keep = Math.max(2, max - 1);
  const tail = Math.ceil(keep / 2);
  return `${s.slice(0, keep - tail).trimEnd()}…${s.slice(s.length - tail).trimStart()}`;
}

/** The tooltip stays inside the chart box (phones) and does not animate. */
export const tooltipBase = { isAnimationActive: false, allowEscapeViewBox: { x: false, y: false } };
