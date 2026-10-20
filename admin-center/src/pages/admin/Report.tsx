import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, call, errorMessage, useApi } from '@marketly/web-shared/api';
import { AdminLayout } from '@marketly/web-shared/layouts';
import { useView } from '@marketly/web-shared/lib/hooks';
import { DEFAULT_PRESETS, type PeriodPreset } from '@marketly/web-shared/lib/period';
import { href } from '@marketly/web-shared/routes';
import {
  Alert, BarsChart, Button, Card, ChartFrame, Drawer, EmptyState, Field, fmtCount, fmtCountCompact, fmtForUnit, Icon, IconButton, KeyValue, PageHeader, PeriodControl, rowsFrom, SegmentedControl, Select, seriesFromReport,
  seriesTable, StatusBadge, TableWrap, Textarea, TrendChart, announce, usePeriod,
} from '@marketly/web-shared/ui';
import { useStaffSession } from '@/app/session';
import { date, dateTime, LoadError, shortDate, SkeletonLines } from '@/app/parts';
import { useReportExport } from './data/report-export';
import { Freshness, ReportExportDialog, ReportKpis, ReportNotices, ReportTableCard, type ExportFormat } from './data/report-parts';
import {
  breakdownsOf, DATE_BASIS, fmtCell, metaOf, SOLD_BY, tableOf,
  type ExportJob, type MetricDefinition, type ReportDefinition, type ReportGroup, type ReportQuery, type ReportResult,
} from './data/reports';
import './Report.css';

// Report detail (admin/report): designed in React after the design export, following
// reports/Best ecommerce site UX patterns.md, "Report detail and export flows".
// Views: '' report · 'export' = export dialog · 'definitions' = metric definitions drawer.
// Data: GET /api/admin/reports/reports/{key} (definition, filters, metric definitions), POST …/{key}/query
// (meta, KPIs, series, table, breakdowns, callouts), GET/POST …/exports (background jobs, polled; the list
// shows this report's exports), POST …/metrics/{key}/suggestions (Suggest a change). The URL key is the
// report key (e.g. commerce.sales).

type View = 'export' | 'definitions';

const UNIT_LABEL: Record<string, string> = { money: 'Money (USD)', count: 'Count', percent: 'Percent', ratio: 'Ratio', duration_hours: 'Hours', days: 'Days' };

/** The breakdown chart draws one value per row (requests, count or share). */
const BREAKDOWN_SERIES = [{ key: 'value', label: 'Value' }];

const EXPORT_STATE: Record<ExportJob['state'], { label: string; tone: 'success' | 'info' | 'danger' | '' }> = {
  queued: { label: 'Queued', tone: 'info' },
  running: { label: 'Preparing', tone: 'info' },
  ready: { label: 'Ready', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  expired: { label: 'Expired', tone: '' },
};

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
          The link may be old or the report was renamed. Every report is listed in the library.
        </EmptyState>
      </Card>
    </AdminLayout>
  );
}

export default function Report() {
  const { key = '' } = useParams();
  const { api } = useApi();
  const def = useQuery({
    queryKey: ['reports', 'report', key],
    queryFn: () => call(api.GET('/api/admin/reports/reports/{key}', { params: { path: { key } } })) as Promise<{ report: ReportDefinition; definitions: MetricDefinition[] }>,
    retry: false,
  });
  const catalogue = useQuery({ queryKey: ['reports', 'catalogue'], queryFn: () => call(api.GET('/api/admin/reports/catalogue')) as Promise<ReportGroup[]> });
  if (def.error instanceof ApiError && def.error.status === 404) return <NotFound k={key} />;
  if (def.error)
    return (
      <AdminLayout active="reports">
        <PageHeader crumbs={[{ label: 'Reports and settings' }, { label: 'Reports', to: href('admin/reports') }, { label: key }]} title="Report" />
        <LoadError error={def.error} onRetry={() => void def.refetch()} />
      </AdminLayout>
    );
  if (!def.data)
    return (
      <AdminLayout active="reports">
        <PageHeader crumbs={[{ label: 'Reports and settings' }, { label: 'Reports', to: href('admin/reports') }, { label: key }]} title={<span className="sk sk-line" style={{ width: 240, display: 'inline-block' }} />} />
        <Card pad>
          <SkeletonLines rows={6} />
        </Card>
      </AdminLayout>
    );
  const group = catalogue.data?.find((g) => g.key === def.data.report.group);
  return <ReportPage key={key} r={def.data.report} defs={def.data.definitions} group={group} />;
}

function ReportPage({ r, defs, group }: { r: ReportDefinition; defs: MetricDefinition[]; group?: ReportGroup }) {
  const { api } = useApi();
  const qc = useQueryClient();
  const { can } = useStaffSession();
  const [view, setView] = useView<View>();
  const filter = (k: string) => r.filters.find((f) => f.key === k);
  // the period lives in the URL (PeriodControl); the report's own default preset (often 14 days) stays offered
  const defaultPreset = ((filter('range')?.default as string) ?? 'last_14_days') as PeriodPreset;
  const period = usePeriod({ preset: defaultPreset });
  const presets = DEFAULT_PRESETS.includes(defaultPreset) ? DEFAULT_PRESETS : [defaultPreset, ...DEFAULT_PRESETS];
  const compare = period.compare;
  const [seller, setSeller] = useState('all');
  const [basis, setBasis] = useState(((filter('dateBasis')?.default as string) ?? 'placement') as string);
  const [soldBy, setSoldBy] = useState(((filter('soldBy')?.default as string) ?? 'all') as string);
  const [chartKey, setChartKey] = useState('');
  const [notice, setNotice] = useState<{ tone: 'success' | 'info'; title: string; body?: string } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const exp = useReportExport();

  const query: ReportQuery = {
    // new presets and comparisons (docs/09 §3.3) are not in the generated types until the backend lands
    ...(period.query as ReportQuery),
    ...(filter('dateBasis') ? { dateBasis: basis as ReportQuery['dateBasis'] } : {}),
    ...(filter('soldBy') ? { soldBy: soldBy as ReportQuery['soldBy'] } : {}),
    ...(filter('sellerId') && seller !== 'all' ? { sellerId: seller } : {}),
  };
  const result = useQuery({
    queryKey: ['reports', 'query', r.key, query],
    queryFn: () => call(api.POST('/api/admin/reports/reports/{key}/query', { params: { path: { key: r.key } }, body: query })) as Promise<ReportResult>,
    placeholderData: keepPreviousData,
  });
  const sellers = useQuery({
    queryKey: ['sellers', 'list', 'for-reports'],
    queryFn: () => call(api.GET('/api/admin/sellers/sellers', { params: { query: { limit: 100 } } as never })) as Promise<{ items: Array<{ id: string; storeName: string }> }>,
    enabled: !!filter('sellerId'),
    retry: false,
  });
  const canExport = can('reports.exports.create');
  const exportsList = useQuery({
    queryKey: ['reports', 'exports'],
    queryFn: () => call(api.GET('/api/admin/reports/exports', { params: { query: { limit: 50 } } })) as Promise<{ items: ExportJob[] }>,
    enabled: canExport,
    refetchInterval: (q) => (q.state.data?.items.some((e) => e.state === 'queued' || e.state === 'running') ? 3000 : false),
  });

  /* ----- Suggest a change ----- */
  const [sugMetric, setSugMetric] = useState(defs[0]?.key ?? '');
  const [sugText, setSugText] = useState('');
  const [sugReason, setSugReason] = useState('');
  const [sugOpen, setSugOpen] = useState(false);
  const [sugErr, setSugErr] = useState('');
  const suggest = useMutation({
    mutationFn: () => call(api.POST('/api/admin/reports/metrics/{key}/suggestions', { params: { path: { key: sugMetric } }, body: { proposed: sugText.trim(), reason: sugReason.trim() } })),
    onSuccess: () => {
      const owner = defs.find((d) => d.key === sugMetric)?.owner;
      setView('');
      setSugOpen(false);
      setSugText('');
      setSugReason('');
      setNotice({ tone: 'info', title: `Suggestion sent to ${owner?.name ?? group?.ownerRole ?? 'the metric owner'}`, body: 'Definition changes get a new version number; exports made before the change keep the old definitions.' });
    },
  });
  const sendSuggestion = () => {
    if (!sugText.trim() || !sugReason.trim()) return setSugErr('Describe the change and why it is needed.');
    setSugErr('');
    suggest.mutate();
  };

  /* ----- Export dialog ----- */
  const openExport = () => {
    exp.reset();
    setView('export');
  };
  const runExport = async (format: ExportFormat) => {
    setView('');
    setToast('Export started. It will be ready under Exports, and we will notify you.');
    announce('Export started in the background');
    const j = await exp.start(r.key, query, format);
    setToast(null);
    void qc.invalidateQueries({ queryKey: ['reports', 'exports'] });
    if (!j) return;
    if (j.state === 'ready') {
      setNotice({ tone: 'success', title: `Downloaded ${j.fileName ?? 'the export'}`, body: `${(j.rowCount ?? 0).toLocaleString('en-US')} rows${j.columnsExcluded.length ? `; ${j.columnsExcluded.length} columns left out for your permissions` : ''}. The export is recorded in Action history.` });
      announce('Export downloaded');
    } else if (j.state !== 'failed') setNotice({ tone: 'info', title: `Export ${j.ref} is still being prepared`, body: 'It appears under Exports on this page when it is ready.' });
  };
  useEffect(() => () => setToast(null), []);

  const res = result.data;
  const meta = res ? metaOf(res) : null;
  const series = (res?.series ?? []).filter((s) => !s.key.endsWith(':compare'));
  const activeSeries = series.find((s) => s.key === chartKey) ?? series[0];
  const breakdowns = res ? breakdownsOf(res) : [];
  const table = res ? tableOf(res) : null;
  const defList = res?.definitions.length ? res.definitions : defs;
  const unitOfSeries = (k: string) => defList.find((d) => d.key.endsWith(`.${k}`))?.unit ?? (table?.columns.find((c) => k.startsWith(c.key))?.unit ?? 'count');
  const seriesUnit = activeSeries ? unitOfSeries(activeSeries.key) : 'count';
  const [unitFmt, unitAxisFmt] = fmtForUnit(seriesUnit);
  const chart = seriesFromReport(res, activeSeries ? [activeSeries.key] : []);
  const rangeText = meta ? `${date(meta.range.from)} – ${date(meta.range.to)}` : '';
  const cmpText = meta?.compareRange ? `${shortDate(meta.compareRange.from)} – ${date(meta.compareRange.to)}` : '';
  const scopeText = seller !== 'all' ? (sellers.data?.items.find((s) => s.id === seller)?.storeName ?? 'One seller') : filter('soldBy') ? SOLD_BY[soldBy] : 'All sellers and the Official Store';
  const owner = group ? (group.owner ? `${group.owner.name}` : group.ownerRole) : '';
  const myExports = (exportsList.data?.items ?? []).filter((e) => e.reportKey === r.key);
  const firstBreakdown = breakdowns[0];
  const breakdownRows = rowsFrom(
    (firstBreakdown?.rows ?? []).map((x) => x.label),
    { value: (firstBreakdown?.rows ?? []).map((x) => Number(x.requests ?? x.count ?? x.sharePct ?? 0)) },
  );
  const definitionsVersion = [...new Set(defList.map((d) => d.version))].map((v) => `Version ${v}`).join(', ');

  return (
    <AdminLayout active="reports">
      <PageHeader
        crumbs={[{ label: 'Reports and settings' }, { label: 'Reports', to: href('admin/reports') }, { label: r.title }]}
        eyebrow={`${group?.label ?? r.group}${owner ? ` · Owner ${owner}` : ''}`}
        title={r.title}
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
            {canExport && (
              <Button size="sm" icon="download" onClick={openExport} disabled={exp.busy}>
                Export
              </Button>
            )}
          </>
        }
      />

      <section className="card" aria-label="Report filters">
        <div className="card-body">
          <PeriodControl period={period} presets={presets} idPrefix="rp" />
          <div className="rpd-filters">
            {filter('sellerId') ? (
              <Field label="Sellers" hint={seller === 'all' && filter('soldBy') ? 'Includes the Official Store' : undefined}>
                <Select id="rp-seller" options={[{ value: 'all', label: 'All sellers' }, ...(sellers.data?.items ?? []).map((s) => ({ value: s.id, label: s.storeName }))]} value={seller} onChange={(e) => setSeller(e.target.value)} />
              </Field>
            ) : null}
            {filter('soldBy') && seller === 'all' ? (
              <Field label="Sold by">
                <Select id="rp-soldby" options={(filter('soldBy')?.options ?? Object.keys(SOLD_BY)).map((o) => ({ value: o, label: SOLD_BY[o] ?? o }))} value={soldBy} onChange={(e) => setSoldBy(e.target.value)} />
              </Field>
            ) : null}
            {filter('dateBasis') ? (
              <Field label="Date basis" hint={filter('dateBasis')?.hint ?? undefined}>
                <Select id="rp-basis" options={(filter('dateBasis')?.options ?? []).map((o) => ({ value: o, label: DATE_BASIS[o] ?? o }))} value={basis} onChange={(e) => setBasis(e.target.value)} />
              </Field>
            ) : null}
            <Field label="Time zone" hint="Days run 12:00 AM to 11:59 PM PT">
              <Select id="rp-tz" options={['Pacific Time (PT)']} />
            </Field>
          </div>
          {meta && (
            <div className="panel xs sub rpd-scopeline">
              <span>
                <Icon name="info" />
                <span>
                  Showing <b>{rangeText}</b> in Pacific Time, {scopeText.toLowerCase()}
                  {cmpText ? <>, compared with {cmpText}</> : null}. USD, tax {meta.taxIncluded ? 'included' : 'excluded'}.
                </span>
              </span>
              <Freshness at={meta.freshAsOf} />
            </div>
          )}
        </div>
      </section>

      <ReportNotices res={res} />
      {notice && (
        <Alert tone={notice.tone} title={notice.title}>
          {notice.body}
        </Alert>
      )}
      {!!exp.error && (
        <Alert tone="danger" title="The export didn’t start">
          {errorMessage(exp.error)}
        </Alert>
      )}
      {exp.job?.state === 'failed' && (
        <Alert tone="danger" title="The export failed">
          {exp.job.error}
        </Alert>
      )}
      {result.error && <LoadError error={result.error} onRetry={() => void result.refetch()} />}

      <ReportKpis res={res} compared={compare !== 'none'} cmpText={cmpText} error={!!result.error} />

      {activeSeries ? (
        <ChartFrame
          titleAs="h2"
          title={`${activeSeries.label} by ${meta?.granularity ?? 'day'}`}
          sub={`${rangeText} · ${scopeText}${seriesUnit === 'money' ? ' · USD' : ''}`}
          actions={
            series.length > 1 ? (
              <div className="rpd-seg">
                <SegmentedControl label="Chart metric" items={series.map((s) => ({ value: s.key, label: s.label }))} active={activeSeries.key} onChange={setChartKey} />
              </div>
            ) : undefined
          }
          refreshing={result.isPlaceholderData}
          empty={chart.rows.length > 1 ? false : 'One day selected: see the table below.'}
          table={seriesTable(chart.rows, chart.series, unitFmt, { compareLabel: chart.compareLabel })}
        >
          <TrendChart rows={chart.rows} series={chart.series} fmt={unitFmt} axisFmt={unitAxisFmt} compareLabel={chart.compareLabel} label={`${activeSeries.label}, ${rangeText}`} />
        </ChartFrame>
      ) : firstBreakdown ? (
        <ChartFrame titleAs="h2" title={firstBreakdown.label} sub={`${rangeText} · ${scopeText}`} refreshing={result.isPlaceholderData} table={seriesTable(breakdownRows, BREAKDOWN_SERIES, fmtCount, { xLabel: 'Item' })}>
          <BarsChart rows={breakdownRows} series={BREAKDOWN_SERIES} fmt={fmtCount} axisFmt={fmtCountCompact} horizontal label={`${firstBreakdown.label}, ${rangeText}`} />
        </ChartFrame>
      ) : null}

      {breakdowns.map((b) => (
        <Card key={b.key} title={b.label} flush>
          <TableWrap label={`${b.label} table`}>
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">{b.label.replace(/^.* by /i, '').replace(/^\w/, (c) => c.toUpperCase())}</th>
                  {Object.keys(b.rows[0] ?? {})
                    .filter((k) => k !== 'key' && k !== 'label')
                    .map((k) => (
                      <th key={k} className="r" scope="col">
                        {k === 'sharePct' ? 'Share' : k[0].toUpperCase() + k.slice(1)}
                      </th>
                    ))}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((row) => (
                  <tr key={row.key}>
                    <td>{row.label}</td>
                    {Object.entries(row)
                      .filter(([k]) => k !== 'key' && k !== 'label')
                      .map(([k, v]) => (
                        <td key={k} className="r nowrap">
                          {k === 'sharePct' ? `${Number(v).toFixed(1)}%` : fmtCell(v, 'count')}
                        </td>
                      ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        </Card>
      ))}

      {table && (
        <ReportTableCard
          table={table}
          title="The same numbers as a table"
          sub={`${table.rows.length} rows · ${scopeText}`}
          label={`${r.title} table`}
          actions={
            canExport ? (
              <Button variant="ghost" size="sm" icon="download" onClick={openExport}>
                Export
              </Button>
            ) : undefined
          }
        />
      )}

      {canExport && (
        <section className="card" id="rp-exports" aria-labelledby="rp-exports-h">
          <div className="card-head">
            <div className="stack gap-0">
              <h2 className="h4" id="rp-exports-h">
                Exports
              </h2>
              <span className="xs muted">Your exports of this report · download links expire · every export is recorded in Action history</span>
            </div>
          </div>
          {exportsList.error ? (
            <div className="card-body">
              <LoadError error={exportsList.error} onRetry={() => void exportsList.refetch()} />
            </div>
          ) : !exportsList.data ? (
            <div className="card-body">
              <SkeletonLines rows={2} />
            </div>
          ) : (
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
                  {myExports.map((e) => {
                    const st = EXPORT_STATE[e.state];
                    return (
                      <tr key={e.id}>
                        <td>
                          <span className="ab-cell">
                            <span className="small strong mono">{e.fileName ?? e.ref}</span>
                            <span className="xs muted">
                              {e.ref} · {e.format.toUpperCase()}
                              {e.columnsExcluded.length ? ` · ${e.columnsExcluded.length} columns left out for permissions` : ''}
                            </span>
                          </span>
                        </td>
                        <td>
                          <span className="small nowrap">{dateTime(e.createdAt)}</span>
                        </td>
                        <td className="r">{e.rowCount != null ? e.rowCount.toLocaleString('en-US') : '—'}</td>
                        <td>
                          <span className="stack gap-1 items-start">
                            <StatusBadge status={st.label} tone={st.tone} />
                            <span className="xs muted nowrap">{e.state === 'ready' && e.expiresAt ? `Expires ${dateTime(e.expiresAt)}` : e.state === 'failed' ? (e.error ?? '') : e.state === 'expired' && e.expiresAt ? `Expired ${shortDate(e.expiresAt)}` : e.state === 'ready' ? '' : 'Preparing…'}</span>
                          </span>
                        </td>
                        <td className="col-pin">
                          {e.state === 'ready' ? (
                            <Button variant="secondary" size="sm" icon="download" srLabel={e.fileName ?? e.ref} onClick={() => void exp.fetchAndDownload(e.id)}>
                              Download
                            </Button>
                          ) : e.state === 'expired' || e.state === 'failed' ? (
                            <Button variant="ghost" size="sm" icon="refresh-cw" srLabel={e.fileName ?? e.ref} onClick={openExport}>
                              Export again
                            </Button>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                  {myExports.length === 0 && (
                    <tr>
                      <td colSpan={5} className="muted">
                        No exports of this report yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </TableWrap>
          )}
        </section>
      )}

      <ReportExportDialog open={view === 'export'} onClose={() => setView('')} title={r.title} scope={`${rangeText} (inclusive) · Pacific Time · ${scopeText}`} busy={exp.busy} onStart={(f) => void runExport(f)} />

      <Drawer
        open={view === 'definitions'}
        onClose={() => setView('')}
        title="Metric definitions"
        foot={
          sugOpen ? (
            <>
              <Button variant="ghost" onClick={() => setSugOpen(false)}>
                Cancel
              </Button>
              <Button icon="send" onClick={sendSuggestion} disabled={suggest.isPending}>
                Send suggestion
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" icon="pencil" onClick={() => setSugOpen(true)}>
                Suggest a change
              </Button>
              <Button variant="secondary" onClick={() => setView('')}>
                Close
              </Button>
            </>
          )
        }
      >
        <p className="small sub">
          {r.title} · {definitionsVersion} · owner {owner || 'not named yet'}. Every figure in the report and its exports uses these definitions.
        </p>
        {sugOpen && (
          <div className="panel stack gap-3">
            <Field label="Metric">
              <Select id="rd-sug-metric" options={defList.map((d) => ({ value: d.key, label: d.name }))} value={sugMetric} onChange={(e) => setSugMetric(e.target.value)} />
            </Field>
            <Field label="What should change" error={sugErr || (suggest.error ? errorMessage(suggest.error) : undefined)}>
              <Textarea id="rd-sug-text" value={sugText} onChange={(e) => (setSugText(e.target.value), setSugErr(''))} />
            </Field>
            <Field label="Why">
              <Textarea id="rd-sug-reason" value={sugReason} onChange={(e) => (setSugReason(e.target.value), setSugErr(''))} />
            </Field>
          </div>
        )}
        <div className="rpd-defs">
          {defList.map((m) => (
            <section className="rpd-def" key={m.key} aria-labelledby={`rd-${m.key}`}>
              <h3 className="h4" id={`rd-${m.key}`}>
                {m.name}
              </h3>
              <p className="small">{m.definition}</p>
              <KeyValue
                pairs={[
                  ['Formula', m.formula],
                  ['Unit', UNIT_LABEL[m.unit] ?? m.unit],
                  ['Includes', m.includes.length ? m.includes.join('; ') : '—'],
                  ['Excludes', m.excludes.length ? m.excludes.join('; ') : '—'],
                  ['Owner', m.owner ? `${m.owner.name}, ${m.owner.role}` : 'Not named yet'],
                  ['Version', `Version ${m.version} · effective ${date(m.effectiveFrom)}${m.reviewedAt ? ` · reviewed ${date(m.reviewedAt)}` : ''}`],
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
