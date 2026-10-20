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

/** The tooltip stays inside the chart box (phones) and does not animate. */
export const tooltipBase = { isAnimationActive: false, allowEscapeViewBox: { x: false, y: false } };
