import { Link, useSearchParams } from 'react-router';
import { href } from '@marketly/web-shared/routes';
import { BarsChart, ChartFrame, fmtMoney, fmtMoneyCompact, LoadError, PeriodControl, seriesFromReport, seriesTable, usePeriod } from '@marketly/web-shared/ui';
import { fmtPeriod } from '../data/finance';
import { kpiOf, metaOf, type ReportQuery } from '../data/reports';
import { M, picks, STATS, useSellerReport } from '../data/statistics';

// Finance → "Money in and out": net earnings and what was paid out to the bank per day, week or month
// (seller.earnings), with its own period control (URL ?preset=&from=&to=&grain=) and a link to Statistics →
// Earnings and profit for the same period. Net earnings count by order date, payouts by the day they were paid.

export function MoneyInOut() {
  const period = usePeriod({ compare: 'none' });
  const [params] = useSearchParams();
  const query = period.query as ReportQuery;
  const report = useSellerReport(STATS.earnings, query);
  const r = report.data;
  const meta = metaOf(r);
  const grain = meta?.granularity ?? period.grain;
  const chart = seriesFromReport(r, picks(r, [{ key: M.netEarnings, label: 'Net earnings' }, { key: M.paidOut, label: 'Paid out' }]));
  const any = chart.rows.some((row) => chart.series.some((s) => Number(row[s.key] ?? 0) !== 0));
  const net = kpiOf(r, M.netEarnings);
  const paid = kpiOf(r, M.paidOut);
  const statsLink = href('seller/reports', 'earnings', undefined, Object.fromEntries(params));

  return (
    <ChartFrame
      titleAs="h2"
      title="Money in and out"
      sub={r ? `${net ? `Net earnings ${net.display}` : ''}${net && paid ? ' · ' : ''}${paid ? `paid out ${paid.display}` : ''} · ${fmtPeriod(meta?.range, true)}` : `Net earnings and payouts per ${grain}`}
      actions={
        <>
          <PeriodControl period={period} idPrefix="fin" noCompare />
          <Link className="small strong" to={statsLink}>
            Earnings and profit
          </Link>
        </>
      }
      loading={!r && !report.isError}
      refreshing={report.isPlaceholderData}
      empty={report.isError ? <LoadError error={report.error} title="We couldn’t load your earnings" forbiddenHint="This chart needs the Seller reports permission as well." onRetry={() => void report.refetch()} /> : r && !any ? 'No earnings or payouts in this period.' : false}
      table={seriesTable(chart.rows, chart.series, fmtMoney)}
    >
      <BarsChart rows={chart.rows} series={chart.series} fmt={fmtMoney} axisFmt={fmtMoneyCompact} label={`Net earnings and paid out per ${grain}, ${fmtPeriod(meta?.range, true).replace(' – ', ' to ')}`} />
    </ChartFrame>
  );
}
