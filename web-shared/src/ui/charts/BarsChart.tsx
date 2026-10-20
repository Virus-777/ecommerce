import { Bar, BarChart, CartesianGrid, ReferenceLine, Tooltip, XAxis, YAxis } from 'recharts';
import { barCursor, grid, margin, tooltipBase, xAxis, yAxis } from './axes';
import { ChartLegend, useHiddenSeries, type LegendItem } from './ChartLegend';
import { ChartTooltip } from './ChartTooltip';
import { COMPARE_COLOR, compareKey, hasCompare, seriesColor, valueOf, type ChartRow, type ChartSeries, type Fmt } from './model';

// Bars: grouped or stacked, upright (over time) or horizontal (rankings: one row per item, the longest at the
// top when the caller sorts). Negative values grow down (or left) from a zero line. Bars are at most 24 px thick
// with a 4 px rounded end; stacked segments are split by a 2 px gap in the surface colour.

export interface BarsChartProps {
  rows: ChartRow[];
  series: ChartSeries[];
  fmt: Fmt;
  axisFmt?: Fmt;
  stacked?: boolean;
  /** Horizontal bars, the row labels down the left (rankings). */
  horizontal?: boolean;
  /** Name of the comparison period; grouped bars then get a muted twin bar per series. */
  compareLabel?: string;
  /** Default 240; horizontal charts default to 32 px per row. */
  height?: number;
  label: string;
}

const COMPARE = '__compare';
/** Long category names are cut on the axis (the tooltip and the table show them whole). */
const cut = (s: string) => (s.length > 18 ? `${s.slice(0, 17)}…` : s);

export function BarsChart({ rows, series, fmt, axisFmt, stacked, horizontal, compareLabel, height, label }: BarsChartProps) {
  const [hidden, toggle] = useHiddenSeries();
  const withTwin = compareLabel && !stacked ? series.filter((s) => hasCompare(rows, s.key)) : [];
  const shown = series.filter((s) => !hidden.has(s.key));
  const showTwins = withTwin.length > 0 && !hidden.has(COMPARE);
  const negative = rows.some((r) => series.some((s) => (valueOf(r, s.key) ?? 0) < 0));
  // rounded data end, square at the baseline; flat when values can be negative (the end would be on the wrong side)
  const radius: [number, number, number, number] | number = negative || stacked ? 0 : horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0];

  const legend: LegendItem[] = series.map((s, i) => ({ key: s.key, label: s.label, color: seriesColor(s, i), shape: 'rect' }));
  if (withTwin.length) legend.push({ key: COMPARE, label: compareLabel!, color: COMPARE_COLOR, shape: 'rect' });
  const keys = legend.map((l) => l.key);
  const h = height ?? (horizontal ? Math.max(120, rows.length * 32 + 32) : 240);

  return (
    <div className="chart" role="figure" aria-label={label}>
      {legend.length > 1 && <ChartLegend items={legend} hidden={hidden} onToggle={(k) => toggle(k, keys)} />}
      <BarChart data={rows} layout={horizontal ? 'vertical' : 'horizontal'} responsive style={{ width: '100%', height: h }} margin={margin} barCategoryGap="20%" barGap={2}>
        <CartesianGrid {...grid} vertical={!!horizontal} horizontal={!horizontal} />
        {horizontal ? (
          <>
            <XAxis {...yAxis} type="number" width={undefined} tickFormatter={axisFmt ?? fmt} />
            <YAxis {...xAxis} type="category" width="auto" interval={0} tickFormatter={cut} />
          </>
        ) : (
          <>
            <XAxis {...xAxis} />
            <YAxis {...yAxis} tickFormatter={axisFmt ?? fmt} />
          </>
        )}
        {negative && (horizontal ? <ReferenceLine x={0} stroke="var(--border-strong)" /> : <ReferenceLine y={0} stroke="var(--border-strong)" />)}
        <Tooltip
          {...tooltipBase}
          cursor={barCursor}
          content={(p) => <ChartTooltip active={p.active} payload={p.payload} compareLabel={showTwins ? compareLabel : ''} lines={shown.map((s) => ({ key: s.key, label: s.label, color: seriesColor(s, series.indexOf(s)), fmt, shape: 'rect' }))} />}
        />
        {shown.flatMap((s) => {
          const bars = [
            <Bar key={s.key} dataKey={s.key} name={s.label} fill={seriesColor(s, series.indexOf(s))} stackId={stacked ? 'stack' : undefined} maxBarSize={24} radius={radius} stroke={stacked ? 'var(--surface)' : undefined} strokeWidth={stacked ? 2 : 0} isAnimationActive={false} />,
          ];
          if (showTwins && withTwin.includes(s)) bars.push(<Bar key={`${s.key}:c`} dataKey={compareKey(s.key)} name={`${s.label}, ${compareLabel}`} fill={COMPARE_COLOR} maxBarSize={24} radius={radius} isAnimationActive={false} />);
          return bars;
        })}
      </BarChart>
    </div>
  );
}
