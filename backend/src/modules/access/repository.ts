import type { ModuleStore } from '../../kernel/mongo/index.js';
import type { Filter } from '../../kernel/mongo/table.js';
import type { Page } from '../../spec/common.js';
import type {
  AccessRepository,
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

function found<T>(row: T | undefined, what: string): T {
  if (!row) throw new Error(`access: ${what} not found`);
  return row;
}

/** MongoDB adapter for AccessRepository (docs/04-mongodb-migration.md): one collection per spec table. */
export function createMongoAccessRepository(store: ModuleStore): AccessRepository {
  const t = {
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

  const requestFilter = (f: RequestFilter): Filter => ({
    ...(f.ids ? { id: oneOf(f.ids) } : {}),
    ...(f.statuses ? { status: oneOf(f.statuses) } : {}),
    ...(f.actionKey ? { action_key: f.actionKey } : {}),
    ...(f.module ? { module: f.module } : {}),
    ...(f.targetType ? { target_type: f.targetType } : {}),
    ...(f.targetIds ? { target_id: oneOf(f.targetIds) } : {}),
    ...(f.sellerIds ? { seller_id: oneOf(f.sellerIds) } : {}),
    ...(f.requestedById ? { requested_by_id: f.requestedById } : {}),
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
  async function syncRegistry<T extends { key: string; unavailable_since: Date | null }>(table: typeof t.permissions | typeof t.actions, rows: T[]) {
    await table.upsertMany(rows, { update: ({ unavailable_since: _u, key: _k, ...rest }) => rest });
    const back = rows.filter((r) => r.unavailable_since === null).map((r) => r.key);
    if (back.length) await table.updateMany({ key: oneOf(back) }, { unavailable_since: null });
    const gone = new Map<number, string[]>();
    for (const r of rows) if (r.unavailable_since) gone.set(r.unavailable_since.getTime(), [...(gone.get(r.unavailable_since.getTime()) ?? []), r.key]);
    for (const [at, keys] of gone) await table.updateMany({ key: oneOf(keys), unavailable_since: null }, { unavailable_since: new Date(at) });
  }

  const repo: AccessRepository = {
    transaction: (fn) => store.transaction((tx) => fn(createMongoAccessRepository(tx))),
    lockRegistry: () => store.lock('sync-registry'),

    /* ------------------------------------------------ registry */
    listPermissions: () => t.permissions.find({}, { sort: { key: 1 } }),
    upsertPermissions: (rows) => syncRegistry(t.permissions, rows),
    async markPermissionsUnavailable(exceptKeys, at) {
      await t.permissions.updateMany({ unavailable_since: null, ...(exceptKeys.length ? { key: { $nin: exceptKeys } } : {}) }, { unavailable_since: at });
    },
    listActions: () => t.actions.find({}, { sort: { key: 1 } }),
    getAction: (key) => t.actions.get(key),
    async upsertActions(rows) {
      await syncRegistry(t.actions, rows);
    },
    async markActionsUnavailable(exceptKeys, at) {
      await t.actions.updateMany({ unavailable_since: null, ...(exceptKeys.length ? { key: { $nin: exceptKeys } } : {}) }, { unavailable_since: at });
    },

    /* ------------------------------------------------ roles */
    listRoles: () => t.roles.find({}, { sort: { created_at: 1, name: 1 } }),
    getRole: (id, opts) => t.roles.get(id, opts),
    getRoleByKey: (key) => t.roles.findOne({ key }),
    insertRole: (row) => t.roles.insertIfAbsent(row, ['key']),
    updateRole: async (id, patch) => found(await t.roles.update(id, patch), `role ${id}`),
    rolePermissions: (roleIds) => t.rolePermissions.find(roleIds ? { role_id: oneOf(roleIds) } : {}),
    async addRolePermissions(roleId, keys, by, at) {
      await t.rolePermissions.insertManyIfAbsent(keys.map((k) => ({ role_id: roleId, permission_key: k, granted_by: by, granted_at: at })));
    },
    async removeRolePermissions(roleId, keys) {
      if (keys.length) await t.rolePermissions.deleteMany({ role_id: roleId, permission_key: oneOf(keys) });
    },
    async permissionKeysOfRoles(roleIds) {
      if (!roleIds.length) return [];
      return t.rolePermissions.distinct<string>('permission_key', { role_id: oneOf(roleIds) });
    },
    listCoverage: () => t.coverage.find(),
    getCoverage: (roleId) => t.coverage.get(roleId),
    upsertCoverage: (row) =>
      t.coverage.upsert(row, { update: { lead_account_id: row.lead_account_id, backup_account_ids: row.backup_account_ids, updated_by: row.updated_by, updated_at: row.updated_at } }),

    /* ------------------------------------------------ assignments */
    listAssignments: (f) =>
      t.assignments.find(
        {
          ...(f.accountId ? { account_id: f.accountId } : {}),
          ...(f.accountIds ? { $and: [{ account_id: oneOf(f.accountIds) }] } : {}),
          ...(f.roleId ? { role_id: f.roleId } : {}),
          ...(f.statuses ? { status: oneOf(f.statuses) } : {}),
        },
        { sort: { granted_at: 1, id: 1 } },
      ),
    activeAssignments: (at, f = {}) =>
      t.assignments.find(
        {
          status: 'active',
          $or: [{ expires_at: null }, { expires_at: { $gt: at } }],
          ...(f.accountId ? { account_id: f.accountId } : {}),
          ...(f.roleIds ? { role_id: oneOf(f.roleIds) } : {}),
        },
        { sort: { granted_at: 1, id: 1 } },
      ),
    getAssignment: (id, opts) => t.assignments.get(id, opts),
    insertAssignment: (row) => t.assignments.insert(row),
    updateAssignment: async (id, patch) => found(await t.assignments.update(id, patch), `assignment ${id}`),
    memberAccountIds: () => t.assignments.distinct<string>('account_id'),

    /* ------------------------------------------------ limits */
    limitsInForce: (at, f = {}) =>
      t.limits.find(
        { ...inForce(at, 'effective_from', 'effective_to'), ...(f.roleIds ? { role_id: oneOf(f.roleIds) } : {}), ...(f.actionKey ? { action_key: f.actionKey } : {}) },
        { sort: { effective_from: -1 } },
      ),
    limitRowExists: (roleId, actionKey) => t.limits.exists({ role_id: roleId, action_key: actionKey }),
    async insertLimits(rows) {
      await t.limits.insertMany(rows);
    },
    async closeLimits(roleId, actionKey, at) {
      await t.limits.updateMany({ role_id: roleId, action_key: actionKey, ...inForce(at, 'effective_from', 'effective_to') }, { effective_to: at });
    },
    getLimitRows: (ids) => t.limits.getMany(ids),

    /* ------------------------------------------------ limit changes */
    insertLimitChange: (row) => t.limitChanges.insert(row),
    getLimitChange: (id, opts) => t.limitChanges.get(id, opts),
    updateLimitChange: async (id, patch) => found(await t.limitChanges.update(id, patch), `limit change ${id}`),
    listLimitChanges: (f, page): Promise<Page<LimitChangeRow>> =>
      t.limitChanges.page({ ...(f.status ? { status: f.status } : {}), ...(f.roleId ? { role_id: f.roleId } : {}) }, page, { column: 'created_at', direction: 'desc' }),
    limitChangesByIds: (ids) => t.limitChanges.getMany(ids),
    dueLimitChanges: (at, limit) => t.limitChanges.find({ status: 'scheduled', effective_from: { $lte: at } }, { sort: { effective_from: 1, id: 1 }, limit }),
    openLimitChangeOfRole: (roleId) => t.limitChanges.findOne({ role_id: roleId, status: oneOf(['pending_approval', 'scheduled']) }, { sort: { created_at: -1 } }),

    /* ------------------------------------------------ approval requests */
    insertRequest: (row) => t.requests.insert(row),
    getRequest: (id, opts) => t.requests.get(id, opts),
    updateRequest: async (id, patch) => found(await t.requests.update(id, patch), `approval request ${id}`),
    findOpenRequest: (actionKey, targetType, targetId) =>
      t.requests.findOne({ action_key: actionKey, target_type: targetType, target_id: targetId, status: oneOf(['pending', 'partially_approved', 'returned']) }),
    findRequests(f, opts = {}) {
      const dir = opts.order === 'created_asc' ? 1 : -1;
      return t.requests.find(requestFilter(f), { sort: { created_at: dir, id: dir }, ...(opts.limit ? { limit: opts.limit } : {}) });
    },
    pageRequests: (f, page) => t.requests.page(requestFilter(f), page, { column: 'created_at', direction: 'desc' }),
    candidateRequests: (roleKeys, accountId, f) =>
      t.requests.find(
        {
          $and: [
            requestFilter({ ...f, statuses: f.statuses ?? ['pending', 'partially_approved'] }),
            { $or: [{ nominated_reviewer_id: accountId }, ...(roleKeys.length ? [{ eligible_role_keys: { $in: roleKeys } }] : [])] },
          ],
        },
        { sort: { created_at: 1, id: 1 } },
      ),
    decisionsOf: async (ids) => (ids.length ? t.decisions.find({ request_id: oneOf(ids) }, { sort: { at: 1, step: 1 } }) : []),
    async insertDecision(row) {
      await t.decisions.insert(row);
    },
    async supersedeDecisions(requestId) {
      await t.decisions.updateMany({ request_id: requestId, decision: oneOf(['approved', 'returned', 'rejected']) }, [{ $set: { decision: { $concat: ['superseded_', '$decision'] } } }]);
    },

    /* ------------------------------------------------ away periods */
    async insertAway(row, coverage) {
      const out = await t.away.insert(row);
      await t.awayCoverage.insertMany(coverage);
      return out;
    },
    getAway: (id, opts) => t.away.get(id, opts),
    updateAway: async (id, patch) => found(await t.away.update(id, patch), `away period ${id}`),
    findAway: (f) => t.away.find(awayFilter(f), { sort: { starts_at: 1, id: 1 } }),
    pageAway: (f, page) => t.away.page(awayFilter(f), page, { column: 'starts_at', direction: 'asc' }),
    awayCoverage: async (ids) => (ids.length ? t.awayCoverage.find({ away_period_id: oneOf(ids) }) : []),
    async awayInForce(at) {
      const periods = await t.away.find({ status: oneOf(['scheduled', 'active']), starts_at: { $lte: at }, ends_at: { $gt: at } });
      const coverage = await repo.awayCoverage(periods.map((p) => p.id));
      return periods.map((period) => ({ period, coverage: coverage.filter((c) => c.away_period_id === period.id) }));
    },
  };
  return repo;
}
