import { Cell, Pie, PieChart, Tooltip } from 'recharts';
import { ChartLegend, useHiddenSeries } from './ChartLegend';
import type { ChartTable } from './ChartFrame';
import { chartColor, COMPARE_COLOR, MAX_SERIES, type Fmt } from './model';
import { tooltipBase } from './axes';

// Shares of a whole (fees by type, costs by kind) with the total in the middle. At most six slices: the smallest
// rest are folded into "Other" (never a 7th colour). The legend lists every slice with its value and share, so
// the numbers are readable without hovering; pressing a legend entry hides that slice.

export interface DonutSlice {
  key: string;
  label: string;
  value: number;
}

/** Largest first; past `max` slices the rest become one "Other" slice. Zero and negative slices are dropped. */
export function foldSlices(slices: DonutSlice[], max = MAX_SERIES): DonutSlice[] {
  const sorted = slices.filter((s) => s.value > 0).sort((a, b) => b.value - a.value);
  if (sorted.length <= max) return sorted;
  const keep = sorted.slice(0, max - 1);
  const other = sorted.slice(max - 1).reduce((t, s) => t + s.value, 0);
  return [...keep, { key: '__other', label: 'Other', value: other }];
}

const share = (v: number, total: number) => (total ? `${((v / total) * 100).toFixed(1)}%` : '0%');

/** The slices as a table for ChartFrame. */
export function donutTable(slices: DonutSlice[], fmt: Fmt, labelHeader = 'Part'): ChartTable {
  const total = slices.reduce((t, s) => t + Math.max(0, s.value), 0);
  return {
    columns: [{ key: 'label', label: labelHeader }, { key: 'value', label: 'Amount', fmt }, { key: 'share', label: 'Share' }],
    rows: foldSlices(slices).map((s) => ({ label: s.label, value: s.value, share: share(s.value, total) })),
    foot: { label: 'Total', value: total, share: '100%' },
  };
}

export function DonutChart({ slices, fmt, totalLabel = 'Total', height = 220, label }: { slices: DonutSlice[]; fmt: Fmt; totalLabel?: string; height?: number; label: string }) {
  const [hidden, toggle] = useHiddenSeries();
  const parts = foldSlices(slices);
  const colorOf = (i: number, key: string) => (key === '__other' ? COMPARE_COLOR : chartColor(i));
  const total = parts.reduce((t, s) => t + s.value, 0);
  const shown = parts.filter((s) => !hidden.has(s.key));
  const shownTotal = shown.reduce((t, s) => t + s.value, 0);
  const keys = parts.map((p) => p.key);

  return (
    <div className="chart chart-donut" role="figure" aria-label={label}>
      <div className="chart-donut-plot" style={{ height }}>
        <PieChart responsive style={{ width: '100%', height }}>
          <Pie data={shown} dataKey="value" nameKey="label" innerRadius="62%" outerRadius="92%" paddingAngle={shown.length > 1 ? 1 : 0} stroke="var(--surface)" strokeWidth={2} isAnimationActive={false}>
            {shown.map((s) => (
              <Cell key={s.key} fill={colorOf(parts.indexOf(s), s.key)} />
            ))}
          </Pie>
          <Tooltip
            {...tooltipBase}
            content={({ active, payload }) => {
              const s = payload?.[0]?.payload as DonutSlice | undefined;
              if (!active || !s) return null;
              return (
                <div className="chart-tip">
                  <div className="chart-tip-h">{s.label}</div>
                  <div className="chart-tip-row">
                    <b>{fmt(s.value)}</b>
                    <span>{share(s.value, total)}</span>
                  </div>
                </div>
              );
            }}
          />
        </PieChart>
        <div className="chart-donut-total">
          <span className="xs muted">{totalLabel}</span>
          <b>{fmt(shownTotal)}</b>
        </div>
      </div>
      <ChartLegend
        label="Parts"
        items={parts.map((s, i) => ({ key: s.key, label: s.label, color: colorOf(i, s.key), shape: 'rect', note: `${fmt(s.value)} · ${share(s.value, total)}` }))}
        hidden={hidden}
        onToggle={parts.length > 1 ? (k) => toggle(k, keys) : undefined}
      />
    </div>
  );
}
