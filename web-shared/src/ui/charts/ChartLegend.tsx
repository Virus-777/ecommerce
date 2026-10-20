import { useState } from 'react';
import { cx } from '../../lib/cx';

// Legend under a chart title. Each entry is a toggle button: pressing it hides or shows that series (keyboard and
// touch friendly, aria-pressed = shown). The swatch mirrors the mark: a line for lines, a dashed line for the
// comparison, a square for bars and slices. Text stays in text colours; only the swatch carries the series colour.

export interface LegendItem {
  key: string;
  label: string;
  color: string;
  shape?: 'line' | 'dash' | 'rect';
  /** Extra text after the label, e.g. a slice's value and share. */
  note?: string;
}

export function ChartLegend({ items, hidden, onToggle, label = 'Series' }: { items: LegendItem[]; hidden?: ReadonlySet<string>; onToggle?: (key: string) => void; label?: string }) {
  if (items.length === 0) return null;
  return (
    <div className="chart-legend" role="group" aria-label={`${label}${onToggle ? ': press to hide or show' : ''}`}>
      {items.map((it) => {
        const off = hidden?.has(it.key) ?? false;
        const body = (
          <>
            <i className={cx('chart-key', `is-${it.shape ?? 'line'}`)} style={{ ['--key' as string]: it.color }} aria-hidden="true" />
            <span>{it.label}</span>
            {it.note && <span className="chart-legend-note">{it.note}</span>}
          </>
        );
        return onToggle ? (
          <button key={it.key} type="button" className={cx('chart-legend-item', off && 'is-off')} aria-pressed={!off} onClick={() => onToggle(it.key)}>
            {body}
          </button>
        ) : (
          <span key={it.key} className="chart-legend-item">
            {body}
          </span>
        );
      })}
    </div>
  );
}

/** Hidden series keys and a toggle that never hides the last visible one (an empty plot helps nobody). */
export function useHiddenSeries(): [ReadonlySet<string>, (key: string, allKeys: string[]) => void] {
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const toggle = (key: string, allKeys: string[]) =>
    setHidden((h) => {
      const next = new Set(h);
      if (next.has(key)) next.delete(key);
      else if (allKeys.filter((k) => !next.has(k)).length > 1) next.add(key);
      return next;
    });
  return [hidden, toggle];
}
