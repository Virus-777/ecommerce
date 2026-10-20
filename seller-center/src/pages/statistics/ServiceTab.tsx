import { useQuery } from '@tanstack/react-query';
import { type CSSProperties } from 'react';
import { Link } from 'react-router';
import { call, useApi } from '@marketly/web-shared/api';
import { href } from '@marketly/web-shared/routes';
import { Card, ChartFrame, fmtPercent, fmtPercentCompact, LoadError, Meter, seriesFromReport, seriesTable, StatusBadge, TrendChart } from '@marketly/web-shared/ui';
import { useSellerSession } from '@/app/session';
import { fmtPeriod } from '../data/finance';
import { meterPct, metaOf, SERVICE_KEYS, type ReportQuery } from '../data/reports';
import { KpiTile, M, metaLine, picks, ReportCallouts, statSkeleton, STATS, useSellerReport } from '../data/statistics';

// Statistics → Service: the period's service figures (seller.service_performance: on-time dispatch, valid tracking,
// cancellations, delivery issues, and the on-time dispatch trend with its comparison) and the account-health
// meters against Marketly's targets (GET sellers/performance, always the last 30 days).

export function ServiceTab({ query }: { query: ReportQuery }) {
  const { api } = useApi();
  const { sellerId } = useSellerSession();
  const report = useSellerReport(STATS.service, query);
  const performance = useQuery({ queryKey: ['sellers', 'performance', sellerId], queryFn: () => call(api.GET('/api/seller/sellers/performance')) });

  const r = report.data;
  const meta = metaOf(r);
  const chart = seriesFromReport(r, picks(r, [{ key: M.onTimeDispatch, label: 'On-time dispatch' }]));
  const dispatched = r?.series.find((s) => s.key === 'dispatched' || s.key === 'service.dispatched');
  // a period without dispatches has 0% points; say so instead of drawing a flat line
  const anyDispatch = dispatched ? (dispatched.points as Array<{ y: number }>).some((p) => p.y > 0) : chart.rows.length > 0;
  const service = SERVICE_KEYS.map((k) => performance.data?.metrics.find((m) => m.key === k)).filter((m) => !!m);
  const range = fmtPeriod(meta?.range).replace(' – ', ' to ');

  return (
    <>
      {r && <p className="small muted">{metaLine(r)}</p>}
      {report.isError && <LoadError error={report.error} title="We couldn’t load your service figures" onRetry={() => void report.refetch()} />}
      <div className="sb-kpis">
        <KpiTile result={r} metricKey={M.onTimeDispatch} label="On-time dispatch" />
        <KpiTile result={r} metricKey={M.validTracking} label="Valid tracking" />
        <KpiTile result={r} metricKey={M.sellerCancellations} label="Seller cancellations" />
        <KpiTile result={r} metricKey={M.deliveryExceptions} label="Delivery issues" />
      </div>
      <ChartFrame
        titleAs="h2"
        title={`On-time dispatch per ${meta?.granularity ?? 'day'}`}
        sub="Share of your packages dispatched by their dispatch deadline"
        loading={!r && !report.isError}
        refreshing={report.isPlaceholderData}
        empty={r && !anyDispatch ? 'No packages dispatched in this period.' : false}
        table={seriesTable(chart.rows, chart.series, fmtPercent, { compareLabel: chart.compareLabel })}
      >
        <TrendChart rows={chart.rows} series={chart.series} fmt={fmtPercent} axisFmt={fmtPercentCompact} compareLabel={chart.compareLabel} label={`On-time dispatch per ${meta?.granularity ?? 'day'}, ${range}`} />
      </ChartFrame>
      <ReportCallouts result={r} />
      <Card
        titleAs="h3"
        title="Account health"
        sub={performance.data ? `Against Marketly service targets, ${fmtPeriod(performance.data.period)}` : 'Against Marketly service targets, last 30 days'}
        actions={
          <Link className="small strong" to={href('seller/performance')}>
            Performance
          </Link>
        }
      >
        {performance.isError ? (
          <LoadError error={performance.error} title="We couldn’t load your service figures" onRetry={() => void performance.refetch()} />
        ) : !performance.data ? (
          statSkeleton
        ) : (
          <div className="grid md2" style={{ '--gap': '0 var(--sp-6)' } as CSSProperties}>
            {service.map((m) => {
              const meets = m.status === 'meets' || m.status === 'watch';
              const status = meets ? 'Meets target' : 'Below target';
              const tone = meets ? 'success' : 'warning';
              return (
                <div key={m.key} className="sb-metric">
                  <div className="stack gap-0">
                    <span className="small strong">{m.label}</span>
                    <span className="xs muted">Target: {m.target.display}</span>
                  </div>
                  <div className="row gap-2 nowrap">
                    <span className="h3 num">{m.display}</span>
                    <StatusBadge status={status} tone={tone} />
                  </div>
                  <div className="bar">
                    <Meter pct={meterPct(m)} tone={tone} label={`${m.display} ${status}`} />
                    {m.status === 'watch' && <span className="xs strong meter-note t-warning-text">Near target</span>}
                  </div>
                  <span className="xs muted span-all">
                    {[m.definition, m.detail].map((t) => t.replace(/\.$/, '')).join('. ')}.
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </>
  );
}
