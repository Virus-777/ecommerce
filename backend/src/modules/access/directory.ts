/**
 * A read-time picture of who holds what (roles, active assignments, coverage, away periods in force,
 * role permissions, limit reviews), loaded in a handful of queries and shared by one use case.
 * Away cover is computed from now in [from, to), so it ends even when the job scheduler is off.
 */
import { BUSINESS_OWNER } from './domain/seed.js';
import type { AssignmentRow, AwayCoverageRow, AwayRow, RoleRow } from './ports.js';
import type { AccessRepository } from './repository.js';

export interface Directory {
  now: Date;
  roles: RoleRow[];
  roleById: Map<string, RoleRow>;
  roleByKey: Map<string, RoleRow>;
  /** Active, unexpired assignments */
  assignments: AssignmentRow[];
  coverage: Map<string, { lead: string | null; backups: string[] }>;
  away: { period: AwayRow; coverage: AwayCoverageRow[] }[];
  permsByRole: Map<string, Set<string>>;
  /** Accounts whose approval limits wait for the Business Owner's review */
  blocked: Set<string>;
  rolesOf(accountId: string): RoleRow[];
  holds(accountId: string, roleId: string): boolean;
  membersOf(roleId: string): string[];
  awayOf(accountId: string): AwayRow | undefined;
  /** Roles a person covers for someone away now (delegated: the Business Owner approved handing over the role's permissions and limits) */
  covering(accountId: string): { roleId: string; from: string; delegated: boolean }[];
  /** Effective permission keys: own roles plus roles covered with approved delegation */
  permissionsOf(accountId: string): Set<string>;
  isBusinessOwner(accountId: string): boolean;
}

export async function loadDirectory(repo: AccessRepository, now: Date): Promise<Directory> {
  const [roles, assignments, coverageRows, away, rolePerms, reviews] = await Promise.all([
    repo.listRoles(),
    repo.activeAssignments(now),
    repo.listCoverage(),
    repo.awayInForce(now),
    repo.rolePermissions(),
    repo.findRequests({ actionKey: 'access.limits.change', targetType: 'staff_member' }, { order: 'created_asc' }),
  ]);
  const roleById = new Map(roles.map((r) => [r.id, r]));
  const roleByKey = new Map(roles.map((r) => [r.key, r]));
  const coverage = new Map(coverageRows.map((c) => [c.role_id, { lead: c.lead_account_id, backups: Array.isArray(c.backup_account_ids) ? (c.backup_account_ids as string[]) : [] }]));
  const permsByRole = new Map<string, Set<string>>();
  for (const rp of rolePerms) {
    if (!permsByRole.has(rp.role_id)) permsByRole.set(rp.role_id, new Set());
    permsByRole.get(rp.role_id)!.add(rp.permission_key);
  }
  // the latest limit review per member decides (created_asc: later rows overwrite earlier ones)
  const review = new Map<string, string>();
  for (const r of reviews) review.set(r.target_id, r.status);
  const blocked = new Set([...review].filter(([, status]) => status !== 'approved').map(([id]) => id));

  const byAccount = new Map<string, AssignmentRow[]>();
  const byRole = new Map<string, string[]>();
  for (const a of assignments) {
    byAccount.set(a.account_id, [...(byAccount.get(a.account_id) ?? []), a]);
    const list = byRole.get(a.role_id) ?? [];
    if (!list.includes(a.account_id)) list.push(a.account_id);
    byRole.set(a.role_id, list);
  }
  const holds = (accountId: string, roleId: string) => (byAccount.get(accountId) ?? []).some((a) => a.role_id === roleId);
  const bo = roleByKey.get(BUSINESS_OWNER);
  const isBusinessOwner = (accountId: string) => Boolean(bo && holds(accountId, bo.id));

  const dir: Directory = {
    now,
    roles,
    roleById,
    roleByKey,
    assignments,
    coverage,
    away,
    permsByRole,
    blocked,
    rolesOf: (accountId) =>
      (byAccount.get(accountId) ?? [])
        .map((a) => roleById.get(a.role_id))
        .filter((r): r is RoleRow => Boolean(r && !r.archived_at))
        .filter((r, i, all) => all.findIndex((x) => x.id === r.id) === i),
    holds,
    membersOf: (roleId) => byRole.get(roleId) ?? [],
    awayOf: (accountId) => away.find((a) => a.period.account_id === accountId)?.period,
    covering(accountId) {
      const out: { roleId: string; from: string; delegated: boolean }[] = [];
      for (const { period, coverage: cov } of away) {
        for (const c of cov) {
          if (c.covered_by_account_id !== accountId) continue;
          // the away person must still hold the role they handed over
          if (!holds(period.account_id, c.role_id)) continue;
          out.push({ roleId: c.role_id, from: period.account_id, delegated: period.delegate_approvals });
        }
      }
      return out;
    },
    permissionsOf(accountId) {
      // a covered role grants its permissions only where the away period grants them: delegation approved by the Business Owner
      const roleIds = new Set([...dir.rolesOf(accountId).map((r) => r.id), ...dir.covering(accountId).filter((c) => c.delegated).map((c) => c.roleId)]);
      const out = new Set<string>();
      for (const id of roleIds) for (const k of permsByRole.get(id) ?? []) out.add(k);
      return out;
    },
    isBusinessOwner,
  };
  return dir;
}
