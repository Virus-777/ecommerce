/**
 * Settings rows ↔ records, shared by the repositories: what a stored row means is independent of the database.
 */
import type { Selectable } from 'kysely';
import type { SettingsDb } from '../../../spec/settings.js';
import type { ChangeMeta, ChangePatch, ChangeRecord, FlagRecord, ValueRecord } from '../ports.js';

export type ValueRow = Selectable<SettingsDb['values']>;
export type ChangeRow = Selectable<SettingsDb['changes']>;
export type FlagRow = Selectable<SettingsDb['feature_flags']>;

/** Who wrote the boot seed of market defaults */
export const SEED_ACTOR = { kind: 'system', id: 'settings.seed' } as const;

export const toValue = (r: ValueRow): ValueRecord => ({
  id: r.id,
  key: r.key,
  version: r.version,
  value: r.value,
  effectiveFrom: r.effective_from,
  effectiveTo: r.effective_to,
  applyScope: r.apply_scope as ValueRecord['applyScope'],
  changeId: r.change_id,
  changedBy: { kind: r.changed_by_kind, id: r.changed_by_id },
  approvedById: r.approved_by_id,
  reason: r.reason,
  createdAt: r.created_at,
});

export const toChange = (r: ChangeRow): ChangeRecord => ({
  id: r.id,
  ref: r.ref,
  status: r.status as ChangeRecord['status'],
  items: r.items as unknown as ChangeRecord['items'],
  effectiveAt: r.effective_at,
  applyScope: r.apply_scope as ChangeRecord['applyScope'],
  reason: r.reason,
  meta: r.impact as unknown as ChangeMeta,
  createdByKind: r.created_by_kind,
  createdById: r.created_by_id,
  createdAt: r.created_at,
  submittedAt: r.submitted_at,
  approvalRequestId: r.approval_request_id,
  appliedAt: r.applied_at,
  cancelReason: r.cancel_reason,
  version: r.version,
  announcedAt: r.announced_at,
});

export const toFlag = (r: FlagRow): FlagRecord => ({
  key: r.key,
  module: r.module,
  label: r.label,
  description: r.description,
  enabled: r.enabled,
  rollout: r.rollout as FlagRecord['rollout'],
  percentage: r.percentage,
  public: r.public,
  plannedPhase: r.planned_phase,
  updatedBy: r.updated_by,
  updatedAt: r.updated_at,
});

export const changeColumns = (p: ChangePatch) => {
  const out: Partial<Record<keyof ChangeRow, unknown>> = {};
  if (p.status !== undefined) out.status = p.status;
  if (p.items !== undefined) out.items = p.items;
  if (p.effectiveAt !== undefined) out.effective_at = p.effectiveAt;
  if (p.applyScope !== undefined) out.apply_scope = p.applyScope;
  if (p.reason !== undefined) out.reason = p.reason;
  if (p.meta !== undefined) out.impact = p.meta;
  if (p.submittedAt !== undefined) out.submitted_at = p.submittedAt;
  if (p.approvalRequestId !== undefined) out.approval_request_id = p.approvalRequestId;
  if (p.appliedAt !== undefined) out.applied_at = p.appliedAt;
  if (p.cancelReason !== undefined) out.cancel_reason = p.cancelReason;
  if (p.announcedAt !== undefined) out.announced_at = p.announcedAt;
  return out;
};

