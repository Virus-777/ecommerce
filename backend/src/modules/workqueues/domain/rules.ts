/**
 * Pure rules of work queues: deadline states, labels, escalation routes and their conditions,
 * coverage gaps and the small parsers used by filters. No I/O.
 */
import type { CoverageGap, EscalationStep } from '../../../spec/workqueues.js';
import { isPlaceholder, roleLabel } from './catalog.js';

export type DeadlineState = 'on_time' | 'due_soon' | 'overdue';

export function deadlineState(dueAt: Date, now: Date, dueSoonMinutes: number): DeadlineState {
  const left = dueAt.getTime() - now.getTime();
  if (left <= 0) return 'overdue';
  if (left <= dueSoonMinutes * 60_000) return 'due_soon';
  return 'on_time';
}

/** Short age, e.g. 16 d, 5 h, 12 min */
export function ageLabel(from: Date, now: Date): string {
  const mins = Math.max(0, Math.floor((now.getTime() - from.getTime()) / 60_000));
  if (mins >= 1440) return `${Math.floor(mins / 1440)} d`;
  if (mins >= 60) return `${Math.floor(mins / 60)} h`;
  return `${mins} min`;
}

/** Tile wording, e.g. oldest 2 days */
export function oldestLabel(from: Date, now: Date): string {
  const mins = Math.max(0, Math.floor((now.getTime() - from.getTime()) / 60_000));
  const n = mins >= 1440 ? Math.floor(mins / 1440) : mins >= 60 ? Math.floor(mins / 60) : mins;
  const unit = mins >= 1440 ? 'day' : mins >= 60 ? 'hour' : 'minute';
  return `oldest ${n} ${unit}${n === 1 ? '' : 's'}`;
}

/** 2880 → 48 h, 90 → 90 min, 43200 → 30 d */
export function durationLabel(minutes: number): string {
  if (minutes >= 1440 && minutes % 1440 === 0 && minutes > 2880) return `${minutes / 1440} d`;
  if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60} h`;
  return `${minutes} min`;
}

/** 24h, 90m, 2d, 1h30m or plain minutes → minutes (null when unreadable) */
export function parseDuration(s: string | number | null | undefined): number | null {
  if (s === null || s === undefined || s === '') return null;
  if (typeof s === 'number') return Number.isFinite(s) && s >= 0 ? Math.floor(s) : null;
  const t = s.trim().toLowerCase().replace(/\s+/g, '');
  if (/^\d+$/.test(t)) return Number(t);
  const re = /(\d+(?:\.\d+)?)(d|h|m|min)/g;
  let total = 0;
  let consumed = 0;
  for (const m of t.matchAll(re)) {
    const n = Number(m[1]);
    total += m[2] === 'd' ? n * 1440 : m[2] === 'h' ? n * 60 : n;
    consumed += m[0].length;
  }
  return consumed === t.length && consumed > 0 ? Math.floor(total) : null;
}

/* ---------------------------------------------------------------- escalation routes */

export interface StepTarget {
  kind: 'role' | 'staff';
  /** role key or staff id */
  id: string;
  name: string;
}

/** The `to` of a step: { kind: role|staff, key or staffId, name } */
export function stepTarget(step: EscalationStep): StepTarget | null {
  const to = step.to as { kind?: unknown; key?: unknown; staffId?: unknown; id?: unknown; name?: unknown } | null | undefined;
  if (!to || typeof to !== 'object') return null;
  if (to.kind === 'role' && typeof to.key === 'string' && to.key) return { kind: 'role', id: to.key, name: typeof to.name === 'string' && to.name ? to.name : roleLabel(to.key) };
  const staffId = typeof to.staffId === 'string' ? to.staffId : typeof to.id === 'string' ? to.id : null;
  if (to.kind === 'staff' && staffId) return { kind: 'staff', id: staffId, name: typeof to.name === 'string' && to.name ? to.name : 'Staff member' };
  return null;
}

/** e.g. Seller Manager (seller items only), Order Manager after 4 h, Business Owner after 48 h */
export function escalationLabel(route: EscalationStep[]): string {
  if (!route.length) return 'No escalation route';
  return [...route]
    .sort((a, b) => a.afterMinutes - b.afterMinutes)
    .map((s) => {
      const t = stepTarget(s);
      const name = t?.name ?? 'Unknown';
      const when = s.afterMinutes > 0 ? ` after ${durationLabel(s.afterMinutes)}` : '';
      const cond = s.condition ? ` (${s.condition})` : '';
      return `${name}${cond}${when}`;
    })
    .join(', ');
}

/** Problems with a route given by an admin (VALIDATION_FAILED issues) */
export function routeIssues(route: unknown): { path: string; message: string }[] {
  if (!Array.isArray(route) || !route.length) return [{ path: 'escalationRoute', message: 'needs at least one step' }];
  const issues: { path: string; message: string }[] = [];
  route.forEach((s: EscalationStep, i) => {
    if (!Number.isInteger(s.afterMinutes) || s.afterMinutes < 0) issues.push({ path: `escalationRoute.${i}.afterMinutes`, message: 'must be 0 or more minutes' });
    if (!stepTarget(s)) issues.push({ path: `escalationRoute.${i}.to`, message: 'needs { kind: role, key } or { kind: staff, staffId }' });
  });
  return issues;
}

export interface ConditionSubject {
  sellerId: string | null;
  amountMinor: number | null;
  priority: string;
}

/**
 * Whether a step's optional condition applies to an item. Understood: 'seller items only',
 * 'official store only', 'amount over $1,000', 'urgent only' / 'high priority'. Anything else applies.
 */
export function conditionApplies(condition: string | null | undefined, item: ConditionSubject): boolean {
  if (!condition) return true;
  const c = condition.toLowerCase();
  if (/seller items?/.test(c)) return Boolean(item.sellerId);
  if (/official/.test(c)) return !item.sellerId;
  const amount = /amount (?:over|above|more than)\s*\$?\s*([\d,]+(?:\.\d+)?)/.exec(c);
  if (amount) return (item.amountMinor ?? 0) > Math.round(Number(amount[1]!.replace(/,/g, '')) * 100);
  if (/urgent/.test(c)) return item.priority === 'urgent';
  if (/high priority/.test(c)) return item.priority === 'high' || item.priority === 'urgent';
  return true;
}

/** Steps in order (stable on afterMinutes) */
export const sortedRoute = (route: EscalationStep[]) => route.map((s, i) => ({ s, i })).sort((a, b) => a.s.afterMinutes - b.s.afterMinutes || a.i - b.i).map((x) => x.s);

/**
 * The next step after `level` (1-based levels; 0 = not escalated) whose condition applies.
 * `dueBy` limits to steps already reached `overdueMinutes` after the deadline (sweep); without it the
 * next applicable step regardless of time (manual escalation).
 */
export function nextStep(route: EscalationStep[], level: number, item: ConditionSubject, overdueMinutes?: number): { step: EscalationStep; level: number } | null {
  const steps = sortedRoute(route);
  for (let i = level; i < steps.length; i++) {
    const s = steps[i]!;
    if (overdueMinutes !== undefined && s.afterMinutes > overdueMinutes) return null;
    if (conditionApplies(s.condition, item) && stepTarget(s)) return { step: s, level: i + 1 };
  }
  return null;
}

/* ---------------------------------------------------------------- coverage gaps */

export interface CoverageQueue {
  key: string;
  name: string;
  leadId: string;
  backupId: string;
  active: boolean;
}

export interface StaffState {
  known: boolean;
  away: boolean;
  name: string;
}

/** Busiest backups: one person backing up more than this many queues is a gap */
export const SAME_BACKUP_LIMIT = 3;

export function coverageGaps(queues: CoverageQueue[], staff: Map<string, StaffState>): CoverageGap[] {
  const gaps: CoverageGap[] = [];
  const active = queues.filter((q) => q.active);
  const backups = new Map<string, CoverageQueue[]>();
  for (const q of active) {
    const lead = staff.get(q.leadId);
    const backup = staff.get(q.backupId);
    const noLead = isPlaceholder(q.leadId) || !lead?.known;
    const noBackup = isPlaceholder(q.backupId) || !backup?.known;
    if (noLead) gaps.push({ queueKey: q.key, queueName: q.name, problem: 'no_lead', detail: isPlaceholder(q.leadId) ? 'The lead is still the install placeholder; name a lead before launch' : 'The lead is not a known staff member' });
    if (noBackup) gaps.push({ queueKey: q.key, queueName: q.name, problem: 'no_backup', detail: isPlaceholder(q.backupId) ? 'The backup is still the install placeholder; name a backup before launch' : 'The backup is not a known staff member' });
    if (q.leadId === q.backupId) gaps.push({ queueKey: q.key, queueName: q.name, problem: 'lead_is_backup', detail: 'The backup must be a different person from the lead' });
    if (!noLead && lead?.away && (noBackup || backup?.away)) gaps.push({ queueKey: q.key, queueName: q.name, problem: 'lead_away_no_cover', detail: `${lead.name} is away and ${noBackup ? 'no backup is set' : `the backup ${backup!.name} is away too`}` });
    if (!noBackup) backups.set(q.backupId, [...(backups.get(q.backupId) ?? []), q]);
  }
  for (const [id, list] of backups) {
    if (list.length <= SAME_BACKUP_LIMIT) continue;
    const name = staff.get(id)?.name ?? 'One person';
    for (const q of list) gaps.push({ queueKey: q.key, queueName: q.name, problem: 'same_backup_for_many', detail: `${name} backs up ${list.length} queues` });
  }
  return gaps;
}

/* ---------------------------------------------------------------- dates */

/** ISO weekday (1 = Monday … 7 = Sunday) of a YYYY-MM-DD date */
export function isoWeekday(date: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return wd === 0 ? 7 : wd;
}

/** Template weekdays may use ISO 1–7 or 0 for Sunday */
export const runsOn = (weekdays: number[], date: string) => {
  const wd = isoWeekday(date);
  return weekdays.includes(wd) || (wd === 7 && weekdays.includes(0));
};

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** A date as YYYY-MM-DD, from a date column (text) or a Date */
export const dateText = (v: unknown): string => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

export const isHhMm = (s: unknown): s is string => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

/** Lower-case slug for derived queue keys */
export const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48) || 'queue';

/** Median of a list (null when empty) */
export function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}
