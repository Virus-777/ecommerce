import type { components } from '@marketly/web-shared/api';
import type { MoneyValue } from '@marketly/web-shared/lib/format';

// Seller reports (seller/reports): the report queries the screen runs and local types for the parts of
// reports.ReportResult the OpenAPI types as `unknown` (meta, table, breakdowns, KPI delta).
// API: POST /api/seller/reports/reports/{key}/query (docs/api/modules/reports.md, Seller API).

export type Period = '7d' | '30d' | '90d';
export type ReportQuery = components['schemas']['reports.ReportQuery'];
export type ReportResult = components['schemas']['reports.ReportResult'];
export type Kpi = components['schemas']['reports.KpiValue'];
export type PerformanceMetric = components['schemas']['sellers.PerformanceMetric'];

export const PERIODS: Array<{ label: string; value: Period; preset: NonNullable<ReportQuery['preset']>; days: number }> = [
  { label: '7 days', value: '7d', preset: 'last_7_days', days: 7 },
  { label: '30 days', value: '30d', preset: 'last_30_days', days: 30 },
  { label: '90 days', value: '90d', preset: 'last_90_days', days: 90 },
];

/** Seller report keys (GET /api/seller/reports/catalogue). */
export const REPORT = {
  trend: 'seller.order_trend',
  products: 'seller.product_sales',
  returns: 'seller.returns_by_reason',
} as const;

export interface ReportMeta {
  reportKey: string;
  title: string;
  range: { from: string; to: string };
  dateBasis: string;
  dateBasisLabel?: string;
  currency: string;
  timeZone: string;
  freshAsOf?: string | null;
  mayStillChange?: boolean;
  compareRange?: { from: string; to: string } | null;
  granularity?: 'day' | 'week' | 'month';
}

export interface KpiDelta {
  value: number;
  unit: 'pct' | 'pts';
  direction: 'up' | 'down' | 'flat';
  good: boolean;
}

export interface ProductSalesRow {
  productId: string;
  product: string;
  units: number;
  orders: number;
  gross: MoneyValue;
  cancelled: MoneyValue;
  refunded: MoneyValue;
}

export interface ReturnsProductRow {
  productId: string;
  product: string;
  requests: number;
  units: number;
}

export interface Breakdown {
  key: string;
  label: string;
  rows: Array<{ key: string | null; label: string; requests: number; units?: number; sharePct: number }>;
}

export interface Table<R> {
  columns: Array<{ key: string; label: string; unit: string; align: string }>;
  rows: R[];
  totals: Record<string, unknown>;
}

export const metaOf = (r?: ReportResult) => r?.meta as ReportMeta | undefined;
export const tableOf = <R>(r?: ReportResult) => (r?.table ?? null) as Table<R> | null;
export const breakdownsOf = (r?: ReportResult) => (r?.breakdowns ?? []) as Breakdown[];
export const kpiOf = (r: ReportResult | undefined, key: string) => r?.kpis.find((k) => k.metricKey === key);
export const deltaOf = (k?: Kpi) => (k?.delta ?? null) as KpiDelta | null;

/** Stat delta props from a KPI delta: "6.1%" / "0.6 pts", direction and whether it is good. */
export function statDelta(k?: Kpi) {
  const d = deltaOf(k);
  if (!d || d.direction === 'flat') return {};
  const v = Math.abs(d.value);
  return { delta: d.unit === 'pts' ? `${v.toFixed(1)} pts` : `${v.toFixed(1)}%`, dir: d.direction, good: d.good } as const;
}

/** The four service metrics the design shows, in its order (GET /api/seller/sellers/performance). */
export const SERVICE_KEYS: Array<PerformanceMetric['key']> = ['dispatch_reliability', 'cancellation_rate', 'response_time', 'valid_tracking'];

/** Meter fill: the value for "at least" rates; the value's share of the limit for "at most" targets (capped). */
export function meterPct(m: PerformanceMetric): number {
  const t = m.target;
  if (t.comparator === 'gte') return Math.max(0, Math.min(100, m.value));
  if (!t.threshold) return m.value > 0 ? 100 : 0;
  return Math.max(0, Math.min(100, (m.value / t.threshold) * 100));
}

/** "Pacific Time" for the market time zone. */
export const zoneLabel = (tz?: string) => (tz === 'America/Los_Angeles' ? 'Pacific Time' : (tz ?? ''));
