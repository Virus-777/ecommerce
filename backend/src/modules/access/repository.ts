import { orThrow } from '../../kernel/lib/or-throw.js';
import type { PageRequest } from '../../kernel/lib/pagination.js';
import type { Filter, ModuleStore, Table } from '../../kernel/mongo/index.js';
import type { Page } from '../../spec/common.js';
import type {
  ActionRow,
  AssignmentRow,
  AwayCoverageRow,
  AwayFilter,
  AwayRow,
  CoverageRow,
  DecisionRow,
  LimitChangeRow,
  LimitRow,
  PermissionRow,
  RequestFilter,
  RequestRow,
  RolePermissionRow,
  RoleRow,
} from './ports.js';

/** One of `values`, or nothing when the list is empty (an empty IN matches no row) */
const oneOf = (values: readonly unknown[]) => ({ $in: [...values] });

const requestFilter = (f: RequestFilter): Filter => ({
  ...(f.ids ? { id: oneOf(f.ids) } : {}),
  ...(f.statuses ? { status: oneOf(f.statuses) } : {}),
  ...(f.actionKey ? { action_key: f.actionKey } : {}),
  ...(f.module ? { module: f.module } : {}),
  ...(f.targetType ? { target_type: f.targetType } : {}),
  ...(f.targetIds ? { target_id: oneOf(f.targetIds) } : {}),
  ...(f.sellerIds ? { seller_id: oneOf(f.sellerIds) } : {}),
  ...(f.requestedById ? { requested_by_id: f.requestedById } : {}),
  ...(f.nominatedReviewerId ? { nominated_reviewer_id: f.nominatedReviewerId } : {}),
  ...(f.dueBefore || f.expiresBefore
    ? { $and: [...(f.dueBefore ? [{ due_at: { $lt: f.dueBefore } }] : []), ...(f.expiresBefore ? [{ expires_at: { $lte: f.expiresBefore } }] : [])] }
    : {}),
});

const awayFilter = (f: AwayFilter): Filter => {
  const ends: Record<string, Date> = {};
  if (f.from) ends.$gt = f.from;
  if (f.endsAfter && (!ends.$gt || f.endsAfter > ends.$gt)) ends.$gt = f.endsAfter;
  return {
    ...(f.accountId ? { account_id: f.accountId } : {}),
    ...(f.statuses ? { status: oneOf(f.statuses) } : {}),
    ...(ends.$gt ? { ends_at: ends } : {}),
    ...(f.to ? { starts_at: { $lt: f.to } } : {}),
  };
};

/** Rows in force at `at`: started, and not ended (effective_to null or later) */
const inForce = (at: Date, from: string, to: string): Filter => ({ [from]: { $lte: at }, $or: [{ [to]: null }, { [to]: { $gt: at } }] });

/**
 * Registry rows (permissions, approval actions): every spec field is refreshed; unavailable_since is cleared when
 * the row is back, and when the row is gone it keeps the first date it went missing.
 */
async function syncRegistry<T extends { key: string; unavailable_since: Date | null }>(table: Table<T>, rows: T[]) {
  await table.upsertMany(rows, { update: ({ unavailable_since: _u, key: _k, ...rest }) => rest });
  const back = rows.filter((r) => r.unavailable_since === null).map((r) => r.key);
  if (back.length) await table.updateMany({ key: oneOf(back) }, { unavailable_since: null });
  const gone = new Map<number, string[]>();
  for (const r of rows) if (r.unavailable_since) gone.set(r.unavailable_since.getTime(), [...(gone.get(r.unavailable_since.getTime()) ?? []), r.key]);
  for (const [at, keys] of gone) await table.updateMany({ key: oneOf(keys), unavailable_since: null }, { unavailable_since: new Date(at) });
}

/**
 * access.roles, access.permissions, access.role_permissions, access.role_assignments, access.role_coverage,
 * access.approval_actions, access.approval_limits, access.limit_changes, access.approval_requests,
 * access.approval_decisions, access.away_periods, access.away_coverage (MongoDB, docs/04-mongodb-migration.md).
 */
export class AccessRepository {
  readonly #t;

  constructor(private readonly store: ModuleStore) {
    this.#t = {
      permissions: store.table<PermissionRow>('permissions'),
      actions: store.table<ActionRow>('approval_actions'),
      roles: store.table<RoleRow>('roles'),
      rolePermissions: store.table<RolePermissionRow>('role_permissions'),
      coverage: store.table<CoverageRow>('role_coverage'),
      assignments: store.table<AssignmentRow>('role_assignments'),
      limits: store.table<LimitRow>('approval_limits'),
      limitChanges: store.table<LimitChangeRow>('limit_changes'),
      requests: store.table<RequestRow>('approval_requests'),
      decisions: store.table<DecisionRow>('approval_decisions'),
      away: store.table<AwayRow>('away_periods'),
      awayCoverage: store.table<AwayCoverageRow>('away_coverage'),
    };
  }

  /** Runs fn with a repository bound to one transaction */
  transaction<R>(fn: (tx: AccessRepository) => Promise<R>): Promise<R> {
    return this.store.transaction((tx) => fn(new AccessRepository(tx)));
  }

  /** Serializes registry syncs (inside a transaction) */
  lockRegistry(): Promise<void> {
    return this.store.lock('sync-registry');
  }

  /* ------------------------------------------------ registry */
  listPermissions(): Promise<PermissionRow[]> {
    return this.#t.permissions.find({}, { sort: { key: 1 } });
  }

  upsertPermissions(rows: PermissionRow[]): Promise<void> {
    return syncRegistry(this.#t.permissions, rows);
  }

  async markPermissionsUnavailable(exceptKeys: string[], at: Date): Promise<void> {
    await this.#t.permissions.updateMany({ unavailable_since: null, ...(exceptKeys.length ? { key: { $nin: exceptKeys } } : {}) }, { unavailable_since: at });
  }

  listActions(): Promise<ActionRow[]> {
    return this.#t.actions.find({}, { sort: { key: 1 } });
  }

  getAction(key: string): Promise<ActionRow | undefined> {
    return this.#t.actions.get(key);
  }

  async upsertActions(rows: ActionRow[]): Promise<void> {
    await syncRegistry(this.#t.actions, rows);
  }

  async markActionsUnavailable(exceptKeys: string[], at: Date): Promise<void> {
    await this.#t.actions.updateMany({ unavailable_since: null, ...(exceptKeys.length ? { key: { $nin: exceptKeys } } : {}) }, { unavailable_since: at });
  }

  /* ------------------------------------------------ roles */
  listRoles(): Promise<RoleRow[]> {
    return this.#t.roles.find({}, { sort: { created_at: 1, name: 1 } });
  }

  getRole(id: string, opts?: { forUpdate?: boolean }): Promise<RoleRow | undefined> {
    return this.#t.roles.get(id, opts);
  }

  getRoles(ids: string[]): Promise<RoleRow[]> {
    return this.#t.roles.getMany(ids);
  }

  getRoleByKey(key: string): Promise<RoleRow | undefined> {
    return this.#t.roles.findOne({ key });
  }

  insertRole(row: RoleRow): Promise<RoleRow | undefined> {
    return this.#t.roles.insertIfAbsent(row, ['key']);
  }

  async updateRole(id: string, patch: Partial<RoleRow>): Promise<RoleRow> {
    return orThrow(await this.#t.roles.update(id, patch), `access: role ${id}`);
  }

  rolePermissions(roleIds?: string[]): Promise<RolePermissionRow[]> {
    return this.#t.rolePermissions.find(roleIds ? { role_id: oneOf(roleIds) } : {});
  }

  async addRolePermissions(roleId: string, keys: string[], by: string, at: Date): Promise<void> {
    await this.#t.rolePermissions.insertManyIfAbsent(keys.map((k) => ({ role_id: roleId, permission_key: k, granted_by: by, granted_at: at })));
  }

  async removeRolePermissions(roleId: string, keys: string[]): Promise<void> {
    if (keys.length) await this.#t.rolePermissions.deleteMany({ role_id: roleId, permission_key: oneOf(keys) });
  }

  /** Permission keys of these roles (effective permissions) */
  async permissionKeysOfRoles(roleIds: string[]): Promise<string[]> {
    if (!roleIds.length) return [];
    return this.#t.rolePermissions.distinct<string>('permission_key', { role_id: oneOf(roleIds) });
  }

  listCoverage(): Promise<CoverageRow[]> {
    return this.#t.coverage.find();
  }

  getCoverage(roleId: string): Promise<CoverageRow | undefined> {
    return this.#t.coverage.get(roleId);
  }

  upsertCoverage(row: CoverageRow): Promise<CoverageRow> {
    return this.#t.coverage.upsert(row, { update: { lead_account_id: row.lead_account_id, backup_account_ids: row.backup_account_ids, updated_by: row.updated_by, updated_at: row.updated_at } });
  }

  /* ------------------------------------------------ assignments */
  listAssignments(f: { accountId?: string; accountIds?: string[]; roleId?: string; statuses?: readonly string[] }): Promise<AssignmentRow[]> {
    return this.#t.assignments.find(
      {
        ...(f.accountId ? { account_id: f.accountId } : {}),
        ...(f.accountIds ? { $and: [{ account_id: oneOf(f.accountIds) }] } : {}),
        ...(f.roleId ? { role_id: f.roleId } : {}),
        ...(f.statuses ? { status: oneOf(f.statuses) } : {}),
      },
      { sort: { granted_at: 1, id: 1 } },
    );
  }

  /** Assignments that give authority at `at`: active and not past expiresAt */
  activeAssignments(at: Date, f: { accountId?: string; roleIds?: string[] } = {}): Promise<AssignmentRow[]> {
    return this.#t.assignments.find(
      {
        status: 'active',
        $or: [{ expires_at: null }, { expires_at: { $gt: at } }],
        ...(f.accountId ? { account_id: f.accountId } : {}),
        ...(f.roleIds ? { role_id: oneOf(f.roleIds) } : {}),
      },
      { sort: { granted_at: 1, id: 1 } },
    );
  }

  /** Active assignments whose expiresAt has passed (temporary access to end) */
  expiredAssignments(at: Date): Promise<AssignmentRow[]> {
    return this.#t.assignments.find({ status: 'active', expires_at: { $lte: at } }, { sort: { granted_at: 1, id: 1 } });
  }

  getAssignment(id: string, opts?: { forUpdate?: boolean }): Promise<AssignmentRow | undefined> {
    return this.#t.assignments.get(id, opts);
  }

  insertAssignment(row: AssignmentRow): Promise<AssignmentRow> {
    return this.#t.assignments.insert(row);
  }

  async updateAssignment(id: string, patch: Partial<AssignmentRow>): Promise<AssignmentRow> {
    return orThrow(await this.#t.assignments.update(id, patch), `access: assignment ${id}`);
  }

  /** Accounts that ever held a role */
  memberAccountIds(): Promise<string[]> {
    return this.#t.assignments.distinct<string>('account_id');
  }

  /* ------------------------------------------------ limits */
  limitsInForce(at: Date, f: { roleIds?: string[]; actionKey?: string } = {}): Promise<LimitRow[]> {
    return this.#t.limits.find(
      { ...inForce(at, 'effective_from', 'effective_to'), ...(f.roleIds ? { role_id: oneOf(f.roleIds) } : {}), ...(f.actionKey ? { action_key: f.actionKey } : {}) },
      { sort: { effective_from: -1 } },
    );
  }

  limitRowExists(roleId: string, actionKey: string): Promise<boolean> {
    return this.#t.limits.exists({ role_id: roleId, action_key: actionKey });
  }

  async insertLimits(rows: LimitRow[]): Promise<void> {
    await this.#t.limits.insertMany(rows);
  }

  /** Close rows of (role, action) in force at `at` */
  async closeLimits(roleId: string, actionKey: string, at: Date): Promise<void> {
    await this.#t.limits.updateMany({ role_id: roleId, action_key: actionKey, ...inForce(at, 'effective_from', 'effective_to') }, { effective_to: at });
  }

  getLimitRows(ids: string[]): Promise<LimitRow[]> {
    return this.#t.limits.getMany(ids);
  }

  /* ------------------------------------------------ limit changes */
  insertLimitChange(row: LimitChangeRow): Promise<LimitChangeRow> {
    return this.#t.limitChanges.insert(row);
  }

  getLimitChange(id: string, opts?: { forUpdate?: boolean }): Promise<LimitChangeRow | undefined> {
    return this.#t.limitChanges.get(id, opts);
  }

  async updateLimitChange(id: string, patch: Partial<LimitChangeRow>): Promise<LimitChangeRow> {
    return orThrow(await this.#t.limitChanges.update(id, patch), `access: limit change ${id}`);
  }

  listLimitChanges(f: { status?: string; roleId?: string }, page: PageRequest): Promise<Page<LimitChangeRow>> {
    return this.#t.limitChanges.page({ ...(f.status ? { status: f.status } : {}), ...(f.roleId ? { role_id: f.roleId } : {}) }, page, { column: 'created_at', direction: 'desc' });
  }

  limitChangesByIds(ids: string[]): Promise<LimitChangeRow[]> {
    return this.#t.limitChanges.getMany(ids);
  }

  dueLimitChanges(at: Date, limit: number): Promise<LimitChangeRow[]> {
    return this.#t.limitChanges.find({ status: 'scheduled', effective_from: { $lte: at } }, { sort: { effective_from: 1, id: 1 }, limit });
  }

  openLimitChangeOfRole(roleId: string): Promise<LimitChangeRow | undefined> {
    return this.#t.limitChanges.findOne({ role_id: roleId, status: oneOf(['pending_approval', 'scheduled']) }, { sort: { created_at: -1 } });
  }

  /* ------------------------------------------------ approval requests */
  insertRequest(row: RequestRow): Promise<RequestRow> {
    return this.#t.requests.insert(row);
  }

  getRequest(id: string, opts?: { forUpdate?: boolean }): Promise<RequestRow | undefined> {
    return this.#t.requests.get(id, opts);
  }

  async updateRequest(id: string, patch: Partial<RequestRow>): Promise<RequestRow> {
    return orThrow(await this.#t.requests.update(id, patch), `access: approval request ${id}`);
  }

  findOpenRequest(actionKey: string, targetType: string, targetId: string): Promise<RequestRow | undefined> {
    return this.#t.requests.findOne({ action_key: actionKey, target_type: targetType, target_id: targetId, status: oneOf(['pending', 'partially_approved', 'returned']) });
  }

  findRequests(f: RequestFilter, opts: { limit?: number; order?: 'created_desc' | 'created_asc' } = {}): Promise<RequestRow[]> {
    const dir = opts.order === 'created_asc' ? 1 : -1;
    return this.#t.requests.find(requestFilter(f), { sort: { created_at: dir, id: dir }, ...(opts.limit ? { limit: opts.limit } : {}) });
  }

  pageRequests(f: RequestFilter, page: PageRequest): Promise<Page<RequestRow>> {
    return this.#t.requests.page(requestFilter(f), page, { column: 'created_at', direction: 'desc' });
  }

  /** Open requests a person may be able to decide: eligible roles overlap, or nominated */
  candidateRequests(roleKeys: string[], accountId: string, f: RequestFilter): Promise<RequestRow[]> {
    return this.#t.requests.find(
      {
        $and: [
          requestFilter({ ...f, statuses: f.statuses ?? ['pending', 'partially_approved'] }),
          { $or: [{ nominated_reviewer_id: accountId }, ...(roleKeys.length ? [{ eligible_role_keys: { $in: roleKeys } }] : [])] },
        ],
      },
      { sort: { created_at: 1, id: 1 } },
    );
  }

  async decisionsOf(ids: string[]): Promise<DecisionRow[]> {
    return ids.length ? this.#t.decisions.find({ request_id: oneOf(ids) }, { sort: { at: 1, step: 1 } }) : [];
  }

  async insertDecision(row: DecisionRow): Promise<void> {
    await this.#t.decisions.insert(row);
  }

  /** resubmit: earlier decisions no longer count (kept for the timeline) */
  async supersedeDecisions(requestId: string): Promise<void> {
    await this.#t.decisions.updateMany({ request_id: requestId, decision: oneOf(['approved', 'returned', 'rejected']) }, [{ $set: { decision: { $concat: ['superseded_', '$decision'] } } }]);
  }

  /* ------------------------------------------------ away periods */
  async insertAway(row: AwayRow, coverage: AwayCoverageRow[]): Promise<AwayRow> {
    const out = await this.#t.away.insert(row);
    await this.#t.awayCoverage.insertMany(coverage);
    return out;
  }

  getAway(id: string, opts?: { forUpdate?: boolean }): Promise<AwayRow | undefined> {
    return this.#t.away.get(id, opts);
  }

  async updateAway(id: string, patch: Partial<AwayRow>): Promise<AwayRow> {
    return orThrow(await this.#t.away.update(id, patch), `access: away period ${id}`);
  }

  findAway(f: AwayFilter): Promise<AwayRow[]> {
    return this.#t.away.find(awayFilter(f), { sort: { starts_at: 1, id: 1 } });
  }

  pageAway(f: AwayFilter, page: PageRequest): Promise<Page<AwayRow>> {
    return this.#t.away.page(awayFilter(f), page, { column: 'starts_at', direction: 'asc' });
  }

  async awayCoverage(ids: string[]): Promise<AwayCoverageRow[]> {
    return ids.length ? this.#t.awayCoverage.find({ away_period_id: oneOf(ids) }) : [];
  }

  /** Periods in force at `at` (scheduled or active and from <= at < to), with their coverage */
  async awayInForce(at: Date): Promise<{ period: AwayRow; coverage: AwayCoverageRow[] }[]> {
    const periods = await this.#t.away.find({ status: oneOf(['scheduled', 'active']), starts_at: { $lte: at }, ends_at: { $gt: at } });
    const coverage = await this.awayCoverage(periods.map((p) => p.id));
    return periods.map((period) => ({ period, coverage: coverage.filter((c) => c.away_period_id === period.id) }));
  }
}
