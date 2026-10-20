// Financial statistics (admin/finance-statistics, docs/09 §4.3): the three tabs and the report each one reads
// (POST /api/admin/reports/reports/{key}/query), and helpers that turn a report's breakdowns into chart input.
// The report, KPI, series and breakdown keys are the ones docs/09 §3.3 defines.
import { rowsFrom, type ChartRow, type DonutSlice, type WaterfallStepInput } from '@marketly/web-shared/ui';
import { breakdownsOf, type ReportResult, type TableSpec } from './reports';

export type StatsView = '' | 'seller-money' | 'official-store';

export interface StatsTab {
  view: StatsView;
  label: string;
  /** Report key in the reports catalogue. */
  report: string;
  /** The permission the report needs; the tab is hidden without it. */
  permission: string;
  /** What the tab answers, under the tabs. */
  intro: string;
  /** Headline KPIs in this order (the rest are in the table). */
  kpis: string[];
}

export const STATS_TABS: StatsTab[] = [
  {
    view: '',
    label: 'Platform income',
    report: 'finance.platform_income',
    permission: 'reports.marketplace-finance.view',
    intro: 'What the marketplace earns (fees, ads, service fees and labels) less platform costs and platform-funded discounts, by booking date.',
    kpis: ['platform.fee_income_net', 'platform.ad_income', 'platform.service_fees', 'platform.costs', 'platform.net_income', 'platform.official_net_margin', 'platform.company_result', 'platform.discount_funding'],
  },
  {
    view: 'seller-money',
    label: 'Seller money',
    report: 'finance.seller_money',
    permission: 'reports.marketplace-finance.view',
    intro: 'Money Marketly holds for sellers at the end of each day, what sellers owe, and the payouts in the period. Seller money is not company income.',
    kpis: ['sellers.owed', 'sellers.held', 'sellers.negative', 'sellers.negative_count', 'sellers.payouts_paid', 'sellers.payouts_failed'],
  },
  {
    view: 'official-store',
    label: 'Official Store P&L',
    report: 'trading.pnl',
    permission: 'reports.trading.view',
    intro: 'Official Store sales less the cost of the goods sold, shipping, returns, write-offs and chargeback losses, plus supplier credits. Discounts are shown for reference (sales are already after them); stock bought from suppliers is shown on its own, not as a cost of sales.',
    // the second row holds the two figures shown but not taken off the margin
    kpis: ['trading.official_sales', 'trading.gross_margin', 'trading.net_margin', 'trading.net_margin_pct', 'trading.discounts', 'trading.stock_bought'],
  },
];

/** Cents from a Money object or a plain number (breakdown rows and table cells carry either). */
export function minor(v: unknown): number {
  if (typeof v === 'number') return v;
  if (v && typeof v === 'object' && 'amount' in v && typeof (v as { amount: unknown }).amount === 'number') return (v as { amount: number }).amount;
  return 0;
}

const breakdown = (res: ReportResult | undefined, key: string) => (res ? breakdownsOf(res).find((b) => b.key === key) : undefined);

/** The `waterfall` breakdown as WaterfallChart steps; [] when the result has none. */
export function waterfallOf(res: ReportResult | undefined): WaterfallStepInput[] {
  return (breakdown(res, 'waterfall')?.rows ?? []).map((r) => ({ key: r.key, label: r.label, amount: minor(r.amount), step: (r.step as WaterfallStepInput['step']) ?? 'minus' }));
}

/** A money breakdown (costs by kind) as donut slices. */
export function slicesOf(res: ReportResult | undefined, key: string): DonutSlice[] {
  return (breakdown(res, key)?.rows ?? []).map((r) => ({ key: r.key, label: r.label, value: minor(r.amount) }));
}

/** A money breakdown (fee income by category or seller) as ranking rows, largest first, at most `top`. */
export function rankingOf(res: ReportResult | undefined, key: string, top = 10): ChartRow[] {
  const rows = [...(breakdown(res, key)?.rows ?? [])].sort((a, b) => minor(b.amount) - minor(a.amount)).slice(0, top);
  return rowsFrom(
    rows.map((r) => r.label),
    { amount: rows.map((r) => minor(r.amount)) },
    rows.map((r) => r.key),
  );
}

/** The label a breakdown has in the result (falls back to `fallback`). */
export const breakdownLabel = (res: ReportResult | undefined, key: string, fallback: string) => breakdown(res, key)?.label ?? fallback;

/**
 * Seller money: the top sellers by fee income, from the report's seller table (its fee column is the first money
 * column whose key mentions fees). Largest first, at most `top`.
 */
export function topSellersOf(table: TableSpec | null, top = 10): ChartRow[] {
  if (!table) return [];
  const fee = table.columns.find((c) => c.unit === 'money' && /fee/i.test(c.key));
  const name = table.columns.find((c) => c.unit !== 'money' && c.align !== 'right');
  if (!fee || !name) return [];
  const rows = [...table.rows].sort((a, b) => minor(b[fee.key]) - minor(a[fee.key])).slice(0, top);
  return rowsFrom(
    rows.map((r) => String(r[name.key] ?? '')),
    { amount: rows.map((r) => minor(r[fee.key])) },
    rows.map((r, i) => String(r.sellerId ?? i)),
  );
}
