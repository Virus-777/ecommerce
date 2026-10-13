// Data helpers for the Admin dashboard (design: pages/admin/admin-dashboard.html).
// Sources: GraphQL AdminDashboard (figures, sales split, ads, my approvals), REST workqueues/summary
// (needs-attention tiles, overdue dispatch, team on shift; the GraphQL workSummary answers empty lists),
// REST finance/payout-runs (next run; GraphQL nextPayoutRun fails on Money.formatted, G13/G37).
import type { components } from '@marketly/web-shared/api';

export type Range = 'today' | '7d' | '30d';

export const RANGES: Array<{ value: Range; label: string }> = [
  { value: 'today', label: 'Today' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
];

export const PERIOD: Record<Range, 'TODAY' | 'LAST_7_DAYS' | 'LAST_30_DAYS'> = { today: 'TODAY', '7d': 'LAST_7_DAYS', '30d': 'LAST_30_DAYS' };

interface GqlMoney {
  amount: number;
  currency: string;
}

export interface DashKpi {
  metricKey: string;
  label: string;
  display: string;
  unit: string;
  note: string | null;
  delta: { value: number; unit: string; direction: 'UP' | 'DOWN' | 'FLAT'; good: boolean | null } | null;
}

export interface DashAd {
  id: string;
  name: string;
  placementName: string | null;
  pagesLabel: string | null;
  periodLabel: string | null;
  budgetLabel: string | null;
  deliveryLabel: string | null;
  status: string;
}

/** The parts of the AdminDashboard screen query this page reads (workSummary and nextPayoutRun come from REST). */
export interface AdminDashboardData {
  adminDashboard: {
    period: string;
    from: string;
    to: string;
    asOf: string;
    basisLabel: string;
    currency: string;
    mayStillChange: boolean;
    kpis: DashKpi[];
    series: Array<{ key: string; label: string; unit: string; points: Array<{ date: string; label: string; value: number }>; total: { display: string } | null }>;
    split: Array<{ key: string; label: string; sharePct: number; amount: GqlMoney }>;
    unavailable: string[];
  } | null;
  adDashboard: { liveNow: { total: number }; startingIn7Days: number; live: DashAd[]; upcomingStarts: DashAd[] } | null;
  myApprovalSummary: { toDecide: number; overdue: number; dueSoon: number } | null;
}

/** workqueues.WorkSummary needsAttention rows (typed `unknown[]` in the OpenAPI document, G20). */
export interface AttentionRow {
  queueKey: string;
  name: string;
  areaLabel: string;
  count: number;
  overdue: number;
  tone: 'danger' | 'warning' | 'neutral';
  oldestLabel: string | null;
  screen: string | null;
  screenFilter: string | null;
}

export type WorkSummary = components['schemas']['workqueues.WorkSummary'];
export type WorkItem = components['schemas']['workqueues.WorkItem'];
export type PayoutRun = components['schemas']['finance.PayoutRun'];

/** Delta text as the design writes it: "4.1%" or "0.2 pts". */
export function deltaText(d: DashKpi['delta']): { text?: string; dir?: 'up' | 'down'; good?: boolean } {
  if (!d || d.direction === 'FLAT') return {};
  const unit = d.unit.toUpperCase();
  const v = Math.abs(d.value);
  const text = unit === 'PTS' || unit === 'POINTS' ? `${v} pts` : unit === 'PCT' ? `${v}%` : String(v);
  return { text, dir: d.direction === 'UP' ? 'up' : 'down', good: d.good ?? undefined };
}

/** Chart axis money in minor units: $1.08M, $36.7k, $820. */
export function compactMoney(minor: number): string {
  const d = minor / 100;
  if (Math.abs(d) >= 1_000_000) return `$${(d / 1_000_000).toFixed(2)}M`;
  if (Math.abs(d) >= 1000) return `$${(d / 1000).toFixed(1)}k`;
  return `$${Math.round(d)}`;
}

/** The next payout run: the earliest scheduled run that is not finished or cancelled. */
export function nextRun(runs: PayoutRun[]): PayoutRun | undefined {
  return runs
    .filter((r) => r.status !== 'completed' && r.status !== 'cancelled')
    .sort((a, b) => String(a.scheduledRelease ?? '').localeCompare(String(b.scheduledRelease ?? '')))[0];
}

/** The delivery exception an overdue-dispatch work item points at (used by Remind seller). */
export function exceptionOf(w: WorkItem): string | undefined {
  const rel = (w.relatedSubjects ?? []) as Array<{ type?: string; id?: string }>;
  return rel.find((s) => (s.type ?? '').toLowerCase() === 'delivery_exception')?.id;
}

/** Greeting by the Pacific hour. */
export function greeting(now = new Date()): string {
  const h = Number(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', hour12: false })) % 24;
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}
