import {
  BarsChart, ChartFrame, ComboChart, DonutChart, donutTable, fmtMoney, fmtMoneyCompact, PeriodControl, seriesTable, ShareBar, TrendChart, usePeriod, WaterfallChart, waterfallTable,
} from '@marketly/web-shared/ui';
import { DEMO_COMBO, DEMO_FEES, DEMO_RANKING, DEMO_TREND, DEMO_WATERFALL } from './data/charts-demo';

// Chart gallery of the design components page: every shared chart (web-shared/src/ui/charts) and the period
// control, on sample data, so they can be checked in light and dark mode and at phone width.

const TREND = [
  { key: 'official', label: 'Official Store' },
  { key: 'sellers', label: 'Marketplace sellers' },
];
const COMBO_BARS = [
  { key: 'cost', label: 'Product cost' },
  { key: 'profit', label: 'Profit' },
];
const MARGIN = { key: 'margin', label: 'Margin', axis: 'right' as const };
const RANKING = [{ key: 'profit', label: 'Profit' }];

export function ChartsDemo() {
  const period = usePeriod();
  return (
    <div className="stack gap-4">
      <div className="card pad stack gap-2">
        <PeriodControl period={period} idPrefix="demo" />
        <code className="xs muted">{JSON.stringify(period.query)}</code>
      </div>
      <div className="grid lg2 gap-4">
        <ChartFrame title="Daily sales" sub="TrendChart · two series, the Official Store compared with the period before" table={seriesTable(DEMO_TREND, TREND, fmtMoney, { compareLabel: 'Sep 11 – Sep 24' })}>
          <TrendChart rows={DEMO_TREND} series={TREND} fmt={fmtMoney} axisFmt={fmtMoneyCompact} compareLabel="Sep 11 – Sep 24" label="Daily sales, Official Store and sellers, Sep 25 to Oct 8" />
        </ChartFrame>
        <ChartFrame title="Costs and profit per week" sub="ComboChart · bars and the margin line on a % axis" table={seriesTable(DEMO_COMBO, [...COMBO_BARS, MARGIN], fmtMoney, { xLabel: 'Week of', rightFmt: (v) => `${v.toFixed(1)}%` })}>
          <ComboChart rows={DEMO_COMBO} bars={COMBO_BARS} line={MARGIN} fmt={fmtMoney} axisFmt={fmtMoneyCompact} label="Product cost and profit per week with margin" />
        </ChartFrame>
        <ChartFrame title="Item sales to profit" sub="WaterfallChart · from a waterfall breakdown" table={waterfallTable(DEMO_WATERFALL, fmtMoney)}>
          <WaterfallChart steps={DEMO_WATERFALL} fmt={fmtMoney} axisFmt={fmtMoneyCompact} label="Item sales to profit, October" />
        </ChartFrame>
        <ChartFrame title="Fees by type" sub="DonutChart · eight kinds folded to six slices" table={donutTable(DEMO_FEES, fmtMoney, 'Fee')}>
          <DonutChart slices={DEMO_FEES} fmt={fmtMoney} totalLabel="Fees" label="Fees by type, October" />
        </ChartFrame>
        <ChartFrame title="Profit by product" sub="BarsChart · horizontal ranking with a loss" table={seriesTable(DEMO_RANKING, RANKING, fmtMoney, { xLabel: 'Product' })}>
          <BarsChart rows={DEMO_RANKING} series={RANKING} fmt={fmtMoney} axisFmt={fmtMoneyCompact} horizontal label="Profit by product, October" />
        </ChartFrame>
        <ChartFrame title="Sales per day, stacked" sub="BarsChart · stacked; the loading and empty states below" table={seriesTable(DEMO_TREND, TREND, fmtMoney)}>
          <BarsChart rows={DEMO_TREND} series={TREND} fmt={fmtMoney} axisFmt={fmtMoneyCompact} stacked label="Daily sales stacked, Sep 25 to Oct 8" />
        </ChartFrame>
        <ChartFrame title="Loading" loading height={160}>
          {null}
        </ChartFrame>
        <ChartFrame title="Nothing to show" empty>
          {null}
        </ChartFrame>
      </div>
      <div className="card pad">
        <ShareBar
          label="Share of sales"
          parts={[
            { key: 'official', label: 'Official Store', pct: 58.4, value: '$140.2k' },
            { key: 'sellers', label: 'Marketplace sellers', pct: 41.6, value: '$99.8k' },
          ]}
        />
      </div>
    </div>
  );
}
