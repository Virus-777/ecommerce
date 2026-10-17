/**
 * Roles and the registry (Admin Center): role list and detail, custom roles, their permissions and coverage, and
 * the permissions and approval actions the modules register.
 */
import { AppError } from '../../../kernel/errors/index.js';
import { newId } from '../../../kernel/lib/ids.js';
import type * as audit from '../../../spec/audit.js';
import type {
  ApprovalAction,
  CoverageInput,
  Permission,
  PermissionGroup,
  Role,
  RoleCoverage,
  RoleDetail,
  RoleInput,
  RoleUpdate,
} from '../../../spec/access.js';
import { loadDirectory, type Directory } from '../directory.js';
import { limitSummary, type Issue, type LimitKind, type SecondMode } from '../domain/limits.js';
import { BUSINESS_OWNER, actionNoun, defaultEligibleRoleKeys, slugKey } from '../domain/seed.js';
import { OPEN_ASSIGNMENT, type ActionRow, type LimitRow, type RoleRow } from '../ports.js';
import { type Core, type Caller, SENSITIVE_GRANT, uniq, by, roleRef, validation, notFound } from './core.js';
import type { Approvals } from './approvals.js';
import type { AwayPeriods } from './away.js';
import type { Limits } from './limits.js';

export class Roles {
  constructor(readonly core: Core) {}

  private get approvals(): Approvals {
    return this.core.parts.approvals;
  }

  private get away(): AwayPeriods {
    return this.core.parts.away;
  }

  private get limits(): Limits {
    return this.core.parts.limits;
  }

  async listRoles(caller: Caller, query: { q?: string; includeArchived?: boolean }): Promise<Role[]> {
    await this.core.ready();
    const dir = await loadDirectory(this.core.repo, this.core.now());
    const q = query.q?.trim().toLowerCase();
    const rows = this.core.sortRoles(dir.roles.filter((r) => (query.includeArchived || !r.archived_at) && (!q || `${r.name} ${r.key} ${r.work_area}`.toLowerCase().includes(q))));
    return this.roleViews(rows, dir);
  }

  async getRole(caller: Caller, id: string): Promise<RoleDetail> {
    await this.core.ready();
    const dir = await loadDirectory(this.core.repo, this.core.now());
    const row = dir.roleById.get(id);
    if (!row) throw notFound('Role');
    return this.roleDetail(row, dir);
  }

  async createRole(caller: Caller, input: RoleInput): Promise<Role> {
    await this.core.ready();
    const name = input.name.trim();
    const workArea = input.workArea.trim();
    const issues: Issue[] = [];
    if (!name) issues.push({ path: 'name', message: 'Give the role a name' });
    if (!workArea) issues.push({ path: 'workArea', message: 'Choose a work area' });
    if (input.escalationRoleId && !(await this.core.repo.getRole(input.escalationRoleId))) issues.push({ path: 'escalationRoleId', message: 'Unknown escalation role' });
    if (issues.length) throw validation('The role cannot be created', issues);
    const now = this.core.now();
    const base = slugKey(name);
    let row: RoleRow | undefined;
    for (let i = 1; !row && i < 50; i++) {
      row = await this.core.repo.insertRole({
        id: newId(),
        key: i === 1 ? base : `${base}_${i}`,
        name,
        kind: input.kind ?? 'custom',
        work_area: workArea,
        description: input.description ?? null,
        system: false,
        escalation_role_id: input.escalationRoleId ?? null,
        archived_at: null,
        created_at: now,
        updated_at: now,
        version: 1,
      });
    }
    if (!row) throw new AppError('CONFLICT', 'Choose another role name');
    this.core.publishRoleChanged(row, 'created', null, caller.actor, caller.requestId);
    await this.core.audit({ action: 'access.role.create', actionLabel: 'Created role', target: this.roleTarget(row), after: row, reason: input.reason }, caller);
    const dir = await loadDirectory(this.core.repo, this.core.now());
    return (await this.roleViews([row], dir))[0]!;
  }

  async updateRole(caller: Caller, id: string, input: RoleUpdate): Promise<Role> {
    await this.core.ready();
    const issues: Issue[] = [];
    if (input.name != null && !input.name.trim()) issues.push({ path: 'name', message: 'Give the role a name' });
    if (input.workArea != null && !input.workArea.trim()) issues.push({ path: 'workArea', message: 'Choose a work area' });
    if (input.escalationRoleId) {
      if (input.escalationRoleId === id) issues.push({ path: 'escalationRoleId', message: 'A role cannot escalate to itself' });
      else if (!(await this.core.repo.getRole(input.escalationRoleId))) issues.push({ path: 'escalationRoleId', message: 'Unknown escalation role' });
    }
    if (issues.length) throw validation('The role cannot be changed', issues);
    const { before, after } = await this.core.repo.transaction(async (tx) => {
      const before = await tx.getRole(id, { forUpdate: true });
      if (!before) throw notFound('Role');
      const after = await tx.updateRole(id, {
        ...(input.name != null ? { name: input.name.trim() } : {}),
        ...(input.workArea != null ? { work_area: input.workArea.trim() } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.escalationRoleId !== undefined ? { escalation_role_id: input.escalationRoleId } : {}),
        updated_at: this.core.now(),
        version: before.version + 1,
      });
      return { before, after };
    });
    this.core.publishRoleChanged(after, 'updated', null, caller.actor, caller.requestId);
    await this.core.audit({ action: 'access.role.update', actionLabel: 'Changed role', target: this.roleTarget(after), before, after, reason: input.reason }, caller);
    const dir = await loadDirectory(this.core.repo, this.core.now());
    return (await this.roleViews([after], dir))[0]!;
  }

  async archiveRole(caller: Caller, id: string, reason: string): Promise<Role> {
    await this.core.ready();
    const { before, after } = await this.core.repo.transaction(async (tx) => {
      const before = await tx.getRole(id, { forUpdate: true });
      if (!before) throw notFound('Role');
      if (before.system) throw new AppError('SYSTEM_ROLE', `${before.name} is a system role and cannot be archived`);
      if (before.archived_at) return { before, after: before };
      const inUse = await tx.listAssignments({ roleId: id, statuses: OPEN_ASSIGNMENT });
      if (inUse.length) throw new AppError('ROLE_IN_USE', `Remove ${before.name} from ${inUse.length} staff member${inUse.length === 1 ? '' : 's'} before archiving it`, { assignments: inUse.length });
      const after = await tx.updateRole(id, { archived_at: this.core.now(), updated_at: this.core.now(), version: before.version + 1 });
      return { before, after };
    });
    if (before !== after) {
      this.core.publishRoleChanged(after, 'archived', null, caller.actor, caller.requestId);
      await this.core.audit({ action: 'access.role.archive', actionLabel: 'Archived role', target: this.roleTarget(after), before, after, reason }, caller);
    }
    const dir = await loadDirectory(this.core.repo, this.core.now());
    return (await this.roleViews([after], dir))[0]!;
  }

  async setRolePermissions(caller: Caller, id: string, permissionKeys: string[], reason: string): Promise<RoleDetail> {
    await this.core.ready();
    const role = await this.core.repo.getRole(id);
    if (!role) throw notFound('Role');
    if (role.archived_at) throw new AppError('CONFLICT', 'Archived roles cannot be changed');
    const registry = new Map((await this.core.repo.listPermissions()).map((p) => [p.key, p]));
    const desired = uniq(permissionKeys);
    const current = (await this.core.repo.rolePermissions([id])).map((r) => r.permission_key);
    // a held key of a module that is off comes back from the role detail as granted: keep it, never add one
    const unknown = desired.filter((k) => !registry.get(k) || (registry.get(k)!.unavailable_since && !current.includes(k)));
    if (unknown.length) throw new AppError('UNKNOWN_PERMISSION', `Not in the permission registry: ${unknown.join(', ')}`, { keys: unknown });
    const remove = current.filter((k) => !desired.includes(k));
    const add = desired.filter((k) => !current.includes(k));
    const dir = await loadDirectory(this.core.repo, this.core.now());
    const holdsRole = Boolean(caller.principal.accountId && dir.holds(caller.principal.accountId, id));
    const prefixes = await this.core.sensitivePrefixes();
    const pending = holdsRole || role.key === BUSINESS_OWNER ? add : add.filter((k) => this.core.isSensitive(k, prefixes));
    const immediate = add.filter((k) => !pending.includes(k));

    await this.core.repo.transaction(async (tx) => {
      await tx.removeRolePermissions(id, remove);
      await tx.addRolePermissions(id, immediate, by(caller.actor), this.core.now());
    });
    let approvalRequestId: string | null = null;
    if (pending.length) {
      // a newer proposal replaces a waiting one for the same role
      const waiting = await this.core.repo.findOpenRequest(SENSITIVE_GRANT, 'role_permissions', id);
      if (waiting) await this.approvals.closeRequest(waiting.id, 'cancel', caller.actor, 'Replaced by a newer permission change');
      const req = await this.approvals.openRequest(
        {
          action: SENSITIVE_GRANT,
          target: { type: 'role_permissions', id, ref: role.key, label: role.name, screen: 'admin/staff' },
          summary: `Grant ${pending.length} permission${pending.length === 1 ? '' : 's'} to ${role.name}`,
          details: { roleId: id, roleKey: role.key, permissionKeys: pending, removed: remove },
          reason,
          requestedBy: caller.principal,
        },
        { restrictToBusinessOwner: holdsRole || role.key === BUSINESS_OWNER, requestedByActor: caller.actor, requestId: caller.requestId },
      );
      approvalRequestId = req.id;
    }
    if (remove.length || immediate.length) this.core.publishRoleChanged(role, 'permissions_changed', null, caller.actor, caller.requestId);
    await this.core.audit(
      {
        action: 'access.role.permissions',
        actionLabel: 'Changed role permissions',
        target: this.roleTarget(role),
        before: { permissionKeys: current },
        after: { permissionKeys: current.filter((k) => !remove.includes(k)).concat(immediate), pendingApproval: pending },
        reason,
        approvalRequestId,
      },
      caller,
    );
    const fresh = await loadDirectory(this.core.repo, this.core.now());
    return this.roleDetail(fresh.roleById.get(id)!, fresh);
  }

  async setRoleCoverage(caller: Caller, id: string, input: CoverageInput): Promise<RoleCoverage> {
    await this.core.ready();
    const dir = await loadDirectory(this.core.repo, this.core.now());
    const role = dir.roleById.get(id);
    if (!role) throw notFound('Role');
    const eligible = (acc: string) => dir.holds(acc, id) || dir.isBusinessOwner(acc);
    const issues: Issue[] = [];
    const lead = input.leadAccountId ?? null;
    if (lead && !eligible(lead)) issues.push({ path: 'leadAccountId', message: `The lead must hold ${role.name} (or be Business Owner)` });
    input.backupAccountIds.forEach((b, i) => {
      if (b === lead) issues.push({ path: `backupAccountIds.${i}`, message: 'A backup cannot be the lead' });
      else if (input.backupAccountIds.indexOf(b) !== i) issues.push({ path: `backupAccountIds.${i}`, message: 'Listed twice' });
      else if (!eligible(b)) issues.push({ path: `backupAccountIds.${i}`, message: `Backups must hold ${role.name} (or be Business Owner)` });
    });
    if (input.escalationRoleId) {
      if (input.escalationRoleId === id) issues.push({ path: 'escalationRoleId', message: 'A role cannot escalate to itself' });
      else if (!dir.roleById.get(input.escalationRoleId)) issues.push({ path: 'escalationRoleId', message: 'Unknown escalation role' });
    }
    if (issues.length) throw new AppError('COVERAGE_INVALID', 'The cover for this role is not valid', { issues });
    const before = dir.coverage.get(id) ?? { lead: null, backups: [] };
    await this.core.repo.transaction(async (tx) => {
      await tx.upsertCoverage({ role_id: id, lead_account_id: lead, backup_account_ids: uniq(input.backupAccountIds), updated_by: by(caller.actor), updated_at: this.core.now() });
      if (input.escalationRoleId !== undefined) await tx.updateRole(id, { escalation_role_id: input.escalationRoleId, updated_at: this.core.now(), version: role.version + 1 });
    });
    const fresh = await loadDirectory(this.core.repo, this.core.now());
    const cov = (await this.away.coverageOfRoles(fresh, [id])).roles[0]!;
    this.away.publishCoverage(cov);
    await this.core.audit(
      {
        action: 'access.role.coverage',
        actionLabel: 'Set lead and backups',
        target: this.roleTarget(role),
        before: { leadAccountId: before.lead, backupAccountIds: before.backups, escalationRoleId: role.escalation_role_id },
        after: { leadAccountId: lead, backupAccountIds: input.backupAccountIds, escalationRoleId: input.escalationRoleId === undefined ? role.escalation_role_id : input.escalationRoleId },
        reason: input.reason,
      },
      caller,
    );
    return cov;
  }

  async listPermissions(caller: Caller, query: { module?: string }): Promise<PermissionGroup[]> {
    await this.core.ready();
    const rows = (await this.core.repo.listPermissions()).filter((p) => !p.unavailable_since && (!query.module || p.module === query.module));
    const mine = new Set(caller.principal.accountId ? await this.core.permissionsOf(caller.principal.accountId) : []);
    return this.groupPermissions(rows.map((p) => ({ permission: this.permissionView(p), granted: mine.has(p.key) })));
  }

  async listApprovalActions(): Promise<ApprovalAction[]> {
    await this.core.ready();
    return (await this.core.repo.listActions()).map((a) => this.actionView(a)).sort((a, b) => Number(b.available) - Number(a.available) || a.key.localeCompare(b.key));
  }

  actionView(a: ActionRow): ApprovalAction {
    return {
      key: a.key,
      module: a.module,
      label: a.label,
      limit: a.limit_kind,
      secondReviewer: a.second_reviewer,
      approvers: a.approvers,
      defaultEligibleRoleKeys: (a.default_eligible_role_keys as string[]) ?? [],
      available: !a.unavailable_since,
    };
  }

  private permissionView(p: { key: string; module: string; area: string; label: string; description: string; sensitive: boolean; unavailable_since: Date | null }): Permission {
    return { key: p.key, module: p.module, area: p.area, label: p.label, desc: p.description, sensitive: p.sensitive, available: !p.unavailable_since };
  }

  private groupPermissions(grants: { permission: Permission; granted: boolean }[]): PermissionGroup[] {
    const groups = new Map<string, { permission: Permission; granted: boolean }[]>();
    for (const g of grants) groups.set(g.permission.area, [...(groups.get(g.permission.area) ?? []), g]);
    return [...groups]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([area, permissions]) => ({ area, permissions: permissions.sort((a, b) => a.permission.key.localeCompare(b.permission.key)), grantedCount: permissions.filter((p) => p.granted).length }));
  }

  roleTarget(r: RoleRow): audit.AuditTarget {
    return { type: 'role', id: r.id, ref: r.key, label: r.name, screen: 'admin/staff' };
  }

  private async roleViews(rows: RoleRow[], dir: Directory): Promise<Role[]> {
    const ids = uniq(rows.flatMap((r) => [...dir.membersOf(r.id), ...(dir.coverage.get(r.id)?.lead ? [dir.coverage.get(r.id)!.lead!] : []), ...(dir.coverage.get(r.id)?.backups ?? [])]));
    const refs = await this.core.staffRefs(ids, dir);
    const limits = await this.core.repo.limitsInForce(this.core.now(), { roleIds: rows.map((r) => r.id) });
    const actions = new Map((await this.core.repo.listActions()).map((a) => [a.key, a]));
    return rows.map((r) => {
      const cov = dir.coverage.get(r.id);
      const esc = r.escalation_role_id ? dir.roleById.get(r.escalation_role_id) : undefined;
      return {
        id: r.id,
        key: r.key,
        name: r.name,
        kind: r.kind,
        workArea: r.work_area,
        description: r.description,
        system: r.system,
        archived: Boolean(r.archived_at),
        people: dir.membersOf(r.id).map((id) => refs.get(id)!).filter(Boolean),
        lead: cov?.lead ? (refs.get(cov.lead) ?? null) : null,
        backups: (cov?.backups ?? []).map((id) => refs.get(id)!).filter(Boolean),
        escalationRole: esc ? roleRef(esc) : null,
        permissionCount: dir.permsByRole.get(r.id)?.size ?? 0,
        limitSummary: this.roleLimitSummary(limits.filter((l) => l.role_id === r.id), actions),
      };
    });
  }

  private roleLimitSummary(limits: LimitRow[], actions: Map<string, ActionRow>): string {
    const KIND_RANK: Record<string, number> = { money: 0, units: 1, percent: 2, none: 3 };
    const parts = limits
      .filter((l) => l.authority !== 'not_permitted' && actions.get(l.action_key) && !actions.get(l.action_key)!.unavailable_since)
      // the largest money authority first: it says most about the role
      .sort(
        (a, b) =>
          (KIND_RANK[actions.get(a.action_key)!.limit_kind] ?? 9) - (KIND_RANK[actions.get(b.action_key)!.limit_kind] ?? 9) ||
          (b.limit_amount_minor ?? Number.MAX_SAFE_INTEGER) - (a.limit_amount_minor ?? Number.MAX_SAFE_INTEGER) ||
          a.action_key.localeCompare(b.action_key),
      )
      .map((l) => {
        const act = actions.get(l.action_key)!;
        const s = limitSummary(act.limit_kind as LimitKind, act.second_reviewer as SecondMode, this.limits.limitValue(l));
        return `${actionNoun(l.action_key)}: ${s.charAt(0).toLowerCase()}${s.slice(1)}`;
      });
    if (!parts.length) return 'No financial authority';
    return parts.length > 3 ? `${parts.slice(0, 3).join('; ')}; +${parts.length - 3} more` : parts.join('; ');
  }

  private async roleDetail(row: RoleRow, dir: Directory): Promise<RoleDetail> {
    const [role] = await this.roleViews([row], dir);
    const registry = await this.core.repo.listPermissions();
    const granted = dir.permsByRole.get(row.id) ?? new Set<string>();
    const grants = registry.filter((p) => !p.unavailable_since || granted.has(p.key)).map((p) => ({ permission: this.permissionView(p), granted: granted.has(p.key) }));
    const limits = await this.core.repo.limitsInForce(this.core.now(), { roleIds: [row.id] });
    const pendingChange = await this.core.repo.openLimitChangeOfRole(row.id);
    const pendingPerms = await this.core.repo.findOpenRequest(SENSITIVE_GRANT, 'role_permissions', row.id);
    return {
      role: role!,
      permissions: this.groupPermissions(grants),
      limits: await this.limits.limitViews(limits, dir),
      pendingLimitChange: pendingChange ? ((await this.limits.limitChangeViews([pendingChange], dir))[0] ?? null) : null,
      pendingPermissionApproval: pendingPerms ? ((await this.approvals.approvalInfos([pendingPerms], dir))[0] ?? null) : null,
    };
  }
}
