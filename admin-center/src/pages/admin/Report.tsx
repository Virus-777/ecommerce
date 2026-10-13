import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { STAFF } from '@marketly/web-shared/data/staff';
import { AdminLayout } from '@marketly/web-shared/layouts';
import { useElementWidth, useView } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import {
  Alert, BarChart, Button, Card, Checkbox, Dialog, Drawer, EmptyState, Field, Icon, IconButton, KeyValue, Legend, LineChart, OptionCard, PageHeader, SegmentedControl, Select, Stat, StatusBadge, TableWrap, announce,
} from '@marketly/web-shared/ui';
import {
  aggregate, bucketsOf, compareRange, csvNumber, findReport, fmtValue, isoDay, OFFICIAL, PRESETS, rangeLabel, SELLERS, unitName, unitsOf,
  type Compare, type Fmt, type Metric, type ReportDef,
} from './data/reports';
import './Report.css';

// Report detail (admin/report): designed in React after the design export, following
// reports/Best ecommerce site UX patterns.md, "Report detail and export flows".
// Views: '' report · 'export' = export dialog · 'definitions' = metric definitions drawer.
// Default period is last month (dates inclusive), Pacific Time. KPIs, chart, table and exports all
// come from the same generated rows, so exported numbers match the screen.
//
// Rules applied here (blueprint "Create and edit forms"): the export button is never disabled
// (errors show on submit); a toast appears only for a background export, which also leaves a
// lasting record in the Exports list and in Action history. Instant downloads and errors stay inline.

type View = 'export' | 'definitions';
type ExportScope = 'view' | 'all';
type ExportFormat = 'excel' | 'plain';

/** Up to this many rows download straight away; bigger exports run in the background. */
const INSTANT_ROWS = 250;
const ME = STAFF.admin.name;

interface ExportOpts {
  scope: ExportScope;
  columns: string[];
  format: ExportFormat;
  defs: boolean;
  range: [number, number];
  seller: string;
}

interface ExportRow {
  id: string;
  file: string;
  detail: string;
  rows: number;
  requested: string;
  status: 'Queued' | 'Ready' | 'Expired';
  expires?: string;
  opts?: ExportOpts;
}

const days = ([a, b]: [number, number]) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

function chartFmt(f: Fmt) {
  return (v: number) =>
    f === 'percent' ? `${Math.round(v)}%` : f === 'hours' ? `${Math.round(v)} h` : f === 'money' ? (v >= 1000 ? `$${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k` : `$${Math.round(v)}`) : v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k` : String(Math.round(v));
}

function scopeUnits(r: ReportDef, seller: string) {
  return seller === 'all' ? unitsOf(r) : [seller];
}

function scopeOptions(r: ReportDef) {
  if (r.scopes === 'official') return [{ value: OFFICIAL.id, label: OFFICIAL.name }];
  return [{ value: 'all', label: 'All sellers' }, ...(r.scopes === 'all' ? [{ value: OFFICIAL.id, label: OFFICIAL.name }] : []), ...SELLERS.map((s) => ({ value: s.id, label: s.name }))];
}

const scopeLabel = (r: ReportDef, seller: string) => (seller === 'all' ? (r.scopes === 'all' ? 'All sellers and the Official Store' : 'All marketplace sellers') : unitName(seller));

const rowCount = (r: ReportDef, o: Pick<ExportOpts, 'scope' | 'range' | 'seller'>) => (o.scope === 'view' ? bucketsOf(o.range).list.length + 1 : days(o.range).length * scopeUnits(r, o.seller).length);

const fileName = (r: ReportDef, o: ExportOpts) => `${r.key}-${isoDay(o.range[0])}-to-${isoDay(o.range[1])}${o.scope === 'all' ? '-all-rows' : ''}.csv`;

function buildCsv(r: ReportDef, o: ExportOpts): string {
  const cols = r.metrics.filter((m) => o.columns.includes(m.key));
  const cell = (c: string | number) => `"${String(c).replace(/"/g, '""')}"`;
  const lines: Array<Array<string | number>> = [];
  if (o.defs) {
    lines.push([`# Report: ${r.name}`], [`# Period: ${isoDay(o.range[0])} to ${isoDay(o.range[1])}, dates inclusive, Pacific Time (PT)`], [`# Sellers: ${scopeLabel(r, o.seller)}`], [`# Definitions: ${r.definitionsVersion}, owner ${r.owner}`]);
    for (const m of cols) lines.push([`# ${m.label}: ${m.def?.meaning ?? ''} Formula: ${m.def?.formula ?? ''}`]);
    lines.push([]);
  }
  const units = scopeUnits(r, o.seller);
  if (o.scope === 'view') {
    const b = bucketsOf(o.range);
    lines.push([b.unit, ...cols.map((m) => m.label)]);
    for (const x of b.list) {
      const a = aggregate(r, units, x.days);
      lines.push([x.full, ...cols.map((m) => csvNumber(a[m.key], m.fmt))]);
    }
    const t = aggregate(r, units, days(o.range));
    lines.push(['Total', ...cols.map((m) => csvNumber(t[m.key], m.fmt))]);
  } else {
    lines.push(['Date', 'Seller', ...cols.map((m) => m.label)]);
    for (const d of days(o.range))
      for (const u of units) {
        const a = aggregate(r, [u], [d]);
        lines.push([isoDay(d), unitName(u), ...cols.map((m) => csvNumber(a[m.key], m.fmt))]);
      }
  }
  const eol = o.format === 'excel' ? '\r\n' : '\n';
  const body = lines.map((l) => l.map(cell).join(',')).join(eol);
  return (o.format === 'excel' ? '﻿' : '') + body + eol;
}

function download(name: string, csv: string) {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function delta(m: Metric, cur: number, cmp: number | undefined) {
  if (cmp === undefined) return null;
  const d = cur - cmp;
  const text = m.fmt === 'percent' ? `${Math.abs(d).toFixed(1)} pts` : `${cmp ? Math.abs((d / cmp) * 100).toFixed(1) : '0.0'}%`;
  return { text, dir: (d >= 0 ? 'up' : 'down') as 'up' | 'down', good: Math.abs(d) < 1e-9 ? undefined : (d >= 0) === m.up };
}

function NotFound({ k }: { k: string }) {
  return (
    <AdminLayout active="reports">
      <PageHeader crumbs={[{ label: 'Reports and settings' }, { label: 'Reports', to: href('admin/reports') }, { label: k }]} title="Report not found" />
      <Card pad>
        <EmptyState
          icon="file-x"
          title="This report is not in the library"
          as="h2"
          action={
            <Button to={href('admin/reports')} icon="chart-column">
              Go to the report library
            </Button>
          }
        >
          The link may be old or the report was renamed. All 23 launch reports are listed in the library.
        </EmptyState>
      </Card>
    </AdminLayout>
  );
}

export default function Report() {
  const { key = '' } = useParams();
  const r = findReport(key);
  if (!r) return <NotFound k={key} />;
  return <ReportPage key={r.key} r={r} />;
}

function ReportPage({ r }: { r: ReportDef }) {
  const [view, setView] = useView<View>();
  // Draw the chart at the card's real width so its text keeps the design's size in a full-width card.
  const [chartRef, measured] = useElementWidth<HTMLDivElement>();
  const chartWidth = Math.max(640, measured);
  const [preset, setPreset] = useState(PRESETS[0].value);
  const [compare, setCompare] = useState<Compare>('previous');
  const [seller, setSeller] = useState(r.scopes === 'official' ? OFFICIAL.id : 'all');
  const [chartKey, setChartKey] = useState(r.chartMetrics[0]);
  const [notice, setNotice] = useState<{ tone: 'success' | 'info'; title: string; body?: string } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const timers = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const p = PRESETS.find((x) => x.value === preset) ?? PRESETS[0];
  const cmpRange = compareRange(p, compare);
  const units = scopeUnits(r, seller);
  const total = aggregate(r, units, days(p.range));
  const cmpTotal = cmpRange ? aggregate(r, units, days(cmpRange)) : null;
  const b = bucketsOf(p.range);
  const cb = cmpRange ? bucketsOf(cmpRange) : null;
  const rows = b.list.map((x, i) => ({ bucket: x, v: aggregate(r, units, x.days), c: cb?.list[i] ? aggregate(r, units, cb.list[i].days) : null }));
  const metric = (k: string) => r.metrics.find((m) => m.key === k)!;
  const chartM = metric(chartKey);
  const cmpText = cmpRange ? rangeLabel(cmpRange) : '';
  const sameShape = !!cb && cb.list.length === b.list.length;

  const initialExport = (): ExportRow[] => {
    const q: ExportOpts = { scope: 'all', columns: r.metrics.map((m) => m.key), format: 'excel', defs: true, range: PRESETS[3].range, seller: r.scopes === 'official' ? OFFICIAL.id : 'all' };
    return [
      { id: 'EX-261007-0412', file: fileName(r, q), detail: 'All rows · all columns · CSV for Excel', rows: rowCount(r, q), requested: `Oct 7, 4:12 PM · ${ME}`, status: 'Ready', expires: 'Oct 14', opts: q },
      { id: 'EX-260929-0388', file: `${r.key}-2026-08-01-to-2026-08-31-all-rows.csv`, detail: 'All rows · 4 columns · plain CSV', rows: 279, requested: 'Sep 29, 9:05 AM · Mei Lin', status: 'Expired', expires: 'Oct 6' },
    ];
  };
  const [exports, setExports] = useState<ExportRow[]>(initialExport);

  /* ----- Export dialog ----- */
  const [ex, setEx] = useState<{ scope: ExportScope; columns: string[]; format: ExportFormat; defs: boolean }>({ scope: 'view', columns: r.metrics.map((m) => m.key), format: 'excel', defs: true });
  const [exTried, setExTried] = useState(false);
  const exOpts: ExportOpts = { ...ex, range: p.range, seller };
  const exRows = rowCount(r, exOpts);
  const instant = exRows <= INSTANT_ROWS;
  const colsError = exTried && ex.columns.length === 0 ? 'Choose at least one column.' : undefined;
  const toggleCol = (k: string) => setEx((x) => ({ ...x, columns: x.columns.includes(k) ? x.columns.filter((c) => c !== k) : r.metrics.filter((m) => m.key === k || x.columns.includes(m.key)).map((m) => m.key) }));

  const openExport = () => {
    setExTried(false);
    setView('export');
  };
  const runExport = () => {
    setExTried(true);
    if (ex.columns.length === 0) return;
    const o = exOpts;
    const detail = `${o.scope === 'view' ? 'Current view' : 'All rows'} · ${o.columns.length === r.metrics.length ? 'all columns' : `${o.columns.length} columns`} · ${o.format === 'excel' ? 'CSV for Excel' : 'plain CSV'}`;
    setView('');
    if (instant) {
      download(fileName(r, o), buildCsv(r, o));
      setNotice({ tone: 'success', title: `Downloaded ${fileName(r, o)}`, body: `${exRows.toLocaleString('en-US')} rows, ${scopeLabel(r, seller).toLowerCase()}, ${rangeLabel(p.range)}. The export is recorded in Action history.` });
      announce('Export downloaded');
      return;
    }
    const id = `EX-261008-${String(1047 + exports.length).padStart(4, '0')}`;
    setExports((l) => [{ id, file: fileName(r, o), detail, rows: exRows, requested: `Just now · ${ME}`, status: 'Queued', opts: o }, ...l]);
    setNotice(null);
    setToast(`Export started: ${exRows.toLocaleString('en-US')} rows. It will be ready under Exports, and we will notify you.`);
    announce('Export started in the background');
    timers.current.push(
      setTimeout(() => setToast(null), 8000),
      setTimeout(() => {
        setExports((l) => l.map((e) => (e.id === id ? { ...e, status: 'Ready', expires: 'Oct 15' } : e)));
        announce(`Export ${id} is ready to download`);
      }, 5000),
    );
  };

  const kpis = r.kpis.map(metric);
  const tableCols = r.metrics;

  return (
    <AdminLayout active="reports">
      <PageHeader
        crumbs={[{ label: 'Reports and settings' }, { label: 'Reports', to: href('admin/reports') }, { label: r.name }]}
        eyebrow={`${r.group} · Owner ${r.owner}`}
        title={r.name}
        sub={
          <>
            {r.description} ·{' '}
            <Link to={href('admin/report', 'definitions', { key: r.key })} preventScrollReset>
              Metric definitions
            </Link>
          </>
        }
        actions={
          <>
            <Button variant="secondary" size="sm" icon="book-open" onClick={() => setView('definitions')}>
              Definitions
            </Button>
            <Button size="sm" icon="download" onClick={openExport}>
              Export
            </Button>
          </>
        }
      />

      <section className="card" aria-label="Report filters">
        <div className="card-body">
          <div className="rpd-filters">
            <Field label="Date range" hint={`${rangeLabel(p.range)} · dates inclusive`}>
              <Select id="rp-range" options={PRESETS.map((x) => ({ value: x.value, label: x.label }))} value={preset} onChange={(e) => setPreset(e.target.value)} />
            </Field>
            <Field label="Compare to" hint={cmpRange ? rangeLabel(cmpRange) : 'Deltas hidden'}>
              <Select
                id="rp-compare"
                options={[
                  { value: 'previous', label: 'Previous period' },
                  { value: 'last-year', label: 'Same period last year' },
                  { value: 'none', label: 'No comparison' },
                ]}
                value={compare}
                onChange={(e) => setCompare(e.target.value as Compare)}
              />
            </Field>
            <Field label="Sellers" hint={r.scopes === 'official' ? 'This report covers the Official Store only' : r.scopes === 'sellers' ? 'Marketplace sellers only' : seller === 'all' ? 'Includes the Official Store' : undefined}>
              <Select id="rp-seller" options={scopeOptions(r)} value={seller} onChange={(e) => setSeller(e.target.value)} />
            </Field>
            <Field label="Time zone" hint="Days run 12:00 AM to 11:59 PM PT">
              <Select id="rp-tz" options={['Pacific Time (PT)']} />
            </Field>
          </div>
          <div className="panel xs sub rpd-scopeline">
            <span>
              <Icon name="info" />
              <span>
                Showing <b>{rangeLabel(p.range)}</b> in Pacific Time, {scopeLabel(r, seller).toLowerCase()}
                {cmpRange ? <>, compared with {cmpText}</> : null}. USD, tax excluded.
              </span>
            </span>
            <span className="rpd-fresh">
              <Icon name="refresh-cw" />
              <span>
                Data updated {r.freshness.ago} <span className="muted">· {r.freshness.at}</span>
              </span>
            </span>
          </div>
        </div>
      </section>

      {r.note && (
        <Alert tone="info" title={r.note.title}>
          {r.note.body}
        </Alert>
      )}
      {notice && (
        <Alert tone={notice.tone} title={notice.title}>
          {notice.body}
        </Alert>
      )}

      <div className="ac-kpis">
        {kpis.map((m) => {
          const dlt = cmpTotal ? delta(m, total[m.key], cmpTotal[m.key]) : null;
          return (
            <div className="panel rpd-kpi" key={m.key}>
              <Stat label={m.label} value={fmtValue(total[m.key], m.fmt, true)} {...(dlt ? { delta: dlt.text, dir: dlt.dir, good: dlt.good, note: `vs ${cmpText}` } : {})} />
            </div>
          );
        })}
      </div>

      <Card
        title={`${chartM.label} by ${b.unit.toLowerCase()}`}
        sub={r.target ?? `${rangeLabel(p.range)} · ${scopeLabel(r, seller)}`}
        actions={
          r.chartMetrics.length > 1 ? (
            <div className="rpd-seg">
              <SegmentedControl label="Chart metric" items={r.chartMetrics.map((k) => ({ value: k, label: metric(k).label }))} active={chartKey} onChange={setChartKey} />
            </div>
          ) : undefined
        }
      >
        <div className="rpd-chart-head">
          <Legend items={r.chart === 'line' && sameShape ? [rangeLabel(p.range), cmpText] : [rangeLabel(p.range)]} />
          <span className="xs muted">{r.chart === 'bar' && cmpRange ? 'Comparison is in the KPIs and the table' : cmpRange && !sameShape ? 'Periods have different week counts; comparison is in the table' : chartM.fmt === 'money' ? 'USD' : ''}</span>
        </div>
        <div ref={chartRef}>
        {r.chart === 'line' ? (
          <LineChart
            width={chartWidth}
            labels={rows.map((x) => x.bucket.label)}
            series={[{ name: rangeLabel(p.range), data: rows.map((x) => x.v[chartKey]) }, ...(sameShape ? [{ name: cmpText, data: rows.map((x) => x.c![chartKey]) }] : [])]}
            height={240}
            fmt={chartFmt(chartM.fmt)}
            label={`${chartM.label} by ${b.unit.toLowerCase()}, ${rangeLabel(p.range)}${sameShape ? ` compared with ${cmpText}` : ''}`}
          />
        ) : (
          <BarChart width={chartWidth} labels={rows.map((x) => x.bucket.label)} data={rows.map((x) => x.v[chartKey])} height={220} fmt={chartFmt(chartM.fmt)} label={`${chartM.label} by ${b.unit.toLowerCase()}, ${rangeLabel(p.range)}`} />
        )}
        </div>
      </Card>

      <Card title="The same numbers as a table" sub={`${b.list.length} ${b.unit.toLowerCase()}s · ${scopeLabel(r, seller)}`} flush actions={<Button variant="ghost" size="sm" icon="download" onClick={openExport}>Export</Button>}>
        <TableWrap label={`${r.name} table`}>
          <table className="table">
            <thead>
              <tr>
                <th scope="col">{b.unit}</th>
                {tableCols.map((m) => (
                  <th key={m.key} className="r" scope="col">
                    {m.label}
                  </th>
                ))}
                {cmpRange && (
                  <th className="r" scope="col">
                    {chartM.label}, {cmpText}
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((x) => (
                <tr key={x.bucket.full}>
                  <td className="nowrap">{x.bucket.full}</td>
                  {tableCols.map((m) => (
                    <td key={m.key} className="r nowrap">
                      {m.key === chartKey ? <b>{fmtValue(x.v[m.key], m.fmt)}</b> : fmtValue(x.v[m.key], m.fmt)}
                    </td>
                  ))}
                  {cmpRange && <td className="r nowrap muted">{x.c ? fmtValue(x.c[chartKey], chartM.fmt) : '—'}</td>}
                </tr>
              ))}
              <tr className="ac-total">
                <td>Total</td>
                {tableCols.map((m) => (
                  <td key={m.key} className="r nowrap">
                    {fmtValue(total[m.key], m.fmt)}
                  </td>
                ))}
                {cmpRange && cmpTotal && <td className="r nowrap">{fmtValue(cmpTotal[chartKey], chartM.fmt)}</td>}
              </tr>
            </tbody>
          </table>
        </TableWrap>
      </Card>

      <section className="card" id="rp-exports" aria-labelledby="rp-exports-h">
        <div className="card-head">
          <div className="stack gap-0">
            <h2 className="h4" id="rp-exports-h">
              Exports
            </h2>
            <span className="xs muted">Background exports of this report · download links last 7 days · every export is recorded in Action history</span>
          </div>
        </div>
        <TableWrap label="Exports table">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">File</th>
                <th scope="col">Requested</th>
                <th className="r" scope="col">
                  Rows
                </th>
                <th scope="col">Status</th>
                <th className="col-pin" scope="col">
                  <span className="sr-only">Download</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {exports.map((e) => (
                <tr key={e.id}>
                  <td>
                    <span className="ab-cell">
                      <span className="small strong mono">{e.file}</span>
                      <span className="xs muted">{e.detail}</span>
                    </span>
                  </td>
                  <td>
                    <span className="small nowrap">{e.requested}</span>
                  </td>
                  <td className="r">{e.rows.toLocaleString('en-US')}</td>
                  <td>
                    <span className="stack gap-1 items-start">
                      <StatusBadge status={e.status} tone={e.status === 'Ready' ? 'success' : e.status === 'Queued' ? 'info' : ''} />
                      <span className="xs muted nowrap">{e.status === 'Queued' ? 'Preparing…' : e.status === 'Ready' ? `Expires ${e.expires}` : `Expired ${e.expires}`}</span>
                    </span>
                  </td>
                  <td className="col-pin">
                    {e.status === 'Ready' && e.opts ? (
                      <Button variant="secondary" size="sm" icon="download" srLabel={e.file} onClick={() => download(e.file, buildCsv(r, e.opts!))}>
                        Download
                      </Button>
                    ) : e.status === 'Expired' ? (
                      <Button variant="ghost" size="sm" icon="refresh-cw" srLabel={e.file} onClick={openExport}>
                        Export again
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      </section>

      <Dialog
        open={view === 'export'}
        onClose={() => setView('')}
        title={`Export ${r.name}`}
        size="lg"
        foot={
          <>
            <Button variant="ghost" onClick={() => setView('')}>
              Cancel
            </Button>
            <Button icon="download" onClick={runExport}>
              {instant ? 'Download CSV' : 'Start export'}
            </Button>
          </>
        }
      >
        <p className="small sub">
          {rangeLabel(p.range)} (inclusive) · Pacific Time · {scopeLabel(r, seller)}
        </p>
        <fieldset className="stack gap-2 fieldset-reset">
          <legend className="label">Rows</legend>
          <OptionCard id="rx-view" name="rx-scope" title={<span className="small strong">Current view</span>} body={`One row per ${b.unit.toLowerCase()} plus a total: ${b.list.length + 1} rows, as on screen`} checked={ex.scope === 'view'} onChange={() => setEx((x) => ({ ...x, scope: 'view' }))} />
          <OptionCard
            id="rx-all"
            name="rx-scope"
            title={<span className="small strong">All rows</span>}
            body={`One row per day and seller: ${rowCount(r, { ...exOpts, scope: 'all' }).toLocaleString('en-US')} rows`}
            checked={ex.scope === 'all'}
            onChange={() => setEx((x) => ({ ...x, scope: 'all' }))}
          />
        </fieldset>
        <fieldset className="stack gap-2 fieldset-reset">
          <legend className="label">Columns</legend>
          <span className="row gap-3 xs">
            <button type="button" className="btn-bare tight strong" onClick={() => setEx((x) => ({ ...x, columns: r.metrics.map((m) => m.key) }))}>
              Select all
            </button>
            <button type="button" className="btn-bare tight strong" onClick={() => setEx((x) => ({ ...x, columns: [] }))}>
              Clear
            </button>
            <span className="muted">
              {ex.columns.length} of {r.metrics.length} selected · date{ex.scope === 'all' ? ' and seller' : ''} always included
            </span>
          </span>
          <div className="rpd-cols">
            {r.metrics.map((m) => (
              <Checkbox key={m.key} id={`rx-col-${m.key}`} label={m.label} checked={ex.columns.includes(m.key)} onChange={() => toggleCol(m.key)} />
            ))}
          </div>
          {colsError && (
            <span className="error-text" role="alert">
              <Icon name="circle-alert" className="ic-sm" />
              {colsError}
            </span>
          )}
        </fieldset>
        <fieldset className="stack gap-2 fieldset-reset">
          <legend className="label">Format</legend>
          <OptionCard id="rx-excel" name="rx-format" title={<span className="small strong">CSV for Excel</span>} body="UTF-8 with a byte order mark and Windows line endings, so accents and symbols in seller names open correctly in Excel" checked={ex.format === 'excel'} onChange={() => setEx((x) => ({ ...x, format: 'excel' }))} />
          <OptionCard id="rx-plain" name="rx-format" title={<span className="small strong">Plain CSV</span>} body="UTF-8 without a byte order mark, for Google Sheets, scripts and databases" checked={ex.format === 'plain'} onChange={() => setEx((x) => ({ ...x, format: 'plain' }))} />
        </fieldset>
        <Checkbox id="rx-defs" label="Start the file with the period, seller scope and metric definitions" checked={ex.defs} onChange={(e) => setEx((x) => ({ ...x, defs: e.target.checked }))} />
        <div className="panel rpd-delivery">
          <Icon name={instant ? 'file-down' : 'hourglass'} />
          <span>
            {instant ? (
              <>
                <b>Downloads now.</b> {exRows.toLocaleString('en-US')} rows.
              </>
            ) : (
              <>
                <b>Runs in the background.</b> {exRows.toLocaleString('en-US')} rows is more than the {INSTANT_ROWS} that download straight away. The file appears under Exports on this page and you get a notification when it is ready.
              </>
            )}
          </span>
        </div>
        <p className="xs muted">Exports of seller data are recorded in Action history with your name, the period, the seller scope and the columns.</p>
      </Dialog>

      <Drawer
        open={view === 'definitions'}
        onClose={() => setView('')}
        title="Metric definitions"
        foot={
          <>
            <Button
              variant="ghost"
              icon="pencil"
              onClick={() => {
                setView('');
                setNotice({ tone: 'info', title: `Suggestion sent to ${r.owner.split(',')[0]}`, body: 'Definition changes get a new version number; exports made before the change keep the old definitions in their header.' });
              }}
            >
              Suggest a change
            </Button>
            <Button variant="secondary" onClick={() => setView('')}>
              Close
            </Button>
          </>
        }
      >
        <p className="small sub">
          {r.name} · {r.definitionsVersion} · owner {r.owner}. The same definitions are written at the top of every export.
        </p>
        <div className="rpd-defs">
          {r.metrics.map((m) => (
            <section className="rpd-def" key={m.key} aria-labelledby={`rd-${m.key}`}>
              <h3 className="h4" id={`rd-${m.key}`}>
                {m.label}
              </h3>
              <p className="small">{m.def?.meaning}</p>
              <KeyValue
                pairs={[
                  ['Formula', m.def?.formula],
                  ['Includes', m.def?.includes],
                  ['Excludes', m.def?.excludes],
                  ['Owner', m.def?.owner],
                  ['Version', m.def?.version],
                ]}
              />
            </section>
          ))}
        </div>
      </Drawer>

      {toast && (
        <div className="rpd-toast-wrap">
          <div className="toast" role="status">
            <Icon name="hourglass" className="ic-sm" />
            <span>{toast}</span>
            <button type="button" className="btn-bare tight" onClick={() => document.getElementById('rp-exports')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
              View exports
            </button>
            <IconButton icon="x" label="Dismiss" size="sm" className="x" onClick={() => setToast(null)} />
          </div>
        </div>
      )}
    </AdminLayout>
  );
}

