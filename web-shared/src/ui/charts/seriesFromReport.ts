import { shortDate } from '../../lib/dates';
import { compareKey, type ChartRow, type ChartSeries } from './model';

// Turns the `series` of a report result (POST …/reports/{key}/query) into chart rows. With `compare` set, the
// backend sends a twin per series, `<key>:compare`, whose points use the current period's x values (docs/09 §3.3);
// the twin's value goes on the same row under the same `<key>:compare` name, so the charts draw it on one axis.

interface ReportPoint {
  x: string;
  y: number;
  label?: string | null;
}

/** The parts of reports.ReportResult this helper reads (its OpenAPI type has `points: unknown[]`). */
export interface ReportLike {
  series: Array<{ key: string; label: string; points: unknown[] }>;
  meta?: unknown;
}

export interface ReportSeriesPick {
  key: string;
  /** Overrides the report's label. */
  label?: string;
  color?: string;
  axis?: 'left' | 'right';
}

export interface ReportChartData {
  rows: ChartRow[];
  series: ChartSeries[];
  /** "Previous period, Sep 1 – Sep 30" style label for the twins, from meta.compareRange; '' without comparison. */
  compareLabel: string;
}

/**
 * Rows and series for the given keys, in that order (missing keys are left out). Each row has x, label, every
 * picked series and, when the result has twins, `<key>:compare`.
 */
export function seriesFromReport(result: ReportLike | null | undefined, keys: Array<string | ReportSeriesPick>): ReportChartData {
  const picks = keys.map((k) => (typeof k === 'string' ? { key: k } : k));
  const all = result?.series ?? [];
  const byKey = new Map(all.map((s) => [s.key, s]));
  const rows = new Map<string, ChartRow>();
  const series: ChartSeries[] = [];
  let anyTwin = false;

  const put = (key: string, points: unknown[]) => {
    for (const p of points as ReportPoint[]) {
      const row = rows.get(p.x) ?? { x: p.x, label: p.label || shortDate(p.x) };
      row[key] = p.y;
      rows.set(p.x, row);
    }
  };

  for (const pick of picks) {
    const s = byKey.get(pick.key);
    if (!s) continue;
    series.push({ key: s.key, label: pick.label ?? s.label, color: pick.color, axis: pick.axis });
    put(s.key, s.points);
    const twin = byKey.get(compareKey(s.key));
    if (twin) {
      anyTwin = true;
      put(compareKey(s.key), twin.points);
    }
  }

  const meta = (result?.meta ?? {}) as { compareRange?: { from: string; to: string } | null };
  const cr = meta.compareRange;
  return {
    // the backend sends every series over the same buckets in order, so the first series sets the order
    rows: [...rows.values()],
    series,
    compareLabel: anyTwin ? (cr ? `${shortDate(cr.from)} – ${shortDate(cr.to)}` : 'Comparison period') : '',
  };
}

/** Rows from parallel arrays (charts fed by non-report endpoints): labels[i] with one value per series. */
export function rowsFrom(labels: string[], data: Record<string, Array<number | null | undefined>>, xs?: string[]): ChartRow[] {
  return labels.map((label, i) => {
    const row: ChartRow = { x: xs?.[i] ?? String(i), label };
    for (const [key, values] of Object.entries(data)) row[key] = values[i] ?? null;
    return row;
  });
}
