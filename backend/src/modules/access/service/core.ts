/**
 * Shared plumbing of the access use cases: the registry sync every read waits for, effective permissions, events,
 * audit, identity look-ups and the staff references shown with roles and requests. The use cases live in the
 * feature classes (service/*.ts).
 */
import { AppError, isNotImplemented } from '../../../kernel/errors/index.js';
import { newId } from '../../../kernel/lib/ids.js';
import { allSpecs } from '../../../kernel/module-system/loader.js';
import type { ModuleContext } from '../../../kernel/module-system/index.js';
import type * as audit from '../../../spec/audit.js';
import type * as common from '../../../spec/common.js';
import type * as identity from '../../../spec/identity.js';
import type { RoleRef, StaffMember, StaffRef } from '../../../spec/access.js';
import type { Directory } from '../directory.js';
import { normalizeLimit, type Issue } from '../domain/limits.js';
import {
  BUSINESS_OWNER,
  SYSTEM_ROLES,
  areaOf,
  defaultEligibleRoleKeys,
  expandPermissions,
  permissionLabel,
} from '../domain/seed.js';
import type { ActionRow, LimitRow, RoleRow } from '../ports.js';
import type { AccessRepository } from '../repository.js';
import type { Roles } from './roles.js';
import type { Members } from './members.js';
import type { Limits } from './limits.js';
import type { Approvals } from './approvals.js';
import type { AwayPeriods } from './away.js';

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

/** An invited person: their staff account, invitation, link and pass code (the operator hands both over) */
export interface BootstrapInvitee {
  accountId: string;
  invitationId: string;
  acceptUrl: string;
  /** Shown once (XXXX-XXXX); only its hash is stored */
  passCode: string;
}

/** The staff accounts and identity invitations created; `deputy` is null without one. In-process only (npm run bootstrap-owner). */
export interface BootstrapOwnerResult extends BootstrapInvitee {
  deputy: BootstrapInvitee | null;
}

export type Accounts = Map<string, identity.AccountSummary>;

export const SENSITIVE_GRANT = 'access.roles.sensitive-grant';
export const LIMITS_CHANGE = 'access.limits.change';
export const DELEGATIONS = 'access.delegations.approve';
export const DECIDABLE = ['pending', 'partially_approved'] as const;
export const FINAL = new Set(['approved', 'rejected', 'cancelled', 'expired']);
export const DUE_SOON_MS = 24 * 3_600_000;
export const EXPIRY_GRACE_MS = 24 * 3_600_000;
export const BATCH = 200;

export const iso = (d: Date | string) => new Date(d).toISOString();
export const uniq = <T>(xs: Iterable<T>) => [...new Set(xs)];
export const by = (actor: common.Actor) => (actor.id ? `${actor.kind}:${actor.id}` : actor.kind);
export const actorFrom = (text: string | null | undefined): common.Actor | null => {
  if (!text) return null;
  const i = text.indexOf(':');
  if (i < 0) return { kind: text as common.Actor['kind'] };
  return { kind: text.slice(0, i) as common.Actor['kind'], id: text.slice(i + 1) };
};
export const roleRef = (r: RoleRow): RoleRef => ({ id: r.id, key: r.key, name: r.name });
export const moneyOf = (minor: number | null, currency: string | null): common.Money | null => (minor == null || !currency ? null : { amount: Number(minor), currency });
export const num = (v: string | number | null | undefined) => (v == null ? null : Number(v));
export const validation = (message: string, issues: Issue[]) => new AppError('VALIDATION_FAILED', message, { issues });
export const notFound = (what: string) => new AppError('NOT_FOUND', `${what} not found`);
export const KIND_ORDER: Record<string, number> = { owner: 0, management: 1, task: 2, custom: 3 };

export const STATUS: Record<string, StaffMember['status']> = { invited: 'invited', pending_verification: 'invited', active: 'active', locked: 'locked', disabled: 'disabled', closed: 'disabled' };

export const TIMELINE_LABEL: Record<string, string> = {
  approved: 'Approved',
  rejected: 'Rejected',
  returned: 'Returned for changes',
  resubmitted: 'Resubmitted',
  superseded_approved: 'Approved (cleared on resubmit)',
  superseded_returned: 'Returned for changes',
  superseded_rejected: 'Rejected',
};

/** The feature classes of the service */
export interface Parts {
  roles: Roles;
  members: Members;
  limits: Limits;
  approvals: Approvals;
  away: AwayPeriods;
}

export class Core {
  /** The feature classes, set by the service once they are built (features call one another through it) */
  parts!: Parts;
  #ready?: Promise<void>;
  #syncing?: Promise<void>;

  constructor(readonly deps: AccessServiceDeps) {}

  get ctx() {
    return this.deps.ctx;
  }

  get repo() {
    return this.deps.repo;
  }

  now() {
    return this.ctx.clock.now();
  }

  /** The registry and the system roles exist before anything reads them (also run by the boot job). */
  ready(): Promise<void> {
    this.#ready ??= this.syncRegistry().catch((err) => {
      this.#ready = undefined;
      throw err;
    });
    return this.#ready;
  }

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

  async doSync() {
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
              if (actionKeys.has(key) && !(await tx.limitRowExists(existing.id, key))) rows.push(this.parts.limits.limitRow(existing.id, key, normalizeLimit(v), now, null));
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
            .map(([key, v]) => this.parts.limits.limitRow(row.id, key, normalizeLimit(v), now, null)),
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
        for (const key of actionKeys) if (!(await tx.limitRowExists(bo.id, key))) rows.push(this.parts.limits.limitRow(bo.id, key, normalizeLimit({ authority: 'permitted' }), now, null));
        await tx.insertLimits(rows);
      }
    });
  }

  sortRoles(rows: RoleRow[]): RoleRow[] {
    return [...rows].sort((a, b) => (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9) || a.created_at.getTime() - b.created_at.getTime() || a.name.localeCompare(b.name));
  }

  /** Approver roles in route order: the usual approvers first, the Business Owner last */
  roleRefsOf(keys: string[], dir: Directory): RoleRef[] {
    const rank = (r: RoleRow) => (r.kind === 'owner' ? 9 : (KIND_ORDER[r.kind] ?? 5));
    return uniq(keys)
      .map((k) => dir.roleByKey.get(k))
      .filter((r): r is RoleRow => Boolean(r))
      .sort((a, b) => rank(a) - rank(b) || a.created_at.getTime() - b.created_at.getTime() || a.name.localeCompare(b.name))
      .map(roleRef);
  }

  publishRoleChanged(role: RoleRow, change: 'created' | 'updated' | 'archived' | 'permissions_changed' | 'assigned' | 'unassigned', accountId: string | null, actor: common.Actor, requestId?: string) {
    this.ctx.events.publish('access.role.changed', { roleId: role.id, roleKey: role.key, change, accountId, by: actor }, { actor, requestId });
  }

  async requireAction(key: string): Promise<ActionRow> {
    const act = await this.repo.getAction(key);
    if (!act || act.unavailable_since) throw new AppError('UNKNOWN_APPROVAL_ACTION', `${key} is not registered by any enabled module`, { actionKey: key });
    return act;
  }

  async sensitivePrefixes(): Promise<string[]> {
    const v = await this.ctx.settings.get('sensitivePermissionPrefixes');
    return Array.isArray(v) ? (v as string[]) : [];
  }

  isSensitive(key: string, prefixes: string[]) {
    return prefixes.some((p) => (p.endsWith('.') ? key.startsWith(p) : key === p || key.startsWith(`${p}.`)));
  }

  async can(caller: Caller, permission: string): Promise<boolean> {
    return caller.can ? caller.can(permission) : this.hasPermission(caller.principal, permission);
  }

  /** Display lookups: identity's account summaries (empty while identity is not built yet) */
  async accounts(ids: string[]): Promise<Accounts> {
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
  async requireAccounts(ids: string[]): Promise<Accounts> {
    const want = uniq(ids.filter(Boolean));
    if (!want.length) return new Map();
    return new Map((await this.ctx.use('identity').getAccounts(want)).map((a) => [a.id, a]));
  }

  async staffRefs(ids: string[], dir: Directory, known?: Accounts): Promise<Map<string, StaffRef>> {
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

  async audit(entry: Omit<audit.RecordInput, 'actor' | 'module' | 'requestId' | 'category'> & { category?: audit.RecordInput['category'] }, by: { actor: common.Actor; requestId?: string }) {
    try {
      await this.ctx.tryUse('audit')?.record({ category: 'access', ...entry, actor: by.actor, module: this.ctx.name, requestId: by.requestId ?? null });
    } catch (err) {
      // the change is committed; a missing audit entry is logged, never turned into a failed request
      this.ctx.log[isNotImplemented(err) ? 'debug' : 'error']({ err, action: entry.action }, 'audit entry not recorded');
    }
  }
}
