// Data helpers for the Admin dashboard (design: pages/admin/admin-dashboard.html).
// Source: GraphQL AdminDashboard: figures, sales split, ads, my approvals, the work summary (needs-attention tiles,
// overdue dispatch, team on shift; it honours the caller's permissions) and the next payout run.

export type Range = 'today' | '7d' | '30d';

export const RANGES: Array<{ value: Range; label: string }> = [
  { value: 'today', label: 'Today' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
];

export const PERIOD: Record<Range, 'TODAY' | 'LAST_7_DAYS' | 'LAST_30_DAYS'> = { today: 'TODAY', '7d': 'LAST_7_DAYS', '30d': 'LAST_30_DAYS' };

export interface GqlMoney {
  amount: number;
  currency: string;
  formatted?: string | null;
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

/** workSummary.needsAttention rows. */
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

/** workSummary.overdueDispatch rows (GraphQL spells enum values in capitals). */
export interface WorkItem {
  id: string;
  title: string;
  summary: string | null;
  subject: { type: string; id: string; ref: string | null } | null;
  relatedSubjects: Array<{ type: string; id: string }> | null;
  sellerName: string | null;
  deadline: { dueAt: string; state: string } | null;
  ownerRole: string | null;
  assignee: { name: string | null; role: string | null } | null;
  waitingOn: string | null;
}

/** workSummary.team rows. */
export interface TeamRow {
  staff: { staffId: string; name: string; role: string | null };
  area: string;
  role: string;
  coveringFor: { name: string | null } | null;
  status: string;
}

export interface WorkSummary {
  generatedAt: string;
  needsAttention: AttentionRow[];
  overdueDispatch: WorkItem[];
  team: TeamRow[];
}

/** nextPayoutRun (null when no run is open or the caller can't see payouts). */
export interface NextPayoutRun {
  id: string;
  ref: string;
  status: string;
  scheduledRelease: string | null;
  total: GqlMoney;
  sellerCount: number;
  readyCount: number;
  heldCount: number;
  failedLastRun: number;
  approval: { required: boolean; reason: string | null } | null;
}

/** The parts of the AdminDashboard screen query this page reads. */
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
  workSummary: WorkSummary | null;
  adDashboard: { liveNow: { total: number }; startingIn7Days: number; live: DashAd[]; upcomingStarts: DashAd[] } | null;
  nextPayoutRun: NextPayoutRun | null;
  myApprovalSummary: { toDecide: number; overdue: number; dueSoon: number } | null;
}

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

/** Server-formatted money, else formatted here. */
export const moneyText = (m: GqlMoney, fallback: (m: GqlMoney) => string) => m.formatted ?? fallback(m);

/** The delivery exception an overdue-dispatch work item points at (used by Remind seller). */
export function exceptionOf(w: WorkItem): string | undefined {
  return (w.relatedSubjects ?? []).find((s) => (s.type ?? '').toLowerCase() === 'delivery_exception')?.id;
}

/** Greeting by the Pacific hour. */
export function greeting(now = new Date()): string {
  const h = Number(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', hour12: false })) % 24;
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}
