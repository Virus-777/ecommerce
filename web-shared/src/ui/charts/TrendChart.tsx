import { Area, CartesianGrid, ComposedChart, Line, Tooltip, XAxis, YAxis } from 'recharts';
import { grid, lineCursor, margin, tooltipBase, xAxis, yAxis } from './axes';
import { ChartLegend, useHiddenSeries, type LegendItem } from './ChartLegend';
import { ChartTooltip } from './ChartTooltip';
import { COMPARE_COLOR, compareKey, fmtPercent, fmtPercentCompact, hasCompare, seriesColor, type ChartRow, type ChartSeries, type Fmt } from './model';

// Values over time: one or more lines (or areas), each optionally with its comparison twin drawn dashed in
// --chart-compare on the same x axis. A series with axis: 'right' goes on a second, percentage axis (e.g. margin %
// next to money); the doc asks for it, and the right axis is labelled with % ticks so the two scales are not
// mistaken for one.

export interface TrendChartProps {
  rows: ChartRow[];
  series: ChartSeries[];
  /** Value format in the tooltip (left-axis series). */
  fmt: Fmt;
  /** Left axis ticks; default fmt. */
  axisFmt?: Fmt;
  /** Format of right-axis series (default 12.5%) and its ticks (default 13%). */
  rightFmt?: Fmt;
  rightAxisFmt?: Fmt;
  /** Fill a light wash under each line. */
  area?: boolean;
  /** Name of the comparison period; twins (`<key>:compare`) are drawn only when this is set. */
  compareLabel?: string;
  height?: number;
  /** Accessible name, e.g. "Net earnings and profit per week, Oct 1 to Oct 21". */
  label: string;
}

const COMPARE = '__compare';

export function TrendChart({ rows, series, fmt, axisFmt, rightFmt = fmtPercent, rightAxisFmt = fmtPercentCompact, area, compareLabel, height = 240, label }: TrendChartProps) {
  const [hidden, toggle] = useHiddenSeries();
  const withTwin = compareLabel ? series.filter((s) => hasCompare(rows, s.key)) : [];
  const shown = series.filter((s) => !hidden.has(s.key));
  const showTwins = withTwin.length > 0 && !hidden.has(COMPARE);
  const hasRight = shown.some((s) => s.axis === 'right');
  const fmtOf = (s: ChartSeries) => (s.axis === 'right' ? rightFmt : fmt);

  const legend: LegendItem[] = series.map((s, i) => ({ key: s.key, label: s.label, color: seriesColor(s, i), shape: area ? 'rect' : 'line' }));
  if (withTwin.length) legend.push({ key: COMPARE, label: compareLabel!, color: COMPARE_COLOR, shape: 'dash' });
  const keys = legend.map((l) => l.key);
  const one = rows.length < 2; // a single point has no line: show it as a dot

  return (
    <div className="chart" role="figure" aria-label={label}>
      {legend.length > 1 && <ChartLegend items={legend} hidden={hidden} onToggle={(k) => toggle(k, keys)} />}
      <ComposedChart data={rows} responsive style={{ width: '100%', height }} margin={margin}>
        <CartesianGrid {...grid} />
        <XAxis {...xAxis} />
        <YAxis {...yAxis} yAxisId="left" tickFormatter={axisFmt ?? fmt} />
        {hasRight && <YAxis {...yAxis} yAxisId="right" orientation="right" tickFormatter={rightAxisFmt} />}
        <Tooltip
          {...tooltipBase}
          cursor={lineCursor}
          content={(p) => <ChartTooltip active={p.active} payload={p.payload} compareLabel={showTwins ? compareLabel : ''} lines={shown.map((s) => ({ key: s.key, label: s.label, color: seriesColor(s, series.indexOf(s)), fmt: fmtOf(s) }))} />}
        />
        {showTwins &&
          withTwin
            .filter((s) => !hidden.has(s.key))
            .map((s) => <Line key={`${s.key}:c`} yAxisId={s.axis ?? 'left'} dataKey={compareKey(s.key)} name={`${s.label}, ${compareLabel}`} stroke={COMPARE_COLOR} strokeWidth={1.5} strokeDasharray="4 4" dot={false} activeDot={false} isAnimationActive={false} />)}
        {shown.map((s) => {
          const color = seriesColor(s, series.indexOf(s));
          const common = { yAxisId: s.axis ?? 'left', dataKey: s.key, name: s.label, stroke: color, strokeWidth: 2, dot: one ? { r: 4, fill: color, strokeWidth: 0 } : false, activeDot: { r: 4, stroke: 'var(--surface)', strokeWidth: 2, fill: color }, isAnimationActive: false };
          return area ? <Area key={s.key} type="monotone" {...common} fill={color} fillOpacity={0.1} /> : <Line key={s.key} type="monotone" {...common} />;
        })}
      </ComposedChart>
    </div>
  );
}
