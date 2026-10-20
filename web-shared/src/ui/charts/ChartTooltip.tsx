import type { ReactNode } from 'react';
import { changeText, compareKey, valueOf, type ChartRow, type Fmt } from './model';

// The one tooltip every chart uses. It reads the hovered row (not Recharts' payload) so it always lists every
// visible series at that x, with the comparison value and the change when the row has one. Values lead, labels
// follow; each line is keyed by a short stroke of the series colour. Recharts moves it with the pointer, touch
// and the arrow keys (accessibilityLayer).

export interface TooltipLine {
  key: string;
  label: string;
  color: string;
  fmt: Fmt;
  /** Bars and slices get a square key, lines a stroke. */
  shape?: 'line' | 'rect';
}

interface Props {
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: unknown }>;
  lines: TooltipLine[];
  /** Label of the comparison period ('' = none). */
  compareLabel?: string;
  /** Shown above the lines; default: the row's label. */
  title?: (row: ChartRow) => ReactNode;
}

export function ChartTooltip({ active, payload, lines, compareLabel, title }: Props) {
  const row = payload?.[0]?.payload as ChartRow | undefined;
  if (!active || !row) return null;
  return (
    <div className="chart-tip">
      <div className="chart-tip-h">{title ? title(row) : row.label}</div>
      {lines.map((l) => {
        const v = valueOf(row, l.key);
        const before = compareLabel ? valueOf(row, compareKey(l.key)) : null;
        const change = changeText(v, before);
        return (
          <div key={l.key} className="chart-tip-item">
            <div className="chart-tip-row">
              <i className={`chart-key is-${l.shape ?? 'line'}`} style={{ ['--key' as string]: l.color }} aria-hidden="true" />
              <b>{v === null ? '—' : l.fmt(v)}</b>
              <span>{l.label}</span>
            </div>
            {before !== null && (
              <div className="chart-tip-row is-compare">
                <i className="chart-key is-dash" style={{ ['--key' as string]: 'var(--chart-compare)' }} aria-hidden="true" />
                <span>
                  {compareLabel}: {l.fmt(before)}
                  {change && <> · {change}</>}
                </span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
