import { Bar, BarChart, CartesianGrid, Cell, ReferenceLine, Tooltip, XAxis, YAxis } from 'recharts';
import { useElementWidth } from '../../lib/hooks';
import { barCursor, grid, margin, tooltipBase, xAxis, yAxis } from './axes';
import type { ChartTable } from './ChartFrame';
import { chartColor, NEGATIVE_COLOR, POSITIVE_COLOR, type Fmt } from './model';

// How a starting amount becomes a result, step by step (item sales → minus fees … → net earnings → profit), from
// a report's `waterfall` breakdown (docs/09 §3.3). Start and total bars stand on zero in --chart-1; plus steps
// float up in --chart-positive, minus steps down in --chart-negative. On narrow cards (phones) or with many steps
// the steps run down the page as horizontal bars so every label fits.

/** A row of a `waterfall` breakdown. `amount` is Money (minor units) or a plain number. */
export interface WaterfallStepInput {
  key: string;
  label: string;
  amount: { amount: number } | number;
  step: 'start' | 'minus' | 'plus' | 'total';
}

export interface WaterfallBar {
  key: string;
  label: string;
  step: WaterfallStepInput['step'];
  /** Signed change for plus/minus, the level for start/total. */
  value: number;
  /** Level after this step. */
  running: number;
  /** [low, high] of the drawn bar. */
  range: [number, number];
  x: string;
}

/** Steps → bars. Plus and minus use the step's direction whatever the amount's sign. */
export function toWaterfall(steps: WaterfallStepInput[]): WaterfallBar[] {
  let level = 0;
  return steps.map((s) => {
    const a = typeof s.amount === 'number' ? s.amount : s.amount.amount;
    if (s.step === 'start' || s.step === 'total') {
      level = a;
      return { key: s.key, label: s.label, step: s.step, value: a, running: a, range: [Math.min(0, a), Math.max(0, a)], x: s.key };
    }
    const change = s.step === 'minus' ? -Math.abs(a) : Math.abs(a);
    const before = level;
    level += change;
    return { key: s.key, label: s.label, step: s.step, value: change, running: level, range: [Math.min(before, level), Math.max(before, level)], x: s.key };
  });
}

const colorOf = (b: WaterfallBar) => (b.step === 'minus' ? NEGATIVE_COLOR : b.step === 'plus' ? POSITIVE_COLOR : chartColor(0));
const signed = (fmt: Fmt, b: WaterfallBar) => (b.step === 'minus' ? `−${fmt(Math.abs(b.value))}` : b.step === 'plus' ? `+${fmt(b.value)}` : fmt(b.value));
const cut = (s: string) => (s.length > 18 ? `${s.slice(0, 17)}…` : s);

/** The steps as a table for ChartFrame: step, change or level, running total. */
export function waterfallTable(steps: WaterfallStepInput[], fmt: Fmt): ChartTable {
  return {
    columns: [{ key: 'label', label: 'Step' }, { key: 'amount', label: 'Amount' }, { key: 'running', label: 'Running total' }],
    rows: toWaterfall(steps).map((b) => ({ label: b.label, amount: signed(fmt, b), running: fmt(b.running) })),
  };
}

export function WaterfallChart({ steps, fmt, axisFmt, height, label }: { steps: WaterfallStepInput[]; fmt: Fmt; axisFmt?: Fmt; height?: number; label: string }) {
  const [box, width] = useElementWidth<HTMLDivElement>();
  const bars = toWaterfall(steps);
  // upright columns only when every step label gets about 80 px; otherwise (phones, long waterfalls) rows
  const across = width > 0 && width < bars.length * 80;
  const h = height ?? (across ? Math.max(160, bars.length * 32 + 32) : 260);
  const tip = ({ active, payload }: { active?: boolean; payload?: ReadonlyArray<{ payload?: unknown }> }) => {
    const b = payload?.[0]?.payload as WaterfallBar | undefined;
    if (!active || !b) return null;
    return (
      <div className="chart-tip">
        <div className="chart-tip-h">{b.label}</div>
        <div className="chart-tip-row">
          <i className="chart-key is-rect" style={{ ['--key' as string]: colorOf(b) }} aria-hidden="true" />
          <b>{signed(fmt, b)}</b>
        </div>
        {(b.step === 'plus' || b.step === 'minus') && <div className="chart-tip-row is-compare">Running total {fmt(b.running)}</div>}
      </div>
    );
  };

  return (
    <div className="chart" role="figure" aria-label={label} ref={box}>
      <BarChart data={bars} layout={across ? 'vertical' : 'horizontal'} responsive style={{ width: '100%', height: h }} margin={margin} barCategoryGap="20%">
        <CartesianGrid {...grid} vertical={across} horizontal={!across} />
        {across ? (
          <>
            <XAxis {...yAxis} type="number" width={undefined} tickFormatter={axisFmt ?? fmt} />
            <YAxis {...xAxis} type="category" width="auto" interval={0} tickFormatter={cut} />
          </>
        ) : (
          <>
            <XAxis {...xAxis} interval={0} tickFormatter={cut} />
            <YAxis {...yAxis} tickFormatter={axisFmt ?? fmt} />
          </>
        )}
        {across ? <ReferenceLine x={0} stroke="var(--border-strong)" /> : <ReferenceLine y={0} stroke="var(--border-strong)" />}
        <Tooltip {...tooltipBase} cursor={barCursor} content={tip} />
        <Bar dataKey="range" maxBarSize={across ? 20 : 40} radius={2} isAnimationActive={false}>
          {bars.map((b) => (
            <Cell key={b.key} fill={colorOf(b)} />
          ))}
        </Bar>
      </BarChart>
      <p className="chart-steps-key xs muted">
        <span>
          <i className="chart-key is-rect" style={{ ['--key' as string]: chartColor(0) }} aria-hidden="true" /> Start and totals
        </span>
        <span>
          <i className="chart-key is-rect" style={{ ['--key' as string]: POSITIVE_COLOR }} aria-hidden="true" /> Adds
        </span>
        <span>
          <i className="chart-key is-rect" style={{ ['--key' as string]: NEGATIVE_COLOR }} aria-hidden="true" /> Takes away
        </span>
      </p>
    </div>
  );
}
