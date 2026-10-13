import { SYSTEM_ACTOR } from '../../kernel/auth/index.js';
import { zonedDayRange } from '../../kernel/lib/clock.js';
import { AppError, isNotImplemented } from '../../kernel/errors/index.js';
import type { EventPayload } from '../../kernel/events/index.js';
import { newId } from '../../kernel/lib/ids.js';
import { pageOf, toPageRequest, type PageRequest } from '../../kernel/lib/pagination.js';
import { allSpecs } from '../../kernel/module-system/loader.js';
import type { ModuleContext } from '../../kernel/module-system/index.js';
import type * as audit from '../../spec/audit.js';
import type * as common from '../../spec/common.js';
import type * as identity from '../../spec/identity.js';
import type {
  AccessPublicApi,
  ApprovalAction,
  ApprovalDecision,
  ApprovalLimit,
  ApprovalRequest,
  ApprovalTarget,
  AuthorityCheck,
  AmountInput,
  AwayInput,
  AwayPeriod,
  Coverage,
  CoverageGap,
  CoverageInput,
  LimitChange,
  LimitDiff,
  LimitInput,
  LimitValue,
  MyAccess,
  MyActionLimit,
  Permission,
  PermissionGroup,
  RecipientResolution,
  RequestApprovalInput,
  Role,
  RoleAssignment,
  RoleCoverage,
  RoleDetail,
  RoleInput,
  RoleRef,
  RoleUpdate,
  StaffInvitationInput,
  StaffMember,
  StaffMemberDetail,
  StaffRef,
} from '../../spec/access.js';
import { loadDirectory, type Directory } from './directory.js';
import {
  amountText,
  bestFor,
  compareSize,
  evaluate,
  expectedApprovals,
  isComplete,
  limitSummary,
  normalizeLimit,
  NOT_PERMITTED,
  standing,
  stepRoleKeys,
  strongest,
  validateLimit,
  type Amount,
  type Candidate,
  type Issue,
  type LimitKind,
  type RequestState,
  type SecondMode,
  type Snapshot,
} from './domain/limits.js';
import { BUSINESS_OWNER, PLATFORM_ADMINISTRATOR, SYSTEM_ROLES, actionNoun, areaOf, defaultEligibleRoleKeys, expandPermissions, permissionLabel, slugKey } from './domain/seed.js';
import { approvalRequestMachine, awayPeriodMachine, limitChangeMachine, roleAssignmentMachine } from './domain/state-machines.js';
import {
  OPEN_ASSIGNMENT,
  OPEN_REQUEST,
  type ActionRow,
  type AssignmentRow,
  type AwayRow,
  type DecisionRow,
  type LimitChangeRow,
  type LimitRow,
  type RequestFilter,
  type RequestRow,
  type RoleRow,
} from './ports.js';
import type { AccessRepository } from './repository.js';

export interface AccessServiceDeps {
  repo: AccessRepository;
  ctx: ModuleContext<'access'>;
}

/** Who is calling a use case (HTTP handlers pass the kernel's `can`, which also honours development tokens). */
export interface Caller {
  principal: identity.Principal;
  actor: common.Actor;
  requestId?: string;
  can?: (permission: string) => Promise<boolean>;
}

/** The operator's bootstrap: the first Business Owner and, optionally, a deputy (a second Business Owner) */
export interface BootstrapOwnerInput {
  email: string;
  name: string;
  deputy?: { email: string; name: string } | null;
}

/** The staff accounts and identity invitations created; `deputy` is null without one */
export interface BootstrapOwnerResult {
  accountId: string;
  invitationId: string;
  deputy: { accountId: string; invitationId: string } | null;
}

type Accounts = Map<string, identity.AccountSummary>;

const SENSITIVE_GRANT = 'access.roles.sensitive-grant';
const LIMITS_CHANGE = 'access.limits.change';
const DELEGATIONS = 'access.delegations.approve';
const DECIDABLE = ['pending', 'partially_approved'] as const;
const FINAL = new Set(['approved', 'rejected', 'cancelled', 'expired']);
const DUE_SOON_MS = 24 * 3_600_000;
const EXPIRY_GRACE_MS = 24 * 3_600_000;
const BATCH = 200;

const iso = (d: Date | string) => new Date(d).toISOString();
const uniq = <T>(xs: Iterable<T>) => [...new Set(xs)];
const by = (actor: common.Actor) => (actor.id ? `${actor.kind}:${actor.id}` : actor.kind);
const actorFrom = (text: string | null | undefined): common.Actor | null => {
  if (!text) return null;
  const i = text.indexOf(':');
  if (i < 0) return { kind: text as common.Actor['kind'] };
  return { kind: text.slice(0, i) as common.Actor['kind'], id: text.slice(i + 1) };
};
const roleRef = (r: RoleRow): RoleRef => ({ id: r.id, key: r.key, name: r.name });
const moneyOf = (minor: number | null, currency: string | null): common.Money | null => (minor == null || !currency ? null : { amount: Number(minor), currency });
const num = (v: string | number | null | undefined) => (v == null ? null : Number(v));
const validation = (message: string, issues: Issue[]) => new AppError('VALIDATION_FAILED', message, { issues });
const notFound = (what: string) => new AppError('NOT_FOUND', `${what} not found`);
const KIND_ORDER: Record<string, number> = { owner: 0, management: 1, task: 2, custom: 3 };

/**
 * Access and approvals use cases. Depends only on its repository, the event bus, the clock and other modules' public APIs.
 * Each method maps to a publicApi function, a consumed event or a job in docs/api/spec/modules/access.json.
 */
export class AccessService implements AccessPublicApi {
  #ready?: Promise<void>;
  #syncing?: Promise<void>;

  constructor(protected readonly deps: AccessServiceDeps) {}

  private get ctx() {
    return this.deps.ctx;
  }
  private get repo() {
    return this.deps.repo;
  }
  private now() {
    return this.ctx.clock.now();
  }

  /** The registry and the system roles exist before anything reads them (also run by the boot job). */
  private ready(): Promise<void> {
    this.#ready ??= this.syncRegistry().catch((err) => {
      this.#ready = undefined;
      throw err;
    });
    return this.#ready;
  }

  /* ================================================================ public API (in-process) */

  /** Kernel guard for every admin endpoint with a `permission`. Includes roles covered as a backup only where the away period grants them. */
  async hasPermission(principal: identity.Principal, permissionKey: string): Promise<boolean> {
    if (principal?.kind !== 'staff' || !principal.accountId) return false;
    return (await this.permissionsOf(principal.accountId)).includes(permissionKey);
  }

  /** Effective staff permissions (cached, invalidated on access.role.changed) */
  async permissionsOf(accountId: string): Promise<string[]> {
    await this.ready();
    const now = this.now();
    const [own, away] = await Promise.all([this.repo.activeAssignments(now, { accountId }), this.repo.awayInForce(now)]);
    const roleIds = new Set(own.map((a) => a.role_id));
    // a covered role adds its permissions only where the away period grants them (delegation approved by the Business Owner)
    const covered = away
      .filter(({ period }) => period.delegate_approvals)
      .flatMap(({ period, coverage }) => coverage.filter((c) => c.covered_by_account_id === accountId).map((c) => ({ period, roleId: c.role_id })));
    if (covered.length) {
      const holders = await this.repo.activeAssignments(now, { roleIds: uniq(covered.map((c) => c.roleId)) });
      for (const c of covered) if (holders.some((a) => a.account_id === c.period.account_id && a.role_id === c.roleId)) roleIds.add(c.roleId);
    }
    return (await this.repo.permissionKeysOfRoles([...roleIds])).sort();
  }

  /** allowed | approval_required | denied for this person, action and amount, with who could approve. Uses the limits in force now. Permissions alone never make a money action allowed. */
  async check(principal: identity.Principal, action: string, amount?: AmountInput): Promise<AuthorityCheck> {
    await this.ready();
    const act = await this.requireAction(action);
    const dir = await loadDirectory(this.repo, this.now());
    const snapshot = await this.snapshotFor(act, dir, principal.accountId ?? null, this.amountOf(act, amount));
    const amt = this.amountOf(act, amount);
    const kind = act.limit_kind as LimitKind;
    const mode = act.second_reviewer as SecondMode;
    const label = act.label;
    const mine = snapshot.requester;
    const base = { action: act.key, callerLimit: mine?.value ?? null, stepUpRequired: await this.stepUpNeeded(amt) };

    if (principal.kind !== 'staff' || !principal.accountId || !mine || mine.value.authority === 'not_permitted') {
      return { ...base, decision: 'denied', reason: `Your role has no authority to ${label.charAt(0).toLowerCase()}${label.slice(1)}`, requiresSecondReviewer: false, approvalsNeeded: 0, eligibleApproverRoles: [], eligibleApprovers: [] };
    }
    const s = standing(kind, mode, mine.value, amt, true);
    if (s === 3) {
      const limitText = kind === 'none' ? '' : ` ${limitSummary(kind, mode, mine.value).replace(/^Up to /, '')}`;
      return { ...base, decision: 'allowed', reason: kind === 'none' ? 'Within your authority' : `Within your${limitText} limit`, requiresSecondReviewer: false, approvalsNeeded: 0, eligibleApproverRoles: [], eligibleApprovers: [] };
    }
    const countsAsFirst = s === 2;
    const state: RequestState = { requesterId: principal.accountId, requesterCountsAsFirst: countsAsFirst, approvals: [], amount: amt };
    const roleKeys = stepRoleKeys(snapshot, state);
    const needed = expectedApprovals(snapshot, state);
    const eligibleRoles = this.roleRefsOf(roleKeys, dir);
    const people = this.eligiblePeople(snapshot, state, dir, null);
    const refs = await this.staffRefs(people, dir);
    const routeNames = eligibleRoles.map((r) => r.name).join(' or ') || 'another approver';
    const reason =
      mine.value.authority === 'recommend_only'
        ? 'Your role can recommend only'
        : countsAsFirst
          ? mode === 'always'
            ? `Always needs a second person: ${routeNames}`
            : `Needs a second reviewer: ${routeNames}`
          : `Above your limit: ${routeNames} approval`;
    return {
      ...base,
      decision: 'approval_required',
      reason,
      requiresSecondReviewer: countsAsFirst || needed > 1,
      approvalsNeeded: needed,
      eligibleApproverRoles: eligibleRoles,
      eligibleApprovers: people.map((id) => refs.get(id)!).filter(Boolean),
    };
  }

  /** Create an approval request (or return the open one for the same action and target). The requesting module keeps its record pending and finishes on access.approval.decided. */
  async requestApproval(input: RequestApprovalInput): Promise<ApprovalRequest> {
    const row = await this.openRequest(input, {});
    return this.viewOne(row, input.requestedBy);
  }

  /** Same rules as the admin approve/reject/return endpoints, for modules that show the decision inside their own screen (payout run approval) */
  async decide(requestId: string, principal: identity.Principal, decision: { kind: 'approve' | 'reject' | 'return'; note?: string; stepUpCode?: string }): Promise<ApprovalRequest> {
    const caller: Caller = { principal, actor: { kind: principal.kind === 'staff' ? 'staff' : principal.kind, id: principal.accountId ?? null } };
    return this.decideAs(caller, requestId, decision.kind, { note: decision.note, stepUpCode: decision.stepUpCode });
  }

  /** The requesting module withdraws a request (record changed or deleted) */
  async cancelApproval(requestId: string, by: common.Actor, reason: string): Promise<void> {
    await this.ready();
    const row = await this.repo.getRequest(requestId);
    if (!row) throw notFound('Approval request');
    if (FINAL.has(row.status)) return; // already decided: nothing to withdraw
    await this.closeRequest(row.id, 'cancel', by, reason);
  }

  /** Full request with decisions */
  async getApproval(requestId: string): Promise<ApprovalRequest | null> {
    await this.ready();
    const row = await this.repo.getRequest(requestId);
    return row ? this.viewOne(row, null) : null;
  }

  /** Compact common.ApprovalInfo for embedding in other modules' responses */
  async approvalInfo(requestId: string): Promise<common.ApprovalInfo> {
    await this.ready();
    const row = await this.repo.getRequest(requestId);
    if (!row) return { required: false, reason: 'Approval request not found', approvalRequestId: requestId, approvers: [] };
    const dir = await loadDirectory(this.repo, this.now());
    const [info] = await this.approvalInfos([row], dir);
    return info!;
  }

  /** Who receives a role's work and notices right now: lead, or the covering backup while the lead is away (the lead keeps a copy) */
  async resolveRecipients(roleKey: string): Promise<RecipientResolution> {
    await this.ready();
    const dir = await loadDirectory(this.repo, this.now());
    const role = dir.roleByKey.get(roleKey);
    if (!role) return { roleKey, leadAccountId: null, accountIds: [], ccAccountIds: [], viaBackup: false, escalationRoleKey: null };
    const unavailable = await this.unavailableAccounts(this.routingCandidates(role.id, dir), dir);
    const r = this.route(role, dir, unavailable);
    return {
      roleKey,
      leadAccountId: r.lead,
      accountIds: r.receiving,
      ccAccountIds: r.viaBackup && r.lead ? [r.lead] : [],
      viaBackup: r.viaBackup,
      escalationRoleKey: role.escalation_role_id ? (dir.roleById.get(role.escalation_role_id)?.key ?? null) : null,
    };
  }

  /** Active roles of a staff member (audit stores them with each entry) */
  async rolesOf(accountId: string): Promise<RoleRef[]> {
    await this.ready();
    const dir = await loadDirectory(this.repo, this.now());
    return this.sortRoles(dir.rolesOf(accountId)).map(roleRef);
  }

  /** Everyone holding a role (assignment pickers in workqueues and support) */
  async membersOfRole(roleKey: string): Promise<StaffRef[]> {
    await this.ready();
    const dir = await loadDirectory(this.repo, this.now());
    const role = dir.roleByKey.get(roleKey);
    if (!role) return [];
    const ids = dir.membersOf(role.id);
    const refs = await this.staffRefs(ids, dir);
    return ids.map((id) => refs.get(id)!).sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Active staff whose active role assignments grant the permission (the hasPermission rule: own roles plus roles
   * covered with an approved delegation). Disabled or closed accounts are left out; locked ones are shown away.
   * includeCovering adds people who hold it only as an away-period backup (without delegation).
   */
  async staffWithPermission(permissionKey: string, opts?: { includeCovering?: boolean }): Promise<StaffRef[]> {
    await this.ready();
    const dir = await loadDirectory(this.repo, this.now());
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
    const accounts = await this.accounts(ids);
    const refs = await this.staffRefs(ids, dir, accounts);
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

  /** Requests the caller may decide now, oldest due first (same rules as GET /approval-requests?view=to_decide). canDecide and steps are computed for the caller. */
  async listApprovalsToDecide(principal: identity.Principal, filter: { module?: string; actionKey?: string; overdue?: boolean }, page: common.PageInput): Promise<common.Page<ApprovalRequest>> {
    await this.ready();
    const items = await this.toDecide(principal, filter);
    return pageOf(items, toPageRequest(page));
  }

  /** Approval counts for the admin dashboard and inbox */
  async approvalSummaryFor(principal: identity.Principal): Promise<{ toDecide: number; overdue: number; dueSoon: number; myOpenRequests: number; returnedToMe: number }> {
    await this.ready();
    const now = this.now().getTime();
    const decide = await this.toDecide(principal, {});
    const mine = principal.accountId ? await this.repo.findRequests({ requestedById: principal.accountId, statuses: OPEN_REQUEST }) : [];
    const due = (r: ApprovalRequest) => (r.deadline ? new Date(r.deadline.dueAt).getTime() : null);
    return {
      toDecide: decide.length,
      overdue: decide.filter((r) => (due(r) ?? Infinity) < now).length,
      dueSoon: decide.filter((r) => {
        const d = due(r);
        return d !== null && d >= now && d - now <= DUE_SOON_MS;
      }).length,
      myOpenRequests: mine.length,
      returnedToMe: mine.filter((r) => r.status === 'returned').length,
    };
  }

  /** One request with decisions and steps, null unless the caller is the requester, an eligible approver or holds access.approvals.view-all. canDecide and cannotDecideReason are for the caller. */
  async getApprovalForViewer(principal: identity.Principal, requestId: string): Promise<ApprovalRequest | null> {
    await this.ready();
    const row = await this.repo.getRequest(requestId);
    if (!row) return null;
    const dir = await loadDirectory(this.repo, this.now());
    const [view] = await this.views([row], principal, dir);
    if (!view) return null;
    if (await this.mayView(row, view, principal, dir, (p) => this.hasPermission(principal, p))) return view;
    return null;
  }

  /** Batched: the current approval request per target record (open request first, else the latest decided one), for approval panels embedded in other modules' admin views (payout run, hold, refund request). Visibility follows the parent record; canDecide is for the caller. */
  async approvalForTargets(principal: identity.Principal, targetType: string, targetIds: string[]): Promise<Map<string, ApprovalRequest | null>> {
    await this.ready();
    const out = new Map<string, ApprovalRequest | null>(targetIds.map((id) => [id, null]));
    if (!targetIds.length) return out;
    const rows = await this.repo.findRequests({ targetType, targetIds: uniq(targetIds) });
    const pick = new Map<string, RequestRow>();
    for (const r of rows) {
      const cur = pick.get(r.target_id);
      const open = (x: RequestRow) => (OPEN_REQUEST as readonly string[]).includes(x.status);
      if (!cur || (open(r) && !open(cur))) pick.set(r.target_id, r); // rows are newest first
    }
    const views = await this.views([...pick.values()], principal);
    for (const v of views) out.set(v.target.id, v);
    return out;
  }

  /** Batched: open requests whose target belongs to each seller (ApprovalTarget.sellerId), for the admin seller 360 */
  async approvalsForSellers(principal: identity.Principal, sellerIds: string[]): Promise<Map<string, ApprovalRequest[]>> {
    await this.ready();
    const out = new Map<string, ApprovalRequest[]>(sellerIds.map((id) => [id, []]));
    if (!sellerIds.length) return out;
    const rows = await this.repo.findRequests({ sellerIds: uniq(sellerIds), statuses: OPEN_REQUEST });
    for (const v of await this.views(rows, principal)) if (v.target.sellerId) out.get(v.target.sellerId)?.push(v);
    return out;
  }

  /** Leads, backups and who receives each role's work today (GET /coverage without gaps), for the admin dashboard */
  async coverageNow(filter: { workArea?: string }): Promise<RoleCoverage[]> {
    await this.ready();
    const dir = await loadDirectory(this.repo, this.now());
    return (await this.coverageOfRoles(dir)).roles.filter((r) => !filter?.workArea || r.workArea === filter.workArea);
  }

  /** The caller's own authority, limit, second-review rule and approval route for one action (decision panels) */
  async myLimitFor(principal: identity.Principal, actionKey: string): Promise<MyActionLimit> {
    await this.ready();
    const act = await this.requireAction(actionKey);
    const dir = await loadDirectory(this.repo, this.now());
    const kind = act.limit_kind as LimitKind;
    const mode = act.second_reviewer as SecondMode;
    const limits = await this.repo.limitsInForce(this.now(), { actionKey });
    const mine = this.limitsOfPerson(principal.accountId ?? '', dir, limits, kind);
    const best = strongest(kind, mine)?.value ?? NOT_PERMITTED;
    const value = principal.accountId && dir.blocked.has(principal.accountId) ? this.blockedValue(best) : best;
    const myRoleIds = new Set(dir.rolesOf(principal.accountId ?? '').map((r) => r.id));
    const above = limits
      .filter((l) => !myRoleIds.has(l.role_id) && dir.roleById.get(l.role_id) && !dir.roleById.get(l.role_id)!.archived_at)
      .map((l) => ({ role: dir.roleById.get(l.role_id)!, value: this.limitValue(l) }))
      .filter((x) => x.value.authority === 'permitted' || x.value.authority === 'permitted_with_second_review')
      .filter((x) => kind === 'none' || value.authority === 'not_permitted' || value.authority === 'recommend_only' || compareSize(kind, x.value, value) > 0)
      .sort((a, b) => compareSize(kind, a.value, b.value) || (KIND_ORDER[b.role.kind] ?? 9) - (KIND_ORDER[a.role.kind] ?? 9));
    return {
      action: this.actionView(act),
      value,
      needsSecondReviewer: mode === 'always' || value.authority === 'permitted_with_second_review' || Boolean(value.secondReviewerAboveMoney || value.secondReviewerAboveNumber != null),
      route: uniq(above.map((x) => x.role.name)),
      summary: limitSummary(kind, mode, value),
    };
  }

  /** A staff member's display name and role label (roleLabel) for assignee, owner, reviewer and decider columns */
  async getStaffRef(staffId: string): Promise<StaffRef | null> {
    await this.ready();
    const dir = await loadDirectory(this.repo, this.now());
    const accounts = await this.accounts([staffId]);
    const known = accounts.has(staffId) || dir.rolesOf(staffId).length > 0 || (await this.repo.listAssignments({ accountId: staffId })).length > 0;
    if (!known) return null;
    return (await this.staffRefs([staffId], dir, accounts)).get(staffId) ?? null;
  }

  /* ================================================================ admin use cases: roles */

  async listRoles(caller: Caller, query: { q?: string; includeArchived?: boolean }): Promise<Role[]> {
    await this.ready();
    const dir = await loadDirectory(this.repo, this.now());
    const q = query.q?.trim().toLowerCase();
    const rows = this.sortRoles(dir.roles.filter((r) => (query.includeArchived || !r.archived_at) && (!q || `${r.name} ${r.key} ${r.work_area}`.toLowerCase().includes(q))));
    return this.roleViews(rows, dir);
  }

  async getRole(caller: Caller, id: string): Promise<RoleDetail> {
    await this.ready();
    const dir = await loadDirectory(this.repo, this.now());
    const row = dir.roleById.get(id);
    if (!row) throw notFound('Role');
    return this.roleDetail(row, dir);
  }

  async createRole(caller: Caller, input: RoleInput): Promise<Role> {
    await this.ready();
    const name = input.name.trim();
    const workArea = input.workArea.trim();
    const issues: Issue[] = [];
    if (!name) issues.push({ path: 'name', message: 'Give the role a name' });
    if (!workArea) issues.push({ path: 'workArea', message: 'Choose a work area' });
    if (input.escalationRoleId && !(await this.repo.getRole(input.escalationRoleId))) issues.push({ path: 'escalationRoleId', message: 'Unknown escalation role' });
    if (issues.length) throw validation('The role cannot be created', issues);
    const now = this.now();
    const base = slugKey(name);
    let row: RoleRow | undefined;
    for (let i = 1; !row && i < 50; i++) {
      row = await this.repo.insertRole({
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
    this.publishRoleChanged(row, 'created', null, caller.actor, caller.requestId);
    await this.audit({ action: 'access.role.create', actionLabel: 'Created role', target: this.roleTarget(row), after: row, reason: input.reason }, caller);
    const dir = await loadDirectory(this.repo, this.now());
    return (await this.roleViews([row], dir))[0]!;
  }

  async updateRole(caller: Caller, id: string, input: RoleUpdate): Promise<Role> {
    await this.ready();
    const issues: Issue[] = [];
    if (input.name != null && !input.name.trim()) issues.push({ path: 'name', message: 'Give the role a name' });
    if (input.workArea != null && !input.workArea.trim()) issues.push({ path: 'workArea', message: 'Choose a work area' });
    if (input.escalationRoleId) {
      if (input.escalationRoleId === id) issues.push({ path: 'escalationRoleId', message: 'A role cannot escalate to itself' });
      else if (!(await this.repo.getRole(input.escalationRoleId))) issues.push({ path: 'escalationRoleId', message: 'Unknown escalation role' });
    }
    if (issues.length) throw validation('The role cannot be changed', issues);
    const { before, after } = await this.repo.transaction(async (tx) => {
      const before = await tx.getRole(id, { forUpdate: true });
      if (!before) throw notFound('Role');
      const after = await tx.updateRole(id, {
        ...(input.name != null ? { name: input.name.trim() } : {}),
        ...(input.workArea != null ? { work_area: input.workArea.trim() } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.escalationRoleId !== undefined ? { escalation_role_id: input.escalationRoleId } : {}),
        updated_at: this.now(),
        version: before.version + 1,
      });
      return { before, after };
    });
    this.publishRoleChanged(after, 'updated', null, caller.actor, caller.requestId);
    await this.audit({ action: 'access.role.update', actionLabel: 'Changed role', target: this.roleTarget(after), before, after, reason: input.reason }, caller);
    const dir = await loadDirectory(this.repo, this.now());
    return (await this.roleViews([after], dir))[0]!;
  }

  async archiveRole(caller: Caller, id: string, reason: string): Promise<Role> {
    await this.ready();
    const { before, after } = await this.repo.transaction(async (tx) => {
      const before = await tx.getRole(id, { forUpdate: true });
      if (!before) throw notFound('Role');
      if (before.system) throw new AppError('SYSTEM_ROLE', `${before.name} is a system role and cannot be archived`);
      if (before.archived_at) return { before, after: before };
      const inUse = await tx.listAssignments({ roleId: id, statuses: OPEN_ASSIGNMENT });
      if (inUse.length) throw new AppError('ROLE_IN_USE', `Remove ${before.name} from ${inUse.length} staff member${inUse.length === 1 ? '' : 's'} before archiving it`, { assignments: inUse.length });
      const after = await tx.updateRole(id, { archived_at: this.now(), updated_at: this.now(), version: before.version + 1 });
      return { before, after };
    });
    if (before !== after) {
      this.publishRoleChanged(after, 'archived', null, caller.actor, caller.requestId);
      await this.audit({ action: 'access.role.archive', actionLabel: 'Archived role', target: this.roleTarget(after), before, after, reason }, caller);
    }
    const dir = await loadDirectory(this.repo, this.now());
    return (await this.roleViews([after], dir))[0]!;
  }

  async setRolePermissions(caller: Caller, id: string, permissionKeys: string[], reason: string): Promise<RoleDetail> {
    await this.ready();
    const role = await this.repo.getRole(id);
    if (!role) throw notFound('Role');
    if (role.archived_at) throw new AppError('CONFLICT', 'Archived roles cannot be changed');
    const registry = new Map((await this.repo.listPermissions()).map((p) => [p.key, p]));
    const desired = uniq(permissionKeys);
    const unknown = desired.filter((k) => !registry.get(k) || registry.get(k)!.unavailable_since);
    if (unknown.length) throw new AppError('UNKNOWN_PERMISSION', `Not in the permission registry: ${unknown.join(', ')}`, { keys: unknown });
    const current = (await this.repo.rolePermissions([id])).map((r) => r.permission_key);
    const remove = current.filter((k) => !desired.includes(k));
    const add = desired.filter((k) => !current.includes(k));
    const dir = await loadDirectory(this.repo, this.now());
    const holdsRole = Boolean(caller.principal.accountId && dir.holds(caller.principal.accountId, id));
    const prefixes = await this.sensitivePrefixes();
    const pending = holdsRole || role.key === BUSINESS_OWNER ? add : add.filter((k) => this.isSensitive(k, prefixes));
    const immediate = add.filter((k) => !pending.includes(k));

    await this.repo.transaction(async (tx) => {
      await tx.removeRolePermissions(id, remove);
      await tx.addRolePermissions(id, immediate, by(caller.actor), this.now());
    });
    let approvalRequestId: string | null = null;
    if (pending.length) {
      // a newer proposal replaces a waiting one for the same role
      const waiting = await this.repo.findOpenRequest(SENSITIVE_GRANT, 'role_permissions', id);
      if (waiting) await this.closeRequest(waiting.id, 'cancel', caller.actor, 'Replaced by a newer permission change');
      const req = await this.openRequest(
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
    if (remove.length || immediate.length) this.publishRoleChanged(role, 'permissions_changed', null, caller.actor, caller.requestId);
    await this.audit(
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
    const fresh = await loadDirectory(this.repo, this.now());
    return this.roleDetail(fresh.roleById.get(id)!, fresh);
  }

  async setRoleCoverage(caller: Caller, id: string, input: CoverageInput): Promise<RoleCoverage> {
    await this.ready();
    const dir = await loadDirectory(this.repo, this.now());
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
    await this.repo.transaction(async (tx) => {
      await tx.upsertCoverage({ role_id: id, lead_account_id: lead, backup_account_ids: uniq(input.backupAccountIds), updated_by: by(caller.actor), updated_at: this.now() });
      if (input.escalationRoleId !== undefined) await tx.updateRole(id, { escalation_role_id: input.escalationRoleId, updated_at: this.now(), version: role.version + 1 });
    });
    const fresh = await loadDirectory(this.repo, this.now());
    const cov = (await this.coverageOfRoles(fresh, [id])).roles[0]!;
    this.publishCoverage(cov);
    await this.audit(
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
    await this.ready();
    const rows = (await this.repo.listPermissions()).filter((p) => !p.unavailable_since && (!query.module || p.module === query.module));
    const mine = new Set(caller.principal.accountId ? await this.permissionsOf(caller.principal.accountId) : []);
    return this.groupPermissions(rows.map((p) => ({ permission: this.permissionView(p), granted: mine.has(p.key) })));
  }

  /* ================================================================ admin use cases: members and assignments */

  async listMembers(caller: Caller, query: { q?: string; roleId?: string; status?: StaffMember['status']; away?: boolean }, page: PageRequest): Promise<common.Page<StaffMember>> {
    await this.ready();
    const dir = await loadDirectory(this.repo, this.now());
    const ids = await this.repo.memberAccountIds();
    const accounts = await this.requireAccounts(ids);
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
    await this.ready();
    const dir = await loadDirectory(this.repo, this.now());
    const [assignments, accounts] = await Promise.all([this.repo.listAssignments({ accountId }), this.requireAccounts([accountId])]);
    const account = accounts.get(accountId);
    if (!account || (account.realm !== 'staff' && !assignments.length)) throw notFound('Staff member');
    const [member] = await this.memberViews([accountId], dir, accounts);
    const limits = await this.repo.limitsInForce(this.now(), { roleIds: dir.rolesOf(accountId).map((r) => r.id) });
    const away = await this.repo.findAway({ accountId });
    return {
      member: member!,
      assignments: await this.assignmentViews(assignments, dir),
      effectivePermissions: [...dir.permissionsOf(accountId)].sort(),
      effectiveLimits: await this.limitViews(limits, dir),
      awayPeriods: await this.awayViews(away, dir),
      approvalsWaiting: (await this.toDecide({ kind: 'staff', accountId }, {}, dir)).length,
    };
  }

  async inviteStaff(caller: Caller, input: StaffInvitationInput): Promise<StaffMember> {
    await this.ready();
    const dir = await loadDirectory(this.repo, this.now());
    const roles = uniq(input.roleIds).map((id) => dir.roleById.get(id));
    const issues: Issue[] = [];
    if (!input.roleIds.length) issues.push({ path: 'roleIds', message: 'Choose at least one role' });
    roles.forEach((r, i) => {
      if (!r) issues.push({ path: `roleIds.${i}`, message: 'Unknown role' });
      else if (r.archived_at) issues.push({ path: `roleIds.${i}`, message: `${r.name} is archived` });
    });
    if (input.reportsToAccountId && !dir.rolesOf(input.reportsToAccountId).length) issues.push({ path: 'reportsToAccountId', message: 'Not a staff member with a role' });
    if (issues.length) throw validation('The invitation cannot be sent', issues);

    const idp = this.ctx.use('identity');
    const invitation = await idp.inviteStaff({ email: input.email, name: input.name, invitedBy: caller.actor });
    const accountId = invitation.accountId ?? (await idp.findAccountByEmail(input.email, 'staff'))?.id;
    if (!accountId) throw new AppError('CONFLICT', 'The staff account could not be created; try again');
    const prefixes = await this.sensitivePrefixes();
    const created: AssignmentRow[] = [];
    for (const role of roles as RoleRow[]) {
      const row = await this.createAssignment(caller, { accountId, role, reason: input.reason, expiresAt: null, invited: true, accountName: input.name }, dir, prefixes);
      if (row) created.push(row);
    }
    if (input.requestLimitReview) {
      await this.openRequest(
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
    await this.audit(
      {
        action: 'access.staff.invite',
        actionLabel: 'Invited staff member',
        target: { type: 'staff', id: accountId, label: input.name },
        after: { email: input.email, roles: (roles as RoleRow[]).map((r) => r.key), assignments: created.map((a) => ({ id: a.id, status: a.status })), requestLimitReview: Boolean(input.requestLimitReview) },
        reason: input.reason,
      },
      caller,
    );
    const fresh = await loadDirectory(this.repo, this.now());
    const accounts = await this.accounts([accountId]);
    if (!accounts.has(accountId)) {
      accounts.set(accountId, { id: accountId, realm: 'staff', email: input.email, displayName: input.name, status: 'invited', emailVerified: false, twoStepEnabled: false });
    }
    return (await this.memberViews([accountId], fresh, accounts))[0]!;
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
    await this.ready();
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

    const dir = await loadDirectory(this.repo, this.now());
    const role = dir.roleByKey.get(BUSINESS_OWNER);
    const admin = dir.roleByKey.get(PLATFORM_ADMINISTRATOR);
    if (!role || !admin) throw new Error('The Business Owner and Platform Administrator roles are not seeded');
    if ((await this.repo.listAssignments({ roleId: role.id, statuses: OPEN_ASSIGNMENT })).length) {
      throw new AppError('CONFLICT', 'A Business Owner already exists or is invited; invite other staff from the Admin Center');
    }
    const system: common.Actor = { kind: 'system', name: 'bootstrap' };
    const idp = this.ctx.use('identity');
    // invite everyone first (identity's own writes), then seat them in one transaction
    const invited: { email: string; name: string; accountId: string; invitationId: string; deputy: boolean }[] = [];
    for (const p of people) {
      const invitation = await idp.inviteStaff({ email: p.email.trim(), name: p.name.trim(), invitedBy: system });
      const accountId = invitation.accountId ?? (await idp.findAccountByEmail(p.email.trim(), 'staff'))?.id;
      if (!accountId) throw new AppError('CONFLICT', 'The staff account could not be created; try again');
      invited.push({ email: p.email.trim(), name: p.name.trim(), accountId, invitationId: invitation.id, deputy: p.path !== '' });
    }
    const now = this.now();
    const seated = await this.repo.transaction(async (tx) => {
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
      await this.audit(
        {
          action: 'access.role.assign',
          actionLabel: `Gave ${r.name} to the ${person.deputy ? 'deputy' : 'first'} Business Owner`,
          target: { type: 'staff', id: person.accountId, label: person.name },
          relatedTargets: [this.roleTarget(r)],
          after: { roleKey: r.key, status: row.status, email: person.email },
          reason: person.deputy ? 'Deputy Business Owner (bootstrap)' : 'First Business Owner (bootstrap)',
        },
        { actor: system },
      );
    }
    const [owner, deputy] = invited;
    return { accountId: owner!.accountId, invitationId: owner!.invitationId, deputy: deputy ? { accountId: deputy.accountId, invitationId: deputy.invitationId } : null };
  }

  async assignRole(caller: Caller, input: { accountId: string; roleId: string; reason: string; expiresAt?: string | null }): Promise<RoleAssignment> {
    await this.ready();
    const dir = await loadDirectory(this.repo, this.now());
    const role = dir.roleById.get(input.roleId);
    if (!role) throw notFound('Role');
    if (role.archived_at) throw new AppError('CONFLICT', `${role.name} is archived`);
    const account = await this.ctx.use('identity').getAccount(input.accountId);
    if (!account || account.realm !== 'staff') throw notFound('Staff member');
    if (account.status === 'disabled' || account.status === 'closed') throw new AppError('CONFLICT', 'This staff account is disabled');
    if (input.expiresAt && new Date(input.expiresAt) <= this.now()) throw validation('The assignment cannot be created', [{ path: 'expiresAt', message: 'Must be in the future' }]);
    const row = await this.createAssignment(
      caller,
      { accountId: input.accountId, role, reason: input.reason, expiresAt: input.expiresAt ? new Date(input.expiresAt) : null, invited: account.status === 'invited' || account.status === 'pending_verification', accountName: account.displayName },
      dir,
      await this.sensitivePrefixes(),
    );
    if (!row) throw new AppError('CONFLICT', `${account.displayName} already holds or is waiting for ${role.name}`);
    await this.audit(
      {
        action: 'access.role.assign',
        actionLabel: 'Gave a role',
        target: { type: 'staff', id: input.accountId, label: account.displayName },
        relatedTargets: [this.roleTarget(role)],
        after: { roleKey: role.key, status: row.status, expiresAt: row.expires_at },
        reason: input.reason,
        approvalRequestId: row.approval_request_id,
      },
      caller,
    );
    return (await this.assignmentViews([row], await loadDirectory(this.repo, this.now())))[0]!;
  }

  async revokeRoleAssignment(caller: Caller, id: string, reason: string): Promise<RoleAssignment> {
    await this.ready();
    const dir = await loadDirectory(this.repo, this.now());
    const current = await this.repo.getAssignment(id);
    if (!current) throw notFound('Role assignment');
    const role = dir.roleById.get(current.role_id);
    if (role?.key === BUSINESS_OWNER && current.status === 'active') {
      const others = dir.membersOf(role.id).filter((acc) => acc !== current.account_id);
      if (!others.length) throw new AppError('LAST_BUSINESS_OWNER', 'At least one active Business Owner must remain');
    }
    const after = await this.endAssignment(id, current.status === 'pending_approval' ? 'reject' : 'revoke', caller.actor, reason, caller.requestId);
    await this.audit(
      {
        action: 'access.role.revoke',
        actionLabel: 'Removed a role',
        target: { type: 'staff', id: after.account_id },
        relatedTargets: role ? [this.roleTarget(role)] : [],
        before: { status: current.status },
        after: { status: after.status },
        reason,
        approvalRequestId: current.approval_request_id,
      },
      caller,
    );
    return (await this.assignmentViews([after], await loadDirectory(this.repo, this.now())))[0]!;
  }

  /* ================================================================ admin use cases: limits */

  async listApprovalActions(): Promise<ApprovalAction[]> {
    await this.ready();
    return (await this.repo.listActions()).map((a) => this.actionView(a)).sort((a, b) => Number(b.available) - Number(a.available) || a.key.localeCompare(b.key));
  }

  async listLimits(query: { roleId?: string; actionKey?: string }): Promise<ApprovalLimit[]> {
    await this.ready();
    const dir = await loadDirectory(this.repo, this.now());
    const rows = await this.repo.limitsInForce(this.now(), { ...(query.roleId ? { roleIds: [query.roleId] } : {}), ...(query.actionKey ? { actionKey: query.actionKey } : {}) });
    return this.limitViews(rows, dir);
  }

  async proposeLimitChange(caller: Caller, input: { roleId: string; changes: LimitInput[]; reason: string; effectiveFrom: string }): Promise<LimitChange> {
    await this.ready();
    const dir = await loadDirectory(this.repo, this.now());
    const role = dir.roleById.get(input.roleId);
    if (!role) throw notFound('Role');
    if (role.archived_at) throw new AppError('CONFLICT', `${role.name} is archived`);
    const actions = new Map((await this.repo.listActions()).map((a) => [a.key, a]));
    const unknown = input.changes.map((c) => c.actionKey).filter((k) => !actions.get(k) || actions.get(k)!.unavailable_since);
    if (unknown.length) throw new AppError('UNKNOWN_APPROVAL_ACTION', `Not registered by any enabled module: ${uniq(unknown).join(', ')}`, { keys: uniq(unknown) });
    const issues: Issue[] = [];
    if (!input.changes.length) issues.push({ path: 'changes', message: 'Change at least one limit' });
    input.changes.forEach((c, i) => {
      if (input.changes.findIndex((x) => x.actionKey === c.actionKey) !== i) issues.push({ path: `changes.${i}.actionKey`, message: 'Listed twice' });
      issues.push(...validateLimit(actions.get(c.actionKey)!.limit_kind as LimitKind, normalizeLimit(c.value), `changes.${i}.value`, this.ctx.config.market.currency));
      c.value.secondReviewerRoleKeys.forEach((k, j) => {
        if (!dir.roleByKey.get(k)) issues.push({ path: `changes.${i}.value.secondReviewerRoleKeys.${j}`, message: 'Unknown role' });
      });
    });
    if (issues.length) throw validation('The limit change is not valid', issues);

    const now = this.now();
    const inForce = await this.repo.limitsInForce(now, { roleIds: [role.id] });
    const diffs: LimitDiff[] = input.changes.map((c) => {
      const before = inForce.find((l) => l.action_key === c.actionKey);
      return { actionKey: c.actionKey, actionLabel: actions.get(c.actionKey)!.label, before: before ? this.limitValue(before) : null, after: normalizeLimit(c.value) };
    });
    const me = caller.principal.accountId ?? '';
    const bo = dir.roleByKey.get(BUSINESS_OWNER);
    const otherOwners = bo ? dir.membersOf(bo.id).filter((acc) => acc !== me) : [];
    const autoApprove = dir.isBusinessOwner(me) && (!dir.holds(me, role.id) || !otherOwners.length);
    const id = newId();
    let approvalRequestId: string | null = null;
    if (!autoApprove) {
      const req = await this.openRequest(
        {
          action: LIMITS_CHANGE,
          target: { type: 'limit_change', id, ref: role.key, label: `Approval limits of ${role.name}`, screen: 'admin/staff' },
          summary: `Change ${diffs.length} approval limit${diffs.length === 1 ? '' : 's'} of ${role.name}`,
          details: { roleId: role.id, roleKey: role.key, changes: diffs, effectiveFrom: iso(input.effectiveFrom) },
          reason: input.reason,
          requestedBy: caller.principal,
        },
        { restrictToBusinessOwner: true, requestedByActor: caller.actor, requestId: caller.requestId },
      );
      approvalRequestId = req.id;
    }
    const row = await this.repo.insertLimitChange({
      id,
      role_id: role.id,
      changes: diffs as never,
      reason: input.reason,
      effective_from: new Date(input.effectiveFrom),
      status: autoApprove ? 'scheduled' : 'pending_approval',
      proposed_by_kind: caller.actor.kind,
      proposed_by_id: caller.actor.id ?? '',
      approval_request_id: approvalRequestId,
      created_at: now,
      applied_at: null,
      cancel_reason: null,
    });
    await this.audit(
      {
        action: 'access.limits.propose',
        actionLabel: 'Proposed approval limits',
        target: this.roleTarget(role),
        relatedTargets: [{ type: 'limit_change', id }],
        before: diffs.map((d) => ({ actionKey: d.actionKey, value: d.before })),
        after: diffs.map((d) => ({ actionKey: d.actionKey, value: d.after })),
        reason: input.reason,
        approvalRequestId,
        approvalNote: autoApprove ? 'Approved on creation by the Business Owner' : null,
      },
      caller,
    );
    if (autoApprove && row.effective_from <= now) await this.applyLimitChange(id);
    const fresh = await this.repo.getLimitChange(id);
    return (await this.limitChangeViews([fresh!], dir))[0]!;
  }

  async listLimitChanges(query: { status?: LimitChange['status']; roleId?: string }, page: PageRequest): Promise<common.Page<LimitChange>> {
    await this.ready();
    const dir = await loadDirectory(this.repo, this.now());
    const rows = await this.repo.listLimitChanges(query, page);
    return { ...rows, items: await this.limitChangeViews(rows.items, dir) };
  }

  async cancelLimitChange(caller: Caller, id: string, reason: string): Promise<LimitChange> {
    await this.ready();
    const { before, after } = await this.repo.transaction(async (tx) => {
      const before = await tx.getLimitChange(id, { forUpdate: true });
      if (!before) throw notFound('Limit change');
      const status = limitChangeMachine.next(before.status as never, 'cancel');
      const after = await tx.updateLimitChange(id, { status, cancel_reason: reason });
      return { before, after };
    });
    if (after.approval_request_id) {
      const req = await this.repo.getRequest(after.approval_request_id);
      if (req && !FINAL.has(req.status)) await this.closeRequest(req.id, 'cancel', caller.actor, reason);
    }
    const dir = await loadDirectory(this.repo, this.now());
    const role = dir.roleById.get(after.role_id);
    await this.audit(
      { action: 'access.limits.cancel', actionLabel: 'Withdrew a limit change', target: role ? this.roleTarget(role) : { type: 'role', id: after.role_id }, relatedTargets: [{ type: 'limit_change', id }], before: { status: before.status }, after: { status: after.status }, reason, approvalRequestId: after.approval_request_id },
      caller,
    );
    return (await this.limitChangeViews([after], dir))[0]!;
  }

  async checkAuthority(caller: Caller, input: { action: string; amount?: AmountInput | null }): Promise<AuthorityCheck> {
    return this.check(caller.principal, input.action, input.amount ?? undefined);
  }

  /* ================================================================ admin use cases: approval requests */

  async listApprovalRequests(
    caller: Caller,
    query: { view?: 'to_decide' | 'requested_by_me' | 'all'; status?: ApprovalRequest['status']; actionKey?: string; module?: string; targetType?: string; targetId?: string; overdue?: boolean },
    page: PageRequest,
  ): Promise<common.Page<ApprovalRequest>> {
    await this.ready();
    const me = caller.principal.accountId ?? '';
    const filter: RequestFilter = {
      ...(query.status ? { statuses: [query.status] } : {}),
      ...(query.actionKey ? { actionKey: query.actionKey } : {}),
      ...(query.module ? { module: query.module } : {}),
      ...(query.targetType ? { targetType: query.targetType } : {}),
      ...(query.targetId ? { targetIds: [query.targetId] } : {}),
      ...(query.overdue ? { dueBefore: this.now(), statuses: query.status ? [query.status] : OPEN_REQUEST } : {}),
    };
    const viewAll = query.view === 'all' || (!query.view && (await this.can(caller, 'access.approvals.view-all')));
    if (query.view === 'to_decide') {
      const items = await this.toDecide(caller.principal, { module: query.module, actionKey: query.actionKey, overdue: query.overdue }, undefined, filter);
      return pageOf(items, page);
    }
    if (viewAll || query.view === 'requested_by_me') {
      const rows = await this.repo.pageRequests(query.view === 'requested_by_me' ? { ...filter, requestedById: me } : filter, page);
      return { ...rows, items: await this.views(rows.items, caller.principal) };
    }
    // default: what I requested and what I may decide now
    const dir = await loadDirectory(this.repo, this.now());
    const mine = await this.repo.findRequests({ ...filter, requestedById: me });
    const decide = await this.toDecide(caller.principal, {}, dir, filter);
    const views = await this.views(mine, caller.principal, dir);
    const all = [...views, ...decide.filter((d) => !views.some((v) => v.id === d.id))].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return pageOf(all, page);
  }

  async getApprovalRequest(caller: Caller, id: string): Promise<ApprovalRequest> {
    await this.ready();
    const row = await this.repo.getRequest(id);
    if (!row) throw notFound('Approval request');
    const dir = await loadDirectory(this.repo, this.now());
    const [view] = await this.views([row], caller.principal, dir);
    if (!view || !(await this.mayView(row, view, caller.principal, dir, (p) => this.can(caller, p)))) throw notFound('Approval request');
    return view;
  }

  async decideAs(caller: Caller, id: string, kind: 'approve' | 'reject' | 'return', input: { note?: string | null; stepUpCode?: string | null; reason?: string; comment?: string }): Promise<ApprovalRequest> {
    await this.ready();
    const row = await this.repo.getRequest(id);
    if (!row) throw notFound('Approval request');
    const dir = await loadDirectory(this.repo, this.now());
    const me = caller.principal.accountId ?? '';
    const event = kind === 'approve' ? 'approve' : kind;
    if (kind === 'approve') {
      if (!(DECIDABLE as readonly string[]).includes(row.status)) approvalRequestMachine.next(row.status as never, 'approveFinal');
    } else approvalRequestMachine.next(row.status as never, event as 'reject' | 'return');
    if (caller.principal.kind !== 'staff' || !me) throw new AppError('NOT_ELIGIBLE_APPROVER', 'Only staff decide approval requests');

    const decisions = await this.repo.decisionsOf([row.id]);
    const snapshot = this.snapshotOf(row);
    const state = this.stateOf(row, decisions);
    if (row.requested_by_id === me) {
      if (kind === 'return') throw new AppError('NOT_ELIGIBLE_APPROVER', 'You cannot return your own request; cancel or change it instead', { eligibleRoles: this.roleRefsOf(stepRoleKeys(snapshot, state), dir) });
      throw new AppError('SELF_APPROVAL_NOT_ALLOWED', 'You cannot approve or reject your own request');
    }
    const elig = evaluate(snapshot, state, this.candidate(me, dir, snapshot));
    if (!elig.ok) {
      const code = kind === 'approve' ? elig.code : elig.code === 'SELF_APPROVAL_NOT_ALLOWED' ? elig.code : 'NOT_ELIGIBLE_APPROVER';
      throw new AppError(code, elig.code === 'ALREADY_APPROVED_BY_YOU' ? 'The second approval must come from a different person' : elig.reason, { eligibleRoles: this.roleRefsOf(stepRoleKeys(snapshot, state), dir) });
    }
    if (kind === 'approve') await this.requireStepUp(row, me, input.stepUpCode ?? null);

    const now = this.now();
    const role = dir.roleByKey.get(elig.roleKey);
    const step = state.approvals.length + 1;
    const note = kind === 'approve' ? (input.note ?? null) : kind === 'reject' ? (input.reason ?? null) : (input.comment ?? null);
    const decision: DecisionRow = {
      id: newId(),
      request_id: row.id,
      step,
      decision: kind === 'approve' ? 'approved' : kind === 'reject' ? 'rejected' : 'returned',
      by_account_id: me,
      roles: (role ? [roleRef(role)] : []) as never,
      note,
      via_delegation_from: elig.viaDelegationFrom ?? null,
      at: now,
    };
    const after = await this.repo.transaction(async (tx) => {
      const locked = await tx.getRequest(row.id, { forUpdate: true });
      if (!locked || locked.version !== row.version) throw new AppError('CONFLICT', 'This request changed while you were deciding; reload and try again');
      await tx.insertDecision(decision);
      if (kind === 'approve') {
        const next: RequestState = { ...state, approvals: [...state.approvals, { accountId: me, roleKeys: [elig.roleKey] }] };
        const done = isComplete(snapshot, next);
        const status = approvalRequestMachine.next(locked.status as never, done ? 'approveFinal' : 'approve');
        return tx.updateRequest(row.id, {
          status,
          ...(done
            ? { decided_at: now, required_approvals: Math.min(locked.required_approvals, next.approvals.length) || 1 }
            : { required_approvals: Math.max(locked.required_approvals, next.approvals.length + 1), eligible_role_keys: stepRoleKeys(snapshot, next) as never }),
          version: locked.version + 1,
        });
      }
      const status = approvalRequestMachine.next(locked.status as never, kind);
      return tx.updateRequest(row.id, { status, outcome_reason: note, ...(kind === 'reject' ? { decided_at: now } : {}), version: locked.version + 1 });
    });

    const target = this.targetOf(after);
    const meta = { actor: caller.actor, requestId: caller.requestId };
    if (after.status === 'partially_approved') {
      const nextState = this.stateOf(after, [...decisions, decision]);
      this.ctx.events.publish(
        'access.approval.partially_approved',
        { requestId: after.id, actionKey: after.action_key, module: after.module, target, approvedBy: caller.actor, remainingApprovals: Math.max(1, after.required_approvals - nextState.approvals.length), eligibleAccountIds: this.eligiblePeople(snapshot, nextState, dir, null) },
        meta,
      );
    } else if (after.status === 'returned') {
      this.ctx.events.publish('access.approval.returned', { requestId: after.id, actionKey: after.action_key, module: after.module, target, by: caller.actor, comment: note ?? '', requestedById: after.requested_by_id }, meta);
    } else {
      await this.finish(after, caller.actor, note, caller.requestId);
    }
    await this.audit(
      {
        action: `access.approval.${kind}`,
        actionLabel: kind === 'approve' ? (after.status === 'approved' ? 'Approved request' : 'Gave first approval') : kind === 'reject' ? 'Rejected request' : 'Returned request',
        target: this.auditTarget(after),
        before: { status: row.status },
        after: { status: after.status, step },
        reason: note,
        approvalRequestId: after.id,
      },
      caller,
    );
    return this.viewOne(after, caller.principal);
  }

  async resubmitRequest(caller: Caller, id: string, note: string): Promise<ApprovalRequest> {
    await this.ready();
    const row = await this.repo.getRequest(id);
    if (!row) throw notFound('Approval request');
    if (row.requested_by_id !== caller.principal.accountId) throw new AppError('FORBIDDEN', 'Only the requester can resubmit this request');
    const status = approvalRequestMachine.next(row.status as never, 'resubmit');
    const snapshot = this.snapshotOf(row);
    const fresh: RequestState = { requesterId: row.requested_by_id, requesterCountsAsFirst: row.requester_counts_as_first, approvals: [], amount: this.amountOfRow(row) };
    const after = await this.repo.transaction(async (tx) => {
      const locked = await tx.getRequest(id, { forUpdate: true });
      if (!locked || locked.version !== row.version) throw new AppError('CONFLICT', 'This request changed meanwhile; reload and try again');
      await tx.supersedeDecisions(id);
      await tx.insertDecision({ id: newId(), request_id: id, step: 0, decision: 'resubmitted', by_account_id: caller.principal.accountId!, roles: [] as never, note, via_delegation_from: null, at: this.now() });
      return tx.updateRequest(id, {
        status,
        outcome_reason: null,
        required_approvals: expectedApprovals(snapshot, fresh),
        eligible_role_keys: stepRoleKeys(snapshot, fresh) as never,
        version: locked.version + 1,
      });
    });
    const dir = await loadDirectory(this.repo, this.now());
    this.publishRequested(after, snapshot, dir, { actor: caller.actor, requestId: caller.requestId });
    await this.audit({ action: 'access.approval.resubmit', actionLabel: 'Resubmitted request', target: this.auditTarget(after), before: { status: row.status }, after: { status: after.status }, reason: note, approvalRequestId: id }, caller);
    return this.viewOne(after, caller.principal);
  }

  async cancelRequest(caller: Caller, id: string, reason: string): Promise<ApprovalRequest> {
    await this.ready();
    const row = await this.repo.getRequest(id);
    if (!row) throw notFound('Approval request');
    if (row.requested_by_id !== caller.principal.accountId) throw new AppError('FORBIDDEN', 'Only the requester can withdraw this request');
    approvalRequestMachine.next(row.status as never, 'cancel');
    const after = await this.closeRequest(id, 'cancel', caller.actor, reason, caller.requestId);
    await this.audit({ action: 'access.approval.cancel', actionLabel: 'Withdrew request', target: this.auditTarget(after), before: { status: row.status }, after: { status: after.status }, reason, approvalRequestId: id }, caller);
    return this.viewOne(after, caller.principal);
  }

  async remindReviewers(caller: Caller, id: string, message: string | null | undefined): Promise<{ notified: StaffRef[] }> {
    await this.ready();
    const row = await this.repo.getRequest(id);
    if (!row) throw notFound('Approval request');
    const dir = await loadDirectory(this.repo, this.now());
    const [view] = await this.views([row], caller.principal, dir);
    if (!view || !(await this.mayView(row, view, caller.principal, dir, (p) => this.can(caller, p)))) throw notFound('Approval request');
    if (!(DECIDABLE as readonly string[]).includes(row.status)) {
      throw new AppError('ILLEGAL_TRANSITION', `Approval request: reviewers cannot be reminded of a ${row.status} request`, { machine: 'Approval request', from: row.status, event: 'remind' });
    }
    const minutes = Number(await this.ctx.settings.get('reminderMinIntervalMinutes'));
    if (row.last_reminded_at) {
      const next = new Date(row.last_reminded_at.getTime() + minutes * 60_000);
      if (next > this.now()) throw new AppError('REMINDER_TOO_SOON', `Reviewers were reminded recently; try again after ${next.toISOString()}`, { nextAllowedAt: next.toISOString() });
    }
    const ids = view.eligibleApprovers.map((s) => s.accountId);
    await this.repo.updateRequest(id, { last_reminded_at: this.now() });
    this.ctx.events.publish('access.approval.reminder_sent', { requestId: id, toAccountIds: ids, by: caller.actor, message: message ?? null }, { actor: caller.actor, requestId: caller.requestId });
    return { notified: view.eligibleApprovers };
  }

  /* ================================================================ admin use cases: away periods, coverage, me */

  async listAwayPeriods(query: { accountId?: string; status?: AwayPeriod['status']; from?: string; to?: string }, page: PageRequest): Promise<common.Page<AwayPeriod>> {
    await this.ready();
    const now = this.now();
    const rows = await this.repo.pageAway(
      {
        ...(query.accountId ? { accountId: query.accountId } : {}),
        ...(query.status ? { statuses: [query.status] } : !query.from && !query.to ? { statuses: ['pending_approval', 'scheduled', 'active'], endsAfter: now } : {}),
        ...(query.from ? { from: zonedDayRange(query, this.ctx.config.market.timeZone).start } : {}),
        ...(query.to ? { to: zonedDayRange(query, this.ctx.config.market.timeZone).end } : {}),
      },
      page,
    );
    const dir = await loadDirectory(this.repo, now);
    return { ...rows, items: await this.awayViews(rows.items, dir) };
  }

  async createAwayPeriod(caller: Caller, input: AwayInput): Promise<AwayPeriod> {
    await this.ready();
    const me = caller.principal.accountId ?? '';
    const accountId = input.accountId ?? me;
    if (accountId !== me && !(await this.can(caller, 'access.away.manage'))) throw new AppError('FORBIDDEN', 'Planning time away for someone else needs access.away.manage', { permission: 'access.away.manage' });
    const now = this.now();
    const from = new Date(input.from);
    const to = new Date(input.to);
    const issues: Issue[] = [];
    if (!(to > from)) issues.push({ path: 'to', message: 'Must be after the start' });
    if (to <= now) issues.push({ path: 'to', message: 'Must be in the future' });
    if (issues.length) throw validation('The away period is not valid', issues);

    const dir = await loadDirectory(this.repo, now);
    const coverIssues: Issue[] = [];
    const heldRoles = dir.rolesOf(accountId);
    const leads = (rid: string) => dir.coverage.get(rid)?.lead === accountId;
    input.coverage.forEach((c, i) => {
      const role = dir.roleById.get(c.roleId);
      if (!role || !heldRoles.some((r) => r.id === c.roleId)) coverIssues.push({ path: `coverage.${i}.roleId`, message: 'Not a role of the person who is away' });
      else if (c.coveredByAccountId === accountId) coverIssues.push({ path: `coverage.${i}.coveredByAccountId`, message: 'Someone else must cover' });
      else if (leads(c.roleId) && !dir.holds(c.coveredByAccountId, c.roleId) && !dir.isBusinessOwner(c.coveredByAccountId)) coverIssues.push({ path: `coverage.${i}.coveredByAccountId`, message: `The lead's cover must hold ${role.name} (or be Business Owner)` });
      else if (!dir.rolesOf(c.coveredByAccountId).length) coverIssues.push({ path: `coverage.${i}.coveredByAccountId`, message: 'Must be a staff member with a role' });
      if (input.coverage.findIndex((x) => x.roleId === c.roleId) !== i) coverIssues.push({ path: `coverage.${i}.roleId`, message: 'Listed twice' });
    });
    for (const [roleId, cov] of dir.coverage) {
      if (cov.lead === accountId && !input.coverage.some((c) => c.roleId === roleId)) {
        coverIssues.push({ path: 'coverage', message: `${dir.roleById.get(roleId)?.name ?? 'A role'} is led by this person and needs cover` });
      }
    }
    if (coverIssues.length) throw new AppError('COVERAGE_INVALID', 'Every role this person leads needs cover by someone holding it', { issues: coverIssues });
    const overlapping = await this.repo.findAway({ accountId, statuses: ['pending_approval', 'scheduled', 'active'], from, to });
    if (overlapping.length) throw new AppError('AWAY_OVERLAP', 'This person already has an away period in that time', { awayPeriodId: overlapping[0]!.id });

    const id = newId();
    let approvalRequestId: string | null = null;
    const name = (await this.accounts([accountId])).get(accountId)?.displayName ?? 'staff member';
    if (input.delegateApprovals) {
      const req = await this.openRequest(
        {
          action: DELEGATIONS,
          target: { type: 'away_period', id, label: `Time away of ${name}`, screen: 'admin/staff' },
          summary: `Delegate approval authority while ${name} is away (${input.from.slice(0, 10)} to ${input.to.slice(0, 10)})`,
          details: { accountId, from: iso(from), to: iso(to), coverage: input.coverage },
          reason: input.reason ?? 'Time away',
          requestedBy: caller.principal,
          dueAt: from > now ? iso(from) : null,
        },
        { restrictToBusinessOwner: true, requestedByActor: caller.actor, requestId: caller.requestId },
      );
      approvalRequestId = req.id;
    }
    let row = await this.repo.insertAway(
      {
        id,
        account_id: accountId,
        starts_at: from,
        ends_at: to,
        status: input.delegateApprovals ? 'pending_approval' : awayPeriodMachine.initial,
        delegate_approvals: input.delegateApprovals,
        reason: input.reason ?? null,
        approval_request_id: approvalRequestId,
        created_by_kind: caller.actor.kind,
        created_by_id: caller.actor.id ?? '',
        created_at: now,
        ended_at: null,
      },
      input.coverage.map((c) => ({ away_period_id: id, role_id: c.roleId, covered_by_account_id: c.coveredByAccountId })),
    );
    if (row.status === 'scheduled' && from <= now) row = (await this.startAway(id)) ?? row;
    await this.audit(
      { action: 'access.away.create', actionLabel: 'Planned time away', target: { type: 'away_period', id, label: `Time away of ${name}` }, relatedTargets: [{ type: 'staff', id: accountId, label: name }], after: { from: iso(from), to: iso(to), coverage: input.coverage, delegateApprovals: input.delegateApprovals }, reason: input.reason ?? null, approvalRequestId },
      caller,
    );
    return (await this.awayViews([row], await loadDirectory(this.repo, this.now())))[0]!;
  }

  async endAwayPeriod(caller: Caller, id: string): Promise<AwayPeriod> {
    await this.ready();
    const row = await this.repo.getAway(id);
    if (!row) throw notFound('Away period');
    await this.requireOwnOrManage(caller, row);
    if (row.status === 'scheduled' && row.starts_at <= this.now()) await this.startAway(id);
    const current = (await this.repo.getAway(id))!;
    awayPeriodMachine.next(current.status as never, 'end');
    const after = (await this.finishAway(id))!;
    await this.audit({ action: 'access.away.end', actionLabel: 'Ended time away early', target: { type: 'away_period', id }, before: { status: row.status }, after: { status: after.status } }, caller);
    return (await this.awayViews([after], await loadDirectory(this.repo, this.now())))[0]!;
  }

  async cancelAwayPeriod(caller: Caller, id: string, reason: string | null | undefined): Promise<AwayPeriod> {
    await this.ready();
    const row = await this.repo.getAway(id);
    if (!row) throw notFound('Away period');
    await this.requireOwnOrManage(caller, row);
    const after = await this.repo.transaction(async (tx) => {
      const locked = await tx.getAway(id, { forUpdate: true });
      const status = awayPeriodMachine.next(locked!.status as never, 'cancel');
      return tx.updateAway(id, { status, ...(reason ? { reason } : {}) });
    });
    if (after.approval_request_id) {
      const req = await this.repo.getRequest(after.approval_request_id);
      if (req && !FINAL.has(req.status)) await this.closeRequest(req.id, 'cancel', caller.actor, reason ?? 'Away period cancelled');
    }
    await this.audit({ action: 'access.away.cancel', actionLabel: 'Cancelled time away', target: { type: 'away_period', id }, before: { status: row.status }, after: { status: after.status }, reason: reason ?? null }, caller);
    return (await this.awayViews([after], await loadDirectory(this.repo, this.now())))[0]!;
  }

  async getCoverage(): Promise<Coverage> {
    await this.ready();
    return this.coverageOfRoles(await loadDirectory(this.repo, this.now()));
  }

  async getMyAccess(caller: Caller): Promise<MyAccess> {
    await this.ready();
    const me = caller.principal.accountId ?? '';
    const dir = await loadDirectory(this.repo, this.now());
    const account = (await this.requireAccounts([me])).get(me);
    if (!account) throw notFound('Staff account');
    const roles = this.sortRoles(dir.rolesOf(me));
    const limits = await this.repo.limitsInForce(this.now(), { roleIds: roles.map((r) => r.id) });
    const away = dir.awayOf(me);
    const mine = await this.repo.findRequests({ requestedById: me, statuses: OPEN_REQUEST });
    return {
      account,
      roles: roles.map(roleRef),
      coveringNow: uniq(dir.covering(me).map((c) => c.roleId)).map((id) => dir.roleById.get(id)).filter((r): r is RoleRow => Boolean(r)).map(roleRef),
      permissions: [...dir.permissionsOf(me)].sort(),
      limits: await this.limitViews(limits, dir),
      approvalsToDecide: (await this.toDecide(caller.principal, {}, dir)).length,
      myOpenRequests: mine.length,
      away: away ? ((await this.awayViews([away], dir))[0] ?? null) : null,
    };
  }

  /* ================================================================ events consumed */

  /**
   * identity.invitation.accepted: Activate pending_acceptance role assignments of a newly accepted staff member
   * (including sensitive grants already approved); assignments still pending_approval wait for their approval
   * and then become active.
   */
  async onInvitationAcceptedFromIdentity(event: EventPayload<'identity.invitation.accepted'>): Promise<void> {
    if (event.purpose !== 'staff') return;
    await this.ready();
    await this.activateAcceptedAssignments(event.accountId);
  }

  /** Whether the staff member has accepted their invitation (an unknown account counts as accepted: nothing to wait for) */
  private async hasAcceptedInvitation(accountId: string): Promise<boolean> {
    const account = await this.ctx.use('identity').getAccount(accountId);
    return !account || (account.status !== 'invited' && account.status !== 'pending_verification');
  }

  /** pending_acceptance → active for every assignment of someone who accepted their invitation (idempotent) */
  private async activateAcceptedAssignments(accountId: string): Promise<void> {
    const waiting = await this.repo.listAssignments({ accountId, statuses: ['pending_acceptance'] });
    for (const a of waiting) {
      const after = await this.repo.transaction(async (tx) => {
        const locked = await tx.getAssignment(a.id, { forUpdate: true });
        if (locked?.status !== 'pending_acceptance') return null;
        return tx.updateAssignment(a.id, { status: roleAssignmentMachine.next('pending_acceptance', 'accept') });
      });
      if (!after) continue;
      const role = await this.repo.getRole(after.role_id);
      if (role) this.publishRoleChanged(role, 'assigned', after.account_id, SYSTEM_ACTOR);
    }
  }

  /** identity.account.disabled: Revoke all role assignments, remove the person as lead/backup, drop them from eligible approvers of open requests, and publish access.coverage.changed with the gap */
  async onAccountDisabledFromIdentity(event: EventPayload<'identity.account.disabled'>): Promise<void> {
    await this.ready();
    const accountId = event.accountId;
    const open = await this.repo.listAssignments({ accountId, statuses: OPEN_ASSIGNMENT });
    const reason = `Account disabled: ${event.reason}`;
    for (const a of open) {
      try {
        await this.endAssignment(a.id, a.status === 'pending_approval' ? 'reject' : 'revoke', event.by ?? SYSTEM_ACTOR, reason);
      } catch (err) {
        if (!(err instanceof AppError && err.code === 'ILLEGAL_TRANSITION')) throw err;
      }
    }
    const coverage = await this.repo.listCoverage();
    const touched: string[] = [];
    for (const c of coverage) {
      const backups = (c.backup_account_ids as string[]) ?? [];
      if (c.lead_account_id !== accountId && !backups.includes(accountId)) continue;
      await this.repo.upsertCoverage({ ...c, lead_account_id: c.lead_account_id === accountId ? null : c.lead_account_id, backup_account_ids: backups.filter((b) => b !== accountId), updated_by: 'system', updated_at: this.now() });
      touched.push(c.role_id);
    }
    const nominated = await this.repo.findRequests({ statuses: OPEN_REQUEST });
    for (const r of nominated.filter((x) => x.nominated_reviewer_id === accountId)) await this.repo.updateRequest(r.id, { nominated_reviewer_id: null });
    await this.publishCoverageFor(touched);
    if (open.length || touched.length) {
      await this.audit(
        {
          action: 'access.staff.disabled',
          actionLabel: 'Removed the roles and cover duties of a disabled account',
          target: { type: 'staff', id: accountId },
          before: { assignments: open.map((a) => ({ id: a.id, roleId: a.role_id, status: a.status })), coverageRoleIds: touched },
          after: { assignments: [], coverageRoleIds: [] },
          reason,
        },
        { actor: event.by ?? SYSTEM_ACTOR },
      );
    }
  }

  /** identity.account.locked: Treat a locked staff member as unavailable for routing (backup receives) until unlocked */
  async onAccountLockedFromIdentity(event: EventPayload<'identity.account.locked'>): Promise<void> {
    await this.ready();
    await this.publishCoverageFor(await this.rolesRoutedTo(event.accountId), new Set([event.accountId]));
  }

  /** identity.account.unlocked: Restore routing to the unlocked staff member */
  async onAccountUnlockedFromIdentity(event: EventPayload<'identity.account.unlocked'>): Promise<void> {
    await this.ready();
    await this.publishCoverageFor(await this.rolesRoutedTo(event.accountId), undefined, new Set([event.accountId]));
  }

  /* ================================================================ jobs */

  /** Job access.sync-registry (on boot): Upsert permissions and approval actions from enabled module manifests; mark those of disabled modules unavailable (kept for history); seed the system roles on first boot */
  async syncRegistry(): Promise<void> {
    this.#syncing ??= this.doSync()
      .then(() => {
        this.#ready ??= Promise.resolve(); // the boot job did the work: no second sync on the first request
      })
      .finally(() => {
        this.#syncing = undefined;
      });
    return this.#syncing;
  }

  /** Job access.apply-limit-changes (every minute): Apply scheduled limit changes whose effectiveFrom has passed; publish access.limits.changed */
  async applyLimitChanges(): Promise<void> {
    await this.ready();
    for (;;) {
      const due = await this.repo.dueLimitChanges(this.now(), BATCH);
      for (const lc of due) await this.applyLimitChange(lc.id);
      if (due.length < BATCH) return;
    }
  }

  /** Job access.run-away-periods (every 5 min): Start scheduled away periods and end active ones at their time; publish access.away.started/ended and access.coverage.changed */
  async runAwayPeriods(): Promise<void> {
    await this.ready();
    const now = this.now();
    const scheduled = await this.repo.findAway({ statuses: ['scheduled'], to: new Date(now.getTime() + 1) });
    for (const p of scheduled) await this.startAway(p.id);
    const active = await this.repo.findAway({ statuses: ['active'] });
    for (const p of active.filter((x) => x.ends_at <= now)) await this.finishAway(p.id);
  }

  /** Job access.expire-approval-requests (every 15 min): Expire open requests past expires_at (dueAt + grace, or approvalRequestTtlHours) and publish access.approval.decided with outcome expired */
  async expireApprovalRequests(): Promise<void> {
    await this.ready();
    for (;;) {
      const due = await this.repo.findRequests({ statuses: OPEN_REQUEST, expiresBefore: this.now() }, { limit: BATCH, order: 'created_asc' });
      for (const r of due) await this.closeRequest(r.id, 'expire', SYSTEM_ACTOR, 'No decision before the request expired');
      if (due.length < BATCH) return;
    }
  }

  /** Job access.remind-approvals (every 30 min): Remind eligible reviewers of requests due within reminderHoursBeforeDue or waiting longer than reminderAfterHours; escalate to the role's escalation role when overdue */
  async remindApprovals(): Promise<void> {
    await this.ready();
    const now = this.now();
    const before = Number(await this.ctx.settings.get('reminderHoursBeforeDue')) * 3_600_000;
    const after = Number(await this.ctx.settings.get('reminderAfterHours')) * 3_600_000;
    const open = await this.repo.findRequests({ statuses: DECIDABLE }, { order: 'created_asc', limit: 1000 });
    if (!open.length) return;
    const dir = await loadDirectory(this.repo, now);
    const decisions = await this.repo.decisionsOf(open.map((r) => r.id));
    for (const r of open) {
      const last = r.last_reminded_at?.getTime() ?? 0;
      let overdue = false;
      if (r.due_at) {
        const due = r.due_at.getTime();
        overdue = now.getTime() > due;
        const windowStart = overdue ? due : due - before;
        if (now.getTime() < due - before || last >= windowStart) continue;
      } else if (now.getTime() - r.created_at.getTime() < after || now.getTime() - last < after) continue;
      const snapshot = this.snapshotOf(r);
      const state = this.stateOf(r, decisions.filter((d) => d.request_id === r.id));
      const to = new Set(this.eligiblePeople(snapshot, state, dir, null));
      if (overdue) {
        for (const key of stepRoleKeys(snapshot, state)) {
          const esc = dir.roleByKey.get(key)?.escalation_role_id;
          if (esc) for (const acc of dir.membersOf(esc)) if (acc !== r.requested_by_id) to.add(acc);
        }
      }
      await this.repo.updateRequest(r.id, { last_reminded_at: now });
      this.ctx.events.publish('access.approval.reminder_sent', { requestId: r.id, toAccountIds: [...to], by: SYSTEM_ACTOR, message: overdue ? 'Overdue: escalated' : null }, { actor: SYSTEM_ACTOR });
    }
  }

  /** Job access.expire-assignments (hourly): Expire role assignments past expiresAt (temporary access) */
  async expireAssignments(): Promise<void> {
    await this.ready();
    const now = this.now();
    const active = await this.repo.listAssignments({ statuses: ['active'] });
    for (const a of active.filter((x) => x.expires_at && x.expires_at <= now)) {
      const after = await this.endAssignment(a.id, 'expire', SYSTEM_ACTOR, 'Temporary access ended');
      await this.audit(
        { action: 'access.role.expire', actionLabel: 'Temporary role ended', target: { type: 'staff', id: a.account_id }, relatedTargets: [{ type: 'role', id: a.role_id }], before: { status: a.status, expiresAt: iso(a.expires_at!) }, after: { status: after.status } },
        { actor: SYSTEM_ACTOR },
      );
    }
  }

  /* ================================================================ registry sync */

  private async doSync() {
    const now = this.now();
    const enabled = new Set<string>(this.ctx.modules);
    const prefixes = await this.sensitivePrefixes();
    const specs = Object.values(allSpecs);
    const permissions = specs.flatMap((s) =>
      s.permissions
        .filter((p) => p.audience === 'staff')
        .map((p) => ({ key: p.key, module: s.name, area: areaOf(s.name), label: permissionLabel(p.key), description: p.desc, sensitive: this.isSensitive(p.key, prefixes), registered_at: now, unavailable_since: enabled.has(s.name) ? null : now })),
    );
    const actions = specs.flatMap((s) =>
      s.approvalActions.map((a) => ({
        key: a.key,
        module: s.name,
        label: a.desc,
        limit_kind: a.limit as ActionRow['limit_kind'],
        second_reviewer: a.secondReviewer as ActionRow['second_reviewer'],
        approvers: a.approvers ?? null,
        default_eligible_role_keys: defaultEligibleRoleKeys(a.key, a.approvers) as never,
        unavailable_since: enabled.has(s.name) ? null : now,
      })),
    );
    await this.repo.transaction(async (tx) => {
      await tx.lockRegistry();
      await tx.upsertPermissions(permissions);
      await tx.markPermissionsUnavailable(permissions.map((p) => p.key), now);
      await tx.upsertActions(actions);
      await tx.markActionsUnavailable(actions.map((a) => a.key), now);

      const staffKeys = permissions.map((p) => p.key);
      const actionKeys = new Set(actions.map((a) => a.key));
      const created: { seed: (typeof SYSTEM_ROLES)[number]; row: RoleRow }[] = [];
      for (const seed of SYSTEM_ROLES) {
        const existing = await tx.getRoleByKey(seed.key);
        if (existing) {
          // seeded limits added later (or for actions registered later) reach existing installs: a limit row is
          // only added where the role never had one for that action (limit rows are effective-dated, never deleted,
          // so a limit the Business Owner changed or removed is never overwritten)
          if (existing.system && !existing.archived_at) {
            const rows: LimitRow[] = [];
            for (const [key, v] of Object.entries(seed.limits)) {
              if (actionKeys.has(key) && !(await tx.limitRowExists(existing.id, key))) rows.push(this.limitRow(existing.id, key, normalizeLimit(v), now, null));
            }
            await tx.insertLimits(rows);
          }
          continue;
        }
        const row = await tx.insertRole({
          id: newId(),
          key: seed.key,
          name: seed.name,
          kind: seed.kind,
          work_area: seed.workArea,
          description: seed.description,
          system: true,
          escalation_role_id: null,
          archived_at: null,
          created_at: now,
          updated_at: now,
          version: 1,
        });
        if (!row) continue;
        created.push({ seed, row });
        await tx.addRolePermissions(row.id, expandPermissions(seed.permissions, staffKeys), 'system', now);
        await tx.insertLimits(
          Object.entries(seed.limits)
            .filter(([key]) => actionKeys.has(key))
            .map(([key, v]) => this.limitRow(row.id, key, normalizeLimit(v), now, null)),
        );
      }
      for (const { seed, row } of created) {
        if (!seed.escalationRoleKey) continue;
        const esc = await tx.getRoleByKey(seed.escalationRoleKey);
        if (esc) await tx.updateRole(row.id, { escalation_role_id: esc.id });
      }
      // the Business Owner is the final approver above every limit, also for actions registered later
      const bo = await tx.getRoleByKey(BUSINESS_OWNER);
      if (bo) {
        const rows: LimitRow[] = [];
        for (const key of actionKeys) if (!(await tx.limitRowExists(bo.id, key))) rows.push(this.limitRow(bo.id, key, normalizeLimit({ authority: 'permitted' }), now, null));
        await tx.insertLimits(rows);
      }
    });
  }

  /* ================================================================ approval request internals */

  /** Creates the request (or returns the open one for the same action and target) and announces it. */
  private async openRequest(
    input: RequestApprovalInput,
    opts: { restrictToBusinessOwner?: boolean; requestedByActor?: common.Actor; requestId?: string },
  ): Promise<RequestRow> {
    await this.ready();
    const act = await this.requireAction(input.action);
    const existing = await this.repo.findOpenRequest(act.key, input.target.type, input.target.id);
    if (existing) return existing;
    const issues: Issue[] = [];
    if (!input.summary?.trim()) issues.push({ path: 'summary', message: 'Summarise the request' });
    if (input.nominatedReviewerId && input.nominatedReviewerId === input.requestedBy.accountId) issues.push({ path: 'nominatedReviewerId', message: 'Nominate someone other than the requester' });
    if (input.amount && (!Number.isSafeInteger(input.amount.amount) || input.amount.amount < 0)) issues.push({ path: 'amount', message: 'Amounts are whole minor units, zero or more' });
    if (issues.length) throw validation('The approval request is not valid', issues);

    const now = this.now();
    const dir = await loadDirectory(this.repo, now);
    const amount = this.amountOf(act, { money: input.amount ?? null, number: input.quantity ?? null });
    const requesterId = input.requestedBy.accountId ?? '';
    const snapshot = await this.snapshotFor(act, dir, input.requestedBy.kind === 'staff' ? requesterId : null, amount, opts.restrictToBusinessOwner);
    const reqStanding = snapshot.requester ? standing(snapshot.limitKind, snapshot.secondReviewer, snapshot.requester.value, amount, true) : 0;
    const countsAsFirst = snapshot.permissionRule ? this.candidate(requesterId, dir, snapshot).hasPermission || reqStanding >= 2 : reqStanding === 2;
    const state: RequestState = { requesterId, requesterCountsAsFirst: countsAsFirst, approvals: [], amount };
    const ttl = Number(await this.ctx.settings.get('approvalRequestTtlHours')) * 3_600_000;
    const dueAt = input.dueAt ? new Date(input.dueAt) : null;
    const ref = await this.ctx.refs.next('AP', { digits: 4 });
    const requesterRoles = this.sortRoles(dir.rolesOf(requesterId)).map(roleRef);
    const row: RequestRow = {
      id: newId(),
      ref,
      action_key: act.key,
      module: act.module,
      target_type: input.target.type,
      target_id: input.target.id,
      target_ref: input.target.ref ?? null,
      target_label: input.target.label ?? null,
      target_screen: input.target.screen ?? null,
      seller_id: input.target.sellerId ?? null,
      amount_minor: input.amount?.amount ?? null,
      currency: input.amount?.currency ?? null,
      quantity: input.quantity != null ? String(input.quantity) : null,
      summary: input.summary.trim(),
      details: (input.details ?? {}) as never,
      reason: input.reason,
      requested_by_kind: opts.requestedByActor?.kind ?? input.requestedBy.kind,
      requested_by_id: requesterId || (input.requestedBy.sessionId ?? 'unknown'),
      requester_roles: requesterRoles as never,
      requester_counts_as_first: countsAsFirst,
      required_approvals: expectedApprovals(snapshot, state),
      status: approvalRequestMachine.initial,
      eligible_role_keys: stepRoleKeys(snapshot, state) as never,
      nominated_reviewer_id: input.nominatedReviewerId ?? null,
      limit_snapshot: snapshot as never,
      due_at: dueAt,
      expires_at: new Date(dueAt ? dueAt.getTime() + EXPIRY_GRACE_MS : now.getTime() + ttl),
      created_at: now,
      decided_at: null,
      outcome_reason: null,
      last_reminded_at: null,
      version: 1,
    };
    let saved: RequestRow;
    try {
      saved = await this.repo.insertRequest(row);
    } catch (err) {
      const again = await this.repo.findOpenRequest(act.key, input.target.type, input.target.id);
      if (again) return again; // created concurrently for the same target
      throw err;
    }
    const actor = opts.requestedByActor ?? { kind: input.requestedBy.kind, id: requesterId || null };
    this.publishRequested(saved, snapshot, dir, { actor, requestId: opts.requestId });
    await this.audit(
      { action: 'access.approval.request', actionLabel: 'Requested approval', target: this.auditTarget(saved), after: { actionKey: act.key, summary: saved.summary, amount: input.amount ?? null, requiredApprovals: saved.required_approvals }, reason: input.reason, approvalRequestId: saved.id },
      { actor, requestId: opts.requestId },
    );
    return saved;
  }

  private publishRequested(row: RequestRow, snapshot: Snapshot, dir: Directory, meta: { actor: common.Actor; requestId?: string }) {
    const state = this.stateOf(row, []);
    this.ctx.events.publish(
      'access.approval.requested',
      {
        requestId: row.id,
        ref: row.ref,
        actionKey: row.action_key,
        module: row.module,
        target: this.targetOf(row),
        amount: moneyOf(row.amount_minor, row.currency),
        summary: row.summary,
        requestedBy: meta.actor,
        eligibleRoleKeys: (row.eligible_role_keys as string[]) ?? [],
        eligibleAccountIds: this.eligiblePeople(snapshot, state, dir, row.nominated_reviewer_id),
        nominatedReviewerId: row.nominated_reviewer_id,
        dueAt: row.due_at ? iso(row.due_at) : null,
      },
      meta,
    );
  }

  /** cancel or expire an open request, announce the outcome and finish this module's own targets */
  private async closeRequest(id: string, event: 'cancel' | 'expire', actor: common.Actor, reason: string, requestId?: string): Promise<RequestRow> {
    const after = await this.repo.transaction(async (tx) => {
      const locked = await tx.getRequest(id, { forUpdate: true });
      if (!locked) throw notFound('Approval request');
      const status = approvalRequestMachine.next(locked.status as never, event);
      return tx.updateRequest(id, { status, decided_at: this.now(), outcome_reason: reason, version: locked.version + 1 });
    });
    await this.finish(after, event === 'expire' ? null : actor, reason, requestId);
    return after;
  }

  /** A request reached a final outcome: announce it, and finish the records this module itself is waiting on */
  private async finish(row: RequestRow, decidedBy: common.Actor | null, reason: string | null, requestId?: string) {
    const outcome = row.status as 'approved' | 'rejected' | 'cancelled' | 'expired';
    const decisions = await this.repo.decisionsOf([row.id]);
    this.ctx.events.publish(
      'access.approval.decided',
      {
        requestId: row.id,
        ref: row.ref,
        actionKey: row.action_key,
        module: row.module,
        target: this.targetOf(row),
        outcome,
        decidedBy,
        reason,
        amount: moneyOf(row.amount_minor, row.currency),
        approverIds: decisions.filter((d) => d.decision === 'approved').map((d) => d.by_account_id),
        requestedById: row.requested_by_id,
      },
      { actor: decidedBy ?? SYSTEM_ACTOR, requestId },
    );
    if (row.module === 'access') await this.onOwnApprovalDecided(row, outcome, decidedBy ?? SYSTEM_ACTOR);
  }

  /** access's own approval actions: limit changes, sensitive grants and delegations */
  private async onOwnApprovalDecided(row: RequestRow, outcome: 'approved' | 'rejected' | 'cancelled' | 'expired', actor: common.Actor) {
    const approved = outcome === 'approved';
    if (row.target_type === 'limit_change') {
      const lc = await this.repo.getLimitChange(row.target_id);
      if (lc?.status !== 'pending_approval') return;
      const status = limitChangeMachine.next('pending_approval', approved ? 'approve' : outcome === 'cancelled' ? 'cancel' : 'reject');
      await this.repo.updateLimitChange(lc.id, { status, ...(approved ? {} : { cancel_reason: row.outcome_reason }) });
      if (approved && lc.effective_from <= this.now()) await this.applyLimitChange(lc.id);
      return;
    }
    if (row.target_type === 'role_assignment') {
      const a = await this.repo.getAssignment(row.target_id);
      if (a?.status !== 'pending_approval') return;
      if (approved) {
        // guarded: a person who hasn't accepted their invitation yet waits in pending_acceptance (identity.invitation.accepted activates it)
        const target = (await this.hasAcceptedInvitation(a.account_id)) ? 'active' : 'pending_acceptance';
        const after = await this.repo.transaction(async (tx) => {
          const locked = await tx.getAssignment(a.id, { forUpdate: true });
          if (locked?.status !== 'pending_approval') return null;
          return tx.updateAssignment(a.id, { status: roleAssignmentMachine.next('pending_approval', 'approve', target) });
        });
        if (!after) return;
        if (after.status === 'active') {
          const role = await this.repo.getRole(after.role_id);
          if (role) this.publishRoleChanged(role, 'assigned', after.account_id, actor);
        } else if (await this.hasAcceptedInvitation(after.account_id)) {
          // accepted while the approval was being recorded: its event found nothing to activate
          await this.activateAcceptedAssignments(after.account_id);
        }
      } else {
        await this.repo.updateAssignment(a.id, { status: roleAssignmentMachine.next('pending_approval', 'reject'), revoked_at: this.now(), revoked_by: by(actor), revoke_reason: row.outcome_reason ?? `Approval ${outcome}` });
      }
      return;
    }
    if (row.target_type === 'role_permissions' && approved) {
      const role = await this.repo.getRole(row.target_id);
      const keys = ((row.details as { permissionKeys?: string[] } | null)?.permissionKeys ?? []).filter((k) => typeof k === 'string');
      if (!role || role.archived_at || !keys.length) return;
      const registry = new Map((await this.repo.listPermissions()).map((p) => [p.key, p]));
      const grant = keys.filter((k) => registry.get(k) && !registry.get(k)!.unavailable_since);
      await this.repo.addRolePermissions(role.id, grant, by(actor), this.now());
      this.publishRoleChanged(role, 'permissions_changed', null, actor);
      await this.audit({ action: 'access.role.permissions', actionLabel: 'Granted approved permissions', target: this.roleTarget(role), after: { added: grant }, approvalRequestId: row.id }, { actor });
      return;
    }
    if (row.target_type === 'away_period') {
      const p = await this.repo.getAway(row.target_id);
      if (p?.status !== 'pending_approval') return;
      const status = awayPeriodMachine.next('pending_approval', approved ? 'approve' : outcome === 'cancelled' ? 'cancel' : 'reject');
      await this.repo.updateAway(p.id, { status });
      if (approved && p.starts_at <= this.now() && p.ends_at > this.now()) await this.startAway(p.id);
    }
  }

  /** The amount is above stepUpAbove (money in the same currency): acting or approving needs a fresh 2-step code */
  private async stepUpNeeded(amount: Amount): Promise<boolean> {
    const m = amount.money;
    if (!m) return false;
    const above = (await this.ctx.settings.get('stepUpAbove')) as common.Money | null;
    return !!above && above.currency === m.currency && m.amount > above.amount;
  }

  private async requireStepUp(row: RequestRow, accountId: string, code: string | null) {
    if (row.amount_minor == null || !row.currency) return;
    const above = (await this.ctx.settings.get('stepUpAbove')) as common.Money | null;
    if (!above || above.currency !== row.currency || Number(row.amount_minor) <= above.amount) return;
    const refuse = () => new AppError('STEP_UP_REQUIRED', `Approvals above ${amountText('money', { money: above })} need a fresh 2-step code`, { kind: 'code', purpose: 'approval' });
    if (!code) throw refuse();
    let ok = false;
    try {
      ok = await this.ctx.use('identity').verifyStepUp(accountId, { code });
    } catch (err) {
      if (!isNotImplemented(err)) throw err; // identity not built yet: fail closed
    }
    if (!ok) throw refuse();
  }

  /** Limits in force for this action, the requester's best one and the special rules of access's own actions */
  private async snapshotFor(act: ActionRow, dir: Directory, requesterId: string | null, amount: Amount, restrictToBusinessOwner?: boolean): Promise<Snapshot> {
    const kind = act.limit_kind as LimitKind;
    const mode = act.second_reviewer as SecondMode;
    const limits = await this.repo.limitsInForce(dir.now, { actionKey: act.key });
    const roles: Record<string, LimitValue> = {};
    for (const l of limits) {
      const role = dir.roleById.get(l.role_id);
      if (role && !role.archived_at && !roles[role.key]) roles[role.key] = this.limitValue(l);
    }
    const snapshot: Snapshot = { actionKey: act.key, limitKind: kind, secondReviewer: mode, roles, requester: null };
    if (act.key === LIMITS_CHANGE || act.key === DELEGATIONS || restrictToBusinessOwner) snapshot.restrictRoleKeys = [BUSINESS_OWNER];
    if (act.key === SENSITIVE_GRANT) {
      const holders = dir.roles.filter((r) => !r.archived_at && (dir.permsByRole.get(r.id)?.has('access.roles.manage') || r.key === BUSINESS_OWNER)).map((r) => r.key);
      snapshot.permissionRule = { permission: 'access.roles.manage', roleKeys: uniq([BUSINESS_OWNER, ...holders]) };
    }
    if (requesterId) {
      const mine = this.limitsOfPerson(requesterId, dir, limits, kind);
      const best = bestFor(kind, mode, mine, amount, true);
      if (best) snapshot.requester = { roleKey: best.roleKey, value: dir.blocked.has(requesterId) ? this.blockedValue(best.value) : best.value };
      else snapshot.requester = { roleKey: null, value: NOT_PERMITTED };
    }
    return snapshot;
  }

  /** A person's limits for one action: own roles plus roles covered with delegated authority (never above the away person's) */
  private limitsOfPerson(accountId: string, dir: Directory, limits: LimitRow[], _kind: LimitKind): { roleKey: string; value: LimitValue }[] {
    const roleIds = new Set([...dir.rolesOf(accountId).map((r) => r.id), ...dir.covering(accountId).filter((c) => c.delegated).map((c) => c.roleId)]);
    const out: { roleKey: string; value: LimitValue }[] = [];
    for (const l of limits) {
      const role = dir.roleById.get(l.role_id);
      if (role && roleIds.has(l.role_id) && !out.some((o) => o.roleKey === role.key)) out.push({ roleKey: role.key, value: this.limitValue(l) });
    }
    return out;
  }

  /** While the Business Owner reviews a new member's limits they may prepare requests but not approve */
  private blockedValue(v: LimitValue): LimitValue {
    return v.authority === 'not_permitted' ? v : { ...NOT_PERMITTED, authority: 'recommend_only' };
  }

  private candidate(accountId: string, dir: Directory, snapshot: Snapshot): Candidate {
    const delegated: Record<string, string> = {};
    for (const c of dir.covering(accountId)) {
      const role = dir.roleById.get(c.roleId);
      if (c.delegated && role) delegated[role.key] = c.from;
    }
    return {
      accountId,
      roleKeys: dir.rolesOf(accountId).map((r) => r.key),
      delegated,
      hasPermission: snapshot.permissionRule ? dir.permissionsOf(accountId).has(snapshot.permissionRule.permission) : false,
      blocked: dir.blocked.has(accountId),
    };
  }

  /** People who could decide the current step now (backups covering with delegated authority included) */
  private eligiblePeople(snapshot: Snapshot, state: RequestState, dir: Directory, nominated: string | null): string[] {
    const keys = stepRoleKeys(snapshot, state);
    const pool = new Set<string>();
    for (const k of keys) {
      const role = dir.roleByKey.get(k);
      if (!role) continue;
      for (const acc of dir.membersOf(role.id)) pool.add(acc);
    }
    for (const { coverage } of dir.away) for (const c of coverage) pool.add(c.covered_by_account_id);
    if (snapshot.permissionRule) for (const a of dir.assignments) pool.add(a.account_id);
    if (nominated) pool.add(nominated);
    const out = [...pool].filter((acc) => evaluate(snapshot, state, this.candidate(acc, dir, snapshot)).ok);
    if (nominated && out.includes(nominated)) return [nominated, ...out.filter((x) => x !== nominated)];
    return out;
  }

  private snapshotOf(row: RequestRow): Snapshot {
    const s = row.limit_snapshot as unknown as Snapshot;
    return { ...s, roles: s?.roles ?? {}, requester: s?.requester ?? null, limitKind: s?.limitKind ?? 'none', secondReviewer: s?.secondReviewer ?? 'always', actionKey: s?.actionKey ?? row.action_key };
  }

  private stateOf(row: RequestRow, decisions: DecisionRow[]): RequestState {
    const approvals = decisions
      .filter((d) => d.request_id === row.id && d.decision === 'approved')
      .sort((a, b) => a.step - b.step)
      .map((d) => ({ accountId: d.by_account_id, roleKeys: ((d.roles as unknown as RoleRef[]) ?? []).map((r) => r.key) }));
    return { requesterId: row.requested_by_id, requesterCountsAsFirst: row.requester_counts_as_first, approvals, amount: this.amountOfRow(row) };
  }

  private amountOf(act: ActionRow, amount?: AmountInput | null): Amount {
    return act.limit_kind === 'money' ? { money: amount?.money ?? null } : act.limit_kind === 'none' ? {} : { number: amount?.number ?? null };
  }

  private amountOfRow(row: RequestRow): Amount {
    return { money: moneyOf(row.amount_minor, row.currency), number: num(row.quantity) };
  }

  private targetOf(row: RequestRow): ApprovalTarget {
    return { type: row.target_type, id: row.target_id, ref: row.target_ref, label: row.target_label, sellerId: row.seller_id, screen: row.target_screen };
  }

  private auditTarget(row: RequestRow): audit.AuditTarget {
    return { type: row.target_type, id: row.target_id, ref: row.target_ref ?? row.ref, label: row.target_label ?? row.summary, sellerId: row.seller_id, screen: row.target_screen };
  }

  /** Requests the person may decide now, oldest due first */
  private async toDecide(principal: identity.Principal, filter: { module?: string; actionKey?: string; overdue?: boolean }, dirIn?: Directory, base: RequestFilter = {}): Promise<ApprovalRequest[]> {
    const me = principal.accountId;
    if (principal.kind !== 'staff' || !me) return [];
    const dir = dirIn ?? (await loadDirectory(this.repo, this.now()));
    const keys = uniq([...dir.rolesOf(me).map((r) => r.key), ...dir.covering(me).map((c) => dir.roleById.get(c.roleId)?.key ?? '')]).filter(Boolean);
    const rows = await this.repo.candidateRequests(keys, me, {
      ...base,
      statuses: [...DECIDABLE].filter((s) => !base.statuses || base.statuses.includes(s)),
      ...(filter.module ? { module: filter.module } : {}),
      ...(filter.actionKey ? { actionKey: filter.actionKey } : {}),
      ...(filter.overdue ? { dueBefore: this.now() } : {}),
    });
    const views = (await this.views(rows, principal, dir)).filter((v) => v.canDecide);
    const due = (v: ApprovalRequest) => (v.deadline ? new Date(v.deadline.dueAt).getTime() : Infinity);
    return views.sort((a, b) => due(a) - due(b) || a.createdAt.localeCompare(b.createdAt));
  }

  private async mayView(row: RequestRow, view: ApprovalRequest, principal: identity.Principal, dir: Directory, can: (p: string) => Promise<boolean>): Promise<boolean> {
    const me = principal.accountId;
    if (!me) return false;
    if (row.requested_by_id === me || row.nominated_reviewer_id === me || view.canDecide) return true;
    if (view.approvals.some((a) => a.by.id === me)) return true;
    const mine = new Set(dir.rolesOf(me).map((r) => r.key));
    if (((row.eligible_role_keys as string[]) ?? []).some((k) => mine.has(k))) return true;
    return can('access.approvals.view-all');
  }

  /* ================================================================ views */

  private async viewOne(row: RequestRow, viewer: identity.Principal | null): Promise<ApprovalRequest> {
    return (await this.views([row], viewer))[0]!;
  }

  private async views(rows: RequestRow[], viewer: identity.Principal | null, dirIn?: Directory): Promise<ApprovalRequest[]> {
    if (!rows.length) return [];
    const now = this.now();
    const dir = dirIn ?? (await loadDirectory(this.repo, now));
    const [decisions, actions] = await Promise.all([this.repo.decisionsOf(rows.map((r) => r.id)), this.repo.listActions()]);
    const actionByKey = new Map(actions.map((a) => [a.key, a]));
    const prepared = rows.map((row) => {
      const ds = decisions.filter((d) => d.request_id === row.id);
      const snapshot = this.snapshotOf(row);
      const state = this.stateOf(row, ds);
      const open = (DECIDABLE as readonly string[]).includes(row.status);
      const eligible = open ? this.eligiblePeople(snapshot, state, dir, row.nominated_reviewer_id) : [];
      return { row, ds, snapshot, state, open, eligible };
    });
    const people = uniq(
      prepared.flatMap((p) => [
        ...(p.row.requested_by_kind === 'staff' ? [p.row.requested_by_id] : []),
        ...p.ds.map((d) => d.by_account_id),
        ...p.ds.map((d) => d.via_delegation_from).filter((x): x is string => Boolean(x)),
        ...(p.row.nominated_reviewer_id ? [p.row.nominated_reviewer_id] : []),
        ...p.eligible,
      ]),
    );
    const refs = await this.staffRefs(people, dir);
    const actor = (id: string, kind = 'staff'): common.Actor => ({ kind: kind as common.Actor['kind'], id, ...(refs.get(id) ? { name: refs.get(id)!.name } : {}) });
    const viewerId = viewer?.accountId ?? null;

    return prepared.map(({ row, ds, snapshot, state, open, eligible }) => {
      const act = actionByKey.get(row.action_key);
      const approvals: ApprovalDecision[] = ds
        .filter((d) => d.decision === 'approved' || d.decision === 'rejected' || d.decision === 'returned')
        .sort((a, b) => a.at.getTime() - b.at.getTime() || a.step - b.step)
        .map((d) => ({
          step: d.step,
          decision: d.decision as ApprovalDecision['decision'],
          by: actor(d.by_account_id),
          roles: (d.roles as unknown as RoleRef[]) ?? [],
          note: d.note,
          viaDelegationFrom: d.via_delegation_from ? (refs.get(d.via_delegation_from) ?? null) : null,
          at: iso(d.at),
        }));
      let canDecide = false;
      let cannot: string | null = null;
      if (!viewerId || viewer?.kind !== 'staff') cannot = 'Only staff decide approval requests';
      else if (row.status === 'returned') cannot = 'Waiting for the requester';
      else if (!open) cannot = `Already ${row.status.replace('_', ' ')}`;
      else {
        const e = evaluate(snapshot, state, this.candidate(viewerId, dir, snapshot));
        canDecide = e.ok;
        cannot = e.ok ? null : e.reason;
      }
      const timeline: common.TimelineEvent[] = [
        { at: iso(row.created_at), label: 'Approval requested', detail: row.reason, actor: row.requested_by_kind === 'staff' ? actor(row.requested_by_id) : { kind: row.requested_by_kind as common.Actor['kind'], id: row.requested_by_id } },
        ...ds.map((d) => ({
          at: iso(d.at),
          label: TIMELINE_LABEL[d.decision] ?? d.decision,
          detail: d.note,
          actor: actor(d.by_account_id),
        })),
        ...(row.last_reminded_at ? [{ at: iso(row.last_reminded_at), label: 'Reviewers reminded', detail: null, actor: null }] : []),
        ...(row.status === 'cancelled' || row.status === 'expired' ? [{ at: iso(row.decided_at ?? now), label: row.status === 'cancelled' ? 'Request withdrawn' : 'Request expired', detail: row.outcome_reason, actor: null }] : []),
      ].sort((a, b) => a.at.localeCompare(b.at));
      return {
        id: row.id,
        ref: row.ref,
        action: act ? this.actionView(act) : { key: row.action_key, module: row.module, label: row.action_key, limit: snapshot.limitKind, secondReviewer: snapshot.secondReviewer, approvers: null, defaultEligibleRoleKeys: [], available: false },
        target: this.targetOf(row),
        amount: moneyOf(row.amount_minor, row.currency),
        quantity: num(row.quantity),
        summary: row.summary,
        details: row.details ?? {},
        reason: row.reason,
        requestedBy: row.requested_by_kind === 'staff' ? actor(row.requested_by_id) : { kind: row.requested_by_kind as common.Actor['kind'], id: row.requested_by_id },
        requestedByRoles: (row.requester_roles as unknown as RoleRef[]) ?? [],
        requesterCountsAsFirst: row.requester_counts_as_first,
        status: row.status as ApprovalRequest['status'],
        requiredApprovals: row.required_approvals,
        approvals,
        eligibleApprovers: eligible.map((id) => refs.get(id)!).filter(Boolean),
        nominatedReviewer: row.nominated_reviewer_id ? (refs.get(row.nominated_reviewer_id) ?? null) : null,
        deadline: row.due_at ? this.deadline(row.due_at, open) : null,
        limitSnapshot: row.limit_snapshot ?? {},
        timeline,
        createdAt: iso(row.created_at),
        decidedAt: row.decided_at ? iso(row.decided_at) : null,
        canDecide,
        cannotDecideReason: cannot,
      };
    });
  }

  private deadline(due: Date, open: boolean): common.Deadline {
    const left = due.getTime() - this.now().getTime();
    return { dueAt: iso(due), state: open && left < 0 ? 'overdue' : open && left <= DUE_SOON_MS ? 'due_soon' : 'on_time' };
  }

  private async approvalInfos(rows: RequestRow[], dir: Directory): Promise<common.ApprovalInfo[]> {
    const decisions = await this.repo.decisionsOf(rows.map((r) => r.id));
    const ids = uniq(decisions.filter((d) => d.decision === 'approved' || d.decision === 'rejected').map((d) => d.by_account_id));
    const refs = await this.staffRefs(ids, dir);
    return rows.map((row) => {
      const ds = decisions.filter((d) => d.request_id === row.id);
      const snapshot = this.snapshotOf(row);
      const state = this.stateOf(row, ds);
      const names = (decision: string) => ds.filter((d) => d.decision === decision).map((d) => refs.get(d.by_account_id)?.name ?? 'Staff member');
      const roleNames = this.roleRefsOf(stepRoleKeys(snapshot, state), dir).map((r) => r.name);
      const reason =
        row.status === 'approved'
          ? `Approved by ${names('approved').join(' and ')}`
          : row.status === 'rejected'
            ? `Rejected${row.outcome_reason ? `: ${row.outcome_reason}` : ''}`
            : row.status === 'returned'
              ? `Returned for changes${row.outcome_reason ? `: ${row.outcome_reason}` : ''}`
              : row.status === 'cancelled'
                ? 'Withdrawn'
                : row.status === 'expired'
                  ? 'Expired without a decision'
                  : `Waiting for ${roleNames.join(' or ') || 'an approver'}`;
      return { required: true, reason, approvalRequestId: row.id, approvers: row.status === 'approved' ? names('approved') : roleNames };
    });
  }

  private actionView(a: ActionRow): ApprovalAction {
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

  private limitValue(l: LimitRow): LimitValue {
    return {
      authority: l.authority as LimitValue['authority'],
      limitMoney: moneyOf(l.limit_amount_minor, l.limit_currency),
      limitNumber: num(l.limit_number),
      secondReviewerAboveMoney: moneyOf(l.second_above_amount_minor, l.limit_currency),
      secondReviewerAboveNumber: num(l.second_above_number),
      secondReviewerRoleKeys: (l.second_reviewer_role_keys as string[]) ?? [],
    };
  }

  private limitRow(roleId: string, actionKey: string, v: LimitValue, from: Date, limitChangeId: string | null): LimitRow {
    return {
      id: newId(),
      role_id: roleId,
      action_key: actionKey,
      authority: v.authority,
      limit_amount_minor: v.limitMoney?.amount ?? null,
      limit_currency: v.limitMoney?.currency ?? v.secondReviewerAboveMoney?.currency ?? null,
      limit_number: v.limitNumber != null ? String(v.limitNumber) : null,
      second_above_amount_minor: v.secondReviewerAboveMoney?.amount ?? null,
      second_above_number: v.secondReviewerAboveNumber != null ? String(v.secondReviewerAboveNumber) : null,
      second_reviewer_role_keys: v.secondReviewerRoleKeys as never,
      effective_from: from,
      effective_to: null,
      limit_change_id: limitChangeId,
    };
  }

  private async limitViews(rows: LimitRow[], dir: Directory): Promise<ApprovalLimit[]> {
    const actions = new Map((await this.repo.listActions()).map((a) => [a.key, a]));
    const changes = await this.repo.limitChangesByIds(uniq(rows.map((r) => r.limit_change_id).filter((x): x is string => Boolean(x))));
    const requests = await this.repo.findRequests({ ids: uniq(changes.map((c) => c.approval_request_id).filter((x): x is string => Boolean(x))) });
    const decisions = await this.repo.decisionsOf(requests.map((r) => r.id));
    const approverOf = (lcId: string | null): common.Actor | null => {
      const lc = changes.find((c) => c.id === lcId);
      if (!lc) return null;
      if (!lc.approval_request_id) return { kind: lc.proposed_by_kind as common.Actor['kind'], id: lc.proposed_by_id || null };
      const last = decisions.filter((d) => d.request_id === lc.approval_request_id && d.decision === 'approved').at(-1);
      return last ? { kind: 'staff', id: last.by_account_id } : null;
    };
    return rows
      .filter((r) => dir.roleById.get(r.role_id) && actions.get(r.action_key))
      .map((r) => {
        const act = actions.get(r.action_key)!;
        const value = this.limitValue(r);
        return {
          id: r.id,
          role: roleRef(dir.roleById.get(r.role_id)!),
          action: this.actionView(act),
          value,
          summary: limitSummary(act.limit_kind as LimitKind, act.second_reviewer as SecondMode, value),
          effectiveFrom: iso(r.effective_from),
          approvedBy: approverOf(r.limit_change_id),
        };
      })
      .sort((a, b) => a.role.name.localeCompare(b.role.name) || a.action.key.localeCompare(b.action.key));
  }

  private async limitChangeViews(rows: LimitChangeRow[], dir: Directory): Promise<LimitChange[]> {
    const requests = await this.repo.findRequests({ ids: uniq(rows.map((r) => r.approval_request_id).filter((x): x is string => Boolean(x))) });
    const infos = new Map((await this.approvalInfos(requests, dir)).map((i) => [i.approvalRequestId!, i]));
    return rows.map((r) => {
      const role = dir.roleById.get(r.role_id);
      return {
        id: r.id,
        role: role ? roleRef(role) : { id: r.role_id, key: 'unknown', name: 'Unknown role' },
        changes: (r.changes as unknown as LimitDiff[]) ?? [],
        reason: r.reason,
        effectiveFrom: iso(r.effective_from),
        status: r.status as LimitChange['status'],
        proposedBy: { kind: r.proposed_by_kind as common.Actor['kind'], id: r.proposed_by_id || null },
        approval: (r.approval_request_id && infos.get(r.approval_request_id)) || { required: false, reason: 'Approved on creation by the Business Owner', approvalRequestId: null, approvers: [] },
        createdAt: iso(r.created_at),
        appliedAt: r.applied_at ? iso(r.applied_at) : null,
      };
    });
  }

  private async applyLimitChange(id: string) {
    const now = this.now();
    const done = await this.repo.transaction(async (tx) => {
      const lc = await tx.getLimitChange(id, { forUpdate: true });
      if (!lc || lc.status !== 'scheduled' || lc.effective_from > now) return null;
      const changes = (lc.changes as unknown as LimitDiff[]) ?? [];
      for (const c of changes) {
        await tx.closeLimits(lc.role_id, c.actionKey, lc.effective_from);
        await tx.insertLimits([this.limitRow(lc.role_id, c.actionKey, normalizeLimit(c.after), lc.effective_from, lc.id)]);
      }
      return tx.updateLimitChange(id, { status: limitChangeMachine.next('scheduled', 'apply'), applied_at: now });
    });
    if (!done) return;
    const role = await this.repo.getRole(done.role_id);
    const diffs = (done.changes as unknown as LimitDiff[]) ?? [];
    this.ctx.events.publish(
      'access.limits.changed',
      { roleId: done.role_id, roleKey: role?.key ?? '', actionKeys: diffs.map((c) => c.actionKey), limitChangeId: done.id, effectiveFrom: iso(done.effective_from) },
      { actor: SYSTEM_ACTOR },
    );
    await this.audit(
      {
        action: 'access.limits.apply',
        actionLabel: 'Approval limits took effect',
        target: role ? this.roleTarget(role) : { type: 'role', id: done.role_id },
        relatedTargets: [{ type: 'limit_change', id: done.id }],
        before: diffs.map((d) => ({ actionKey: d.actionKey, value: d.before })),
        after: diffs.map((d) => ({ actionKey: d.actionKey, value: d.after })),
        reason: done.reason,
        approvalRequestId: done.approval_request_id,
      },
      { actor: SYSTEM_ACTOR },
    );
  }

  private sortRoles(rows: RoleRow[]): RoleRow[] {
    return [...rows].sort((a, b) => (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9) || a.created_at.getTime() - b.created_at.getTime() || a.name.localeCompare(b.name));
  }

  /** Approver roles in route order: the usual approvers first, the Business Owner last */
  private roleRefsOf(keys: string[], dir: Directory): RoleRef[] {
    const rank = (r: RoleRow) => (r.kind === 'owner' ? 9 : (KIND_ORDER[r.kind] ?? 5));
    return uniq(keys)
      .map((k) => dir.roleByKey.get(k))
      .filter((r): r is RoleRow => Boolean(r))
      .sort((a, b) => rank(a) - rank(b) || a.created_at.getTime() - b.created_at.getTime() || a.name.localeCompare(b.name))
      .map(roleRef);
  }

  private roleTarget(r: RoleRow): audit.AuditTarget {
    return { type: 'role', id: r.id, ref: r.key, label: r.name, screen: 'admin/staff' };
  }

  private async roleViews(rows: RoleRow[], dir: Directory): Promise<Role[]> {
    const ids = uniq(rows.flatMap((r) => [...dir.membersOf(r.id), ...(dir.coverage.get(r.id)?.lead ? [dir.coverage.get(r.id)!.lead!] : []), ...(dir.coverage.get(r.id)?.backups ?? [])]));
    const refs = await this.staffRefs(ids, dir);
    const limits = await this.repo.limitsInForce(this.now(), { roleIds: rows.map((r) => r.id) });
    const actions = new Map((await this.repo.listActions()).map((a) => [a.key, a]));
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
        const s = limitSummary(act.limit_kind as LimitKind, act.second_reviewer as SecondMode, this.limitValue(l));
        return `${actionNoun(l.action_key)}: ${s.charAt(0).toLowerCase()}${s.slice(1)}`;
      });
    if (!parts.length) return 'No financial authority';
    return parts.length > 3 ? `${parts.slice(0, 3).join('; ')}; +${parts.length - 3} more` : parts.join('; ');
  }

  private async roleDetail(row: RoleRow, dir: Directory): Promise<RoleDetail> {
    const [role] = await this.roleViews([row], dir);
    const registry = await this.repo.listPermissions();
    const granted = dir.permsByRole.get(row.id) ?? new Set<string>();
    const grants = registry.filter((p) => !p.unavailable_since || granted.has(p.key)).map((p) => ({ permission: this.permissionView(p), granted: granted.has(p.key) }));
    const limits = await this.repo.limitsInForce(this.now(), { roleIds: [row.id] });
    const pendingChange = await this.repo.openLimitChangeOfRole(row.id);
    const pendingPerms = await this.repo.findOpenRequest(SENSITIVE_GRANT, 'role_permissions', row.id);
    return {
      role: role!,
      permissions: this.groupPermissions(grants),
      limits: await this.limitViews(limits, dir),
      pendingLimitChange: pendingChange ? ((await this.limitChangeViews([pendingChange], dir))[0] ?? null) : null,
      pendingPermissionApproval: pendingPerms ? ((await this.approvalInfos([pendingPerms], dir))[0] ?? null) : null,
    };
  }

  private async assignmentViews(rows: AssignmentRow[], dir: Directory): Promise<RoleAssignment[]> {
    const requests = await this.repo.findRequests({ ids: uniq(rows.map((r) => r.approval_request_id).filter((x): x is string => Boolean(x))) });
    const infos = new Map((await this.approvalInfos(requests, dir)).map((i) => [i.approvalRequestId!, i]));
    return rows.map((a) => {
      const role = dir.roleById.get(a.role_id);
      const expired = a.status === 'active' && a.expires_at && a.expires_at <= this.now();
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
    const open = await this.repo.listAssignments({ accountIds: ids, statuses: ['active', 'pending_acceptance'] });
    const awayIds = ids.map((id) => dir.awayOf(id)).filter((p): p is AwayRow => Boolean(p));
    const awayViews = await this.awayViews(awayIds, dir);
    const reviews = await this.repo.findRequests({ actionKey: LIMITS_CHANGE, targetType: 'staff_member', targetIds: ids });
    const reviewInfos = new Map<string, common.ApprovalInfo>();
    const infos = await this.approvalInfos(reviews, dir);
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
          roles: refs(open.filter((a) => a.account_id === id && (a.status !== 'active' || !a.expires_at || a.expires_at > this.now())).map((a) => a.role_id)),
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

  private async awayViews(rows: AwayRow[], dir: Directory): Promise<AwayPeriod[]> {
    if (!rows.length) return [];
    const coverage = await this.repo.awayCoverage(rows.map((r) => r.id));
    const refs = await this.staffRefs(uniq([...rows.map((r) => r.account_id), ...coverage.map((c) => c.covered_by_account_id)]), dir);
    const requests = await this.repo.findRequests({ ids: uniq(rows.map((r) => r.approval_request_id).filter((x): x is string => Boolean(x))) });
    const infos = new Map((await this.approvalInfos(requests, dir)).map((i) => [i.approvalRequestId!, i]));
    return rows.map((r) => ({
      id: r.id,
      account: refs.get(r.account_id)!,
      from: iso(r.starts_at),
      to: iso(r.ends_at),
      status: r.status as AwayPeriod['status'],
      coverage: coverage
        .filter((c) => c.away_period_id === r.id)
        .map((c) => ({ role: dir.roleById.get(c.role_id) ? roleRef(dir.roleById.get(c.role_id)!) : { id: c.role_id, key: 'unknown', name: 'Unknown role' }, coveredBy: refs.get(c.covered_by_account_id)! })),
      delegateApprovals: r.delegate_approvals,
      approval: r.approval_request_id ? (infos.get(r.approval_request_id) ?? null) : null,
      reason: r.reason,
      createdBy: { kind: r.created_by_kind as common.Actor['kind'], id: r.created_by_id || null },
      createdAt: iso(r.created_at),
    }));
  }

  /* ================================================================ coverage and routing */

  private routingCandidates(roleId: string, dir: Directory): string[] {
    const cov = dir.coverage.get(roleId);
    return uniq([...(cov?.lead ? [cov.lead] : []), ...(cov?.backups ?? []), ...dir.membersOf(roleId), ...dir.away.flatMap((a) => a.coverage.filter((c) => c.role_id === roleId).map((c) => c.covered_by_account_id))]);
  }

  /** Who receives a role's work now: the lead, else (lead away or locked) the person covering the role, the first available backup, or any available member */
  private route(role: RoleRow, dir: Directory, unavailable: Set<string>): { lead: string | null; receiving: string[]; viaBackup: boolean; leadAwayUntil: Date | null } {
    const cov = dir.coverage.get(role.id);
    const lead = cov?.lead ?? null;
    const available = (acc: string) => !unavailable.has(acc) && !dir.awayOf(acc);
    const members = dir.membersOf(role.id).filter(available);
    if (lead && available(lead)) return { lead, receiving: [lead], viaBackup: false, leadAwayUntil: null };
    const leadAway = lead ? dir.awayOf(lead) : undefined;
    if (lead) {
      const covering = dir.away.find((a) => a.period.account_id === lead)?.coverage.find((c) => c.role_id === role.id)?.covered_by_account_id;
      const next = (covering && available(covering) ? covering : undefined) ?? (cov?.backups ?? []).find(available) ?? members.find((m) => m !== lead);
      return { lead, receiving: next ? [next] : [], viaBackup: true, leadAwayUntil: leadAway?.ends_at ?? null };
    }
    const backup = (cov?.backups ?? []).find(available);
    return { lead: null, receiving: backup ? [backup] : members, viaBackup: false, leadAwayUntil: null };
  }

  private async coverageOfRoles(dir: Directory, only?: string[]): Promise<Coverage> {
    const roles = this.sortRoles(dir.roles.filter((r) => !r.archived_at && (!only || only.includes(r.id))));
    const candidates = uniq(roles.flatMap((r) => this.routingCandidates(r.id, dir)));
    const accounts = await this.accounts(candidates);
    const unavailable = new Set([...accounts.values()].filter((a) => a.status === 'locked' || a.status === 'disabled' || a.status === 'closed').map((a) => a.id));
    const refs = await this.staffRefs(candidates, dir, accounts);
    const out: RoleCoverage[] = [];
    const gaps: CoverageGap[] = [];
    for (const role of roles) {
      const cov = dir.coverage.get(role.id) ?? { lead: null, backups: [] };
      const r = this.route(role, dir, unavailable);
      const esc = role.escalation_role_id ? dir.roleById.get(role.escalation_role_id) : undefined;
      out.push({
        role: roleRef(role),
        workArea: role.work_area,
        lead: cov.lead ? (refs.get(cov.lead) ?? null) : null,
        backups: cov.backups.map((id) => refs.get(id)!).filter(Boolean),
        receivingNow: r.receiving.map((id) => refs.get(id)!).filter(Boolean),
        viaBackup: r.viaBackup,
        leadAwayUntil: r.leadAwayUntil ? iso(r.leadAwayUntil) : null,
        escalationRole: esc ? roleRef(esc) : null,
      });
      const ref = (id: string) => refs.get(id)!;
      const holds = (acc: string) => dir.holds(acc, role.id) || dir.isBusinessOwner(acc);
      if (!cov.lead && dir.membersOf(role.id).length) gaps.push({ kind: 'no_lead', roles: [roleRef(role)], people: [], message: `${role.name} has no lead`, severity: 'review' });
      if (cov.lead && !cov.backups.length) gaps.push({ kind: 'no_backup', roles: [roleRef(role)], people: [ref(cov.lead)].filter(Boolean), message: `${role.name} has no backup`, severity: 'review' });
      const outside = [...(cov.lead ? [cov.lead] : []), ...cov.backups].filter((acc) => !holds(acc));
      if (outside.length) gaps.push({ kind: 'backup_not_in_role', roles: [roleRef(role)], people: outside.map(ref).filter(Boolean), message: `${outside.length === 1 ? 'Someone' : `${outside.length} people`} named as lead or backup no longer hold${outside.length === 1 ? 's' : ''} ${role.name}`, severity: 'critical' });
      if (cov.lead && !r.receiving.length) gaps.push({ kind: 'lead_and_backups_away', roles: [roleRef(role)], people: [cov.lead, ...cov.backups].map(ref).filter(Boolean), message: `Nobody receives ${role.name} work: the lead and backups are away or unavailable`, severity: 'critical' });
    }
    const backupOf = new Map<string, RoleRow[]>();
    const leadOf = new Map<string, RoleRow[]>();
    for (const role of roles) {
      const cov = dir.coverage.get(role.id);
      for (const b of cov?.backups ?? []) backupOf.set(b, [...(backupOf.get(b) ?? []), role]);
      if (cov?.lead) leadOf.set(cov.lead, [...(leadOf.get(cov.lead) ?? []), role]);
    }
    for (const [acc, rs] of backupOf) {
      if (rs.length > 1) gaps.push({ kind: 'shared_backup', roles: rs.map(roleRef), people: [refs.get(acc)!].filter(Boolean), message: `${refs.get(acc)?.name ?? 'One person'} is the backup for ${rs.length} roles`, severity: 'review' });
    }
    for (const [acc, rs] of leadOf) {
      if (rs.length > 2) gaps.push({ kind: 'one_person_leads_several', roles: rs.map(roleRef), people: [refs.get(acc)!].filter(Boolean), message: `${refs.get(acc)?.name ?? 'One person'} leads ${rs.length} roles`, severity: 'review' });
    }
    return { roles: out, gaps };
  }

  private async rolesRoutedTo(accountId: string): Promise<string[]> {
    const coverage = await this.repo.listCoverage();
    return coverage.filter((c) => c.lead_account_id === accountId || ((c.backup_account_ids as string[]) ?? []).includes(accountId)).map((c) => c.role_id);
  }

  /** Announces who receives each role's work now (identity statuses may lag behind the event that triggered this) */
  private async publishCoverageFor(roleIds: string[], forceUnavailable?: Set<string>, forceAvailable?: Set<string>) {
    if (!roleIds.length) return;
    const dir = await loadDirectory(this.repo, this.now());
    for (const roleId of uniq(roleIds)) {
      const role = dir.roleById.get(roleId);
      if (!role) continue;
      const unavailable = await this.unavailableAccounts(this.routingCandidates(roleId, dir), dir);
      for (const a of forceUnavailable ?? []) unavailable.add(a);
      for (const a of forceAvailable ?? []) unavailable.delete(a);
      const r = this.route(role, dir, unavailable);
      this.ctx.events.publish('access.coverage.changed', { roleId, roleKey: role.key, leadAccountId: r.lead, receivingAccountIds: r.receiving, viaBackup: r.viaBackup }, { actor: SYSTEM_ACTOR });
    }
  }

  private publishCoverage(cov: RoleCoverage) {
    this.ctx.events.publish(
      'access.coverage.changed',
      { roleId: cov.role.id, roleKey: cov.role.key, leadAccountId: cov.lead?.accountId ?? null, receivingAccountIds: cov.receivingNow.map((s) => s.accountId), viaBackup: cov.viaBackup },
      { actor: SYSTEM_ACTOR },
    );
  }

  private async unavailableAccounts(ids: string[], _dir: Directory): Promise<Set<string>> {
    const accounts = await this.accounts(ids);
    return new Set([...accounts.values()].filter((a) => a.status === 'locked' || a.status === 'disabled' || a.status === 'closed').map((a) => a.id));
  }

  /* ================================================================ away periods */

  private async startAway(id: string): Promise<AwayRow | null> {
    const now = this.now();
    const row = await this.repo.transaction(async (tx) => {
      const p = await tx.getAway(id, { forUpdate: true });
      if (p?.status !== 'scheduled' || p.starts_at > now) return null;
      return tx.updateAway(id, { status: awayPeriodMachine.next('scheduled', 'start') });
    });
    if (!row) return null;
    const coverage = await this.repo.awayCoverage([id]);
    this.ctx.events.publish(
      'access.away.started',
      { awayPeriodId: id, accountId: row.account_id, until: iso(row.ends_at), coverage: coverage.map((c) => ({ roleId: c.role_id, coveredByAccountId: c.covered_by_account_id })), delegateApprovals: row.delegate_approvals },
      { actor: SYSTEM_ACTOR },
    );
    await this.publishCoverageFor(uniq([...(await this.rolesRoutedTo(row.account_id)), ...coverage.map((c) => c.role_id)]));
    if (row.ends_at <= now) return this.finishAway(id);
    return row;
  }

  private async finishAway(id: string): Promise<AwayRow | null> {
    const row = await this.repo.transaction(async (tx) => {
      const p = await tx.getAway(id, { forUpdate: true });
      if (p?.status !== 'active') return null;
      return tx.updateAway(id, { status: awayPeriodMachine.next('active', 'end'), ended_at: this.now() });
    });
    if (!row) return null;
    const coverage = await this.repo.awayCoverage([id]);
    this.ctx.events.publish('access.away.ended', { awayPeriodId: id, accountId: row.account_id }, { actor: SYSTEM_ACTOR });
    await this.publishCoverageFor(uniq([...(await this.rolesRoutedTo(row.account_id)), ...coverage.map((c) => c.role_id)]));
    return row;
  }

  private async requireOwnOrManage(caller: Caller, row: AwayRow) {
    if (row.account_id === caller.principal.accountId) return;
    if (await this.can(caller, 'access.away.manage')) return;
    throw new AppError('FORBIDDEN', "Changing someone else's time away needs access.away.manage", { permission: 'access.away.manage' });
  }

  /* ================================================================ assignments */

  /** Creates one assignment; sensitive roles, the Business Owner role and roles for yourself wait for a second reviewer. Null when one is already open. */
  private async createAssignment(
    caller: Caller,
    a: { accountId: string; role: RoleRow; reason: string; expiresAt: Date | null; invited: boolean; accountName: string },
    dir: Directory,
    prefixes: string[],
  ): Promise<AssignmentRow | null> {
    const open = await this.repo.listAssignments({ accountId: a.accountId, roleId: a.role.id, statuses: OPEN_ASSIGNMENT });
    if (open.length) return null;
    const self = a.accountId === caller.principal.accountId;
    const sensitive = [...(dir.permsByRole.get(a.role.id) ?? [])].some((k) => this.isSensitive(k, prefixes));
    const needsApproval = self || sensitive || a.role.key === BUSINESS_OWNER;
    const id = newId();
    let approvalRequestId: string | null = null;
    if (needsApproval) {
      const req = await this.openRequest(
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
      const row = await this.repo.insertAssignment({
        id,
        account_id: a.accountId,
        role_id: a.role.id,
        status: needsApproval ? 'pending_approval' : a.invited ? roleAssignmentMachine.initial : roleAssignmentMachine.next('pending_acceptance', 'accept'),
        granted_by_kind: caller.actor.kind,
        granted_by_id: caller.actor.id ?? '',
        reason: a.reason,
        granted_at: this.now(),
        expires_at: a.expiresAt,
        revoked_at: null,
        revoked_by: null,
        revoke_reason: null,
        approval_request_id: approvalRequestId,
      });
      if (row.status === 'active') this.publishRoleChanged(a.role, 'assigned', a.accountId, caller.actor, caller.requestId);
      return row;
    } catch (err) {
      if (approvalRequestId) await this.closeRequest(approvalRequestId, 'cancel', caller.actor, 'The assignment could not be created');
      if (await this.repo.listAssignments({ accountId: a.accountId, roleId: a.role.id, statuses: OPEN_ASSIGNMENT }).then((x) => x.length)) return null;
      throw err;
    }
  }

  /** revoke, reject (waiting for approval) or expire an assignment; announces the change and any coverage it affects */
  private async endAssignment(id: string, event: 'revoke' | 'reject' | 'expire', actor: common.Actor, reason: string, requestId?: string): Promise<AssignmentRow> {
    const after = await this.repo.transaction(async (tx) => {
      const locked = await tx.getAssignment(id, { forUpdate: true });
      if (!locked) throw notFound('Role assignment');
      const status = roleAssignmentMachine.next(locked.status as never, event);
      return tx.updateAssignment(id, { status, revoked_at: this.now(), revoked_by: by(actor), revoke_reason: reason });
    });
    if (after.approval_request_id) {
      const req = await this.repo.getRequest(after.approval_request_id);
      if (req && !FINAL.has(req.status)) await this.closeRequest(req.id, 'cancel', actor, reason, requestId);
    }
    const role = await this.repo.getRole(after.role_id);
    if (role) this.publishRoleChanged(role, 'unassigned', after.account_id, actor, requestId);
    const cov = await this.repo.getCoverage(after.role_id);
    if (cov && (cov.lead_account_id === after.account_id || ((cov.backup_account_ids as string[]) ?? []).includes(after.account_id))) await this.publishCoverageFor([after.role_id]);
    return after;
  }

  /* ================================================================ helpers */

  private publishRoleChanged(role: RoleRow, change: 'created' | 'updated' | 'archived' | 'permissions_changed' | 'assigned' | 'unassigned', accountId: string | null, actor: common.Actor, requestId?: string) {
    this.ctx.events.publish('access.role.changed', { roleId: role.id, roleKey: role.key, change, accountId, by: actor }, { actor, requestId });
  }

  private async requireAction(key: string): Promise<ActionRow> {
    const act = await this.repo.getAction(key);
    if (!act || act.unavailable_since) throw new AppError('UNKNOWN_APPROVAL_ACTION', `${key} is not registered by any enabled module`, { actionKey: key });
    return act;
  }

  private async sensitivePrefixes(): Promise<string[]> {
    const v = await this.ctx.settings.get('sensitivePermissionPrefixes');
    return Array.isArray(v) ? (v as string[]) : [];
  }

  private isSensitive(key: string, prefixes: string[]) {
    return prefixes.some((p) => (p.endsWith('.') ? key.startsWith(p) : key === p || key.startsWith(`${p}.`)));
  }

  private async can(caller: Caller, permission: string): Promise<boolean> {
    return caller.can ? caller.can(permission) : this.hasPermission(caller.principal, permission);
  }

  /** Display lookups: identity's account summaries (empty while identity is not built yet) */
  private async accounts(ids: string[]): Promise<Accounts> {
    const want = uniq(ids.filter(Boolean));
    if (!want.length) return new Map();
    try {
      return new Map((await this.ctx.use('identity').getAccounts(want)).map((a) => [a.id, a]));
    } catch (err) {
      if (isNotImplemented(err)) return new Map();
      throw err;
    }
  }

  /** Lookups where the account itself is part of the answer: identity must answer */
  private async requireAccounts(ids: string[]): Promise<Accounts> {
    const want = uniq(ids.filter(Boolean));
    if (!want.length) return new Map();
    return new Map((await this.ctx.use('identity').getAccounts(want)).map((a) => [a.id, a]));
  }

  private async staffRefs(ids: string[], dir: Directory, known?: Accounts): Promise<Map<string, StaffRef>> {
    const want = uniq(ids.filter(Boolean));
    const accounts = known ?? (await this.accounts(want));
    const missing = want.filter((id) => !accounts.has(id));
    if (known && missing.length) for (const [k, v] of await this.accounts(missing)) accounts.set(k, v);
    return new Map(
      want.map((id) => {
        const a = accounts.get(id);
        const primary = this.sortRoles(dir.rolesOf(id))[0];
        return [id, { accountId: id, name: a?.displayName ?? 'Staff member', email: a?.email ?? null, away: Boolean(dir.awayOf(id)), roleLabel: primary?.name ?? null }];
      }),
    );
  }

  protected async audit(entry: Omit<audit.RecordInput, 'actor' | 'module' | 'requestId' | 'category'> & { category?: audit.RecordInput['category'] }, by: { actor: common.Actor; requestId?: string }) {
    try {
      await this.ctx.tryUse('audit')?.record({ category: 'access', ...entry, actor: by.actor, module: this.ctx.name, requestId: by.requestId ?? null });
    } catch (err) {
      // the change is committed; a missing audit entry is logged, never turned into a failed request
      this.ctx.log[isNotImplemented(err) ? 'debug' : 'error']({ err, action: entry.action }, 'audit entry not recorded');
    }
  }
}

const STATUS: Record<string, StaffMember['status']> = { invited: 'invited', pending_verification: 'invited', active: 'active', locked: 'locked', disabled: 'disabled', closed: 'disabled' };

const TIMELINE_LABEL: Record<string, string> = {
  approved: 'Approved',
  rejected: 'Rejected',
  returned: 'Returned for changes',
  resubmitted: 'Resubmitted',
  superseded_approved: 'Approved (cleared on resubmit)',
  superseded_returned: 'Returned for changes',
  superseded_rejected: 'Rejected',
};
