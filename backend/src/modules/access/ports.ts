/**
 * What the access service needs from the outside world, database-agnostic.
 * The MongoDB adapter is repository.ts.
 */
import type { PageRequest } from '../../kernel/lib/pagination.js';
import type { Page } from '../../spec/common.js';
import type { AccessDb } from '../../spec/access.js';

type Row<T extends keyof AccessDb> = AccessDb[T];
export type RoleRow = Row<'roles'>;
export type PermissionRow = Row<'permissions'>;
export type RolePermissionRow = Row<'role_permissions'>;
export type AssignmentRow = Row<'role_assignments'>;
export type CoverageRow = Row<'role_coverage'>;
export type ActionRow = Row<'approval_actions'>;
export type LimitRow = Row<'approval_limits'>;
export type LimitChangeRow = Row<'limit_changes'>;
export type RequestRow = Row<'approval_requests'>;
export type DecisionRow = Row<'approval_decisions'>;
export type AwayRow = Row<'away_periods'>;
export type AwayCoverageRow = Row<'away_coverage'>;

export const OPEN_REQUEST = ['pending', 'partially_approved', 'returned'] as const;
export const OPEN_ASSIGNMENT = ['active', 'pending_acceptance', 'pending_approval'] as const;

export interface RequestFilter {
  ids?: string[];
  statuses?: readonly string[];
  actionKey?: string;
  module?: string;
  targetType?: string;
  targetIds?: string[];
  sellerIds?: string[];
  requestedById?: string;
  /** due_at before this instant */
  dueBefore?: Date;
  expiresBefore?: Date;
}

export interface AwayFilter {
  accountId?: string;
  statuses?: readonly string[];
  /** Overlapping [from, to) */
  from?: Date;
  to?: Date;
  /** ends after this instant */
  endsAfter?: Date;
}

/** Persistence for this module's own tables: access.roles, access.permissions, access.role_permissions, access.role_assignments, access.role_coverage, access.approval_actions, access.approval_limits, access.limit_changes, access.approval_requests, access.approval_decisions, access.away_periods, access.away_coverage. */
export interface AccessRepository {
  /** Runs fn with a repository bound to one transaction */
  transaction<T>(fn: (tx: AccessRepository) => Promise<T>): Promise<T>;
  /** Serializes registry syncs (inside a transaction) */
  lockRegistry(): Promise<void>;

  /* registry */
  listPermissions(): Promise<PermissionRow[]>;
  upsertPermissions(rows: PermissionRow[]): Promise<void>;
  markPermissionsUnavailable(exceptKeys: string[], at: Date): Promise<void>;
  listActions(): Promise<ActionRow[]>;
  getAction(key: string): Promise<ActionRow | undefined>;
  upsertActions(rows: ActionRow[]): Promise<void>;
  markActionsUnavailable(exceptKeys: string[], at: Date): Promise<void>;

  /* roles */
  listRoles(): Promise<RoleRow[]>;
  getRole(id: string, opts?: { forUpdate?: boolean }): Promise<RoleRow | undefined>;
  getRoleByKey(key: string): Promise<RoleRow | undefined>;
  insertRole(row: RoleRow): Promise<RoleRow | undefined>;
  updateRole(id: string, patch: Partial<RoleRow>): Promise<RoleRow>;
  rolePermissions(roleIds?: string[]): Promise<RolePermissionRow[]>;
  addRolePermissions(roleId: string, keys: string[], by: string, at: Date): Promise<void>;
  removeRolePermissions(roleId: string, keys: string[]): Promise<void>;
  /** Permission keys of these roles (effective permissions) */
  permissionKeysOfRoles(roleIds: string[]): Promise<string[]>;
  listCoverage(): Promise<CoverageRow[]>;
  getCoverage(roleId: string): Promise<CoverageRow | undefined>;
  upsertCoverage(row: CoverageRow): Promise<CoverageRow>;

  /* assignments */
  listAssignments(filter: { accountId?: string; accountIds?: string[]; roleId?: string; statuses?: readonly string[] }): Promise<AssignmentRow[]>;
  /** Assignments that give authority at `at`: active and not past expiresAt */
  activeAssignments(at: Date, filter?: { accountId?: string; roleIds?: string[] }): Promise<AssignmentRow[]>;
  getAssignment(id: string, opts?: { forUpdate?: boolean }): Promise<AssignmentRow | undefined>;
  insertAssignment(row: AssignmentRow): Promise<AssignmentRow>;
  updateAssignment(id: string, patch: Partial<AssignmentRow>): Promise<AssignmentRow>;
  /** Accounts that ever held a role */
  memberAccountIds(): Promise<string[]>;

  /* limits */
  limitsInForce(at: Date, filter?: { roleIds?: string[]; actionKey?: string }): Promise<LimitRow[]>;
  limitRowExists(roleId: string, actionKey: string): Promise<boolean>;
  insertLimits(rows: LimitRow[]): Promise<void>;
  /** Close rows of (role, action) in force at `at` */
  closeLimits(roleId: string, actionKey: string, at: Date): Promise<void>;
  getLimitRows(ids: string[]): Promise<LimitRow[]>;

  /* limit changes */
  insertLimitChange(row: LimitChangeRow): Promise<LimitChangeRow>;
  getLimitChange(id: string, opts?: { forUpdate?: boolean }): Promise<LimitChangeRow | undefined>;
  updateLimitChange(id: string, patch: Partial<LimitChangeRow>): Promise<LimitChangeRow>;
  listLimitChanges(filter: { status?: string; roleId?: string }, page: PageRequest): Promise<Page<LimitChangeRow>>;
  limitChangesByIds(ids: string[]): Promise<LimitChangeRow[]>;
  dueLimitChanges(at: Date, limit: number): Promise<LimitChangeRow[]>;
  openLimitChangeOfRole(roleId: string): Promise<LimitChangeRow | undefined>;

  /* approval requests */
  insertRequest(row: RequestRow): Promise<RequestRow>;
  getRequest(id: string, opts?: { forUpdate?: boolean }): Promise<RequestRow | undefined>;
  updateRequest(id: string, patch: Partial<RequestRow>): Promise<RequestRow>;
  findOpenRequest(actionKey: string, targetType: string, targetId: string): Promise<RequestRow | undefined>;
  findRequests(filter: RequestFilter, opts?: { limit?: number; order?: 'created_desc' | 'created_asc' }): Promise<RequestRow[]>;
  pageRequests(filter: RequestFilter, page: PageRequest): Promise<Page<RequestRow>>;
  /** Open requests a person may be able to decide: eligible roles overlap, or nominated */
  candidateRequests(roleKeys: string[], accountId: string, filter: RequestFilter): Promise<RequestRow[]>;
  decisionsOf(requestIds: string[]): Promise<DecisionRow[]>;
  insertDecision(row: DecisionRow): Promise<void>;
  /** resubmit: earlier decisions no longer count (kept for the timeline) */
  supersedeDecisions(requestId: string): Promise<void>;

  /* away periods */
  insertAway(row: AwayRow, coverage: AwayCoverageRow[]): Promise<AwayRow>;
  getAway(id: string, opts?: { forUpdate?: boolean }): Promise<AwayRow | undefined>;
  updateAway(id: string, patch: Partial<AwayRow>): Promise<AwayRow>;
  findAway(filter: AwayFilter): Promise<AwayRow[]>;
  pageAway(filter: AwayFilter, page: PageRequest): Promise<Page<AwayRow>>;
  awayCoverage(awayIds: string[]): Promise<AwayCoverageRow[]>;
  /** Periods in force at `at` (scheduled or active and from <= at < to), with their coverage */
  awayInForce(at: Date): Promise<{ period: AwayRow; coverage: AwayCoverageRow[] }[]>;
}
