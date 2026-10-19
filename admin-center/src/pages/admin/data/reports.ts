// Helpers for the report library (admin/reports, design: pages/admin/admin-reports.html) and the report detail
// (admin/report, designed in React): API types from the reports module, group icons, presets, value formatting
// and the export download helper. Figures come from POST /api/admin/reports/reports/{key}/query.
import type { components } from '@marketly/web-shared/api';
import { formatMoney } from '@marketly/web-shared/lib/format';
import type { IconName } from '@marketly/web-shared/ui';

type S = components['schemas'];
export type ReportGroup = S['reports.ReportGroup'];
export type ReportDefinition = S['reports.ReportDefinition'];
export type MetricDefinition = S['reports.MetricDefinition'];
export type ReportQuery = S['reports.ReportQuery'];
export type ReportResult = S['reports.ReportResult'];
export type KpiValue = S['reports.KpiValue'];
export type ExportJob = S['reports.ExportJob'];
export type AdminDashboard = S['reports.AdminDashboard'];

export const GROUP_ICON: Record<string, IconName> = {
  commerce: 'shopping-bag',
  company_trading: 'badge-check',
  marketplace_finance: 'landmark',
  products_discovery: 'package',
  service_sellers: 'store',
  customers_marketing_ads: 'megaphone',
};
export const groupIcon = (k: string): IconName => GROUP_ICON[k] ?? 'file-chart-column';

/** "Owner: Priya Nair, Finance Manager" or the role expected while nobody is named. */
export const ownerLabel = (g: Pick<ReportGroup, 'owner' | 'ownerRole'>) => (g.owner ? `${g.owner.name}, ${g.owner.role}` : `${g.ownerRole} (no one named yet)`);

export type Preset = NonNullable<ReportQuery['preset']>;
export const PRESETS: Array<{ value: Preset; label: string }> = [
  { value: 'today', label: 'Today' },
  { value: 'last_7_days', label: 'Last 7 days' },
  { value: 'last_14_days', label: 'Last 14 days' },
  { value: 'last_30_days', label: 'Last 30 days' },
  { value: 'last_90_days', label: 'Last 90 days' },
  { value: 'month_to_date', label: 'Month to date' },
];
export const DATE_BASIS: Record<string, string> = { placement: 'Order placement date', payment: 'Payment date', shipment: 'Shipment date', completion: 'Completion date' };
export const SOLD_BY: Record<string, string> = { all: 'Official Store and sellers', official: 'Official Store only', marketplace: 'Marketplace sellers only' };

export interface Money { amount: number; currency: string }
const isMoney = (v: unknown): v is Money => !!v && typeof v === 'object' && 'amount' in (v as object) && 'currency' in (v as object);

/** A table cell or series value by the column's unit. */
export function fmtCell(v: unknown, unit: string): string {
  if (v === null || v === undefined) return '—';
  if (isMoney(v)) return formatMoney(v);
  if (typeof v === 'number') {
    if (unit === 'money') return formatMoney({ amount: v, currency: 'USD' });
    if (unit === 'percent') return `${v.toFixed(1)}%`;
    if (unit === 'duration_hours' || unit === 'hours') return `${v.toLocaleString('en-US', { maximumFractionDigits: 1 })} h`;
    if (unit === 'days') return `${v.toLocaleString('en-US', { maximumFractionDigits: 1 })} days`;
    if (unit === 'ratio') return v.toFixed(2);
    return v.toLocaleString('en-US');
  }
  return String(v);
}
/** Number behind a cell (money in dollars), for CSV and charts. */
export const cellNumber = (v: unknown): number => (isMoney(v) ? v.amount / 100 : typeof v === 'number' ? v : 0);

export interface TableSpec {
  columns: Array<{ key: string; label: string; unit: string; align?: string }>;
  rows: Array<Record<string, unknown>>;
  totals?: Record<string, unknown> | null;
}
export const tableOf = (r: ReportResult): TableSpec | null => (r.table as TableSpec | null | undefined) ?? null;

export interface Breakdown { key: string; label: string; rows: Array<Record<string, unknown> & { key: string; label: string; sharePct?: number }> }
export const breakdownsOf = (r: ReportResult): Breakdown[] => (r.breakdowns ?? []) as unknown as Breakdown[];
export interface Point { x: string; y: number; label?: string }
export const pointsOf = (s: ReportResult['series'][number]) => s.points as unknown as Point[];
export interface Callout { kind: 'info' | 'warning'; title: string; body: string }
export const calloutsOf = (r: ReportResult) => (r.callouts ?? []) as unknown as Callout[];
export interface SplitPart { key: string; label: string; amount: Money; sharePct: number }
export const splitOf = (r: ReportResult) => (r.split ?? []) as unknown as SplitPart[];
export interface Delta { value: number; unit: 'pct' | 'pts'; direction: 'up' | 'down' | 'flat'; good: boolean }
export const deltaOf = (k: KpiValue) => (k.delta ?? null) as Delta | null;
export interface Meta { range: { from: string; to: string }; dateBasis?: string; dateBasisLabel?: string; freshAsOf?: string; mayStillChange?: boolean; compareRange?: { from: string; to: string } | null; definitionsVersion?: Record<string, number>; taxIncluded?: boolean; granularity?: string }
export const metaOf = (r: ReportResult) => r.meta as unknown as Meta;

/** Signed links point at the API origin; the dev servers proxy /files, so use the path on this origin. */
export function localLink(u: string | null | undefined): string | undefined {
  if (!u) return undefined;
  try {
    const x = new URL(u);
    return x.pathname.startsWith('/files/') ? `${x.pathname}${x.search}` : u;
  } catch {
    return u;
  }
}

/** "2 h ago" from an ISO time. */
export function ago(iso?: string | null): string {
  if (!iso) return '';
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}
