import { sql, type Kysely, type Transaction } from 'kysely';
import { paginate, type PageRequest } from '../../../../kernel/lib/pagination.js';
import type { AccessDb } from '../../../../spec/access.js';
import type { Page } from '../../../../spec/common.js';
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
  RoleRow,
} from '../../ports.js';

/** jsonb columns are written as JSON text (the drivers would turn JS arrays into PostgreSQL arrays) */
const JSON_COLUMNS = new Set([
  'backup_account_ids',
  'default_eligible_role_keys',
  'second_reviewer_role_keys',
  'changes',
  'details',
  'requester_roles',
  'eligible_role_keys',
  'limit_snapshot',
  'roles',
]);

function enc<T extends object>(row: T): any {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v === undefined) continue;
    out[k] = JSON_COLUMNS.has(k) ? JSON.stringify(v ?? null) : v;
  }
  return out;
}

type Db = Kysely<AccessDb> | Transaction<AccessDb>;

/** Postgres adapter for AccessRepository. `db` is scoped to the `access` schema. */
export function createPostgresAccessRepository(root: Kysely<AccessDb>): AccessRepository {
  const make = (db: Db, inTx: boolean): AccessRepository => {
    const requestQuery = (f: RequestFilter) => {
      let q = db.selectFrom('approval_requests').selectAll();
      if (f.ids) q = f.ids.length ? q.where('id', 'in', f.ids) : q.where(sql<boolean>`false`);
      if (f.statuses) q = f.statuses.length ? q.where('status', 'in', [...f.statuses]) : q.where(sql<boolean>`false`);
      if (f.actionKey) q = q.where('action_key', '=', f.actionKey);
      if (f.module) q = q.where('module', '=', f.module);
      if (f.targetType) q = q.where('target_type', '=', f.targetType);
      if (f.targetIds) q = f.targetIds.length ? q.where('target_id', 'in', f.targetIds) : q.where(sql<boolean>`false`);
      if (f.sellerIds) q = f.sellerIds.length ? q.where('seller_id', 'in', f.sellerIds) : q.where(sql<boolean>`false`);
      if (f.requestedById) q = q.where('requested_by_id', '=', f.requestedById);
      if (f.dueBefore) q = q.where('due_at', '<', f.dueBefore);
      if (f.expiresBefore) q = q.where('expires_at', '<=', f.expiresBefore);
      return q;
    };
    const awayQuery = (f: AwayFilter) => {
      let q = db.selectFrom('away_periods').selectAll();
      if (f.accountId) q = q.where('account_id', '=', f.accountId);
      if (f.statuses) q = f.statuses.length ? q.where('status', 'in', [...f.statuses]) : q.where(sql<boolean>`false`);
      if (f.from) q = q.where('ends_at', '>', f.from);
      if (f.to) q = q.where('starts_at', '<', f.to);
      if (f.endsAfter) q = q.where('ends_at', '>', f.endsAfter);
      return q;
    };

    const repo: AccessRepository = {
      async transaction(fn) {
        if (inTx) return fn(repo);
        return root.transaction().execute((trx) => fn(make(trx, true)));
      },
      async lockRegistry() {
        await sql`select pg_advisory_xact_lock(hashtext('access.sync-registry'))`.execute(db);
      },

      /* ------------------------------------------------ registry */
      listPermissions: () => db.selectFrom('permissions').selectAll().orderBy('key').execute(),
      async upsertPermissions(rows) {
        for (let i = 0; i < rows.length; i += 200) {
          await db
            .insertInto('permissions')
            .values(rows.slice(i, i + 200).map(enc))
            .onConflict((oc) =>
              oc.column('key').doUpdateSet((eb) => ({
                module: eb.ref('excluded.module'),
                area: eb.ref('excluded.area'),
                label: eb.ref('excluded.label'),
                description: eb.ref('excluded.description'),
                sensitive: eb.ref('excluded.sensitive'),
                unavailable_since: sql`case when excluded.unavailable_since is null then null else coalesce(permissions.unavailable_since, excluded.unavailable_since) end`,
              })),
            )
            .execute();
        }
      },
      async markPermissionsUnavailable(exceptKeys, at) {
        let q = db.updateTable('permissions').set({ unavailable_since: at }).where('unavailable_since', 'is', null);
        if (exceptKeys.length) q = q.where('key', 'not in', exceptKeys);
        await q.execute();
      },
      listActions: () => db.selectFrom('approval_actions').selectAll().orderBy('key').execute(),
      getAction: (key) => db.selectFrom('approval_actions').selectAll().where('key', '=', key).executeTakeFirst(),
      async upsertActions(rows) {
        if (!rows.length) return;
        await db
          .insertInto('approval_actions')
          .values(rows.map(enc))
          .onConflict((oc) =>
            oc.column('key').doUpdateSet((eb) => ({
              module: eb.ref('excluded.module'),
              label: eb.ref('excluded.label'),
              limit_kind: eb.ref('excluded.limit_kind'),
              second_reviewer: eb.ref('excluded.second_reviewer'),
              approvers: eb.ref('excluded.approvers'),
              default_eligible_role_keys: eb.ref('excluded.default_eligible_role_keys'),
              unavailable_since: sql`case when excluded.unavailable_since is null then null else coalesce(approval_actions.unavailable_since, excluded.unavailable_since) end`,
            })),
          )
          .execute();
      },
      async markActionsUnavailable(exceptKeys, at) {
        let q = db.updateTable('approval_actions').set({ unavailable_since: at }).where('unavailable_since', 'is', null);
        if (exceptKeys.length) q = q.where('key', 'not in', exceptKeys);
        await q.execute();
      },

      /* ------------------------------------------------ roles */
      listRoles: () => db.selectFrom('roles').selectAll().orderBy('created_at').orderBy('name').execute(),
      async getRole(id, opts) {
        let q = db.selectFrom('roles').selectAll().where('id', '=', id);
        if (opts?.forUpdate) q = q.forUpdate();
        return q.executeTakeFirst();
      },
      getRoleByKey: (key) => db.selectFrom('roles').selectAll().where('key', '=', key).executeTakeFirst(),
      insertRole: (row) => db.insertInto('roles').values(enc(row)).onConflict((oc) => oc.column('key').doNothing()).returningAll().executeTakeFirst(),
      updateRole: (id, patch) => db.updateTable('roles').set(enc(patch)).where('id', '=', id).returningAll().executeTakeFirstOrThrow(),
      rolePermissions: (roleIds) => {
        let q = db.selectFrom('role_permissions').selectAll();
        if (roleIds) q = roleIds.length ? q.where('role_id', 'in', roleIds) : q.where(sql<boolean>`false`);
        return q.execute();
      },
      async addRolePermissions(roleId, keys, by, at) {
        if (!keys.length) return;
        await db
          .insertInto('role_permissions')
          .values(keys.map((k) => ({ role_id: roleId, permission_key: k, granted_by: by, granted_at: at })))
          .onConflict((oc) => oc.columns(['role_id', 'permission_key']).doNothing())
          .execute();
      },
      async removeRolePermissions(roleId, keys) {
        if (!keys.length) return;
        await db.deleteFrom('role_permissions').where('role_id', '=', roleId).where('permission_key', 'in', keys).execute();
      },
      async permissionKeysOfRoles(roleIds) {
        if (!roleIds.length) return [];
        const rows = await db.selectFrom('role_permissions').select('permission_key').distinct().where('role_id', 'in', roleIds).execute();
        return rows.map((r) => r.permission_key);
      },
      listCoverage: () => db.selectFrom('role_coverage').selectAll().execute(),
      getCoverage: (roleId) => db.selectFrom('role_coverage').selectAll().where('role_id', '=', roleId).executeTakeFirst(),
      upsertCoverage: (row) =>
        db
          .insertInto('role_coverage')
          .values(enc(row))
          .onConflict((oc) =>
            oc.column('role_id').doUpdateSet((eb) => ({
              lead_account_id: eb.ref('excluded.lead_account_id'),
              backup_account_ids: eb.ref('excluded.backup_account_ids'),
              updated_by: eb.ref('excluded.updated_by'),
              updated_at: eb.ref('excluded.updated_at'),
            })),
          )
          .returningAll()
          .executeTakeFirstOrThrow(),

      /* ------------------------------------------------ assignments */
      listAssignments(f) {
        let q = db.selectFrom('role_assignments').selectAll();
        if (f.accountId) q = q.where('account_id', '=', f.accountId);
        if (f.accountIds) q = f.accountIds.length ? q.where('account_id', 'in', f.accountIds) : q.where(sql<boolean>`false`);
        if (f.roleId) q = q.where('role_id', '=', f.roleId);
        if (f.statuses) q = f.statuses.length ? q.where('status', 'in', [...f.statuses]) : q.where(sql<boolean>`false`);
        return q.orderBy('granted_at').orderBy('id').execute();
      },
      activeAssignments(at, f = {}) {
        let q = db
          .selectFrom('role_assignments')
          .selectAll()
          .where('status', '=', 'active')
          .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', at)]));
        if (f.accountId) q = q.where('account_id', '=', f.accountId);
        if (f.roleIds) q = f.roleIds.length ? q.where('role_id', 'in', f.roleIds) : q.where(sql<boolean>`false`);
        return q.orderBy('granted_at').orderBy('id').execute();
      },
      async getAssignment(id, opts) {
        let q = db.selectFrom('role_assignments').selectAll().where('id', '=', id);
        if (opts?.forUpdate) q = q.forUpdate();
        return q.executeTakeFirst();
      },
      insertAssignment: (row) => db.insertInto('role_assignments').values(enc(row)).returningAll().executeTakeFirstOrThrow(),
      updateAssignment: (id, patch) => db.updateTable('role_assignments').set(enc(patch)).where('id', '=', id).returningAll().executeTakeFirstOrThrow(),
      async memberAccountIds() {
        const rows = await db.selectFrom('role_assignments').select('account_id').distinct().execute();
        return rows.map((r) => r.account_id);
      },

      /* ------------------------------------------------ limits */
      limitsInForce(at, f = {}) {
        let q = db
          .selectFrom('approval_limits')
          .selectAll()
          .where('effective_from', '<=', at)
          .where((eb) => eb.or([eb('effective_to', 'is', null), eb('effective_to', '>', at)]));
        if (f.roleIds) q = f.roleIds.length ? q.where('role_id', 'in', f.roleIds) : q.where(sql<boolean>`false`);
        if (f.actionKey) q = q.where('action_key', '=', f.actionKey);
        return q.orderBy('effective_from', 'desc').execute();
      },
      async limitRowExists(roleId, actionKey) {
        const r = await db.selectFrom('approval_limits').select('id').where('role_id', '=', roleId).where('action_key', '=', actionKey).limit(1).executeTakeFirst();
        return Boolean(r);
      },
      async insertLimits(rows) {
        if (rows.length) await db.insertInto('approval_limits').values(rows.map(enc)).execute();
      },
      async closeLimits(roleId, actionKey, at) {
        await db
          .updateTable('approval_limits')
          .set({ effective_to: at })
          .where('role_id', '=', roleId)
          .where('action_key', '=', actionKey)
          .where('effective_from', '<=', at)
          .where((eb) => eb.or([eb('effective_to', 'is', null), eb('effective_to', '>', at)]))
          .execute();
      },
      getLimitRows: (ids) => (ids.length ? db.selectFrom('approval_limits').selectAll().where('id', 'in', ids).execute() : Promise.resolve([])),

      /* ------------------------------------------------ limit changes */
      insertLimitChange: (row) => db.insertInto('limit_changes').values(enc(row)).returningAll().executeTakeFirstOrThrow(),
      async getLimitChange(id, opts) {
        let q = db.selectFrom('limit_changes').selectAll().where('id', '=', id);
        if (opts?.forUpdate) q = q.forUpdate();
        return q.executeTakeFirst();
      },
      updateLimitChange: (id, patch) => db.updateTable('limit_changes').set(enc(patch)).where('id', '=', id).returningAll().executeTakeFirstOrThrow(),
      listLimitChanges(f, page): Promise<Page<LimitChangeRow>> {
        let q = db.selectFrom('limit_changes').selectAll();
        if (f.status) q = q.where('status', '=', f.status);
        if (f.roleId) q = q.where('role_id', '=', f.roleId);
        return paginate(q, page, { column: 'created_at', direction: 'desc' });
      },
      limitChangesByIds: (ids) => (ids.length ? db.selectFrom('limit_changes').selectAll().where('id', 'in', ids).execute() : Promise.resolve([])),
      dueLimitChanges: (at, limit) =>
        db.selectFrom('limit_changes').selectAll().where('status', '=', 'scheduled').where('effective_from', '<=', at).orderBy('effective_from').orderBy('id').limit(limit).execute(),
      openLimitChangeOfRole: (roleId) =>
        db
          .selectFrom('limit_changes')
          .selectAll()
          .where('role_id', '=', roleId)
          .where('status', 'in', ['pending_approval', 'scheduled'])
          .orderBy('created_at', 'desc')
          .limit(1)
          .executeTakeFirst(),

      /* ------------------------------------------------ approval requests */
      insertRequest: (row) => db.insertInto('approval_requests').values(enc(row)).returningAll().executeTakeFirstOrThrow(),
      async getRequest(id, opts) {
        let q = db.selectFrom('approval_requests').selectAll().where('id', '=', id);
        if (opts?.forUpdate) q = q.forUpdate();
        return q.executeTakeFirst();
      },
      updateRequest: (id, patch) => db.updateTable('approval_requests').set(enc(patch)).where('id', '=', id).returningAll().executeTakeFirstOrThrow(),
      findOpenRequest: (actionKey, targetType, targetId) =>
        db
          .selectFrom('approval_requests')
          .selectAll()
          .where('action_key', '=', actionKey)
          .where('target_type', '=', targetType)
          .where('target_id', '=', targetId)
          .where('status', 'in', ['pending', 'partially_approved', 'returned'])
          .executeTakeFirst(),
      findRequests(f, opts = {}) {
        let q = requestQuery(f).orderBy('created_at', opts.order === 'created_asc' ? 'asc' : 'desc').orderBy('id', opts.order === 'created_asc' ? 'asc' : 'desc');
        if (opts.limit) q = q.limit(opts.limit);
        return q.execute();
      },
      pageRequests: (f, page) => paginate(requestQuery(f), page, { column: 'created_at', direction: 'desc' }),
      candidateRequests(roleKeys, accountId, f) {
        return requestQuery({ ...f, statuses: f.statuses ?? ['pending', 'partially_approved'] })
          .where((eb) =>
            eb.or([
              eb('nominated_reviewer_id', '=', accountId),
              ...(roleKeys.length ? [sql<boolean>`eligible_role_keys ?| array[${sql.join(roleKeys)}]::text[]`] : []),
            ]),
          )
          .orderBy('created_at')
          .orderBy('id')
          .execute();
      },
      decisionsOf: (ids) => (ids.length ? db.selectFrom('approval_decisions').selectAll().where('request_id', 'in', ids).orderBy('at').orderBy('step').execute() : Promise.resolve([])),
      async insertDecision(row: DecisionRow) {
        await db.insertInto('approval_decisions').values(enc(row)).execute();
      },
      async supersedeDecisions(requestId) {
        await db
          .updateTable('approval_decisions')
          .set({ decision: sql`'superseded_' || decision` })
          .where('request_id', '=', requestId)
          .where('decision', 'in', ['approved', 'returned', 'rejected'])
          .execute();
      },

      /* ------------------------------------------------ away periods */
      async insertAway(row: AwayRow, coverage: AwayCoverageRow[]) {
        const out = await db.insertInto('away_periods').values(enc(row)).returningAll().executeTakeFirstOrThrow();
        if (coverage.length) await db.insertInto('away_coverage').values(coverage).execute();
        return out;
      },
      async getAway(id, opts) {
        let q = db.selectFrom('away_periods').selectAll().where('id', '=', id);
        if (opts?.forUpdate) q = q.forUpdate();
        return q.executeTakeFirst();
      },
      updateAway: (id, patch) => db.updateTable('away_periods').set(enc(patch)).where('id', '=', id).returningAll().executeTakeFirstOrThrow(),
      findAway: (f) => awayQuery(f).orderBy('starts_at').orderBy('id').execute(),
      pageAway: (f, page: PageRequest) => paginate(awayQuery(f), page, { column: 'starts_at', direction: 'asc' }),
      awayCoverage: (ids) => (ids.length ? db.selectFrom('away_coverage').selectAll().where('away_period_id', 'in', ids).execute() : Promise.resolve([])),
      async awayInForce(at) {
        const periods = await db
          .selectFrom('away_periods')
          .selectAll()
          .where('status', 'in', ['scheduled', 'active'])
          .where('starts_at', '<=', at)
          .where('ends_at', '>', at)
          .execute();
        const coverage = await repo.awayCoverage(periods.map((p) => p.id));
        return periods.map((period) => ({ period, coverage: coverage.filter((c) => c.away_period_id === period.id) }));
      },
    };
    return repo;
  };
  return make(root, false);
}

export type { ActionRow, AssignmentRow, CoverageRow, LimitRow, PermissionRow, RequestRow, RoleRow };
