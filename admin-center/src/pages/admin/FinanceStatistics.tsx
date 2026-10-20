import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { call, errorMessage, useApi } from '@marketly/web-shared/api';
import { AdminLayout } from '@marketly/web-shared/layouts';
import { useView } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import {
  Alert, BarsChart, Button, Card, ChartFrame, DonutChart, donutTable, EmptyState, Field, fmtCount, fmtCountCompact, fmtMoney, fmtMoneyCompact, Icon, PageHeader, PeriodControl, Select, seriesFromReport, seriesTable, Tabs,
  TrendChart, WaterfallChart, waterfallTable, announce, usePeriod, type ChartRow, type ChartSeries, type ReportSeriesPick,
} from '@marketly/web-shared/ui';
import { useStaffSession } from '@/app/session';
import { date, LoadError, shortDate } from '@/app/parts';
import { useReportExport } from './data/report-export';
import { Freshness, ReportExportDialog, ReportKpis, ReportNotices, ReportTableCard, type ExportFormat } from './data/report-parts';
import { metaOf, tableOf, type ReportQuery, type ReportResult } from './data/reports';
import { breakdownLabel, rankingOf, slicesOf, STATS_TABS, topSellersOf, waterfallOf, type StatsTab, type StatsView } from './data/finance-statistics';
import './FinanceStatistics.css';

// Financial statistics (admin/finance-statistics, docs/09 §4.3; designed in React, no design file). Three tabs,
// each one report of the reports module: Platform income (finance.platform_income), Seller money
// (finance.seller_money) and Official Store P&L (trading.pnl). A tab whose report needs a permission the staff
// member lacks is not shown. Every tab: the period control (URL state, shared by the tabs), headline KPIs with
// the change against the comparison period, a trend with the comparison drawn dashed, the breakdown charts, the
// period table and the export (the same background export as the report detail page).

const RANKING: ChartSeries[] = [{ key: 'amount', label: 'Fee income' }];
const GRAIN: Record<string, string> = { day: 'day', week: 'week', month: 'month' };

export default function FinanceStatistics() {
  const { can } = useStaffSession();
  const [view, setView] = useView<StatsView>();
  const tabs = STATS_TABS.filter((t) => can(t.permission));
  const tab = tabs.find((t) => t.view === view) ?? tabs[0];

  return (
    <AdminLayout active="finance-statistics">
      <PageHeader crumbs={[{ label: 'Admin', to: href('admin/dashboard') }, { label: 'Finance', to: href('admin/finance') }, { label: 'Financial statistics' }]} title="Financial statistics" sub="USD · Pacific Time · money in and out of the marketplace over time" />
      {tab ? (
        <>
          {tabs.length > 1 && (
            <div className="fst-tabs">
              <Tabs label="Statistics" items={tabs.map((t) => ({ label: t.label, value: t.view }))} active={tab.view} onChange={(v) => setView(v)} />
            </div>
          )}
          <StatsTabPage key={tab.report} tab={tab} />
        </>
      ) : (
        <Card pad>
          <EmptyState icon="lock" title="Your roles don’t include financial statistics" as="h2">
            Financial statistics need the marketplace finance or Official Store trading reports. A Platform Administrator can change your roles in Staff and permissions.
          </EmptyState>
        </Card>
      )}
    </AdminLayout>
  );
}

/** One tab: its controls, KPIs, charts, table and export. */
function StatsTabPage({ tab }: { tab: StatsTab }) {
  const { api } = useApi();
  const qc = useQueryClient();
  const { can } = useStaffSession();
  const period = usePeriod({ preset: 'last_30_days' });
  const [seller, setSeller] = useState('all');
  const [exportOpen, setExportOpen] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'success' | 'info'; title: string; body?: ReactNode } | null>(null);
  const exp = useReportExport();
  const sellerFilter = tab.report === 'finance.seller_money';

  const query = {
    // the new presets and comparisons (docs/09 §3.3) are not in the generated API types yet
    ...(period.query as ReportQuery),
    ...(sellerFilter && seller !== 'all' ? { sellerId: seller } : {}),
  } as ReportQuery;
  const result = useQuery({
    queryKey: ['reports', 'query', tab.report, query],
    queryFn: () => call(api.POST('/api/admin/reports/reports/{key}/query', { params: { path: { key: tab.report } }, body: query })) as Promise<ReportResult>,
    placeholderData: keepPreviousData,
  });
  const sellers = useQuery({
    queryKey: ['sellers', 'list', 'for-reports'],
    queryFn: () => call(api.GET('/api/admin/sellers/sellers', { params: { query: { limit: 100 } } as never })) as Promise<{ items: Array<{ id: string; storeName: string }> }>,
    enabled: sellerFilter,
    retry: false,
  });

  const res = result.data;
  const meta = res ? metaOf(res) : null;
  const range = meta?.range ?? period.range;
  const rangeText = `${date(range.from)} – ${date(range.to)}`;
  const cmp = meta?.compareRange;
  const cmpText = cmp ? `${shortDate(cmp.from)} – ${date(cmp.to)}` : '';
  const grain = GRAIN[meta?.granularity ?? period.grain] ?? 'day';
  const scope = sellerFilter && seller !== 'all' ? (sellers.data?.items.find((s) => s.id === seller)?.storeName ?? 'One seller') : '';
  const canExport = can('reports.exports.create');

  const runExport = async (format: ExportFormat) => {
    setExportOpen(false);
    setNotice({ tone: 'info', title: 'Export started', body: 'It runs in the background and downloads when it is ready, usually within a minute.' });
    announce('Export started in the background');
    const j = await exp.start(tab.report, query, format);
    void qc.invalidateQueries({ queryKey: ['reports', 'exports'] });
    const all = (
      <Link to={href('admin/report', '', { key: tab.report })} className="strong">
        All exports of this report
      </Link>
    );
    if (!j) return setNotice(null);
    if (j.state === 'ready') {
      announce('Export downloaded');
      setNotice({ tone: 'success', title: `Downloaded ${j.fileName ?? 'the export'}`, body: <>{(j.rowCount ?? 0).toLocaleString('en-US')} rows. The export is recorded in Action history. {all}</> });
    } else if (j.state === 'failed') setNotice(null);
    else setNotice({ tone: 'info', title: `Export ${j.ref} is still being prepared`, body: <>It will be listed with the report when it is ready. {all}</> });
  };

  const chartProps = { res, loading: !res && !result.error, refreshing: result.isPlaceholderData, rangeText, grain };

  return (
    <>
      <section className="card" aria-label="Period and filters">
        <div className="card-body stack gap-3">
          <p className="small sub fst-intro">{tab.intro}</p>
          <div className="fst-controls">
            <PeriodControl period={period} idPrefix="fs" />
            {sellerFilter && (
              <Field label="Seller">
                <Select id="fs-seller" ctl="sm" options={[{ value: 'all', label: 'All sellers' }, ...(sellers.data?.items ?? []).map((s) => ({ value: s.id, label: s.storeName }))]} value={seller} onChange={(e) => setSeller(e.target.value)} />
              </Field>
            )}
            {canExport && (
              <Button variant="secondary" size="sm" icon="download" className="fst-export" onClick={() => (exp.reset(), setExportOpen(true))} disabled={exp.busy || !res}>
                {exp.busy ? 'Exporting…' : 'Export'}
              </Button>
            )}
          </div>
          {meta && (
            <div className="panel xs sub rpd-scopeline">
              <span>
                <Icon name="info" />
                <span>
                  Showing <b>{rangeText}</b> by {grain}
                  {scope ? <>, {scope}</> : null}
                  {cmpText ? <>, compared with {cmpText}</> : null}.
                </span>
              </span>
              <Freshness at={meta.freshAsOf} short />
            </div>
          )}
        </div>
      </section>

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
      {result.error && <LoadError error={result.error} onRetry={() => void result.refetch()} title={`We couldn’t load ${tab.label}`} />}
      <ReportNotices res={res} />
      <ReportKpis res={res} keys={tab.kpis} compared={period.compare !== 'none'} cmpText={cmpText} error={!!result.error} skeletons={tab.kpis.length} />

      {!result.error && (
        <>
          {tab.report === 'finance.platform_income' && <PlatformCharts {...chartProps} />}
          {tab.report === 'finance.seller_money' && <SellerMoneyCharts {...chartProps} />}
          {tab.report === 'trading.pnl' && <TradingCharts {...chartProps} />}
          {res && tableOf(res) && (
            <ReportTableCard
              table={tableOf(res)!}
              title={sellerFilter ? 'Top 20 sellers by fee income' : `By ${grain}`}
              sub={`${rangeText}${sellerFilter ? ' · balances as of today' : ' · with totals'}`}
              label={`${tab.label} table`}
            />
          )}
        </>
      )}

      <ReportExportDialog open={exportOpen} onClose={() => setExportOpen(false)} title={tab.label} scope={`${rangeText} (inclusive) · Pacific Time${scope ? ` · ${scope}` : ''}`} busy={exp.busy} onStart={(f) => void runExport(f)} />
    </>
  );
}

/* ----- the charts of each tab ----- */

interface ChartProps {
  res?: ReportResult;
  loading: boolean;
  refreshing: boolean;
  rangeText: string;
  grain: string;
}

/** A trend of report series with their comparison twins, in a frame with the table toggle. */
function SeriesTrend({ res, loading, refreshing, title, sub, keys, fmt = fmtMoney, axisFmt = fmtMoneyCompact, label, titleAs }: Omit<ChartProps, 'rangeText' | 'grain'> & { title: string; sub: string; keys: Array<string | ReportSeriesPick>; fmt?: (v: number) => string; axisFmt?: (v: number) => string; label: string; titleAs?: 'h2' | 'h3' }) {
  const chart = seriesFromReport(res, keys);
  return (
    <ChartFrame titleAs={titleAs} title={title} sub={sub} loading={loading} refreshing={refreshing} empty={!loading && (chart.series.length === 0 || chart.rows.length === 0)} table={seriesTable(chart.rows, chart.series, fmt, { compareLabel: chart.compareLabel })}>
      <TrendChart rows={chart.rows} series={chart.series} fmt={fmt} axisFmt={axisFmt} compareLabel={chart.compareLabel} label={label} />
    </ChartFrame>
  );
}

/** The `waterfall` breakdown. */
function Waterfall({ res, loading, refreshing, title, sub }: Omit<ChartProps, 'rangeText' | 'grain'> & { title: string; sub: string }) {
  const steps = waterfallOf(res);
  return (
    <ChartFrame title={title} sub={sub} loading={loading} refreshing={refreshing} height={260} empty={!loading && steps.length === 0} table={waterfallTable(steps, fmtMoney)}>
      <WaterfallChart steps={steps} fmt={fmtMoney} axisFmt={fmtMoneyCompact} label={`${title}, ${sub}`} />
    </ChartFrame>
  );
}

/** A ranking (fee income by category or seller) as horizontal bars, largest at the top. */
function Ranking({ rows, loading, refreshing, title, sub, xLabel }: { rows: ChartRow[]; loading: boolean; refreshing: boolean; title: string; sub: string; xLabel: string }) {
  return (
    <ChartFrame title={title} sub={sub} loading={loading} refreshing={refreshing} empty={!loading && rows.length === 0} table={seriesTable(rows, RANKING, fmtMoney, { xLabel })}>
      <BarsChart rows={rows} series={RANKING} fmt={fmtMoney} axisFmt={fmtMoneyCompact} horizontal label={`${title}, ${sub}`} />
    </ChartFrame>
  );
}

function PlatformCharts({ res, loading, refreshing, rangeText, grain }: ChartProps) {
  const costs = slicesOf(res, 'costs_by_kind');
  return (
    <>
      <SeriesTrend
        res={res}
        loading={loading}
        refreshing={refreshing}
        titleAs="h2"
        title={`Net income by ${grain}`}
        sub={`${rangeText} · fee income after refunds, and what is left after costs and platform-funded discounts`}
        keys={[{ key: 'platform.net_income', label: 'Net income' }, { key: 'platform.fee_income_net', label: 'Fee income (net)' }]}
        label={`Net income and net fee income by ${grain}, ${rangeText}`}
      />
      <div className="grid lg2 gap-4">
        <Waterfall res={res} loading={loading} refreshing={refreshing} title="From fee income to company result" sub={rangeText} />
        <ChartFrame title="Platform costs by kind" sub={rangeText} loading={loading} refreshing={refreshing} empty={!loading && costs.every((c) => c.value <= 0)} table={donutTable(costs, fmtMoney, 'Cost')}>
          <DonutChart slices={costs} fmt={fmtMoney} totalLabel="Costs" label={`Platform costs by kind, ${rangeText}`} />
        </ChartFrame>
        <Ranking rows={rankingOf(res, 'fee_income_by_category')} loading={loading} refreshing={refreshing} title={breakdownLabel(res, 'fee_income_by_category', 'Fee income by category')} sub={`${rangeText} · by order date`} xLabel="Category" />
        <Ranking rows={rankingOf(res, 'fee_income_by_seller')} loading={loading} refreshing={refreshing} title="Top 10 sellers by fee income" sub={rangeText} xLabel="Seller" />
      </div>
    </>
  );
}

function SellerMoneyCharts({ res, loading, refreshing, rangeText, grain }: ChartProps) {
  const payouts = seriesFromReport(res, [
    { key: 'sellers.payouts_paid', label: 'Paid' },
    { key: 'sellers.payouts_failed', label: 'Failed' },
  ]);
  return (
    <>
      <SeriesTrend
        res={res}
        loading={loading}
        refreshing={refreshing}
        titleAs="h2"
        title="Money held for sellers"
        sub={`${rangeText} · end of each ${grain}`}
        keys={[{ key: 'sellers.owed', label: 'Owed to sellers' }, { key: 'sellers.held', label: 'On hold' }]}
        label={`Money owed to sellers and on hold at the end of each ${grain}, ${rangeText}`}
      />
      <div className="grid lg2 gap-4">
        <ChartFrame title={`Payouts by ${grain}`} sub={rangeText} loading={loading} refreshing={refreshing} empty={!loading && payouts.rows.length === 0} table={seriesTable(payouts.rows, payouts.series, fmtMoney, { compareLabel: payouts.compareLabel })}>
          <BarsChart rows={payouts.rows} series={payouts.series} fmt={fmtMoney} axisFmt={fmtMoneyCompact} compareLabel={payouts.compareLabel} label={`Payouts paid and failed by ${grain}, ${rangeText}`} />
        </ChartFrame>
        <SeriesTrend
          res={res}
          loading={loading}
          refreshing={refreshing}
          title="Owed by sellers"
          sub={`${rangeText} · negative balances at the end of each ${grain}`}
          keys={[{ key: 'sellers.negative', label: 'Owed by sellers' }]}
          label={`Money sellers owe Marketly at the end of each ${grain}, ${rangeText}`}
        />
        <SeriesTrend
          res={res}
          loading={loading}
          refreshing={refreshing}
          title="Sellers with a negative balance"
          sub={`${rangeText} · end of each ${grain}`}
          keys={[{ key: 'sellers.negative_count', label: 'Sellers' }]}
          fmt={fmtCount}
          axisFmt={fmtCountCompact}
          label={`Sellers with a negative balance at the end of each ${grain}, ${rangeText}`}
        />
        <Ranking rows={topSellersOf(res ? tableOf(res) : null)} loading={loading} refreshing={refreshing} title="Top 10 sellers by fee income" sub={rangeText} xLabel="Seller" />
      </div>
    </>
  );
}

/** Official Store costs after buying cost, stacked per period (buying cost would dwarf them; it is in the waterfall). */
const TRADING_COSTS: ReportSeriesPick[] = [
  { key: 'trading.discounts', label: 'Discounts' },
  { key: 'trading.shipping_expense', label: 'Shipping' },
  { key: 'trading.returns_cost', label: 'Returns' },
  { key: 'trading.write_offs', label: 'Write-offs' },
  { key: 'trading.chargeback_losses', label: 'Chargebacks' },
];

function TradingCharts({ res, loading, refreshing, rangeText, grain }: ChartProps) {
  // stacked bars draw no comparison, so the costs chart takes the current period only
  const costs = seriesFromReport(res, TRADING_COSTS);
  return (
    <>
      <SeriesTrend
        res={res}
        loading={loading}
        refreshing={refreshing}
        titleAs="h2"
        title={`Sales and net margin by ${grain}`}
        sub={`${rangeText} · Official Store only`}
        keys={[{ key: 'trading.official_sales', label: 'Sales' }, { key: 'trading.net_margin', label: 'Net margin' }]}
        label={`Official Store sales and net margin by ${grain}, ${rangeText}`}
      />
      <div className="grid lg2 gap-4">
        <Waterfall res={res} loading={loading} refreshing={refreshing} title="From sales to net margin" sub={rangeText} />
        <ChartFrame title={`Costs after buying cost, by ${grain}`} sub={rangeText} loading={loading} refreshing={refreshing} empty={!loading && costs.rows.length === 0} table={seriesTable(costs.rows, costs.series, fmtMoney)}>
          <BarsChart rows={costs.rows} series={costs.series} fmt={fmtMoney} axisFmt={fmtMoneyCompact} stacked label={`Official Store costs after buying cost by ${grain}, ${rangeText}`} />
        </ChartFrame>
      </div>
    </>
  );
}
