/** Row types and filters of the access module (its collections are read and written by repository.ts). */
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
