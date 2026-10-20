import { useId, useState, type ElementType, type ReactNode } from 'react';
import { cx } from '../../lib/cx';
import { Button } from '../Button';
import { TableWrap } from '../Structure';
import { compareKey, hasCompare, type ChartRow, type ChartSeries, type Fmt } from './model';

// The card around a chart: title, optional subtitle and actions, a "Show as table" toggle that swaps the drawing
// for an accessible table of the same numbers (so no value is only in a tooltip), and the loading and empty states.
// While `refreshing`, the previous drawing stays at reduced opacity (no skeleton flash, no layout jump).

export interface ChartTableColumn {
  key: string;
  label: string;
  /** Formats numbers; text cells are shown as they are. */
  fmt?: Fmt;
}

export interface ChartTable {
  columns: ChartTableColumn[];
  rows: Array<Record<string, unknown>>;
  /** Optional last row, e.g. totals. */
  foot?: Record<string, unknown>;
}

export interface ChartFrameProps {
  title: ReactNode;
  sub?: ReactNode;
  titleAs?: ElementType;
  /** Buttons or links next to the table toggle. */
  actions?: ReactNode;
  /** The same numbers as a table; the toggle is shown when set. */
  table?: ChartTable;
  /** Name of the table for screen readers (default: the title when it is text). */
  tableLabel?: string;
  /** First load: a placeholder of the chart's height. */
  loading?: boolean;
  /** Refetching: keep the drawing, dimmed. */
  refreshing?: boolean;
  /** Nothing to draw: true shows "No figures for this period.", a node shows that node. */
  empty?: boolean | ReactNode;
  /** Height of the loading placeholder (match the chart's). */
  height?: number;
  className?: string;
  children: ReactNode;
}

export function ChartFrame({ title, sub, titleAs: H = 'h3', actions, table, tableLabel, loading, refreshing, empty, height = 240, className, children }: ChartFrameProps) {
  const [asTable, setAsTable] = useState(false);
  const id = useId();
  const name = tableLabel ?? (typeof title === 'string' ? title : 'Chart data');
  const showToggle = !!table && !loading && !empty;
  return (
    <section className={cx('card chart-frame', className)} aria-labelledby={`${id}-t`}>
      <div className="card-head">
        <div className="stack gap-0">
          <H className="h4" id={`${id}-t`}>
            {title}
          </H>
          {sub && <span className="xs muted">{sub}</span>}
        </div>
        {(actions || showToggle) && (
          <div className="row gap-2 chart-frame-actions">
            {actions}
            {showToggle && (
              <Button variant="ghost" size="sm" icon={asTable ? 'chart-line' : 'table'} onClick={() => setAsTable(!asTable)}>
                {asTable ? 'Show as chart' : 'Show as table'}
              </Button>
            )}
          </div>
        )}
      </div>
      <div className={cx('card-body chart-frame-body', refreshing && 'is-refreshing')} aria-busy={loading || refreshing || undefined}>
        {loading ? (
          <div className="sk" style={{ height }} aria-hidden="true" />
        ) : empty ? (
          <p className="small muted chart-empty">{empty === true ? 'No figures for this period.' : empty}</p>
        ) : asTable && table ? (
          <DataTableView table={table} label={name} />
        ) : (
          children
        )}
      </div>
    </section>
  );
}

function cell(v: unknown, fmt?: Fmt): string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'number') return fmt ? fmt(v) : v.toLocaleString('en-US');
  return String(v);
}

/** The accessible table view: first column is the row header. */
export function DataTableView({ table, label }: { table: ChartTable; label: string }) {
  const [first, ...rest] = table.columns;
  if (!first) return null;
  return (
    <TableWrap label={label} className="chart-table">
      <table className="table">
        <thead>
          <tr>
            {table.columns.map((c, i) => (
              <th key={c.key} scope="col" className={i ? 'r' : undefined}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((r, i) => (
            <tr key={i}>
              <th scope="row">{cell(r[first.key], first.fmt)}</th>
              {rest.map((c) => (
                <td key={c.key} className="r num">
                  {cell(r[c.key], c.fmt)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {table.foot && (
          <tfoot>
            <tr>
              <th scope="row">{cell(table.foot[first.key], first.fmt)}</th>
              {rest.map((c) => (
                <td key={c.key} className="r num strong">
                  {cell(table.foot?.[c.key], c.fmt)}
                </td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
    </TableWrap>
  );
}

/**
 * Table of chart rows: the x label, then each series (and its comparison column when the rows have one).
 * Series on the right-hand axis use `rightFmt` (e.g. a margin percentage next to money).
 */
export function seriesTable(rows: ChartRow[], series: ChartSeries[], fmt: Fmt, opts: { xLabel?: string; compareLabel?: string; rightFmt?: Fmt } = {}): ChartTable {
  const fmtOf = (s: ChartSeries) => (s.axis === 'right' && opts.rightFmt ? opts.rightFmt : fmt);
  const columns: ChartTableColumn[] = [{ key: 'label', label: opts.xLabel ?? 'Period' }];
  for (const s of series) {
    columns.push({ key: s.key, label: s.label, fmt: fmtOf(s) });
    if (opts.compareLabel && hasCompare(rows, s.key)) columns.push({ key: compareKey(s.key), label: `${s.label}, ${opts.compareLabel}`, fmt: fmtOf(s) });
  }
  return { columns, rows };
}
