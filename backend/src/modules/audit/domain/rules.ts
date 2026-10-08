/** Pure rules of the action history: approval column, retention changes, purge window, seller view. */
import type { Actor, TimelineEvent } from '../../../spec/common.js';
import type { AuditApproval, AuditEntry, SellerAuditEntry } from '../../../spec/audit.js';
import { AppError } from '../../../kernel/errors/index.js';
import { dateInZone, zonedTimeToUtc } from '../../../kernel/lib/clock.js';
import { retentionChangeMachine } from './state-machines.js';

export type ApprovalState = AuditApproval['state'];
export type Category = AuditEntry['category'];

export const DATASET = 'audit.admin.entries';
export const RETENTION_ACTION = 'audit.retention.change';
export const PURGE_ACTION = 'audit.retention.purged';
/** Retention values above this are typing mistakes */
export const MAX_RETAIN_YEARS = 100;
/** reports.maxExportRows default; audit cannot read another module's setting (spec gap) */
export const DEFAULT_MAX_EXPORT_ROWS = 500_000;

/** Projection of an access approval request (audit.approval_states). */
export interface ApprovalProjection {
  approvalRequestId: string;
  state: string;
  approvers: string[];
  steps: TimelineEvent[];
  awaiting: string | null;
  decidedAt: Date | null;
  updatedAt: Date;
}

const APPROVAL_STATES = new Set<ApprovalState>(['not_required', 'pending', 'partially_approved', 'approved', 'rejected', 'returned', 'cancelled', 'expired']);

/**
 * The approval column of an entry. No request: not required (with the module's note, e.g.
 * "Within $50 limit"). A request audit has not heard about yet counts as pending.
 */
export function approvalOf(requestId: string | null, note: string | null, p: ApprovalProjection | undefined): AuditApproval {
  if (!requestId) return { state: 'not_required', note, approvalRequestId: null, approvers: [], decidedAt: null, steps: [] };
  const state = p && APPROVAL_STATES.has(p.state as ApprovalState) ? (p.state as ApprovalState) : 'pending';
  const waiting = (state === 'pending' || state === 'partially_approved') && p?.awaiting ? `Waiting for ${p.awaiting}` : null;
  return {
    state,
    note: waiting ?? note,
    approvalRequestId: requestId,
    approvers: p?.approvers ?? [],
    decidedAt: p?.decidedAt ? p.decidedAt.toISOString() : null,
    steps: p?.steps ?? [],
  };
}

/** business_owner → Business Owner */
export const roleLabel = (key: string): string =>
  key
    .split(/[_\-.\s]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(' ');

/** Appends a step unless the same step (time, label, actor, detail) is already there: consumers must be idempotent. */
export function withStep(steps: readonly TimelineEvent[], step: TimelineEvent): TimelineEvent[] {
  const same = (s: TimelineEvent) =>
    s.at === step.at && s.label === step.label && (s.actor?.id ?? null) === (step.actor?.id ?? null) && (s.detail ?? null) === (step.detail ?? null);
  return steps.some(same) ? [...steps] : [...steps, step];
}

export const withName = (names: readonly string[], name: string | null | undefined): string[] => (name && !names.includes(name) ? [...names, name] : [...names]);

/* ---------------------------------------------------------------- retention */

export type RetentionMove = { kind: 'unchanged' } | { kind: 'lengthen' } | { kind: 'shorten' };

/**
 * What a retention update does. Lengthening applies at once; shortening needs approval; never below
 * the legal minimum; while a shortening waits for approval nothing else may change (state machine).
 */
export function decideRetention(current: number, requested: number, minimumYears: number, pending: boolean): RetentionMove {
  if (!Number.isInteger(requested) || requested < 1 || requested > MAX_RETAIN_YEARS) {
    throw new AppError('VALIDATION_FAILED', `Retention must be a whole number of years up to ${MAX_RETAIN_YEARS}`, { issues: [{ path: 'retainYears', message: `1–${MAX_RETAIN_YEARS} years` }] });
  }
  if (requested < minimumYears) throw new AppError('BELOW_LEGAL_MINIMUM', `Retention cannot be shorter than ${minimumYears} years`, { minimumYears });
  const state = pending ? 'pending_approval' : 'none';
  if (!pending && requested === current) return { kind: 'unchanged' };
  if (requested >= current) {
    retentionChangeMachine.next(state, 'lengthen');
    return { kind: 'lengthen' };
  }
  retentionChangeMachine.next(state, 'requestShorten');
  return { kind: 'shorten' };
}

/** The machine event for an access decision on a pending shortening. */
export const retentionEventFor = (outcome: 'approved' | 'rejected' | 'cancelled' | 'expired') =>
  outcome === 'approved' ? 'approve' : outcome === 'rejected' ? 'reject' : 'cancel';

/* ---------------------------------------------------------------- time windows */

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Entries before this instant are purged: month partitions (market time) that lie entirely before
 * now − retainYears. The month containing that moment is kept whole.
 */
export function purgeCutoff(now: Date, retainYears: number, timeZone: string): Date {
  const [y, m] = dateInZone(now, timeZone).split('-').map(Number) as [number, number];
  return zonedTimeToUtc(`${y - retainYears}-${pad(m)}-01`, '00:00', timeZone);
}

/** The monthly purge runs at 00:00 market time on the 1st (kernel scheduler for "monthly"). */
export function nextPurgeAt(now: Date, timeZone: string): Date {
  const [y, m] = dateInZone(now, timeZone).split('-').map(Number) as [number, number];
  const thisMonth = zonedTimeToUtc(`${y}-${pad(m)}-01`, '00:00', timeZone);
  if (thisMonth > now) return thisMonth;
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return zonedTimeToUtc(`${ny}-${pad(nm)}-01`, '00:00', timeZone);
}

export const addDays = (date: string, days: number): string => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/** Whole market days [from 00:00, day after `to` 00:00) as UTC instants. */
export function dayWindow(from: string | undefined, to: string | undefined, timeZone: string): { from?: Date; to?: Date } {
  return {
    ...(from ? { from: zonedTimeToUtc(from, '00:00', timeZone) } : {}),
    ...(to ? { to: zonedTimeToUtc(addDays(to, 1), '00:00', timeZone) } : {}),
  };
}

/* ---------------------------------------------------------------- seller view */

/** Seller members by name; Marketly staff and the system shown as "Marketly" with no personal name. */
export function sellerActor(actor: Actor): Actor {
  if (actor.kind === 'seller') return { kind: 'seller', id: actor.id ?? null, name: actor.name ?? null };
  if (actor.kind === 'staff' || actor.kind === 'system' || actor.kind === 'provider') return { kind: actor.kind === 'provider' ? 'system' : actor.kind, id: null, name: 'Marketly' };
  return { kind: actor.kind, id: null, name: actor.name ?? null };
}

export function toSellerEntry(e: AuditEntry): SellerAuditEntry {
  const { screen: _adminScreen, ...target } = e.target;
  return { id: e.id, at: e.at, actor: sellerActor(e.actor), actionLabel: e.actionLabel, target, reason: e.reason ?? null, change: e.change };
}
