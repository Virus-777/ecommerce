/**
 * Staff members and role assignments: the member list and detail, inviting staff, the owner bootstrap, assigning
 * and revoking roles (sensitive grants need a second person), and the staff directory reads of the public API.
 */
import { SYSTEM_ACTOR } from '../../../kernel/auth/index.js';
import { AppError } from '../../../kernel/errors/index.js';
import { newId } from '../../../kernel/lib/ids.js';
import { pageOf, type PageRequest } from '../../../kernel/lib/pagination.js';
import type * as audit from '../../../spec/audit.js';
import type * as common from '../../../spec/common.js';
import type * as identity from '../../../spec/identity.js';
import type {
  MyAccess,
  Role,
  RoleAssignment,
  RoleRef,
  StaffInvitationInput,
  StaffInvitationSent,
  StaffMember,
  StaffMemberDetail,
  StaffRef,
} from '../../../spec/access.js';
import { loadDirectory, loadStaffDirectory, type Directory } from '../directory.js';
import type { Issue } from '../domain/limits.js';
import { BUSINESS_OWNER, PLATFORM_ADMINISTRATOR } from '../domain/seed.js';
import { roleAssignmentMachine } from '../domain/state-machines.js';
import { OPEN_ASSIGNMENT, OPEN_REQUEST, type AssignmentRow, type AwayRow, type RoleRow } from '../ports.js';
import {
  type Core,
  type Caller,
  type BootstrapOwnerInput,
  type BootstrapOwnerResult,
  type Accounts,
  SENSITIVE_GRANT,
  LIMITS_CHANGE,
  FINAL,
  iso,
  uniq,
  by,
  actorFrom,
  roleRef,
  validation,
  notFound,
  STATUS,
} from './core.js';
import type { Limits } from './limits.js';
import type { AwayPeriods } from './away.js';
import type { Approvals } from './approvals.js';
import type { Roles } from './roles.js';

export class Members {
  constructor(readonly core: Core) {}

  private get limits(): Limits {
    return this.core.parts.limits;
  }

  private get away(): AwayPeriods {
    return this.core.parts.away;
  }

  private get approvals(): Approvals {
    return this.core.parts.approvals;
  }

  private get roles(): Roles {
    return this.core.parts.roles;
  }

  /** Active roles of a staff member (audit stores them with each entry) */
  async rolesOf(accountId: string): Promise<RoleRef[]> {
    await this.core.ready();
    // audit asks on every staff entry: the person's assignments and their roles only, not the whole directory
    const assignments = await this.core.repo.activeAssignments(this.core.now(), { accountId });
    const roles = await this.core.repo.getRoles(uniq(assignments.map((a) => a.role_id)));
    return this.core.sortRoles(roles.filter((r) => !r.archived_at)).map(roleRef);
  }

  /**
   * Whether `byAccountId` may disable `accountId` (identity asks before disabling a staff account): a Business Owner
   * is disabled only by another Business Owner, and never the last active one (the role would end with the account)
   */
  async disableCheck(accountId: string, byAccountId: string | null): Promise<{ allowed: boolean; code: string | null; reason: string | null }> {
    await this.core.ready();
    const dir = await loadStaffDirectory(this.core.repo, this.core.now());
    const role = dir.roleByKey.get(BUSINESS_OWNER);
    const owners = role ? dir.membersOf(role.id) : [];
    if (!owners.includes(accountId)) return { allowed: true, code: null, reason: null };
    if (!byAccountId || !owners.includes(byAccountId)) return { allowed: false, code: 'FORBIDDEN', reason: 'Only a Business Owner can disable a Business Owner' };
    if (!owners.some((o) => o !== accountId)) return { allowed: false, code: 'LAST_BUSINESS_OWNER', reason: 'At least one active Business Owner must remain' };
    return { allowed: true, code: null, reason: null };
  }

  /** Everyone holding a role (assignment pickers in workqueues and support) */
  async membersOfRole(roleKey: string): Promise<StaffRef[]> {
    await this.core.ready();
    const dir = await loadStaffDirectory(this.core.repo, this.core.now());
    const role = dir.roleByKey.get(roleKey);
    if (!role) return [];
    const ids = dir.membersOf(role.id);
    const refs = await this.core.staffRefs(ids, dir);
    return ids.map((id) => refs.get(id)!).sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Active staff whose active role assignments grant the permission (the hasPermission rule: own roles plus roles
   * covered with an approved delegation). Disabled or closed accounts are left out; locked ones are shown away.
   * includeCovering adds people who hold it only as an away-period backup (without delegation).
   */
  async staffWithPermission(permissionKey: string, opts?: { includeCovering?: boolean }): Promise<StaffRef[]> {
    await this.core.ready();
    const dir = await loadDirectory(this.core.repo, this.core.now());
    const holders = new Set<string>();
    for (const a of dir.assignments) {
      const role = dir.roleById.get(a.role_id);
      if (role && !role.archived_at && dir.permsByRole.get(role.id)?.has(permissionKey)) holders.add(a.account_id);
    }
    for (const { period, coverage } of dir.away) {
      for (const c of coverage) {
        if (!c.covered_by_account_id || !dir.holds(period.account_id, c.role_id)) continue;
        if (!dir.permsByRole.get(c.role_id)?.has(permissionKey)) continue;
        if (period.delegate_approvals || opts?.includeCovering) holders.add(c.covered_by_account_id);
      }
    }
    const ids = [...holders];
    const accounts = await this.core.accounts(ids);
    const refs = await this.core.staffRefs(ids, dir, accounts);
    return ids
      .filter((id) => {
        const status = accounts.get(id)?.status;
        return status !== 'disabled' && status !== 'closed';
      })
      .map((id) => {
        const ref = refs.get(id)!;
        return accounts.get(id)?.status === 'locked' ? { ...ref, away: true } : ref;
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** A staff member's display name and role label (roleLabel) for assignee, owner, reviewer and decider columns */
  async getStaffRef(staffId: string): Promise<StaffRef | null> {
    await this.core.ready();
    const [dir, accounts] = await Promise.all([loadStaffDirectory(this.core.repo, this.core.now()), this.core.accounts([staffId])]);
    const known = accounts.has(staffId) || dir.rolesOf(staffId).length > 0 || (await this.core.repo.listAssignments({ accountId: staffId })).length > 0;
    if (!known) return null;
    return (await this.core.staffRefs([staffId], dir, accounts)).get(staffId) ?? null;
  }

  async listMembers(caller: Caller, query: { q?: string; roleId?: string; status?: StaffMember['status']; away?: boolean }, page: PageRequest): Promise<common.Page<StaffMember>> {
    await this.core.ready();
    const dir = await loadDirectory(this.core.repo, this.core.now());
    const ids = await this.core.repo.memberAccountIds();
    const accounts = await this.core.requireAccounts(ids);
    let members = await this.memberViews(
      ids.filter((id) => accounts.has(id)),
      dir,
      accounts,
    );
    const q = query.q?.trim().toLowerCase();
    if (q) members = members.filter((m) => `${m.account.displayName} ${m.account.email}`.toLowerCase().includes(q));
    if (query.roleId) members = members.filter((m) => m.roles.some((r) => r.id === query.roleId));
    if (query.status) members = members.filter((m) => m.status === query.status);
    if (query.away !== undefined) members = members.filter((m) => Boolean(m.away) === query.away);
    members.sort((a, b) => a.account.displayName.localeCompare(b.account.displayName));
    return pageOf(members, page);
  }

  async getMember(caller: Caller, accountId: string): Promise<StaffMemberDetail> {
    await this.core.ready();
    const dir = await loadDirectory(this.core.repo, this.core.now());
    const [assignments, accounts] = await Promise.all([this.core.repo.listAssignments({ accountId }), this.core.requireAccounts([accountId])]);
    const account = accounts.get(accountId);
    if (!account || (account.realm !== 'staff' && !assignments.length)) throw notFound('Staff member');
    const [member] = await this.memberViews([accountId], dir, accounts);
    const limits = await this.core.repo.limitsInForce(this.core.now(), { roleIds: dir.rolesOf(accountId).map((r) => r.id) });
    const away = await this.core.repo.findAway({ accountId });
    return {
      member: member!,
      assignments: await this.assignmentViews(assignments, dir),
      effectivePermissions: [...dir.permissionsOf(accountId)].sort(),
      effectiveLimits: await this.limits.limitViews(limits, dir),
      awayPeriods: await this.away.awayViews(away, dir),
      approvalsWaiting: (await this.approvals.toDecide({ kind: 'staff', accountId }, {}, dir)).length,
    };
  }

  async inviteStaff(caller: Caller, input: StaffInvitationInput): Promise<StaffInvitationSent> {
    await this.core.ready();
    const dir = await loadDirectory(this.core.repo, this.core.now());
    const roles = uniq(input.roleIds).map((id) => dir.roleById.get(id));
    const issues: Issue[] = [];
    if (!input.roleIds.length) issues.push({ path: 'roleIds', message: 'Choose at least one role' });
    roles.forEach((r, i) => {
      if (!r) issues.push({ path: `roleIds.${i}`, message: 'Unknown role' });
      else if (r.archived_at) issues.push({ path: `roleIds.${i}`, message: `${r.name} is archived` });
    });
    if (input.reportsToAccountId && !dir.rolesOf(input.reportsToAccountId).length) issues.push({ path: 'reportsToAccountId', message: 'Not a staff member with a role' });
    if (issues.length) throw validation('The invitation cannot be sent', issues);

    const idp = this.core.ctx.use('identity');
    // the link and pass code go back to the inviter once (no email offline); npm run staff-link can issue new ones
    const { invitation, acceptUrl, passCode } = await idp.inviteStaff({ email: input.email, name: input.name, invitedBy: caller.actor });
    const accountId = invitation.accountId ?? (await idp.findAccountByEmail(input.email, 'staff'))?.id;
    if (!accountId) throw new AppError('CONFLICT', 'The staff account could not be created; try again');
    const prefixes = await this.core.sensitivePrefixes();
    const created: AssignmentRow[] = [];
    for (const role of roles as RoleRow[]) {
      const row = await this.createAssignment(caller, { accountId, role, reason: input.reason, expiresAt: null, invited: true, accountName: input.name }, dir, prefixes);
      if (row) created.push(row);
    }
    if (input.requestLimitReview) {
      await this.approvals.openRequest(
        {
          action: LIMITS_CHANGE,
          target: { type: 'staff_member', id: accountId, label: input.name, screen: 'admin/staff' },
          summary: `Confirm the approval limits of ${input.name}`,
          details: { accountId, roles: (roles as RoleRow[]).map(roleRef) },
          reason: input.reason,
          requestedBy: caller.principal,
        },
        { restrictToBusinessOwner: true, requestedByActor: caller.actor, requestId: caller.requestId },
      );
    }
    await this.core.audit(
      {
        action: 'access.staff.invite',
        actionLabel: 'Invited staff member',
        target: { type: 'staff', id: accountId, label: input.name },
        after: { email: input.email, roles: (roles as RoleRow[]).map((r) => r.key), assignments: created.map((a) => ({ id: a.id, status: a.status })), requestLimitReview: Boolean(input.requestLimitReview) },
        reason: input.reason,
      },
      caller,
    );
    const fresh = await loadDirectory(this.core.repo, this.core.now());
    const accounts = await this.core.accounts([accountId]);
    if (!accounts.has(accountId)) {
      accounts.set(accountId, { id: accountId, realm: 'staff', email: input.email, displayName: input.name, status: 'invited', emailVerified: false, twoStepEnabled: false });
    }
    const member = (await this.memberViews([accountId], fresh, accounts))[0]!;
    return { member, acceptUrl, passCode, expiresAt: invitation.expiresAt };
  }

  /**
   * The first Business Owner (operator command `npm run bootstrap-owner`, never reachable over HTTP).
   * Every other Business Owner grant needs a Business Owner's approval, so the first one is created
   * here, only while nobody holds or awaits the role. The person also gets Platform Administrator, so
   * they can invite the rest of the staff (the Business Owner role itself doesn't manage staff); they can
   * hand that role to someone else later. Invites the person through identity; the roles become active
   * when they accept (onInvitationAcceptedFromIdentity).
   *
   * With a deputy, both people are invited and both get Business Owner and Platform Administrator, so
   * the two-person rules work from day one: either can approve the sensitive grants the other requests
   * (a Finance Manager, another Business Owner), and neither can approve their own.
   */
  async bootstrapBusinessOwner(input: BootstrapOwnerInput): Promise<BootstrapOwnerResult> {
    await this.core.ready();
    const issues: Issue[] = [];
    const people: { email: string; name: string; path: string }[] = [{ ...input, path: '' }];
    if (input.deputy) people.push({ ...input.deputy, path: 'deputy.' });
    for (const p of people) {
      if (!p.email?.trim()) issues.push({ path: `${p.path}email`, message: 'Required' });
      if (!p.name?.trim()) issues.push({ path: `${p.path}name`, message: 'Required' });
    }
    if (input.deputy && input.deputy.email?.trim().toLowerCase() === input.email?.trim().toLowerCase()) {
      issues.push({ path: 'deputy.email', message: 'The deputy must be a different person from the owner' });
    }
    if (issues.length) throw validation('The Business Owner cannot be created', issues);

    const dir = await loadDirectory(this.core.repo, this.core.now());
    const role = dir.roleByKey.get(BUSINESS_OWNER);
    const admin = dir.roleByKey.get(PLATFORM_ADMINISTRATOR);
    if (!role || !admin) throw new Error('The Business Owner and Platform Administrator roles are not seeded');
    if ((await this.core.repo.listAssignments({ roleId: role.id, statuses: OPEN_ASSIGNMENT })).length) {
      throw new AppError('CONFLICT', 'A Business Owner already exists or is invited; invite other staff from the Admin Center');
    }
    const system: common.Actor = { kind: 'system', name: 'bootstrap' };
    const idp = this.core.ctx.use('identity');
    // invite everyone first (identity's own writes), then seat them in one transaction
    const invited: { email: string; name: string; accountId: string; invitationId: string; acceptUrl: string; passCode: string; deputy: boolean }[] = [];
    for (const p of people) {
      const issued = await idp.inviteStaff({ email: p.email.trim(), name: p.name.trim(), invitedBy: system });
      const accountId = issued.invitation.accountId ?? (await idp.findAccountByEmail(p.email.trim(), 'staff'))?.id;
      if (!accountId) throw new AppError('CONFLICT', 'The staff account could not be created; try again');
      invited.push({ email: p.email.trim(), name: p.name.trim(), accountId, invitationId: issued.invitation.id, acceptUrl: issued.acceptUrl, passCode: issued.passCode, deputy: p.path !== '' });
    }
    const now = this.core.now();
    const seated = await this.core.repo.transaction(async (tx) => {
      // checked again under the transaction: two bootstraps at once must not both win
      if ((await tx.listAssignments({ roleId: role.id, statuses: OPEN_ASSIGNMENT })).length) {
        throw new AppError('CONFLICT', 'A Business Owner already exists or is invited; invite other staff from the Admin Center');
      }
      const rows: { person: (typeof invited)[number]; role: RoleRow; row: AssignmentRow }[] = [];
      for (const person of invited) {
        for (const r of [role, admin]) {
          const row = await tx.insertAssignment({
            id: newId(),
            account_id: person.accountId,
            role_id: r.id,
            status: roleAssignmentMachine.initial,
            granted_by_kind: 'system',
            granted_by_id: '',
            reason: person.deputy ? 'Deputy Business Owner' : 'First Business Owner',
            granted_at: now,
            expires_at: null,
            revoked_at: null,
            revoked_by: null,
            revoke_reason: null,
            approval_request_id: null,
          });
          rows.push({ person, role: r, row });
        }
      }
      return rows;
    });
    for (const { person, role: r, row } of seated) {
      await this.core.audit(
        {
          action: 'access.role.assign',
          actionLabel: `Gave ${r.name} to the ${person.deputy ? 'deputy' : 'first'} Business Owner`,
          target: { type: 'staff', id: person.accountId, label: person.name },
          relatedTargets: [this.roles.roleTarget(r)],
          after: { roleKey: r.key, status: row.status, email: person.email },
          reason: person.deputy ? 'Deputy Business Owner (bootstrap)' : 'First Business Owner (bootstrap)',
        },
        { actor: system },
      );
    }
    // the links and pass codes go back to npm run bootstrap-owner, which prints them for the operator
    const invitee = (p: (typeof invited)[number]) => ({ accountId: p.accountId, invitationId: p.invitationId, acceptUrl: p.acceptUrl, passCode: p.passCode });
    const [owner, deputy] = invited;
    return { ...invitee(owner!), deputy: deputy ? invitee(deputy) : null };
  }

  async assignRole(caller: Caller, input: { accountId: string; roleId: string; reason: string; expiresAt?: string | null }): Promise<RoleAssignment> {
    await this.core.ready();
    const dir = await loadDirectory(this.core.repo, this.core.now());
    const role = dir.roleById.get(input.roleId);
    if (!role) throw notFound('Role');
    if (role.archived_at) throw new AppError('CONFLICT', `${role.name} is archived`);
    const account = await this.core.ctx.use('identity').getAccount(input.accountId);
    if (!account || account.realm !== 'staff') throw notFound('Staff member');
    if (account.status === 'disabled' || account.status === 'closed') throw new AppError('CONFLICT', 'This staff account is disabled');
    if (input.expiresAt && new Date(input.expiresAt) <= this.core.now()) throw validation('The assignment cannot be created', [{ path: 'expiresAt', message: 'Must be in the future' }]);
    const row = await this.createAssignment(
      caller,
      { accountId: input.accountId, role, reason: input.reason, expiresAt: input.expiresAt ? new Date(input.expiresAt) : null, invited: account.status === 'invited' || account.status === 'pending_verification', accountName: account.displayName },
      dir,
      await this.core.sensitivePrefixes(),
    );
    if (!row) throw new AppError('CONFLICT', `${account.displayName} already holds or is waiting for ${role.name}`);
    await this.core.audit(
      {
        action: 'access.role.assign',
        actionLabel: 'Gave a role',
        target: { type: 'staff', id: input.accountId, label: account.displayName },
        relatedTargets: [this.roles.roleTarget(role)],
        after: { roleKey: role.key, status: row.status, expiresAt: row.expires_at },
        reason: input.reason,
        approvalRequestId: row.approval_request_id,
      },
      caller,
    );
    return (await this.assignmentViews([row], await loadDirectory(this.core.repo, this.core.now())))[0]!;
  }

  async revokeRoleAssignment(caller: Caller, id: string, reason: string): Promise<RoleAssignment> {
    await this.core.ready();
    const dir = await loadDirectory(this.core.repo, this.core.now());
    const current = await this.core.repo.getAssignment(id);
    if (!current) throw notFound('Role assignment');
    const role = dir.roleById.get(current.role_id);
    if (role?.key === BUSINESS_OWNER && current.status === 'active') {
      const others = dir.membersOf(role.id).filter((acc) => acc !== current.account_id);
      if (!others.length) throw new AppError('LAST_BUSINESS_OWNER', 'At least one active Business Owner must remain');
    }
    const after = await this.endAssignment(id, current.status === 'pending_approval' ? 'reject' : 'revoke', caller.actor, reason, caller.requestId);
    await this.core.audit(
      {
        action: 'access.role.revoke',
        actionLabel: 'Removed a role',
        target: { type: 'staff', id: after.account_id },
        relatedTargets: role ? [this.roles.roleTarget(role)] : [],
        before: { status: current.status },
        after: { status: after.status },
        reason,
        approvalRequestId: current.approval_request_id,
      },
      caller,
    );
    return (await this.assignmentViews([after], await loadDirectory(this.core.repo, this.core.now())))[0]!;
  }

  async getMyAccess(caller: Caller): Promise<MyAccess> {
    await this.core.ready();
    const me = caller.principal.accountId ?? '';
    const dir = await loadDirectory(this.core.repo, this.core.now());
    const account = (await this.core.requireAccounts([me])).get(me);
    if (!account) throw notFound('Staff account');
    const roles = this.core.sortRoles(dir.rolesOf(me));
    const limits = await this.core.repo.limitsInForce(this.core.now(), { roleIds: roles.map((r) => r.id) });
    const away = dir.awayOf(me);
    const mine = await this.core.repo.findRequests({ requestedById: me, statuses: OPEN_REQUEST });
    return {
      account,
      roles: roles.map(roleRef),
      coveringNow: uniq(dir.covering(me).map((c) => c.roleId)).map((id) => dir.roleById.get(id)).filter((r): r is RoleRow => Boolean(r)).map(roleRef),
      permissions: [...dir.permissionsOf(me)].sort(),
      limits: await this.limits.limitViews(limits, dir),
      approvalsToDecide: (await this.approvals.toDecide(caller.principal, {}, dir)).length,
      myOpenRequests: mine.length,
      away: away ? ((await this.away.awayViews([away], dir))[0] ?? null) : null,
    };
  }

  /** Whether the staff member has accepted their invitation (an unknown account counts as accepted: nothing to wait for) */
  async hasAcceptedInvitation(accountId: string): Promise<boolean> {
    const account = await this.core.ctx.use('identity').getAccount(accountId);
    return !account || (account.status !== 'invited' && account.status !== 'pending_verification');
  }

  /** pending_acceptance → active for every assignment of someone who accepted their invitation (idempotent) */
  async activateAcceptedAssignments(accountId: string): Promise<void> {
    const waiting = await this.core.repo.listAssignments({ accountId, statuses: ['pending_acceptance'] });
    for (const a of waiting) {
      const after = await this.core.repo.transaction(async (tx) => {
        const locked = await tx.getAssignment(a.id, { forUpdate: true });
        if (locked?.status !== 'pending_acceptance') return null;
        return tx.updateAssignment(a.id, { status: roleAssignmentMachine.next('pending_acceptance', 'accept') });
      });
      if (!after) continue;
      const role = await this.core.repo.getRole(after.role_id);
      if (role) this.core.publishRoleChanged(role, 'assigned', after.account_id, SYSTEM_ACTOR);
    }
  }

  private async assignmentViews(rows: AssignmentRow[], dir: Directory): Promise<RoleAssignment[]> {
    const requests = await this.core.repo.findRequests({ ids: uniq(rows.map((r) => r.approval_request_id).filter((x): x is string => Boolean(x))) });
    const infos = new Map((await this.approvals.approvalInfos(requests, dir)).map((i) => [i.approvalRequestId!, i]));
    return rows.map((a) => {
      const role = dir.roleById.get(a.role_id);
      const expired = a.status === 'active' && a.expires_at && a.expires_at <= this.core.now();
      return {
        id: a.id,
        accountId: a.account_id,
        role: role ? roleRef(role) : { id: a.role_id, key: 'unknown', name: 'Unknown role' },
        status: (expired ? 'expired' : a.status) as RoleAssignment['status'],
        grantedBy: { kind: a.granted_by_kind as common.Actor['kind'], id: a.granted_by_id || null },
        reason: a.reason,
        grantedAt: iso(a.granted_at),
        expiresAt: a.expires_at ? iso(a.expires_at) : null,
        revokedAt: a.revoked_at ? iso(a.revoked_at) : null,
        revokedBy: actorFrom(a.revoked_by),
        revokeReason: a.revoke_reason,
        approval: a.approval_request_id ? (infos.get(a.approval_request_id) ?? null) : null,
      };
    });
  }

  private async memberViews(ids: string[], dir: Directory, accounts: Accounts): Promise<StaffMember[]> {
    const open = await this.core.repo.listAssignments({ accountIds: ids, statuses: ['active', 'pending_acceptance'] });
    const awayIds = ids.map((id) => dir.awayOf(id)).filter((p): p is AwayRow => Boolean(p));
    const awayViews = await this.away.awayViews(awayIds, dir);
    const reviews = await this.core.repo.findRequests({ actionKey: LIMITS_CHANGE, targetType: 'staff_member', targetIds: ids });
    const reviewInfos = new Map<string, common.ApprovalInfo>();
    const infos = await this.approvals.approvalInfos(reviews, dir);
    reviews.forEach((r, i) => {
      if (!reviewInfos.has(r.target_id)) reviewInfos.set(r.target_id, infos[i]!); // newest first
    });
    const refs = (roleIds: Iterable<string>) => uniq(roleIds).map((id) => dir.roleById.get(id)).filter((r): r is RoleRow => Boolean(r)).map(roleRef);
    return ids
      .filter((id) => accounts.has(id))
      .map((id) => {
        const account = accounts.get(id)!;
        const leads = [...dir.coverage].filter(([, c]) => c.lead === id).map(([roleId]) => roleId);
        const backups = [...dir.coverage].filter(([, c]) => c.backups.includes(id)).map(([roleId]) => roleId);
        const away = dir.awayOf(id);
        return {
          account,
          roles: refs(open.filter((a) => a.account_id === id && (a.status !== 'active' || !a.expires_at || a.expires_at > this.core.now())).map((a) => a.role_id)),
          leads: refs(leads),
          backupFor: refs(backups),
          coveringNow: refs(dir.covering(id).map((c) => c.roleId)),
          away: away ? (awayViews.find((v) => v.id === away.id) ?? null) : null,
          reportsTo: null,
          status: STATUS[account.status] ?? 'active',
          limitReview: reviewInfos.get(id) ?? null,
        };
      });
  }

  async requireOwnOrManage(caller: Caller, row: AwayRow) {
    if (row.account_id === caller.principal.accountId) return;
    if (await this.core.can(caller, 'access.away.manage')) return;
    throw new AppError('FORBIDDEN', "Changing someone else's time away needs access.away.manage", { permission: 'access.away.manage' });
  }

  /** Creates one assignment; sensitive roles, the Business Owner role and roles for yourself wait for a second reviewer. Null when one is already open. */
  private async createAssignment(
    caller: Caller,
    a: { accountId: string; role: RoleRow; reason: string; expiresAt: Date | null; invited: boolean; accountName: string },
    dir: Directory,
    prefixes: string[],
  ): Promise<AssignmentRow | null> {
    const open = await this.core.repo.listAssignments({ accountId: a.accountId, roleId: a.role.id, statuses: OPEN_ASSIGNMENT });
    if (open.length) return null;
    const self = a.accountId === caller.principal.accountId;
    const sensitive = [...(dir.permsByRole.get(a.role.id) ?? [])].some((k) => this.core.isSensitive(k, prefixes));
    const needsApproval = self || sensitive || a.role.key === BUSINESS_OWNER;
    const id = newId();
    let approvalRequestId: string | null = null;
    if (needsApproval) {
      const req = await this.approvals.openRequest(
        {
          action: SENSITIVE_GRANT,
          target: { type: 'role_assignment', id, ref: a.role.key, label: `${a.role.name} for ${a.accountName}`, screen: 'admin/staff' },
          summary: `Give ${a.role.name} to ${a.accountName}`,
          details: { accountId: a.accountId, roleId: a.role.id, roleKey: a.role.key, self, sensitive, expiresAt: a.expiresAt ? iso(a.expiresAt) : null },
          reason: a.reason,
          requestedBy: caller.principal,
        },
        { restrictToBusinessOwner: self || a.role.key === BUSINESS_OWNER, requestedByActor: caller.actor, requestId: caller.requestId },
      );
      approvalRequestId = req.id;
    }
    try {
      const row = await this.core.repo.insertAssignment({
        id,
        account_id: a.accountId,
        role_id: a.role.id,
        status: needsApproval ? 'pending_approval' : a.invited ? roleAssignmentMachine.initial : roleAssignmentMachine.next('pending_acceptance', 'accept'),
        granted_by_kind: caller.actor.kind,
        granted_by_id: caller.actor.id ?? '',
        reason: a.reason,
        granted_at: this.core.now(),
        expires_at: a.expiresAt,
        revoked_at: null,
        revoked_by: null,
        revoke_reason: null,
        approval_request_id: approvalRequestId,
      });
      if (row.status === 'active') this.core.publishRoleChanged(a.role, 'assigned', a.accountId, caller.actor, caller.requestId);
      return row;
    } catch (err) {
      if (approvalRequestId) await this.approvals.closeRequest(approvalRequestId, 'cancel', caller.actor, 'The assignment could not be created');
      if (await this.core.repo.listAssignments({ accountId: a.accountId, roleId: a.role.id, statuses: OPEN_ASSIGNMENT }).then((x) => x.length)) return null;
      throw err;
    }
  }

  /** revoke, reject (waiting for approval) or expire an assignment; announces the change and any coverage it affects */
  async endAssignment(id: string, event: 'revoke' | 'reject' | 'expire', actor: common.Actor, reason: string, requestId?: string): Promise<AssignmentRow> {
    const after = await this.core.repo.transaction(async (tx) => {
      const locked = await tx.getAssignment(id, { forUpdate: true });
      if (!locked) throw notFound('Role assignment');
      const status = roleAssignmentMachine.next(locked.status as never, event);
      return tx.updateAssignment(id, { status, revoked_at: this.core.now(), revoked_by: by(actor), revoke_reason: reason });
    });
    if (after.approval_request_id) {
      const req = await this.core.repo.getRequest(after.approval_request_id);
      if (req && !FINAL.has(req.status)) await this.approvals.closeRequest(req.id, 'cancel', actor, reason, requestId);
    }
    const role = await this.core.repo.getRole(after.role_id);
    if (role) this.core.publishRoleChanged(role, 'unassigned', after.account_id, actor, requestId);
    const cov = await this.core.repo.getCoverage(after.role_id);
    if (cov && (cov.lead_account_id === after.account_id || ((cov.backup_account_ids as string[]) ?? []).includes(after.account_id))) await this.away.publishCoverageFor([after.role_id]);
    return after;
  }
}
