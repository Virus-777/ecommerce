import { useState, type CSSProperties } from 'react';
import { Link } from 'react-router';
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { call, errorMessage, useApi } from '@marketly/web-shared/api';
import { AdminLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { formatMoney } from '@marketly/web-shared/lib/format';
import { href } from '@marketly/web-shared/routes';
import { Alert, announce, Breadcrumbs, Button, Field, Icon, Legend, LineChart, Select, SplitBar, Stat, SummaryRow, TableWrap } from '@marketly/web-shared/ui';
import { useStaffSession } from '@/app/session';
import { date, dateTime, LoadError, SkeletonLines } from '@/app/parts';
import { useReportExport } from './data/report-export';
import {
  calloutsOf, cellNumber, DATE_BASIS, deltaOf, fmtCell, groupIcon, metaOf, ownerLabel, pointsOf, PRESETS, SOLD_BY, splitOf, tableOf,
  type AdminDashboard, type Preset, type ReportGroup, type ReportQuery, type ReportResult,
} from './data/reports';

// Design: pages/admin/admin-reports.html (report library + Commerce: sales). Data: GET /api/admin/reports/catalogue
// (library), POST …/reports/commerce.sales/query (filters, KPIs, chart, split, table, definitions, callouts),
// GET …/dashboard (marketplace fee income for the fee note), exports (POST …/exports, polled), saved views and
// schedules. Library names open the report detail (admin/report, keyed by the report key, e.g. commerce.sales).

const FEATURED = 'commerce.sales';
const DASH_PERIODS = new Set(['today', 'last_7_days', 'last_14_days', 'last_30_days']);

const k = (n: number) => `$${(n / 1000).toFixed(1)}k`;

export default function Reports() {
  const { api } = useApi();
  const { can, accountId } = useStaffSession();
  const [range, setRange] = useState<Preset>('last_14_days');
  const [basis, setBasis] = useState('placement');
  const [soldBy, setSoldBy] = useState('all');
  const [notice, setNotice] = useState('');
  const exp = useReportExport();

  const catalogue = useQuery({ queryKey: ['reports', 'catalogue'], queryFn: () => call(api.GET('/api/admin/reports/catalogue')) as Promise<ReportGroup[]> });
  const query: ReportQuery = { preset: range, dateBasis: basis as ReportQuery['dateBasis'], soldBy: soldBy as ReportQuery['soldBy'], compare: 'previous_period' };
  const canSales = can('reports.commerce.view');
  const result = useQuery({
    queryKey: ['reports', 'query', FEATURED, query],
    queryFn: () => call(api.POST('/api/admin/reports/reports/{key}/query', { params: { path: { key: FEATURED } }, body: query })) as Promise<ReportResult>,
    placeholderData: keepPreviousData,
    enabled: canSales,
  });
  const dash = useQuery({
    queryKey: ['reports', 'dashboard', range],
    queryFn: () => call(api.GET('/api/admin/reports/dashboard', { params: { query: { period: range as 'last_7_days' } } })) as Promise<AdminDashboard>,
    enabled: DASH_PERIODS.has(range) && can('reports.dashboard.view'),
    retry: false,
  });

  const saveView = useMutation({
    mutationFn: () => call(api.POST('/api/admin/reports/saved-views', { body: { reportKey: FEATURED, name: `Sales · ${PRESETS.find((p) => p.value === range)?.label} · ${SOLD_BY[soldBy]}`, query } })),
    onSuccess: () => flash('View saved to your reports'),
  });
  const schedule = useMutation({
    mutationFn: () => call(api.POST('/api/admin/reports/schedules', { body: { reportKey: FEATURED, recipientStaffIds: [accountId], frequency: 'weekly', dayOfWeek: 1, time: '08:00', format: 'csv' } })),
    onSuccess: () => flash('Commerce: sales will be emailed to you every Monday at 8:00 AM PT'),
  });
  const flash = (msg: string) => {
    setNotice(msg);
    announce(msg);
  };
  const exportCsv = async () => {
    const j = await exp.start(FEATURED, query, 'csv');
    if (!j) return;
    if (j.state === 'ready') flash(`Downloaded ${j.fileName ?? 'the export'} (${j.rowCount ?? 0} rows). The export is recorded in Action history.`);
    else if (j.state === 'failed') setNotice('');
    else flash(`Export ${j.ref} is still being prepared. It will be under Exports in the report.`);
  };

  const r = result.data;
  const meta = r ? metaOf(r) : null;
  const t = r ? tableOf(r) : null;
  const split = r ? splitOf(r) : [];
  const official = split.find((s) => s.key === 'official');
  const market = split.find((s) => s.key === 'marketplace');
  const series = r?.series ?? [];
  const labels = series[0] ? pointsOf(series[0]).map((p) => p.label ?? date(p.x)) : [];
  const nReports = (catalogue.data ?? []).reduce((a, g) => a + g.reports.length, 0);
  const feeKpi = dash.data?.kpis.find((x) => x.metricKey === 'marketplace.fee_income');
  const writeError = saveView.error ?? schedule.error ?? exp.error;
  const canExport = can('reports.exports.create');
  const featured = catalogue.data?.flatMap((g) => g.reports.map((rep) => ({ g, rep }))).find((x) => x.rep.key === FEATURED);

  return (
    <AdminLayout active="reports">
      <div className="page-head">
        <div className="t">
          <Breadcrumbs items={[{ label: 'Reports and settings' }, { label: 'Reports' }]} />
          <h1 className="h1">Reports</h1>
          <p className="sub small">Every figure states its range, date basis, currency and time zone. Exports follow your permissions.</p>
        </div>
        <div className="actions">
          {can('reports.schedules.manage') && (
            <Button variant="secondary" size="sm" icon="calendar-clock" onClick={() => schedule.mutate()} disabled={schedule.isPending}>
              Schedule email
            </Button>
          )}
          {canExport && canSales && (
            <Button variant="secondary" size="sm" icon="download" onClick={() => void exportCsv()} disabled={exp.busy}>
              {exp.busy ? 'Preparing…' : 'Export CSV'}
            </Button>
          )}
        </div>
      </div>

      {notice && <Alert tone="success" title={notice} />}
      {!!writeError && (
        <Alert tone="danger" title="That didn’t work">
          {errorMessage(writeError)}
        </Alert>
      )}
      {exp.job?.state === 'failed' && (
        <Alert tone="danger" title="The export failed">
          {exp.job.error}
        </Alert>
      )}

      <div className="ac-lib">
        <section className="card" aria-label="Report library">
          <div className="card-head">
            <div className="stack gap-0">
              <h2 className="h4">Report library</h2>
              <span className="xs muted">{catalogue.data ? `${nReports} launch reports · ${catalogue.data.length} areas` : 'Loading…'}</span>
            </div>
          </div>
          {catalogue.error && (
            <div className="card-body">
              <LoadError error={catalogue.error} onRetry={() => void catalogue.refetch()} />
            </div>
          )}
          {!catalogue.data && !catalogue.error && (
            <div className="card-body">
              <SkeletonLines rows={6} />
            </div>
          )}
          {(catalogue.data ?? []).map((g) => (
            <div className="ac-libgrp" key={g.key}>
              <div className="row between gap-2 nowrap">
                <span className="row gap-2 nowrap small strong">
                  <Icon name={groupIcon(g.key)} className="ic-sm" />
                  {g.label}
                </span>
              </div>
              <span className="xs muted u-mb-sp-1">Owner: {ownerLabel(g)}</span>
              {g.reports.map((rep) => {
                const on = rep.key === FEATURED;
                return (
                  <Link key={rep.key} className={cx('ac-rl', on && 'is-active')} to={href('admin/report', '', { key: rep.key })} aria-current={on ? 'page' : undefined}>
                    <Icon name={on ? 'chart-line' : 'file-chart-column'} className="ic-sm" />
                    <span>{rep.title}</span>
                  </Link>
                );
              })}
            </div>
          ))}
        </section>

        <div className="stack gap-5">
          {!canSales ? (
            <Alert tone="info" title="Commerce reports aren’t part of your role">
              Open a report from the library that your role covers. Commerce reports need the Commerce reports permission.
            </Alert>
          ) : (
            <section className="card">
              <div className="card-head">
                <div className="stack gap-1">
                  <span className="eyebrow">Commerce · Owner {featured ? (featured.g.owner?.name ?? featured.g.ownerRole) : '…'}</span>
                  <h2 className="h3">Commerce: sales</h2>
                  <span className="xs muted">{featured?.rep.description ?? 'Gross sales and sales after cancellations and refunds, with the Official Store and marketplace split'}</span>
                </div>
                <div className="row gap-2">
                  <Button variant="ghost" size="sm" icon="bookmark" onClick={() => saveView.mutate()} disabled={saveView.isPending}>
                    Save view
                  </Button>
                  <Button variant="ghost" size="sm" icon="external-link" to={href('admin/report', '', { key: FEATURED })}>
                    Open report
                  </Button>
                  {canExport && (
                    <Button variant="secondary" size="sm" icon="download" onClick={() => void exportCsv()} disabled={exp.busy}>
                      Export
                    </Button>
                  )}
                </div>
              </div>
              <div className="card-body" style={{ gap: 'var(--sp-4)' } as CSSProperties}>
                <div className="ac-filters">
                  <Field label="Date range">
                    <Select id="rp-range" options={PRESETS} value={range} onChange={(e) => setRange(e.target.value as Preset)} />
                  </Field>
                  <Field label="Date basis">
                    <Select id="rp-basis" options={Object.entries(DATE_BASIS).map(([value, label]) => ({ value, label }))} value={basis} onChange={(e) => setBasis(e.target.value)} />
                  </Field>
                  <Field label="Sold by">
                    <Select id="rp-seller" options={Object.entries(SOLD_BY).map(([value, label]) => ({ value, label }))} value={soldBy} onChange={(e) => setSoldBy(e.target.value)} />
                  </Field>
                  <Field label="Currency" hint="One currency at launch">
                    <Select id="rp-cur" options={['USD (US dollar)']} />
                  </Field>
                  <Field label="Time zone" hint="Days run 12:00 AM to 11:59 PM PT">
                    <Select id="rp-tz" options={['Pacific Time (PT)']} />
                  </Field>
                </div>
                {result.error && <LoadError error={result.error} onRetry={() => void result.refetch()} />}
                {!r && !result.error && <SkeletonLines rows={4} />}
                {r && meta && (
                  <>
                    <div className="panel xs sub row gap-2">
                      <Icon name="info" className="ic-sm" />
                      <span>
                        Showing orders by <b>{(meta.dateBasisLabel ?? DATE_BASIS[basis]).replace(/^By /, '').toLowerCase()}</b> {date(meta.range.from)} – {date(meta.range.to)}, Pacific Time, in USD. Tax {meta.taxIncluded ? 'included' : 'excluded'}.
                        {meta.freshAsOf ? ` Figures through ${dateTime(meta.freshAsOf)} PT` : ''}
                        {meta.mayStillChange ? '; refunds for recent days can still change.' : '.'}
                      </span>
                    </div>
                    <div className="ac-kpis">
                      {r.kpis.slice(0, 4).map((kp) => {
                        const dl = deltaOf(kp);
                        return (
                          <div className="panel" key={kp.metricKey}>
                            <Stat
                              label={kp.label}
                              value={kp.display}
                              note={kp.note ?? undefined}
                              {...(dl && dl.direction !== 'flat' ? { delta: `${Math.abs(dl.value).toFixed(1)}${dl.unit === 'pct' ? '%' : ' pts'} · vs prior period`, dir: dl.direction, good: dl.good } : {})}
                            />
                          </div>
                        );
                      })}
                    </div>
                    <div className="stack gap-2">
                      <div className="row between">
                        <Legend items={series.map((s) => s.label)} />
                        <span className="xs muted">Daily sales, USD</span>
                      </div>
                      {labels.length > 1 ? (
                        <LineChart
                          labels={labels}
                          series={series.map((s) => ({ name: s.label, data: pointsOf(s).map((p) => p.y / 100000) }))}
                          height={240}
                          fmt={(v) => `$${v >= 10 ? Math.round(v) : v.toFixed(1)}k`}
                          label={`Daily ${series.map((s) => s.label.toLowerCase()).join(' and ')}, ${labels[0]} to ${labels[labels.length - 1]}`}
                        />
                      ) : (
                        <p className="small muted">One day selected: see the table below.</p>
                      )}
                      {official && market && (
                        <>
                          <div className="row between xs sub">
                            <span>
                              {official.label} {k(official.amount.amount / 100)} · {Math.round(official.sharePct)}%
                            </span>
                            <span>
                              {market.label} {k(market.amount.amount / 100)} · {Math.round(market.sharePct)}%
                            </span>
                          </div>
                          <SplitBar a={Math.round(official.sharePct)} b={100 - Math.round(official.sharePct)} />
                        </>
                      )}
                    </div>
                  </>
                )}
              </div>
              {t && (
                <TableWrap label="Commerce: sales table">
                  <table className="table">
                    <thead>
                      <tr>
                        {t.columns.map((c, i) => (
                          <th key={c.key} className={cx(c.align === 'right' && 'r', i === t.columns.length - 1 && 'col-pin')} scope="col">
                            {c.key === 'period' ? `Date (${(DATE_BASIS[basis] ?? '').split(' ')[0].toLowerCase()})` : c.label}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {[...t.rows].reverse().map((row, ri) => (
                        <tr key={String(row.period ?? ri)}>
                          {t.columns.map((c, i) => (
                            <td key={c.key} className={cx(c.align === 'right' && 'r', i === t.columns.length - 1 && 'col-pin')}>
                              {c.key === 'period' ? date(String(row.period)) : c.key === 'gross' ? <b>{fmtCell(row[c.key], c.unit)}</b> : (c.key === 'cancelled' || c.key === 'refunded') && cellNumber(row[c.key]) ? `−${fmtCell(row[c.key], c.unit)}` : fmtCell(row[c.key], c.unit)}
                            </td>
                          ))}
                        </tr>
                      ))}
                      {t.totals && (
                        <tr className="ac-total">
                          {t.columns.map((c, i) => (
                            <td key={c.key} className={cx(c.align === 'right' && 'r', i === t.columns.length - 1 && 'col-pin')}>
                              {c.key === 'period' ? `${t.rows.length}-day total` : (c.key === 'cancelled' || c.key === 'refunded') && cellNumber(t.totals![c.key]) ? `−${fmtCell(t.totals![c.key], c.unit)}` : fmtCell(t.totals![c.key], c.unit)}
                            </td>
                          ))}
                        </tr>
                      )}
                    </tbody>
                  </table>
                </TableWrap>
              )}
            </section>
          )}

          {r && (
            <section className="card">
              <div className="card-head">
                <div className="stack gap-0">
                  <h2 className="h4">Definitions used in this report</h2>
                  <span className="xs muted">
                    {r.definitions[0]?.owner ? `Maintained by ${r.definitions[0].owner.name}, ${r.definitions[0].owner.role}` : 'No owner named yet'} · version{' '}
                    {[...new Set(r.definitions.map((d) => d.version))].join(', ')}
                    {r.definitions[0]?.reviewedAt ? `, reviewed ${date(r.definitions[0].reviewedAt)}` : ''}
                  </span>
                </div>
                <Button variant="ghost" size="sm" icon="pencil" to={href('admin/report', 'definitions', { key: FEATURED })}>
                  Suggest a change
                </Button>
              </div>
              <div className="card-body">
                <div className="grid lg2 gap-5">
                  <dl className="ac-defs">
                    {r.definitions.map((d) => (
                      <div key={d.key} style={{ display: 'contents' }}>
                        <dt>{d.name}</dt>
                        <dd>{d.definition}</dd>
                      </div>
                    ))}
                    <dt>Date basis</dt>
                    <dd>Placement counts an order on the day it was placed. Payment, shipment and completion dates move the same order to a later day, so totals differ by basis.</dd>
                  </dl>
                  <div className="stack gap-3">
                    {calloutsOf(r).map((c) => (
                      <Alert key={c.title} tone={c.kind === 'warning' ? 'warning' : 'info'} title={c.title}>
                        {c.body}
                      </Alert>
                    ))}
                    {market && feeKpi?.money && (
                      <div className="well stack gap-2">
                        <span className="small strong">How the two figures relate</span>
                        <SummaryRow k="Marketplace sales (customer paid)" v={formatMoney(market.amount)} />
                        <SummaryRow k="Marketplace fee income (company)" v={formatMoney(feeKpi.money)} />
                        <SummaryRow k="Seller earnings before adjustments" v={formatMoney({ amount: market.amount.amount - feeKpi.money.amount, currency: market.amount.currency })} />
                        <span className="xs muted row gap-1 nowrap wrap">
                          <Icon name="info" className="ic-sm" />
                          <span>
                            {market.amount.amount ? `Effective fee rate ${((feeKpi.money.amount / market.amount.amount) * 100).toFixed(1)}% for the period. ` : ''}Fee income is by order placement date over the dashboard period. Category rates are set in Settings.
                          </span>
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </section>
          )}
        </div>
      </div>
    </AdminLayout>
  );
}
