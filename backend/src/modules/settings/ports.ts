/**
 * What the settings service needs from the outside world, database-agnostic.
 * The MongoDB adapter lives in infra/mongo/.
 */
import type { Actor, Page, TimelineEvent } from '../../spec/common.js';
import type { ChangeItem, ImpactPreview, SettingChange } from '../../spec/settings.js';
import type { PageRequest } from '../../kernel/lib/pagination.js';

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

/** Persistence for this module's own tables: settings.definitions, settings.values, settings.changes, settings.change_keys, settings.feature_flags. */
export interface SettingsRepository {
  transaction<T>(fn: (tx: SettingsRepository) => Promise<T>): Promise<T>;

  /* definitions */
  /** Insert or refresh definitions (registered_at kept; unavailable_since cleared) */
  upsertDefinitions(defs: DefinitionRecord[], at: Date): Promise<void>;
  /** Mark every definition not in `keys` unavailable (module disabled), once */
  markUnavailableExcept(keys: string[], at: Date): Promise<number>;

  /* values */
  /** Versions in force or last written per key (effective_to is null) */
  openValues(): Promise<ValueRecord[]>;
  valueAt(key: string, at: Date): Promise<ValueRecord | null>;
  openValue(key: string, opts?: { forUpdate?: boolean }): Promise<ValueRecord | null>;
  latestVersion(key: string): Promise<number>;
  recentValues(key: string, limit: number): Promise<ValueRecord[]>;
  pageValues(key: string, page: PageRequest): Promise<Page<ValueRecord>>;
  /** Latest version written by a person (not the boot seed) among keys */
  lastChangeAmong(keys: string[]): Promise<ValueRecord | null>;
  closeValue(id: string, at: Date): Promise<void>;
  insertValue(v: ValueRecord): Promise<void>;

  /* changes */
  insertChange(c: ChangeRecord): Promise<void>;
  getChange(id: string, opts?: { forUpdate?: boolean }): Promise<ChangeRecord | null>;
  getChangeByApprovalRequest(requestId: string, opts?: { forUpdate?: boolean }): Promise<ChangeRecord | null>;
  /** Applies the patch and bumps the row version */
  updateChange(id: string, patch: ChangePatch): Promise<ChangeRecord>;
  listChanges(filter: ChangeFilter, page: PageRequest): Promise<Page<ChangeRecord>>;
  /** pending_approval and scheduled changes, soonest first */
  openChanges(): Promise<ChangeRecord[]>;
  /** Scheduled changes whose effective time has come, oldest first */
  dueChanges(now: Date, limit: number): Promise<ChangeRecord[]>;

  /* change keys (one open change per key) */
  /** Open changes (other than `exceptChangeId`) that touch any of the keys */
  keyConflicts(keys: string[], exceptChangeId?: string): Promise<{ key: string; changeId: string; ref: string }[]>;
  /** Claims the keys for a change; false when another open change holds one */
  claimKeys(changeId: string, keys: string[]): Promise<boolean>;
  releaseKeys(changeId: string): Promise<void>;

  /* feature flags */
  listFlags(): Promise<FlagRecord[]>;
  /** Inserts missing flags off, refreshes descriptive fields of existing ones (state untouched) */
  syncFlags(flags: Omit<FlagRecord, 'enabled' | 'rollout' | 'percentage' | 'updatedBy' | 'updatedAt'>[]): Promise<void>;
  upsertFlag(f: FlagRecord): Promise<FlagRecord>;
}
