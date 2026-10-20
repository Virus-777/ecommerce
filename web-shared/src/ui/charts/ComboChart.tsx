import { Bar, CartesianGrid, ComposedChart, Line, ReferenceLine, Tooltip, XAxis, YAxis } from 'recharts';
import { barCursor, grid, margin, tooltipBase, xAxis, yAxis } from './axes';
import { ChartLegend, useHiddenSeries, type LegendItem } from './ChartLegend';
import { ChartTooltip } from './ChartTooltip';
import { fmtPercent, fmtPercentCompact, seriesColor, valueOf, type ChartRow, type ChartSeries, type Fmt } from './model';

// Bars plus one line on a second (right) axis, e.g. product cost and profit bars with the margin % line.
// The line takes the colour slot after the bars so it never shares a colour with one of them.

export interface ComboChartProps {
  rows: ChartRow[];
  /** Bar series on the left axis (money or counts). */
  bars: ChartSeries[];
  /** The line on the right axis (a percentage by default). */
  line: ChartSeries;
  fmt: Fmt;
  axisFmt?: Fmt;
  /** Line value format (default 12.5%) and right-axis ticks (default 13%). */
  lineFmt?: Fmt;
  lineAxisFmt?: Fmt;
  stacked?: boolean;
  height?: number;
  label: string;
}

export function ComboChart({ rows, bars, line, fmt, axisFmt, lineFmt = fmtPercent, lineAxisFmt = fmtPercentCompact, stacked, height = 260, label }: ComboChartProps) {
  const [hidden, toggle] = useHiddenSeries();
  const all = [...bars, line];
  const colorOf = (s: ChartSeries) => seriesColor(s, all.indexOf(s));
  const legend: LegendItem[] = all.map((s) => ({ key: s.key, label: s.label, color: colorOf(s), shape: s === line ? 'line' : 'rect' }));
  const keys = legend.map((l) => l.key);
  const shownBars = bars.filter((s) => !hidden.has(s.key));
  const showLine = !hidden.has(line.key);
  const negative = rows.some((r) => bars.some((s) => (valueOf(r, s.key) ?? 0) < 0));
  const radius: [number, number, number, number] | number = negative || stacked ? 0 : [4, 4, 0, 0];

  return (
    <div className="chart" role="figure" aria-label={label}>
      <ChartLegend items={legend} hidden={hidden} onToggle={(k) => toggle(k, keys)} />
      <ComposedChart data={rows} responsive style={{ width: '100%', height }} margin={margin} barCategoryGap="20%" barGap={2}>
        <CartesianGrid {...grid} />
        <XAxis {...xAxis} />
        <YAxis {...yAxis} yAxisId="left" tickFormatter={axisFmt ?? fmt} />
        <YAxis {...yAxis} yAxisId="right" orientation="right" tickFormatter={lineAxisFmt} hide={!showLine} />
        {negative && <ReferenceLine yAxisId="left" y={0} stroke="var(--border-strong)" />}
        <Tooltip
          {...tooltipBase}
          cursor={barCursor}
          content={(p) => (
            <ChartTooltip
              active={p.active}
              payload={p.payload}
              lines={[...shownBars.map((s) => ({ key: s.key, label: s.label, color: colorOf(s), fmt, shape: 'rect' as const })), ...(showLine ? [{ key: line.key, label: line.label, color: colorOf(line), fmt: lineFmt }] : [])]}
            />
          )}
        />
        {shownBars.map((s) => (
          <Bar key={s.key} yAxisId="left" dataKey={s.key} name={s.label} fill={colorOf(s)} stackId={stacked ? 'stack' : undefined} maxBarSize={24} radius={radius} stroke={stacked ? 'var(--surface)' : undefined} strokeWidth={stacked ? 2 : 0} isAnimationActive={false} />
        ))}
        {showLine && (
          <Line yAxisId="right" type="monotone" dataKey={line.key} name={line.label} stroke={colorOf(line)} strokeWidth={2} dot={{ r: 3, fill: colorOf(line), stroke: 'var(--surface)', strokeWidth: 2 }} activeDot={{ r: 4, stroke: 'var(--surface)', strokeWidth: 2 }} isAnimationActive={false} />
        )}
      </ComposedChart>
    </div>
  );
}
