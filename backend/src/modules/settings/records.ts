/**
 * Settings records (what the service works with), their stored rows, and the conversions between the two
 * (used by repository.ts).
 */
import type { Actor, TimelineEvent } from '../../spec/common.js';
import type { ChangeItem, ImpactPreview, SettingChange, SettingsDb } from '../../spec/settings.js';

export type ChangeStatus = SettingChange['status'];
export type ApplyScope = SettingChange['applyScope'];

/** settings.definitions row (the persisted mirror of the catalogue, synced at boot) */
export interface DefinitionRecord {
  key: string;
  module: string;
  section: string;
  label: string;
  description: string;
  valueType: string;
  schema: { enumValues: string[]; min: number | null; max: number | null; unit: string | null; nullable: boolean };
  default: unknown;
  editable: boolean;
  approval: string;
  minLeadDays: number;
  applyScopes: string[];
  sellerVisible: boolean;
  public: boolean;
  exampleValue: boolean;
  editPermission: string;
}

/** settings.values row: one effective-dated version of a key */
export interface ValueRecord {
  id: string;
  key: string;
  version: number;
  value: unknown;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  applyScope: ApplyScope;
  changeId: string | null;
  changedBy: { kind: string; id: string };
  approvedById: string | null;
  reason: string | null;
  createdAt: Date;
}

/**
 * What a change keeps beside its columns. Stored in changes.impact (jsonb) next to the preview,
 * because the spec's changes table has no timeline or approver columns (spec gap, see report).
 */
export interface ChangeMeta {
  preview: ImpactPreview;
  timeline: TimelineEvent[];
  /** Creator with name (the columns keep kind and id only) */
  createdBy: Actor;
  /** Who approved (access decision) */
  approvedBy: Actor | null;
  /** When it entered scheduled: a version never takes effect before it was scheduled */
  scheduledAt: string | null;
  /** Why no approval was needed, or why it was (access check reason) */
  approvalNote: string | null;
}

/** settings.changes row */
export interface ChangeRecord {
  id: string;
  ref: string;
  status: ChangeStatus;
  items: ChangeItem[];
  effectiveAt: Date;
  applyScope: ApplyScope;
  reason: string;
  meta: ChangeMeta;
  createdByKind: string;
  createdById: string;
  createdAt: Date;
  submittedAt: Date | null;
  approvalRequestId: string | null;
  appliedAt: Date | null;
  cancelReason: string | null;
  version: number;
  announcedAt: Date | null;
}

export type ChangePatch = Partial<Omit<ChangeRecord, 'id' | 'ref' | 'createdAt' | 'createdByKind' | 'createdById' | 'version'>>;

/** settings.feature_flags row */
export interface FlagRecord {
  key: string;
  module: string;
  label: string;
  description: string;
  enabled: boolean;
  rollout: 'everyone' | 'staff_only' | 'percentage';
  percentage: number | null;
  public: boolean;
  plannedPhase: number | null;
  updatedBy: string | null;
  updatedAt: Date | null;
}

export interface ChangeFilter {
  status?: ChangeStatus;
  key?: string;
  /** Keys of a section (the service resolves section → keys) */
  keys?: string[];
}

export type ValueRow = SettingsDb['values'];
export type ChangeRow = SettingsDb['changes'];
export type FlagRow = SettingsDb['feature_flags'];

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

/** A patch as the columns it writes (the row's JSON columns hold the records as they are) */
export const changeColumns = (p: ChangePatch): Partial<ChangeRow> => {
  const out: Partial<ChangeRow> = {};
  if (p.status !== undefined) out.status = p.status;
  if (p.items !== undefined) out.items = p.items as unknown as ChangeRow['items'];
  if (p.effectiveAt !== undefined) out.effective_at = p.effectiveAt;
  if (p.applyScope !== undefined) out.apply_scope = p.applyScope;
  if (p.reason !== undefined) out.reason = p.reason;
  if (p.meta !== undefined) out.impact = p.meta as unknown as ChangeRow['impact'];
  if (p.submittedAt !== undefined) out.submitted_at = p.submittedAt;
  if (p.approvalRequestId !== undefined) out.approval_request_id = p.approvalRequestId;
  if (p.appliedAt !== undefined) out.applied_at = p.appliedAt;
  if (p.cancelReason !== undefined) out.cancel_reason = p.cancelReason;
  if (p.announcedAt !== undefined) out.announced_at = p.announcedAt;
  return out;
};

