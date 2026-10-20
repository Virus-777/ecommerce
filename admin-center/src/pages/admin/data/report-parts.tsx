// Parts shared by the screens that show a report result (POST /api/admin/reports/reports/{key}/query): the
// report detail (admin/report) and Financial statistics (admin/finance-statistics). The KPI row with its deltas,
// the callouts and "not available" note, the "Data updated" line, the period table and the export dialog.
import { useState, type ReactNode } from 'react';
import { Alert, Button, Card, Dialog, Icon, OptionCard, Stat, TableWrap } from '@marketly/web-shared/ui';
import { dateTime, SkeletonLines, time } from '@/app/parts';
import { ago, calloutsOf, deltaOf, fmtCell, type ReportResult, type TableSpec } from './reports';
import '../Report.css';

/**
 * The KPI tiles of a result, in the order of `keys` when given (keys the result lacks are skipped; without keys
 * every KPI is shown). A delta shows only with a comparison, with "vs <comparison dates>" under it.
 */
export function ReportKpis({ res, keys, compared, cmpText, skeletons = 4, error }: { res?: ReportResult; keys?: string[]; compared: boolean; cmpText?: string; skeletons?: number; error?: boolean }) {
  if (!res)
    return error ? null : (
      <div className="ac-kpis">
        {Array.from({ length: skeletons }, (_, i) => (
          <div className="panel rpd-kpi" key={i}>
            <SkeletonLines rows={1} />
          </div>
        ))}
      </div>
    );
  const kpis = keys ? keys.map((k) => res.kpis.find((x) => x.metricKey === k)).filter((k) => !!k) : res.kpis;
  return (
    <div className="ac-kpis">
      {kpis.map((k) => {
        const dl = deltaOf(k);
        return (
          <div className="panel rpd-kpi" key={k.metricKey}>
            <Stat
              label={k.label}
              value={k.display}
              {...(dl && dl.direction !== 'flat' && compared
                ? { delta: `${Math.abs(dl.value).toFixed(1)}${dl.unit === 'pct' ? '%' : ' pts'}`, dir: dl.direction, good: dl.good, note: cmpText ? `vs ${cmpText}` : undefined }
                : { note: k.note ?? undefined })}
            />
          </div>
        );
      })}
    </div>
  );
}

/** The report's callouts (date basis, what a figure excludes) and the figures a switched-off module can't supply. */
export function ReportNotices({ res }: { res?: ReportResult }) {
  if (!res) return null;
  return (
    <>
      {calloutsOf(res).map((c) => (
        <Alert key={c.title} tone={c.kind === 'warning' ? 'warning' : 'info'} title={c.title}>
          {c.body}
        </Alert>
      ))}
      {res.unavailable.length > 0 && (
        <Alert tone="warning" title="Some figures aren’t available">
          {res.unavailable.join(', ')} can’t be shown right now because the module that supplies them is off.
        </Alert>
      )}
    </>
  );
}

/** "Data updated 5 min ago · 2:05 PM PT" from meta.freshAsOf; `short` gives "Updated 2:05 PM". */
export function Freshness({ at, short }: { at?: string | null; short?: boolean }) {
  if (!at) return null;
  return (
    <span className="rpd-fresh" title={`${dateTime(at)} PT`}>
      <Icon name="refresh-cw" />
      {short ? (
        <span>Updated {time(at)}</span>
      ) : (
        <span>
          Data updated {ago(at)} <span className="muted">· {dateTime(at)} PT</span>
        </span>
      )}
    </span>
  );
}

/** The result's table (one row per period, product or seller) with a totals row. */
export function ReportTableCard({ table, title, sub, label, actions }: { table: TableSpec; title: string; sub?: string; label: string; actions?: ReactNode }) {
  return (
    <Card title={title} sub={sub} flush actions={actions}>
      <TableWrap label={label}>
        <table className="table">
          <thead>
            <tr>
              {table.columns.map((c) => (
                <th key={c.key} className={c.align === 'right' ? 'r' : undefined} scope="col">
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, i) => (
              <tr key={String(row.period ?? row.productId ?? row.campaignId ?? row.sellerId ?? i)}>
                {table.columns.map((c) => (
                  <td key={c.key} className={c.align === 'right' ? 'r nowrap' : 'nowrap'}>
                    {c.key === 'period' ? String(row.label ?? row.period) : fmtCell(row[c.key], c.unit)}
                  </td>
                ))}
              </tr>
            ))}
            {table.rows.length === 0 && (
              <tr>
                <td colSpan={table.columns.length} className="muted">
                  No records in this period.
                </td>
              </tr>
            )}
            {table.totals && (
              <tr className="ac-total">
                {table.columns.map((c, i) => (
                  <td key={c.key} className={c.align === 'right' ? 'r nowrap' : undefined}>
                    {i === 0 ? 'Total' : table.totals![c.key] !== undefined ? fmtCell(table.totals![c.key], c.unit) : ''}
                  </td>
                ))}
              </tr>
            )}
          </tbody>
        </table>
      </TableWrap>
    </Card>
  );
}

export type ExportFormat = 'csv' | 'xlsx';

/** Format choice before a report export starts (the export itself runs through useReportExport). */
export function ReportExportDialog({ open, onClose, title, scope, busy, onStart }: { open: boolean; onClose: () => void; title: string; scope: string; busy: boolean; onStart: (format: ExportFormat) => void }) {
  const [format, setFormat] = useState<ExportFormat>('csv');
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Export ${title}`}
      size="lg"
      foot={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button icon="download" onClick={() => onStart(format)} disabled={busy}>
            Start export
          </Button>
        </>
      }
    >
      <p className="small sub">{scope}</p>
      <fieldset className="stack gap-2 fieldset-reset">
        <legend className="label">Format</legend>
        <OptionCard id="rx-plain" name="rx-format" title={<span className="small strong">CSV</span>} body="UTF-8 text, for Excel, Google Sheets, scripts and databases" checked={format === 'csv'} onChange={() => setFormat('csv')} />
        <OptionCard id="rx-excel" name="rx-format" title={<span className="small strong">Excel workbook (.xlsx)</span>} body="Opens in Excel with columns already typed" checked={format === 'xlsx'} onChange={() => setFormat('xlsx')} />
      </fieldset>
      <div className="panel rpd-delivery">
        <Icon name="hourglass" />
        <span>
          <b>Runs in the background.</b> The file downloads when it is ready, usually within a minute, and stays under the report’s Exports until the link expires. Columns your role may not see are left out.
        </span>
      </div>
      <p className="xs muted">Exports of seller data are recorded in Action history with your name, the period and the filters.</p>
    </Dialog>
  );
}
