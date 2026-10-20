import { useMemo } from 'react';
import { Link } from 'react-router';
import {
  ChartFrame, ComboChart, DonutChart, donutTable, fmtMoney, fmtMoneyCompact, fmtPercent, LoadError, seriesFromReport, seriesTable, TrendChart, WaterfallChart, waterfallTable, type WaterfallStepInput,
} from '@marketly/web-shared/ui';
import { fmtPeriod } from '../data/finance';
import { metaOf, type ReportQuery } from '../data/reports';
import { breakdownOf, centsOf, compareNote, costCoverage, KpiTile, M, metaLine, picks, ReportCallouts, ReportTableCard, STATS, unavailable, useSellerReport, useTabLink } from '../data/statistics';

// Statistics → Earnings and profit (seller.earnings, docs/09 §3.3): net earnings, profit, margin and paid out with
// their change against the comparison; net earnings against profit per period (with the comparison drawn dashed);
// how item sales become net earnings and profit (waterfall); fees by type; item sales against product cost with
// the margin line; and the period table. Item sales, refunds, fees and product cost count by order date; ad
// spend, service fees, labels, adjustments and payouts by the day they were charged (the report's callout says so).
// Profit needs unit costs: with none on the period's sales the profit and margin tiles show "—" and a link to the
// Products tab, and the charts stop at net earnings; with some, the tiles say what share of item sales has a cost.

export function EarningsTab({ query }: { query: ReportQuery }) {
  const report = useSellerReport(STATS.earnings, query);
  const tabLink = useTabLink();
  const r = report.data;
  const meta = metaOf(r);
  const grain = meta?.granularity ?? 'day';
  const range = fmtPeriod(meta?.range).replace(' – ', ' to ');

  // no unit cost on any sale: profit would only repeat net earnings, so it is left out of the tiles and charts
  const costs = costCoverage(r);
  const noCosts = costs.state === 'none';

  const view = useMemo(() => {
    const withProfit = !noCosts && !unavailable(r, M.profit);
    const trend = seriesFromReport(r, picks(r, [{ key: M.netEarnings, label: 'Net earnings' }, ...(withProfit ? [{ key: M.profit, label: 'Profit' }] : [])]));
    const combo = seriesFromReport(r, picks(r, [{ key: M.itemSales, label: 'Item sales' }, { key: M.productCost, label: 'Product cost' }, { key: M.marginPct, label: 'Margin', axis: 'right' }]));
    // without costs the waterfall ends at net earnings (product cost $0, profit = net earnings says nothing)
    const steps = breakdownOf<WaterfallStepInput>(r, 'waterfall');
    const waterfall = noCosts ? steps.filter((st) => st.key !== M.productCost && st.key !== M.profit) : steps;
    const fees = breakdownOf<{ key: string | null; label: string; amount?: unknown }>(r, 'fees_by_type').map((f) => ({ key: f.key ?? f.label, label: f.label, value: Math.abs(centsOf(f.amount)) }));
    return { trend, combo, waterfall, fees };
  }, [r, noCosts]);

  const anyMoney = view.trend.rows.some((row) => view.trend.series.some((s) => Number(row[s.key] ?? 0) !== 0));
  const [comboBars, comboLine] = [view.combo.series.filter((s) => s.axis !== 'right'), view.combo.series.find((s) => s.axis === 'right')];
  const hasCosts = view.combo.rows.some((row) => Number(row[comboBars[1]?.key ?? ''] ?? 0) > 0);
  const empty = r && !anyMoney ? 'No sales or charges in this period.' : false;
  const costsMissing = (
    <span>
      No product costs for these sales yet. <Link to={tabLink('products')}>Add unit costs</Link> to see profit.
    </span>
  );
  const addCosts = (
    <>
      <Link to={tabLink('products')}>Add unit costs</Link> to see profit
    </>
  );
  const trendTitle = view.trend.series.length > 1 ? 'Net earnings and profit' : 'Net earnings';

  return (
    <>
      {r && <p className="small muted">{metaLine(r)}</p>}
      {report.isError && <LoadError error={report.error} title="We couldn’t load your earnings" forbiddenHint="Earnings and profit need the permission to view balances. Ask the store owner if you need them." onRetry={() => void report.refetch()} />}
      <div className="sb-kpis">
        <KpiTile result={r} metricKey={M.netEarnings} label="Net earnings" note={compareNote(r)} />
        <KpiTile result={r} metricKey={M.profit} label="Profit" note={costs.note} blank={noCosts && addCosts} />
        <KpiTile result={r} metricKey={M.marginPct} label="Margin" note={costs.note} blank={noCosts && addCosts} />
        <KpiTile result={r} metricKey={M.paidOut} label="Paid out" />
      </div>
      <ChartFrame
        titleAs="h2"
        title={`${trendTitle} per ${grain}`}
        sub={noCosts ? 'What your sales left after refunds, fees and charges' : 'What your sales left after refunds, fees and charges, and after product cost'}
        loading={!r && !report.isError}
        refreshing={report.isPlaceholderData}
        empty={empty}
        table={seriesTable(view.trend.rows, view.trend.series, fmtMoney, { compareLabel: view.trend.compareLabel })}
      >
        <TrendChart rows={view.trend.rows} series={view.trend.series} fmt={fmtMoney} axisFmt={fmtMoneyCompact} compareLabel={view.trend.compareLabel} label={`${trendTitle} per ${grain}, ${range}`} />
      </ChartFrame>
      <div className="grid lg2 gap-5">
        <ChartFrame
          title={noCosts ? 'From item sales to net earnings' : 'From item sales to profit'}
          sub="Each amount for the whole period"
          loading={!r && !report.isError}
          refreshing={report.isPlaceholderData}
          empty={r && !view.waterfall.length ? 'No sales or charges in this period.' : empty}
          table={waterfallTable(view.waterfall, fmtMoney)}
        >
          <WaterfallChart steps={view.waterfall} fmt={fmtMoney} axisFmt={fmtMoneyCompact} label={`${noCosts ? 'From item sales to net earnings' : 'From item sales to net earnings and profit'}, ${range}`} />
        </ChartFrame>
        <ChartFrame
          title="Fees by type"
          sub="Marketplace fees, ads, services and labels you paid"
          loading={!r && !report.isError}
          refreshing={report.isPlaceholderData}
          empty={r && !view.fees.some((f) => f.value > 0) ? 'No fees in this period.' : false}
          table={donutTable(view.fees, fmtMoney, 'Fee')}
        >
          <DonutChart slices={view.fees} fmt={fmtMoney} totalLabel="Fees" label={`Fees by type, ${range}`} />
        </ChartFrame>
      </div>
      {comboLine && (
        <ChartFrame
          title={`Item sales and product cost per ${grain}`}
          sub="Bars in dollars; the margin line on the percentage scale at the right"
          loading={!r && !report.isError}
          refreshing={report.isPlaceholderData}
          empty={r && !hasCosts ? costsMissing : empty}
          table={seriesTable(view.combo.rows, view.combo.series, fmtMoney, { rightFmt: fmtPercent })}
        >
          <ComboChart rows={view.combo.rows} bars={comboBars} line={comboLine} fmt={fmtMoney} axisFmt={fmtMoneyCompact} label={`Item sales, product cost and margin per ${grain}, ${range}`} />
        </ChartFrame>
      )}
      <ReportCallouts result={r} />
      <ReportTableCard result={r} title={`Per ${grain}`} sub="Every amount of the report, with the period totals" label="Earnings and profit per period" />
    </>
  );
}
